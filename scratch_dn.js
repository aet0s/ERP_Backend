const { getTenantPool } = require('./db/tenantManager');
const { queryMaster } = require('./db/masterDb');

(async () => {
  const c = await queryMaster('SELECT database_name FROM companies LIMIT 1');
  const db = getTenantPool(c.rows[0].database_name);
  const dn = await db.query('SELECT * FROM debit_notes ORDER BY created_at DESC LIMIT 3');
  console.log('DN:', dn.rows);
  if (dn.rows.length > 0) {
    const dni = await db.query('SELECT * FROM debit_note_items WHERE debit_note_id = ?', [dn.rows[0].id]);
    console.log('DNI:', dni.rows);
    const proc = await db.query('SELECT * FROM procurements WHERE id = ?', [dn.rows[0].procurement_id]);
    console.log('Proc:', proc.rows);
    const pi = await db.query('SELECT * FROM procurement_items WHERE procurement_id = ?', [dn.rows[0].procurement_id]);
    console.log('Proc Items:', pi.rows);
    const rr = await db.query('SELECT * FROM return_requests WHERE reference_id = ?', [dn.rows[0].procurement_id]);
    console.log('RR:', rr.rows);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
