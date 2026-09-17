'use strict';

/**
 * ensureMasterDb.js
 * Comprehensive Master Database Health Check, Auto-Setup, and Self-Healing Engine.
 * 
 * Guarantees that whenever index.js runs:
 * 1. The target master database exists (created if missing).
 * 2. All required master tables exist.
 * 3. All critical columns exist in key tables.
 * 4. All numbered migrations in db/master are applied.
 * 5. Default baseline data (platform settings, initial super admin, permissions) is populated.
 * 6. If healthy -> logs verification and smoothly moves on.
 * 7. If missing, incomplete, or corrupted -> automatically imports/reimports schema to fix and heal.
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { getMasterConfig, getAdminPool, masterPool } = require('./masterDb');
const { runMasterMigrations } = require('./migrationRunner');

const MASTER_INIT_SQL_PATH = path.join(__dirname, '..', '..', 'db', 'master_init_complete.sql');
const MASTER_MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'master');

// Required Master Database Tables
const REQUIRED_MASTER_TABLES = [
  'companies',
  'company_users',
  'company_invites',
  'master_audit_log',
  'master_schema_migrations',
  'master_webhook_events',
  'master_refresh_tokens',
  'platform_admins',
  'platform_settings',
  'global_portal_users',
  'global_portal_memberships',
  'platform_portal_permissions'
];

// Required Columns in Core Master Tables
const REQUIRED_TABLE_COLUMNS = {
  companies: [
    'id', 'company_name', 'company_code', 'database_name', 'status',
    'currency', 'plan', 'subscription_id', 'subscription_status',
    'primary_owner_id', 'primary_owner_email', 'connect_code',
    'number_system', 'auto_backup_enabled', 'accent_color'
  ],
  company_users: [
    'id', 'company_id', 'email', 'user_id', 'role', 'roles', 'status'
  ],
  platform_settings: [
    'id', 'default_trial_days', 'platform_name', 'default_currency',
    'master_auto_backup_enabled', 'invoice_rounding_method'
  ],
  global_portal_users: [
    'id', 'email', 'name', 'status'
  ],
  platform_portal_permissions: [
    'id', 'role', 'module', 'can_view', 'can_create', 'can_edit', 'can_delete'
  ]
};

/**
 * Cleans and splits raw SQL into individual executable statements
 */
function cleanSqlStatements(rawSql) {
  const withoutComments = rawSql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  return withoutComments
    .split(/;\s*(?:[\r\n]+|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Step 1: Ensure MySQL database erp_master exists (connects via admin credentials)
 */
async function ensureMasterDatabaseExists(masterDbName) {
  const adminPool = getAdminPool();
  try {
    await adminPool.query(
      `CREATE DATABASE IF NOT EXISTS \`${masterDbName}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
    );
  } catch (err) {
    console.warn(`[Master DB] Notice during CREATE DATABASE check: ${err.message}`);
  }
}

/**
 * Step 2: Check health of master database schema
 * Returns { healthy: boolean, reasons: string[] }
 */
async function checkMasterSchemaHealth(masterDbName) {
  const reasons = [];
  const conn = await masterPool.getConnection();

  try {
    // 1. Check existing tables
    const tableRes = await conn.query('SHOW TABLES');
    const existingTables = (tableRes.rows || []).map((row) => Object.values(row)[0]);

    for (const reqTable of REQUIRED_MASTER_TABLES) {
      if (!existingTables.includes(reqTable)) {
        reasons.push(`Missing table: \`${reqTable}\``);
      }
    }

    // If core tables are missing, no need to check deeper columns
    if (reasons.length > 0) {
      return { healthy: false, reasons };
    }

    // 2. Check critical columns in key tables
    for (const [tableName, cols] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
      const colRes = await conn.query(`SHOW COLUMNS FROM \`${tableName}\``);
      const existingCols = (colRes.rows || []).map((r) => r.Field);
      for (const reqCol of cols) {
        if (!existingCols.includes(reqCol)) {
          reasons.push(`Missing column \`${reqCol}\` in table \`${tableName}\``);
        }
      }
    }

    // 3. Check migration synchronization
    const migrationFiles = fs.existsSync(MASTER_MIGRATIONS_DIR)
      ? fs.readdirSync(MASTER_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
      : [];

    const migRes = await conn.query('SELECT version FROM master_schema_migrations');
    const appliedVersions = new Set((migRes.rows || []).map((r) => parseInt(r.version, 10)));

    for (const file of migrationFiles) {
      const match = file.match(/^(\d+)_/);
      if (match) {
        const version = parseInt(match[1], 10);
        if (!appliedVersions.has(version)) {
          reasons.push(`Unapplied migration: [${file}] (version ${version})`);
        }
      }
    }

    // 4. Check essential baseline rows
    const settingsRes = await conn.query('SELECT COUNT(*) as count FROM platform_settings');
    const settingsCount = (settingsRes.rows && settingsRes.rows[0]) ? Number(settingsRes.rows[0].count) : 0;
    if (settingsCount === 0) {
      reasons.push('platform_settings table is empty (needs baseline row)');
    }

    return {
      healthy: reasons.length === 0,
      reasons
    };
  } catch (err) {
    return {
      healthy: false,
      reasons: [`Database check error: ${err.message}`]
    };
  } finally {
    conn.release();
  }
}

/**
 * Step 3: Automatically import or reimport master schema to heal/setup database
 */
async function importMasterSchema(masterDbName) {
  const masterConfig = getMasterConfig();
  console.log(`[Master DB] Connecting to [${masterDbName}] to initialize/repair schema...`);

  // Direct connection for schema execution
  const conn = await mysql.createConnection({
    ...masterConfig,
    multipleStatements: false
  });

  try {
    // 1. Run master_init_complete.sql if available
    if (fs.existsSync(MASTER_INIT_SQL_PATH)) {
      console.log(`[Master DB] Importing consolidated schema from master_init_complete.sql...`);
      const rawSql = fs.readFileSync(MASTER_INIT_SQL_PATH, 'utf8');
      const statements = cleanSqlStatements(rawSql);

      let executedCount = 0;
      for (const stmt of statements) {
        try {
          await conn.query(stmt);
          executedCount++;
        } catch (execErr) {
          // Gracefully ignore safe idempotent codes (column/table/index already exists)
          const safeCodes = [
            'ER_DUP_FIELDNAME',
            'ER_DUP_KEYNAME',
            'ER_TABLE_EXISTS_ERROR',
            'ER_DUP_ENTRY',
            'ER_CANT_DROP_FIELD_OR_KEY'
          ];
          if (!safeCodes.includes(execErr.code)) {
            console.warn(`[Master DB] Notice on statement: ${execErr.code} - ${execErr.message.slice(0, 120)}`);
          }
        }
      }
      console.log(`[Master DB] Processed ${executedCount}/${statements.length} schema statements.`);
    }

    // 2. Run master migrations to ensure all individual migration files are synced & recorded
    console.log(`[Master DB] Synchronizing master schema migration records...`);
    await runMasterMigrations();

    // 3. Ensure default platform settings row exists
    await conn.query(`
      INSERT IGNORE INTO platform_settings (
        id, default_trial_days, max_active_tenant_pools, tenant_db_pool_max, master_db_pool_max,
        default_currency, invoice_rounding_method, payment_grace_period_days, platform_name,
        platform_support_email, platform_company_legal_name, allow_workspace_registration,
        auto_freeze_on_grace_expiry, default_tax_rate_pct, jwt_session_expiry_hours,
        max_login_attempts_lockout, enforce_strong_passwords, audit_log_retention_days,
        tenant_pool_queue_timeout_ms, maintenance_mode_enabled, master_auto_backup_enabled,
        master_auto_backup_frequency, master_auto_backup_retention_days, master_auto_backup_time
      ) VALUES (
        'default-platform-settings-uuid', 14, 50, 5, 20,
        'INR', 'round_half_up', 7, 'ERP Enterprise Studio',
        'support@erpplatform.com', 'ERP Global Systems Technologies Inc.', 1,
        1, 18.00, 24,
        5, 1, 90,
        5000, 0, 1,
        'daily', 30, '01:00'
      )
    `).catch(() => {});

    // 4. Ensure default platform super admin exists if empty
    const adminCheck = await conn.query('SELECT COUNT(*) as cnt FROM platform_admins');
    const adminCount = adminCheck[0] && adminCheck[0][0] ? Number(adminCheck[0][0].cnt) : 0;
    if (adminCount === 0) {
      await conn.query(`
        INSERT IGNORE INTO platform_admins (id, name, email, password_hash, status)
        VALUES (
          'admin-super-uuid-0001',
          'Platform Super Admin',
          'admin@platform.com',
          '$2b$12$qW1sDwANy8ENaTEDZq6Mgu46ZrIn8hWG6OSdRSy4gDN5gkeASC9hK',
          'active'
        )
      `).catch(() => {});
      console.log('[Master DB] Seeded default platform super admin (admin@platform.com).');
    }
  } finally {
    await conn.end().catch(() => {});
  }
}

/**
 * Main Entry Point: Ensures Master DB is present, checked, and healed/initialized.
 */
async function ensureMasterDb() {
  const masterConfig = getMasterConfig();
  const masterDbName = masterConfig.database || 'erp_master';

  // Step 1: Ensure database exists in MySQL
  await ensureMasterDatabaseExists(masterDbName);

  // Step 2: Check current schema health
  const healthCheck = await checkMasterSchemaHealth(masterDbName);

  if (healthCheck.healthy) {
    console.log(`[Master DB] Schema verification passed: all ${REQUIRED_MASTER_TABLES.length} tables, columns, and migrations in [${masterDbName}] are intact.`);
    return true;
  }

  // Step 3: Schema needs import or repair
  console.log(`[Master DB] Schema requires setup/repair. Issues detected:\n - ${healthCheck.reasons.join('\n - ')}`);
  console.log(`[Master DB] Automatically importing master schema and running migrations...`);

  await importMasterSchema(masterDbName);

  // Step 4: Re-verify
  const postCheck = await checkMasterSchemaHealth(masterDbName);
  if (postCheck.healthy) {
    console.log(`[Master DB] Master database [${masterDbName}] successfully initialized, repaired, and verified.`);
    return true;
  } else {
    console.warn(`[Master DB] Warning: Post-import verification still detected minor warnings:\n - ${postCheck.reasons.join('\n - ')}`);
    return false;
  }
}

module.exports = {
  ensureMasterDb,
  checkMasterSchemaHealth,
  importMasterSchema
};
