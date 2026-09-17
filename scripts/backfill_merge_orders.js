require('dotenv').config();
const { getTenantPool } = require('../db/tenantManager');

(async () => {
  const pool = getTenantPool('erp_company_8d54560145604fb1b3ceb22b1387a83a');

  // 1. For RUN-2026-2027-0006: add Mustard Oil output if not present
  const exists = await pool.query(
    "SELECT id FROM production_order_outputs WHERE order_id = '56dc3932-b9eb-48a0-99b1-505306e7b90a' AND item_id = '893e63ee-11d3-4686-855e-786d21b22ac6'"
  );
  if (exists.rowCount === 0) {
    await pool.query(
      "INSERT INTO production_order_outputs (id, order_id, item_id, item_type, target_quantity, uom) VALUES (UUID(), '56dc3932-b9eb-48a0-99b1-505306e7b90a', '893e63ee-11d3-4686-855e-786d21b22ac6', 'finished_good', 90.0000, 'Lts')"
    );
  }
  // 2. Delete RUN-2026-2027-0006-2
  await pool.query("DELETE FROM production_order_outputs WHERE order_id = '5c3ec151-c22f-417d-a5b1-41f8e61eb62f'");
  await pool.query("DELETE FROM production_orders WHERE id = '5c3ec151-c22f-417d-a5b1-41f8e61eb62f'");

  // 3. For RUN-2026-2027-0005 if it has -2
  const dup005 = await pool.query("SELECT id FROM production_orders WHERE order_number = 'RUN-2026-2027-0005-2'");
  if (dup005.rowCount > 0) {
    const parent005 = await pool.query("SELECT id FROM production_orders WHERE order_number = 'RUN-2026-2027-0005'");
    if (parent005.rowCount > 0) {
      await pool.query(
        "INSERT IGNORE INTO production_order_outputs (id, order_id, item_id, item_type, target_quantity, uom) VALUES (UUID(), ?, 'f2cb34c5-00db-41bb-9b9f-a36d286524fb', 'finished_good', 50.0000, 'kg')",
        [parent005.rows[0].id]
      );
      await pool.query("DELETE FROM production_order_outputs WHERE order_id = ?", [dup005.rows[0].id]);
      await pool.query("DELETE FROM production_orders WHERE id = ?", [dup005.rows[0].id]);
    }
  }

  const res = await pool.query(
    "SELECT po.order_number, poo.item_id, COALESCE(fg.name, i.name) as item_name, poo.target_quantity, poo.uom FROM production_orders po JOIN production_order_outputs poo ON poo.order_id = po.id LEFT JOIN finished_goods fg ON fg.id = poo.item_id LEFT JOIN items i ON i.id = poo.item_id WHERE po.order_number = 'RUN-2026-2027-0006'"
  );
  console.log('RUN-2026-2027-0006 outputs in DB:', res.rows);

  console.log('✅ Backfill merge completed successfully.');
  process.exit(0);
})();
