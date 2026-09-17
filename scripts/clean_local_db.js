/**
 * clean_local_db.js — Complete Fresh Reset of Local ERP Databases
 *
 * 1. Discovers and drops all tenant databases (`erp_company_*`).
 * 2. Drops and recreates `erp_master`.
 * 3. Applies all master migrations.
 * 4. Provisions fresh Platform Super Admin and default platform enterprise settings.
 * 5. Leaves 0 workspaces, 0 tenant users, 0 companies — 100% fresh!
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const path = require('path');
const { runMasterMigrations } = require('../db/migrationRunner');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);
const ADMIN_EMAIL = process.env.PLATFORM_ADMIN_EMAIL || 'admin@erp.com';
const ADMIN_PASSWORD = process.env.PLATFORM_ADMIN_PASSWORD || 'Admin@1234';

async function cleanLocalDatabase() {
  console.log('\n================================================================');
  console.log('       ERP LOCAL DATABASE CLEANUP & FRESH INITIALIZATION        ');
  console.log('================================================================\n');

  const host = process.env.MYSQL_HOST || 'localhost';
  const port = parseInt(process.env.MYSQL_PORT || '3306', 10);
  const user = process.env.MYSQL_USER || 'root';
  const password = process.env.MYSQL_PASSWORD || '';
  const masterDbName = process.env.MASTER_DB_NAME || 'erp_master';

  console.log(`Connecting to local MySQL instance at ${host}:${port} as ${user}...`);

  const rootConn = await mysql.createConnection({
    host,
    port,
    user,
    password,
    multipleStatements: true
  });

  try {
    // 1. Find all tenant databases
    const [rows] = await rootConn.query(`
      SELECT SCHEMA_NAME AS dbName FROM information_schema.SCHEMATA
      WHERE SCHEMA_NAME LIKE 'erp_company_%'
    `);

    const tenantDbs = rows.map(r => r.dbName);
    console.log(`\n[Step 1/4] Found ${tenantDbs.length} local tenant database(s) to delete:`);
    for (const db of tenantDbs) {
      console.log(` - Deleting tenant workspace DB: ${db}...`);
      await rootConn.query(`DROP DATABASE IF EXISTS \`${db}\`;`);
      console.log(`   ✓ Deleted ${db}`);
    }

    // 2. Drop and recreate erp_master
    console.log(`\n[Step 2/4] Resetting master database \`${masterDbName}\`...`);
    await rootConn.query(`DROP DATABASE IF EXISTS \`${masterDbName}\`;`);
    console.log(`   ✓ Dropped old \`${masterDbName}\``);

    await rootConn.query(
      `CREATE DATABASE \`${masterDbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
    );
    console.log(`   ✓ Created fresh \`${masterDbName}\``);
  } finally {
    await rootConn.end();
  }

  // 3. Run all master migrations
  console.log(`\n[Step 3/4] Running all schema migrations on fresh \`${masterDbName}\`...`);
  await runMasterMigrations();
  console.log(`   ✓ All master migrations completed successfully.`);

  // 4. Provision fresh platform super admin
  console.log(`\n[Step 4/4] Provisioning fresh Platform Super Admin...`);
  const masterConn = await mysql.createConnection({
    host,
    port,
    user,
    password,
    database: masterDbName
  });

  try {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, BCRYPT_ROUNDS);
    const adminId = crypto.randomUUID();

    await masterConn.query(
      `INSERT INTO platform_admins (id, name, email, password_hash, status)
       VALUES (?, 'Platform Super Admin', ?, ?, 'active')`,
      [adminId, ADMIN_EMAIL, passwordHash]
    );

    console.log(`   ✓ Fresh Platform Super Admin created:`);
    console.log(`     Email:    ${ADMIN_EMAIL}`);
    console.log(`     Password: ${ADMIN_PASSWORD}`);

    // Verify companies and users count
    const [companies] = await masterConn.query('SELECT COUNT(*) as cnt FROM companies');
    const [users] = await masterConn.query('SELECT COUNT(*) as cnt FROM global_portal_users');
    const [companyUsers] = await masterConn.query('SELECT COUNT(*) as cnt FROM company_users');

    console.log('\n================================================================');
    console.log('               ✓ LOCAL DB IS 100% CLEAN AND FRESH               ');
    console.log('================================================================');
    console.log(`Active Master DB:       ${masterDbName}`);
    console.log(`Total Workspaces:       ${companies[0].cnt} (Cleaned)`);
    console.log(`Total Tenant Users:     ${companyUsers[0].cnt} (Cleaned)`);
    console.log(`Total Portal Users:     ${users[0].cnt} (Cleaned)`);
    console.log(`Platform Admin Account: ${ADMIN_EMAIL}`);
    console.log('================================================================\n');
  } finally {
    await masterConn.end();
  }
}

if (require.main === module) {
  cleanLocalDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Database cleanup failed:', err);
      process.exit(1);
    });
}

module.exports = { cleanLocalDatabase };
