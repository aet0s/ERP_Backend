'use strict';

/**
 * portalAuth.js — Auth middleware for Vendor and Customer portals.
 *
 * Portal tokens are completely separate from internal staff JWTs:
 * - Different cookie names (erp_vendor_portal_token, erp_customer_portal_token)
 * - Different JWT claims (portal_type, vendor_id / customer_id)
 * - Internal routes reject portal tokens; portal routes reject internal tokens
 */

const jwt = require('jsonwebtoken');
const { queryMaster } = require('../db/masterDb');
const { getTenantPool } = require('../db/tenantManager');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('FATAL: JWT_SECRET environment variable is not configured');

function extractCookieToken(req, cookieName) {
  const cookie = req.headers.cookie || '';
  const match = cookie.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${cookieName}=`));
  return match ? decodeURIComponent(match.slice(cookieName.length + 1)) : null;
}

/**
 * requireVendorPortalAuth
 * Sets req.vendorUser = { portal_user_id, vendor_id, company_id, database_name, name, email }
 * Sets req.tenantDb to the vendor's company tenant pool
 */
async function requireVendorPortalAuth(req, res, next) {
  const auth = req.headers.authorization;
  const token = (auth && auth.startsWith('Bearer ') ? auth.slice(7) : null)
    || extractCookieToken(req, 'erp_vendor_portal_token');

  if (!token) return res.status(401).json({ error: 'Missing portal token' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
  } catch {
    return res.status(401).json({ error: 'Invalid portal token' });
  }

  // Enforce portal_type — internal tokens are rejected here
  if (payload.portal_type !== 'vendor') {
    return res.status(403).json({ error: 'This token is not valid for the vendor portal' });
  }

  const { portal_user_id, vendor_id, company_id, database_name } = payload;
  if (!portal_user_id || !vendor_id || !company_id || !database_name) {
    return res.status(401).json({ error: 'Malformed portal token' });
  }

  try {
    // Verify company still exists and is active
    const compRes = await queryMaster(
      'SELECT id, status FROM companies WHERE id = ?',
      [company_id]
    );
    if (compRes.rowCount === 0) return res.status(401).json({ error: 'Workspace not found' });
    const companyStatus = compRes.rows[0].status;
    if (['suspended', 'cancelled', 'paused', 'deleted'].includes(companyStatus)) {
      return res.status(403).json({ error: `Workspace is currently ${companyStatus}. Portal operations are paused.`, status: companyStatus });
    }

    const tenantDb = getTenantPool(database_name);

    // Verify portal user still exists and is active
    const userRes = await tenantDb.query(
      'SELECT id, name, email, vendor_id, status FROM vendor_portal_users WHERE id = ? AND status = ?',
      [portal_user_id, 'Active']
    );
    if (userRes.rowCount === 0) {
      return res.status(401).json({ error: 'Vendor portal user not found or inactive' });
    }

    const portalUser = userRes.rows[0];
    // Enforce that the token's vendor_id matches the DB record
    if (portalUser.vendor_id !== vendor_id) {
      return res.status(403).json({ error: 'Portal token vendor mismatch' });
    }

    req.vendorUser = { ...portalUser, portal_user_id, company_id, database_name };
    req.tenantDb = tenantDb;
    return next();
  } catch (err) {
    console.error('requireVendorPortalAuth error:', err);
    return res.status(500).json({ error: 'Portal authentication failed' });
  }
}

/**
 * requireCustomerPortalAuth
 * Sets req.customerUser = { portal_user_id, customer_id, company_id, database_name, name, email }
 * Sets req.tenantDb to the customer's company tenant pool
 */
async function requireCustomerPortalAuth(req, res, next) {
  const auth = req.headers.authorization;
  const token = (auth && auth.startsWith('Bearer ') ? auth.slice(7) : null)
    || extractCookieToken(req, 'erp_customer_portal_token');

  if (!token) return res.status(401).json({ error: 'Missing portal token' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
  } catch {
    return res.status(401).json({ error: 'Invalid portal token' });
  }

  if (payload.portal_type !== 'customer') {
    return res.status(403).json({ error: 'This token is not valid for the customer portal' });
  }

  const { portal_user_id, customer_id, company_id, database_name } = payload;
  if (!portal_user_id || !customer_id || !company_id || !database_name) {
    return res.status(401).json({ error: 'Malformed portal token' });
  }

  try {
    const compRes = await queryMaster('SELECT id, status FROM companies WHERE id = ?', [company_id]);
    if (compRes.rowCount === 0) return res.status(401).json({ error: 'Workspace not found' });
    const companyStatus = compRes.rows[0].status;
    if (['suspended', 'cancelled', 'paused', 'deleted'].includes(companyStatus)) {
      return res.status(403).json({ error: `Workspace is currently ${companyStatus}. Portal operations are paused.`, status: companyStatus });
    }

    const tenantDb = getTenantPool(database_name);

    const userRes = await tenantDb.query(
      'SELECT id, name, email, customer_id, status FROM customer_portal_users WHERE id = ? AND status = ?',
      [portal_user_id, 'Active']
    );
    if (userRes.rowCount === 0) {
      return res.status(401).json({ error: 'Customer portal user not found or inactive' });
    }

    const portalUser = userRes.rows[0];
    if (portalUser.customer_id !== customer_id) {
      return res.status(403).json({ error: 'Portal token customer mismatch' });
    }

    req.customerUser = { ...portalUser, portal_user_id, company_id, database_name };
    req.tenantDb = tenantDb;
    return next();
  } catch (err) {
    console.error('requireCustomerPortalAuth error:', err);
    return res.status(500).json({ error: 'Portal authentication failed' });
  }
}

/**
 * requirePortalPermission
 * Enforces platform_portal_permissions for vendor and customer users.
 */
function requirePortalPermission(moduleName, action = 'view') {
  return async (req, res, next) => {
    const portalRole = req.vendorUser ? 'vendor' : (req.customerUser ? 'customer' : null);
    if (!portalRole) {
      return res.status(401).json({ error: 'Missing portal user context' });
    }

    const col = `can_${action}`;
    try {
      const permRes = await queryMaster(
        `SELECT ${col} AS allowed FROM platform_portal_permissions WHERE role = ? AND module = ?`,
        [portalRole, moduleName]
      );

      const isAllowed = permRes.rows && permRes.rows[0] && (permRes.rows[0].allowed === 1 || permRes.rows[0].allowed === true);
      if (!isAllowed) {
        return res.status(403).json({
          error: `Forbidden: portal role '${portalRole}' does not have '${action}' permission for module '${moduleName}'`
        });
      }

      return next();
    } catch (err) {
      console.error('requirePortalPermission error:', err);
      return res.status(500).json({ error: 'Failed to verify portal permissions' });
    }
  };
}

module.exports = { requireVendorPortalAuth, requireCustomerPortalAuth, requirePortalPermission };
