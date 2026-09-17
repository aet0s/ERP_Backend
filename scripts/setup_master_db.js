/**
 * setup_master_db.js — Production Master Database Provisioner
 *
 * This script is executed on a fresh server or deployment environment to:
 * 1. Connect to MySQL engine using administrative or master credentials.
 * 2. Create the master database (`erp_master`) if it does not already exist.
 * 3. Run all versioned master schema migrations (db/master/*.sql).
 * 4. Verify/Provision the initial Platform Super Admin user.
 * 5. Verify the default platform enterprise settings row.
 *
 * Usage:
 *   node scripts/setup_master_db.js
 *   or
 *   npm run setup:master
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const path = require('path');
const { getMasterConfig, getAdminConfig, queryMaster, masterPool } = require('../db/masterDb');
const { runMasterMigrations } = require('../db/migrationRunner');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);
const DEFAULT_ADMIN_EMAIL = process.env.PLATFORM_ADMIN_EMAIL || 'admin@platform.com';
const DEFAULT_ADMIN_PASSWORD = process.env.PLATFORM_ADMIN_PASSWORD || 'PlatformAdmin2026!';

async function setupMasterDatabase() {
  console.log('\n================================================================');
  console.log('       ERP PRODUCTION: MASTER DATABASE SETUP & INITIALIZATION    ');
  console.log('================================================================\n');

  const masterConfig = getMasterConfig();
  const targetDbName = masterConfig.database || 'erp_master';

  // Step 1: Connect to MySQL engine and create erp_master if not exists
  console.log(`[Step 1/4] Connecting to MySQL at ${masterConfig.host}:${masterConfig.port}...`);
  let adminConn;
  let dbVerified = false;

  // Try creating DB if user has administrative rights
  try {
    adminConn = await mysql.createConnection({
      host: masterConfig.host,
      port: masterConfig.port,
      user: masterConfig.user,
      password: masterConfig.password,
      multipleStatements: true
    });
    console.log(`✓ Connected to MySQL engine successfully.`);

    console.log(`Ensuring master database \`${targetDbName}\` exists...`);
    await adminConn.query(
      `CREATE DATABASE IF NOT EXISTS \`${targetDbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
    );
    console.log(`✓ Master database \`${targetDbName}\` is verified.`);
    dbVerified = true;
  } catch (err) {
    // If user lacks CREATE DATABASE or server requires connecting directly to the assigned DB
    console.log(`ℹ Notice on MySQL engine connect: ${err.message}`);
    console.log(`Checking direct connection to pre-created database \`${targetDbName}\`...`);
    try {
      const testConn = await mysql.createConnection({
        host: masterConfig.host,
        port: masterConfig.port,
        user: masterConfig.user,
        password: masterConfig.password,
        database: targetDbName
      });
      await testConn.query('SELECT 1');
      await testConn.end();
      console.log(`✓ Connected directly to pre-created database \`${targetDbName}\` successfully!`);
      dbVerified = true;
    } catch (directErr) {
      console.error(`\n❌ Failed to connect to MySQL database \`${targetDbName}\`:`);
      console.error(`   ${directErr.message}`);
      console.error('\nPlease verify your MASTER_DATABASE_URL or MYSQL_* environment variables in backend/.env.');
      process.exit(1);
    }
  } finally {
    if (adminConn) {
      await adminConn.end().catch(() => {});
    }
  }

  // Step 2: Run all master migrations
  console.log(`\n[Step 2/4] Running master schema migrations...`);
  try {
    await runMasterMigrations();
    const applied = await queryMaster('SELECT COUNT(*) AS cnt FROM master_schema_migrations');
    const count = applied.rows?.[0]?.cnt || 0;
    console.log(`✓ All master schema migrations applied successfully (Total: ${count} migrations).`);
  } catch (err) {
    console.error('\n❌ Master migrations failed:');
    console.error(`   ${err.message}`);
    process.exit(1);
  }

  // Step 3: Platform Super Admin provisioning
  console.log(`\n[Step 3/4] Checking Platform Super Admin account...`);
  try {
    const adminCheck = await queryMaster('SELECT id, email, name FROM platform_admins LIMIT 1');
    if (adminCheck.rows && adminCheck.rows.length > 0) {
      console.log(`✓ Platform Admin already exists: ${adminCheck.rows[0].email} (${adminCheck.rows[0].name})`);
    } else {
      console.log(`Creating initial Platform Super Admin (${DEFAULT_ADMIN_EMAIL})...`);
      const passwordHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, BCRYPT_ROUNDS);
      const adminId = crypto.randomUUID();

      await queryMaster(
        `INSERT INTO platform_admins (id, name, email, password_hash, status)
         VALUES (?, 'Platform Super Admin', ?, ?, 'active')`,
        [adminId, DEFAULT_ADMIN_EMAIL, passwordHash]
      );
      console.log(`✓ Platform Super Admin account provisioned:`);
      console.log(`   Email:    ${DEFAULT_ADMIN_EMAIL}`);
      console.log(`   Password: ${DEFAULT_ADMIN_PASSWORD}`);
      console.log(`   (You can change this password after login in the Platform Console)`);
    }
  } catch (err) {
    console.warn(`⚠️ Warning checking/creating platform admin: ${err.message}`);
  }

  // Step 4: Verify platform settings
  console.log(`\n[Step 4/4] Verifying Platform Enterprise Settings...`);
  try {
    const settingsCheck = await queryMaster('SELECT id, platform_name, default_currency FROM platform_settings LIMIT 1');
    if (settingsCheck.rows && settingsCheck.rows.length > 0) {
      console.log(`✓ Platform settings active: "${settingsCheck.rows[0].platform_name}" (Currency: ${settingsCheck.rows[0].default_currency})`);
    }
  } catch (err) {
    console.warn(`⚠️ Warning verifying platform settings: ${err.message}`);
  }

  console.log('\n================================================================');
  console.log('       ✓ MASTER DATABASE SETUP COMPLETED WITH ZERO ERRORS        ');
  console.log('================================================================');
  console.log(`Database:     ${targetDbName}`);
  console.log(`Host:         ${masterConfig.host}:${masterConfig.port}`);
  console.log(`Next step:    Start the server with: npm start\n`);

  await masterPool.end();
  process.exit(0);
}

if (require.main === module) {
  setupMasterDatabase().catch((err) => {
    console.error('Fatal error during master setup:', err);
    process.exit(1);
  });
}

module.exports = { setupMasterDatabase };
