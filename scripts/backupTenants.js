require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { masterPool } = require('../db/masterDb');
const { dumpTenantDatabase } = require('../lib/backupEngine');
const { closeAllTenantPools } = require('../db/tenantManager');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

async function backupAllTenants() {
  console.log('--- EXECUTING PER-COMPANY BACKUP JOB ---');
  const masterClient = await masterPool.connect();

  try {
    const compRes = await masterClient.query(
      "SELECT id, company_name, company_code, database_name FROM companies WHERE status != 'failed' AND database_name IS NOT NULL"
    );

    console.log(`Found ${compRes.rowCount} company database(s) for backup.`);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFiles = [];

    for (const comp of compRes.rows) {
      const fileName = `${comp.company_code}_${comp.database_name}_${timestamp}.sql`;
      const filePath = path.join(BACKUP_DIR, fileName);
      console.log(`Creating database backup for company [${comp.company_name}] (${comp.database_name})...`);

      try {
        const dumpResult = await dumpTenantDatabase(comp.database_name, filePath);
        console.log(`✓ Backup created successfully: ${fileName} (${dumpResult.bytes} bytes)`);
        backupFiles.push({ company_code: comp.company_code, filePath, fileName });
      } catch (err) {
        console.error(`✖ Dump failed for ${comp.database_name}:`, err.message);
      }
    }

    console.log(`\n--- BACKUP JOB COMPLETE: ${backupFiles.length} file(s) saved to ${BACKUP_DIR} ---`);
    return backupFiles;
  } finally {
    masterClient.release();
    await closeAllTenantPools();
    await masterPool.end();
  }
}

if (require.main === module) {
  backupAllTenants().catch((err) => {
    console.error('Backup job failed:', err);
    process.exit(1);
  });
}

module.exports = { backupAllTenants, BACKUP_DIR };
