'use strict';

/**
 * test_browser_portal_ui.js
 *
 * Real browser verification (Playwright) of:
 * 1. Vendor login with pending invitation:
 *    - Amber banner on /portal/orders is visible
 *    - Connections menu badge in sidebar is visible (showing count)
 * 2. Workspace /people table:
 *    - Shows Connected, Invited, and Declined badges correctly
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { chromium } = require('playwright');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { queryMaster } = require('../db/masterDb');
const { getTenantPool } = require('../db/tenantManager');

async function resolveFrontendUrl() {
  if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL;
  for (const port of [5174, 5173, 5175]) {
    try {
      const res = await fetch(`http://localhost:${port}`);
      const text = await res.text();
      if (text.includes('ERP') || text.includes('erp')) {
        return `http://localhost:${port}`;
      }
    } catch (_) {}
  }
  return 'http://localhost:5174';
}

const JWT_SECRET = process.env.JWT_SECRET || 'erp_secret_key_production_sharding_2026';

async function runBrowserTest() {
  const FRONTEND_URL = await resolveFrontendUrl();
  console.log(`--- Using ERP Frontend URL: ${FRONTEND_URL} ---`);
  console.log('--- Setting up Playwright Browser Test Fixtures ---');

  // 1. Fetch Apollo workspace
  const apolloCompRes = await queryMaster("SELECT * FROM companies WHERE company_name = 'Apollo' LIMIT 1");
  if (apolloCompRes.rowCount === 0) {
    throw new Error('Apollo company not found in masterDb');
  }
  const apollo = apolloCompRes.rows[0];
  const apolloDb = getTenantPool(apollo.database_name);

  // 2. Fetch or create a second workspace for the pending request
  let secondCompRes = await queryMaster("SELECT * FROM companies WHERE id != ? AND status = 'active' LIMIT 1", [apollo.id]);
  if (secondCompRes.rowCount === 0) {
    throw new Error('No second company found in masterDb');
  }
  const secondComp = secondCompRes.rows[0];

  // 3. Ensure test vendor user in masterDb
  const vendorEmail = 'browser_test_vendor@playwright.test';
  const vendorPassword = 'VendorPassword123!';
  const passwordHash = await bcrypt.hash(vendorPassword, 10);
  const vendorUserId = crypto.randomUUID();

  await queryMaster(
    `INSERT INTO global_portal_users (id, email, password_hash, name, status, email_verified_at)
     VALUES (?, ?, ?, 'Playwright Test Vendor', 'Active', NOW())
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), status = 'Active'`,
    [vendorUserId, vendorEmail, passwordHash]
  );

  const uRes = await queryMaster('SELECT id FROM global_portal_users WHERE email = ?', [vendorEmail]);
  const realVendorUserId = uRes.rows[0].id;

  // 4. Create Active membership to Apollo
  const activeMemId = crypto.randomUUID();
  await queryMaster(
    `INSERT INTO global_portal_memberships (id, global_user_id, company_id, entity_id, portal_type, status, joined_at)
     VALUES (?, ?, ?, ?, 'vendor', 'Active', NOW())
     ON DUPLICATE KEY UPDATE status = 'Active'`,
    [activeMemId, realVendorUserId, apollo.id, '652939f5-75b5-4225-a48a-2068969f80a9']
  );

  // 5. Create Pending membership from second company
  const pendingMemId = crypto.randomUUID();
  const inviteExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await queryMaster(
    `INSERT INTO global_portal_memberships (id, global_user_id, company_id, entity_id, portal_type, status, invite_expires_at)
     VALUES (?, ?, ?, ?, 'vendor', 'Pending', ?)
     ON DUPLICATE KEY UPDATE status = 'Pending', invite_expires_at = VALUES(invite_expires_at)`,
    [pendingMemId, realVendorUserId, secondComp.id, crypto.randomUUID(), inviteExpiry]
  );

  // 6. In Apollo tenant DB, ensure 3 vendors with statuses: connected, invited, declined
  const vConnectedId = crypto.randomUUID();
  const vInvitedId = crypto.randomUUID();
  const vDeclinedId = crypto.randomUUID();

  await apolloDb.query(
    `INSERT INTO vendors (id, vendor_code, name, email, phone, connection_status)
     VALUES (?, 'VEN-PW-01', 'PW Connected Vendor Ltd', 'pw_conn@test.com', '9876543201', 'connected')
     ON DUPLICATE KEY UPDATE connection_status = 'connected'`,
    [vConnectedId]
  );

  await apolloDb.query(
    `INSERT INTO vendors (id, vendor_code, name, email, phone, connection_status)
     VALUES (?, 'VEN-PW-02', 'PW Invited Vendor LLC', 'pw_inv@test.com', '9876543202', 'invited')
     ON DUPLICATE KEY UPDATE connection_status = 'invited'`,
    [vInvitedId]
  );

  await apolloDb.query(
    `INSERT INTO vendors (id, vendor_code, name, email, phone, connection_status)
     VALUES (?, 'VEN-PW-03', 'PW Declined Vendor Co', 'pw_dec@test.com', '9876543203', 'declined')
     ON DUPLICATE KEY UPDATE connection_status = 'declined'`,
    [vDeclinedId]
  );

  // 7. Ensure Apollo admin user token for /people check
  const adminRes = await apolloDb.query("SELECT id, name, email, role, roles FROM users WHERE role IN ('owner', 'admin') LIMIT 1");
  let adminUser = adminRes.rows[0];
  if (!adminUser) {
    const newAdminId = crypto.randomUUID();
    await apolloDb.query(
      `INSERT INTO users (id, name, email, password_hash, role, roles, status)
       VALUES (?, 'Apollo Admin', 'pw_admin@apollo.test', ?, 'owner', '[\"owner\"]', 'active')`,
      [newAdminId, passwordHash]
    );
    adminUser = { id: newAdminId, name: 'Apollo Admin', email: 'pw_admin@apollo.test', role: 'owner', roles: ['owner'] };
  }

  const adminToken = jwt.sign(
    {
      userId: adminUser.id,
      user_id: adminUser.id,
      id: adminUser.id,
      email: adminUser.email,
      role: adminUser.role,
      roles: ['owner'],
      company_id: apollo.id,
      workspace_id: apollo.id
    },
    process.env.JWT_SECRET || 'super_secret_jwt_key_erp_2026',
    { expiresIn: '1h' }
  );

  console.log('--- Launching Playwright Chromium Browser ---');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const results = {
    partnerLoginSuccess: false,
    amberBannerVisible: false,
    amberBannerText: '',
    connectionsBadgeVisible: false,
    connectionsBadgeCount: '',
    peoplePageLoaded: false,
    connectedBadgeVisible: false,
    invitedBadgeVisible: false,
    declinedBadgeVisible: false
  };

  page.on('console', (msg) => console.log('BROWSER CONSOLE:', msg.text()));
  page.on('response', async (res) => {
    if (res.url().includes('/login') || res.url().includes('/portal') || res.url().includes('/auth')) {
      try {
        const text = await res.text();
        console.log(`[HTTP ${res.status()}] ${res.url()} ->`, text.slice(0, 200));
      } catch (_) {}
    }
  });

  try {
    // ──────── TEST PART 1: VENDOR LOGIN & PARTNER PORTAL ────────
    console.log(`Navigating to ${FRONTEND_URL}/login?portal=partner ...`);
    await page.goto(`${FRONTEND_URL}/login?portal=partner`, { waitUntil: 'networkidle' });

    // Explicitly click "Partner Portal" tab button to guarantee partner form is shown
    const partnerTabBtn = page.locator('button:has-text("Partner Portal")').first();
    if (await partnerTabBtn.isVisible()) {
      await partnerTabBtn.click();
      await page.waitForTimeout(300);
    }

    console.log('Filling in partner credentials...');
    const emailInput = page.locator('input[placeholder="partner@vendor-corp.com"], input[type="email"]').first();
    const passwordInput = page.locator('form input[type="password"]').first();
    await emailInput.fill(vendorEmail);
    await passwordInput.fill(vendorPassword);

    console.log('Submitting Partner Login...');
    const submitBtn = page.locator('button:has-text("Sign In to Partner Portal"), button[type="submit"]').first();
    await submitBtn.click();

    // Wait for URL or error message
    await page.waitForTimeout(2000);
    console.log('Page URL after submit click:', page.url());

    // Wait for URL to transition to portal
    await page.waitForURL(/.*\/portal\/(orders|connections).*/, { timeout: 10000 });
    results.partnerLoginSuccess = true;
    console.log('Partner login success! Current URL:', page.url());

    // If redirected to /portal/orders, assert amber banner and badge
    if (!page.url().includes('/portal/orders')) {
      await page.goto(`${FRONTEND_URL}/portal/orders`, { waitUntil: 'networkidle' });
    }

    // Assert amber banner
    const banner = page.locator('text=/pending workspace connection/i').first();
    await banner.waitFor({ state: 'visible', timeout: 5000 });
    results.amberBannerVisible = await banner.isVisible();
    results.amberBannerText = await banner.innerText();
    console.log('✓ Amber Banner is visible:', results.amberBannerText);

    // Assert Connections menu badge in sidebar
    const connLink = page.locator('a[href="/portal/connections"]').first();
    await connLink.waitFor({ state: 'visible', timeout: 5000 });
    // Look for badge element inside or adjacent to connLink
    const badge = connLink.locator('span.rounded-full, span:has-text("1")').first();
    results.connectionsBadgeVisible = await badge.isVisible();
    results.connectionsBadgeCount = await badge.innerText();
    console.log('✓ Connections Menu Badge is visible with count:', results.connectionsBadgeCount);

    // ──────── TEST PART 2: WORKSPACE /PEOPLE TABLE ────────
    console.log('Setting admin auth tokens to inspect /people ...');
    await page.evaluate(({ token, company, user }) => {
      localStorage.clear();
      localStorage.setItem('erp_token', token);
      localStorage.setItem('erp_workspace', JSON.stringify(company));
      localStorage.setItem('erp_user', JSON.stringify(user));
    }, { token: adminToken, company: apollo, user: adminUser });

    console.log(`Navigating to ${FRONTEND_URL}/people ...`);
    await page.goto(`${FRONTEND_URL}/people`, { waitUntil: 'networkidle' });
    results.peoplePageLoaded = true;

    // Wait for table to load
    await page.waitForSelector('table', { timeout: 10000 });

    // Assert "Connected" badge in table
    const connectedBadge = page.locator('span:has-text("Connected")').first();
    await connectedBadge.waitFor({ state: 'visible', timeout: 5000 });
    results.connectedBadgeVisible = await connectedBadge.isVisible();
    console.log('✓ "Connected" badge is visible in /people');

    // Assert "Invited" badge in table
    const invitedBadge = page.locator('button:has-text("Invited")').first();
    await invitedBadge.waitFor({ state: 'visible', timeout: 5000 });
    results.invitedBadgeVisible = await invitedBadge.isVisible();
    console.log('✓ "Invited" badge is visible in /people');

    // Assert "Declined (Re-invite)" badge in table
    const declinedBadge = page.locator('button:has-text("Declined")').first();
    await declinedBadge.waitFor({ state: 'visible', timeout: 5000 });
    results.declinedBadgeVisible = await declinedBadge.isVisible();
    console.log('✓ "Declined (Re-invite)" badge is visible in /people');

  } catch (err) {
    console.error('Playwright Browser Test Error:', err);
    throw err;
  } finally {
    await browser.close();
  }

  return results;
}

if (require.main === module) {
  runBrowserTest()
    .then((results) => {
      console.log('\n--- PLAYWRIGHT BROWSER TEST RESULTS ---');
      console.log(JSON.stringify(results, null, 2));
      const allPassed =
        results.partnerLoginSuccess &&
        results.amberBannerVisible &&
        results.connectionsBadgeVisible &&
        results.connectedBadgeVisible &&
        results.invitedBadgeVisible &&
        results.declinedBadgeVisible;

      if (allPassed) {
        console.log('\n>>> ALL BROWSER CHECKS PASSED (100%) <<<');
        process.exit(0);
      } else {
        console.error('\n>>> SOME BROWSER CHECKS FAILED <<<');
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { runBrowserTest };
