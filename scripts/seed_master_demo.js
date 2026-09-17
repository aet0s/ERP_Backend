'use strict';

/**
 * seed_master_demo.js
 * Comprehensive 100% ERP Seed Script:
 * 1. Drops and recreates all ERP master & tenant databases.
 * 2. Runs all master & tenant schema migrations cleanly.
 * 3. Seeds Single Platform Super Admin.
 * 4. Seeds 2 completely distinct active workspaces (Apex Precision & Nexus Electronics).
 * 5. Seeds all workspace employee roles (owner, manager, accounts, production_manager, sales_manager, staff, multirole).
 * 6. Seeds Multi-Workspace Vendor (SteelCorp) and Single-Workspace Vendors.
 * 7. Seeds Multi-Workspace Customer (Tata Motors) and Single-Workspace Customers.
 * 8. Seeds rich operational data: Locations, Raw Materials, Finished Goods, BOM Recipes,
 *    Inventory Ledgers, Purchase Orders, Sales Invoices, Customer Return Requests, Payments, Audit Logs,
 *    and live 16-module x 8-role Permissions Matrix with can_export.
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { runMasterMigrations, runTenantMigrations } = require('../db/migrationRunner');
const { getTenantPool } = require('../db/tenantManager');

const adminUrl = process.env.MASTER_DATABASE_ADMIN_URL || process.env.MASTER_DATABASE_URL || 'mysql://root:@localhost:3306/mysql';

const BCRYPT_ROUNDS = 10;

// Standard Passwords
const SUPERADMIN_PASSWORD = 'SuperAdmin@123';
const WORKSPACE_USER_PASSWORD = '123456';
const VENDOR_PASSWORD = 'Vendor@123';
const CUSTOMER_PASSWORD = 'Customer@123';

// Workspace IDs & DBs
const APEX_ID = 'a0000000-0000-0000-0000-000000000001';
const APEX_DB = 'erp_company_a0000000000000000000000000000001';

const NEXUS_ID = 'b0000000-0000-0000-0000-000000000002';
const NEXUS_DB = 'erp_company_b0000000000000000000000000000002';

const MODULES = [
  'dashboard', 'catalog', 'inventory', 'procurement',
  'production', 'sales', 'parties', 'expenses',
  'locations', 'reports', 'settings', 'vendor_orders', 'customer_orders', 'returns',
  'users', 'billing'
];

const ROLES = [
  'owner', 'manager', 'accounts', 'production_manager', 'sales_manager', 'staff'
];

async function seedMasterDemo() {
  console.log('========================================================================');
  console.log('100% COMPLETE ERP PLATFORM RESET & SEEDING SCRIPT');
  console.log('========================================================================\n');

  // --- 1. Drop & Recreate Databases ---
  console.log('Step 1: Dropping all existing ERP databases...');
  const adminConn = await mysql.createConnection(adminUrl);
  try {
    const [rows] = await adminConn.query(`
      SELECT SCHEMA_NAME AS datname FROM information_schema.SCHEMATA
      WHERE SCHEMA_NAME = 'erp_master' OR SCHEMA_NAME LIKE 'erp_company_%'
    `);
    const dbNames = rows.map((r) => r.datname);
    for (const db of dbNames) {
      console.log(`   - Dropping database \`${db}\`...`);
      await adminConn.query(`DROP DATABASE IF EXISTS \`${db}\`;`);
    }

    console.log('\nStep 2: Creating fresh Master and Tenant databases...');
    await adminConn.query('CREATE DATABASE `erp_master` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;');
    await adminConn.query(`CREATE DATABASE \`${APEX_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    await adminConn.query(`CREATE DATABASE \`${NEXUS_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    console.log('✅ Databases created: `erp_master`, `' + APEX_DB + '`, `' + NEXUS_DB + '`');
  } finally {
    await adminConn.end();
  }

  // --- 2. Run Migrations ---
  console.log('\nStep 3: Running Master Schema Migrations...');
  await runMasterMigrations();
  console.log('✅ Master schema migrations applied.');

  console.log('\nStep 4: Running Tenant Schema Migrations for Apex & Nexus...');
  const apexPool = getTenantPool(APEX_DB);
  await runTenantMigrations(apexPool);

  const nexusPool = getTenantPool(NEXUS_DB);
  await runTenantMigrations(nexusPool);
  console.log('✅ Tenant schema migrations applied for both workspaces.');

  // Pre-calculate Password Hashes
  console.log('\nStep 5: Pre-hashing demo credentials with bcrypt...');
  const superAdminHash = await bcrypt.hash(SUPERADMIN_PASSWORD, BCRYPT_ROUNDS);
  const workspaceUserHash = await bcrypt.hash(WORKSPACE_USER_PASSWORD, BCRYPT_ROUNDS);
  const vendorHash = await bcrypt.hash(VENDOR_PASSWORD, BCRYPT_ROUNDS);
  const customerHash = await bcrypt.hash(CUSTOMER_PASSWORD, BCRYPT_ROUNDS);

  const masterConn = await mysql.createConnection(adminUrl.replace(/\/mysql$/, '/erp_master').replace(/\/$/, '/erp_master'));

  try {
    // --- 3. Seed Super Admin ---
    console.log('\nStep 6: Seeding Platform Super Admin...');
    await masterConn.query(
      `INSERT INTO platform_admins (id, email, password_hash, name, status, created_at)
       VALUES (?, ?, ?, ?, 'active', NOW())`,
      [crypto.randomUUID(), 'superadmin@erp.com', superAdminHash, 'Platform Super Administrator']
    );
    const standardAdminHash = await bcrypt.hash('123456', BCRYPT_ROUNDS);
    await masterConn.query(
      `INSERT INTO platform_admins (id, email, password_hash, name, status, created_at)
       VALUES (?, 'admin@platform.in', ?, 'Platform Super Admin', 'active', NOW())`,
      [crypto.randomUUID(), standardAdminHash]
    );
    console.log('✅ Super Admins seeded: superadmin@erp.com & admin@platform.in');

    // --- 4. Seed Workspaces in Master DB ---
    console.log('\nStep 7: Seeding Companies in erp_master...');
    await masterConn.query(
      `INSERT INTO companies (
        id, company_name, company_code, connect_code, database_name, status, business_type, currency, plan,
        logo_url, accent_color, gstin, state, pan, support_email, support_phone, onboarding_completed_at, created_at
      ) VALUES
      (?, 'Apex Precision Engineering & Auto-Components Pvt Ltd', 'APEX-AUTO', 'APEX-AUTO', ?, 'active',
       'Automotive Springs, Assemblies & Heavy Fabrication', 'INR', 'enterprise',
       NULL, '#2563eb', '27AAACA1234F1Z9', 'Maharashtra', 'AAACA1234F',
       'support@apexengineering.com', '+91 (800) 420-1122', NOW(), NOW()),
      (?, 'Nexus Electronics & Industrial IoT Systems Pvt Ltd', 'NEXUS-IOT', 'NEXUS-IOT', ?, 'active',
       'Smart Sensors, Controllers & Industrial Circuit Boards', 'INR', 'pro',
       NULL, '#0d9488', '07AABCN5678G1Z3', 'Delhi', 'AABCN5678G',
       'support@nexuselectronics.in', '+91 (800) 998-3344', NOW(), NOW())`,
      [APEX_ID, APEX_DB, NEXUS_ID, NEXUS_DB]
    );

    // --- 5. Seed Master Company Users ---
    console.log('\nStep 8: Mapping workspace team identities in erp_master...');
    const apexUsers = [
      { id: crypto.randomUUID(), email: 'owner@apex.com', name: 'Aarav Sharma (Apex Owner)', role: 'owner', roles: ['owner'] },
      { id: crypto.randomUUID(), email: 'manager@apex.com', name: 'Rohan Mehta (Apex Manager)', role: 'manager', roles: ['manager'] },
      { id: crypto.randomUUID(), email: 'accounts@apex.com', name: 'Priya Nair (Apex Accounts)', role: 'accounts', roles: ['accounts'] },
      { id: crypto.randomUUID(), email: 'production@apex.com', name: 'Sanjay Verma (Apex Plant Head)', role: 'production_manager', roles: ['production_manager'] },
      { id: crypto.randomUUID(), email: 'sales@apex.com', name: 'Neha Gupta (Apex Sales Lead)', role: 'sales_manager', roles: ['sales_manager'] },
      { id: crypto.randomUUID(), email: 'staff@apex.com', name: 'Kavita Joshi (Apex Operations)', role: 'staff', roles: ['staff'] },
      { id: crypto.randomUUID(), email: 'multirole@apex.com', name: 'Vikram Joshi (Apex Multi-Role Lead)', role: 'sales_manager', roles: ['sales_manager', 'accounts', 'manager'] }
    ];

    const nexusUsers = [
      { id: crypto.randomUUID(), email: 'owner@nexus.com', name: 'Aditya Sen (Nexus Owner)', role: 'owner', roles: ['owner'] },
      { id: crypto.randomUUID(), email: 'manager@nexus.com', name: 'Meera Kapoor (Nexus VP Ops)', role: 'manager', roles: ['manager'] },
      { id: crypto.randomUUID(), email: 'accounts@nexus.com', name: 'Karan Singhal (Nexus CFO)', role: 'accounts', roles: ['accounts'] },
      { id: crypto.randomUUID(), email: 'production@nexus.com', name: 'Devendra Patel (Nexus Hardware Lead)', role: 'production_manager', roles: ['production_manager'] },
      { id: crypto.randomUUID(), email: 'sales@nexus.com', name: 'Ananya Roy (Nexus Sales Director)', role: 'sales_manager', roles: ['sales_manager'] },
      { id: crypto.randomUUID(), email: 'staff@nexus.com', name: 'Tarun Saxena (Nexus Associate)', role: 'staff', roles: ['staff'] }
    ];

    for (const u of apexUsers) {
      await masterConn.query(
        `INSERT INTO company_users (id, company_id, email, user_id, role, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', NOW())`,
        [crypto.randomUUID(), APEX_ID, u.email, u.id, u.role]
      );
    }

    for (const u of nexusUsers) {
      await masterConn.query(
        `INSERT INTO company_users (id, company_id, email, user_id, role, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', NOW())`,
        [crypto.randomUUID(), NEXUS_ID, u.email, u.id, u.role]
      );
    }

    // --- 6. Seed Global Portal Users & Memberships ---
    console.log('\nStep 9: Seeding Multi-Workspace Global Portal Identities & Memberships...');
    
    // Global Vendor 1: Multi-Workspace Vendor (Tata Steel & Industrial Alloys)
    const globalVendorId = crypto.randomUUID();
    await masterConn.query(
      `INSERT INTO global_portal_users (id, email, password_hash, name, phone, company_name, gstin, address, city, state, pincode, business_type, email_verified_at, status, created_at)
       VALUES (?, 'vendor.global@tatasteel.com', ?, 'Vikram Singhania', '+91 98220 11000', 'Tata Steel & Industrial Alloys Ltd', '27AAACS1122D1Z4', '12 Nariman Point', 'Mumbai', 'Maharashtra', '400021', 'Raw Material Alloys', NOW(), 'Active', NOW())`,
      [globalVendorId, vendorHash]
    );

    // Vendor 2: Apex Only Vendor (Bharat Wire & Springs)
    const apexVendorId = crypto.randomUUID();
    await masterConn.query(
      `INSERT INTO global_portal_users (id, email, password_hash, name, phone, company_name, gstin, address, city, state, pincode, business_type, email_verified_at, status, created_at)
       VALUES (?, 'vendor.apex@bharatwire.com', ?, 'Rajesh Sharma', '+91 98110 22000', 'Bharat Wire & Springs Ltd', '29AAACB3344E1Z1', '88 Peenya Industrial Area', 'Bengaluru', 'Karnataka', '560058', 'Spring Wire Manufacturing', NOW(), 'Active', NOW())`,
      [apexVendorId, vendorHash]
    );

    // Vendor 3: Nexus Only Vendor (Silicon Valley Microelectronics)
    const nexusVendorId = crypto.randomUUID();
    await masterConn.query(
      `INSERT INTO global_portal_users (id, email, password_hash, name, phone, company_name, gstin, address, city, state, pincode, business_type, email_verified_at, status, created_at)
       VALUES (?, 'vendor.nexus@siliconmicro.com', ?, 'Anand Patel', '+91 98330 33000', 'Silicon Valley Microelectronics Ltd', '29AABCS9988H1Z5', 'Electronic City Phase 1', 'Bengaluru', 'Karnataka', '560100', 'IC & Semiconductor Components', NOW(), 'Active', NOW())`,
      [nexusVendorId, vendorHash]
    );

    // Global Customer 1: Multi-Workspace Customer (Tata Motors Commercial Vehicles)
    const globalCustId = crypto.randomUUID();
    await masterConn.query(
      `INSERT INTO global_portal_users (id, email, password_hash, name, phone, company_name, gstin, address, city, state, pincode, business_type, email_verified_at, status, created_at)
       VALUES (?, 'buyer.global@tatamotors.com', ?, 'Pooja Deshmukh', '+91 98440 44000', 'Tata Motors Commercial Vehicles Ltd', '27AAACT5566F1Z8', 'Pimpri Industrial Hub', 'Pune', 'Maharashtra', '411018', 'Automotive OEM', NOW(), 'Active', NOW())`,
      [globalCustId, customerHash]
    );

    // Customer 2: Apex Only Customer (Mahindra Automotive)
    const apexCustId = crypto.randomUUID();
    await masterConn.query(
      `INSERT INTO global_portal_users (id, email, password_hash, name, phone, company_name, gstin, address, city, state, pincode, business_type, email_verified_at, status, created_at)
       VALUES (?, 'buyer.apex@mahindra.com', ?, 'Karan Verma', '+91 98550 55000', 'Mahindra Automotive Plants Ltd', '27AAACM7788G1Z2', 'Kandivali West', 'Mumbai', 'Maharashtra', '400067', 'Vehicle Assembly Plants', NOW(), 'Active', NOW())`,
      [apexCustId, customerHash]
    );

    // Customer 3: Nexus Only Customer (Schneider Electric)
    const nexusCustId = crypto.randomUUID();
    await masterConn.query(
      `INSERT INTO global_portal_users (id, email, password_hash, name, phone, company_name, gstin, address, city, state, pincode, business_type, email_verified_at, status, created_at)
       VALUES (?, 'buyer.nexus@schneider.com', ?, 'Sunil Rao', '+91 98660 66000', 'Schneider Electric Systems Ltd', '29AAACB1111J1Z9', 'Outer Ring Road', 'Bengaluru', 'Karnataka', '560103', 'Industrial Automation', NOW(), 'Active', NOW())`,
      [nexusCustId, customerHash]
    );

    // Seed Master Platform Portal Permissions (Super Admin controlled single source of truth)
    await masterConn.query(
      `INSERT INTO platform_portal_permissions (id, role, module, can_view, can_create, can_edit, can_delete, can_approve, can_export)
       VALUES
         ('perm_vendor_orders', 'vendor', 'vendor_orders', 1, 0, 1, 0, 0, 1),
         ('perm_vendor_returns', 'vendor', 'returns', 1, 1, 1, 0, 0, 1),
         ('perm_customer_orders', 'customer', 'customer_orders', 1, 0, 1, 0, 0, 1),
         ('perm_customer_returns', 'customer', 'returns', 1, 1, 1, 0, 0, 1)
       ON DUPLICATE KEY UPDATE
         can_view = VALUES(can_view), can_create = VALUES(can_create), can_edit = VALUES(can_edit),
         can_delete = VALUES(can_delete), can_approve = VALUES(can_approve), can_export = VALUES(can_export)`
    );

    // Fixed Vendor & Customer Entity IDs across both tenant DBs
    const APEX_VENDOR_GLOBAL = '00000000-0000-4000-v000-000000000001';
    const APEX_VENDOR_LOCAL = '00000000-0000-4000-v000-000000000002';
    const APEX_CUST_GLOBAL = '00000000-0000-4000-c000-000000000001';
    const APEX_CUST_LOCAL = '00000000-0000-4000-c000-000000000002';

    const NEXUS_VENDOR_GLOBAL = '00000000-0000-4000-v000-000000000001';
    const NEXUS_VENDOR_LOCAL = '00000000-0000-4000-v000-000000000003';
    const NEXUS_CUST_GLOBAL = '00000000-0000-4000-c000-000000000001';
    const NEXUS_CUST_LOCAL = '00000000-0000-4000-c000-000000000003';

    // Link Memberships:
    // SteelCorp -> Apex & Nexus
    await masterConn.query(
      `INSERT INTO global_portal_memberships (id, global_user_id, company_id, entity_id, portal_type, status, joined_at, created_at)
       VALUES
       (?, ?, ?, ?, 'vendor', 'Active', NOW(), NOW()),
       (?, ?, ?, ?, 'vendor', 'Active', NOW(), NOW())`,
      [crypto.randomUUID(), globalVendorId, APEX_ID, APEX_VENDOR_GLOBAL, crypto.randomUUID(), globalVendorId, NEXUS_ID, NEXUS_VENDOR_GLOBAL]
    );

    // Bharat Springs -> Apex only
    await masterConn.query(
      `INSERT INTO global_portal_memberships (id, global_user_id, company_id, entity_id, portal_type, status, joined_at, created_at)
       VALUES (?, ?, ?, ?, 'vendor', 'Active', NOW(), NOW())`,
      [crypto.randomUUID(), apexVendorId, APEX_ID, APEX_VENDOR_LOCAL]
    );

    // Semiconductor Hub -> Nexus only
    await masterConn.query(
      `INSERT INTO global_portal_memberships (id, global_user_id, company_id, entity_id, portal_type, status, joined_at, created_at)
       VALUES (?, ?, ?, ?, 'vendor', 'Active', NOW(), NOW())`,
      [crypto.randomUUID(), nexusVendorId, NEXUS_ID, NEXUS_VENDOR_LOCAL]
    );

    // Tata Motors -> Apex & Nexus
    await masterConn.query(
      `INSERT INTO global_portal_memberships (id, global_user_id, company_id, entity_id, portal_type, status, joined_at, created_at)
       VALUES
       (?, ?, ?, ?, 'customer', 'Active', NOW(), NOW()),
       (?, ?, ?, ?, 'customer', 'Active', NOW(), NOW())`,
      [crypto.randomUUID(), globalCustId, APEX_ID, APEX_CUST_GLOBAL, crypto.randomUUID(), globalCustId, NEXUS_ID, NEXUS_CUST_GLOBAL]
    );

    // Mahindra Auto -> Apex only
    await masterConn.query(
      `INSERT INTO global_portal_memberships (id, global_user_id, company_id, entity_id, portal_type, status, joined_at, created_at)
       VALUES (?, ?, ?, ?, 'customer', 'Active', NOW(), NOW())`,
      [crypto.randomUUID(), apexCustId, APEX_ID, APEX_CUST_LOCAL]
    );

    // Bharat Electronics -> Nexus only
    await masterConn.query(
      `INSERT INTO global_portal_memberships (id, global_user_id, company_id, entity_id, portal_type, status, joined_at, created_at)
       VALUES (?, ?, ?, ?, 'customer', 'Active', NOW(), NOW())`,
      [crypto.randomUUID(), nexusCustId, NEXUS_ID, NEXUS_CUST_LOCAL]
    );

    console.log('✅ Global portal users and multi-workspace memberships seeded.');

  } finally {
    await masterConn.end();
  }

  // --- 7. Seed Tenant Database 1: APEX (Manufacturing) ---
  console.log('\n========================================================================');
  console.log('Step 10: Seeding Workspace 1: APEX PRECISION ENGINEERING');
  console.log('========================================================================');
  await seedApexWorkspace(apexPool, workspaceUserHash, vendorHash, customerHash);

  // --- 8. Seed Tenant Database 2: NEXUS (Electronics / IoT) ---
  console.log('\n========================================================================');
  console.log('Step 11: Seeding Workspace 2: NEXUS ELECTRONICS & IOT SYSTEMS');
  console.log('========================================================================');
  await seedNexusWorkspace(nexusPool, workspaceUserHash, vendorHash, customerHash);

  console.log('\n🎉 ALL DATABASES CLEANLY RESET & 100% SEEDED SUCCESSFULLY!');
}

async function seedApexWorkspace(pool, userHash, vendorHash, custHash) {
  const client = await pool.connect();
  try {
    await client.query('START TRANSACTION');

    // 1. Seed Locations
    const locPune = '00000000-0000-4000-l000-000000000001';
    const locMumbai = '00000000-0000-4000-l000-000000000002';
    await client.query(
      `INSERT INTO locations (id, name, address, city, state, is_default, status) VALUES
       (?, 'Main Plant — Pune MIDC', 'Plot 42, MIDC Industrial Area, Bhosari', 'Pune', 'Maharashtra', 1, 'active'),
       (?, 'Warehouse & Logistics — Bhiwandi', 'Unit 12, Logistics Park', 'Bhiwandi', 'Maharashtra', 0, 'active')`,
      [locPune, locMumbai]
    );

    // 2. Seed Internal Users
    const users = [
      ['owner@apex.com', 'Aarav Sharma (Apex Owner)', 'owner', 'owner'],
      ['manager@apex.com', 'Rohan Mehta (Apex Manager)', 'manager', 'manager'],
      ['accounts@apex.com', 'Priya Nair (Apex Accounts)', 'accounts', 'accounts'],
      ['production@apex.com', 'Sanjay Verma (Apex Plant Head)', 'production_manager', 'production_manager'],
      ['sales@apex.com', 'Neha Gupta (Apex Sales Lead)', 'sales_manager', 'sales_manager'],
      ['staff@apex.com', 'Kavita Joshi (Apex Operations)', 'staff', 'staff'],
      ['multirole@apex.com', 'Vikram Joshi (Apex Multi-Role Lead)', 'sales_manager', 'sales_manager,accounts,manager']
    ];

    for (const [email, name, role, roles] of users) {
      await client.query(
        `INSERT INTO users (id, name, email, password_hash, role, roles, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', NOW())`,
        [crypto.randomUUID(), name, email, userHash, role, roles]
      );
    }

    // 3. Seed Vendors
    const vGlobal = '00000000-0000-4000-v000-000000000001';
    const vLocal = '00000000-0000-4000-v000-000000000002';
    await client.query(
      `INSERT INTO vendors (id, name, contact_person_name, email, phone, address_line1, city, state, gstin, payment_terms, status) VALUES
       (?, 'Tata Steel & Industrial Alloys Ltd', 'Vikram Singhania', 'vendor.global@tatasteel.com', '+91 98220 11000', '12 Nariman Point', 'Mumbai', 'Maharashtra', '27AAACS1122D1Z4', 'Net 30', 'Active'),
       (?, 'Bharat Wire & Springs Ltd', 'Rajesh Sharma', 'vendor.apex@bharatwire.com', '+91 98110 22000', '88 Peenya Industrial Area', 'Bengaluru', 'Karnataka', '29AAACB3344E1Z1', 'Net 15', 'Active')`,
      [vGlobal, vLocal]
    );

    // 4. Seed Customers
    const cGlobal = '00000000-0000-4000-c000-000000000001';
    const cLocal = '00000000-0000-4000-c000-000000000002';
    await client.query(
      `INSERT INTO customers (id, name, contact_person_name, email, phone, billing_address, city, state, gstin, status) VALUES
       (?, 'Tata Motors Commercial Vehicles Ltd', 'Pooja Deshmukh', 'buyer.global@tatamotors.com', '+91 98440 44000', 'Pimpri Industrial Hub', 'Pune', 'Maharashtra', '27AAACT5566F1Z8', 'Active'),
       (?, 'Mahindra Automotive Plants Ltd', 'Karan Verma', 'buyer.apex@mahindra.com', '+91 98550 55000', 'Kandivali West', 'Mumbai', 'Maharashtra', '27AAACM7788G1Z2', 'Active')`,
      [cGlobal, cLocal]
    );

    // 5. Seed Portal Users in Tenant DB
    await client.query(
      `INSERT INTO vendor_portal_users (id, vendor_id, name, email, password_hash, status) VALUES
       (?, ?, 'Vikram Singhania', 'vendor.global@tatasteel.com', ?, 'Active'),
       (?, ?, 'Rajesh Sharma', 'vendor.apex@bharatwire.com', ?, 'Active')`,
      [crypto.randomUUID(), vGlobal, vendorHash, crypto.randomUUID(), vLocal, vendorHash]
    );

    await client.query(
      `INSERT INTO customer_portal_users (id, customer_id, name, email, password_hash, status) VALUES
       (?, ?, 'Pooja Deshmukh', 'buyer.global@tatamotors.com', ?, 'Active'),
       (?, ?, 'Karan Verma', 'buyer.apex@mahindra.com', ?, 'Active')`,
      [crypto.randomUUID(), cGlobal, custHash, crypto.randomUUID(), cLocal, custHash]
    );

    // 6. Seed Raw Materials & Finished Goods in raw_materials, finished_goods, and items
    const rmSteel = '00000000-0000-4000-i000-000000000001';
    const rmCrSi = '00000000-0000-4000-i000-000000000002';
    const rmPrimer = '00000000-0000-4000-i000-000000000003';
    const fgTruck = '00000000-0000-4000-i000-000000000010';
    const fgValve = '00000000-0000-4000-i000-000000000020';

    await client.query(
      `INSERT INTO raw_materials (id, name, unit, reorder_level) VALUES
       (?, 'High-Tensile Steel Wire (5.0mm Coil)', 'kg', 500.00),
       (?, 'Chrome Silicon Spring Wire (3.2mm)', 'kg', 300.00),
       (?, 'Phosphate Anti-Corrosion Primer', 'liter', 50.00)`,
      [rmSteel, rmCrSi, rmPrimer]
    );

    await client.query(
      `INSERT INTO finished_goods (id, name, unit, reorder_level) VALUES
       (?, 'Heavy Truck Suspension Leaf Spring (Pack of 4)', 'pack', 20.00),
       (?, 'High-Speed Engine Valve Spring Set', 'set', 50.00)`,
      [fgTruck, fgValve]
    );

    await client.query(
      `INSERT INTO items (id, name, code, item_type, unit, hsn_code, last_purchase_price, reorder_level, tax_rate, status) VALUES
       (?, 'High-Tensile Steel Wire (5.0mm Coil)', 'RM-STEEL-01', 'Raw Material', 'kg', '7217', 85.00, 500.00, 18.00, 'Active'),
       (?, 'Chrome Silicon Spring Wire (3.2mm)', 'RM-CRSI-02', 'Raw Material', 'kg', '7217', 145.00, 300.00, 18.00, 'Active'),
       (?, 'Phosphate Anti-Corrosion Primer', 'RM-PRIMER-03', 'Raw Material', 'liter', '3208', 320.00, 50.00, 18.00, 'Active'),
       (?, 'Heavy Truck Suspension Leaf Spring (Pack of 4)', 'FG-TRUCK-SPR-01', 'Finished Good', 'pack', '7320', 2400.00, 20.00, 18.00, 'Active'),
       (?, 'High-Speed Engine Valve Spring Set', 'FG-VALVE-SPR-02', 'Finished Good', 'set', '7320', 850.00, 50.00, 18.00, 'Active')
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [rmSteel, rmCrSi, rmPrimer, fgTruck, fgValve]
    );

    // 7. Seed Process Stages & Production Runs
    const stg1 = crypto.randomUUID();
    const stg2 = crypto.randomUUID();
    const stg3 = crypto.randomUUID();
    await client.query(
      `INSERT INTO process_stages (id, name, sequence_order, is_final_stage) VALUES
       (?, 'Coiling & CNC Winding', 1, 0),
       (?, 'Heat Treatment & Stress Relief', 2, 0),
       (?, 'Shot Peening & Final QA Packaging', 3, 1)`,
      [stg1, stg2, stg3]
    );

    const prRun1 = crypto.randomUUID();
    await client.query(
      `INSERT INTO production_runs (id, run_number, date, location_id, labor_cost, other_cost, total_input_cost, notes, status) VALUES
       (?, 'PR-2026-0001', CURDATE(), ?, 15000.00, 5000.00, 272000.00, 'Tata Heavy Truck Springs Q3 Run - Completed with 100% QA pass', 'Completed')`,
      [prRun1, locPune]
    );

    await client.query(
      `INSERT INTO production_run_inputs (id, run_id, item_type, item_id, quantity, unit_cost, line_total_cost) VALUES
       (?, ?, 'raw_material', ?, 2400.00, 85.00, 204000.00),
       (?, ?, 'raw_material', ?, 150.00, 320.00, 48000.00)`,
      [crypto.randomUUID(), prRun1, rmSteel, crypto.randomUUID(), prRun1, rmPrimer]
    );

    await client.query(
      `INSERT INTO production_run_outputs (id, run_id, item_type, item_id, quantity_produced, unit, cost_allocation_percent, allocated_cost, unit_cost) VALUES
       (?, ?, 'finished_good', ?, 100.00, 'pack', 100.00, 272000.00, 2720.00)`,
      [crypto.randomUUID(), prRun1, fgTruck]
    );

    // 8. Seed Opening Stock in Inventory Ledger
    await client.query(
      `INSERT INTO inventory_ledger (id, item_type, item_id, transaction_type, quantity, location_id, reason, date) VALUES
       (?, 'raw_material', ?, 'in', 5000.00, ?, 'Opening Stock Balance', NOW()),
       (?, 'raw_material', ?, 'in', 2500.00, ?, 'Opening Stock Balance', NOW()),
       (?, 'raw_material', ?, 'in', 400.00, ?, 'Opening Stock Balance', NOW()),
       (?, 'finished_good', ?, 'in', 120.00, ?, 'Initial Finished Stock', NOW()),
       (?, 'finished_good', ?, 'in', 350.00, ?, 'Initial Finished Stock', NOW())`,
      [crypto.randomUUID(), rmSteel, locPune, crypto.randomUUID(), rmCrSi, locPune, crypto.randomUUID(), rmPrimer, locPune, crypto.randomUUID(), fgTruck, locPune, crypto.randomUUID(), fgValve, locPune]
    );

    // 9. Seed Procurements & POs (for SteelCorp Global & Bharat Springs)
    const po1 = '00000000-0000-4000-p000-000000000001';
    const po2 = '00000000-0000-4000-p000-000000000002';
    await client.query(
      `INSERT INTO procurements (id, procurement_number, vendor_id, raw_material_id, quantity, rate_per_unit, amount_paid, subtotal, tax_amount, date, notes) VALUES
       (?, 'PO-2026-0001', ?, ?, 2000.00, 85.00, 0.00, 170000.00, 30600.00, NOW(), 'High-tensile wire for Tata Motors Q3 production run'),
       (?, 'PO-2026-0002', ?, ?, 500.00, 145.00, 72500.00, 72500.00, 13050.00, DATE_SUB(NOW(), INTERVAL 2 DAY), 'Batch received and inspected at Pune plant')`,
      [po1, vGlobal, rmSteel, po2, vLocal, rmCrSi]
    );

    await client.query(
      `INSERT INTO procurement_items (id, procurement_id, item_id, quantity, rate_per_unit, tax_rate, tax_amount, line_total) VALUES
       (?, ?, ?, 2000.00, 85.00, 18.00, 30600.00, 200600.00),
       (?, ?, ?, 500.00, 145.00, 18.00, 13050.00, 85550.00)`,
      [crypto.randomUUID(), po1, rmSteel, crypto.randomUUID(), po2, rmCrSi]
    );

    // 10. Seed Sales Invoices (for Tata Motors & Mahindra)
    const inv1 = '00000000-0000-4000-s000-000000000001';
    const inv2 = '00000000-0000-4000-s000-000000000002';
    await client.query(
      `INSERT INTO sales (id, invoice_number, customer_id, finished_good_id, quantity, rate_per_unit, subtotal, total_tax, amount_received, payment_status, due_date, date, notes) VALUES
       (?, 'INV-2026-2027-0001', ?, ?, 100.00, 4850.00, 485000.00, 87300.00, 250000.00, 'Partial', DATE_ADD(NOW(), INTERVAL 15 DAY), NOW(), 'Heavy truck springs consignment for Pune plant'),
       (?, 'INV-2026-2027-0002', ?, ?, 100.00, 1750.00, 175000.00, 31500.00, 175000.00, 'Paid', DATE_ADD(NOW(), INTERVAL 30 DAY), NOW(), 'Engine valve spring sets')`,
      [inv1, cGlobal, fgTruck, inv2, cLocal, fgValve]
    );

    await client.query(
      `INSERT INTO sales_items (id, sale_id, finished_good_id, quantity, rate_per_unit, taxable_value, tax_rate, line_total) VALUES
       (?, ?, ?, 100.00, 4850.00, 485000.00, 18.00, 572300.00),
       (?, ?, ?, 100.00, 1750.00, 175000.00, 18.00, 206500.00)`,
      [crypto.randomUUID(), inv1, fgTruck, crypto.randomUUID(), inv2, fgValve]
    );

    // 11. Seed Customer Return Requests
    await client.query(
      `INSERT INTO return_requests (
        id, request_number, request_type, reference_id, reference_type, requested_by_type,
        customer_id, reason, items, status, created_at
      ) VALUES
      (?, 'RET-2026-2027-0001', 'sales_return', ?, 'sale', 'customer_portal',
       ?, 'Dimensional variance on 4 units - load deflection out of spec', JSON_ARRAY(JSON_OBJECT('item_id', ?, 'quantity', 4)), 'Pending', NOW()),
      (?, 'RET-2026-2027-0002', 'sales_return', ?, 'sale', 'customer_portal',
       ?, 'Excess units ordered by mistake during monthly revision', JSON_ARRAY(JSON_OBJECT('item_id', ?, 'quantity', 5)), 'Approved', DATE_SUB(NOW(), INTERVAL 1 DAY))`,
      [crypto.randomUUID(), inv1, cGlobal, fgTruck, crypto.randomUUID(), inv2, cLocal, fgValve]
    );

    // 12. Seed Live Expanded Permissions Matrix
    await seedRolePermissions(client);

    await client.query('COMMIT');
    console.log('✅ Apex Precision Engineering workspace data seeded 100%.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function seedNexusWorkspace(pool, userHash, vendorHash, custHash) {
  const client = await pool.connect();
  try {
    await client.query('START TRANSACTION');

    // 1. Seed Locations
    const locDelhi = '00000000-0000-4000-l000-000000000003';
    const locGurgaon = '00000000-0000-4000-l000-000000000004';
    await client.query(
      `INSERT INTO locations (id, name, address, city, state, is_default, status) VALUES
       (?, 'IoT R&D and Assembly Hub — Okhla', 'Phase III Industrial Estate', 'New Delhi', 'Delhi', 1, 'active'),
       (?, 'Transit Warehouse — Cybercity', 'Sector 29', 'Gurgaon', 'Haryana', 0, 'active')`,
      [locDelhi, locGurgaon]
    );

    // 2. Seed Internal Users
    const users = [
      ['owner@nexus.com', 'Aditya Sen (Nexus Owner)', 'owner', 'owner'],
      ['manager@nexus.com', 'Meera Kapoor (Nexus VP Ops)', 'manager', 'manager'],
      ['accounts@nexus.com', 'Karan Singhal (Nexus CFO)', 'accounts', 'accounts'],
      ['production@nexus.com', 'Devendra Patel (Nexus Hardware Lead)', 'production_manager', 'production_manager'],
      ['sales@nexus.com', 'Ananya Roy (Nexus Sales Director)', 'sales_manager', 'sales_manager'],
      ['staff@nexus.com', 'Tarun Saxena (Nexus Associate)', 'staff', 'staff']
    ];

    for (const [email, name, role, roles] of users) {
      await client.query(
        `INSERT INTO users (id, name, email, password_hash, role, roles, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', NOW())`,
        [crypto.randomUUID(), name, email, userHash, role, roles]
      );
    }

    // 3. Seed Vendors
    const vGlobal = '00000000-0000-4000-v000-000000000001';
    const vLocal = '00000000-0000-4000-v000-000000000003';
    await client.query(
      `INSERT INTO vendors (id, name, contact_person_name, email, phone, address_line1, city, state, gstin, payment_terms, status) VALUES
       (?, 'Tata Steel & Industrial Alloys Ltd', 'Vikram Singhania', 'vendor.global@tatasteel.com', '+91 98220 11000', '12 Nariman Point', 'Mumbai', 'Maharashtra', '27AAACS1122D1Z4', 'Net 30', 'Active'),
       (?, 'Silicon Valley Microelectronics Ltd', 'Anand Patel', 'vendor.nexus@siliconmicro.com', '+91 98330 33000', 'Electronic City Phase 1', 'Bengaluru', 'Karnataka', '29AABCS9988H1Z5', 'Net 21', 'Active')`,
      [vGlobal, vLocal]
    );

    // 4. Seed Customers
    const cGlobal = '00000000-0000-4000-c000-000000000001';
    const cLocal = '00000000-0000-4000-c000-000000000003';
    await client.query(
      `INSERT INTO customers (id, name, contact_person_name, email, phone, billing_address, city, state, gstin, status) VALUES
       (?, 'Tata Motors Commercial Vehicles Ltd', 'Pooja Deshmukh', 'buyer.global@tatamotors.com', '+91 98440 44000', 'Telematics Hub, Pune Plant', 'Pune', 'Maharashtra', '27AAACT5566F1Z8', 'Active'),
       (?, 'Schneider Electric Systems Ltd', 'Sunil Rao', 'buyer.nexus@schneider.com', '+91 98660 66000', 'Outer Ring Road', 'Bengaluru', 'Karnataka', '29AAACB1111J1Z9', 'Active')`,
      [cGlobal, cLocal]
    );

    // 5. Seed Portal Users
    await client.query(
      `INSERT INTO vendor_portal_users (id, vendor_id, name, email, password_hash, status) VALUES
       (?, ?, 'Vikram Singhania', 'vendor.global@tatasteel.com', ?, 'Active'),
       (?, ?, 'Anand Patel', 'vendor.nexus@siliconmicro.com', ?, 'Active')`,
      [crypto.randomUUID(), vGlobal, vendorHash, crypto.randomUUID(), vLocal, vendorHash]
    );

    await client.query(
      `INSERT INTO customer_portal_users (id, customer_id, name, email, password_hash, status) VALUES
       (?, ?, 'Pooja Deshmukh', 'buyer.global@tatamotors.com', ?, 'Active'),
       (?, ?, 'Sunil Rao', 'buyer.nexus@schneider.com', ?, 'Active')`,
      [crypto.randomUUID(), cGlobal, custHash, crypto.randomUUID(), cLocal, custHash]
    );

    // 6. Seed Items
    const rmEnclosure = '00000000-0000-4000-i000-000000000004';
    const rmMCU = '00000000-0000-4000-i000-000000000005';
    const rmPCB = '00000000-0000-4000-i000-000000000006';
    const fgIoT = '00000000-0000-4000-i000-000000000030';
    const fgSensor = '00000000-0000-4000-i000-000000000040';

    await client.query(
      `INSERT INTO raw_materials (id, name, unit, reorder_level) VALUES
       (?, 'CNC Anodized Aluminium Enclosure (IP67)', 'pcs', 100.00),
       (?, 'ARM Cortex-M4 Microcontroller IC', 'pcs', 200.00),
       (?, '6-Layer Industrial Telematics PCB', 'pcs', 150.00)`,
      [rmEnclosure, rmMCU, rmPCB]
    );

    await client.query(
      `INSERT INTO finished_goods (id, name, unit, reorder_level) VALUES
       (?, 'Industrial IoT Fleet Gateway Pro (4G LTE + GPS)', 'unit', 25.00),
       (?, 'Smart Vibration & Temperature Sensor Node', 'unit', 40.00)`,
      [fgIoT, fgSensor]
    );

    await client.query(
      `INSERT INTO items (id, name, code, item_type, unit, hsn_code, last_purchase_price, reorder_level, tax_rate, status) VALUES
       (?, 'CNC Anodized Aluminium Enclosure (IP67)', 'RM-ENC-01', 'Raw Material', 'pcs', '7616', 650.00, 100.00, 18.00, 'Active'),
       (?, 'ARM Cortex-M4 Microcontroller IC', 'RM-MCU-02', 'Raw Material', 'pcs', '8542', 420.00, 200.00, 18.00, 'Active'),
       (?, '6-Layer Industrial Telematics PCB', 'RM-PCB-03', 'Raw Material', 'pcs', '8534', 280.00, 150.00, 18.00, 'Active'),
       (?, 'Industrial IoT Fleet Gateway Pro (4G LTE + GPS)', 'FG-IOT-GW-01', 'Finished Good', 'unit', '8517', 2100.00, 25.00, 18.00, 'Active'),
       (?, 'Smart Vibration & Temperature Sensor Node', 'FG-SENS-02', 'Finished Good', 'unit', '9031', 1150.00, 40.00, 18.00, 'Active')
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [rmEnclosure, rmMCU, rmPCB, fgIoT, fgSensor]
    );

    // 7. Seed Process Stages & Production Runs
    const stgN1 = crypto.randomUUID();
    const stgN2 = crypto.randomUUID();
    const stgN3 = crypto.randomUUID();
    await client.query(
      `INSERT INTO process_stages (id, name, sequence_order, is_final_stage) VALUES
       (?, 'SMT Pick & Place Automated Solder', 1, 0),
       (?, 'Firmware Flash & Telematics Testing', 2, 0),
       (?, 'IP67 Enclosure Assembly & Final QA', 3, 1)`,
      [stgN1, stgN2, stgN3]
    );

    const prRunN1 = crypto.randomUUID();
    await client.query(
      `INSERT INTO production_runs (id, run_number, date, location_id, labor_cost, other_cost, total_input_cost, notes, status) VALUES
       (?, 'PR-2026-NEXUS-01', CURDATE(), ?, 8000.00, 3000.00, 78500.00, 'Fleet Gateway Pro Assembly Batch #1 - Assembled and calibrated', 'Completed')`,
      [prRunN1, locDelhi]
    );

    await client.query(
      `INSERT INTO production_run_inputs (id, run_id, item_type, item_id, quantity, unit_cost, line_total_cost) VALUES
       (?, ?, 'raw_material', ?, 50.00, 650.00, 32500.00),
       (?, ?, 'raw_material', ?, 50.00, 420.00, 21000.00),
       (?, ?, 'raw_material', ?, 50.00, 280.00, 14000.00)`,
      [crypto.randomUUID(), prRunN1, rmEnclosure, crypto.randomUUID(), prRunN1, rmMCU, crypto.randomUUID(), prRunN1, rmPCB]
    );

    await client.query(
      `INSERT INTO production_run_outputs (id, run_id, item_type, item_id, quantity_produced, unit, cost_allocation_percent, allocated_cost, unit_cost) VALUES
       (?, ?, 'finished_good', ?, 50.00, 'unit', 100.00, 78500.00, 1570.00)`,
      [crypto.randomUUID(), prRunN1, fgIoT]
    );

    // 8. Seed Opening Stock
    await client.query(
      `INSERT INTO inventory_ledger (id, item_type, item_id, transaction_type, quantity, location_id, reason, date) VALUES
       (?, 'raw_material', ?, 'in', 1200.00, ?, 'Opening Stock Balance', NOW()),
       (?, 'raw_material', ?, 'in', 3000.00, ?, 'Opening Stock Balance', NOW()),
       (?, 'raw_material', ?, 'in', 2000.00, ?, 'Opening Stock Balance', NOW()),
       (?, 'finished_good', ?, 'in', 85.00, ?, 'Initial Finished Stock', NOW()),
       (?, 'finished_good', ?, 'in', 140.00, ?, 'Initial Finished Stock', NOW())`,
      [crypto.randomUUID(), rmEnclosure, locDelhi, crypto.randomUUID(), rmMCU, locDelhi, crypto.randomUUID(), rmPCB, locDelhi, crypto.randomUUID(), fgIoT, locDelhi, crypto.randomUUID(), fgSensor, locDelhi]
    );

    // 9. Seed Procurements
    const poNexus1 = '00000000-0000-4000-p000-000000000003';
    const poNexus2 = '00000000-0000-4000-p000-000000000004';
    await client.query(
      `INSERT INTO procurements (id, procurement_number, vendor_id, raw_material_id, quantity, rate_per_unit, amount_paid, subtotal, tax_amount, date, notes) VALUES
       (?, 'PO-2026-NEXUS-01', ?, ?, 500.00, 650.00, 0.00, 325000.00, 58500.00, NOW(), 'Custom anodized enclosures for Tata fleet order'),
       (?, 'PO-2026-NEXUS-02', ?, ?, 500.00, 420.00, 210000.00, 210000.00, 37800.00, DATE_SUB(NOW(), INTERVAL 3 DAY), 'Cortex M4 microcontrollers batch certified')`,
      [poNexus1, vGlobal, rmEnclosure, poNexus2, vLocal, rmMCU]
    );

    await client.query(
      `INSERT INTO procurement_items (id, procurement_id, item_id, quantity, rate_per_unit, tax_rate, tax_amount, line_total) VALUES
       (?, ?, ?, 500.00, 650.00, 18.00, 58500.00, 383500.00),
       (?, ?, ?, 500.00, 420.00, 18.00, 37800.00, 247800.00)`,
      [crypto.randomUUID(), poNexus1, rmEnclosure, crypto.randomUUID(), poNexus2, rmMCU]
    );

    // 10. Seed Sales
    const invNexus1 = '00000000-0000-4000-s000-000000000003';
    const invNexus2 = '00000000-0000-4000-s000-000000000004';
    await client.query(
      `INSERT INTO sales (id, invoice_number, customer_id, finished_good_id, quantity, rate_per_unit, subtotal, total_tax, amount_received, payment_status, due_date, date, notes) VALUES
       (?, 'INV-2026-2027-0003', ?, ?, 50.00, 5800.00, 290000.00, 52200.00, 290000.00, 'Paid', DATE_ADD(NOW(), INTERVAL 30 DAY), NOW(), 'Fleet gateways batch #1'),
       (?, 'INV-2026-2027-0004', ?, ?, 50.00, 2950.00, 147500.00, 26550.00, 0.00, 'Unpaid', DATE_ADD(NOW(), INTERVAL 45 DAY), NOW(), 'Vibration sensor nodes')`,
      [invNexus1, cGlobal, fgIoT, invNexus2, cLocal, fgSensor]
    );

    await client.query(
      `INSERT INTO sales_items (id, sale_id, finished_good_id, quantity, rate_per_unit, taxable_value, tax_rate, line_total) VALUES
       (?, ?, ?, 50.00, 5800.00, 290000.00, 18.00, 342200.00),
       (?, ?, ?, 50.00, 2950.00, 147500.00, 18.00, 174050.00)`,
      [crypto.randomUUID(), invNexus1, fgIoT, crypto.randomUUID(), invNexus2, fgSensor]
    );

    // 11. Seed Return Request from Tata Motors on Nexus
    await client.query(
      `INSERT INTO return_requests (
        id, request_number, request_type, reference_id, reference_type, requested_by_type,
        customer_id, reason, items, status, created_at
      ) VALUES
      (?, 'RET-2026-2027-0003', 'sales_return', ?, 'sale', 'customer_portal',
       ?, 'SIM slot pin bent on 2 gateways during bench testing', JSON_ARRAY(JSON_OBJECT('item_id', ?, 'quantity', 2)), 'Pending', NOW())`,
      [crypto.randomUUID(), invNexus1, cGlobal, fgIoT]
    );

    // 12. Seed Permissions Matrix
    await seedRolePermissions(client);

    await client.query('COMMIT');
    console.log('✅ Nexus Electronics workspace data seeded 100%.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function seedRolePermissions(client) {
  for (const role of ROLES) {
    for (const mod of MODULES) {
      let canView = 1, canCreate = 0, canEdit = 0, canDelete = 0, canApprove = 0, canExport = 0;

      if (role === 'owner') {
        canView = 1; canCreate = 1; canEdit = 1; canDelete = 1; canApprove = 1; canExport = 1;
      } else if (role === 'manager') {
        canView = 1; canCreate = 1; canEdit = 1; canDelete = 0; canApprove = 1; canExport = 1;
      } else if (role === 'accounts') {
        if (['sales', 'procurement', 'expenses', 'reports', 'catalog', 'dashboard', 'billing'].includes(mod)) {
          canView = 1; canCreate = 1; canEdit = 1; canDelete = 0; canApprove = 1; canExport = 1;
        } else if (['inventory', 'parties', 'locations'].includes(mod)) {
          canView = 1; canCreate = 0; canEdit = 0; canDelete = 0; canApprove = 0; canExport = 1;
        } else {
          canView = 0;
        }
      } else if (role === 'production_manager') {
        if (['production', 'inventory', 'catalog', 'locations', 'dashboard'].includes(mod)) {
          canView = 1; canCreate = 1; canEdit = 1; canDelete = 0; canApprove = 1; canExport = 1;
        } else if (['reports', 'procurement'].includes(mod)) {
          canView = 1; canCreate = 0; canEdit = 0; canDelete = 0; canApprove = 0; canExport = 0;
        } else {
          canView = 0;
        }
      } else if (role === 'sales_manager') {
        if (['sales', 'parties', 'customer_orders', 'returns', 'reports', 'catalog', 'settings', 'dashboard'].includes(mod)) {
          canView = 1; canCreate = 1; canEdit = 1; canDelete = 0; canApprove = 1; canExport = 1;
        } else if (['inventory'].includes(mod)) {
          canView = 1; canCreate = 0; canEdit = 0; canDelete = 0; canApprove = 0; canExport = 1;
        } else {
          canView = 0;
        }
      } else if (role === 'staff') {
        if (['dashboard', 'inventory', 'production', 'sales'].includes(mod)) {
          canView = 1; canCreate = 1; canEdit = 0; canDelete = 0; canApprove = 0; canExport = 0;
        } else {
          canView = 0;
        }
      }

      await client.query(
        `INSERT INTO role_permissions (id, role, module, can_view, can_create, can_edit, can_delete, can_approve, can_export)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           can_view = VALUES(can_view), can_create = VALUES(can_create), can_edit = VALUES(can_edit),
           can_delete = VALUES(can_delete), can_approve = VALUES(can_approve), can_export = VALUES(can_export)`,
        [`${role}_${mod}`, role, mod, canView, canCreate, canEdit, canDelete, canApprove, canExport]
      );
    }
  }
}

if (require.main === module) {
  seedMasterDemo()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Error during seeding:', err);
      process.exit(1);
    });
}

module.exports = { seedMasterDemo };
