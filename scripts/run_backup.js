const fs = require('fs');
const path = require('path');
const { dumpTenantDatabase } = require('../lib/backupEngine');
const { masterPool } = require('../db/masterDb');

async function dumpDatabase(dbName, outputPath, pool) {
  const conn = pool.connect ? await pool.connect() : await pool.getConnection();
  const formatResult = (res) => {
    if (!res) return { rows: [], rowCount: 0 };
    if (res && typeof res === 'object' && Array.isArray(res.rows)) return res;
    const rows = Array.isArray(res) ? res[0] : res;
    if (Array.isArray(rows)) return { rows, rowCount: rows.length };
    return { rows: [], rowCount: 0 };
  };
  const query = async (sql, params) => formatResult(await conn.query(sql, params));
  const sqlStatements = [];

  try {
    sqlStatements.push(`-- ERP Backup: ${dbName}`);
    sqlStatements.push(`-- Date: ${new Date().toISOString()}`);
    sqlStatements.push(`SET FOREIGN_KEY_CHECKS = 0;\n`);

    const tablesRes = await query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'`,
      [dbName]
    );

    const tables = tablesRes.rows.map((r) => r.table_name || r.TABLE_NAME);

    for (const tableName of tables) {
      const createRes = await query(`SHOW CREATE TABLE \`${tableName}\``);
      const createSql = createRes.rows[0]['Create Table'] || createRes.rows[0]['CREATE TABLE'] || Object.values(createRes.rows[0])[1];
      sqlStatements.push(`DROP TABLE IF EXISTS \`${tableName}\`;`);
      sqlStatements.push(`${createSql};\n`);

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

        const batchSize = 100;
        for (let i = 0; i < valueTuples.length; i += batchSize) {
          const slice = valueTuples.slice(i, i + batchSize);
          sqlStatements.push(`INSERT INTO \`${tableName}\` (${colNamesStr}) VALUES\n${slice.join(',\n')};\n`);
        }
      }
    }

    sqlStatements.push(`SET FOREIGN_KEY_CHECKS = 1;\n`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, sqlStatements.join('\n'), 'utf8');
    console.log(`Saved backup for [${dbName}] -> ${outputPath}`);
  } finally {
    conn.release();
  }
}

async function run() {
  const backupDir = path.join(__dirname, '..', '..', 'backups');
  await dumpDatabase(process.env.MASTER_DB_NAME || 'erp_master', path.join(backupDir, 'erp_master_backup.sql'), masterPool);
  await dumpTenantDatabase('erp_company_03867519ebfd4d798e8e7f9c5308f664', path.join(backupDir, 'erp_company_apollo_backup.sql'));
  console.log('Database backups completed successfully.');
  process.exit(0);
}

run().catch((err) => {
  console.error('Backup failed:', err);
  process.exit(1);
});
