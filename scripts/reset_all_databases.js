require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { runMasterMigrations, runTenantMigrations } = require('../db/migrationRunner');

const adminUrl = process.env.MASTER_DATABASE_ADMIN_URL || process.env.MASTER_DATABASE_URL || 'mysql://root:@localhost:3306/mysql';

async function resetAllDatabases() {
  console.log('=== 1. DROPPING EXISTING ERP DATABASES ===');
  const adminConn = await mysql.createConnection(adminUrl);

  try {
    const [rows] = await adminConn.query(`
      SELECT SCHEMA_NAME AS datname FROM information_schema.SCHEMATA
      WHERE SCHEMA_NAME = 'erp_master' OR SCHEMA_NAME LIKE 'erp_company_%'
    `);

    const dbNames = rows.map(r => r.datname);
    console.log('Found databases to drop:', dbNames);

    for (const dbName of dbNames) {
      console.log(`Dropping database [${dbName}]...`);
      await adminConn.query(`DROP DATABASE IF EXISTS \`${dbName}\`;`);
    }

    console.log('\n=== 2. CREATING MASTER & DEMO TENANT DATABASES ===');
    await adminConn.query('CREATE DATABASE `erp_master`;');
    const demoTenantDb = 'erp_company_a0000000000000000000000000000001';
    await adminConn.query(`CREATE DATABASE \`${demoTenantDb}\`;`);

    console.log('Master and Demo Tenant databases created.');
  } catch (err) {
    console.error('Error dropping/creating databases:', err);
    throw err;
  } finally {
    await adminConn.end();
  }

  // 3. Run Master Migrations
  console.log('\n=== 3. RUNNING MASTER DATABASE MIGRATIONS ===');
  await runMasterMigrations();

  // 4. Run Tenant Migrations on Demo Tenant
  console.log('\n=== 4. RUNNING TENANT DATABASE MIGRATIONS ON DEMO TENANT ===');
  const demoUrlObj = new URL(adminUrl);
  demoUrlObj.pathname = '/erp_company_a0000000000000000000000000000001';
  const demoPool = mysql.createPool({
    uri: demoUrlObj.toString(),
    multipleStatements: true,
    waitForConnections: true,
    connectionLimit: 5
  });

  await runTenantMigrations(demoPool);
  await demoPool.end();

  // 5. Populate Seed Data from demo_company_seed.sql
  console.log('\n=== 5. POPULATING DEMO SEED DATA ===');
  const seedPath = path.join(__dirname, '..', '..', 'db', 'seed', 'demo_company_seed.sql');
  const seedSql = fs.readFileSync(seedPath, 'utf8');

  const masterConn = await mysql.createConnection(adminUrl.replace(/\/mysql$/, '/erp_master').replace(/\/$/, '/erp_master'));
  const demoConn = await mysql.createConnection(demoUrlObj.toString());

  try {
    const blocks = seedSql.split(/-- USE /);
    for (const block of blocks) {
      if (!block.trim()) continue;
      const lines = block.trim().split('\n');
      const targetHeader = lines[0].replace(';', '').trim();

      const statements = lines.slice(1).join('\n').trim();
      if (!statements) continue;

      if (targetHeader.includes('erp_master')) {
        console.log('Executing seed block on master DB...');
        const sqlStatements = statements.split(';').map(s => s.trim()).filter(Boolean);
        for (const stmt of sqlStatements) {
          await masterConn.query(stmt);
        }
      } else if (targetHeader.includes('erp_company')) {
        console.log('Executing seed block on demo tenant DB...');
        const sqlStatements = statements.split(';').map(s => s.trim()).filter(Boolean);
        for (const stmt of sqlStatements) {
          await demoConn.query(stmt);
        }
      }
    }
    console.log('Successfully seeded demo databases!');
  } catch (err) {
    console.error('Error seeding demo data:', err);
    throw err;
  } finally {
    await masterConn.end();
    await demoConn.end();
  }

  console.log('\n=======================================================');
  console.log('ALL ERP DATABASES RESET & SEEDED WITH DEMO DATA 100%');
  console.log('=======================================================');
}

if (require.main === module) {
  resetAllDatabases()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Reset failed:', err);
      process.exit(1);
    });
}

module.exports = { resetAllDatabases };
