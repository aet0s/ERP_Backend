'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, requirePermission } = require('../middleware/auth');
const {
  validateFormula,
  scaleFormula,
  allocateProductionCosts
} = require('../lib/manufacturingEngine');

// ─────────────────────────────────────────────────────────────────────────────
// LIST FORMULAS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/formulas', requireAuth, requirePermission('production', 'view'), async (req, res) => {
  try {
    const { status, search, product_id } = req.query;
    const conditions = ['pf.deleted_at IS NULL'];
    const params = [];

    if (status) {
      conditions.push('pf.status = ?');
      params.push(status);
    }
    if (search) {
      conditions.push('(pf.name LIKE ? OR pf.code LIKE ? OR pf.notes LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (product_id) {
      conditions.push(`pf.id IN (SELECT formula_id FROM production_formula_outputs WHERE item_id = ?)`);
      params.push(product_id);
    }

    const whereSql = conditions.join(' AND ');

    const isExport = req.query.export === 'true' || req.query.all === 'true';
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = isExport ? 10000 : Math.max(1, Math.min(100, parseInt(req.query.page_size || req.query.limit || '20', 10)));
    const offset = isExport ? 0 : (page - 1) * pageSize;

    const countRes = await req.tenantDb.query(
      `SELECT COUNT(*) AS total FROM production_formulas pf WHERE ${whereSql}`,
      params
    );
    const total = Number(countRes.rows[0]?.total || 0);

    const formulas = await req.tenantDb.query(
      `SELECT pf.*,
              (SELECT COUNT(*) FROM production_formula_inputs WHERE formula_id = pf.id) AS input_count,
              (SELECT COUNT(*) FROM production_formula_outputs WHERE formula_id = pf.id) AS output_count,
              (SELECT pfo.quantity FROM production_formula_outputs pfo WHERE pfo.formula_id = pf.id ORDER BY pfo.sequence ASC LIMIT 1) AS batch_size,
              (SELECT pfo.uom FROM production_formula_outputs pfo WHERE pfo.formula_id = pf.id ORDER BY pfo.sequence ASC LIMIT 1) AS batch_uom,
              (SELECT GROUP_CONCAT(DISTINCT COALESCE(fg.name, i.name) SEPARATOR ', ')
               FROM production_formula_outputs pfo
               LEFT JOIN finished_goods fg ON fg.id = pfo.item_id
               LEFT JOIN items i ON i.id = pfo.item_id
               WHERE pfo.formula_id = pf.id) AS primary_outputs_summary
       FROM production_formulas pf
       WHERE ${whereSql}
       ORDER BY pf.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    const isTable = req.query.table === '1' || req.query.page || req.query.page_size;
    if (isTable) {
      return res.json({
        items: formulas.rows,
        meta: {
          page,
          page_size: pageSize,
          total,
          total_pages: Math.max(1, Math.ceil(total / pageSize))
        }
      });
    }
    return res.json(formulas.rows);
  } catch (err) {
    console.error('list manufacturing formulas error', err);
    return res.status(500).json({ error: 'Failed to fetch manufacturing formulas' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET ONE FORMULA WITH INPUTS & OUTPUTS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/formulas/:id', requireAuth, requirePermission('production', 'view'), async (req, res) => {
  try {
    const formulaRes = await req.tenantDb.query(
      'SELECT * FROM production_formulas WHERE id = ? AND deleted_at IS NULL',
      [req.params.id]
    );
    if (formulaRes.rowCount === 0) {
      return res.status(404).json({ error: 'Manufacturing formula not found' });
    }

    const formula = formulaRes.rows[0];

    // Fetch Inputs
    const inputsRes = await req.tenantDb.query(
      `SELECT pfi.*, COALESCE(i.name, rm.name) AS item_name, COALESCE(i.code, '') AS item_code,
              COALESCE(i.unit, rm.unit, pfi.uom) AS base_unit,
              COALESCE(i.last_purchase_price, i.default_price, 0) AS unit_cost
       FROM production_formula_inputs pfi
       LEFT JOIN items i ON i.id = pfi.item_id
       LEFT JOIN raw_materials rm ON rm.id = pfi.item_id
       WHERE pfi.formula_id = ?
       ORDER BY pfi.sequence ASC, pfi.created_at ASC`,
      [req.params.id]
    );

    // Fetch Outputs
    const outputsRes = await req.tenantDb.query(
      `SELECT pfo.*,
              pfo.item_id AS product_id,
              pfo.item_type AS product_type,
              COALESCE(fg.name, i.name) AS item_name,
              COALESCE(fg.name, i.name) AS product_name,
              COALESCE(fg.unit, i.unit, pfo.uom) AS base_unit,
              COALESCE(fg.default_price, i.last_purchase_price, 0) AS default_selling_price
       FROM production_formula_outputs pfo
       LEFT JOIN finished_goods fg ON fg.id = pfo.item_id
       LEFT JOIN items i ON i.id = pfo.item_id
       WHERE pfo.formula_id = ?
       ORDER BY pfo.sequence ASC, pfo.created_at ASC`,
      [req.params.id]
    );

    formula.inputs = inputsRes.rows;
    formula.outputs = outputsRes.rows;
    const primaryOut = formula.outputs[0];
    formula.batch_size = primaryOut ? Number(primaryOut.quantity) : 1;
    formula.batch_uom = primaryOut ? primaryOut.uom : 'unit';

    return res.json(formula);
  } catch (err) {
    console.error('get formula detail error', err);
    return res.status(500).json({ error: 'Failed to fetch formula details' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SCALE FORMULA
// ─────────────────────────────────────────────────────────────────────────────
// SCALE FORMULA
// ─────────────────────────────────────────────────────────────────────────────
async function handleScaleFormula(req, res) {
  try {
    const scaleMultiplier = req.query?.scale_multiplier ?? req.body?.scale_multiplier ?? req.query?.multiplier ?? req.body?.multiplier ?? req.query?.scale ?? req.body?.scale;
    const inputQuantity = req.query?.input_quantity ?? req.body?.input_quantity;
    const inputItemId = req.query?.input_item_id ?? req.body?.input_item_id;
    const batchSize = req.query?.batch_size ?? req.body?.batch_size;
    const targetQuantity = req.query?.target_quantity ?? req.body?.target_quantity;

    const formulaRes = await req.tenantDb.query(
      'SELECT * FROM production_formulas WHERE id = ? AND deleted_at IS NULL',
      [req.params.id]
    );
    if (formulaRes.rowCount === 0) return res.status(404).json({ error: 'Formula not found' });

    const inputs = await req.tenantDb.query(
      `SELECT pfi.*,
              pfi.item_id AS raw_material_id,
              pfi.item_id AS product_id,
              COALESCE(i.name, rm.name) AS item_name,
              COALESCE(i.unit, rm.unit, pfi.uom) AS base_unit,
              COALESCE(i.last_purchase_price, i.default_price, 0) AS unit_cost
       FROM production_formula_inputs pfi
       LEFT JOIN items i ON i.id = pfi.item_id
       LEFT JOIN raw_materials rm ON rm.id = pfi.item_id
       WHERE pfi.formula_id = ?
       ORDER BY pfi.sequence ASC`,
      [req.params.id]
    );

    const outputs = await req.tenantDb.query(
      `SELECT pfo.*,
              pfo.item_id AS product_id,
              pfo.item_type AS product_type,
              COALESCE(fg.name, i.name) AS item_name,
              COALESCE(fg.name, i.name) AS product_name,
              COALESCE(fg.unit, i.unit, pfo.uom) AS base_unit,
              COALESCE(fg.default_price, i.last_purchase_price, 0) AS default_selling_price
       FROM production_formula_outputs pfo
       LEFT JOIN finished_goods fg ON fg.id = pfo.item_id
       LEFT JOIN items i ON i.id = pfo.item_id
       WHERE pfo.formula_id = ?
       ORDER BY pfo.sequence ASC`,
      [req.params.id]
    );

    const formula = {
      ...formulaRes.rows[0],
      inputs: inputs.rows,
      outputs: outputs.rows
    };

    let scaled;
    if (inputQuantity !== undefined && inputQuantity !== null && inputQuantity !== '') {
      const targetInp = (inputItemId ? inputs.rows.find((i) => i.item_id === inputItemId) : null) || inputs.rows[0];
      const baseReq = Number(targetInp?.quantity) || 1;
      const lossPct = Number(targetInp?.expected_loss_percent || 0);
      const baseWithLoss = baseReq * (1 + (lossPct / 100));
      const mult = baseWithLoss > 0 ? (Number(inputQuantity) / baseWithLoss) : (Number(inputQuantity) / baseReq);
      scaled = scaleFormula(formula, mult, true);
    } else if (scaleMultiplier !== undefined && scaleMultiplier !== null && scaleMultiplier !== '') {
      scaled = scaleFormula(formula, Number(scaleMultiplier), true);
    } else if (targetQuantity !== undefined || batchSize !== undefined) {
      const rawTarget = targetQuantity ?? batchSize;
      scaled = scaleFormula(formula, Number(rawTarget), false);
    } else {
      scaled = scaleFormula(formula, 1, true);
    }

    return res.json({
      formula_id: formula.id,
      formula_name: formula.name,
      formula_version: formula.version,
      cost_allocation_method: formula.cost_allocation_method,
      ...scaled
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

router.get('/formulas/:id/scale', requireAuth, requirePermission('production', 'view'), handleScaleFormula);
router.post('/formulas/:id/scale', requireAuth, requirePermission('production', 'view'), handleScaleFormula);

// ─────────────────────────────────────────────────────────────────────────────
// CREATE FORMULA
// ─────────────────────────────────────────────────────────────────────────────
router.post('/formulas', requireAuth, requirePermission('production', 'create'), async (req, res) => {
  const {
    name,
    code,
    cost_allocation_method = 'manual_percentage',
    status = 'active',
    notes,
    inputs = [],
    outputs = []
  } = req.body;

  try {
    validateFormula({ name, inputs, outputs, cost_allocation_method });
  } catch (valErr) {
    return res.status(400).json({ error: valErr.message });
  }

  const client = await req.tenantDb.connect();
  const userId = req.user.user_id || req.user.id;

  try {
    await client.query('START TRANSACTION');

    const formulaId = crypto.randomUUID();
    const effectiveCode = code && code.trim() ? code.trim() : `FORM-${Date.now().toString().slice(-6)}`;

    await client.query(
      `INSERT INTO production_formulas
         (id, name, code, version, status, cost_allocation_method, notes, created_by)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      [formulaId, name.trim(), effectiveCode, status, cost_allocation_method, notes || null, userId]
    );

    // Insert inputs
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i];
      const inputId = crypto.randomUUID();
      const itemId = inp.item_id || inp.product_id || inp.raw_material_id;
      await client.query(
        `INSERT INTO production_formula_inputs
           (id, formula_id, item_type, item_id, quantity, uom, expected_loss_percent, sequence, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          inputId,
          formulaId,
          inp.item_type || 'raw_material',
          itemId,
          Number(inp.quantity),
          inp.uom.trim(),
          Number(inp.expected_loss_percent) || 0,
          i + 1,
          inp.notes || null
        ]
      );
    }

    // Insert outputs
    for (let i = 0; i < outputs.length; i++) {
      const out = outputs[i];
      const outputId = crypto.randomUUID();
      const itemId = out.item_id || out.product_id;
      await client.query(
        `INSERT INTO production_formula_outputs
           (id, formula_id, item_type, item_id, quantity, uom, cost_allocation_percent, sequence, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          outputId,
          formulaId,
          out.item_type || out.product_type || 'finished_good',
          itemId,
          Number(out.quantity),
          out.uom.trim(),
          Number(out.cost_allocation_percent) || 0,
          i + 1,
          out.notes || null
        ]
      );
    }

    // Audit Log
    try {
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata)
         VALUES (?, ?, 'formula_created', 'production_formula', ?, ?)`,
        [crypto.randomUUID(), userId, formulaId, JSON.stringify({ name, code: effectiveCode, inputsCount: inputs.length, outputsCount: outputs.length })]
      );
    } catch (auditErr) {
      console.warn('Audit log write error:', auditErr.message);
    }

    await client.query('COMMIT');

    const created = await client.query('SELECT * FROM production_formulas WHERE id = ?', [formulaId]);
    return res.status(201).json(created.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('create formula error', err);
    return res.status(500).json({ error: 'Failed to create formula: ' + err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE FORMULA (WITH VERSIONING GUARANTEE)
// ─────────────────────────────────────────────────────────────────────────────
router.put('/formulas/:id', requireAuth, requirePermission('production', 'edit'), async (req, res) => {
  const {
    name,
    code,
    cost_allocation_method,
    status,
    notes,
    inputs,
    outputs
  } = req.body;

  const client = await req.tenantDb.connect();
  const userId = req.user.user_id || req.user.id;

  try {
    await client.query('START TRANSACTION');

    const existingRes = await client.query(
      'SELECT * FROM production_formulas WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
      [req.params.id]
    );
    if (existingRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Formula not found' });
    }

    const currentFormula = existingRes.rows[0];

    // Check if this formula has already been used in historical production runs
    const runsCountRes = await client.query(
      'SELECT COUNT(*) AS cnt FROM production_runs WHERE formula_id = ? AND deleted_at IS NULL',
      [req.params.id]
    );
    const hasHistoricalRuns = Number(runsCountRes.rows[0]?.cnt || 0) > 0;

    // Validate inputs & outputs if provided
    const newInputs = inputs || [];
    const newOutputs = outputs || [];
    const newAllocMethod = cost_allocation_method || currentFormula.cost_allocation_method;

    if (inputs && outputs) {
      validateFormula({
        name: name || currentFormula.name,
        inputs: newInputs,
        outputs: newOutputs,
        cost_allocation_method: newAllocMethod
      });
    }

    let targetFormulaId = req.params.id;
    let newVersion = Number(currentFormula.version) || 1;

    if (hasHistoricalRuns) {
      // Historical runs exist! Versioning requirement: increment version number
      newVersion += 1;
    }

    await client.query(
      `UPDATE production_formulas SET
         name = COALESCE(?, name),
         code = COALESCE(?, code),
         version = ?,
         status = COALESCE(?, status),
         cost_allocation_method = COALESCE(?, cost_allocation_method),
         notes = COALESCE(?, notes),
         updated_at = NOW()
       WHERE id = ?`,
      [name, code, newVersion, status, cost_allocation_method, notes, targetFormulaId]
    );

    // If inputs / outputs were supplied, replace them
    if (Array.isArray(inputs) && inputs.length > 0) {
      await client.query('DELETE FROM production_formula_inputs WHERE formula_id = ?', [targetFormulaId]);
      for (let i = 0; i < inputs.length; i++) {
        const inp = inputs[i];
        const inpId = inp.item_id || inp.product_id || inp.raw_material_id;
        await client.query(
          `INSERT INTO production_formula_inputs
             (id, formula_id, item_type, item_id, quantity, uom, expected_loss_percent, sequence, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            targetFormulaId,
            inp.item_type || 'raw_material',
            inpId,
            Number(inp.quantity),
            inp.uom.trim(),
            Number(inp.expected_loss_percent || inp.scrap_percentage) || 0,
            i + 1,
            inp.notes || null
          ]
        );
      }
    }

    if (Array.isArray(outputs) && outputs.length > 0) {
      await client.query('DELETE FROM production_formula_outputs WHERE formula_id = ?', [targetFormulaId]);
      for (let i = 0; i < outputs.length; i++) {
        const out = outputs[i];
        const outId = out.item_id || out.product_id;
        await client.query(
          `INSERT INTO production_formula_outputs
             (id, formula_id, item_type, item_id, quantity, uom, cost_allocation_percent, sequence, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            targetFormulaId,
            out.item_type || out.product_type || 'finished_good',
            outId,
            Number(out.quantity),
            out.uom.trim(),
            Number(out.cost_allocation_percent) || 0,
            i + 1,
            out.notes || null
          ]
        );
      }
    }

    // Audit Log
    try {
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata)
         VALUES (?, ?, 'formula_updated', 'production_formula', ?, ?)`,
        [crypto.randomUUID(), userId, targetFormulaId, JSON.stringify({ version: newVersion, status })]
      );
    } catch (auditErr) {
      console.warn('Audit log write error:', auditErr.message);
    }

    await client.query('COMMIT');

    const updated = await client.query('SELECT * FROM production_formulas WHERE id = ?', [targetFormulaId]);
    return res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('update formula error', err);
    return res.status(500).json({ error: 'Failed to update formula: ' + err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE / ARCHIVE FORMULA
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/formulas/:id', requireAuth, requirePermission('production', 'delete'), async (req, res) => {
  const userId = req.user.user_id || req.user.id;
  try {
    // Check if used in historical production runs
    const runsCountRes = await req.tenantDb.query(
      'SELECT COUNT(*) AS cnt FROM production_runs WHERE formula_id = ? AND deleted_at IS NULL',
      [req.params.id]
    );
    const runsCount = Number(runsCountRes.rows[0]?.cnt || 0);

    if (runsCount > 0) {
      // Archive instead of hard delete to preserve historical integrity
      await req.tenantDb.query(
        `UPDATE production_formulas SET status = 'archived', updated_at = NOW() WHERE id = ?`,
        [req.params.id]
      );
      return res.json({
        message: 'Formula is referenced by historical production runs and was safely archived instead of deleted.',
        archived: true
      });
    }

    // Soft delete if never used
    await req.tenantDb.query(
      `UPDATE production_formulas SET deleted_at = NOW(), deleted_by = ? WHERE id = ?`,
      [userId, req.params.id]
    );

    return res.json({ message: 'Manufacturing formula deleted successfully' });
  } catch (err) {
    console.error('delete formula error', err);
    return res.status(500).json({ error: 'Failed to delete formula' });
  }
});

module.exports = router;
