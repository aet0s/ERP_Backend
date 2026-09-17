'use strict';

/**
 * portalAuth.js — Authentication, Onboarding, Multi-Company Switching & Password Reset
 * for Vendor & Customer Portals with Global Multi-Workspace Identities.
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const { queryMaster } = require('../db/masterDb');
const { getTenantPool } = require('../db/tenantManager');
const { createNotification } = require('../lib/notifications');
const { calculateInvoiceLine, calculateInvoiceTotals, getNextDocumentNumber } = require('../lib/invoiceEngine');
const { publishReturnRequestMessage } = require('../lib/returnRequestSocket');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('FATAL: JWT_SECRET environment variable is not configured');

// Helper: auto-insert system event messages into return_request_messages
async function insertSystemMessage(tenantDb, returnRequestId, message) {
  try {
    const id = crypto.randomUUID();
    await tenantDb.query(
      `INSERT INTO return_request_messages
         (id, return_request_id, sender_type, sender_id, sender_name, message, is_system)
       VALUES (?, ?, 'system', 'system', 'System', ?, 1)`,
      [id, returnRequestId, message]
    );
    const fetched = await tenantDb.query('SELECT * FROM return_request_messages WHERE id = ?', [id]);
    publishReturnRequestMessage(tenantDb, returnRequestId, fetched.rows[0]);
  } catch (err) {
    console.warn('insertSystemMessage (portalAuth) failed (non-fatal):', err.message);
  }
}
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

function signPortalToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '3650d' });
}

function setPortalCookie(res, cookieName, token) {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie(cookieName, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: 3650 * 86400000
  });
}

function extractCookieToken(req, cookieName) {
  const cookie = req.headers.cookie || '';
  const match = cookie.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${cookieName}=`));
  return match ? decodeURIComponent(match.slice(cookieName.length + 1)) : null;
}

async function resolveTenantFromCompanyId(companyId) {
  const compRes = await queryMaster(
    'SELECT id, company_name, company_code, database_name, status, subscription_status, currency, number_system, logo_url FROM companies WHERE id = ?',
    [companyId]
  );
  if (compRes.rowCount === 0) return null;
  const company = compRes.rows[0];
  if (['suspended', 'cancelled', 'paused', 'deleted'].includes(company.status)) return null;
  return { company, tenantDb: getTenantPool(company.database_name) };
}

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL IDENTITY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function getGlobalPortalUserByEmail(email) {
  const res = await queryMaster(
    'SELECT * FROM global_portal_users WHERE email = ?',
    [email.toLowerCase().trim()]
  );
  return res.rowCount > 0 ? res.rows[0] : null;
}

async function createOrUpdateGlobalPortalUser({
  email, name, phone, passwordHash,
  company_name, gstin, pan, address, city, state, pincode, business_type
}) {
  const normalizedEmail = email.toLowerCase().trim();
  let user = await getGlobalPortalUserByEmail(normalizedEmail);

  if (user) {
    await queryMaster(
      `UPDATE global_portal_users 
       SET password_hash = COALESCE(?, password_hash),
           name = CASE WHEN (name IS NULL OR name = '' OR name = 'Portal User') AND ? IS NOT NULL THEN ? ELSE name END,
           phone = CASE WHEN (phone IS NULL OR phone = '') AND ? IS NOT NULL THEN ? ELSE phone END,
           company_name = CASE WHEN (company_name IS NULL OR company_name = '') AND ? IS NOT NULL THEN ? ELSE company_name END,
           gstin = CASE WHEN (gstin IS NULL OR gstin = '') AND ? IS NOT NULL THEN ? ELSE gstin END,
           pan = CASE WHEN (pan IS NULL OR pan = '') AND ? IS NOT NULL THEN ? ELSE pan END,
           address = CASE WHEN (address IS NULL OR address = '') AND ? IS NOT NULL THEN ? ELSE address END,
           city = CASE WHEN (city IS NULL OR city = '') AND ? IS NOT NULL THEN ? ELSE city END,
           state = CASE WHEN (state IS NULL OR state = '') AND ? IS NOT NULL THEN ? ELSE state END,
           pincode = CASE WHEN (pincode IS NULL OR pincode = '') AND ? IS NOT NULL THEN ? ELSE pincode END,
           business_type = CASE WHEN (business_type IS NULL OR business_type = '') AND ? IS NOT NULL THEN ? ELSE business_type END
       WHERE id = ?`,
      [
        passwordHash || null,
        name || null, name || null,
        phone || null, phone || null,
        company_name || null, company_name || null,
        gstin || null, gstin || null,
        pan || null, pan || null,
        address || null, address || null,
        city || null, city || null,
        state || null, state || null,
        pincode || null, pincode || null,
        business_type || null, business_type || null,
        user.id
      ]
    );
    return await getGlobalPortalUserByEmail(normalizedEmail);
  }

  const id = crypto.randomUUID();
  await queryMaster(
    `INSERT INTO global_portal_users (
      id, email, password_hash, name, phone,
      company_name, gstin, pan, address, city, state, pincode, business_type, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active')`,
    [
      id, normalizedEmail, passwordHash || null,
      (name || 'Portal User').trim(), phone || null,
      company_name || null, gstin || null, pan || null, address || null,
      city || null, state || null, pincode || null, business_type || null
    ]
  );
  return await getGlobalPortalUserByEmail(normalizedEmail);
}

async function enrichPortalUserFromEntity(globalUser, preferredCompanyId = null) {
  if (!globalUser) return globalUser;

  try {
    let sql = `
      SELECT gpm.*, c.database_name
      FROM global_portal_memberships gpm
      JOIN companies c ON c.id = gpm.company_id
      WHERE gpm.global_user_id = ?
        AND c.status NOT IN ('suspended', 'cancelled', 'paused', 'deleted')
    `;
    const params = [globalUser.id];
    if (preferredCompanyId) {
      sql += ' AND gpm.company_id = ?';
      params.push(preferredCompanyId);
    }
    sql += ' ORDER BY CASE WHEN gpm.status = "Active" THEN 1 ELSE 2 END, gpm.created_at DESC LIMIT 1';

    let mRes = await queryMaster(sql, params);
    if (mRes.rowCount === 0 && preferredCompanyId) {
      mRes = await queryMaster(
        `SELECT gpm.*, c.database_name
         FROM global_portal_memberships gpm
         JOIN companies c ON c.id = gpm.company_id
         WHERE gpm.global_user_id = ?
           AND c.status NOT IN ('suspended', 'cancelled', 'paused', 'deleted')
         ORDER BY CASE WHEN gpm.status = "Active" THEN 1 ELSE 2 END, gpm.created_at DESC LIMIT 1`,
        [globalUser.id]
      );
    }

    if (mRes.rowCount === 0) return globalUser;
    const m = mRes.rows[0];
    if (!m.entity_id || !m.database_name) return globalUser;

    const tenantDb = getTenantPool(m.database_name);
    let entity = null;
    const fallbackBusinessType = m.portal_type === 'vendor' ? 'Vendor / Supplier' : 'Customer / Buyer';

    if (m.portal_type === 'vendor') {
      const vRes = await tenantDb.query(
        'SELECT * FROM vendors WHERE id = ? AND deleted_at IS NULL',
        [m.entity_id]
      ).catch(() => ({ rowCount: 0, rows: [] }));
      if (vRes.rowCount > 0) {
        const v = vRes.rows[0];
        entity = {
          company_name: v.name || null,
          name: v.contact_person_name || v.contact || v.name || null,
          phone: v.phone || v.contact || null,
          gstin: v.gstin || null,
          pan: v.pan || (v.gstin && v.gstin.length === 15 ? v.gstin.slice(2, 12) : null),
          address: v.address_line1 || v.address || null,
          city: v.city || null,
          state: v.state || null,
          pincode: v.pincode || null,
          business_type: fallbackBusinessType
        };
      }
    } else if (m.portal_type === 'customer') {
      const cRes = await tenantDb.query(
        'SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL',
        [m.entity_id]
      ).catch(() => ({ rowCount: 0, rows: [] }));
      if (cRes.rowCount > 0) {
        const c = cRes.rows[0];
        entity = {
          company_name: c.name || null,
          name: c.contact_person_name || c.contact || c.name || null,
          phone: c.phone || c.contact || null,
          gstin: c.gstin || null,
          pan: c.pan || (c.gstin && c.gstin.length === 15 ? c.gstin.slice(2, 12) : null),
          address: c.billing_address || c.shipping_address || c.address || null,
          city: c.city || null,
          state: c.state || null,
          pincode: c.pincode || null,
          business_type: fallbackBusinessType
        };
      }
    }

    if (!entity) return globalUser;

    const enriched = {
      ...globalUser,
      company_name: globalUser.company_name || entity.company_name || '',
      name: (globalUser.name && globalUser.name !== 'Portal User') ? globalUser.name : (entity.name || globalUser.name || ''),
      phone: globalUser.phone || entity.phone || '',
      gstin: globalUser.gstin || entity.gstin || '',
      pan: globalUser.pan || entity.pan || '',
      address: globalUser.address || entity.address || '',
      city: globalUser.city || entity.city || '',
      state: globalUser.state || entity.state || '',
      pincode: globalUser.pincode || entity.pincode || '',
      business_type: globalUser.business_type || entity.business_type || fallbackBusinessType
    };

    // Auto-update master table if any empty field was enriched
    if (
      (!globalUser.company_name && entity.company_name) ||
      ((!globalUser.name || globalUser.name === 'Portal User') && entity.name) ||
      (!globalUser.phone && entity.phone) ||
      (!globalUser.gstin && entity.gstin) ||
      (!globalUser.pan && entity.pan) ||
      (!globalUser.address && entity.address) ||
      (!globalUser.city && entity.city) ||
      (!globalUser.state && entity.state) ||
      (!globalUser.pincode && entity.pincode) ||
      (!globalUser.business_type && entity.business_type)
    ) {
      await queryMaster(
        `UPDATE global_portal_users
         SET company_name = COALESCE(NULLIF(company_name, ''), ?),
             name = CASE WHEN name IS NULL OR name = '' OR name = 'Portal User' THEN ? ELSE name END,
             phone = COALESCE(NULLIF(phone, ''), ?),
             gstin = COALESCE(NULLIF(gstin, ''), ?),
             pan = COALESCE(NULLIF(pan, ''), ?),
             address = COALESCE(NULLIF(address, ''), ?),
             city = COALESCE(NULLIF(city, ''), ?),
             state = COALESCE(NULLIF(state, ''), ?),
             pincode = COALESCE(NULLIF(pincode, ''), ?),
             business_type = COALESCE(NULLIF(business_type, ''), ?)
         WHERE id = ?`,
        [
          entity.company_name || null,
          entity.name || null,
          entity.phone || null,
          entity.gstin || null,
          entity.pan || null,
          entity.address || null,
          entity.city || null,
          entity.state || null,
          entity.pincode || null,
          entity.business_type || null,
          globalUser.id
        ]
      ).catch(() => {});
    }

    return enriched;
  } catch (err) {
    console.error('enrichPortalUserFromEntity error:', err);
    return globalUser;
  }
}

async function getGlobalUserMemberships(globalUserId, portalType) {
  const query = `
    SELECT 
      gpm.id AS membership_id,
      gpm.company_id,
      gpm.entity_id,
      gpm.portal_type,
      gpm.status AS membership_status,
      c.company_name,
      c.company_code,
      c.database_name,
      c.currency,
      c.number_system,
      c.logo_url,
      c.status AS company_status
    FROM global_portal_memberships gpm
    JOIN companies c ON c.id = gpm.company_id
    WHERE gpm.global_user_id = ? 
      AND gpm.portal_type = ? 
      AND gpm.status = 'Active'
      AND c.status NOT IN ('suspended', 'cancelled', 'paused', 'deleted')
    ORDER BY gpm.created_at ASC
  `;
  const res = await queryMaster(query, [globalUserId, portalType]);
  return res.rows;
}

// Ensure the tenant DB has a matching local record for backward compatibility & local relations
async function syncTenantPortalUser(tenantDb, portalType, globalUser, entityId, targetCompanyId) {
  const tableName = portalType === 'vendor' ? 'vendor_portal_users' : 'customer_portal_users';
  const entityColumn = portalType === 'vendor' ? 'vendor_id' : 'customer_id';

  const existingRes = await tenantDb.query(
    `SELECT * FROM ${tableName} WHERE email = ? AND ${entityColumn} = ?`,
    [globalUser.email, entityId]
  );

  let localUserId;
  if (existingRes.rowCount > 0) {
    localUserId = existingRes.rows[0].id;
    if (globalUser.password_hash && existingRes.rows[0].password_hash !== globalUser.password_hash) {
      await tenantDb.query(
        `UPDATE ${tableName} SET password_hash = ?, name = ?, status = 'Active' WHERE id = ?`,
        [globalUser.password_hash, globalUser.name, localUserId]
      );
    }
  } else {
    localUserId = crypto.randomUUID();
    await tenantDb.query(
      `INSERT INTO ${tableName} (id, ${entityColumn}, name, email, password_hash, status)
       VALUES (?, ?, ?, ?, ?, 'Active')`,
      [localUserId, entityId, globalUser.name, globalUser.email, globalUser.password_hash]
    );
  }

  if (globalUser.password_hash || globalUser.last_login_at) {
    const parentTable = portalType === 'vendor' ? 'vendors' : 'customers';
    await tenantDb.query(
      `UPDATE ${parentTable} SET connection_status = 'connected' WHERE id = ?`,
      [entityId]
    ).catch(() => {});
  }

  return localUserId;
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSAL PORTAL AUTHENTICATION MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

async function requireUniversalPortalAuth(req, res, next) {
  const auth = req.headers.authorization;
  const token = (auth && auth.startsWith('Bearer ') ? auth.slice(7) : null)
    || extractCookieToken(req, 'erp_portal_token')
    || extractCookieToken(req, 'erp_vendor_portal_token')
    || extractCookieToken(req, 'erp_customer_portal_token');

  if (!token) {
    return res.status(401).json({ error: 'Missing portal authentication token' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
    let globalUser = null;
    if (payload.global_user_id) {
      const userRes = await queryMaster('SELECT * FROM global_portal_users WHERE id = ?', [payload.global_user_id]);
      if (userRes.rowCount > 0) globalUser = userRes.rows[0];
    }
    if (!globalUser && payload.email) {
      globalUser = await getGlobalPortalUserByEmail(payload.email);
    }

    if (!globalUser) {
      return res.status(401).json({ error: 'Portal user not found' });
    }

    if (globalUser.status && globalUser.status !== 'Active') {
      return res.status(403).json({ error: 'This portal account is currently suspended' });
    }

    req.portalUser = globalUser;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired portal token' });
  }
}

// UNIVERSAL PORTAL LOGOUT
router.post(['/logout', '/portal/logout', '/auth/logout', '/portal/auth/logout'], async (req, res) => {
  const auth = req.headers.authorization;
  const token = (auth && auth.startsWith('Bearer ') ? auth.slice(7) : null)
    || (req.headers.cookie || '').split(';').map(p => p.trim()).find(p => p.startsWith('erp_portal_token='))?.slice('erp_portal_token='.length);

  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
      if (payload.global_user_id) {
        await queryMaster('DELETE FROM global_portal_sessions WHERE global_user_id = ?', [payload.global_user_id]).catch(() => {});
      }
    } catch {}
  }

  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie('erp_portal_token', { httpOnly: true, secure: isProd, sameSite: 'lax' });
  res.clearCookie('erp_vendor_portal_token', { httpOnly: true, secure: isProd, sameSite: 'lax' });
  res.clearCookie('erp_customer_portal_token', { httpOnly: true, secure: isProd, sameSite: 'lax' });

  return res.json({ ok: true, message: 'Logged out from Partner Portal' });
});

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSAL PORTAL: SELF-REGISTRATION & EMAIL VERIFICATION
// ─────────────────────────────────────────────────────────────────────────────

// PUBLIC SELF-REGISTRATION (DISABLED - PARTNERS ACCESS ONLY VIA WORKSPACE INVITATION)
router.post(['/register', '/portal/register', '/auth/register', '/portal/auth/register'], async (req, res) => {
  return res.status(403).json({
    error: 'Partner self-registration is disabled. Partners can only gain access to the portal when invited by a workspace.'
  });
});

// EMAIL VERIFICATION
router.all(['/verify-email', '/portal/verify-email', '/auth/verify-email', '/portal/auth/verify-email'], async (req, res) => {
  const token = req.query.token || req.body.token;
  const email = req.query.email || req.body.email;

  if (!token) {
    return res.status(400).json({ error: 'Verification token is required' });
  }

  try {
    let query = 'SELECT * FROM global_portal_users WHERE verification_token = ?';
    let params = [token];
    if (email) {
      query += ' AND email = ?';
      params.push(email.toLowerCase().trim());
    }

    const result = await queryMaster(query, params);
    if (result.rowCount === 0) {
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }

    const user = result.rows[0];
    if (user.verification_token_expires_at && new Date(user.verification_token_expires_at) < new Date()) {
      return res.status(400).json({ error: 'Verification token has expired. Please request a new one.' });
    }

    await queryMaster(
      'UPDATE global_portal_users SET email_verified_at = NOW(), verification_token = NULL, verification_token_expires_at = NULL WHERE id = ?',
      [user.id]
    );

    const jwtToken = signPortalToken({
      portal_type: 'universal',
      global_user_id: user.id,
      email: user.email,
      name: user.name
    });
    setPortalCookie(res, 'erp_portal_token', jwtToken);

    return res.json({
      ok: true,
      token: jwtToken,
      message: 'Email verified successfully! Welcome to your Universal Portal.'
    });
  } catch (err) {
    console.error('verify email error:', err);
    return res.status(500).json({ error: 'Email verification failed: ' + err.message });
  }
});

// UNIVERSAL PORTAL LOGIN
router.post(['/login', '/portal/login', '/auth/login', '/portal/auth/login'], async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  try {
    let globalUser = await getGlobalPortalUserByEmail(normalizedEmail);

    // Legacy fallback check across tenant DBs if not in master yet
    if (!globalUser) {
      const companiesRes = await queryMaster("SELECT id, database_name FROM companies WHERE status = 'active'");
      for (const comp of companiesRes.rows) {
        try {
          const tenantDb = getTenantPool(comp.database_name);
          const vRes = await tenantDb.query('SELECT * FROM vendor_portal_users WHERE email = ?', [normalizedEmail]);
          if (vRes.rowCount > 0 && vRes.rows[0].password_hash) {
            const valid = await bcrypt.compare(password, vRes.rows[0].password_hash);
            if (valid) {
              globalUser = await createOrUpdateGlobalPortalUser({
                email: normalizedEmail,
                name: vRes.rows[0].name,
                passwordHash: vRes.rows[0].password_hash
              });
              await queryMaster(
                `INSERT IGNORE INTO global_portal_memberships (id, global_user_id, company_id, entity_id, portal_type, status, joined_at)
                 VALUES (?, ?, ?, ?, 'vendor', 'Active', NOW())`,
                [crypto.randomUUID(), globalUser.id, comp.id, vRes.rows[0].vendor_id]
              );
              break;
            }
          }
          const cRes = await tenantDb.query('SELECT * FROM customer_portal_users WHERE email = ?', [normalizedEmail]);
          if (cRes.rowCount > 0 && cRes.rows[0].password_hash) {
            const valid = await bcrypt.compare(password, cRes.rows[0].password_hash);
            if (valid) {
              globalUser = await createOrUpdateGlobalPortalUser({
                email: normalizedEmail,
                name: cRes.rows[0].name,
                passwordHash: cRes.rows[0].password_hash
              });
              await queryMaster(
                `INSERT IGNORE INTO global_portal_memberships (id, global_user_id, company_id, entity_id, portal_type, status, joined_at)
                 VALUES (?, ?, ?, ?, 'customer', 'Active', NOW())`,
                [crypto.randomUUID(), globalUser.id, comp.id, cRes.rows[0].customer_id]
              );
              break;
            }
          }
        } catch (e) {
          // ignore tenant check error
        }
      }
    }

    if (!globalUser || !globalUser.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password. If you are newly invited, please create an account or verify your invite.' });
    }

    const valid = await bcrypt.compare(password, globalUser.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    await queryMaster('UPDATE global_portal_users SET last_login_at = NOW() WHERE id = ?', [globalUser.id]);

    // Fetch active memberships and pending requests
    const membershipsRes = await queryMaster(
      `SELECT 
        gpm.id AS membership_id,
        gpm.company_id,
        gpm.entity_id,
        gpm.portal_type,
        gpm.status AS membership_status,
        gpm.created_at AS requested_at,
        gpm.joined_at,
        c.company_name,
        c.company_code,
        c.logo_url,
        c.currency,
        c.support_email,
        c.support_phone,
        c.status AS company_status
       FROM global_portal_memberships gpm
       JOIN companies c ON c.id = gpm.company_id
       WHERE gpm.global_user_id = ?
         AND c.status NOT IN ('suspended', 'cancelled', 'paused', 'deleted')
       ORDER BY gpm.created_at DESC`,
      [globalUser.id]
    );

    const activeConnections = membershipsRes.rows.filter((m) => m.membership_status === 'Active');
    const pendingRequests = membershipsRes.rows.filter((m) => m.membership_status === 'Pending');

    const tokenPayload = {
      portal_type: 'universal',
      global_user_id: globalUser.id,
      email: globalUser.email,
      name: globalUser.name
    };
    const token = signPortalToken(tokenPayload);
    setPortalCookie(res, 'erp_portal_token', token);

    return res.json({
      ok: true,
      token,
      user: {
        id: globalUser.id,
        email: globalUser.email,
        name: globalUser.name,
        phone: globalUser.phone,
        company_name: globalUser.company_name,
        gstin: globalUser.gstin,
        address: globalUser.address,
        city: globalUser.city,
        state: globalUser.state,
        pincode: globalUser.pincode,
        business_type: globalUser.business_type,
        email_verified: !!globalUser.email_verified_at
      },
      active_connections: activeConnections,
      pending_requests: pendingRequests
    });
  } catch (err) {
    console.error('universal portal login error:', err);
    return res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

// GET UNIVERSAL PORTAL CONNECTIONS & DASHBOARD
router.get(['/connections', '/portal/connections', '/me', '/portal/me'], requireUniversalPortalAuth, async (req, res) => {
  try {
    const globalUser = req.portalUser;

    const membershipsRes = await queryMaster(
      `SELECT 
        gpm.id AS membership_id,
        gpm.company_id,
        gpm.entity_id,
        gpm.portal_type,
        gpm.status AS membership_status,
        gpm.created_at AS requested_at,
        gpm.joined_at,
        c.company_name,
        c.company_code,
        c.logo_url,
        c.currency,
        c.support_email,
        c.support_phone,
        c.status AS company_status
       FROM global_portal_memberships gpm
       JOIN companies c ON c.id = gpm.company_id
       WHERE gpm.global_user_id = ?
         AND c.status NOT IN ('suspended', 'cancelled', 'paused', 'deleted')
       ORDER BY gpm.created_at DESC`,
      [globalUser.id]
    );

    const activeConnections = membershipsRes.rows.filter((m) => m.membership_status === 'Active');
    const pendingRequests = membershipsRes.rows.filter((m) => m.membership_status === 'Pending');

    const enrichedUser = await enrichPortalUserFromEntity(globalUser);

    return res.json({
      ok: true,
      user: {
        id: enrichedUser.id,
        email: enrichedUser.email,
        name: enrichedUser.name,
        phone: enrichedUser.phone,
        company_name: enrichedUser.company_name,
        gstin: enrichedUser.gstin,
        pan: enrichedUser.pan,
        address: enrichedUser.address,
        city: enrichedUser.city,
        state: enrichedUser.state,
        pincode: enrichedUser.pincode,
        business_type: enrichedUser.business_type,
        email_verified: !!enrichedUser.email_verified_at,
        created_at: enrichedUser.created_at
      },
      active_connections: activeConnections,
      pending_requests: pendingRequests
    });
  } catch (err) {
    console.error('get portal connections error:', err);
    return res.status(500).json({ error: 'Failed to fetch portal connections' });
  }
});

// ACCEPT WORKSPACE CONNECTION REQUEST
router.post(['/connections/:membership_id/accept', '/portal/connections/:membership_id/accept'], requireUniversalPortalAuth, async (req, res) => {
  const { membership_id } = req.params;
  const globalUser = req.portalUser;

  try {
    const memRes = await queryMaster(
      `SELECT gpm.*, c.database_name, c.company_name
       FROM global_portal_memberships gpm
       JOIN companies c ON c.id = gpm.company_id
       WHERE gpm.id = ? AND gpm.global_user_id = ?`,
      [membership_id, globalUser.id]
    );

    if (memRes.rowCount === 0) {
      return res.status(404).json({ error: 'Connection request not found' });
    }

    const membership = memRes.rows[0];
    if (membership.status === 'Active') {
      return res.json({ ok: true, message: 'Already connected to ' + membership.company_name });
    }

    // Activate membership in master DB
    await queryMaster(
      'UPDATE global_portal_memberships SET status = \'Active\', joined_at = NOW() WHERE id = ?',
      [membership_id]
    );

    // Sync in tenant DB
    const tenantDb = getTenantPool(membership.database_name);
    if (membership.portal_type === 'vendor') {
      await tenantDb.query(
        'UPDATE vendors SET connection_status = \'connected\' WHERE id = ?',
        [membership.entity_id]
      ).catch(() => {});
    } else if (membership.portal_type === 'customer') {
      await tenantDb.query(
        'UPDATE customers SET connection_status = \'connected\' WHERE id = ?',
        [membership.entity_id]
      ).catch(() => {});
    }

    return res.json({
      ok: true,
      message: `Successfully connected with ${membership.company_name}!`
    });
  } catch (err) {
    console.error('accept connection error:', err);
    return res.status(500).json({ error: 'Failed to accept connection: ' + err.message });
  }
});

// DECLINE WORKSPACE CONNECTION REQUEST
router.post(['/connections/:membership_id/decline', '/portal/connections/:membership_id/decline'], requireUniversalPortalAuth, async (req, res) => {
  const { membership_id } = req.params;
  const globalUser = req.portalUser;

  try {
    const memRes = await queryMaster(
      `SELECT gpm.*, c.database_name, c.company_name
       FROM global_portal_memberships gpm
       JOIN companies c ON c.id = gpm.company_id
       WHERE gpm.id = ? AND gpm.global_user_id = ?`,
      [membership_id, globalUser.id]
    );

    if (memRes.rowCount === 0) {
      return res.status(404).json({ error: 'Connection request not found' });
    }

    const membership = memRes.rows[0];

    // Remove or decline in master DB
    await queryMaster(
      'UPDATE global_portal_memberships SET status = \'Declined\' WHERE id = ?',
      [membership_id]
    );

    // Update in tenant DB
    const tenantDb = getTenantPool(membership.database_name);
    if (membership.portal_type === 'vendor') {
      await tenantDb.query(
        'UPDATE vendors SET connection_status = \'declined\' WHERE id = ?',
        [membership.entity_id]
      ).catch(() => {});
    } else if (membership.portal_type === 'customer') {
      await tenantDb.query(
        'UPDATE customers SET connection_status = \'declined\' WHERE id = ?',
        [membership.entity_id]
      ).catch(() => {});
    }

    return res.json({
      ok: true,
      message: `Declined connection with ${membership.company_name}.`
    });
  } catch (err) {
    console.error('decline connection error:', err);
    return res.status(500).json({ error: 'Failed to decline connection: ' + err.message });
  }
});

// GET & UPDATE UNIVERSAL PROFILE
router.get(['/profile', '/portal/profile'], requireUniversalPortalAuth, async (req, res) => {
  const companyId = req.query.company_id || null;
  const user = await enrichPortalUserFromEntity(req.portalUser, companyId);
  return res.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      company_name: user.company_name,
      gstin: user.gstin,
      pan: user.pan,
      address: user.address,
      city: user.city,
      state: user.state,
      pincode: user.pincode,
      business_type: user.business_type,
      email_verified: !!user.email_verified_at,
      created_at: user.created_at
    }
  });
});

router.put(['/profile', '/portal/profile'], requireUniversalPortalAuth, async (req, res) => {
  const { name, phone, company_name, gstin, pan, address, city, state, pincode, business_type, company_id } = req.body;
  const user = req.portalUser;

  try {
    await queryMaster(
      `UPDATE global_portal_users
       SET name = COALESCE(?, name),
           phone = COALESCE(?, phone),
           company_name = COALESCE(?, company_name),
           gstin = COALESCE(?, gstin),
           pan = COALESCE(?, pan),
           address = COALESCE(?, address),
           city = COALESCE(?, city),
           state = COALESCE(?, state),
           pincode = COALESCE(?, pincode),
           business_type = COALESCE(?, business_type)
       WHERE id = ?`,
      [
        name ? name.trim() : null,
        phone ? phone.trim() : null,
        company_name ? company_name.trim() : null,
        gstin ? gstin.trim().toUpperCase() : null,
        pan ? pan.trim().toUpperCase() : null,
        address || null,
        city || null,
        state || null,
        pincode || null,
        business_type || null,
        user.id
      ]
    );

    // If active workspace/company is linked, also sync back to tenant vendor/customer table
    const targetCompanyId = company_id || req.query.company_id;
    const mRes = await queryMaster(
      `SELECT gpm.*, c.database_name
       FROM global_portal_memberships gpm
       JOIN companies c ON c.id = gpm.company_id
       WHERE gpm.global_user_id = ? ${targetCompanyId ? 'AND gpm.company_id = ?' : ''}
       ORDER BY gpm.status = 'Active' DESC LIMIT 1`,
      targetCompanyId ? [user.id, targetCompanyId] : [user.id]
    );
    if (mRes.rowCount > 0 && mRes.rows[0].entity_id && mRes.rows[0].database_name) {
      const m = mRes.rows[0];
      const tenantDb = getTenantPool(m.database_name);
      if (m.portal_type === 'vendor') {
        await tenantDb.query(
          `UPDATE vendors
           SET name = COALESCE(?, name),
               contact_person_name = COALESCE(?, contact_person_name),
               phone = COALESCE(?, phone),
               gstin = COALESCE(?, gstin),
               pan = COALESCE(?, pan),
               address_line1 = COALESCE(?, address_line1),
               city = COALESCE(?, city),
               state = COALESCE(?, state),
               pincode = COALESCE(?, pincode)
           WHERE id = ?`,
          [
            company_name ? company_name.trim() : null,
            name ? name.trim() : null,
            phone ? phone.trim() : null,
            gstin ? gstin.trim().toUpperCase() : null,
            pan ? pan.trim().toUpperCase() : null,
            address || null,
            city || null,
            state || null,
            pincode || null,
            m.entity_id
          ]
        ).catch(() => {});
      } else if (m.portal_type === 'customer') {
        await tenantDb.query(
          `UPDATE customers
           SET name = COALESCE(?, name),
               contact_person_name = COALESCE(?, contact_person_name),
               phone = COALESCE(?, phone),
               gstin = COALESCE(?, gstin),
               pan = COALESCE(?, pan),
               billing_address = COALESCE(?, billing_address),
               city = COALESCE(?, city),
               state = COALESCE(?, state),
               pincode = COALESCE(?, pincode)
           WHERE id = ?`,
          [
            company_name ? company_name.trim() : null,
            name ? name.trim() : null,
            phone ? phone.trim() : null,
            gstin ? gstin.trim().toUpperCase() : null,
            pan ? pan.trim().toUpperCase() : null,
            address || null,
            city || null,
            state || null,
            pincode || null,
            m.entity_id
          ]
        ).catch(() => {});
      }
    }

    const updated = await getGlobalPortalUserByEmail(user.email);
    return res.json({
      ok: true,
      message: 'Profile updated successfully!',
      user: {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        phone: updated.phone,
        company_name: updated.company_name,
        gstin: updated.gstin,
        pan: updated.pan,
        address: updated.address,
        city: updated.city,
        state: updated.state,
        pincode: updated.pincode,
        business_type: updated.business_type,
        email_verified: !!updated.email_verified_at
      }
    });
  } catch (err) {
    console.error('update profile error:', err);
    return res.status(500).json({ error: 'Failed to update profile: ' + err.message });
  }
});

// LAUNCH WORKSPACE SESSION FROM UNIVERSAL PORTAL
router.post(['/launch-workspace', '/portal/launch-workspace'], requireUniversalPortalAuth, async (req, res) => {
  const { company_id, portal_type } = req.body;
  const globalUser = req.portalUser;

  if (!company_id || !portal_type) {
    return res.status(400).json({ error: 'company_id and portal_type (vendor/customer) are required' });
  }

  try {
    const memRes = await queryMaster(
      `SELECT gpm.*, c.company_name, c.company_code, c.database_name, c.currency, c.logo_url
       FROM global_portal_memberships gpm
       JOIN companies c ON c.id = gpm.company_id
       WHERE gpm.global_user_id = ? AND gpm.company_id = ? AND gpm.portal_type = ? AND gpm.status = 'Active'`,
      [globalUser.id, company_id, portal_type]
    );

    if (memRes.rowCount === 0) {
      return res.status(403).json({ error: 'Active connection to this workspace was not found' });
    }

    const membership = memRes.rows[0];
    const tenantDb = getTenantPool(membership.database_name);
    const localUserId = await syncTenantPortalUser(tenantDb, portal_type, globalUser, membership.entity_id, membership.company_id);
    const entityTable = portal_type === 'vendor' ? 'vendors' : 'customers';
    const userTable = portal_type === 'vendor' ? 'vendor_portal_users' : 'customer_portal_users';
    await tenantDb.query(`UPDATE ${userTable} SET last_login_at = NOW() WHERE id = ?`, [localUserId]).catch(() => {});
    await tenantDb.query(`UPDATE ${entityTable} SET connection_status = 'connected' WHERE id = ?`, [membership.entity_id]).catch(() => {});

    const tokenPayload = {
      portal_type,
      global_user_id: globalUser.id,
      portal_user_id: localUserId,
      vendor_id: portal_type === 'vendor' ? membership.entity_id : undefined,
      customer_id: portal_type === 'customer' ? membership.entity_id : undefined,
      company_id: membership.company_id,
      database_name: membership.database_name,
      name: globalUser.name,
      email: globalUser.email
    };

    const token = signPortalToken(tokenPayload);
    const cookieName = portal_type === 'vendor' ? 'erp_vendor_portal_token' : 'erp_customer_portal_token';
    setPortalCookie(res, cookieName, token);

    return res.json({
      ok: true,
      token,
      portal_type,
      company: {
        id: membership.company_id,
        name: membership.company_name,
        code: membership.company_code,
        currency: membership.currency || 'INR',
        logo_url: membership.logo_url
      }
    });
  } catch (err) {
    console.error('launch workspace error:', err);
    return res.status(500).json({ error: 'Failed to launch workspace session: ' + err.message });
  }
});

// BIDIRECTIONAL CONNECT (DISABLED - PARTNERS CONNECT ONLY VIA WORKSPACE INVITATIONS)
router.post(['/connect-by-code', '/portal/connect-by-code'], requireUniversalPortalAuth, async (req, res) => {
  return res.status(403).json({
    error: 'Manual connection by code is disabled. Workspaces must invite partners directly.'
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSAL PORTAL: ORDERS PAGE API (Per Active Workspace Context)
// ─────────────────────────────────────────────────────────────────────────────

router.get(['/orders', '/portal/orders'], requireUniversalPortalAuth, async (req, res) => {
  const globalUser = req.portalUser;
  const { company_id, status, payment_status, start_date, end_date, search, page = 1, limit = 20 } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageSize = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  const offset = (pageNum - 1) * pageSize;

  try {
    // 1. Fetch active memberships
    const membershipsRes = await queryMaster(
      `SELECT gpm.*, c.company_name, c.company_code, c.database_name, c.currency, c.logo_url
       FROM global_portal_memberships gpm
       JOIN companies c ON c.id = gpm.company_id
       WHERE gpm.global_user_id = ?
         AND gpm.status = 'Active'
         AND c.status NOT IN ('suspended', 'cancelled', 'paused', 'deleted')
       ORDER BY gpm.created_at ASC`,
      [globalUser.id]
    );

    if (membershipsRes.rowCount === 0) {
      return res.json({
        ok: true,
        orders: [],
        total: 0,
        meta: { page: 1, page_size: pageSize, total: 0, total_pages: 1 },
        portal_type: null,
        company: null,
        companies: []
      });
    }

    // 2. Select active workspace context
    let activeMem = company_id ? membershipsRes.rows.find((m) => m.company_id === company_id) : null;
    if (!activeMem) activeMem = membershipsRes.rows[0];

    const tenantDb = getTenantPool(activeMem.database_name);
    let orders = [];
    let totalCount = 0;

    if (activeMem.portal_type === 'vendor') {
      const vMatch = await tenantDb.query(
        `SELECT id FROM vendors 
         WHERE id = ? 
            OR global_user_id = ? 
            OR (email IS NOT NULL AND LOWER(email) = LOWER(?))
            OR (phone IS NOT NULL AND phone != '' AND phone = ?)`,
        [activeMem.entity_id, globalUser.id, globalUser.email, globalUser.phone || '']
      );
      const matchedVendorIds = Array.from(new Set([activeMem.entity_id, ...vMatch.rows.map(r => r.id)].filter(Boolean)));
      const vPlaceholders = matchedVendorIds.map(() => '?').join(',');

      const params = [...matchedVendorIds];
      let where = `p.vendor_id IN (${vPlaceholders}) AND p.deleted_at IS NULL`;

      if (status && status !== 'all') {
        where += ' AND p.status = ?';
        params.push(status);
      }
      if (payment_status && payment_status !== 'all') {
        if (payment_status === 'paid') {
          where += ' AND p.amount_due <= 0 AND p.amount_paid > 0';
        } else if (payment_status === 'partial') {
          where += ' AND p.amount_paid > 0 AND p.amount_due > 0';
        } else if (payment_status === 'unpaid') {
          where += ' AND (p.amount_paid = 0 OR p.amount_paid IS NULL)';
        }
      }
      if (start_date) {
        where += ' AND p.date >= ?';
        params.push(start_date);
      }
      if (end_date) {
        where += ' AND p.date <= ?';
        params.push(end_date);
      }
      if (search && search.trim()) {
        where += ' AND (p.procurement_number LIKE ? OR p.notes LIKE ? OR p.dispatch_tracking_ref LIKE ?)';
        const q = `%${search.trim()}%`;
        params.push(q, q, q);
      }

      // Count total matching orders
      const countRes = await tenantDb.query(`SELECT COUNT(*) AS total FROM procurements p WHERE ${where}`, params);
      totalCount = parseInt(countRes.rows[0]?.total || '0', 10);

      const query = `
        SELECT 
          p.id,
          p.procurement_number AS order_number,
          p.date,
          COALESCE(p.subtotal, 0) AS subtotal,
          COALESCE(p.discount_amount, 0) AS discount_amount,
          COALESCE(p.discount_percent, CASE WHEN p.subtotal > 0 AND p.discount_amount > 0 THEN ROUND((p.discount_amount / p.subtotal) * 100, 2) ELSE 0 END) AS discount_percent,
          COALESCE(p.tax_amount, 0) AS tax_amount,
          COALESCE(p.tax_amount, 0) AS total_tax,
          p.total_amount,
          p.amount_paid,
          p.amount_due,
          COALESCE(p.status, 'Pending Vendor Confirmation') AS status,
          p.notes,
          p.vendor_notes,
          p.dispatch_tracking_ref,
          p.dispatch_date,
          p.received_date,
          p.rejection_reason,
          p.created_at,
          loc.name AS location_name,
          loc.address AS location_address,
          COALESCE(v.phone, v.contact, '') AS vendor_contact,
          COALESCE(
            NULLIF(TRIM(CONCAT_WS(', ', NULLIF(v.address_line1, ''), NULLIF(v.city, ''), NULLIF(v.state, ''), NULLIF(v.pincode, ''))), ''),
            v.address,
            ''
          ) AS vendor_address,
          v.name AS vendor_name,
          'vendor' AS portal_type
        FROM procurements p
        LEFT JOIN locations loc ON loc.id = p.location_id
        LEFT JOIN vendors v ON v.id = p.vendor_id
        WHERE ${where}
        ORDER BY p.date DESC, p.created_at DESC
        LIMIT ? OFFSET ?
      `;

      const result = await tenantDb.query(query, [...params, pageSize, offset]);
      
      // Fetch line items and payment installments for each order
      for (const ord of result.rows) {
        const sub = Number(ord.subtotal || 0);
        const tax = Number(ord.tax_amount || ord.total_tax || 0);
        const disc = Number(ord.discount_amount || 0);
        if (sub > 0 || tax > 0 || disc > 0) {
          ord.total_amount = Math.max(0, sub + tax - disc);
        }
        ord.amount_due = Math.max(0, Number(ord.total_amount || 0) - Number(ord.amount_paid || 0));

        const itemsRes = await tenantDb.query(
          `SELECT pi.quantity, pi.rate_per_unit, pi.line_total,
                  COALESCE(pi.tax_rate, 0) AS tax_rate,
                  COALESCE(pi.tax_amount, 0) AS tax_amount,
                  COALESCE(i.hsn_code, '') AS hsn_code,
                  COALESCE(i.name, rm.name, 'Item') AS item_name,
                  COALESCE(i.unit, rm.unit, 'pcs') AS unit
           FROM procurement_items pi
           LEFT JOIN items i ON i.id = pi.item_id
           LEFT JOIN raw_materials rm ON rm.id = pi.item_id
           WHERE pi.procurement_id = ?`,
          [ord.id]
        );

        const paymentsRes = await tenantDb.query(
          `SELECT id, amount, date, notes, created_at
           FROM payments_log
           WHERE (related_id = ? OR (related_type = 'procurement' AND related_id = ?))
             AND deleted_at IS NULL
           ORDER BY date DESC, created_at DESC`,
          [ord.id, ord.id]
        ).catch(() => ({ rows: [] }));

        orders.push({
          ...ord,
          items: itemsRes.rows,
          item_count: itemsRes.rowCount,
          payments: paymentsRes.rows || [],
          payment_count: (paymentsRes.rows || []).length
        });
      }

      // Also include purchase orders created in PO tab not yet converted
      try {
        const poRes = await tenantDb.query(
          `SELECT po.id, po.po_number AS order_number, po.date,
                  COALESCE(po.subtotal, 0) AS subtotal,
                  0 AS discount_amount,
                  0 AS discount_percent,
                  COALESCE(po.total_tax, 0) AS tax_amount,
                  COALESCE(po.total_tax, 0) AS total_tax,
                  po.total_amount,
                  0 AS amount_paid, po.total_amount AS amount_due,
                  COALESCE(po.status, 'Sent to Vendor') AS status,
                  po.notes,
                  po.notes AS vendor_notes, NULL AS dispatch_tracking_ref, NULL AS dispatch_date,
                  po.created_at, 'vendor' AS portal_type,
                  COALESCE(v.phone, v.contact, '') AS vendor_contact,
                  COALESCE(
                    NULLIF(TRIM(CONCAT_WS(', ', NULLIF(v.address_line1, ''), NULLIF(v.city, ''), NULLIF(v.state, ''), NULLIF(v.pincode, ''))), ''),
                    v.address,
                    ''
                  ) AS vendor_address,
                  v.name AS vendor_name
           FROM purchase_orders po
           LEFT JOIN vendors v ON v.id = po.vendor_id
           WHERE po.vendor_id IN (${vPlaceholders}) AND po.deleted_at IS NULL
             AND po.id NOT IN (SELECT COALESCE(purchase_order_id, '') FROM procurements WHERE purchase_order_id IS NOT NULL)
           ORDER BY po.date DESC, po.created_at DESC`,
          [...matchedVendorIds]
        );
        for (const p of poRes.rows) {
          const poiRes = await tenantDb.query(
            `SELECT poi.quantity, poi.rate_per_unit, poi.line_total,
                    COALESCE(poi.tax_rate, 0) AS tax_rate,
                    COALESCE(poi.line_total - (poi.quantity * poi.rate_per_unit), 0) AS tax_amount,
                    COALESCE(i.hsn_code, '') AS hsn_code,
                    COALESCE(i.name, 'Item') AS item_name,
                    COALESCE(i.unit, 'pcs') AS unit
             FROM purchase_order_items poi
             LEFT JOIN items i ON i.id = poi.item_id
             WHERE poi.po_id = ?`,
            [p.id]
          ).catch(() => ({ rows: [] }));
          orders.push({
            ...p,
            items: poiRes.rows || [],
            item_count: (poiRes.rows || []).length,
            payments: [],
            payment_count: 0
          });
        }
      } catch (poErr) {}
    } else {
      // Customer Portal Orders (Sales Invoices & Orders)
      const cMatch = await tenantDb.query(
        `SELECT id FROM customers 
         WHERE id = ? 
            OR global_user_id = ? 
            OR (email IS NOT NULL AND LOWER(email) = LOWER(?))
            OR (phone IS NOT NULL AND phone != '' AND phone = ?)`,
        [activeMem.entity_id, globalUser.id, globalUser.email, globalUser.phone || '']
      );
      const matchedCustomerIds = Array.from(new Set([activeMem.entity_id, ...cMatch.rows.map(r => r.id)].filter(Boolean)));
      const cPlaceholders = matchedCustomerIds.map(() => '?').join(',');

      const params = [...matchedCustomerIds];
      let where = `s.customer_id IN (${cPlaceholders}) AND s.deleted_at IS NULL`;

      if (status && status !== 'all') {
        where += ' AND s.status = ?';
        params.push(status);
      }
      if (payment_status && payment_status !== 'all') {
        if (payment_status === 'paid') {
          where += ' AND (s.payment_status = \'paid\' OR s.amount_due <= 0)';
        } else if (payment_status === 'partial') {
          where += ' AND (s.payment_status = \'partial\' OR (s.amount_received > 0 AND s.amount_due > 0))';
        } else if (payment_status === 'unpaid') {
          where += ' AND (s.payment_status = \'unpaid\' OR s.amount_received = 0 OR s.amount_received IS NULL)';
        }
      }
      if (start_date) {
        where += ' AND s.date >= ?';
        params.push(start_date);
      }
      if (end_date) {
        where += ' AND s.date <= ?';
        params.push(end_date);
      }
      if (search && search.trim()) {
        where += ' AND (s.invoice_number LIKE ? OR s.notes LIKE ? OR s.customer_notes LIKE ?)';
        const q = `%${search.trim()}%`;
        params.push(q, q, q);
      }

      const countRes = await tenantDb.query(`SELECT COUNT(*) AS total FROM sales s WHERE ${where}`, params);
      totalCount = parseInt(countRes.rows[0]?.total || '0', 10);

      const query = `
        SELECT 
          s.id,
          s.invoice_number AS order_number,
          s.date,
          COALESCE(s.subtotal, 0) AS subtotal,
          COALESCE(s.discount_amount, 0) AS discount_amount,
          CASE WHEN s.subtotal > 0 AND s.discount_amount > 0 THEN ROUND((s.discount_amount / s.subtotal) * 100, 2) ELSE 0 END AS discount_percent,
          COALESCE(s.total_tax, 0) AS tax_amount,
          COALESCE(s.total_tax, 0) AS total_tax,
          COALESCE(s.cgst_amount, 0) AS cgst_amount,
          COALESCE(s.sgst_amount, 0) AS sgst_amount,
          COALESCE(s.igst_amount, 0) AS igst_amount,
          COALESCE(s.round_off_amount, 0) AS round_off_amount,
          s.place_of_supply,
          s.terms_and_conditions,
          s.notes,
          s.total_amount,
          s.amount_received AS amount_paid,
          s.amount_due,
          s.payment_status,
          COALESCE(s.status, 'Sales Order Sent') AS status,
          s.customer_notes,
          s.decline_reason,
          s.dispatch_tracking_ref,
          s.dispatch_date,
          s.created_at,
          'customer' AS portal_type
        FROM sales s
        WHERE ${where}
        ORDER BY s.date DESC, s.created_at DESC
        LIMIT ? OFFSET ?
      `;

      const result = await tenantDb.query(query, [...params, pageSize, offset]);

      for (const ord of result.rows) {
        const itemsRes = await tenantDb.query(
          `SELECT si.quantity, si.rate_per_unit, si.line_total,
                  COALESCE(si.discount_percent, 0) AS discount_percent,
                  COALESCE(si.taxable_value, 0) AS taxable_value,
                  COALESCE(si.tax_rate, 0) AS tax_rate,
                  COALESCE(si.cgst_rate, 0) AS cgst_rate,
                  COALESCE(si.cgst_amount, 0) AS cgst_amount,
                  COALESCE(si.sgst_rate, 0) AS sgst_rate,
                  COALESCE(si.sgst_amount, 0) AS sgst_amount,
                  COALESCE(si.igst_rate, 0) AS igst_rate,
                  COALESCE(si.igst_amount, 0) AS igst_amount,
                  COALESCE(fg.hsn_code, i.hsn_code, '') AS hsn_code,
                  si.packaging_config_id,
                  si.packaging_level_id,
                  COALESCE(ppl.name, si.package_name) AS package_name,
                  COALESCE(ppl.base_quantity_equivalent, si.units_per_package, 1) AS units_per_package,
                  COALESCE(ppl.package_unit, si.package_name, fg.unit, i.unit, 'pcs') AS unit,
                  COALESCE(fg.unit, i.unit, 'pcs') AS base_unit,
                  COALESCE(i.name, fg.name, 'Product') AS item_name
           FROM sales_items si
           LEFT JOIN items i ON i.id = si.finished_good_id
           LEFT JOIN finished_goods fg ON fg.id = si.finished_good_id
           LEFT JOIN product_packaging_levels ppl ON ppl.id = COALESCE(si.packaging_level_id, si.packaging_config_id)
           WHERE si.sale_id = ?`,
          [ord.id]
        );

        const paymentsRes = await tenantDb.query(
          `SELECT id, amount, date, notes, created_at
           FROM payments_log
           WHERE (related_id = ? OR (related_type = 'sale' AND related_id = ?))
             AND deleted_at IS NULL
           ORDER BY date DESC, created_at DESC`,
          [ord.id, ord.id]
        ).catch(() => ({ rows: [] }));

        orders.push({
          ...ord,
          items: itemsRes.rows,
          item_count: itemsRes.rowCount,
          payments: paymentsRes.rows || [],
          payment_count: (paymentsRes.rows || []).length
        });
      }
    }

    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

    return res.json({
      ok: true,
      orders,
      total: totalCount,
      meta: {
        page: pageNum,
        page_size: pageSize,
        total: totalCount,
        total_pages: totalPages
      },
      portal_type: activeMem.portal_type,
      company: {
        id: activeMem.company_id,
        name: activeMem.company_name,
        code: activeMem.company_code,
        currency: activeMem.currency || 'INR',
        logo_url: activeMem.logo_url
      },
      companies: membershipsRes.rows.map((m) => ({
        id: m.company_id,
        name: m.company_name,
        code: m.company_code,
        portal_type: m.portal_type,
        currency: m.currency || 'INR'
      }))
    });
  } catch (err) {
    console.error('portal orders error:', err);
    return res.status(500).json({ error: 'Failed to fetch portal orders: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSAL PORTAL: PRODUCTS CATALOG & ORDER PLACEMENT API
// ─────────────────────────────────────────────────────────────────────────────

router.get(['/products', '/portal/products'], requireUniversalPortalAuth, async (req, res) => {
  const globalUser = req.portalUser;
  const { company_id } = req.query;

  try {
    const membershipsRes = await queryMaster(
      `SELECT gpm.*, c.company_name, c.company_code, c.database_name, c.currency, c.state AS company_state
       FROM global_portal_memberships gpm
       JOIN companies c ON c.id = gpm.company_id
       WHERE gpm.global_user_id = ?
         AND gpm.status = 'Active'
         AND c.status NOT IN ('suspended', 'cancelled', 'paused', 'deleted')
       ORDER BY gpm.created_at ASC`,
      [globalUser.id]
    );

    if (membershipsRes.rowCount === 0) {
      return res.json({ ok: true, products: [], company: null });
    }

    let activeMem = company_id ? membershipsRes.rows.find((m) => m.company_id === company_id) : null;
    if (!activeMem) activeMem = membershipsRes.rows[0];

    const tenantDb = getTenantPool(activeMem.database_name);

    const result = await tenantDb.query(`
      SELECT fg.id, fg.name, fg.unit, fg.default_price, fg.tax_rate, fg.hsn_code,
             COALESCE((
               SELECT SUM(CASE WHEN transaction_type = 'in' THEN quantity ELSE -quantity END)
               FROM inventory_ledger
               WHERE item_type = 'finished_good' AND item_id = fg.id
             ), 0) AS available_stock
      FROM finished_goods fg
      WHERE fg.deleted_at IS NULL
      ORDER BY fg.name ASC
    `);

    const fgIds = result.rows.map((r) => r.id);
    if (fgIds.length > 0) {
      const pkgRes = await tenantDb.query(
        `SELECT ppl.*, 
                parent.name AS parent_package_name, 
                parent.package_unit AS parent_package_unit,
                parent.base_quantity_equivalent AS parent_base_quantity_equivalent
         FROM product_packaging_levels ppl
         LEFT JOIN product_packaging_levels parent ON parent.id = ppl.parent_level_id
         WHERE ppl.product_id IN (${fgIds.map(() => '?').join(',')}) AND ppl.status != 'archived'
         ORDER BY ppl.base_quantity_equivalent ASC, ppl.created_at ASC`,
        fgIds
      );
      const pkgMap = {};
      for (const p of pkgRes.rows) {
        if (!pkgMap[p.product_id]) pkgMap[p.product_id] = [];
        pkgMap[p.product_id].push({
          id: p.id,
          product_id: p.product_id,
          package_name: p.name,
          package_unit: p.package_unit,
          units_per_package: p.base_quantity_equivalent,
          selling_price: p.selling_price,
          mrp: p.mrp,
          is_default: p.is_default,
          barcode: p.barcode
        });
      }
      for (const row of result.rows) {
        row.packaging_configs = pkgMap[row.id] || [];
      }
    } else {
      for (const row of result.rows) {
        row.packaging_configs = [];
      }
    }

    return res.json({
      ok: true,
      products: result.rows,
      portal_type: activeMem.portal_type,
      company: {
        id: activeMem.company_id,
        name: activeMem.company_name,
        code: activeMem.company_code,
        currency: activeMem.currency || 'INR',
        state: activeMem.company_state || 'Delhi'
      }
    });
  } catch (err) {
    console.error('portal products error:', err);
    return res.status(500).json({ error: 'Failed to fetch catalog: ' + err.message });
  }
});

router.post(['/orders', '/portal/orders'], requireUniversalPortalAuth, async (req, res) => {
  const globalUser = req.portalUser;
  const { company_id, items, notes, delivery_address, date, due_date } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one item is required to place an order' });
  }

  try {
    const memRes = await queryMaster(
      `SELECT gpm.*, c.company_name, c.company_code, c.database_name, c.currency, c.state AS company_state
       FROM global_portal_memberships gpm
       JOIN companies c ON c.id = gpm.company_id
       WHERE gpm.global_user_id = ? AND gpm.company_id = ? AND gpm.status = 'Active'`,
      [globalUser.id, company_id]
    );

    if (memRes.rowCount === 0) {
      return res.status(403).json({ error: 'Unauthorized for this workspace context' });
    }

    const membership = memRes.rows[0];
    if (membership.portal_type !== 'customer') {
      return res.status(400).json({ error: 'Only connected customers can place sales orders' });
    }

    const tenantDb = getTenantPool(membership.database_name);

    // Resolve customer record in tenant DB
    const custRes = await tenantDb.query(
      'SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL',
      [membership.entity_id]
    );
    if (custRes.rowCount === 0) {
      return res.status(404).json({ error: 'Customer record not found in workspace' });
    }
    const customer = custRes.rows[0];

    const workspaceState = membership.company_state || 'Delhi';
    const customerState = customer.state || workspaceState;
    const isInterstate = customerState.trim().toLowerCase() !== workspaceState.trim().toLowerCase();

    // Calculate each item line
    const calculatedLines = [];
    for (const item of items) {
      const fgId = item.finished_good_id || item.item_id;
      if (!fgId) return res.status(400).json({ error: 'Each item must specify finished_good_id' });

      const fgRes = await tenantDb.query('SELECT name, unit, default_price, tax_rate FROM finished_goods WHERE id = ? AND deleted_at IS NULL', [fgId]);
      if (fgRes.rowCount === 0) return res.status(400).json({ error: `Product not found: ${fgId}` });
      const fg = fgRes.rows[0];

      let rate = Number(item.rate_per_unit);
      let unitsPerPkg = 1;
      let pkgName = null;
      let pkgConfigId = item.packaging_config_id || null;

      // If packaging_config_id is not passed, auto-match from product packaging levels
      if (!pkgConfigId) {
        const autoPkgRes = await tenantDb.query(
          'SELECT * FROM product_packaging_levels WHERE product_id = ? AND status != "archived" ORDER BY is_default DESC, base_quantity_equivalent ASC',
          [fgId]
        );
        if (autoPkgRes.rowCount > 0) {
          const matchByPrice = autoPkgRes.rows.find((p) => Number(p.selling_price) === rate);
          if (matchByPrice) {
            pkgConfigId = matchByPrice.id;
          } else if (rate > Number(fg.default_price || 0) || autoPkgRes.rows.length === 1) {
            const defPkg = autoPkgRes.rows.find((p) => p.is_default) || autoPkgRes.rows[0];
            pkgConfigId = defPkg.id;
          }
        }
      }

      if (pkgConfigId) {
        const pkgRes = await tenantDb.query('SELECT * FROM product_packaging_levels WHERE id = ?', [pkgConfigId]);
        if (pkgRes.rowCount > 0) {
          const pkg = pkgRes.rows[0];
          pkgName = pkg.name;
          unitsPerPkg = Number(pkg.base_quantity_equivalent || 1);
          if (!rate || isNaN(rate) || rate <= 0) {
            rate = Number(pkg.selling_price) || (Number(fg.default_price || 0) * unitsPerPkg);
          }
        }
      }

      if (!rate || isNaN(rate) || rate <= 0) {
        rate = Number(fg.default_price) || 0;
      }

      const taxRate = item.tax_rate != null ? Number(item.tax_rate) : (Number(fg.tax_rate) || 18);
      const lineCalculated = calculateInvoiceLine({
        quantity: Number(item.quantity || 1),
        ratePerUnit: rate,
        discountPercent: 0,
        taxRate,
        isInterstate
      });

      calculatedLines.push({
        finished_good_id: fgId,
        finished_good_name: fg.name,
        packaging_config_id: pkgConfigId,
        package_name: pkgName,
        units_per_package: unitsPerPkg,
        ...lineCalculated
      });
    }

    const totals = calculateInvoiceTotals(calculatedLines, {
      invoiceDiscount: 0,
      roundingMethod: 'round_half_up',
      roundingTarget: 1
    });

    const invoiceNumber = await getNextDocumentNumber(tenantDb, 'invoice');
    const saleId = crypto.randomUUID();
    const orderDate = date || new Date().toISOString().slice(0, 10);
    const defaultLocRes = await tenantDb.query("SELECT id FROM locations WHERE is_default = 1 LIMIT 1");
    const defaultLocationId = defaultLocRes.rows[0]?.id || null;

    await tenantDb.query('START TRANSACTION');

    await tenantDb.query(
      `INSERT INTO sales (
        id, invoice_number, customer_id, location_id, finished_good_id, quantity, rate_per_unit,
        date, due_date, place_of_supply, subtotal, cgst_amount, sgst_amount, igst_amount,
        total_tax, discount_amount, pre_rounding_total, round_off_amount,
        total_amount, amount_received, amount_due, payment_status, notes, customer_notes, status, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'Ordered', NOW())`,
      [
        saleId, invoiceNumber, customer.id, defaultLocationId,
        calculatedLines[0].finished_good_id, calculatedLines[0].quantity, calculatedLines[0].rate_per_unit,
        orderDate, due_date || null, customerState,
        totals.subtotal, totals.cgst_amount, totals.sgst_amount, totals.igst_amount,
        totals.total_tax, totals.discount_amount, totals.pre_rounding_total, totals.round_off_amount,
        totals.total_amount, 0, totals.total_amount, 'Unpaid',
        delivery_address ? `Delivery Address: ${delivery_address}` : null,
        notes || 'Order placed by customer via portal'
      ]
    );

    for (const line of calculatedLines) {
      const salesItemId = crypto.randomUUID();
      await tenantDb.query(
        `INSERT INTO sales_items (
          id, sale_id, finished_good_id, packaging_config_id, package_name, units_per_package,
          quantity, rate_per_unit, discount_percent,
          taxable_value, tax_rate, cgst_rate, cgst_amount, sgst_rate, sgst_amount,
          igst_rate, igst_amount, line_total
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          salesItemId, saleId, line.finished_good_id, line.packaging_config_id || null,
          line.package_name || null, line.units_per_package || 1,
          line.quantity, line.rate_per_unit, 0,
          line.taxable_value, line.tax_rate, line.cgst_rate, line.cgst_amount,
          line.sgst_rate, line.sgst_amount, line.igst_rate, line.igst_amount, line.line_total
        ]
      );
    }

    await createNotification(tenantDb, {
      user_type: 'user',
      title: 'New Customer Order Received',
      message: `Customer ${customer.name} placed a new order ${invoiceNumber} for ₹${totals.total_amount.toLocaleString('en-IN')}.`,
      link: '/sales'
    }).catch(() => {});

    await tenantDb.query('COMMIT');

    return res.status(201).json({
      ok: true,
      message: 'Order placed successfully!',
      order_id: saleId,
      sale_id: saleId,
      order_number: invoiceNumber,
      invoice_number: invoiceNumber,
      total_amount: totals.total_amount
    });
  } catch (err) {
    await tenantDb.query('ROLLBACK').catch(() => {});
    console.error('portal place order error:', err);
    return res.status(500).json({ error: 'Failed to place order: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSAL PORTAL: PAYMENTS & FINANCIAL INSTALLMENTS LEDGER API
// ─────────────────────────────────────────────────────────────────────────────

router.get(['/payments', '/portal/payments'], requireUniversalPortalAuth, async (req, res) => {
  const globalUser = req.portalUser;
  const { company_id, start_date, end_date, search, page = 1, limit = 20 } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageSize = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  const offset = (pageNum - 1) * pageSize;

  try {
    const membershipsRes = await queryMaster(
      `SELECT gpm.*, c.company_name, c.company_code, c.database_name, c.currency, c.logo_url
       FROM global_portal_memberships gpm
       JOIN companies c ON c.id = gpm.company_id
       WHERE gpm.global_user_id = ?
         AND gpm.status = 'Active'
         AND c.status NOT IN ('suspended', 'cancelled', 'paused', 'deleted')
       ORDER BY gpm.created_at ASC`,
      [globalUser.id]
    );

    if (membershipsRes.rowCount === 0) {
      return res.json({
        ok: true,
        payments: [],
        total: 0,
        meta: { page: 1, page_size: pageSize, total: 0, total_pages: 1 },
        portal_type: null,
        company: null
      });
    }

    let activeMem = company_id ? membershipsRes.rows.find((m) => m.company_id === company_id) : null;
    if (!activeMem) activeMem = membershipsRes.rows[0];

    const tenantDb = getTenantPool(activeMem.database_name);
    let payments = [];
    let totalCount = 0;
    let totalAmount = 0;

    let balanceSummary = { total_invoiced: 0, total_paid: 0, total_due: 0 };

    if (activeMem.portal_type === 'vendor') {
      const vMatch = await tenantDb.query(
        `SELECT id FROM vendors 
         WHERE id = ? 
            OR global_user_id = ? 
            OR (email IS NOT NULL AND LOWER(email) = LOWER(?))
            OR (phone IS NOT NULL AND phone != '' AND phone = ?)`,
        [activeMem.entity_id, globalUser.id, globalUser.email, globalUser.phone || '']
      );
      const matchedVendorIds = Array.from(new Set([activeMem.entity_id, ...vMatch.rows.map(r => r.id)].filter(Boolean)));
      const vPlaceholders = matchedVendorIds.map(() => '?').join(',');

      const balanceRes = await tenantDb.query(
        `SELECT 
           COALESCE(SUM(total_amount), 0) AS total_invoiced,
           COALESCE(SUM(amount_paid), 0) AS total_paid,
           COALESCE(SUM(amount_due), 0) AS total_due
         FROM procurements
         WHERE vendor_id IN (${vPlaceholders}) AND deleted_at IS NULL`,
        matchedVendorIds
      );
      balanceSummary = {
        total_invoiced: parseFloat(balanceRes.rows[0]?.total_invoiced || '0'),
        total_paid: parseFloat(balanceRes.rows[0]?.total_paid || '0'),
        total_due: parseFloat(balanceRes.rows[0]?.total_due || '0')
      };

      const params = [...matchedVendorIds];
      let where = `p.vendor_id IN (${vPlaceholders}) AND pl.related_type = 'procurement' AND pl.deleted_at IS NULL AND p.deleted_at IS NULL`;

      if (start_date) {
        where += ' AND pl.date >= ?';
        params.push(start_date);
      }
      if (end_date) {
        where += ' AND pl.date <= ?';
        params.push(end_date);
      }
      if (search && search.trim()) {
        where += ' AND (p.procurement_number LIKE ? OR pl.notes LIKE ?)';
        const q = `%${search.trim()}%`;
        params.push(q, q);
      }

      const countRes = await tenantDb.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(pl.amount), 0) AS total_amount
         FROM payments_log pl
         JOIN procurements p ON p.id = pl.related_id
         WHERE ${where}`,
        params
      );
      totalCount = parseInt(countRes.rows[0]?.total || '0', 10);
      totalAmount = parseFloat(countRes.rows[0]?.total_amount || '0');

      const query = `
        SELECT 
          pl.id,
          pl.amount,
          pl.date,
          pl.notes,
          pl.created_at,
          p.id AS order_id,
          p.procurement_number AS order_number,
          p.total_amount AS order_total,
          p.amount_paid AS order_paid,
          p.amount_due AS order_due,
          'vendor_payment' AS type
        FROM payments_log pl
        JOIN procurements p ON p.id = pl.related_id
        WHERE ${where}
        ORDER BY pl.date DESC, pl.created_at DESC
        LIMIT ? OFFSET ?
      `;

      const result = await tenantDb.query(query, [...params, pageSize, offset]);
      payments = result.rows || [];
    } else {
      const cMatch = await tenantDb.query(
        `SELECT id FROM customers 
         WHERE id = ? 
            OR global_user_id = ? 
            OR (email IS NOT NULL AND LOWER(email) = LOWER(?))
            OR (phone IS NOT NULL AND phone != '' AND phone = ?)`,
        [activeMem.entity_id, globalUser.id, globalUser.email, globalUser.phone || '']
      );
      const matchedCustomerIds = Array.from(new Set([activeMem.entity_id, ...cMatch.rows.map(r => r.id)].filter(Boolean)));
      const cPlaceholders = matchedCustomerIds.map(() => '?').join(',');

      const balanceRes = await tenantDb.query(
        `SELECT 
           COALESCE(SUM(total_amount), 0) AS total_invoiced,
           COALESCE(SUM(amount_received), 0) AS total_paid,
           COALESCE(SUM(amount_due), 0) AS total_due
         FROM sales
         WHERE customer_id IN (${cPlaceholders}) AND deleted_at IS NULL`,
        matchedCustomerIds
      );
      balanceSummary = {
        total_invoiced: parseFloat(balanceRes.rows[0]?.total_invoiced || '0'),
        total_paid: parseFloat(balanceRes.rows[0]?.total_paid || '0'),
        total_due: parseFloat(balanceRes.rows[0]?.total_due || '0')
      };

      const params = [...matchedCustomerIds];
      let where = `s.customer_id IN (${cPlaceholders}) AND pl.related_type = 'sale' AND pl.deleted_at IS NULL AND s.deleted_at IS NULL`;

      if (start_date) {
        where += ' AND pl.date >= ?';
        params.push(start_date);
      }
      if (end_date) {
        where += ' AND pl.date <= ?';
        params.push(end_date);
      }
      if (search && search.trim()) {
        where += ' AND (s.invoice_number LIKE ? OR pl.notes LIKE ?)';
        const q = `%${search.trim()}%`;
        params.push(q, q);
      }

      const countRes = await tenantDb.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(pl.amount), 0) AS total_amount
         FROM payments_log pl
         JOIN sales s ON s.id = pl.related_id
         WHERE ${where}`,
        params
      );
      totalCount = parseInt(countRes.rows[0]?.total || '0', 10);
      totalAmount = parseFloat(countRes.rows[0]?.total_amount || '0');

      const query = `
        SELECT 
          pl.id,
          pl.amount,
          pl.date,
          pl.notes,
          pl.created_at,
          s.id AS order_id,
          s.invoice_number AS order_number,
          s.total_amount AS order_total,
          s.amount_received AS order_paid,
          s.amount_due AS order_due,
          'customer_payment' AS type
        FROM payments_log pl
        JOIN sales s ON s.id = pl.related_id
        WHERE ${where}
        ORDER BY pl.date DESC, pl.created_at DESC
        LIMIT ? OFFSET ?
      `;

      const result = await tenantDb.query(query, [...params, pageSize, offset]);
      payments = result.rows || [];
    }

    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

    return res.json({
      ok: true,
      payments,
      total: totalCount,
      total_amount: totalAmount,
      total_due: balanceSummary.total_due,
      total_invoiced: balanceSummary.total_invoiced,
      total_paid_overall: balanceSummary.total_paid,
      meta: {
        page: pageNum,
        page_size: pageSize,
        total: totalCount,
        total_pages: totalPages
      },
      portal_type: activeMem.portal_type,
      company: {
        id: activeMem.company_id,
        name: activeMem.company_name,
        code: activeMem.company_code,
        currency: activeMem.currency || 'INR'
      }
    });
  } catch (err) {
    console.error('portal payments error:', err);
    return res.status(500).json({ error: 'Failed to fetch payment ledger: ' + err.message });
  }
});

// ORDER WORKFLOW ACTIONS (Accept / Reject / Dispatch / Confirm Delivery)
router.post(['/orders/:id/action', '/portal/orders/:id/action'], requireUniversalPortalAuth, async (req, res) => {
  const { id } = req.params;
  let {
    company_id,
    action,
    reason,
    dispatch_tracking_ref,
    vendor_notes,
    tracking_ref,
    notes,
    transporter_name,
    vehicle_number,
    dispatch_date,
    vendor_contact,
    vendor_address
  } = req.body;
  const globalUser = req.portalUser;

  if (!action) {
    return res.status(400).json({ error: 'action is required' });
  }

  const effectiveTracking = dispatch_tracking_ref || tracking_ref || transporter_name || 'Handed to Logistics';
  let formattedNotes = vendor_notes || notes || '';
  const detailsParts = [];
  if (transporter_name) detailsParts.push(`Carrier: ${transporter_name}${vehicle_number ? ` (${vehicle_number})` : ''}`);
  if (vendor_contact) detailsParts.push(`Vendor Contact: ${vendor_contact}`);
  if (vendor_address) detailsParts.push(`Dispatch Pickup Address: ${vendor_address}`);
  if (detailsParts.length > 0 && !formattedNotes.includes('Carrier:') && !formattedNotes.includes('Dispatch Pickup Address:')) {
    formattedNotes = `${detailsParts.join(' | ')}${formattedNotes ? `\nNotes: ${formattedNotes}` : ''}`.trim();
  }

  try {
    let membership = null;
    if (company_id) {
      const memRes = await queryMaster(
        `SELECT gpm.*, c.database_name, c.company_name
         FROM global_portal_memberships gpm
         JOIN companies c ON c.id = gpm.company_id
         WHERE gpm.global_user_id = ? AND gpm.company_id = ? AND gpm.status = 'Active'`,
        [globalUser.id, company_id]
      );
      if (memRes.rowCount > 0) membership = memRes.rows[0];
    } else {
      const allMems = await queryMaster(
        `SELECT gpm.*, c.database_name, c.company_name
         FROM global_portal_memberships gpm
         JOIN companies c ON c.id = gpm.company_id
         WHERE gpm.global_user_id = ? AND gpm.status = 'Active'`,
        [globalUser.id]
      );
      for (const m of allMems.rows) {
        try {
          const tDb = getTenantPool(m.database_name);
          if (m.portal_type === 'vendor') {
            const chk = await tDb.query(
              `SELECT id FROM procurements WHERE id = ? 
               UNION 
               SELECT id FROM purchase_orders WHERE id = ? AND deleted_at IS NULL`,
              [id, id]
            );
            if (chk.rowCount > 0) {
              membership = m;
              break;
            }
          } else {
            const chk = await tDb.query(`SELECT id FROM sales WHERE id = ? AND deleted_at IS NULL`, [id]);
            if (chk.rowCount > 0) {
              membership = m;
              break;
            }
          }
        } catch (e) {}
      }
    }

    if (!membership) {
      return res.status(404).json({ error: 'Order not found in your active connected workspaces' });
    }

    const tenantDb = getTenantPool(membership.database_name);

    if (membership.portal_type === 'vendor') {
      const vMatch = await tenantDb.query(
        `SELECT id FROM vendors 
         WHERE id = ? 
            OR global_user_id = ? 
            OR (email IS NOT NULL AND LOWER(email) = LOWER(?))
            OR (phone IS NOT NULL AND phone != '' AND phone = ?)`,
        [membership.entity_id, globalUser.id, globalUser.email, globalUser.phone || '']
      );
      const matchedVendorIds = Array.from(new Set([membership.entity_id, ...vMatch.rows.map(r => r.id)].filter(Boolean)));
      const vPlaceholders = matchedVendorIds.map(() => '?').join(',');

      let pRes = await tenantDb.query(`SELECT * FROM procurements WHERE id = ? AND vendor_id IN (${vPlaceholders})`, [id, ...matchedVendorIds]);
      let isPoTable = false;
      if (pRes.rowCount === 0) {
        pRes = await tenantDb.query(`SELECT * FROM purchase_orders WHERE id = ? AND vendor_id IN (${vPlaceholders}) AND deleted_at IS NULL`, [id, ...matchedVendorIds]);
        if (pRes.rowCount === 0) return res.status(404).json({ error: 'Order not found' });
        isPoTable = true;
      }
      const orderRow = pRes.rows[0];

      if (action === 'accept') {
        const newStatus = 'Confirmed by Vendor';
        if (isPoTable) {
          await tenantDb.query('UPDATE purchase_orders SET status = ?, notes = COALESCE(?, notes), updated_at = NOW() WHERE id = ?', [newStatus, formattedNotes || null, id]);
        } else {
          await tenantDb.query('UPDATE procurements SET status = ?, vendor_notes = COALESCE(?, vendor_notes), updated_at = NOW() WHERE id = ?', [newStatus, formattedNotes || null, id]);
          if (orderRow.purchase_order_id) {
            await tenantDb.query('UPDATE purchase_orders SET status = ?, updated_at = NOW() WHERE id = ?', [newStatus, orderRow.purchase_order_id]).catch(() => {});
          }
        }
        await createNotification(tenantDb, {
          user_type: 'user',
          title: 'Purchase Order Confirmed by Vendor',
          message: `Vendor has accepted and confirmed Purchase Order ${orderRow.procurement_number || orderRow.po_number || id}.`,
          link: '/procurement'
        }).catch(() => {});

        return res.json({ ok: true, message: 'Purchase Order accepted and confirmed successfully.', new_status: newStatus });
      } else if (action === 'reject') {
        const newStatus = 'Rejected by Vendor';
        const cleanReason = (reason || '').trim();
        if (!cleanReason) {
          return res.status(400).json({ error: 'A reason is required when declining or cancelling an order.' });
        }
        if (isPoTable) {
          await tenantDb.query(
            'UPDATE purchase_orders SET status = ?, notes = CONCAT(COALESCE(notes, ""), "\n[Declined: ", ?, "]"), updated_at = NOW() WHERE id = ?',
            [newStatus, cleanReason, id]
          );
        } else {
          await tenantDb.query(
            'UPDATE procurements SET status = ?, rejection_reason = ?, vendor_notes = COALESCE(?, vendor_notes), updated_at = NOW() WHERE id = ?',
            [newStatus, cleanReason, formattedNotes || null, id]
          );
          if (orderRow.purchase_order_id) {
            await tenantDb.query(
              'UPDATE purchase_orders SET status = ?, notes = CONCAT(COALESCE(notes, ""), "\n[Declined: ", ?, "]"), updated_at = NOW() WHERE id = ?',
              [newStatus, cleanReason, orderRow.purchase_order_id]
            ).catch(() => {});
          }
        }
        await createNotification(tenantDb, {
          user_type: 'user',
          title: 'Order Declined by Vendor',
          message: `Vendor declined Order ${orderRow.procurement_number || orderRow.po_number || id}. Reason: ${cleanReason}`,
          link: '/procurement'
        }).catch(() => {});

        return res.json({ ok: true, message: 'Purchase Order rejected/cancelled.', new_status: newStatus });
      } else if (action === 'dispatch') {
        const newStatus = 'Dispatched by Vendor';
        const dDate = dispatch_date || new Date().toISOString().slice(0, 10);
        if (isPoTable) {
          await tenantDb.query(
            'UPDATE purchase_orders SET status = ?, dispatch_tracking_ref = ?, dispatch_date = ?, notes = CONCAT(COALESCE(notes, ""), "\n", ?), updated_at = NOW() WHERE id = ?',
            [newStatus, effectiveTracking, dDate, formattedNotes || '', id]
          );
        } else {
          await tenantDb.query(
            'UPDATE procurements SET status = ?, dispatch_tracking_ref = ?, dispatch_date = ?, vendor_notes = COALESCE(?, vendor_notes), updated_at = NOW() WHERE id = ?',
            [newStatus, effectiveTracking, dDate, formattedNotes || null, id]
          );
          if (orderRow.purchase_order_id) {
            await tenantDb.query(
              'UPDATE purchase_orders SET status = ?, dispatch_tracking_ref = ?, dispatch_date = ?, updated_at = NOW() WHERE id = ?',
              [newStatus, effectiveTracking, dDate, orderRow.purchase_order_id]
            ).catch(() => {});
          }
        }
        await createNotification(tenantDb, {
          user_type: 'user',
          title: 'Shipment Dispatched by Vendor',
          message: `Vendor dispatched Order ${orderRow.procurement_number || orderRow.po_number || id}. Carrier: ${effectiveTracking}. Ready to receive in Procurement!`,
          link: '/procurement'
        }).catch(() => {});

        return res.json({
          ok: true,
          message: 'Shipment dispatched successfully! Logistics details recorded.',
          new_status: newStatus,
          dispatch_tracking_ref: effectiveTracking
        });
      }
    } else {
      // Customer Actions
      const cMatch = await tenantDb.query(
        `SELECT id FROM customers 
         WHERE id = ? 
            OR global_user_id = ? 
            OR (email IS NOT NULL AND LOWER(email) = LOWER(?))
            OR (phone IS NOT NULL AND phone != '' AND phone = ?)`,
        [membership.entity_id, globalUser.id, globalUser.email, globalUser.phone || '']
      );
      const matchedCustomerIds = Array.from(new Set([membership.entity_id, ...cMatch.rows.map(r => r.id)].filter(Boolean)));
      const cPlaceholders = matchedCustomerIds.map(() => '?').join(',');

      const sRes = await tenantDb.query(`SELECT * FROM sales WHERE id = ? AND customer_id IN (${cPlaceholders})`, [id, ...matchedCustomerIds]);
      if (sRes.rowCount === 0) return res.status(404).json({ error: 'Order not found' });

      if (action === 'confirm_order') {
        await tenantDb.query('UPDATE sales SET status = \'Confirmed by Customer\' WHERE id = ?', [id]);
        return res.json({ ok: true, message: 'Sales order confirmed.', new_status: 'Confirmed by Customer' });
      } else if (action === 'decline_order') {
        await tenantDb.query('UPDATE sales SET status = \'Declined by Customer\', decline_reason = ? WHERE id = ?', [reason || 'Declined by customer', id]);
        return res.json({ ok: true, message: 'Sales order declined.', new_status: 'Declined by Customer' });
      } else if (action === 'receive_goods' || action === 'confirm_delivery') {
        const newStatus = 'Goods Received';
        await tenantDb.query(
          "UPDATE sales SET status = ?, delivered_date = NOW(), updated_at = NOW() WHERE id = ?",
          [newStatus, id]
        );

        const custInfo = cMatch.rows[0]?.name || globalUser.name || 'Customer';
        await createNotification(tenantDb, {
          user_type: 'user',
          title: 'Goods Received by Customer',
          message: `${custInfo} confirmed receipt of goods for Order ${sRes.rows[0].invoice_number || id}.`,
          link: '/sales'
        }).catch(() => {});

        return res.json({
          ok: true,
          message: 'Goods received confirmed successfully!',
          new_status: newStatus
        });
      } else if (action === 'request_return' || action === 'return_order') {
        const cleanReason = (reason || '').trim();
        if (!cleanReason) {
          return res.status(400).json({ error: 'A return reason is required.' });
        }

        const returnId = crypto.randomUUID();
        const reqNum = `RR-${Date.now().toString().slice(-4)}`;
        const returnItems = req.body.items ? JSON.stringify(req.body.items) : (req.body.item_description ? JSON.stringify([{ item_description: req.body.item_description, quantity: req.body.quantity || 1, notes: req.body.notes || '' }]) : null);

        await tenantDb.query(
          `INSERT INTO return_requests (
            id, request_number, request_type, reference_id, reference_type,
            requested_by_type, customer_id, reason, items, status, created_at
          ) VALUES (?, ?, 'sales_return', ?, 'invoice', 'customer_portal', ?, ?, ?, 'Pending', NOW())`,
          [returnId, reqNum, id, membership.entity_id, cleanReason, returnItems]
        );

        const newStatus = 'Return Requested';
        await tenantDb.query('UPDATE sales SET status = ?, updated_at = NOW() WHERE id = ?', [newStatus, id]);

        const custInfo = cMatch.rows[0]?.name || globalUser.name || 'Customer';
        await createNotification(tenantDb, {
          user_type: 'user',
          title: 'Customer Return Requested',
          message: `${custInfo} requested a return for Order ${sRes.rows[0].invoice_number || id}. Reason: ${cleanReason}`,
          link: '/sales'
        }).catch(() => {});

        return res.json({
          ok: true,
          message: 'Return request submitted successfully!',
          new_status: newStatus,
          request_number: reqNum
        });
      }
    }

    return res.status(400).json({ error: 'Unrecognized action: ' + action });
  } catch (err) {
    console.error('order action error:', err);
    return res.status(500).json({ error: 'Failed to process action: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSAL PORTAL: RETURNS PAGE API
// ─────────────────────────────────────────────────────────────────────────────

router.get(['/returns', '/portal/returns'], requireUniversalPortalAuth, async (req, res) => {
  const globalUser = req.portalUser;
  const { company_id, status, search } = req.query;

  try {
    const membershipsRes = await queryMaster(
      `SELECT gpm.*, c.company_name, c.company_code, c.database_name, c.currency, c.logo_url
       FROM global_portal_memberships gpm
       JOIN companies c ON c.id = gpm.company_id
       WHERE gpm.global_user_id = ?
         AND gpm.status = 'Active'
         AND c.status NOT IN ('suspended', 'cancelled', 'paused', 'deleted')
       ORDER BY gpm.created_at ASC`,
      [globalUser.id]
    );

    if (membershipsRes.rowCount === 0) {
      return res.json({ ok: true, returns: [], total: 0, portal_type: null, company: null });
    }

    let activeMem = company_id ? membershipsRes.rows.find((m) => m.company_id === company_id) : null;
    if (!activeMem) activeMem = membershipsRes.rows[0];

    const tenantDb = getTenantPool(activeMem.database_name);
    let params = [];
    let where = '1=1';

    if (activeMem.portal_type === 'customer') {
      where += ' AND rr.customer_id = ?';
      params.push(activeMem.entity_id);
    } else {
      where += ' AND rr.vendor_id = ?';
      params.push(activeMem.entity_id);
    }

    if (status && status !== 'all') {
      where += ' AND rr.status = ?';
      params.push(status);
    }
    if (search && search.trim()) {
      where += ' AND (rr.reason LIKE ? OR rr.request_number LIKE ? OR rr.id LIKE ?)';
      params.push(`%${search.trim()}%`, `%${search.trim()}%`, `%${search.trim()}%`);
    }

    const query = `
      SELECT 
        rr.id,
        rr.request_number,
        rr.request_type,
        rr.reference_id,
        rr.reference_type,
        rr.reason,
        rr.items,
        rr.review_notes AS resolution_notes,
        COALESCE(rr.status, 'Pending') AS status,
        rr.created_at,
        rr.updated_at
      FROM return_requests rr
      WHERE ${where}
      ORDER BY rr.created_at DESC
    `;

    const result = await tenantDb.query(query, params).catch(() => ({ rows: [] }));

    return res.json({
      ok: true,
      returns: result.rows || [],
      total: (result.rows || []).length,
      portal_type: activeMem.portal_type,
      company: {
        id: activeMem.company_id,
        name: activeMem.company_name,
        code: activeMem.company_code,
        currency: activeMem.currency || 'INR'
      }
    });
  } catch (err) {
    console.error('portal returns error:', err);
    return res.status(500).json({ error: 'Failed to fetch returns: ' + err.message });
  }
});

router.post(['/returns', '/portal/returns'], requireUniversalPortalAuth, async (req, res) => {
  const { company_id, order_id, invoice_id, reason, notes, item_description, quantity } = req.body;
  const globalUser = req.portalUser;

  if (!company_id || !reason) {
    return res.status(400).json({ error: 'company_id and reason are required' });
  }

  try {
    const memRes = await queryMaster(
      `SELECT gpm.*, c.database_name, c.company_name
       FROM global_portal_memberships gpm
       JOIN companies c ON c.id = gpm.company_id
       WHERE gpm.global_user_id = ? AND gpm.company_id = ? AND gpm.status = 'Active'`,
      [globalUser.id, company_id]
    );

    if (memRes.rowCount === 0) return res.status(403).json({ error: 'Unauthorized for this workspace context' });
    const membership = memRes.rows[0];
    const tenantDb = getTenantPool(membership.database_name);

    const returnId = crypto.randomUUID();
    const isCustomer = membership.portal_type === 'customer';
    const reqNum = `RR-${Date.now().toString().slice(-4)}`;
    const reqType = isCustomer ? 'sales_return' : 'purchase_return';
    const refId = order_id || invoice_id || crypto.randomUUID();
    const refType = isCustomer ? 'invoice' : 'procurement';
    const itemsJson = JSON.stringify([{ item_description: item_description || 'Item Return', quantity: quantity || 1, notes: notes || '' }]);

    await tenantDb.query(
      `INSERT INTO return_requests (
        id, request_number, request_type, reference_id, reference_type,
        requested_by_type, customer_id, vendor_id, reason, items, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', NOW())`,
      [
        returnId,
        reqNum,
        reqType,
        refId,
        refType,
        isCustomer ? 'customer_portal' : 'vendor_portal',
        isCustomer ? membership.entity_id : null,
        !isCustomer ? membership.entity_id : null,
        reason.trim(),
        itemsJson
      ]
    );

    return res.status(201).json({
      ok: true,
      message: 'Return request submitted successfully. The client workspace will review your request.',
      return_id: returnId
    });
  } catch (err) {
    console.error('submit return error:', err);
    return res.status(500).json({ error: 'Failed to submit return request: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Vendor decision for a return initiated in the ERP procurement screen.
// Current vendor invitations use this universal portal, so decisions belong here.
router.post(['/returns/:id/accept', '/portal/returns/:id/accept'], requireUniversalPortalAuth, async (req, res) => {
  const { company_id, notes } = req.body;
  if (!company_id) return res.status(400).json({ error: 'company_id is required' });
  try {
    const membershipRes = await queryMaster(
      `SELECT gpm.*, c.database_name FROM global_portal_memberships gpm JOIN companies c ON c.id = gpm.company_id
       WHERE gpm.global_user_id = ? AND gpm.company_id = ? AND gpm.status = 'Active'`,
      [req.portalUser.id, company_id]
    );
    const membership = membershipRes.rows[0];
    if (!membership || membership.portal_type !== 'vendor') return res.status(403).json({ error: 'Vendor portal access is required' });
    const tenantDb = getTenantPool(membership.database_name);
    const requestRes = await tenantDb.query(
      `SELECT id, reference_id, request_type, status FROM return_requests WHERE id = ? AND vendor_id = ?`,
      [req.params.id, membership.entity_id]
    );
    const returnRequest = requestRes.rows[0];
    if (!returnRequest) return res.status(404).json({ error: 'Return request not found' });
    if (!['purchase_return', 'purchase_cancellation'].includes(returnRequest.request_type)) return res.status(400).json({ error: 'This is not a vendor return request' });
    if (returnRequest.status !== 'Pending') return res.status(409).json({ error: 'This return request has already been reviewed' });

    await tenantDb.query(`UPDATE return_requests SET status = 'Approved', review_notes = ?, reviewed_at = NOW(), updated_at = NOW() WHERE id = ? AND status = 'Pending'`, [(notes || 'Accepted by vendor').trim(), returnRequest.id]);
    await tenantDb.query("UPDATE procurements SET status = 'Return Accepted by Vendor', updated_at = NOW() WHERE id = ? AND vendor_id = ? AND deleted_at IS NULL", [returnRequest.reference_id, membership.entity_id]);

    // Auto-close chat
    await insertSystemMessage(
      tenantDb, returnRequest.id,
      `✅ Vendor has Approved this return request. ${notes ? `Notes: ${notes.trim()}` : ''} The chat is now closed and contact information is available.`
    );

    return res.json({ ok: true, message: 'Return request accepted', status: 'Approved', procurement_status: 'Return Accepted by Vendor' });
  } catch (err) {
    console.error('vendor portal return acceptance error:', err);
    return res.status(500).json({ error: 'Failed to accept return request' });
  }
});

router.post(['/returns/:id/reject', '/portal/returns/:id/reject'], requireUniversalPortalAuth, async (req, res) => {
  const { company_id, reason } = req.body;
  if (!company_id || !reason || String(reason).trim().length < 3) return res.status(400).json({ error: 'company_id and a rejection reason are required' });
  try {
    const membershipRes = await queryMaster(
      `SELECT gpm.*, c.database_name FROM global_portal_memberships gpm JOIN companies c ON c.id = gpm.company_id
       WHERE gpm.global_user_id = ? AND gpm.company_id = ? AND gpm.status = 'Active'`,
      [req.portalUser.id, company_id]
    );
    const membership = membershipRes.rows[0];
    if (!membership || membership.portal_type !== 'vendor') return res.status(403).json({ error: 'Vendor portal access is required' });
    const tenantDb = getTenantPool(membership.database_name);
    const requestRes = await tenantDb.query(
      `SELECT id, reference_id, request_type, status FROM return_requests WHERE id = ? AND vendor_id = ?`,
      [req.params.id, membership.entity_id]
    );
    const returnRequest = requestRes.rows[0];
    if (!returnRequest) return res.status(404).json({ error: 'Return request not found' });
    if (!['purchase_return', 'purchase_cancellation'].includes(returnRequest.request_type)) return res.status(400).json({ error: 'This is not a vendor return request' });
    if (returnRequest.status !== 'Pending') return res.status(409).json({ error: 'This return request has already been reviewed' });

    const cleanReason = String(reason).trim();
    await tenantDb.query(`UPDATE return_requests SET status = 'Rejected', review_notes = ?, reviewed_at = NOW(), updated_at = NOW() WHERE id = ? AND status = 'Pending'`, [cleanReason, returnRequest.id]);
    await tenantDb.query("UPDATE procurements SET status = 'Return Rejected by Vendor', rejection_reason = ?, updated_at = NOW() WHERE id = ? AND vendor_id = ? AND deleted_at IS NULL", [cleanReason, returnRequest.reference_id, membership.entity_id]);

    // Auto-close chat
    await insertSystemMessage(
      tenantDb, returnRequest.id,
      `❌ Vendor has Rejected this return request. Reason: ${cleanReason} The chat is now closed.`
    );

    return res.json({ ok: true, message: 'Return request rejected', status: 'Rejected', procurement_status: 'Return Rejected by Vendor' });
  } catch (err) {
    console.error('vendor portal return rejection error:', err);
    return res.status(500).json({ error: 'Failed to reject return request' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSAL PORTAL: RETURN REQUEST CHAT MESSAGES
// GET  /portal/returns/:id/messages  — read all messages
// POST /portal/returns/:id/messages  — send a message
// ─────────────────────────────────────────────────────────────────────────────

router.get(['/returns/:id/messages', '/portal/returns/:id/messages'], requireUniversalPortalAuth, async (req, res) => {
  const { company_id } = req.query;
  if (!company_id) return res.status(400).json({ error: 'company_id is required' });

  try {
    const membershipRes = await queryMaster(
      `SELECT gpm.*, c.database_name FROM global_portal_memberships gpm
       JOIN companies c ON c.id = gpm.company_id
       WHERE gpm.global_user_id = ? AND gpm.company_id = ? AND gpm.status = 'Active'`,
      [req.portalUser.id, company_id]
    );
    if (membershipRes.rowCount === 0) return res.status(403).json({ error: 'Unauthorized' });
    const membership = membershipRes.rows[0];
    const tenantDb = getTenantPool(membership.database_name);

    // IDOR: verify the return request belongs to this portal user's entity
    const rrRes = await tenantDb.query(
      'SELECT id, vendor_id, customer_id FROM return_requests WHERE id = ?',
      [req.params.id]
    );
    if (rrRes.rowCount === 0) return res.status(404).json({ error: 'Return request not found' });
    const rr = rrRes.rows[0];
    const ownedByEntity =
      (membership.portal_type === 'vendor' && rr.vendor_id === membership.entity_id) ||
      (membership.portal_type === 'customer' && rr.customer_id === membership.entity_id);
    if (!ownedByEntity) return res.status(403).json({ error: 'Access denied' });

    const result = await tenantDb.query(
      `SELECT id, sender_type, sender_id, sender_name, message, is_system, created_at
       FROM return_request_messages
       WHERE return_request_id = ?
       ORDER BY created_at ASC`,
      [req.params.id]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('portal get messages error:', err);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

router.post(['/returns/:id/messages', '/portal/returns/:id/messages'], requireUniversalPortalAuth, async (req, res) => {
  const { company_id, message } = req.body;
  if (!company_id) return res.status(400).json({ error: 'company_id is required' });
  if (!message || String(message).trim().length === 0) return res.status(400).json({ error: 'message is required' });

  try {
    const membershipRes = await queryMaster(
      `SELECT gpm.*, c.database_name FROM global_portal_memberships gpm
       JOIN companies c ON c.id = gpm.company_id
       WHERE gpm.global_user_id = ? AND gpm.company_id = ? AND gpm.status = 'Active'`,
      [req.portalUser.id, company_id]
    );
    if (membershipRes.rowCount === 0) return res.status(403).json({ error: 'Unauthorized' });
    const membership = membershipRes.rows[0];
    const tenantDb = getTenantPool(membership.database_name);

    // IDOR + status
    const rrRes = await tenantDb.query(
      'SELECT id, vendor_id, customer_id, status FROM return_requests WHERE id = ?',
      [req.params.id]
    );
    if (rrRes.rowCount === 0) return res.status(404).json({ error: 'Return request not found' });
    const rr = rrRes.rows[0];
    const ownedByEntity =
      (membership.portal_type === 'vendor' && rr.vendor_id === membership.entity_id) ||
      (membership.portal_type === 'customer' && rr.customer_id === membership.entity_id);
    if (!ownedByEntity) return res.status(403).json({ error: 'Access denied' });
    if (rr.status !== 'Pending') return res.status(409).json({ error: 'Chat is closed — this request has already been resolved.' });

    const senderType = membership.portal_type === 'vendor' ? 'vendor' : 'customer';
    const senderName = req.portalUser.name || req.portalUser.email || (membership.portal_type === 'vendor' ? 'Vendor' : 'Customer');
    const msgId = crypto.randomUUID();

    await tenantDb.query(
      `INSERT INTO return_request_messages
         (id, return_request_id, sender_type, sender_id, sender_name, message, is_system)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [msgId, req.params.id, senderType, req.portalUser.id, senderName, message.trim()]
    );

    const fetched = await tenantDb.query('SELECT * FROM return_request_messages WHERE id = ?', [msgId]);
    publishReturnRequestMessage(tenantDb, req.params.id, fetched.rows[0]);
    return res.status(201).json(fetched.rows[0]);
  } catch (err) {
    console.error('portal send message error:', err);
    return res.status(500).json({ error: 'Failed to send message' });
  }
});

// VENDOR PORTAL: AUTH & WORKSPACE SWITCHING
// ─────────────────────────────────────────────────────────────────────────────

router.post('/vendor-portal/auth/login', async (req, res) => {
  const { email, password, company_id } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  try {
    let globalUser = await getGlobalPortalUserByEmail(normalizedEmail);

    // If not found in global table, check if tenant DB has a legacy user and auto-migrate
    if (!globalUser) {
      const companiesRes = await queryMaster("SELECT id, database_name FROM companies WHERE status = 'active'");
      for (const comp of companiesRes.rows) {
        try {
          const tenantDb = getTenantPool(comp.database_name);
          const legacyRes = await tenantDb.query('SELECT * FROM vendor_portal_users WHERE email = ?', [normalizedEmail]);
          if (legacyRes.rowCount > 0 && legacyRes.rows[0].password_hash) {
            const legacyUser = legacyRes.rows[0];
            const validLegacy = await bcrypt.compare(password, legacyUser.password_hash);
            if (validLegacy) {
              globalUser = await createOrUpdateGlobalPortalUser({
                email: normalizedEmail,
                name: legacyUser.name,
                passwordHash: legacyUser.password_hash
              });
              await queryMaster(
                `INSERT IGNORE INTO global_portal_memberships (id, global_user_id, company_id, entity_id, portal_type, status, joined_at)
                 VALUES (?, ?, ?, ?, 'vendor', 'Active', NOW())`,
                [crypto.randomUUID(), globalUser.id, comp.id, legacyUser.vendor_id]
              );
              break;
            }
          }
        } catch (e) {
          // ignore tenant probe error
        }
      }
    }

    if (!globalUser || !globalUser.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials or account setup incomplete. Please accept your invite first.' });
    }

    const valid = await bcrypt.compare(password, globalUser.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Fetch all active company memberships for this vendor
    const memberships = await getGlobalUserMemberships(globalUser.id, 'vendor');
    if (memberships.length === 0) {
      return res.status(403).json({ error: 'No active company workspaces found for this vendor account' });
    }

    // Determine active company: use requested company_id if valid, otherwise default to first membership
    let activeMembership = company_id ? memberships.find((m) => m.company_id === company_id) : null;
    if (!activeMembership) activeMembership = memberships[0];

    const tenantDb = getTenantPool(activeMembership.database_name);
    const localUserId = await syncTenantPortalUser(tenantDb, 'vendor', globalUser, activeMembership.entity_id, activeMembership.company_id);

    await queryMaster('UPDATE global_portal_users SET last_login_at = NOW() WHERE id = ?', [globalUser.id]);
    await tenantDb.query('UPDATE vendor_portal_users SET last_login_at = NOW() WHERE id = ?', [localUserId]).catch(() => {});
    await tenantDb.query("UPDATE vendors SET connection_status = 'connected' WHERE id = ?", [activeMembership.entity_id]).catch(() => {});

    const tokenPayload = {
      portal_type: 'vendor',
      global_user_id: globalUser.id,
      portal_user_id: localUserId,
      vendor_id: activeMembership.entity_id,
      company_id: activeMembership.company_id,
      database_name: activeMembership.database_name,
      name: globalUser.name,
      email: globalUser.email
    };
    const token = signPortalToken(tokenPayload);
    setPortalCookie(res, 'erp_vendor_portal_token', token);

    const companiesList = memberships.map((m) => ({
      id: m.company_id,
      name: m.company_name,
      code: m.company_code,
      currency: m.currency || 'INR',
      number_system: m.number_system || 'indian',
      logo_url: m.logo_url,
      vendor_id: m.entity_id
    }));

    return res.json({
      ok: true,
      token,
      portal_type: 'vendor',
      user: { id: globalUser.id, name: globalUser.name, email: globalUser.email },
      active_company: {
        id: activeMembership.company_id,
        name: activeMembership.company_name,
        code: activeMembership.company_code,
        currency: activeMembership.currency || 'INR',
        number_system: activeMembership.number_system || 'indian',
        logo_url: activeMembership.logo_url,
        vendor_id: activeMembership.entity_id
      },
      companies: companiesList
    });
  } catch (err) {
    console.error('vendor portal login error:', err);
    return res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

// VENDOR PORTAL: SWITCH ACTIVE COMPANY
router.post('/vendor-portal/auth/switch-company', async (req, res) => {
  const { company_id } = req.body;
  if (!company_id) return res.status(400).json({ error: 'company_id is required' });

  const auth = req.headers.authorization;
  const token = (auth && auth.startsWith('Bearer ') ? auth.slice(7) : null) || extractCookieToken(req, 'erp_vendor_portal_token');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  if (payload.portal_type !== 'vendor') return res.status(403).json({ error: 'Invalid portal token type' });

  try {
    const globalUser = await getGlobalPortalUserByEmail(payload.email);
    if (!globalUser) return res.status(401).json({ error: 'User not found' });

    const memberships = await getGlobalUserMemberships(globalUser.id, 'vendor');
    const targetMembership = memberships.find((m) => m.company_id === company_id);

    if (!targetMembership) {
      return res.status(403).json({ error: 'You do not have access to this workspace' });
    }

    const tenantDb = getTenantPool(targetMembership.database_name);
    const localUserId = await syncTenantPortalUser(tenantDb, 'vendor', globalUser, targetMembership.entity_id, targetMembership.company_id);

    const nextPayload = {
      portal_type: 'vendor',
      global_user_id: globalUser.id,
      portal_user_id: localUserId,
      vendor_id: targetMembership.entity_id,
      company_id: targetMembership.company_id,
      database_name: targetMembership.database_name,
      name: globalUser.name,
      email: globalUser.email
    };
    const nextToken = signPortalToken(nextPayload);
    setPortalCookie(res, 'erp_vendor_portal_token', nextToken);

    const companiesList = memberships.map((m) => ({
      id: m.company_id,
      name: m.company_name,
      code: m.company_code,
      currency: m.currency || 'INR',
      logo_url: m.logo_url,
      vendor_id: m.entity_id
    }));

    return res.json({
      ok: true,
      token: nextToken,
      portal_type: 'vendor',
      user: { id: globalUser.id, name: globalUser.name, email: globalUser.email },
      active_company: {
        id: targetMembership.company_id,
        name: targetMembership.company_name,
        code: targetMembership.company_code,
        currency: targetMembership.currency || 'INR',
        logo_url: targetMembership.logo_url,
        vendor_id: targetMembership.entity_id
      },
      companies: companiesList
    });
  } catch (err) {
    console.error('vendor portal switch company error:', err);
    return res.status(500).json({ error: 'Failed to switch company: ' + err.message });
  }
});

// VENDOR PORTAL: GET CURRENT SESSION INFO & AVAILABLE WORKSPACES
router.get('/vendor-portal/auth/me', async (req, res) => {
  const auth = req.headers.authorization;
  const token = (auth && auth.startsWith('Bearer ') ? auth.slice(7) : null) || extractCookieToken(req, 'erp_vendor_portal_token');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.portal_type !== 'vendor') return res.status(403).json({ error: 'Invalid portal token' });

    const globalUser = await getGlobalPortalUserByEmail(payload.email);
    if (!globalUser) return res.status(401).json({ error: 'User not found' });

    const memberships = await getGlobalUserMemberships(globalUser.id, 'vendor');
    const activeMembership = memberships.find((m) => m.company_id === payload.company_id) || memberships[0];

    return res.json({
      ok: true,
      user: { id: globalUser.id, name: globalUser.name, email: globalUser.email },
      active_company: activeMembership ? {
        id: activeMembership.company_id,
        name: activeMembership.company_name,
        code: activeMembership.company_code,
        currency: activeMembership.currency || 'INR',
        logo_url: activeMembership.logo_url,
        vendor_id: activeMembership.entity_id
      } : null,
      companies: memberships.map((m) => ({
        id: m.company_id,
        name: m.company_name,
        code: m.company_code,
        currency: m.currency || 'INR',
        logo_url: m.logo_url,
        vendor_id: m.entity_id
      }))
    });
  } catch (err) {
    return res.status(401).json({ error: 'Session expired or invalid' });
  }
});

// VENDOR PORTAL: INVITE (Internal staff invites a vendor)
router.post('/vendors/:id/portal-invite', requireAuth, requirePermission('parties', 'edit'), async (req, res) => {
  const { name, email, phone } = req.body;
  const vendorId = req.params.id;
  const companyId = req.user.company_id || req.user.workspace_id;

  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
  const normalizedEmail = email.toLowerCase().trim();

  try {
    const vendorRes = await req.tenantDb.query('SELECT * FROM vendors WHERE id = ? AND deleted_at IS NULL', [vendorId]);
    if (vendorRes.rowCount === 0) return res.status(404).json({ error: 'Vendor not found' });
    const vendor = vendorRes.rows[0];

    const vendorAddress = vendor.address_line1 || vendor.address || null;
    const vendorPhone = vendor.phone || vendor.contact || phone || null;
    const vendorContactPerson = vendor.contact_person_name || name || vendor.name;

    // 1. Check or create/update global portal user with all vendor details entered by ERP admin
    let globalUser = await createOrUpdateGlobalPortalUser({
      email: normalizedEmail,
      name: vendorContactPerson,
      phone: vendorPhone,
      company_name: vendor.name,
      gstin: vendor.gstin || null,
      pan: vendor.pan || (vendor.gstin && vendor.gstin.length === 15 ? vendor.gstin.slice(2, 12) : null),
      address: vendorAddress,
      city: vendor.city || null,
      state: vendor.state || null,
      pincode: vendor.pincode || null,
      business_type: 'Vendor / Supplier'
    });

    // 2. Check if membership already exists for this company
    const existingMembership = await queryMaster(
      'SELECT * FROM global_portal_memberships WHERE global_user_id = ? AND company_id = ? AND portal_type = ?',
      [globalUser.id, companyId, 'vendor']
    );

    const base = process.env.FRONTEND_URL || 'http://localhost:5173';

    const forceReinvite = Boolean(req.body.force_reinvite || req.body.reset_password);

    // If already member and active
    if (!forceReinvite && existingMembership.rowCount > 0 && existingMembership.rows[0].status === 'Active') {
      const inviteLink = `${base}/login?portal=partner&company=${companyId}`;
      return res.status(200).json({
        ok: true,
        already_registered: true,
        can_reinvite: true,
        message: 'This vendor is already connected to your portal.',
        invite_link: inviteLink
      });
    }

    // 3. If global user already has a password set from another company or previous signup
    if (!forceReinvite && globalUser.password_hash) {
      const membershipId = existingMembership.rowCount > 0 ? existingMembership.rows[0].id : crypto.randomUUID();
      if (existingMembership.rowCount > 0) {
        await queryMaster(
          'UPDATE global_portal_memberships SET entity_id = ?, status = ?, joined_at = NOW() WHERE id = ?',
          [vendorId, 'Active', membershipId]
        );
      } else {
        await queryMaster(
          `INSERT INTO global_portal_memberships (id, global_user_id, company_id, entity_id, portal_type, status, joined_at)
           VALUES (?, ?, ?, ?, 'vendor', 'Active', NOW())`,
          [membershipId, globalUser.id, companyId, vendorId]
        );
      }

      await syncTenantPortalUser(req.tenantDb, 'vendor', globalUser, vendorId, companyId);
      await req.tenantDb.query("UPDATE vendors SET connection_status = 'connected' WHERE id = ?", [vendorId]).catch(() => {});
      const inviteLink = `${base}/login?portal=partner&company=${companyId}`;

      return res.status(201).json({
        ok: true,
        already_registered: true,
        can_reinvite: true,
        portal_user_id: globalUser.id,
        email: normalizedEmail,
        invite_link: inviteLink,
        message: 'Vendor already has an active account on the platform. Your workspace has been linked immediately!'
      });
    }

    // 4. If global user does NOT have a password yet or force_reinvite is requested
    const inviteToken = crypto.randomBytes(32).toString('hex');
    const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const membershipId = existingMembership.rowCount > 0 ? existingMembership.rows[0].id : crypto.randomUUID();

    if (existingMembership.rowCount > 0) {
      await queryMaster(
        'UPDATE global_portal_memberships SET entity_id = ?, status = ?, invite_token = ?, invite_expires_at = ? WHERE id = ?',
        [vendorId, 'Pending', inviteToken, inviteExpires, membershipId]
      );
    } else {
      await queryMaster(
        `INSERT INTO global_portal_memberships (id, global_user_id, company_id, entity_id, portal_type, status, invite_token, invite_expires_at)
         VALUES (?, ?, ?, ?, 'vendor', 'Pending', ?, ?)`,
        [membershipId, globalUser.id, companyId, vendorId, inviteToken, inviteExpires]
      );
    }

    const localUserId = crypto.randomUUID();
    await req.tenantDb.query(
      `INSERT INTO vendor_portal_users (id, vendor_id, name, email, status, invite_token, invite_expires_at)
       VALUES (?, ?, ?, ?, 'Active', ?, ?)
       ON DUPLICATE KEY UPDATE invite_token = VALUES(invite_token), invite_expires_at = VALUES(invite_expires_at)`,
      [localUserId, vendorId, name.trim(), normalizedEmail, inviteToken, inviteExpires]
    ).catch(() => {});

    await req.tenantDb.query(
      "UPDATE vendors SET connection_status = 'invited' WHERE id = ? AND (connection_status IS NULL OR connection_status != 'connected')",
      [vendorId]
    ).catch(() => {});

    const inviteLink = `${base}/portal/accept-invite?token=${inviteToken}&company=${companyId}&type=vendor`;

    return res.status(201).json({
      ok: true,
      already_registered: false,
      reinvited: forceReinvite,
      portal_user_id: globalUser.id,
      email: normalizedEmail,
      invite_token: inviteToken,
      invite_link: inviteLink,
      expires_at: inviteExpires,
      message: forceReinvite
        ? 'A fresh activation and password setup link has been generated!'
        : 'Portal invitation generated successfully!'
    });
  } catch (err) {
    console.error('vendor portal invite error', err);
    return res.status(500).json({ error: 'Failed to create portal invite: ' + err.message });
  }
});

// SHARED PORTAL ACCEPT INVITE HANDLER
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

async function handlePortalAcceptInvite(req, res, forcedPortalType = null) {
  const { token, company_id, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: 'Token and password are required' });
  }
  const passError = validateStrongPassword(password);
  if (passError) {
    return res.status(400).json({ error: passError });
  }

  try {
    // 1. Look up membership by invite token
    const memRes = await queryMaster(
      'SELECT * FROM global_portal_memberships WHERE invite_token = ?',
      [token]
    );

    let membership = memRes.rowCount > 0 ? memRes.rows[0] : null;
    let globalUser = null;
    let targetCompanyId = company_id;
    let portalType = forcedPortalType || membership?.portal_type || 'vendor';

    if (membership) {
      if (membership.invite_expires_at && new Date(membership.invite_expires_at) <= new Date()) {
        return res.status(400).json({ error: 'Invite token has expired. Please request a new invite.' });
      }
      portalType = membership.portal_type || portalType;
      const userRes = await queryMaster('SELECT * FROM global_portal_users WHERE id = ?', [membership.global_user_id]);
      if (userRes.rowCount > 0) globalUser = userRes.rows[0];
      targetCompanyId = membership.company_id;
    }

    // Fallback: check tenant DB for legacy invite tokens
    if (!globalUser && targetCompanyId) {
      const tenantCtx = await resolveTenantFromCompanyId(targetCompanyId);
      if (tenantCtx) {
        const table = portalType === 'customer' ? 'customer_portal_users' : 'vendor_portal_users';
        const entityCol = portalType === 'customer' ? 'customer_id' : 'vendor_id';
        const localUserRes = await tenantCtx.tenantDb.query(`SELECT * FROM ${table} WHERE invite_token = ?`, [token]);
        if (localUserRes.rowCount > 0) {
          const localUser = localUserRes.rows[0];
          globalUser = await createOrUpdateGlobalPortalUser({ email: localUser.email, name: localUser.name });
          await queryMaster(
            `INSERT INTO global_portal_memberships (id, global_user_id, company_id, entity_id, portal_type, status, joined_at)
             VALUES (?, ?, ?, ?, ?, 'Active', NOW())
             ON DUPLICATE KEY UPDATE status = 'Active', joined_at = NOW()`,
            [crypto.randomUUID(), globalUser.id, targetCompanyId, localUser[entityCol], portalType]
          );
        }
      }
    }

    if (!globalUser) {
      return res.status(400).json({ error: 'Invalid or expired invite token' });
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Update global user password
    await queryMaster(
      'UPDATE global_portal_users SET password_hash = ?, last_login_at = NOW() WHERE id = ?',
      [hash, globalUser.id]
    );

    // Activate all memberships for this user
    await queryMaster(
      'UPDATE global_portal_memberships SET status = ?, joined_at = NOW(), invite_token = NULL, invite_expires_at = NULL WHERE global_user_id = ?',
      ['Active', globalUser.id]
    );

    const memberships = await getGlobalUserMemberships(globalUser.id, portalType);
    const activeMembership = memberships.find((m) => m.company_id === targetCompanyId) || memberships[0];

    if (!activeMembership) {
      return res.status(400).json({ error: 'No active workspace membership found for this invite' });
    }

    const tenantDb = getTenantPool(activeMembership.database_name);
    const localUserId = await syncTenantPortalUser(tenantDb, portalType, { ...globalUser, password_hash: hash }, activeMembership.entity_id, activeMembership.company_id);
    const entityTable = portalType === 'vendor' ? 'vendors' : 'customers';
    const userTable = portalType === 'vendor' ? 'vendor_portal_users' : 'customer_portal_users';
    await tenantDb.query(`UPDATE ${userTable} SET last_login_at = NOW(), invite_accepted_at = NOW() WHERE id = ?`, [localUserId]).catch(() => {});
    await tenantDb.query(`UPDATE ${entityTable} SET connection_status = 'connected' WHERE id = ?`, [activeMembership.entity_id]).catch(() => {});

    const tokenPayload = {
      portal_type: portalType,
      global_user_id: globalUser.id,
      portal_user_id: localUserId,
      entity_id: activeMembership.entity_id,
      vendor_id: portalType === 'vendor' ? activeMembership.entity_id : undefined,
      customer_id: portalType === 'customer' ? activeMembership.entity_id : undefined,
      company_id: activeMembership.company_id,
      database_name: activeMembership.database_name,
      name: globalUser.name,
      email: globalUser.email
    };
    const jwtToken = signPortalToken(tokenPayload);
    setPortalCookie(res, portalType === 'vendor' ? 'erp_vendor_portal_token' : 'erp_customer_portal_token', jwtToken);

    return res.json({
      ok: true,
      token: jwtToken,
      portal_type: portalType,
      user: { id: globalUser.id, name: globalUser.name, email: globalUser.email },
      company_id: activeMembership.company_id,
      active_company: {
        id: activeMembership.company_id,
        name: activeMembership.company_name,
        code: activeMembership.company_code,
        currency: activeMembership.currency || 'INR',
        logo_url: activeMembership.logo_url,
        entity_id: activeMembership.entity_id
      },
      companies: memberships.map((m) => ({
        id: m.company_id,
        name: m.company_name,
        code: m.company_code,
        currency: m.currency || 'INR',
        logo_url: m.logo_url,
        entity_id: m.entity_id
      })),
      message: 'Account activated successfully! Accessing your portal...'
    });
  } catch (err) {
    console.error('portal accept invite error', err);
    return res.status(500).json({ error: 'Failed to accept invitation: ' + err.message });
  }
}

// Check invite details (for partner portal invitations)
router.get(['/portal/auth/invite-info', '/auth/invite-info', '/vendor-portal/auth/invite-info', '/customer-portal/auth/invite-info'], async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ ok: false, error: 'Token is required' });

  try {
    const memRes = await queryMaster(
      `SELECT gpm.*, c.company_name, c.company_code, c.currency, gu.email, gu.name AS user_name, gu.password_hash
       FROM global_portal_memberships gpm
       JOIN companies c ON c.id = gpm.company_id
       JOIN global_portal_users gu ON gu.id = gpm.global_user_id
       WHERE gpm.invite_token = ?`,
      [token]
    );

    if (memRes.rowCount === 0) {
      // Check company_invites for internal workspace member invites
      const empRes = await queryMaster(
        `SELECT ci.*, c.company_name, c.company_code
         FROM company_invites ci
         JOIN companies c ON c.id = ci.company_id
         WHERE ci.token = ?`,
        [token]
      );

      if (empRes.rowCount === 0) {
        return res.status(404).json({ ok: false, error: 'Invalid or expired invitation link' });
      }

      const emp = empRes.rows[0];
      if (emp.expires_at && new Date(emp.expires_at) <= new Date()) {
        return res.status(400).json({ ok: false, error: 'This invitation link has expired. Please ask the company admin to re-invite you.' });
      }
      if (emp.accepted_at) {
        return res.status(400).json({ ok: false, error: 'This invitation has already been accepted. Please sign in.' });
      }

      return res.json({
        ok: true,
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

    const mem = memRes.rows[0];
    if (mem.invite_expires_at && new Date(mem.invite_expires_at) <= new Date()) {
      return res.status(400).json({ ok: false, error: 'This invitation link has expired. Please ask the company to re-invite you.' });
    }

    return res.json({
      ok: true,
      portal_type: mem.portal_type,
      company_id: mem.company_id,
      company_name: mem.company_name,
      company_code: mem.company_code,
      email: mem.email,
      name: mem.user_name,
      has_password: !!mem.password_hash
    });
  } catch (err) {
    console.error('get invite info error', err);
    return res.status(500).json({ ok: false, error: 'Failed to verify invitation' });
  }
});

// VENDOR PORTAL: ACCEPT INVITE
router.post('/vendor-portal/auth/accept-invite', (req, res) => handlePortalAcceptInvite(req, res, 'vendor'));
router.post(['/portal/auth/accept-invite', '/auth/accept-invite'], (req, res) => handlePortalAcceptInvite(req, res));

// VENDOR PORTAL: FORGOT & RESET PASSWORD
router.post('/vendor-portal/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  try {
    const globalUser = await getGlobalPortalUserByEmail(email);
    if (!globalUser || !globalUser.password_hash) {
      return res.json({ ok: true, message: 'If an active account exists, password reset instructions have been generated.' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours

    await queryMaster(
      'UPDATE global_portal_users SET password_hash = password_hash WHERE id = ?',
      [globalUser.id]
    );

    const base = process.env.FRONTEND_URL || 'http://localhost:5173';
    const resetLink = `${base}/vendor-portal/reset-password?token=${resetToken}&email=${encodeURIComponent(globalUser.email)}`;

    return res.json({
      ok: true,
      reset_link: resetLink,
      message: 'Password reset link generated successfully.'
    });
  } catch (err) {
    console.error('vendor forgot password error:', err);
    return res.status(500).json({ error: 'Failed to generate reset link' });
  }
});

router.post('/vendor-portal/auth/reset-password', async (req, res) => {
  const { token, email, new_password } = req.body;
  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ error: 'A 6+ character new password is required' });
  }

  try {
    const globalUser = await getGlobalPortalUserByEmail(email || '');
    if (!globalUser) return res.status(400).json({ error: 'Invalid or expired reset token' });

    const hash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
    await queryMaster(
      'UPDATE global_portal_users SET password_hash = ? WHERE id = ?',
      [hash, globalUser.id]
    );

    const memberships = await getGlobalUserMemberships(globalUser.id, 'vendor');
    if (memberships.length === 0) return res.status(400).json({ error: 'No active workspaces found' });

    const activeMembership = memberships[0];
    const tenantDb = getTenantPool(activeMembership.database_name);
    const localUserId = await syncTenantPortalUser(tenantDb, 'vendor', { ...globalUser, password_hash: hash }, activeMembership.entity_id, activeMembership.company_id);

    const tokenPayload = {
      portal_type: 'vendor',
      global_user_id: globalUser.id,
      portal_user_id: localUserId,
      vendor_id: activeMembership.entity_id,
      company_id: activeMembership.company_id,
      database_name: activeMembership.database_name,
      name: globalUser.name,
      email: globalUser.email
    };
    const jwtToken = signPortalToken(tokenPayload);
    setPortalCookie(res, 'erp_vendor_portal_token', jwtToken);

    return res.json({
      ok: true,
      token: jwtToken,
      user: { id: globalUser.id, name: globalUser.name, email: globalUser.email },
      message: 'Password reset successfully!'
    });
  } catch (err) {
    console.error('vendor reset password error:', err);
    return res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER PORTAL: AUTH & WORKSPACE SWITCHING
// ─────────────────────────────────────────────────────────────────────────────

router.post('/customer-portal/auth/login', async (req, res) => {
  const { email, password, company_id } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  try {
    let globalUser = await getGlobalPortalUserByEmail(normalizedEmail);

    // If not in global table, search tenant DBs for legacy migration
    if (!globalUser) {
      const companiesRes = await queryMaster("SELECT id, database_name FROM companies WHERE status = 'active'");
      for (const comp of companiesRes.rows) {
        try {
          const tenantDb = getTenantPool(comp.database_name);
          const legacyRes = await tenantDb.query('SELECT * FROM customer_portal_users WHERE email = ?', [normalizedEmail]);
          if (legacyRes.rowCount > 0 && legacyRes.rows[0].password_hash) {
            const legacyUser = legacyRes.rows[0];
            const validLegacy = await bcrypt.compare(password, legacyUser.password_hash);
            if (validLegacy) {
              globalUser = await createOrUpdateGlobalPortalUser({
                email: normalizedEmail,
                name: legacyUser.name,
                passwordHash: legacyUser.password_hash
              });
              await queryMaster(
                `INSERT IGNORE INTO global_portal_memberships (id, global_user_id, company_id, entity_id, portal_type, status, joined_at)
                 VALUES (?, ?, ?, ?, 'customer', 'Active', NOW())`,
                [crypto.randomUUID(), globalUser.id, comp.id, legacyUser.customer_id]
              );
              break;
            }
          }
        } catch (e) {
          // ignore probe error
        }
      }
    }

    if (!globalUser || !globalUser.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials or account setup incomplete. Please accept your invite first.' });
    }

    const valid = await bcrypt.compare(password, globalUser.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const memberships = await getGlobalUserMemberships(globalUser.id, 'customer');
    if (memberships.length === 0) {
      return res.status(403).json({ error: 'No active company workspaces found for this customer account' });
    }

    let activeMembership = company_id ? memberships.find((m) => m.company_id === company_id) : null;
    if (!activeMembership) activeMembership = memberships[0];

    const tenantDb = getTenantPool(activeMembership.database_name);
    const localUserId = await syncTenantPortalUser(tenantDb, 'customer', globalUser, activeMembership.entity_id, activeMembership.company_id);

    await queryMaster('UPDATE global_portal_users SET last_login_at = NOW() WHERE id = ?', [globalUser.id]);
    await tenantDb.query('UPDATE customer_portal_users SET last_login_at = NOW() WHERE id = ?', [localUserId]).catch(() => {});
    await tenantDb.query("UPDATE customers SET connection_status = 'connected' WHERE id = ?", [activeMembership.entity_id]).catch(() => {});

    const tokenPayload = {
      portal_type: 'customer',
      global_user_id: globalUser.id,
      portal_user_id: localUserId,
      customer_id: activeMembership.entity_id,
      company_id: activeMembership.company_id,
      database_name: activeMembership.database_name,
      name: globalUser.name,
      email: globalUser.email
    };
    const token = signPortalToken(tokenPayload);
    setPortalCookie(res, 'erp_customer_portal_token', token);

    const companiesList = memberships.map((m) => ({
      id: m.company_id,
      name: m.company_name,
      code: m.company_code,
      currency: m.currency || 'INR',
      number_system: m.number_system || 'indian',
      logo_url: m.logo_url,
      customer_id: m.entity_id
    }));

    return res.json({
      ok: true,
      token,
      portal_type: 'customer',
      user: { id: globalUser.id, name: globalUser.name, email: globalUser.email },
      active_company: {
        id: activeMembership.company_id,
        name: activeMembership.company_name,
        code: activeMembership.company_code,
        currency: activeMembership.currency || 'INR',
        number_system: activeMembership.number_system || 'indian',
        logo_url: activeMembership.logo_url,
        customer_id: activeMembership.entity_id
      },
      companies: companiesList
    });
  } catch (err) {
    console.error('customer portal login error:', err);
    return res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

// CUSTOMER PORTAL: SWITCH ACTIVE COMPANY
router.post('/customer-portal/auth/switch-company', async (req, res) => {
  const { company_id } = req.body;
  if (!company_id) return res.status(400).json({ error: 'company_id is required' });

  const auth = req.headers.authorization;
  const token = (auth && auth.startsWith('Bearer ') ? auth.slice(7) : null) || extractCookieToken(req, 'erp_customer_portal_token');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  if (payload.portal_type !== 'customer') return res.status(403).json({ error: 'Invalid portal token type' });

  try {
    const globalUser = await getGlobalPortalUserByEmail(payload.email);
    if (!globalUser) return res.status(401).json({ error: 'User not found' });

    const memberships = await getGlobalUserMemberships(globalUser.id, 'customer');
    const targetMembership = memberships.find((m) => m.company_id === company_id);

    if (!targetMembership) {
      return res.status(403).json({ error: 'You do not have access to this workspace' });
    }

    const tenantDb = getTenantPool(targetMembership.database_name);
    const localUserId = await syncTenantPortalUser(tenantDb, 'customer', globalUser, targetMembership.entity_id, targetMembership.company_id);

    const nextPayload = {
      portal_type: 'customer',
      global_user_id: globalUser.id,
      portal_user_id: localUserId,
      customer_id: targetMembership.entity_id,
      company_id: targetMembership.company_id,
      database_name: targetMembership.database_name,
      name: globalUser.name,
      email: globalUser.email
    };
    const nextToken = signPortalToken(nextPayload);
    setPortalCookie(res, 'erp_customer_portal_token', nextToken);

    const companiesList = memberships.map((m) => ({
      id: m.company_id,
      name: m.company_name,
      code: m.company_code,
      currency: m.currency || 'INR',
      logo_url: m.logo_url,
      customer_id: m.entity_id
    }));

    return res.json({
      ok: true,
      token: nextToken,
      portal_type: 'customer',
      user: { id: globalUser.id, name: globalUser.name, email: globalUser.email },
      active_company: {
        id: targetMembership.company_id,
        name: targetMembership.company_name,
        code: targetMembership.company_code,
        currency: targetMembership.currency || 'INR',
        logo_url: targetMembership.logo_url,
        customer_id: targetMembership.entity_id
      },
      companies: companiesList
    });
  } catch (err) {
    console.error('customer portal switch company error:', err);
    return res.status(500).json({ error: 'Failed to switch company: ' + err.message });
  }
});

// CUSTOMER PORTAL: GET CURRENT SESSION INFO & AVAILABLE WORKSPACES
router.get('/customer-portal/auth/me', async (req, res) => {
  const auth = req.headers.authorization;
  const token = (auth && auth.startsWith('Bearer ') ? auth.slice(7) : null) || extractCookieToken(req, 'erp_customer_portal_token');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.portal_type !== 'customer') return res.status(403).json({ error: 'Invalid portal token' });

    const globalUser = await getGlobalPortalUserByEmail(payload.email);
    if (!globalUser) return res.status(401).json({ error: 'User not found' });

    const memberships = await getGlobalUserMemberships(globalUser.id, 'customer');
    const activeMembership = memberships.find((m) => m.company_id === payload.company_id) || memberships[0];

    return res.json({
      ok: true,
      user: { id: globalUser.id, name: globalUser.name, email: globalUser.email },
      active_company: activeMembership ? {
        id: activeMembership.company_id,
        name: activeMembership.company_name,
        code: activeMembership.company_code,
        currency: activeMembership.currency || 'INR',
        logo_url: activeMembership.logo_url,
        customer_id: activeMembership.entity_id
      } : null,
      companies: memberships.map((m) => ({
        id: m.company_id,
        name: m.company_name,
        code: m.company_code,
        currency: m.currency || 'INR',
        logo_url: m.logo_url,
        customer_id: m.entity_id
      }))
    });
  } catch (err) {
    return res.status(401).json({ error: 'Session expired or invalid' });
  }
});

// CUSTOMER PORTAL: INVITE (Internal staff invites a customer)
router.post('/customers/:id/portal-invite', requireAuth, requirePermission('parties', 'edit'), async (req, res) => {
  const { name, email, phone } = req.body;
  const customerId = req.params.id;
  const companyId = req.user.company_id || req.user.workspace_id;

  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
  const normalizedEmail = email.toLowerCase().trim();

  try {
    const custRes = await req.tenantDb.query('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL', [customerId]);
    if (custRes.rowCount === 0) return res.status(404).json({ error: 'Customer not found' });
    const customer = custRes.rows[0];

    const custAddress = customer.billing_address || customer.shipping_address || customer.address || null;
    const custPhone = customer.phone || customer.contact || phone || null;
    const custContactPerson = customer.contact_person_name || name || customer.name;

    // 1. Check or create/update global portal user with all customer details entered by ERP admin
    let globalUser = await createOrUpdateGlobalPortalUser({
      email: normalizedEmail,
      name: custContactPerson,
      phone: custPhone,
      company_name: customer.name,
      gstin: customer.gstin || null,
      pan: customer.pan || (customer.gstin && customer.gstin.length === 15 ? customer.gstin.slice(2, 12) : null),
      address: custAddress,
      city: customer.city || null,
      state: customer.state || null,
      pincode: customer.pincode || null,
      business_type: 'Customer / Buyer'
    });

    const existingMembership = await queryMaster(
      'SELECT * FROM global_portal_memberships WHERE global_user_id = ? AND company_id = ? AND portal_type = ?',
      [globalUser.id, companyId, 'customer']
    );

    const base = process.env.FRONTEND_URL || 'http://localhost:5173';
    const forceReinvite = Boolean(req.body.force_reinvite || req.body.reset_password);

    if (!forceReinvite && existingMembership.rowCount > 0 && existingMembership.rows[0].status === 'Active') {
      const inviteLink = `${base}/login?portal=partner&company=${companyId}`;
      return res.status(200).json({
        ok: true,
        already_registered: true,
        can_reinvite: true,
        message: 'This customer is already connected to your portal.',
        invite_link: inviteLink
      });
    }

    if (!forceReinvite && globalUser.password_hash) {
      const membershipId = existingMembership.rowCount > 0 ? existingMembership.rows[0].id : crypto.randomUUID();
      if (existingMembership.rowCount > 0) {
        await queryMaster(
          'UPDATE global_portal_memberships SET entity_id = ?, status = ?, joined_at = NOW() WHERE id = ?',
          [customerId, 'Active', membershipId]
        );
      } else {
        await queryMaster(
          `INSERT INTO global_portal_memberships (id, global_user_id, company_id, entity_id, portal_type, status, joined_at)
           VALUES (?, ?, ?, ?, 'customer', 'Active', NOW())`,
          [membershipId, globalUser.id, companyId, customerId]
        );
      }

      await syncTenantPortalUser(req.tenantDb, 'customer', globalUser, customerId, companyId);
      await req.tenantDb.query("UPDATE customers SET connection_status = 'connected' WHERE id = ?", [customerId]).catch(() => {});
      const inviteLink = `${base}/login?portal=partner&company=${companyId}`;

      return res.status(201).json({
        ok: true,
        already_registered: true,
        can_reinvite: true,
        portal_user_id: globalUser.id,
        email: normalizedEmail,
        invite_link: inviteLink,
        message: 'Customer already has an active account on the platform. Your workspace has been linked immediately!'
      });
    }

    const inviteToken = crypto.randomBytes(32).toString('hex');
    const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const membershipId = existingMembership.rowCount > 0 ? existingMembership.rows[0].id : crypto.randomUUID();

    if (existingMembership.rowCount > 0) {
      await queryMaster(
        'UPDATE global_portal_memberships SET entity_id = ?, status = ?, invite_token = ?, invite_expires_at = ? WHERE id = ?',
        [customerId, 'Pending', inviteToken, inviteExpires, membershipId]
      );
    } else {
      await queryMaster(
        `INSERT INTO global_portal_memberships (id, global_user_id, company_id, entity_id, portal_type, status, invite_token, invite_expires_at)
         VALUES (?, ?, ?, ?, 'customer', 'Pending', ?, ?)`,
        [membershipId, globalUser.id, companyId, customerId, inviteToken, inviteExpires]
      );
    }

    const localUserId = crypto.randomUUID();
    await req.tenantDb.query(
      `INSERT INTO customer_portal_users (id, customer_id, name, email, status, invite_token, invite_expires_at)
       VALUES (?, ?, ?, ?, 'Active', ?, ?)
       ON DUPLICATE KEY UPDATE invite_token = VALUES(invite_token), invite_expires_at = VALUES(invite_expires_at)`,
      [localUserId, customerId, name.trim(), normalizedEmail, inviteToken, inviteExpires]
    ).catch(() => {});

    await req.tenantDb.query(
      "UPDATE customers SET connection_status = 'invited' WHERE id = ? AND (connection_status IS NULL OR connection_status != 'connected')",
      [customerId]
    ).catch(() => {});

    const inviteLink = `${base}/portal/accept-invite?token=${inviteToken}&company=${companyId}&type=customer`;

    return res.status(201).json({
      ok: true,
      already_registered: false,
      reinvited: forceReinvite,
      portal_user_id: globalUser.id,
      email: normalizedEmail,
      invite_token: inviteToken,
      invite_link: inviteLink,
      expires_at: inviteExpires,
      message: forceReinvite
        ? 'A fresh activation and password setup link has been generated!'
        : 'Portal invitation generated successfully!'
    });
  } catch (err) {
    console.error('customer portal invite error', err);
    return res.status(500).json({ error: 'Failed to create portal invite: ' + err.message });
  }
});

// CUSTOMER PORTAL: ACCEPT INVITE
router.post('/customer-portal/auth/accept-invite', (req, res) => handlePortalAcceptInvite(req, res, 'customer'));

// CUSTOMER PORTAL: FORGOT & RESET PASSWORD
router.post('/customer-portal/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  try {
    const globalUser = await getGlobalPortalUserByEmail(email);
    if (!globalUser || !globalUser.password_hash) {
      return res.json({ ok: true, message: 'If an active account exists, password reset instructions have been generated.' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 2 * 60 * 60 * 1000);

    const base = process.env.FRONTEND_URL || 'http://localhost:5173';
    const resetLink = `${base}/customer-portal/reset-password?token=${resetToken}&email=${encodeURIComponent(globalUser.email)}`;

    return res.json({
      ok: true,
      reset_link: resetLink,
      message: 'Password reset link generated successfully.'
    });
  } catch (err) {
    console.error('customer forgot password error:', err);
    return res.status(500).json({ error: 'Failed to generate reset link' });
  }
});

router.post('/customer-portal/auth/reset-password', async (req, res) => {
  const { token, email, new_password } = req.body;
  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ error: 'A 6+ character new password is required' });
  }

  try {
    const globalUser = await getGlobalPortalUserByEmail(email || '');
    if (!globalUser) return res.status(400).json({ error: 'Invalid or expired reset token' });

    const hash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
    await queryMaster(
      'UPDATE global_portal_users SET password_hash = ? WHERE id = ?',
      [hash, globalUser.id]
    );

    const memberships = await getGlobalUserMemberships(globalUser.id, 'customer');
    if (memberships.length === 0) return res.status(400).json({ error: 'No active workspaces found' });

    const activeMembership = memberships[0];
    const tenantDb = getTenantPool(activeMembership.database_name);
    const localUserId = await syncTenantPortalUser(tenantDb, 'customer', { ...globalUser, password_hash: hash }, activeMembership.entity_id, activeMembership.company_id);

    const tokenPayload = {
      portal_type: 'customer',
      global_user_id: globalUser.id,
      portal_user_id: localUserId,
      customer_id: activeMembership.entity_id,
      company_id: activeMembership.company_id,
      database_name: activeMembership.database_name,
      name: globalUser.name,
      email: globalUser.email
    };
    const jwtToken = signPortalToken(tokenPayload);
    setPortalCookie(res, 'erp_customer_portal_token', jwtToken);

    return res.json({
      ok: true,
      token: jwtToken,
      user: { id: globalUser.id, name: globalUser.name, email: globalUser.email },
      message: 'Password reset successfully!'
    });
  } catch (err) {
    console.error('customer reset password error:', err);
    return res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
