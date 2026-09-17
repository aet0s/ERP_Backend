'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const { getNextDocumentNumber, syncNumberingSeries } = require('../lib/invoiceEngine');

const { queryMaster } = require('../db/masterDb');

// ─────────────────────────────────────────────────────────────────────────────
// LOCATIONS MASTER
// ─────────────────────────────────────────────────────────────────────────────

// List all active locations (Auto-initializes Primary Main Location from Company Setup if empty)
router.get('/locations', requireAuth, requirePermission('locations', 'view'), async (req, res) => {
  try {
    let result = await req.tenantDb.query(
      `SELECT id, name, address, city, state, is_default, status, notes, created_at, updated_at
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
        `INSERT INTO locations (id, name, address, city, state, is_default, status, notes)
         VALUES (?, ?, ?, ?, ?, 1, 'Active', 'Primary main location auto-initialized from business setup')`,
        [defaultLocId, companyName, companyAddress, companyCity, companyState]
      );

      result = await req.tenantDb.query(
        `SELECT id, name, address, city, state, is_default, status, notes, created_at, updated_at
         FROM locations
         WHERE deleted_at IS NULL
         ORDER BY is_default DESC, name ASC`
      );
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
       LEFT JOIN users u ON u.id = st.created_by`;

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
             u.name AS created_by_name
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

// Create stock transfer
router.post('/stock-transfers', requireAuth, requirePermission('stock_transfers', 'create'), async (req, res) => {
  const { from_location_id, to_location_id, item_type, item_id, quantity, notes } = req.body;
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

    // Check sufficient stock at source location
    const stockCheck = await client.query(
      `SELECT SUM(CASE WHEN transaction_type = 'in' THEN quantity
                       WHEN transaction_type = 'out' THEN -quantity
                       ELSE quantity END) AS net_stock
       FROM inventory_ledger
       WHERE item_type = ? AND item_id = ? AND location_id = ?`,
      [item_type, item_id, from_location_id]
    );
    const sourceStock = Number(stockCheck.rows[0]?.net_stock || 0);
    if (qty > sourceStock) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Insufficient stock at source location: available ${sourceStock}`, available: sourceStock });
    }

    // Generate transfer number
    const transferNumber = await getNextDocumentNumber(client, 'stock_transfer');

    const transferId = crypto.randomUUID();
    await client.query(
      `INSERT INTO stock_transfers (id, transfer_number, from_location_id, to_location_id, item_type, item_id, quantity, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [transferId, transferNumber, from_location_id, to_location_id, item_type, item_id, qty, notes || null, userId]
    );

    // Write paired OUT/IN ledger entries
    const outId = crypto.randomUUID();
    const inId = crypto.randomUUID();
    const today = new Date().toISOString().slice(0, 10);

    await client.query(
      `INSERT INTO inventory_ledger (id, item_type, item_id, transaction_type, quantity, location_id, reference_table, reference_id, reason, created_by, date)
       VALUES (?, ?, ?, 'out', ?, ?, 'stock_transfers', ?, 'Stock transfer out', ?, ?)`,
      [outId, item_type, item_id, qty, from_location_id, transferId, userId, today]
    );
    await client.query(
      `INSERT INTO inventory_ledger (id, item_type, item_id, transaction_type, quantity, location_id, reference_table, reference_id, reason, created_by, date)
       VALUES (?, ?, ?, 'in', ?, ?, 'stock_transfers', ?, 'Stock transfer in', ?, ?)`,
      [inId, item_type, item_id, qty, to_location_id, transferId, userId, today]
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
