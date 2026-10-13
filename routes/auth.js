'use strict';

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { masterPool, queryMaster } = require('../db/masterDb');
const { getTenantPool } = require('../db/tenantManager');
const { provisionTenant, cleanupFailedRegistration } = require('../db/provisionTenant');
const { requireAuth } = require('../middleware/auth');
const { logTenantAudit, logMasterAudit } = require('../lib/auditCrypto');
const { parseRoles, resolveUserRoles } = require('../lib/roles');
const { ensureDefaultRolePermissions } = require('../lib/defaultPermissions');
const { sendOtpEmail, sendPasswordResetOtpEmail } = require('../lib/mailer');

const registrationOtps = new Map();
const passwordResetOtps = new Map();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('FATAL: JWT_SECRET environment variable is not configured');
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

function issueAccessToken(user, companyId) {
  const userRoles = resolveUserRoles(user.role, user.roles);

  return jwt.sign(
    {
      id: user.id,
      user_id: user.id,
      userId: user.id,
      company_id: companyId,
      workspace_id: companyId,
      email: user.email,
      name: user.name,
      role: user.role || userRoles[0] || 'accounts',
      roles: userRoles.length > 0 ? userRoles : [user.role || 'accounts'],
      vendor_id: user.vendor_id || null,
      customer_id: user.customer_id || null
    },
    JWT_SECRET,
    { expiresIn: '3650d' }
  );
}

function buildRefreshToken() {
  return crypto.randomBytes(40).toString('hex');
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function setAuthCookies(res, token, refreshToken) {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('erp_token', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: 3650 * 86400000
  });
  // also set legacy cookie for full backward compatibility
  res.cookie('erp_access_token', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: 3650 * 86400000
  });
  if (refreshToken) {
    res.cookie('erp_refresh_token', refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/auth/refresh',
      maxAge: 3650 * 86400000
    });
  }
}

async function persistRefreshToken(tenantClient, user, refreshToken) {
  const tokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + 3650 * 86400000);
  const id = crypto.randomUUID();

  await tenantClient.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?)`,
    [id, user.id, tokenHash, expiresAt]
  ).catch(() => {});

  const masterId = crypto.randomUUID();
  await queryMaster(
    `INSERT INTO master_refresh_tokens (id, company_id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [masterId, user.workspace_id || user.company_id, user.id, tokenHash, expiresAt]
  ).catch(() => {});
}

// Temporarily disabled: login attempt rate limiting for development/testing.
// const loginAttempts = new Map();
// function rateLimitLogin(req, res, next) {
//   const key = req.ip + '_' + (req.body.email || '');
//   const now = Date.now();
//   const state = loginAttempts.get(key) || { count: 0, first: now };
//   if (now - state.first > 15 * 60 * 1000) {
//     state.count = 0;
//     state.first = now;
//   }
//   state.count += 1;
//   loginAttempts.set(key, state);
//   if (state.count > 8) return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
//   return next();
// }

// POST /auth/register/send-otp — Step 1: Send 6-digit OTP to corporate email
router.post('/register/send-otp', async (req, res) => {
  try {
    const { owner_name, owner_email } = req.body;
    if (!owner_name || !owner_name.trim()) {
      return res.status(400).json({ error: 'Owner full name is required' });
    }
    if (!owner_email || !/\S+@\S+\.\S+/.test(owner_email)) {
      return res.status(400).json({ error: 'Valid corporate email address is required' });
    }

    const normalizedEmail = owner_email.toLowerCase().trim();

    // Check if email already registered in master database
    const existingCheck = await queryMaster('SELECT id FROM company_users WHERE email = ? LIMIT 1', [normalizedEmail]);
    if (existingCheck.rows && existingCheck.rows.length > 0) {
      return res.status(400).json({ error: 'This corporate email is already registered. Please sign in instead.' });
    }

    // Generate random 6-digit code
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    registrationOtps.set(normalizedEmail, {
      otp,
      owner_name: owner_name.trim(),
      owner_email: normalizedEmail,
      expiresAt,
      verified: false,
      attempts: 0
    });

    await sendOtpEmail({
      to: normalizedEmail,
      name: owner_name.trim(),
      otp
    });

    return res.status(200).json({
      ok: true,
      message: 'Verification code sent to ' + normalizedEmail
    });
  } catch (err) {
    console.error('Error in send-otp:', err);
    return res.status(500).json({ error: err.message || 'Failed to dispatch verification code' });
  }
});

// POST /auth/register/verify-otp — Step 2: Validate 6-digit OTP
router.post('/register/verify-otp', async (req, res) => {
  try {
    const { owner_email, otp } = req.body;
    if (!owner_email || !otp) {
      return res.status(400).json({ error: 'Email and 6-digit verification code are required' });
    }

    const normalizedEmail = owner_email.toLowerCase().trim();
    const record = registrationOtps.get(normalizedEmail);

    if (!record || Date.now() > record.expiresAt) {
      return res.status(400).json({ error: 'Verification code has expired or was not requested. Please request a new code.' });
    }

    if (record.attempts >= 5) {
      return res.status(400).json({ error: 'Too many invalid attempts. Please request a new verification code.' });
    }

    if (String(record.otp).trim() !== String(otp).trim()) {
      record.attempts += 1;
      return res.status(400).json({ error: 'Invalid verification code. Please check your email and try again.' });
    }

    record.verified = true;
    return res.status(200).json({
      ok: true,
      message: 'Corporate email verified successfully.'
    });
  } catch (err) {
    console.error('Error in verify-otp:', err);
    return res.status(500).json({ error: err.message || 'Failed to verify code' });
  }
});

// =============================================================================
// FORGOT CREDENTIALS / PASSWORD RECOVERY FLOW
// =============================================================================

// POST /auth/forgot-password/send-otp — Dispatch 6-digit OTP to user's registered email
router.post('/forgot-password/send-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/\S+@\S+\.\S+/.test(email)) {
      return res.status(400).json({ error: 'Valid email address is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // 1. Check master company_users
    let userFound = false;
    const cuRes = await queryMaster(
      `SELECT cu.company_id, cu.user_id, c.database_name, c.status AS company_status
       FROM company_users cu
       JOIN companies c ON c.id = cu.company_id
       WHERE cu.email = ? AND c.status != 'deleted'
       LIMIT 1`,
      [normalizedEmail]
    );

    if (cuRes.rowCount > 0) {
      userFound = true;
    } else {
      // 2. Check global_portal_users
      const gpuRes = await queryMaster(
        `SELECT id, email FROM global_portal_users WHERE email = ? LIMIT 1`,
        [normalizedEmail]
      ).catch(() => ({ rowCount: 0 }));

      if (gpuRes.rowCount > 0) {
        userFound = true;
      } else {
        // 3. Fallback: Check tenant databases directly
        const allComps = await queryMaster("SELECT id, database_name FROM companies WHERE status NOT IN ('deleted', 'suspended', 'cancelled', 'paused')");
        for (const comp of allComps.rows) {
          const tDb = getTenantPool(comp.database_name);
          const uCheck = await tDb.query('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL', [normalizedEmail]).catch(() => ({ rows: [] }));
          if (uCheck.rows && uCheck.rows.length > 0) {
            userFound = true;
            break;
          }
        }
      }
    }

    if (!userFound) {
      return res.status(404).json({ error: 'No active account found with this email address.' });
    }

    // Generate random 6-digit OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    passwordResetOtps.set(normalizedEmail, {
      otp,
      email: normalizedEmail,
      expiresAt,
      verified: false,
      attempts: 0
    });

    await sendPasswordResetOtpEmail({
      to: normalizedEmail,
      otp
    });

    return res.status(200).json({
      ok: true,
      message: `A 6-digit security code has been sent to ${normalizedEmail}.`
    });
  } catch (err) {
    console.error('Error in /auth/forgot-password/send-otp:', err);
    return res.status(500).json({ error: err.message || 'Failed to dispatch password recovery code' });
  }
});

// POST /auth/forgot-password/verify-otp — Validate 6-digit OTP
router.post('/forgot-password/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and 6-digit verification code are required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const record = passwordResetOtps.get(normalizedEmail);

    if (!record || Date.now() > record.expiresAt) {
      return res.status(400).json({ error: 'Verification code has expired or was not requested. Please request a new code.' });
    }

    if (record.attempts >= 5) {
      return res.status(400).json({ error: 'Too many invalid attempts. Please request a new verification code.' });
    }

    if (String(record.otp).trim() !== String(otp).trim()) {
      record.attempts += 1;
      return res.status(400).json({ error: 'Invalid verification code. Please check your email and try again.' });
    }

    record.verified = true;
    const resetToken = crypto.randomBytes(32).toString('hex');
    record.resetToken = resetToken;

    return res.status(200).json({
      ok: true,
      reset_token: resetToken,
      message: 'Security code verified successfully.'
    });
  } catch (err) {
    console.error('Error in /auth/forgot-password/verify-otp:', err);
    return res.status(500).json({ error: err.message || 'Failed to verify code' });
  }
});

// POST /auth/forgot-password/reset — Set new password
router.post('/forgot-password/reset', async (req, res) => {
  try {
    const { email, reset_token, new_password, confirm_password } = req.body;

    if (!email || !new_password) {
      return res.status(400).json({ error: 'Email and new password are required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const record = passwordResetOtps.get(normalizedEmail);

    if (!record || Date.now() > record.expiresAt || !record.verified) {
      return res.status(400).json({ error: 'Please verify the security code sent to your email before resetting your password.' });
    }

    if (reset_token && record.resetToken && record.resetToken !== reset_token) {
      return res.status(400).json({ error: 'Invalid reset authorization token. Please request a new code.' });
    }

    if (confirm_password && new_password !== confirm_password) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }

    // Password validation rules
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    }
    if (!/[A-Z]/.test(new_password)) {
      return res.status(400).json({ error: 'Password must contain at least one uppercase letter (A-Z).' });
    }
    if (!/[a-z]/.test(new_password)) {
      return res.status(400).json({ error: 'Password must contain at least one lowercase letter (a-z).' });
    }
    if (!/[0-9]/.test(new_password)) {
      return res.status(400).json({ error: 'Password must contain at least one number (0-9).' });
    }
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(new_password)) {
      return res.status(400).json({ error: 'Password must contain at least one special character.' });
    }
    if (/\s/.test(new_password)) {
      return res.status(400).json({ error: 'Password cannot contain spaces.' });
    }

    const newHash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);

    // 1. Update in all tenant databases where user exists
    const allComps = await queryMaster("SELECT id, database_name FROM companies WHERE status != 'deleted'");
    for (const comp of allComps.rows) {
      try {
        const tDb = getTenantPool(comp.database_name);
        await tDb.query('UPDATE users SET password_hash = ? WHERE email = ? AND deleted_at IS NULL', [newHash, normalizedEmail]);
      } catch (err) {
        // continue
      }
    }

    // 2. Update in global_portal_users if exists
    try {
      await queryMaster('UPDATE global_portal_users SET password_hash = ? WHERE email = ?', [newHash, normalizedEmail]);
    } catch (err) {
      // ignore
    }

    // Clean up reset record
    passwordResetOtps.delete(normalizedEmail);

    return res.status(200).json({
      ok: true,
      message: 'Your password has been successfully reset. You can now sign in with your new credentials.'
    });
  } catch (err) {
    console.error('Error in /auth/forgot-password/reset:', err);
    return res.status(500).json({ error: err.message || 'Failed to reset password' });
  }
});

// POST /auth/register — Step 3: Complete registration and provision workspace
router.post('/register', [
  body('owner_email').custom((val, { req }) => {
    const email = req.body.owner_email || req.body.email;
    if (!email || !/\S+@\S+\.\S+/.test(email)) throw new Error('Valid email required');
    return true;
  }),
  body('owner_password').custom((val, { req }) => {
    const pass = req.body.owner_password || req.body.password;
    if (!pass) throw new Error('Password is required');
    if (pass.length < 8) throw new Error('Password must be at least 8 characters long');
    if (!/[A-Z]/.test(pass)) throw new Error('Password must contain at least one uppercase letter (A-Z)');
    if (!/[a-z]/.test(pass)) throw new Error('Password must contain at least one lowercase letter (a-z)');
    if (!/[0-9]/.test(pass)) throw new Error('Password must contain at least one number (0-9)');
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(pass)) {
      throw new Error('Password must contain at least one special character (like @, #, $, or _)');
    }
    if (/\s/.test(pass)) throw new Error('Password cannot contain spaces');
    return true;
  }),
  body('owner_confirm_password').optional().custom((val, { req }) => {
    const pass = req.body.owner_password || req.body.password;
    if (val && val !== pass) {
      throw new Error('Passwords do not match');
    }
    return true;
  })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const firstMsg = errors.array()[0]?.msg || 'Validation failed';
    return res.status(400).json({ error: firstMsg, errors: errors.array() });
  }

  const owner_name = (req.body.owner_name || req.body.name || 'Company Owner').trim();
  const owner_email = (req.body.owner_email || req.body.email).toLowerCase().trim();
  const owner_password = req.body.owner_password || req.body.password;
  const otp = req.body.otp;

  // Verify OTP verification status
  const otpRecord = registrationOtps.get(owner_email);
  if (!otpRecord || !otpRecord.verified || (otp && String(otpRecord.otp).trim() !== String(otp).trim())) {
    return res.status(400).json({ error: 'Please verify your corporate email with the OTP code before configuring your password.' });
  }

  const company_name = (req.body.company_name || req.body.workspace_name || `${owner_name}'s Workspace`).trim();
  const business_type = req.body.business_type || 'Manufacturing & Trading';
  const currency = req.body.currency || 'INR';

  let provisionResult = null;
  try {
    provisionResult = await provisionTenant({
      company_name,
      workspace_name: company_name,
      name: company_name,
      business_type,
      currency,
      owner_name,
      owner_email,
      owner_password
    });

    const { company, user, dbName } = provisionResult;
    const tenantDbName = dbName || company?.database_name;
    const tenantPool = getTenantPool(tenantDbName);
    const tenantClient = tenantPool.connect ? await tenantPool.connect() : await tenantPool.getConnection();

    try {
      const token = issueAccessToken(user, company.id);
      const refresh_token = buildRefreshToken();
      user.workspace_id = company.id;

      await persistRefreshToken(tenantClient, user, refresh_token);
      setAuthCookies(res, token, refresh_token);

      // Clean up used OTP
      registrationOtps.delete(owner_email);

      return res.status(201).json({
        token,
        refresh_token,
        workspace_id: company.id,
        company_id: company.id,
        user,
        workspace: company
      });
    } finally {
      if (tenantClient.release) tenantClient.release();
    }
  } catch (err) {
    if (provisionResult) {
      await cleanupFailedRegistration({
        companyId: provisionResult.company?.id,
        dbName: provisionResult.dbName || provisionResult.company?.database_name,
        email: owner_email
      }).catch(() => {});
    }

    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error('Error during register:', err);
    return res.status(500).json({ error: err.message || 'Failed to create workspace database' });
  }
});


// POST /auth/login — Single Unified Login Endpoint for All 6 Roles
// Temporarily disabled: rateLimitLogin middleware.
router.post('/login', async (req, res) => {
  const { email, password, company_id } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const normalizedEmail = email.toLowerCase().trim();

  try {
    let companyId = company_id;
    let databaseName = null;

    // Step 1: Resolve Company & DB
    if (companyId) {
      const compRes = await queryMaster('SELECT id, database_name, status, plan, subscription_status, current_period_end, trial_ends_at FROM companies WHERE id = ?', [companyId]);
      if (compRes.rowCount === 0) return res.status(401).json({ error: 'Company workspace not found' });
      const comp = compRes.rows[0];
      if (comp.status === 'paused') {
        return res.status(403).json({ error: 'Workspace subscription is currently paused by platform administrator.' });
      }
      if (comp.status === 'suspended') {
        return res.status(403).json({ error: 'Workspace is suspended by platform administrator.' });
      }
      if (comp.status === 'cancelled') {
        return res.status(403).json({ error: 'Workspace subscription has been cancelled.' });
      }
      if (comp.status === 'deleted') {
        return res.status(403).json({ error: 'Workspace has been deleted.' });
      }
      databaseName = comp.database_name;
    } else {
      // Look up master company_users
      const masterRes = await queryMaster(
        `SELECT cu.company_id, c.database_name, c.status AS company_status
         FROM company_users cu
         JOIN companies c ON c.id = cu.company_id
         WHERE cu.email = ? AND c.status != 'deleted'
         LIMIT 1`,
        [normalizedEmail]
      );

      if (masterRes.rowCount > 0) {
        const comp = masterRes.rows[0];
        if (comp.company_status === 'paused') {
          return res.status(403).json({ error: 'Workspace subscription is currently paused by platform administrator.' });
        }
        if (comp.company_status === 'suspended') {
          return res.status(403).json({ error: 'Workspace is suspended by platform administrator.' });
        }
        if (comp.company_status === 'cancelled') {
          return res.status(403).json({ error: 'Workspace subscription has been cancelled.' });
        }
        companyId = comp.company_id;
        databaseName = comp.database_name;
      } else {
        // Fallback: search all active tenant DBs if master map missing
        const allComps = await queryMaster("SELECT id, database_name, status FROM companies WHERE status NOT IN ('deleted', 'suspended', 'cancelled', 'paused')");
        for (const comp of allComps.rows) {
          const tDb = getTenantPool(comp.database_name);
          const uCheck = await tDb.query('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL', [normalizedEmail]);
          if (uCheck.rows.length > 0) {
            companyId = comp.id;
            databaseName = comp.database_name;
            break;
          }
        }
      }
    }

    if (!companyId || !databaseName) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Step 2: Query tenant DB users table
    const tenantPool = getTenantPool(databaseName);
    await tenantPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS roles TEXT NULL').catch(() => {});
    await tenantPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50) NULL').catch(() => {});
    await tenantPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url LONGTEXT NULL').catch(() => {});
    await tenantPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT NULL').catch(() => {});
    const userRes = await tenantPool.query(
      `SELECT id, name, email, phone, avatar_url, bio, password_hash, role, roles, status, created_at, last_login_at
       FROM users WHERE email = ? AND deleted_at IS NULL`,
      [normalizedEmail]
    );

    if (userRes.rowCount === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user = userRes.rows[0];

    if (user.status === 'inactive' || user.status === 'suspended') {
      return res.status(403).json({ error: 'Ask owner to activate your account.' });
    }

    // Check Password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // Update last_login_at
    await tenantPool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

    delete user.password_hash;
    user.workspace_id = companyId;
    user.company_id = companyId;

    const userRoles = resolveUserRoles(user.role, user.roles);
    user.roles = userRoles;
    user.role = userRoles[0] || user.role || 'accounts';

    const token = issueAccessToken(user, companyId);
    const refreshToken = buildRefreshToken();

    await persistRefreshToken(tenantPool, user, refreshToken);
    setAuthCookies(res, token, refreshToken);

    // Temporarily disabled: login attempt reset cleanup.
    // loginAttempts.delete(req.ip + '_' + normalizedEmail);

    // Tamper-proof login audit logging
    const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    await logTenantAudit(tenantPool, {
      user_id: user.id,
      action: 'login',
      entity_type: 'user',
      entity_id: user.id,
      metadata: {
        email: normalizedEmail,
        name: user.name,
        role: user.role,
        roles: user.roles,
        ip: clientIp,
        user_agent: userAgent
      }
    }).catch((err) => console.warn('Tenant login audit write error:', err.message));

    await logMasterAudit(queryMaster, {
      company_id: companyId,
      user_id: user.id,
      action: 'login',
      metadata: {
        email: normalizedEmail,
        name: user.name,
        role: user.role,
        ip: clientIp
      }
    }).catch((err) => console.warn('Master login audit write error:', err.message));

    // Fetch live role_permissions aggregated across all assigned roles
    await ensureDefaultRolePermissions(tenantPool);
    const placeholders = userRoles.map(() => '?').join(',');
    const permRes = await tenantPool.query(
      `SELECT module, MAX(can_view) AS can_view, MAX(can_create) AS can_create, MAX(can_edit) AS can_edit, MAX(can_delete) AS can_delete, MAX(can_approve) AS can_approve, MAX(can_export) AS can_export
       FROM role_permissions WHERE role IN (${placeholders}) GROUP BY module`,
      userRoles
    );
    user.permissions = permRes.rows;

    return res.json({
      ok: true,
      token,
      refresh_token: refreshToken,
      workspace_id: companyId,
      company_id: companyId,
      permissions: permRes.rows,
      user
    });
  } catch (err) {
    console.error('Unified login error:', err);
    return res.status(500).json({ error: 'Internal server error during login' });
  }
});

// GET /auth/me — Current User Profile & Live Module Permissions
router.get('/me', requireAuth, async (req, res) => {
  try {
    await req.tenantDb.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS roles TEXT NULL').catch(() => {});
    await req.tenantDb.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50) NULL').catch(() => {});
    await req.tenantDb.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url LONGTEXT NULL').catch(() => {});
    await req.tenantDb.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT NULL').catch(() => {});
    const userRes = await req.tenantDb.query(
      `SELECT id, name, email, phone, avatar_url, bio, role, roles, status, created_at, last_login_at
       FROM users WHERE id = ? AND deleted_at IS NULL`,
      [req.user.id]
    );

    if (userRes.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    const user = userRes.rows[0];
    user.workspace_id = req.user.company_id;
    user.company_id = req.user.company_id;

    const userRoles = resolveUserRoles(user.role, user.roles);
    user.roles = userRoles;
    user.role = userRoles[0] || user.role || 'accounts';

    // Fetch live role_permissions aggregated across all assigned roles
    await ensureDefaultRolePermissions(req.tenantDb);
    const placeholders = userRoles.map(() => '?').join(',');
    const permRes = await req.tenantDb.query(
      `SELECT module, MAX(can_view) AS can_view, MAX(can_create) AS can_create, MAX(can_edit) AS can_edit, MAX(can_delete) AS can_delete, MAX(can_approve) AS can_approve, MAX(can_export) AS can_export
       FROM role_permissions WHERE role IN (${placeholders}) GROUP BY module`,
      userRoles
    );

    user.permissions = permRes.rows;

    return res.json({
      user,
      permissions: permRes.rows,
      workspace: { ...req.company, name: req.company.company_name || req.company.name }
    });
  } catch (err) {
    console.error('GET /auth/me error:', err);
    return res.status(500).json({ error: 'Failed to fetch user session' });
  }
});

// PUT /auth/profile — Update logged in user's profile (name, phone, avatar, bio, password)
router.put('/profile', requireAuth, async (req, res) => {
  const { name, phone, avatar_url, bio, current_password, new_password } = req.body;
  const userId = req.user.id;

  try {
    await req.tenantDb.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50) NULL').catch(() => {});
    await req.tenantDb.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url LONGTEXT NULL').catch(() => {});
    await req.tenantDb.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT NULL').catch(() => {});

    // If changing password, verify current password
    if (new_password) {
      if (!current_password) {
        return res.status(400).json({ error: 'Current password is required to set a new password.' });
      }
      if (new_password.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters.' });
      }
      const passRes = await req.tenantDb.query('SELECT password_hash FROM users WHERE id = ?', [userId]);
      if (passRes.rowCount === 0) return res.status(404).json({ error: 'User not found' });
      const valid = await bcrypt.compare(current_password, passRes.rows[0].password_hash);
      if (!valid) return res.status(400).json({ error: 'Incorrect current password.' });

      const newHash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
      await req.tenantDb.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, userId]);
    }

    const updates = [];
    const params = [];

    if (name !== undefined && String(name).trim()) {
      updates.push('name = ?');
      params.push(String(name).trim());
    }
    if (phone !== undefined) {
      updates.push('phone = ?');
      params.push(String(phone).trim());
    }
    if (avatar_url !== undefined) {
      updates.push('avatar_url = ?');
      params.push(avatar_url);
    }
    if (bio !== undefined) {
      updates.push('bio = ?');
      params.push(String(bio).trim());
    }

    if (updates.length > 0) {
      params.push(userId);
      await req.tenantDb.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    // Update master company_users if phone or name changed
    if (name || phone) {
      await queryMaster('ALTER TABLE company_users ADD COLUMN IF NOT EXISTS phone VARCHAR(50) NULL').catch(() => {});
      if (phone) {
        await queryMaster('UPDATE company_users SET phone = ? WHERE user_id = ? AND company_id = ?', [String(phone).trim(), userId, req.user.company_id]).catch(() => {});
      }
    }

    const updatedUserRes = await req.tenantDb.query(
      `SELECT id, name, email, phone, avatar_url, bio, role, roles, status, created_at, last_login_at
       FROM users WHERE id = ?`,
      [userId]
    );
    const updatedUser = updatedUserRes.rows[0];
    const userRoles = resolveUserRoles(updatedUser.role, updatedUser.roles);
    updatedUser.roles = userRoles;
    updatedUser.role = userRoles[0] || updatedUser.role || 'accounts';
    updatedUser.workspace_id = req.user.company_id;
    updatedUser.company_id = req.user.company_id;

    // Fetch live permissions
    await ensureDefaultRolePermissions(req.tenantDb);
    const placeholders = userRoles.map(() => '?').join(',');
    const permRes = await req.tenantDb.query(
      `SELECT module, MAX(can_view) AS can_view, MAX(can_create) AS can_create, MAX(can_edit) AS can_edit, MAX(can_delete) AS can_delete, MAX(can_approve) AS can_approve, MAX(can_export) AS can_export
       FROM role_permissions WHERE role IN (${placeholders}) GROUP BY module`,
      userRoles
    );
    updatedUser.permissions = permRes.rows;

    return res.json({ ok: true, user: updatedUser, message: 'Profile updated successfully' });
  } catch (err) {
    console.error('Update profile error:', err);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
});

// POST /auth/refresh — Cookie Refresh Token Rotation
router.post('/refresh', async (req, res) => {
  const cookie = req.headers.cookie || '';
  const match = cookie.split(';').map(p => p.trim()).find(p => p.startsWith('erp_refresh_token='));
  const rawToken = match ? decodeURIComponent(match.slice('erp_refresh_token='.length)) : (req.body ? req.body.refresh_token : null);

  if (!rawToken) return res.status(401).json({ error: 'Missing refresh token' });
  const tokenHash = hashToken(rawToken);

  try {
    const masterRes = await queryMaster(
      `SELECT mrt.*, c.database_name, c.status AS company_status
       FROM master_refresh_tokens mrt
       JOIN companies c ON c.id = mrt.company_id
       WHERE mrt.token_hash = ? AND mrt.expires_at > NOW()`,
      [tokenHash]
    );

    if (masterRes.rowCount === 0) return res.status(401).json({ error: 'Invalid or expired refresh token' });
    const record = masterRes.rows[0];

    if (['paused', 'suspended', 'cancelled', 'deleted'].includes(record.company_status)) {
      await queryMaster('DELETE FROM master_refresh_tokens WHERE id = ?', [record.id]).catch(() => {});
      return res.status(403).json({
        error: `Workspace subscription is ${record.company_status}. Access blocked.`,
        status: record.company_status,
        locked: true
      });
    }

    const tenantPool = getTenantPool(record.database_name);
    const userRes = await tenantPool.query(
      `SELECT id, name, email, role, roles, status FROM users WHERE id = ? AND deleted_at IS NULL`,
      [record.user_id]
    );

    if (userRes.rowCount === 0) return res.status(401).json({ error: 'User not found' });
    const user = userRes.rows[0];
    const userRoles = resolveUserRoles(user.role, user.roles);
    user.roles = userRoles;
    user.role = userRoles[0] || user.role || 'accounts';

    // Revoke used token
    await queryMaster('DELETE FROM master_refresh_tokens WHERE id = ?', [record.id]);

    // Issue rotated tokens
    const newAccessToken = issueAccessToken(user, record.company_id);
    const newRefreshToken = buildRefreshToken();

    await persistRefreshToken(tenantPool, user, newRefreshToken);
    setAuthCookies(res, newAccessToken, newRefreshToken);

    return res.json({
      token: newAccessToken,
      refresh_token: newRefreshToken,
      company_id: record.company_id
    });
  } catch (err) {
    console.error('Refresh token error:', err);
    return res.status(500).json({ error: 'Failed to refresh token' });
  }
});

// POST /auth/logout
router.post('/logout', async (req, res) => {
  const cookie = req.headers.cookie || '';
  const match = cookie.split(';').map(p => p.trim()).find(p => p.startsWith('erp_refresh_token='));
  const rawToken = match ? decodeURIComponent(match.slice('erp_refresh_token='.length)) : null;

  if (rawToken) {
    const tokenHash = crypto.createHash('sha256').update(String(rawToken)).digest('hex');
    await queryMaster('DELETE FROM master_refresh_tokens WHERE token_hash = ?', [tokenHash]).catch(() => {});
  }

  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie('erp_token', { httpOnly: true, secure: isProd, sameSite: 'lax' });
  res.clearCookie('erp_access_token', { httpOnly: true, secure: isProd, sameSite: 'lax' });
  res.clearCookie('erp_refresh_token', { httpOnly: true, secure: isProd, sameSite: 'lax', path: '/auth/refresh' });

  return res.json({ ok: true, message: 'Logged out successfully' });
});

// GET /auth/verify-invite & /auth/invite-info
router.get(['/verify-invite', '/invite-info'], async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ ok: false, error: 'Token is required' });

  try {
    // 1. Check company_invites (workspace staff members)
    const empRes = await queryMaster(
      `SELECT ci.*, c.company_name, c.company_code
       FROM company_invites ci
       JOIN companies c ON c.id = ci.company_id
       WHERE ci.token = ?`,
      [token]
    );

    if (empRes.rowCount > 0) {
      const emp = empRes.rows[0];
      if (emp.expires_at && new Date(emp.expires_at) <= new Date()) {
        return res.status(400).json({ ok: false, error: 'This invitation link has expired. Please ask the company admin to re-invite you.' });
      }
      if (emp.accepted_at) {
        return res.status(400).json({ ok: false, error: 'This invitation has already been accepted. Please sign in.' });
      }

      return res.json({
        ok: true,
        type: 'workspace',
        portal_type: 'workspace_member',
        company_id: emp.company_id,
        company_name: emp.company_name,
        company_code: emp.company_code,
        email: emp.email,
        role: emp.role,
        name: '',
        has_password: false
      });
    }

    // 2. Check global_portal_memberships (vendor / customer partners)
    const memRes = await queryMaster(
      `SELECT gpm.*, c.company_name, c.company_code, c.currency, gu.email, gu.name AS user_name, gu.password_hash
       FROM global_portal_memberships gpm
       JOIN companies c ON c.id = gpm.company_id
       JOIN global_portal_users gu ON gu.id = gpm.global_user_id
       WHERE gpm.invite_token = ?`,
      [token]
    );

    if (memRes.rowCount > 0) {
      const mem = memRes.rows[0];
      if (mem.invite_expires_at && new Date(mem.invite_expires_at) <= new Date()) {
        return res.status(400).json({ ok: false, error: 'This invitation link has expired. Please ask the company to re-invite you.' });
      }

      return res.json({
        ok: true,
        type: mem.portal_type,
        portal_type: mem.portal_type,
        company_id: mem.company_id,
        company_name: mem.company_name,
        company_code: mem.company_code,
        email: mem.email,
        name: mem.user_name,
        has_password: !!mem.password_hash
      });
    }

    return res.status(404).json({ ok: false, error: 'Invalid or expired invitation link' });
  } catch (err) {
    console.error('auth verify invite error', err);
    return res.status(500).json({ ok: false, error: 'Failed to verify invitation' });
  }
});

function validateStrongPassword(password) {
  if (!password || typeof password !== 'string') return 'Password is required';
  if (password.length < 8) return 'Password must be at least 8 characters long';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter (A-Z)';
  if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter (a-z)';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number (0-9)';
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(password)) return 'Password must contain at least one special character (like @, #, $, _)';
  if (/\s/.test(password)) return 'Password cannot contain spaces';
  return null;
}

// POST /auth/accept-invite
router.post('/accept-invite', async (req, res) => {
  const { token, name, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: 'Token and password are required' });
  }
  const passError = validateStrongPassword(password);
  if (passError) {
    return res.status(400).json({ error: passError });
  }

  // 1. Check if token is for workspace member
  const inviteRes = await queryMaster(
    `SELECT ci.id, ci.company_id, ci.email, ci.role, ci.location_id, ci.accepted_at, ci.expires_at, c.database_name, c.company_name, c.company_code, c.currency, c.status AS company_status
     FROM company_invites ci
     JOIN companies c ON c.id = ci.company_id
     WHERE ci.token = ?`,
    [token]
  );

  if (inviteRes.rowCount > 0) {
    const inviteRecord = inviteRes.rows[0];
    if (inviteRecord.accepted_at || new Date(inviteRecord.expires_at) <= new Date() || inviteRecord.company_status !== 'active') {
      return res.status(400).json({ error: 'Invalid or expired invitation token' });
    }

    const normalizedEmail = inviteRecord.email.toLowerCase().trim();
    const displayName = (name && name.trim()) ? name.trim() : normalizedEmail.split('@')[0];

    const existingMaster = await queryMaster('SELECT id, status FROM company_users WHERE email = ? AND company_id = ?', [normalizedEmail, inviteRecord.company_id]);
    if (existingMaster.rowCount > 0 && existingMaster.rows[0].status !== 'deleted') {
      return res.status(400).json({ error: 'An active user with this email is already registered in this workspace' });
    }

    const targetTenantPool = getTenantPool(inviteRecord.database_name);
    const tenantClient = await targetTenantPool.connect();

    try {
      await tenantClient.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS roles TEXT NULL').catch(() => {});
      await tenantClient.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS location_id VARCHAR(36) NULL').catch(() => {});
      await tenantClient.query('START TRANSACTION');
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const newUserId = crypto.randomUUID();

      const existingTenantUser = await tenantClient.query('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
      let resolvedUserId = newUserId;
      if (existingTenantUser.rowCount > 0) {
        resolvedUserId = existingTenantUser.rows[0].id;
        await tenantClient.query(
          `UPDATE users SET name = ?, password_hash = ?, role = ?, roles = ?, location_id = COALESCE(?, location_id), status = 'active', deleted_at = NULL, last_login_at = NOW() WHERE email = ?`,
          [displayName, hash, inviteRecord.role, inviteRecord.role, inviteRecord.location_id || null, normalizedEmail]
        );
      } else {
        await tenantClient.query(
          `INSERT INTO users (id, name, email, password_hash, role, roles, location_id, status, created_at, last_login_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NOW(), NOW())`,
          [newUserId, displayName, normalizedEmail, hash, inviteRecord.role, inviteRecord.role, inviteRecord.location_id || null]
        );
      }

      await queryMaster(
        `INSERT INTO company_users (id, company_id, email, role, status, created_at)
         VALUES (?, ?, ?, ?, 'active', NOW())
         ON DUPLICATE KEY UPDATE role = VALUES(role), status = 'active'`,
        [resolvedUserId, inviteRecord.company_id, normalizedEmail, inviteRecord.role]
      );

      await queryMaster('UPDATE company_invites SET accepted_at = NOW() WHERE id = ?', [inviteRecord.id]);
      await tenantClient.query('COMMIT');

      const userPayload = {
        id: resolvedUserId,
        name: displayName,
        email: normalizedEmail,
        role: inviteRecord.role,
        roles: [inviteRecord.role],
        location_id: inviteRecord.location_id || null,
        company_id: inviteRecord.company_id,
        database_name: inviteRecord.database_name
      };
      const userToken = issueAccessToken(userPayload, inviteRecord.company_id);
      const newRefreshToken = buildRefreshToken();
      await persistRefreshToken(targetTenantPool, userPayload, newRefreshToken).catch(() => {});
      setAuthCookies(res, userToken, newRefreshToken);

      return res.json({
        ok: true,
        token: userToken,
        user: userPayload,
        workspace: {
          id: inviteRecord.company_id,
          name: inviteRecord.company_name,
          code: inviteRecord.company_code,
          currency: inviteRecord.currency || 'INR'
        },
        message: 'Account created successfully! Welcome to the workspace.'
      });
    } catch (err) {
      await tenantClient.query('ROLLBACK').catch(() => {});
      console.error('Accept invite error:', err);
      return res.status(500).json({ error: 'Failed to accept invitation: ' + err.message });
    } finally {
      tenantClient.release();
    }
  }

  // 2. Check if token is for partner portal
  const portalAuthRoute = require('./portalAuth');
  if (portalAuthRoute.handlePortalAcceptInvite) {
    return portalAuthRoute.handlePortalAcceptInvite(req, res);
  }

  return res.status(400).json({ error: 'Invalid or expired invitation token' });
});

router.issueAccessToken = issueAccessToken;
router.buildRefreshToken = buildRefreshToken;
router.persistRefreshToken = persistRefreshToken;
router.setAuthCookies = setAuthCookies;
router.parseRoles = parseRoles;
router.resolveUserRoles = resolveUserRoles;

module.exports = router;
