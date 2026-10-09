const mysql = require('mysql2/promise');
require('dotenv').config({ path: __dirname + '/../.env' });

async function main() {
  const masterConn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost',
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MASTER_DB_NAME || 'erp_master'
  });

  console.log('Connected to master DB');
  const [companies] = await masterConn.query('SELECT id, company_name, database_name, primary_owner_id, primary_owner_email FROM companies');
  console.log('Companies:', companies);

  if (companies.length > 0) {
    const comp = companies[0];
    const tenantConn = await mysql.createConnection({
      host: process.env.MYSQL_HOST || 'localhost',
      port: process.env.MYSQL_PORT || 3306,
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: comp.database_name
    });
    console.log('Connected to tenant DB:', comp.database_name);
    const [users] = await tenantConn.query('SELECT id, name, email, role, roles, status, is_primary_owner FROM users');
    console.log('Tenant Users:', users);

    const [rolePerms] = await tenantConn.query('SELECT role, module, can_view, can_create, can_edit, can_delete, can_approve, can_export FROM role_permissions LIMIT 10');
    console.log('Sample Role Permissions:', rolePerms);

    await tenantConn.end();
  }

  await masterConn.end();
}

main().catch(console.error);
