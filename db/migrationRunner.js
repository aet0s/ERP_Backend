const fs = require('fs');
const path = require('path');
const { masterPool } = require('./masterDb');

const MASTER_MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'master');
const TENANT_MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'tenant');

function formatQueryResult(res) {
  if (!res) return { rows: [], rowCount: 0, insertId: null, affectedRows: 0 };
  if (res.rows && Array.isArray(res.rows)) return res;

  const rows = Array.isArray(res) ? res[0] : res;
  if (Array.isArray(rows)) {
    return { rows, rowCount: rows.length, insertId: null, affectedRows: 0 };
  } else if (rows && typeof rows === 'object') {
    return { rows: [], rowCount: rows.affectedRows || 0, insertId: rows.insertId || null, affectedRows: rows.affectedRows || 0 };
  }
  return { rows: [], rowCount: 0, insertId: null, affectedRows: 0 };
}

function cleanSqlStatements(rawSql) {
  const withoutComments = rawSql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  return withoutComments
    .split(/;\s*[\r\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runMasterMigrations() {
  const conn = masterPool.connect ? await masterPool.connect() : await masterPool.getConnection();
  const query = async (sql, params) => formatQueryResult(await conn.query(sql, params));

  try {
    // Ensure master_schema_migrations table exists
    await query(`
      CREATE TABLE IF NOT EXISTS master_schema_migrations (
        version INT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    const files = fs.existsSync(MASTER_MIGRATIONS_DIR)
      ? fs.readdirSync(MASTER_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
      : [];

    for (const file of files) {
      const match = file.match(/^(\d+)_/);
      const version = match ? parseInt(match[1], 10) : 0;
      
      const appliedRows = await query('SELECT version FROM master_schema_migrations WHERE version = ?', [version]);
      if (appliedRows.rowCount === 0) {
        console.log(`Applying master migration [${file}]...`);
        const sql = fs.readFileSync(path.join(MASTER_MIGRATIONS_DIR, file), 'utf8');
        const statements = cleanSqlStatements(sql);

        for (const stmt of statements) {
          try {
            await query(stmt);
          } catch (execErr) {
            if (execErr.code !== 'ER_DUP_FIELDNAME' && execErr.code !== 'ER_DUP_KEYNAME' && execErr.code !== 'ER_TABLE_EXISTS_ERROR') {
              throw execErr;
            }
          }
        }
        await query('INSERT INTO master_schema_migrations (version, name) VALUES (?, ?)', [version, file]);
      }
    }
  } catch (err) {
    console.error('Error running master migrations:', err);
    throw err;
  } finally {
    conn.release();
  }
}

async function runTenantMigrations(tenantPool) {
  const conn = tenantPool.connect ? await tenantPool.connect() : await tenantPool.getConnection();
  const query = async (sql, params) => formatQueryResult(await conn.query(sql, params));

  try {
    // Ensure schema_migrations table exists
    await query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    const files = fs.existsSync(TENANT_MIGRATIONS_DIR)
      ? fs.readdirSync(TENANT_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
      : [];

    for (const file of files) {
      const match = file.match(/^(\d+)_/);
      const version = match ? parseInt(match[1], 10) : 0;

      const applied = await query('SELECT version FROM schema_migrations WHERE version = ?', [version]);
      if (applied.rowCount === 0) {
        console.log(`Applying tenant migration [${file}]...`);
        const sql = fs.readFileSync(path.join(TENANT_MIGRATIONS_DIR, file), 'utf8');
        const statements = cleanSqlStatements(sql);

        for (const stmt of statements) {
          try {
            await query(stmt);
          } catch (execErr) {
            if (execErr.code !== 'ER_DUP_FIELDNAME' && execErr.code !== 'ER_DUP_KEYNAME' && execErr.code !== 'ER_TABLE_EXISTS_ERROR') {
              throw execErr;
            }
          }
        }
        await query('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [version, file]);
      }
    }
  } catch (err) {
    console.error('Error running tenant migrations:', err);
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  runMasterMigrations,
  runTenantMigrations
};
