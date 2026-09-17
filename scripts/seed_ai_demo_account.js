'use strict';

/**
 * seed_ai_demo_account.js
 * Dedicated AI Analytics Demo Account Seeder:
 * - Creates a dedicated demo workspace: "Apex FutureTech Robotics"
 * - User: ai-demo@erp.com / 123456 (Owner role)
 * - 30 consecutive days of operational data across ALL modules
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { runTenantMigrations } = require('../db/migrationRunner');
const { getTenantPool } = require('../db/tenantManager');

const adminUrl = process.env.MASTER_DATABASE_ADMIN_URL || process.env.MASTER_DATABASE_URL || 'mysql://root:@localhost:3306/mysql';

const DEMO_COMPANY_ID = 'a0000000-0000-0000-0000-000000000001';
const DEMO_DB_NAME = 'erp_company_a0000000000000000000000000000001';
const DEMO_USER_ID = 'u0000000-0000-0000-0000-000000000001';
const DEMO_EMAIL = 'ai-demo@erp.com';
const DEMO_PASSWORD = '123456';

async function seedAiDemoAccount() {
  console.log('========================================================================');
  console.log('AI ANALYTICS DEMO ACCOUNT SEEDER (30 DAYS FULL TELEMETRY)');
  console.log('========================================================================\n');

  const adminConn = await mysql.createConnection(adminUrl);
  try {
    // 1. Ensure master database has demo company & user
    console.log('Step 1: Setting up demo company and user in erp_master...');
    const masterConn = await mysql.createConnection(process.env.MASTER_DATABASE_URL || 'mysql://root:@localhost:3306/erp_master');

    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

    // Upsert company in erp_master
    await masterConn.query(
      `INSERT INTO companies (
        id, company_name, company_code, database_name, status,
        business_type, currency, plan, accent_color, primary_owner_id, primary_owner_email, created_at, updated_at
       ) VALUES (
        ?, 'Apex FutureTech Robotics', 'APEX-AI01', ?, 'active',
        'Robotics, AI Control Systems & Heavy Assembly', 'INR', 'enterprise', '#10b981', ?, ?, NOW(), NOW()
       )
       ON DUPLICATE KEY UPDATE company_name = VALUES(company_name), status = 'active', plan = 'enterprise'`,
      [DEMO_COMPANY_ID, DEMO_DB_NAME, DEMO_USER_ID, DEMO_EMAIL]
    );

    // Upsert company_user in erp_master
    await masterConn.query(
      `INSERT INTO company_users (id, company_id, email, user_id, role, status, created_at)
       VALUES (?, ?, ?, ?, 'owner', 'active', NOW())
       ON DUPLICATE KEY UPDATE role = 'owner', status = 'active'`,
      [crypto.randomUUID(), DEMO_COMPANY_ID, DEMO_EMAIL, DEMO_USER_ID]
    );

    console.log(`✅ Master records ready for [${DEMO_EMAIL}].`);
    await masterConn.end();

    // 2. Ensure Tenant Database exists
    console.log(`\nStep 2: Ensuring tenant database \`${DEMO_DB_NAME}\` exists...`);
    await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${DEMO_DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);

    // 3. Run tenant migrations on demo database
    console.log('Step 3: Running tenant schema migrations on demo database...');
    const tenantPool = getTenantPool(DEMO_DB_NAME);
    await runTenantMigrations(tenantPool);
    console.log('✅ Schema migrations complete.');

    // 4. Clean previous demo operational data in demo DB
    console.log('\nStep 4: Populating 30 days of operational records...');
    const tablesToClean = [
      'sales_items', 'sales', 'procurement_items', 'procurements',
      'production_shift_logs', 'production_run_inputs', 'production_run_outputs', 'production_runs',
      'production_order_outputs', 'production_orders',
      'production_formula_inputs', 'production_formula_outputs', 'production_formulas',
      'inventory_ledger', 'stock_transfers', 'return_requests', 'expenses',
      'items', 'raw_materials', 'finished_goods', 'locations', 'vendors', 'customers', 'users', 'role_permissions'
    ];
    await tenantPool.query(`SET FOREIGN_KEY_CHECKS = 0`);
    for (const tbl of tablesToClean) {
      await tenantPool.query(`DELETE FROM \`${tbl}\``).catch(() => {});
    }
    await tenantPool.query(`SET FOREIGN_KEY_CHECKS = 1`);

    // 5. Seed Users
    await tenantPool.query(
      `INSERT INTO users (id, name, email, role, roles, status, is_primary_owner, password_hash, created_at)
       VALUES (?, 'Dr. Rajesh Sharma (Director)', ?, 'owner', '["owner","manager"]', 'active', 1, ?, NOW())`,
      [DEMO_USER_ID, DEMO_EMAIL, passwordHash]
    );

    // 6. Seed Role Permissions for all modules including ai_analytics
    const { ensureDefaultRolePermissions } = require('../lib/defaultPermissions');
    await ensureDefaultRolePermissions(tenantPool);

    // 7. Seed Locations
    const locMain = crypto.randomUUID();
    const locStore = crypto.randomUUID();
    const locFloor = crypto.randomUUID();
    await tenantPool.query(
      `INSERT INTO locations (id, name, location_code, address, is_default, status) VALUES
       (?, 'Main Plant - Assembly Line 1', 'PLANT-01', 'Sector 4, Industrial Area, Pune', 1, 'Active'),
       (?, 'Central Storage & Raw Material Depo', 'WH-01', 'Warehouse Complex, Talegaon, Pune', 0, 'Active'),
       (?, 'Dispatch & Finished Goods Hub', 'DISPATCH-01', 'Export Cargo Terminal, Pune', 0, 'Active')`,
      [locMain, locStore, locFloor]
    );

    // 8. Seed Catalog (Raw Materials & Finished Goods)
    const rawAlum = crypto.randomUUID();
    const rawMotor = crypto.randomUUID();
    const rawChip = crypto.randomUUID();
    const rawWire = crypto.randomUUID();
    const rawFastener = crypto.randomUUID();

    const fgRobo = crypto.randomUUID();
    const fgCtrl = crypto.randomUUID();

    await tenantPool.query(
      `INSERT INTO items (id, name, code, item_type, unit, reorder_level, last_purchase_price, default_price, status) VALUES
       (?, 'Aircraft-Grade Aluminum Plate 10mm', 'RM-ALUM-10', 'raw_material', 'kg', 50, 420.00, 480.00, 'active'),
       (?, 'Industrial Stepper Motor NEMA-23', 'RM-MOT-23', 'raw_material', 'pcs', 20, 1850.00, 2100.00, 'active'),
       (?, 'ESP32 Industrial Microcontroller IC', 'RM-MCU-32', 'raw_material', 'pcs', 100, 380.00, 450.00, 'active'),
       (?, 'Heavy Duty Shielded Cable Harness', 'RM-WIRE-01', 'raw_material', 'meter', 60, 95.00, 120.00, 'active'),
       (?, 'Hex Head M4 Fasteners (Pack of 100)', 'RM-FAST-04', 'raw_material', 'packs', 30, 210.00, 250.00, 'active'),
       (?, 'Apex IoT 6-Axis Robotic Arm Pro', 'FG-ROBO-01', 'finished_good', 'units', 5, 88000.00, 145000.00, 'active'),
       (?, 'Smart Industrial IoT Controller V2', 'FG-CTRL-02', 'finished_good', 'units', 10, 16500.00, 28500.00, 'active')`,
      [rawAlum, rawMotor, rawChip, rawWire, rawFastener, fgRobo, fgCtrl]
    );

    // Mirror to legacy raw_materials and finished_goods tables to satisfy foreign key constraints
    await tenantPool.query(
      `INSERT INTO raw_materials (id, name, unit, reorder_level) VALUES
       (?, 'Aircraft-Grade Aluminum Plate 10mm', 'kg', 50),
       (?, 'Industrial Stepper Motor NEMA-23', 'pcs', 20),
       (?, 'ESP32 Industrial Microcontroller IC', 'pcs', 100),
       (?, 'Heavy Duty Shielded Cable Harness', 'meter', 60),
       (?, 'Hex Head M4 Fasteners (Pack of 100)', 'packs', 30)`,
      [rawAlum, rawMotor, rawChip, rawWire, rawFastener]
    );

    await tenantPool.query(
      `INSERT INTO finished_goods (id, name, unit, default_price, reorder_level) VALUES
       (?, 'Apex IoT 6-Axis Robotic Arm Pro', 'units', 145000.00, 5),
       (?, 'Smart Industrial IoT Controller V2', 'units', 28500.00, 10)`,
      [fgRobo, fgCtrl]
    );

    // Seed Opening Inventory via inventory_ledger
    // Raw materials with realistic stock (RM-MCU-32 is intentionally set to 12 vs reorder 100 to trigger AI stockout radar)
    await tenantPool.query(
      `INSERT INTO inventory_ledger (id, item_type, item_id, transaction_type, quantity, unit_cost, reason, date, created_by) VALUES
       (UUID(), 'raw_material', ?, 'in', 350, 410.00, 'Initial opening stock', NOW(), ?),
       (UUID(), 'raw_material', ?, 'in', 18, 1800.00, 'Initial opening stock', NOW(), ?),
       (UUID(), 'raw_material', ?, 'in', 12, 375.00, 'Initial opening stock', NOW(), ?),
       (UUID(), 'raw_material', ?, 'in', 450, 92.00, 'Initial opening stock', NOW(), ?),
       (UUID(), 'raw_material', ?, 'in', 120, 205.00, 'Initial opening stock', NOW(), ?),
       (UUID(), 'finished_good', ?, 'in', 8, 88000.00, 'Initial opening stock', NOW(), ?),
       (UUID(), 'finished_good', ?, 'in', 24, 16500.00, 'Initial opening stock', NOW(), ?)`,
      [rawAlum, DEMO_USER_ID, rawMotor, DEMO_USER_ID, rawChip, DEMO_USER_ID, rawWire, DEMO_USER_ID, rawFastener, DEMO_USER_ID, fgRobo, DEMO_USER_ID, fgCtrl, DEMO_USER_ID]
    );

    // Seed Manufacturing Formulas (Header, Inputs, Outputs)
    const formulaRobo = crypto.randomUUID();
    const formulaCtrl = crypto.randomUUID();
    await tenantPool.query(
      `INSERT INTO production_formulas (id, name, code, version, status, cost_allocation_method, created_by) VALUES
       (?, 'Robotic Arm Standard Formula', 'FORM-ROBO-01', 1, 'active', 'manual_percentage', ?),
       (?, 'Smart Controller Standard Formula', 'FORM-CTRL-01', 1, 'active', 'manual_percentage', ?)`,
      [formulaRobo, DEMO_USER_ID, formulaCtrl, DEMO_USER_ID]
    );

    await tenantPool.query(
      `INSERT INTO production_formula_inputs (id, formula_id, item_type, item_id, quantity, uom, sequence) VALUES
       (UUID(), ?, 'raw_material', ?, 12.5, 'kg', 1),
       (UUID(), ?, 'raw_material', ?, 6.0, 'pcs', 2),
       (UUID(), ?, 'raw_material', ?, 2.0, 'pcs', 3),
       (UUID(), ?, 'raw_material', ?, 8.0, 'meter', 4),
       (UUID(), ?, 'raw_material', ?, 2.0, 'packs', 5),
       (UUID(), ?, 'raw_material', ?, 1.0, 'pcs', 1),
       (UUID(), ?, 'raw_material', ?, 1.0, 'meter', 2),
       (UUID(), ?, 'raw_material', ?, 2.0, 'packs', 3)`,
      [formulaRobo, rawAlum, formulaRobo, rawMotor, formulaRobo, rawChip, formulaRobo, rawWire, formulaRobo, rawFastener,
       formulaCtrl, rawChip, formulaCtrl, rawWire, formulaCtrl, rawFastener]
    );

    await tenantPool.query(
      `INSERT INTO production_formula_outputs (id, formula_id, item_type, item_id, quantity, uom, cost_allocation_percent) VALUES
       (UUID(), ?, 'finished_good', ?, 1.0, 'units', 100.0000),
       (UUID(), ?, 'finished_good', ?, 1.0, 'units', 100.0000)`,
      [formulaRobo, fgRobo, formulaCtrl, fgCtrl]
    );

    // 9. Seed Vendors & Customers
    const venSteel = crypto.randomUUID();
    const venChips = crypto.randomUUID();
    const venMotors = crypto.randomUUID();

    await tenantPool.query(
      `INSERT INTO vendors (id, name, vendor_code, contact_person_name, phone, email, city, state, gstin, status) VALUES
       (?, 'Hindalco Alloys & Metals Pvt Ltd', 'VEN-HIND-01', 'Sunil Deshmukh', '9822104523', 'sales@hindalco-metals.in', 'Pune', 'Maharashtra', '27AABCH1234F1Z5', 'Active'),
       (?, 'Microchip Tech Solutions India', 'VEN-CHIP-02', 'Anita Rao', '9845012389', 'orders@microchip-india.com', 'Bengaluru', 'Karnataka', '29AABCM5678E1Z3', 'Active'),
       (?, 'Motion Dynamics & Steppers Ltd', 'VEN-MOT-03', 'Vikram Seth', '9711098452', 'vikram@motiondynamics.in', 'Faridabad', 'Haryana', '06AABCM9012D1Z8', 'Active')`,
      [venSteel, venChips, venMotors]
    );

    const custTata = crypto.randomUUID();
    const custReliance = crypto.randomUUID();
    const custMahindra = crypto.randomUUID();

    await tenantPool.query(
      `INSERT INTO customers (id, name, customer_code, contact_person_name, phone, email, city, state, gstin, status) VALUES
       (?, 'Tata Motors Automation Division', 'CUST-TATA-01', 'Pravin Kulkarni', '9820011223', 'procure@tatamotors.com', 'Pune', 'Maharashtra', '27AABCT2468M1Z1', 'Active'),
       (?, 'Reliance Industrial Systems Ltd', 'CUST-REL-02', 'Meera Kapoor', '9821199887', 'automation@ril.com', 'Navi Mumbai', 'Maharashtra', '27AABCR1357N1Z9', 'Active'),
       (?, 'Mahindra Aerospace & Robotics', 'CUST-MAH-03', 'Gaurav Joshi', '9988776655', 'g.joshi@mahindra.com', 'Bengaluru', 'Karnataka', '29AABCM2468P1Z4', 'Active')`,
      [custTata, custReliance, custMahindra]
    );

    // Parent Production Order for shift logs
    const prodOrderId = crypto.randomUUID();
    await tenantPool.query(
      `INSERT INTO production_orders (id, order_number, target_item_id, target_item_type, target_quantity, target_uom, required_by_date, location_id, priority, status, created_by)
       VALUES (?, 'PO-2026-001', ?, 'finished_good', 100, 'units', DATE_ADD(NOW(), INTERVAL 14 DAY), ?, 'normal', 'in_progress', ?)`,
      [prodOrderId, fgRobo, locMain, DEMO_USER_ID]
    );

    // 10. Generate 30 Consecutive Days of Correlated Operations (from 30 days ago to today)
    const today = new Date();

    console.log('   - Generating 30 days of sales invoices, procurements, and shift logs...');

    for (let dayOffset = 30; dayOffset >= 0; dayOffset--) {
      const recordDate = new Date(today);
      recordDate.setDate(today.getDate() - dayOffset);
      const dateStr = recordDate.toISOString().split('T')[0];

      // Daily Shift Log (Morning Shift & Evening Shift)
      const shiftUnitsMorning = Math.floor(10 + Math.random() * 8); // 10-18 units
      const shiftUnitsEvening = Math.floor(8 + Math.random() * 6);  // 8-14 units

      await tenantPool.query(
        `INSERT INTO production_shift_logs (id, order_id, item_id, log_date, shift, quantity_produced, uom, notes, created_by) VALUES
         (UUID(), ?, ?, ?, 'morning', ?, 'units', 'Standard morning production run', ?),
         (UUID(), ?, ?, ?, 'evening', ?, 'units', 'Evening manufacturing and testing', ?)`,
        [prodOrderId, fgRobo, dateStr, shiftUnitsMorning, DEMO_USER_ID,
         prodOrderId, fgRobo, dateStr, shiftUnitsEvening, DEMO_USER_ID]
      );

      // Production Runs (Every 2-3 days)
      if (dayOffset % 2 === 0) {
        const runId = crypto.randomUUID();
        const runNum = `RUN-2026-${String(30 - dayOffset).padStart(3, '0')}`;
        const outputQty = Math.floor(2 + Math.random() * 3);
        const allocatedCost = outputQty * 85000;
        const totalMatCost = (outputQty * 12.5 * 420.00) + (outputQty * 6 * 1850.00);

        await tenantPool.query(
          `INSERT INTO production_runs (id, run_number, date, location_id, labor_cost, other_cost, total_input_cost, notes, status, created_by)
           VALUES (?, ?, ?, ?, 15000.00, 5000.00, ?, 'Automated assembly batch', 'Completed', ?)`,
          [runId, runNum, dateStr, locMain, totalMatCost + 20000, DEMO_USER_ID]
        );

        await tenantPool.query(
          `INSERT INTO production_run_outputs (id, run_id, item_id, quantity_produced, allocated_cost)
           VALUES (UUID(), ?, ?, ?, ?)`,
          [runId, fgRobo, outputQty, allocatedCost]
        );

        await tenantPool.query(
          `INSERT INTO production_run_inputs (id, run_id, item_type, item_id, quantity, unit_cost, line_total_cost) VALUES
           (UUID(), ?, 'raw_material', ?, ?, 420.00, ?),
           (UUID(), ?, 'raw_material', ?, ?, 1850.00, ?)`,
          [runId, rawAlum, outputQty * 12.5, outputQty * 12.5 * 420.00,
           runId, rawMotor, outputQty * 6, outputQty * 6 * 1850.00]
        );
      }

      // Customer Sales Invoices (Daily sales with realistic revenue growth)
      const salesId = crypto.randomUUID();
      const invNum = `INV-2026-${String(30 - dayOffset + 100).padStart(4, '0')}`;
      const customerId = [custTata, custReliance, custMahindra][dayOffset % 3];

      // Trending growth: base revenue grows over the 30 days
      const baseUnits = dayOffset < 10 ? 2 : 1;
      const isRobo = Math.random() < 0.65;
      const itemSold = isRobo ? fgRobo : fgCtrl;
      const unitRate = isRobo ? 145000 : 28500;
      const subtotal = baseUnits * unitRate;
      const taxAmount = subtotal * 0.18;
      const totalAmount = subtotal + taxAmount;
      const amountReceived = dayOffset > 5 ? totalAmount : (totalAmount * 0.5); // recent sales have partial receivables
      const amountDue = totalAmount - amountReceived;

      await tenantPool.query(
        `INSERT INTO sales (id, invoice_number, date, customer_id, location_id, finished_good_id, quantity, rate_per_unit, subtotal, total_tax, total_amount, amount_received, amount_due, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Confirmed')`,
        [salesId, invNum, dateStr, customerId, locFloor, itemSold, baseUnits, unitRate, subtotal, taxAmount, totalAmount, amountReceived, amountDue]
      );

      await tenantPool.query(
        `INSERT INTO sales_items (id, sale_id, finished_good_id, quantity, rate_per_unit, taxable_value, line_total)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?)`,
        [salesId, itemSold, baseUnits, unitRate, subtotal, totalAmount]
      );

      // Procurements (Every 3-4 days raw material POs)
      if (dayOffset % 3 === 0) {
        const poId = crypto.randomUUID();
        const poNum = `PO-2026-${String(Math.floor((30 - dayOffset) / 3) + 1).padStart(3, '0')}`;
        const vendorId = [venSteel, venChips, venMotors][(dayOffset / 3) % 3];
        const poSubtotal = Math.floor(65000 + Math.random() * 45000);
        const poTax = poSubtotal * 0.18;
        const poTotal = poSubtotal + poTax;
        const poPaid = dayOffset > 7 ? poTotal : (poTotal * 0.4);
        const poDue = poTotal - poPaid;
        const poQty = 50;
        const poRate = Math.round(poSubtotal / poQty);

        await tenantPool.query(
          `INSERT INTO procurements (id, procurement_number, date, vendor_id, location_id, raw_material_id, quantity, rate_per_unit, total_amount, amount_paid, amount_due, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Received')`,
          [poId, poNum, dateStr, vendorId, locStore, rawMotor, poQty, poRate, poTotal, poPaid, poDue]
        );

        await tenantPool.query(
          `INSERT INTO procurement_items (id, procurement_id, item_id, quantity, rate_per_unit, tax_rate, tax_amount, line_total)
           VALUES (UUID(), ?, ?, ?, ?, 18.00, ?, ?)`,
          [poId, rawMotor, poQty, poRate, poTax, poTotal]
        );
      }

      // Operational Expenses (Every 2-3 days)
      if (dayOffset % 2 === 1) {
        const categories = ['Utilities & Power', 'Lease & Storage Facility', 'Equipment Maintenance', 'Logistics & Freight', 'Quality Certification'];
        const cat = categories[dayOffset % categories.length];
        const expAmount = Math.floor(12000 + Math.random() * 18000);

        await tenantPool.query(
          `INSERT INTO expenses (id, date, category, amount, notes, created_by)
           VALUES (UUID(), ?, ?, ?, ?, ?)`,
          [dateStr, cat, expAmount, `Operational expenditure for ${cat}`, DEMO_USER_ID]
        );
      }
    }

    // Customer Return Request (1 realistic return to test returns integration)
    await tenantPool.query(
      `INSERT INTO return_requests (id, request_number, request_type, reference_id, reference_type, requested_by_type, customer_id, reason, status)
       VALUES (UUID(), 'RET-2026-001', 'sales_return', UUID(), 'sale', 'internal', ?, 'Minor sensor calibration discrepancy on 1 unit - recalibrated & resolved', 'Approved')`,
      [custTata]
    );

    // Stock Transfer
    await tenantPool.query(
      `INSERT INTO stock_transfers (id, transfer_number, from_location_id, to_location_id, item_type, item_id, quantity, notes, created_by)
       VALUES (UUID(), 'TRF-2026-001', ?, ?, 'raw_material', ?, 10, 'Transferred raw stepper motors to plant floor', ?)`,
      [locStore, locMain, rawMotor, DEMO_USER_ID]
    );

    console.log('\n========================================================================');
    console.log('✅ DEMO ACCOUNT SEEDED SUCCESSFULLY WITH 30 DAYS OF CONTINUOUS DATA!');
    console.log('========================================================================');
    console.log(`Workspace:       Apex FutureTech Robotics (APEX-AI01)`);
    console.log(`Login URL:       http://localhost:5173/login`);
    console.log(`Demo Email:      ${DEMO_EMAIL}`);
    console.log(`Demo Password:   ${DEMO_PASSWORD}`);
    console.log(`Role:            Owner (Full Internal Access)`);
    console.log(`Modules Covered: Catalog, Inventory, Procurement, Production, Shift Logs,`);
    console.log(`                 Sales Invoices, Expenses, Transfers, Returns, AI Analytics`);
    console.log('========================================================================\n');

  } catch (err) {
    console.error('Error during seeding AI demo account:', err);
    process.exit(1);
  } finally {
    await adminConn.end();
  }
}

if (require.main === module) {
  seedAiDemoAccount().then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = { seedAiDemoAccount };
