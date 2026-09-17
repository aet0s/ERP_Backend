'use strict';

/**
 * platformAdminAuth.js — Dedicated Login & Session Auth for Platform Super Admin.
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { queryMaster } = require('../db/masterDb');
const { getPlatformAdminToken } = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('FATAL: JWT_SECRET environment variable is not configured');

// Temporarily disabled: login attempt rate limiting for development/testing.
// const loginAttempts = new Map();
// function checkRateLimit(ip) {
//   const now = Date.now();
//   const attempts = loginAttempts.get(ip) || [];
//   const recent = attempts.filter(t => now - t < 15 * 60 * 1000);
//   loginAttempts.set(ip, recent);
//   return recent.length < 5;
// }
// function recordAttempt(ip) {
//   const attempts = loginAttempts.get(ip) || [];
//   attempts.push(Date.now());
//   loginAttempts.set(ip, attempts);
// }

// POST /platform-admin/auth/login — Dedicated Platform Admin Login
router.post('/login', async (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  // Temporarily disabled: rate-limit block.
  // if (!checkRateLimit(clientIp)) {
  //   return res.status(429).json({ error: 'Too many failed login attempts. Account temporarily locked for 15 minutes.' });
  // }

  const { email, password } = req.body;
  if (!email || !password) {
    // Temporarily disabled: recordAttempt(clientIp);
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const adminRes = await queryMaster(
      'SELECT id, name, email, password_hash, status FROM platform_admins WHERE email = ? AND status = ?',
      [email.toLowerCase().trim(), 'active']
    );

    if (adminRes.rowCount === 0) {
      // Temporarily disabled: recordAttempt(clientIp);
      return res.status(401).json({ error: 'Invalid platform admin credentials' });
    }

    const admin = adminRes.rows[0];
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      // Temporarily disabled: recordAttempt(clientIp);
      return res.status(401).json({ error: 'Invalid platform admin credentials' });
    }

    await queryMaster('UPDATE platform_admins SET last_login_at = NOW() WHERE id = ?', [admin.id]);

    const tokenPayload = {
      is_platform_admin: true,
      admin_id: admin.id,
      name: admin.name,
      email: admin.email
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '3650d' });
    const isProd = process.env.NODE_ENV === 'production';

    res.cookie('erp_platform_token', token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: 3650 * 86400000
    });

    // Write tamper-proof audit log
    const { logMasterAudit } = require('../lib/auditCrypto');
    await logMasterAudit(queryMaster, {
      company_id: null,
      user_id: admin.email,
      action: 'superadmin_login',
      metadata: { ip: clientIp, name: admin.name, message: 'Platform superadmin logged in successfully' }
    });

    return res.json({
      ok: true,
      token,
      admin: { id: admin.id, name: admin.name, email: admin.email }
    });
  } catch (err) {
    console.error('platform admin login error', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /platform-admin/auth/me — Current Platform Admin profile
router.get('/me', async (req, res) => {
  const token = getPlatformAdminToken(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
    if (!decoded.is_platform_admin) return res.status(403).json({ error: 'Access denied' });
    return res.json({ ok: true, admin: decoded });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// POST /platform-admin/auth/logout — Sign out platform admin
router.post('/logout', async (req, res) => {
  const token = getPlatformAdminToken(req);
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
      const { logMasterAudit } = require('../lib/auditCrypto');
      await logMasterAudit(queryMaster, {
        company_id: null,
        user_id: decoded.email || 'superadmin',
        action: 'superadmin_logout',
        metadata: { message: 'Platform superadmin logged out' }
      });
    } catch { /* ignore */ }
  }
  res.clearCookie('erp_platform_token');
  return res.json({ ok: true, message: 'Logged out' });
});

module.exports = router;
