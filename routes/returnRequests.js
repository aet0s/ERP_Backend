'use strict';

/**
 * returnRequests.js — Internal queue management for returns and cancellations.
 *
 * Staff create requests via portal. Internal managers review and approve/reject.
 * On approval:
 *   - purchase_cancellation → soft-delete the procurement + reverse ledger
 *   - purchase_return       → create a Debit Note document
 *   - sales_cancellation    → soft-delete the sale + reverse ledger
 *   - sales_return          → create a Credit Note document
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const { getNextDocumentNumber } = require('../lib/invoiceEngine');
const { createNotification } = require('../lib/notifications');
const { publishReturnRequestMessage } = require('../lib/returnRequestSocket');

// ─────────────────────────────────────────────────────────────────────────────
// CHAT HELPER — auto-insert system event messages
// ─────────────────────────────────────────────────────────────────────────────
async function insertSystemMessage(db, returnRequestId, message) {
  try {
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO return_request_messages
         (id, return_request_id, sender_type, sender_id, sender_name, message, is_system)
       VALUES (?, ?, 'system', 'system', 'System', ?, 1)`,
      [id, returnRequestId, message]
    );
    const fetched = await db.query('SELECT * FROM return_request_messages WHERE id = ?', [id]);
    publishReturnRequestMessage(db, returnRequestId, fetched.rows[0]);
  } catch (err) {
    // Non-fatal — table may not exist yet during migration window
    console.warn('insertSystemMessage failed (non-fatal):', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LIST (all requests, with filter by status/type/party/direction)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/return-requests', requireAuth, requirePermission('returns', 'view'), async (req, res) => {
  try {
    const params = [];
    const conditions = [];

    // Row-level security for customer role
    if (req.user.role === 'customer' || req.user.customer_id) {
      params.push(req.user.customer_id);
      conditions.push('rr.customer_id = ?');
    } else if (req.query.customer_id) {
      params.push(req.query.customer_id);
      conditions.push('rr.customer_id = ?');
    }

    if (req.user.role === 'vendor' || req.user.vendor_id) {
      params.push(req.user.vendor_id);
      conditions.push('rr.vendor_id = ?');
    } else if (req.query.vendor_id) {
      params.push(req.query.vendor_id);
      conditions.push('rr.vendor_id = ?');
    }

    // Direction filter: 'vendor' (Made to Vendors) vs 'customer' (Made by Customers)
    const direction = req.query.direction || req.query.party_type;
    if (direction === 'vendor') {
      conditions.push("(rr.request_type IN ('purchase_return', 'purchase_cancellation') OR rr.vendor_id IS NOT NULL)");
    } else if (direction === 'customer') {
      conditions.push("(rr.request_type IN ('sales_return', 'sales_cancellation') OR rr.customer_id IS NOT NULL)");
    }

    if (req.query.status && req.query.status !== 'all') {
      params.push(req.query.status);
      conditions.push('rr.status = ?');
    }
    if (req.query.request_type && req.query.request_type !== 'all') {
      params.push(req.query.request_type);
      conditions.push('rr.request_type = ?');
    }
    if (req.query.reason_category && req.query.reason_category !== 'all') {
      params.push(`%${req.query.reason_category}%`);
      conditions.push('rr.reason LIKE ?');
    }
    if (req.query.start_date) {
      params.push(req.query.start_date);
      conditions.push('DATE(rr.created_at) >= ?');
    }
    if (req.query.end_date) {
      params.push(req.query.end_date);
      conditions.push('DATE(rr.created_at) <= ?');
    }
    if (req.query.search) {
      const searchPattern = `%${req.query.search}%`;
      params.push(
        searchPattern, searchPattern, searchPattern, searchPattern,
        searchPattern, searchPattern, searchPattern
      );
      conditions.push(`(
        rr.request_number LIKE ? OR 
        rr.reason LIKE ? OR 
        v.name LIKE ? OR 
        c.name LIKE ? OR 
        pr.procurement_number LIKE ? OR 
        sa.invoice_number LIKE ? OR
        CAST(rr.items AS CHAR) LIKE ?
      )`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await req.tenantDb.query(
      `SELECT COUNT(*) AS count
       FROM return_requests rr
       LEFT JOIN vendors v ON v.id = rr.vendor_id
       LEFT JOIN customers c ON c.id = rr.customer_id
       LEFT JOIN procurements pr ON pr.id = rr.reference_id AND rr.reference_type IN ('procurement', 'purchase_order')
       LEFT JOIN sales sa ON sa.id = rr.reference_id AND rr.reference_type IN ('sale', 'invoice')
       ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0]?.count || 0, 10);

    const isTable = req.query.table === '1';
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(parseInt(req.query.page_size || req.query.limit || (isTable ? '20' : '200'), 10), 10000);
    const offset = (page - 1) * pageSize;

    let query = `
      SELECT rr.id, rr.request_number, rr.request_type, rr.reference_id, rr.reference_type,
             rr.requested_by_type, rr.reason, rr.status, rr.review_notes, rr.outcome_document_type,
             rr.outcome_document_id, rr.created_at, rr.updated_at, rr.items AS return_items,
             v.name AS vendor_name, v.email AS vendor_email, v.phone AS vendor_phone,
             c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
             u.name AS reviewed_by_name,
             CASE 
               WHEN rr.request_type IN ('purchase_return', 'purchase_cancellation') OR rr.vendor_id IS NOT NULL THEN 'vendor'
               ELSE 'customer'
             END AS return_direction,
             CASE 
               WHEN rr.reference_type IN ('procurement', 'purchase_order') THEN pr.procurement_number
               WHEN rr.reference_type IN ('sale', 'invoice') THEN sa.invoice_number
               ELSE rr.reference_id
             END AS reference_number,
             COALESCE(pr.total_amount, sa.total_amount) AS reference_total_amount,
             COALESCE(pr.status, sa.status) AS reference_status,
             CASE
               WHEN rr.outcome_document_type = 'credit_note' THEN cn.credit_note_number
               WHEN rr.outcome_document_type = 'debit_note' THEN dn.debit_note_number
               ELSE NULL
             END AS outcome_document_number,
             COALESCE(cn.total_amount, dn.total_amount) AS outcome_amount
      FROM return_requests rr
      LEFT JOIN vendors v ON v.id = rr.vendor_id
      LEFT JOIN customers c ON c.id = rr.customer_id
      LEFT JOIN users u ON u.id = rr.reviewed_by
      LEFT JOIN procurements pr ON pr.id = rr.reference_id AND rr.reference_type IN ('procurement', 'purchase_order')
      LEFT JOIN sales sa ON sa.id = rr.reference_id AND rr.reference_type IN ('sale', 'invoice')
      LEFT JOIN credit_notes cn ON cn.id = rr.outcome_document_id AND rr.outcome_document_type = 'credit_note'
      LEFT JOIN debit_notes dn ON dn.id = rr.outcome_document_id AND rr.outcome_document_type = 'debit_note'
      ${where}
      ORDER BY
        CASE rr.status WHEN 'Pending' THEN 0 ELSE 1 END ASC,
        rr.created_at DESC
    `;

    const queryParams = [...params];
    if (isTable || req.query.page || req.query.limit) {
      query += ` LIMIT ? OFFSET ?`;
      queryParams.push(pageSize, offset);
    }

    const result = await req.tenantDb.query(query, queryParams);

    // Calculate metrics summary (Pending, Vendor Returns count, Customer Returns count)
    const summaryRes = await req.tenantDb.query(`
      SELECT 
        COUNT(*) AS total_count,
        SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN status = 'Approved' THEN 1 ELSE 0 END) AS approved_count,
        SUM(CASE WHEN status = 'Rejected' THEN 1 ELSE 0 END) AS rejected_count,
        SUM(CASE WHEN request_type IN ('purchase_return', 'purchase_cancellation') OR vendor_id IS NOT NULL THEN 1 ELSE 0 END) AS vendor_returns_count,
        SUM(CASE WHEN request_type IN ('sales_return', 'sales_cancellation') OR customer_id IS NOT NULL THEN 1 ELSE 0 END) AS customer_returns_count
      FROM return_requests
    `);
    const sumRow = summaryRes.rows[0] || {};

    const summaryData = {
      total_count: Number(sumRow.total_count || 0),
      pending_count: Number(sumRow.pending_count || 0),
      approved_count: Number(sumRow.approved_count || 0),
      rejected_count: Number(sumRow.rejected_count || 0),
      vendor_returns_count: Number(sumRow.vendor_returns_count || 0),
      customer_returns_count: Number(sumRow.customer_returns_count || 0)
    };

    if (isTable) {
      return res.json({
        items: result.rows,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize) || 1,
        meta: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) || 1 },
        summary: summaryData
      });
    }

    return res.json({
      items: result.rows,
      meta: { page: 1, page_size: result.rows.length || 25, total: result.rows.length, total_pages: 1 },
      summary: summaryData
    });
  } catch (err) {
    console.error('list return requests error', err);
    return res.status(500).json({ error: 'Failed to fetch return requests' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET ONE
// ─────────────────────────────────────────────────────────────────────────────

router.get('/return-requests/:id', requireAuth, async (req, res) => {
  try {
    const result = await req.tenantDb.query(
      `SELECT rr.*, 
              v.name AS vendor_name, v.email AS vendor_email, v.phone AS vendor_phone, v.address AS vendor_address, v.gstin AS vendor_gstin,
              c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone, c.billing_address AS customer_address, c.gstin AS customer_gstin,
              u.name AS reviewed_by_name,
              CASE 
                WHEN rr.request_type IN ('purchase_return', 'purchase_cancellation') OR rr.vendor_id IS NOT NULL THEN 'vendor'
                ELSE 'customer'
              END AS return_direction,
              CASE 
                WHEN rr.reference_type = 'procurement' THEN pr.procurement_number
                WHEN rr.reference_type = 'sale' THEN sa.invoice_number
                ELSE rr.reference_id
              END AS reference_number,
              COALESCE(pr.total_amount, sa.total_amount) AS reference_total_amount,
              COALESCE(pr.status, sa.status) AS reference_status,
              COALESCE(pr.date, sa.date, pr.created_at, sa.created_at) AS reference_date,
              CASE
                WHEN rr.outcome_document_type = 'credit_note' THEN cn.credit_note_number
                WHEN rr.outcome_document_type = 'debit_note' THEN dn.debit_note_number
                ELSE NULL
              END AS outcome_document_number,
              COALESCE(cn.total_amount, dn.total_amount) AS outcome_amount
       FROM return_requests rr
       LEFT JOIN vendors v ON v.id = rr.vendor_id
       LEFT JOIN customers c ON c.id = rr.customer_id
       LEFT JOIN users u ON u.id = rr.reviewed_by
       LEFT JOIN procurements pr ON pr.id = rr.reference_id AND rr.reference_type IN ('procurement', 'purchase_order')
       LEFT JOIN sales sa ON sa.id = rr.reference_id AND rr.reference_type IN ('sale', 'invoice')
       LEFT JOIN credit_notes cn ON cn.id = rr.outcome_document_id AND rr.outcome_document_type = 'credit_note'
       LEFT JOIN debit_notes dn ON dn.id = rr.outcome_document_id AND rr.outcome_document_type = 'debit_note'
       WHERE rr.id = ?`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Return request not found' });
    
    const row = result.rows[0];

    // If items is null or empty but reference_id exists (e.g. cancellation), load items from referenced document
    let parsedItems = [];
    try {
      if (row.items) {
        parsedItems = typeof row.items === 'string' ? JSON.parse(row.items) : row.items;
      }
    } catch (_) {}

    if ((!parsedItems || parsedItems.length === 0) && row.reference_id) {
      if (row.reference_type === 'procurement') {
        const procItems = await req.tenantDb.query(
          `SELECT pi.*, rm.name AS item_name, rm.unit
           FROM procurement_items pi
           LEFT JOIN raw_materials rm ON rm.id = pi.item_id
           WHERE pi.procurement_id = ?`,
          [row.reference_id]
        );
        parsedItems = procItems.rows.map(item => ({
          item_id: item.item_id,
          name: item.item_name || 'Item',
          quantity: item.quantity,
          unit: item.unit || 'units',
          rate_per_unit: item.unit_price || item.rate,
          total_price: item.total_price || (item.quantity * item.unit_price)
        }));
      } else if (row.reference_type === 'sale') {
        const saleItems = await req.tenantDb.query(
          `SELECT si.*, fg.name AS item_name, fg.unit AS base_unit,
                  COALESCE(ppl.package_unit, pc.package_unit) AS package_unit,
                  COALESCE(si.package_name, ppl.name) AS package_name,
                  COALESCE(si.units_per_package, ppl.base_quantity_equivalent, 1) AS units_per_package
           FROM sales_items si
           LEFT JOIN finished_goods fg ON fg.id = si.finished_good_id
           LEFT JOIN product_packaging_levels ppl ON ppl.id = COALESCE(si.packaging_level_id, si.packaging_config_id)
           WHERE si.sale_id = ?`,
          [row.reference_id]
        );
        parsedItems = saleItems.rows.map(item => ({
          finished_good_id: item.finished_good_id,
          name: item.item_name || 'Finished Good',
          quantity: item.quantity,
          unit: item.package_unit || item.package_name || item.base_unit || 'pcs',
          package_name: item.package_name,
          units_per_package: item.units_per_package,
          rate_per_unit: item.rate_per_unit,
          total_price: item.line_total || (item.quantity * item.rate_per_unit)
        }));
      }
    }

    row.items = parsedItems;
    return res.json(row);
  } catch (err) {
    console.error('fetch return request error', err);
    return res.status(500).json({ error: 'Failed to fetch return request' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CREATE (internal staff can also create requests directly, bypassing portal)
// ─────────────────────────────────────────────────────────────────────────────

router.post('/return-requests', requireAuth, requirePermission('returns', 'create'), async (req, res) => {
  const { reference_id, reference_type, request_type, reason, items } = req.body;
  const userId = req.user.user_id || req.user.id;

  if (!reference_id || !reference_type || !request_type || !reason) {
    return res.status(400).json({ error: 'reference_id, reference_type, request_type and reason are required' });
  }

  try {
    // Check for duplicate pending
    const dupRes = await req.tenantDb.query(
      "SELECT id FROM return_requests WHERE reference_id = ? AND status = 'Pending'",
      [reference_id]
    );
    if (dupRes.rowCount > 0) {
      return res.status(400).json({ error: 'A pending request already exists for this document' });
    }

    const requestNumber = await getNextDocumentNumber(req.tenantDb, 'return_request');
    const id = crypto.randomUUID();

    // Look up vendor_id / customer_id from the referenced document or authenticated user
    let vendor_id = req.user.vendor_id || null;
    let customer_id = req.user.customer_id || null;
    let requested_by_type = 'internal';

    if (req.user.role === 'customer' || req.user.customer_id) {
      requested_by_type = 'customer';
    } else if (req.user.role === 'vendor' || req.user.vendor_id) {
      requested_by_type = 'vendor';
    }

    try {
      if (reference_type === 'procurement' && !vendor_id) {
        const pr = await req.tenantDb.query('SELECT vendor_id FROM procurements WHERE id = ?', [reference_id]);
        vendor_id = pr.rows[0]?.vendor_id || null;
      } else if ((reference_type === 'sale' || reference_type === 'invoice') && !customer_id) {
        const sa = await req.tenantDb.query('SELECT customer_id FROM sales WHERE id = ?', [reference_id]);
        customer_id = sa.rows[0]?.customer_id || null;
      }
    } catch (_) {}

    await req.tenantDb.query(
      `INSERT INTO return_requests
         (id, request_number, request_type, reference_id, reference_type, requested_by_type,
          requested_by_id, vendor_id, customer_id, reason, items, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending')`,
      [id, requestNumber, request_type, reference_id, reference_type, requested_by_type, userId,
       vendor_id, customer_id, reason.trim(), items ? JSON.stringify(items) : null]
    );

    // A purchase return is awaiting the vendor's decision, not an internal
    // approval. Keep the procurement list in step with the request queue.
    if (['purchase_return', 'purchase_cancellation'].includes(request_type) && reference_type === 'procurement') {
      await req.tenantDb.query(
        "UPDATE procurements SET status = 'Return Requested', updated_at = NOW() WHERE id = ? AND deleted_at IS NULL",
        [reference_id]
      );
    }

    const fetched = await req.tenantDb.query('SELECT * FROM return_requests WHERE id = ?', [id]);

    // Auto-open chat with a system message
    await insertSystemMessage(
      req.tenantDb,
      id,
      `Return Request ${requestNumber} has been opened. Use this chat to discuss the return with the ${['purchase_return', 'purchase_cancellation'].includes(request_type) ? 'vendor' : 'customer'}.`
    );

    return res.status(201).json(fetched.rows[0]);
  } catch (err) {
    console.error('create return request error', err);
    return res.status(500).json({ error: 'Failed to create return request' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// APPROVE
// ─────────────────────────────────────────────────────────────────────────────

router.post('/return-requests/:id/approve', requireAuth, requirePermission('returns', 'approve'), async (req, res) => {
  const { review_notes } = req.body;
  const userId = req.user.user_id || req.user.id;
  const client = await req.tenantDb.connect();

  try {
    await client.query('START TRANSACTION');

    const rrRes = await client.query(
      "SELECT * FROM return_requests WHERE id = ? AND status = 'Pending' FOR UPDATE",
      [req.params.id]
    );
    if (rrRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pending return request not found' });
    }
    const rr = rrRes.rows[0];

    // Purchase returns raised by ERP staff are decisions for the vendor. They
    // must be acted on in the vendor portal, never approved internally.
    if (['purchase_return', 'purchase_cancellation'].includes(rr.request_type) && rr.requested_by_type === 'internal') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Vendor response is required for this purchase return request' });
    }

    let outcomeDocType = null;
    let outcomeDocId = null;

    // ── Dispatch based on request_type ──────────────────────────────────────
    if (rr.request_type === 'purchase_cancellation') {
      // Soft-delete the procurement and reverse its ledger entries
      const procRes = await client.query(
        'SELECT * FROM procurements WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
        [rr.reference_id]
      );
      if (procRes.rowCount > 0) {
        const proc = procRes.rows[0];
        // Reverse each procurement_item ledger entry
        const piRes = await client.query(
          'SELECT * FROM procurement_items WHERE procurement_id = ?',
          [proc.id]
        );
        for (const pi of piRes.rows) {
          const revId = crypto.randomUUID();
          await client.query(
            `INSERT INTO inventory_ledger (id, item_type, item_id, transaction_type, quantity, reference_table, reference_id, reason, created_by, date)
             VALUES (?, 'raw_material', ?, 'out', ?, 'return_requests', ?, 'Purchase cancellation approved', ?, ?)`,
            [revId, pi.item_id, pi.quantity, rr.id, userId, new Date().toISOString().slice(0, 10)]
          );
        }
        // Soft delete procurement and its payment logs
        await client.query(
          'UPDATE procurements SET deleted_at = NOW(), deleted_by = ? WHERE id = ?',
          [userId, proc.id]
        );
        await client.query(
          "UPDATE payments_log SET deleted_at = NOW(), deleted_by = ? WHERE related_type = 'procurement' AND related_id = ?",
          [userId, proc.id]
        );
      }

    } else if (rr.request_type === 'purchase_return') {
      // Create a Debit Note from the items snapshot
      try {
        const debitNoteNumber = await getNextDocumentNumber(client, 'debit_note');
        outcomeDocId = crypto.randomUUID();
        outcomeDocType = 'debit_note';

        const parsedItems = rr.items ? (typeof rr.items === 'string' ? JSON.parse(rr.items) : rr.items) : [];
        const totalAmount = parsedItems.reduce((s, i) => s + (Number(i.quantity || 0) * Number(i.rate_per_unit || 0)), 0);

        await client.query(
          `INSERT INTO debit_notes (id, debit_note_number, vendor_id, procurement_id, reason, total_amount, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 'Issued', ?)`,
          [outcomeDocId, debitNoteNumber, rr.vendor_id, rr.reference_id, rr.reason, totalAmount, userId]
        );

        // Reverse inventory for returned items
        for (const item of parsedItems) {
          if (!item.item_id || !item.quantity) continue;
          const revId = crypto.randomUUID();
          await client.query(
            `INSERT INTO inventory_ledger (id, item_type, item_id, transaction_type, quantity, reference_table, reference_id, reason, created_by, date)
             VALUES (?, 'raw_material', ?, 'out', ?, 'return_requests', ?, 'Purchase return approved', ?, ?)`,
            [revId, item.item_id, item.quantity, rr.id, userId, new Date().toISOString().slice(0, 10)]
          );
        }
      } catch (e) {
        // debit_notes table may not exist in all schema versions — log and continue
        console.warn('Could not create debit note:', e.message);
      }

    } else if (rr.request_type === 'sales_cancellation') {
      // Soft-delete the sale and reverse its ledger entries
      const saleRes = await client.query(
        'SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
        [rr.reference_id]
      );
      if (saleRes.rowCount > 0) {
        const sale = saleRes.rows[0];
        const revId = crypto.randomUUID();
        await client.query(
          `INSERT INTO inventory_ledger (id, item_type, item_id, transaction_type, quantity, reference_table, reference_id, reason, created_by, date)
           VALUES (?, 'finished_good', ?, 'in', ?, 'return_requests', ?, 'Sales cancellation approved', ?, ?)`,
          [revId, sale.finished_good_id, sale.quantity, rr.id, userId, new Date().toISOString().slice(0, 10)]
        );
        await client.query(
          'UPDATE sales SET deleted_at = NOW(), deleted_by = ? WHERE id = ?',
          [userId, sale.id]
        );
        await client.query(
          "UPDATE payments_log SET deleted_at = NOW(), deleted_by = ? WHERE related_type = 'sale' AND related_id = ?",
          [userId, sale.id]
        );
      }

    } else if (rr.request_type === 'sales_return') {
      // Create a Credit Note
      try {
        const creditNoteNumber = await getNextDocumentNumber(client, 'credit_note');
        outcomeDocId = crypto.randomUUID();
        outcomeDocType = 'credit_note';

        const parsedItems = rr.items ? (typeof rr.items === 'string' ? JSON.parse(rr.items) : rr.items) : [];
        const totalAmount = parsedItems.reduce((s, i) => s + (Number(i.quantity || 0) * Number(i.rate_per_unit || 0)), 0);

        await client.query(
          `INSERT INTO credit_notes (id, credit_note_number, customer_id, sale_id, reason, total_amount, notes, date, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [outcomeDocId, creditNoteNumber, rr.customer_id, rr.reference_id, rr.reason, totalAmount, review_notes || 'Issued from approved return request']
        );

        // Reverse inventory for returned goods in base units
        for (const item of parsedItems) {
          const targetItemId = item.finished_good_id || item.item_id;
          if (!targetItemId || !item.quantity) continue;
          const unitsPerPkg = Number(item.units_per_package) || 1;
          const baseReturnQty = Number(item.quantity) * unitsPerPkg;
          const revId = crypto.randomUUID();
          await client.query(
            `INSERT INTO inventory_ledger (id, item_type, item_id, transaction_type, quantity, reference_table, reference_id, reason, created_by, date)
             VALUES (?, 'finished_good', ?, 'in', ?, 'return_requests', ?, 'Sales return approved (base units)', ?, ?)`,
            [revId, targetItemId, baseReturnQty, rr.id, userId, new Date().toISOString().slice(0, 10)]
          );
        }
        if (rr.reference_id) {
          await client.query("UPDATE sales SET status = 'Returned', updated_at = NOW() WHERE id = ?", [rr.reference_id]).catch(() => {});
        }
      } catch (e) {
        console.warn('Could not create credit note:', e.message);
      }
    }

    // Update the return request record
    await client.query(
      `UPDATE return_requests
       SET status = 'Approved', reviewed_by = ?, reviewed_at = NOW(), review_notes = ?,
           outcome_document_type = ?, outcome_document_id = ?, updated_at = NOW()
       WHERE id = ?`,
      [userId, review_notes || null, outcomeDocType, outcomeDocId, req.params.id]
    );

    if (rr.customer_id) {
      await createNotification(client, {
        user_type: 'customer_portal',
        customer_id: rr.customer_id,
        title: 'Return Request Approved',
        message: `Your return request ${rr.request_number} has been approved. Credit Note issued.`,
        link: '/customer-portal/returns'
      }).catch(() => {});
    }

    await client.query('COMMIT');

    // Auto-close chat with a system message
    await insertSystemMessage(
      req.tenantDb,
      req.params.id,
      `✅ This return request has been Approved by ERP management. ${review_notes ? `Notes: ${review_notes}` : ''} The chat is now closed and contact information is available below.`
    );

    const fetched = await req.tenantDb.query('SELECT * FROM return_requests WHERE id = ?', [req.params.id]);
    return res.json({ ok: true, return_request: fetched.rows[0], outcome_document_type: outcomeDocType, outcome_document_id: outcomeDocId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('approve return request error', err);
    return res.status(500).json({ error: 'Failed to approve return request' });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REJECT
// ─────────────────────────────────────────────────────────────────────────────

router.post('/return-requests/:id/reject', requireAuth, requirePermission('returns', 'approve'), async (req, res) => {
  const { review_notes } = req.body;
  const userId = req.user.user_id || req.user.id;

  if (!review_notes || String(review_notes).trim().length < 1) {
    return res.status(400).json({ error: 'A rejection reason is required' });
  }

  const currentRes = await req.tenantDb.query(
    'SELECT request_type, requested_by_type FROM return_requests WHERE id = ? AND status = \'Pending\'',
    [req.params.id]
  );
  const current = currentRes.rows[0];
  if (current && ['purchase_return', 'purchase_cancellation'].includes(current.request_type) && current.requested_by_type === 'internal') {
    return res.status(403).json({ error: 'Vendor response is required for this purchase return request' });
  }

  const updateRes = await req.tenantDb.query(
    `UPDATE return_requests
     SET status = 'Rejected', reviewed_by = ?, reviewed_at = NOW(), review_notes = ?, updated_at = NOW()
     WHERE id = ? AND status = 'Pending'`,
    [userId, review_notes.trim(), req.params.id]
  );
  if (updateRes.rowCount === 0) return res.status(404).json({ error: 'Pending return request not found' });

  const fetched = await req.tenantDb.query('SELECT * FROM return_requests WHERE id = ?', [req.params.id]);
  const rr = fetched.rows[0];

  // Revert the linked sale's status back to 'Delivered' so the customer
  // no longer sees it stuck on 'Return Requested'
  if (rr && rr.reference_id && ['sales_return', 'sales_cancellation'].includes(rr.request_type)) {
    await req.tenantDb.query(
      "UPDATE sales SET status = 'Return Rejected', updated_at = NOW() WHERE id = ? AND status = 'Return Requested'",
      [rr.reference_id]
    ).catch(() => {});
  }

  // Notify the customer via portal notification
  if (rr && rr.customer_id) {
    await createNotification(req.tenantDb, {
      user_type: 'customer_portal',
      customer_id: rr.customer_id,
      title: 'Return Request Rejected',
      message: `Your return request ${rr.request_number} has been rejected. Reason: ${review_notes.trim()}`,
      link: '/customer-portal/returns'
    }).catch(() => {});
  }

  // Auto-close chat with a system message
  await insertSystemMessage(
    req.tenantDb,
    req.params.id,
    `❌ This return request has been Rejected. Reason: ${review_notes.trim()} The chat is now closed.`
  );

  return res.json({ ok: true, return_request: rr });
});

// ─────────────────────────────────────────────────────────────────────────────
// CHAT MESSAGES — Read & Write (ERP internal users)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/return-requests/:id/messages — List message history for initial load
router.get('/return-requests/:id/messages', requireAuth, async (req, res) => {
  try {
    const rrRes = await req.tenantDb.query(
      'SELECT id FROM return_requests WHERE id = ?',
      [req.params.id]
    );
    if (rrRes.rowCount === 0) return res.status(404).json({ error: 'Return request not found' });

    const result = await req.tenantDb.query(
      `SELECT id, sender_type, sender_id, sender_name, message, is_system, created_at
       FROM return_request_messages
       WHERE return_request_id = ?
       ORDER BY created_at ASC`,
      [req.params.id]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('list return messages error', err);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// POST /api/return-requests/:id/messages — ERP user sends a message
router.post('/return-requests/:id/messages', requireAuth, async (req, res) => {
  const { message } = req.body;
  if (!message || String(message).trim().length === 0) {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    // Fetch request to verify it exists and is still open
    const rrRes = await req.tenantDb.query(
      'SELECT id, status, request_number FROM return_requests WHERE id = ?',
      [req.params.id]
    );
    if (rrRes.rowCount === 0) return res.status(404).json({ error: 'Return request not found' });

    const rr = rrRes.rows[0];
    if (rr.status !== 'Pending') {
      return res.status(409).json({ error: 'Chat is closed. This request has already been resolved.' });
    }

    const userId = req.user.user_id || req.user.id;
    // Fetch the sender name
    const userRes = await req.tenantDb.query(
      'SELECT name FROM users WHERE id = ?',
      [userId]
    ).catch(() => ({ rows: [] }));
    const senderName = userRes.rows[0]?.name || req.user.name || req.user.email || 'ERP Staff';

    const msgId = crypto.randomUUID();
    await req.tenantDb.query(
      `INSERT INTO return_request_messages
         (id, return_request_id, sender_type, sender_id, sender_name, message, is_system)
       VALUES (?, ?, 'erp_user', ?, ?, ?, 0)`,
      [msgId, req.params.id, userId, senderName, message.trim()]
    );

    const fetched = await req.tenantDb.query(
      'SELECT * FROM return_request_messages WHERE id = ?',
      [msgId]
    );
    publishReturnRequestMessage(req.tenantDb, req.params.id, fetched.rows[0]);
    return res.status(201).json(fetched.rows[0]);
  } catch (err) {
    console.error('send return message error', err);
    return res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
