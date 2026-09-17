require('dotenv').config();
const { getTenantPool } = require('../db/tenantManager');
const { queryMaster } = require('../db/masterDb');
const { runTenantMigrations } = require('../db/migrationRunner');

(async () => {
  try {
    const companies = await queryMaster("SELECT id, company_name, database_name FROM companies WHERE status != 'deleted'");
    for (const company of companies.rows) {
      console.log('Migrating tenant:', company.company_name, company.database_name);
      const pool = getTenantPool(company.database_name);
      await runTenantMigrations(pool);
    }
    console.log('✅ Migrations applied successfully!');
    process.exit(0);
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  }
})();
