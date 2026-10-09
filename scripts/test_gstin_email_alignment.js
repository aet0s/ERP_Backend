// Test script for Option 1: Global GSTIN-email alignment across workspaces
require('dotenv').config();
const { queryMaster } = require('../db/masterDb');
const { getTenantPool } = require('../db/tenantManager');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_erp_2026';
const BASE_URL = 'http://localhost:4000';

async function run() {
  console.log('--- Starting Global GSTIN-Email Alignment Test ---');

  // 1. Fetch two active companies
  const compRes = await queryMaster("SELECT id, company_name, database_name FROM companies WHERE status = 'active' LIMIT 2");
  if (compRes.rows.length < 2) {
    throw new Error('Need at least 2 active companies to test cross-workspace alignment');
  }

  const [companyA, companyB] = compRes.rows;
  console.log(`Company A: ${companyA.company_name} (${companyA.id})`);
  console.log(`Company B: ${companyB.company_name} (${companyB.id})`);

  const poolA = getTenantPool(companyA.database_name);
  const poolB = getTenantPool(companyB.database_name);

  let uResA = await poolA.query("SELECT id, email, role FROM users WHERE (role = 'Admin' OR roles LIKE '%Admin%') AND deleted_at IS NULL LIMIT 1");
  let userA = uResA.rows[0];
  if (!userA) {
    const idA = 'test-admin-a-' + Date.now();
    await poolA.query("INSERT INTO users (id, name, email, role, status) VALUES (?, 'Admin A', 'admin_a@test.com', 'Admin', 'active')", [idA]);
    userA = { id: idA, email: 'admin_a@test.com', role: 'Admin' };
  }

  let uResB = await poolB.query("SELECT id, email, role FROM users WHERE (role = 'Admin' OR roles LIKE '%Admin%') AND deleted_at IS NULL LIMIT 1");
  let userB = uResB.rows[0];
  if (!userB) {
    const idB = 'test-admin-b-' + Date.now();
    await poolB.query("INSERT INTO users (id, name, email, role, status) VALUES (?, 'Admin B', 'admin_b@test.com', 'Admin', 'active')", [idB]);
    userB = { id: idB, email: 'admin_b@test.com', role: 'Admin' };
  }

  // Generate auth tokens for real users
  const tokenA = jwt.sign({
    userId: userA.id,
    id: userA.id,
    company_id: companyA.id,
    role: userA.role || 'Admin',
    email: userA.email
  }, JWT_SECRET, { expiresIn: '1h' });

  const tokenB = jwt.sign({
    userId: userB.id,
    id: userB.id,
    company_id: companyB.id,
    role: userB.role || 'Admin',
    email: userB.email
  }, JWT_SECRET, { expiresIn: '1h' });

  const testGstin = '27ABCDE1234F1Z5';
  const emailA = 'unified_vendor@example.com';
  const emailWrong = 'different_email@example.com';

  // Clean up any test records beforehand
  await poolA.query('DELETE FROM vendors WHERE UPPER(gstin) = ?', [testGstin]);
  await poolB.query('DELETE FROM vendors WHERE UPPER(gstin) = ?', [testGstin]);
  await queryMaster('DELETE FROM global_portal_users WHERE UPPER(gstin) = ?', [testGstin]);

  console.log('\n[Case 1] Workspace A creates vendor with GSTIN and emailA...');
  const res1 = await fetch(`${BASE_URL}/api/vendors`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenA}`
    },
    body: JSON.stringify({
      name: 'Unified Test Vendor',
      vendor_code: 'VEN-TEST-ALIGN-A',
      email: emailA,
      phone: '9876543210',
      street: '123 Test Street',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400001',
      gstin: testGstin
    })
  });

  const body1 = await res1.json();
  if (res1.status !== 201) {
    console.error('Case 1 FAILED:', res1.status, body1);
    process.exit(1);
  }
  console.log('✓ Case 1 Passed: Vendor created in Workspace A (status 201, id:', body1.id, ')');

  console.log('\n[Case 2] Preflight check in Workspace B with differing email...');
  const preflightRes2 = await fetch(`${BASE_URL}/api/parties/check-tax-unique?gstin=${testGstin}&email=${emailWrong}&type=vendor`, {
    headers: { 'Authorization': `Bearer ${tokenB}` }
  });
  const preflightBody2 = await preflightRes2.json();
  console.log('Preflight response:', preflightBody2);
  if (preflightBody2.available !== false || !preflightBody2.error || !preflightBody2.error.includes(emailA)) {
    console.error('Case 2 preflight FAILED: expected available=false referencing emailA');
    process.exit(1);
  }
  console.log('✓ Case 2 Preflight Passed: Blocked and referenced correct registered email');

  console.log('\n[Case 3] Workspace B attempts to create vendor with same GSTIN but DIFFERENT email (emailWrong)...');
  const res3 = await fetch(`${BASE_URL}/api/vendors`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenB}`
    },
    body: JSON.stringify({
      name: 'Unified Test Vendor Branch B',
      vendor_code: 'VEN-TEST-ALIGN-B',
      email: emailWrong,
      phone: '9876543211',
      street: '456 Branch Road',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411001',
      gstin: testGstin
    })
  });
  const body3 = await res3.json();
  console.log('Workspace B (different email) response:', res3.status, body3);
  if (res3.status !== 400 || !body3.error || !body3.error.includes(emailA)) {
    console.error('Case 3 FAILED: expected 400 with alignment error mentioning', emailA);
    process.exit(1);
  }
  console.log('✓ Case 3 Passed: Creation blocked with message:', body3.error);

  console.log('\n[Case 4] Workspace B creates vendor with same GSTIN and MATCHING email (emailA)...');
  const res4 = await fetch(`${BASE_URL}/api/vendors`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenB}`
    },
    body: JSON.stringify({
      name: 'Unified Test Vendor Branch B',
      vendor_code: 'VEN-TEST-ALIGN-B',
      email: emailA,
      phone: '9876543211',
      street: '456 Branch Road',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411001',
      gstin: testGstin
    })
  });
  const body4 = await res4.json();
  if (res4.status !== 201) {
    console.error('Case 4 FAILED:', res4.status, body4);
    process.exit(1);
  }
  console.log('✓ Case 4 Passed: Vendor created in Workspace B with matching email (status 201, id:', body4.id, ')');

  console.log('\n[Case 5] Workspace B attempts to UPDATE vendor email to mismatched email...');
  const res5 = await fetch(`${BASE_URL}/api/vendors/${body4.id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenB}`
    },
    body: JSON.stringify({
      email: emailWrong
    })
  });
  const body5 = await res5.json();
  console.log('Workspace B update response:', res5.status, body5);
  if (res5.status !== 400 || !body5.error || !body5.error.includes(emailA)) {
    console.error('Case 5 FAILED: expected 400 blocking update to mismatched email');
    process.exit(1);
  }
  console.log('✓ Case 5 Passed: Update blocked with message:', body5.error);

  // Clean up vendors
  await poolA.query('DELETE FROM vendors WHERE UPPER(gstin) = ?', [testGstin]);
  await poolB.query('DELETE FROM vendors WHERE UPPER(gstin) = ?', [testGstin]);

  console.log('\n--- Testing Customer GSTIN-Email Alignment ---');
  const custGstin = '29ABCDE5678F1Z2';
  const custEmailA = 'unified_customer@example.com';
  const custEmailWrong = 'wrong_customer@example.com';

  await poolA.query('DELETE FROM customers WHERE UPPER(gstin) = ?', [custGstin]);
  await poolB.query('DELETE FROM customers WHERE UPPER(gstin) = ?', [custGstin]);

  console.log('\n[Case 6] Workspace A creates customer with GSTIN and custEmailA...');
  const res6 = await fetch(`${BASE_URL}/api/customers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenA}`
    },
    body: JSON.stringify({
      name: 'Unified Test Customer',
      customer_code: 'CUST-ALIGN-A',
      email: custEmailA,
      phone: '9876543220',
      street: '789 Client Ave',
      city: 'Bangalore',
      state: 'Karnataka',
      pincode: '560001',
      gstin: custGstin
    })
  });
  const body6 = await res6.json();
  if (res6.status !== 201) {
    console.error('Case 6 FAILED:', res6.status, body6);
    process.exit(1);
  }
  console.log('✓ Case 6 Passed: Customer created in Workspace A (status 201, id:', body6.id, ')');

  console.log('\n[Case 7] Workspace B attempts to create customer with same GSTIN but mismatched email...');
  const res7 = await fetch(`${BASE_URL}/api/customers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenB}`
    },
    body: JSON.stringify({
      name: 'Unified Test Customer Branch B',
      customer_code: 'CUST-ALIGN-B',
      email: custEmailWrong,
      phone: '9876543221',
      street: '789 Client Ave Branch',
      city: 'Bangalore',
      state: 'Karnataka',
      pincode: '560001',
      gstin: custGstin
    })
  });
  const body7 = await res7.json();
  if (res7.status !== 400 || !body7.error || !body7.error.includes(custEmailA)) {
    console.error('Case 7 FAILED: expected 400 with alignment error mentioning', custEmailA, body7);
    process.exit(1);
  }
  console.log('✓ Case 7 Passed: Customer creation blocked with message:', body7.error);

  console.log('\n[Case 8] Workspace B creates customer with same GSTIN and matching email...');
  const res8 = await fetch(`${BASE_URL}/api/customers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenB}`
    },
    body: JSON.stringify({
      name: 'Unified Test Customer Branch B',
      customer_code: 'CUST-ALIGN-B',
      email: custEmailA,
      phone: '9876543221',
      street: '789 Client Ave Branch',
      city: 'Bangalore',
      state: 'Karnataka',
      pincode: '560001',
      gstin: custGstin
    })
  });
  const body8 = await res8.json();
  if (res8.status !== 201) {
    console.error('Case 8 FAILED:', res8.status, body8);
    process.exit(1);
  }
  console.log('✓ Case 8 Passed: Customer created in Workspace B with matching email (status 201, id:', body8.id, ')');

  // Clean up customers
  await poolA.query('DELETE FROM customers WHERE UPPER(gstin) = ?', [custGstin]);
  await poolB.query('DELETE FROM customers WHERE UPPER(gstin) = ?', [custGstin]);

  console.log('\n🎉 ALL GLOBAL GSTIN-EMAIL ALIGNMENT CHECKS (VENDORS & CUSTOMERS) PASSED SUCCESSFULLY!');
  process.exit(0);
}

run().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
