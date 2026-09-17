const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const { getNextDocumentNumber } = require('../lib/invoiceEngine');
const { getWeightedAvgCost } = require('../lib/analytics');
const { createNotification } = require('../lib/notifications');

// ─────────────────────────────────────────────────────────────────────────────
// VENDOR ORDER PROCESS CHAIN & PROCUREMENTS
// ─────────────────────────────────────────────────────────────────────────────

// List Multi-line Procurements
router.get('/procurements', requireAuth, requirePermission('procurement', 'view'), async (req, res) => {
  try {
    const { vendor_id, location_id, search, status, payment_status, start_date, end_date } = req.query;
    let where = 'p.deleted_at IS NULL';
    const params = [];

    // NON-NEGOTIABLE BACKEND ROW-LEVEL SCOPING FOR VENDORS
    if (req.user.role === 'vendor' || req.user.vendor_id) {
      params.push(req.user.vendor_id);
      where += ` AND p.vendor_id = ?`;
    } else if (vendor_id) {
      params.push(vendor_id);
      where += ` AND p.vendor_id = ?`;
    }

    if (location_id) {
      params.push(location_id, location_id);
      where += ` AND (p.location_id = ? OR (p.location_id IS NULL AND (SELECT id FROM locations WHERE is_default = 1 LIMIT 1) = ?))`;
    }

    if (status && status !== 'all') {
      if (status === 'Denied') {
        where += ` AND (p.status = 'Denied' OR p.status = 'Rejected')`;
      } else {
        params.push(status);
        where += ` AND p.status = ?`;
      }
    }

    if (payment_status && payment_status !== 'all') {
      if (payment_status === 'paid') {
        where += ` AND (p.amount_due <= 0.01 OR (p.total_amount > 0 AND p.amount_paid >= p.total_amount - 0.01))`;
      } else if (payment_status === 'partial') {
        where += ` AND p.amount_paid > 0.01 AND p.amount_due > 0.01`;
      } else if (payment_status === 'unpaid') {
        where += ` AND (p.amount_paid IS NULL OR p.amount_paid <= 0.01)`;
      }
    }

    if (start_date) {
      params.push(start_date);
      where += ` AND p.date >= ?`;
    }

    if (end_date) {
      params.push(end_date);
      where += ` AND p.date <= ?`;
    }

    if (search) {
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      where += ` AND (p.procurement_number LIKE ? OR v.name LIKE ? OR (SELECT GROUP_CONCAT(COALESCE(i.name, rm.name)) FROM procurement_items pi LEFT JOIN items i ON i.id = pi.item_id LEFT JOIN raw_materials rm ON rm.id = pi.item_id WHERE pi.procurement_id = p.id) LIKE ?)`;
    }

    const countRes = await req.tenantDb.query(
      `SELECT COUNT(*) AS count
       FROM procurements p
       LEFT JOIN vendors v ON v.id = p.vendor_id
       WHERE ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0]?.count || 0, 10);

    const isTable = req.query.table === '1';
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(parseInt(req.query.page_size || req.query.limit || (isTable ? '20' : '200'), 10), 10000);
    const offset = (page - 1) * pageSize;

    let query = `
      SELECT p.*, v.name AS vendor_name, v.vendor_code, v.gstin AS vendor_gstin,
             COALESCE(l.name, (SELECT name FROM locations WHERE is_default = 1 LIMIT 1), (SELECT name FROM locations LIMIT 1), 'Main Location') AS location_name,
             (SELECT COUNT(*) FROM procurement_items pi WHERE pi.procurement_id = p.id) AS item_count,
             (SELECT GROUP_CONCAT(DISTINCT COALESCE(i.name, rm.name, 'Item') SEPARATOR ', ') 
              FROM procurement_items pi 
              LEFT JOIN items i ON i.id = pi.item_id 
              LEFT JOIN raw_materials rm ON rm.id = pi.item_id 
              WHERE pi.procurement_id = p.id) AS item_names,
             (SELECT COALESCE(SUM(pi.quantity), 0) FROM procurement_items pi WHERE pi.procurement_id = p.id) AS total_item_quantity,
             (SELECT rr.id FROM return_requests rr WHERE rr.reference_id = p.id ORDER BY rr.created_at DESC LIMIT 1) AS return_request_id,
             (SELECT rr.status FROM return_requests rr WHERE rr.reference_id = p.id ORDER BY rr.created_at DESC LIMIT 1) AS return_status,
             (SELECT rr.reason FROM return_requests rr WHERE rr.reference_id = p.id ORDER BY rr.created_at DESC LIMIT 1) AS return_reason
      FROM procurements p
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN locations l ON l.id = p.location_id
      WHERE ${where}
      ORDER BY p.date DESC, p.created_at DESC
    `;

    const queryParams = [...params];
    if (isTable || req.query.page || req.query.limit) {
      query += ` LIMIT ? OFFSET ?`;
      queryParams.push(pageSize, offset);
    }

    const result = await req.tenantDb.query(query, queryParams);

    for (const r of result.rows) {
      const count = Number(r.item_count || 0);
      if (!r.item_names || r.item_names.trim() === '') {
        r.item_names = r.material_name || r.item_name || 'Procurement Item';
      }
      r.items_summary = count > 1 ? `${count} items: ${r.item_names}` : r.item_names;

      if (!r.total_item_quantity || Number(r.total_item_quantity) === 0) {
        r.total_item_quantity = Number(r.quantity || 0);
      }
      if (r.subtotal !== undefined && r.subtotal !== null && (Number(r.tax_amount) > 0 || Number(r.discount_amount) > 0 || Number(r.subtotal) > 0)) {
        r.total_amount = Number(r.subtotal || 0) + Number(r.tax_amount || 0) - Number(r.discount_amount || 0);
      } else if (!r.total_amount || Number(r.total_amount) === 0) {
        r.total_amount = Number(r.quantity || 0) * Number(r.rate_per_unit || 0);
      }
      r.amount_due = Math.max(0, Number(r.total_amount) - Number(r.amount_paid || 0));
    }

    if (isTable) {
      return res.json({
        items: result.rows,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize) || 1
      });
    }

    return res.json(result.rows);
  } catch (err) {
    console.error('get procurements error', err);
    return res.status(500).json({ error: 'Failed to fetch procurements' });
  }
});

// Single Procurement Details
router.get('/procurements/:id', requireAuth, async (req, res) => {
  try {
    const result = await req.tenantDb.query(
      `SELECT p.*, 
              v.name AS vendor_name, 
              v.vendor_code, 
              v.gstin AS vendor_gstin,
              v.pan AS vendor_pan,
              v.contact_person_name AS vendor_contact_person,
              COALESCE(v.phone, v.contact) AS vendor_phone,
              v.email AS vendor_email,
              v.address_line1 AS vendor_address_line1,
              v.address_line2 AS vendor_address_line2,
              v.address AS vendor_address,
              v.city AS vendor_city,
              v.state AS vendor_state,
              v.pincode AS vendor_pincode,
              v.country AS vendor_country,
              v.bank_account_name AS vendor_bank_account_name,
              v.bank_account_number AS vendor_bank_account_number,
              v.bank_ifsc AS vendor_bank_ifsc,
              COALESCE(l.name, (SELECT name FROM locations WHERE is_default = 1 LIMIT 1), 'Main Location') AS location_name
       FROM procurements p
       LEFT JOIN vendors v ON v.id = p.vendor_id
       LEFT JOIN locations l ON l.id = p.location_id
       WHERE p.id = ? AND p.deleted_at IS NULL`,
      [req.params.id]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'Procurement not found' });
    const proc = result.rows[0];

    // Accurate calculation of total_amount and amount_due
    const subtotal = Number(proc.subtotal) || 0;
    const taxAmount = Number(proc.tax_amount) || 0;
    const discount = Number(proc.discount_amount) || 0;
    if (subtotal > 0 || taxAmount > 0 || discount > 0) {
      proc.total_amount = subtotal + taxAmount - discount;
    } else if (!proc.total_amount || Number(proc.total_amount) === 0) {
      proc.total_amount = Number(proc.quantity || 0) * Number(proc.rate_per_unit || 0);
    } else {
      proc.total_amount = Number(proc.total_amount);
    }
    proc.amount_paid = Number(proc.amount_paid) || 0;
    proc.amount_due = Math.max(0, proc.total_amount - proc.amount_paid);

    // Items with SKU, HSN, Tax
    const itemsRes = await req.tenantDb.query(
      `SELECT pi.*, 
              COALESCE(i.name, rm.name, 'Item') AS item_name,
              COALESCE(i.code, '-') AS item_code,
              COALESCE(i.hsn_code, '-') AS hsn_code,
              COALESCE(i.unit, rm.unit, 'pcs') AS unit
       FROM procurement_items pi
       LEFT JOIN items i ON i.id = pi.item_id
       LEFT JOIN raw_materials rm ON rm.id = pi.item_id
       WHERE pi.procurement_id = ?
       ORDER BY pi.created_at ASC`,
      [req.params.id]
    );

    if (itemsRes.rows.length > 0) {
      proc.items = itemsRes.rows.map(item => ({
        ...item,
        quantity: Number(item.quantity || 0),
        rate_per_unit: Number(item.rate_per_unit || 0),
        tax_rate: Number(item.tax_rate || 0),
        tax_amount: Number(item.tax_amount || 0),
        line_total: Number(item.line_total || 0) || (Number(item.quantity || 0) * Number(item.rate_per_unit || 0))
      }));
    } else if (proc.raw_material_id) {
      const rmRes = await req.tenantDb.query(
        `SELECT id, name, code, hsn_code, unit FROM items WHERE id = ?
         UNION
         SELECT id, name, '-' AS code, '-' AS hsn_code, unit FROM raw_materials WHERE id = ?`,
        [proc.raw_material_id, proc.raw_material_id]
      );
      const rm = rmRes.rows[0];
      proc.items = [{
        id: proc.id,
        item_id: proc.raw_material_id,
        item_name: rm?.name || 'Item',
        item_code: rm?.code || '-',
        hsn_code: rm?.hsn_code || '-',
        unit: rm?.unit || 'units',
        quantity: Number(proc.quantity || 0),
        rate_per_unit: Number(proc.rate_per_unit || 0),
        tax_rate: 0,
        tax_amount: 0,
        line_total: Number(proc.quantity || 0) * Number(proc.rate_per_unit || 0)
      }];
    } else {
      proc.items = [];
    }

    // Purchase Order Link
    if (proc.purchase_order_id) {
      const poRes = await req.tenantDb.query(
        `SELECT id, po_number, order_date, status, total_amount FROM purchase_orders WHERE id = ?`,
        [proc.purchase_order_id]
      );
      if (poRes.rows[0]) {
        proc.purchase_order = poRes.rows[0];
      }
    }

    // Payments Log History with user name
    const paymentsRes = await req.tenantDb.query(
      `SELECT pl.*, u.name AS recorded_by_name
       FROM payments_log pl
       LEFT JOIN users u ON u.id = pl.created_by
       WHERE pl.related_id = ? AND pl.deleted_at IS NULL
       ORDER BY pl.date DESC, pl.created_at DESC`,
      [req.params.id]
    );
    proc.payments_history = paymentsRes.rows;

    // Timeline construction
    const timeline = [];
    if (proc.created_at) {
      timeline.push({
        title: 'Procurement Created',
        date: proc.created_at,
        kind: 'created',
        notes: `Procurement recorded for ${proc.vendor_name || 'Vendor'}`
      });
    }
    if (proc.sent_at) {
      timeline.push({
        title: 'Sent to Vendor',
        date: proc.sent_at,
        kind: 'sent',
        notes: 'Transmitted to vendor for fulfillment'
      });
    }
    if (proc.dispatch_date || proc.dispatch_tracking_ref) {
      timeline.push({
        title: 'Dispatched by Vendor',
        date: proc.dispatch_date || proc.created_at,
        kind: 'dispatch',
        notes: proc.dispatch_tracking_ref ? `Tracking Ref: ${proc.dispatch_tracking_ref}` : 'Order dispatched by vendor'
      });
    }
    if (proc.received_date || proc.status === 'Received' || proc.status === 'Delivered') {
      timeline.push({
        title: 'Goods Received',
        date: proc.received_date || proc.updated_at || proc.created_at,
        kind: 'received',
        notes: `Items safely delivered and inspected at ${proc.location_name}`
      });
    }
    for (const pmt of proc.payments_history) {
      timeline.push({
        title: 'Payment Recorded',
        date: pmt.date || pmt.created_at,
        kind: 'payment',
        amount: pmt.amount,
        notes: `${pmt.notes || 'Vendor Payment'}${pmt.recorded_by_name ? ` (Recorded by ${pmt.recorded_by_name})` : ''}`
      });
    }
    timeline.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    proc.timeline = timeline;

    return res.json(proc);
  } catch (err) {
    console.error('get procurement detail error', err);
    return res.status(500).json({ error: 'Failed to fetch procurement detail' });
  }
});

// Create Multi-Line Procurement (Draft or Sent to Vendor)
router.post('/procurements', requireAuth, requirePermission('procurement', 'create'), async (req, res) => {
  const { vendor_id, purchase_order_id, discount_amount = 0, discount_percent = 0, amount_paid = 0, date, notes, send_to_vendor = false } = req.body;
  const rawItems = req.body.items || req.body.lines || [];
  const items = Array.isArray(rawItems) ? rawItems.filter(i => (i && (i.item_id || i.raw_material_id))) : [];

  if (!vendor_id) {
    return res.status(400).json({ error: 'vendor_id is required for every procurement' });
  }
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Procurement must contain at least one item' });
  }

  try {
    const procNumber = await getNextDocumentNumber(req.tenantDb, 'procurement');
    let subtotal = 0;
    let totalTax = 0;

    const processedLines = [];
    for (const item of items) {
      const itemId = item.item_id || item.raw_material_id;
      const qty = Math.max(0, Number(item.quantity) || 0);
      const rate = Math.max(0, Number(item.rate_per_unit || item.rate) || 0);
      const taxRate = Math.max(0, Number(item.tax_rate) || 0);

      const lineTaxable = qty * rate;
      const lineTax = lineTaxable * (taxRate / 100);
      const lineTotal = lineTaxable + lineTax;

      subtotal += lineTaxable;
      totalTax += lineTax;

      processedLines.push({
        item_id: itemId,
        quantity: qty,
        rate_per_unit: rate,
        tax_rate: taxRate,
        tax_amount: lineTax,
        line_total: lineTotal
      });
    }

    const grossTotal = subtotal + totalTax - Math.max(0, Number(discount_amount) || 0);
    const finalDiscountPercent = Number(discount_percent) || (subtotal > 0 && Number(discount_amount) > 0 ? Number(((Number(discount_amount) / subtotal) * 100).toFixed(2)) : 0);
    const paid = Math.max(0, Number(amount_paid) || 0);
    const initialStatus = 'Sent to Vendor';

    await req.tenantDb.query('START TRANSACTION');
    const procId = crypto.randomUUID();

    let rawMaterialFk = null;
    if (processedLines[0]?.item_id) {
      const itemId = processedLines[0].item_id;
      const rmCheck = await req.tenantDb.query('SELECT id FROM raw_materials WHERE id = ?', [itemId]);
      if (rmCheck.rows && rmCheck.rows.length > 0) {
        rawMaterialFk = itemId;
      } else {
        const itemCheck = await req.tenantDb.query('SELECT id FROM items WHERE id = ?', [itemId]);
        if (itemCheck.rows && itemCheck.rows.length > 0) {
          await req.tenantDb.query(
            `INSERT INTO raw_materials (id, name, unit, reorder_level)
             SELECT id, name, COALESCE(NULLIF(unit, ''), 'Units'), COALESCE(reorder_level, 0) FROM items WHERE id = ?
             ON DUPLICATE KEY UPDATE name = VALUES(name)`,
            [itemId]
          ).catch(() => {});
          rawMaterialFk = itemId;
        }
      }
    }

    const targetLocationId = req.body.location_id || null;
    const due = Math.max(0, grossTotal - paid);

    await req.tenantDb.query(
      `INSERT INTO procurements (
        id, procurement_number, purchase_order_id, vendor_id, location_id, raw_material_id, quantity, rate_per_unit,
        subtotal, tax_amount, discount_amount, discount_percent, total_amount, amount_paid, amount_due, date, notes, status, sent_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        procId, procNumber, purchase_order_id || null, vendor_id, targetLocationId, rawMaterialFk, processedLines[0].quantity, processedLines[0].rate_per_unit,
        subtotal, totalTax, discount_amount, finalDiscountPercent, grossTotal, paid, due, date || new Date().toISOString().slice(0, 10), notes, initialStatus,
        new Date()
      ]
    );

    for (const line of processedLines) {
      const procItemId = crypto.randomUUID();
      await req.tenantDb.query(
        `INSERT INTO procurement_items (id, procurement_id, item_id, quantity, rate_per_unit, tax_rate, tax_amount, line_total)
         VALUES (?,?,?,?,?,?,?,?)`,
        [procItemId, procId, line.item_id, line.quantity, line.rate_per_unit, line.tax_rate, line.tax_amount, line.line_total]
      );

      // Record price history into vendor_items
      await req.tenantDb.query(
        `INSERT INTO vendor_items (id, vendor_id, item_id, last_purchase_price, last_purchase_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE 
           last_purchase_price = VALUES(last_purchase_price),
           last_purchase_date = VALUES(last_purchase_date),
           updated_at = NOW()`,
        [crypto.randomUUID(), vendor_id, line.item_id, line.rate_per_unit, date || new Date().toISOString().slice(0, 10)]
      ).catch(() => {});
    }

    // Record initial advance / payment in payments_log if paid > 0
    if (paid > 0) {
      const payId = crypto.randomUUID();
      const userId = req.user.user_id || req.user.id || null;
      await req.tenantDb.query(
        `INSERT INTO payments_log (id, related_type, related_id, amount, date, notes, created_by)
         VALUES (?, 'procurement', ?, ?, ?, ?, ?)`,
        [payId, procId, paid, date ? `${date} 10:00:00` : new Date(), 'Advance / Initial Payment at Procurement', userId]
      );
    }

    // Send notification if sent to vendor immediately
    if (send_to_vendor) {
      await createNotification(req.tenantDb, {
        user_type: 'vendor_portal',
        vendor_id,
        title: 'New Purchase Order Received',
        message: `Purchase Order ${procNumber} for ₹${grossTotal.toLocaleString('en-IN')} has been sent to your vendor portal.`,
        link: `/vendor-portal/orders/${procId}`
      });
    }

    await req.tenantDb.query('COMMIT');
    const fetchedProc = await req.tenantDb.query('SELECT * FROM procurements WHERE id = ?', [procId]);
    return res.status(201).json({ ...fetchedProc.rows[0], items: processedLines });
  } catch (err) {
    await req.tenantDb.query('ROLLBACK').catch(() => { });
    console.error('create procurement error', err);
    return res.status(500).json({ error: 'Failed to create procurement: ' + err.message });
  }
});

// ACTION: Send PO to Vendor (Draft -> Sent to Vendor)
router.post('/procurements/:id/send-to-vendor', requireAuth, requirePermission('procurement', 'approve'), async (req, res) => {
  try {
    const procRes = await req.tenantDb.query('SELECT * FROM procurements WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (procRes.rowCount === 0) return res.status(404).json({ error: 'Procurement not found' });
    const proc = procRes.rows[0];

    await req.tenantDb.query(
      "UPDATE procurements SET status = 'Sent to Vendor', sent_at = NOW(), updated_at = NOW() WHERE id = ?",
      [req.params.id]
    );

    await createNotification(req.tenantDb, {
      user_type: 'vendor_portal',
      vendor_id: proc.vendor_id,
      title: 'New Purchase Order Received',
      message: `Purchase Order ${proc.procurement_number} has been sent to your portal for review.`,
      link: `/vendor-portal/orders/${proc.id}`
    });

    return res.json({ ok: true, message: 'Purchase order sent to vendor successfully' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to send PO to vendor' });
  }
});

// ACTION: Vendor Confirms Physical Receipt of Returned Goods
router.post('/procurements/:id/vendor-confirm-return', requireAuth, async (req, res) => {
  try {
    const procRes = await req.tenantDb.query('SELECT * FROM procurements WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!procRes.rows || procRes.rows.length === 0) return res.status(404).json({ error: 'Procurement not found' });
    const proc = procRes.rows[0];

    // Enforce vendor scoping if user is vendor
    if (req.user.role === 'vendor' && req.user.vendor_id && proc.vendor_id !== req.user.vendor_id) {
      return res.status(403).json({ error: 'Unauthorized to confirm return for another vendor' });
    }

    await req.tenantDb.query('START TRANSACTION');

    // Update procurement status
    await req.tenantDb.query(
      "UPDATE procurements SET status = 'Return Received by Vendor', updated_at = NOW() WHERE id = ?",
      [req.params.id]
    );

    // Update return request status if exists
    await req.tenantDb.query(
      "UPDATE return_requests SET status = 'Received by Vendor', updated_at = NOW() WHERE reference_id = ?",
      [req.params.id]
    );

    await req.tenantDb.query('COMMIT');
    return res.json({ ok: true, message: 'Vendor confirmed physical receipt of returned goods' });
  } catch (err) {
    await req.tenantDb.query('ROLLBACK').catch(() => {});
    console.error('vendor confirm return error', err);
    return res.status(500).json({ error: 'Failed to confirm return receipt' });
  }
});
// STRICT RULE: Inventory IN entry is written ONLY at this step!
router.post('/procurements/:id/receive', requireAuth, requirePermission('procurement', 'approve'), async (req, res) => {
  try {
    const procRes = await req.tenantDb.query('SELECT * FROM procurements WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (procRes.rowCount === 0) return res.status(404).json({ error: 'Procurement not found' });
    const proc = procRes.rows[0];

    if (proc.status === 'Received') {
      return res.status(400).json({ error: 'Goods have already been received for this procurement' });
    }

    const itemsRes = await req.tenantDb.query('SELECT * FROM procurement_items WHERE procurement_id = ?', [req.params.id]);
    let items = itemsRes.rows;

    if (items.length === 0 && proc.raw_material_id) {
      items = [{
        item_id: proc.raw_material_id,
        quantity: Number(proc.quantity || 1),
        rate_per_unit: Number(proc.rate_per_unit || 0)
      }];
    }

    const userId = req.user.user_id || req.user.id || null;
    await req.tenantDb.query('START TRANSACTION');

    // Update status to Received
    await req.tenantDb.query(
      "UPDATE procurements SET status = 'Received', received_date = NOW(), updated_at = NOW() WHERE id = ?",
      [req.params.id]
    );

    if (proc.purchase_order_id) {
      await req.tenantDb.query(
        "UPDATE purchase_orders SET status = 'Received', updated_at = NOW() WHERE id = ?",
        [proc.purchase_order_id]
      ).catch(() => {});
    }

    // WRITE INVENTORY LEDGER IN ENTRIES STRICTLY HERE!
    for (const item of items) {
      const ledgerId = crypto.randomUUID();
      await req.tenantDb.query(
        `INSERT INTO inventory_ledger (
          id, item_type, item_id, transaction_type, quantity, unit_cost, location_id, reason, reference_table, reference_id, created_by
        ) VALUES (?, 'raw_material', ?, 'in', ?, ?, ?, ?, 'procurements', ?, ?)`,
        [ledgerId, item.item_id, item.quantity, item.rate_per_unit, proc.location_id, `Procurement Received ${proc.procurement_number}`, proc.id, userId]
      );

      // Recalculate weighted average cost
      const newWeightedAvg = await getWeightedAvgCost(req.tenantDb, item.item_id);
      await req.tenantDb.query('UPDATE items SET last_purchase_price = ?, updated_at = NOW() WHERE id = ?', [newWeightedAvg, item.item_id]).catch(() => {});
      await req.tenantDb.query('UPDATE raw_materials SET last_purchase_price = ?, updated_at = NOW() WHERE id = ?', [newWeightedAvg, item.item_id]).catch(() => {});

      // Upsert vendor_items on receipt
      await req.tenantDb.query(
        `INSERT INTO vendor_items (id, vendor_id, item_id, last_purchase_price, last_purchase_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE 
           last_purchase_price = VALUES(last_purchase_price),
           last_purchase_date = VALUES(last_purchase_date),
           updated_at = NOW()`,
        [crypto.randomUUID(), proc.vendor_id, item.item_id, item.rate_per_unit || newWeightedAvg, proc.date || new Date().toISOString().slice(0, 10)]
      ).catch(() => {});
    }

    await createNotification(req.tenantDb, {
      user_type: 'user',
      title: 'Goods Received',
      message: `Physical goods for PO ${proc.procurement_number} have been received and stock added to inventory.`,
      link: `/procurement`
    });

    await req.tenantDb.query('COMMIT');
    return res.json({ ok: true, message: 'Physical goods received and inventory ledger IN entries updated' });
  } catch (err) {
    await req.tenantDb.query('ROLLBACK').catch(() => {});
    console.error('receive procurement error', err);
    return res.status(500).json({ error: 'Failed to mark goods as received: ' + err.message });
  }
});

// Receive goods directly from Purchase Order (PO tab)
router.post('/purchase-orders/:id/receive', requireAuth, requirePermission('procurement', 'approve'), async (req, res) => {
  try {
    const poRes = await req.tenantDb.query('SELECT * FROM purchase_orders WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (poRes.rowCount === 0) return res.status(404).json({ error: 'Purchase Order not found' });
    const po = poRes.rows[0];

    if (po.status === 'Received') {
      return res.status(400).json({ error: 'Goods have already been received for this PO' });
    }

    // Check if there is an existing procurement linked to this PO
    const linkedProc = await req.tenantDb.query('SELECT id, status FROM procurements WHERE purchase_order_id = ? AND deleted_at IS NULL', [po.id]);
    if (linkedProc.rowCount > 0) {
      req.params.id = linkedProc.rows[0].id;
      // Re-route to standard receive logic
      const subRes = await req.tenantDb.query('SELECT * FROM procurements WHERE id = ?', [linkedProc.rows[0].id]);
      if (subRes.rows[0].status === 'Received') {
        return res.status(400).json({ error: 'Goods have already been received for this PO' });
      }
    }

    const itemsRes = await req.tenantDb.query('SELECT * FROM purchase_order_items WHERE po_id = ?', [po.id]);
    const items = itemsRes.rows;
    const userId = req.user.user_id || req.user.id || null;

    await req.tenantDb.query('START TRANSACTION');

    // Mark PO as Received
    await req.tenantDb.query("UPDATE purchase_orders SET status = 'Received', updated_at = NOW() WHERE id = ?", [po.id]);

    // Create or update linked procurement record
    let procId = linkedProc.rowCount > 0 ? linkedProc.rows[0].id : crypto.randomUUID();
    let procNumber = po.po_number.replace('PO-', 'PROC-');

    if (linkedProc.rowCount > 0) {
      await req.tenantDb.query("UPDATE procurements SET status = 'Received', received_date = NOW(), updated_at = NOW() WHERE id = ?", [procId]);
    } else {
      await req.tenantDb.query(
        `INSERT INTO procurements (
          id, procurement_number, purchase_order_id, vendor_id, subtotal, total_amount, amount_paid, amount_due, date, status, received_date, notes
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'Received', NOW(), ?)`,
        [procId, procNumber, po.id, po.vendor_id, po.subtotal || 0, po.total_amount || 0, po.total_amount || 0, po.date || new Date().toISOString().slice(0, 10), po.notes || 'Converted from PO on receipt']
      );

      for (const item of items) {
        await req.tenantDb.query(
          `INSERT INTO procurement_items (id, procurement_id, item_id, quantity, rate_per_unit, tax_rate, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
           [crypto.randomUUID(), procId, item.item_id, item.quantity, item.rate_per_unit, item.tax_rate || 0, item.line_total || 0]
        );

        // Upsert vendor_items from PO receipt
        await req.tenantDb.query(
          `INSERT INTO vendor_items (id, vendor_id, item_id, last_purchase_price, last_purchase_date, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NOW(), NOW())
           ON DUPLICATE KEY UPDATE 
             last_purchase_price = VALUES(last_purchase_price),
             last_purchase_date = VALUES(last_purchase_date),
             updated_at = NOW()`,
          [crypto.randomUUID(), po.vendor_id, item.item_id, item.rate_per_unit, po.date || new Date().toISOString().slice(0, 10)]
        ).catch(() => {});
      }
    }

    // Write inventory ledger IN entries
    for (const item of items) {
      const ledgerId = crypto.randomUUID();
      await req.tenantDb.query(
        `INSERT INTO inventory_ledger (
          id, item_type, item_id, transaction_type, quantity, unit_cost, reason, reference_table, reference_id, created_by
        ) VALUES (?, 'raw_material', ?, 'in', ?, ?, ?, 'procurements', ?, ?)`,
        [ledgerId, item.item_id, item.quantity, item.rate_per_unit, `PO Received ${po.po_number}`, procId, userId]
      );

      const newWeightedAvg = await getWeightedAvgCost(req.tenantDb, item.item_id);
      await req.tenantDb.query('UPDATE items SET last_purchase_price = ?, updated_at = NOW() WHERE id = ?', [newWeightedAvg, item.item_id]).catch(() => {});
      await req.tenantDb.query('UPDATE raw_materials SET last_purchase_price = ?, updated_at = NOW() WHERE id = ?', [newWeightedAvg, item.item_id]).catch(() => {});
    }

    await req.tenantDb.query('COMMIT');
    return res.json({ ok: true, message: 'PO marked as Received and inventory ledger IN entries updated' });
  } catch (err) {
    await req.tenantDb.query('ROLLBACK').catch(() => {});
    console.error('receive PO error', err);
    return res.status(500).json({ error: 'Failed to receive purchase order: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// VENDOR PAYMENTS & INSTALLMENT HISTORY LOG
// ─────────────────────────────────────────────────────────────────────────────

router.get('/procurements/:id/payments', requireAuth, async (req, res) => {
  try {
    const procRes = await req.tenantDb.query(
      `SELECT p.*, v.name AS vendor_name, v.vendor_code
       FROM procurements p
       LEFT JOIN vendors v ON v.id = p.vendor_id
       WHERE p.id = ? AND p.deleted_at IS NULL`,
      [req.params.id]
    );

    if (procRes.rowCount === 0) {
      return res.status(404).json({ error: 'Procurement not found' });
    }

    const proc = procRes.rows[0];

    // Calculate actual total bill amount
    const subtotal = Number(proc.subtotal) || 0;
    const taxAmount = Number(proc.tax_amount) || 0;
    const discount = Number(proc.discount_amount) || 0;
    const fullBill = (subtotal + taxAmount - discount > 0) ? (subtotal + taxAmount - discount) : (Number(proc.total_amount) || 0);
    proc.total_amount = fullBill;

    // Fetch existing payment logs
    const paymentsRes = await req.tenantDb.query(
      `SELECT pl.*, u.name AS recorded_by_name
       FROM payments_log pl
       LEFT JOIN users u ON u.id = pl.created_by
       WHERE pl.related_id = ? AND pl.deleted_at IS NULL
       ORDER BY pl.date ASC, pl.created_at ASC`,
      [req.params.id]
    );

    let payments = paymentsRes.rows;
    const procPaid = Number(proc.amount_paid) || 0;

    // Self-healing / backfill: If procurement has amount_paid > 0 but payments_log has 0 entries
    if (procPaid > 0 && payments.length === 0) {
      const payId = crypto.randomUUID();
      const userId = req.user.user_id || req.user.id || null;
      const initialDate = proc.date ? `${proc.date} 10:00:00` : new Date();
      await req.tenantDb.query(
        `INSERT INTO payments_log (id, related_type, related_id, amount, date, notes, created_by)
         VALUES (?, 'procurement', ?, ?, ?, ?, ?)`,
        [payId, proc.id, procPaid, initialDate, 'Advance / Initial Payment at Procurement', userId]
      ).catch(() => {});

      payments = [{
        id: payId,
        related_type: 'procurement',
        related_id: proc.id,
        amount: procPaid,
        date: initialDate,
        notes: 'Advance / Initial Payment at Procurement'
      }];
    }

    // Ensure amount_due is exact
    proc.amount_due = Math.max(0, Number(proc.total_amount) - Number(proc.amount_paid));

    return res.json({
      procurement: proc,
      payments
    });
  } catch (err) {
    console.error('get procurement payments error', err);
    return res.status(500).json({ error: 'Failed to fetch payment history' });
  }
});

router.post('/procurements/:id/payments', requireAuth, requirePermission('procurement', 'create'), async (req, res) => {
  const { amount, date, notes } = req.body;
  const payAmt = Math.max(0, Number(amount) || 0);
  if (payAmt <= 0) {
    return res.status(400).json({ error: 'Valid positive payment amount is required' });
  }

  const userId = req.user.user_id || req.user.id || null;

  try {
    await req.tenantDb.query('START TRANSACTION');

    const procRes = await req.tenantDb.query(
      'SELECT id, total_amount, subtotal, tax_amount, discount_amount, amount_paid, amount_due, status FROM procurements WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
      [req.params.id]
    );

    if (procRes.rowCount === 0) {
      await req.tenantDb.query('ROLLBACK');
      return res.status(404).json({ error: 'Procurement not found' });
    }

    const proc = procRes.rows[0];
    const subtotal = Number(proc.subtotal) || 0;
    const taxAmount = Number(proc.tax_amount) || 0;
    const discount = Number(proc.discount_amount) || 0;
    const fullBill = (subtotal + taxAmount - discount > 0) ? (subtotal + taxAmount - discount) : (Number(proc.total_amount) || 0);
    const prevPaid = Number(proc.amount_paid) || 0;
    const currentDue = Math.max(0, fullBill - prevPaid);

    if (payAmt > currentDue + 0.01) {
      await req.tenantDb.query('ROLLBACK');
      return res.status(400).json({ error: `Payment amount cannot exceed the remaining due balance of ₹${currentDue.toFixed(2)}` });
    }

    const newPaid = prevPaid + payAmt;
    const newDue = Math.max(0, fullBill - newPaid);

    // Update procurement financial fields
    await req.tenantDb.query(
      `UPDATE procurements
       SET total_amount = ?, amount_paid = ?, amount_due = ?, updated_at = NOW()
       WHERE id = ?`,
      [fullBill, newPaid, newDue, req.params.id]
    );

    // Insert into payments_log
    const payId = crypto.randomUUID();
    const payDate = date ? `${date} 12:00:00` : new Date();
    await req.tenantDb.query(
      `INSERT INTO payments_log (id, related_type, related_id, amount, date, notes, created_by)
       VALUES (?, 'procurement', ?, ?, ?, ?, ?)`,
      [payId, req.params.id, payAmt, payDate, notes || null, userId]
    );

    await req.tenantDb.query('COMMIT');
    return res.status(201).json({ success: true, id: payId, amount_paid: newPaid, amount_due: newDue });
  } catch (err) {
    await req.tenantDb.query('ROLLBACK').catch(() => {});
    console.error('record procurement payment error', err);
    return res.status(500).json({ error: 'Failed to record vendor payment: ' + err.message });
  }
});

// Purchase Orders & Debit Notes Endpoints
router.get('/purchase-orders', requireAuth, async (req, res) => {
  try {
    const isTable = req.query.table === '1';
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(parseInt(req.query.page_size || req.query.limit || (isTable ? '20' : '200'), 10), 10000);
    const offset = (page - 1) * pageSize;

    let hasDeletedAt = false;
    try {
      const colCheck = await req.tenantDb.query("SHOW COLUMNS FROM purchase_orders LIKE 'deleted_at'");
      hasDeletedAt = (colCheck.rows && colCheck.rows.length > 0);
    } catch (_) {}

    const conditions = [];
    const countParams = [];

    if (hasDeletedAt) {
      conditions.push('po.deleted_at IS NULL');
    }

    if (req.query.search) {
      conditions.push('(po.po_number LIKE ? OR v.name LIKE ? OR po.notes LIKE ?)');
      const s = `%${req.query.search}%`;
      countParams.push(s, s, s);
    }

    if (req.query.start_date) {
      conditions.push('po.date >= ?');
      countParams.push(req.query.start_date);
    }

    if (req.query.end_date) {
      conditions.push('po.date <= ?');
      countParams.push(req.query.end_date);
    }

    if (req.query.status && req.query.status !== 'all') {
      conditions.push('po.status = ?');
      countParams.push(req.query.status);
    }

    if (req.query.vendor_id) {
      conditions.push('po.vendor_id = ?');
      countParams.push(req.query.vendor_id);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await req.tenantDb.query(
      `SELECT COUNT(*) AS count FROM purchase_orders po LEFT JOIN vendors v ON v.id = po.vendor_id ${whereClause}`,
      countParams
    );
    const total = parseInt(countRes.rows[0]?.count || 0, 10);

    const sortFieldMap = {
      date: 'po.date',
      po_number: 'po.po_number',
      vendor_name: 'v.name',
      expected_delivery_date: 'po.expected_delivery_date',
      total_amount: 'po.total_amount',
      status: 'po.status',
      created_at: 'po.created_at'
    };
    const sortBy = sortFieldMap[req.query.sort_by] || 'po.date';
    const sortOrder = String(req.query.sort_order || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    let query = `
      SELECT po.*, v.name AS vendor_name, v.vendor_code,
             (SELECT COUNT(*) FROM purchase_order_items poi WHERE poi.po_id = po.id) AS item_count
      FROM purchase_orders po
      LEFT JOIN vendors v ON v.id = po.vendor_id
      ${whereClause}
      ORDER BY ${sortBy} ${sortOrder}, po.created_at DESC
    `;

    const queryParams = [...countParams];
    if (isTable || req.query.page || req.query.limit) {
      query += ` LIMIT ? OFFSET ?`;
      queryParams.push(pageSize, offset);
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
    console.error('get purchase orders error', err);
    return res.status(500).json({ error: 'Failed to fetch purchase orders' });
  }
});

router.post('/purchase-orders', requireAuth, requirePermission('procurement', 'create'), async (req, res) => {
  const { vendor_id, expected_delivery_date, notes, items = [] } = req.body;
  if (!vendor_id) return res.status(400).json({ error: 'vendor_id required' });
  if (!items || items.length === 0) return res.status(400).json({ error: 'items required' });

  try {
    const poNumber = await getNextDocumentNumber(req.tenantDb, 'purchase_order');
    const poId = crypto.randomUUID();
    const date = new Date().toISOString().slice(0, 10);

    let subtotal = 0;
    let totalTax = 0;
    const processedLines = [];

    for (const item of items) {
      const qty = Math.max(0, Number(item.quantity) || 0);
      const rate = Math.max(0, Number(item.rate_per_unit) || 0);
      const taxRate = Math.max(0, Number(item.tax_rate) || 0);
      const lineTaxable = qty * rate;
      const lineTax = lineTaxable * (taxRate / 100);
      const lineTotal = lineTaxable + lineTax;

      subtotal += lineTaxable;
      totalTax += lineTax;
      processedLines.push({ item_id: item.item_id, quantity: qty, rate_per_unit: rate, tax_rate: taxRate, line_total: lineTotal });
    }

    const totalAmount = subtotal + totalTax;

    await req.tenantDb.query('START TRANSACTION');
    await req.tenantDb.query(
      `INSERT INTO purchase_orders (id, po_number, vendor_id, date, expected_delivery_date, status, subtotal, total_tax, total_amount, notes)
       VALUES (?, ?, ?, ?, ?, 'Sent to Vendor', ?, ?, ?, ?)`,
      [poId, poNumber, vendor_id, date, expected_delivery_date || null, subtotal, totalTax, totalAmount, notes || null]
    );

    for (const line of processedLines) {
      await req.tenantDb.query(
        `INSERT INTO purchase_order_items (id, po_id, item_id, quantity, rate_per_unit, tax_rate, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), poId, line.item_id, line.quantity, line.rate_per_unit, line.tax_rate, line.line_total]
      );
    }

    await req.tenantDb.query('COMMIT');
    return res.status(201).json({ id: poId, po_number: poNumber, total_amount: totalAmount, status: 'Sent to Vendor' });
  } catch (err) {
    await req.tenantDb.query('ROLLBACK').catch(() => {});
    console.error('create purchase order error', err);
    return res.status(500).json({ error: 'Failed to create purchase order: ' + err.message });
  }
});

router.delete('/purchase-orders/:id', requireAuth, requirePermission('procurement', 'delete'), async (req, res) => {
  try {
    let hasDeletedAt = false;
    try {
      const colCheck = await req.tenantDb.query("SHOW COLUMNS FROM purchase_orders LIKE 'deleted_at'");
      hasDeletedAt = (colCheck.rows && colCheck.rows.length > 0);
    } catch (_) {}

    if (hasDeletedAt) {
      await req.tenantDb.query('UPDATE purchase_orders SET deleted_at = NOW() WHERE id = ?', [req.params.id]);
    } else {
      await req.tenantDb.query('DELETE FROM purchase_orders WHERE id = ?', [req.params.id]);
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('delete purchase order error', err);
    return res.status(500).json({ error: 'Failed to delete purchase order' });
  }
});

router.get('/debit-notes', requireAuth, async (req, res) => {
  try {
    const isTable = req.query.table === '1';
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(parseInt(req.query.page_size || req.query.limit || (isTable ? '20' : '200'), 10), 10000);
    const offset = (page - 1) * pageSize;

    const conditions = [];
    const countParams = [];

    if (req.query.search) {
      conditions.push('(dn.debit_note_number LIKE ? OR v.name LIKE ? OR dn.reason LIKE ? OR p.procurement_number LIKE ?)');
      const s = `%${req.query.search}%`;
      countParams.push(s, s, s, s);
    }

    if (req.query.start_date) {
      conditions.push('dn.date >= ?');
      countParams.push(req.query.start_date);
    }

    if (req.query.end_date) {
      conditions.push('dn.date <= ?');
      countParams.push(req.query.end_date);
    }

    if (req.query.vendor_id) {
      conditions.push('dn.vendor_id = ?');
      countParams.push(req.query.vendor_id);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await req.tenantDb.query(
      `SELECT COUNT(*) AS count FROM debit_notes dn LEFT JOIN vendors v ON v.id = dn.vendor_id LEFT JOIN procurements p ON p.id = dn.procurement_id ${whereClause}`,
      countParams
    );
    const total = parseInt(countRes.rows[0]?.count || 0, 10);

    const sortFieldMap = {
      date: 'dn.date',
      created_at: 'dn.created_at',
      debit_note_number: 'dn.debit_note_number',
      vendor_name: 'v.name',
      reason: 'dn.reason',
      total_amount: 'dn.total_amount'
    };
    const sortBy = sortFieldMap[req.query.sort_by] || 'dn.date';
    const sortOrder = String(req.query.sort_order || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    let query = `
      SELECT dn.*, v.name AS vendor_name, p.procurement_number
      FROM debit_notes dn
      LEFT JOIN vendors v ON v.id = dn.vendor_id
      LEFT JOIN procurements p ON p.id = dn.procurement_id
      ${whereClause}
      ORDER BY ${sortBy} ${sortOrder}, dn.created_at DESC
    `;

    const queryParams = [...countParams];
    if (isTable || req.query.page || req.query.limit) {
      query += ` LIMIT ? OFFSET ?`;
      queryParams.push(pageSize, offset);
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
    console.error('get debit notes error', err);
    return res.status(500).json({ error: 'Failed to fetch debit notes' });
  }
});

router.post('/debit-notes', requireAuth, requirePermission('procurement', 'create'), async (req, res) => {
  const { vendor_id, procurement_id, total_amount, reason, notes } = req.body;
  const rawItems = req.body.items || req.body.lines || [];
  const items = Array.isArray(rawItems) ? rawItems.filter(i => (i && (i.item_id || i.raw_material_id))) : [];

  if (!vendor_id) return res.status(400).json({ error: 'vendor_id is required' });

  const calculatedTotal = items.reduce((sum, item) => {
    const qty = Math.max(0, Number(item.quantity) || 0);
    const rate = Math.max(0, Number(item.rate_per_unit) || 0);
    const taxRate = Math.max(0, Number(item.tax_rate) || 0);
    return sum + (qty * rate * (1 + taxRate / 100));
  }, 0);

  const amt = Number(total_amount) || calculatedTotal;
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Valid total_amount is required' });

  try {
    const dnNumber = await getNextDocumentNumber(req.tenantDb, 'debit_note');
    const dnId = crypto.randomUUID();
    const date = new Date().toISOString().slice(0, 10);

    await req.tenantDb.query('START TRANSACTION');
    await req.tenantDb.query(
      `INSERT INTO debit_notes (id, debit_note_number, procurement_id, vendor_id, date, reason, total_amount, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [dnId, dnNumber, procurement_id || null, vendor_id, date, reason || 'Purchase Return', amt, notes || null]
    );

    for (const item of items) {
      const qty = Math.max(0, Number(item.quantity) || 0);
      const rate = Math.max(0, Number(item.rate_per_unit) || 0);
      const taxRate = Math.max(0, Number(item.tax_rate) || 0);
      const lineTaxable = qty * rate;
      const lineTotal = lineTaxable * (1 + taxRate / 100);

      await req.tenantDb.query(
        `INSERT INTO debit_note_items (id, debit_note_id, item_id, quantity, rate_per_unit, tax_rate, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), dnId, item.item_id || item.raw_material_id, qty, rate, taxRate, lineTotal]
      );
    }

    await req.tenantDb.query('COMMIT');
    return res.status(201).json({ id: dnId, debit_note_number: dnNumber, total_amount: amt });
  } catch (err) {
    await req.tenantDb.query('ROLLBACK').catch(() => {});
    console.error('create debit note error', err);
    return res.status(500).json({ error: 'Failed to create debit note: ' + err.message });
  }
});

router.delete('/debit-notes/:id', requireAuth, requirePermission('procurement', 'delete'), async (req, res) => {
  try {
    await req.tenantDb.query('DELETE FROM debit_notes WHERE id = ?', [req.params.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('delete debit note error', err);
    return res.status(500).json({ error: 'Failed to delete debit note' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// VENDOR-SCOPED RETURN REQUESTS (for vendor role users in main app)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/vendor-return-requests', requireAuth, async (req, res) => {
  const vendorId = req.user.vendor_id;
  if (!vendorId) {
    return res.status(403).json({ error: 'This endpoint is only available for vendor users' });
  }

  try {
    const { status, request_type, search, start_date, end_date } = req.query;
    let where = 'rr.vendor_id = ?';
    const params = [vendorId];

    if (status && status !== 'all') {
      params.push(status);
      where += ' AND rr.status = ?';
    }
    if (request_type && request_type !== 'all') {
      params.push(request_type);
      where += ' AND rr.request_type = ?';
    }
    if (start_date) {
      params.push(start_date);
      where += ' AND DATE(rr.created_at) >= ?';
    }
    if (end_date) {
      params.push(end_date);
      where += ' AND DATE(rr.created_at) <= ?';
    }
    if (search) {
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
      where += ` AND (rr.request_number LIKE ? OR p.procurement_number LIKE ? OR rr.reason LIKE ? OR (SELECT GROUP_CONCAT(COALESCE(i.name, rm.name)) FROM procurement_items pi LEFT JOIN items i ON i.id = pi.item_id LEFT JOIN raw_materials rm ON rm.id = pi.item_id WHERE pi.procurement_id = p.id) LIKE ?)`;
    }

    const countRes = await req.tenantDb.query(
      `SELECT COUNT(*) AS count
       FROM return_requests rr
       LEFT JOIN procurements p ON p.id = rr.reference_id
       WHERE ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0]?.count || 0, 10);

    const isTable = req.query.table === '1';
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(parseInt(req.query.page_size || req.query.limit || (isTable ? '25' : '200'), 10), 10000);
    const offset = (page - 1) * pageSize;

    let query = `
      SELECT rr.id, rr.request_number, rr.request_type, rr.reference_id, rr.reference_type,
             rr.requested_by_type, rr.requested_by_id, rr.reason, rr.status, rr.review_notes,
             rr.reviewed_at, rr.created_at, rr.updated_at, rr.items AS return_items,
             p.procurement_number, p.date AS procurement_date, p.total_amount,
             p.status AS procurement_status,
             (SELECT GROUP_CONCAT(DISTINCT COALESCE(i.name, rm.name, 'Item') SEPARATOR ', ')
              FROM procurement_items pi
              LEFT JOIN items i ON i.id = pi.item_id
              LEFT JOIN raw_materials rm ON rm.id = pi.item_id
              WHERE pi.procurement_id = p.id) AS item_names,
             (SELECT COALESCE(SUM(pi.quantity), 0) FROM procurement_items pi WHERE pi.procurement_id = p.id) AS total_quantity
      FROM return_requests rr
      LEFT JOIN procurements p ON p.id = rr.reference_id
      WHERE ${where}
      ORDER BY
        CASE rr.status WHEN 'Pending' THEN 0 WHEN 'Approved' THEN 1 ELSE 2 END ASC,
        rr.created_at DESC
    `;

    const queryParams = [...params];
    if (isTable || req.query.page || req.query.limit) {
      query += ` LIMIT ? OFFSET ?`;
      queryParams.push(pageSize, offset);
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
    console.error('vendor return requests error', err);
    return res.status(500).json({ error: 'Failed to fetch return requests' });
  }
});

// Vendor action: Accept return request (main app vendor user)
router.post('/vendor-return-requests/:id/accept', requireAuth, async (req, res) => {
  const vendorId = req.user.vendor_id;
  if (!vendorId) return res.status(403).json({ error: 'Vendor access only' });

  try {
    const rrRes = await req.tenantDb.query(
      'SELECT id, vendor_id, status FROM return_requests WHERE id = ?',
      [req.params.id]
    );
    if (rrRes.rowCount === 0) return res.status(404).json({ error: 'Return request not found' });
    if (rrRes.rows[0].vendor_id !== vendorId) return res.status(403).json({ error: 'Access denied' });

    await req.tenantDb.query(
      `UPDATE return_requests
       SET status = 'Approved', review_notes = ?, reviewed_by = ?, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [req.body.notes || 'Accepted by vendor', req.user.id, req.params.id]
    );

    return res.json({ ok: true, message: 'Return request accepted' });
  } catch (err) {
    console.error('vendor accept return error', err);
    return res.status(500).json({ error: 'Failed to accept return request' });
  }
});

// Vendor action: Reject return request (main app vendor user)
router.post('/vendor-return-requests/:id/reject', requireAuth, async (req, res) => {
  const vendorId = req.user.vendor_id;
  if (!vendorId) return res.status(403).json({ error: 'Vendor access only' });

  const { reason } = req.body;
  if (!reason || String(reason).trim().length < 3) {
    return res.status(400).json({ error: 'Rejection reason is required' });
  }

  try {
    const rrRes = await req.tenantDb.query(
      'SELECT id, vendor_id, status FROM return_requests WHERE id = ?',
      [req.params.id]
    );
    if (rrRes.rowCount === 0) return res.status(404).json({ error: 'Return request not found' });
    if (rrRes.rows[0].vendor_id !== vendorId) return res.status(403).json({ error: 'Access denied' });

    await req.tenantDb.query(
      `UPDATE return_requests
       SET status = 'Rejected', review_notes = ?, reviewed_by = ?, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [reason.trim(), req.user.id, req.params.id]
    );

    return res.json({ ok: true, message: 'Return request rejected' });
  } catch (err) {
    console.error('vendor reject return error', err);
    return res.status(500).json({ error: 'Failed to reject return request' });
  }
});

module.exports = router;
