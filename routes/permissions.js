'use strict';

/**
 * permissions.js — Dynamic Role Permissions API for Owner Management with Guardrails.
 */

const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { ROLES, MODULES, ensureDefaultRolePermissions } = require('../lib/defaultPermissions');

const MATRIX_SQL = "SELECT role, module, can_view, can_create, can_edit, can_delete, can_approve, can_export FROM role_permissions WHERE role NOT IN ('vendor', 'customer') ORDER BY role, module";

function truthy(val) {
  return Number(val) === 1 || val === true || val === '1' ? 1 : 0;
}

async function applyPermissionMatrix(tenantDb, permissions) {
  if (!permissions || !Array.isArray(permissions)) {
    const err = new Error('permissions array is required');
    err.status = 400;
    throw err;
  }

  // Validate every row
  for (const p of permissions) {
    if (p.role === 'vendor' || p.role === 'customer') {
      const err = new Error(`Portal roles ('${p.role}') are managed exclusively at the platform level by Platform Super Admin and cannot be modified within workspace settings.`);
      err.status = 400;
      throw err;
    }
    if (!ROLES.includes(p.role)) {
      const err = new Error(`Unknown role: '${p.role}'`);
      err.status = 400;
      throw err;
    }
    if (!MODULES.includes(p.module)) {
      const err = new Error(`Unknown permission module: '${p.module}'`);
      err.status = 400;
      throw err;
    }
  }

  // Ensure default rows exist first
  await ensureDefaultRolePermissions(tenantDb);

  // Write on ONE connection inside START TRANSACTION ... COMMIT
  const conn = await tenantDb.connect();
  let appliedCount = 0;
  try {
    await conn.query('START TRANSACTION');
    for (const p of permissions) {
      // Silently skip role 'owner' (immutable, always full access, enforced server-side)
      if (p.role === 'owner') continue;

      await conn.query(`
        INSERT INTO role_permissions (id, role, module, can_view, can_create, can_edit, can_delete, can_approve, can_export)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          can_view = VALUES(can_view),
          can_create = VALUES(can_create),
          can_edit = VALUES(can_edit),
          can_delete = VALUES(can_delete),
          can_approve = VALUES(can_approve),
          can_export = VALUES(can_export)
      `, [
        `${p.role}_${p.module}`, p.role, p.module,
        truthy(p.can_view), truthy(p.can_create),
        truthy(p.can_edit), truthy(p.can_delete),
        truthy(p.can_approve), truthy(p.can_export)
      ]);
      appliedCount++;
    }
    await conn.query('COMMIT');
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }

  const fresh = await tenantDb.query(MATRIX_SQL);
  return { ok: true, applied: appliedCount, permissions: fresh.rows || [] };
}

// GET /api/permissions — Fetch live internal role permissions matrix
router.get('/', requireAuth, async (req, res) => {
  try {
    await ensureDefaultRolePermissions(req.tenantDb);
    const result = await req.tenantDb.query(MATRIX_SQL);
    return res.json(result.rows || []);
  } catch (err) {
    console.error('fetch permissions error', err);
    return res.status(500).json({ error: 'Failed to fetch role permissions' });
  }
});

// PUT /api/permissions — Update internal role permissions matrix (Owner and Admin)
router.put('/', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  const { permissions } = req.body;
  if (!permissions || !Array.isArray(permissions)) {
    return res.status(400).json({ error: 'permissions array is required' });
  }

  try {
    const result = await applyPermissionMatrix(req.tenantDb, permissions);
    return res.json(result);
  } catch (err) {
    if (err.status === 400 || err.statusCode === 400) {
      return res.status(400).json({ error: err.message });
    }
    console.error('update permissions error', err);
    return res.status(500).json({ error: 'Failed to update permissions' });
  }
});

module.exports = router;
module.exports.applyPermissionMatrix = applyPermissionMatrix;
module.exports.MATRIX_SQL = MATRIX_SQL;
