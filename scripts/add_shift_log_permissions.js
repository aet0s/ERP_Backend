require('dotenv').config();
const { getTenantPool } = require('../db/tenantManager');
const { queryMaster } = require('../db/masterDb');

const DEFAULT_SHIFT_LOG_PERMISSIONS = [
  { role: 'owner', view: 1, create: 1, edit: 1, del: 1, approve: 1, export: 1 },
  { role: 'manager', view: 1, create: 1, edit: 1, del: 1, approve: 1, export: 1 },
  { role: 'production_manager', view: 1, create: 1, edit: 1, del: 1, approve: 1, export: 1 },
  { role: 'staff', view: 1, create: 1, edit: 0, del: 0, approve: 0, export: 0 },
  { role: 'accounts', view: 1, create: 0, edit: 0, del: 0, approve: 0, export: 1 },
  { role: 'sales_manager', view: 0, create: 0, edit: 0, del: 0, approve: 0, export: 0 }
];

(async () => {
  try {
    const companies = await queryMaster("SELECT id, company_name, database_name FROM companies WHERE status != 'deleted'");
    for (const company of companies.rows) {
      console.log('Adding shift_log permissions for:', company.company_name, company.database_name);
      const pool = getTenantPool(company.database_name);

      for (const p of DEFAULT_SHIFT_LOG_PERMISSIONS) {
        await pool.query(`
          INSERT INTO role_permissions (id, role, module, can_view, can_create, can_edit, can_delete, can_approve, can_export)
          VALUES (?, ?, 'shift_log', ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            can_view = VALUES(can_view),
            can_create = VALUES(can_create),
            can_edit = VALUES(can_edit),
            can_delete = VALUES(can_delete),
            can_approve = VALUES(can_approve),
            can_export = VALUES(can_export)
        `, [`${p.role}_shift_log`, p.role, p.view, p.create, p.edit, p.del, p.approve, p.export]);
      }
    }
    console.log('✅ shift_log permissions added to all tenant databases!');
    process.exit(0);
  } catch (err) {
    console.error('Permission setup error:', err);
    process.exit(1);
  }
})();
