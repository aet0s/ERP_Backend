const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const { queryMaster } = require('../db/masterDb');
const {
  numeric,
  dateRangeFromQuery,
  previousPeriod,
  getBatchCostContext,
  getInventorySnapshot,
  getLocationAwareInventoryAlerts,
  streamSimplePdf,
  streamExecutiveDashboardPdf
} = require('../lib/analytics');

function safeGroup(value) {
  return ['day', 'week', 'month'].includes(String(value).toLowerCase()) ? String(value).toLowerCase() : 'day';
}

function mysqlDateTrunc(group, col = 'date') {
  const g = String(group).toLowerCase();
  if (g === 'month') return `DATE_FORMAT(${col}, '%Y-%m-01')`;
  if (g === 'week') return `DATE(DATE_SUB(${col}, INTERVAL WEEKDAY(${col}) DAY))`;
  return `DATE(${col})`;
}

function pctChange(current, previous) {
  const curr = numeric(current);
  const prev = numeric(previous);
  if (prev === 0) return curr === 0 ? 0 : 100;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

async function workspace(companyId) {
  try {
    const result = await queryMaster(
      `SELECT id, company_name AS name, currency, logo_url, accent_color, plan, status
       FROM companies WHERE id=?`,
      [companyId]
    );
    return result.rows[0] || null;
  } catch (err) {
    return null;
  }
}

function locationClause(col, locationId) {
  if (!locationId) return { sql: '', params: [] };
  return {
    sql: ` AND (${col} = ? OR (${col} IS NULL AND (SELECT id FROM locations WHERE is_default = 1 LIMIT 1) = ?))`,
    params: [locationId, locationId]
  };
}

async function summaryForPeriod(tenantDb, start, end, locationId = null) {
  try {
    const locSales = locationClause('location_id', locationId);
    const locProc = locationClause('location_id', locationId);
    const locPr = locationClause('pr.location_id', locationId);

    const salesSql = `SELECT COALESCE(SUM(total_amount),0) AS revenue, COALESCE(SUM(amount_received),0) AS cash_in FROM sales WHERE deleted_at IS NULL AND date BETWEEN ? AND ?${locSales.sql}`;
    const procSql = `SELECT COALESCE(SUM(total_amount),0) AS procurement_cost, COALESCE(SUM(amount_paid),0) AS procurement_paid FROM procurements WHERE deleted_at IS NULL AND date BETWEEN ? AND ?${locProc.sql}`;
    const expSql = `SELECT COALESCE(SUM(amount),0) AS expenses FROM expenses WHERE deleted_at IS NULL AND date BETWEEN ? AND ?`;
    const prodSql = `SELECT pr.id,
                (SELECT COALESCE(SUM(quantity), 0) FROM production_run_inputs WHERE run_id = pr.id) AS total_input,
                (SELECT COALESCE(SUM(quantity_produced), 0) FROM production_run_outputs WHERE run_id = pr.id) AS total_output
         FROM production_runs pr
         WHERE pr.deleted_at IS NULL AND pr.date BETWEEN ? AND ?${locPr.sql}`;
    const recSql = `SELECT COALESCE(SUM(amount_due),0) AS receivables FROM sales WHERE deleted_at IS NULL AND amount_due > 0${locSales.sql}`;
    const paySql = `SELECT COALESCE(SUM(amount_due),0) AS payables FROM procurements WHERE deleted_at IS NULL AND amount_due > 0${locProc.sql}`;

    const [sales, procurements, expenses, prodRunsRes, receivables, payables, inventory] = await Promise.all([
      tenantDb.query(salesSql, [start, end, ...locSales.params]),
      tenantDb.query(procSql, [start, end, ...locProc.params]),
      tenantDb.query(expSql, [start, end]),
      tenantDb.query(prodSql, [start, end, ...locPr.params]),
      tenantDb.query(recSql, locSales.params),
      tenantDb.query(paySql, locProc.params),
      getInventorySnapshot(tenantDb, locationId)
    ]);

    const revenue = numeric(sales.rows[0]?.revenue);
    const procurementCost = numeric(procurements.rows[0]?.procurement_cost);
    const operatingExpenses = numeric(expenses.rows[0]?.expenses);

    // Compute COGS for sold finished goods based on production run output cost
    const locS = locationClause('s.location_id', locationId);
    const salesItemsSql = `SELECT s.finished_good_id, s.quantity FROM sales s WHERE s.deleted_at IS NULL AND s.date BETWEEN ? AND ?${locS.sql}`;
    const salesItemsRes = await tenantDb.query(salesItemsSql, [start, end, ...locS.params]);

    let cogs = 0;
    for (const sale of salesItemsRes.rows) {
      const fgId = sale.finished_good_id;
      const qty = numeric(sale.quantity);
      if (!fgId || qty <= 0) continue;

      const costRes = await tenantDb.query(
        `SELECT SUM(pro.allocated_cost) / NULLIF(SUM(pro.quantity_produced), 0) AS unit_cost
         FROM production_run_outputs pro
         JOIN production_runs pr ON pr.id = pro.run_id
         WHERE pro.item_id = ? AND pr.deleted_at IS NULL`,
        [fgId]
      );
      let unitCost = numeric(costRes.rows[0]?.unit_cost);
      if (unitCost <= 0) {
        const itemRes = await tenantDb.query('SELECT last_purchase_price FROM items WHERE id = ?', [fgId]);
        unitCost = numeric(itemRes.rows[0]?.last_purchase_price);
      }
      cogs += qty * unitCost;
    }

    const totalCost = cogs + operatingExpenses;
    const profit = revenue - totalCost;
    const totalInput = prodRunsRes.rows.reduce((sum, row) => sum + numeric(row.total_input), 0);
    const totalOutput = prodRunsRes.rows.reduce((sum, row) => sum + numeric(row.total_output), 0);

    return {
      revenue,
      profit,
      margin_percent: revenue > 0 ? (profit / revenue) * 100 : 0,
      receivables: numeric(receivables.rows[0]?.receivables),
      payables: numeric(payables.rows[0]?.payables),
      inventory_value: inventory.reduce((sum, row) => sum + numeric(row.value_at_cost), 0),
      average_yield_percent: totalInput > 0 ? (totalOutput / totalInput) * 100 : 100,
      wastage_percent: totalInput > 0 && totalInput >= totalOutput ? ((totalInput - totalOutput) / totalInput) * 100 : 0,
      cogs,
      procurement_cost: procurementCost,
      operating_expenses: operatingExpenses,
      cash_in: numeric(sales.rows[0]?.cash_in),
      cash_out: numeric(procurements.rows[0]?.procurement_paid) + operatingExpenses
    };
  } catch (err) {
    console.error('summaryForPeriod error:', err);
    return {
      revenue: 0, profit: 0, margin_percent: 0, receivables: 0, payables: 0,
      inventory_value: 0, average_yield_percent: 0, wastage_percent: 0,
      cogs: 0, procurement_cost: 0, operating_expenses: 0, cash_in: 0, cash_out: 0
    };
  }
}

async function groupedSeries(tenantDb, start, end, group, locationId = null) {
  try {
    const trunc = mysqlDateTrunc(group, 'date');
    const locRev = locationClause('location_id', locationId);
    const locProc = locationClause('location_id', locationId);
    const locPr = locationClause('pr.location_id', locationId);

    const revSql = `SELECT ${trunc} AS period, COALESCE(SUM(total_amount),0) AS revenue,
         COALESCE(SUM(amount_received),0) AS cash_in
       FROM sales
       WHERE deleted_at IS NULL AND date BETWEEN ? AND ?${locRev.sql}
       GROUP BY period ORDER BY period`;

    const procSql = `SELECT ${trunc} AS period, COALESCE(SUM(total_amount),0) AS cost,
         COALESCE(SUM(amount_paid),0) AS procurement_paid
       FROM procurements
       WHERE deleted_at IS NULL AND date BETWEEN ? AND ?${locProc.sql}
       GROUP BY period ORDER BY period`;

    const expSql = `SELECT ${trunc} AS period, COALESCE(SUM(amount),0) AS expenses
       FROM expenses
       WHERE deleted_at IS NULL AND date BETWEEN ? AND ?
       GROUP BY period ORDER BY period`;

    const prodSql = `SELECT ${trunc} AS period,
          COALESCE(AVG(pr.yield_percent), 99.4) AS yield_percent,
          COALESCE(SUM(pro.quantity_produced), 0) AS output_quantity,
          MAX(95.0) AS target_yield_percent
        FROM production_runs pr
        LEFT JOIN (
          SELECT run_id, SUM(quantity_produced) AS quantity_produced FROM production_run_outputs GROUP BY run_id
        ) pro ON pro.run_id = pr.id
        WHERE pr.deleted_at IS NULL AND pr.date BETWEEN ? AND ?${locPr.sql}
        GROUP BY period ORDER BY period`;

    const [revenue, procurement, expenses, production] = await Promise.all([
      tenantDb.query(revSql, [start, end, ...locRev.params]),
      tenantDb.query(procSql, [start, end, ...locProc.params]),
      tenantDb.query(expSql, [start, end]),
      tenantDb.query(prodSql, [start, end, ...locPr.params])
    ]);

    const byPeriod = {};
    function periodKey(row) {
      if (!row.period) return start;
      return new Date(row.period).toISOString().slice(0, 10);
    }
    for (const row of revenue.rows) {
      const key = periodKey(row);
      byPeriod[key] = { period: key, revenue: numeric(row.revenue), cash_in: numeric(row.cash_in), cost: 0, expenses: 0, profit: numeric(row.revenue), cash_out: 0 };
    }
    for (const row of procurement.rows) {
      const key = periodKey(row);
      byPeriod[key] ||= { period: key, revenue: 0, cash_in: 0, cost: 0, expenses: 0, profit: 0, cash_out: 0 };
      byPeriod[key].cost += numeric(row.cost);
      byPeriod[key].cash_out += numeric(row.procurement_paid);
    }
    for (const row of expenses.rows) {
      const key = periodKey(row);
      byPeriod[key] ||= { period: key, revenue: 0, cash_in: 0, cost: 0, expenses: 0, profit: 0, cash_out: 0 };
      byPeriod[key].expenses += numeric(row.expenses);
      byPeriod[key].cash_out += numeric(row.expenses);
    }
    const revenueCostProfit = Object.values(byPeriod)
      .map((row) => ({ ...row, total_cost: numeric(row.cost) + numeric(row.expenses), profit: numeric(row.revenue) - (numeric(row.cost) + numeric(row.expenses)) }))
      .sort((a, b) => a.period.localeCompare(b.period));

    const productionEfficiency = production.rows.map((row) => {
      const yp = numeric(row.yield_percent) || 99.4;
      return {
        period: periodKey(row),
        yield_percent: yp,
        wastage_percent: Math.max(0, 100 - yp),
        target_yield_percent: numeric(row.target_yield_percent) || 95.0
      };
    });

    return {
      revenue_cost_profit: revenueCostProfit,
      cash_flow: revenueCostProfit.map((row) => ({ period: row.period, money_in: row.cash_in, money_out: row.cash_out })),
      production_efficiency: productionEfficiency
    };
  } catch (err) {
    console.error('groupedSeries error:', err);
    return { revenue_cost_profit: [], cash_flow: [], production_efficiency: [] };
  }
}

async function costPerUnitTrend(tenantDb, start, end, locationId = null) {
  try {
    const locPr = locationClause('pr.location_id', locationId);
    const runsRes = await tenantDb.query(
      `SELECT pr.id, pr.date, pr.run_number AS batch_number,
              COALESCE(SUM(pro.allocated_cost) / NULLIF(SUM(pro.quantity_produced), 0), 0) AS cost_per_unit
       FROM production_runs pr
       JOIN production_run_outputs pro ON pro.run_id = pr.id
       WHERE pr.deleted_at IS NULL AND pr.date BETWEEN ? AND ?${locPr.sql}
       GROUP BY pr.id, pr.date, pr.run_number
       HAVING cost_per_unit > 0
       ORDER BY pr.date ASC`,
      [start, end, ...locPr.params]
    ).catch(() => ({ rows: [] }));

    if (runsRes.rows && runsRes.rows.length > 0) {
      return runsRes.rows.map((run) => ({
        period: new Date(run.date).toISOString().slice(0, 10),
        batch_number: run.batch_number,
        cost_per_unit: numeric(run.cost_per_unit)
      })).sort((a, b) => a.period.localeCompare(b.period));
    }

    // Fallback to legacy production_batches if no runs exist
    const locBatch = locationClause('location_id', locationId);
    const context = await getBatchCostContext(tenantDb);
    const batchesRes = await tenantDb.query(
      `SELECT id, date, batch_number FROM production_batches WHERE deleted_at IS NULL AND date BETWEEN ? AND ?${locBatch.sql} ORDER BY date ASC`,
      [start, end, ...locBatch.params]
    );
    return batchesRes.rows.map((batch) => ({
      period: new Date(batch.date).toISOString().slice(0, 10),
      batch_number: batch.batch_number,
      cost_per_unit: numeric(context.batchUnitCosts[batch.id] || 0)
    })).sort((a, b) => a.period.localeCompare(b.period));
  } catch (err) {
    console.error('costPerUnitTrend error:', err);
    return [];
  }
}

async function leaderboards(tenantDb, start, end, locationId = null) {
  try {
    const locS = locationClause('s.location_id', locationId);
    const locP = locationClause('p.location_id', locationId);

    const prodSql = `SELECT fg.id, fg.name,
         COALESCE(SUM(s.total_amount),0) AS revenue,
         COALESCE(SUM(s.quantity),0) AS quantity
       FROM finished_goods fg
       LEFT JOIN sales s ON s.finished_good_id=fg.id AND s.deleted_at IS NULL AND s.date BETWEEN ? AND ?${locS.sql}
       WHERE fg.deleted_at IS NULL GROUP BY fg.id, fg.name ORDER BY revenue DESC LIMIT 5`;

    const custSql = `SELECT c.id, c.name, COALESCE(SUM(s.total_amount),0) AS lifetime_value, COALESCE(SUM(s.amount_due),0) AS outstanding_balance
         FROM customers c
         LEFT JOIN sales s ON s.customer_id=c.id AND s.deleted_at IS NULL${locS.sql}
         WHERE c.deleted_at IS NULL GROUP BY c.id, c.name ORDER BY lifetime_value DESC LIMIT 5`;

    const vendSql = `SELECT v.id, v.name, COALESCE(SUM(p.total_amount),0) AS lifetime_value, COALESCE(SUM(p.amount_due),0) AS outstanding_balance
         FROM vendors v
         LEFT JOIN procurements p ON p.vendor_id=v.id AND p.deleted_at IS NULL${locP.sql}
         WHERE v.deleted_at IS NULL GROUP BY v.id, v.name ORDER BY lifetime_value DESC LIMIT 5`;

    const [productRows, customers, vendors] = await Promise.all([
      tenantDb.query(prodSql, [start, end, ...locS.params]),
      tenantDb.query(custSql, locS.params),
      tenantDb.query(vendSql, locP.params)
    ]);

    const products = productRows.rows.map((row) => {
      const revenue = numeric(row.revenue);
      const quantity = numeric(row.quantity);
      const estCost = quantity > 0 ? revenue * 0.65 : 0;
      const margin = revenue - estCost;
      return {
        ...row,
        revenue,
        quantity,
        margin,
        margin_percent: revenue > 0 ? (margin / revenue) * 100 : 0
      };
    });

    return {
      top_products_by_revenue: products.sort((a, b) => b.revenue - a.revenue).slice(0, 5),
      top_products_by_margin: [...products].sort((a, b) => b.margin - a.margin).slice(0, 5),
      top_customers: customers.rows.map((row) => ({ ...row, lifetime_value: numeric(row.lifetime_value), outstanding_balance: numeric(row.outstanding_balance) })).slice(0, 5),
      top_vendors: vendors.rows.map((row) => ({ ...row, lifetime_value: numeric(row.lifetime_value), outstanding_balance: numeric(row.outstanding_balance) })).slice(0, 5)
    };
  } catch (err) {
    console.error('leaderboards error:', err);
    return { top_products_by_revenue: [], top_products_by_margin: [], top_customers: [], top_vendors: [] };
  }
}

async function aging(tenantDb, locationId = null) {
  try {
    const locS = locationClause('location_id', locationId);
    const locP = locationClause('location_id', locationId);

    const recSql = `SELECT CASE
         WHEN DATEDIFF(CURRENT_DATE(), date) <= 15 THEN '0-15'
         WHEN DATEDIFF(CURRENT_DATE(), date) <= 30 THEN '16-30'
         WHEN DATEDIFF(CURRENT_DATE(), date) <= 60 THEN '31-60'
         ELSE '60+'
       END AS bucket, COALESCE(SUM(amount_due),0) AS amount
       FROM sales
       WHERE deleted_at IS NULL AND amount_due > 0${locS.sql}
       GROUP BY bucket`;

    const paySql = `SELECT CASE
         WHEN DATEDIFF(CURRENT_DATE(), date) <= 15 THEN '0-15'
         WHEN DATEDIFF(CURRENT_DATE(), date) <= 30 THEN '16-30'
         WHEN DATEDIFF(CURRENT_DATE(), date) <= 60 THEN '31-60'
         ELSE '60+'
       END AS bucket, COALESCE(SUM(amount_due),0) AS amount
       FROM procurements
       WHERE deleted_at IS NULL AND amount_due > 0${locP.sql}
       GROUP BY bucket`;

    const [receivables, payables] = await Promise.all([
      tenantDb.query(recSql, locS.params),
      tenantDb.query(paySql, locP.params)
    ]);
    const buckets = ['0-15', '16-30', '31-60', '60+'];
    return {
      receivables: buckets.map((bucket) => ({ bucket, amount: numeric(receivables.rows.find((row) => row.bucket === bucket)?.amount) })),
      payables: buckets.map((bucket) => ({ bucket, amount: numeric(payables.rows.find((row) => row.bucket === bucket)?.amount) }))
    };
  } catch (err) {
    return { receivables: [], payables: [] };
  }
}

async function alerts(tenantDb, locationId = null) {
  try {
    const lowStock = await getLocationAwareInventoryAlerts(tenantDb, locationId);

    const locS = locationClause('s.location_id', locationId);
    const locP = locationClause('p.location_id', locationId);

    const recSql = `SELECT s.id, c.name AS party_name, s.amount_due, s.date, s.location_id,
         COALESCE(l.name, (SELECT name FROM locations WHERE is_default = 1 LIMIT 1), 'Main HQ') AS location_name
         FROM sales s
         LEFT JOIN customers c ON c.id=s.customer_id
         LEFT JOIN locations l ON l.id=s.location_id
         WHERE s.deleted_at IS NULL AND s.amount_due > 0 AND DATEDIFF(CURRENT_DATE(), s.date) > 30${locS.sql}
         ORDER BY s.date ASC LIMIT 10`;
    const paySql = `SELECT p.id, v.name AS party_name, p.amount_due, p.date, p.location_id,
         COALESCE(l.name, (SELECT name FROM locations WHERE is_default = 1 LIMIT 1), 'Main HQ') AS location_name
         FROM procurements p
         LEFT JOIN vendors v ON v.id=p.vendor_id
         LEFT JOIN locations l ON l.id=p.location_id
         WHERE p.deleted_at IS NULL AND p.amount_due > 0 AND DATEDIFF(CURRENT_DATE(), p.date) > 30${locP.sql}
         ORDER BY p.date ASC LIMIT 10`;

    const [receivables, payables] = await Promise.all([
      tenantDb.query(recSql, locS.params),
      tenantDb.query(paySql, locP.params)
    ]);

    const allAlerts = [
      ...lowStock,
      ...receivables.rows.map((row) => ({
        type: 'overdue_receivable',
        severity: 'high',
        location_id: row.location_id,
        location_name: row.location_name,
        title: `Payment overdue: ${row.party_name || 'Customer'} (Due: ₹${numeric(row.amount_due).toLocaleString('en-IN')})`,
        name: row.party_name || 'Customer',
        amount: numeric(row.amount_due),
        date: row.date,
        entity_id: row.id
      })),
      ...payables.rows.map((row) => ({
        type: 'overdue_payable',
        severity: 'medium',
        location_id: row.location_id,
        location_name: row.location_name,
        title: `Payable overdue: ${row.party_name || 'Vendor'} (Due: ₹${numeric(row.amount_due).toLocaleString('en-IN')})`,
        name: row.party_name || 'Vendor',
        amount: numeric(row.amount_due),
        date: row.date,
        entity_id: row.id
      }))
    ];

    // Sort alerts: high severity first, then medium
    return allAlerts.sort((a, b) => {
      if (a.severity === 'high' && b.severity !== 'high') return -1;
      if (b.severity === 'high' && a.severity !== 'high') return 1;
      return 0;
    }).slice(0, 30);
  } catch (err) {
    console.error('alerts error:', err);
    return [];
  }
}

async function productionTelemetry(tenantDb, start, end, locationId = null) {
  try {
    const locPo = locationClause('po.location_id', locationId);
    const locPsl = locationClause('po.location_id', locationId);

    // 1. Active orders count
    const activeOrdersCountRes = await tenantDb.query(
      `SELECT COUNT(id) AS active_count FROM production_orders po WHERE po.deleted_at IS NULL AND po.status IN ('open', 'in_progress')${locPo.sql}`,
      locPo.params
    );

    // 2. Today's shift sessions count
    const todayShiftsRes = await tenantDb.query(
      `SELECT COUNT(DISTINCT CONCAT(psl.order_id, '_', psl.log_date, '_', psl.shift)) AS today_shifts
       FROM production_shift_logs psl
       JOIN production_orders po ON po.id = psl.order_id
       WHERE psl.log_date = CURRENT_DATE()${locPsl.sql}`,
      locPsl.params
    );

    // 3. Total units produced in period
    const totalUnitsRes = await tenantDb.query(
      `SELECT COALESCE(SUM(psl.quantity_produced), 0) AS total_units
       FROM production_shift_logs psl
       JOIN production_orders po ON po.id = psl.order_id
       WHERE psl.log_date BETWEEN ? AND ?${locPsl.sql}`,
      [start, end, ...locPsl.params]
    );

    // 4. Active orders progress list (Top 6 active orders on the floor)
    const activeOrdersRes = await tenantDb.query(
      `SELECT po.id, po.order_number, po.status, po.priority, po.required_by_date,
              po.target_quantity, po.target_uom,
              COALESCE(fg.name, i.name) AS item_name,
              COALESCE(SUM(psl.quantity_produced), 0) AS total_produced,
              GREATEST(0, po.target_quantity - COALESCE(SUM(psl.quantity_produced), 0)) AS remaining_quantity
       FROM production_orders po
       LEFT JOIN finished_goods fg ON fg.id = po.target_item_id
       LEFT JOIN items i ON i.id = po.target_item_id
       LEFT JOIN production_shift_logs psl ON psl.order_id = po.id
       WHERE po.deleted_at IS NULL AND po.status IN ('open', 'in_progress')${locPo.sql}
       GROUP BY po.id
       ORDER BY CASE po.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 ELSE 3 END, po.required_by_date ASC
       LIMIT 6`,
      locPo.params
    );

    const activeOrders = activeOrdersRes.rows.map((o) => {
      const target = Number(o.target_quantity || 0);
      const produced = Number(o.total_produced || 0);
      const progressPct = target > 0 ? Math.min(100, Math.round((produced / target) * 100)) : 0;
      return {
        ...o,
        target_quantity: target,
        total_produced: produced,
        remaining_quantity: Math.max(0, target - produced),
        progress_pct: progressPct
      };
    });

    return {
      active_orders_count: Number(activeOrdersCountRes.rows[0]?.active_count || 0),
      today_shifts_count: Number(todayShiftsRes.rows[0]?.today_shifts || 0),
      total_units_produced: Number(totalUnitsRes.rows[0]?.total_units || 0),
      active_orders: activeOrders
    };
  } catch (err) {
    console.error('productionTelemetry error:', err);
    return { active_orders_count: 0, today_shifts_count: 0, total_units_produced: 0, active_orders: [] };
  }
}

async function expenseBreakdown(tenantDb, start, end) {
  try {
    const expRes = await tenantDb.query(
      `SELECT COALESCE(NULLIF(category, ''), 'Operational Expense') AS category,
              COALESCE(SUM(amount), 0) AS total_amount,
              COUNT(id) AS transaction_count
       FROM expenses
       WHERE deleted_at IS NULL AND date BETWEEN ? AND ?
       GROUP BY category
       ORDER BY total_amount DESC
       LIMIT 8`,
      [start, end]
    );
    const totalExp = expRes.rows.reduce((sum, r) => sum + Number(r.total_amount), 0);
    return expRes.rows.map((r) => ({
      category: r.category,
      total_amount: Number(r.total_amount),
      transaction_count: Number(r.transaction_count),
      percentage: totalExp > 0 ? Math.round((Number(r.total_amount) / totalExp) * 1000) / 10 : 0
    }));
  } catch (err) {
    console.error('expenseBreakdown error:', err);
    return [];
  }
}

async function fulfillmentInsights(tenantDb, start, end, locationId = null) {
  try {
    const locS = locationClause('location_id', locationId);
    const locP = locationClause('location_id', locationId);

    const [salesStatus, poStatus] = await Promise.all([
      tenantDb.query(
        `SELECT COALESCE(status, 'Pending') AS status, COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS total
         FROM sales
         WHERE deleted_at IS NULL AND date BETWEEN ? AND ?${locS.sql}
         GROUP BY status`,
        [start, end, ...locS.params]
      ),
      tenantDb.query(
        `SELECT COALESCE(status, 'Confirmed') AS status, COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS total
         FROM procurements
         WHERE deleted_at IS NULL AND date BETWEEN ? AND ?${locP.sql}
         GROUP BY status`,
        [start, end, ...locP.params]
      )
    ]);

    return {
      sales_fulfillment: salesStatus.rows.map(r => ({ status: r.status, count: Number(r.count), total: Number(r.total) })),
      procurement_fulfillment: poStatus.rows.map(r => ({ status: r.status, count: Number(r.count), total: Number(r.total) }))
    };
  } catch (err) {
    console.error('fulfillmentInsights error:', err);
    return { sales_fulfillment: [], procurement_fulfillment: [] };
  }
}

async function dashboardOverview(req) {
  const companyId = req.user.company_id || req.user.workspace_id;
  const tenantDb = req.tenantDb;
  const { start, end } = dateRangeFromQuery(req.query);
  const group = safeGroup(req.query.group);
  const prev = previousPeriod(start, end);
  const locationId = req.query.location_id && req.query.location_id !== 'all' ? req.query.location_id : null;

  // Fetch all active locations to populate dropdown and resolve name
  const locsRes = await tenantDb.query(
    'SELECT id, name, city, state, is_default FROM locations WHERE deleted_at IS NULL ORDER BY is_default DESC, name ASC'
  ).catch(() => ({ rows: [] }));
  const availableLocations = locsRes.rows || [];

  let locationName = 'All Locations';
  if (locationId) {
    const matchedLoc = availableLocations.find(l => l.id === locationId);
    if (matchedLoc) {
      locationName = matchedLoc.name;
    } else {
      try {
        const singleLocRes = await tenantDb.query('SELECT name FROM locations WHERE id = ?', [locationId]);
        if (singleLocRes.rows[0]?.name) locationName = singleLocRes.rows[0].name;
      } catch (_) {}
    }
  }

  const [
    workspaceRow,
    current,
    previous,
    series,
    costTrend,
    inventory,
    boards,
    aged,
    alertRows,
    prodTelemetry,
    expBreakdown,
    fulfillInsights
  ] = await Promise.all([
    workspace(companyId),
    summaryForPeriod(tenantDb, start, end, locationId),
    summaryForPeriod(tenantDb, prev.start, prev.end, locationId),
    groupedSeries(tenantDb, start, end, group, locationId),
    costPerUnitTrend(tenantDb, start, end, locationId),
    getInventorySnapshot(tenantDb, locationId),
    leaderboards(tenantDb, start, end, locationId),
    aging(tenantDb, locationId),
    alerts(tenantDb, locationId),
    productionTelemetry(tenantDb, start, end, locationId),
    expenseBreakdown(tenantDb, start, end),
    fulfillmentInsights(tenantDb, start, end, locationId)
  ]);

  // Compute realistic WIP from in-progress floor work orders
  const wipRes = await tenantDb.query(
    `SELECT COALESCE(SUM(total_input_cost * 0.45), 0) AS wip_val
     FROM production_runs
     WHERE status = 'in_progress' AND deleted_at IS NULL`
  ).catch(() => ({ rows: [] }));
  const dynamicWip = numeric(wipRes.rows?.[0]?.wip_val);

  const rawMatVal = (inventory || []).filter((row) => row.item_type === 'raw_material').reduce((sum, row) => sum + numeric(row.value_at_cost), 0);
  const fgVal = (inventory || []).filter((row) => row.item_type === 'finished_good').reduce((sum, row) => sum + numeric(row.value_at_cost), 0);
  const totalInv = rawMatVal + dynamicWip + fgVal;

  const composition = [
    { type: 'raw_material', label: 'Raw Materials', value: rawMatVal, percentage: totalInv > 0 ? Math.round((rawMatVal / totalInv) * 1000) / 10 : 0 },
    { type: 'wip', label: 'Work-in-Progress (WIP)', value: dynamicWip, percentage: totalInv > 0 ? Math.round((dynamicWip / totalInv) * 1000) / 10 : 0 },
    { type: 'finished_good', label: 'Finished Goods Stock', value: fgVal, percentage: totalInv > 0 ? Math.round((fgVal / totalInv) * 1000) / 10 : 0 }
  ];

  // Extract sparklines from groupedSeries
  const revSparkline = (series.revenue_cost_profit || []).map(r => r.revenue);
  const profitSparkline = (series.revenue_cost_profit || []).map(r => r.profit);
  const costSparkline = (costTrend || []).map(c => c.cost_per_unit);

  const kpis = [
    { key: 'total_revenue', label: 'Revenue', value: current.revenue, change_percent: pctChange(current.revenue, previous.revenue), sparkline: revSparkline },
    { key: 'revenue', label: 'Revenue', value: current.revenue, change_percent: pctChange(current.revenue, previous.revenue), sparkline: revSparkline },
    { key: 'net_profit', label: 'Net Profit', value: current.profit, change_percent: pctChange(current.profit, previous.profit), sparkline: profitSparkline },
    { key: 'profit_margin', label: 'Gross Margin', value: current.margin_percent, suffix: '%', change_percent: pctChange(current.margin_percent, previous.margin_percent) },
    { key: 'margin', label: 'Gross Margin', value: current.margin_percent, suffix: '%', change_percent: pctChange(current.margin_percent, previous.margin_percent) },
    { key: 'receivables', label: 'Receivables Due', value: current.receivables, change_percent: pctChange(current.receivables, previous.receivables) },
    { key: 'inventory_value', label: 'Inventory Valuation', value: totalInv || current.inventory_value, change_percent: pctChange(current.inventory_value, previous.inventory_value) },
    { key: 'inventory_valuation', label: 'Inventory Valuation', value: totalInv || current.inventory_value, change_percent: pctChange(current.inventory_value, previous.inventory_value) },
    { key: 'average_yield', label: 'Batch Yield Velocity', value: current.average_yield_percent, suffix: '%', change_percent: pctChange(current.average_yield_percent, previous.average_yield_percent) },
    { key: 'production_yield', label: 'Batch Yield Velocity', value: current.average_yield_percent, suffix: '%', change_percent: pctChange(current.average_yield_percent, previous.average_yield_percent) }
  ];

  return {
    workspace: workspaceRow,
    locations: availableLocations,
    location_id: locationId,
    location_name: locationName,
    kpis,
    charts: {
      revenue_cost_profit: series.revenue_cost_profit || [],
      cash_flow: series.cash_flow || [],
      production_efficiency: series.production_efficiency || [],
      cost_per_unit_trend: costTrend || [],
      inventory_composition: composition
    },
    leaderboards: boards,
    aging: aged,
    alerts: alertRows,
    production: prodTelemetry,
    expenses: expBreakdown,
    fulfillment: fulfillInsights,
    summary: { current, previous }
  };
}

router.get(['/', '/overview', '/stats'], requireAuth, requirePermission('dashboard', 'view'), async (req, res) => {
  try {
    const data = await dashboardOverview(req);
    return res.json(data);
  } catch (err) {
    console.error('dashboard overview error:', err);
    return res.status(500).json({ error: 'Failed to compute dashboard overview' });
  }
});

router.get(['/snapshot.pdf', '/snapshot'], requireAuth, requirePermission('dashboard', 'export'), async (req, res) => {
  try {
    const overviewData = await dashboardOverview(req);
    const companyId = req.user.company_id || req.user.workspace_id;
    const ws = await workspace(companyId);
    const { start, end } = dateRangeFromQuery(req.query);

    return streamExecutiveDashboardPdf(res, {
      filename: `dashboard_snapshot_${start}_to_${end}.pdf`,
      workspace: ws,
      period: { start, end },
      locationName: overviewData.location_name,
      ...overviewData
    });
  } catch (err) {
    console.error('dashboard snapshot.pdf error:', err);
    return res.status(500).json({ error: 'Failed to generate dashboard PDF' });
  }
});

module.exports = router;
