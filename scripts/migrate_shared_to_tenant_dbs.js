require('dotenv').config();
const mysql = require('mysql2/promise');
const { masterPool, queryMaster } = require('../db/masterDb');
const { getTenantPool } = require('../db/tenantManager');
const { runMasterMigrations, runTenantMigrations } = require('../db/migrationRunner');
const { sanitizeDatabaseName } = require('../db/provisionTenant');

const oldDbUrl = process.env.OLD_DATABASE_URL || process.env.DATABASE_URL || 'mysql://root:@localhost:3306/erp_master';

async function migrateWorkspace(workspace) {
  const companyId = workspace.id;
  const dbName = sanitizeDatabaseName(companyId);
  console.log(`\n==================================================`);
  console.log(`Migrating Company: ${workspace.name} (ID: ${companyId})`);
  console.log(`Target Database: ${dbName}`);
  console.log(`==================================================`);

  // 1. Ensure master DB company record exists
  let companyRes = await queryMaster('SELECT * FROM companies WHERE id = ?', [companyId]);
  if (companyRes.rowCount === 0) {
    console.log(`Creating master company record for [${workspace.name}]...`);
    await queryMaster(
      `INSERT INTO companies (id, company_name, company_code, database_name, status, business_type, currency, plan, logo_url, accent_color, onboarding_completed_at, created_at)
       VALUES (?, ?, ?, ?, 'provisioning', ?, ?, COALESCE(?, 'trial'), ?, COALESCE(?, '#2563eb'), ?, COALESCE(?, NOW()))`,
      [
        companyId,
        workspace.name,
        `COMP-${companyId.slice(0, 4).toUpperCase()}`,
        dbName,
        workspace.business_type || null,
        workspace.currency || 'INR',
        workspace.plan || 'trial',
        workspace.logo_url || null,
        workspace.accent_color || '#2563eb',
        workspace.onboarding_completed_at || null,
        workspace.created_at || new Date()
      ]
    );
  }

  // 2. Create database if missing
  const masterConn = await masterPool.getConnection();
  try {
    await masterConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
  } finally {
    masterConn.release();
  }

  // 3. Apply tenant migrations
  const tenantPool = getTenantPool(dbName);
  await runTenantMigrations(tenantPool);

  const tenantClient = tenantPool.connect ? await tenantPool.connect() : await tenantPool.getConnection();
  const report = {};

  try {
    await tenantClient.query('START TRANSACTION');

    const copyTable = async (table, selectQuery, selectParams, insertColumns, convertRow) => {
      const sourceRows = await masterPool.query(selectQuery, selectParams);
      let copied = 0;
      for (const row of sourceRows.rows) {
        const values = convertRow(row);
        const markers = values.map(() => '?').join(',');
        const colList = insertColumns.join(',');
        await tenantClient.query(
          `INSERT IGNORE INTO ${table} (${colList}) VALUES (${markers})`,
          values
        );
        copied++;
      }
      report[table] = { expected: sourceRows.rowCount, copied };
    };

    // Copy users
    await copyTable(
      'users',
      'SELECT * FROM users WHERE workspace_id = ?',
      [companyId],
      ['id', 'name', 'email', 'password_hash', 'role', 'deleted_at', 'last_login_at', 'created_at'],
      (r) => [r.id, r.name, r.email, r.password_hash, r.role, r.deleted_at, r.last_login_at, r.created_at]
    );

    // Map users in master DB company_users
    const usersRes = await masterPool.query('SELECT * FROM users WHERE workspace_id = ?', [companyId]);
    for (const u of usersRes.rows) {
      await queryMaster(
        `INSERT INTO company_users (id, company_id, email, user_id, role, status)
         VALUES (?, ?, ?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE company_id = VALUES(company_id), user_id = VALUES(user_id)`,
        [require('crypto').randomUUID(), companyId, u.email.toLowerCase(), u.id, u.role]
      );
    }

    // Copy master data tables
    await copyTable(
      'raw_materials',
      'SELECT * FROM raw_materials WHERE workspace_id = ?',
      [companyId],
      ['id', 'name', 'unit', 'reorder_level', 'updated_at', 'deleted_at', 'deleted_by', 'created_at'],
      (r) => [r.id, r.name, r.unit, r.reorder_level, r.updated_at || r.created_at, r.deleted_at, r.deleted_by, r.created_at]
    );

    await copyTable(
      'process_stages',
      'SELECT * FROM process_stages WHERE workspace_id = ?',
      [companyId],
      ['id', 'name', 'sequence_order', 'is_final_stage', 'updated_at', 'deleted_at', 'deleted_by', 'created_at'],
      (r) => [r.id, r.name, r.sequence_order, r.is_final_stage, r.updated_at || r.created_at, r.deleted_at, r.deleted_by, r.created_at]
    );

    await copyTable(
      'finished_goods',
      'SELECT * FROM finished_goods WHERE workspace_id = ?',
      [companyId],
      ['id', 'name', 'unit', 'default_price', 'reorder_level', 'updated_at', 'deleted_at', 'deleted_by', 'created_at'],
      (r) => [r.id, r.name, r.unit, r.default_price, r.reorder_level, r.updated_at || r.created_at, r.deleted_at, r.deleted_by, r.created_at]
    );

    await copyTable(
      'vendors',
      'SELECT * FROM vendors WHERE workspace_id = ?',
      [companyId],
      ['id', 'name', 'contact', 'address', 'updated_at', 'deleted_at', 'deleted_by', 'created_at'],
      (r) => [r.id, r.name, r.contact, r.address, r.updated_at || r.created_at, r.deleted_at, r.deleted_by, r.created_at]
    );

    await copyTable(
      'customers',
      'SELECT * FROM customers WHERE workspace_id = ?',
      [companyId],
      ['id', 'name', 'contact', 'address', 'updated_at', 'deleted_at', 'deleted_by', 'created_at'],
      (r) => [r.id, r.name, r.contact, r.address, r.updated_at || r.created_at, r.deleted_at, r.deleted_by, r.created_at]
    );

    await tenantClient.query('COMMIT');
    await queryMaster("UPDATE companies SET status = 'active' WHERE id = ?", [companyId]);

    console.log(`Migration Summary for [${workspace.name}]:`);
    for (const [t, stats] of Object.entries(report)) {
      console.log(`  ${t.padEnd(20)}: ${stats.copied} / ${stats.expected} records`);
    }
    console.log(`Status: SUCCESS for ${workspace.name}\n`);
  } catch (err) {
    await tenantClient.query('ROLLBACK').catch(() => {});
    console.error(`Migration failed for ${workspace.name}:`, err);
    await queryMaster("UPDATE companies SET status = 'failed' WHERE id = ?", [companyId]);
    throw err;
  } finally {
    tenantClient.release();
  }
}

(async () => {
  try {
    console.log('Starting shared DB -> Database-Per-Company migration...');
    await runMasterMigrations();
    console.log('Shared DB migration script ready for MySQL.');
    process.exit(0);
  } catch (err) {
    console.error('Data migration error:', err);
    process.exit(1);
  }
})();
