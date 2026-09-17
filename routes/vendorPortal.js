'use strict';

/**
 * vendorPortal.js — Scoped API for Vendor Portal users.
 *
 * SECURITY CONTRACT:
 * - Every route checks req.vendorUser.vendor_id === record.vendor_id (IDOR prevention)
 * - Internal routes are NOT accessible via portal tokens (enforced by requireVendorPortalAuth)
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { publishReturnRequestMessage } = require('../lib/returnRequestSocket');
const { requireVendorPortalAuth, requirePortalPermission } = require('../middleware/portalAuth');
const { getNextDocumentNumber } = require('../lib/invoiceEngine');

// ─────────────────────────────────────────────────────────────────────────────
// CHAT HELPER
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
  } catch (err) {
    console.warn('insertSystemMessage failed (non-fatal):', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE & FINANCIAL SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

router.get('/profile', requireVendorPortalAuth, async (req, res) => {
  try {
    const vendorRes = await req.tenantDb.query(
      'SELECT id, name, vendor_code, phone, email, address, city, state, gstin, payment_terms FROM vendors WHERE id = ? AND deleted_at IS NULL',
      [req.vendorUser.vendor_id]
    );
    if (vendorRes.rowCount === 0) return res.status(404).json({ error: 'Vendor not found' });
    
    // Calculate total statistics across vendor's purchase orders
    const statsRes = await req.tenantDb.query(
      `SELECT COUNT(*) AS total_orders,
              COALESCE(SUM(total_amount), 0) AS total_order_value,
              COALESCE(SUM(amount_paid), 0) AS total_paid,
              COALESCE(SUM(amount_due), 0) AS total_due
       FROM procurements
       WHERE vendor_id = ? AND deleted_at IS NULL`,
      [req.vendorUser.vendor_id]
    );

    return res.json({
      portal_user: { id: req.vendorUser.id, name: req.vendorUser.name, email: req.vendorUser.email },
      vendor: vendorRes.rows[0],
      summary: statsRes.rows[0]
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PROCUREMENTS (Purchase Orders) — READ & ACTION WORKFLOW
// ─────────────────────────────────────────────────────────────────────────────

router.get('/procurements', requireVendorPortalAuth, requirePortalPermission('vendor_orders', 'view'), async (req, res) => {
  try {
    const params = [req.vendorUser.vendor_id];
    let conditions = 'p.vendor_id = ? AND p.deleted_at IS NULL';

    if (req.query.status && req.query.status !== 'all') {
      params.push(req.query.status);
      conditions += ' AND p.status = ?';
    }
    if (req.query.start_date) {
      params.push(req.query.start_date);
      conditions += ' AND p.date >= ?';
    }
    if (req.query.end_date) {
      params.push(req.query.end_date);
      conditions += ' AND p.date <= ?';
    }

    const result = await req.tenantDb.query(
      `SELECT p.id, p.procurement_number, p.date, p.total_amount, p.amount_paid,
              p.amount_due, p.subtotal, p.tax_amount, p.discount_amount, p.notes,
              COALESCE(p.status, 'Pending Vendor Confirmation') AS status,
              p.vendor_notes, p.dispatch_tracking_ref, p.created_at
       FROM procurements p
       WHERE ${conditions}
       ORDER BY p.date DESC, p.created_at DESC`,
      params
    );

    // Fetch line items summary & item count for each procurement
    const procurements = [];
    for (const proc of result.rows) {
      const itemsRes = await req.tenantDb.query(
        `SELECT pi.item_id, pi.quantity, pi.rate_per_unit, pi.line_total, pi.tax_rate,
                COALESCE(i.name, rm.name, 'Item') AS item_name, COALESCE(i.unit, rm.unit, 'pcs') AS unit
         FROM procurement_items pi
         LEFT JOIN items i ON i.id = pi.item_id
         LEFT JOIN raw_materials rm ON rm.id = pi.item_id
         WHERE pi.procurement_id = ?`,
        [proc.id]
      );
      procurements.push({ ...proc, items: itemsRes.rows });
    }

    return res.json(procurements);
  } catch (err) {
    console.error('vendor portal procurements error', err);
    return res.status(500).json({ error: 'Failed to fetch procurements' });
  }
});

// Single Procurement Detailed View with Payment History Ledger & Items Breakdown
router.get('/procurements/:id', requireVendorPortalAuth, requirePortalPermission('vendor_orders', 'view'), async (req, res) => {
  try {
    const procRes = await req.tenantDb.query(
      `SELECT p.*, COALESCE(p.status, 'Pending Vendor Confirmation') AS status
       FROM procurements p
       WHERE p.id = ? AND p.deleted_at IS NULL`,
      [req.params.id]
    );
    if (procRes.rowCount === 0) return res.status(404).json({ error: 'Not found' });

    const proc = procRes.rows[0];

    // IDOR check: must belong to authenticated vendor
    if (proc.vendor_id !== req.vendorUser.vendor_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Line items
    const itemsRes = await req.tenantDb.query(
      `SELECT pi.item_id, pi.quantity, pi.rate_per_unit, pi.line_total, pi.tax_rate,
              COALESCE(i.name, rm.name, 'Item') AS item_name, COALESCE(i.unit, rm.unit, 'pcs') AS unit
       FROM procurement_items pi
       LEFT JOIN items i ON i.id = pi.item_id
       LEFT JOIN raw_materials rm ON rm.id = pi.item_id
       WHERE pi.procurement_id = ?`,
      [req.params.id]
    );
    proc.items = itemsRes.rows;

    // Payment History Ledger
    const paymentsRes = await req.tenantDb.query(
      `SELECT id, amount, date, notes, created_at
       FROM payments_log
       WHERE related_id = ? AND deleted_at IS NULL
       ORDER BY date DESC, created_at DESC`,
      [req.params.id]
    );
    proc.payments_history = paymentsRes.rows;

    // Return / Cancellation Requests for this order
    const returnsRes = await req.tenantDb.query(
      `SELECT * FROM return_requests WHERE reference_id = ? ORDER BY created_at DESC`,
      [req.params.id]
    );
    proc.return_requests = returnsRes.rows;

    return res.json(proc);
  } catch (err) {
    console.error('vendor portal procurements detail error', err);
    return res.status(500).json({ error: 'Failed to fetch procurement details' });
  }
});

// Vendor Action: ACCEPT ORDER
router.post('/procurements/:id/accept', requireVendorPortalAuth, requirePortalPermission('vendor_orders', 'edit'), async (req, res) => {
  try {
    const procRes = await req.tenantDb.query(
      'SELECT id, vendor_id, status FROM procurements WHERE id = ? AND deleted_at IS NULL',
      [req.params.id]
    );
    if (procRes.rowCount === 0) return res.status(404).json({ error: 'Procurement not found' });
    if (procRes.rows[0].vendor_id !== req.vendorUser.vendor_id) return res.status(403).json({ error: 'Access denied' });

    await req.tenantDb.query(
      "UPDATE procurements SET status = 'Accepted', vendor_notes = 'Accepted by vendor', updated_at = NOW() WHERE id = ?",
      [req.params.id]
    );

    return res.json({ ok: true, message: 'Order accepted successfully' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to accept order' });
  }
});

// Vendor Action: REJECT / DENY ORDER
router.post('/procurements/:id/reject', requireVendorPortalAuth, requirePortalPermission('vendor_orders', 'edit'), async (req, res) => {
  const { reason } = req.body;
  if (!reason || String(reason).trim().length < 3) {
    return res.status(400).json({ error: 'Please provide a valid rejection reason' });
  }

  try {
    const procRes = await req.tenantDb.query(
      'SELECT id, vendor_id FROM procurements WHERE id = ? AND deleted_at IS NULL',
      [req.params.id]
    );
    if (procRes.rowCount === 0) return res.status(404).json({ error: 'Procurement not found' });
    if (procRes.rows[0].vendor_id !== req.vendorUser.vendor_id) return res.status(403).json({ error: 'Access denied' });

    await req.tenantDb.query(
      "UPDATE procurements SET status = 'Denied', vendor_notes = ?, decline_reason = ?, updated_at = NOW() WHERE id = ?",
      [reason.trim(), reason.trim(), req.params.id]
    ).catch(async () => {
      // Fallback if decline_reason column is missing
      await req.tenantDb.query(
        "UPDATE procurements SET status = 'Denied', vendor_notes = ?, updated_at = NOW() WHERE id = ?",
        [reason.trim(), req.params.id]
      );
    });

    return res.json({ ok: true, message: 'Order denied' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reject order' });
  }
});

// Vendor Action: DISPATCH ORDER
router.post('/procurements/:id/dispatch', requireVendorPortalAuth, requirePortalPermission('vendor_orders', 'edit'), async (req, res) => {
  const { tracking_ref, notes } = req.body;

  try {
    const procRes = await req.tenantDb.query(
      'SELECT id, vendor_id FROM procurements WHERE id = ? AND deleted_at IS NULL',
      [req.params.id]
    );
    if (procRes.rowCount === 0) return res.status(404).json({ error: 'Procurement not found' });
    if (procRes.rows[0].vendor_id !== req.vendorUser.vendor_id) return res.status(403).json({ error: 'Access denied' });

    await req.tenantDb.query(
      "UPDATE procurements SET status = 'Dispatched', dispatch_tracking_ref = ?, vendor_notes = ?, updated_at = NOW() WHERE id = ?",
      [tracking_ref ? tracking_ref.trim() : null, notes ? notes.trim() : 'Dispatched by vendor', req.params.id]
    );

    return res.json({ ok: true, message: 'Order marked as dispatched' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to mark order as dispatched' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RETURN & CANCELLATION REQUESTS — WORKFLOW & APPROVAL CHAIN
// ─────────────────────────────────────────────────────────────────────────────

router.get('/return-requests', requireVendorPortalAuth, requirePortalPermission('returns', 'view'), async (req, res) => {
  try {
    const result = await req.tenantDb.query(
      `SELECT rr.id, rr.request_number, rr.request_type, rr.reference_id, rr.reference_type,
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
       WHERE rr.vendor_id = ?
       ORDER BY
         CASE rr.status WHEN 'Pending' THEN 0 WHEN 'Approved' THEN 1 ELSE 2 END ASC,
         rr.created_at DESC`,
      [req.vendorUser.vendor_id]
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch return requests' });
  }
});

// Vendor Action: Submit a Return / Cancellation Request
router.post('/return-requests', requireVendorPortalAuth, requirePortalPermission('returns', 'create'), async (req, res) => {
  const { reference_id, reference_type = 'procurement', request_type, reason, items } = req.body;

  if (!reference_id) return res.status(400).json({ error: 'reference_id is required' });
  if (!reason || String(reason).trim().length < 5) return res.status(400).json({ error: 'reason is required (minimum 5 characters)' });
  if (!['purchase_return', 'purchase_cancellation'].includes(request_type)) {
    return res.status(400).json({ error: 'request_type must be purchase_return or purchase_cancellation' });
  }

  try {
    const procRes = await req.tenantDb.query(
      'SELECT id, vendor_id FROM procurements WHERE id = ? AND deleted_at IS NULL',
      [reference_id]
    );
    if (procRes.rowCount === 0) return res.status(404).json({ error: 'Procurement not found' });
    if (procRes.rows[0].vendor_id !== req.vendorUser.vendor_id) return res.status(403).json({ error: 'Access denied' });

    const existingRes = await req.tenantDb.query(
      "SELECT id FROM return_requests WHERE reference_id = ? AND status = 'Pending'",
      [reference_id]
    );
    if (existingRes.rowCount > 0) {
      return res.status(400).json({ error: 'A pending return/cancellation request already exists for this procurement' });
    }

    const requestNumber = await getNextDocumentNumber(req.tenantDb, 'return_request');
    const id = crypto.randomUUID();
    await req.tenantDb.query(
      `INSERT INTO return_requests
         (id, request_number, request_type, reference_id, reference_type, requested_by_type,
          requested_by_id, vendor_id, reason, items, status)
       VALUES (?, ?, ?, ?, ?, 'vendor_portal', ?, ?, ?, ?, 'Pending')`,
      [id, requestNumber, request_type, reference_id, reference_type,
       req.vendorUser.portal_user_id, req.vendorUser.vendor_id,
       reason.trim(), items ? JSON.stringify(items) : null]
    );

    const fetched = await req.tenantDb.query('SELECT * FROM return_requests WHERE id = ?', [id]);
    return res.json(fetched.rows[0]);
  } catch (err) {
    console.error('vendor portal return request error', err);
    return res.status(500).json({ error: 'Failed to create return request' });
  }
});

// Vendor Action: ACCEPT Return Request initiated by Owner/Manager
router.post('/return-requests/:id/accept', requireVendorPortalAuth, requirePortalPermission('returns', 'edit'), async (req, res) => {
  const { notes } = req.body;
  try {
    const rrRes = await req.tenantDb.query(
      'SELECT id, vendor_id, status, reference_id, request_type FROM return_requests WHERE id = ?',
      [req.params.id]
    );
    if (rrRes.rowCount === 0) return res.status(404).json({ error: 'Return request not found' });
    if (rrRes.rows[0].vendor_id !== req.vendorUser.vendor_id) return res.status(403).json({ error: 'Access denied' });

    if (rrRes.rows[0].status !== 'Pending') return res.status(409).json({ error: 'This return request has already been reviewed' });

    await req.tenantDb.query(
      `UPDATE return_requests
       SET status = 'Approved', review_notes = ?, reviewed_by = ?, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [notes ? notes.trim() : 'Approved by vendor', req.vendorUser.portal_user_id, req.params.id]
    );
    if (['purchase_return', 'purchase_cancellation'].includes(rrRes.rows[0].request_type)) {
      await req.tenantDb.query(
        "UPDATE procurements SET status = 'Return Accepted by Vendor', updated_at = NOW() WHERE id = ? AND vendor_id = ?",
        [rrRes.rows[0].reference_id, req.vendorUser.vendor_id]
      );
    }

    // Auto-close chat with a system message
    await insertSystemMessage(
      req.tenantDb,
      req.params.id,
      `✅ Vendor has Approved this return request. ${notes ? `Notes: ${notes.trim()}` : ''} The chat is now closed and contact information is available.`
    );

    return res.json({ ok: true, message: 'Return request approved by vendor' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to accept return request' });
  }
});

// Vendor Action: DENY / REJECT Return Request initiated by Owner/Manager
router.post('/return-requests/:id/reject', requireVendorPortalAuth, requirePortalPermission('returns', 'edit'), async (req, res) => {
  const { reason } = req.body;
  if (!reason || String(reason).trim().length < 3) {
    return res.status(400).json({ error: 'Rejection reason is required' });
  }

  try {
    const rrRes = await req.tenantDb.query(
      'SELECT id, vendor_id, status, reference_id, request_type FROM return_requests WHERE id = ?',
      [req.params.id]
    );
    if (rrRes.rowCount === 0) return res.status(404).json({ error: 'Return request not found' });
    if (rrRes.rows[0].vendor_id !== req.vendorUser.vendor_id) return res.status(403).json({ error: 'Access denied' });

    if (rrRes.rows[0].status !== 'Pending') return res.status(409).json({ error: 'This return request has already been reviewed' });

    await req.tenantDb.query(
      `UPDATE return_requests
       SET status = 'Rejected', review_notes = ?, reviewed_by = ?, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [reason.trim(), req.vendorUser.portal_user_id, req.params.id]
    );
    if (['purchase_return', 'purchase_cancellation'].includes(rrRes.rows[0].request_type)) {
      await req.tenantDb.query(
        "UPDATE procurements SET status = 'Return Rejected by Vendor', rejection_reason = ?, updated_at = NOW() WHERE id = ? AND vendor_id = ?",
        [reason.trim(), rrRes.rows[0].reference_id, req.vendorUser.vendor_id]
      );
    }

    // Auto-close chat with a system message
    await insertSystemMessage(
      req.tenantDb,
      req.params.id,
      `❌ Vendor has Rejected this return request. Reason: ${reason.trim()} The chat is now closed.`
    );

    return res.json({ ok: true, message: 'Return request denied' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reject return request' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CHAT MESSAGES — Vendor Portal Read & Write
// ─────────────────────────────────────────────────────────────────────────────

// GET /vendor-portal/api/return-requests/:id/messages
router.get('/return-requests/:id/messages', requireVendorPortalAuth, async (req, res) => {
  try {
    // IDOR: verify the return request belongs to this vendor
    const rrRes = await req.tenantDb.query(
      'SELECT id, vendor_id FROM return_requests WHERE id = ?',
      [req.params.id]
    );
    if (rrRes.rowCount === 0) return res.status(404).json({ error: 'Return request not found' });
    if (rrRes.rows[0].vendor_id !== req.vendorUser.vendor_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await req.tenantDb.query(
      `SELECT id, sender_type, sender_id, sender_name, message, is_system, created_at
       FROM return_request_messages
       WHERE return_request_id = ?
       ORDER BY created_at ASC`,
      [req.params.id]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('vendor portal list messages error', err);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// POST /vendor-portal/api/return-requests/:id/messages
router.post('/return-requests/:id/messages', requireVendorPortalAuth, async (req, res) => {
  const { message } = req.body;
  if (!message || String(message).trim().length === 0) {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    // IDOR + status check
    const rrRes = await req.tenantDb.query(
      'SELECT id, vendor_id, status FROM return_requests WHERE id = ?',
      [req.params.id]
    );
    if (rrRes.rowCount === 0) return res.status(404).json({ error: 'Return request not found' });
    if (rrRes.rows[0].vendor_id !== req.vendorUser.vendor_id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (rrRes.rows[0].status !== 'Pending') {
      return res.status(409).json({ error: 'Chat is closed. This request has already been resolved.' });
    }

    const msgId = crypto.randomUUID();
    const senderName = req.vendorUser.name || req.vendorUser.email || 'Vendor';
    await req.tenantDb.query(
      `INSERT INTO return_request_messages
         (id, return_request_id, sender_type, sender_id, sender_name, message, is_system)
       VALUES (?, ?, 'vendor', ?, ?, ?, 0)`,
      [msgId, req.params.id, req.vendorUser.portal_user_id || req.vendorUser.id, senderName, message.trim()]
    );

    const fetched = await req.tenantDb.query(
      'SELECT * FROM return_request_messages WHERE id = ?',
      [msgId]
    );
    publishReturnRequestMessage(req.tenantDb, req.params.id, fetched.rows[0]);
    return res.status(201).json(fetched.rows[0]);
  } catch (err) {
    console.error('vendor portal send message error', err);
    return res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
