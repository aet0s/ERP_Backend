'use strict';

/**
 * defaultPermissions.js — Canonical Single Source of Truth for Roles & Modules Permission Matrix
 */

const ROLES = [
  'owner', 'admin', 'manager', 'accounts', 'production_manager', 'sales_manager', 'staff'
];

const MODULES = [
  'dashboard', 'catalog', 'inventory', 'procurement',
  'production', 'shift_log', 'sales', 'parties', 'expenses',
  'locations', 'reports', 'settings', 'vendor_orders', 'customer_orders', 'returns',
  'users', 'billing', 'stock_transfers', 'ai_analytics'
];

function defaultFlags(role, mod) {
  let canView = 1, canCreate = 0, canEdit = 0, canDelete = 0, canApprove = 0, canExport = 0;

  if (role === 'owner' || role === 'admin') {
    canView = 1; canCreate = 1; canEdit = 1; canDelete = 1; canApprove = 1; canExport = 1;
  } else if (role === 'manager') {
    canView = 1; canCreate = 1; canEdit = 1; canDelete = 0; canApprove = 1; canExport = 1;
    if (mod === 'shift_log') canDelete = 1;
  } else if (role === 'accounts') {
    if (['sales', 'procurement', 'expenses', 'reports', 'catalog', 'dashboard', 'billing', 'ai_analytics'].includes(mod)) {
      canView = 1; canCreate = 1; canEdit = 1; canDelete = 0; canApprove = 1; canExport = 1;
    } else if (['inventory', 'shift_log', 'parties', 'locations'].includes(mod)) {
      canView = 1; canCreate = 0; canEdit = 0; canDelete = 0; canApprove = 0; canExport = 1;
    } else {
      canView = 0;
    }
  } else if (role === 'production_manager') {
    if (['production', 'shift_log', 'inventory', 'catalog', 'locations', 'dashboard', 'ai_analytics', 'stock_transfers'].includes(mod)) {
      canView = 1; canCreate = 1; canEdit = 1; canDelete = (mod === 'shift_log' ? 1 : 0); canApprove = 1; canExport = 1;
    } else if (['reports', 'procurement'].includes(mod)) {
      canView = 1; canCreate = 0; canEdit = 0; canDelete = 0; canApprove = 0; canExport = 0;
    } else {
      canView = 0;
    }
  } else if (role === 'sales_manager') {
    if (['sales', 'parties', 'customer_orders', 'returns', 'reports', 'catalog', 'settings', 'dashboard', 'ai_analytics'].includes(mod)) {
      canView = 1; canCreate = 1; canEdit = 1; canDelete = 0; canApprove = 1; canExport = 1;
    } else if (['inventory'].includes(mod)) {
      canView = 1; canCreate = 0; canEdit = 0; canDelete = 0; canApprove = 0; canExport = 1;
    } else {
      canView = 0;
    }
  } else if (role === 'staff') {
    if (['dashboard', 'inventory', 'production', 'shift_log', 'sales', 'ai_analytics'].includes(mod)) {
      canView = 1; canCreate = (mod === 'ai_analytics' ? 0 : 1); canEdit = 0; canDelete = 0; canApprove = 0; canExport = (mod === 'ai_analytics' ? 1 : 0);
    } else {
      canView = 0;
    }
  } else {
    canView = 0;
  }

  return {
    can_view: canView,
    can_create: canCreate,
    can_edit: canEdit,
    can_delete: canDelete,
    can_approve: canApprove,
    can_export: canExport
  };
}

const ensuredTenants = new Set();

async function resolveDbName(tenantPool) {
  if (tenantPool && typeof tenantPool.databaseName === 'string') return tenantPool.databaseName;
  if (tenantPool && typeof tenantPool.dbName === 'string') return tenantPool.dbName;
  try {
    const res = await tenantPool.query('SELECT DATABASE() AS db');
    return res.rows?.[0]?.db || null;
  } catch (_) {
    return null;
  }
}

async function ensureDefaultRolePermissions(tenantPool) {
  if (!tenantPool) return;

  let dbName = null;
  try {
    dbName = await resolveDbName(tenantPool);
    if (dbName && ensuredTenants.has(dbName)) {
      return;
    }

    const rows = [];
    const placeholders = [];

    for (const role of ROLES) {
      for (const mod of MODULES) {
        const flags = defaultFlags(role, mod);
        rows.push(
          `${role}_${mod}`,
          role,
          mod,
          flags.can_view,
          flags.can_create,
          flags.can_edit,
          flags.can_delete,
          flags.can_approve,
          flags.can_export
        );
        placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?)');
      }
    }

    const sql = `INSERT IGNORE INTO role_permissions
      (id, role, module, can_view, can_create, can_edit, can_delete, can_approve, can_export)
      VALUES ${placeholders.join(', ')}`;

    await tenantPool.query(sql, rows);

    if (dbName) {
      ensuredTenants.add(dbName);
    }
  } catch (err) {
    console.error('ensureDefaultRolePermissions error:', err);
  }
}

function clearEnsuredTenantCache(dbName) {
  if (dbName) {
    ensuredTenants.delete(dbName);
  } else {
    ensuredTenants.clear();
  }
}

module.exports = {
  ROLES,
  MODULES,
  defaultFlags,
  ensureDefaultRolePermissions,
  clearEnsuredTenantCache
};
