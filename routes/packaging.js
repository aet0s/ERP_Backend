'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, requirePermission } = require('../middleware/auth');
const {
  detectCycle,
  computeBaseQuantityEquivalent,
  validatePackagingLevel,
  calculatePackagingCapacity,
  calculateTotalPackagedCost,
  computePackagingSellingPrice
} = require('../lib/packagingEngine');

async function recalculateChildPackagingLevels(client, parentLevelId, baseSellingPrice) {
  const children = await client.query(
    'SELECT * FROM product_packaging_levels WHERE parent_level_id = ? AND status != "archived"',
    [parentLevelId]
  );
  for (const child of children.rows) {
    const allProdLevels = await client.query(
      'SELECT * FROM product_packaging_levels WHERE product_id = ? AND status != "archived"',
      [child.product_id]
    );
    const lMap = new Map();
    allProdLevels.rows.forEach(l => lMap.set(l.id, l));
    const newEquiv = computeBaseQuantityEquivalent(child, lMap);
    const newPrice = computePackagingSellingPrice(baseSellingPrice, newEquiv);
    await client.query(
      'UPDATE product_packaging_levels SET base_quantity_equivalent = ?, selling_price = ?, updated_at = NOW() WHERE id = ?',
      [newEquiv, newPrice, child.id]
    );
    await recalculateChildPackagingLevels(client, child.id, baseSellingPrice);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LIST PACKAGING LEVELS (By Product or All)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/levels', requireAuth, requirePermission('catalog', 'view'), async (req, res) => {
  try {
    const { product_id, status } = req.query;
    const conditions = ['1=1'];
    const params = [];

    if (product_id) {
      conditions.push('ppl.product_id = ?');
      params.push(product_id);
    }
    if (status) {
      conditions.push('ppl.status = ?');
      params.push(status);
    } else {
      conditions.push("ppl.status != 'archived'");
    }

    const isTable = req.query.table === '1' || Boolean(req.query.page);
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size || req.query.limit || '20', 10)));
    const offset = (page - 1) * pageSize;

    let total = 0;
    if (isTable) {
      const countRes = await req.tenantDb.query(
        `SELECT COUNT(*) AS count FROM product_packaging_levels ppl WHERE ${conditions.join(' AND ')}`,
        params
      );
      total = Number(countRes.rows[0]?.count || countRes.rows[0]?.['COUNT(*)'] || 0);
    }

    let query = `
      SELECT ppl.*,
             ppl.contains_quantity AS capacity_quantity,
             ppl.contains_unit AS capacity_unit,
             ppl.level_number AS level_order,
             parent.name AS parent_package_name,
             parent.package_unit AS parent_package_unit,
             parent.base_quantity_equivalent AS parent_base_quantity_equivalent,
             (SELECT COUNT(*) FROM product_packaging_materials ppm WHERE ppm.packaging_level_id = ppl.id) AS materials_count,
             COALESCE((SELECT SUM(ppm.quantity * ppm.cost_per_unit) FROM product_packaging_materials ppm WHERE ppm.packaging_level_id = ppl.id), 0) AS packaging_materials_cost
      FROM product_packaging_levels ppl
      LEFT JOIN product_packaging_levels parent ON parent.id = ppl.parent_level_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ppl.base_quantity_equivalent ASC, ppl.created_at ASC
    `;

    const queryParams = [...params];
    if (isTable) {
      query += ` LIMIT ? OFFSET ?`;
      queryParams.push(pageSize, offset);
    }

    const levels = await req.tenantDb.query(query, queryParams);

    if (isTable) {
      return res.json({
        items: levels.rows,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize) || 1,
        meta: {
          page,
          page_size: pageSize,
          total,
          total_pages: Math.ceil(total / pageSize) || 1
        }
      });
    }

    return res.json(levels.rows);
  } catch (err) {
    console.error('list packaging levels error', err);
    return res.status(500).json({ error: 'Failed to fetch packaging levels' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET ONE PACKAGING LEVEL WITH MATERIALS & CAPACITY
// ─────────────────────────────────────────────────────────────────────────────
router.get('/levels/:id', requireAuth, requirePermission('catalog', 'view'), async (req, res) => {
  try {
    const levelRes = await req.tenantDb.query(
      `SELECT ppl.*,
              ppl.contains_quantity AS capacity_quantity,
              ppl.contains_unit AS capacity_unit,
              ppl.level_number AS level_order,
              parent.name AS parent_package_name,
              parent.package_unit AS parent_package_unit,
              COALESCE(fg.name, i.name) AS product_name,
              COALESCE(fg.unit, i.unit, 'unit') AS product_base_unit,
              COALESCE(fg.default_price, i.last_purchase_price, 0) AS base_selling_price
       FROM product_packaging_levels ppl
       LEFT JOIN product_packaging_levels parent ON parent.id = ppl.parent_level_id
       LEFT JOIN finished_goods fg ON fg.id = ppl.product_id
       LEFT JOIN items i ON i.id = ppl.product_id
       WHERE ppl.id = ?`,
      [req.params.id]
    );

    if (levelRes.rowCount === 0) {
      return res.status(404).json({ error: 'Packaging level not found' });
    }

    const level = levelRes.rows[0];

    // Fetch Attached Materials (BOM components)
    const materialsRes = await req.tenantDb.query(
      `SELECT ppm.*, COALESCE(i.name, rm.name) AS item_name, COALESCE(i.code, '') AS item_code
       FROM product_packaging_materials ppm
       LEFT JOIN items i ON i.id = ppm.item_id
       LEFT JOIN raw_materials rm ON rm.id = ppm.item_id
       WHERE ppm.packaging_level_id = ?
       ORDER BY ppm.created_at ASC`,
      [req.params.id]
    );

    level.materials = materialsRes.rows;

    // Calculate packaging cost summary
    const costSummary = calculateTotalPackagedCost(
      level.base_selling_price,
      level.base_quantity_equivalent,
      materialsRes.rows
    );
    level.cost_summary = costSummary;

    // Calculate current capacity against available stock
    const stockCheck = await req.tenantDb.query(
      `SELECT COALESCE(SUM(CASE WHEN transaction_type = 'in' THEN quantity
                                WHEN transaction_type = 'out' THEN -quantity
                                ELSE quantity END), 0) AS net_stock
       FROM inventory_ledger
       WHERE item_id = ?`,
      [level.product_id]
    );
    const availableStock = Number(stockCheck.rows[0]?.net_stock || 0);
    level.capacity = calculatePackagingCapacity(availableStock, level.base_quantity_equivalent);

    return res.json(level);
  } catch (err) {
    console.error('get packaging level detail error', err);
    return res.status(500).json({ error: 'Failed to fetch packaging level details' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CREATE PACKAGING LEVEL
// ─────────────────────────────────────────────────────────────────────────────
router.post('/levels', requireAuth, requirePermission('catalog', 'create'), async (req, res) => {
  const {
    product_id,
    product_type = 'finished_good',
    name,
    package_unit,
    contains_quantity: rawContainsQty,
    capacity_quantity: rawCapacityQty,
    contains_unit,
    parent_level_id,
    selling_price = 0,
    mrp = 0,
    barcode,
    is_default = false,
    notes,
    materials = []
  } = req.body;

  const contains_quantity = rawContainsQty !== undefined ? rawContainsQty : rawCapacityQty;

  const client = await req.tenantDb.connect();
  const userId = req.user.user_id || req.user.id;

  try {
    await client.query('START TRANSACTION');

    // Fetch existing levels for this product to validate parent & compute base equivalent
    const existingLevelsRes = await client.query(
      'SELECT * FROM product_packaging_levels WHERE product_id = ?',
      [product_id]
    );
    const existingLevels = existingLevelsRes.rows;

    validatePackagingLevel(
      {
        product_id,
        name,
        package_unit,
        contains_quantity,
        parent_level_id
      },
      existingLevels
    );

    const levelsMap = new Map();
    existingLevels.forEach((l) => levelsMap.set(l.id, l));

    const totalBaseEquivalent = computeBaseQuantityEquivalent(
      { contains_quantity, parent_level_id },
      levelsMap
    );

    // Determine level number
    let levelNumber = 1;
    if (parent_level_id && levelsMap.has(parent_level_id)) {
      levelNumber = (Number(levelsMap.get(parent_level_id).level_number) || 1) + 1;
    }

    const levelId = crypto.randomUUID();

    // If is_default is true, clear any other default for this product
    if (is_default) {
      await client.query(
        'UPDATE product_packaging_levels SET is_default = 0 WHERE product_id = ?',
        [product_id]
      );
    }

    // Resolve contains_unit
    // Fetch base selling price and resolve contains unit
    const prodRes = await client.query(
      `SELECT COALESCE(base_selling_price, default_price, 0) AS base_selling_price, unit FROM finished_goods WHERE id = ?
       UNION
       SELECT COALESCE(base_selling_price, default_price, last_purchase_price, 0) AS base_selling_price, unit FROM items WHERE id = ?`,
      [product_id, product_id]
    );
    const baseSellingPrice = Number(prodRes.rows[0]?.base_selling_price) || 0;
    const computedSellingPrice = computePackagingSellingPrice(baseSellingPrice, totalBaseEquivalent);

    let resolvedContainsUnit = contains_unit ? contains_unit.trim() : null;
    if (!resolvedContainsUnit) {
      if (parent_level_id && levelsMap.has(parent_level_id)) {
        resolvedContainsUnit = levelsMap.get(parent_level_id).package_unit;
      } else {
        resolvedContainsUnit = prodRes.rows[0]?.unit || 'unit';
      }
    }

    await client.query(
      `INSERT INTO product_packaging_levels
         (id, product_id, product_type, level_number, name, package_unit, contains_quantity, contains_unit,
          parent_level_id, base_quantity_equivalent, selling_price, mrp, barcode, is_default, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        levelId,
        product_id,
        product_type,
        levelNumber,
        name.trim(),
        package_unit.trim(),
        Number(contains_quantity),
        resolvedContainsUnit,
        parent_level_id || null,
        totalBaseEquivalent,
        computedSellingPrice,
        Number(mrp) || 0,
        barcode || null,
        is_default ? 1 : 0,
        notes || null
      ]
    );

    // Insert packaging materials BOM if provided
    if (Array.isArray(materials) && materials.length > 0) {
      for (const mat of materials) {
        if (!mat.item_id || !mat.quantity) continue;
        await client.query(
          `INSERT INTO product_packaging_materials
             (id, packaging_level_id, item_id, quantity, uom, cost_per_unit, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            levelId,
            mat.item_id,
            Number(mat.quantity),
            mat.uom || 'unit',
            Number(mat.cost_per_unit) || 0,
            mat.notes || null
          ]
        );
      }
    }

    // Audit Log
    try {
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata)
         VALUES (?, ?, 'packaging_level_created', 'product_packaging_level', ?, ?)`,
        [crypto.randomUUID(), userId, levelId, JSON.stringify({ product_id, name, package_unit, base_quantity_equivalent: totalBaseEquivalent, selling_price })]
      );
    } catch (auditErr) {
      console.warn('Audit log write error:', auditErr.message);
    }

    await client.query('COMMIT');

    const created = await client.query('SELECT * FROM product_packaging_levels WHERE id = ?', [levelId]);
    return res.status(201).json(created.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('create packaging level error', err);
    return res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE PACKAGING LEVEL
// ─────────────────────────────────────────────────────────────────────────────
router.put('/levels/:id', requireAuth, requirePermission('catalog', 'edit'), async (req, res) => {
  const {
    name,
    package_unit,
    contains_quantity: rawContainsQty,
    capacity_quantity: rawCapacityQty,
    contains_unit,
    parent_level_id,
    selling_price,
    mrp,
    barcode,
    is_default,
    status,
    notes
  } = req.body;

  const rawQty = rawContainsQty !== undefined ? rawContainsQty : rawCapacityQty;

  const client = await req.tenantDb.connect();
  const userId = req.user.user_id || req.user.id;

  try {
    await client.query('START TRANSACTION');

    const currentRes = await client.query(
      'SELECT * FROM product_packaging_levels WHERE id = ? FOR UPDATE',
      [req.params.id]
    );
    if (currentRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Packaging level not found' });
    }

    const current = currentRes.rows[0];

    const allLevelsRes = await client.query(
      'SELECT * FROM product_packaging_levels WHERE product_id = ?',
      [current.product_id]
    );
    const allLevels = allLevelsRes.rows;

    const effectiveParentId = parent_level_id !== undefined ? parent_level_id : current.parent_level_id;
    const effectiveContainsQty = rawQty !== undefined ? Number(rawQty) : Number(current.contains_quantity);

    validatePackagingLevel(
      {
        id: req.params.id,
        product_id: current.product_id,
        name: name || current.name,
        package_unit: package_unit || current.package_unit,
        contains_quantity: effectiveContainsQty,
        parent_level_id: effectiveParentId
      },
      allLevels
    );

    const levelsMap = new Map();
    allLevels.forEach((l) => levelsMap.set(l.id, l));

    const totalBaseEquivalent = computeBaseQuantityEquivalent(
      { contains_quantity: effectiveContainsQty, parent_level_id: effectiveParentId },
      levelsMap
    );

    if (is_default) {
      await client.query(
        'UPDATE product_packaging_levels SET is_default = 0 WHERE product_id = ?',
        [current.product_id]
      );
    }

    // Fetch base selling price
    const prodRes = await client.query(
      `SELECT COALESCE(base_selling_price, default_price, 0) AS base_selling_price FROM finished_goods WHERE id = ?
       UNION
       SELECT COALESCE(base_selling_price, default_price, last_purchase_price, 0) AS base_selling_price FROM items WHERE id = ?`,
      [current.product_id, current.product_id]
    );
    const baseSellingPrice = Number(prodRes.rows[0]?.base_selling_price) || 0;
    const computedSellingPrice = computePackagingSellingPrice(baseSellingPrice, totalBaseEquivalent);

    await client.query(
      `UPDATE product_packaging_levels SET
         name = COALESCE(?, name),
         package_unit = COALESCE(?, package_unit),
         contains_quantity = ?,
         contains_unit = COALESCE(?, contains_unit),
         parent_level_id = ?,
         base_quantity_equivalent = ?,
         selling_price = ?,
         mrp = COALESCE(?, mrp),
         barcode = COALESCE(?, barcode),
         is_default = COALESCE(?, is_default),
         status = COALESCE(?, status),
         notes = COALESCE(?, notes),
         updated_at = NOW()
       WHERE id = ?`,
      [
        name,
        package_unit,
        effectiveContainsQty,
        contains_unit,
        effectiveParentId || null,
        totalBaseEquivalent,
        computedSellingPrice,
        mrp !== undefined ? Number(mrp) : undefined,
        barcode,
        is_default !== undefined ? (is_default ? 1 : 0) : undefined,
        status,
        notes,
        req.params.id
      ]
    );

    // Recursively recompute downstream child levels
    await recalculateChildPackagingLevels(client, req.params.id, baseSellingPrice);

    // Audit Log
    try {
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata)
         VALUES (?, ?, 'packaging_level_updated', 'product_packaging_level', ?, ?)`,
        [crypto.randomUUID(), userId, req.params.id, JSON.stringify({ name, selling_price, mrp, base_quantity_equivalent: totalBaseEquivalent })]
      );
    } catch (auditErr) {
      console.warn('Audit log write error:', auditErr.message);
    }

    await client.query('COMMIT');

    const updated = await client.query('SELECT * FROM product_packaging_levels WHERE id = ?', [req.params.id]);
    return res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('update packaging level error', err);
    return res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE / ARCHIVE PACKAGING LEVEL
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/levels/:id', requireAuth, requirePermission('catalog', 'delete'), async (req, res) => {
  const userId = req.user.user_id || req.user.id;
  try {
    // Check if child packaging levels depend on this
    const childCheck = await req.tenantDb.query(
      "SELECT COUNT(*) AS cnt FROM product_packaging_levels WHERE parent_level_id = ? AND status != 'archived'",
      [req.params.id]
    );
    if (Number(childCheck.rows[0]?.cnt || 0) > 0) {
      return res.status(400).json({
        error: 'Cannot delete this packaging level because higher-tier packages depend on it. Remove or reassign child packages first.'
      });
    }

    // Check if historical sales or production runs reference this level
    const [salesCheck, runsCheck] = await Promise.all([
      req.tenantDb.query('SELECT COUNT(*) AS cnt FROM sales_items WHERE packaging_level_id = ? OR packaging_config_id = ?', [req.params.id, req.params.id]),
      req.tenantDb.query('SELECT COUNT(*) AS cnt FROM production_run_outputs WHERE packaging_level_id = ? OR packaging_config_id = ?', [req.params.id, req.params.id])
    ]);

    const isReferenced = (Number(salesCheck.rows[0]?.cnt || 0) + Number(runsCheck.rows[0]?.cnt || 0)) > 0;

    if (isReferenced) {
      // Historical references exist: archive instead of hard delete
      await req.tenantDb.query(
        "UPDATE product_packaging_levels SET status = 'archived', is_default = 0, updated_at = NOW() WHERE id = ?",
        [req.params.id]
      );
      return res.json({
        message: 'Packaging level is referenced by historical sales/production and was safely archived.',
        archived: true
      });
    }

    // Unreferenced: delete cleanly
    await req.tenantDb.query('DELETE FROM product_packaging_levels WHERE id = ?', [req.params.id]);

    // Also delete from legacy packaging_configs if mapped
    await req.tenantDb.query('DELETE FROM packaging_configs WHERE id = ?', [req.params.id]).catch(() => {});

    // Audit Log
    try {
      await req.tenantDb.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata)
         VALUES (?, ?, 'packaging_level_deleted', 'product_packaging_level', ?, '{}')`,
        [crypto.randomUUID(), userId, req.params.id]
      );
    } catch (auditErr) {}

    return res.json({ message: 'Packaging level deleted successfully' });
  } catch (err) {
    console.error('delete packaging level error', err);
    return res.status(500).json({ error: 'Failed to delete packaging level' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PACKAGING CAPACITY CALCULATOR
// ─────────────────────────────────────────────────────────────────────────────
router.get('/levels/:id/capacity', requireAuth, requirePermission('catalog', 'view'), async (req, res) => {
  try {
    const levelRes = await req.tenantDb.query(
      `SELECT ppl.*, COALESCE(fg.unit, i.unit, 'unit') AS base_unit
       FROM product_packaging_levels ppl
       LEFT JOIN finished_goods fg ON fg.id = ppl.product_id
       LEFT JOIN items i ON i.id = ppl.product_id
       WHERE ppl.id = ?`,
      [req.params.id]
    );

    if (levelRes.rowCount === 0) return res.status(404).json({ error: 'Packaging level not found' });
    const level = levelRes.rows[0];

    // Net available inventory from inventory_ledger
    const stockRes = await req.tenantDb.query(
      `SELECT COALESCE(SUM(CASE WHEN transaction_type = 'in' THEN quantity
                                WHEN transaction_type = 'out' THEN -quantity
                                ELSE quantity END), 0) AS net_stock
       FROM inventory_ledger
       WHERE item_id = ?`,
      [level.product_id]
    );

    const available = Number(stockRes.rows[0]?.net_stock || 0);
    const capacity = calculatePackagingCapacity(available, level.base_quantity_equivalent);

    return res.json({
      level_id: level.id,
      package_name: level.name,
      package_unit: level.package_unit,
      base_unit: level.base_unit,
      ...capacity
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to calculate packaging capacity' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACH PACKAGING BOM MATERIAL
// ─────────────────────────────────────────────────────────────────────────────
router.post('/levels/:id/materials', requireAuth, requirePermission('catalog', 'edit'), async (req, res) => {
  const { item_id, quantity, uom, cost_per_unit, notes } = req.body;
  if (!item_id) return res.status(400).json({ error: 'item_id is required' });
  if (!quantity || Number(quantity) <= 0) return res.status(400).json({ error: 'quantity must be > 0' });

  const client = await req.tenantDb.connect();
  const userId = req.user.user_id || req.user.id;

  try {
    await client.query('START TRANSACTION');

    const levelRes = await client.query('SELECT id FROM product_packaging_levels WHERE id = ?', [req.params.id]);
    if (levelRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Packaging level not found' });
    }

    let unitCost = Number(cost_per_unit) || 0;
    if (unitCost <= 0) {
      // Lookup last purchase price from items
      const itemRes = await client.query('SELECT last_purchase_price, unit FROM items WHERE id = ?', [item_id]);
      if (itemRes.rowCount > 0) {
        unitCost = Number(itemRes.rows[0].last_purchase_price || 0);
      }
    }

    const materialId = crypto.randomUUID();
    await client.query(
      `INSERT INTO product_packaging_materials
         (id, packaging_level_id, item_id, quantity, uom, cost_per_unit, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [materialId, req.params.id, item_id, Number(quantity), uom || 'pcs', unitCost, notes || null]
    );

    // Audit Log
    try {
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata)
         VALUES (?, ?, 'packaging_material_added', 'product_packaging_material', ?, ?)`,
        [crypto.randomUUID(), userId, materialId, JSON.stringify({ packaging_level_id: req.params.id, item_id, quantity, unitCost })]
      );
    } catch (auditErr) {}

    await client.query('COMMIT');

    const created = await client.query(
      `SELECT ppm.*, COALESCE(i.name, rm.name) AS item_name
       FROM product_packaging_materials ppm
       LEFT JOIN items i ON i.id = ppm.item_id
       LEFT JOIN raw_materials rm ON rm.id = ppm.item_id
       WHERE ppm.id = ?`,
      [materialId]
    );

    return res.status(201).json(created.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to add packaging material: ' + err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REMOVE PACKAGING BOM MATERIAL
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/materials/:materialId', requireAuth, requirePermission('catalog', 'edit'), async (req, res) => {
  try {
    await req.tenantDb.query('DELETE FROM product_packaging_materials WHERE id = ?', [req.params.materialId]);
    return res.json({ message: 'Packaging material removed' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to remove packaging material' });
  }
});

module.exports = router;
