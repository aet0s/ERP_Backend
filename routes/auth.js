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

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('FATAL: JWT_SECRET environment variable is not configured');
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

function parseRoles(rawRoles, fallbackRole = 'accounts') {
  if (Array.isArray(rawRoles)) {
    return rawRoles.map((r) => String(r).trim()).filter(Boolean);
  }
  if (!rawRoles) return fallbackRole ? [fallbackRole] : ['staff'];
  if (typeof rawRoles === 'string') {
    const trimmed = rawRoles.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map((r) => String(r).trim()).filter(Boolean);
      } catch {}
    }
    return trimmed.split(',').map((r) => r.trim()).filter(Boolean);
  }
  return fallbackRole ? [fallbackRole] : ['staff'];
}

function issueAccessToken(user, companyId) {
  const userRoles = parseRoles(user.roles, user.role);

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

// Register workspace/company + owner user
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
  }),
  body('company_name').custom((val, { req }) => {
    const name = req.body.company_name || req.body.workspace_name || req.body.name;
    if (!name || !name.trim()) throw new Error('Company/workspace name is required');
    return true;
  })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const firstMsg = errors.array()[0]?.msg || 'Validation failed';
    return res.status(400).json({ error: firstMsg, errors: errors.array() });
  }

  const owner_name = req.body.owner_name || req.body.name || 'Company Owner';
  const owner_email = (req.body.owner_email || req.body.email).toLowerCase().trim();
  const owner_password = req.body.owner_password || req.body.password;
  const company_name = (req.body.company_name || req.body.workspace_name || req.body.name || '').trim();
  const business_type = req.body.business_type || null;
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
      return res.status(403).json({ error: 'Account is deactivated' });
    }

    // Check Password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // Update last_login_at
    await tenantPool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

    delete user.password_hash;
    user.workspace_id = companyId;
    user.company_id = companyId;

    const userRoles = parseRoles(user.roles, user.role || 'accounts');
    user.roles = userRoles;

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

    const userRoles = parseRoles(user.roles, user.role || req.user.role || 'accounts');
    user.roles = userRoles;

    // Fetch live role_permissions aggregated across all assigned roles
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
      workspace: req.company
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
    const userRoles = parseRoles(updatedUser.roles, updatedUser.role || req.user.role || 'accounts');
    updatedUser.roles = userRoles;
    updatedUser.workspace_id = req.user.company_id;
    updatedUser.company_id = req.user.company_id;

    // Fetch live permissions
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
    const userRoles = parseRoles(user.roles, user.role || 'accounts');
    user.roles = userRoles;

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

router.issueAccessToken = issueAccessToken;
router.buildRefreshToken = buildRefreshToken;
router.persistRefreshToken = persistRefreshToken;
router.setAuthCookies = setAuthCookies;
router.parseRoles = parseRoles;

module.exports = router;
