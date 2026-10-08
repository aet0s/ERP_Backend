/**
 * e2e_permissions.mjs — Comprehensive End-to-End Verification of Role & Permissions System
 */

import mysql from 'mysql2/promise';

const BASE_URL = 'http://localhost:4000';
const SUPER_ADMIN_SECRET = process.env.SUPER_ADMIN_SECRET || 'super_admin_secret_key_erp_2026';

const results = [];

function record(checkNum, name, passed, details = '') {
  results.push({ checkNum, name, passed, details });
  const status = passed ? 'PASS' : 'FAIL';
  console.log(`[${status}] Check ${checkNum}: ${name}${details ? ` (${details})` : ''}`);
}

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  const res = await fetch(url, {
    ...options,
    headers,
    body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined
  });
  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, data, headers: res.headers };
}

async function run() {
  console.log('================================================================');
  console.log('Starting E2E Permissions Verification Test Suite');
  console.log('================================================================\n');

  const stamp = Date.now();
  const ownerEmail = `e2e_owner_${stamp}@example.com`;
  const ownerPassword = 'Password123!';
  const workspaceName = `E2E Workspace ${stamp}`;

  console.log(`Setting up throwaway workspace: "${workspaceName}"...`);
  const regRes = await request('/auth/register', {
    method: 'POST',
    body: {
      owner_name: 'E2E Owner',
      owner_email: ownerEmail,
      owner_password: ownerPassword,
      company_name: workspaceName
    }
  });

  if (!regRes.ok) {
    console.error('Failed to register throwaway workspace:', regRes.data);
    process.exit(1);
  }

  const ownerToken = regRes.data.token;
  const workspaceId = regRes.data.workspace_id || regRes.data.company_id;
  const dbName = regRes.data.workspace?.database_name;

  console.log(`Workspace registered: ID = ${workspaceId}, DB = ${dbName}`);

  // Create staff user
  const staffEmail = `staff_${stamp}@example.com`;
  const staffPassword = 'Password123!';
  const createUserRes = await request('/api/users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}` },
    body: {
      name: 'E2E Staff Member',
      email: staffEmail,
      password: staffPassword,
      role: 'staff'
    }
  });

  if (!createUserRes.ok) {
    console.error('Failed to create staff user:', createUserRes.data);
    process.exit(1);
  }

  const memberId = createUserRes.data.user.id;
  console.log(`Staff user created: ID = ${memberId}, Email = ${staffEmail}`);

  // Login as staff user to obtain memberToken
  const staffLoginRes = await request('/auth/login', {
    method: 'POST',
    body: {
      email: staffEmail,
      password: staffPassword
    }
  });

  if (!staffLoginRes.ok) {
    console.error('Failed to login as staff member:', staffLoginRes.data);
    process.exit(1);
  }

  // THIS TOKEN WILL BE USED FOR THE WHOLE RUN
  const memberToken = staffLoginRes.data.token;
  console.log('Member token acquired. Proceeding to tests...\n');

  // -------------------------------------------------------------
  // Check 1: GET /api/permissions returns 6 roles x 19 modules including ai_analytics
  // -------------------------------------------------------------
  try {
    const permRes = await request('/api/permissions', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ownerToken}` }
    });

    const is200 = permRes.status === 200;
    const isArray = Array.isArray(permRes.data);
    const count = isArray ? permRes.data.length : 0;
    const has114 = count === 114;

    const roles = isArray ? Array.from(new Set(permRes.data.map(r => r.role))).sort() : [];
    const expectedRoles = ['accounts', 'manager', 'owner', 'production_manager', 'sales_manager', 'staff'].sort();
    const rolesMatch = JSON.stringify(roles) === JSON.stringify(expectedRoles);

    const modules = isArray ? Array.from(new Set(permRes.data.map(r => r.module))) : [];
    const hasAiAnalytics = modules.includes('ai_analytics');
    const has19Mods = modules.length === 19;

    const pass1 = is200 && has114 && rolesMatch && hasAiAnalytics && has19Mods;
    record(1, 'GET /api/permissions returns 6 roles x 19 modules including ai_analytics', pass1, `count=${count}, roles=${roles.length}, modules=${modules.length}`);
  } catch (err) {
    record(1, 'GET /api/permissions returns 6 roles x 19 modules', false, err.message);
  }

  // -------------------------------------------------------------
  // Check 2: Owner PUTs whole matrix with staff catalog:view=1 -> 200; staff GET /api/items goes 403 -> 200 immediately; revoke -> 403 again; /auth/me matches
  // -------------------------------------------------------------
  try {
    // A. Staff GET /api/items initially -> 403
    const initialStaffGet = await request('/api/items', {
      method: 'GET',
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const stepA = initialStaffGet.status === 403;

    // B. Fetch full matrix, update staff catalog view = 1
    const getMatrix = await request('/api/permissions', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    const matrix = getMatrix.data;
    const updatedMatrix = matrix.map(row => {
      if (row.role === 'staff' && row.module === 'catalog') {
        return { ...row, can_view: 1 };
      }
      return row;
    });

    const putMatrixRes = await request('/api/permissions', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: { permissions: updatedMatrix }
    });
    const stepB = putMatrixRes.status === 200 && putMatrixRes.data?.ok === true;

    // C. Staff GET /api/items immediately with SAME token -> 200
    const staffGetGranted = await request('/api/items', {
      method: 'GET',
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const stepC = staffGetGranted.status === 200;

    // D. Staff GET /auth/me -> permissions match
    const staffMeGranted = await request('/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const catalogPerm = staffMeGranted.data?.permissions?.find(p => p.module === 'catalog');
    const stepD = staffMeGranted.status === 200 && Number(catalogPerm?.can_view) === 1;

    // E. Revoke staff catalog view -> 0
    const revokedMatrix = updatedMatrix.map(row => {
      if (row.role === 'staff' && row.module === 'catalog') {
        return { ...row, can_view: 0 };
      }
      return row;
    });
    const revokeRes = await request('/api/permissions', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: { permissions: revokedMatrix }
    });
    const stepE = revokeRes.status === 200;

    // F. Staff GET /api/items -> 403 again
    const staffGetRevoked = await request('/api/items', {
      method: 'GET',
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const stepF = staffGetRevoked.status === 403;

    const pass2 = stepA && stepB && stepC && stepD && stepE && stepF;
    record(2, 'Owner PUTs staff catalog:view=1 -> 200; staff GET /api/items 403 -> 200 -> 403, /auth/me matches', pass2, `A(403)=${stepA}, B(200)=${stepB}, C(200)=${stepC}, D(me=1)=${stepD}, E(200)=${stepE}, F(403)=${stepF}`);
  } catch (err) {
    record(2, 'Owner PUTs whole matrix with staff catalog:view=1 and revokes', false, err.message);
  }

  // -------------------------------------------------------------
  // Check 3: Each flag (create/edit/delete) is honoured independently on /api/items endpoints
  // -------------------------------------------------------------
  try {
    // Grant staff view = 1, create = 0, edit = 0, delete = 0
    const matrixRes = await request('/api/permissions', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ownerToken}` }
    });

    const setFlags = async (create, edit, del) => {
      const updated = matrixRes.data.map(row => {
        if (row.role === 'staff' && row.module === 'catalog') {
          return { ...row, can_view: 1, can_create: create, can_edit: edit, can_delete: del };
        }
        return row;
      });
      await request('/api/permissions', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${ownerToken}` },
        body: { permissions: updated }
      });
    };

    // 1. Create flag test
    await setFlags(0, 0, 0);
    const postWith0 = await request('/api/items', {
      method: 'POST',
      headers: { Authorization: `Bearer ${memberToken}` },
      body: { name: 'Item Test' }
    });
    const createBlocked = postWith0.status === 403;

    await setFlags(1, 0, 0);
    const postWith1 = await request('/api/items', {
      method: 'POST',
      headers: { Authorization: `Bearer ${memberToken}` },
      body: { name: 'Item Test' }
    });
    // With create=1, should NOT be 403 (might be 200/201 or 400 validation error)
    const createAllowed = postWith1.status !== 403;

    // 2. Edit flag test
    await setFlags(0, 0, 0);
    const putWith0 = await request('/api/items/some-id', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${memberToken}` },
      body: { name: 'Updated' }
    });
    const editBlocked = putWith0.status === 403;

    await setFlags(0, 1, 0);
    const putWith1 = await request('/api/items/some-id', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${memberToken}` },
      body: { name: 'Updated' }
    });
    const editAllowed = putWith1.status !== 403;

    // 3. Delete flag test
    await setFlags(0, 0, 0);
    const deleteWith0 = await request('/api/items/some-id', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const deleteBlocked = deleteWith0.status === 403;

    await setFlags(0, 0, 1);
    const deleteWith1 = await request('/api/items/some-id', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const deleteAllowed = deleteWith1.status !== 403;

    // Reset flags
    await setFlags(0, 0, 0);

    const pass3 = createBlocked && createAllowed && editBlocked && editAllowed && deleteBlocked && deleteAllowed;
    record(3, 'Each flag (create/edit/delete) is honoured independently on /api/items endpoints', pass3, `create(${createBlocked},${createAllowed}), edit(${editBlocked},${editAllowed}), del(${deleteBlocked},${deleteAllowed})`);
  } catch (err) {
    record(3, 'Each flag (create/edit/delete) is honoured independently', false, err.message);
  }

  // -------------------------------------------------------------
  // Check 4: Owner changes member staff -> accounts -> sales_manager -> staff (and multi-role staff+accounts) with SAME token; /api/billing and /api/items change immediately and /auth/me matches; unknown role -> 400
  // -------------------------------------------------------------
  try {
    // A. Change staff -> accounts
    const toAccounts = await request(`/api/users/${memberId}/role`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: { role: 'accounts' }
    });
    const step4A = toAccounts.status === 200 && toAccounts.data.role === 'accounts';

    // Accounts can view billing and items immediately with same token
    const billingWithAccounts = await request('/api/billing', {
      method: 'GET',
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const itemsWithAccounts = await request('/api/items', {
      method: 'GET',
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const meWithAccounts = await request('/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const step4B = billingWithAccounts.status === 200 && itemsWithAccounts.status === 200 && meWithAccounts.data.user.role === 'accounts';

    // B. Change accounts -> sales_manager
    const toSalesMgr = await request(`/api/users/${memberId}/role`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: { role: 'sales_manager' }
    });
    const step4C = toSalesMgr.status === 200;

    // sales_manager has items view = 1, but billing view = 0
    const billingWithSalesMgr = await request('/api/billing', {
      method: 'GET',
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const meWithSalesMgr = await request('/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const step4D = billingWithSalesMgr.status === 403 && meWithSalesMgr.data.user.role === 'sales_manager';

    // C. Change to multi-role: staff + accounts
    const toMultiRole = await request(`/api/users/${memberId}/role`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: { role: 'staff', roles: ['staff', 'accounts'] }
    });
    const step4E = toMultiRole.status === 200;

    const meWithMulti = await request('/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const billingWithMulti = await request('/api/billing', {
      method: 'GET',
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const step4F = billingWithMulti.status === 200 &&
                   meWithMulti.data.user.role === 'staff' &&
                   meWithMulti.data.user.roles.includes('accounts');

    // D. Change back to staff
    const toStaff = await request(`/api/users/${memberId}/role`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: { role: 'staff', roles: ['staff'] }
    });
    const step4G = toStaff.status === 200;

    // E. Unknown role -> 400
    const toInvalid = await request(`/api/users/${memberId}/role`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: { role: 'super_wizard_unknown' }
    });
    const step4H = toInvalid.status === 400;

    const pass4 = step4A && step4B && step4C && step4D && step4E && step4F && step4G && step4H;
    record(4, 'Owner changes role transitions (staff -> accounts -> sales_manager -> multi -> staff), billing/items change immediately, unknown role -> 400', pass4, `A=${step4A}, B=${step4B}, C=${step4C}, D=${step4D}, E=${step4E}, F=${step4F}, G=${step4G}, H(400)=${step4H}`);
  } catch (err) {
    record(4, 'Owner role transitions with same member token', false, err.message);
  }

  // -------------------------------------------------------------
  // Check 5: Customising a role in the matrix (e.g. accounts locations:view=0) applies to a member assigned that role afterwards
  // -------------------------------------------------------------
  try {
    // Customize matrix: set accounts locations can_view = 0
    const matRes = await request('/api/permissions', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    const customized = matRes.data.map(row => {
      if (row.role === 'accounts' && row.module === 'locations') {
        return { ...row, can_view: 0 };
      }
      return row;
    });
    await request('/api/permissions', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: { permissions: customized }
    });

    // Assign member to accounts
    await request(`/api/users/${memberId}/role`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: { role: 'accounts', roles: ['accounts'] }
    });

    // Member checks /api/locations
    const locRes = await request('/api/locations', {
      method: 'GET',
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const locBlocked = locRes.status === 403;

    // Check member /auth/me locations permission is 0
    const meRes = await request('/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const locPerm = meRes.data?.permissions?.find(p => p.module === 'locations');
    const mePerm0 = Number(locPerm?.can_view) === 0;

    // Restore accounts locations view = 1
    const restored = customized.map(row => {
      if (row.role === 'accounts' && row.module === 'locations') {
        return { ...row, can_view: 1 };
      }
      return row;
    });
    await request('/api/permissions', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: { permissions: restored }
    });

    // Assign member back to staff
    await request(`/api/users/${memberId}/role`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: { role: 'staff', roles: ['staff'] }
    });

    const pass5 = locBlocked && mePerm0;
    record(5, 'Customising a role in matrix applies to member assigned that role afterwards', pass5, `locBlocked=${locBlocked}, mePerm0=${mePerm0}`);
  } catch (err) {
    record(5, 'Customising a role in matrix before assignment', false, err.message);
  }

  // -------------------------------------------------------------
  // Check 6: Owner rows cannot be changed even if client sends can_view=0
  // -------------------------------------------------------------
  try {
    const matRes = await request('/api/permissions', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    const matrixWithRevokedOwner = matRes.data.map(row => {
      if (row.role === 'owner') {
        return { ...row, can_view: 0, can_create: 0, can_edit: 0, can_delete: 0, can_approve: 0, can_export: 0 };
      }
      return row;
    });

    const putRes = await request('/api/permissions', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: { permissions: matrixWithRevokedOwner }
    });

    // Fresh matrix fetch
    const freshMat = await request('/api/permissions', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ownerToken}` }
    });

    const ownerRows = freshMat.data.filter(r => r.role === 'owner');
    const allOwnerRowsIntact = ownerRows.every(r => Number(r.can_view) === 1 && Number(r.can_create) === 1 && Number(r.can_edit) === 1);

    const pass6 = putRes.status === 200 && allOwnerRowsIntact;
    record(6, 'Owner rows cannot be changed even if client sends can_view=0 (immutable)', pass6, `ownerRowsCount=${ownerRows.length}, allIntact=${allOwnerRowsIntact}`);
  } catch (err) {
    record(6, 'Owner immutability verification', false, err.message);
  }

  // -------------------------------------------------------------
  // Check 7: Stress: 40 parallel reads of /api/stock and /auth/me while owner saves matrix, repeated 6 times toggling expenses:view; final /api/expenses matches last save
  // -------------------------------------------------------------
  try {
    // Set member role to accounts so expenses permission toggle is tested
    await request(`/api/users/${memberId}/role`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: { role: 'accounts', roles: ['accounts'] }
    });

    const matRes = await request('/api/permissions', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ownerToken}` }
    });

    let currentExpensesView = 0;

    for (let round = 1; round <= 6; round++) {
      currentExpensesView = round % 2 === 0 ? 1 : 0;

      const updated = matRes.data.map(row => {
        if (row.role === 'accounts' && row.module === 'expenses') {
          return { ...row, can_view: currentExpensesView };
        }
        return row;
      });

      // Concurrent tasks: 1 save + 40 parallel reads
      const savePromise = request('/api/permissions', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${ownerToken}` },
        body: { permissions: updated }
      });

      const readPromises = [];
      for (let i = 0; i < 20; i++) {
        readPromises.push(request('/api/stock', { method: 'GET', headers: { Authorization: `Bearer ${memberToken}` } }));
        readPromises.push(request('/auth/me', { method: 'GET', headers: { Authorization: `Bearer ${memberToken}` } }));
      }

      await Promise.all([savePromise, ...readPromises]);
    }

    // Verify final expenses:view status
    const finalExpensesCheck = await request('/api/expenses', {
      method: 'GET',
      headers: { Authorization: `Bearer ${memberToken}` }
    });

    // Round 6: 6 % 2 === 0 -> currentExpensesView = 1 -> status should be 200
    const pass7 = currentExpensesView === 1 ? finalExpensesCheck.status === 200 : finalExpensesCheck.status === 403;
    record(7, 'Stress: 40 parallel reads while owner saves matrix (x6 rounds), final expenses matches last save', pass7, `finalExpensesStatus=${finalExpensesCheck.status}, expectedView=${currentExpensesView}`);

    // Set member back to staff
    await request(`/api/users/${memberId}/role`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: { role: 'staff', roles: ['staff'] }
    });
  } catch (err) {
    record(7, 'Stress test concurrent reads and matrix saves', false, err.message);
  }

  // -------------------------------------------------------------
  // Check 8: Super admin (header x-super-admin-secret): GET/PUT /admin/workspaces/:id/permissions, PUT /admin/users/:id/roles with production_manager, unknown role -> 400; effects visible to member immediately
  // -------------------------------------------------------------
  try {
    const adminHeaders = {
      'x-super-admin-secret': SUPER_ADMIN_SECRET
    };

    // A. GET /admin/workspaces/:id/permissions
    const adminGet = await request(`/admin/workspaces/${workspaceId}/permissions`, {
      method: 'GET',
      headers: adminHeaders
    });
    const step8A = adminGet.status === 200 && Array.isArray(adminGet.data) && adminGet.data.length === 114;

    // B. PUT /admin/workspaces/:id/permissions
    const adminPut = await request(`/admin/workspaces/${workspaceId}/permissions`, {
      method: 'PUT',
      headers: adminHeaders,
      body: { permissions: adminGet.data }
    });
    const step8B = adminPut.status === 200 && adminPut.data?.ok === true;

    // C. PUT /admin/users/:id/roles with unknown role -> 400
    const adminUnknownRole = await request(`/admin/users/${memberId}/roles`, {
      method: 'PUT',
      headers: adminHeaders,
      body: { roles: ['super_secret_invalid_role'] }
    });
    const step8C = adminUnknownRole.status === 400;

    // D. PUT /admin/users/:id/roles with production_manager
    const adminValidRole = await request(`/admin/users/${memberId}/roles`, {
      method: 'PUT',
      headers: adminHeaders,
      body: { roles: ['production_manager'] }
    });
    const step8D = adminValidRole.status === 200 && adminValidRole.data?.role === 'production_manager';

    // E. Member immediately sees effects on /auth/me with same token
    const memberMe = await request('/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const step8E = memberMe.status === 200 && memberMe.data?.user?.role === 'production_manager';

    const pass8 = step8A && step8B && step8C && step8D && step8E;
    record(8, 'Super admin GET/PUT permissions, PUT user roles with production_manager, unknown role -> 400, visible immediately', pass8, `GET(114)=${step8A}, PUT(ok)=${step8B}, invalidRole(400)=${step8C}, assignProdMgr(200)=${step8D}, memberSeesProdMgr=${step8E}`);
  } catch (err) {
    record(8, 'Super admin permissions and role management', false, err.message);
  }

  // -------------------------------------------------------------
  // Check 9: A user set to status 'inactive' gets 403; a soft-deleted user gets 401
  // -------------------------------------------------------------
  try {
    const pool = mysql.createPool({
      host: process.env.MYSQL_HOST || 'localhost',
      port: parseInt(process.env.MYSQL_PORT || '3306', 10),
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: dbName
    });

    // A. Set user to status 'inactive' in tenant DB
    await pool.query("UPDATE users SET status = 'inactive' WHERE id = ?", [memberId]);

    const inactiveReq = await request('/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const step9A = inactiveReq.status === 403;

    // B. Re-activate user
    await pool.query("UPDATE users SET status = 'active' WHERE id = ?", [memberId]);
    const activeReq = await request('/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const step9B = activeReq.status === 200;

    // C. Soft-delete user
    await pool.query("UPDATE users SET deleted_at = NOW(), status = 'deleted' WHERE id = ?", [memberId]);
    const deletedReq = await request('/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const step9C = deletedReq.status === 401;

    await pool.end();

    const pass9 = step9A && step9B && step9C;
    record(9, "A user set to status 'inactive' gets 403; re-activated gets 200; soft-deleted gets 401", pass9, `inactive(403)=${step9A}, active(200)=${step9B}, deleted(401)=${step9C}`);
  } catch (err) {
    record(9, 'Inactive and soft-deleted user access enforcement', false, err.message);
  }

  // -------------------------------------------------------------
  // Check 10: Existing transaction-using routes commit and roll back correctly with transaction-aware wrapper
  // -------------------------------------------------------------
  try {
    const { getTenantPool } = await import('../db/tenantManager.js');
    const tenantPool = getTenantPool(dbName);

    // Test 1: START TRANSACTION -> INSERT -> ROLLBACK -> row not present
    const testItemId1 = `e2e_tx_item_rb_${Date.now()}`;
    await tenantPool.query('START TRANSACTION');
    await tenantPool.query(
      'INSERT INTO items (id, name, item_type, unit, default_price) VALUES (?, ?, "raw", "kg", 100)',
      [testItemId1, 'Transaction Rollback Test Item']
    );
    await tenantPool.query('ROLLBACK');

    const check1 = await tenantPool.query('SELECT id FROM items WHERE id = ?', [testItemId1]);
    const rollbackSuccess = check1.rows.length === 0;

    // Test 2: START TRANSACTION -> INSERT -> COMMIT -> row persists
    const testItemId2 = `e2e_tx_item_cm_${Date.now()}`;
    await tenantPool.query('START TRANSACTION');
    await tenantPool.query(
      'INSERT INTO items (id, name, item_type, unit, default_price) VALUES (?, ?, "raw", "kg", 200)',
      [testItemId2, 'Transaction Commit Test Item']
    );
    await tenantPool.query('COMMIT');

    const check2 = await tenantPool.query('SELECT id FROM items WHERE id = ?', [testItemId2]);
    const commitSuccess = check2.rows.length === 1;

    // Clean up test item
    await tenantPool.query('DELETE FROM items WHERE id = ?', [testItemId2]);

    // Test 3: Multiple rapid transactions on wrapper
    let rapidSuccess = true;
    for (let i = 0; i < 5; i++) {
      const id = `rapid_${i}_${Date.now()}`;
      await tenantPool.query('START TRANSACTION');
      await tenantPool.query(
        'INSERT INTO items (id, name, item_type, unit, default_price) VALUES (?, ?, "raw", "kg", ?)',
        [id, `Rapid Item ${i}`, i * 10]
      );
      if (i % 2 === 0) {
        await tenantPool.query('COMMIT');
        const c = await tenantPool.query('SELECT id FROM items WHERE id = ?', [id]);
        if (c.rows.length !== 1) rapidSuccess = false;
        await tenantPool.query('DELETE FROM items WHERE id = ?', [id]);
      } else {
        await tenantPool.query('ROLLBACK');
        const c = await tenantPool.query('SELECT id FROM items WHERE id = ?', [id]);
        if (c.rows.length !== 0) rapidSuccess = false;
      }
    }

    const pass10 = rollbackSuccess && commitSuccess && rapidSuccess;
    record(10, 'Existing transaction-using routes / wrapper commit and roll back correctly', pass10, `rollbackSuccess=${rollbackSuccess}, commitSuccess=${commitSuccess}, rapidSuccess=${rapidSuccess}`);
  } catch (err) {
    record(10, 'Transaction-aware wrapper commit/rollback verification', false, err.message);
  }

  // -------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------
  console.log('\n================================================================');
  console.log('Test Suite Summary');
  console.log('================================================================');
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const failed = total - passed;
  console.log(`Total Checks: ${total} | Passed: ${passed} | Failed: ${failed}`);

  if (failed > 0) {
    console.error('\nFAILURES DETECTED:');
    results.filter(r => !r.passed).forEach(r => {
      console.error(`- Check ${r.checkNum}: ${r.name} (${r.details})`);
    });
    process.exit(1);
  } else {
    console.log('\nALL 10 VERIFICATION CHECKS PASSED PERFECTLY!');
    process.exit(0);
  }
}

run().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
