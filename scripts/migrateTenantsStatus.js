const fs = require('fs');
const path = require('path');
const { masterPool } = require('../db/masterDb');
const { getTenantPool, closeAllTenantPools } = require('../db/tenantManager');

const TENANT_MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'tenant');

async function checkMigrationStatus() {
  console.log('--- MULTI-TENANT MIGRATION STATUS REPORT ---');
  
  const files = fs.existsSync(TENANT_MIGRATIONS_DIR)
    ? fs.readdirSync(TENANT_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    : [];

  const migrationMap = files.map((file) => {
    const match = file.match(/^(\d+)_/);
    return {
      version: match ? parseInt(match[1], 10) : 0,
      name: file
    };
  });

  console.log(`Available Tenant Migration Files (${migrationMap.length}):`);
  migrationMap.forEach((m) => console.log(`  - [v${m.version}] ${m.name}`));
  console.log('--------------------------------------------');

  const masterClient = await masterPool.connect();
  try {
    const companies = await masterClient.query(
      "SELECT id, company_name, company_code, database_name, status FROM companies ORDER BY created_at ASC"
    );

    if (companies.rowCount === 0) {
      console.log('No registered companies found in master DB.');
      return;
    }

    for (const company of companies.rows) {
      console.log(`\nCompany: ${company.company_name} (${company.company_code}) | DB: ${company.database_name} | Status: ${company.status}`);
      if (!company.database_name || company.status === 'failed') {
        console.log('  [!] Skipping database check (status failed or database missing)');
        continue;
      }

      try {
        const tenantPool = getTenantPool(company.database_name);
        const tenantClient = await tenantPool.connect();
        try {
          const appliedRes = await tenantClient.query(
            "SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC"
          ).catch(() => ({ rows: [] }));

          const appliedVersions = new Set(appliedRes.rows.map((r) => r.version));
          
          console.log(`  Applied Migrations (${appliedRes.rows.length}):`);
          appliedRes.rows.forEach((r) => {
            console.log(`    ✓ [v${r.version}] ${r.name} (applied: ${r.applied_at ? new Date(r.applied_at).toISOString() : 'N/A'})`);
          });

          const pending = migrationMap.filter((m) => !appliedVersions.has(m.version));
          if (pending.length > 0) {
            console.log(`  Pending Migrations (${pending.length}):`);
            pending.forEach((m) => console.log(`    ⏳ [v${m.version}] ${m.name}`));
          } else {
            console.log('  ✓ Up to date (0 pending)');
          }
        } finally {
          tenantClient.release();
        }
      } catch (err) {
        console.error(`  [!] Error querying tenant database [${company.database_name}]: ${err.message}`);
      }
    }
  } finally {
    masterClient.release();
    await closeAllTenantPools();
    await masterPool.end();
  }
}

if (require.main === module) {
  checkMigrationStatus().catch((err) => {
    console.error('Fatal error checking migration status:', err);
    process.exit(1);
  });
}

module.exports = { checkMigrationStatus };
