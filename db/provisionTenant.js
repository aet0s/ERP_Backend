const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { masterPool, getAdminPool, queryMaster } = require('./masterDb');
const { getTenantPool } = require('./tenantManager');
const { runTenantMigrations } = require('./migrationRunner');
const { ensureDefaultRolePermissions } = require('../lib/defaultPermissions');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

function sanitizeDatabaseName(companyId) {
  const cleanId = String(companyId).replace(/-/g, '');
  const prefix = process.env.TENANT_DB_PREFIX || 'erp_company_';
  return `${prefix}${cleanId}`;
}

function generateCompanyCode(companyName) {
  const prefix = companyName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase() || 'COMP';
  const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}-${suffix}`;
}

async function cleanupFailedRegistration({ companyId, dbName, email }) {
  console.log(`[REGISTRATION ROLLBACK] Rolling back failed registration for company [${companyId || 'unknown'}], db [${dbName || 'none'}], email [${email || 'unknown'}]...`);

  if (dbName) {
    try {
      const { closeTenantPool } = require('./tenantManager');
      await closeTenantPool(dbName).catch(() => {});
    } catch (_) {}

    try {
      const adminPool = getAdminPool();
      await adminPool.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await adminPool.end().catch(() => {});
      console.log(`[REGISTRATION ROLLBACK] Successfully dropped partial tenant DB [${dbName}]`);
    } catch (dropErr) {
      console.error(`[REGISTRATION ROLLBACK] Could not drop partial tenant DB [${dbName}]:`, dropErr.message);
    }
  }

  try {
    if (email) {
      await queryMaster('DELETE FROM company_users WHERE email = ?', [email]).catch(() => {});
    }
    if (companyId) {
      await queryMaster('DELETE FROM company_users WHERE company_id = ?', [companyId]).catch(() => {});
      await queryMaster('DELETE FROM master_refresh_tokens WHERE company_id = ?', [companyId]).catch(() => {});
      await queryMaster('DELETE FROM companies WHERE id = ?', [companyId]).catch(() => {});
    }
    console.log(`[REGISTRATION ROLLBACK] Master database cleaned up completely for retry.`);
  } catch (cleanErr) {
    console.error(`[REGISTRATION ROLLBACK] Error cleaning master DB tables:`, cleanErr.message);
  }
}

async function provisionTenant({ workspace_name, company_name, name, business_type, currency, owner_name, owner_email, email, owner_password, password }) {
  const finalCompanyName = (company_name || workspace_name || name || 'Workspace').trim();
  const finalOwnerName = (owner_name || name || 'Workspace Owner').trim();
  const finalOwnerEmail = (owner_email || email || '').toLowerCase().trim();
  const finalOwnerPassword = owner_password || password;
  const companyId = crypto.randomUUID();
  const dbName = sanitizeDatabaseName(companyId);
  const companyCode = generateCompanyCode(finalCompanyName);
  const normalizedEmail = finalOwnerEmail;

  const masterClient = await masterPool.getConnection();
  let dbCreated = false;

  try {
    // 1. Check existing email mapping in Master DB
    const existingCheck = await masterClient.query('SELECT id FROM company_users WHERE email = ?', [normalizedEmail]);
    if (existingCheck.rows && existingCheck.rows.length > 0) {
      const err = new Error('Email is already registered');
      err.statusCode = 400;
      throw err;
    }

    // Fetch platform settings for default currency and trial days
    let defaultTrialDays = 14;
    let defaultCurrency = 'INR';
    try {
      const settingsRes = await masterClient.query('SELECT default_trial_days, default_currency FROM platform_settings LIMIT 1');
      if (settingsRes.rowCount > 0 && settingsRes.rows[0]) {
        defaultTrialDays = parseInt(settingsRes.rows[0].default_trial_days || '14', 10);
        defaultCurrency = settingsRes.rows[0].default_currency || 'INR';
      }
    } catch (sErr) {
      console.warn('Could not read platform_settings during tenant provisioning, using defaults:', sErr.message);
    }

    const trialEndsAt = new Date(Date.now() + defaultTrialDays * 86400000);
    const finalCurrency = currency || defaultCurrency;

    // 2. Insert company record in master DB (status = 'provisioning')
    await masterClient.query(
      `INSERT INTO companies (id, company_name, company_code, database_name, status, business_type, currency, trial_ends_at, plan, subscription_status, auto_backup_enabled, auto_backup_frequency, auto_backup_retention_days, auto_backup_time)
       VALUES (?, ?, ?, ?, 'provisioning', ?, ?, ?, 'trial', 'trialing', 1, 'daily', 30, '02:00')`,
      [companyId, finalCompanyName, companyCode, dbName, business_type || null, finalCurrency, trialEndsAt]
    );

    // 3. Create actual MySQL database using admin pool
    const adminPool = getAdminPool();
    try {
      const checkDb = await adminPool.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [dbName]);
      if (checkDb.rowCount === 0) {
        await adminPool.query(`CREATE DATABASE \`${dbName}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      }
      dbCreated = true;
    } finally {
      await adminPool.end().catch(() => {});
    }

    // 4. Get tenant pool & apply tenant migrations
    const tenantPool = getTenantPool(dbName);
    await runTenantMigrations(tenantPool);
    await ensureDefaultRolePermissions(tenantPool);

    // 5. Create owner user inside tenant DB
    const tenantClient = await tenantPool.connect();
    let tenantUserId = crypto.randomUUID();
    try {
      await tenantClient.query('START TRANSACTION');
      const passwordHash = await bcrypt.hash(finalOwnerPassword, BCRYPT_ROUNDS);
      await tenantClient.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_primary_owner TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});
      await tenantClient.query(
        `INSERT INTO users (id, name, email, password_hash, role, is_primary_owner)
         VALUES (?, ?, ?, ?, 'owner', 1)`,
        [tenantUserId, finalOwnerName, normalizedEmail, passwordHash]
      );

      // Seed default Primary Main Location
      const defaultLocId = crypto.randomUUID();
      const mainLocName = `${finalCompanyName} (Main Factory / HQ)`;
      await tenantClient.query(
        `INSERT INTO locations (id, name, address, city, state, is_default, status, notes)
         VALUES (?, ?, NULL, NULL, 'Delhi', 1, 'Active', 'Primary main location registered during company setup')`,
        [defaultLocId, mainLocName]
      );

      const auditId = crypto.randomUUID();
      await tenantClient.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata)
         VALUES (?, ?, 'create', 'workspace', ?, ?)`,
        [auditId, tenantUserId, tenantUserId, JSON.stringify({ name: finalCompanyName })]
      );
      await tenantClient.query('COMMIT');
    } catch (err) {
      await tenantClient.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      tenantClient.release();
    }

    // 6. Map identity in Master DB company_users and mark company active
    await masterClient.query('START TRANSACTION');
    const companyUserId = crypto.randomUUID();
    await masterClient.query(
      `INSERT INTO company_users (id, company_id, email, user_id, role, status)
       VALUES (?, ?, ?, ?, 'owner', 'active')`,
      [companyUserId, companyId, normalizedEmail, tenantUserId]
    );

    await masterClient.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS primary_owner_id VARCHAR(36) NULL').catch(() => {});
    await masterClient.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS primary_owner_email VARCHAR(255) NULL').catch(() => {});
    await masterClient.query(
      `UPDATE companies
       SET status = 'active', primary_owner_id = ?, primary_owner_email = ?, onboarding_completed_at = NULL, last_activity_at = NOW()
       WHERE id = ?`,
      [tenantUserId, normalizedEmail, companyId]
    );
    await masterClient.query('COMMIT');

    const companyFetch = await masterClient.query(
      `SELECT id, company_name AS name, company_code, database_name, business_type, currency, plan, status, logo_url, accent_color, onboarding_completed_at
       FROM companies WHERE id = ?`,
      [companyId]
    );
    const company = (companyFetch.rows && companyFetch.rows[0])
      ? { ...companyFetch.rows[0], database_name: companyFetch.rows[0].database_name || dbName }
      : { id: companyId, name: finalCompanyName, database_name: dbName };

    const user = {
      id: tenantUserId,
      workspace_id: companyId,
      email: normalizedEmail,
      name: finalOwnerName,
      role: 'owner'
    };

    return {
      company,
      user,
      dbName
    };
  } catch (err) {
    await masterClient.query('ROLLBACK').catch(() => {});

    // Complete cleanup on failure: drop the partial DB and delete company and user records
    await cleanupFailedRegistration({ companyId, dbName: dbCreated ? dbName : null, email: normalizedEmail }).catch(() => {});

    console.error(`[PROVISIONING ERROR] Provisioning failed for company [${companyId}] (${finalCompanyName}):`, err.message);
    throw err;
  } finally {
    masterClient.release();
  }
}

module.exports = {
  provisionTenant,
  cleanupFailedRegistration,
  sanitizeDatabaseName
};
