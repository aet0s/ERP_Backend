const express = require('express');
const router = express.Router();
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');

function requireReportPermission() {
  return async (req, res, next) => {
    const isExport = req.query.format === 'csv' || req.query.format === 'pdf' || req.path.endsWith('.pdf') || req.path.endsWith('.csv');
    const action = isExport ? 'export' : 'view';
    return requirePermission('reports', action)(req, res, next);
  };
}
const { queryMaster } = require('../db/masterDb');
const {
  numeric,
  dateRangeFromQuery,
  toCSV,
  getBatchCostContext,
  getInventorySnapshot,
  streamSimplePdf
} = require('../lib/analytics');

async function workspace(companyId) {
  const result = await queryMaster('SELECT id, company_name AS name, currency, accent_color, logo_url FROM companies WHERE id=?', [companyId]);
  return result.rows[0] || null;
}

async function sendReport(req, res, rows, summary, headers, filename, title, subtitle) {
  const isPdf = req.query.format === 'pdf' || req.path.endsWith('.pdf');
  const isCsv = req.query.format === 'csv' || req.path.endsWith('.csv');

  const formattedRows = (rows || []).map((r) => {
    const copy = { ...r };
    for (const [k, v] of Object.entries(copy)) {
      if (v instanceof Date) {
        copy[k] = v.toISOString().slice(0, 10);
      } else if (typeof v === 'string' && v.includes('00:00:00')) {
        copy[k] = v.slice(0, 10);
      }
    }
    return copy;
  });

  if (isCsv) {
    const csv = toCSV(formattedRows, headers);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(csv);
  }

  if (isPdf) {
    const companyId = req.user?.company_id || req.user?.workspace_id;
    const ws = companyId ? await workspace(companyId) : null;

    const summaryCards = [];
    if (summary) {
      for (const [k, v] of Object.entries(summary)) {
        if (typeof v === 'number' || typeof v === 'string') {
          const label = k.replace(/_/g, ' ');
          let valStr = String(v);
          if (typeof v === 'number') {
            valStr = v.toLocaleString(undefined, { maximumFractionDigits: 2 });
          }
          summaryCards.push({ label, value: valStr });
        }
      }
    }

    return streamSimplePdf(res, {
      filename: `${filename}.pdf`,
      title: title || 'Operational Report',
      subtitle: subtitle || 'ERP Studio Enterprise',
      workspace: ws,
      rows: formattedRows,
      columns: headers,
      summaryCards
    });
  }

  return res.json({ rows: formattedRows, summary: summary || {} });
}

async function procurementRows(req) {
  const { start, end } = dateRangeFromQuery(req.query);
  const params = [start, end];
  const where = ['p.deleted_at IS NULL', 'p.date BETWEEN ? AND ?'];
  if (req.query.vendor_id) {
    params.push(req.query.vendor_id);
    where.push('p.vendor_id = ?');
  }
  if (req.query.raw_material_id) {
    params.push(req.query.raw_material_id);
    where.push('p.raw_material_id = ?');
  }
  const rows = await req.tenantDb.query(
    `SELECT p.date, v.name AS vendor, rm.name AS material, p.quantity, p.rate_per_unit,
       p.total_amount, p.amount_paid, p.amount_due, p.notes
     FROM procurements p
     LEFT JOIN vendors v ON v.id=p.vendor_id
     LEFT JOIN raw_materials rm ON rm.id=p.raw_material_id
     WHERE ${where.join(' AND ')}
     ORDER BY p.date DESC`,
    params
  );
  return {
    rows: rows.rows,
    summary: rows.rows.reduce((acc, row) => ({
      total_quantity: acc.total_quantity + numeric(row.quantity),
      total_spend: acc.total_spend + numeric(row.total_amount),
      total_paid: acc.total_paid + numeric(row.amount_paid),
      total_outstanding: acc.total_outstanding + numeric(row.amount_due)
    }), { total_quantity: 0, total_spend: 0, total_paid: 0, total_outstanding: 0 }),
    start,
    end
  };
}

async function salesRows(req) {
  const { start, end } = dateRangeFromQuery(req.query);
  const params = [start, end];
  const where = ['s.deleted_at IS NULL', 's.date BETWEEN ? AND ?'];
  if (req.query.customer_id) {
    params.push(req.query.customer_id);
    where.push('s.customer_id = ?');
  }
  if (req.query.finished_good_id) {
    params.push(req.query.finished_good_id);
    where.push('s.finished_good_id = ?');
  }
  const rows = await req.tenantDb.query(
    `SELECT s.date, c.name AS customer, fg.name AS product, s.quantity, s.rate_per_unit,
       s.total_amount, s.amount_received, s.amount_due, s.notes
     FROM sales s
     LEFT JOIN customers c ON c.id=s.customer_id
     LEFT JOIN finished_goods fg ON fg.id=s.finished_good_id
     WHERE ${where.join(' AND ')}
     ORDER BY s.date DESC`,
    params
  );
  return {
    rows: rows.rows,
    summary: rows.rows.reduce((acc, row) => ({
      total_quantity: acc.total_quantity + numeric(row.quantity),
      total_revenue: acc.total_revenue + numeric(row.total_amount),
      amount_received: acc.amount_received + numeric(row.amount_received),
      amount_due: acc.amount_due + numeric(row.amount_due)
    }), { total_quantity: 0, total_revenue: 0, amount_received: 0, amount_due: 0 }),
    start,
    end
  };
}

async function productionRows(req) {
  const { start, end } = dateRangeFromQuery(req.query);
  const whereRuns = ['pr.deleted_at IS NULL', 'DATE(pr.created_at) BETWEEN ? AND ?'];
  const paramsRuns = [start, end];

  if (req.query.finished_good_id) {
    whereRuns.push(`EXISTS (SELECT 1 FROM production_run_outputs pro WHERE pro.production_run_id = pr.id AND pro.product_id = ?)`);
    paramsRuns.push(req.query.finished_good_id);
  }

  const runsQuery = `
    SELECT 
      DATE(pr.created_at) AS date,
      pr.run_number AS batch_number,
      COALESCE(pf.name, 'Production Run') AS stage,
      COALESCE(
        (SELECT GROUP_CONCAT(DISTINCT COALESCE(fg.name, itm.name) SEPARATOR ', ')
         FROM production_run_outputs pro
         LEFT JOIN finished_goods fg ON fg.id = pro.product_id
         LEFT JOIN items itm ON itm.id = pro.product_id
         WHERE pro.production_run_id = pr.id),
        'Finished Goods'
      ) AS finished_good,
      COALESCE((SELECT SUM(pri.quantity_used) FROM production_run_inputs pri WHERE pri.production_run_id = pr.id), 0) AS input_quantity,
      COALESCE((SELECT SUM(pro.quantity_produced) FROM production_run_outputs pro WHERE pro.production_run_id = pr.id), 0) AS output_quantity,
      0 AS wastage_quantity,
      pr.yield_percent,
      pr.labor_cost,
      pr.overhead_cost AS other_cost
    FROM production_runs pr
    LEFT JOIN production_formulas pf ON pf.id = pr.formula_id
    WHERE ${whereRuns.join(' AND ')}
    ORDER BY pr.created_at DESC
  `;

  let runs = [];
  try {
    const resRuns = await req.tenantDb.query(runsQuery, paramsRuns);
    runs = resRuns.rows || [];
  } catch (err) {
    console.warn('Could not query production_runs for report:', err.message);
  }

  // Also query legacy production_batches if table exists
  let batchRows = [];
  try {
    const paramsBatches = [start, end];
    const whereBatches = ['pb.deleted_at IS NULL', 'pb.date BETWEEN ? AND ?'];
    if (req.query.process_stage_id) {
      paramsBatches.push(req.query.process_stage_id);
      whereBatches.push('pb.process_stage_id = ?');
    }
    if (req.query.finished_good_id) {
      paramsBatches.push(req.query.finished_good_id);
      whereBatches.push('pb.finished_good_id = ?');
    }
    const resBatches = await req.tenantDb.query(
      `SELECT pb.date, pb.batch_number, ps.name AS stage, fg.name AS finished_good,
         pb.input_quantity, pb.output_quantity, pb.wastage_quantity, pb.yield_percent,
         pb.labor_cost, pb.other_cost
       FROM production_batches pb
       JOIN process_stages ps ON ps.id=pb.process_stage_id
       LEFT JOIN finished_goods fg ON fg.id=pb.finished_good_id
       WHERE ${whereBatches.join(' AND ')}
       ORDER BY pb.date DESC`,
      paramsBatches
    );
    batchRows = resBatches.rows || [];
  } catch {
    // production_batches may not have records or table might be legacy
  }

  const allRows = [...runs, ...batchRows];
  const totalInput = allRows.reduce((sum, r) => sum + numeric(r.input_quantity), 0);
  const totalOutput = allRows.reduce((sum, r) => sum + numeric(r.output_quantity), 0);
  return {
    rows: allRows,
    summary: {
      total_input: totalInput,
      total_output: totalOutput,
      total_wastage: allRows.reduce((sum, r) => sum + numeric(r.wastage_quantity), 0),
      average_yield: totalInput > 0 ? `${((totalOutput / totalInput) * 100).toFixed(1)}%` : '0%'
    },
    start,
    end
  };
}

async function handleProcurementReport(req, res) {
  const data = await procurementRows(req);
  return sendReport(
    req,
    res,
    data.rows,
    data.summary,
    [
      { key: 'date', label: 'Date' },
      { key: 'vendor', label: 'Vendor' },
      { key: 'material', label: 'Material' },
      { key: 'quantity', label: 'Quantity' },
      { key: 'rate_per_unit', label: 'Rate' },
      { key: 'total_amount', label: 'Total Amount' },
      { key: 'amount_paid', label: 'Paid' },
      { key: 'amount_due', label: 'Due' }
    ],
    `procurement_report_${data.start}_to_${data.end}`,
    'Procurement Report',
    `Period: ${data.start} to ${data.end}`
  );
}

router.get(['/procurement', '/procurements', '/procurement.pdf', '/procurements.pdf'], requireAuth, requireReportPermission(), handleProcurementReport);

async function handleSalesReport(req, res) {
  const data = await salesRows(req);
  return sendReport(
    req,
    res,
    data.rows,
    data.summary,
    [
      { key: 'date', label: 'Date' },
      { key: 'customer', label: 'Customer' },
      { key: 'product', label: 'Product' },
      { key: 'quantity', label: 'Quantity' },
      { key: 'rate_per_unit', label: 'Rate' },
      { key: 'total_amount', label: 'Total Amount' },
      { key: 'amount_received', label: 'Received' },
      { key: 'amount_due', label: 'Due' }
    ],
    `sales_report_${data.start}_to_${data.end}`,
    'Sales Report',
    `Period: ${data.start} to ${data.end}`
  );
}

router.get(['/sales', '/sales.pdf'], requireAuth, requireReportPermission(), handleSalesReport);

async function handleProductionReport(req, res) {
  const data = await productionRows(req);
  return sendReport(
    req,
    res,
    data.rows,
    data.summary,
    [
      { key: 'date', label: 'Date' },
      { key: 'batch_number', label: 'Batch' },
      { key: 'stage', label: 'Stage' },
      { key: 'finished_good', label: 'Product' },
      { key: 'input_quantity', label: 'Input Qty' },
      { key: 'output_quantity', label: 'Output Qty' },
      { key: 'wastage_quantity', label: 'Wastage' },
      { key: 'yield_percent', label: 'Yield %' }
    ],
    `production_report_${data.start}_to_${data.end}`,
    'Production Efficiency Report',
    `Period: ${data.start} to ${data.end}`
  );
}

router.get(['/production', '/production.pdf'], requireAuth, requireReportPermission(), handleProductionReport);

async function handleInventoryReport(req, res) {
  const rows = await getInventorySnapshot(req.tenantDb);
  const summary = {
    total_items: rows.length,
    total_stock: rows.reduce((sum, r) => sum + numeric(r.current_stock), 0),
    total_value: rows.reduce((sum, r) => sum + numeric(r.value_at_cost), 0),
    low_stock_items: rows.filter((r) => r.status === 'Low' || r.status === 'Out').length
  };
  return sendReport(
    req,
    res,
    rows,
    summary,
    [
      { key: 'item_type', label: 'Item Type' },
      { key: 'name', label: 'Item Name' },
      { key: 'current_stock', label: 'Stock' },
      { key: 'unit', label: 'Unit' },
      { key: 'reorder_level', label: 'Reorder Level' },
      { key: 'unit_cost', label: 'Unit Cost' },
      { key: 'value_at_cost', label: 'Total Value' },
      { key: 'status', label: 'Status' }
    ],
    'inventory_valuation_report',
    'Inventory Valuation Report',
    'Current Stock & Asset Cost Valuation'
  );
}

router.get(['/inventory', '/inventory.pdf'], requireAuth, requireReportPermission(), handleInventoryReport);

async function handleProfitLossReport(req, res) {
  const { start, end } = dateRangeFromQuery(req.query);
  const context = await getBatchCostContext(req.tenantDb);

  const [sales, procurements, expenses, batches] = await Promise.all([
    req.tenantDb.query(`SELECT COALESCE(SUM(total_amount),0) AS revenue FROM sales WHERE deleted_at IS NULL AND date BETWEEN ? AND ?`, [start, end]),
    req.tenantDb.query(`SELECT COALESCE(SUM(total_amount),0) AS procurement_cost FROM procurements WHERE deleted_at IS NULL AND date BETWEEN ? AND ?`, [start, end]),
    req.tenantDb.query(`SELECT COALESCE(SUM(amount),0) AS expenses FROM expenses WHERE deleted_at IS NULL AND date BETWEEN ? AND ?`, [start, end]),
    req.tenantDb.query(`SELECT id, output_quantity, date FROM production_batches WHERE deleted_at IS NULL AND date BETWEEN ? AND ?`, [start, end])
  ]);

  const revenue = numeric(sales.rows[0].revenue);
  const procurementCost = numeric(procurements.rows[0].procurement_cost);
  const operatingExpenses = numeric(expenses.rows[0].expenses);

  let cogs = 0;
  for (const batch of batches.rows) {
    cogs += numeric(batch.output_quantity) * numeric(context.batchUnitCosts[batch.id]);
  }
  const grossProfit = revenue - cogs;
  const netProfit = revenue - (cogs + operatingExpenses);

  const summary = {
    revenue,
    cogs,
    gross_profit: grossProfit,
    operating_expenses: operatingExpenses,
    net_profit: netProfit
  };

  const rows = [
    { line_item: 'Revenue (Sales)', amount: revenue },
    { line_item: 'Cost of Goods Sold (COGS)', amount: cogs },
    { line_item: 'Gross Profit', amount: grossProfit },
    { line_item: 'Operating Expenses', amount: operatingExpenses },
    { line_item: 'Net Profit', amount: netProfit }
  ];

  return sendReport(
    req,
    res,
    rows,
    summary,
    [{ key: 'line_item', label: 'Financial Metric' }, { key: 'amount', label: 'Amount' }],
    `profit_loss_${start}_to_${end}`,
    'Profit & Loss Statement',
    `Period: ${start} to ${end}`
  );
}

router.get(['/profit-loss', '/profit-loss.pdf'], requireAuth, requireReportPermission(), handleProfitLossReport);

async function handleOutstandingReport(req, res) {
  const vendors = await req.tenantDb.query(
    `SELECT 'Vendor' AS party_type, v.name AS party_name, COALESCE(SUM(p.total_amount),0) AS total_value, COALESCE(SUM(p.amount_due),0) AS outstanding_balance
     FROM vendors v
     LEFT JOIN procurements p ON p.vendor_id = v.id AND p.deleted_at IS NULL
     WHERE v.deleted_at IS NULL
     GROUP BY v.id, v.name`
  );
  const customers = await req.tenantDb.query(
    `SELECT 'Customer' AS party_type, c.name AS party_name, COALESCE(SUM(s.total_amount),0) AS total_value, COALESCE(SUM(s.amount_due),0) AS outstanding_balance
     FROM customers c
     LEFT JOIN sales s ON s.customer_id = c.id AND s.deleted_at IS NULL
     WHERE c.deleted_at IS NULL
     GROUP BY c.id, c.name`
  );
  const rows = [...vendors.rows, ...customers.rows].filter(r => numeric(r.outstanding_balance) > 0);
  const summary = {
    total_parties: rows.length,
    total_outstanding: rows.reduce((sum, r) => sum + numeric(r.outstanding_balance), 0)
  };
  return sendReport(
    req,
    res,
    rows,
    summary,
    [{ key: 'party_type', label: 'Party Type' }, { key: 'party_name', label: 'Name' }, { key: 'total_value', label: 'Total Business' }, { key: 'outstanding_balance', label: 'Outstanding Balance' }],
    'outstanding_balances',
    'Outstanding Balances Report',
    'Parties with Pending Dues'
  );
}

async function handleGstSummaryReport(req, res) {
  try {
    const { start, end } = dateRangeFromQuery(req.query);

    const [salesRes, procRes] = await Promise.all([
      req.tenantDb.query(
        `SELECT s.id, s.invoice_number, s.date, s.total_amount,
                COALESCE(s.total_tax, s.cgst_amount + s.sgst_amount + s.igst_amount, 0) AS tax_amount,
                s.discount_amount,
                COALESCE(s.cgst_amount, 0) AS cgst_amount,
                COALESCE(s.sgst_amount, 0) AS sgst_amount,
                COALESCE(s.igst_amount, 0) AS igst_amount,
                c.name AS customer_name, c.gstin AS customer_gstin, c.state AS customer_state
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id
         WHERE s.deleted_at IS NULL AND s.date BETWEEN ? AND ?
         ORDER BY s.date DESC`,
        [start, end]
      ),
      req.tenantDb.query(
        `SELECT p.id, p.date, p.total_amount, v.name AS vendor_name, v.gstin AS vendor_gstin
         FROM procurements p
         LEFT JOIN vendors v ON v.id = p.vendor_id
         WHERE p.deleted_at IS NULL AND p.date BETWEEN ? AND ?
         ORDER BY p.date DESC`,
        [start, end]
      )
    ]);

    const salesRows = salesRes.rows || [];
    const procRows = procRes.rows || [];

    const totalSalesRevenue = salesRows.reduce((sum, r) => sum + numeric(r.total_amount), 0);
    const totalSalesTax = salesRows.reduce((sum, r) => sum + numeric(r.tax_amount), 0);
    const totalSalesTaxable = Math.max(0, totalSalesRevenue - totalSalesTax);

    const totalProcSpend = procRows.reduce((sum, r) => sum + numeric(r.total_amount), 0);
    const totalItcEstimate = totalProcSpend * 0.18 / 1.18;
    const netGstPayable = Math.max(0, totalSalesTax - totalItcEstimate);

    const summary = {
      total_sales_revenue: totalSalesRevenue,
      total_sales_taxable: totalSalesTaxable,
      outward_tax_liability: totalSalesTax,
      b2b_sales_count: salesRows.filter(r => r.customer_gstin).length,
      b2c_sales_count: salesRows.filter(r => !r.customer_gstin).length,
      total_inward_purchases: totalProcSpend,
      input_tax_credit_itc: totalItcEstimate,
      net_gst_payable: netGstPayable
    };

    const rows = salesRows.map(s => ({
      date: s.date,
      invoice_number: s.invoice_number,
      party_name: s.customer_name || 'Walk-in Customer',
      gstin: s.customer_gstin || 'B2C (Unregistered)',
      taxable_amount: Math.round(numeric(s.total_amount) - numeric(s.tax_amount)),
      cgst_amount: Math.round(numeric(s.cgst_amount)),
      sgst_amount: Math.round(numeric(s.sgst_amount)),
      igst_amount: Math.round(numeric(s.igst_amount)),
      tax_amount: Math.round(numeric(s.tax_amount)),
      total_amount: numeric(s.total_amount)
    }));

    return sendReport(
      req,
      res,
      rows,
      summary,
      [
        { key: 'date', label: 'Date' },
        { key: 'invoice_number', label: 'Invoice #' },
        { key: 'party_name', label: 'Customer' },
        { key: 'gstin', label: 'GSTIN' },
        { key: 'taxable_amount', label: 'Taxable Amount' },
        { key: 'cgst_amount', label: 'CGST' },
        { key: 'sgst_amount', label: 'SGST' },
        { key: 'igst_amount', label: 'IGST' },
        { key: 'tax_amount', label: 'Total GST' },
        { key: 'total_amount', label: 'Total Amount' }
      ],
      `gst_summary_${start}_to_${end}`,
      'GST Filing Summary Report (GSTR-1 / GSTR-3B)',
      `Period: ${start} to ${end}`
    );
  } catch (err) {
    console.error('GST summary report error:', err);
    return res.status(500).json({ error: 'Failed to generate GST summary: ' + err.message });
  }
}

async function handleExpenseReport(req, res) {
  const { start, end } = dateRangeFromQuery(req.query);
  const rowsRes = await req.tenantDb.query(
    `SELECT date, category, amount, notes FROM expenses WHERE deleted_at IS NULL AND date BETWEEN ? AND ? ORDER BY date DESC`,
    [start, end]
  );
  const rows = rowsRes.rows || [];
  const categoryTotals = {};
  let totalExpense = 0;
  for (const r of rows) {
    const amt = numeric(r.amount);
    totalExpense += amt;
    categoryTotals[r.category] = (categoryTotals[r.category] || 0) + amt;
  }
  const summary = {
    total_expense: totalExpense,
    total_entries: rows.length,
    top_category: Object.keys(categoryTotals).sort((a, b) => categoryTotals[b] - categoryTotals[a])[0] || 'None'
  };
  return sendReport(
    req,
    res,
    rows,
    summary,
    [
      { key: 'date', label: 'Date' },
      { key: 'category', label: 'Category' },
      { key: 'amount', label: 'Amount' },
      { key: 'notes', label: 'Notes' }
    ],
    `expense_report_${start}_to_${end}`,
    'Operating Expense Breakdown Report',
    `Period: ${start} to ${end}`
  );
}

async function handleStockMovementReport(req, res) {
  const { start, end } = dateRangeFromQuery(req.query);
  const rowsRes = await req.tenantDb.query(
    `SELECT il.date, il.transaction_type, il.item_type,
            COALESCE(rm.name, fg.name, il.item_id) AS item_name,
            il.quantity, il.unit_cost, (il.quantity * COALESCE(il.unit_cost, 0)) AS total_value,
            COALESCE(l.name, 'Main Warehouse') AS location,
            il.reason
     FROM inventory_ledger il
     LEFT JOIN raw_materials rm ON rm.id = il.item_id AND il.item_type = 'raw_material'
     LEFT JOIN finished_goods fg ON fg.id = il.item_id AND il.item_type = 'finished_good'
     LEFT JOIN locations l ON l.id = il.location_id
     WHERE il.date BETWEEN ? AND ?
     ORDER BY il.date DESC, il.created_at DESC`,
    [start, end]
  );
  const rows = rowsRes.rows || [];
  const inQty = rows.filter(r => r.transaction_type === 'in').reduce((s, r) => s + numeric(r.quantity), 0);
  const outQty = rows.filter(r => r.transaction_type === 'out').reduce((s, r) => s + numeric(r.quantity), 0);
  const summary = {
    total_movements: rows.length,
    total_received_qty: inQty,
    total_dispatched_qty: outQty,
    net_movement_qty: inQty - outQty
  };
  return sendReport(
    req,
    res,
    rows,
    summary,
    [
      { key: 'date', label: 'Date' },
      { key: 'transaction_type', label: 'Type' },
      { key: 'item_type', label: 'Category' },
      { key: 'item_name', label: 'Item Name' },
      { key: 'quantity', label: 'Quantity' },
      { key: 'location', label: 'Location' },
      { key: 'reason', label: 'Reason / Reference' }
    ],
    `stock_movements_${start}_to_${end}`,
    'Stock Movement & Audit Ledger Report',
    `Period: ${start} to ${end}`
  );
}

async function handleReorderSuggestions(req, res) {
  try {
    const inventory = await getInventorySnapshot(req.tenantDb);
    const lowStock = inventory.filter(i => (i.status === 'Low' || i.status === 'Out') && i.item_type !== 'wip');
    
    const results = [];
    for (const item of lowStock) {
      let vendorId = null;
      let vendorName = 'Unassigned';
      let lastPrice = item.unit_cost || 0;
      let itemCode = '';

      const itemRow = await req.tenantDb.query('SELECT code, last_purchase_price FROM items WHERE id = ?', [item.item_id]).catch(() => ({ rows: [] }));
      if (itemRow.rows.length > 0) {
        itemCode = itemRow.rows[0].code || '';
        if (numeric(itemRow.rows[0].last_purchase_price) > 0) {
          lastPrice = numeric(itemRow.rows[0].last_purchase_price);
        }
      }

      const viRow = await req.tenantDb.query(
        `SELECT vi.vendor_id, v.name AS vendor_name, vi.last_purchase_price
         FROM vendor_items vi
         JOIN vendors v ON v.id = vi.vendor_id AND v.deleted_at IS NULL
         WHERE vi.item_id = ?
         ORDER BY vi.is_preferred_vendor DESC, vi.last_purchase_date DESC
         LIMIT 1`,
        [item.item_id]
      ).catch(() => ({ rows: [] }));

      if (viRow.rows.length > 0) {
        vendorId = viRow.rows[0].vendor_id;
        vendorName = viRow.rows[0].vendor_name;
        if (numeric(viRow.rows[0].last_purchase_price) > 0) {
          lastPrice = numeric(viRow.rows[0].last_purchase_price);
        }
      } else {
        const procRow = await req.tenantDb.query(
          `SELECT p.vendor_id, v.name AS vendor_name, p.rate_per_unit
           FROM procurements p
           JOIN vendors v ON v.id = p.vendor_id AND v.deleted_at IS NULL
           WHERE (p.raw_material_id = ? OR p.item_id = ?) AND p.deleted_at IS NULL
           ORDER BY p.date DESC
           LIMIT 1`,
          [item.item_id, item.item_id]
        ).catch(() => ({ rows: [] }));

        if (procRow.rows.length > 0) {
          vendorId = procRow.rows[0].vendor_id;
          vendorName = procRow.rows[0].vendor_name;
          if (numeric(procRow.rows[0].rate_per_unit) > 0) {
            lastPrice = numeric(procRow.rows[0].rate_per_unit);
          }
        }
      }

      const reorderLevel = item.reorder_level || 10;
      const suggestedQty = Math.max(1, Math.ceil(reorderLevel * 1.5 - item.current_stock));

      results.push({
        item_id: item.item_id,
        item_name: item.name,
        item_code: itemCode,
        item_type: item.item_type,
        unit: item.unit,
        current_stock: item.current_stock,
        reorder_level: reorderLevel,
        suggested_reorder_qty: suggestedQty,
        preferred_vendor_id: vendorId,
        preferred_vendor_name: vendorName,
        last_purchase_price: lastPrice
      });
    }

    return res.json(results);
  } catch (err) {
    console.error('reorder-suggestions error:', err);
    return res.status(500).json({ error: 'Failed to generate reorder suggestions: ' + err.message });
  }
}

router.get(['/gst-summary', '/gst-summary.pdf', '/gst_summary'], requireAuth, requireReportPermission(), handleGstSummaryReport);
router.get(['/outstanding-balances', '/outstanding-balances.pdf', '/outstanding'], requireAuth, requireReportPermission(), handleOutstandingReport);
router.get(['/expenses', '/expenses.pdf'], requireAuth, requireReportPermission(), handleExpenseReport);
router.get(['/stock-movements', '/stock-movements.pdf'], requireAuth, requireReportPermission(), handleStockMovementReport);
router.get(['/reorder-suggestions', '/reorder-suggestions.pdf', '/reorder'], requireAuth, requireReportPermission(), handleReorderSuggestions);

module.exports = router;
module.exports.handleReorderSuggestions = handleReorderSuggestions;
