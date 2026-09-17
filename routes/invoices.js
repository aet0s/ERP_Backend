const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const { calculateInvoiceLine, calculateInvoiceTotals, getNextDocumentNumber } = require('../lib/invoiceEngine');
const { streamInvoicePdf } = require('../lib/pdfInvoice');
const { queryMaster } = require('../db/masterDb');
const { createNotification } = require('../lib/notifications');

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER ORDER PROCESS CHAIN & SALES INVOICES
// ─────────────────────────────────────────────────────────────────────────────

// List Sales Invoices & Sales Orders
router.get('/', requireAuth, requirePermission('sales', 'view'), async (req, res) => {
  try {
    const { customer_id, location_id, payment_status, search, status, start_date, end_date } = req.query;
    let where = 's.deleted_at IS NULL';
    const params = [];

    // NON-NEGOTIABLE BACKEND ROW-LEVEL SCOPING FOR CUSTOMERS
    if (req.user.role === 'customer' || req.user.customer_id) {
      params.push(req.user.customer_id);
      where += ` AND s.customer_id = ?`;
    } else if (customer_id) {
      params.push(customer_id);
      where += ` AND s.customer_id = ?`;
    }

    if (location_id) {
      params.push(location_id, location_id);
      where += ` AND (s.location_id = ? OR (s.location_id IS NULL AND (SELECT id FROM locations WHERE is_default = 1 LIMIT 1) = ?))`;
    }

    if (payment_status && payment_status !== 'all') {
      if (payment_status === 'paid') {
        where += ` AND (s.amount_due <= 0.01 OR (s.total_amount > 0 AND s.amount_received >= s.total_amount - 0.01))`;
      } else if (payment_status === 'partial') {
        where += ` AND s.amount_received > 0.01 AND s.amount_due > 0.01`;
      } else if (payment_status === 'unpaid') {
        where += ` AND (s.amount_received IS NULL OR s.amount_received <= 0.01)`;
      } else {
        params.push(payment_status);
        where += ` AND s.payment_status = ?`;
      }
    }

    if (status && status !== 'all') {
      if (status === 'Declined') {
        where += ` AND (s.status = 'Declined' OR s.status = 'Rejected')`;
      } else {
        params.push(status);
        where += ` AND s.status = ?`;
      }
    }

    if (start_date) {
      params.push(start_date);
      where += ` AND s.date >= ?`;
    }

    if (end_date) {
      params.push(end_date);
      where += ` AND s.date <= ?`;
    }

    if (search) {
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      where += ` AND (s.invoice_number LIKE ? OR c.name LIKE ? OR (SELECT GROUP_CONCAT(COALESCE(fg.name, 'Item')) FROM sales_items si LEFT JOIN finished_goods fg ON fg.id = si.finished_good_id WHERE si.sale_id = s.id) LIKE ?)`;
    }

    const countRes = await req.tenantDb.query(
      `SELECT COUNT(*) AS count
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       WHERE ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0]?.count || 0, 10);

    const isTable = req.query.table === '1';
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(parseInt(req.query.page_size || req.query.limit || (isTable ? '20' : '200'), 10), 10000);
    const offset = (page - 1) * pageSize;

    let query = `
      SELECT s.*, c.name AS customer_name, c.gstin AS customer_gstin, c.state AS customer_state,
             COALESCE(l.name, (SELECT name FROM locations WHERE is_default = 1 LIMIT 1), (SELECT name FROM locations LIMIT 1), 'Main Location') AS location_name,
             (SELECT COUNT(*) FROM sales_items si WHERE si.sale_id = s.id) AS item_count,
             (SELECT GROUP_CONCAT(DISTINCT COALESCE(fg.name, 'Item') SEPARATOR ', ')
              FROM sales_items si
              LEFT JOIN finished_goods fg ON fg.id = si.finished_good_id
              WHERE si.sale_id = s.id) AS item_names,
             (SELECT COALESCE(SUM(si.quantity), 0)
              FROM sales_items si
              WHERE si.sale_id = s.id) AS total_quantity,
             (SELECT rr.id FROM return_requests rr WHERE rr.reference_id = s.id ORDER BY rr.created_at DESC LIMIT 1) AS return_request_id,
             (SELECT rr.status FROM return_requests rr WHERE rr.reference_id = s.id ORDER BY rr.created_at DESC LIMIT 1) AS return_status
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN locations l ON l.id = s.location_id
      WHERE ${where}
      ORDER BY s.date DESC, s.created_at DESC
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
        r.item_names = 'Sales Item';
      }
      r.items_summary = count > 1 ? `${count} items: ${r.item_names}` : r.item_names;

      if (!r.total_quantity || Number(r.total_quantity) === 0) {
        r.total_quantity = Number(r.quantity || 0);
      }
      if (r.subtotal !== undefined && r.subtotal !== null && (Number(r.tax_amount) > 0 || Number(r.discount_amount) > 0 || Number(r.subtotal) > 0)) {
        r.total_amount = Number(r.subtotal || 0) + Number(r.tax_amount || 0) - Number(r.discount_amount || 0);
      }
      r.amount_due = Math.max(0, Number(r.total_amount || 0) - Number(r.amount_received || 0));
    }

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
    console.error('get invoices error', err);
    return res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// List Credit Notes (Returns)
router.get('/credit-notes', requireAuth, requirePermission('returns', 'view'), async (req, res) => {
  try {
    await req.tenantDb.query(`
      CREATE TABLE IF NOT EXISTS credit_notes (
        id VARCHAR(36) PRIMARY KEY,
        credit_note_number VARCHAR(50) NOT NULL,
        customer_id VARCHAR(36) NOT NULL,
        sale_id VARCHAR(36) NULL,
        reason VARCHAR(255) NULL,
        total_amount DECIMAL(12,2) NOT NULL DEFAULT '0.00',
        status VARCHAR(30) NOT NULL DEFAULT 'Issued',
        created_by VARCHAR(36) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `).catch(() => {});

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(parseInt(req.query.page_size || req.query.limit || '20', 10), 200);
    const offset = (page - 1) * pageSize;
    const search = req.query.search || '';

    let where = '1=1';
    const params = [];

    if (search) {
      where += ' AND (cn.credit_note_number LIKE ? OR c.name LIKE ? OR cn.reason LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (req.user.role === 'customer' || req.user.customer_id) {
      params.push(req.user.customer_id);
      where += ' AND cn.customer_id = ?';
    }

    const countRes = await req.tenantDb.query(
      `SELECT COUNT(*) AS count
       FROM credit_notes cn
       LEFT JOIN customers c ON c.id = cn.customer_id
       WHERE ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0]?.count || 0, 10);

    const queryParams = [...params, pageSize, offset];
    const rowsRes = await req.tenantDb.query(
      `SELECT cn.*, c.name AS customer_name, c.gstin AS customer_gstin, s.invoice_number AS sale_invoice_number
       FROM credit_notes cn
       LEFT JOIN customers c ON c.id = cn.customer_id
       LEFT JOIN sales s ON s.id = cn.sale_id
       WHERE ${where}
       ORDER BY cn.created_at DESC
       LIMIT ? OFFSET ?`,
      queryParams
    );

    if (req.query.table === '1') {
      return res.json({
        items: rowsRes.rows,
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
    return res.json(rowsRes.rows);
  } catch (err) {
    console.error('list credit notes error', err);
    return res.status(500).json({ error: 'Failed to list credit notes' });
  }
});

// Create Credit Note (Manual)
router.post('/credit-notes', requireAuth, requirePermission('sales', 'create'), async (req, res) => {
  const { customer_id, sale_id, reason, total_amount, notes, date } = req.body;

  if (!customer_id) return res.status(400).json({ error: 'Customer is required' });
  if (!total_amount || Number(total_amount) <= 0) return res.status(400).json({ error: 'Total amount must be greater than 0' });
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'Reason for credit note is required' });

  try {
    // Ensure credit_notes table exists
    await req.tenantDb.query(`
      CREATE TABLE IF NOT EXISTS credit_notes (
        id VARCHAR(36) PRIMARY KEY,
        credit_note_number VARCHAR(50) NOT NULL,
        customer_id VARCHAR(36) NOT NULL,
        sale_id VARCHAR(36) NULL,
        reason VARCHAR(255) NULL,
        total_amount DECIMAL(12,2) NOT NULL DEFAULT '0.00',
        status VARCHAR(30) NOT NULL DEFAULT 'Issued',
        created_by VARCHAR(36) NULL,
        notes TEXT NULL,
        date DATE NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `).catch(() => {});

    const creditNoteNumber = await getNextDocumentNumber(req.tenantDb, 'credit_note');
    const id = crypto.randomUUID();
    const userId = req.user?.user_id || req.user?.id || null;
    const noteDate = date || new Date().toISOString().slice(0, 10);

    await req.tenantDb.query(
      `INSERT INTO credit_notes (id, credit_note_number, customer_id, sale_id, reason, total_amount, notes, date, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Issued', ?, NOW())`,
      [id, creditNoteNumber, customer_id, sale_id || null, reason.trim(), Number(total_amount), notes || null, noteDate, userId]
    );

    const fetched = await req.tenantDb.query(
      `SELECT cn.*, c.name AS customer_name, s.invoice_number AS sale_invoice_number
       FROM credit_notes cn
       LEFT JOIN customers c ON c.id = cn.customer_id
       LEFT JOIN sales s ON s.id = cn.sale_id
       WHERE cn.id = ?`,
      [id]
    );

    return res.status(201).json(fetched.rows[0]);
  } catch (err) {
    console.error('create credit note error', err);
    return res.status(500).json({ error: 'Failed to create credit note: ' + err.message });
  }
});

// Single Sales Order / Invoice Detail
router.get('/:id', requireAuth, requirePermission('sales', 'view'), async (req, res) => {
  try {
    const saleRes = await req.tenantDb.query(
      `SELECT s.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone, c.gstin AS customer_gstin,
              COALESCE(l.name, (SELECT name FROM locations WHERE is_default = 1 LIMIT 1), (SELECT name FROM locations LIMIT 1), 'Main Location') AS location_name
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN locations l ON l.id = s.location_id
       WHERE s.id = ? AND s.deleted_at IS NULL`,
      [req.params.id]
    );

    if (saleRes.rowCount === 0) return res.status(404).json({ error: 'Sales invoice not found' });
    const sale = saleRes.rows[0];

    // Scoping check for customer role
    if ((req.user.role === 'customer' || req.user.customer_id) && sale.customer_id && req.user.customer_id && sale.customer_id !== req.user.customer_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const itemsRes = await req.tenantDb.query(
      `SELECT si.*, 
              COALESCE(fg.name, 'Finished Product') AS finished_good_name,
              COALESCE(fg.name, 'Finished Product') AS item_name,
              COALESCE(ppl.package_unit, si.package_name, fg.unit, 'pcs') AS unit,
              fg.unit AS base_unit,
              COALESCE(si.package_name, ppl.name) AS package_name,
              COALESCE(ppl.package_unit, si.package_name) AS package_unit,
              COALESCE(si.units_per_package, ppl.base_quantity_equivalent, 1) AS units_per_package
       FROM sales_items si
       LEFT JOIN finished_goods fg ON fg.id = si.finished_good_id
       LEFT JOIN product_packaging_levels ppl ON ppl.id = COALESCE(si.packaging_level_id, si.packaging_config_id)
       WHERE si.sale_id = ?`,
      [req.params.id]
    );
    sale.items = itemsRes.rows;

    let paymentsRes = await req.tenantDb.query(
      `SELECT * FROM payments_log WHERE related_id = ? AND deleted_at IS NULL ORDER BY date DESC, created_at DESC`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));

    if (paymentsRes.rows.length === 0 && Number(sale.amount_received || 0) > 0) {
      const payId = crypto.randomUUID();
      await req.tenantDb.query(
        `INSERT INTO payments_log (id, related_type, related_id, amount, date, notes, created_by)
         VALUES (?, 'sale', ?, ?, ?, ?, ?)`,
        [payId, sale.id, Number(sale.amount_received), sale.date || new Date().toISOString().slice(0, 10), 'Initial payment received during checkout / buy', req.user.id || null]
      ).catch(() => {});
      paymentsRes = await req.tenantDb.query(
        `SELECT * FROM payments_log WHERE related_id = ? AND deleted_at IS NULL ORDER BY date DESC, created_at DESC`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
    }

    sale.payments_history = paymentsRes.rows || [];

    return res.json(sale);
  } catch (err) {
    console.error('get invoice error:', err);
    return res.status(500).json({ error: 'Failed to fetch invoice details: ' + err.message });
  }
});

// GET Invoice PDF Stream
router.get('/:id/pdf', requireAuth, requirePermission('sales', 'export'), async (req, res) => {
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

    if (saleRes.rowCount === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    const sale = saleRes.rows[0];

    // Scoping check for customer role
    if ((req.user.role === 'customer' || req.user.customer_id) && sale.customer_id && req.user.customer_id && sale.customer_id !== req.user.customer_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const itemsRes = await req.tenantDb.query(
      `SELECT si.*, 
              COALESCE(fg.name, 'Finished Product') AS finished_good_name,
              COALESCE(fg.name, 'Finished Product') AS item_name,
              COALESCE(ppl.package_unit, si.package_name, fg.unit, 'pcs') AS unit,
              fg.unit AS base_unit,
              fg.hsn_code,
              COALESCE(si.package_name, ppl.name) AS package_name,
              COALESCE(ppl.package_unit, si.package_name) AS package_unit,
              COALESCE(si.units_per_package, ppl.base_quantity_equivalent, 1) AS units_per_package
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
      name: req.user.company_name || 'ERP Studio',
      gstin: 'Unregistered',
      state: 'Delhi',
      address: 'Enterprise Headquarters',
      accent_color: '#1e3a8a'
    };

    try {
      const compRes = await queryMaster(
        'SELECT id, company_name AS name, gstin, state, address, support_phone AS phone, support_email AS email, currency, number_system FROM companies WHERE id = ?',
        [req.user.company_id]
      );
      if (compRes.rowCount > 0 && compRes.rows[0]) {
        workspace = { ...workspace, ...compRes.rows[0] };
      }
    } catch (cErr) {
      console.warn('Could not query master company for invoice pdf:', cErr.message);
    }

    const customer = {
      name: sale.customer_name || 'Walk-in Customer',
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
    console.error('Invoice PDF download error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to generate invoice PDF: ' + err.message });
    }
  }
});

// Create Sales Order / Invoice
router.post('/', requireAuth, requirePermission('sales', 'create'), async (req, res) => {
  const {
    customer_id, date, due_date, place_of_supply,
    items = [], invoice_discount = 0, amount_received = 0,
    terms_and_conditions, notes, send_to_customer = false
  } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Invoice must contain at least one line item' });
  }

  try {
    const compRes = await queryMaster(
      'SELECT state, currency, company_name AS name, gstin FROM companies WHERE id = ?',
      [req.user.company_id]
    );
    const workspaceState = compRes.rows[0]?.state || 'Delhi';
    
    let roundingMethod = process.env.INVOICE_ROUNDING_METHOD || 'round_half_up';
    try {
      const pSettings = await queryMaster('SELECT invoice_rounding_method FROM platform_settings LIMIT 1');
      if (pSettings.rowCount > 0 && pSettings.rows[0]?.invoice_rounding_method) {
        roundingMethod = pSettings.rows[0].invoice_rounding_method;
      }
    } catch (sErr) {
      console.warn('Could not read platform invoice_rounding_method, falling back to default:', sErr.message);
    }

    let customerState = workspaceState;
    if (customer_id) {
      const custRes = await req.tenantDb.query(
        'SELECT id, name, gstin, state FROM customers WHERE id = ? AND deleted_at IS NULL',
        [customer_id]
      );
      if (custRes.rowCount > 0 && custRes.rows[0].state) {
        customerState = custRes.rows[0].state;
      }
    }

    const calculatedLines = [];
    for (const item of items) {
      const fgId = item.finished_good_id || item.item_id;
      const fgRes = await req.tenantDb.query('SELECT name, unit, default_price FROM finished_goods WHERE id = ?', [fgId]);
      const fg = fgRes.rows[0];
      const fgName = fg?.name || 'Finished Good';

      let pkgName = item.package_name || null;
      let unitsPerPkg = Number(item.units_per_package) || 1;
      let pkgConfigId = item.packaging_level_id || item.packaging_config_id || null;

      if (pkgConfigId) {
        // Try product_packaging_levels first
        const pplRes = await req.tenantDb.query('SELECT * FROM product_packaging_levels WHERE id = ?', [pkgConfigId]);
        if (pplRes.rows.length > 0) {
          const pkg = pplRes.rows[0];
          pkgName = pkg.name;
          unitsPerPkg = Number(pkg.base_quantity_equivalent) || 1;
        }

        // Validate available packaged stock specifically for this packaging level
        const pkgStockRes = await req.tenantDb.query(
          `SELECT COALESCE(SUM(
             CASE WHEN transaction_type = 'in' THEN COALESCE(package_count, quantity / ?)
                  WHEN transaction_type = 'out' THEN -COALESCE(package_count, quantity / ?)
                  ELSE 0 END
           ), 0) AS avail_pkg_stock
           FROM inventory_ledger
           WHERE item_type = 'finished_good' AND item_id = ? AND packaging_level_id = ?`,
          [unitsPerPkg, unitsPerPkg, fgId, pkgConfigId]
        );
        const availPkgStock = Math.max(0, Number(pkgStockRes.rows[0]?.avail_pkg_stock || 0));
        const reqQty = Number(item.quantity) || 0;
        if (reqQty > availPkgStock) {
          return res.status(400).json({
            error: `Cannot sell ${reqQty} ${pkgName || 'packages'} of "${fgName}". Only ${availPkgStock} available in packaged stock.`
          });
        }
      } else {
        // Loose finished goods stock validation
        const looseStockRes = await req.tenantDb.query(
          `SELECT COALESCE(SUM(
             CASE WHEN transaction_type = 'in' THEN quantity
                  WHEN transaction_type = 'out' THEN -quantity
                  ELSE 0 END
           ), 0) AS avail_loose_stock
           FROM inventory_ledger
           WHERE item_type = 'finished_good' AND item_id = ? AND packaging_level_id IS NULL`,
          [fgId]
        );
        const availLooseStock = Math.max(0, Number(looseStockRes.rows[0]?.avail_loose_stock || 0));
        const reqQty = Number(item.quantity) || 0;
        if (reqQty > availLooseStock) {
          return res.status(400).json({
            error: `Cannot sell ${reqQty} ${fg?.unit || 'units'} loose of "${fgName}". Only ${availLooseStock} loose units available in stock.`
          });
        }
      }

      const calculated = calculateInvoiceLine({
        quantity: item.quantity,
        ratePerUnit: item.rate_per_unit || item.rate,
        discountPercent: item.discount_percent || 0,
        taxRate: item.tax_rate,
        sellerState: workspaceState,
        placeOfSupply: place_of_supply || customerState
      });

      calculatedLines.push({
        finished_good_id: fgId,
        finished_good_name: fgName,
        packaging_level_id: pkgConfigId,
        packaging_config_id: pkgConfigId,
        package_name: pkgName,
        units_per_package: unitsPerPkg,
        ...calculated
      });
    }

    const totals = calculateInvoiceTotals(calculatedLines, {
      invoiceDiscount: invoice_discount,
      roundingMethod,
      roundingTarget: 1
    });

    const received = Math.max(0, Number(amount_received) || 0);
    const due = Math.max(0, totals.total_amount - received);
    const paymentStatus = due <= 0.01 ? 'Paid' : (received > 0 ? 'Partially Paid' : 'Unpaid');

    const invoiceNumber = await getNextDocumentNumber(req.tenantDb, 'invoice');
    const targetLocationId = req.body.location_id || null;
    const initialStatus = send_to_customer ? 'Sales Order Sent' : 'Draft';

    await req.tenantDb.query('START TRANSACTION');
    const saleId = crypto.randomUUID();

    await req.tenantDb.query(
      `INSERT INTO sales (
        id, invoice_number, customer_id, location_id, finished_good_id, quantity, rate_per_unit,
        date, due_date, place_of_supply, subtotal, cgst_amount, sgst_amount, igst_amount,
        total_tax, discount_amount, pre_rounding_total, round_off_amount,
        total_amount, amount_received, amount_due, payment_status, notes, terms_and_conditions, status, sent_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        saleId, invoiceNumber, customer_id || null, targetLocationId, calculatedLines[0].finished_good_id, calculatedLines[0].quantity, calculatedLines[0].rate_per_unit,
        date || new Date().toISOString().slice(0, 10), due_date || null, place_of_supply || customerState,
        totals.subtotal, totals.cgst_amount, totals.sgst_amount, totals.igst_amount,
        totals.total_tax, totals.discount_amount, totals.pre_rounding_total, totals.round_off_amount,
        totals.total_amount, received, due, paymentStatus, notes, terms_and_conditions, initialStatus,
        send_to_customer ? new Date() : null
      ]
    );

    for (const line of calculatedLines) {
      const salesItemId = crypto.randomUUID();
      await req.tenantDb.query(
        `INSERT INTO sales_items (
          id, sale_id, finished_good_id, packaging_level_id, packaging_config_id, package_name, units_per_package,
          quantity, rate_per_unit, discount_percent,
          taxable_value, tax_rate, cgst_rate, cgst_amount, sgst_rate, sgst_amount,
          igst_rate, igst_amount, line_total
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          salesItemId, saleId, line.finished_good_id, line.packaging_level_id || null, line.packaging_config_id || null, line.package_name || null, line.units_per_package || 1,
          line.quantity, line.rate_per_unit, line.discount_percent,
          line.taxable_value, line.tax_rate, line.cgst_rate, line.cgst_amount, line.sgst_rate, line.sgst_amount,
          line.igst_rate, line.igst_amount, line.line_total
        ]
      );

      // Direct sales invoice creation immediately deducts finished goods inventory in base units with packaging breakdown
      if (!send_to_customer) {
        const baseDeductQty = Number(line.quantity) * (Number(line.units_per_package) || 1);
        const ledgerId = crypto.randomUUID();
        await req.tenantDb.query(
          `INSERT INTO inventory_ledger (
            id, item_type, item_id, location_id, packaging_level_id, package_count, transaction_type, quantity, unit_cost, reason, reference_table, reference_id, created_by
          ) VALUES (?, 'finished_good', ?, ?, ?, ?, 'out', ?, ?, ?, 'sales', ?, ?)`,
          [ledgerId, line.finished_good_id, targetLocationId, line.packaging_level_id || null, Number(line.quantity), baseDeductQty, line.rate_per_unit, `Sales Invoice ${invoiceNumber}`, saleId, req.user.id]
        );
      }
    }

    if (received > 0) {
      const payId = crypto.randomUUID();
      await req.tenantDb.query(
        `INSERT INTO payments_log (id, related_type, related_id, amount, date, notes, created_by)
         VALUES (?, 'sale', ?, ?, ?, ?, ?)`,
        [payId, saleId, received, date || new Date().toISOString().slice(0, 10), 'Initial payment received during checkout / buy', req.user.id]
      );
    }

    if (send_to_customer && customer_id) {
      await createNotification(req.tenantDb, {
        user_type: 'customer_portal',
        customer_id,
        title: 'New Sales Order Awaiting Confirmation',
        message: `Sales Order ${invoiceNumber} for ₹${totals.total_amount.toLocaleString('en-IN')} is ready for your confirmation.`,
        link: `/customer-portal/orders/${saleId}`
      });
    }

    await req.tenantDb.query('COMMIT');
    const fetchedSale = await req.tenantDb.query('SELECT * FROM sales WHERE id = ?', [saleId]);
    return res.status(201).json({ ...fetchedSale.rows[0], items: calculatedLines });
  } catch (err) {
    await req.tenantDb.query('ROLLBACK').catch(() => {});
    console.error('create invoice error', err);
    return res.status(500).json({ error: 'Failed to create invoice: ' + err.message });
  }
});

// ACTION: Send Sales Order to Customer (Draft -> Sales Order Sent)
router.post('/:id/send-to-customer', requireAuth, requirePermission('sales', 'approve'), async (req, res) => {
  try {
    const saleRes = await req.tenantDb.query('SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (saleRes.rowCount === 0) return res.status(404).json({ error: 'Sales order not found' });
    const sale = saleRes.rows[0];

    await req.tenantDb.query(
      "UPDATE sales SET status = 'Sales Order Sent', sent_at = NOW(), updated_at = NOW() WHERE id = ?",
      [req.params.id]
    );

    if (sale.customer_id) {
      await createNotification(req.tenantDb, {
        user_type: 'customer_portal',
        customer_id: sale.customer_id,
        title: 'New Sales Order Awaiting Confirmation',
        message: `Sales Order ${sale.invoice_number} is ready for your review.`,
        link: `/customer-portal/orders/${sale.id}`
      });
    }

    return res.json({ ok: true, message: 'Sales order sent to customer' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to send sales order' });
  }
});

// ACTION: Confirm Sales Order (Customer / Staff -> Confirmed, triggers inventory OUT & invoice creation)
router.post('/:id/confirm', requireAuth, async (req, res) => {
  try {
    const saleRes = await req.tenantDb.query('SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (saleRes.rowCount === 0) return res.status(404).json({ error: 'Sales order not found' });
    const sale = saleRes.rows[0];

    // Row-level check if customer role
    if (req.user.role === 'customer' && sale.customer_id !== req.user.customer_id) {
      return res.status(403).json({ error: 'Access denied: order belongs to another customer' });
    }

    await req.tenantDb.query('START TRANSACTION');

    await req.tenantDb.query(
      "UPDATE sales SET status = 'Confirmed', customer_notes = 'Order confirmed by customer', updated_at = NOW() WHERE id = ?",
      [req.params.id]
    );

    // Deduct Finished Goods Inventory ('out')
    const itemsRes = await req.tenantDb.query('SELECT * FROM sales_items WHERE sale_id = ?', [req.params.id]);
    for (const line of itemsRes.rows) {
      const baseDeductQty = Number(line.quantity) * (Number(line.units_per_package) || 1);
      const ledgerId = crypto.randomUUID();
      await req.tenantDb.query(
        `INSERT INTO inventory_ledger (
          id, item_type, item_id, location_id, packaging_level_id, package_count, transaction_type, quantity, unit_cost, reason, reference_table, reference_id, created_by
        ) VALUES (?, 'finished_good', ?, ?, ?, ?, 'out', ?, ?, ?, 'sales', ?, ?)`,
        [ledgerId, line.finished_good_id, sale.location_id, line.packaging_level_id || null, Number(line.quantity), baseDeductQty, line.rate_per_unit, `Sales Order Confirmed ${sale.invoice_number}`, sale.id, req.user.id]
      );
    }

    await req.tenantDb.query('COMMIT');
    return res.json({ ok: true, message: 'Sales order confirmed and finished goods inventory updated!' });
  } catch (err) {
    await req.tenantDb.query('ROLLBACK').catch(() => {});
    console.error('confirm order error', err);
    return res.status(500).json({ error: 'Failed to confirm sales order' });
  }
});

// ACTION: Decline Sales Order (Customer / Staff -> Declined with reason)
router.post('/:id/decline', requireAuth, async (req, res) => {
  const { reason } = req.body;
  if (!reason || String(reason).trim().length < 3) {
    return res.status(400).json({ error: 'Please provide a valid decline reason' });
  }

  try {
    const saleRes = await req.tenantDb.query('SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (saleRes.rowCount === 0) return res.status(404).json({ error: 'Sales order not found' });
    const sale = saleRes.rows[0];

    if (req.user.role === 'customer' && sale.customer_id !== req.user.customer_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await req.tenantDb.query(
      "UPDATE sales SET status = 'Declined', decline_reason = ?, updated_at = NOW() WHERE id = ?",
      [reason.trim(), req.params.id]
    );

    return res.json({ ok: true, message: 'Sales order declined' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to decline sales order' });
  }
});

// ACTION: Dispatch Sales Order (Confirmed/Ordered -> Dispatched)
router.post('/:id/dispatch', requireAuth, requirePermission('sales', 'approve'), async (req, res) => {
  const { tracking_ref, notes, transporter_name, vehicle_number, dispatch_date } = req.body;
  const effectiveTracking = transporter_name && tracking_ref && !tracking_ref.includes(transporter_name)
    ? `${transporter_name}: ${tracking_ref}`.trim()
    : (tracking_ref || transporter_name || 'Handed to Carrier').trim();
  const formattedCarrierNotes = transporter_name
    ? `Carrier: ${transporter_name}${vehicle_number ? ` | Vehicle: ${vehicle_number}` : ''}${notes ? `. ${notes}` : ''}`
    : (notes || null);

  try {
    const saleRes = await req.tenantDb.query('SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (saleRes.rowCount === 0) return res.status(404).json({ error: 'Sales order not found' });
    const sale = saleRes.rows[0];

    const dDate = dispatch_date ? new Date(dispatch_date) : new Date();

    await req.tenantDb.query(
      `UPDATE sales 
       SET status = 'Dispatched', 
           dispatch_tracking_ref = ?, 
           dispatch_date = ?, 
           notes = COALESCE(?, notes), 
           updated_at = NOW() 
       WHERE id = ?`,
      [effectiveTracking, dDate, formattedCarrierNotes, req.params.id]
    );

    // Deduct finished goods inventory ('out') if not already deducted upon order creation
    const ledgerCheck = await req.tenantDb.query(
      "SELECT id FROM inventory_ledger WHERE reference_table = 'sales' AND reference_id = ? AND transaction_type = 'out'",
      [sale.id]
    );

    if (ledgerCheck.rowCount === 0) {
      const itemsRes = await req.tenantDb.query('SELECT * FROM sales_items WHERE sale_id = ?', [sale.id]);
      const defaultLocRes = await req.tenantDb.query('SELECT id FROM locations WHERE is_default = 1 LIMIT 1');
      const targetLocId = sale.location_id || defaultLocRes.rows[0]?.id || null;

      for (const line of itemsRes.rows) {
        const baseDeductQty = Number(line.quantity) * (Number(line.units_per_package) || 1);
        const ledgerId = crypto.randomUUID();
        await req.tenantDb.query(
          `INSERT INTO inventory_ledger (
            id, item_type, item_id, location_id, packaging_level_id, package_count, transaction_type, quantity, unit_cost, reason, reference_table, reference_id, created_by
          ) VALUES (?, 'finished_good', ?, ?, ?, ?, 'out', ?, ?, ?, 'sales', ?, ?)`,
          [
            ledgerId,
            line.finished_good_id,
            targetLocId,
            line.packaging_level_id || null,
            Number(line.quantity),
            baseDeductQty,
            line.rate_per_unit,
            `Sales Order Dispatched ${sale.invoice_number}`,
            sale.id,
            req.user.id
          ]
        );
      }
    }

    if (sale.customer_id) {
      await createNotification(req.tenantDb, {
        user_type: 'customer_portal',
        customer_id: sale.customer_id,
        title: 'Order Dispatched',
        message: `Your order ${sale.invoice_number} has been dispatched. Carrier: ${transporter_name || 'Express Logistics'} | Tracking: ${effectiveTracking}`,
        link: `/customer-portal/orders/${sale.id}`
      });
    }

    return res.json({
      ok: true,
      message: 'Order marked as dispatched and logistics tracking updated!',
      dispatch_tracking_ref: effectiveTracking
    });
  } catch (err) {
    console.error('dispatch order error', err);
    return res.status(500).json({ error: 'Failed to dispatch order: ' + err.message });
  }
});

// ACTION: Receive Goods / Confirm Delivery (Dispatched -> Goods Received)
router.post(['/:id/receive', '/:id/confirm-delivery'], requireAuth, async (req, res) => {
  try {
    const saleRes = await req.tenantDb.query('SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (saleRes.rowCount === 0) return res.status(404).json({ error: 'Sales order not found' });
    const sale = saleRes.rows[0];

    if ((req.user.role === 'customer' || req.user.customer_id) && sale.customer_id && req.user.customer_id && sale.customer_id !== req.user.customer_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await req.tenantDb.query(
      "UPDATE sales SET status = 'Goods Received', delivered_date = NOW(), updated_at = NOW() WHERE id = ?",
      [req.params.id]
    );

    await createNotification(req.tenantDb, {
      user_type: 'user',
      title: 'Goods Received by Customer',
      message: `Goods for order ${sale.invoice_number} have been received and verified by customer.`,
      link: '/sales'
    }).catch(() => {});

    return res.json({ ok: true, message: 'Delivery and goods receipt confirmed successfully!' });
  } catch (err) {
    console.error('confirm delivery error', err);
    return res.status(500).json({ error: 'Failed to confirm delivery' });
  }
});

// ACTION: Mark Order Delivered (Dispatched -> Delivered)
router.post('/:id/deliver', requireAuth, requirePermission('sales', 'approve'), async (req, res) => {
  try {
    const saleRes = await req.tenantDb.query('SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (saleRes.rowCount === 0) return res.status(404).json({ error: 'Sales order not found' });
    const sale = saleRes.rows[0];

    await req.tenantDb.query(
      "UPDATE sales SET status = 'Delivered', delivered_date = NOW(), updated_at = NOW() WHERE id = ?",
      [req.params.id]
    );

    if (sale.customer_id) {
      await createNotification(req.tenantDb, {
        user_type: 'customer_portal',
        customer_id: sale.customer_id,
        title: 'Order Delivered',
        message: `Your order ${sale.invoice_number} has been marked as delivered.`,
        link: `/customer-portal/orders/${sale.id}`
      });
    }

    return res.json({ ok: true, message: 'Order marked as delivered' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to mark order as delivered' });
  }
});



// GET Invoice Payments History
router.get('/:id/payments', requireAuth, async (req, res) => {
  try {
    const saleRes = await req.tenantDb.query('SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (saleRes.rowCount === 0) return res.status(404).json({ error: 'Invoice not found' });
    const sale = saleRes.rows[0];

    let payments = (await req.tenantDb.query(
      'SELECT * FROM payments_log WHERE related_id = ? AND deleted_at IS NULL ORDER BY date DESC, created_at DESC',
      [req.params.id]
    )).rows;

    if (payments.length === 0 && Number(sale.amount_received || 0) > 0) {
      const payId = crypto.randomUUID();
      await req.tenantDb.query(
        `INSERT INTO payments_log (id, related_type, related_id, amount, date, notes, created_by)
         VALUES (?, 'sale', ?, ?, ?, ?, ?)`,
        [payId, sale.id, Number(sale.amount_received), sale.date || new Date().toISOString().slice(0, 10), 'Initial payment received during checkout / buy', req.user.id || null]
      ).catch(() => {});
      payments = (await req.tenantDb.query(
        'SELECT * FROM payments_log WHERE related_id = ? AND deleted_at IS NULL ORDER BY date DESC, created_at DESC',
        [req.params.id]
      )).rows;
    }

    return res.json({ sale, payments });
  } catch (err) {
    console.error('get invoice payments error', err);
    return res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// POST Record Payment Installment for Invoice
router.post('/:id/payments', requireAuth, async (req, res) => {
  const { amount, date, notes } = req.body;
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Please enter a valid positive payment amount' });

  try {
    await req.tenantDb.query('START TRANSACTION');
    const saleRes = await req.tenantDb.query('SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [req.params.id]);
    if (saleRes.rowCount === 0) {
      await req.tenantDb.query('ROLLBACK');
      return res.status(404).json({ error: 'Invoice not found' });
    }
    const sale = saleRes.rows[0];
    const currentReceived = Number(sale.amount_received || 0);
    const totalAmt = Number(sale.total_amount || 0);
    const newReceived = currentReceived + amt;
    const newDue = Math.max(0, totalAmt - newReceived);
    const newPaymentStatus = newDue <= 0.01 ? 'Paid' : 'Partially Paid';

    await req.tenantDb.query(
      'UPDATE sales SET amount_received = ?, amount_due = ?, payment_status = ?, updated_at = NOW() WHERE id = ?',
      [newReceived, newDue, newPaymentStatus, req.params.id]
    );

    const payId = crypto.randomUUID();
    await req.tenantDb.query(
      `INSERT INTO payments_log (id, related_type, related_id, amount, date, notes, created_by)
       VALUES (?, 'sale', ?, ?, ?, ?, ?)`,
      [payId, req.params.id, amt, date || new Date().toISOString().slice(0, 10), notes || 'Payment installment', req.user.id]
    );

    await req.tenantDb.query('COMMIT');

    const updatedSaleRes = await req.tenantDb.query('SELECT * FROM sales WHERE id = ?', [req.params.id]);
    const paymentsRes = await req.tenantDb.query(
      'SELECT * FROM payments_log WHERE related_id = ? AND deleted_at IS NULL ORDER BY date DESC, created_at DESC',
      [req.params.id]
    );

    return res.json({
      ok: true,
      message: 'Payment recorded successfully',
      sale: updatedSaleRes.rows[0],
      payments: paymentsRes.rows
    });
  } catch (err) {
    await req.tenantDb.query('ROLLBACK').catch(() => {});
    console.error('record invoice payment error', err);
    return res.status(500).json({ error: 'Failed to record payment: ' + err.message });
  }
});

module.exports = router;
