const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getTenantPool } = require('../db/tenantManager');

function formatResult(res) {
  if (!res) return { rows: [], rowCount: 0 };
  if (res && typeof res === 'object' && Array.isArray(res.rows)) return res;
  const rows = Array.isArray(res) ? res[0] : res;
  if (Array.isArray(rows)) {
    return { rows, rowCount: rows.length };
  }
  return { rows: [], rowCount: 0 };
}

async function dumpTenantDatabase(dbName, outputPath) {
  const pool = getTenantPool(dbName);
  const conn = pool.connect ? await pool.connect() : await pool.getConnection();
  const query = async (sql, params) => formatResult(await conn.query(sql, params));
  const sqlStatements = [];

  try {
    sqlStatements.push(`-- ERP Studio Tenant Database Backup: ${dbName}`);
    sqlStatements.push(`-- Date: ${new Date().toISOString()}`);
    sqlStatements.push(`SET FOREIGN_KEY_CHECKS = 0;\n`);

    // Fetch all user tables
    const tablesRes = await query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'`,
      [dbName]
    );

    const tables = tablesRes.rows.map((r) => r.table_name || r.TABLE_NAME).filter((t) => t !== 'schema_migrations');

    for (const tableName of tables) {
      // Get DDL schema
      const createRes = await query(`SHOW CREATE TABLE \`${tableName}\``);
      const createSql = createRes.rows[0]['Create Table'] || createRes.rows[0]['CREATE TABLE'] || Object.values(createRes.rows[0])[1];
      
      sqlStatements.push(`DROP TABLE IF EXISTS \`${tableName}\`;`);
      sqlStatements.push(`${createSql};\n`);

      // Fetch all rows
      const rowsRes = await query(`SELECT * FROM \`${tableName}\``);
      if (rowsRes.rows.length > 0) {
        const columns = Object.keys(rowsRes.rows[0]);
        const colNamesStr = columns.map((c) => `\`${c}\``).join(', ');

        const valueTuples = rowsRes.rows.map((row) => {
          const vals = columns.map((col) => {
            const val = row[col];
            if (val === null || val === undefined) return 'NULL';
            if (typeof val === 'number') return val;
            if (typeof val === 'boolean') return val ? 1 : 0;
            if (val instanceof Date) return `'${val.toISOString().slice(0, 19).replace('T', ' ')}'`;
            if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "\\'")}'`;
            return `'${String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
          });
          return `(${vals.join(', ')})`;
        });

        sqlStatements.push(`INSERT INTO \`${tableName}\` (${colNamesStr}) VALUES\n${valueTuples.join(',\n')};\n`);
      }
    }

    sqlStatements.push(`\nSET FOREIGN_KEY_CHECKS = 1;`);
    const sqlContent = sqlStatements.join('\n');
    fs.writeFileSync(outputPath, sqlContent, 'utf8');
    return { outputPath, bytes: fs.statSync(outputPath).size };
  } finally {
    conn.release();
  }
}

async function restoreTenantDatabase(dbName, sqlFilePath) {
  const sqlContent = fs.readFileSync(sqlFilePath, 'utf8');
  const pool = getTenantPool(dbName);
  const conn = pool.connect ? await pool.connect() : await pool.getConnection();
  const query = async (sql, params) => formatResult(await conn.query(sql, params));

  try {
    await query('SET FOREIGN_KEY_CHECKS = 0');

    // Split SQL into individual executable statements
    const statements = sqlContent
      .split(/;\s*[\r\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
      if (stmt.startsWith('/*') || stmt.startsWith('--')) continue;
      try {
        await query(stmt);
      } catch (err) {
        console.warn('Restore statement warning:', err.message, stmt.slice(0, 60));
      }
    }

    await query('SET FOREIGN_KEY_CHECKS = 1');
    return true;
  } finally {
    conn.release();
  }
}

async function computeDatabaseChecksum(dbName) {
  const pool = getTenantPool(dbName);
  const conn = pool.connect ? await pool.connect() : await pool.getConnection();
  const query = async (sql, params) => formatResult(await conn.query(sql, params));
  const tableHashes = {};

  try {
    const tablesRes = await query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name`,
      [dbName]
    );

    for (const row of tablesRes.rows) {
      const tableName = row.table_name || row.TABLE_NAME;
      if (tableName === 'schema_migrations') continue;

      const dataRes = await query(`SELECT * FROM \`${tableName}\` ORDER BY 1 ASC`);
      const serialized = JSON.stringify(dataRes.rows);
      const hash = crypto.createHash('sha256').update(serialized).digest('hex');
      tableHashes[tableName] = hash;
    }

    return tableHashes;
  } finally {
    conn.release();
  }
}

async function dumpMasterDatabase(outputPath) {
  const { queryMaster } = require('../db/masterDb');
  const dbName = process.env.MASTER_DB_NAME || 'erp_master';
  const sqlStatements = [];

  sqlStatements.push(`-- ERP Studio Master Platform Database Backup: ${dbName}`);
  sqlStatements.push(`-- Date: ${new Date().toISOString()}`);
  sqlStatements.push(`SET FOREIGN_KEY_CHECKS = 0;\n`);

  const tablesRes = await queryMaster(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'`,
    [dbName]
  );
  const tables = tablesRes.rows.map((r) => r.table_name || r.TABLE_NAME).filter((t) => t !== 'schema_migrations');

  for (const tableName of tables) {
    const createRes = await queryMaster(`SHOW CREATE TABLE \`${tableName}\``);
    const createSql = createRes.rows[0]['Create Table'] || createRes.rows[0]['CREATE TABLE'] || Object.values(createRes.rows[0])[1];

    sqlStatements.push(`DROP TABLE IF EXISTS \`${tableName}\`;`);
    sqlStatements.push(`${createSql};\n`);

    const rowsRes = await queryMaster(`SELECT * FROM \`${tableName}\``);
    if (rowsRes.rows.length > 0) {
      const columns = Object.keys(rowsRes.rows[0]);
      const colNamesStr = columns.map((c) => `\`${c}\``).join(', ');

      const valueTuples = rowsRes.rows.map((row) => {
        const vals = columns.map((col) => {
          const val = row[col];
          if (val === null || val === undefined) return 'NULL';
          if (typeof val === 'number') return val;
          if (typeof val === 'boolean') return val ? 1 : 0;
          if (val instanceof Date) return `'${val.toISOString().slice(0, 19).replace('T', ' ')}'`;
          if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "\\'")}'`;
          return `'${String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
        });
        return `(${vals.join(', ')})`;
      });

      sqlStatements.push(`INSERT INTO \`${tableName}\` (${colNamesStr}) VALUES\n${valueTuples.join(',\n')};\n`);
    }
  }

  sqlStatements.push(`\nSET FOREIGN_KEY_CHECKS = 1;`);
  const sqlContent = sqlStatements.join('\n');
  fs.writeFileSync(outputPath, sqlContent, 'utf8');
  return { outputPath, bytes: fs.statSync(outputPath).size };
}

module.exports = {
  dumpTenantDatabase,
  dumpMasterDatabase,
  restoreTenantDatabase,
  computeDatabaseChecksum
};
