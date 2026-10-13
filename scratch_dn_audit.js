const { getTenantPool } = require('./db/tenantManager');
const { queryMaster } = require('./db/masterDb');

(async () => {
  const companies = await queryMaster("SELECT database_name FROM companies WHERE status = 'active'");
  for (const c of companies.rows) {
    const db = getTenantPool(c.database_name);
    const dns = await db.query(`
      SELECT dn.id, dn.debit_note_number, dn.total_amount, dn.procurement_id, 
             p.procurement_number, p.total_amount AS proc_total, p.subtotal AS proc_subtotal, p.tax_amount AS proc_tax,
             (SELECT COUNT(*) FROM debit_note_items dni WHERE dni.debit_note_id = dn.id) AS item_count
      FROM debit_notes dn 
      LEFT JOIN procurements p ON p.id = dn.procurement_id
    `);
    console.log(c.database_name, dns.rows);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
