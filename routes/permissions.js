'use strict';

/**
 * permissions.js — Dynamic Role Permissions API for Owner Management with Guardrails.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, requireRole } = require('../middleware/auth');
const { ensureDefaultRolePermissions } = require('../lib/defaultPermissions');

const MODULES = [
  'dashboard', 'catalog', 'inventory', 'procurement',
  'production', 'shift_log', 'sales', 'parties', 'expenses',
  'locations', 'reports', 'settings', 'vendor_orders', 'customer_orders', 'returns',
  'users', 'billing', 'stock_transfers'
];

const ALLOWED_VENDOR_MODULES = ['vendor_orders', 'returns'];
const ALLOWED_CUSTOMER_MODULES = ['customer_orders', 'returns'];

// GET /api/permissions — Fetch live internal role permissions matrix
router.get('/', requireAuth, async (req, res) => {
  try {
    await ensureDefaultRolePermissions(req.tenantDb);
    const result = await req.tenantDb.query(
      "SELECT role, module, can_view, can_create, can_edit, can_delete, can_approve, can_export FROM role_permissions WHERE role NOT IN ('vendor', 'customer') ORDER BY role, module"
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('fetch permissions error', err);
    return res.status(500).json({ error: 'Failed to fetch role permissions' });
  }
});

// PUT /api/permissions — Update internal role permissions matrix (Owner and Admin)
router.put('/', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  const { permissions } = req.body; // Array of { role, module, can_view, can_create, can_edit, can_delete, can_approve, can_export }
  if (!permissions || !Array.isArray(permissions)) {
    return res.status(400).json({ error: 'permissions array is required' });
  }

  // Reject any attempt to configure vendor or customer roles at workspace level
  for (const p of permissions) {
    if (p.role === 'vendor' || p.role === 'customer') {
      return res.status(400).json({
        error: `Portal roles ('${p.role}') are managed exclusively at the platform level by Platform Super Admin and cannot be modified within workspace settings.`
      });
    }
    if (!MODULES.includes(p.module)) {
      return res.status(400).json({ error: `Unknown permission module: '${p.module}'` });
    }
  }

  try {
    await req.tenantDb.query('START TRANSACTION');
    for (const p of permissions) {
      await req.tenantDb.query(`
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
        p.can_view ? 1 : 0, p.can_create ? 1 : 0,
        p.can_edit ? 1 : 0, p.can_delete ? 1 : 0,
        p.can_approve ? 1 : 0, p.can_export ? 1 : 0
      ]);
    }
    await req.tenantDb.query('COMMIT');
    return res.json({ ok: true, message: 'Permissions updated successfully' });
  } catch (err) {
    await req.tenantDb.query('ROLLBACK').catch(() => {});
    console.error('update permissions error', err);
    return res.status(500).json({ error: 'Failed to update permissions' });
  }
});

module.exports = router;
