'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { getNextDocumentNumber } = require('../lib/invoiceEngine');

// Helper for flexible module permissions
function requireAnyPermission(modules, action = 'view') {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Missing auth' });
    const userRoles = req.user.roles && Array.isArray(req.user.roles) && req.user.roles.length > 0
      ? req.user.roles
      : [req.user.role || 'accounts'];

    if (userRoles.includes('owner') || userRoles.includes('admin') || req.user.role === 'owner' || req.user.role === 'admin') return next();

    const col = `can_${action}`;
    try {
      const placeholders = userRoles.map(() => '?').join(',');
      const modPlaceholders = modules.map(() => '?').join(',');
      const permRes = await req.tenantDb.query(
        `SELECT MAX(${col}) AS allowed FROM role_permissions WHERE role IN (${placeholders}) AND module IN (${modPlaceholders})`,
        [...userRoles, ...modules]
      );
      if (permRes.rows[0]?.allowed === 1 || permRes.rows[0]?.allowed === true) return next();
      return res.status(403).json({ error: `Forbidden: assigned roles do not have '${action}' permission for ${modules.join('/')}` });
    } catch (err) {
      console.error('requireAnyPermission error:', err);
      return res.status(500).json({ error: 'Failed to verify module permissions' });
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LIST PRODUCTION ORDERS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/production-orders', requireAuth, requireAnyPermission(['production', 'shift_log'], 'view'), async (req, res) => {
  try {
    const conditions = ['po.deleted_at IS NULL'];
    const params = [];

    if (req.query.status) {
      const statuses = req.query.status.split(',').map((s) => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        conditions.push('po.status = ?');
        params.push(statuses[0]);
      } else if (statuses.length > 1) {
        conditions.push(`po.status IN (${statuses.map(() => '?').join(', ')})`);
        params.push(...statuses);
      }
    }
    if (req.query.priority) {
      conditions.push('po.priority = ?');
      params.push(req.query.priority);
    }
    if (req.query.location_id) {
      conditions.push('po.location_id = ?');
      params.push(req.query.location_id);
    }
    if (req.query.item_id || req.query.product_id) {
      const prodId = req.query.item_id || req.query.product_id;
      conditions.push('(po.target_item_id = ? OR EXISTS (SELECT 1 FROM production_order_outputs poo WHERE poo.order_id = po.id AND poo.item_id = ?))');
      params.push(prodId, prodId);
    }
    if (req.query.formula_id) {
      conditions.push('po.formula_id = ?');
      params.push(req.query.formula_id);
    }
    if (req.query.overdue === 'true') {
      conditions.push('(po.required_by_date < CURDATE() AND po.status NOT IN ("completed", "cancelled"))');
    }
    if (req.query.start_date) {
      conditions.push('po.required_by_date >= ?');
      params.push(req.query.start_date);
    }
    if (req.query.end_date) {
      conditions.push('po.required_by_date <= ?');
      params.push(req.query.end_date);
    }
    if (req.query.search) {
      conditions.push('(po.order_number LIKE ? OR po.notes LIKE ? OR fg.name LIKE ? OR i.name LIKE ?)');
      params.push(`%${req.query.search}%`, `%${req.query.search}%`, `%${req.query.search}%`, `%${req.query.search}%`);
    }

    const where = conditions.join(' AND ');

    // Server-side pagination or export all
    const isExport = req.query.export === 'true' || req.query.limit === 'all' || req.query.all === 'true';
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = isExport ? 10000 : Math.max(1, Math.min(100, parseInt(req.query.page_size || req.query.limit || '20', 10)));
    const offset = isExport ? 0 : (page - 1) * pageSize;

    const countRes = await req.tenantDb.query(
      `SELECT COUNT(DISTINCT po.id) AS total
       FROM production_orders po
       LEFT JOIN finished_goods fg ON fg.id = po.target_item_id
       LEFT JOIN items i ON i.id = po.target_item_id
       LEFT JOIN production_formulas pf ON pf.id = po.formula_id
       LEFT JOIN locations l ON l.id = po.location_id
       WHERE ${where}`,
      params
    );
    const total = Number(countRes.rows[0]?.total || 0);

    const orders = await req.tenantDb.query(
      `SELECT po.*,
              COALESCE(fg.name, i.name) AS target_item_name,
              COALESCE(fg.unit, i.unit, po.target_uom) AS target_item_unit,
              pf.name AS formula_name,
              l.name AS location_name,
              COALESCE(SUM(psl.quantity_produced), 0) AS total_produced,
              GREATEST(0, po.target_quantity - COALESCE(SUM(psl.quantity_produced), 0)) AS remaining_quantity,
              COUNT(psl.id) AS shift_log_count
       FROM production_orders po
       LEFT JOIN finished_goods fg ON fg.id = po.target_item_id
       LEFT JOIN items i ON i.id = po.target_item_id
       LEFT JOIN production_formulas pf ON pf.id = po.formula_id
       LEFT JOIN locations l ON l.id = po.location_id
       LEFT JOIN production_shift_logs psl ON psl.order_id = po.id
       WHERE ${where}
       GROUP BY po.id
       ORDER BY po.required_by_date ASC, po.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    if (orders.rows.length > 0) {
      const orderIds = orders.rows.map((o) => o.id);
      const outputsRes = await req.tenantDb.query(
        `SELECT poo.id, poo.order_id, poo.item_id, poo.item_type, poo.target_quantity, poo.uom,
                COALESCE(fg.name, i.name) AS item_name,
                COALESCE(fg.unit, i.unit, poo.uom) AS base_unit,
                COALESCE(pro.packaging_name, ppl.name) AS packaging_name,
                pro.packaging_level_id,
                pro.units_per_package,
                pro.base_quantity,
                ppl.package_unit,
                pro.id AS run_output_id,
                COALESCE(SUM(psl.quantity_produced), 0) AS total_produced,
                GREATEST(0, poo.target_quantity - COALESCE(SUM(psl.quantity_produced), 0)) AS remaining_quantity
         FROM production_order_outputs poo
         JOIN production_orders po ON po.id = poo.order_id
         LEFT JOIN finished_goods fg ON fg.id = poo.item_id
         LEFT JOIN items i ON i.id = poo.item_id
         LEFT JOIN production_runs pr ON ((pr.order_id IS NOT NULL AND pr.order_id = po.id) OR pr.run_number = po.order_number) AND pr.deleted_at IS NULL
         LEFT JOIN production_run_outputs pro ON pro.run_id = pr.id AND pro.item_id = poo.item_id
         LEFT JOIN product_packaging_levels ppl ON ppl.id = pro.packaging_level_id
         LEFT JOIN production_shift_logs psl ON psl.order_id = poo.order_id AND (psl.item_id = poo.item_id OR (psl.item_id IS NULL AND poo.item_id = po.target_item_id))
         WHERE poo.order_id IN (${orderIds.map(() => '?').join(',')})
         GROUP BY poo.id, poo.order_id, poo.item_id, poo.item_type, poo.target_quantity, poo.uom,
                  fg.name, i.name, fg.unit, i.unit, pro.packaging_name, ppl.name, pro.packaging_level_id, pro.units_per_package, pro.base_quantity, ppl.package_unit, pro.id
         ORDER BY poo.created_at ASC`,
        orderIds
      );

      // Fetch packaging allocations if any run_output_id exists
      const runOutputIds = outputsRes.rows.map((o) => o.run_output_id).filter(Boolean);
      let allocMap = {};
      if (runOutputIds.length > 0) {
        const allocsRes = await req.tenantDb.query(
          `SELECT proa.*, 
                  COALESCE(ppl.name, 'Package') AS level_name,
                  COALESCE(ppl.name, 'Package') AS packaging_name,
                  ppl.package_unit,
                  ppl.base_quantity_equivalent
           FROM production_run_output_allocations proa
           LEFT JOIN product_packaging_levels ppl ON ppl.id = proa.packaging_level_id
           WHERE proa.run_output_id IN (${runOutputIds.map(() => '?').join(',')})
           ORDER BY proa.created_at ASC`,
          runOutputIds
        );
        for (const a of allocsRes.rows) {
          if (!allocMap[a.run_output_id]) allocMap[a.run_output_id] = [];
          allocMap[a.run_output_id].push(a);
        }
      }

      const outputsByOrderId = {};
      for (const out of outputsRes.rows) {
        if (!outputsByOrderId[out.order_id]) outputsByOrderId[out.order_id] = [];
        const allocs = (out.run_output_id && allocMap[out.run_output_id]) ? allocMap[out.run_output_id] : [];
        const primaryAlloc = allocs.find((a) => a.packaging_level_id && Number(a.package_count) > 0) || allocs[0];
        const packageCount = primaryAlloc && Number(primaryAlloc.package_count) > 0 ? Number(primaryAlloc.package_count) : null;
        const packagingName = out.packaging_name || primaryAlloc?.packaging_name || primaryAlloc?.level_name || null;
        const packageUnit = primaryAlloc?.package_unit || out.package_unit || (packageCount ? packagingName : null);

        // Floor operations track packaging units if defined
        const hasPackaging = Boolean(packageCount && packageCount > 0 && packagingName);
        const effectiveTargetQty = hasPackaging ? packageCount : (Number(out.target_quantity) || 0);
        const effectiveUom = hasPackaging ? (packageUnit || packagingName) : (out.uom || out.base_unit || 'unit');
        const pQty = Number(out.total_produced) || 0;
        const baseQty = Number(out.base_quantity) || (hasPackaging ? effectiveTargetQty * (Number(out.units_per_package) || 1) : effectiveTargetQty);
        const baseUom = out.base_unit || out.uom || 'unit';

        outputsByOrderId[out.order_id].push({
          ...out,
          target_quantity: effectiveTargetQty,
          uom: effectiveUom,
          item_unit: effectiveUom,
          packaging_name: packagingName,
          package_count: packageCount,
          package_unit: packageUnit,
          base_quantity: baseQty,
          base_unit: baseUom,
          units_per_package: Number(out.units_per_package) || 1,
          allocations: allocs,
          total_produced: pQty,
          remaining_quantity: Math.max(0, effectiveTargetQty - pQty),
          progress_pct: effectiveTargetQty > 0 ? Math.min(100, Math.round((pQty / effectiveTargetQty) * 100)) : 0
        });
      }

      for (const order of orders.rows) {
        const outs = outputsByOrderId[order.id] || [];
        if (outs.length > 0) {
          order.outputs = outs;
          order.target_quantity = outs.reduce((sum, o) => sum + Number(o.target_quantity || 0), 0);
          order.total_produced = outs.reduce((sum, o) => sum + Number(o.total_produced || 0), 0);
          order.remaining_quantity = Math.max(0, order.target_quantity - order.total_produced);
          if (outs.length === 1) {
            order.target_uom = outs[0].uom;
          }
        } else {
          const tQty = Number(order.target_quantity) || 0;
          const pQty = Number(order.total_produced) || 0;
          order.outputs = [{
            id: order.id,
            order_id: order.id,
            item_id: order.target_item_id,
            item_type: order.target_item_type,
            target_quantity: tQty,
            uom: order.target_uom,
            item_name: order.target_item_name,
            item_unit: order.target_item_unit,
            total_produced: pQty,
            remaining_quantity: Math.max(0, tQty - pQty),
            progress_pct: tQty > 0 ? Math.min(100, Math.round((pQty / tQty) * 100)) : 0
          }];
        }
      }
    }

    return res.json({
      data: orders.rows,
      items: orders.rows,
      meta: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.ceil(total / pageSize) || 1
      }
    });
  } catch (err) {
    console.error('list production orders error', err);
    return res.status(500).json({ error: 'Failed to fetch production orders' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LIST ALL SHIFT LOGS (Paginated global shift logs across all orders)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/production-shift-logs', requireAuth, requirePermission('shift_log', 'view'), async (req, res) => {
  try {
    const isExport = req.query.export === 'true' || req.query.limit === 'all' || req.query.all === 'true';
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = isExport ? 10000 : Math.max(1, Math.min(100, parseInt(req.query.page_size || req.query.limit || '20', 10)));
    const offset = isExport ? 0 : (page - 1) * pageSize;

    const conditions = ['po.deleted_at IS NULL'];
    const params = [];

    if (req.query.shift) {
      conditions.push('psl.shift = ?');
      params.push(req.query.shift);
    }
    if (req.query.start_date) {
      conditions.push('psl.log_date >= ?');
      params.push(req.query.start_date);
    }
    if (req.query.end_date) {
      conditions.push('psl.log_date <= ?');
      params.push(req.query.end_date);
    }
    if (req.query.order_id) {
      conditions.push('psl.order_id = ?');
      params.push(req.query.order_id);
    }
    if (req.query.operator_id || req.query.created_by) {
      conditions.push('psl.created_by = ?');
      params.push(req.query.operator_id || req.query.created_by);
    }
    if (req.query.item_id || req.query.product_id) {
      conditions.push('COALESCE(psl.item_id, po.target_item_id) = ?');
      params.push(req.query.item_id || req.query.product_id);
    }
    if (req.query.search) {
      conditions.push('(po.order_number LIKE ? OR psl.notes LIKE ? OR u.name LIKE ? OR fg.name LIKE ? OR i.name LIKE ?)');
      params.push(`%${req.query.search}%`, `%${req.query.search}%`, `%${req.query.search}%`, `%${req.query.search}%`, `%${req.query.search}%`);
    }

    const where = conditions.join(' AND ');

    const countRes = await req.tenantDb.query(
      `SELECT COUNT(psl.id) AS total
       FROM production_shift_logs psl
       JOIN production_orders po ON po.id = psl.order_id
       LEFT JOIN finished_goods fg ON fg.id = COALESCE(psl.item_id, po.target_item_id)
       LEFT JOIN items i ON i.id = COALESCE(psl.item_id, po.target_item_id)
       LEFT JOIN users u ON u.id = psl.created_by
       WHERE ${where}`,
      params
    );
    const total = Number(countRes.rows[0]?.total || 0);

    const logs = await req.tenantDb.query(
      `SELECT psl.*,
              po.order_number,
              COALESCE(fg.name, i.name) AS target_item_name,
              COALESCE(fg.name, i.name) AS item_name,
              u.name AS logged_by_name
       FROM production_shift_logs psl
       JOIN production_orders po ON po.id = psl.order_id
       LEFT JOIN finished_goods fg ON fg.id = COALESCE(psl.item_id, po.target_item_id)
       LEFT JOIN items i ON i.id = COALESCE(psl.item_id, po.target_item_id)
       LEFT JOIN users u ON u.id = psl.created_by
       WHERE ${where}
       ORDER BY psl.log_date DESC, psl.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    return res.json({
      data: logs.rows,
      items: logs.rows,
      meta: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.ceil(total / pageSize) || 1
      }
    });
  } catch (err) {
    console.error('list shift logs error', err);
    return res.status(500).json({ error: 'Failed to fetch shift logs' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTION STATS SUMMARY (for Floor KPI widgets)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/production-orders/stats', requireAuth, requireAnyPermission(['production', 'shift_log'], 'view'), async (req, res) => {
  try {
    const activeRes = await req.tenantDb.query(
      `SELECT COUNT(id) AS active_count
       FROM production_orders
       WHERE deleted_at IS NULL AND status IN ('open', 'in_progress')`
    );

    const completedRes = await req.tenantDb.query(
      `SELECT COUNT(id) AS completed_count
       FROM production_orders
       WHERE deleted_at IS NULL AND status = 'completed'`
    );

    // Count distinct shift logging sessions today (order + date + shift)
    // so multi-product finished goods outputs logged together count as 1 shift session
    const todayRes = await req.tenantDb.query(
      `SELECT COUNT(DISTINCT CONCAT(order_id, '_', log_date, '_', shift)) AS today_shifts
       FROM production_shift_logs
       WHERE log_date = CURRENT_DATE()`
    );

    const urgentRes = await req.tenantDb.query(
      `SELECT COUNT(id) AS urgent_or_overdue_count
       FROM production_orders
       WHERE deleted_at IS NULL
         AND status IN ('open', 'in_progress')
         AND (priority IN ('urgent', 'high') OR required_by_date < CURRENT_DATE())`
    );

    return res.json({
      active_orders_count: Number(activeRes.rows[0]?.active_count || 0),
      today_shifts_count: Number(todayRes.rows[0]?.today_shifts || 0),
      completed_orders_count: Number(completedRes.rows[0]?.completed_count || 0),
      urgent_or_overdue_count: Number(urgentRes.rows[0]?.urgent_or_overdue_count || 0)
    });
  } catch (err) {
    console.error('production orders stats error', err);
    return res.status(500).json({ error: 'Failed to fetch production stats' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FILTER OPTIONS (Distinct products, formulas, and operators for shop floor filters)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/production-orders/filter-options', requireAuth, requireAnyPermission(['production', 'shift_log'], 'view'), async (req, res) => {
  try {
    const productsRes = await req.tenantDb.query(`
      SELECT DISTINCT item_id AS id, item_name AS name, item_unit AS unit
      FROM (
        SELECT poo.item_id, COALESCE(fg.name, i.name) AS item_name, COALESCE(fg.unit, i.unit, poo.uom) AS item_unit
        FROM production_order_outputs poo
        LEFT JOIN finished_goods fg ON fg.id = poo.item_id
        LEFT JOIN items i ON i.id = poo.item_id
        WHERE poo.item_id IS NOT NULL
        UNION
        SELECT po.target_item_id AS item_id, COALESCE(fg2.name, i2.name) AS item_name, COALESCE(fg2.unit, i2.unit, po.target_uom) AS item_unit
        FROM production_orders po
        LEFT JOIN finished_goods fg2 ON fg2.id = po.target_item_id
        LEFT JOIN items i2 ON i2.id = po.target_item_id
        WHERE po.target_item_id IS NOT NULL AND po.deleted_at IS NULL
      ) combined
      WHERE item_name IS NOT NULL
      ORDER BY item_name ASC
    `);

    const formulasRes = await req.tenantDb.query(`
      SELECT DISTINCT pf.id, pf.name
      FROM production_formulas pf
      JOIN production_orders po ON po.formula_id = pf.id
      WHERE po.deleted_at IS NULL AND pf.deleted_at IS NULL
      ORDER BY pf.name ASC
    `);

    const operatorsRes = await req.tenantDb.query(`
      SELECT DISTINCT u.id, u.name, u.email
      FROM users u
      JOIN production_shift_logs psl ON psl.created_by = u.id
      WHERE u.deleted_at IS NULL
      ORDER BY u.name ASC
    `);

    return res.json({
      products: productsRes.rows || [],
      formulas: formulasRes.rows || [],
      operators: operatorsRes.rows || []
    });
  } catch (err) {
    console.error('filter-options error:', err);
    return res.status(500).json({ error: 'Failed to fetch filter options' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET ONE PRODUCTION ORDER WITH SHIFT LOGS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/production-orders/:id', requireAuth, requireAnyPermission(['production', 'shift_log'], 'view'), async (req, res) => {
  try {
    const orderRes = await req.tenantDb.query(
      `SELECT po.*,
              COALESCE(fg.name, i.name) AS target_item_name,
              COALESCE(fg.unit, i.unit, po.target_uom) AS target_item_unit,
              pf.name AS formula_name, pf.id AS formula_id,
              l.name AS location_name,
              COALESCE(SUM(psl.quantity_produced), 0) AS total_produced,
              GREATEST(0, po.target_quantity - COALESCE(SUM(psl.quantity_produced), 0)) AS remaining_quantity
       FROM production_orders po
       LEFT JOIN finished_goods fg ON fg.id = po.target_item_id
       LEFT JOIN items i ON i.id = po.target_item_id
       LEFT JOIN production_formulas pf ON pf.id = po.formula_id
       LEFT JOIN locations l ON l.id = po.location_id
       LEFT JOIN production_shift_logs psl ON psl.order_id = po.id
       WHERE po.id = ? AND po.deleted_at IS NULL
       GROUP BY po.id`,
      [req.params.id]
    );

    if (orderRes.rowCount === 0) {
      return res.status(404).json({ error: 'Production order not found' });
    }

    const order = orderRes.rows[0];

    // Fetch outputs for this order with packaging & allocation resolution
    const outputsRes = await req.tenantDb.query(
      `SELECT poo.id, poo.order_id, poo.item_id, poo.item_type, poo.target_quantity, poo.uom,
              COALESCE(fg.name, i.name) AS item_name,
              COALESCE(fg.unit, i.unit, poo.uom) AS base_unit,
              COALESCE(pro.packaging_name, ppl.name) AS packaging_name,
              pro.packaging_level_id,
              pro.units_per_package,
              pro.base_quantity,
              ppl.package_unit,
              pro.id AS run_output_id,
              COALESCE(SUM(psl.quantity_produced), 0) AS total_produced,
              GREATEST(0, poo.target_quantity - COALESCE(SUM(psl.quantity_produced), 0)) AS remaining_quantity
       FROM production_order_outputs poo
       JOIN production_orders po ON po.id = poo.order_id
       LEFT JOIN finished_goods fg ON fg.id = poo.item_id
       LEFT JOIN items i ON i.id = poo.item_id
       LEFT JOIN production_runs pr ON ((pr.order_id IS NOT NULL AND pr.order_id = po.id) OR pr.run_number = po.order_number) AND pr.deleted_at IS NULL
       LEFT JOIN production_run_outputs pro ON pro.run_id = pr.id AND pro.item_id = poo.item_id
       LEFT JOIN product_packaging_levels ppl ON ppl.id = pro.packaging_level_id
       LEFT JOIN production_shift_logs psl ON psl.order_id = poo.order_id AND (psl.item_id = poo.item_id OR (psl.item_id IS NULL AND poo.item_id = po.target_item_id))
       WHERE poo.order_id = ?
       GROUP BY poo.id, poo.order_id, poo.item_id, poo.item_type, poo.target_quantity, poo.uom,
                fg.name, i.name, fg.unit, i.unit, pro.packaging_name, ppl.name, pro.packaging_level_id, pro.units_per_package, pro.base_quantity, ppl.package_unit, pro.id
       ORDER BY poo.created_at ASC`,
      [req.params.id]
    );

    // Fetch allocations for outputs
    const runOutputIds = outputsRes.rows.map((o) => o.run_output_id).filter(Boolean);
    let allocMap = {};
    if (runOutputIds.length > 0) {
      const allocsRes = await req.tenantDb.query(
        `SELECT proa.*,
                COALESCE(ppl.name, 'Package') AS level_name,
                COALESCE(ppl.name, 'Package') AS packaging_name,
                ppl.package_unit,
                ppl.base_quantity_equivalent
         FROM production_run_output_allocations proa
         LEFT JOIN product_packaging_levels ppl ON ppl.id = proa.packaging_level_id
         WHERE proa.run_output_id IN (${runOutputIds.map(() => '?').join(',')})
         ORDER BY proa.created_at ASC`,
        runOutputIds
      );
      for (const a of allocsRes.rows) {
        if (!allocMap[a.run_output_id]) allocMap[a.run_output_id] = [];
        allocMap[a.run_output_id].push(a);
      }
    }

    if (outputsRes.rows.length > 0) {
      order.outputs = outputsRes.rows.map((out) => {
        const allocs = (out.run_output_id && allocMap[out.run_output_id]) ? allocMap[out.run_output_id] : [];
        const primaryAlloc = allocs.find((a) => a.packaging_level_id && Number(a.package_count) > 0) || allocs[0];
        const packageCount = primaryAlloc && Number(primaryAlloc.package_count) > 0 ? Number(primaryAlloc.package_count) : null;
        const packagingName = out.packaging_name || primaryAlloc?.packaging_name || primaryAlloc?.level_name || null;
        const packageUnit = primaryAlloc?.package_unit || out.package_unit || (packageCount ? packagingName : null);

        const hasPackaging = Boolean(packageCount && packageCount > 0 && packagingName);
        const effectiveTargetQty = hasPackaging ? packageCount : (Number(out.target_quantity) || 0);
        const effectiveUom = hasPackaging ? (packageUnit || packagingName) : (out.uom || out.base_unit || 'unit');
        const pQty = Number(out.total_produced) || 0;
        const baseQty = Number(out.base_quantity) || (hasPackaging ? effectiveTargetQty * (Number(out.units_per_package) || 1) : effectiveTargetQty);
        const baseUom = out.base_unit || out.uom || 'unit';

        return {
          ...out,
          target_quantity: effectiveTargetQty,
          uom: effectiveUom,
          item_unit: effectiveUom,
          packaging_name: packagingName,
          package_count: packageCount,
          package_unit: packageUnit,
          base_quantity: baseQty,
          base_unit: baseUom,
          units_per_package: Number(out.units_per_package) || 1,
          allocations: allocs,
          total_produced: pQty,
          remaining_quantity: Math.max(0, effectiveTargetQty - pQty),
          progress_pct: effectiveTargetQty > 0 ? Math.min(100, Math.round((pQty / effectiveTargetQty) * 100)) : 0
        };
      });
      order.target_quantity = order.outputs.reduce((sum, o) => sum + Number(o.target_quantity || 0), 0);
      order.total_produced = order.outputs.reduce((sum, o) => sum + Number(o.total_produced || 0), 0);
      order.remaining_quantity = Math.max(0, order.target_quantity - order.total_produced);
      if (order.outputs.length === 1) {
        order.target_uom = order.outputs[0].uom;
      }
    } else {
      const tQty = Number(order.target_quantity) || 0;
      const pQty = Number(order.total_produced) || 0;
      order.outputs = [{
        id: order.id,
        order_id: order.id,
        item_id: order.target_item_id,
        item_type: order.target_item_type,
        target_quantity: tQty,
        uom: order.target_uom,
        item_name: order.target_item_name,
        item_unit: order.target_item_unit,
        total_produced: pQty,
        remaining_quantity: Math.max(0, tQty - pQty),
        progress_pct: tQty > 0 ? Math.min(100, Math.round((pQty / tQty) * 100)) : 0
      }];
    }

    // Fetch shift logs with item names
    const logsRes = await req.tenantDb.query(
      `SELECT psl.*,
              COALESCE(fg.name, i.name, po_fg.name, po_i.name) AS item_name,
              COALESCE(fg.unit, i.unit, psl.uom) AS item_unit,
              u.name AS logged_by_name
       FROM production_shift_logs psl
       JOIN production_orders po ON po.id = psl.order_id
       LEFT JOIN finished_goods fg ON fg.id = psl.item_id
       LEFT JOIN items i ON i.id = psl.item_id
       LEFT JOIN finished_goods po_fg ON po_fg.id = po.target_item_id
       LEFT JOIN items po_i ON po_i.id = po.target_item_id
       LEFT JOIN users u ON u.id = psl.created_by
       WHERE psl.order_id = ?
       ORDER BY psl.log_date DESC, psl.shift ASC`,
      [req.params.id]
    );

    order.shift_logs = logsRes.rows;

    return res.json(order);
  } catch (err) {
    console.error('get production order error', err);
    return res.status(500).json({ error: 'Failed to fetch production order' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CREATE PRODUCTION ORDER (Manager)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/production-orders', requireAuth, requirePermission('production', 'create'), async (req, res) => {
  const {
    formula_id,
    target_item_id,
    target_item_type = 'finished_good',
    target_quantity,
    target_uom = 'unit',
    required_by_date,
    location_id,
    priority = 'normal',
    notes
  } = req.body;

  if (!target_item_id) return res.status(400).json({ error: 'target_item_id is required' });
  if (!target_quantity || Number(target_quantity) <= 0) return res.status(400).json({ error: 'target_quantity must be positive' });
  if (!required_by_date) return res.status(400).json({ error: 'required_by_date is required' });

  const client = await req.tenantDb.connect();
  const userId = req.user.user_id || req.user.id;

  try {
    await client.query('START TRANSACTION');

    const orderId = crypto.randomUUID();
    const orderNumber = await getNextDocumentNumber(client, 'production_order');

    // Resolve formula_version if formula_id provided
    let formulaVersion = 1;
    if (formula_id) {
      const fRes = await client.query('SELECT version FROM production_formulas WHERE id = ?', [formula_id]);
      if (fRes.rowCount > 0) formulaVersion = Number(fRes.rows[0].version) || 1;
    }

    await client.query(
      `INSERT INTO production_orders
         (id, order_number, formula_id, formula_version, target_item_id, target_item_type,
          target_quantity, target_uom, required_by_date, location_id, priority, notes, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      [orderId, orderNumber, formula_id || null, formulaVersion, target_item_id, target_item_type,
       Number(target_quantity), target_uom, required_by_date, location_id || null,
       priority, notes || null, userId]
    );

    // Audit
    try {
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata)
         VALUES (?, ?, 'production_order_created', 'production_order', ?, ?)`,
        [crypto.randomUUID(), userId, orderId, JSON.stringify({ orderNumber, target_quantity, required_by_date })]
      );
    } catch {}

    await client.query('COMMIT');

    const created = await req.tenantDb.query(
      `SELECT po.*, COALESCE(fg.name, i.name) AS target_item_name, COALESCE(fg.unit, i.unit, po.target_uom) AS target_item_unit
       FROM production_orders po
       LEFT JOIN finished_goods fg ON fg.id = po.target_item_id
       LEFT JOIN items i ON i.id = po.target_item_id
       WHERE po.id = ?`,
      [orderId]
    );

    return res.status(201).json(created.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('create production order error', err);
    return res.status(500).json({ error: 'Failed to create production order: ' + err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE PRODUCTION ORDER STATUS
// ─────────────────────────────────────────────────────────────────────────────
router.put('/production-orders/:id/status', requireAuth, requirePermission('production', 'edit'), async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['open', 'in_progress', 'completed', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  try {
    const result = await req.tenantDb.query(
      'UPDATE production_orders SET status = ?, updated_at = NOW() WHERE id = ? AND deleted_at IS NULL',
      [status, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Production order not found' });
    await req.tenantDb.query(
      'UPDATE production_runs SET status = ?, updated_at = NOW() WHERE order_id = ? OR run_number = (SELECT order_number FROM production_orders WHERE id = ?)',
      [status, req.params.id, req.params.id]
    );
    return res.json({ updated: true, status });
  } catch (err) {
    console.error('update production order status error', err);
    return res.status(500).json({ error: 'Failed to update status' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE (soft delete) PRODUCTION ORDER
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/production-orders/:id', requireAuth, requirePermission('production', 'delete'), async (req, res) => {
  const userId = req.user.user_id || req.user.id;
  try {
    const result = await req.tenantDb.query(
      'UPDATE production_orders SET deleted_at = NOW(), deleted_by = ? WHERE id = ? AND deleted_at IS NULL',
      [userId, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Production order not found' });
    return res.json({ deleted: true });
  } catch (err) {
    console.error('delete production order error', err);
    return res.status(500).json({ error: 'Failed to delete production order' });
  }
});

// Helper: Dynamically recalculate production order status based on outputs target & shift logs
async function recalculateOrderStatus(client, orderId) {
  const outputsRes = await client.query(
    `SELECT poo.id, poo.item_id, poo.target_quantity, poo.uom,
            proa.package_count, proa.packaging_level_id
     FROM production_order_outputs poo
     JOIN production_orders po ON po.id = poo.order_id
     LEFT JOIN production_runs pr ON ((pr.order_id IS NOT NULL AND pr.order_id = po.id) OR pr.run_number = po.order_number) AND pr.deleted_at IS NULL
     LEFT JOIN production_run_outputs pro ON pro.run_id = pr.id AND pro.item_id = poo.item_id
     LEFT JOIN production_run_output_allocations proa ON proa.run_output_id = pro.id AND proa.packaging_level_id IS NOT NULL
     WHERE poo.order_id = ?`,
    [orderId]
  );

  if (outputsRes.rowCount === 0) {
    const poRes = await client.query(
      `SELECT po.target_quantity, proa.package_count, proa.packaging_level_id
       FROM production_orders po
       LEFT JOIN production_runs pr ON ((pr.order_id IS NOT NULL AND pr.order_id = po.id) OR pr.run_number = po.order_number) AND pr.deleted_at IS NULL
       LEFT JOIN production_run_outputs pro ON pro.run_id = pr.id AND pro.item_id = po.target_item_id
       LEFT JOIN production_run_output_allocations proa ON proa.run_output_id = pro.id AND proa.packaging_level_id IS NOT NULL
       WHERE po.id = ?`,
      [orderId]
    );
    const row = poRes.rows[0];
    const target = (row?.packaging_level_id && Number(row?.package_count) > 0)
      ? Number(row.package_count)
      : Number(row?.target_quantity || 0);
    const sumRes = await client.query('SELECT COALESCE(SUM(quantity_produced), 0) AS total FROM production_shift_logs WHERE order_id = ?', [orderId]);
    const total = Number(sumRes.rows[0]?.total || 0);
    let nextStatus = 'open';
    if (total >= target && target > 0) nextStatus = 'completed';
    else if (total > 0) nextStatus = 'in_progress';
    await client.query('UPDATE production_orders SET status = ?, updated_at = NOW() WHERE id = ?', [nextStatus, orderId]);
    await client.query(
      'UPDATE production_runs SET status = ?, updated_at = NOW() WHERE order_id = ? OR run_number = (SELECT order_number FROM production_orders WHERE id = ?)',
      [nextStatus, orderId, orderId]
    );
    return nextStatus;
  }

  const logsRes = await client.query(
    'SELECT COALESCE(item_id, ?) AS item_id, SUM(quantity_produced) AS total_produced FROM production_shift_logs WHERE order_id = ? GROUP BY COALESCE(item_id, ?)',
    [outputsRes.rows[0].item_id, orderId, outputsRes.rows[0].item_id]
  );
  const producedMap = {};
  let totalProducedAll = 0;
  for (const row of logsRes.rows) {
    producedMap[row.item_id] = Number(row.total_produced || 0);
    totalProducedAll += Number(row.total_produced || 0);
  }

  let allCompleted = true;
  for (const out of outputsRes.rows) {
    const produced = producedMap[out.item_id] || 0;
    const effectiveTarget = (out.packaging_level_id && Number(out.package_count) > 0)
      ? Number(out.package_count)
      : Number(out.target_quantity);
    if (produced < effectiveTarget) {
      allCompleted = false;
    }
  }

  let nextStatus = 'open';
  if (allCompleted && outputsRes.rows.length > 0) {
    nextStatus = 'completed';
  } else if (totalProducedAll > 0) {
    nextStatus = 'in_progress';
  }

  await client.query('UPDATE production_orders SET status = ?, updated_at = NOW() WHERE id = ?', [nextStatus, orderId]);
  await client.query(
    'UPDATE production_runs SET status = ?, updated_at = NOW() WHERE order_id = ? OR run_number = (SELECT order_number FROM production_orders WHERE id = ?)',
    [nextStatus, orderId, orderId]
  );
  return nextStatus;
}

// ─────────────────────────────────────────────────────────────────────────────
// LIST SHIFT LOGS FOR AN ORDER
// ─────────────────────────────────────────────────────────────────────────────
router.get('/production-orders/:id/shift-logs', requireAuth, requirePermission('shift_log', 'view'), async (req, res) => {
  try {
    const logsRes = await req.tenantDb.query(
      `SELECT psl.*,
              COALESCE(fg.name, i.name, po_fg.name, po_i.name) AS item_name,
              COALESCE(fg.unit, i.unit, psl.uom) AS item_unit,
              u.name AS logged_by_name
       FROM production_shift_logs psl
       JOIN production_orders po ON po.id = psl.order_id
       LEFT JOIN finished_goods fg ON fg.id = psl.item_id
       LEFT JOIN items i ON i.id = psl.item_id
       LEFT JOIN finished_goods po_fg ON po_fg.id = po.target_item_id
       LEFT JOIN items po_i ON po_i.id = po.target_item_id
       LEFT JOIN users u ON u.id = psl.created_by
       WHERE psl.order_id = ?
       ORDER BY psl.log_date DESC, psl.shift ASC, psl.created_at DESC`,
      [req.params.id]
    );
    return res.json(logsRes.rows);
  } catch (err) {
    console.error('list shift logs error', err);
    return res.status(500).json({ error: 'Failed to fetch shift logs' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADD SHIFT LOG (Staff - inventory updated with stock here!)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/production-orders/:id/shift-logs', requireAuth, requirePermission('shift_log', 'create'), async (req, res) => {
  const { log_date, shift, entries, quantity_produced, uom, item_id, notes } = req.body;

  if (!log_date) return res.status(400).json({ error: 'log_date is required' });
  const validShifts = ['morning', 'evening', 'night'];
  if (!shift || !validShifts.includes(shift)) {
    return res.status(400).json({ error: `shift must be one of: ${validShifts.join(', ')}` });
  }

  // Parse entries to log
  let itemsToLog = [];
  if (Array.isArray(entries) && entries.length > 0) {
    itemsToLog = entries
      .filter((e) => Number(e.quantity_produced) > 0)
      .map((e) => ({
        item_id: e.item_id,
        quantity_produced: Number(e.quantity_produced),
        uom: e.uom
      }));
  } else if (Number(quantity_produced) > 0) {
    itemsToLog = [{
      item_id: item_id || null,
      quantity_produced: Number(quantity_produced),
      uom: uom || null
    }];
  }

  if (itemsToLog.length === 0) {
    return res.status(400).json({ error: 'Please enter a positive production quantity for at least one finished product.' });
  }

  const userId = req.user.user_id || req.user.id;
  const client = await req.tenantDb.connect();

  try {
    await client.query('START TRANSACTION');

    // Check the order exists
    const orderRes = await client.query(
      `SELECT po.*, COALESCE(fg.name, i.name) AS target_item_name
       FROM production_orders po
       LEFT JOIN finished_goods fg ON fg.id = po.target_item_id
       LEFT JOIN items i ON i.id = po.target_item_id
       WHERE po.id = ? AND po.deleted_at IS NULL`,
      [req.params.id]
    );
    if (orderRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Production order not found' });
    }

    const order = orderRes.rows[0];
    if (order.status === 'completed' || order.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Cannot add shift log to a ${order.status} order` });
    }

    const baseRunNumber = (order.order_number || '').replace(/-[0-9]+$/, '');
    const shiftLabel = shift.charAt(0).toUpperCase() + shift.slice(1);
    const createdLogs = [];

    for (const item of itemsToLog) {
      const resolvedItemId = item.item_id || order.target_item_id;

      // Determine unit cost
      let unitCost = 0;
      const costRes = await client.query(
        `SELECT pro.unit_cost, pro.allocated_cost, pro.base_quantity, pro.quantity_produced
         FROM production_run_outputs pro
         JOIN production_runs pr ON pr.id = pro.run_id
         WHERE (pr.order_id = ? OR pr.run_number = ? OR pr.run_number = ?) AND pro.item_id = ?
         ORDER BY pro.created_at DESC LIMIT 1`,
        [order.id, order.order_number, baseRunNumber, resolvedItemId]
      );
      if (costRes.rowCount > 0) {
        const row = costRes.rows[0];
        const baseQty = Number(row.base_quantity) || Number(row.quantity_produced) || 1;
        unitCost = Number(row.allocated_cost) > 0 ? Number(row.allocated_cost) / baseQty : Number(row.unit_cost) || 0;
      } else {
        const fgCost = await client.query('SELECT default_cost FROM finished_goods WHERE id = ?', [resolvedItemId]);
        if (fgCost.rowCount > 0 && fgCost.rows[0].default_cost) {
          unitCost = Number(fgCost.rows[0].default_cost);
        }
      }

      // Fetch item name & base uom
      const nameRes = await client.query(
        'SELECT name, unit FROM finished_goods WHERE id = ? UNION SELECT name, unit FROM items WHERE id = ? LIMIT 1',
        [resolvedItemId, resolvedItemId]
      );
      const itemName = nameRes.rows[0]?.name || order.target_item_name || 'Finished Product';
      const itemUom = item.uom || nameRes.rows[0]?.unit || order.target_uom || 'unit';

      // Check packaging configuration & conversion to base units for warehouse inventory
      let unitsPerPackage = 1;
      let baseUnit = nameRes.rows[0]?.unit || 'unit';

      const pkgInfoRes = await client.query(
        `SELECT pro.packaging_level_id, pro.units_per_package, pro.packaging_name,
                ppl.package_unit, ppl.base_quantity_equivalent, fg.unit AS fg_unit
         FROM production_run_outputs pro
         JOIN production_runs pr ON pr.id = pro.run_id
         LEFT JOIN product_packaging_levels ppl ON ppl.id = pro.packaging_level_id
         LEFT JOIN finished_goods fg ON fg.id = pro.item_id
         WHERE (pr.order_id = ? OR pr.run_number = ? OR pr.run_number = ?) AND pro.item_id = ?
         ORDER BY pro.created_at DESC LIMIT 1`,
        [order.id, order.order_number, baseRunNumber, resolvedItemId]
      );

      let pkgRow = null;
      if (pkgInfoRes.rowCount > 0) {
        pkgRow = pkgInfoRes.rows[0];
        unitsPerPackage = Number(pkgRow.base_quantity_equivalent || pkgRow.units_per_package || 1);
        if (pkgRow.fg_unit) baseUnit = pkgRow.fg_unit;
      } else {
        const directPkg = await client.query(
          `SELECT id AS packaging_level_id, package_unit, base_quantity_equivalent, level_name AS packaging_name
           FROM product_packaging_levels
           WHERE product_id = ? 
             AND (LOWER(package_unit) = LOWER(?) OR LOWER(level_name) = LOWER(?))
           LIMIT 1`,
          [resolvedItemId, itemUom, itemUom]
        );
        if (directPkg.rowCount > 0) {
          pkgRow = directPkg.rows[0];
          unitsPerPackage = Number(pkgRow.base_quantity_equivalent || 1);
        }
      }

      // If logged in packaging unit or packaging is defined with conversion factor > 1
      const isPackaged = unitsPerPackage > 1 || (itemUom.toLowerCase() !== baseUnit.toLowerCase());
      const inventoryQuantity = (isPackaged && unitsPerPackage > 1)
        ? Number(item.quantity_produced) * unitsPerPackage
        : Number(item.quantity_produced);

      // 1. Insert into production_shift_logs (Stored in the exact unit logged, e.g. Katta)
      const logId = crypto.randomUUID();
      await client.query(
        `INSERT INTO production_shift_logs (id, order_id, item_id, log_date, shift, quantity_produced, uom, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [logId, req.params.id, resolvedItemId, log_date, shift, item.quantity_produced, itemUom, notes || null, userId]
      );

      // 2. Insert into inventory_ledger (Stock increases in base unit, e.g. kg / Lts!)
      const ledgerId = crypto.randomUUID();
      const reasonText = (isPackaged && unitsPerPackage > 1)
        ? `Shift output: ${shiftLabel} shift (${item.quantity_produced} ${itemUom} = ${inventoryQuantity} ${baseUnit}) of ${itemName} for Order ${order.order_number}`
        : `Shift output: ${shiftLabel} shift (${item.quantity_produced} ${itemUom}) of ${itemName} for Order ${order.order_number}`;

      const resolvedPkgLevelId = pkgRow?.packaging_level_id || null;
      const packageCount = resolvedPkgLevelId ? Number(item.quantity_produced) : null;

      await client.query(
        `INSERT INTO inventory_ledger
           (id, item_type, item_id, location_id, packaging_level_id, package_count, transaction_type, quantity, unit_cost, reason, reference_table, reference_id, date, created_by)
         VALUES (?, 'finished_good', ?, ?, ?, ?, 'in', ?, ?, ?, 'production_shift_logs', ?, ?, ?)`,
        [
          ledgerId,
          resolvedItemId,
          order.location_id,
          resolvedPkgLevelId,
          packageCount,
          inventoryQuantity,
          unitCost,
          reasonText,
          logId,
          log_date,
          userId
        ]
      );

      createdLogs.push({ id: logId, item_id: resolvedItemId, item_name: itemName, quantity_produced: item.quantity_produced, uom: itemUom });
    }

    // 3. Auto-update order status
    const nextStatus = await recalculateOrderStatus(client, req.params.id);

    await client.query('COMMIT');

    return res.status(201).json({
      success: true,
      message: `Successfully logged shift output for ${createdLogs.length} finished product(s)`,
      shift_logs: createdLogs,
      order_status: nextStatus
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('add shift log error', err);
    return res.status(500).json({ error: 'Failed to add shift log: ' + err.message });
  } finally {
    client.release();
  }
});

// Helper: Enforce shift_log delete permission or workspace administrator
async function requireShiftLogDelete(req, res, next) {
  const userRoles = Array.isArray(req.user?.roles) ? req.user.roles : [req.user?.role || ''];
  const isAdmin = userRoles.includes('owner') || userRoles.includes('admin') || req.user?.role === 'owner' || req.user?.role === 'admin';
  if (isAdmin) return next();

  try {
    const placeholders = userRoles.map(() => '?').join(',');
    const permRes = await req.tenantDb.query(
      `SELECT MAX(can_delete) AS allowed FROM role_permissions WHERE role IN (${placeholders}) AND module IN ('shift_log', 'production')`,
      userRoles
    );
    if (permRes.rows[0]?.allowed === 1 || permRes.rows[0]?.allowed === true) return next();
    return res.status(403).json({ error: 'Forbidden: Insufficient permissions to delete shift production logs.' });
  } catch (err) {
    console.error('requireShiftLogDelete error:', err);
    return res.status(500).json({ error: 'Failed to verify delete permissions' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE SHIFT LOG (Direct by Shift Log ID - Reverses inventory_ledger addition)
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/production-shift-logs/:id', requireAuth, requirePermission('shift_log', 'delete'), async (req, res) => {
  const client = await req.tenantDb.connect();
  try {
    await client.query('START TRANSACTION');

    // 1. Fetch shift log to verify existence and get order_id & quantity
    const logRes = await client.query(
      'SELECT * FROM production_shift_logs WHERE id = ?',
      [req.params.id]
    );
    if (logRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shift log not found' });
    }
    const log = logRes.rows[0];

    // 2. Remove from inventory_ledger (Stock addition reversed!)
    await client.query(
      "DELETE FROM inventory_ledger WHERE reference_table = 'production_shift_logs' AND reference_id = ?",
      [req.params.id]
    );

    // 3. Delete the shift log record
    await client.query(
      'DELETE FROM production_shift_logs WHERE id = ?',
      [req.params.id]
    );

    // 4. Recompute status using multi-output aware logic
    const nextStatus = await recalculateOrderStatus(client, log.order_id);

    await client.query('COMMIT');
    return res.json({
      deleted: true,
      message: 'Shift log deleted and inventory reversed successfully',
      deleted_id: req.params.id,
      order_id: log.order_id,
      quantity_deducted: Number(log.quantity_produced || 0),
      order_status: nextStatus
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('delete shift log error', err);
    return res.status(500).json({ error: 'Failed to delete shift log: ' + err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE SHIFT LOG (By Order & Log ID - Reverses inventory_ledger addition)
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/production-orders/:orderId/shift-logs/:logId', requireAuth, requirePermission('shift_log', 'delete'), async (req, res) => {
  const client = await req.tenantDb.connect();
  try {
    await client.query('START TRANSACTION');

    // 1. Fetch shift log to verify existence
    const logRes = await client.query(
      'SELECT * FROM production_shift_logs WHERE id = ? AND order_id = ?',
      [req.params.logId, req.params.orderId]
    );
    if (logRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shift log not found' });
    }
    const log = logRes.rows[0];

    // 2. Remove from inventory_ledger (Stock addition reversed!)
    await client.query(
      "DELETE FROM inventory_ledger WHERE reference_table = 'production_shift_logs' AND reference_id = ?",
      [req.params.logId]
    );

    // 3. Delete the shift log record
    await client.query(
      'DELETE FROM production_shift_logs WHERE id = ? AND order_id = ?',
      [req.params.logId, req.params.orderId]
    );

    // 4. Recompute status using multi-output aware logic
    const nextStatus = await recalculateOrderStatus(client, req.params.orderId);

    await client.query('COMMIT');
    return res.json({
      deleted: true,
      message: 'Shift log deleted and inventory reversed successfully',
      deleted_id: req.params.logId,
      order_id: req.params.orderId,
      quantity_deducted: Number(log.quantity_produced || 0),
      order_status: nextStatus
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('delete shift log error', err);
    return res.status(500).json({ error: 'Failed to delete shift log: ' + err.message });
  } finally {
    client.release();
  }
});

module.exports = router;

