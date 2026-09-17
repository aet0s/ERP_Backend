'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const { getNextDocumentNumber } = require('../lib/invoiceEngine');
const { allocateProductionCosts, calculateYieldAndVariances } = require('../lib/manufacturingEngine');
const { allocateProducedQuantity } = require('../lib/packagingEngine');
const { getWeightedAvgCost } = require('../lib/analytics');

// ─────────────────────────────────────────────────────────────────────────────
// LIST
// ─────────────────────────────────────────────────────────────────────────────
router.get('/production-runs', requireAuth, requirePermission('production', 'view'), async (req, res) => {
  try {
    const params = [];
    const conditions = ['pr.deleted_at IS NULL'];

    if (req.query.location_id) {
      params.push(req.query.location_id);
      conditions.push('pr.location_id = ?');
    }
    if (req.query.start_date) {
      params.push(req.query.start_date);
      conditions.push('pr.date >= ?');
    }
    if (req.query.end_date) {
      params.push(req.query.end_date);
      conditions.push('pr.date <= ?');
    }
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      conditions.push('(pr.run_number LIKE ? OR pr.notes LIKE ?)');
      params.push(`%${req.query.search}%`);
    }

    const where = conditions.join(' AND ');

    const isExport = req.query.export === 'true' || req.query.all === 'true';
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = isExport ? 10000 : Math.max(1, Math.min(100, parseInt(req.query.page_size || req.query.limit || '20', 10)));
    const offset = isExport ? 0 : (page - 1) * pageSize;

    const countRes = await req.tenantDb.query(
      `SELECT COUNT(*) AS total
       FROM production_runs pr
       WHERE ${where}`,
      params
    );
    const total = Number(countRes.rows[0]?.total || 0);

    const queryParams = [...params];
    const runs = await req.tenantDb.query(
      `SELECT pr.id, pr.run_number, pr.date, pr.location_id, pr.labor_cost, pr.other_cost,
              pr.total_input_cost, pr.notes,
              COALESCE(po.status, pr.status, 'open') AS status,
              pr.migrated_from_batch_id, pr.created_at,
              pr.formula_id, pr.formula_version, pr.yield_percent,
              pf.name AS formula_name,
              COALESCE(l.name, (SELECT name FROM locations WHERE is_default = 1 LIMIT 1), (SELECT name FROM locations LIMIT 1), 'Main Factory / HQ') AS location_name,
              (SELECT COUNT(*) FROM production_run_inputs pri WHERE pri.run_id = pr.id) AS input_count,
              (SELECT COUNT(*) FROM production_run_outputs pro WHERE pro.run_id = pr.id) AS output_count,
              (SELECT GROUP_CONCAT(DISTINCT 
                 CASE 
                   WHEN pro.packaging_name IS NOT NULL AND pro.packaging_name != '' 
                   THEN CONCAT(COALESCE(fg.name, i.name), ' (', pro.packaging_name, ')')
                   ELSE COALESCE(fg.name, i.name)
                 END 
               SEPARATOR ', ')
               FROM production_run_outputs pro
               LEFT JOIN items i ON i.id = pro.item_id
               LEFT JOIN finished_goods fg ON fg.id = pro.item_id
               WHERE pro.run_id = pr.id) AS output_summary
       FROM production_runs pr
       LEFT JOIN production_orders po ON ((pr.order_id IS NOT NULL AND po.id = pr.order_id) OR po.order_number = pr.run_number) AND po.deleted_at IS NULL
       LEFT JOIN locations l ON l.id = pr.location_id
       LEFT JOIN production_formulas pf ON pf.id = pr.formula_id
       WHERE ${where}
       ORDER BY pr.date DESC, pr.created_at DESC
       LIMIT ? OFFSET ?`,
      [...queryParams, pageSize, offset]
    );

    const isTable = req.query.table === '1' || req.query.page || req.query.page_size;
    if (isTable) {
      return res.json({
        items: runs.rows,
        meta: {
          page,
          page_size: pageSize,
          total,
          total_pages: Math.max(1, Math.ceil(total / pageSize))
        }
      });
    }
    return res.json(runs.rows);
  } catch (err) {
    console.error('list production runs error', err);
    return res.status(500).json({ error: 'Failed to fetch production runs' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET ONE
// ─────────────────────────────────────────────────────────────────────────────
router.get('/production-runs/:id', requireAuth, async (req, res) => {
  try {
    const runRes = await req.tenantDb.query(
      `SELECT pr.*,
              COALESCE(po.status, pr.status, 'open') AS status,
              pf.name AS formula_name,
              COALESCE(l.name, (SELECT name FROM locations WHERE is_default = 1 LIMIT 1), (SELECT name FROM locations LIMIT 1), 'Main Factory / HQ') AS location_name
       FROM production_runs pr
       LEFT JOIN production_orders po ON ((pr.order_id IS NOT NULL AND po.id = pr.order_id) OR po.order_number = pr.run_number) AND po.deleted_at IS NULL
       LEFT JOIN locations l ON l.id = pr.location_id
       LEFT JOIN production_formulas pf ON pf.id = pr.formula_id
       WHERE pr.id = ? AND pr.deleted_at IS NULL`,
      [req.params.id]
    );
    if (runRes.rowCount === 0) return res.status(404).json({ error: 'Production run not found' });

    const run = runRes.rows[0];

    // Inputs
    const inputsRes = await req.tenantDb.query(
      `SELECT pri.id, pri.item_type, pri.item_id, pri.quantity, pri.unit_cost, pri.line_total_cost,
              pri.expected_quantity, pri.variance_quantity, pri.uom,
              COALESCE(i.name, rm.name) AS item_name,
              COALESCE(i.unit, rm.unit, pri.uom) AS item_unit
       FROM production_run_inputs pri
       LEFT JOIN items i ON i.id = pri.item_id
       LEFT JOIN raw_materials rm ON rm.id = pri.item_id
       WHERE pri.run_id = ?`,
      [req.params.id]
    );

    // Outputs
    const outputsRes = await req.tenantDb.query(
      `SELECT pro.id, pro.item_type, pro.item_id, pro.quantity_produced, pro.unit,
              pro.packaging_level_id, pro.packaging_config_id, pro.packaging_name, pro.units_per_package, pro.base_quantity,
              pro.expected_quantity, pro.variance_quantity,
              pro.cost_allocation_percent, pro.allocated_cost, pro.unit_cost,
              COALESCE(fg.name, i.name) AS item_name,
              COALESCE(ppl.selling_price, fg.default_price, i.last_purchase_price, 0) AS default_price,
              fg.default_price AS base_selling_price,
              COALESCE(ppl.selling_price, 0) AS package_selling_price,
              COALESCE(ppl.mrp, 0) AS package_mrp,
              ppl.package_unit AS package_unit,
              ppl.contains_quantity AS fill_quantity,
              ppl.contains_unit AS fill_unit,
              fg.unit AS base_unit
       FROM production_run_outputs pro
       LEFT JOIN items i ON i.id = pro.item_id
       LEFT JOIN finished_goods fg ON fg.id = pro.item_id
       LEFT JOIN product_packaging_levels ppl ON ppl.id = COALESCE(pro.packaging_level_id, pro.packaging_config_id)
       WHERE pro.run_id = ?`,
      [req.params.id]
    );

    const outputIds = outputsRes.rows.map(o => o.id);
    if (outputIds.length > 0) {
      const allocsRes = await req.tenantDb.query(
        `SELECT proa.*,
                COALESCE(ppl.name, 'Package') AS level_name,
                COALESCE(ppl.name, 'Package') AS packaging_name,
                ppl.package_unit,
                ppl.contains_quantity,
                ppl.contains_unit,
                ppl.base_quantity_equivalent,
                ppl.base_quantity_equivalent AS base_unit_equivalent,
                COALESCE(ppl.selling_price, 0) AS selling_price,
                COALESCE(ppl.mrp, 0) AS mrp
         FROM production_run_output_allocations proa
         LEFT JOIN product_packaging_levels ppl ON ppl.id = proa.packaging_level_id
         WHERE proa.run_output_id IN (${outputIds.map(() => '?').join(',')})
         ORDER BY proa.created_at ASC`,
        outputIds
      );
      const allocMap = {};
      for (const a of allocsRes.rows) {
        if (!allocMap[a.run_output_id]) allocMap[a.run_output_id] = [];
        allocMap[a.run_output_id].push(a);
      }
      for (const o of outputsRes.rows) {
        o.allocations = allocMap[o.id] || [];
        const consumed = o.allocations.reduce((sum, a) => sum + Number(a.base_units_consumed || 0), 0);
        o.loose_remaining = Math.max(0, (Number(o.quantity_produced) || 0) - consumed);
      }
    }

    run.inputs = inputsRes.rows;
    run.outputs = outputsRes.rows;

    return res.json(run);
  } catch (err) {
    console.error('get production run error', err);
    return res.status(500).json({ error: 'Failed to fetch production run' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────────────────────
router.post('/production-runs', requireAuth, requirePermission('production', 'create'), async (req, res) => {
  const {
    date,
    required_by_date,
    priority = 'normal',
    location_id,
    formula_id,
    formula_version,
    cost_allocation_method = 'manual_percentage',
    labor_cost = 0,
    other_cost = 0,
    notes,
    inputs = [],   // [{ item_type, item_id, quantity, expected_quantity, uom, unit_cost }]
    outputs = []   // [{ item_type, item_id, quantity_produced, expected_quantity, unit, packaging_level_id, packaging_config_id, cost_allocation_percent }]
  } = req.body;

  if (!date) return res.status(400).json({ error: 'date is required' });
  if (!inputs || inputs.length === 0) return res.status(400).json({ error: 'At least one input material is required' });
  if (!outputs || outputs.length === 0) return res.status(400).json({ error: 'At least one output product is required' });

  // Validate input lines
  for (const [i, inp] of inputs.entries()) {
    inp.item_id = inp.item_id || inp.raw_material_id || inp.product_id;
    if (!inp.item_id) return res.status(400).json({ error: `Input line ${i + 1}: item_id is required` });
    if (!Number.isFinite(Number(inp.quantity)) || Number(inp.quantity) <= 0)
      return res.status(400).json({ error: `Input line ${i + 1}: quantity must be positive` });
  }
  // Validate output lines
  for (const [i, out] of outputs.entries()) {
    out.item_id = out.item_id || out.product_id;
    if (!out.item_id) return res.status(400).json({ error: `Output line ${i + 1}: item_id is required` });
    if (!Number.isFinite(Number(out.quantity_produced)) || Number(out.quantity_produced) <= 0)
      return res.status(400).json({ error: `Output line ${i + 1}: quantity_produced must be positive` });
  }

  const client = await req.tenantDb.connect();
  const userId = req.user.user_id || req.user.id;

  try {
    await client.query('START TRANSACTION');

    // Validate location if provided
    if (location_id) {
      const locRes = await client.query('SELECT id FROM locations WHERE id = ? AND deleted_at IS NULL', [location_id]);
      if (locRes.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'location_id not found' });
      }
    }

    // Determine effective location (use default if not specified)
    let effectiveLocationId = location_id || null;
    if (!effectiveLocationId) {
      const defLoc = await client.query('SELECT id FROM locations WHERE is_default = 1 LIMIT 1');
      if (defLoc.rowCount > 0) effectiveLocationId = defLoc.rows[0].id;
    }

    // ── STEP 1: Compute weighted-avg costs for inputs ──────────────────────
    let totalRawMatCost = 0;
    const enrichedInputs = [];

    for (const inp of inputs) {
      const qty = Number(inp.quantity);
      let unitCost = Number(inp.unit_cost) > 0 ? Number(inp.unit_cost) : await getWeightedAvgCost(client, inp.item_id, date);
      const lineTotal = qty * unitCost;
      totalRawMatCost += lineTotal;

      // Validate sufficient stock at location
      // NOTE: item_type can be 'raw_material', 'item', or 'wip' depending on how the item was procured.
      // We sum across ALL matching item_ids regardless of item_type to avoid false "Insufficient stock" errors.
      const stockCheck = await client.query(
        `SELECT SUM(CASE WHEN transaction_type = 'in' THEN quantity
                         WHEN transaction_type = 'out' THEN -quantity
                         ELSE quantity END) AS net_stock
         FROM inventory_ledger
         WHERE item_id = ? AND (location_id = ? OR ? IS NULL)`,
        [inp.item_id, effectiveLocationId, effectiveLocationId]
      );
      const available = Number(stockCheck.rows[0]?.net_stock || 0);
      if (qty > available + 0.0001) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Insufficient stock for input item: available ${available.toFixed(4)}, requested ${qty}`,
          item_id: inp.item_id,
          available
        });
      }

      // Expected vs actual variance
      const expQty = Number(inp.expected_quantity);
      const variance = Number.isFinite(expQty) && expQty > 0 ? qty - expQty : null;

      enrichedInputs.push({
        ...inp,
        qty,
        expected_quantity: Number.isFinite(expQty) && expQty > 0 ? expQty : null,
        variance_quantity: variance,
        unitCost,
        lineTotal
      });
    }

    const laborCost = Number(labor_cost) || 0;
    const otherCost = Number(other_cost) || 0;
    const totalRunCost = totalRawMatCost + laborCost + otherCost;

    // ── STEP 2: Resolve packaging details and prices for outputs ───────────
    for (const out of outputs) {
      const targetPkgId = out.packaging_level_id || out.packaging_config_id;
      if (targetPkgId) {
        // Try product_packaging_levels first
        const pplRes = await client.query(
          'SELECT name, package_unit, base_quantity_equivalent, selling_price FROM product_packaging_levels WHERE id = ?',
          [targetPkgId]
        );
        if (pplRes.rowCount > 0) {
          const ppl = pplRes.rows[0];
          out.packaging_level_id = targetPkgId;
          out.packaging_name = out.packaging_name || ppl.name;
          out.units_per_package = Number(out.units_per_package) || Number(ppl.base_quantity_equivalent) || 1;
          out.package_selling_price = Number(ppl.selling_price) || 0;
          if (!out.unit) out.unit = ppl.package_unit || 'pkg';
        } else {
          // Fallback to legacy packaging_configs if table exists
          const pkgRes = await client.query(
            'SELECT package_name, package_unit, units_per_package, selling_price FROM packaging_configs WHERE id = ?',
            [targetPkgId]
          ).catch(() => ({ rowCount: 0, rows: [] }));
          if (pkgRes.rowCount > 0) {
            const pc = pkgRes.rows[0];
            out.packaging_config_id = targetPkgId;
            out.packaging_name = out.packaging_name || pc.package_name;
            out.units_per_package = Number(out.units_per_package) || Number(pc.units_per_package) || 1;
            out.package_selling_price = Number(pc.selling_price) || 0;
            if (!out.unit) out.unit = pc.package_unit || 'pkg';
          }
        }
      } else {
        out.units_per_package = 1;
      }

      // Populate default selling price for value-based weighting if not already known
      if (!out.default_selling_price) {
        if (out.package_selling_price > 0) {
          out.default_selling_price = out.package_selling_price;
        } else {
          const fgPriceRes = await client.query('SELECT default_price FROM finished_goods WHERE id = ?', [out.item_id]);
          if (fgPriceRes.rowCount > 0 && Number(fgPriceRes.rows[0].default_price) > 0) {
            out.default_selling_price = Number(fgPriceRes.rows[0].default_price) * (Number(out.units_per_package) || 1);
          } else {
            const itemPriceRes = await client.query('SELECT last_purchase_price FROM items WHERE id = ?', [out.item_id]);
            if (itemPriceRes.rowCount > 0 && Number(itemPriceRes.rows[0].last_purchase_price) > 0) {
              out.default_selling_price = Number(itemPriceRes.rows[0].last_purchase_price);
            } else {
              out.default_selling_price = 0;
            }
          }
        }
      }
    }

    // ── STEP 3: Cost allocation across outputs ───────────────────────────
    // Cost allocation is simple: total input/processing money divided across final products produced
    const enrichedOutputs = allocateProductionCosts(outputs, totalRunCost, 'quantity_proportional');

    // Compute expected vs actual variances and overall yield
    const yieldAnalysis = calculateYieldAndVariances(enrichedInputs, enrichedOutputs);
    const overallYieldPct = yieldAnalysis.overall_yield_percent;

    // ── STEP 4: Insert production_run header ────────────────────────────────
    const runId = crypto.randomUUID();
    const runNumber = await getNextDocumentNumber(client, 'production_run');

    await client.query(
      `INSERT INTO production_runs
         (id, run_number, date, required_by_date, location_id, labor_cost, other_cost, total_input_cost, notes, formula_id, formula_version, yield_percent, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      [
        runId,
        runNumber,
        date,
        required_by_date || null,
        effectiveLocationId,
        laborCost,
        otherCost,
        totalRunCost,
        notes || null,
        formula_id || null,
        formula_version || 1,
        overallYieldPct,
        userId
      ]
    );

    // ── STEP 5: Insert input lines + OUT ledger entries ────────────────────
    for (const inp of enrichedInputs) {
      const inputRowId = crypto.randomUUID();
      await client.query(
        `INSERT INTO production_run_inputs
           (id, run_id, item_type, item_id, quantity, expected_quantity, variance_quantity, uom, unit_cost, line_total_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          inputRowId,
          runId,
          inp.item_type || 'raw_material',
          inp.item_id,
          inp.qty,
          inp.expected_quantity,
          inp.variance_quantity,
          inp.uom || null,
          inp.unitCost,
          inp.lineTotal
        ]
      );

      const ledgerId = crypto.randomUUID();
      await client.query(
        `INSERT INTO inventory_ledger
           (id, item_type, item_id, transaction_type, quantity, unit_cost, location_id, reference_table, reference_id, date, reason, created_by)
         VALUES (?, ?, ?, 'out', ?, ?, ?, 'production_runs', ?, ?, 'Consumed in production run', ?)`,
        [ledgerId, inp.item_type || 'raw_material', inp.item_id, inp.qty, inp.unitCost, effectiveLocationId, runId, date, userId]
      );
    }

    // ── STEP 6: Insert output lines + IN ledger entries ────────────────────
    const orderOutputsToInsert = [];

    for (const out of enrichedOutputs) {
      if (out.packaging_level_id || out.packaging_config_id) {
        const pkgLevelId = out.packaging_level_id || out.packaging_config_id;
        const pkgURes = await client.query(
          'SELECT name, package_unit, base_quantity_equivalent FROM product_packaging_levels WHERE id = ?',
          [pkgLevelId]
        );
        if (pkgURes.rowCount > 0) {
          const pl = pkgURes.rows[0];
          if (!out.unit && pl.package_unit) out.unit = pl.package_unit;
          if (!out.packaging_name && pl.name) out.packaging_name = pl.name;
          if (!out.units_per_package || Number(out.units_per_package) <= 1) {
            out.units_per_package = Number(pl.base_quantity_equivalent) || 1;
          }
        }
      }
      let fgUnit = 'unit';
      const fgURes = await client.query('SELECT unit FROM finished_goods WHERE id = ?', [out.item_id]);
      if (fgURes.rowCount > 0 && fgURes.rows[0].unit) fgUnit = fgURes.rows[0].unit;
      if (!out.unit) out.unit = fgUnit;

      const outputRowId = crypto.randomUUID();
      const qtyProd = Number(out.quantity_produced);
      const unitsPerPkg = Number(out.units_per_package) || 1;

      let baseQuantity = Number(out.base_quantity);
      if (!Number.isFinite(baseQuantity) || baseQuantity <= 0) {
        const isPackagedUnit = out.unit && fgUnit && out.unit.toLowerCase() !== fgUnit.toLowerCase();
        baseQuantity = ((out.packaging_level_id || out.packaging_config_id) && isPackagedUnit)
          ? qtyProd * unitsPerPkg
          : qtyProd;
      }
      const costPerBaseUnit = baseQuantity > 0 ? out.allocated_cost / baseQuantity : 0;

      const expOutQty = Number(out.expected_quantity);
      const outVariance = Number.isFinite(expOutQty) && expOutQty > 0 ? qtyProd - expOutQty : null;

      await client.query(
        `INSERT INTO production_run_outputs
           (id, run_id, item_type, item_id, packaging_level_id, packaging_config_id, packaging_name, units_per_package, base_quantity,
            expected_quantity, variance_quantity, quantity_produced, unit, cost_allocation_percent, allocated_cost, unit_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          outputRowId,
          runId,
          out.item_type || 'finished_good',
          out.item_id,
          out.packaging_level_id || null,
          out.packaging_config_id || null,
          out.packaging_name || null,
          unitsPerPkg,
          baseQuantity,
          Number.isFinite(expOutQty) && expOutQty > 0 ? expOutQty : null,
          outVariance,
          qtyProd,
          out.unit,
          out.cost_allocation_percent,
          out.allocated_cost,
          out.unit_cost
        ]
      );

      // NOTE: Finished goods stock is NOT inserted into inventory_ledger here.
      // Stock will ONLY be updated with stock when staff logs how much item is made in a shift log!

      // Save output allocations if provided or default single allocation
      const prodPkgLevelsRes = await client.query(
        'SELECT * FROM product_packaging_levels WHERE product_id = ? AND status != "archived"',
        [out.item_id]
      );

      let targetAllocations = [];
      if (Array.isArray(out.allocations) && out.allocations.length > 0) {
        targetAllocations = out.allocations;
      } else if (out.packaging_level_id || out.packaging_config_id) {
        targetAllocations = [{ packaging_level_id: out.packaging_level_id || out.packaging_config_id, package_count: qtyProd }];
      } else {
        targetAllocations = [{ packaging_level_id: null, package_count: qtyProd }];
      }

      const allocResult = allocateProducedQuantity(baseQuantity, targetAllocations, prodPkgLevelsRes.rows);
      for (const alloc of allocResult.allocations) {
        await client.query(
          `INSERT INTO production_run_output_allocations
             (id, run_output_id, packaging_level_id, package_count, base_units_consumed)
           VALUES (?, ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            outputRowId,
            alloc.packaging_level_id || null,
            alloc.package_count,
            alloc.base_units_consumed
          ]
        );
      }

      // Packaging-aware floor target: if output has packaging allocation, order should track package units!
      const primaryAlloc = allocResult.allocations.find((a) => a.packaging_level_id && Number(a.package_count) > 0);
      let orderTargetQty = qtyProd;
      let orderTargetUom = out.unit || 'unit';

      if (primaryAlloc && Number(primaryAlloc.package_count) > 0) {
        orderTargetQty = Number(primaryAlloc.package_count);
        orderTargetUom = primaryAlloc.package_unit || primaryAlloc.level_name || out.packaging_name || 'pkg';
      } else if (Number(expOutQty) > 0) {
        orderTargetQty = Number(expOutQty);
      }

      orderOutputsToInsert.push({
        item_id: out.item_id,
        item_type: out.item_type || 'finished_good',
        target_quantity: orderTargetQty,
        uom: orderTargetUom
      });
    }

    // ── STEP 7: Create production_orders header & production_order_outputs ──
    if (orderOutputsToInsert.length > 0) {
      const orderId = crypto.randomUUID();
      const primaryOrderOutput = orderOutputsToInsert[0];

      await client.query(
        `INSERT INTO production_orders
           (id, order_number, formula_id, formula_version, target_item_id, target_item_type, target_quantity, target_uom, required_by_date, location_id, priority, notes, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        [
          orderId,
          runNumber,
          formula_id || null,
          formula_version || 1,
          primaryOrderOutput.item_id,
          primaryOrderOutput.item_type,
          primaryOrderOutput.target_quantity,
          primaryOrderOutput.uom,
          required_by_date || date,
          effectiveLocationId,
          priority || 'normal',
          notes || null,
          userId
        ]
      );

      for (const oout of orderOutputsToInsert) {
        await client.query(
          `INSERT INTO production_order_outputs
             (id, order_id, item_id, item_type, target_quantity, uom)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            orderId,
            oout.item_id,
            oout.item_type,
            oout.target_quantity,
            oout.uom
          ]
        );
      }

      await client.query('UPDATE production_runs SET order_id = ? WHERE id = ?', [orderId, runId]);
    }

    // Audit Log
    try {
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata)
         VALUES (?, ?, 'production_run_created', 'production_run', ?, ?)`,
        [crypto.randomUUID(), userId, runId, JSON.stringify({ runNumber, totalCost: totalRunCost, yieldPercent: overallYieldPct, formula_id })]
      );
    } catch (auditErr) {}

    await client.query('COMMIT');

    // Return full detail
    const run = await req.tenantDb.query(
      `SELECT pr.*, pf.name AS formula_name, l.name AS location_name
       FROM production_runs pr
       LEFT JOIN locations l ON l.id = pr.location_id
       LEFT JOIN production_formulas pf ON pf.id = pr.formula_id
       WHERE pr.id = ?`,
      [runId]
    );
    const inpRows = await req.tenantDb.query('SELECT * FROM production_run_inputs WHERE run_id = ?', [runId]);
    const outRows = await req.tenantDb.query('SELECT * FROM production_run_outputs WHERE run_id = ?', [runId]);

    return res.status(201).json({ ...run.rows[0], inputs: inpRows.rows, outputs: outRows.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('create production run error', err);
    return res.status(500).json({ error: 'Failed to create production run: ' + err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE (soft delete + reverse all ledger entries with base units guarantee)
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/production-runs/:id', requireAuth, requirePermission('production', 'delete'), async (req, res) => {
  const userId = req.user.user_id || req.user.id;
  const client = await req.tenantDb.connect();

  try {
    await client.query('START TRANSACTION');

    const runRes = await client.query(
      'SELECT * FROM production_runs WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
      [req.params.id]
    );
    if (runRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Production run not found' });
    }
    const run = runRes.rows[0];

    // Reverse input ledger entries: each OUT becomes an IN reversal
    const inputsRes = await client.query(
      'SELECT * FROM production_run_inputs WHERE run_id = ?', [req.params.id]
    );
    for (const inp of inputsRes.rows) {
      const revId = crypto.randomUUID();
      await client.query(
        `INSERT INTO inventory_ledger
           (id, item_type, item_id, transaction_type, quantity, unit_cost, location_id, reference_table, reference_id, date, reason, created_by)
         VALUES (?, ?, ?, 'in', ?, ?, ?, 'production_runs', ?, ?, 'Soft delete reversal: production run voided', ?)`,
        [revId, inp.item_type, inp.item_id, inp.quantity, inp.unit_cost, run.location_id, req.params.id, run.date, userId]
      );
    }

    // Reverse output ledger entries ONLY IF this run actually inserted 'in' entries into inventory_ledger
    // (In modern 2-stage shop floor flows, finished goods only enter inventory via shift logs, which are cleaned up below)
    const existingOutputLedgerRes = await client.query(
      `SELECT * FROM inventory_ledger 
       WHERE reference_table = 'production_runs' 
         AND reference_id = ? 
         AND transaction_type = 'in' 
         AND reason NOT LIKE '%reversal%'`,
      [req.params.id]
    );
    for (const inEntry of existingOutputLedgerRes.rows) {
      const revId = crypto.randomUUID();
      await client.query(
        `INSERT INTO inventory_ledger
           (id, item_type, item_id, location_id, packaging_level_id, package_count, transaction_type, quantity, unit_cost, reference_table, reference_id, date, reason, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'out', ?, ?, 'production_runs', ?, ?, 'Soft delete reversal: production run voided', ?)`,
        [revId, inEntry.item_type, inEntry.item_id, run.location_id, inEntry.packaging_level_id || null, inEntry.package_count || null, inEntry.quantity, inEntry.unit_cost, req.params.id, run.date, userId]
      );
    }

    // Soft delete the linked production_order if present and clean up shift log inventory
    // Soft delete all linked production_orders and clean up shift log inventory
    const linkedOrdersRes = await client.query(
      `SELECT id FROM production_orders
       WHERE (id = ? OR order_number = ? OR order_number LIKE CONCAT(?, '-%')) AND deleted_at IS NULL`,
      [run.order_id, run.run_number, run.run_number]
    );
    for (const ord of linkedOrdersRes.rows) {
      const shiftLogsRes = await client.query(
        'SELECT id FROM production_shift_logs WHERE order_id = ?', [ord.id]
      );
      for (const slog of shiftLogsRes.rows) {
        await client.query(
          "DELETE FROM inventory_ledger WHERE reference_table = 'production_shift_logs' AND reference_id = ?",
          [slog.id]
        );
      }
      await client.query(
        'UPDATE production_orders SET status = \'cancelled\', deleted_at = NOW(), deleted_by = ? WHERE id = ?',
        [userId, ord.id]
      );
    }

    // Soft delete the run
    await client.query(
      'UPDATE production_runs SET status = \'cancelled\', deleted_at = NOW(), deleted_by = ? WHERE id = ?',
      [userId, req.params.id]
    );

    await client.query('COMMIT');
    return res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('delete production run error', err);
    return res.status(500).json({ error: 'Failed to delete production run' });
  } finally {
    client.release();
  }
});

module.exports = router;
