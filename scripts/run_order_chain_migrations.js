const { queryMaster } = require('d:/2. PERSONAL/ERP/backend/db/masterDb');
const { getTenantPool } = require('d:/2. PERSONAL/ERP/backend/db/tenantManager');

async function runMigrations() {
  console.log('--- STARTING ORDER CHAIN & SCHEMA MIGRATIONS ---');
  try {
    const compRes = await queryMaster('SELECT database_name FROM companies');
    for (const company of compRes.rows) {
      console.log(`Migrating tenant DB: ${company.database_name}...`);
      const tenantDb = await getTenantPool(company.database_name);

      // 1. Procurements columns
      const procurementCols = [
        "ALTER TABLE procurements ADD COLUMN status VARCHAR(50) DEFAULT 'Draft'",
        "ALTER TABLE procurements ADD COLUMN vendor_notes TEXT NULL",
        "ALTER TABLE procurements ADD COLUMN dispatch_tracking_ref VARCHAR(255) NULL",
        "ALTER TABLE procurements ADD COLUMN dispatch_date DATETIME NULL",
        "ALTER TABLE procurements ADD COLUMN received_date DATETIME NULL",
        "ALTER TABLE procurements ADD COLUMN sent_at DATETIME NULL"
      ];
      for (const sql of procurementCols) {
        try { await tenantDb.query(sql); } catch (e) {}
      }

      // 2. Sales / Sales Invoices columns
      const salesCols = [
        "ALTER TABLE sales ADD COLUMN status VARCHAR(50) DEFAULT 'Draft'",
        "ALTER TABLE sales ADD COLUMN customer_notes TEXT NULL",
        "ALTER TABLE sales ADD COLUMN decline_reason TEXT NULL",
        "ALTER TABLE sales ADD COLUMN dispatch_tracking_ref VARCHAR(255) NULL",
        "ALTER TABLE sales ADD COLUMN dispatch_date DATETIME NULL",
        "ALTER TABLE sales ADD COLUMN delivered_date DATETIME NULL",
        "ALTER TABLE sales ADD COLUMN sent_at DATETIME NULL"
      ];
      for (const sql of salesCols) {
        try { await tenantDb.query(sql); } catch (e) {}
      }

      // 3. Notifications table
      try {
        await tenantDb.query(`
          CREATE TABLE IF NOT EXISTS notifications (
            id VARCHAR(36) PRIMARY KEY,
            user_type VARCHAR(50) NOT NULL,
            user_id VARCHAR(36) NULL,
            vendor_id VARCHAR(36) NULL,
            customer_id VARCHAR(36) NULL,
            title VARCHAR(255) NOT NULL,
            message TEXT NOT NULL,
            link VARCHAR(255) NULL,
            is_read TINYINT(1) DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
      } catch (e) {
        console.warn('Notifications table creation note:', e.message);
      }

      // 4. Migrate existing legacy records to terminal state if status was null/draft
      await tenantDb.query("UPDATE procurements SET status = 'Received' WHERE status IS NULL OR status = 'Pending Vendor Confirmation'");
      await tenantDb.query("UPDATE sales SET status = 'Delivered' WHERE status IS NULL OR status = 'Paid'");
    }

    console.log('\n======================================================');
    console.log('SUCCESS: TENANT SCHEMA MIGRATIONS APPLIED SUCCESSFULLY!');
    console.log('======================================================');
    process.exit(0);
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  }
}

runMigrations();
