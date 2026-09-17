require('dotenv').config();
const { masterPool, queryMaster } = require('../db/masterDb');
const { getTenantPool } = require('../db/tenantManager');
const { runMasterMigrations, runTenantMigrations } = require('../db/migrationRunner');

(async () => {
  try {
    console.log('Running master database migrations...');
    await runMasterMigrations();
    console.log('Master migrations applied successfully.');

    // Find all active companies and run tenant migrations
    const companies = await queryMaster('SELECT id, company_name, database_name FROM companies WHERE status != \'deleted\'');
    console.log(`Found ${companies.rowCount} company database(s) to migrate.`);

    for (const company of companies.rows) {
      console.log(`Migrating company database [${company.company_name}] (${company.database_name})...`);
      const tenantPool = getTenantPool(company.database_name);
      await runTenantMigrations(tenantPool);
    }

    console.log('All migrations completed successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
})();
