/**
 * migrate_phase6.js
 * Data migration script for Phase 6 (ERP multi-location + production runs).
 *
 * Run ONCE per tenant database after schema migrations 007-011 have been applied.
 * The script is idempotent — safe to re-run; it skips tenants already migrated.
 *
 * Usage:
 *   node backend/scripts/migrate_phase6.js [--dry-run] [--company-id=<id>]
 *
 * Options:
 *   --dry-run          Print what would be done without committing changes
 *   --company-id=<id>  Migrate a specific company only (omit for all companies)
 */

'use strict';

require('dotenv').config();
const crypto = require('crypto');
const { queryMaster } = require('../db/masterDb');
const { getTenantPool } = require('../db/tenantManager');
const { runTenantMigrations } = require('../db/migrationRunner');

const isDryRun = process.argv.includes('--dry-run');
const companyIdArg = process.argv.find((a) => a.startsWith('--company-id='));
const targetCompanyId = companyIdArg ? companyIdArg.split('=')[1] : null;

async function migrateTenant(company) {
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`Migrating: ${company.company_name} (${company.database_name})`);
  console.log(`═══════════════════════════════════════════════════`);

  const pool = getTenantPool(company.database_name);

  // First apply any pending schema migrations
  console.log('  [1/3] Applying schema migrations...');
  if (!isDryRun) {
    await runTenantMigrations(pool);
    console.log('  ✓ Schema migrations applied');
  } else {
    console.log('  [DRY-RUN] Would apply schema migrations');
  }

  const client = await pool.connect();
  try {
    // ─────────────────────────────────────────────────────────────────────
    // STEP 2: Create "Main Location" if no locations exist yet
    // ─────────────────────────────────────────────────────────────────────
    console.log('  [2/3] Setting up default location...');
    const locRes = await client.query('SELECT id FROM locations WHERE deleted_at IS NULL LIMIT 1');
    let defaultLocationId;

    if (locRes.rowCount === 0) {
      defaultLocationId = crypto.randomUUID();
      if (!isDryRun) {
        await client.query(
          `INSERT INTO locations (id, name, is_default, status)
           VALUES (?, 'Main Location', 1, 'Active')`,
          [defaultLocationId]
        );
        console.log(`  ✓ Created "Main Location" (id: ${defaultLocationId})`);
      } else {
        console.log(`  [DRY-RUN] Would create "Main Location" (id: ${defaultLocationId})`);
      }
    } else {
      defaultLocationId = locRes.rows[0].id;
      // Ensure one is marked as default
      const defaultRes = await client.query('SELECT id FROM locations WHERE is_default = 1 LIMIT 1');
      if (defaultRes.rowCount === 0 && !isDryRun) {
        await client.query('UPDATE locations SET is_default = 1 WHERE id = ? LIMIT 1', [defaultLocationId]);
      }
      console.log(`  ✓ Default location already exists (id: ${defaultLocationId})`);
    }

    // Backfill location_id on transaction tables (NULL rows only)
    if (!isDryRun) {
      const tables = [
        { table: 'inventory_ledger', col: 'location_id' },
        { table: 'procurements', col: 'location_id' },
        { table: 'production_batches', col: 'location_id' },
        { table: 'sales', col: 'location_id' },
      ];
      for (const { table, col } of tables) {
        try {
          const result = await client.query(
            `UPDATE ${table} SET ${col} = ? WHERE ${col} IS NULL`,
            [defaultLocationId]
          );
          console.log(`  ✓ Backfilled ${result.affectedRows} rows in ${table}.${col}`);
        } catch (e) {
          console.warn(`  ⚠ Could not backfill ${table}.${col}: ${e.message}`);
        }
      }
    } else {
      console.log('  [DRY-RUN] Would backfill location_id on inventory_ledger, procurements, production_batches, sales');
    }

    // ─────────────────────────────────────────────────────────────────────
    // STEP 3: Migrate production_batches → production_runs
    // ─────────────────────────────────────────────────────────────────────
    console.log('  [3/3] Migrating production batches to production runs...');

    const batchesRes = await client.query(
      `SELECT * FROM production_batches WHERE deleted_at IS NULL ORDER BY date ASC, created_at ASC`
    );

    console.log(`  Found ${batchesRes.rowCount} production batch(es) to migrate`);

    // Build a map of already-migrated batch IDs
    let alreadyMigrated = new Set();
    try {
      const migratedRes = await client.query(
        'SELECT migrated_from_batch_id FROM production_runs WHERE migrated_from_batch_id IS NOT NULL'
      );
      alreadyMigrated = new Set(migratedRes.rows.map((r) => r.migrated_from_batch_id));
    } catch (e) {
      // production_runs may not exist yet (schema migration not applied)
      console.warn('  ⚠ production_runs table not found — ensure schema migrations are applied first');
    }

    let migratedCount = 0;
    let skippedCount = 0;

    for (const batch of batchesRes.rows) {
      if (alreadyMigrated.has(batch.id)) {
        skippedCount++;
        continue;
      }

      if (isDryRun) {
        migratedCount++;
        continue;
      }

      // Get weighted-avg cost for this batch's input material
      let inputUnitCost = 0;
      try {
        const costRes = await client.query(
          `SELECT SUM(pi.quantity * pi.rate_per_unit) / NULLIF(SUM(pi.quantity), 0) AS avg_cost
           FROM procurement_items pi
           JOIN procurements p ON p.id = pi.procurement_id
           WHERE pi.item_id = ? AND p.deleted_at IS NULL AND p.date <= ?`,
          [batch.input_reference_id, batch.date]
        );
        inputUnitCost = Number(costRes.rows[0]?.avg_cost || 0);
      } catch (e) {
        // Fallback to simple procurement avg
        try {
          const costRes2 = await client.query(
            `SELECT AVG(rate_per_unit) AS avg_cost FROM procurements
             WHERE raw_material_id = ? AND deleted_at IS NULL AND date <= ?`,
            [batch.input_reference_id, batch.date]
          );
          inputUnitCost = Number(costRes2.rows[0]?.avg_cost || 0);
        } catch (_) {}
      }

      const runId = crypto.randomUUID();
      const runNumber = batch.batch_number ? `MIGR-${batch.batch_number}` : `MIGR-${runId.slice(0, 8).toUpperCase()}`;

      // Insert production_run header
      await client.query(
        `INSERT INTO production_runs
           (id, run_number, date, location_id, labor_cost, other_cost, total_input_cost, notes, migrated_from_batch_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          runId,
          runNumber,
          batch.date,
          defaultLocationId,
          Number(batch.labor_cost || 0),
          Number(batch.other_cost || 0),
          (Number(batch.input_quantity || 0) * inputUnitCost) + Number(batch.labor_cost || 0) + Number(batch.other_cost || 0),
          `[MIGRATED FROM BATCH ${batch.batch_number || batch.id}] ${batch.notes || ''}`.trim(),
          batch.id,
          batch.created_by || null,
          batch.created_at
        ]
      );

      // Insert input line (if batch has input material)
      if (batch.input_reference_id && Number(batch.input_quantity) > 0) {
        const inputId = crypto.randomUUID();
        const lineTotal = Number(batch.input_quantity) * inputUnitCost;
        await client.query(
          `INSERT INTO production_run_inputs
             (id, run_id, item_type, item_id, quantity, unit_cost, line_total_cost)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            inputId, runId,
            batch.input_material_type === 'raw_material' ? 'raw_material' : 'wip',
            batch.input_reference_id,
            Number(batch.input_quantity),
            inputUnitCost,
            lineTotal
          ]
        );
      }

      // Insert output line (if batch has output)
      if (batch.finished_good_id && Number(batch.output_quantity) > 0) {
        const outputId = crypto.randomUUID();
        const totalInputCost = (Number(batch.input_quantity || 0) * inputUnitCost) +
          Number(batch.labor_cost || 0) + Number(batch.other_cost || 0);
        const unitCostOutput = Number(batch.output_quantity) > 0 ? totalInputCost / Number(batch.output_quantity) : 0;

        await client.query(
          `INSERT INTO production_run_outputs
             (id, run_id, item_type, item_id, quantity_produced, unit, cost_allocation_percent, allocated_cost, unit_cost)
           VALUES (?, ?, 'finished_good', ?, ?, ?, 100, ?, ?)`,
          [
            outputId, runId,
            batch.finished_good_id,
            Number(batch.output_quantity),
            batch.output_unit || 'unit',
            totalInputCost,
            unitCostOutput
          ]
        );
      }

      migratedCount++;
    }

    if (isDryRun) {
      console.log(`  [DRY-RUN] Would migrate ${migratedCount} batch(es) to production runs`);
    } else {
      console.log(`  ✓ Migrated ${migratedCount} batch(es) | Skipped ${skippedCount} already-migrated`);
    }

  } finally {
    client.release();
  }
}

async function main() {
  console.log(`\n${'═'.repeat(55)}`);
  console.log('  ERP Phase 6 Data Migration Script');
  if (isDryRun) console.log('  MODE: DRY-RUN — no changes will be committed');
  console.log(`${'═'.repeat(55)}\n`);

  try {
    let companies;
    if (targetCompanyId) {
      const res = await queryMaster('SELECT id, company_name, database_name FROM companies WHERE id = ? AND status = ?', [targetCompanyId, 'active']);
      companies = res.rows;
    } else {
      const res = await queryMaster("SELECT id, company_name, database_name FROM companies WHERE status NOT IN ('provisioning', 'cancelled') ORDER BY created_at ASC");
      companies = res.rows;
    }

    console.log(`Found ${companies.length} company/companies to migrate\n`);

    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    for (const company of companies) {
      try {
        await migrateTenant(company);
        successCount++;
      } catch (err) {
        errorCount++;
        errors.push({ company: company.company_name, error: err.message });
        console.error(`  ✗ Error migrating ${company.company_name}: ${err.message}`);
      }
    }

    console.log(`\n${'═'.repeat(55)}`);
    console.log(`  Migration Complete`);
    console.log(`  ✓ Success: ${successCount}  ✗ Errors: ${errorCount}`);
    if (errors.length > 0) {
      console.log('\n  Failed companies:');
      for (const e of errors) console.log(`    - ${e.company}: ${e.error}`);
    }
    console.log(`${'═'.repeat(55)}\n`);

    if (require.main === module) {
      process.exit(errorCount > 0 ? 1 : 0);
    }
  } catch (err) {
    console.error('Fatal migration error:', err);
    if (require.main === module) process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { migrateTenant };
