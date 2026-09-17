'use strict';

/**
 * defaultPermissions.js — Standard 6-role, 16-module permission matrix for ERP workspaces.
 */

const ROLES = [
  'owner', 'manager', 'accounts', 'production_manager', 'sales_manager', 'staff'
];

const MODULES = [
  'dashboard', 'catalog', 'inventory', 'procurement',
  'production', 'shift_log', 'sales', 'parties', 'expenses',
  'locations', 'reports', 'settings', 'vendor_orders', 'customer_orders', 'returns',
  'users', 'billing', 'stock_transfers', 'ai_analytics'
];

async function ensureDefaultRolePermissions(tenantPool) {
  if (!tenantPool) return;
  try {
    for (const role of ROLES) {
      for (const mod of MODULES) {
        let canView = 1, canCreate = 0, canEdit = 0, canDelete = 0, canApprove = 0, canExport = 0;

        if (role === 'owner') {
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
          if (['production', 'shift_log', 'inventory', 'catalog', 'locations', 'dashboard', 'ai_analytics'].includes(mod)) {
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
        }

        await tenantPool.query(
          `INSERT IGNORE INTO role_permissions (id, role, module, can_view, can_create, can_edit, can_delete, can_approve, can_export)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           `,
          [`${role}_${mod}`, role, mod, canView, canCreate, canEdit, canDelete, canApprove, canExport]
        );
      }
    }
  } catch (err) {
    console.error('ensureDefaultRolePermissions error:', err);
  }
}

module.exports = {
  ROLES,
  MODULES,
  ensureDefaultRolePermissions
};
