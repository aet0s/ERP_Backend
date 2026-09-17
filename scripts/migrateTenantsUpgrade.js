const { masterPool } = require('../db/masterDb');
const { getTenantPool, closeAllTenantPools } = require('../db/tenantManager');
const { runTenantMigrations } = require('../db/migrationRunner');

async function upgradeAllTenants() {
  console.log('--- EXECUTING MULTI-TENANT UPGRADE MIGRATIONS ---');
  const masterClient = await masterPool.connect();
  try {
    const companies = await masterClient.query(
      "SELECT id, company_name, company_code, database_name, status FROM companies WHERE status != 'failed' AND database_name IS NOT NULL ORDER BY created_at ASC"
    );

    console.log(`Found ${companies.rowCount} active tenant database(s) for upgrade.`);
    let successCount = 0;
    let failCount = 0;

    for (const company of companies.rows) {
      console.log(`\nUpgrading tenant DB: ${company.database_name} (${company.company_name})...`);
      try {
        const tenantPool = getTenantPool(company.database_name);
        await runTenantMigrations(tenantPool);
        console.log(`✓ Successfully upgraded ${company.database_name}`);
        successCount += 1;
      } catch (err) {
        console.error(`✖ Failed to upgrade ${company.database_name}: ${err.message}`);
        failCount += 1;
      }
    }

    console.log(`\n--- UPGRADE COMPLETE: ${successCount} succeeded, ${failCount} failed ---`);
  } finally {
    masterClient.release();
    await closeAllTenantPools();
    await masterPool.end();
  }
}

if (require.main === module) {
  upgradeAllTenants().catch((err) => {
    console.error('Fatal error running tenant upgrades:', err);
    process.exit(1);
  });
}

module.exports = { upgradeAllTenants };
