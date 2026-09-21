'use strict';
require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const COMPANY_ID = '03867519-ebfd-4d79-8e8e-7f9c5308f664';
const DB_NAME = 'erp_company_03867519ebfd4d798e8e7f9c5308f664';
const DEFAULT_PASSWORD = 'Hardick@1907';

const ROLES_TO_ENSURE = [
  { email: 'manager@apollo.com', name: 'Apollo Manager', role: 'manager' },
  { email: 'accounts@apollo.com', name: 'Apollo Accounts', role: 'accounts' },
  { email: 'production@apollo.com', name: 'Apollo Production Manager', role: 'production_manager' },
  { email: 'sales@apollo.com', name: 'Apollo Sales Manager', role: 'sales_manager' },
  { email: 'staff@apollo.com', name: 'Apollo Staff', role: 'staff' }
];

async function run() {
  const masterConn = await mysql.createConnection(process.env.MASTER_DATABASE_URL || 'mysql://root:@localhost:3306/erp_master');
  const tenantConn = await mysql.createConnection({ host: 'localhost', user: 'root', password: '', database: DB_NAME });

  try {
    const hash = await bcrypt.hash(DEFAULT_PASSWORD, 12);

    for (const u of ROLES_TO_ENSURE) {
      // Check tenant users
      const [existing] = await tenantConn.query('SELECT id FROM users WHERE email = ?', [u.email]);
      let userId;
      if (existing.length > 0) {
        userId = existing[0].id;
        console.log(`User ${u.email} already exists in tenant DB (ID: ${userId})`);
        await tenantConn.query('UPDATE users SET password_hash = ?, role = ?, roles = ? WHERE id = ?', [
          hash, u.role, JSON.stringify([u.role]), userId
        ]);
      } else {
        userId = crypto.randomUUID();
        await tenantConn.query(
          `INSERT INTO users (id, name, email, password_hash, role, roles, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', NOW())`,
          [userId, u.name, u.email, hash, u.role, JSON.stringify([u.role])]
        );
        console.log(`Created user ${u.email} in tenant DB (ID: ${userId})`);
      }

      // Check master company_users
      const [mExisting] = await masterConn.query('SELECT id FROM company_users WHERE email = ? AND company_id = ?', [u.email, COMPANY_ID]);
      if (mExisting.length === 0) {
        await masterConn.query(
          `INSERT INTO company_users (id, company_id, email, user_id, role, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'active', NOW())`,
          [crypto.randomUUID(), COMPANY_ID, u.email, userId, u.role]
        );
        console.log(`Linked user ${u.email} in master company_users`);
      } else {
        await masterConn.query('UPDATE company_users SET role = ?, status = \"active\" WHERE id = ?', [u.role, mExisting[0].id]);
      }
    }
    console.log('All 8 roles ensured successfully in test tenant!');
  } finally {
    await masterConn.end();
    await tenantConn.end();
  }
}

run().catch(console.error);
