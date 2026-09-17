'use strict';

/**
 * customerPortal.js — Scoped API for Customer Portal users.
 *
 * SECURITY CONTRACT:
 * - Every route checks req.customerUser.customer_id === record.customer_id (IDOR prevention)
 * - Internal routes are NOT accessible via portal tokens
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { publishReturnRequestMessage } = require('../lib/returnRequestSocket');
const { requireCustomerPortalAuth, requirePortalPermission } = require('../middleware/portalAuth');
const { getNextDocumentNumber } = require('../lib/invoiceEngine');
const { createNotification } = require('../lib/notifications');
const { streamInvoicePdf } = require('../lib/pdfInvoice');
const { queryMaster } = require('../db/masterDb');

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE & METRICS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/profile', requireCustomerPortalAuth, async (req, res) => {
  try {
    const custRes = await req.tenantDb.query(
      'SELECT id, name, customer_code, phone, email, billing_address, city, state, gstin, payment_terms, credit_limit FROM customers WHERE id = ? AND deleted_at IS NULL',
      [req.customerUser.customer_id]
    );
    if (custRes.rowCount === 0) return res.status(404).json({ error: 'Customer not found' });
    
    const statsRes = await req.tenantDb.query(
      `SELECT COUNT(*) AS total_orders,
              COALESCE(SUM(total_amount), 0) AS total_order_value,
              COALESCE(SUM(amount_received), 0) AS total_paid,
              COALESCE(SUM(amount_due), 0) AS total_due
       FROM sales
       WHERE customer_id = ? AND deleted_at IS NULL`,
      [req.customerUser.customer_id]
    );

    return res.json({
      portal_user: { id: req.customerUser.id, name: req.customerUser.name, email: req.customerUser.email },
      customer: custRes.rows[0],
      summary: statsRes.rows[0]
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SALES ORDERS & INVOICES
// ─────────────────────────────────────────────────────────────────────────────

router.get('/invoices', requireCustomerPortalAuth, requirePortalPermission('customer_orders', 'view'), async (req, res) => {
  try {
    const params = [req.customerUser.customer_id];
    let conditions = 's.customer_id = ? AND s.deleted_at IS NULL';

    if (req.query.status && req.query.status !== 'all') {
      params.push(req.query.status);
      conditions += ' AND s.status = ?';
    }

    const result = await req.tenantDb.query(
      `SELECT s.id, s.invoice_number, s.date, s.due_date, s.total_amount, s.amount_received,
              s.amount_due, s.payment_status, COALESCE(s.status, 'Sales Order Sent') AS status,
              s.customer_notes, s.decline_reason, s.dispatch_tracking_ref, s.subtotal,
              s.total_tax, s.notes, s.created_at, c.name AS customer_name
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       WHERE ${conditions}
       ORDER BY s.date DESC, s.created_at DESC`,
      params
    );

    const invoices = [];
    for (const sale of result.rows) {
      const itemsRes = await req.tenantDb.query(
        `SELECT si.finished_good_id, si.quantity, si.rate_per_unit, si.line_total, si.tax_rate,
                fg.name AS item_name, fg.unit
         FROM sales_items si
         JOIN finished_goods fg ON fg.id = si.finished_good_id
         WHERE si.sale_id = ?`,
        [sale.id]
      );
      invoices.push({ ...sale, items: itemsRes.rows });
    }

    return res.json(invoices);
  } catch (err) {
    console.error('customer portal invoices error', err);
    return res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

router.get('/invoices/:id', requireCustomerPortalAuth, requirePortalPermission('customer_orders', 'view'), async (req, res) => {
  try {
    const saleRes = await req.tenantDb.query(
      `SELECT s.*, COALESCE(s.status, 'Sales Order Sent') AS status FROM sales s WHERE s.id = ? AND s.deleted_at IS NULL`,
      [req.params.id]
    );

    if (saleRes.rowCount === 0) return res.status(404).json({ error: 'Order not found' });
    const sale = saleRes.rows[0];

    if (sale.customer_id !== req.customerUser.customer_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const itemsRes = await req.tenantDb.query(
      `SELECT si.*, fg.name AS item_name, fg.unit
       FROM sales_items si
       JOIN finished_goods fg ON fg.id = si.finished_good_id
       WHERE si.sale_id = ?`,
      [sale.id]
    );
    sale.items = itemsRes.rows;

    const paymentsRes = await req.tenantDb.query(
      `SELECT * FROM payments_log WHERE related_id = ? AND deleted_at IS NULL ORDER BY date DESC`,
      [sale.id]
    );
    sale.payments_history = paymentsRes.rows;

    return res.json(sale);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch order detail' });
  }
});

router.get('/invoices/:id/pdf', requireCustomerPortalAuth, requirePortalPermission('customer_orders', 'export'), async (req, res) => {
  try {
    const saleRes = await req.tenantDb.query(
      `SELECT s.*, 
              c.name AS customer_name, 
              c.email AS customer_email, 
              c.phone AS customer_phone, 
              c.gstin AS customer_gstin,
              c.state AS customer_state,
              COALESCE(c.billing_address, c.address) AS customer_address,
              COALESCE(l.name, (SELECT name FROM locations WHERE is_default = 1 LIMIT 1), (SELECT name FROM locations LIMIT 1), 'Main Location') AS location_name
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN locations l ON l.id = s.location_id
       WHERE s.id = ? AND s.deleted_at IS NULL`,
      [req.params.id]
    );

    if (saleRes.rowCount === 0) return res.status(404).json({ error: 'Order not found' });
    const sale = saleRes.rows[0];

    if (sale.customer_id !== req.customerUser.customer_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const itemsRes = await req.tenantDb.query(
      `SELECT si.*, 
              COALESCE(fg.name, 'Finished Product') AS finished_good_name,
              COALESCE(fg.name, 'Finished Product') AS item_name,
              COALESCE(ppl.package_unit, fg.unit, 'pcs') AS unit,
              fg.unit AS base_unit,
              fg.hsn_code,
              COALESCE(si.package_name, ppl.name) AS package_name,
              ppl.package_unit
       FROM sales_items si
       LEFT JOIN finished_goods fg ON fg.id = si.finished_good_id
       LEFT JOIN product_packaging_levels ppl ON ppl.id = COALESCE(si.packaging_level_id, si.packaging_config_id)
       WHERE si.sale_id = ?`,
      [req.params.id]
    );

    const formattedItems = (itemsRes.rows || []).map(row => {
      const qty = Number(row.quantity || 0);
      const rate = Number(row.unit_price || row.rate_per_unit || 0);
      const taxRate = Number(row.tax_rate || 0);
      const taxable = Number(row.taxable_amount != null ? row.taxable_amount : (qty * rate));
      const lineTotal = Number(row.total_amount != null ? row.total_amount : (taxable + (taxable * taxRate / 100)));

      let itemName = row.finished_good_name;
      if (row.package_name) {
        itemName = `${row.finished_good_name} (${row.package_name})`;
      }

      return {
        name: itemName,
        hsn_code: row.hsn_code || '-',
        quantity: qty,
        rate_per_unit: rate,
        taxable_value: taxable,
        tax_rate: taxRate,
        line_total: lineTotal
      };
    });

    let workspace = {
      name: 'ERP Studio',
      gstin: 'Unregistered',
      state: 'Delhi',
      address: 'Enterprise Headquarters',
      accent_color: '#1e3a8a'
    };

    try {
      const compRes = await queryMaster(
        'SELECT id, company_name AS name, gstin, state, address, support_phone AS phone, support_email AS email, currency, number_system FROM companies WHERE id = ?',
        [req.companyId || req.customerUser.company_id]
      );
      if (compRes.rowCount > 0 && compRes.rows[0]) {
        workspace = { ...workspace, ...compRes.rows[0] };
      }
    } catch (cErr) {
      console.warn('Could not query master company for portal invoice pdf:', cErr.message);
    }

    const customer = {
      name: sale.customer_name || req.customerUser.name || 'Customer',
      gstin: sale.customer_gstin || 'Unregistered',
      state: sale.customer_state || sale.place_of_supply || workspace.state || 'N/A',
      address: sale.customer_address || 'N/A'
    };

    const invoice = {
      ...sale,
      invoice_number: sale.invoice_number || 'INV-0001',
      date: sale.date ? new Date(sale.date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
      due_date: sale.due_date ? new Date(sale.due_date).toISOString().slice(0, 10) : 'On Receipt',
      subtotal: Number(sale.subtotal || 0),
      total_tax: Number(sale.tax_amount || sale.total_tax || 0),
      cgst_amount: Number(sale.cgst_amount || 0),
      sgst_amount: Number(sale.sgst_amount || 0),
      igst_amount: Number(sale.igst_amount || 0),
      discount_amount: Number(sale.discount_amount || sale.invoice_discount || 0),
      round_off_amount: Number(sale.round_off_amount || 0),
      total_amount: Number(sale.total_amount || 0),
      amount_received: Number(sale.amount_received || 0),
      amount_due: Number(sale.amount_due || 0),
      terms_and_conditions: sale.terms_and_conditions || null
    };

    return streamInvoicePdf(res, {
      workspace,
      customer,
      invoice,
      items: formattedItems
    });
  } catch (err) {
    console.error('Customer portal invoice PDF error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to generate invoice PDF' });
    }
  }
});

// Customer Action: CONFIRM SALES ORDER
// Generates/verifies GST Invoice & reserves/deducts finished goods inventory ('out')
router.post('/invoices/:id/confirm', requireCustomerPortalAuth, requirePortalPermission('customer_orders', 'edit'), async (req, res) => {
  try {
    const saleRes = await req.tenantDb.query('SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (saleRes.rowCount === 0) return res.status(404).json({ error: 'Order not found' });
    const sale = saleRes.rows[0];

    if (sale.customer_id !== req.customerUser.customer_id) return res.status(403).json({ error: 'Access denied' });

    await req.tenantDb.query('START TRANSACTION');

    // Update status to Confirmed
    await req.tenantDb.query(
      "UPDATE sales SET status = 'Confirmed', customer_notes = 'Order confirmed by customer', updated_at = NOW() WHERE id = ?",
      [req.params.id]
    );

    // Reserve / Deduct Finished Goods Inventory ('out')
    const itemsRes = await req.tenantDb.query('SELECT * FROM sales_items WHERE sale_id = ?', [req.params.id]);
    for (const line of itemsRes.rows) {
      const ledgerId = crypto.randomUUID();
      await req.tenantDb.query(
        `INSERT INTO inventory_ledger (
          id, item_type, item_id, transaction_type, quantity, unit_cost, location_id, reason, reference_table, reference_id, created_by
        ) VALUES (?, 'finished_good', ?, 'out', ?, ?, ?, ?, 'sales', ?, ?)`,
        [ledgerId, line.finished_good_id, line.quantity, line.rate_per_unit, sale.location_id, `Sales Order Confirmed ${sale.invoice_number}`, sale.id, req.customerUser.portal_user_id]
      );
    }

    await createNotification(req.tenantDb, {
      user_type: 'user',
      title: 'Sales Order Confirmed by Customer',
      message: `Customer has confirmed order ${sale.invoice_number}. Finished goods inventory reserved.`,
      link: `/invoices`
    });

    await req.tenantDb.query('COMMIT');
    return res.json({ ok: true, message: 'Order confirmed successfully!' });
  } catch (err) {
    await req.tenantDb.query('ROLLBACK').catch(() => {});
    console.error('confirm order error', err);
    return res.status(500).json({ error: 'Failed to confirm order' });
  }
});

// Customer Action: DECLINE SALES ORDER
router.post('/invoices/:id/decline', requireCustomerPortalAuth, requirePortalPermission('customer_orders', 'edit'), async (req, res) => {
  const { reason } = req.body;
  if (!reason || String(reason).trim().length < 3) {
    return res.status(400).json({ error: 'Please provide a valid decline reason' });
  }

  try {
    const saleRes = await req.tenantDb.query('SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (saleRes.rowCount === 0) return res.status(404).json({ error: 'Order not found' });
    const sale = saleRes.rows[0];

    if (sale.customer_id !== req.customerUser.customer_id) return res.status(403).json({ error: 'Access denied' });

    await req.tenantDb.query(
      "UPDATE sales SET status = 'Declined', decline_reason = ?, updated_at = NOW() WHERE id = ?",
      [reason.trim(), req.params.id]
    );

    await createNotification(req.tenantDb, {
      user_type: 'user',
      title: 'Sales Order Declined by Customer',
      message: `Customer declined order ${sale.invoice_number}. Reason: ${reason.trim()}`,
      link: `/invoices`
    });

    return res.json({ ok: true, message: 'Sales order declined' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to decline order' });
  }
});

// Customer Action: CONFIRM DELIVERY
router.post('/invoices/:id/confirm-delivery', requireCustomerPortalAuth, requirePortalPermission('customer_orders', 'edit'), async (req, res) => {
  try {
    const saleRes = await req.tenantDb.query('SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (saleRes.rowCount === 0) return res.status(404).json({ error: 'Order not found' });
    const sale = saleRes.rows[0];

    if (sale.customer_id !== req.customerUser.customer_id) return res.status(403).json({ error: 'Access denied' });

    await req.tenantDb.query(
      "UPDATE sales SET status = 'Delivered', delivered_date = NOW(), updated_at = NOW() WHERE id = ?",
      [req.params.id]
    );

    return res.json({ ok: true, message: 'Delivery confirmed!' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to confirm delivery' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RETURN REQUESTS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/return-requests', requireCustomerPortalAuth, requirePortalPermission('returns', 'view'), async (req, res) => {
  try {
    const result = await req.tenantDb.query(
      `SELECT id, request_number, request_type, reference_id, reference_type, reason,
              status, review_notes, created_at, updated_at
       FROM return_requests
       WHERE customer_id = ?
       ORDER BY created_at DESC`,
      [req.customerUser.customer_id]
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch return requests' });
  }
});

router.post('/return-requests', requireCustomerPortalAuth, requirePortalPermission('returns', 'create'), async (req, res) => {
  const { reference_id, reference_type = 'sale', request_type, reason, items } = req.body;

  if (!reference_id) return res.status(400).json({ error: 'reference_id is required' });
  if (!reason || String(reason).trim().length < 5) return res.status(400).json({ error: 'reason is required (minimum 5 characters)' });
  if (!['sales_return', 'sales_cancellation'].includes(request_type)) {
    return res.status(400).json({ error: 'request_type must be sales_return or sales_cancellation for customer portal' });
  }

  try {
    const saleRes = await req.tenantDb.query('SELECT customer_id FROM sales WHERE id = ? AND deleted_at IS NULL', [reference_id]);
    if (saleRes.rowCount === 0) return res.status(404).json({ error: 'Sales order not found' });
    if (saleRes.rows[0].customer_id !== req.customerUser.customer_id) return res.status(403).json({ error: 'Access denied' });

    const existingRes = await req.tenantDb.query(
      "SELECT id FROM return_requests WHERE reference_id = ? AND status = 'Pending'",
      [reference_id]
    );
    if (existingRes.rowCount > 0) {
      return res.status(400).json({ error: 'A pending return/cancellation request already exists for this document' });
    }

    const requestNumber = await getNextDocumentNumber(req.tenantDb, 'return_request');
    const id = crypto.randomUUID();
    await req.tenantDb.query(
      `INSERT INTO return_requests
         (id, request_number, request_type, reference_id, reference_type, requested_by_type,
          requested_by_id, customer_id, reason, items, status)
       VALUES (?, ?, ?, ?, ?, 'customer_portal', ?, ?, ?, ?, 'Pending')`,
      [id, requestNumber, request_type, reference_id, reference_type,
       req.customerUser.portal_user_id, req.customerUser.customer_id,
       reason.trim(), items ? JSON.stringify(items) : null]
    );

    const fetched = await req.tenantDb.query('SELECT * FROM return_requests WHERE id = ?', [id]);
    return res.status(201).json(fetched.rows[0]);
  } catch (err) {
    console.error('customer portal return request error', err);
    return res.status(500).json({ error: 'Failed to create return request' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CHAT MESSAGES — Customer Portal Read & Write
// ─────────────────────────────────────────────────────────────────────────────

// GET /customer-portal/api/return-requests/:id/messages
router.get('/return-requests/:id/messages', requireCustomerPortalAuth, async (req, res) => {
  try {
    // IDOR: verify the return request belongs to this customer
    const rrRes = await req.tenantDb.query(
      'SELECT id, customer_id FROM return_requests WHERE id = ?',
      [req.params.id]
    );
    if (rrRes.rowCount === 0) return res.status(404).json({ error: 'Return request not found' });
    if (rrRes.rows[0].customer_id !== req.customerUser.customer_id) {
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
    console.error('customer portal list messages error', err);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// POST /customer-portal/api/return-requests/:id/messages
router.post('/return-requests/:id/messages', requireCustomerPortalAuth, async (req, res) => {
  const { message } = req.body;
  if (!message || String(message).trim().length === 0) {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    // IDOR + status check
    const rrRes = await req.tenantDb.query(
      'SELECT id, customer_id, status FROM return_requests WHERE id = ?',
      [req.params.id]
    );
    if (rrRes.rowCount === 0) return res.status(404).json({ error: 'Return request not found' });
    if (rrRes.rows[0].customer_id !== req.customerUser.customer_id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (rrRes.rows[0].status !== 'Pending') {
      return res.status(409).json({ error: 'Chat is closed. This request has already been resolved.' });
    }

    const msgId = crypto.randomUUID();
    const senderName = req.customerUser.name || req.customerUser.email || 'Customer';
    await req.tenantDb.query(
      `INSERT INTO return_request_messages
         (id, return_request_id, sender_type, sender_id, sender_name, message, is_system)
       VALUES (?, ?, 'customer', ?, ?, ?, 0)`,
      [msgId, req.params.id, req.customerUser.portal_user_id || req.customerUser.id, senderName, message.trim()]
    );

    const fetched = await req.tenantDb.query(
      'SELECT * FROM return_request_messages WHERE id = ?',
      [msgId]
    );
    publishReturnRequestMessage(req.tenantDb, req.params.id, fetched.rows[0]);
    return res.status(201).json(fetched.rows[0]);
  } catch (err) {
    console.error('customer portal send message error', err);
    return res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
