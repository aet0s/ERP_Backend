'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const { getNextDocumentNumber, syncNumberingSeries } = require('../lib/invoiceEngine');

const { queryMaster } = require('../db/masterDb');
const { getInventorySnapshot } = require('../lib/analytics');

// ─────────────────────────────────────────────────────────────────────────────
// LOCATIONS MASTER
// ─────────────────────────────────────────────────────────────────────────────

// List all active locations (Auto-initializes Primary Main Location from Company Setup if empty)
router.get('/locations', requireAuth, requirePermission('locations', 'view'), async (req, res) => {
  try {
    let result = await req.tenantDb.query(
      `SELECT id, location_code, name, address, city, state, is_default, status, notes, created_at, updated_at
       FROM locations
       WHERE deleted_at IS NULL
       ORDER BY is_default DESC, name ASC`
    );

    if (result.rowCount === 0) {
      let companyName = 'Main Location';
      let companyAddress = null;
      let companyCity = null;
      let companyState = null;

      const companyId = req.user?.company_id || req.user?.workspace_id;
      if (companyId) {
        try {
          const compRes = await queryMaster(
            'SELECT company_name, state FROM companies WHERE id = ?',
            [companyId]
          );
          if (compRes.rows && compRes.rows[0]) {
            const comp = compRes.rows[0];
            companyName = comp.company_name ? `${comp.company_name} (Main Factory / HQ)` : 'Main Location';
            companyState = comp.state || null;
          }
        } catch (mErr) {
          console.warn('[LOCATION AUTO-SEED] Could not fetch master company info:', mErr.message);
        }
      }

      const defaultLocId = crypto.randomUUID();
      await req.tenantDb.query(
        `INSERT INTO locations (id, location_code, name, address, city, state, is_default, status, notes)
         VALUES (?, 'LOC-0001', ?, ?, ?, ?, 1, 'Active', 'Primary main location auto-initialized from business setup')`,
        [defaultLocId, companyName, companyAddress, companyCity, companyState]
      );

      result = await req.tenantDb.query(
        `SELECT id, location_code, name, address, city, state, is_default, status, notes, created_at, updated_at
         FROM locations
         WHERE deleted_at IS NULL
         ORDER BY is_default DESC, name ASC`
      );
    }

    // Ensure every location has a location_code populated
    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows[i];
      if (!row.location_code || !String(row.location_code).trim()) {
        const generatedCode = row.is_default ? 'LOC-0001' : `LOC-${String(i + 1).padStart(4, '0')}`;
        row.location_code = generatedCode;
        req.tenantDb.query('UPDATE locations SET location_code = ? WHERE id = ?', [generatedCode, row.id]).catch(() => {});
      }
    }

    return res.json(result.rows);
  } catch (err) {
    console.error('list locations error', err);
    return res.status(500).json({ error: 'Failed to fetch locations' });
  }
});

// Get single location with stock summary
router.get('/locations/:id', requireAuth, requirePermission('locations', 'view'), async (req, res) => {
  try {
    const locRes = await req.tenantDb.query(
      'SELECT * FROM locations WHERE id = ? AND deleted_at IS NULL',
      [req.params.id]
    );
    if (locRes.rowCount === 0) return res.status(404).json({ error: 'Location not found' });

    const loc = locRes.rows[0];

    // Stock summary at this location
    const stockRes = await req.tenantDb.query(
      `SELECT item_type, item_id,
              SUM(CASE WHEN transaction_type = 'in' THEN quantity
                       WHEN transaction_type = 'out' THEN -quantity
                       ELSE quantity END) AS current_stock
       FROM inventory_ledger
       WHERE location_id = ?
       GROUP BY item_type, item_id
       HAVING current_stock > 0`,
      [req.params.id]
    );

    loc.stock_item_count = stockRes.rowCount;

    // Detailed stock items stored at this location
    const itemsRes = await req.tenantDb.query(
      `SELECT il.item_type, il.item_id,
              COALESCE(i.name, fg.name, rm.name, 'Warehouse Item') AS item_name,
              COALESCE(i.code, fg.hsn_code, '') AS code,
              COALESCE(i.unit, fg.unit, rm.unit, 'units') AS unit,
              SUM(CASE WHEN il.transaction_type = 'in' THEN il.quantity
                       WHEN il.transaction_type = 'out' THEN -il.quantity
                       ELSE il.quantity END) AS quantity
       FROM inventory_ledger il
       LEFT JOIN items i ON i.id = il.item_id
       LEFT JOIN finished_goods fg ON fg.id = il.item_id
       LEFT JOIN raw_materials rm ON rm.id = il.item_id
       WHERE il.location_id = ?
       GROUP BY il.item_type, il.item_id, item_name, code, unit
       HAVING quantity > 0
       ORDER BY quantity DESC`,
      [req.params.id]
    );

    // Fetch inventory snapshot for this location to resolve exact WAC costs, selling prices, and packaging
    const snapshot = await getInventorySnapshot(req.tenantDb, req.params.id).catch(() => []);
    const snapMap = {};
    for (const s of snapshot) {
      snapMap[`${s.item_type}:${s.item_id}`] = s;
    }

    // Fallbacks from finished_goods and inventory_ledger
    const [fgPricesRes, ledgerCostRes] = await Promise.all([
      req.tenantDb.query('SELECT id, default_price, base_selling_price FROM finished_goods WHERE deleted_at IS NULL').catch(() => ({ rows: [] })),
      req.tenantDb.query(`
        SELECT item_type, item_id,
               SUM(CASE WHEN transaction_type = 'in' AND unit_cost > 0 THEN quantity * unit_cost ELSE 0 END) /
               NULLIF(SUM(CASE WHEN transaction_type = 'in' AND unit_cost > 0 THEN quantity ELSE 0 END), 0) AS wac_cost,
               MAX(CASE WHEN unit_cost > 0 THEN unit_cost ELSE 0 END) AS latest_cost
        FROM inventory_ledger
        WHERE (location_id = ? OR location_id IS NULL) AND unit_cost > 0
        GROUP BY item_type, item_id
      `, [req.params.id]).catch(() => ({ rows: [] }))
    ]);

    const fgPriceMap = {};
    for (const fg of fgPricesRes.rows) {
      fgPriceMap[fg.id] = Number(fg.default_price || fg.base_selling_price || 0);
    }

    const ledgerCostMap = {};
    for (const lc of ledgerCostRes.rows) {
      ledgerCostMap[`${lc.item_type}:${lc.item_id}`] = Number(lc.wac_cost || lc.latest_cost || 0);
    }

    loc.items = itemsRes.rows.map(r => {
      const snap = snapMap[`${r.item_type}:${r.item_id}`];
      const qty = Number(r.quantity || 0);
      const unitCost = Number(snap?.unit_cost || ledgerCostMap[`${r.item_type}:${r.item_id}`] || 0);
      const sellingPrice = Number(snap?.selling_price || fgPriceMap[r.item_id] || 0);
      const rate = unitCost > 0 ? unitCost : (sellingPrice || 0);
      const total = qty * rate;

      return {
        ...r,
        name: r.item_name,
        quantity: qty,
        rate_per_unit: rate,
        unit_cost: unitCost,
        selling_price: sellingPrice,
        line_total: total,
        packaging_summary: snap?.packaging_summary || null,
        packaged_stock: snap?.packaged_stock || null,
        package_name: snap?.package_name || null,
        package_unit: snap?.package_unit || null
      };
    });

    loc.total_valuation = loc.items.reduce((sum, item) => sum + (item.line_total || 0), 0);

    return res.json(loc);
  } catch (err) {
    console.error('get location error', err);
    return res.status(500).json({ error: 'Failed to fetch location' });
  }
});

// Create location
router.post('/locations', requireAuth, requirePermission('locations', 'create'), async (req, res) => {
  const { name, address, city, state, is_default = false, notes } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Location name is required' });

  const id = crypto.randomUUID();
  const client = await req.tenantDb.connect();
  try {
    await client.query('START TRANSACTION');
    if (is_default) {
      // Un-default any existing default location
      await client.query('UPDATE locations SET is_default = 0 WHERE is_default = 1');
    }
    const locCode = req.body.location_code && String(req.body.location_code).trim()
      ? String(req.body.location_code).trim().toUpperCase()
      : await getNextDocumentNumber(client, 'location');
    await syncNumberingSeries(client, 'location', locCode);

    await client.query(
      `INSERT INTO locations (id, name, address, city, state, is_default, notes, status, location_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Active', ?)`,
      [id, name.trim(), address || null, city || null, state || null, is_default ? 1 : 0, notes || null, locCode]
    );
    await client.query('COMMIT');
    const fetched = await req.tenantDb.query('SELECT * FROM locations WHERE id = ?', [id]);
    return res.status(201).json(fetched.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('create location error', err);
    return res.status(500).json({ error: 'Failed to create location' });
  } finally {
    client.release();
  }
});

// Update location
router.put('/locations/:id', requireAuth, requirePermission('locations', 'edit'), async (req, res) => {
  const { name, address, city, state, notes, status, location_code } = req.body;
  const client = await req.tenantDb.connect();
  try {
    await client.query('START TRANSACTION');
    const updateRes = await client.query(
      `UPDATE locations
       SET name    = COALESCE(?, name),
           address = COALESCE(?, address),
           city    = COALESCE(?, city),
           state   = COALESCE(?, state),
           notes   = COALESCE(?, notes),
           status  = COALESCE(?, status),
           location_code = COALESCE(?, location_code),
           updated_at = NOW()
       WHERE id = ? AND deleted_at IS NULL`,
      [name || null, address || null, city || null, state || null, notes || null, status || null, location_code ? location_code.trim().toUpperCase() : null, req.params.id]
    );
    if (updateRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Location not found' });
    }
    await client.query('COMMIT');
    const fetched = await req.tenantDb.query('SELECT * FROM locations WHERE id = ?', [req.params.id]);
    return res.json(fetched.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('update location error', err);
    return res.status(500).json({ error: 'Failed to update location' });
  } finally {
    client.release();
  }
});

// Set location as default
router.post('/locations/:id/set-default', requireAuth, requirePermission('locations', 'edit'), async (req, res) => {
  const client = await req.tenantDb.connect();
  try {
    await client.query('START TRANSACTION');
    const locRes = await client.query('SELECT id FROM locations WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (locRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Location not found' });
    }
    await client.query('UPDATE locations SET is_default = 0');
    await client.query('UPDATE locations SET is_default = 1 WHERE id = ?', [req.params.id]);
    await client.query('COMMIT');
    const fetched = await req.tenantDb.query('SELECT * FROM locations WHERE id = ?', [req.params.id]);
    return res.json(fetched.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('set-default location error', err);
    return res.status(500).json({ error: 'Failed to set default location' });
  } finally {
    client.release();
  }
});

// Soft delete location
router.delete('/locations/:id', requireAuth, requirePermission('locations', 'delete'), async (req, res) => {
  const userId = req.user.user_id || req.user.id;
  const client = await req.tenantDb.connect();
  try {
    await client.query('START TRANSACTION');
    const locRes = await client.query('SELECT id, is_default FROM locations WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [req.params.id]);
    if (locRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Location not found' });
    }
    if (locRes.rows[0].is_default) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot delete the default location. Set another location as default first.' });
    }
    // Check for active inventory at this location
    const stockCheck = await client.query(
      `SELECT SUM(CASE WHEN transaction_type = 'in' THEN quantity
                       WHEN transaction_type = 'out' THEN -quantity
                       ELSE quantity END) AS net_stock
       FROM inventory_ledger WHERE location_id = ?`,
      [req.params.id]
    );
    const netStock = Number(stockCheck.rows[0]?.net_stock || 0);
    if (netStock > 0.0001) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Cannot delete location: it has ${netStock.toFixed(2)} units of active stock. Transfer or adjust stock to zero first.`,
        net_stock: netStock
      });
    }
    await client.query(
      'UPDATE locations SET deleted_at = NOW(), deleted_by = ? WHERE id = ?',
      [userId, req.params.id]
    );
    await client.query('COMMIT');
    return res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('delete location error', err);
    return res.status(500).json({ error: 'Failed to delete location' });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STOCK TRANSFERS
// ─────────────────────────────────────────────────────────────────────────────

// List stock transfers (most recent first)
router.get('/stock-transfers', requireAuth, requirePermission('stock_transfers', 'view'), async (req, res) => {
  try {
    const params = [];
    let where = 'st.deleted_at IS NULL';

    if (req.query.from_location_id) {
      params.push(req.query.from_location_id);
      where += ` AND st.from_location_id = ?`;
    }
    if (req.query.to_location_id) {
      params.push(req.query.to_location_id);
      where += ` AND st.to_location_id = ?`;
    }
    if (req.query.item_type) {
      params.push(req.query.item_type);
      where += ` AND st.item_type = ?`;
    }
    if (req.query.start_date) {
      params.push(req.query.start_date);
      where += ` AND DATE(st.created_at) >= ?`;
    }
    if (req.query.end_date) {
      params.push(req.query.end_date);
      where += ` AND DATE(st.created_at) <= ?`;
    }

    if (req.query.search) {
      const q = `%${req.query.search}%`;
      params.push(q, q, q, q);
      where += ` AND (st.transfer_number LIKE ? OR st.notes LIKE ? OR fl.name LIKE ? OR tl.name LIKE ?)`;
    }

    const isTable = req.query.table === '1' || Boolean(req.query.page);
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size || req.query.limit || '20', 10)));
    const offset = (page - 1) * pageSize;

    const fromTable = `stock_transfers st
       LEFT JOIN locations fl ON fl.id = st.from_location_id
       LEFT JOIN locations tl ON tl.id = st.to_location_id
       LEFT JOIN items i ON i.id = st.item_id
       LEFT JOIN raw_materials rm ON rm.id = st.item_id
       LEFT JOIN finished_goods fg ON fg.id = st.item_id
       LEFT JOIN users u ON u.id = st.created_by
       LEFT JOIN inventory_ledger il_out ON il_out.reference_table = 'stock_transfers' AND il_out.reference_id = st.id AND il_out.transaction_type = 'out'
       LEFT JOIN product_packaging_levels ppl ON ppl.id = il_out.packaging_level_id`;

    let total = 0;
    if (isTable) {
      const countRes = await req.tenantDb.query(
        `SELECT COUNT(*) AS count FROM ${fromTable} WHERE ${where}`,
        params
      );
      total = Number(countRes.rows[0]?.count || countRes.rows[0]?.['COUNT(*)'] || 0);
    }

    let query = `
      SELECT st.id, st.transfer_number, st.item_type, st.item_id, st.quantity, st.notes, st.created_at,
             fl.name AS from_location_name, tl.name AS to_location_name,
             COALESCE(i.name, rm.name, fg.name) AS item_name,
             COALESCE(i.unit, rm.unit, fg.unit) AS item_unit,
             u.name AS created_by_name,
             il_out.package_count,
             ppl.package_unit,
             ppl.name AS package_name
      FROM ${fromTable}
      WHERE ${where}
      ORDER BY st.created_at DESC
    `;

    const queryParams = [...params];
    if (isTable) {
      query += ` LIMIT ? OFFSET ?`;
      queryParams.push(pageSize, offset);
    } else {
      query += ` LIMIT 100`;
    }

    const result = await req.tenantDb.query(query, queryParams);

    if (isTable) {
      return res.json({
        items: result.rows,
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

    return res.json(result.rows);
  } catch (err) {
    console.error('list stock transfers error', err);
    return res.status(500).json({ error: 'Failed to fetch stock transfers' });
  }
});

// Fetch available items for stock transfer by item_type and optional location_id
router.get('/stock-transfers/available-items', requireAuth, requirePermission('stock_transfers', 'view'), async (req, res) => {
  try {
    const { item_type = 'raw_material', location_id } = req.query;
    let items = [];

    if (item_type === 'raw_material') {
      const q = `
        SELECT rm.id, rm.name, rm.unit, COALESCE(i.code, '') AS code,
               COALESCE((
                 SELECT SUM(CASE WHEN il.transaction_type = 'in' THEN il.quantity ELSE -il.quantity END)
                 FROM inventory_ledger il
                 WHERE il.item_type = 'raw_material' AND il.item_id = rm.id
                 ${location_id ? 'AND il.location_id = ?' : ''}
               ), 0) AS current_stock
        FROM raw_materials rm
        LEFT JOIN items i ON i.id = rm.id
        WHERE rm.deleted_at IS NULL
        UNION
        SELECT i.id, i.name, i.unit, COALESCE(i.code, '') AS code,
               COALESCE((
                 SELECT SUM(CASE WHEN il.transaction_type = 'in' THEN il.quantity ELSE -il.quantity END)
                 FROM inventory_ledger il
                 WHERE il.item_type = 'raw_material' AND il.item_id = i.id
                 ${location_id ? 'AND il.location_id = ?' : ''}
               ), 0) AS current_stock
        FROM items i
        WHERE (LOWER(REPLACE(i.item_type, ' ', '_')) = 'raw_material' OR LOWER(i.item_type) LIKE '%material%' OR LOWER(i.item_type) LIKE '%raw%')
          AND i.deleted_at IS NULL
          AND i.id NOT IN (SELECT id FROM raw_materials WHERE deleted_at IS NULL)
        ORDER BY name ASC
      `;
      const params = location_id ? [location_id, location_id] : [];
      const result = await req.tenantDb.query(q, params);
      items = (result.rows || []).map(r => ({ ...r, current_stock: Number(r.current_stock || 0) }));
    } else if (item_type === 'finished_good') {
      const q = `
        SELECT fg.id, fg.name, fg.unit, COALESCE(fg.hsn_code, '') AS code,
               COALESCE((
                 SELECT SUM(CASE WHEN il.transaction_type = 'in' THEN il.quantity ELSE -il.quantity END)
                 FROM inventory_ledger il
                 WHERE il.item_type = 'finished_good' AND il.item_id = fg.id
                 ${location_id ? 'AND il.location_id = ?' : ''}
               ), 0) AS current_stock
        FROM finished_goods fg
        WHERE fg.deleted_at IS NULL
        UNION
        SELECT i.id, i.name, i.unit, COALESCE(i.code, '') AS code,
               COALESCE((
                 SELECT SUM(CASE WHEN il.transaction_type = 'in' THEN il.quantity ELSE -il.quantity END)
                 FROM inventory_ledger il
                 WHERE il.item_type = 'finished_good' AND il.item_id = i.id
                 ${location_id ? 'AND il.location_id = ?' : ''}
               ), 0) AS current_stock
        FROM items i
        WHERE (LOWER(REPLACE(i.item_type, ' ', '_')) = 'finished_good' OR LOWER(i.item_type) LIKE '%finish%')
          AND i.deleted_at IS NULL
          AND i.id NOT IN (SELECT id FROM finished_goods WHERE deleted_at IS NULL)
        ORDER BY name ASC
      `;
      const params = location_id ? [location_id, location_id] : [];
      const result = await req.tenantDb.query(q, params);
      const rawItems = (result.rows || []).map(r => ({ ...r, current_stock: Number(r.current_stock || 0) }));

      // Fetch packaging levels and packaging stock for finished goods
      const pplRes = await req.tenantDb.query(
        `SELECT id, product_id, name, package_unit, base_quantity_equivalent, is_default
         FROM product_packaging_levels
         WHERE status != 'archived'
         ORDER BY is_default DESC, base_quantity_equivalent ASC`
      ).catch(() => ({ rows: [] }));

      const pkgStockQ = `
        SELECT item_id, packaging_level_id,
               COALESCE(SUM(
                 CASE WHEN transaction_type = 'in' THEN COALESCE(package_count, 0)
                      WHEN transaction_type = 'out' THEN -COALESCE(package_count, 0)
                      ELSE 0 END
               ), 0) AS packaged_stock
        FROM inventory_ledger
        WHERE item_type = 'finished_good' AND packaging_level_id IS NOT NULL
        ${location_id ? 'AND location_id = ?' : ''}
        GROUP BY item_id, packaging_level_id
      `;
      const pkgStockRes = await req.tenantDb.query(pkgStockQ, location_id ? [location_id] : []).catch(() => ({ rows: [] }));

      const pkgStockMap = {};
      for (const ps of pkgStockRes.rows) {
        pkgStockMap[`${ps.item_id}:${ps.packaging_level_id}`] = Math.max(0, Number(ps.packaged_stock || 0));
      }

      const levelsByProduct = {};
      for (const l of pplRes.rows) {
        if (!levelsByProduct[l.product_id]) levelsByProduct[l.product_id] = [];
        const pStock = pkgStockMap[`${l.product_id}:${l.id}`] || 0;
        levelsByProduct[l.product_id].push({
          id: l.id,
          name: l.name,
          package_unit: l.package_unit || 'pkg',
          base_quantity_equivalent: Number(l.base_quantity_equivalent) || 1,
          is_default: Boolean(l.is_default),
          packaged_stock: pStock
        });
      }

      items = rawItems.map(fg => {
        const levels = levelsByProduct[fg.id] || [];
        if (levels.length > 0) {
          const inStockLevel = levels.find(l => l.packaged_stock > 0);
          const activeLevel = inStockLevel || levels.find(l => l.is_default) || levels[0];
          return {
            ...fg,
            base_unit: fg.unit,
            base_stock: fg.current_stock,
            unit: activeLevel.package_unit,
            package_name: activeLevel.name,
            package_unit: activeLevel.package_unit,
            packaging_level_id: activeLevel.id,
            units_per_package: activeLevel.base_quantity_equivalent,
            current_stock: activeLevel.packaged_stock,
            packaging_levels: levels
          };
        }
        return fg;
      });
    } else if (item_type === 'wip') {
      const q = `
        SELECT i.id, i.name, i.code, i.unit,
               COALESCE((
                 SELECT SUM(CASE WHEN il.transaction_type = 'in' THEN il.quantity ELSE -il.quantity END)
                 FROM inventory_ledger il
                 WHERE il.item_type = 'wip' AND il.item_id = i.id
                 ${location_id ? 'AND il.location_id = ?' : ''}
               ), 0) AS current_stock
        FROM items i
        WHERE (LOWER(REPLACE(i.item_type, ' ', '_')) = 'wip' OR LOWER(i.item_type) LIKE '%wip%')
          AND i.deleted_at IS NULL
        ORDER BY i.name ASC
      `;
      const params = location_id ? [location_id] : [];
      const result = await req.tenantDb.query(q, params);
      items = (result.rows || []).map(r => ({ ...r, current_stock: Number(r.current_stock || 0) }));
    }

    return res.json(items);
  } catch (err) {
    console.error('get stock-transfers available items error', err);
    return res.status(500).json({ error: 'Failed to fetch available items: ' + err.message });
  }
});

// Create stock transfer
router.post('/stock-transfers', requireAuth, requirePermission('stock_transfers', 'create'), async (req, res) => {
  const { from_location_id, to_location_id, item_type, item_id, quantity, packaging_level_id, notes } = req.body;
  const userId = req.user.user_id || req.user.id;

  if (!from_location_id) return res.status(400).json({ error: 'from_location_id is required' });
  if (!to_location_id) return res.status(400).json({ error: 'to_location_id is required' });
  if (from_location_id === to_location_id) return res.status(400).json({ error: 'Source and destination locations must be different' });
  if (!['raw_material', 'finished_good', 'wip'].includes(item_type)) return res.status(400).json({ error: 'Invalid item_type' });
  if (!item_id) return res.status(400).json({ error: 'item_id is required' });
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'quantity must be positive' });

  const client = await req.tenantDb.connect();
  try {
    await client.query('START TRANSACTION');

    // Validate locations exist
    const [fromLoc, toLoc] = await Promise.all([
      client.query('SELECT id FROM locations WHERE id = ? AND deleted_at IS NULL', [from_location_id]),
      client.query('SELECT id FROM locations WHERE id = ? AND deleted_at IS NULL', [to_location_id])
    ]);
    if (fromLoc.rowCount === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Source location not found' }); }
    if (toLoc.rowCount === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Destination location not found' }); }

    let unitsPerPkg = 1;
    let pkgCount = null;
    let baseQty = qty;
    let activePkgLevelId = packaging_level_id || null;

    if (item_type === 'finished_good') {
      let ppl = null;
      if (activePkgLevelId) {
        const pplRes = await client.query(
          'SELECT id, name, package_unit, base_quantity_equivalent FROM product_packaging_levels WHERE id = ?',
          [activePkgLevelId]
        );
        if (pplRes.rowCount > 0) ppl = pplRes.rows[0];
      } else {
        const pplRes = await client.query(
          'SELECT id, name, package_unit, base_quantity_equivalent FROM product_packaging_levels WHERE product_id = ? AND status != "archived" ORDER BY is_default DESC, base_quantity_equivalent ASC LIMIT 1',
          [item_id]
        );
        if (pplRes.rowCount > 0) {
          ppl = pplRes.rows[0];
          activePkgLevelId = ppl.id;
        }
      }

      if (ppl) {
        unitsPerPkg = Number(ppl.base_quantity_equivalent) || 1;
        pkgCount = qty; // User entered number of packages
        baseQty = qty * unitsPerPkg; // Total base unit equivalent

        // Check sufficient packaged stock at source location
        const pkgStockCheck = await client.query(
          `SELECT SUM(CASE WHEN transaction_type = 'in' THEN COALESCE(package_count, 0)
                           WHEN transaction_type = 'out' THEN -COALESCE(package_count, 0)
                           ELSE 0 END) AS net_packages
           FROM inventory_ledger
           WHERE item_type = 'finished_good' AND item_id = ? AND location_id = ? AND packaging_level_id = ?`,
          [item_id, from_location_id, activePkgLevelId]
        );
        const availPkgs = Number(pkgStockCheck.rows[0]?.net_packages || 0);
        if (qty > availPkgs) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `Insufficient stock at source location: available ${availPkgs} ${ppl.package_unit || 'packages'}`,
            available: availPkgs
          });
        }
      } else {
        // Fallback to base stock check
        const stockCheck = await client.query(
          `SELECT SUM(CASE WHEN transaction_type = 'in' THEN quantity
                           WHEN transaction_type = 'out' THEN -quantity
                           ELSE quantity END) AS net_stock
           FROM inventory_ledger
           WHERE item_type = ? AND item_id = ? AND location_id = ?`,
          [item_type, item_id, from_location_id]
        );
        const sourceStock = Number(stockCheck.rows[0]?.net_stock || 0);
        if (baseQty > sourceStock) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Insufficient stock at source location: available ${sourceStock}`, available: sourceStock });
        }
      }
    } else {
      // Raw Material / WIP stock check
      const stockCheck = await client.query(
        `SELECT SUM(CASE WHEN transaction_type = 'in' THEN quantity
                         WHEN transaction_type = 'out' THEN -quantity
                         ELSE quantity END) AS net_stock
         FROM inventory_ledger
         WHERE item_type = ? AND item_id = ? AND location_id = ?`,
        [item_type, item_id, from_location_id]
      );
      const sourceStock = Number(stockCheck.rows[0]?.net_stock || 0);
      if (baseQty > sourceStock) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Insufficient stock at source location: available ${sourceStock}`, available: sourceStock });
      }
    }

    // Generate transfer number
    const transferNumber = await getNextDocumentNumber(client, 'stock_transfer');

    const transferId = crypto.randomUUID();
    await client.query(
      `INSERT INTO stock_transfers (id, transfer_number, from_location_id, to_location_id, item_type, item_id, quantity, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [transferId, transferNumber, from_location_id, to_location_id, item_type, item_id, baseQty, notes || null, userId]
    );

    // Write paired OUT/IN ledger entries with package_count & packaging_level_id
    const outId = crypto.randomUUID();
    const inId = crypto.randomUUID();
    const today = new Date().toISOString().slice(0, 10);

    await client.query(
      `INSERT INTO inventory_ledger (id, item_type, item_id, transaction_type, quantity, package_count, packaging_level_id, location_id, reference_table, reference_id, reason, created_by, date)
       VALUES (?, ?, ?, 'out', ?, ?, ?, ?, 'stock_transfers', ?, 'Stock transfer out', ?, ?)`,
      [outId, item_type, item_id, baseQty, pkgCount, activePkgLevelId, from_location_id, transferId, userId, today]
    );
    await client.query(
      `INSERT INTO inventory_ledger (id, item_type, item_id, transaction_type, quantity, package_count, packaging_level_id, location_id, reference_table, reference_id, reason, created_by, date)
       VALUES (?, ?, ?, 'in', ?, ?, ?, ?, 'stock_transfers', ?, 'Stock transfer in', ?, ?)`,
      [inId, item_type, item_id, baseQty, pkgCount, activePkgLevelId, to_location_id, transferId, userId, today]
    );

    await client.query('COMMIT');

    const fetched = await req.tenantDb.query(
      `SELECT st.*, fl.name AS from_location_name, tl.name AS to_location_name
       FROM stock_transfers st
       LEFT JOIN locations fl ON fl.id = st.from_location_id
       LEFT JOIN locations tl ON tl.id = st.to_location_id
       WHERE st.id = ?`,
      [transferId]
    );
    return res.status(201).json(fetched.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('create stock transfer error', err);
    return res.status(500).json({ error: 'Failed to create stock transfer' });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// USER-LOCATION ASSIGNMENTS
// ─────────────────────────────────────────────────────────────────────────────

// Get assignments for a user
router.get('/users/:id/locations', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const result = await req.tenantDb.query(
      `SELECT ula.id, ula.location_id, l.name AS location_name, l.is_default, ula.created_at
       FROM user_location_assignments ula
       JOIN locations l ON l.id = ula.location_id
       WHERE ula.user_id = ? AND l.deleted_at IS NULL
       ORDER BY l.name ASC`,
      [req.params.id]
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch user location assignments' });
  }
});

// Assign user to location
router.post('/users/:id/locations', requireAuth, requireRole('manager'), async (req, res) => {
  const { location_id } = req.body;
  if (!location_id) return res.status(400).json({ error: 'location_id required' });
  try {
    const id = crypto.randomUUID();
    await req.tenantDb.query(
      'INSERT IGNORE INTO user_location_assignments (id, user_id, location_id) VALUES (?, ?, ?)',
      [id, req.params.id, location_id]
    );
    return res.status(201).json({ ok: true, user_id: req.params.id, location_id });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to assign user to location' });
  }
});

// Remove user from location
router.delete('/users/:id/locations/:lid', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    await req.tenantDb.query(
      'DELETE FROM user_location_assignments WHERE user_id = ? AND location_id = ?',
      [req.params.id, req.params.lid]
    );
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to remove user from location' });
  }
});

// Per-location stock snapshot
router.get('/stock-by-location', requireAuth, async (req, res) => {
  try {
    const { location_id, item_type } = req.query;
    const params = [];
    let where = "1=1";

    if (location_id) {
      params.push(location_id);
      where += ' AND il.location_id = ?';
    }
    if (item_type) {
      params.push(item_type);
      where += ' AND il.item_type = ?';
    }

    const result = await req.tenantDb.query(
      `SELECT
         il.location_id,
         l.name AS location_name,
         il.item_type,
         il.item_id,
         COALESCE(i.name, rm.name, fg.name) AS item_name,
         COALESCE(i.unit, rm.unit, fg.unit) AS unit,
         SUM(CASE WHEN il.transaction_type = 'in' THEN il.quantity
                  WHEN il.transaction_type = 'out' THEN -il.quantity
                  ELSE il.quantity END) AS current_stock
       FROM inventory_ledger il
       LEFT JOIN locations l ON l.id = il.location_id
       LEFT JOIN items i ON i.id = il.item_id
       LEFT JOIN raw_materials rm ON rm.id = il.item_id
       LEFT JOIN finished_goods fg ON fg.id = il.item_id
       WHERE ${where}
       GROUP BY il.location_id, l.name, il.item_type, il.item_id, item_name, unit
       HAVING current_stock > 0
       ORDER BY l.name ASC, il.item_type ASC, item_name ASC`,
      params
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('stock by location error', err);
    return res.status(500).json({ error: 'Failed to fetch stock by location' });
  }
});

module.exports = router;
