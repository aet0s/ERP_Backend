'use strict';

require('dotenv').config();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { queryMaster } = require('../db/masterDb');
const { runMasterMigrations } = require('../db/migrationRunner');

const PLATFORM_ADMIN_EMAIL = 'admin@platform.com';
const PLATFORM_ADMIN_PASSWORD = 'PlatformAdmin2026!';
const BCRYPT_ROUNDS = 12;

async function seedPlatformAdmin() {
  console.log('===========================================================');
  console.log('SEEDING PLATFORM SUPER ADMIN');
  console.log('===========================================================');

  try {
    console.log('1. Running Master Migrations...');
    await runMasterMigrations();

    console.log('2. Creating Platform Admin user...');
    const passwordHash = await bcrypt.hash(PLATFORM_ADMIN_PASSWORD, BCRYPT_ROUNDS);
    const adminId = crypto.randomUUID();

    await queryMaster(
      `INSERT INTO platform_admins (id, name, email, password_hash, status)
       VALUES (?, 'Platform Super Admin', ?, ?, 'active')
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), status = 'active'`,
      [adminId, PLATFORM_ADMIN_EMAIL, passwordHash]
    );

    console.log('\n✓ Platform Super Admin Created Successfully!');
    console.log('===========================================================');
    console.log('PLATFORM SUPER ADMIN LOGIN:');
    console.log('===========================================================');
    console.log(`Email:    ${PLATFORM_ADMIN_EMAIL}`);
    console.log(`Password: ${PLATFORM_ADMIN_PASSWORD}`);
    console.log('===========================================================\n');
  } catch (err) {
    console.error('Platform admin seed error:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  seedPlatformAdmin().then(() => process.exit(0));
}

module.exports = { seedPlatformAdmin };