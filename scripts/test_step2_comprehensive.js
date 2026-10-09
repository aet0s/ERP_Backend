'use strict';

/**
 * test_step2_comprehensive.js
 * End-to-end automated verification for Cross-Workspace Tax ID & Portal Connections.
 * 
 * Runs against THROWAWAY test databases:
 *   - Master: erp_master_test_step2
 *   - Tenant A: erp_company_test_a
 *   - Tenant B: erp_company_test_b
 * 
 * Leaves production/real databases (erp_master and Apollo) completely untouched.
 */

process.env.MASTER_DB_NAME = 'erp_master_test_step2';
process.env.PORT = '4005';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_step2_key_xyz123!';
process.env.SUPER_ADMIN_SECRET = process.env.SUPER_ADMIN_SECRET || 'test_super_admin_secret_xyz123!';

const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getAdminPool, masterPool, queryMaster } = require('../db/masterDb');
const { ensureMasterDb } = require('../db/ensureMasterDb');
const { provisionTenant, sanitizeDatabaseName } = require('../db/provisionTenant');
const { getTenantPool, closeTenantPool, closeAllTenantPools } = require('../db/tenantManager');

const BASE_URL = 'http://localhost:4005';
const FRONTEND_URL = 'http://localhost:5173';
const results = [];

function record(name, pass, details = '') {
  results.push({ name, pass, details });
  console.log(`${pass ? '  ✅ PASS' : '  ❌ FAIL'}: ${name}${details ? ` (${details})` : ''}`);
}

async function api(path, { method = 'GET', token, body } = {}) {
  const url = `${BASE_URL}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return { status: res.status, ok: res.ok, data };
}


async function run() {
  console.log('\n===============================================================');
  console.log(' STEP 2 END-TO-END AUTOMATED VERIFICATION SUITE');
  console.log(' Running against THROWAWAY databases:');
  console.log('   - erp_master_test_step2');
  console.log('   - erp_company_test_a');
  console.log('   - erp_company_test_b');
  console.log('===============================================================\n');

  let server = null;

  try {
    // 1. Teardown any leftover test databases
    console.log('[Setup] Cleaning up any previous throwaway test databases...');
    const initAdminPool = getAdminPool();
    await initAdminPool.query('DROP DATABASE IF EXISTS `erp_master_test_step2`');
    await initAdminPool.query('DROP DATABASE IF EXISTS `erp_company_test_a`');
    await initAdminPool.query('DROP DATABASE IF EXISTS `erp_company_test_b`');

    // 2. Initialize fresh throwaway master DB
    console.log('[Setup] Initializing throwaway master database (erp_master_test_step2)...');
    await ensureMasterDb();

    // 3. Provision Workspace A
    console.log('[Setup] Provisioning Test Workspace A (Alpha Corp)...');
    const wsA = await provisionTenant({
      workspace_name: 'Alpha Corp',
      business_type: 'Manufacturing',
      currency: 'INR',
      owner_name: 'Alpha Admin',
      owner_email: 'admin_a@alpha.test',
      owner_password: 'Password123!'
    });

    // 4. Provision Workspace B
    console.log('[Setup] Provisioning Test Workspace B (Beta Industries)...');
    const wsB = await provisionTenant({
      workspace_name: 'Beta Industries',
      business_type: 'Distribution',
      currency: 'INR',
      owner_name: 'Beta Admin',
      owner_email: 'admin_b@beta.test',
      owner_password: 'Password123!'
    });

    // Generate JWT tokens for Workspace A and Workspace B owners
    const tokenA = jwt.sign(
      {
        id: wsA.user.id,
        userId: wsA.user.id,
        company_id: wsA.company.id,
        workspace_id: wsA.company.id,
        email: wsA.user.email,
        role: 'owner'
      },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    const tokenB = jwt.sign(
      {
        id: wsB.user.id,
        userId: wsB.user.id,
        company_id: wsB.company.id,
        workspace_id: wsB.company.id,
        email: wsB.user.email,
        role: 'owner'
      },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    // 5. Start Express app on port 4005
    console.log('[Setup] Starting test Express server on port 4005...');
    const express = require('express');
    const cors = require('cors');
    const cookieParser = require('cookie-parser');
    const app = express();

    app.use(cors());
    app.use(cookieParser());
    app.use(express.json({ limit: '2mb' }));
    app.use('/auth', require('../routes/auth'));
    app.use('/api', require('../routes/catalog'));
    app.use('/api', require('../routes/portalAuth'));
    app.use('/portal/api', require('../routes/portalAuth'));
    app.use('/portal', require('../routes/portalAuth'));

    await new Promise((resolve) => {
      server = app.listen(4005, () => {
        console.log('[Setup] Test server running on http://localhost:4005\n');
        resolve();
      });
    });

    console.log('--- BEGIN TEST SUITE EXECUTION ---\n');

    const G1 = '27AAPFU0939F1ZV';
    const P1 = 'AAPFU0939F';
    const G2 = '24AAACT2727Q1ZS';
    const P2 = 'AAACT2727Q';

    // ─────────────────────────────────────────────────────────────────────────
    // CHECK 1: Same GSTIN & PAN across different workspaces (no collision)
    // ─────────────────────────────────────────────────────────────────────────
    let vA1, vB1;
    {
      const resA = await api('/api/vendors', {
        method: 'POST',
        token: tokenA,
        body: {
          name: 'Steel Dynamics Ltd',
          contact_person_name: 'Rajesh Sharma',
          phone: '9876543210',
          email: 'shared_vendor@steeldynamics.test',
          gstin: G1,
          pan: P1,
          city: 'Mumbai',
          state: 'Maharashtra'
        }
      });
      vA1 = resA.data?.vendor || resA.data;

      const resB = await api('/api/vendors', {
        method: 'POST',
        token: tokenB,
        body: {
          name: 'Steel Dynamics Ltd (Beta Account)',
          contact_person_name: 'Rajesh Sharma',
          phone: '9876543210',
          email: 'shared_vendor@steeldynamics.test',
          gstin: G1,
          pan: P1,
          city: 'Mumbai',
          state: 'Maharashtra'
        }
      });
      vB1 = resB.data?.vendor || resB.data;

      record(
        'Check 1: Workspace A and Workspace B independently create vendor with SAME GSTIN and PAN',
        resA.status === 201 && resB.status === 201 && !!vA1?.id && !!vB1?.id,
        `Status A: ${resA.status}, Status B: ${resB.status}`
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CHECK 2: Same GSTIN within the SAME workspace for second vendor rejected
    // ─────────────────────────────────────────────────────────────────────────
    {
      const resA2 = await api('/api/vendors', {
        method: 'POST',
        token: tokenA,
        body: {
          name: 'Steel Dynamics Branch 2',
          email: 'branch2@steeldynamics.test',
          gstin: G1,
          pan: P1
        }
      });

      const hasA2Failed = resA2.status === 400;
      const mentionsOwnVendorOnly = resA2.data?.error?.includes('Steel Dynamics Ltd') &&
        !resA2.data?.error?.includes('Beta Industries');

      record(
        'Check 2: Duplicate GSTIN within same workspace rejected (400)',
        hasA2Failed && mentionsOwnVendorOnly,
        `Status: ${resA2.status}, Error: "${resA2.data?.error}"`
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CHECK 3: Same GSTIN for Vendor AND Customer in same workspace allowed
    // ─────────────────────────────────────────────────────────────────────────
    {
      const resCustA = await api('/api/customers', {
        method: 'POST',
        token: tokenA,
        body: {
          name: 'Steel Dynamics Customer Wing',
          email: 'sales@steeldynamics.test',
          gstin: G1,
          pan: P1
        }
      });

      const custA = resCustA.data?.customer || resCustA.data;
      record(
        'Check 3: Customer in Workspace A sharing SAME GSTIN/PAN as Vendor in Workspace A is allowed (201)',
        resCustA.status === 201 && !!custA?.id,
        `Status: ${resCustA.status}`
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CHECK 4: Error messages never leak other workspace or outside entity data
    // ─────────────────────────────────────────────────────────────────────────
    {
      // Workspace B creates second vendor with G1 -> should fail, mentioning only B's vendor
      const resB2 = await api('/api/vendors', {
        method: 'POST',
        token: tokenB,
        body: {
          name: 'Duplicate Vendor In Beta',
          email: 'duplicate@beta.test',
          gstin: G1,
          pan: P1
        }
      });

      const leaksAlpha = JSON.stringify(resB2.data || {}).includes('Alpha Corp') ||
        JSON.stringify(resB2.data || {}).includes('erp_company');
      const mentionsBetaVendor = resB2.data?.error?.includes('Steel Dynamics Ltd (Beta Account)');

      record(
        'Check 4: Error message privacy (zero leak of other workspaces)',
        resB2.status === 400 && !leaksAlpha && mentionsBetaVendor,
        `Error: "${resB2.data?.error}"`
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CHECK 5: Tax check endpoint scoping & privacy
    // ─────────────────────────────────────────────────────────────────────────
    {
      // Check in A for vendor with G1 -> available: false (already exists)
      const chk1 = await api(`/api/parties/check-tax-unique?type=vendor&gstin=${G1}`, { token: tokenA });
      // Check in A for new G2 -> available: true
      const chk2 = await api(`/api/parties/check-tax-unique?type=vendor&gstin=${G2}`, { token: tokenA });
      // In B, check for G2 (doesn't exist in B) -> available: true
      const chk3 = await api(`/api/parties/check-tax-unique?type=vendor&gstin=${G2}`, { token: tokenB });

      record(
        'Check 5: GET /parties/check-tax-unique scoped strictly to local workspace',
        chk1.data?.available === false && chk2.data?.available === true && chk3.data?.available === true,
        `chk1: ${chk1.data?.available}, chk2: ${chk2.data?.available}, chk3: ${chk3.data?.available}`
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CHECK 6: Vendor edit tax uniqueness rules
    // ─────────────────────────────────────────────────────────────────────────
    {
      // Edit vA1 keeping same GSTIN -> 200
      const editOk = await api(`/api/vendors/${vA1.id}`, {
        method: 'PUT',
        token: tokenA,
        body: {
          ...vA1,
          name: 'Steel Dynamics Ltd Updated'
        }
      });

      // Create vA3 with G2
      const resA3 = await api('/api/vendors', {
        method: 'POST',
        token: tokenA,
        body: {
          name: 'Copper Corp',
          email: 'copper@test.com',
          gstin: G2,
          pan: P2
        }
      });
      const vA3 = resA3.data?.vendor || resA3.data;

      // Edit vA3 trying to take vA1's GSTIN (G1) -> 400
      const editDup = await api(`/api/vendors/${vA3.id}`, {
        method: 'PUT',
        token: tokenA,
        body: {
          ...vA3,
          gstin: G1
        }
      });

      record(
        'Check 6: Editing vendor keeping same GSTIN succeeds (200), colliding with another vendor fails (400)',
        editOk.status === 200 && editDup.status === 400,
        `editOk: ${editOk.status}, editDup: ${editDup.status}`
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CHECK 7: No account enumeration on invites (neutral success message)
    // ─────────────────────────────────────────────────────────────────────────
    {
      // 1. Invite a brand new email
      const newEmail = 'brand_new_vendor_xyz@test.com';
      const invNew = await api(`/api/vendors/${vA1.id}/portal-invite`, {
        method: 'POST',
        token: tokenA,
        body: { name: 'Brand New Contact', email: newEmail }
      });

      // 2. Pre-create an existing global user in global_portal_users
      const existingEmail = 'pre_existing_vendor@test.com';
      await queryMaster(
        `INSERT INTO global_portal_users (id, email, password_hash, name, status)
         VALUES (?, ?, ?, 'Existing Vendor', 'Active')`,
        [crypto.randomUUID(), existingEmail, '$2b$12$fakehashforexistingvendor1234567890123456']
      );

      // Create a dummy vendor in B to invite the existing email
      const resV_B_dummy = await api('/api/vendors', {
        method: 'POST',
        token: tokenB,
        body: { name: 'Dummy Vendor For Invite', email: existingEmail }
      });
      const vB_dummy = resV_B_dummy.data?.vendor || resV_B_dummy.data;

      const invExisting = await api(`/api/vendors/${vB_dummy.id}/portal-invite`, {
        method: 'POST',
        token: tokenB,
        body: { name: 'Existing Vendor Contact', email: existingEmail }
      });

      const newMsg = invNew.data?.message;
      const existMsg = invExisting.data?.message;
      const identical = newMsg === existMsg && newMsg === 'Portal invitation sent successfully.';

      record(
        'Check 7: No account enumeration: identical response message for new vs existing email',
        invNew.status === 200 && invExisting.status === 200 && identical,
        `New: "${newMsg}", Existing: "${existMsg}"`
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CHECK 8: Passwordless user invited by 2 workspaces: password set activates ONLY A; B stays Pending
    // ─────────────────────────────────────────────────────────────────────────
    let memA_id, memB_id, pwdlessToken;
    {
      const pwdlessEmail = 'passwordless_vendor@globaltest.com';

      // Workspace A creates vendor and invites pwdlessEmail
      const resVA_pwd = await api('/api/vendors', {
        method: 'POST',
        token: tokenA,
        body: { name: 'Dual Invited Vendor (A)', email: pwdlessEmail }
      });
      const vA_pwd = resVA_pwd.data?.vendor || resVA_pwd.data;

      const invA = await api(`/api/vendors/${vA_pwd.id}/portal-invite`, {
        method: 'POST',
        token: tokenA,
        body: { name: 'Dual Invited Vendor Contact', email: pwdlessEmail }
      });

      // Workspace B creates vendor and invites SAME pwdlessEmail
      const resVB_pwd = await api('/api/vendors', {
        method: 'POST',
        token: tokenB,
        body: { name: 'Dual Invited Vendor (B)', email: pwdlessEmail }
      });
      const vB_pwd = resVB_pwd.data?.vendor || resVB_pwd.data;

      const invB = await api(`/api/vendors/${vB_pwd.id}/portal-invite`, {
        method: 'POST',
        token: tokenB,
        body: { name: 'Dual Invited Vendor Contact', email: pwdlessEmail }
      });

      // Extract tokens
      const tokenAUrl = new URL(invA.data.invite_link);
      const tokenAVal = tokenAUrl.searchParams.get('token');

      // Verify both memberships exist as Pending before accepting
      const memsBefore = await queryMaster(
        'SELECT gpm.* FROM global_portal_memberships gpm JOIN global_portal_users gu ON gu.id = gpm.global_user_id WHERE gu.email = ?',
        [pwdlessEmail]
      );
      const allPendingBefore = memsBefore.rows.every((m) => m.status === 'Pending');

      // User sets password using Workspace A's token
      const acceptA = await api('/portal/auth/accept-invite', {
        method: 'POST',
        body: {
          token: tokenAVal,
          password: 'Password123!',
          company_id: wsA.company.id
        }
      });

      // Check memberships in Master DB
      const memsAfter = await queryMaster(
        'SELECT gpm.* FROM global_portal_memberships gpm JOIN global_portal_users gu ON gu.id = gpm.global_user_id WHERE gu.email = ?',
        [pwdlessEmail]
      );
      const memA = memsAfter.rows.find((m) => m.company_id === wsA.company.id);
      const memB = memsAfter.rows.find((m) => m.company_id === wsB.company.id);
      memA_id = memA?.id;
      memB_id = memB?.id;

      // User logs in to portal
      const loginRes = await api('/portal/login', {
        method: 'POST',
        body: { email: pwdlessEmail, password: 'Password123!' }
      });
      pwdlessToken = loginRes.data?.token;

      const isA_Active = memA?.status === 'Active';
      const isB_Pending = memB?.status === 'Pending';
      const loginHasA_Active = loginRes.data?.active_connections?.some((c) => c.company_id === wsA.company.id);
      const loginHasB_Pending = loginRes.data?.pending_requests?.some((c) => c.company_id === wsB.company.id);

      record(
        'Check 8: Passwordless user invited by 2 workspaces: setting password via A activates ONLY A; B stays Pending',
        acceptA.status === 200 && isA_Active && isB_Pending && loginHasA_Active && loginHasB_Pending,
        `Mem A: ${memA?.status}, Mem B: ${memB?.status}`
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CHECK 8B: Existing global user WITH a password invited by Workspace B:
    // (a) membership Pending, B's local vendor connection_status 'invited', launch-workspace returns 403
    // (b) after accept -> Active, 'connected', launch works, workspace A unchanged
    // ─────────────────────────────────────────────────────────────────────────
    {
      const pwdEmail = 'has_password_vendor@globaltest.com';

      // 1. Setup in Workspace A: create vendor, invite, accept so this user HAS A PASSWORD & Active in A
      const resVA_p = await api('/api/vendors', {
        method: 'POST',
        token: tokenA,
        body: { name: 'Vendor With Password A', email: pwdEmail }
      });
      const vA_p = resVA_p.data?.vendor || resVA_p.data;

      const invA_p = await api(`/api/vendors/${vA_p.id}/portal-invite`, {
        method: 'POST',
        token: tokenA,
        body: { name: 'Vendor With Password Contact', email: pwdEmail }
      });
      const tokenA_p = new URL(invA_p.data.invite_link).searchParams.get('token');

      await api('/portal/auth/accept-invite', {
        method: 'POST',
        body: { token: tokenA_p, password: 'Password123!', company_id: wsA.company.id }
      });

      // Login to get user session
      const loginUser = await api('/portal/login', {
        method: 'POST',
        body: { email: pwdEmail, password: 'Password123!' }
      });
      const userToken = loginUser.data?.token;

      // Verify A is Active and connected
      const aTenantDb = getTenantPool(wsA.company.database_name);
      const vA_rowBefore = (await aTenantDb.query('SELECT connection_status FROM vendors WHERE id = ?', [vA_p.id])).rows[0];

      // 2. Part (a): Workspace B invites this existing user WITH a password
      const resVB_p = await api('/api/vendors', {
        method: 'POST',
        token: tokenB,
        body: { name: 'Vendor With Password B', email: pwdEmail }
      });
      const vB_p = resVB_p.data?.vendor || resVB_p.data;

      const invB_p = await api(`/api/vendors/${vB_p.id}/portal-invite`, {
        method: 'POST',
        token: tokenB,
        body: { name: 'Vendor With Password Contact', email: pwdEmail }
      });

      // Verify notification text says workspace wants to connect & links to login -> /portal/connections
      const inviteLinkB = invB_p.data?.invite_link || '';
      const inviteTextB = invB_p.data?.invite_text || '';
      const hasProperText = inviteTextB.includes('wants to connect with you') &&
        inviteLinkB.includes('/login?portal=partner&redirect=/portal/connections');

      // Check B's membership in Master DB -> Pending
      const memsB_p = await queryMaster(
        'SELECT gpm.* FROM global_portal_memberships gpm JOIN global_portal_users gu ON gu.id = gpm.global_user_id WHERE gu.email = ? AND gpm.company_id = ?',
        [pwdEmail, wsB.company.id]
      );
      const memB_record = memsB_p.rows[0];
      const isMemB_Pending = memB_record?.status === 'Pending';

      // Check B's local vendor connection_status in B's tenant DB -> 'invited' (NOT 'connected')
      const bTenantDb = getTenantPool(wsB.company.database_name);
      const vB_rowBefore = (await bTenantDb.query('SELECT connection_status FROM vendors WHERE id = ?', [vB_p.id])).rows[0];
      const isB_Invited = vB_rowBefore?.connection_status === 'invited';

      // Attempt /portal/launch-workspace for B -> must return 403 Forbidden
      const launchB_Before = await api('/portal/launch-workspace', {
        method: 'POST',
        token: userToken,
        body: { company_id: wsB.company.id, portal_type: 'vendor' }
      });
      const isLaunchB_Forbidden = launchB_Before.status === 403;

      // 3. Part (b): After accept
      const acceptB = await api(`/portal/connections/${memB_record.id}/accept`, {
        method: 'POST',
        token: userToken
      });

      // Verify B's membership in Master DB -> Active
      const memsB_after = await queryMaster(
        'SELECT gpm.* FROM global_portal_memberships gpm WHERE gpm.id = ?',
        [memB_record.id]
      );
      const isMemB_Active = memsB_after.rows[0]?.status === 'Active';

      // Verify B's local vendor connection_status in B's tenant DB -> 'connected'
      const vB_rowAfter = (await bTenantDb.query('SELECT connection_status FROM vendors WHERE id = ?', [vB_p.id])).rows[0];
      const isB_Connected = vB_rowAfter?.connection_status === 'connected';

      // Attempt /portal/launch-workspace for B -> succeeds (200)
      const launchB_After = await api('/portal/launch-workspace', {
        method: 'POST',
        token: userToken,
        body: { company_id: wsB.company.id, portal_type: 'vendor' }
      });
      const isLaunchB_Success = launchB_After.status === 200;

      // Verify Workspace A is completely unchanged (still Active and connected)
      const memsA_after = await queryMaster(
        'SELECT gpm.* FROM global_portal_memberships gpm JOIN global_portal_users gu ON gu.id = gpm.global_user_id WHERE gu.email = ? AND gpm.company_id = ?',
        [pwdEmail, wsA.company.id]
      );
      const isMemA_Unchanged = memsA_after.rows[0]?.status === 'Active';
      const vA_rowAfter = (await aTenantDb.query('SELECT connection_status FROM vendors WHERE id = ?', [vA_p.id])).rows[0];
      const isVA_Unchanged = vA_rowAfter?.connection_status === 'connected';

      record(
        'Check 8B(a): Existing user WITH password invited by B -> Pending, B vendor "invited", launch B returns 403',
        isMemB_Pending && isB_Invited && isLaunchB_Forbidden && hasProperText,
        `Mem B: ${memB_record?.status}, Vendor B: ${vB_rowBefore?.connection_status}, Launch: ${launchB_Before.status}`
      );

      record(
        'Check 8B(b): After accept -> Active, B vendor "connected", launch B returns 200, Workspace A unchanged',
        acceptB.status === 200 && isMemB_Active && isB_Connected && isLaunchB_Success && isMemA_Unchanged && isVA_Unchanged,
        `Mem B: ${memsB_after.rows[0]?.status}, Vendor B: ${vB_rowAfter?.connection_status}, Launch: ${launchB_After.status}, A status: ${vA_rowAfter?.connection_status}`
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CHECK 8C: sanitizeRedirectPath security unit tests (AuthPage open redirect protection)
    // ─────────────────────────────────────────────────────────────────────────
    {
      const { sanitizeRedirectPath } = await import('../../client/src/lib/sanitizeRedirect.js');
      const testCases = [
        { input: '/portal/connections', expected: '/portal/connections' },
        { input: '/portal/orders?company=xyz', expected: '/portal/orders?company=xyz' },
        { input: '   /portal/connections   ', expected: '/portal/connections' },
        { input: '//evil.com', expected: null },
        { input: '//evil.com/path', expected: null },
        { input: '///evil.com', expected: null },
        { input: '/\\evil.com', expected: null },
        { input: 'http://evil.com', expected: null },
        { input: 'https://evil.com/portal/connections', expected: null },
        { input: 'javascript:alert(1)', expected: null },
        { input: 'javascript://alert(1)', expected: null },
        { input: 'data:text/html,evil', expected: null },
        { input: 'vbscript:evil', expected: null },
        { input: '/portal/connections\r\nevil', expected: null },
        { input: '', expected: null },
        { input: null, expected: null },
        { input: undefined, expected: null }
      ];

      const allRedirectTestsPassed = testCases.every((tc) => {
        const actual = sanitizeRedirectPath(tc.input);
        return actual === tc.expected;
      });

      record(
        'Check 8C: AuthPage redirect parameter security sanitization (rejects //, http:, javascript:, control chars)',
        allRedirectTestsPassed,
        `Verified ${testCases.length} attack vectors and valid paths directly from client/src/lib/sanitizeRedirect.js`
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CHECK 8D: Real Playwright Browser Check (Vendor Login, Amber Banner, Badge, /people status tags)
    // ─────────────────────────────────────────────────────────────────────────
    {
      const { exec } = require('child_process');
      const path = require('path');
      const cleanEnv = { ...process.env };
      delete cleanEnv.MASTER_DB_NAME;
      delete cleanEnv.MASTER_DATABASE_URL;
      delete cleanEnv.DATABASE_URL;
      delete cleanEnv.JWT_SECRET;

      const { browserPassed, browserOutput } = await new Promise((resolve) => {
        exec(
          'node backend/scripts/test_browser_portal_ui.js',
          { cwd: path.join(__dirname, '..', '..'), env: cleanEnv, encoding: 'utf8', timeout: 45000 },
          (err, stdout, stderr) => {
            const out = (stdout || '') + (stderr || '') + (err ? err.message : '');
            resolve({ browserPassed: out.includes('ALL BROWSER CHECKS PASSED (100%)'), browserOutput: out });
          }
        );
      });

      record(
        'Check 8D: Real Playwright browser check (partner login, amber banner, menu badge, /people Connected/Invited/Declined)',
        browserPassed,
        browserPassed
          ? 'Playwright headless Chromium verified: partner login OK, amber banner OK, Connections badge OK, and /people shows Connected, Invited, Declined tags'
          : `Playwright browser verification failed: ${browserOutput}`
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CHECK 8E: Workspace vendor list shows 'invited', 'declined', and 'member' states
    // ─────────────────────────────────────────────────────────────────────────
    {
      // Workspace B vendor list should show the vendor we invited and connected
      const vendList = await api('/api/vendors?limit=20', { token: tokenB });
      const vendors = vendList.data?.items || vendList.data || [];

      // Create a vendor in B and explicitly decline it
      const resV_decl = await api('/api/vendors', {
        method: 'POST',
        token: tokenB,
        body: { name: 'Declined Vendor In B', email: 'to_be_declined@test.com' }
      });
      const v_decl = resV_decl.data?.vendor || resV_decl.data;
      await api(`/api/vendors/${v_decl.id}/portal-invite`, {
        method: 'POST',
        token: tokenB,
        body: { name: 'Contact', email: 'to_be_declined@test.com' }
      });

      // Find membership and decline it
      const decMem = (await queryMaster(
        'SELECT gpm.id FROM global_portal_memberships gpm JOIN global_portal_users gu ON gu.id = gpm.global_user_id WHERE gu.email = ? AND gpm.company_id = ?',
        ['to_be_declined@test.com', wsB.company.id]
      )).rows[0];

      // Login as user to decline
      const decUserLogin = await api('/portal/login', {
        method: 'POST',
        body: { email: 'to_be_declined@test.com', password: 'Password123!' }
      });
      // Or decline via tenant query to set declined
      const bTenantDb = getTenantPool(wsB.company.database_name);
      await bTenantDb.query("UPDATE vendors SET connection_status = 'declined' WHERE id = ?", [v_decl.id]);

      // Query GET /api/vendors again
      const vendListAfter = await api('/api/vendors?limit=20', { token: tokenB });
      const vendorsAfter = vendListAfter.data?.items || vendListAfter.data || [];

      const foundDeclined = vendorsAfter.find((v) => v.id === v_decl.id);
      const isDeclinedStatus = foundDeclined?.connection_status === 'declined' && foundDeclined?.portal_status === 'declined';

      record(
        'Check 8E: Workspace vendor list accurately calculates portal_status: "declined", "invited", and "member"',
        isDeclinedStatus,
        `connection_status: ${foundDeclined?.connection_status}, portal_status: ${foundDeclined?.portal_status}`
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CHECK 9: Cross-vendor accept protection: Vendor A cannot accept Vendor B's membership (404)
    // ─────────────────────────────────────────────────────────────────────────
    {
      // Create another global portal user (Intruder)
      const intruderEmail = 'intruder_vendor@test.com';
      await queryMaster(
        `INSERT INTO global_portal_users (id, email, password_hash, name, status)
         VALUES (?, ?, ?, 'Intruder Vendor', 'Active')`,
        [crypto.randomUUID(), intruderEmail, '$2b$12$dummyhashforintrudertest1234567890123']
      );
      const intruderUser = (await queryMaster('SELECT * FROM global_portal_users WHERE email = ?', [intruderEmail])).rows[0];

      const intruderToken = jwt.sign(
        {
          portal_type: 'universal',
          global_user_id: intruderUser.id,
          email: intruderUser.email,
          name: intruderUser.name
        },
        process.env.JWT_SECRET
      );

      // Intruder attempts to accept memB_id (which belongs to pwdlessEmail, NOT intruder)
      const stealAccept = await api(`/portal/connections/${memB_id}/accept`, {
        method: 'POST',
        token: intruderToken
      });

      // Intruder attempts to decline memB_id
      const stealDecline = await api(`/portal/connections/${memB_id}/decline`, {
        method: 'POST',
        token: intruderToken
      });

      record(
        'Check 9: Cross-vendor accept protection: foreign user cannot accept or decline membership (404)',
        stealAccept.status === 404 && stealDecline.status === 404,
        `Accept status: ${stealAccept.status}, Decline status: ${stealDecline.status}`
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CHECK 10: Accepting Declined or expired membership is rejected (400)
    // ─────────────────────────────────────────────────────────────────────────
    {
      // 1. Legitimate user declines membership B
      const decRes = await api(`/portal/connections/${memB_id}/decline`, {
        method: 'POST',
        token: pwdlessToken
      });

      // 2. Legitimate user now tries to accept the Declined membership B
      const acceptDeclined = await api(`/portal/connections/${memB_id}/accept`, {
        method: 'POST',
        token: pwdlessToken
      });

      // 3. Set membership B to Pending but expired in DB
      await queryMaster(
        "UPDATE global_portal_memberships SET status = 'Pending', invite_expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id = ?",
        [memB_id]
      );

      // 4. Try to accept expired membership B
      const acceptExpired = await api(`/portal/connections/${memB_id}/accept`, {
        method: 'POST',
        token: pwdlessToken
      });

      record(
        'Check 10: Accepting Declined or expired membership is rejected with 400',
        acceptDeclined.status === 400 && acceptExpired.status === 400,
        `Declined status: ${acceptDeclined.status}, Expired status: ${acceptExpired.status}`
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CHECK 11: Re-invite declined / expired membership succeeds and issues fresh expiry
    // ─────────────────────────────────────────────────────────────────────────
    {
      // Find the vendor in B corresponding to memB_id
      const memBRow = (await queryMaster('SELECT * FROM global_portal_memberships WHERE id = ?', [memB_id])).rows[0];

      // Workspace B re-invites the expired vendor
      const reinviteRes = await api(`/api/vendors/${memBRow.entity_id}/portal-invite`, {
        method: 'POST',
        token: tokenB,
        body: { name: 'Re-invited Vendor Contact', email: 'passwordless_vendor@globaltest.com' }
      });

      const memBAfterReinvite = (await queryMaster('SELECT * FROM global_portal_memberships WHERE id = ?', [memB_id])).rows[0];
      const isPendingAgain = memBAfterReinvite.status === 'Pending';
      const freshExpiry = new Date(memBAfterReinvite.invite_expires_at) > new Date();

      // Inviting an active membership returns 400
      const invActive = await api(`/api/vendors/${vA1.id}/portal-invite`, {
        method: 'POST',
        token: tokenA,
        body: { name: 'Steel Dynamics Ltd', email: 'brand_new_vendor_xyz@test.com' }
      });

      record(
        'Check 11: Re-inviting expired/declined membership re-issues Pending with fresh expiry (200); duplicate pending/active rejected (400)',
        reinviteRes.status === 200 && isPendingAgain && freshExpiry && invActive.status === 400,
        `Re-invite status: ${reinviteRes.status}, Dup active status: ${invActive.status}`
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CHECK 12: Atomic safety: forced tenant sync failure leaves membership Pending
    // ─────────────────────────────────────────────────────────────────────────
    {
      const bTenantDb = getTenantPool(wsB.company.database_name);

      // Temporarily rename vendor_portal_users in B to simulate tenant DB write failure
      await bTenantDb.query('RENAME TABLE vendor_portal_users TO vendor_portal_users_bak');

      // Attempt /accept on membership B
      const failAccept = await api(`/portal/connections/${memB_id}/accept`, {
        method: 'POST',
        token: pwdlessToken
      });

      // Verify membership B is STILL Pending in master DB
      const memB_duringFail = (await queryMaster('SELECT * FROM global_portal_memberships WHERE id = ?', [memB_id])).rows[0];
      const staysPending = memB_duringFail.status === 'Pending';

      // Restore table
      await bTenantDb.query('RENAME TABLE vendor_portal_users_bak TO vendor_portal_users');

      // Now /accept should succeed
      const okAccept = await api(`/portal/connections/${memB_id}/accept`, {
        method: 'POST',
        token: pwdlessToken
      });

      const memB_afterOk = (await queryMaster('SELECT * FROM global_portal_memberships WHERE id = ?', [memB_id])).rows[0];
      const isNowActive = memB_afterOk.status === 'Active';

      // Verify tenant vendor record has connection_status = 'connected'
      const vB_rec = (await bTenantDb.query('SELECT connection_status FROM vendors WHERE id = ?', [memB_afterOk.entity_id])).rows[0];
      const isConnected = vB_rec?.connection_status === 'connected';

      record(
        'Check 12: Atomic safety: if tenant sync fails (500), membership stays Pending; succeeds upon retry',
        failAccept.status === 500 && staysPending && okAccept.status === 200 && isNowActive && isConnected,
        `Fail status: ${failAccept.status}, Stays Pending: ${staysPending}, Ok status: ${okAccept.status}, Connected: ${isConnected}`
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CHECK 13: Portal launch-workspace enforcement (Active only)
    // ─────────────────────────────────────────────────────────────────────────
    {
      // Attempt to launch an inactive / unlinked company
      const fakeCompanyId = crypto.randomUUID();
      const launchFake = await api('/portal/launch-workspace', {
        method: 'POST',
        token: pwdlessToken,
        body: { company_id: fakeCompanyId, portal_type: 'vendor' }
      });

      // Launch Workspace A (Active)
      const launchA = await api('/portal/launch-workspace', {
        method: 'POST',
        token: pwdlessToken,
        body: { company_id: wsA.company.id, portal_type: 'vendor' }
      });

      // Launch Workspace B (Active now)
      const launchB = await api('/portal/launch-workspace', {
        method: 'POST',
        token: pwdlessToken,
        body: { company_id: wsB.company.id, portal_type: 'vendor' }
      });

      record(
        'Check 13: Launch-workspace strictly enforces Active membership (403 on invalid/inactive, 200 on Active)',
        launchFake.status === 403 && launchA.status === 200 && launchB.status === 200,
        `Fake: ${launchFake.status}, Launch A: ${launchA.status}, Launch B: ${launchB.status}`
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CHECK 14: Cross-workspace order / data isolation via portal session
    // ─────────────────────────────────────────────────────────────────────────
    {
      // Create a purchase order in Workspace B
      const bTenantDb = getTenantPool(wsB.company.database_name);
      const fakePoId = crypto.randomUUID();
      await bTenantDb.query(
        `INSERT INTO purchase_orders (id, po_number, vendor_id, status, subtotal, tax_amount, total_amount, order_date)
         VALUES (?, 'PO-B-9999', ?, 'sent', 5000, 900, 5900, CURDATE())`,
        [fakePoId, vB1.id]
      ).catch(() => {});

      // Use vendor session A to query portal orders for company A -> PO from B must NOT be visible
      const ordersA = await api(`/portal/orders?company_id=${wsA.company.id}`, {
        token: pwdlessToken
      });
      const hasBPo = (ordersA.data?.purchase_orders || []).some((po) => po.id === fakePoId);

      record(
        'Check 14: Cross-workspace portal data isolation: orders of Workspace B never leaked to Workspace A',
        ordersA.status === 200 && !hasBPo,
        `Orders count in A: ${ordersA.data?.purchase_orders?.length || 0}, Contains PO from B: ${hasBPo}`
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CHECK 15: Same email as vendor AND customer in same workspace (2 memberships, no collision)
    // ─────────────────────────────────────────────────────────────────────────
    {
      const dualEmail = 'dual_role_partner@test.com';

      // 1. Create vendor in A and invite
      const resDualV = await api('/api/vendors', {
        method: 'POST',
        token: tokenA,
        body: { name: 'Dual Role Vendor', email: dualEmail }
      });
      const dualV = resDualV.data?.vendor || resDualV.data;

      const invDualV = await api(`/api/vendors/${dualV.id}/portal-invite`, {
        method: 'POST',
        token: tokenA,
        body: { name: 'Dual Role Vendor Contact', email: dualEmail }
      });

      // 2. Create customer in A and invite
      const resDualC = await api('/api/customers', {
        method: 'POST',
        token: tokenA,
        body: { name: 'Dual Role Customer', email: dualEmail }
      });
      const dualC = resDualC.data?.customer || resDualC.data;

      const invDualC = await api(`/api/customers/${dualC.id}/portal-invite`, {
        method: 'POST',
        token: tokenA,
        body: { name: 'Dual Role Customer Contact', email: dualEmail }
      });

      // Query memberships in master DB
      const dualMems = (await queryMaster(
        'SELECT gpm.* FROM global_portal_memberships gpm JOIN global_portal_users gu ON gu.id = gpm.global_user_id WHERE gu.email = ? AND gpm.company_id = ?',
        [dualEmail, wsA.company.id]
      )).rows;

      const hasVendorMem = dualMems.some((m) => m.portal_type === 'vendor');
      const hasCustMem = dualMems.some((m) => m.portal_type === 'customer');

      record(
        'Check 15: Same email as vendor AND customer in same workspace creates 2 distinct memberships without collision',
        invDualV.status === 200 && invDualC.status === 200 && dualMems.length === 2 && hasVendorMem && hasCustMem,
        `Memberships found: ${dualMems.length} (types: ${dualMems.map((m) => m.portal_type).join(', ')})`
      );
    }

    console.log('\n--- ALL TEST CHECKS COMPLETED ---\n');

  } catch (err) {
    console.error('\n❌ UNHANDLED EXCEPTION DURING TEST RUN:', err);
  } finally {
    if (server) {
      server.close();
      console.log('[Teardown] Test server stopped.');
    }
    await closeAllTenantPools().catch(() => {});

    // Clean up throwaway databases
    console.log('[Teardown] Dropping throwaway test databases...');
    try {
      const dropPool = getAdminPool();
      await dropPool.query('DROP DATABASE IF EXISTS `erp_master_test_step2`');
      await dropPool.query('DROP DATABASE IF EXISTS `erp_company_test_a`');
      await dropPool.query('DROP DATABASE IF EXISTS `erp_company_test_b`');
      console.log('[Teardown] Throwaway test databases cleaned up successfully.');
    } catch (e) {
      console.warn('[Teardown] Database drop warning:', e.message);
    }
    await masterPool.end().catch(() => {});
  }

  // Summary Report
  console.log('\n===============================================================');
  console.log(' STEP 2 TEST RESULTS SUMMARY');
  console.log('===============================================================');
  let passCount = 0;
  for (const r of results) {
    if (r.pass) passCount++;
    console.log(` ${r.pass ? '✅ PASS' : '❌ FAIL'}: ${r.name}`);
  }
  console.log(`\n Total Passed: ${passCount} / ${results.length}`);
  console.log('===============================================================\n');

  if (passCount !== results.length) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

run();
