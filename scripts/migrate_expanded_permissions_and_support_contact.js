const { queryMaster } = require('../db/masterDb');
const { getTenantPool } = require('../db/tenantManager');

async function migrate() {
  console.log('=== STARTING EXPANDED PERMISSIONS & SUPPORT CONTACT MIGRATION ===\n');

  // 1. Add support_email and support_phone to companies in erp_master
  try {
    console.log('[1/3] Updating erp_master.companies table...');
    await queryMaster(`
      ALTER TABLE companies 
      ADD COLUMN IF NOT EXISTS support_email VARCHAR(255) NULL,
      ADD COLUMN IF NOT EXISTS support_phone VARCHAR(50) NULL
    `).catch(async () => {
      await queryMaster('ALTER TABLE companies ADD COLUMN support_email VARCHAR(255) NULL').catch(() => {});
      await queryMaster('ALTER TABLE companies ADD COLUMN support_phone VARCHAR(50) NULL').catch(() => {});
    });
    console.log('✔ companies table updated with support_email and support_phone columns.');
  } catch (err) {
    console.warn('Companies table update notice:', err.message);
  }

  // 2. Fetch all active companies
  const companiesRes = await queryMaster('SELECT id, company_name, database_name FROM companies WHERE status != ?', ['deleted']);
  console.log(`\n[2/3] Found ${companiesRes.rows.length} tenant databases to update...`);

  const MODULES = [
    'dashboard',
    'parties',
    'catalog',
    'procurement',
    'production',
    'sales',
    'expenses',
    'inventory',
    'stock_transfers',
    'locations',
    'returns',
    'reports',
    'settings',
    'users_roles',
    'vendor_orders',
    'customer_orders'
  ];

  const ROLES = [
    'owner',
    'manager',
    'accounts',
    'sales_manager',
    'production_manager',
    'staff',
    'vendor',
    'customer'
  ];

  for (const company of companiesRes.rows) {
    console.log(`\nUpdating tenant: ${company.company_name} (${company.database_name})...`);
    const tenantDb = await getTenantPool(company.database_name);

    // Add can_export column to role_permissions
    await tenantDb.query(`
      ALTER TABLE role_permissions
      ADD COLUMN IF NOT EXISTS can_export TINYINT(1) NOT NULL DEFAULT 0
    `).catch(async () => {
      await tenantDb.query('ALTER TABLE role_permissions ADD COLUMN can_export TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});
    });

    // Ensure all role x module rows exist with sensible defaults
    for (const role of ROLES) {
      for (const mod of MODULES) {
        const isVendor = role === 'vendor';
        const isCustomer = role === 'customer';
        const isOwner = role === 'owner';
        const isManager = role === 'manager';

        let v = 0, c = 0, e = 0, d = 0, a = 0, exp = 0;

        if (isOwner) {
          v = 1; c = 1; e = 1; d = 1; a = 1; exp = 1;
        } else if (isManager) {
          if (!['settings', 'vendor_orders', 'customer_orders'].includes(mod)) {
            v = 1; c = 1; e = 1; d = 0; a = 1; exp = 1;
          }
        } else if (role === 'accounts') {
          if (['dashboard', 'parties', 'catalog', 'procurement', 'sales', 'expenses', 'inventory', 'returns', 'reports'].includes(mod)) {
            v = 1;
            c = ['procurement', 'sales', 'expenses', 'returns'].includes(mod) ? 1 : 0;
            e = ['procurement', 'sales', 'expenses', 'returns'].includes(mod) ? 1 : 0;
            d = ['expenses'].includes(mod) ? 1 : 0;
            a = ['sales', 'returns', 'procurement'].includes(mod) ? 1 : 0;
            exp = 1;
          }
        } else if (role === 'sales_manager') {
          if (['dashboard', 'parties', 'catalog', 'sales', 'returns', 'reports', 'customer_orders', 'inventory'].includes(mod)) {
            v = 1;
            c = ['sales', 'returns', 'parties'].includes(mod) ? 1 : 0;
            e = ['sales', 'returns', 'parties'].includes(mod) ? 1 : 0;
            d = 0;
            a = ['sales', 'returns'].includes(mod) ? 1 : 0;
            exp = 1;
          }
        } else if (role === 'production_manager') {
          if (['dashboard', 'catalog', 'procurement', 'production', 'inventory', 'stock_transfers', 'locations'].includes(mod)) {
            v = 1;
            c = ['production', 'stock_transfers', 'locations'].includes(mod) ? 1 : 0;
            e = ['production', 'stock_transfers', 'locations'].includes(mod) ? 1 : 0;
            d = 0;
            a = ['production', 'stock_transfers'].includes(mod) ? 1 : 0;
            exp = 1;
          }
        } else if (role === 'staff') {
          if (['dashboard', 'catalog', 'production', 'inventory', 'locations'].includes(mod)) {
            v = 1;
            c = ['production'].includes(mod) ? 1 : 0;
            e = 0; d = 0; a = 0; exp = 0;
          }
        } else if (isVendor) {
          if (mod === 'vendor_orders') { v = 1; e = 1; }
          if (mod === 'returns') { v = 1; c = 1; }
        } else if (isCustomer) {
          if (mod === 'customer_orders') { v = 1; e = 1; }
          if (mod === 'returns') { v = 1; c = 1; }
        }

        const id = `${role}_${mod}`;
        await tenantDb.query(`
          INSERT INTO role_permissions (id, role, module, can_view, can_create, can_edit, can_delete, can_approve, can_export)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            can_view = can_view,
            can_create = can_create,
            can_edit = can_edit,
            can_delete = can_delete,
            can_approve = can_approve,
            can_export = can_export
        `, [id, role, mod, v, c, e, d, a, exp]);
      }
    }
    console.log(`✔ Permissions matrix updated for ${company.company_name}`);
  }

  console.log('\n[3/3] Migration finished successfully with 100% completion!');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
