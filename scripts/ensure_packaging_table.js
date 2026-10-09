const { getTenantPool } = require('../db/tenantManager');

async function run() {
  const pool = getTenantPool('erp_company_03867519ebfd4d798e8e7f9c5308f664');
  const ddl = `
    CREATE TABLE IF NOT EXISTS packaging_configs (
      id VARCHAR(36) PRIMARY KEY,
      product_id VARCHAR(36) NOT NULL,
      product_type VARCHAR(50) NOT NULL DEFAULT 'finished_good',
      package_name VARCHAR(255) NOT NULL,
      package_unit VARCHAR(50) NOT NULL,
      units_per_package DECIMAL(15,4) NOT NULL DEFAULT 1,
      fill_quantity DECIMAL(15,4) DEFAULT 1,
      fill_unit VARCHAR(50),
      parent_config_id VARCHAR(36),
      mrp DECIMAL(15,4) DEFAULT 0,
      selling_price DECIMAL(15,4) DEFAULT 0,
      barcode VARCHAR(100),
      is_default TINYINT(1) DEFAULT 0,
      notes TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;
  await pool.query(ddl);

  const alterCols = [
    { name: 'packaging_config_id', def: 'VARCHAR(36)' },
    { name: 'package_unit', def: 'VARCHAR(50)' },
    { name: 'total_packages', def: 'DECIMAL(15,4) DEFAULT 0' },
    { name: 'units_per_package', def: 'DECIMAL(15,4) DEFAULT 1' }
  ];

  for (const col of alterCols) {
    try {
      await pool.query(`ALTER TABLE production_batches ADD COLUMN ${col.name} ${col.def}`);
      console.log(`Added column ${col.name} to production_batches`);
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') console.warn(e.message);
    }
  }

  console.log('packaging_configs & production_batches schema healed successfully');
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
