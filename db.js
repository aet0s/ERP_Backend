const { masterPool, queryMaster, getAdminPool } = require('./db/masterDb');
const { getTenantPool, closeAllTenantPools } = require('./db/tenantManager');
const { runMasterMigrations, runTenantMigrations } = require('./db/migrationRunner');
const { provisionTenant } = require('./db/provisionTenant');

module.exports = {
  // Master DB
  masterPool,
  queryMaster,
  query: queryMaster, // Fallback for master queries
  getAdminPool,

  // Tenant DB
  getTenantPool,
  closeAllTenantPools,

  // Provisioning & Migrations
  provisionTenant,
  runMasterMigrations,
  runTenantMigrations
};
