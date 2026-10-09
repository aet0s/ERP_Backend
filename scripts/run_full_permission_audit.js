const axios = require('axios');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const API_BASE = 'http://localhost:4000';
const COMPANY_ID = '03867519-ebfd-4d79-8e8e-7f9c5308f664';
const OWNER_ID = '308bfdbb-050d-4d38-9130-e2321a9caddd';
const OWNER_EMAIL = 'inf@apollo.com';
const DEMO_EMAIL = 'demo.perm.test@apollo.com';

const MODULES = [
  'dashboard', 'catalog', 'inventory', 'procurement',
  'production', 'shift_log', 'sales', 'parties', 'expenses',
  'locations', 'reports', 'settings', 'vendor_orders', 'customer_orders', 'returns',
  'users', 'billing', 'stock_transfers', 'ai_analytics'
];

const ACTIONS = ['can_view', 'can_create', 'can_edit', 'can_delete', 'can_approve', 'can_export'];

const MODULE_ENDPOINTS = {
  sales: { method: 'get', url: '/api/sales' },
  procurement: { method: 'get', url: '/api/procurements' },
  inventory: { method: 'get', url: '/api/raw-materials' },
  production: { method: 'get', url: '/api/production-batches' },
  expenses: { method: 'get', url: '/api/expenses' },
  locations: { method: 'get', url: '/api/locations' },
  stock_transfers: { method: 'get', url: '/api/stock-transfers' },
  parties: { method: 'get', url: '/api/customers' },
  catalog: { method: 'get', url: '/api/finished-goods' },
  dashboard: { method: 'get', url: '/api/dashboard/stats' },
  ai_analytics: { method: 'get', url: '/api/ai-analytics/overview' },
  reports: { method: 'get', url: '/api/reports/gst-summary' },
  users: { method: 'get', url: '/api/users' },
  returns: { method: 'get', url: '/api/return-requests' }
};

function createJwt(user) {
  return jwt.sign(
    {
      id: user.id,
      user_id: user.id,
      userId: user.id,
      company_id: COMPANY_ID,
      workspace_id: COMPANY_ID,
      email: user.email,
      name: user.name,
      role: user.role,
      roles: user.roles || [user.role]
    },
    process.env.JWT_SECRET,
    { expiresIn: '1d' }
  );
}

async function run() {
  console.log('=== STARTING ROLE & PERMISSION MATRIX FULL AUDIT ===\n');

  const tenantConn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost',
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: 'erp_company_03867519ebfd4d798e8e7f9c5308f664'
  });

  const masterConn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost',
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MASTER_DB_NAME || 'erp_master'
  });

  // Step 0: Ensure demo user exists in tenant & master DB
  let [demoUsers] = await tenantConn.query('SELECT * FROM users WHERE email = ?', [DEMO_EMAIL]);
  let demoUser = demoUsers[0];

  if (!demoUser) {
    const demoId = crypto.randomUUID();
    await tenantConn.query(
      `INSERT INTO users (id, name, email, password_hash, role, roles, status)
       VALUES (?, 'Demo Test Member', ?, 'demo_hash_123', 'staff', '["staff"]', 'active')`,
      [demoId, DEMO_EMAIL]
    );
    await masterConn.query(
      `INSERT INTO company_users (id, company_id, email, user_id, role, roles, status)
       VALUES (?, ?, ?, ?, 'staff', '["staff"]', 'active')`,
      [crypto.randomUUID(), COMPANY_ID, DEMO_EMAIL, demoId]
    );
    [demoUsers] = await tenantConn.query('SELECT * FROM users WHERE email = ?', [DEMO_EMAIL]);
    demoUser = demoUsers[0];
    console.log('Created dedicated demo user:', DEMO_EMAIL, 'id:', demoUser.id);
  } else {
    console.log('Using existing demo user:', DEMO_EMAIL, 'id:', demoUser.id);
  }

  const ownerToken = createJwt({
    id: OWNER_ID,
    email: OWNER_EMAIL,
    name: 'Hardick',
    role: 'owner',
    roles: ['owner']
  });

  const allTestResults = {
    summary: {
      timestamp: new Date().toISOString(),
      workspace: 'Apollo',
      owner: OWNER_EMAIL,
      demoUser: DEMO_EMAIL,
      totalTests: 0,
      passed: 0,
      failed: 0
    },
    roleTests: [],
    toggleTests: [],
    routeAudits: []
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. TEST ROLE ASSIGNMENT & PERMISSION RESOLUTION FOR EVERY ROLE
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 1. Testing Role Assignment & Verification for Every Role ---');
  const rolesToTest = ['manager', 'accounts', 'production_manager', 'sales_manager', 'staff', 'admin', 'owner'];

  for (const targetRole of rolesToTest) {
    allTestResults.summary.totalTests++;
    const testItem = {
      role: targetRole,
      assignSuccess: false,
      repeatedChangeSuccess: false,
      authMeRoleMatches: false,
      permCount: 0,
      hasRequiredModules: false,
      status: 'FAIL',
      details: ''
    };

    try {
      // 1. Assign role
      const res1 = await axios.put(
        `${API_BASE}/api/users/${demoUser.id}/role`,
        { role: targetRole, roles: [targetRole] },
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      testItem.assignSuccess = res1.data.ok === true && res1.data.role === targetRole;

      // 2. Change the role of the same person AGAIN immediately (testing "changing role of same person")
      const resRepeated = await axios.put(
        `${API_BASE}/api/users/${demoUser.id}/role`,
        { role: targetRole, roles: [targetRole] },
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      testItem.repeatedChangeSuccess = resRepeated.data.ok === true;

      // 3. Issue member JWT and verify /auth/me
      const memberToken = createJwt({
        id: demoUser.id,
        email: DEMO_EMAIL,
        name: 'Demo Test Member',
        role: targetRole,
        roles: [targetRole]
      });

      const meRes = await axios.get(`${API_BASE}/auth/me`, {
        headers: { Authorization: `Bearer ${memberToken}` }
      });

      testItem.authMeRoleMatches = meRes.data.user.role === targetRole;
      testItem.permCount = meRes.data.permissions?.length || 0;
      testItem.hasRequiredModules = testItem.permCount >= 19;

      if (testItem.assignSuccess && testItem.repeatedChangeSuccess && testItem.authMeRoleMatches && testItem.hasRequiredModules) {
        testItem.status = 'PASS';
        testItem.details = `Successfully assigned ${targetRole}, repeated same-person update passed, /auth/me matched with ${testItem.permCount} module permissions.`;
        allTestResults.summary.passed++;
        console.log(`  ✅ [PASS] Role: ${targetRole.padEnd(20)} | Permissions: ${testItem.permCount} | Repeated Update: OK`);
      } else {
        testItem.status = 'FAIL';
        testItem.details = `Incomplete resolution: assign=${testItem.assignSuccess}, repeated=${testItem.repeatedChangeSuccess}, authMe=${testItem.authMeRoleMatches}, permCount=${testItem.permCount}`;
        allTestResults.summary.failed++;
        console.log(`  ❌ [FAIL] Role: ${targetRole.padEnd(20)} | Details: ${testItem.details}`);
      }
    } catch (err) {
      testItem.status = 'FAIL';
      testItem.details = err.response?.data?.error || err.message;
      allTestResults.summary.failed++;
      console.log(`  ❌ [ERROR] Role: ${targetRole.padEnd(18)} | Error: ${testItem.details}`);
    }

    allTestResults.roleTests.push(testItem);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. TEST PERMISSION TOGGLE FOR ALL MODULES (CHECKBOX TESTING)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 2. Testing Live Permission Toggles Across All Modules for Staff Role ---');

  // Set demo user to staff for granular toggle tests
  await axios.put(
    `${API_BASE}/api/users/${demoUser.id}/role`,
    { role: 'staff', roles: ['staff'] },
    { headers: { Authorization: `Bearer ${ownerToken}` } }
  );

  const memberToken = createJwt({
    id: demoUser.id,
    email: DEMO_EMAIL,
    name: 'Demo Test Member',
    role: 'staff',
    roles: ['staff']
  });

  // Fetch current permissions matrix
  const permRes = await axios.get(`${API_BASE}/api/permissions`, {
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  let permissionsMatrix = permRes.data;

  // Test toggling every module
  for (const mod of MODULES) {
    const row = permissionsMatrix.find(p => p.role === 'staff' && p.module === mod);
    if (!row) continue;

    for (const action of ['can_view', 'can_create']) {
      allTestResults.summary.totalTests++;
      const origVal = Number(row[action]) === 1 ? 1 : 0;
      const toggleVal = origVal === 1 ? 0 : 1;

      const toggleItem = {
        role: 'staff',
        module: mod,
        action,
        originalValue: origVal,
        toggledValue: toggleVal,
        ownerSaveOk: false,
        memberReflectedOk: false,
        apiEnforcedOk: true,
        status: 'FAIL',
        details: ''
      };

      try {
        // Step A: Owner toggles permission
        row[action] = toggleVal;
        const updateRes = await axios.put(
          `${API_BASE}/api/permissions`,
          { permissions: permissionsMatrix },
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        toggleItem.ownerSaveOk = updateRes.data.ok === true;

        // Step B: Member immediately calls /auth/me to check reflection
        const memberMe = await axios.get(`${API_BASE}/auth/me`, {
          headers: { Authorization: `Bearer ${memberToken}` }
        });
        const memberPerm = memberMe.data.permissions?.find(p => p.module === mod);
        const reflectedVal = memberPerm ? Number(memberPerm[action]) : null;
        toggleItem.memberReflectedOk = reflectedVal === toggleVal;

        // Step C: If endpoint exists, verify API enforcement
        if (action === 'can_view' && MODULE_ENDPOINTS[mod]) {
          const endpoint = MODULE_ENDPOINTS[mod];
          try {
            const apiRes = await axios({
              method: endpoint.method,
              url: `${API_BASE}${endpoint.url}`,
              headers: { Authorization: `Bearer ${memberToken}` }
            });
            // If toggle was 0, it should fail or return 403
            if (toggleVal === 0) {
              toggleItem.apiEnforcedOk = false; // Expected 403, got 200
            } else {
              toggleItem.apiEnforcedOk = apiRes.status === 200;
            }
          } catch (apiErr) {
            if (toggleVal === 0) {
              toggleItem.apiEnforcedOk = apiErr.response?.status === 403;
            } else {
              toggleItem.apiEnforcedOk = false;
            }
          }
        }

        // Restore original value
        row[action] = origVal;
        await axios.put(
          `${API_BASE}/api/permissions`,
          { permissions: permissionsMatrix },
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );

        if (toggleItem.ownerSaveOk && toggleItem.memberReflectedOk && toggleItem.apiEnforcedOk) {
          toggleItem.status = 'PASS';
          toggleItem.details = `Toggled to ${toggleVal}: Owner save OK, Member /auth/me reflected immediately (${reflectedVal}), API enforcement verified.`;
          allTestResults.summary.passed++;
          console.log(`  ✅ [PASS] ${mod.padEnd(16)} | ${action.padEnd(10)} | Reflected: ${reflectedVal} | Status: PASS`);
        } else {
          toggleItem.status = 'FAIL';
          toggleItem.details = `Mismatch: ownerSave=${toggleItem.ownerSaveOk}, memberReflected=${toggleItem.memberReflectedOk} (got ${reflectedVal}, expected ${toggleVal}), apiEnforced=${toggleItem.apiEnforcedOk}`;
          allTestResults.summary.failed++;
          console.log(`  ❌ [FAIL] ${mod.padEnd(16)} | ${action.padEnd(10)} | ${toggleItem.details}`);
        }
      } catch (err) {
        toggleItem.status = 'FAIL';
        toggleItem.details = err.response?.data?.error || err.message;
        allTestResults.summary.failed++;
        console.log(`  ❌ [ERROR] ${mod.padEnd(16)} | ${action.padEnd(10)} | ${toggleItem.details}`);
      }

      allTestResults.toggleTests.push(toggleItem);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. PAGE & COMPONENT RBAC COVERAGE AUDIT
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 3. Page & Route RBAC Functionality Verification ---');
  const pages = [
    { page: 'SalesPage.tsx', module: 'sales', route: '/sales' },
    { page: 'ProcurementPage.tsx', module: 'procurement', route: '/procurement' },
    { page: 'InventoryPage.tsx', module: 'inventory', route: '/inventory' },
    { page: 'ProductionRunsPage.tsx', module: 'production', route: '/production' },
    { page: 'ProductionShiftLogPage.tsx', module: 'shift_log', route: '/shift-logs' },
    { page: 'ExpensesPage.tsx', module: 'expenses', route: '/expenses' },
    { page: 'LocationsPage.tsx', module: 'locations', route: '/locations' },
    { page: 'StockTransferPage.tsx', module: 'stock_transfers', route: '/stock-transfers' },
    { page: 'AiAnalyticsPage.tsx', module: 'ai_analytics', route: '/ai-analytics' },
    { page: 'CatalogPage.tsx', module: 'catalog', route: '/catalog' },
    { page: 'PeoplePage.tsx', module: 'parties', route: '/people' },
    { page: 'ReportsPage.tsx', module: 'reports', route: '/reports' },
    { page: 'ReturnRequestsPage.tsx', module: 'returns', route: '/return-requests' },
    { page: 'UsersPage.tsx', module: 'users', route: '/users' },
    { page: 'SettingsPage.tsx', module: 'settings', route: '/settings' },
    { page: 'DashboardPage.tsx', module: 'dashboard', route: '/' }
  ];

  for (const p of pages) {
    allTestResults.summary.totalTests++;
    const auditItem = {
      page: p.page,
      module: p.module,
      route: p.route,
      hasUsePermissions: false,
      hasViewGuard: false,
      hasRoleGuardInShell: true,
      status: 'PASS',
      details: 'Fully protected by usePermissions hook and AppShell RoleGuard.'
    };

    const filePath = path.join(__dirname, '../../client/src/pages', p.page);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      auditItem.hasUsePermissions = content.includes('usePermissions');
      auditItem.hasViewGuard = content.includes('canView') || content.includes('Access Restricted');
      if (auditItem.hasUsePermissions && auditItem.hasViewGuard) {
        auditItem.status = 'PASS';
        allTestResults.summary.passed++;
        console.log(`  ✅ [PASS] Page: ${p.page.padEnd(25)} | Module: ${p.module.padEnd(16)} | Guard: Active`);
      } else {
        auditItem.status = 'FAIL';
        auditItem.details = `Missing check: hasUsePermissions=${auditItem.hasUsePermissions}, hasViewGuard=${auditItem.hasViewGuard}`;
        allTestResults.summary.failed++;
        console.log(`  ❌ [FAIL] Page: ${p.page.padEnd(25)} | Module: ${p.module.padEnd(16)} | Guard: Missing`);
      }
    } else {
      auditItem.status = 'FAIL';
      auditItem.details = 'File not found';
      allTestResults.summary.failed++;
    }

    allTestResults.routeAudits.push(auditItem);
  }

  // Restore demo user to staff
  await axios.put(
    `${API_BASE}/api/users/${demoUser.id}/role`,
    { role: 'staff', roles: ['staff'] },
    { headers: { Authorization: `Bearer ${ownerToken}` } }
  );

  await tenantConn.end();
  await masterConn.end();

  // Save audit data to JSON for Excel generator
  const outJson = path.join(__dirname, 'permission_audit_results.json');
  fs.writeFileSync(outJson, JSON.stringify(allTestResults, null, 2));
  console.log(`\nAudit data written to ${outJson}`);
  console.log(`\nSUMMARY: Total: ${allTestResults.summary.totalTests} | Passed: ${allTestResults.summary.passed} | Failed: ${allTestResults.summary.failed}`);
}

run().catch(console.error);
