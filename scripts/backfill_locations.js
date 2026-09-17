const { getTenantPool } = require('../db/tenantManager');
const { queryMaster } = require('../db/masterDb');

async function backfill() {
  const companies = await queryMaster("SELECT id, company_name, database_name FROM companies");
  for (const c of companies.rows) {
    try {
      const db = await getTenantPool(c.database_name);
      const defaultLoc = await db.query("SELECT id FROM locations WHERE is_default = 1 LIMIT 1");
      const defaultId = defaultLoc.rows[0]?.id;
      if (!defaultId) {
        console.log(`Skipping ${c.company_name}: No default location found`);
        continue;
      }

      const sRes = await db.query("UPDATE sales SET location_id = ? WHERE location_id IS NULL", [defaultId]);
      const pRes = await db.query("UPDATE procurements SET location_id = ? WHERE location_id IS NULL", [defaultId]);
      const prRes = await db.query("UPDATE production_runs SET location_id = ? WHERE location_id IS NULL", [defaultId]);
      const ilRes = await db.query("UPDATE inventory_ledger SET location_id = ? WHERE location_id IS NULL", [defaultId]);

      console.log(`Backfilled ${c.company_name} (default location: ${defaultId}): ` +
        `sales=${sRes.affectedRows || 0}, procurements=${pRes.affectedRows || 0}, ` +
        `runs=${prRes.affectedRows || 0}, ledger=${ilRes.affectedRows || 0}`);
    } catch (err) {
      console.error(`Error backfilling ${c.company_name}:`, err.message);
    }
  }
  process.exit(0);
}

backfill().catch(e => {
  console.error(e);
  process.exit(1);
});
