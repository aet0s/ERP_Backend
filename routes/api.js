const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const { queryMaster } = require('../db/masterDb');
const {
  numeric,
  todayIso,
  paymentStatus,
  toCSV,
  getBatchCostContext,
  getInventorySnapshot,
  getLocationAwareInventoryAlerts
} = require('../lib/analytics');
const { calculateInvoiceLine, calculateInvoiceTotals, getNextDocumentNumber, syncNumberingSeries } = require('../lib/invoiceEngine');
const { logTenantAudit, verifyTenantAuditChain } = require('../lib/auditCrypto');

const STAFF_ENTRY_TABLES = new Set(['procurements', 'production_batches', 'sales', 'expenses']);
const MASTER_TABLES = {
  raw_materials: 'raw_materials',
  process_stages: 'process_stages',
  finished_goods: 'finished_goods',
  vendors: 'vendors',
  customers: 'customers'
};

function isTableRequest(req) {
  return Boolean(req.query.table || req.query.page || req.query.page_size || req.query.search || req.query.sort_by);
}

router.use('/reports', require('./reports'));
router.get('/reorder-suggestions', requireAuth, requirePermission('reports', 'view'), require('./reports').handleReorderSuggestions);

function pageParams(req) {
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const requested = parseInt(req.query.page_size || req.query.limit || '20', 10) || 20;
  const pageSize = [10, 20, 25, 50, 100].includes(requested) ? requested : 20;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function sortClause(req, allowed, fallback) {
  const key = String(req.query.sort_by || fallback.key);
  const direction = String(req.query.sort_order || fallback.direction || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  return {
    sql: allowed[key] || allowed[fallback.key],
    direction,
    key
  };
}

function pushParam(params, value) {
  params.push(value);
  return '?';
}

function addSearch(where, params, search, fields) {
  if (!search) return;
  const term = `%${String(search).trim()}%`;
  where.push(`(${fields.map((field) => {
    params.push(term);
    return `${field} LIKE ?`;
  }).join(' OR ')})`);
}

function addDateFilter(where, params, tableAlias) {
  if (params.reqStart) where.push(`${tableAlias}.date >= ${pushParam(params.values, params.reqStart)}`);
  if (params.reqEnd) where.push(`${tableAlias}.date <= ${pushParam(params.values, params.reqEnd)}`);
}

function withPaymentStatus(row) {
  if (!row) return row;
  const total = numeric(row.total_amount);
  const paid = numeric(row.amount_paid !== undefined ? row.amount_paid : row.amount_received);
  const due = row.amount_due !== undefined ? numeric(row.amount_due) : (total - paid);
  
  let status = 'Unpaid';
  if (due <= 0.01 || (total > 0 && paid >= total - 0.01)) {
    status = 'Paid';
  } else if (paid > 0) {
    status = 'Partially Paid';
  }

  return {
    ...row,
    amount_due: due,
    status
  };
}

async function audit(client, req, action, entityType, entityId, metadata = {}) {
  try {
    const userId = req.user?.user_id || req.user?.id || null;
    await logTenantAudit(client, {
      user_id: userId,
      action,
      entity_type: entityType,
      entity_id: entityId || null,
      metadata
    });
  } catch (err) {
    console.warn('[AUDIT WARNING] Failed to insert audit log:', err.message);
  }
}

async function touchWorkspace(client, workspaceId) {
  try {
    await queryMaster('UPDATE companies SET last_activity_at = NOW() WHERE id = ?', [workspaceId]);
  } catch (err) {
    // ignore non-critical timing touch failure
  }
}

function requireManagerMutation(req, res, next) {
  if (req.user.role === 'staff') return res.status(403).json({ error: 'Staff users can create entries only' });
  return next();
}

function sendList(req, res, rows, total, summary = {}) {
  if (!isTableRequest(req)) return res.json(rows);
  const { page, pageSize } = pageParams(req);
  return res.json({
    items: rows,
    meta: {
      page,
      page_size: pageSize,
      total: Number(total || 0),
      total_pages: Math.max(1, Math.ceil(Number(total || 0) / pageSize))
    },
    summary
  });
}

function validateNonNegative(value, label, { required = true } = {}) {
  if (!required && (value === null || typeof value === 'undefined' || value === '')) return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: `${label} must be a non-negative number` };
  return { ok: true, value: n };
}

function validatePositive(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: `${label} must be a positive number` };
  return { ok: true, value: n };
}

async function ensureWorkspaceRecord(client, table, id, extra = '') {
  const result = await client.query(
    `SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL ${extra}`,
    [id]
  );
  return result.rows[0] || null;
}

async function stockForItem(client, itemType, itemId) {
  const result = await client.query(
    `SELECT COALESCE(SUM(CASE
       WHEN transaction_type = 'in' THEN quantity
       WHEN transaction_type = 'out' THEN -quantity
       ELSE quantity
     END),0) AS current_stock
     FROM inventory_ledger
     WHERE item_type = ? AND item_id = ?`,
    [itemType, itemId]
  );
  return numeric(result.rows[0]?.current_stock);
}

async function detailTimeline(tenantDb, referenceTable, referenceId) {
  const [ledger, payments] = await Promise.all([
    tenantDb.query(
      `SELECT id, item_type, item_id, transaction_type, quantity, unit_cost, reason, date, created_at
       FROM inventory_ledger
       WHERE reference_table = ? AND reference_id = ?
       ORDER BY date DESC, created_at DESC`,
      [referenceTable, referenceId]
    ),
    tenantDb.query(
      `SELECT id, related_type, related_id, amount, date, notes, created_at
       FROM payments_log
       WHERE related_id = ? AND deleted_at IS NULL
       ORDER BY date DESC, created_at DESC`,
      [referenceId]
    )
  ]);
  return [...ledger.rows.map((row) => ({ kind: 'inventory', ...row })), ...payments.rows.map((row) => ({ kind: 'payment', ...row }))].sort(
    (a, b) => new Date(b.date || b.created_at).getTime() - new Date(a.date || a.created_at).getTime()
  );
}

async function reverseLedgerForDeletedRecord(client, req, table, record) {
  const userId = req.user.user_id || req.user.id;
  if (table === 'procurements') {
    // Only reverse inventory ledger if physical goods were actually marked as Received!
    if (record.status === 'Received') {
      let lines = [];
      try {
        const piRes = await client.query(
          'SELECT item_id, quantity, rate_per_unit FROM procurement_items WHERE procurement_id = ?',
          [record.id]
        );
        if (piRes.rows && piRes.rows.length > 0) {
          lines = piRes.rows.map((pi) => ({ item_id: pi.item_id, quantity: Number(pi.quantity) }));
        }
      } catch (e) {
        // procurement_items table may not exist in very old schemas — fall through to legacy
      }

      // Legacy fallback: use header raw_material_id + quantity if no line items found
      if (lines.length === 0 && record.raw_material_id) {
        lines = [{ item_id: record.raw_material_id, quantity: Number(record.quantity) }];
      }

      for (const line of lines) {
        if (!line.item_id || !line.quantity) continue;
        const id = crypto.randomUUID();
        await client.query(
          `INSERT INTO inventory_ledger (id, item_type, item_id, transaction_type, quantity, reference_table, reference_id, reason, created_by)
           VALUES (?, 'raw_material', ?, 'out', ?, 'procurements', ?, 'Soft delete reversal', ?)`,
          [id, line.item_id, line.quantity, record.id, userId]
        );
      }
    }
  }
  if (table === 'sales') {
    // Mirror exact outbound ledger entries created by this sale so packaging, base units, and locations match 1:1
    const origLedger = await client.query(
      `SELECT item_type, item_id, quantity, unit_cost, location_id, packaging_level_id, package_count 
       FROM inventory_ledger 
       WHERE reference_table = 'sales' AND reference_id = ? AND transaction_type = 'out'`,
      [record.id]
    );

    if (origLedger.rows && origLedger.rows.length > 0) {
      for (const entry of origLedger.rows) {
        const id = crypto.randomUUID();
        await client.query(
          `INSERT INTO inventory_ledger (id, item_type, item_id, location_id, packaging_level_id, package_count, transaction_type, quantity, unit_cost, reference_table, reference_id, reason, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 'in', ?, ?, 'sales', ?, 'Soft delete reversal', ?)`,
          [id, entry.item_type, entry.item_id, entry.location_id, entry.packaging_level_id || null, entry.package_count || null, entry.quantity, entry.unit_cost, record.id, userId]
        );
      }
    } else {
      // Legacy fallback if no previous ledger rows exist
      let lines = [];
      try {
        const siRes = await client.query(
          'SELECT finished_good_id, quantity, units_per_package FROM sales_items WHERE sale_id = ?',
          [record.id]
        );
        if (siRes.rows && siRes.rows.length > 0) {
          lines = siRes.rows.map((si) => {
            const unitsPerPkg = Number(si.units_per_package) > 0 ? Number(si.units_per_package) : 1;
            return { item_id: si.finished_good_id, quantity: Number(si.quantity) * unitsPerPkg };
          });
        }
      } catch (e) {
        // fall through to legacy
      }

      if (lines.length === 0 && record.finished_good_id) {
        lines = [{ item_id: record.finished_good_id, quantity: Number(record.quantity) }];
      }

      for (const line of lines) {
        if (!line.item_id || !line.quantity) continue;
        const id = crypto.randomUUID();
        await client.query(
          `INSERT INTO inventory_ledger (id, item_type, item_id, transaction_type, quantity, reference_table, reference_id, reason, created_by)
           VALUES (?, 'finished_good', ?, 'in', ?, 'sales', ?, 'Soft delete reversal', ?)`,
          [id, line.item_id, line.quantity, record.id, userId]
        );
      }
    }
  }
  if (table === 'production_batches') {
    if (record.input_quantity > 0) {
      const inputType = record.input_material_type === 'raw_material' ? 'raw_material' : 'wip';
      const id1 = crypto.randomUUID();
      await client.query(
        `INSERT INTO inventory_ledger (id, item_type, item_id, transaction_type, quantity, reference_table, reference_id, reason, created_by)
         VALUES (?, ?, ?, 'in', ?, 'production_batches', ?, 'Soft delete reversal', ?)`,
        [id1, inputType, record.input_reference_id || null, record.input_quantity, record.id, userId]
      );
    }
    if (record.output_quantity > 0) {
      const outputType = record.finished_good_id ? 'finished_good' : 'wip';
      const outputId = record.finished_good_id || record.id;
      const id2 = crypto.randomUUID();
      await client.query(
        `INSERT INTO inventory_ledger (id, item_type, item_id, transaction_type, quantity, reference_table, reference_id, reason, created_by)
         VALUES (?, ?, ?, 'out', ?, 'production_batches', ?, 'Soft delete reversal', ?)`,
        [id2, outputType, outputId, record.output_quantity, record.id, userId]
      );
    }
  }
}

// Workspace details (queried from Master DB)
router.get('/workspace', requireAuth, requirePermission('settings', 'view'), async (req, res) => {
  const companyId = req.user.company_id || req.user.workspace_id;
  const result = await queryMaster(
    `SELECT c.id, c.company_name AS name, c.company_code, c.connect_code, c.business_type, c.currency, c.number_system, c.plan, c.status, c.logo_url, c.accent_color, c.gstin, c.state, c.pan, c.support_email, c.support_phone,
            c.address, c.city, c.pincode, c.bank_name, c.bank_account_name, c.bank_account_number, c.bank_ifsc, c.bank_branch,
            c.onboarding_completed_at, c.created_at,
            COALESCE(c.support_email, (SELECT cu.email FROM company_users cu WHERE cu.company_id = c.id AND cu.role = 'owner' LIMIT 1), 'support@platform.in') AS contact_email,
            COALESCE(c.support_phone, '+91 (800) 123-4567') AS contact_phone
     FROM companies c WHERE c.id = ?`,
    [companyId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'workspace not found' });
  return res.json(result.rows[0]);
});

router.put('/workspace', requireAuth, requirePermission('settings', 'edit'), async (req, res) => {
  const {
    name, business_type, currency, number_system, logo_url, accent_color, gstin, state, pan,
    support_email, support_phone, phone, email,
    address, city, pincode,
    bank_name, bank_account_name, bank_account_number, bank_ifsc, bank_branch,
    onboarding_completed, rounding_method, invoice_prefix, reset_period, connect_code
  } = req.body;
  const companyId = req.user.company_id || req.user.workspace_id;
  try {
    if (connect_code && connect_code.trim()) {
      const cleanCode = connect_code.trim().toUpperCase();
      const existCheck = await queryMaster(
        'SELECT id FROM companies WHERE (UPPER(connect_code) = ? OR UPPER(company_code) = ?) AND id != ?',
        [cleanCode, cleanCode, companyId]
      );
      if (existCheck.rowCount > 0) {
        return res.status(400).json({ error: 'This Connect Code is already in use by another workspace.' });
      }
    }

    const finalEmail = email || support_email || null;
    const finalPhone = phone || support_phone || null;
    const cleanNumberSystem = number_system === 'international' ? 'international' : (number_system === 'indian' ? 'indian' : null);

    await queryMaster(
      `UPDATE companies
       SET company_name = COALESCE(?, company_name),
           business_type = COALESCE(?, business_type),
           currency = COALESCE(?, currency),
           number_system = COALESCE(?, number_system),
           logo_url = COALESCE(?, logo_url),
           accent_color = COALESCE(?, accent_color),
           gstin = COALESCE(?, gstin),
           state = COALESCE(?, state),
           pan = COALESCE(?, pan),
           support_email = COALESCE(?, support_email),
           support_phone = COALESCE(?, support_phone),
           address = COALESCE(?, address),
           city = COALESCE(?, city),
           pincode = COALESCE(?, pincode),
           bank_name = COALESCE(?, bank_name),
           bank_account_name = COALESCE(?, bank_account_name),
           bank_account_number = COALESCE(?, bank_account_number),
           bank_ifsc = COALESCE(?, bank_ifsc),
           bank_branch = COALESCE(?, bank_branch),
           connect_code = COALESCE(?, connect_code),
           onboarding_completed_at = CASE WHEN ? THEN COALESCE(onboarding_completed_at, NOW()) ELSE onboarding_completed_at END,
           last_activity_at = NOW()
       WHERE id = ?`,
      [
        name || null,
        business_type || null,
        currency || null,
        cleanNumberSystem,
        logo_url || null,
        accent_color || null,
        gstin || null,
        state || null,
        pan || null,
        finalEmail,
        finalPhone,
        address || null,
        city || null,
        pincode || null,
        bank_name || null,
        bank_account_name || null,
        bank_account_number || null,
        bank_ifsc ? bank_ifsc.trim().toUpperCase() : null,
        bank_branch || null,
        connect_code ? connect_code.trim().toUpperCase() : null,
        !!onboarding_completed ? 1 : 0,
        companyId
      ]
    );

    const result = await queryMaster(
      `SELECT id, company_name AS name, company_code, connect_code, business_type, currency, number_system, plan, status, logo_url, accent_color, gstin, state, pan, support_email, support_phone,
              address, city, pincode, bank_name, bank_account_name, bank_account_number, bank_ifsc, bank_branch, onboarding_completed_at
       FROM companies WHERE id = ?`,
      [companyId]
    );

    if (invoice_prefix || reset_period) {
      await req.tenantDb.query(
        `UPDATE numbering_series
         SET prefix = COALESCE(?, prefix),
             reset_period = COALESCE(?, reset_period),
             updated_at = NOW()
         WHERE document_type = 'invoice'`,
        [invoice_prefix || null, reset_period || null]
      ).catch(() => {});
    }

    if (rounding_method) {
      process.env.INVOICE_ROUNDING_METHOD = rounding_method;
    }

    await audit(req.tenantDb, req, 'update', 'workspace', companyId, { fields: Object.keys(req.body) });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('workspace update error', err);
    return res.status(500).json({ error: 'Failed to update workspace' });
  }
});

// GET /api/numbering-series/next/:type — Preview next auto-generated code
router.get('/numbering-series/next/:type', requireAuth, async (req, res) => {
  try {
    const docType = String(req.params.type || '').toLowerCase();
    const nextCode = await getNextDocumentNumber(req.tenantDb, docType, true);
    return res.json({
      document_type: docType,
      next_code: nextCode
    });
  } catch (err) {
    console.error('get next numbering code error', err);
    return res.status(500).json({ error: 'Failed to retrieve next sequence code' });
  }
});

// GET /workspace/connection-requests — Incoming Partner Proposals
router.get('/workspace/connection-requests', requireAuth, async (req, res) => {
  const companyId = req.user.company_id || req.user.workspace_id;
  try {
    const result = await queryMaster(
      `SELECT 
        gpm.id,
        gpm.global_user_id,
        gpm.company_id,
        gpm.entity_id,
        gpm.portal_type,
        gpm.status,
        gpm.initiated_by,
        gpm.notes,
        gpm.created_at,
        gpu.email,
        gpu.name,
        gpu.phone,
        gpu.company_name AS partner_business_name,
        gpu.gstin,
        gpu.address,
        gpu.city,
        gpu.state,
        gpu.pincode,
        gpu.business_type
       FROM global_portal_memberships gpm
       JOIN global_portal_users gpu ON gpu.id = gpm.global_user_id
       WHERE gpm.company_id = ?
       ORDER BY gpm.created_at DESC`,
      [companyId]
    );
    return res.json({ ok: true, requests: result.rows });
  } catch (err) {
    console.error('get workspace connection requests error:', err);
    return res.status(500).json({ error: 'Failed to fetch connection requests' });
  }
});

// POST /workspace/connection-requests/:id/accept — Accept Partner Proposal
router.post('/workspace/connection-requests/:id/accept', requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const companyId = req.user.company_id || req.user.workspace_id;
  const requestId = req.params.id;

  try {
    const memRes = await queryMaster(
      `SELECT gpm.*, gpu.name, gpu.email, gpu.phone, gpu.company_name AS partner_business_name, gpu.gstin, gpu.address, gpu.city, gpu.state, gpu.pincode, gpu.password_hash
       FROM global_portal_memberships gpm
       JOIN global_portal_users gpu ON gpu.id = gpm.global_user_id
       WHERE gpm.id = ? AND gpm.company_id = ?`,
      [requestId, companyId]
    );

    if (memRes.rowCount === 0) {
      return res.status(404).json({ error: 'Connection request not found' });
    }

    const membership = memRes.rows[0];

    // 1. Update Master Membership to Active
    await queryMaster(
      `UPDATE global_portal_memberships
       SET status = 'Active', joined_at = NOW()
       WHERE id = ?`,
      [requestId]
    );

    // 2. Sync / Update Tenant Database Records
    if (membership.portal_type === 'vendor') {
      await req.tenantDb.query(
        `UPDATE vendors
         SET connection_status = 'active', status = 'Active', global_user_id = ?
         WHERE id = ?`,
        [membership.global_user_id, membership.entity_id]
      ).catch(() => {});

      // Sync local user credentials if needed
      const existingUser = await req.tenantDb.query(
        'SELECT id FROM vendor_portal_users WHERE vendor_id = ? AND email = ?',
        [membership.entity_id, membership.email]
      );
      if (existingUser.rowCount === 0) {
        await req.tenantDb.query(
          `INSERT INTO vendor_portal_users (id, vendor_id, name, email, password_hash, status)
           VALUES (?, ?, ?, ?, ?, 'Active')`,
          [crypto.randomUUID(), membership.entity_id, membership.name, membership.email, membership.password_hash]
        ).catch(() => {});
      } else {
        await req.tenantDb.query(
          `UPDATE vendor_portal_users SET status = 'Active', password_hash = COALESCE(?, password_hash) WHERE id = ?`,
          [membership.password_hash, existingUser.rows[0].id]
        ).catch(() => {});
      }
    } else {
      await req.tenantDb.query(
        `UPDATE customers
         SET connection_status = 'active', status = 'Active', global_user_id = ?
         WHERE id = ?`,
        [membership.global_user_id, membership.entity_id]
      ).catch(() => {});

      const existingUser = await req.tenantDb.query(
        'SELECT id FROM customer_portal_users WHERE customer_id = ? AND email = ?',
        [membership.entity_id, membership.email]
      );
      if (existingUser.rowCount === 0) {
        await req.tenantDb.query(
          `INSERT INTO customer_portal_users (id, customer_id, name, email, password_hash, status)
           VALUES (?, ?, ?, ?, ?, 'Active')`,
          [crypto.randomUUID(), membership.entity_id, membership.name, membership.email, membership.password_hash]
        ).catch(() => {});
      } else {
        await req.tenantDb.query(
          `UPDATE customer_portal_users SET status = 'Active', password_hash = COALESCE(?, password_hash) WHERE id = ?`,
          [membership.password_hash, existingUser.rows[0].id]
        ).catch(() => {});
      }
    }

    await audit(req.tenantDb, req, 'approve', 'partner_connection', requestId, { partner: membership.email, type: membership.portal_type });

    return res.json({
      ok: true,
      message: `Partner connection request approved successfully! ${membership.partner_business_name || membership.name} is now actively connected.`
    });
  } catch (err) {
    console.error('accept connection request error:', err);
    return res.status(500).json({ error: 'Failed to accept connection request: ' + err.message });
  }
});

// POST /workspace/connection-requests/:id/decline — Decline Partner Proposal
router.post('/workspace/connection-requests/:id/decline', requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const companyId = req.user.company_id || req.user.workspace_id;
  const requestId = req.params.id;

  try {
    const memRes = await queryMaster(
      `SELECT gpm.*, gpu.email
       FROM global_portal_memberships gpm
       JOIN global_portal_users gpu ON gpu.id = gpm.global_user_id
       WHERE gpm.id = ? AND gpm.company_id = ?`,
      [requestId, companyId]
    );

    if (memRes.rowCount === 0) {
      return res.status(404).json({ error: 'Connection request not found' });
    }

    const membership = memRes.rows[0];

    await queryMaster(
      `UPDATE global_portal_memberships
       SET status = 'Declined'
       WHERE id = ?`,
      [requestId]
    );

    if (membership.portal_type === 'vendor') {
      await req.tenantDb.query(
        `UPDATE vendors SET connection_status = 'declined' WHERE id = ?`,
        [membership.entity_id]
      ).catch(() => {});
    } else {
      await req.tenantDb.query(
        `UPDATE customers SET connection_status = 'declined' WHERE id = ?`,
        [membership.entity_id]
      ).catch(() => {});
    }

    await audit(req.tenantDb, req, 'decline', 'partner_connection', requestId, { partner: membership.email });

    return res.json({
      ok: true,
      message: 'Partner connection request has been declined.'
    });
  } catch (err) {
    console.error('decline connection request error:', err);
    return res.status(500).json({ error: 'Failed to decline connection request' });
  }
});

router.get('/global-search', requireAuth, async (req, res) => {
  const rawQ = String(req.query.q || '').trim();
  if (!rawQ) return res.json([]);
  const q = `%${rawQ}%`;

  const results = [];
  const tenantDb = req.tenantDb;

  // 1. Static Navigation / Quick Page matches
  const pages = [
    { title: 'Dashboard', subtitle: 'Overview, KPIs & Analytics', category: 'page', badge: 'Page', link: '/' },
    { title: 'Product Catalog', subtitle: 'Items, recipes & pricing', category: 'page', badge: 'Page', link: '/catalog' },
    { title: 'Sales & Invoices', subtitle: 'Orders, dispatch & billing', category: 'page', badge: 'Page', link: '/sales' },
    { title: 'Procurement & POs', subtitle: 'Purchase orders & vendor bills', category: 'page', badge: 'Page', link: '/procurement' },
    { title: 'Inventory & Stock Ledger', subtitle: 'Valuation, low stock & transfers', category: 'page', badge: 'Page', link: '/inventory' },
    { title: 'Production Management', subtitle: 'Runs, formulas & batch tracking', category: 'page', badge: 'Page', link: '/production' },
    { title: 'Shift Logs', subtitle: 'Daily operator shift entries', category: 'page', badge: 'Page', link: '/shift-logs' },
    { title: 'Customers & Vendors', subtitle: 'Parties, contacts & ledgers', category: 'page', badge: 'Page', link: '/people' },
    { title: 'Executive Reports', subtitle: 'P&L, sales, tax & audits', category: 'page', badge: 'Page', link: '/reports' },
    { title: 'Locations & Warehouses', subtitle: 'Multi-warehouse facilities', category: 'page', badge: 'Page', link: '/locations' },
    { title: 'Settings & Users', subtitle: 'Company profile, team & permissions', category: 'page', badge: 'Page', link: '/settings' },
    { title: 'Billing & Plan', subtitle: 'Subscription & usage details', category: 'page', badge: 'Page', link: '/billing' }
  ];

  const matchedPages = pages.filter(p => 
    p.title.toLowerCase().includes(rawQ.toLowerCase()) || 
    p.subtitle.toLowerCase().includes(rawQ.toLowerCase())
  );
  results.push(...matchedPages.slice(0, 3));

  try {
    // 2. Unified Items & Catalog (products, raw materials, WIP)
    const itemsRes = await tenantDb.query(
      `SELECT id, name, code, item_type, unit, COALESCE(default_price, last_purchase_price, 0) AS price
       FROM (
         SELECT id, name, code, item_type, unit, default_price, last_purchase_price FROM items WHERE deleted_at IS NULL
         UNION ALL
         SELECT id, name, NULL AS code, 'finished_good' AS item_type, unit, default_price, NULL AS last_purchase_price FROM finished_goods WHERE deleted_at IS NULL AND id NOT IN (SELECT id FROM items WHERE deleted_at IS NULL)
         UNION ALL
         SELECT id, name, NULL AS code, 'raw_material' AS item_type, unit, 0 AS default_price, 0 AS last_purchase_price FROM raw_materials WHERE deleted_at IS NULL AND id NOT IN (SELECT id FROM items WHERE deleted_at IS NULL)
       ) u
       WHERE name LIKE ? OR (code IS NOT NULL AND code LIKE ?)
       LIMIT 6`,
      [q, q]
    ).catch(() => ({ rows: [] }));

    for (const item of itemsRes.rows) {
      const typeLabel = item.item_type ? item.item_type.replace('_', ' ').toUpperCase() : 'PRODUCT';
      const parts = [];
      if (item.code) parts.push(`Code: ${item.code}`);
      parts.push(`Type: ${typeLabel}`);
      if (item.unit) parts.push(`Unit: ${item.unit}`);
      if (Number(item.price) > 0) parts.push(`₹${Number(item.price).toLocaleString('en-IN')}`);
      results.push({
        id: item.id,
        category: 'product',
        badge: typeLabel,
        title: item.name,
        subtitle: parts.join(' • '),
        link: `/catalog?search=${encodeURIComponent(item.name)}`
      });
    }

    // 3. Customers
    const custRes = await tenantDb.query(
      `SELECT id, name, customer_code, contact_person_name, phone, email, city, gstin, pan
       FROM customers
       WHERE deleted_at IS NULL AND (name LIKE ? OR customer_code LIKE ? OR contact_person_name LIKE ? OR phone LIKE ? OR email LIKE ? OR gstin LIKE ? OR pan LIKE ?)
       LIMIT 5`,
      [q, q, q, q, q, q, q]
    ).catch(() => ({ rows: [] }));

    for (const c of custRes.rows) {
      const parts = ['Customer'];
      if (c.customer_code) parts.push(c.customer_code);
      if (c.phone) parts.push(c.phone);
      if (c.city) parts.push(c.city);
      if (c.gstin) parts.push(`GST: ${c.gstin}`);
      results.push({
        id: c.id,
        category: 'customer',
        badge: 'Customer',
        title: c.name,
        subtitle: parts.join(' • '),
        link: `/people?tab=customers&search=${encodeURIComponent(c.name)}`
      });
    }

    // 4. Vendors
    const vendRes = await tenantDb.query(
      `SELECT id, name, vendor_code, contact_person_name, phone, email, city, gstin, pan
       FROM vendors
       WHERE deleted_at IS NULL AND (name LIKE ? OR vendor_code LIKE ? OR contact_person_name LIKE ? OR phone LIKE ? OR email LIKE ? OR gstin LIKE ? OR pan LIKE ?)
       LIMIT 5`,
      [q, q, q, q, q, q, q]
    ).catch(() => ({ rows: [] }));

    for (const v of vendRes.rows) {
      const parts = ['Vendor'];
      if (v.vendor_code) parts.push(v.vendor_code);
      if (v.phone) parts.push(v.phone);
      if (v.city) parts.push(v.city);
      if (v.gstin) parts.push(`GST: ${v.gstin}`);
      results.push({
        id: v.id,
        category: 'vendor',
        badge: 'Vendor',
        title: v.name,
        subtitle: parts.join(' • '),
        link: `/people?tab=vendors&search=${encodeURIComponent(v.name)}`
      });
    }

    // 5. Sales & Invoices
    const salesRes = await tenantDb.query(
      `SELECT s.id, s.invoice_number, s.date, s.total_amount, s.payment_status, c.name AS customer_name
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       WHERE s.deleted_at IS NULL AND (s.invoice_number LIKE ? OR c.name LIKE ? OR s.id LIKE ?)
       ORDER BY s.date DESC
       LIMIT 5`,
      [q, q, q]
    ).catch(() => ({ rows: [] }));

    for (const s of salesRes.rows) {
      const invoiceNo = s.invoice_number || `Sale #${s.id.slice(0, 8)}`;
      const dateStr = s.date ? new Date(s.date).toISOString().slice(0, 10) : '';
      const parts = [];
      if (s.customer_name) parts.push(s.customer_name);
      if (s.total_amount) parts.push(`₹${Number(s.total_amount).toLocaleString('en-IN')}`);
      if (s.payment_status) parts.push(s.payment_status);
      if (dateStr) parts.push(dateStr);
      results.push({
        id: s.id,
        category: 'sale',
        badge: 'Invoice',
        title: invoiceNo,
        subtitle: parts.join(' • '),
        link: `/sales?search=${encodeURIComponent(s.invoice_number || s.customer_name || s.id)}`
      });
    }

    // 6. Procurement & Purchase Orders
    const procRes = await tenantDb.query(
      `SELECT p.id, p.invoice_number, p.po_number, p.date, p.total_amount, p.status, v.name AS vendor_name
       FROM procurements p
       LEFT JOIN vendors v ON v.id = p.vendor_id
       WHERE p.deleted_at IS NULL AND (p.invoice_number LIKE ? OR p.po_number LIKE ? OR v.name LIKE ? OR p.id LIKE ?)
       ORDER BY p.date DESC
       LIMIT 5`,
      [q, q, q, q]
    ).catch(() => ({ rows: [] }));

    for (const p of procRes.rows) {
      const docNo = p.po_number || p.invoice_number || `PO #${p.id.slice(0, 8)}`;
      const dateStr = p.date ? new Date(p.date).toISOString().slice(0, 10) : '';
      const parts = [];
      if (p.vendor_name) parts.push(p.vendor_name);
      if (p.total_amount) parts.push(`₹${Number(p.total_amount).toLocaleString('en-IN')}`);
      if (p.status) parts.push(p.status);
      if (dateStr) parts.push(dateStr);
      results.push({
        id: p.id,
        category: 'procurement',
        badge: 'PO / Bill',
        title: docNo,
        subtitle: parts.join(' • '),
        link: `/procurement?search=${encodeURIComponent(p.po_number || p.invoice_number || p.vendor_name || p.id)}`
      });
    }

    // 7. Production Runs
    const runsRes = await tenantDb.query(
      `SELECT pr.id, pr.run_number, pr.date, pr.status, pr.notes
       FROM production_runs pr
       WHERE pr.deleted_at IS NULL AND (pr.run_number LIKE ? OR pr.notes LIKE ? OR pr.id LIKE ?)
       ORDER BY pr.date DESC
       LIMIT 4`,
      [q, q, q]
    ).catch(() => ({ rows: [] }));

    for (const r of runsRes.rows) {
      const dateStr = r.date ? new Date(r.date).toISOString().slice(0, 10) : '';
      const parts = ['Production Run', r.status || 'Completed'];
      if (dateStr) parts.push(dateStr);
      if (r.notes) parts.push(r.notes.slice(0, 30));
      results.push({
        id: r.id,
        category: 'production',
        badge: 'Run',
        title: r.run_number || `Run #${r.id.slice(0, 8)}`,
        subtitle: parts.join(' • '),
        link: `/production?search=${encodeURIComponent(r.run_number || r.id)}`
      });
    }

    // 8. Shift Logs
    const shiftRes = await tenantDb.query(
      `SELECT psl.id, psl.shift, psl.log_date, psl.quantity_produced, psl.uom, psl.notes
       FROM production_shift_logs psl
       WHERE (psl.shift LIKE ? OR psl.notes LIKE ? OR psl.id LIKE ?)
       ORDER BY psl.log_date DESC
       LIMIT 4`,
      [q, q, q]
    ).catch(() => ({ rows: [] }));

    for (const s of shiftRes.rows) {
      const dateStr = s.log_date ? new Date(s.log_date).toISOString().slice(0, 10) : '';
      const parts = [`Shift: ${s.shift || 'General'}`];
      if (Number(s.quantity_produced) > 0) parts.push(`Produced: ${s.quantity_produced} ${s.uom || ''}`);
      if (dateStr) parts.push(dateStr);
      results.push({
        id: s.id,
        category: 'shift_log',
        badge: 'Shift Log',
        title: `Shift Entry - ${s.shift || 'Log'} (${dateStr})`,
        subtitle: parts.join(' • '),
        link: `/shift-logs?search=${encodeURIComponent(s.shift || dateStr)}`
      });
    }

    // 9. Locations & Warehouses
    const locRes = await tenantDb.query(
      `SELECT id, name, city, state, is_default
       FROM locations
       WHERE deleted_at IS NULL AND (name LIKE ? OR city LIKE ? OR state LIKE ?)
       LIMIT 4`,
      [q, q, q]
    ).catch(() => ({ rows: [] }));

    for (const l of locRes.rows) {
      const parts = [l.is_default ? 'Main / HQ' : 'Warehouse'];
      if (l.city) parts.push(l.city);
      if (l.state) parts.push(l.state);
      results.push({
        id: l.id,
        category: 'location',
        badge: 'Location',
        title: l.name,
        subtitle: parts.join(' • '),
        link: `/locations`
      });
    }

    // 10. Users & Team
    const userRes = await tenantDb.query(
      `SELECT id, name, email, role
       FROM users
       WHERE deleted_at IS NULL AND (name LIKE ? OR email LIKE ? OR role LIKE ?)
       LIMIT 4`,
      [q, q, q]
    ).catch(() => ({ rows: [] }));

    for (const u of userRes.rows) {
      const parts = [u.role ? u.role.toUpperCase() : 'TEAM MEMBER'];
      if (u.email) parts.push(u.email);
      results.push({
        id: u.id,
        category: 'user',
        badge: 'User',
        title: u.name,
        subtitle: parts.join(' • '),
        link: `/settings?tab=users&search=${encodeURIComponent(u.name)}`
      });
    }
  } catch (err) {
    console.error('global-search error:', err);
  }

  return res.json(results);
});

// Master Table CRUD Helpers
function registerMasterTable(routerPath, table, searchFields, sortMapping) {
  router.get(`/${routerPath}`, requireAuth, async (req, res) => {
    const params = [];
    const where = ['deleted_at IS NULL'];
    addSearch(where, params, req.query.search, searchFields);
    const sort = sortClause(req, sortMapping, { key: 'name', direction: 'asc' });

    if (!isTableRequest(req)) {
      const rows = await req.tenantDb.query(
        `SELECT * FROM ${table} WHERE ${where.join(' AND ')} ORDER BY ${sort.sql} ${sort.direction}`,
        params
      );
      return res.json(rows.rows || []);
    }

    const { pageSize, offset } = pageParams(req);
    const count = await req.tenantDb.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where.join(' AND ')}`, params);
    const queryParams = [...params];
    const rows = await req.tenantDb.query(
      `SELECT * FROM ${table} WHERE ${where.join(' AND ')} ORDER BY ${sort.sql} ${sort.direction} LIMIT ? OFFSET ?`,
      [...queryParams, pageSize, offset]
    );
    const total = (count && count.rows && count.rows[0]) ? Number(count.rows[0].count || count.rows[0]['COUNT(*)'] || 0) : 0;
    const rowList = (rows && rows.rows) ? rows.rows : [];
    return sendList(req, res, rowList, total);
  });

  router.get(`/${routerPath}/:id`, requireAuth, async (req, res) => {
    const record = await req.tenantDb.query(`SELECT * FROM ${table} WHERE id=? AND deleted_at IS NULL`, [req.params.id]);
    if (record.rowCount === 0) return res.status(404).json({ error: 'not found' });
    return res.json(record.rows[0]);
  });
}

registerMasterTable('raw-materials', 'raw_materials', ['name', 'unit'], { name: 'name', reorder_level: 'reorder_level' });

router.get('/finished-goods', requireAuth, async (req, res) => {
  try {
    const params = [];
    const where = ['fg.deleted_at IS NULL'];
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      where.push(`fg.name LIKE ?`);
    }

    const fgStockSub = `COALESCE((SELECT SUM(CASE WHEN il.transaction_type = 'in' THEN il.quantity ELSE -il.quantity END) FROM inventory_ledger il WHERE il.item_type = 'finished_good' AND il.item_id = fg.id), 0)`;

    if (req.query.stock_status === 'in_stock') {
      where.push(`${fgStockSub} > 0`);
    } else if (req.query.stock_status === 'low_stock') {
      where.push(`${fgStockSub} <= fg.reorder_level AND fg.reorder_level IS NOT NULL AND fg.reorder_level > 0`);
    } else if (req.query.stock_status === 'out_of_stock') {
      where.push(`${fgStockSub} <= 0`);
    }

    // Get total count first
    const countRes = await req.tenantDb.query(
      `SELECT COUNT(*) AS count FROM finished_goods fg WHERE ${where.join(' AND ')}`,
      params
    );
    const total = Number(countRes.rows[0]?.count || countRes.rows[0]?.['COUNT(*)'] || 0);

    // Pagination
    const isTable = isTableRequest(req);
    const { pageSize, offset } = pageParams(req);
    const queryParams = [...params];
    let mainQuery = `
      SELECT fg.*,
        ${fgStockSub} AS available_stock,
        ${fgStockSub} AS current_stock
      FROM finished_goods fg
      WHERE ${where.join(' AND ')}
      ORDER BY fg.name ASC
    `;
    if (isTable || req.query.page || req.query.limit) {
      mainQuery += ` LIMIT ? OFFSET ?`;
      queryParams.push(pageSize, offset);
    }

    const result = await req.tenantDb.query(mainQuery, queryParams);

    const fgIds = result.rows.map((r) => r.id);
    if (fgIds.length > 0) {
      const placeholders = fgIds.map(() => '?').join(',');
      const [levelsRes, pkgStockRes, looseStockRes] = await Promise.all([
        req.tenantDb.query(
          `SELECT ppl.*, 
                  parent.name AS parent_package_name, 
                  parent.package_unit AS parent_package_unit,
                  parent.base_quantity_equivalent AS parent_base_quantity_equivalent
           FROM product_packaging_levels ppl
           LEFT JOIN product_packaging_levels parent ON parent.id = ppl.parent_level_id
           WHERE ppl.product_id IN (${placeholders}) AND ppl.status != 'archived'
           ORDER BY ppl.base_quantity_equivalent ASC, ppl.created_at ASC`,
          fgIds
        ).catch(() => ({ rows: [] })),
        req.tenantDb.query(
          `SELECT 
             item_id,
             packaging_level_id,
             COALESCE(SUM(
               CASE WHEN transaction_type = 'in' THEN COALESCE(package_count, 0)
                    WHEN transaction_type = 'out' THEN -COALESCE(package_count, 0)
                    ELSE 0 END
             ), 0) AS packaged_stock
           FROM inventory_ledger
           WHERE item_type = 'finished_good' AND item_id IN (${placeholders}) AND packaging_level_id IS NOT NULL
           GROUP BY item_id, packaging_level_id`,
          fgIds
        ).catch(() => ({ rows: [] })),
        req.tenantDb.query(
          `SELECT 
             item_id,
             COALESCE(SUM(
               CASE WHEN transaction_type = 'in' THEN quantity
                    WHEN transaction_type = 'out' THEN -quantity
                    ELSE 0 END
             ), 0) AS loose_stock
           FROM inventory_ledger
           WHERE item_type = 'finished_good' AND item_id IN (${placeholders}) AND packaging_level_id IS NULL
           GROUP BY item_id`,
          fgIds
        ).catch(() => ({ rows: [] }))
      ]);

      const pkgStockMap = {};
      for (const ps of pkgStockRes.rows) {
        pkgStockMap[`${ps.item_id}:${ps.packaging_level_id}`] = Math.max(0, Number(ps.packaged_stock || 0));
      }

      const looseStockMap = {};
      for (const ls of looseStockRes.rows) {
        looseStockMap[ls.item_id] = Math.max(0, Number(ls.loose_stock || 0));
      }

      const levelMap = {};
      for (const l of levelsRes.rows) {
        if (!levelMap[l.product_id]) levelMap[l.product_id] = [];
        const availPkgStock = pkgStockMap[`${l.product_id}:${l.id}`] ?? 0;
        l.available_stock = availPkgStock;
        levelMap[l.product_id].push(l);
      }

      for (const row of result.rows) {
        const levels = levelMap[row.id] || [];
        row.loose_stock = looseStockMap[row.id] ?? 0;
        row.packaging_levels = levels;
        // Provide packaging_configs alias for backwards compatibility
        row.packaging_configs = levels.map((l) => ({
          id: l.id,
          product_id: l.product_id,
          product_type: l.product_type,
          package_name: l.name,
          package_unit: l.package_unit,
          units_per_package: l.base_quantity_equivalent,
          fill_quantity: l.contains_quantity,
          fill_unit: l.contains_unit,
          parent_config_id: l.parent_level_id,
          mrp: l.mrp,
          selling_price: l.selling_price,
          barcode: l.barcode,
          is_default: l.is_default,
          available_stock: l.available_stock,
          notes: l.notes
        }));
      }
    } else {
      for (const row of result.rows) {
        row.loose_stock = 0;
        row.packaging_levels = [];
        row.packaging_configs = [];
      }
    }

    return sendList(req, res, result.rows, total);
  } catch (err) {
    console.error('get finished goods error', err);
    return res.status(500).json({ error: 'Failed to fetch finished goods' });
  }
});


registerMasterTable('vendors', 'vendors', ['name', 'contact', 'address'], { name: 'name' });
registerMasterTable('customers', 'customers', ['name', 'contact', 'address'], { name: 'name' });

router.get('/process-stages', requireAuth, async (req, res) => {
  const result = await req.tenantDb.query('SELECT * FROM process_stages WHERE deleted_at IS NULL ORDER BY sequence_order ASC');
  return res.json(result.rows);
});

router.post('/raw-materials', requireAuth, requirePermission('catalog', 'create'), async (req, res) => {
  try {
    const { name, unit, reorder_level } = req.body;
    if (!name || !unit) return res.status(400).json({ error: 'name and unit required' });
    const id = crypto.randomUUID();
    await req.tenantDb.query(
      `INSERT INTO raw_materials (id, name, unit, reorder_level) VALUES (?,?,?,?)`,
      [id, name, unit, reorder_level || null]
    );
    const fetched = await req.tenantDb.query('SELECT * FROM raw_materials WHERE id = ?', [id]);
    const record = (fetched && fetched.rows && fetched.rows[0]) ? fetched.rows[0] : { id, name, unit, reorder_level: reorder_level || null };
    await audit(req.tenantDb, req, 'create', 'raw_material', id);
    return res.status(201).json(record);
  } catch (err) {
    console.error('POST /raw-materials error:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
});

router.put('/raw-materials/:id', requireAuth, requirePermission('catalog', 'edit'), async (req, res) => {
  const { name, unit, reorder_level } = req.body;
  const updateRes = await req.tenantDb.query(
    `UPDATE raw_materials SET name=COALESCE(?,name), unit=COALESCE(?,unit), reorder_level=?, updated_at=NOW() WHERE id=? AND deleted_at IS NULL`,
    [name || null, unit || null, typeof reorder_level === 'undefined' ? null : reorder_level, req.params.id]
  );
  if (updateRes.rowCount === 0) return res.status(404).json({ error: 'not found' });
  const fetched = await req.tenantDb.query('SELECT * FROM raw_materials WHERE id = ?', [req.params.id]);
  await audit(req.tenantDb, req, 'update', 'raw_material', req.params.id);
  return res.json(fetched.rows[0]);
});

router.delete('/raw-materials/:id', requireAuth, requirePermission('catalog', 'delete'), async (req, res) => {
  const userId = req.user.user_id || req.user.id;
  const updateRes = await req.tenantDb.query(`UPDATE raw_materials SET deleted_at=NOW(), deleted_by=? WHERE id=? AND deleted_at IS NULL`, [userId, req.params.id]);
  if (updateRes.rowCount === 0) return res.status(404).json({ error: 'not found' });
  await audit(req.tenantDb, req, 'delete', 'raw_material', req.params.id);
  return res.json({ deleted: true });
});

router.post('/process-stages', requireAuth, requirePermission('catalog', 'create'), async (req, res) => {
  const { name, sequence_order, is_final_stage } = req.body;
  if (!name || sequence_order === undefined) return res.status(400).json({ error: 'name and sequence_order required' });
  try {
    const id = crypto.randomUUID();
    await req.tenantDb.query(
      `INSERT INTO process_stages (id, name, sequence_order, is_final_stage) VALUES (?,?,?,?)`,
      [id, name, sequence_order, is_final_stage ? 1 : 0]
    );
    const fetched = await req.tenantDb.query('SELECT * FROM process_stages WHERE id = ?', [id]);
    await audit(req.tenantDb, req, 'create', 'process_stage', id);
    return res.status(201).json(fetched.rows[0]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' || err.code === '23505') return res.status(400).json({ error: 'sequence_order must be unique' });
    throw err;
  }
});

router.put('/process-stages/:id', requireAuth, requirePermission('catalog', 'edit'), async (req, res) => {
  const { name, sequence_order, is_final_stage } = req.body;
  const updateRes = await req.tenantDb.query(
    `UPDATE process_stages SET name=COALESCE(?,name), sequence_order=COALESCE(?,sequence_order), is_final_stage=COALESCE(?,is_final_stage), updated_at=NOW() WHERE id=? AND deleted_at IS NULL`,
    [name || null, sequence_order ?? null, is_final_stage !== undefined ? (is_final_stage ? 1 : 0) : null, req.params.id]
  );
  if (updateRes.rowCount === 0) return res.status(404).json({ error: 'not found' });
  const fetched = await req.tenantDb.query('SELECT * FROM process_stages WHERE id = ?', [req.params.id]);
  await audit(req.tenantDb, req, 'update', 'process_stage', req.params.id);
  return res.json(fetched.rows[0]);
});

router.delete('/process-stages/:id', requireAuth, requirePermission('catalog', 'delete'), async (req, res) => {
  const userId = req.user.user_id || req.user.id;
  const updateRes = await req.tenantDb.query(`UPDATE process_stages SET deleted_at=NOW(), deleted_by=? WHERE id=? AND deleted_at IS NULL`, [userId, req.params.id]);
  if (updateRes.rowCount === 0) return res.status(404).json({ error: 'not found' });
  await audit(req.tenantDb, req, 'delete', 'process_stage', req.params.id);
  return res.json({ deleted: true });
});

router.post('/finished-goods', requireAuth, requirePermission('catalog', 'create'), async (req, res) => {
  const { name, unit, default_price, reorder_level, hsn_code, tax_rate } = req.body;
  if (!name || !unit) return res.status(400).json({ error: 'name and unit required' });
  try {
    const id = crypto.randomUUID();
    await req.tenantDb.query(
      `INSERT INTO finished_goods (id, name, unit, default_price, reorder_level, hsn_code, tax_rate) VALUES (?,?,?,?,?,?,?)`,
      [
        id,
        name,
        unit,
        default_price || null,
        reorder_level || null,
        hsn_code ? hsn_code.trim().toUpperCase() : null,
        tax_rate != null && tax_rate !== '' ? Number(tax_rate) : 18.00
      ]
    );
    const fetched = await req.tenantDb.query('SELECT * FROM finished_goods WHERE id = ?', [id]);
    await audit(req.tenantDb, req, 'create', 'finished_good', id);
    return res.status(201).json(fetched.rows[0]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' || err.code === '23505') return res.status(400).json({ error: 'finished good name must be unique' });
    throw err;
  }
});

router.put('/finished-goods/:id', requireAuth, requirePermission('catalog', 'edit'), async (req, res) => {
  const { name, unit, default_price, base_selling_price, reorder_level, hsn_code, tax_rate } = req.body;
  const effectiveBasePrice = typeof base_selling_price !== 'undefined' ? Number(base_selling_price) : (typeof default_price !== 'undefined' ? Number(default_price) : undefined);

  const updateRes = await req.tenantDb.query(
    `UPDATE finished_goods SET
       name = COALESCE(?, name),
       unit = COALESCE(?, unit),
       default_price = ?,
       base_selling_price = COALESCE(?, base_selling_price),
       reorder_level = ?,
       hsn_code = COALESCE(?, hsn_code),
       tax_rate = COALESCE(?, tax_rate),
       updated_at = NOW()
     WHERE id = ? AND deleted_at IS NULL`,
    [
      name || null,
      unit || null,
      typeof default_price === 'undefined' ? null : default_price,
      effectiveBasePrice !== undefined ? effectiveBasePrice : null,
      typeof reorder_level === 'undefined' ? null : reorder_level,
      typeof hsn_code === 'undefined' ? null : (hsn_code ? hsn_code.trim().toUpperCase() : null),
      typeof tax_rate === 'undefined' ? null : (tax_rate != null && tax_rate !== '' ? Number(tax_rate) : null),
      req.params.id
    ]
  );
  if (updateRes.rowCount === 0) return res.status(404).json({ error: 'not found' });

  // If base selling price was updated, recalculate all active packaging levels for this product
  if (effectiveBasePrice !== undefined && effectiveBasePrice >= 0) {
    const levelsRes = await req.tenantDb.query(
      'SELECT id, base_quantity_equivalent FROM product_packaging_levels WHERE product_id = ? AND status != "archived"',
      [req.params.id]
    );
    for (const lvl of levelsRes.rows) {
      const newPrice = Math.round((effectiveBasePrice * Number(lvl.base_quantity_equivalent || 1)) * 100) / 100;
      await req.tenantDb.query(
        'UPDATE product_packaging_levels SET selling_price = ?, updated_at = NOW() WHERE id = ?',
        [newPrice, lvl.id]
      );
    }
  }

  const fetched = await req.tenantDb.query('SELECT * FROM finished_goods WHERE id = ?', [req.params.id]);
  await audit(req.tenantDb, req, 'update', 'finished_good', req.params.id);
  return res.json(fetched.rows[0]);
});

router.delete('/finished-goods/:id', requireAuth, requirePermission('catalog', 'delete'), async (req, res) => {
  const userId = req.user.user_id || req.user.id;
  const updateRes = await req.tenantDb.query(`UPDATE finished_goods SET deleted_at=NOW(), deleted_by=? WHERE id=? AND deleted_at IS NULL`, [userId, req.params.id]);
  if (updateRes.rowCount === 0) return res.status(404).json({ error: 'not found' });
  await audit(req.tenantDb, req, 'delete', 'finished_good', req.params.id);
  return res.json({ deleted: true });
});

router.post('/vendors', requireAuth, requirePermission('parties', 'create'), async (req, res) => {
  const { name, contact, address, bank_account_name, bank_account_number, bank_ifsc, vendor_code } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = crypto.randomUUID();
  const code = vendor_code && String(vendor_code).trim()
    ? String(vendor_code).trim().toUpperCase()
    : await getNextDocumentNumber(req.tenantDb, 'vendor');
  await syncNumberingSeries(req.tenantDb, 'vendor', code);

  await req.tenantDb.query(
    `INSERT INTO vendors (id, name, contact, address, bank_account_name, bank_account_number, bank_ifsc, vendor_code) VALUES (?,?,?,?,?,?,?,?)`,
    [id, name, contact || null, address || null, bank_account_name || null, bank_account_number || null, bank_ifsc || null, code]
  );
  const fetched = await req.tenantDb.query('SELECT * FROM vendors WHERE id = ?', [id]);
  await audit(req.tenantDb, req, 'create', 'vendor', id);
  return res.status(201).json(fetched.rows[0]);
});

router.put('/vendors/:id', requireAuth, requirePermission('parties', 'edit'), async (req, res) => {
  const { name, contact, address, bank_account_name, bank_account_number, bank_ifsc, vendor_code } = req.body;
  const updateRes = await req.tenantDb.query(
    `UPDATE vendors SET name=COALESCE(?,name), contact=?, address=?, bank_account_name=?, bank_account_number=?, bank_ifsc=?, vendor_code=COALESCE(?, vendor_code), updated_at=NOW() WHERE id=? AND deleted_at IS NULL`,
    [name || null, contact || null, address || null, bank_account_name || null, bank_account_number || null, bank_ifsc || null, vendor_code ? vendor_code.trim().toUpperCase() : null, req.params.id]
  );
  if (updateRes.rowCount === 0) return res.status(404).json({ error: 'not found' });
  const fetched = await req.tenantDb.query('SELECT * FROM vendors WHERE id = ?', [req.params.id]);
  await audit(req.tenantDb, req, 'update', 'vendor', req.params.id);
  return res.json(fetched.rows[0]);
});

router.delete('/vendors/:id', requireAuth, requirePermission('parties', 'delete'), async (req, res) => {
  const userId = req.user.user_id || req.user.id;
  const updateRes = await req.tenantDb.query(`UPDATE vendors SET deleted_at=NOW(), deleted_by=? WHERE id=? AND deleted_at IS NULL`, [userId, req.params.id]);
  if (updateRes.rowCount === 0) return res.status(404).json({ error: 'not found' });
  await audit(req.tenantDb, req, 'delete', 'vendor', req.params.id);
  return res.json({ deleted: true });
});

router.post('/customers', requireAuth, requirePermission('parties', 'create'), async (req, res) => {
  const { name, contact, address, customer_code } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = crypto.randomUUID();
  const code = customer_code && String(customer_code).trim()
    ? String(customer_code).trim().toUpperCase()
    : await getNextDocumentNumber(req.tenantDb, 'customer');
  await syncNumberingSeries(req.tenantDb, 'customer', code);

  await req.tenantDb.query(`INSERT INTO customers (id, name, contact, address, customer_code) VALUES (?,?,?,?,?)`, [id, name, contact || null, address || null, code]);
  const fetched = await req.tenantDb.query('SELECT * FROM customers WHERE id = ?', [id]);
  await audit(req.tenantDb, req, 'create', 'customer', id);
  return res.status(201).json(fetched.rows[0]);
});

router.put('/customers/:id', requireAuth, requirePermission('parties', 'edit'), async (req, res) => {
  const { name, contact, address, customer_code } = req.body;
  const updateRes = await req.tenantDb.query(
    `UPDATE customers SET name=COALESCE(?,name), contact=?, address=?, customer_code=COALESCE(?, customer_code), updated_at=NOW() WHERE id=? AND deleted_at IS NULL`,
    [name || null, contact || null, address || null, customer_code ? customer_code.trim().toUpperCase() : null, req.params.id]
  );
  if (updateRes.rowCount === 0) return res.status(404).json({ error: 'not found' });
  const fetched = await req.tenantDb.query('SELECT * FROM customers WHERE id = ?', [req.params.id]);
  await audit(req.tenantDb, req, 'update', 'customer', req.params.id);
  return res.json(fetched.rows[0]);
});

router.delete('/customers/:id', requireAuth, requirePermission('parties', 'delete'), async (req, res) => {
  const userId = req.user.user_id || req.user.id;
  const updateRes = await req.tenantDb.query(`UPDATE customers SET deleted_at=NOW(), deleted_by=? WHERE id=? AND deleted_at IS NULL`, [userId, req.params.id]);
  if (updateRes.rowCount === 0) return res.status(404).json({ error: 'not found' });
  await audit(req.tenantDb, req, 'delete', 'customer', req.params.id);
  return res.json({ deleted: true });
});

// NOTE (Part A): Legacy single-item procurement routes retired.
// GET /procurements and POST /procurements are now handled exclusively by
// routes/procurementRedesign.js which supports multi-line procurements
// and vendor-optional procurement entry.
//
// The routes below (GET /:id, PUT /:id, DELETE /:id) remain and continue
// to handle individual procurement record operations (including the
// multi-line ledger reversal fix from Part 0).

router.get('/procurements/:id', requireAuth, async (req, res) => {
  try {
    const record = await req.tenantDb.query(
      `SELECT p.*, v.name AS vendor_name, v.vendor_code, v.gstin AS vendor_gstin,
              COALESCE(l.name, (SELECT name FROM locations WHERE is_default = 1 LIMIT 1), (SELECT name FROM locations LIMIT 1), 'Main Location') AS location_name,
              (SELECT COUNT(*) FROM procurement_items pi WHERE pi.procurement_id = p.id) AS item_count,
              (SELECT GROUP_CONCAT(DISTINCT COALESCE(i.name, rm.name, 'Item') SEPARATOR ', ') 
               FROM procurement_items pi 
               LEFT JOIN items i ON i.id = pi.item_id 
               LEFT JOIN raw_materials rm ON rm.id = pi.item_id 
               WHERE pi.procurement_id = p.id) AS item_names,
              (SELECT COALESCE(SUM(pi.quantity), 0) FROM procurement_items pi WHERE pi.procurement_id = p.id) AS total_item_quantity
       FROM procurements p
       LEFT JOIN vendors v ON v.id = p.vendor_id
       LEFT JOIN locations l ON l.id = p.location_id
       WHERE p.id = ? AND p.deleted_at IS NULL`,
      [req.params.id]
    );

    if (record.rowCount === 0) return res.status(404).json({ error: 'Procurement not found' });
    const r = record.rows[0];

    // Calculate true total amount including GST tax minus discount
    if (r.subtotal !== undefined && r.subtotal !== null && (Number(r.tax_amount) > 0 || Number(r.discount_amount) > 0 || Number(r.subtotal) > 0)) {
      r.total_amount = Number(r.subtotal || 0) + Number(r.tax_amount || 0) - Number(r.discount_amount || 0);
    } else if (!r.total_amount || Number(r.total_amount) === 0) {
      r.total_amount = Number(r.quantity || 0) * Number(r.rate_per_unit || 0);
    }

    r.amount_due = Math.max(0, Number(r.total_amount) - Number(r.amount_paid || 0));
    r.status = r.amount_due <= 0.01 ? 'Paid' : (Number(r.amount_paid) > 0 ? 'Partial' : 'Unpaid');

    // Fetch line items
    const itemsRes = await req.tenantDb.query(
      `SELECT pi.*, COALESCE(i.name, rm.name, 'Item') AS item_name, COALESCE(i.unit, rm.unit, 'unit') AS unit
       FROM procurement_items pi
       LEFT JOIN items i ON i.id = pi.item_id
       LEFT JOIN raw_materials rm ON rm.id = pi.item_id
       WHERE pi.procurement_id = ?`,
      [req.params.id]
    );
    r.items = itemsRes.rows;

    const timeline = await detailTimeline(req.tenantDb, 'procurements', req.params.id);
    return res.json({ ...r, timeline });
  } catch (err) {
    console.error('get procurement detail error', err);
    return res.status(500).json({ error: 'Failed to fetch procurement details' });
  }
});

router.put('/procurements/:id', requireAuth, requirePermission('procurement', 'edit'), async (req, res) => {
  const { vendor_id, raw_material_id, quantity, rate_per_unit, amount_paid, date, notes } = req.body;
  const client = await req.tenantDb.connect();
  const userId = req.user.user_id || req.user.id;
  try {
    await client.query('START TRANSACTION');
    const currentRes = await client.query('SELECT * FROM procurements WHERE id=? AND deleted_at IS NULL FOR UPDATE', [req.params.id]);
    if (currentRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }
    const current = currentRes.rows[0];
    const nextQty = typeof quantity === 'undefined' ? numeric(current.quantity) : numeric(quantity);
    const nextRate = typeof rate_per_unit === 'undefined' ? numeric(current.rate_per_unit) : numeric(rate_per_unit);
    const nextPaid = typeof amount_paid === 'undefined' ? numeric(current.amount_paid) : numeric(amount_paid);
    if (nextQty <= 0 || nextRate < 0 || nextPaid < 0 || nextPaid > nextQty * nextRate) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid procurement amounts' });
    }
    await client.query(
      `UPDATE procurements
       SET vendor_id=COALESCE(?,vendor_id), raw_material_id=COALESCE(?,raw_material_id), quantity=?,
           rate_per_unit=?, amount_paid=?, date=COALESCE(?,date), notes=COALESCE(?,notes), updated_at=NOW()
       WHERE id=?`,
      [vendor_id || null, raw_material_id || null, nextQty, nextRate, nextPaid, date || null, notes || null, req.params.id]
    );

    const fetchedProc = await client.query('SELECT * FROM procurements WHERE id = ?', [req.params.id]);

    await client.query(
      `UPDATE inventory_ledger SET item_id=?, quantity=?, unit_cost=?, date=?
       WHERE reference_table='procurements' AND reference_id=? AND transaction_type='in'`,
      [raw_material_id || current.raw_material_id, nextQty, nextRate, date || current.date, req.params.id]
    );
    if (nextPaid > numeric(current.amount_paid)) {
      const payId = crypto.randomUUID();
      await client.query(
        `INSERT INTO payments_log (id, related_type, related_id, amount, date, notes, created_by)
         VALUES (?,'procurement',?,?,?,'Payment adjustment from edit',?)`,
        [payId, req.params.id, nextPaid - numeric(current.amount_paid), date || new Date(), userId]
      );
    }
    await audit(client, req, 'update', 'procurement', req.params.id, req.body);
    await client.query('COMMIT');
    return res.json(withPaymentStatus(fetchedProc.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('update procurement error', err);
    return res.status(500).json({ error: 'update failed' });
  } finally {
    client.release();
  }
});

router.delete('/procurements/:id', requireAuth, requirePermission('procurement', 'delete'), async (req, res) => {
  const client = await req.tenantDb.connect();
  const userId = req.user.user_id || req.user.id;
  try {
    await client.query('START TRANSACTION');
    const current = await client.query('SELECT * FROM procurements WHERE id=? AND deleted_at IS NULL FOR UPDATE', [req.params.id]);
    if (current.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }
    await reverseLedgerForDeletedRecord(client, req, 'procurements', current.rows[0]);
    await client.query('UPDATE procurements SET deleted_at=NOW(), deleted_by=? WHERE id=?', [userId, req.params.id]);
    await client.query("UPDATE payments_log SET deleted_at=NOW(), deleted_by=? WHERE related_type='procurement' AND related_id=?", [userId, req.params.id]);
    await audit(client, req, 'delete', 'procurement', req.params.id);
    await client.query('COMMIT');
    return res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('delete procurement error', err);
    return res.status(500).json({ error: 'delete failed' });
  } finally {
    client.release();
  }
});

router.get('/production-input-options', requireAuth, async (req, res) => {
  const { process_stage_id } = req.query;
  const client = await req.tenantDb.connect();
  try {
    let stage = null;
    if (process_stage_id) {
      const stageRes = await client.query('SELECT * FROM process_stages WHERE id=? AND deleted_at IS NULL', [process_stage_id]);
      if (stageRes.rowCount > 0) stage = stageRes.rows[0];
    }

    const options = [];

    if (stage && stage.sequence_order > 1) {
      const prevStageRes = await client.query(
        'SELECT * FROM process_stages WHERE sequence_order = ? AND deleted_at IS NULL LIMIT 1',
        [stage.sequence_order - 1]
      );
      if (prevStageRes.rowCount > 0) {
        const prevStageId = prevStageRes.rows[0].id;
        const batchesRes = await client.query(
          `SELECT pb.id, pb.batch_number, pb.output_unit, ps.name AS stage_name
           FROM production_batches pb
           JOIN process_stages ps ON ps.id = pb.process_stage_id
           WHERE pb.process_stage_id = ? AND pb.deleted_at IS NULL
           ORDER BY pb.date DESC, pb.created_at DESC`,
          [prevStageId]
        );
        for (const b of batchesRes.rows) {
          const wipStock = await stockForItem(client, 'wip', b.id);
          options.push({
            id: b.id,
            name: `WIP: Batch #${b.batch_number} (${b.stage_name})`,
            input_material_type: 'previous_stage_output',
            available_stock: wipStock,
            unit: b.output_unit || 'kg'
          });
        }
      }
    }

    const rawRes = await client.query('SELECT * FROM raw_materials WHERE deleted_at IS NULL ORDER BY name ASC');
    for (const rm of rawRes.rows) {
      const stock = await stockForItem(client, 'raw_material', rm.id);
      options.push({
        id: rm.id,
        name: rm.name,
        input_material_type: 'raw_material',
        available_stock: stock,
        unit: rm.unit || 'kg'
      });
    }

    return res.json(options);
  } catch (err) {
    console.error('get production-input-options error', err);
    return res.status(500).json({ error: 'failed to fetch input options' });
  } finally {
    client.release();
  }
});

// Production Batches
router.get('/production-batches', requireAuth, async (req, res) => {
  const params = [];
  const where = ['pb.deleted_at IS NULL'];
  if (req.query.process_stage_id) where.push(`pb.process_stage_id = ${pushParam(params, req.query.process_stage_id)}`);
  if (req.query.finished_good_id) where.push(`pb.finished_good_id = ${pushParam(params, req.query.finished_good_id)}`);
  if (req.query.start_date) where.push(`pb.date >= ${pushParam(params, req.query.start_date)}`);
  if (req.query.end_date) where.push(`pb.date <= ${pushParam(params, req.query.end_date)}`);
  addSearch(where, params, req.query.search, ['pb.batch_number', 'ps.name', 'fg.name', 'rm.name', 'pb.notes']);
  const { pageSize, offset } = pageParams(req);
  const sort = sortClause(req, {
    date: 'pb.date',
    batch_number: 'pb.batch_number',
    stage_name: 'ps.name',
    product_name: 'fg.name',
    input_quantity: 'pb.input_quantity',
    output_quantity: 'pb.output_quantity',
    yield_percent: 'pb.yield_percent'
  }, { key: 'date', direction: 'desc' });
  const from = `production_batches pb
    JOIN process_stages ps ON ps.id=pb.process_stage_id
    LEFT JOIN finished_goods fg ON fg.id=pb.finished_good_id
    LEFT JOIN raw_materials rm ON pb.input_material_type='raw_material' AND rm.id=pb.input_reference_id
    LEFT JOIN production_batches prev ON pb.input_material_type='previous_stage_output' AND prev.id=pb.input_reference_id`;
  const count = await req.tenantDb.query(`SELECT COUNT(*) AS count FROM ${from} WHERE ${where.join(' AND ')}`, params);
  const rows = await req.tenantDb.query(
    `SELECT pb.id, pb.process_stage_id, ps.name AS stage_name, ps.sequence_order, ps.is_final_stage, pb.batch_number,
       pb.input_material_type, pb.input_reference_id,
       CASE
         WHEN pb.input_material_type='raw_material' THEN rm.name
         ELSE prev.batch_number
       END AS input_name,
       CASE
         WHEN pb.input_material_type='raw_material' THEN rm.name
         ELSE prev.batch_number
       END AS input_source_name,
       CASE
         WHEN pb.input_material_type='raw_material' THEN rm.unit
         ELSE prev.output_unit
       END AS input_unit,
       pb.input_quantity, pb.output_quantity, pb.output_unit, pb.wastage_quantity, pb.yield_percent,
       pb.labor_cost, pb.other_cost, pb.finished_good_id, fg.name AS finished_good_name, pb.date, pb.notes, pb.created_at,
       ps.stage_type,
       pb.packaging_config_id,
       COALESCE(pb.package_unit, pc.package_unit) AS package_unit,
       pb.total_packages,
       COALESCE(pb.fill_quantity, pc.fill_quantity, pc.units_per_package) AS fill_quantity,
       COALESCE(pb.fill_unit, pc.fill_unit) AS fill_unit,
       pb.packaging_material_cost,
       pc.package_name AS packaging_config_name
     FROM production_batches pb
     JOIN process_stages ps ON ps.id=pb.process_stage_id
     LEFT JOIN raw_materials rm ON (pb.input_material_type='raw_material' AND rm.id=pb.input_reference_id)
     LEFT JOIN production_batches prev ON (pb.input_material_type='previous_stage_output' AND prev.id=pb.input_reference_id)
     LEFT JOIN finished_goods fg ON fg.id=pb.finished_good_id
     LEFT JOIN packaging_configs pc ON pc.id=pb.packaging_config_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${sort.sql} ${sort.direction}
     LIMIT ${pushParam(params, pageSize)} OFFSET ${pushParam(params, offset)}`,
    params
  );
  const context = await getBatchCostContext(req.tenantDb);
  const rowsWithCost = rows.rows.map((row) => ({
    ...row,
    cost_per_unit: context.batchUnitCosts[row.id] || 0
  }));
  return sendList(req, res, rowsWithCost, count.rows[0].count);
});

router.post('/production-batches', requireAuth, requirePermission('production', 'create'), async (req, res) => {
  const {
    process_stage_id, batch_number, input_material_type, input_reference_id,
    input_quantity, output_quantity, output_unit, labor_cost = 0, other_cost = 0, packaging_material_cost = 0,
    finished_good_id, date, notes, allow_negative = false,
    packaging_config_id, package_unit, total_packages, units_per_package, fill_quantity, fill_unit
  } = req.body;

  if (!process_stage_id || !input_material_type || !output_unit) {
    return res.status(400).json({ error: 'process_stage_id, input_material_type and output_unit are required' });
  }
  const inQty = validateNonNegative(input_quantity, 'input_quantity');
  const outQty = validateNonNegative(output_quantity, 'output_quantity');
  const labor = validateNonNegative(labor_cost, 'labor_cost');
  const other = validateNonNegative(other_cost, 'other_cost');
  const pkgCost = validateNonNegative(packaging_material_cost, 'packaging_material_cost');
  if (!inQty.ok) return res.status(400).json({ error: inQty.error });
  if (!outQty.ok) return res.status(400).json({ error: outQty.error });
  if (!labor.ok) return res.status(400).json({ error: labor.error });
  if (!other.ok) return res.status(400).json({ error: other.error });

  const client = await req.tenantDb.connect();
  const userId = req.user.user_id || req.user.id;
  try {
    await client.query('START TRANSACTION');
    const stage = await ensureWorkspaceRecord(client, 'process_stages', process_stage_id);
    if (!stage) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'process_stage_id not found' });
    }
    const maxStageRes = await client.query('SELECT MAX(sequence_order) AS max_seq FROM process_stages WHERE deleted_at IS NULL');
    const maxSeq = Number(maxStageRes.rows[0]?.max_seq || 1);
    if ((stage.is_final_stage || stage.sequence_order >= maxSeq) && !finished_good_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'finished_good_id is required for final process stage' });
    }

    if (input_material_type === 'raw_material') {
      if (!input_reference_id || !(await ensureWorkspaceRecord(client, 'raw_materials', input_reference_id))) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'valid raw_material_id is required for raw_material input' });
      }
      const rawStock = await stockForItem(client, 'raw_material', input_reference_id);
      if (!allow_negative && inQty.value > rawStock) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Insufficient input raw material stock. Available: ${rawStock}, Requested: ${inQty.value}` });
      }
    } else if (input_material_type === 'previous_stage_output') {
      if (!input_reference_id || !(await ensureWorkspaceRecord(client, 'production_batches', input_reference_id))) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'valid previous production batch is required' });
      }
      const wipStock = await stockForItem(client, 'wip', input_reference_id);
      if (!allow_negative && inQty.value > wipStock) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Insufficient WIP stock from previous batch. Available: ${wipStock}, Requested: ${inQty.value}` });
      }
    } else {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'invalid input_material_type' });
    }

    let finalOutQty = outQty.value;
    const finalFillQty = Number(fill_quantity) || Number(units_per_package) || 1;
    const finalFillUnit = fill_unit || package_unit || output_unit;

    if ((!finalOutQty || finalOutQty === 0) && Number(total_packages) > 0) {
      finalOutQty = Number(total_packages) * finalFillQty;
    }

    const nextBatchNum = batch_number || `BATCH-${Date.now()}`;
    const batchId = crypto.randomUUID();

    await client.query(
      `INSERT INTO production_batches
         (id, process_stage_id, batch_number, input_material_type, input_reference_id, input_quantity, output_quantity, output_unit, labor_cost, other_cost, finished_good_id, date, notes, packaging_config_id, package_unit, total_packages, units_per_package, fill_quantity, fill_unit, packaging_material_cost)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        batchId, process_stage_id, nextBatchNum, input_material_type, input_reference_id, inQty.value, finalOutQty, output_unit, labor.value, other.value, finished_good_id || null, date || todayIso(), notes || null,
        packaging_config_id || null, package_unit || null, Number(total_packages) || 0, finalFillQty, finalFillQty, finalFillUnit, pkgCost.value
      ]
    );

    const fetchedBatch = await client.query('SELECT * FROM production_batches WHERE id = ?', [batchId]);
    const batch = fetchedBatch.rows[0];

    if (inQty.value > 0) {
      const inputItemType = input_material_type === 'raw_material' ? 'raw_material' : 'wip';
      const ledgerId1 = crypto.randomUUID();
      await client.query(
        `INSERT INTO inventory_ledger (id, item_type, item_id, transaction_type, quantity, reference_table, reference_id, date, created_by)
         VALUES (?,?,?,'out',?,'production_batches',?,?,?)`,
        [ledgerId1, inputItemType, input_reference_id, inQty.value, batch.id, date || new Date(), userId]
      );
    }

    if (outQty.value > 0) {
      const outputItemType = finished_good_id ? 'finished_good' : 'wip';
      const outputItemId = finished_good_id || batch.id;
      const ledgerId2 = crypto.randomUUID();
      await client.query(
        `INSERT INTO inventory_ledger (id, item_type, item_id, transaction_type, quantity, reference_table, reference_id, date, created_by)
         VALUES (?,?,?,'in',?,'production_batches',?,?,?)`,
        [ledgerId2, outputItemType, outputItemId, outQty.value, batch.id, date || new Date(), userId]
      );
    }

    await audit(client, req, 'create', 'production_batch', batch.id, { batch_number: batch.batch_number });
    await touchWorkspace(client, req.user.company_id || req.user.workspace_id);
    await client.query('COMMIT');
    return res.status(201).json(batch);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === 'ER_DUP_ENTRY' || err.code === '23505') return res.status(400).json({ error: 'batch_number must be unique' });
    console.error('create production batch error', err);
    return res.status(500).json({ error: 'Failed to create production batch' });
  } finally {
    client.release();
  }
});

router.get('/production-batches/:id', requireAuth, async (req, res) => {
  const record = await req.tenantDb.query(
    `SELECT pb.*, ps.name AS stage_name, fg.name AS finished_good_name
     FROM production_batches pb
     JOIN process_stages ps ON ps.id=pb.process_stage_id
     LEFT JOIN finished_goods fg ON fg.id=pb.finished_good_id
     WHERE pb.id=? AND pb.deleted_at IS NULL`,
    [req.params.id]
  );
  if (record.rowCount === 0) return res.status(404).json({ error: 'not found' });
  const context = await getBatchCostContext(req.tenantDb);
  return res.json({
    ...record.rows[0],
    cost_per_unit: context.batchUnitCosts[req.params.id] || 0,
    timeline: await detailTimeline(req.tenantDb, 'production_batches', req.params.id)
  });
});

router.put('/production-batches/:id', requireAuth, requirePermission('production', 'edit'), async (req, res) => {
  const { input_quantity, output_quantity, labor_cost, other_cost, notes, date } = req.body;
  const client = await req.tenantDb.connect();
  try {
    await client.query('START TRANSACTION');
    const currentRes = await client.query('SELECT * FROM production_batches WHERE id=? AND deleted_at IS NULL FOR UPDATE', [req.params.id]);
    if (currentRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }
    const current = currentRes.rows[0];
    const nextIn = typeof input_quantity === 'undefined' ? numeric(current.input_quantity) : numeric(input_quantity);
    const nextOut = typeof output_quantity === 'undefined' ? numeric(current.output_quantity) : numeric(output_quantity);
    const nextLabor = typeof labor_cost === 'undefined' ? numeric(current.labor_cost) : numeric(labor_cost);
    const nextOther = typeof other_cost === 'undefined' ? numeric(current.other_cost) : numeric(other_cost);

    await client.query(
      `UPDATE production_batches
       SET input_quantity=?, output_quantity=?, labor_cost=?, other_cost=?, notes=COALESCE(?,notes), date=COALESCE(?,date), updated_at=NOW()
       WHERE id=?`,
      [nextIn, nextOut, nextLabor, nextOther, notes || null, date || null, req.params.id]
    );

    const fetchedBatch = await client.query('SELECT * FROM production_batches WHERE id = ?', [req.params.id]);

    if (current.input_reference_id) {
      await client.query(
        `UPDATE inventory_ledger SET quantity=?, date=?
         WHERE reference_table='production_batches' AND reference_id=? AND transaction_type='out'`,
        [nextIn, date || current.date, req.params.id]
      );
    }
    const outputId = current.finished_good_id || current.id;
    await client.query(
      `UPDATE inventory_ledger SET quantity=?, date=?
       WHERE reference_table='production_batches' AND reference_id=? AND transaction_type='in' AND item_id=?`,
      [nextOut, date || current.date, req.params.id, outputId]
    );

    await audit(client, req, 'update', 'production_batch', req.params.id, req.body);
    await client.query('COMMIT');
    return res.json(fetchedBatch.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('update production batch error', err);
    return res.status(500).json({ error: 'update failed' });
  } finally {
    client.release();
  }
});

router.delete('/production-batches/:id', requireAuth, requirePermission('production', 'delete'), async (req, res) => {
  const client = await req.tenantDb.connect();
  const userId = req.user.user_id || req.user.id;
  try {
    await client.query('START TRANSACTION');
    const current = await client.query('SELECT * FROM production_batches WHERE id=? AND deleted_at IS NULL FOR UPDATE', [req.params.id]);
    if (current.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }
    await reverseLedgerForDeletedRecord(client, req, 'production_batches', current.rows[0]);
    await client.query('UPDATE production_batches SET deleted_at=NOW(), deleted_by=? WHERE id=?', [userId, req.params.id]);
    await audit(client, req, 'delete', 'production_batch', req.params.id);
    await client.query('COMMIT');
    return res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('delete production batch error', err);
    return res.status(500).json({ error: 'delete failed' });
  } finally {
    client.release();
  }
});

// Sales
router.get('/sales', requireAuth, async (req, res) => {
  const params = [];
  const where = ['s.deleted_at IS NULL'];
  if (req.query.customer_id) where.push(`s.customer_id = ${pushParam(params, req.query.customer_id)}`);
  if (req.query.finished_good_id) where.push(`s.finished_good_id = ${pushParam(params, req.query.finished_good_id)}`);
  if (req.query.status === 'Paid') where.push('s.amount_due <= 0');
  if (req.query.status === 'Partially Paid') where.push('s.amount_due > 0 AND s.amount_due < s.total_amount');
  if (req.query.status === 'Unpaid') where.push('s.amount_due >= s.total_amount');
  if (req.query.start_date) where.push(`s.date >= ${pushParam(params, req.query.start_date)}`);
  if (req.query.end_date) where.push(`s.date <= ${pushParam(params, req.query.end_date)}`);
  addSearch(where, params, req.query.search, ['c.name', 'fg.name', 's.notes']);
  const { pageSize, offset } = pageParams(req);
  const sort = sortClause(req, {
    date: 's.date',
    customer_name: 'c.name',
    product_name: 'fg.name',
    quantity: 's.quantity',
    rate_per_unit: 's.rate_per_unit',
    total_amount: 's.total_amount',
    amount_received: 's.amount_received',
    amount_due: 's.amount_due'
  }, { key: 'date', direction: 'desc' });
  const from = `sales s
    LEFT JOIN customers c ON c.id=s.customer_id
    LEFT JOIN finished_goods fg ON fg.id=s.finished_good_id`;
  const count = await req.tenantDb.query(`SELECT COUNT(*) AS count FROM ${from} WHERE ${where.join(' AND ')}`, params);
  const summary = await req.tenantDb.query(
    `SELECT COALESCE(SUM(s.quantity),0) AS total_quantity, COALESCE(SUM(s.total_amount),0) AS total_amount,
       COALESCE(SUM(s.amount_received),0) AS amount_received, COALESCE(SUM(s.amount_due),0) AS amount_due
     FROM ${from} WHERE ${where.join(' AND ')}`,
    params
  );
  const rows = await req.tenantDb.query(
    `SELECT s.id, s.customer_id, c.name AS customer_name, s.finished_good_id, fg.name AS product_name, fg.unit,
       s.quantity, s.rate_per_unit, s.total_amount, s.amount_received, s.amount_due, s.date, s.notes, s.created_at
     FROM ${from}
     WHERE ${where.join(' AND ')}
     ORDER BY ${sort.sql} ${sort.direction}
     LIMIT ${pushParam(params, pageSize)} OFFSET ${pushParam(params, offset)}`,
    params
  );
  return sendList(req, res, rows.rows.map(withPaymentStatus), count.rows[0].count, summary.rows[0]);
});

router.post('/sales', requireAuth, requirePermission('sales', 'create'), async (req, res) => {
  const { customer_id, finished_good_id, location_id, quantity, rate_per_unit, amount_received = 0, date, notes, allow_negative = false } = req.body;
  if (!finished_good_id) return res.status(400).json({ error: 'finished_good_id is required' });
  const qty = validatePositive(quantity, 'quantity');
  const rate = validateNonNegative(rate_per_unit, 'rate_per_unit');
  const received = validateNonNegative(amount_received, 'amount_received');
  if (!qty.ok) return res.status(400).json({ error: qty.error });
  if (!rate.ok) return res.status(400).json({ error: rate.error });
  if (!received.ok) return res.status(400).json({ error: received.error });

  const client = await req.tenantDb.connect();
  const userId = req.user.user_id || req.user.id;
  try {
    await client.query('START TRANSACTION');
    if (customer_id && !(await ensureWorkspaceRecord(client, 'customers', customer_id))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'customer_id not found' });
    }
    if (!(await ensureWorkspaceRecord(client, 'finished_goods', finished_good_id))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'finished_good_id not found' });
    }
    const currentStock = await stockForItem(client, 'finished_good', finished_good_id);
    if (!allow_negative && qty.value > currentStock) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient stock', current_stock: currentStock });
    }

    // 1. Fetch Company & Customer State for GST Split (CGST+SGST vs IGST)
    const compRes = await queryMaster('SELECT state FROM companies WHERE id = ?', [req.user.company_id || req.user.workspace_id]);
    const workspaceState = compRes.rows[0]?.state || 'Maharashtra';
    let customerState = workspaceState;
    if (customer_id) {
      const custRes = await client.query('SELECT state FROM customers WHERE id = ?', [customer_id]);
      if (custRes.rows.length > 0 && custRes.rows[0].state) customerState = custRes.rows[0].state;
    }
    const isInterstate = workspaceState.trim().toLowerCase() !== customerState.trim().toLowerCase();

    // 2. Fetch tax rate for finished good
    const fgRes = await client.query('SELECT tax_rate FROM items WHERE id = ?', [finished_good_id]);
    const taxRate = Number(fgRes.rows[0]?.tax_rate || req.body.tax_rate || 18);

    // 3. Compute GST Line & Totals via Invoice Engine
    const line = calculateInvoiceLine({
      quantity: qty.value,
      ratePerUnit: rate.value,
      discountPercent: req.body.discount_percent || 0,
      taxRate,
      isInterstate
    });

    const totals = calculateInvoiceTotals([line], {
      invoiceDiscount: req.body.invoice_discount || 0,
      roundingMethod: process.env.INVOICE_ROUNDING_METHOD || 'round_half_up',
      roundingTarget: 1
    });

    if (received.value > totals.total_amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'amount_received cannot exceed total amount' });
    }

    const due = Math.max(0, totals.total_amount - received.value);
    const payStatus = due <= 0.01 ? 'Paid' : (received.value > 0 ? 'Partially Paid' : 'Unpaid');
    const invoiceNumber = await getNextDocumentNumber(req.tenantDb, 'invoice');

    const saleId = crypto.randomUUID();
    await client.query(
      `INSERT INTO sales (
        id, invoice_number, customer_id, location_id, finished_good_id, quantity, rate_per_unit,
        date, place_of_supply, subtotal, cgst_amount, sgst_amount, igst_amount,
        total_tax, discount_amount, pre_rounding_total, round_off_amount,
        total_amount, amount_received, amount_due, payment_status, notes
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        saleId, invoiceNumber, customer_id || null, location_id || req.body.location_id || null, finished_good_id, qty.value, rate.value,
        date || todayIso(), customerState, totals.subtotal, totals.cgst_amount, totals.sgst_amount, totals.igst_amount,
        totals.total_tax, totals.discount_amount, totals.pre_rounding_total, totals.round_off_amount,
        totals.total_amount, received.value, due, payStatus, notes || null
      ]
    );

    const salesItemId = crypto.randomUUID();
    await client.query(
      `INSERT INTO sales_items (
        id, sale_id, finished_good_id, quantity, rate_per_unit, discount_percent,
        taxable_value, tax_rate, cgst_rate, cgst_amount,
        sgst_rate, sgst_amount, igst_rate, igst_amount, line_total
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        salesItemId, saleId, finished_good_id, qty.value, rate.value, line.discount_percent,
        line.taxable_value, line.tax_rate, line.cgst_rate, line.cgst_amount,
        line.sgst_rate, line.sgst_amount, line.igst_rate, line.igst_amount, line.line_total
      ]
    );

    const fetchedSale = await client.query('SELECT * FROM sales WHERE id = ?', [saleId]);
    const sale = fetchedSale.rows[0];

    const ledgerId = crypto.randomUUID();
    await client.query(
      `INSERT INTO inventory_ledger (id, item_type, item_id, transaction_type, quantity, location_id, reference_table, reference_id, date, created_by)
       VALUES (?,'finished_good',?,'out',?,?, 'sales',?,?,?)`,
      [ledgerId, finished_good_id, qty.value, location_id || null, sale.id, date || new Date(), userId]
    );
    if (received.value > 0) {
      const payId = crypto.randomUUID();
      await client.query(
        `INSERT INTO payments_log (id, related_type, related_id, amount, date, created_by)
         VALUES (?,'sale',?,?,?,?)`,
        [payId, sale.id, received.value, date || new Date(), userId]
      );
    }
    await audit(client, req, 'create', 'sale', sale.id, { total_amount: sale.total_amount });
    await touchWorkspace(client, req.user.company_id || req.user.workspace_id);
    await client.query('COMMIT');
    return res.status(201).json(withPaymentStatus(sale));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('create sale error', err);
    return res.status(500).json({ error: 'Failed to create sale: ' + err.message });
  } finally {
    client.release();
  }
});

router.get('/sales/:id', requireAuth, async (req, res) => {
  const record = await req.tenantDb.query(
    `SELECT s.*, c.name AS customer_name, fg.name AS product_name, fg.unit
     FROM sales s
     LEFT JOIN customers c ON c.id=s.customer_id
     LEFT JOIN finished_goods fg ON fg.id=s.finished_good_id
     WHERE s.id=? AND s.deleted_at IS NULL`,
    [req.params.id]
  );
  if (record.rowCount === 0) return res.status(404).json({ error: 'not found' });
  return res.json({ ...withPaymentStatus(record.rows[0]), timeline: await detailTimeline(req.tenantDb, 'sales', req.params.id) });
});

router.get('/sales/:id/pdf', requireAuth, (req, res, next) => {
  req.url = `/${req.params.id}/pdf`;
  return require('./invoices')(req, res, next);
});

router.put('/sales/:id', requireAuth, requirePermission('sales', 'edit'), async (req, res) => {
  const { customer_id, finished_good_id, quantity, rate_per_unit, amount_received, date, notes } = req.body;
  const client = await req.tenantDb.connect();
  const userId = req.user.user_id || req.user.id;
  try {
    await client.query('START TRANSACTION');
    const currentRes = await client.query('SELECT * FROM sales WHERE id=? AND deleted_at IS NULL FOR UPDATE', [req.params.id]);
    if (currentRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }
    const current = currentRes.rows[0];
    const nextQty = typeof quantity === 'undefined' ? numeric(current.quantity) : numeric(quantity);
    const nextRate = typeof rate_per_unit === 'undefined' ? numeric(current.rate_per_unit) : numeric(rate_per_unit);
    const nextReceived = typeof amount_received === 'undefined' ? numeric(current.amount_received) : numeric(amount_received);
    if (nextQty <= 0 || nextRate < 0 || nextReceived < 0 || nextReceived > nextQty * nextRate) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid sale amounts' });
    }
    await client.query(
      `UPDATE sales
       SET customer_id=COALESCE(?,customer_id), finished_good_id=COALESCE(?,finished_good_id), quantity=?,
           rate_per_unit=?, amount_received=?, date=COALESCE(?,date), notes=COALESCE(?,notes), updated_at=NOW()
       WHERE id=?`,
      [customer_id || null, finished_good_id || null, nextQty, nextRate, nextReceived, date || null, notes || null, req.params.id]
    );

    const fetchedSale = await client.query('SELECT * FROM sales WHERE id = ?', [req.params.id]);

    await client.query(
      `UPDATE inventory_ledger SET item_id=?, quantity=?, date=?
       WHERE reference_table='sales' AND reference_id=? AND transaction_type='out'`,
      [finished_good_id || current.finished_good_id, nextQty, date || current.date, req.params.id]
    );
    if (nextReceived > numeric(current.amount_received)) {
      const payId = crypto.randomUUID();
      await client.query(
        `INSERT INTO payments_log (id, related_type, related_id, amount, date, notes, created_by)
         VALUES (?,'sale',?,?,?,'Payment adjustment from edit',?)`,
        [payId, req.params.id, nextReceived - numeric(current.amount_received), date || new Date(), userId]
      );
    }
    await audit(client, req, 'update', 'sale', req.params.id, req.body);
    await client.query('COMMIT');
    return res.json(withPaymentStatus(fetchedSale.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('update sale error', err);
    return res.status(500).json({ error: 'update failed' });
  } finally {
    client.release();
  }
});

router.delete('/sales/:id', requireAuth, requirePermission('sales', 'delete'), async (req, res) => {
  const client = await req.tenantDb.connect();
  const userId = req.user.user_id || req.user.id;
  try {
    await client.query('START TRANSACTION');
    const current = await client.query('SELECT * FROM sales WHERE id=? AND deleted_at IS NULL FOR UPDATE', [req.params.id]);
    if (current.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }
    await reverseLedgerForDeletedRecord(client, req, 'sales', current.rows[0]);
    await client.query('UPDATE sales SET deleted_at=NOW(), deleted_by=? WHERE id=?', [userId, req.params.id]);
    await client.query("UPDATE payments_log SET deleted_at=NOW(), deleted_by=? WHERE related_type='sale' AND related_id=?", [userId, req.params.id]);
    await audit(client, req, 'delete', 'sale', req.params.id);
    await client.query('COMMIT');
    return res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('delete sale error', err);
    return res.status(500).json({ error: 'delete failed' });
  } finally {
    client.release();
  }
});

// Expenses
router.get('/expenses', requireAuth, requirePermission('expenses', 'view'), async (req, res) => {
  const params = [];
  const where = ['deleted_at IS NULL'];
  if (req.query.category) where.push(`category = ${pushParam(params, req.query.category)}`);
  if (req.query.start_date) where.push(`date >= ${pushParam(params, req.query.start_date)}`);
  if (req.query.end_date) where.push(`date <= ${pushParam(params, req.query.end_date)}`);
  addSearch(where, params, req.query.search, ['category', 'notes']);
  const { pageSize, offset } = pageParams(req);
  const sort = sortClause(req, { date: 'date', category: 'category', amount: 'amount' }, { key: 'date', direction: 'desc' });
  const count = await req.tenantDb.query(`SELECT COUNT(*) AS count FROM expenses WHERE ${where.join(' AND ')}`, params);
  const summary = await req.tenantDb.query(`SELECT COALESCE(SUM(amount),0) AS total_amount FROM expenses WHERE ${where.join(' AND ')}`, params);
  const rows = await req.tenantDb.query(
    `SELECT id, category, amount, date, notes, created_at FROM expenses WHERE ${where.join(' AND ')} ORDER BY ${sort.sql} ${sort.direction} LIMIT ${pushParam(params, pageSize)} OFFSET ${pushParam(params, offset)}`,
    params
  );
  return sendList(req, res, rows.rows, count.rows[0].count, summary.rows[0]);
});

router.get('/expenses/:id', requireAuth, async (req, res) => {
  try {
    const record = await req.tenantDb.query(
      `SELECT e.*, u.name AS user_name, u.email AS user_email, u.role AS user_role
       FROM expenses e
       LEFT JOIN users u ON u.id = e.created_by
       WHERE e.id = ? AND e.deleted_at IS NULL`,
      [req.params.id]
    );
    if (record.rowCount === 0) return res.status(404).json({ error: 'Expense not found' });
    const expense = record.rows[0];

    // Query audit log history for creation & edits (using correct singular audit_log table)
    const auditRes = await req.tenantDb.query(
      `SELECT a.*, u.name AS user_name, u.email AS user_email, u.role AS user_role
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.entity_type = 'expense' AND a.entity_id = ?
       ORDER BY a.created_at ASC`,
      [req.params.id]
    ).catch((err) => {
      console.warn('audit_log fetch error:', err.message);
      return { rows: [] };
    });

    const formatRole = (role) => {
      if (!role) return '';
      const map = {
        owner: 'Workspace Owner',
        admin: 'Admin',
        manager: 'Manager',
        staff: 'Staff Member',
        accounts: 'Accounts',
        production_manager: 'Production Manager',
        sales_manager: 'Sales Manager'
      };
      return map[role.toLowerCase()] || role.replace(/_/g, ' ');
    };

    const formatUserNameAndRole = (name, role) => {
      const roleLabel = formatRole(role);
      if (name && roleLabel) return `${name} (${roleLabel})`;
      if (name) return name;
      return roleLabel || '';
    };

    // Determine created_by user
    let creatorName = expense.user_name;
    let creatorEmail = expense.user_email;
    let creatorRole = expense.user_role;

    // If not found via created_by column, check audit log create entry
    if (!creatorName && auditRes.rows.length > 0) {
      const createEntry = auditRes.rows.find((a) => a.action === 'create') || auditRes.rows[0];
      if (createEntry) {
        creatorName = createEntry.user_name;
        creatorEmail = createEntry.user_email;
        creatorRole = createEntry.user_role;
      }
    }

    // Fallback: If still unresolved, look up the workspace owner
    if (!creatorName) {
      const ownerRes = await req.tenantDb.query(
        `SELECT name, email, role FROM users WHERE role = 'owner' LIMIT 1`
      ).catch(() => ({ rows: [] }));
      if (ownerRes.rows.length > 0) {
        creatorName = ownerRes.rows[0].name;
        creatorEmail = ownerRes.rows[0].email;
        creatorRole = ownerRes.rows[0].role;
      }
    }

    expense.created_by_name = formatUserNameAndRole(creatorName, creatorRole) || 'Workspace Owner';
    expense.created_by_raw_name = creatorName || 'Workspace Owner';
    expense.created_by_email = creatorEmail || '';
    expense.created_by_role = creatorRole || '';

    if (auditRes.rows.length > 0) {
      expense.timeline = auditRes.rows.map((a) => {
        let noteText = `${a.action === 'create' ? 'Logged expense' : (a.action === 'update' ? 'Updated expense' : a.action)}`;
        if (a.metadata) {
          try {
            const meta = typeof a.metadata === 'string' ? JSON.parse(a.metadata) : a.metadata;
            if (meta && meta.amount) {
              noteText = `${noteText} (Amount: ${meta.amount})`;
            }
          } catch (e) {
            // keep default
          }
        }
        return {
          id: a.id,
          kind: 'audit',
          action: a.action,
          user_name: formatUserNameAndRole(a.user_name, a.user_role) || 'Workspace User',
          user_email: a.user_email || '',
          notes: noteText,
          date: a.created_at,
          created_at: a.created_at
        };
      });
    } else {
      expense.timeline = [
        {
          id: expense.id,
          kind: 'expense',
          action: 'create',
          user_name: expense.created_by_name,
          user_email: expense.created_by_email,
          notes: expense.notes || `Logged under category: ${expense.category}`,
          date: expense.date,
          created_at: expense.created_at
        }
      ];
    }

    return res.json(expense);
  } catch (err) {
    console.error('get expense error:', err);
    return res.status(500).json({ error: 'Failed to fetch expense details' });
  }
});

router.post('/expenses', requireAuth, requirePermission('expenses', 'create'), async (req, res) => {
  const { category, amount, date, notes } = req.body;
  const amt = validatePositive(amount, 'amount');
  if (!category) return res.status(400).json({ error: 'category required' });
  if (!amt.ok) return res.status(400).json({ error: amt.error });

  const id = crypto.randomUUID();
  const userId = req.user?.id || req.user?.user_id || null;
  const expenseNumber = req.body.expense_number && String(req.body.expense_number).trim()
    ? String(req.body.expense_number).trim().toUpperCase()
    : await getNextDocumentNumber(req.tenantDb, 'expense');

  await req.tenantDb.query(
    `INSERT INTO expenses (id, category, amount, date, notes, created_by, expense_number) VALUES (?,?,?,?,?,?,?)`,
    [id, category, amt.value, date || todayIso(), notes || null, userId, expenseNumber]
  );
  const fetched = await req.tenantDb.query('SELECT * FROM expenses WHERE id = ?', [id]);
  await audit(req.tenantDb, req, 'create', 'expense', id, { amount: amt.value });
  await touchWorkspace(req.tenantDb, req.user.company_id || req.user.workspace_id);
  return res.status(201).json(fetched.rows[0]);
});

router.put('/expenses/:id', requireAuth, requirePermission('expenses', 'edit'), async (req, res) => {
  const { category, amount, date, notes } = req.body;
  const updateRes = await req.tenantDb.query(
    `UPDATE expenses SET category=COALESCE(?,category), amount=COALESCE(?,amount), date=COALESCE(?,date), notes=COALESCE(?,notes), updated_at=NOW() WHERE id=? AND deleted_at IS NULL`,
    [category || null, amount ?? null, date || null, notes || null, req.params.id]
  );
  if (updateRes.rowCount === 0) return res.status(404).json({ error: 'not found' });
  const fetched = await req.tenantDb.query('SELECT * FROM expenses WHERE id = ?', [req.params.id]);
  await audit(req.tenantDb, req, 'update', 'expense', req.params.id);
  return res.json(fetched.rows[0]);
});

router.delete('/expenses/:id', requireAuth, requirePermission('expenses', 'delete'), async (req, res) => {
  const userId = req.user.user_id || req.user.id;
  const updateRes = await req.tenantDb.query(`UPDATE expenses SET deleted_at=NOW(), deleted_by=? WHERE id=? AND deleted_at IS NULL`, [userId, req.params.id]);
  if (updateRes.rowCount === 0) return res.status(404).json({ error: 'not found' });
  await audit(req.tenantDb, req, 'delete', 'expense', req.params.id);
  return res.json({ deleted: true });
});

// Payments
router.post('/procurements/:id/payments', requireAuth, requirePermission('procurement', 'create'), async (req, res) => {
  const { amount, date, notes } = req.body;
  const amt = validatePositive(amount, 'amount');
  if (!amt.ok) return res.status(400).json({ error: amt.error });
  const client = await req.tenantDb.connect();
  const userId = req.user.user_id || req.user.id;
  try {
    await client.query('START TRANSACTION');
    const p = await client.query('SELECT id, amount_paid, total_amount, status FROM procurements WHERE id=? AND deleted_at IS NULL FOR UPDATE', [req.params.id]);
    if (p.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Procurement not found' });
    }
    const currentStatus = p.rows[0].status;
    if (['Denied', 'Rejected', 'Cancelled'].includes(currentStatus)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Cannot record payment for a ${currentStatus.toLowerCase()} purchase order` });
    }
    if (numeric(p.rows[0].amount_paid) + amt.value > numeric(p.rows[0].total_amount)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'payment exceeds outstanding amount' });
    }
    await client.query('UPDATE procurements SET amount_paid = amount_paid + ?, updated_at=NOW() WHERE id=?', [amt.value, req.params.id]);
    const payId = crypto.randomUUID();
    await client.query(
      `INSERT INTO payments_log (id, related_type, related_id, amount, date, notes, created_by)
       VALUES (?,'procurement',?,?,?,?,?)`,
      [payId, req.params.id, amt.value, date || new Date(), notes || null, userId]
    );
    await audit(client, req, 'payment', 'procurement', req.params.id, { amount: amt.value });
    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('procurement payment error', err);
    return res.status(500).json({ error: 'failed' });
  } finally {
    client.release();
  }
});

router.post('/sales/:id/payments', requireAuth, requirePermission('sales', 'create'), async (req, res) => {
  const { amount, date, notes } = req.body;
  const amt = validatePositive(amount, 'amount');
  if (!amt.ok) return res.status(400).json({ error: amt.error });
  const client = await req.tenantDb.connect();
  const userId = req.user.user_id || req.user.id;
  try {
    await client.query('START TRANSACTION');
    const s = await client.query('SELECT id, amount_received, total_amount FROM sales WHERE id=? AND deleted_at IS NULL FOR UPDATE', [req.params.id]);
    if (s.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'sale not found' });
    }
    if (numeric(s.rows[0].amount_received) + amt.value > numeric(s.rows[0].total_amount)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'payment exceeds outstanding amount' });
    }
    await client.query('UPDATE sales SET amount_received = amount_received + ?, updated_at=NOW() WHERE id=?', [amt.value, req.params.id]);
    const payId = crypto.randomUUID();
    await client.query(
      `INSERT INTO payments_log (id, related_type, related_id, amount, date, notes, created_by)
       VALUES (?,'sale',?,?,?,?,?)`,
      [payId, req.params.id, amt.value, date || new Date(), notes || null, userId]
    );
    await audit(client, req, 'payment', 'sale', req.params.id, { amount: amt.value });
    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('sale payment error', err);
    return res.status(500).json({ error: 'failed' });
  } finally {
    client.release();
  }
});

router.delete(['/sales/:id', '/invoices/:id'], requireAuth, requirePermission('sales', 'delete'), async (req, res) => {
  const invoiceId = req.params.id;
  try {
    await req.tenantDb.query('START TRANSACTION');

    const saleRes = await req.tenantDb.query('SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL', [invoiceId]);
    if (saleRes.rows.length === 0) {
      await req.tenantDb.query('ROLLBACK');
      return res.status(404).json({ error: 'Invoice not found' });
    }
    const sale = saleRes.rows[0];

    // Fetch line items to return finished goods to inventory stock
    const itemsRes = await req.tenantDb.query('SELECT * FROM sales_items WHERE sale_id = ?', [invoiceId]);
    for (const item of (itemsRes.rows || [])) {
      if (item.finished_good_id && item.quantity > 0) {
        const ledgerId = crypto.randomUUID();
        await req.tenantDb.query(
          `INSERT INTO inventory_ledger (
            id, item_type, item_id, transaction_type, quantity, unit_cost, reason, reference_table, reference_id, created_by
          ) VALUES (?, 'finished_good', ?, 'in', ?, ?, ?, 'sales_cancellation', ?, ?)`,
          [ledgerId, item.finished_good_id, item.quantity, item.rate_per_unit || 0, `Invoice ${sale.invoice_number || invoiceId} Cancellation Return`, invoiceId, req.user.id]
        );
      }
    }

    // Soft-delete sales record
    await req.tenantDb.query('UPDATE sales SET deleted_at = NOW(), deleted_by = ? WHERE id = ?', [req.user.id, invoiceId]);

    // Soft-delete payment log entries for this sale
    await req.tenantDb.query("UPDATE payments_log SET deleted_at = NOW(), deleted_by = ? WHERE related_type = 'sale' AND related_id = ?", [req.user.id, invoiceId]);

    await req.tenantDb.query('COMMIT');
    return res.json({ message: 'Invoice deleted and finished goods stock re-added to inventory.' });
  } catch (err) {
    await req.tenantDb.query('ROLLBACK').catch(() => {});
    console.error('Delete invoice error:', err);
    return res.status(500).json({ error: 'Failed to delete invoice: ' + err.message });
  }
});

router.get('/payments', requireAuth, async (req, res) => {
  // Sync any existing procurements or sales with paid > 0 that haven't been logged in payments_log yet
  try {
    const existingProcLog = await req.tenantDb.query(`
      SELECT p.id, p.amount_paid, p.date, p.notes
      FROM procurements p
      LEFT JOIN payments_log pl ON pl.related_type = 'procurement' AND pl.related_id = p.id AND pl.deleted_at IS NULL
      WHERE p.amount_paid > 0 AND p.deleted_at IS NULL AND pl.id IS NULL
    `);
    for (const p of (existingProcLog.rows || [])) {
      const payLogId = crypto.randomUUID();
      await req.tenantDb.query(
        `INSERT INTO payments_log (id, related_type, related_id, amount, date, notes, created_by)
         VALUES (?, 'procurement', ?, ?, ?, ?, ?)`,
        [payLogId, p.id, p.amount_paid, p.date || new Date().toISOString().slice(0, 10), p.notes || 'Procurement Payment', req.user.id]
      );
    }

    const existingSalesLog = await req.tenantDb.query(`
      SELECT s.id, s.amount_received, s.date, s.notes
      FROM sales s
      LEFT JOIN payments_log pl ON pl.related_type = 'sale' AND pl.related_id = s.id AND pl.deleted_at IS NULL
      WHERE s.amount_received > 0 AND s.deleted_at IS NULL AND pl.id IS NULL
    `);
    for (const s of (existingSalesLog.rows || [])) {
      const payLogId = crypto.randomUUID();
      await req.tenantDb.query(
        `INSERT INTO payments_log (id, related_type, related_id, amount, date, notes, created_by)
         VALUES (?, 'sale', ?, ?, ?, ?, ?)`,
        [payLogId, s.id, s.amount_received, s.date || new Date().toISOString().slice(0, 10), s.notes || 'Sales Invoice Payment', req.user.id]
      );
    }
  } catch (syncErr) {
    console.error('Payment sync error:', syncErr);
  }

  const params = [];
  const where = ['pl.deleted_at IS NULL'];
  if (req.query.related_type) where.push(`pl.related_type = ${pushParam(params, req.query.related_type)}`);
  if (req.query.start_date) where.push(`DATE(pl.date) >= ${pushParam(params, req.query.start_date)}`);
  if (req.query.end_date) where.push(`DATE(pl.date) <= ${pushParam(params, req.query.end_date)}`);
  addSearch(where, params, req.query.search, ['v.name', 'c.name', 'pl.notes']);
  const { pageSize, offset } = pageParams(req);
  const sort = sortClause(req, { date: 'pl.date', type: 'pl.related_type', party_name: 'party_name', amount: 'pl.amount' }, { key: 'date', direction: 'desc' });
  const from = `payments_log pl
    LEFT JOIN procurements p ON pl.related_type='procurement' AND p.id=pl.related_id AND p.deleted_at IS NULL
    LEFT JOIN vendors v ON v.id=p.vendor_id
    LEFT JOIN sales s ON pl.related_type='sale' AND s.id=pl.related_id AND s.deleted_at IS NULL
    LEFT JOIN customers c ON c.id=s.customer_id`;
  const count = await req.tenantDb.query(`SELECT COUNT(*) AS count FROM ${from} WHERE ${where.join(' AND ')}`, params);
  const rows = await req.tenantDb.query(
    `SELECT pl.id, pl.related_type AS type, pl.related_id, pl.amount, pl.date, pl.notes,
       COALESCE(v.name, c.name, 'Walk-in') AS party_name,
       COALESCE(p.total_amount, s.total_amount, 0) AS related_total,
       COALESCE(p.amount_due, s.amount_due, 0) AS running_due_balance
     FROM ${from}
     WHERE ${where.join(' AND ')}
     ORDER BY ${sort.sql} ${sort.direction}
     LIMIT ${pushParam(params, pageSize)} OFFSET ${pushParam(params, offset)}`,
    params
  );
  return sendList(req, res, rows.rows, count.rows[0].count, {
    total_amount: rows.rows.reduce((sum, row) => sum + numeric(row.amount), 0)
  });
});

// Inventory Stock & Alerts
router.get('/stock', requireAuth, requirePermission('inventory', 'view'), async (req, res) => {
  const rows = await getInventorySnapshot(req.tenantDb);
  return res.json(rows.map((row) => ({
    item_type: row.item_type,
    item_id: row.item_id,
    quantity: row.current_stock,
    name: row.name,
    unit: row.unit
  })));
});

router.get('/inventory', requireAuth, requirePermission('inventory', 'view'), async (req, res) => {
  const locationId = req.query.location_id || null;
  const startDate = req.query.start_date || null;
  const endDate = req.query.end_date || null;
  const rows = await getInventorySnapshot(req.tenantDb, locationId, startDate, endDate);
  const search = String(req.query.search || '').trim().toLowerCase();
  const type = String(req.query.item_type || '').trim();
  const status = String(req.query.status || '').trim();
  let filtered = rows;
  if (search) filtered = filtered.filter((row) => row.name.toLowerCase().includes(search));
  if (type) filtered = filtered.filter((row) => row.item_type === type);
  if (status) filtered = filtered.filter((row) => row.status === status);
  const sort = sortClause(req, {
    name: 'name',
    item_type: 'item_type',
    current_stock: 'current_stock',
    value_at_cost: 'value_at_cost',
    reorder_level: 'reorder_level',
    status: 'status'
  }, { key: 'name', direction: 'asc' });
  filtered.sort((a, b) => {
    const av = a[sort.key];
    const bv = b[sort.key];
    if (typeof av === 'number' || typeof bv === 'number') return (numeric(av) - numeric(bv)) * (sort.direction === 'DESC' ? -1 : 1);
    return String(av || '').localeCompare(String(bv || '')) * (sort.direction === 'DESC' ? -1 : 1);
  });
  const { page, pageSize, offset } = pageParams(req);
  const pageRows = filtered.slice(offset, offset + pageSize);
  return res.json({
    items: pageRows,
    meta: { page, page_size: pageSize, total: filtered.length, total_pages: Math.max(1, Math.ceil(filtered.length / pageSize)) },
    summary: {
      total_items: filtered.length,
      total_value: filtered.reduce((sum, row) => sum + numeric(row.value_at_cost), 0),
      raw_material_value: filtered.filter(r => r.item_type === 'raw_material').reduce((sum, row) => sum + numeric(row.value_at_cost), 0),
      raw_material_count: filtered.filter(r => r.item_type === 'raw_material').length,
      finished_goods_value: filtered.filter(r => r.item_type === 'finished_good').reduce((sum, row) => sum + numeric(row.value_at_cost), 0),
      finished_goods_count: filtered.filter(r => r.item_type === 'finished_good').length,
      wip_value: filtered.filter(r => r.item_type === 'wip').reduce((sum, row) => sum + numeric(row.value_at_cost), 0),
      wip_count: filtered.filter(r => r.item_type === 'wip').length,
      low_count: filtered.filter((row) => row.status === 'Low' || row.status === 'Out').length
    }
  });
});

router.get('/inventory/alerts', requireAuth, requirePermission('inventory', 'view'), async (req, res) => {
  if (req.user.role === 'vendor' || req.user.role === 'customer' || req.user.vendor_id || req.user.customer_id) {
    return res.json([]);
  }
  const locationId = req.query.location_id || null;
  const rows = await getLocationAwareInventoryAlerts(req.tenantDb, locationId);
  return res.json(rows.slice(0, 30));
});

router.get('/inventory/:item_type/:item_id/details', requireAuth, requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { item_type, item_id } = req.params;
    const snapshot = await getInventorySnapshot(req.tenantDb);
    const item = snapshot.find(s => s.item_type === item_type && s.item_id === item_id);
    if (!item) return res.status(404).json({ error: 'Inventory item not found' });

    // Location stock breakdown
    const locRows = await req.tenantDb.query(
      `SELECT l.id, l.name, l.is_default,
         COALESCE(SUM(CASE WHEN il.transaction_type = 'in' OR (il.transaction_type = 'adjustment' AND il.quantity > 0) THEN ABS(il.quantity)
                           WHEN il.transaction_type = 'out' OR (il.transaction_type = 'adjustment' AND il.quantity < 0) THEN -ABS(il.quantity)
                           ELSE il.quantity END), 0) AS stock
       FROM locations l
       LEFT JOIN inventory_ledger il ON il.location_id = l.id AND il.item_type = ? AND il.item_id = ?
       WHERE l.deleted_at IS NULL
       GROUP BY l.id, l.name, l.is_default`,
      [item_type, item_id]
    ).catch(() => ({ rows: [] }));

    // History with production_runs, shift logs, users, and location names
    const historyRes = await req.tenantDb.query(
      `SELECT il.id, il.item_type, il.item_id, il.transaction_type, il.quantity, il.unit_cost, il.reference_table,
         il.reference_id, il.reason, il.date, il.created_at,
         COALESCE(
           CASE WHEN psl.id IS NOT NULL THEN CONCAT('Order ', po.order_number, ' (', psl.shift, ' shift)') ELSE NULL END,
           prun.run_number, p.batch_number, pr.procurement_number, pr.notes, s.invoice_number, s.notes, il.reason
         ) AS reference_note,
         u.name AS user_name, u.role AS user_role,
         loc.name AS location_name
       FROM inventory_ledger il
       LEFT JOIN production_shift_logs psl ON il.reference_table='production_shift_logs' AND psl.id=il.reference_id
       LEFT JOIN production_orders po ON po.id=psl.order_id
       LEFT JOIN production_runs prun ON il.reference_table='production_runs' AND prun.id=il.reference_id
       LEFT JOIN production_batches p ON il.reference_table='production_batches' AND p.id=il.reference_id
       LEFT JOIN procurements pr ON il.reference_table='procurements' AND pr.id=il.reference_id
       LEFT JOIN sales s ON il.reference_table='sales' AND s.id=il.reference_id
       LEFT JOIN users u ON u.id = il.created_by
       LEFT JOIN locations loc ON loc.id = il.location_id
       WHERE il.item_type=? AND il.item_id=?
       ORDER BY il.date DESC, il.created_at DESC LIMIT 50`,
      [item_type, item_id]
    );

    // Vendor purchase price breakdown for raw materials
    let vendorPurchases = [];
    let vendorPricingSummary = null;

    if (item_type === 'raw_material') {
      const vPurchasesRes = await req.tenantDb.query(
        `SELECT pi.quantity, pi.rate_per_unit, (pi.quantity * pi.rate_per_unit) AS total_amount,
                p.procurement_number, p.date,
                COALESCE(v.name, 'Direct Vendor') AS vendor_name, v.id AS vendor_id
         FROM procurement_items pi
         JOIN procurements p ON p.id = pi.procurement_id
         LEFT JOIN vendors v ON v.id = p.vendor_id
         WHERE (pi.item_id = ? OR pi.item_id IN (SELECT id FROM items WHERE id = ? OR name = (SELECT name FROM raw_materials WHERE id = ?)))
           AND p.deleted_at IS NULL
         ORDER BY p.date DESC, p.created_at DESC
         LIMIT 25`,
        [item_id, item_id, item_id]
      ).catch(() => ({ rows: [] }));

      vendorPurchases = vPurchasesRes.rows;

      if (vendorPurchases.length > 0) {
        const rates = vendorPurchases.map(p => Number(p.rate_per_unit)).filter(r => r > 0);
        const totalQty = vendorPurchases.reduce((acc, p) => acc + Number(p.quantity || 0), 0);
        const totalVal = vendorPurchases.reduce((acc, p) => acc + (Number(p.quantity || 0) * Number(p.rate_per_unit || 0)), 0);
        const distinctVendors = new Set(vendorPurchases.map(p => p.vendor_name)).size;

        vendorPricingSummary = {
          weighted_avg_cost: totalQty > 0 ? totalVal / totalQty : (rates[0] || 0),
          last_purchase_price: rates[0] || 0,
          min_price: rates.length > 0 ? Math.min(...rates) : 0,
          max_price: rates.length > 0 ? Math.max(...rates) : 0,
          distinct_vendors_count: distinctVendors,
          total_procured_qty: totalQty,
          total_procured_amount: totalVal
        };
      }
    }

    return res.json({
      ...item,
      locations: locRows.rows,
      history: historyRes.rows,
      vendor_purchases: vendorPurchases,
      vendor_pricing_summary: vendorPricingSummary
    });
  } catch (err) {
    console.error('get inventory details error:', err);
    return res.status(500).json({ error: 'Failed to fetch inventory item details' });
  }
});

router.get('/inventory/:item_type/:item_id/history', requireAuth, requirePermission('inventory', 'view'), async (req, res) => {
  const { item_type, item_id } = req.params;
  const rows = await req.tenantDb.query(
    `SELECT il.id, il.item_type, il.item_id, il.transaction_type, il.quantity, il.unit_cost, il.reference_table,
       il.reference_id, il.reason, il.date, il.created_at,
       COALESCE(
         CASE WHEN psl.id IS NOT NULL THEN CONCAT('Order ', po.order_number, ' (', psl.shift, ' shift)') ELSE NULL END,
         prun.run_number, p.batch_number, pr.procurement_number, pr.notes, s.invoice_number, s.notes, il.reason
       ) AS reference_note,
       u.name AS user_name, u.role AS user_role,
       loc.name AS location_name
     FROM inventory_ledger il
     LEFT JOIN production_shift_logs psl ON il.reference_table='production_shift_logs' AND psl.id=il.reference_id
     LEFT JOIN production_orders po ON po.id=psl.order_id
     LEFT JOIN production_runs prun ON il.reference_table='production_runs' AND prun.id=il.reference_id
     LEFT JOIN production_batches p ON il.reference_table='production_batches' AND p.id=il.reference_id
     LEFT JOIN procurements pr ON il.reference_table='procurements' AND pr.id=il.reference_id
     LEFT JOIN sales s ON il.reference_table='sales' AND s.id=il.reference_id
     LEFT JOIN users u ON u.id = il.created_by
     LEFT JOIN locations loc ON loc.id = il.location_id
     WHERE il.item_type=? AND il.item_id=?
     ORDER BY il.date DESC, il.created_at DESC`,
    [item_type, item_id]
  );
  return res.json(rows.rows);
});

router.patch('/inventory/:item_type/:item_id/reorder-level', requireAuth, requirePermission('inventory', 'edit'), async (req, res) => {
  const { item_type, item_id } = req.params;
  const { reorder_level } = req.body;
  if (!['raw_material', 'finished_good'].includes(item_type)) return res.status(400).json({ error: 'reorder level applies to raw and finished goods only' });
  const table = item_type === 'raw_material' ? 'raw_materials' : 'finished_goods';
  const updateRes = await req.tenantDb.query(
    `UPDATE ${table} SET reorder_level=?, updated_at=NOW() WHERE id=? AND deleted_at IS NULL`,
    [reorder_level === '' ? null : reorder_level, item_id]
  );
  if (updateRes.rowCount === 0) return res.status(404).json({ error: 'not found' });
  const fetched = await req.tenantDb.query(`SELECT id, reorder_level FROM ${table} WHERE id = ?`, [item_id]);
  return res.json(fetched.rows[0]);
});

router.post('/inventory/adjustments', requireAuth, requirePermission('inventory', 'create'), async (req, res) => {
  const { item_type, item_id, quantity, reason, date, location_id } = req.body;
  if (!['raw_material', 'finished_good', 'wip'].includes(item_type)) return res.status(400).json({ error: 'invalid item_type' });
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty === 0) return res.status(400).json({ error: 'quantity adjustment must be non-zero' });
  if (!reason || String(reason).trim().length < 3) return res.status(400).json({ error: 'reason is required' });
  const client = await req.tenantDb.connect();
  const userId = req.user.user_id || req.user.id;
  try {
    await client.query('START TRANSACTION');

    let targetLocId = location_id || null;
    if (!targetLocId) {
      const defLoc = await client.query('SELECT id FROM locations WHERE is_default = 1 LIMIT 1');
      if (defLoc.rows.length > 0) targetLocId = defLoc.rows[0].id;
    }

    const id = crypto.randomUUID();
    const txType = qty > 0 ? 'in' : 'out';
    const absQty = Math.abs(qty);

    await client.query(
      `INSERT INTO inventory_ledger (id, item_type, item_id, transaction_type, quantity, location_id, reference_table, date, reason, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'stock_adjustment', ?, ?, ?)`,
      [id, item_type, item_id || null, txType, absQty, targetLocId, date || new Date().toISOString().slice(0, 10), reason, userId]
    );
    await audit(client, req, 'adjust', 'inventory', item_id || null, { item_type, quantity: qty, reason, location_id: targetLocId });
    await touchWorkspace(client, req.user.company_id || req.user.workspace_id);
    await client.query('COMMIT');
    return res.status(201).json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('stock adjustment error', err);
    return res.status(500).json({ error: 'Failed to save adjustment: ' + err.message });
  } finally {
    client.release();
  }
});

// ============================================================
// TENANT AUDIT LOG (TAMPER-PROOF CRYPTOGRAPHIC AUDIT TRAIL)
// ============================================================

// Verify Cryptographic Hash Chain Integrity for Workspace
router.get('/audit-log/verify', requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  try {
    const result = await verifyTenantAuditChain(req.tenantDb);
    return res.json(result);
  } catch (err) {
    console.error('tenant audit verify error', err);
    return res.status(500).json({ valid: false, error: 'Failed to verify cryptographic audit trail' });
  }
});

// Export Tenant Audit Logs (CSV / JSON)
router.get('/audit-log/export', requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  try {
    await req.tenantDb.query('ALTER TABLE audit_log ADD COLUMN prev_hash VARCHAR(64) NULL').catch(() => {});
    await req.tenantDb.query('ALTER TABLE audit_log ADD COLUMN hash VARCHAR(64) NULL').catch(() => {});
    const format = (req.query.format || 'csv').toLowerCase();
    const search = req.query.search || '';
    const action = req.query.action || '';
    const entity_type = req.query.entity_type || '';
    const user_id = req.query.user_id || '';
    const start_date = req.query.start_date || '';
    const end_date = req.query.end_date || '';

    let where = '1=1';
    const params = [];

    if (search) {
      where += ` AND (al.action LIKE ? OR al.entity_type LIKE ? OR al.metadata LIKE ? OR u.name LIKE ? OR u.email LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (action && action !== 'all') {
      where += ` AND al.action = ?`;
      params.push(action);
    }
    if (entity_type && entity_type !== 'all') {
      where += ` AND al.entity_type = ?`;
      params.push(entity_type);
    }
    if (user_id && user_id !== 'all') {
      where += ` AND al.user_id = ?`;
      params.push(user_id);
    }
    if (start_date) {
      where += ` AND DATE(al.created_at) >= ?`;
      params.push(start_date);
    }
    if (end_date) {
      where += ` AND DATE(al.created_at) <= ?`;
      params.push(end_date);
    }

    const q = `
      SELECT al.id, al.action, al.entity_type, al.entity_id, al.metadata,
             al.prev_hash, al.hash, al.created_at, u.name AS user_name, u.email AS user_email
      FROM audit_log al
      LEFT JOIN users u ON u.id = al.user_id
      WHERE ${where}
      ORDER BY al.created_at DESC
      LIMIT 10000
    `;
    const rows = await req.tenantDb.query(q, params);
    const logs = rows.rows;

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="workspace_audit_${Date.now()}.json"`);
      return res.send(JSON.stringify(logs, null, 2));
    }

    const headers = ['ID', 'Timestamp', 'Actor Name', 'Actor Email', 'Action', 'Entity Type', 'Entity ID', 'Metadata', 'Prev Hash', 'Cryptographic Hash'];
    const csvRows = [
      headers.join(','),
      ...logs.map((row) => [
        `"${row.id}"`,
        `"${new Date(row.created_at).toISOString()}"`,
        `"${String(row.user_name || 'System').replace(/"/g, '""')}"`,
        `"${String(row.user_email || '').replace(/"/g, '""')}"`,
        `"${String(row.action || '').replace(/"/g, '""')}"`,
        `"${String(row.entity_type || '').replace(/"/g, '""')}"`,
        `"${String(row.entity_id || '').replace(/"/g, '""')}"`,
        `"${String(row.metadata || '').replace(/"/g, '""')}"`,
        `"${row.prev_hash || ''}"`,
        `"${row.hash || ''}"`
      ].join(','))
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="workspace_audit_${Date.now()}.csv"`);
    return res.send(csvRows.join('\n'));
  } catch (err) {
    console.error('tenant audit export error', err);
    return res.status(500).json({ error: 'Failed to export workspace audit logs' });
  }
});

// List Paginated Workspace Audit Logs
router.get('/audit-log', requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  try {
    await req.tenantDb.query('ALTER TABLE audit_log ADD COLUMN prev_hash VARCHAR(64) NULL').catch(() => {});
    await req.tenantDb.query('ALTER TABLE audit_log ADD COLUMN hash VARCHAR(64) NULL').catch(() => {});
  } catch (_) {}

  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const pageSize = Math.min(parseInt(req.query.page_size || req.query.limit || '20', 10), 200);
  const offset = (page - 1) * pageSize;
  const search = req.query.search || '';
  const action = req.query.action || '';
  const entity_type = req.query.entity_type || '';
  const user_id = req.query.user_id || '';
  const start_date = req.query.start_date || '';
  const end_date = req.query.end_date || '';

  let where = '1=1';
  const params = [];

  if (search) {
    where += ` AND (al.action LIKE ? OR al.entity_type LIKE ? OR al.metadata LIKE ? OR u.name LIKE ? OR u.email LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (action && action !== 'all') {
    where += ` AND (LOWER(al.action) = LOWER(?) OR LOWER(al.action) LIKE LOWER(?))`;
    params.push(action, `%${action}%`);
  }
  if (entity_type && entity_type !== 'all') {
    const singular = entity_type.endsWith('s') ? entity_type.slice(0, -1) : entity_type;
    const plural = entity_type.endsWith('s') ? entity_type : `${entity_type}s`;
    where += ` AND (LOWER(al.entity_type) = LOWER(?) OR LOWER(al.entity_type) = LOWER(?) OR LOWER(al.entity_type) LIKE LOWER(?))`;
    params.push(entity_type, singular, `%${singular}%`);
  }
  if (user_id && user_id !== 'all') {
    where += ` AND al.user_id = ?`;
    params.push(user_id);
  }
  if (start_date) {
    where += ` AND DATE(al.created_at) >= ?`;
    params.push(start_date);
  }
  if (end_date) {
    where += ` AND DATE(al.created_at) <= ?`;
    params.push(end_date);
  }

  const countQ = `
    SELECT COUNT(*) AS count
    FROM audit_log al
    LEFT JOIN users u ON u.id = al.user_id
    WHERE ${where}
  `;
  const countRes = await req.tenantDb.query(countQ, params);
  const total = parseInt(countRes.rows[0]?.count || 0, 10);

  const queryParams = [...params, pageSize, offset];
  const rows = await req.tenantDb.query(
    `SELECT al.id, al.action, al.entity_type, al.entity_id, al.metadata,
            al.prev_hash, al.hash, al.created_at, u.name AS user_name, u.email AS user_email
     FROM audit_log al
     LEFT JOIN users u ON u.id = al.user_id
     WHERE ${where}
     ORDER BY al.created_at DESC
     LIMIT ? OFFSET ?`,
    queryParams
  );

  const items = (rows.rows || []).map(r => {
    let parsedMeta = r.metadata;
    if (typeof parsedMeta === 'string') {
      try {
        parsedMeta = JSON.parse(parsedMeta);
      } catch (_) {}
    }
    return {
      ...r,
      metadata: parsedMeta
    };
  });

  return res.json({
    items,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize) || 1
  });
});

router.get('/data-export.json', requireAuth, requireRole('owner'), async (req, res) => {
  const tables = ['users', ...Object.values(MASTER_TABLES), ...STAFF_ENTRY_TABLES, 'inventory_ledger', 'payments_log', 'audit_log'];
  const output = {};
  const sensitiveKeys = new Set(['password_hash', 'token_hash', 'refresh_token', 'reset_token', 'auth_token', 'secret']);

  for (const table of tables) {
    try {
      const result = await req.tenantDb.query(`SELECT * FROM ${table}`);
      output[table] = result.rows.map((row) => {
        const cleanRow = {};
        for (const [key, value] of Object.entries(row)) {
          if (!sensitiveKeys.has(key.toLowerCase())) {
            cleanRow[key] = value;
          }
        }
        return cleanRow;
      });
    } catch (err) {
      // If table doesn't exist in current schema phase, continue
    }
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="company_export_${req.user.company_id}.json"`);
  return res.send(JSON.stringify(output, null, 2));
});

router.get('/data-export.csv', requireAuth, requireRole('owner'), async (req, res) => {
  const rows = await getInventorySnapshot(req.tenantDb);
  const csv = toCSV(rows, [
    { key: 'item_type', label: 'Type' },
    { key: 'name', label: 'Item' },
    { key: 'current_stock', label: 'Stock' },
    { key: 'unit', label: 'Unit' },
    { key: 'value_at_cost', label: 'Value at Cost' },
    { key: 'status', label: 'Status' }
  ]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="inventory_snapshot.csv"');
  return res.send(csv);
});

module.exports = router;
module.exports.withPaymentStatus = withPaymentStatus;
