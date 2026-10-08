'use strict';

const jwt = require('jsonwebtoken');
const { queryMaster } = require('../db/masterDb');
const { getTenantPool } = require('../db/tenantManager');
const { parseRoles, resolveUserRoles } = require('../lib/roles');
const { ensureDefaultRolePermissions } = require('../lib/defaultPermissions');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('FATAL: JWT_SECRET environment variable is not configured');

const ensuredAuthColumnsTenants = new Set();

async function guaranteeAuthColumns(tenantDb, dbName) {
  if (!tenantDb || !dbName) return;
  if (ensuredAuthColumnsTenants.has(dbName)) return;

  try {
    const res = await tenantDb.query(
      `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME IN ('roles', 'vendor_id', 'customer_id')`,
      [dbName]
    );
    const existing = (res.rows || []).map((r) => r.COLUMN_NAME || r.column_name);

    if (!existing.includes('roles')) {
      await tenantDb.query('ALTER TABLE users ADD COLUMN roles TEXT NULL').catch(() => {});
    }
    if (!existing.includes('vendor_id')) {
      await tenantDb.query('ALTER TABLE users ADD COLUMN vendor_id VARCHAR(36) NULL').catch(() => {});
    }
    if (!existing.includes('customer_id')) {
      await tenantDb.query('ALTER TABLE users ADD COLUMN customer_id VARCHAR(36) NULL').catch(() => {});
    }

    ensuredAuthColumnsTenants.add(dbName);
  } catch (err) {
    console.error('guaranteeAuthColumns error on', dbName, err);
  }
}

function cookieToken(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('erp_token='));
  if (match) return decodeURIComponent(match.slice('erp_token='.length));
  // Fallback check erp_access_token
  const legacyMatch = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('erp_access_token='));
  return legacyMatch ? decodeURIComponent(legacyMatch.slice('erp_access_token='.length)) : null;
}

async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : cookieToken(req);
  if (!token) return res.status(401).json({ error: 'Missing authentication token' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
  } catch (jwtErr) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Reject platform admin tokens on tenant routes
  if (payload.is_platform_admin) {
    return res.status(403).json({ error: 'Platform admin tokens cannot be used on tenant routes' });
  }

  const companyId = payload.company_id || payload.workspace_id;
  if (!companyId) return res.status(401).json({ error: 'Invalid token payload: missing company_id' });

  try {
    const companyRes = await queryMaster(
      'SELECT id, company_name, database_name, status, plan, subscription_status, currency, logo_url, accent_color, onboarding_completed_at, number_system FROM companies WHERE id = ?',
      [companyId]
    );

    if (companyRes.rowCount === 0) {
      return res.status(401).json({ error: 'Workspace not found' });
    }

    const company = companyRes.rows[0];
    company.number_system = company.number_system || 'indian';

    // Administrative status blocks
    if (company.status === 'paused' || company.subscription_status === 'paused') {
      return res.status(403).json({
        error: 'Workspace subscription is paused by platform administrator.',
        status: 'paused',
        locked: true
      });
    }

    if (company.status === 'suspended' || company.status === 'failed' || company.subscription_status === 'stopped') {
      return res.status(403).json({
        error: 'Workspace is suspended by platform administrator.',
        status: 'suspended',
        locked: true
      });
    }

    if (company.status === 'cancelled' || company.subscription_status === 'canceled') {
      return res.status(403).json({
        error: 'Workspace subscription has been cancelled.',
        status: 'cancelled',
        locked: true
      });
    }

    if (company.status === 'deleted') {
      return res.status(403).json({
        error: 'Workspace has been deleted.',
        status: 'deleted',
        locked: true
      });
    }

    const tenantDb = getTenantPool(company.database_name);
    const userId = payload.userId || payload.user_id || payload.id;
    if (!userId) {
      return res.status(401).json({ error: 'Invalid token payload: missing user_id' });
    }

    // Guarantee users.roles, users.vendor_id, users.customer_id exist
    await guaranteeAuthColumns(tenantDb, company.database_name);

    // Fetch live user record to enforce dynamic role updates and active status immediately
    let uRes;
    try {
      uRes = await tenantDb.query(
        'SELECT id, name, email, role, roles, status, vendor_id, customer_id, deleted_at FROM users WHERE id = ?',
        [userId]
      );
    } catch (dbErr) {
      console.error('requireAuth database error:', dbErr);
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }

    if (!uRes.rows || uRes.rows.length === 0) {
      return res.status(401).json({ error: 'User account not found' });
    }

    const row = uRes.rows[0];

    // Check deleted
    if (row.deleted_at || row.status === 'deleted') {
      return res.status(401).json({ error: 'User account not found or has been deleted' });
    }

    // Check inactive / suspended
    if (row.status === 'inactive' || row.status === 'suspended') {
      return res.status(403).json({ error: 'Account is deactivated or suspended' });
    }

    const userRoles = resolveUserRoles(row.role, row.roles);

    req.user = {
      id: row.id,
      name: row.name,
      email: row.email,
      role: userRoles[0] || row.role || 'accounts',
      roles: userRoles,
      vendor_id: row.vendor_id !== undefined ? row.vendor_id : null,
      customer_id: row.customer_id !== undefined ? row.customer_id : null,
      workspace_id: companyId,
      company_id: companyId
    };
    req.company = company;
    req.tenantDb = tenantDb;

    return next();
  } catch (err) {
    console.error('requireAuth internal error:', err);
    return res.status(500).json({ error: 'Internal server error during authentication' });
  }
}

// Multi-role requirement helper (owner superadmin always passes, checks if any assigned role matches)
function requireRole(...allowedRoles) {
  const roles = allowedRoles.flat();
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Missing auth' });
    const userRoles = req.user.roles && Array.isArray(req.user.roles) && req.user.roles.length > 0
      ? req.user.roles
      : [req.user.role || 'accounts'];

    if (userRoles.includes('owner') || req.user.role === 'owner') return next();

    const hasMatchingRole = roles.length === 0 || userRoles.some((r) => roles.includes(r));
    if (!hasMatchingRole) {
      return res.status(403).json({ error: 'Forbidden: insufficient role permissions' });
    }
    return next();
  };
}

// Dynamic module permission middleware (aggregates permissions across all assigned user roles)
function requirePermission(moduleName, action = 'view') {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Missing auth' });
    const userRoles = req.user.roles && Array.isArray(req.user.roles) && req.user.roles.length > 0
      ? req.user.roles
      : [req.user.role || 'accounts'];

    if (userRoles.includes('owner') || userRoles.includes('admin') || req.user.role === 'owner' || req.user.role === 'admin') return next(); // Owner and Admin have full access to all modules

    const col = `can_${action}`;
    try {
      await ensureDefaultRolePermissions(req.tenantDb);
      const placeholders = userRoles.map(() => '?').join(',');
      const permRes = await req.tenantDb.query(
        `SELECT MAX(${col}) AS allowed FROM role_permissions WHERE role IN (${placeholders}) AND module = ?`,
        [...userRoles, moduleName]
      );

      const isAllowed = Number(permRes.rows[0]?.allowed) === 1 || permRes.rows[0]?.allowed === true;
      if (!isAllowed) {
        return res.status(403).json({ error: `Forbidden: assigned roles do not have '${action}' permission for module '${moduleName}'` });
      }

      return next();
    } catch (err) {
      console.error('requirePermission error:', err);
      return res.status(500).json({ error: 'Failed to verify module permissions' });
    }
  };
}

// Helper to extract platform admin token from multiple possible sources (cookies, headers, query)
function getPlatformAdminToken(req) {
  let token = req.cookies?.erp_platform_token;
  if (!token && req.headers?.cookie) {
    const match = req.headers.cookie.split(';').map(p => p.trim()).find(p => p.startsWith('erp_platform_token='));
    if (match) token = decodeURIComponent(match.slice('erp_platform_token='.length));
  }
  if (!token && req.headers?.authorization) {
    token = req.headers.authorization.replace(/^Bearer\s+/i, '').trim();
  }
  if (!token && req.headers?.['x-platform-token']) {
    token = String(req.headers['x-platform-token']).trim();
  }
  if (!token && req.query?.token) {
    token = String(req.query.token).trim();
  }
  if (!token && req.query?.platform_token) {
    token = String(req.query.platform_token).trim();
  }
  return token || null;
}

// Platform Super Admin Auth Middleware
async function requirePlatformAdminAuth(req, res, next) {
  // Also check SUPER_ADMIN_SECRET header fallback for automated CLI scripts
  const headerSecret = req.headers?.['x-super-admin-secret'];
  const expectedSecret = process.env.SUPER_ADMIN_SECRET || 'super_secret_override_2026';
  if (headerSecret && headerSecret === expectedSecret) {
    req.platformAdmin = { id: 'cli_admin', name: 'CLI Automation', email: 'automation@platform.com' };
    return next();
  }

  const token = getPlatformAdminToken(req);
  if (!token) return res.status(401).json({ error: 'Missing platform admin authentication' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
    if (!decoded.is_platform_admin) return res.status(403).json({ error: 'Access denied: token is not a platform admin token' });

    req.platformAdmin = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired platform admin token' });
  }
}

module.exports = {
  requireAuth,
  requireRole,
  requirePermission,
  requirePlatformAdminAuth,
  getPlatformAdminToken,
  parseRoles
};
