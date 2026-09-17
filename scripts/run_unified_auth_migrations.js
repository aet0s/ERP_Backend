'use strict';

/**
 * run_unified_auth_migrations.js — Migration Script for Part A, Part C, and Part G.
 * 1. Enhances users table in all tenant DBs with vendor_id, customer_id, status, invite & reset columns.
 * 2. Creates role_permissions table in all tenant DBs & seeds default permission matrices for all 6 roles.
 * 3. Migrates all records from vendor_portal_users and customer_portal_users into the unified users table.
 * 4. Creates platform_admins table in masterDb and seeds default platform admin.
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { queryMaster } = require('../db/masterDb');
const { getTenantPool } = require('../db/tenantManager');

const BCRYPT_ROUNDS = 12;

const MODULES = [
  'dashboard', 'catalog', 'inventory', 'procurement',
  'production', 'sales', 'parties', 'expenses',
  'locations', 'reports', 'settings', 'vendor_orders', 'customer_orders', 'returns'
];

async function runMigrations() {
  console.log('=== STARTING UNIFIED AUTH & PERMISSIONS MIGRATIONS ===\n');

  // 1. MASTER DB: platform_admins table
  try {
    await queryMaster(`
      CREATE TABLE IF NOT EXISTS platform_admins (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        status VARCHAR(25) NOT NULL DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login_at DATETIME NULL
      )
    `);
    console.log('[MasterDB] platform_admins table verified.');

    // Seed default platform admin if missing
    const adminCheck = await queryMaster('SELECT id FROM platform_admins WHERE email = ?', ['admin@platform.com']);
    if (adminCheck.rows.length === 0) {
      const adminHash = await bcrypt.hash('123456', BCRYPT_ROUNDS);
      await queryMaster(
        `INSERT INTO platform_admins (id, name, email, password_hash, status) VALUES (?, ?, ?, ?, 'active')`,
        [crypto.randomUUID(), 'Platform Super Admin', 'admin@platform.com', adminHash]
      );
      console.log('[MasterDB] Seeded default platform admin: admin@platform.com / 123456');
    }
  } catch (err) {
    console.error('[MasterDB] Error setting up platform_admins:', err.message);
  }

  // 2. TENANT DBS MIGRATIONS
  const compRes = await queryMaster('SELECT id, company_name, database_name FROM companies WHERE status != ?', ['cancelled']);
  const companies = compRes.rows;

  for (const comp of companies) {
    console.log(`\n--- Migrating Tenant DB: ${comp.company_name} (${comp.database_name}) ---`);
    const tenantDb = getTenantPool(comp.database_name);

    // A. Update users table columns
    const columns = [
      "ALTER TABLE users ADD COLUMN vendor_id VARCHAR(36) NULL",
      "ALTER TABLE users ADD COLUMN customer_id VARCHAR(36) NULL",
      "ALTER TABLE users ADD COLUMN status VARCHAR(25) NOT NULL DEFAULT 'active'",
      "ALTER TABLE users ADD COLUMN invite_token VARCHAR(255) NULL",
      "ALTER TABLE users ADD COLUMN invite_expires_at DATETIME NULL",
      "ALTER TABLE users ADD COLUMN invite_accepted_at DATETIME NULL",
      "ALTER TABLE users ADD COLUMN reset_token VARCHAR(255) NULL",
      "ALTER TABLE users ADD COLUMN reset_expires_at DATETIME NULL"
    ];

    for (const colSql of columns) {
      await tenantDb.query(colSql).catch(() => {}); // ignore duplicate column errors
    }
    console.log('  [Schema] users table columns updated.');

    // B. Create role_permissions table
    await tenantDb.query(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        id VARCHAR(36) PRIMARY KEY,
        role VARCHAR(50) NOT NULL,
        module VARCHAR(50) NOT NULL,
        can_view TINYINT(1) NOT NULL DEFAULT 0,
        can_create TINYINT(1) NOT NULL DEFAULT 0,
        can_edit TINYINT(1) NOT NULL DEFAULT 0,
        can_delete TINYINT(1) NOT NULL DEFAULT 0,
        can_approve TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_role_module (role, module)
      )
    `);
    console.log('  [Schema] role_permissions table verified.');

    // C. Seed default permissions for all 6 roles
    const defaultMatrix = {
      owner: MODULES.map(m => ({ module: m, v: 1, c: 1, e: 1, d: 1, a: 1 })),
      accounts: [
        { module: 'dashboard', v: 1, c: 0, e: 0, d: 0, a: 0 },
        { module: 'catalog', v: 1, c: 0, e: 0, d: 0, a: 0 },
        { module: 'sales', v: 1, c: 1, e: 1, d: 0, a: 1 },
        { module: 'parties', v: 1, c: 1, e: 1, d: 0, a: 0 },
        { module: 'expenses', v: 1, c: 1, e: 1, d: 1, a: 1 },
        { module: 'reports', v: 1, c: 0, e: 0, d: 0, a: 0 },
        { module: 'returns', v: 1, c: 1, e: 1, d: 0, a: 1 }
      ],
      production_manager: [
        { module: 'dashboard', v: 1, c: 0, e: 0, d: 0, a: 0 },
        { module: 'catalog', v: 1, c: 1, e: 1, d: 0, a: 0 },
        { module: 'inventory', v: 1, c: 1, e: 1, d: 0, a: 0 },
        { module: 'procurement', v: 1, c: 1, e: 1, d: 0, a: 1 },
        { module: 'production', v: 1, c: 1, e: 1, d: 0, a: 1 },
        { module: 'locations', v: 1, c: 0, e: 0, d: 0, a: 0 }
      ],
      sales_manager: [
        { module: 'dashboard', v: 1, c: 0, e: 0, d: 0, a: 0 },
        { module: 'catalog', v: 1, c: 0, e: 0, d: 0, a: 0 },
        { module: 'inventory', v: 1, c: 0, e: 0, d: 0, a: 0 },
        { module: 'sales', v: 1, c: 1, e: 1, d: 0, a: 1 },
        { module: 'parties', v: 1, c: 1, e: 1, d: 0, a: 0 }
      ],
      vendor: [
        { module: 'vendor_orders', v: 1, c: 0, e: 1, d: 0, a: 0 },
        { module: 'returns', v: 0, c: 1, e: 0, d: 0, a: 0 } // Initiate only, CANNOT approve
      ],
      customer: [
        { module: 'customer_orders', v: 1, c: 0, e: 1, d: 0, a: 0 },
        { module: 'returns', v: 0, c: 1, e: 0, d: 0, a: 0 }
      ]
    };

    for (const [role, perms] of Object.entries(defaultMatrix)) {
      for (const p of perms) {
        await tenantDb.query(`
          INSERT INTO role_permissions (id, role, module, can_view, can_create, can_edit, can_delete, can_approve)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            can_view = VALUES(can_view), can_create = VALUES(can_create),
            can_edit = VALUES(can_edit), can_delete = VALUES(can_delete),
            can_approve = VALUES(can_approve)
        `, [crypto.randomUUID(), role, p.module, p.v, p.c, p.e, p.d, p.a]);
      }
    }
    console.log('  [Permissions] Default role_permissions seeded.');

    // D. Migrate vendor_portal_users into users table
    const vpUsers = await tenantDb.query('SELECT * FROM vendor_portal_users').catch(() => ({ rows: [] }));
    console.log(`  [Migration] Found ${vpUsers.rows.length} vendor_portal_users records.`);

    let vpMigrated = 0;
    for (const vpu of vpUsers.rows) {
      const existing = await tenantDb.query('SELECT id FROM users WHERE email = ?', [vpu.email]);
      if (existing.rows.length === 0) {
        await tenantDb.query(`
          INSERT INTO users (id, name, email, password_hash, role, vendor_id, status, invite_token, invite_expires_at, invite_accepted_at, last_login_at, created_at)
          VALUES (?, ?, ?, ?, 'vendor', ?, ?, ?, ?, ?, ?, ?)
        `, [
          vpu.id, vpu.name, vpu.email, vpu.password_hash || '$2b$12$e.g.dummy',
          vpu.vendor_id, vpu.status || 'active', vpu.invite_token,
          vpu.invite_expires_at, vpu.invite_accepted_at, vpu.last_login_at, vpu.created_at
        ]);
        vpMigrated++;
      } else {
        await tenantDb.query(`
          UPDATE users SET role = 'vendor', vendor_id = ?, password_hash = COALESCE(password_hash, ?) WHERE email = ?
        `, [vpu.vendor_id, vpu.password_hash, vpu.email]);
        vpMigrated++;
      }
    }
    console.log(`  [Migration] Migrated ${vpMigrated} vendor users to users table.`);

    // E. Migrate customer_portal_users into users table
    const cpUsers = await tenantDb.query('SELECT * FROM customer_portal_users').catch(() => ({ rows: [] }));
    console.log(`  [Migration] Found ${cpUsers.rows.length} customer_portal_users records.`);

    let cpMigrated = 0;
    for (const cpu of cpUsers.rows) {
      const existing = await tenantDb.query('SELECT id FROM users WHERE email = ?', [cpu.email]);
      if (existing.rows.length === 0) {
        await tenantDb.query(`
          INSERT INTO users (id, name, email, password_hash, role, customer_id, status, invite_token, invite_expires_at, invite_accepted_at, last_login_at, created_at)
          VALUES (?, ?, ?, ?, 'customer', ?, ?, ?, ?, ?, ?, ?)
        `, [
          cpu.id, cpu.name, cpu.email, cpu.password_hash || '$2b$12$e.g.dummy',
          cpu.customer_id, cpu.status || 'active', cpu.invite_token,
          cpu.invite_expires_at, cpu.invite_accepted_at, cpu.last_login_at, cpu.created_at
        ]);
        cpMigrated++;
      } else {
        await tenantDb.query(`
          UPDATE users SET role = 'customer', customer_id = ?, password_hash = COALESCE(password_hash, ?) WHERE email = ?
        `, [cpu.customer_id, cpu.password_hash, cpu.email]);
        cpMigrated++;
      }
    }
    console.log(`  [Migration] Migrated ${cpMigrated} customer users to users table.`);

    // F. Verify final counts in users table
    const finalUsersCount = await tenantDb.query('SELECT COUNT(*) as count FROM users');
    const vendorsInUsersCount = await tenantDb.query("SELECT COUNT(*) as count FROM users WHERE role = 'vendor'");
    const customersInUsersCount = await tenantDb.query("SELECT COUNT(*) as count FROM users WHERE role = 'customer'");

    console.log(`  [Verification] Total users: ${finalUsersCount.rows[0].count} (Vendors: ${vendorsInUsersCount.rows[0].count}, Customers: ${customersInUsersCount.rows[0].count})`);
  }

  console.log('\n======================================================');
  console.log('SUCCESS: UNIFIED AUTH & PERMISSIONS MIGRATION COMPLETED!');
  console.log('======================================================');
  process.exit(0);
}

runMigrations().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
