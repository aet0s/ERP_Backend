const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const { getNextDocumentNumber, syncNumberingSeries } = require('../lib/invoiceEngine');
const { queryMaster } = require('../db/masterDb');
const { getTenantPool } = require('../db/tenantManager');

// ─────────────────────────────────────────────────────────────────────────────
// VENDOR MASTER & VENDOR-ITEM LINKS (Part A)
// ─────────────────────────────────────────────────────────────────────────────

// Preview next auto-generated document code for master catalog and parties
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

// Check GSTIN and PAN uniqueness all over the ERP portal
router.get('/parties/check-tax-unique', requireAuth, async (req, res) => {
  try {
    const { gstin, pan, exclude_id } = req.query;
    const currentCompanyId = req.user?.company_id || req.user?.workspace_id;
    const duplicateError = await checkGstinAndPanUniqueness({
      tenantDb: req.tenantDb,
      currentId: exclude_id || null,
      gstin: gstin || null,
      pan: pan || null,
      currentCompanyId
    });

    if (duplicateError) {
      return res.json({ available: false, error: duplicateError });
    }
    return res.json({ available: true });
  } catch (err) {
    console.error('check-tax-unique error', err);
    return res.status(500).json({ error: 'Failed to verify tax ID uniqueness' });
  }
});

// Helper to ensure contacts is parsed as a JSON array for vendors/customers
function parsePartyContacts(row) {
  if (!row) return row;
  if (typeof row.contacts === 'string') {
    try {
      row.contacts = JSON.parse(row.contacts);
    } catch (e) {
      row.contacts = [];
    }
  } else if (!Array.isArray(row.contacts)) {
    row.contacts = [];
  }
  return row;
}

// List Vendors with Lifetime Value, Outstanding Balance, and Advanced Filters
router.get('/vendors', requireAuth, requirePermission('parties', 'view'), async (req, res) => {
  try {
    const { status, search, state, has_gstin, has_outstanding, connection_status, sort_by, sort_order } = req.query;
    let where = 'v.deleted_at IS NULL';
    const params = [];

    if (status && status.trim()) {
      const s = status.trim();
      if (s.toLowerCase() === 'active') {
        where += ` AND (v.status = 'Active' OR v.status IS NULL OR v.status = '')`;
      } else {
        params.push(s);
        where += ` AND v.status = ?`;
      }
    }

    if (state && state.trim()) {
      params.push(state.trim());
      where += ` AND v.state = ?`;
    }

    if (connection_status && connection_status.trim()) {
      params.push(connection_status.trim());
      where += ` AND v.connection_status = ?`;
    }

    if (has_gstin === '1') {
      where += ` AND (v.gstin IS NOT NULL AND TRIM(v.gstin) != '')`;
    } else if (has_gstin === '0') {
      where += ` AND (v.gstin IS NULL OR TRIM(v.gstin) = '')`;
    }

    if (has_outstanding === '1') {
      where += ` AND (SELECT COALESCE(SUM(p.amount_due), 0) FROM procurements p WHERE p.vendor_id = v.id AND p.deleted_at IS NULL) > 0`;
    } else if (has_outstanding === '0') {
      where += ` AND (SELECT COALESCE(SUM(p.amount_due), 0) FROM procurements p WHERE p.vendor_id = v.id AND p.deleted_at IS NULL) <= 0`;
    }

    if (search && search.trim()) {
      const q = `%${search.trim()}%`;
      where += ` AND (v.name LIKE ? OR v.vendor_code LIKE ? OR v.contact_person_name LIKE ? OR v.phone LIKE ? OR v.contact LIKE ? OR v.email LIKE ? OR v.gstin LIKE ? OR v.pan LIKE ? OR v.city LIKE ? OR v.state LIKE ?)`;
      params.push(q, q, q, q, q, q, q, q, q, q);
    }

    const countRes = await req.tenantDb.query(`SELECT COUNT(*) AS count FROM vendors v WHERE ${where}`, params);
    const total = parseInt(countRes.rows[0]?.count || 0, 10);

    const isTable = req.query.table === '1';
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(parseInt(req.query.page_size || req.query.limit || (isTable ? '20' : '200'), 10), 10000);
    const offset = (page - 1) * pageSize;

    let orderClause = 'ORDER BY v.created_at DESC';
    const orderDir = (sort_order || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    if (sort_by === 'total_business_value') {
      orderClause = `ORDER BY total_business_value ${orderDir}`;
    } else if (sort_by === 'outstanding_balance') {
      orderClause = `ORDER BY outstanding_balance ${orderDir}`;
    } else if (sort_by === 'name') {
      orderClause = `ORDER BY v.name ${orderDir}`;
    } else if (sort_by === 'code' || sort_by === 'vendor_code') {
      orderClause = `ORDER BY v.vendor_code ${orderDir}`;
    }

    let query = `
      SELECT v.*,
        COALESCE((SELECT SUM(p.total_amount) FROM procurements p WHERE p.vendor_id = v.id AND p.deleted_at IS NULL), 0) AS total_business_value,
        COALESCE((SELECT SUM(p.amount_due) FROM procurements p WHERE p.vendor_id = v.id AND p.deleted_at IS NULL), 0) AS outstanding_balance,
        (SELECT COUNT(*) FROM procurements p WHERE p.vendor_id = v.id AND p.deleted_at IS NULL) AS total_orders_count,
        CASE
          WHEN v.connection_status = 'connected' OR (SELECT COUNT(*) FROM vendor_portal_users vpu WHERE vpu.vendor_id = v.id AND (vpu.last_login_at IS NOT NULL OR vpu.password_hash IS NOT NULL)) > 0 THEN 'member'
          WHEN v.connection_status = 'invited' OR (SELECT COUNT(*) FROM vendor_portal_users vpu WHERE vpu.vendor_id = v.id) > 0 THEN 'invited'
          ELSE 'not_invited'
        END AS portal_status,
        (SELECT COUNT(*) FROM vendor_portal_users vpu WHERE vpu.vendor_id = v.id AND (vpu.last_login_at IS NOT NULL OR vpu.password_hash IS NOT NULL)) AS portal_logged_in_count,
        (SELECT COUNT(*) FROM vendor_portal_users vpu WHERE vpu.vendor_id = v.id) AS portal_users_count,
        (SELECT MAX(vpu.last_login_at) FROM vendor_portal_users vpu WHERE vpu.vendor_id = v.id) AS portal_last_login_at
      FROM vendors v
      WHERE ${where}
      ${orderClause}
    `;

    const queryParams = [...params];
    if (isTable || req.query.page || req.query.limit) {
      query += ` LIMIT ? OFFSET ?`;
      queryParams.push(pageSize, offset);
    }

    const result = await req.tenantDb.query(query, queryParams);
    result.rows.forEach(parsePartyContacts);

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
    console.error('get vendors error', err);
    return res.status(500).json({ error: 'Failed to fetch vendors' });
  }
});

// Validation helper for Vendor and Customer payloads
function validatePartyInput({ name, code, phone, email, pincode, gstin, pan, bank_account_number, bank_ifsc, type = 'vendor', isUpdate = false }) {
  if (!isUpdate || name !== undefined) {
    if (!name || typeof name !== 'string' || !name.trim()) {
      return `${type === 'vendor' ? 'Vendor' : 'Customer'} business name is required`;
    }
    if (name.trim().length < 2) {
      return `${type === 'vendor' ? 'Vendor' : 'Customer'} business name must be at least 2 characters`;
    }
  }
  if (code !== undefined && code !== null && String(code).trim() !== '') {
    if (!/^[A-Za-z0-9\-_]{3,25}$/.test(String(code).trim())) {
      return `Invalid ${type === 'vendor' ? 'vendor' : 'customer'} code format (letters, numbers, hyphens, 3-25 chars)`;
    }
  }
  if (phone !== undefined && phone !== null && String(phone).trim() !== '') {
    const digits = String(phone).replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) {
      return 'Primary phone number must contain 10 to 15 digits';
    }
  }
  if (email !== undefined && email !== null && String(email).trim() !== '') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
      return 'Invalid email address format';
    }
  }
  if (pincode !== undefined && pincode !== null && String(pincode).trim() !== '') {
    if (!/^[1-9][0-9]{5}$/.test(String(pincode).trim())) {
      return 'PIN code must be a valid 6-digit postal code';
    }
  }
  if (gstin !== undefined && gstin !== null && String(gstin).trim() !== '') {
    const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    if (!gstinRegex.test(String(gstin).trim().toUpperCase())) {
      return 'Invalid 15-character Indian GSTIN format (e.g. 22AAAAA0000A1Z5)';
    }
  }
  if (pan !== undefined && pan !== null && String(pan).trim() !== '') {
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
    if (!panRegex.test(String(pan).trim().toUpperCase())) {
      return 'Invalid 10-character PAN format (e.g. ABCDE1234F)';
    }
  }
  if (bank_account_number !== undefined && bank_account_number !== null && String(bank_account_number).trim() !== '') {
    if (!/^\d{9,18}$/.test(String(bank_account_number).trim())) {
      return 'Bank account number must be between 9 and 18 digits';
    }
  }
  if (bank_ifsc !== undefined && bank_ifsc !== null && String(bank_ifsc).trim() !== '') {
    const ifscRegex = /^[A-Z]{4}0[A-Z0-9]{6}$/;
    if (!ifscRegex.test(String(bank_ifsc).trim().toUpperCase())) {
      return 'Invalid 11-character Indian IFSC code (e.g. SBIN0001234)';
    }
  }
  return null;
}

// Uniqueness checker for GSTIN and PAN across the ERP portal
async function checkGstinAndPanUniqueness({ tenantDb, currentId, gstin, pan, currentCompanyId }) {
  const cleanGstin = gstin && typeof gstin === 'string' && gstin.trim() ? gstin.trim().toUpperCase() : null;
  const cleanPan = pan && typeof pan === 'string' && pan.trim() ? pan.trim().toUpperCase() : null;

  if (!cleanGstin && !cleanPan) return null;

  // 1. Check in the current company's tenant database
  if (cleanGstin) {
    const vCheck = await tenantDb.query(
      `SELECT id, name, vendor_code FROM vendors 
       WHERE UPPER(TRIM(gstin)) = ? AND (? IS NULL OR id != ?) AND deleted_at IS NULL LIMIT 1`,
      [cleanGstin, currentId || null, currentId || null]
    );
    if (vCheck.rows && vCheck.rows.length > 0) {
      return `GSTIN "${cleanGstin}" is already registered by vendor "${vCheck.rows[0].name}" (${vCheck.rows[0].vendor_code || 'Vendor'}). GSTIN must be unique all over the ERP portal.`;
    }

    const cCheck = await tenantDb.query(
      `SELECT id, name, customer_code FROM customers 
       WHERE UPPER(TRIM(gstin)) = ? AND (? IS NULL OR id != ?) AND deleted_at IS NULL LIMIT 1`,
      [cleanGstin, currentId || null, currentId || null]
    );
    if (cCheck.rows && cCheck.rows.length > 0) {
      return `GSTIN "${cleanGstin}" is already registered by customer "${cCheck.rows[0].name}" (${cCheck.rows[0].customer_code || 'Customer'}). GSTIN must be unique all over the ERP portal.`;
    }
  }

  if (cleanPan) {
    const vPanCheck = await tenantDb.query(
      `SELECT id, name, vendor_code FROM vendors 
       WHERE UPPER(TRIM(pan)) = ? AND (? IS NULL OR id != ?) AND deleted_at IS NULL LIMIT 1`,
      [cleanPan, currentId || null, currentId || null]
    );
    if (vPanCheck.rows && vPanCheck.rows.length > 0) {
      return `PAN "${cleanPan}" is already registered by vendor "${vPanCheck.rows[0].name}" (${vPanCheck.rows[0].vendor_code || 'Vendor'}). PAN must be unique all over the ERP portal.`;
    }

    const cPanCheck = await tenantDb.query(
      `SELECT id, name, customer_code FROM customers 
       WHERE UPPER(TRIM(pan)) = ? AND (? IS NULL OR id != ?) AND deleted_at IS NULL LIMIT 1`,
      [cleanPan, currentId || null, currentId || null]
    );
    if (cPanCheck.rows && cPanCheck.rows.length > 0) {
      return `PAN "${cleanPan}" is already registered by customer "${cPanCheck.rows[0].name}" (${cPanCheck.rows[0].customer_code || 'Customer'}). PAN must be unique all over the ERP portal.`;
    }
  }

  // 2. Check in master database: Companies
  if (cleanGstin) {
    const compGstin = await queryMaster(
      `SELECT id, company_name, company_code FROM companies 
       WHERE UPPER(TRIM(gstin)) = ? AND status != 'deleted' LIMIT 1`,
      [cleanGstin]
    );
    if (compGstin.rows && compGstin.rows.length > 0) {
      return `GSTIN "${cleanGstin}" is already registered by workspace company "${compGstin.rows[0].company_name}". GSTIN must be unique all over the ERP portal.`;
    }
  }

  if (cleanPan) {
    const compPan = await queryMaster(
      `SELECT id, company_name, company_code FROM companies 
       WHERE UPPER(TRIM(pan)) = ? AND status != 'deleted' LIMIT 1`,
      [cleanPan]
    );
    if (compPan.rows && compPan.rows.length > 0) {
      return `PAN "${cleanPan}" is already registered by workspace company "${compPan.rows[0].company_name}". PAN must be unique all over the ERP portal.`;
    }
  }

  // 3. Check across other active company tenant databases
  try {
    const otherCompanies = await queryMaster(
      `SELECT id, company_name, database_name FROM companies 
       WHERE status != 'deleted' AND (? IS NULL OR id != ?)`,
      [currentCompanyId || null, currentCompanyId || null]
    );

    for (const comp of otherCompanies.rows) {
      if (!comp.database_name) continue;
      try {
        const otherPool = getTenantPool(comp.database_name);
        if (cleanGstin) {
          const otherV = await otherPool.query(
            `SELECT id, name FROM vendors WHERE UPPER(TRIM(gstin)) = ? AND deleted_at IS NULL LIMIT 1`,
            [cleanGstin]
          );
          if (otherV.rows && otherV.rows.length > 0) {
            return `GSTIN "${cleanGstin}" is already registered in the ERP portal (by vendor "${otherV.rows[0].name}" in workspace "${comp.company_name}"). GSTIN must be unique all over the ERP portal.`;
          }
          const otherC = await otherPool.query(
            `SELECT id, name FROM customers WHERE UPPER(TRIM(gstin)) = ? AND deleted_at IS NULL LIMIT 1`,
            [cleanGstin]
          );
          if (otherC.rows && otherC.rows.length > 0) {
            return `GSTIN "${cleanGstin}" is already registered in the ERP portal (by customer "${otherC.rows[0].name}" in workspace "${comp.company_name}"). GSTIN must be unique all over the ERP portal.`;
          }
        }

        if (cleanPan) {
          const otherVPan = await otherPool.query(
            `SELECT id, name FROM vendors WHERE UPPER(TRIM(pan)) = ? AND deleted_at IS NULL LIMIT 1`,
            [cleanPan]
          );
          if (otherVPan.rows && otherVPan.rows.length > 0) {
            return `PAN "${cleanPan}" is already registered in the ERP portal (by vendor "${otherVPan.rows[0].name}" in workspace "${comp.company_name}"). PAN must be unique all over the ERP portal.`;
          }
          const otherCPan = await otherPool.query(
            `SELECT id, name FROM customers WHERE UPPER(TRIM(pan)) = ? AND deleted_at IS NULL LIMIT 1`,
            [cleanPan]
          );
          if (otherCPan.rows && otherCPan.rows.length > 0) {
            return `PAN "${cleanPan}" is already registered in the ERP portal (by customer "${otherCPan.rows[0].name}" in workspace "${comp.company_name}"). PAN must be unique all over the ERP portal.`;
          }
        }
      } catch (poolErr) {
        // Continue checking next tenant
      }
    }
  } catch (err) {
    console.error('Error during cross-tenant tax uniqueness check:', err);
  }

  return null;
}

// Create Vendor
router.post('/vendors', requireAuth, requirePermission('parties', 'create'), async (req, res) => {
  const {
    name, vendor_code, contact_person_name, contact, phone, email,
    street, address_line1, address_line2, address, city, state, pincode, country = 'India',
    gstin, pan, payment_terms = 'Net 30', bank_account_name, bank_account_number, bank_ifsc, notes, status = 'Active',
    contacts
  } = req.body;

  const validationError = validatePartyInput({
    name,
    code: vendor_code,
    phone,
    email,
    pincode,
    gstin,
    pan,
    bank_account_number,
    bank_ifsc,
    type: 'vendor'
  });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const currentCompanyId = req.user?.company_id || req.user?.workspace_id;
  const duplicateTaxError = await checkGstinAndPanUniqueness({
    tenantDb: req.tenantDb,
    currentId: null,
    gstin,
    pan,
    currentCompanyId
  });
  if (duplicateTaxError) {
    return res.status(400).json({ error: duplicateTaxError });
  }

  const cleanGstin = gstin && typeof gstin === 'string' && gstin.trim() ? gstin.trim().toUpperCase() : null;

  const contactList = Array.isArray(contacts) ? contacts : [];
  const primaryContact = contactList.length > 0 ? contactList[0] : {};

  const finalContactPerson = contact_person_name || primaryContact.name || contact || null;
  const finalPhone = phone || primaryContact.phone || contact || null;
  const finalEmail = email || primaryContact.email || null;
  const finalContact = contact || finalPhone || finalContactPerson || null;
  const finalAddress1 = street || address_line1 || address || null;
  const finalAddress = address || street || address_line1 || null;

  try {
    const code = vendor_code && vendor_code.trim()
      ? vendor_code.trim().toUpperCase()
      : await getNextDocumentNumber(req.tenantDb, 'vendor');

    await syncNumberingSeries(req.tenantDb, 'vendor', code);

    const id = crypto.randomUUID();

    await req.tenantDb.query(
      `INSERT INTO vendors (
        id, name, vendor_code, contact_person_name, phone, contact, email,
        address_line1, address_line2, address, city, state, pincode, country,
        gstin, pan, payment_terms, bank_account_name, bank_account_number, bank_ifsc, notes, status, contacts
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, name.trim(), code, finalContactPerson, finalPhone, finalContact, finalEmail,
        finalAddress1, address_line2 || null, finalAddress, city || null, state || null, pincode || null, country,
        cleanGstin, pan ? pan.trim().toUpperCase() : null,
        payment_terms, bank_account_name || null, bank_account_number || null, bank_ifsc || null, notes || null, status,
        JSON.stringify(contactList)
      ]
    );

    const fetched = await req.tenantDb.query('SELECT * FROM vendors WHERE id = ?', [id]);
    return res.status(201).json(parsePartyContacts(fetched.rows[0]));
  } catch (err) {
    console.error('create vendor error', err);
    return res.status(500).json({ error: 'Failed to create vendor: ' + err.message });
  }
});

// Get Vendor Detail with Price History, Metrics, and Recent Procurements
router.get('/vendors/:id', requireAuth, requirePermission('parties', 'view'), async (req, res) => {
  try {
    const vRes = await req.tenantDb.query(
      `SELECT v.*,
        COALESCE((SELECT SUM(p.total_amount) FROM procurements p WHERE p.vendor_id = v.id AND p.deleted_at IS NULL), 0) AS total_business_value,
        COALESCE((SELECT SUM(p.amount_due) FROM procurements p WHERE p.vendor_id = v.id AND p.deleted_at IS NULL), 0) AS outstanding_balance,
        (SELECT COUNT(*) FROM procurements p WHERE p.vendor_id = v.id AND p.deleted_at IS NULL) AS total_orders_count,
        CASE
          WHEN v.connection_status = 'connected' OR (SELECT COUNT(*) FROM vendor_portal_users vpu WHERE vpu.vendor_id = v.id AND (vpu.last_login_at IS NOT NULL OR vpu.password_hash IS NOT NULL)) > 0 THEN 'member'
          WHEN v.connection_status = 'invited' OR (SELECT COUNT(*) FROM vendor_portal_users vpu WHERE vpu.vendor_id = v.id) > 0 THEN 'invited'
          ELSE 'not_invited'
        END AS portal_status,
        (SELECT COUNT(*) FROM vendor_portal_users vpu WHERE vpu.vendor_id = v.id AND (vpu.last_login_at IS NOT NULL OR vpu.password_hash IS NOT NULL)) AS portal_logged_in_count,
        (SELECT COUNT(*) FROM vendor_portal_users vpu WHERE vpu.vendor_id = v.id) AS portal_users_count,
        (SELECT MAX(vpu.last_login_at) FROM vendor_portal_users vpu WHERE vpu.vendor_id = v.id) AS portal_last_login_at
       FROM vendors v
       WHERE v.id = ? AND v.deleted_at IS NULL`,
      [req.params.id]
    );
    if (vRes.rowCount === 0) return res.status(404).json({ error: 'Vendor not found' });

    const vendor = vRes.rows[0];
    parsePartyContacts(vendor);

    // Fetch recent procurements (top 5)
    const procRes = await req.tenantDb.query(
      `SELECT id, procurement_number, date, total_amount, amount_due, status
       FROM procurements
       WHERE vendor_id = ? AND deleted_at IS NULL
       ORDER BY date DESC, created_at DESC
       LIMIT 5`,
      [vendor.id]
    );
    vendor.recent_procurements = procRes.rows || [];

    // Fetch price history items (from vendor_items merged with live procurements)
    const priceHistoryRes = await req.tenantDb.query(
      `SELECT 
        i.id AS item_id,
        i.name AS item_name,
        i.code AS item_code,
        i.unit,
        i.item_type,
        COALESCE(vi.last_purchase_price, p_stats.last_rate) AS last_purchase_price,
        COALESCE(vi.last_purchase_date, p_stats.last_date) AS last_purchase_date,
        COALESCE(vi.last_purchase_date, p_stats.last_date) AS last_purchased_at,
        COALESCE(vi.is_preferred_vendor, 0) AS is_preferred_vendor,
        vi.vendor_item_code,
        vi.notes,
        p_stats.total_orders,
        p_stats.total_qty_supplied,
        p_stats.last_po_number
      FROM items i
      LEFT JOIN vendor_items vi ON vi.item_id = i.id AND vi.vendor_id = ?
      LEFT JOIN (
        SELECT 
          pi.item_id,
          SUBSTRING_INDEX(GROUP_CONCAT(pi.rate_per_unit ORDER BY p.date DESC, p.created_at DESC), ',', 1) AS last_rate,
          MAX(p.date) AS last_date,
          COUNT(DISTINCT p.id) AS total_orders,
          SUM(pi.quantity) AS total_qty_supplied,
          SUBSTRING_INDEX(GROUP_CONCAT(p.procurement_number ORDER BY p.date DESC, p.created_at DESC), ',', 1) AS last_po_number
        FROM procurements p
        JOIN procurement_items pi ON pi.procurement_id = p.id
        WHERE p.vendor_id = ? AND p.deleted_at IS NULL
        GROUP BY pi.item_id
      ) p_stats ON p_stats.item_id = i.id
      WHERE (vi.id IS NOT NULL OR p_stats.item_id IS NOT NULL)
        AND i.deleted_at IS NULL
      ORDER BY last_purchase_date DESC
      LIMIT 15`,
      [vendor.id, vendor.id]
    );
    vendor.price_history_items = priceHistoryRes.rows || [];
    // Keep backward-compat alias so existing clients don't break immediately
    vendor.items = priceHistoryRes.rows;
    return res.json(vendor);
  } catch (err) {
    console.error('get vendor detail error', err);
    return res.status(500).json({ error: 'Failed to fetch vendor detail' });
  }
});

// Update Vendor
router.put('/vendors/:id', requireAuth, requirePermission('parties', 'edit'), async (req, res) => {
  const {
    name, vendor_code, contact_person_name, contact, phone, email,
    street, address_line1, address_line2, address, city, state, pincode, country,
    gstin, pan, payment_terms, bank_account_name, bank_account_number, bank_ifsc, notes, status,
    contacts
  } = req.body;

  const validationError = validatePartyInput({
    name,
    code: vendor_code,
    phone,
    email,
    pincode,
    gstin,
    pan,
    bank_account_number,
    bank_ifsc,
    type: 'vendor',
    isUpdate: true
  });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const currentCompanyId = req.user?.company_id || req.user?.workspace_id;
  const duplicateTaxError = await checkGstinAndPanUniqueness({
    tenantDb: req.tenantDb,
    currentId: req.params.id,
    gstin,
    pan,
    currentCompanyId
  });
  if (duplicateTaxError) {
    return res.status(400).json({ error: duplicateTaxError });
  }

  const updates = [];
  const params = [];

  if (name !== undefined) {
    updates.push('name = ?');
    params.push(name.trim());
  }

  if (vendor_code !== undefined) {
    updates.push('vendor_code = ?');
    params.push(vendor_code && vendor_code.trim() ? vendor_code.trim().toUpperCase() : null);
  }

  const contactList = Array.isArray(contacts) ? contacts : null;
  const primaryContact = contactList && contactList.length > 0 ? contactList[0] : {};

  if (contact_person_name !== undefined || primaryContact.name !== undefined) {
    updates.push('contact_person_name = ?');
    params.push(contact_person_name || primaryContact.name || null);
  }

  if (phone !== undefined || primaryContact.phone !== undefined) {
    updates.push('phone = ?');
    params.push(phone || primaryContact.phone || null);
  }

  if (contact !== undefined) {
    updates.push('contact = ?');
    params.push(contact || null);
  }

  if (email !== undefined || primaryContact.email !== undefined) {
    updates.push('email = ?');
    params.push(email || primaryContact.email || null);
  }

  const newStreet = street !== undefined ? street : (address_line1 !== undefined ? address_line1 : (address !== undefined ? address : undefined));
  if (newStreet !== undefined) {
    updates.push('address_line1 = ?');
    params.push(newStreet || null);
    updates.push('address = ?');
    params.push(newStreet || null);
  }

  if (address_line2 !== undefined) {
    updates.push('address_line2 = ?');
    params.push(address_line2 || null);
  }

  if (city !== undefined) {
    updates.push('city = ?');
    params.push(city || null);
  }

  if (state !== undefined) {
    updates.push('state = ?');
    params.push(state || null);
  }

  if (pincode !== undefined) {
    updates.push('pincode = ?');
    params.push(pincode || null);
  }

  if (country !== undefined) {
    updates.push('country = ?');
    params.push(country || null);
  }

  if (gstin !== undefined) {
    const cleanGstin = gstin && typeof gstin === 'string' && gstin.trim() ? gstin.trim().toUpperCase() : null;
    if (cleanGstin) {
      const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
      if (!gstinRegex.test(cleanGstin)) {
        return res.status(400).json({ error: 'Invalid 15-character Indian GSTIN format' });
      }
    }
    updates.push('gstin = ?');
    params.push(cleanGstin);
  }

  if (pan !== undefined) {
    updates.push('pan = ?');
    params.push(pan && typeof pan === 'string' && pan.trim() ? pan.trim().toUpperCase() : null);
  }

  if (payment_terms !== undefined) {
    updates.push('payment_terms = ?');
    params.push(payment_terms || null);
  }

  if (bank_account_name !== undefined) {
    updates.push('bank_account_name = ?');
    params.push(bank_account_name || null);
  }

  if (bank_account_number !== undefined) {
    updates.push('bank_account_number = ?');
    params.push(bank_account_number || null);
  }

  if (bank_ifsc !== undefined) {
    updates.push('bank_ifsc = ?');
    params.push(bank_ifsc || null);
  }

  if (notes !== undefined) {
    updates.push('notes = ?');
    params.push(notes || null);
  }

  if (status !== undefined) {
    updates.push('status = ?');
    params.push(status || null);
  }

  if (contactList !== null) {
    updates.push('contacts = ?');
    params.push(JSON.stringify(contactList));
  }

  try {
    if (updates.length > 0) {
      updates.push('updated_at = NOW()');
      params.push(req.params.id);

      const updateRes = await req.tenantDb.query(
        `UPDATE vendors SET ${updates.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
        params
      );

      if (updateRes.rowCount === 0) return res.status(404).json({ error: 'Vendor not found' });
    }

    const fetched = await req.tenantDb.query('SELECT * FROM vendors WHERE id = ?', [req.params.id]);
    if (fetched.rowCount === 0) return res.status(404).json({ error: 'Vendor not found' });
    const vendorRow = fetched.rows[0];

    // Sync updated vendor data to any linked global portal user
    const companyId = req.user?.company_id || req.user?.workspace_id;
    if (companyId) {
      queryMaster(
        `SELECT global_user_id FROM global_portal_memberships 
         WHERE company_id = ? AND entity_id = ? AND portal_type = 'vendor'`,
        [companyId, req.params.id]
      ).then((mRes) => {
        if (mRes.rowCount > 0) {
          const gId = mRes.rows[0].global_user_id;
          queryMaster(
            `UPDATE global_portal_users
             SET company_name = COALESCE(?, company_name),
                 name = COALESCE(?, name),
                 phone = COALESCE(?, phone),
                 gstin = COALESCE(?, gstin),
                 pan = COALESCE(?, pan),
                 address = COALESCE(?, address),
                 city = COALESCE(?, city),
                 state = COALESCE(?, state),
                 pincode = COALESCE(?, pincode)
             WHERE id = ?`,
            [
              vendorRow.name,
              vendorRow.contact_person_name || vendorRow.contact || vendorRow.name,
              vendorRow.phone || vendorRow.contact,
              vendorRow.gstin,
              vendorRow.pan,
              vendorRow.address_line1 || vendorRow.address,
              vendorRow.city,
              vendorRow.state,
              vendorRow.pincode,
              gId
            ]
          ).catch(() => {});
        }
      }).catch(() => {});
    }

    return res.json(parsePartyContacts(vendorRow));
  } catch (err) {
    console.error('update vendor error', err);
    return res.status(500).json({ error: 'Failed to update vendor: ' + err.message });
  }
});

// Soft Delete Vendor
router.delete('/vendors/:id', requireAuth, requirePermission('parties', 'delete'), async (req, res) => {
  try {
    const result = await req.tenantDb.query(
      'UPDATE vendors SET deleted_at = NOW(), deleted_by = ? WHERE id = ?',
      [req.user.id, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Vendor not found' });
    return res.json({ ok: true, id: req.params.id });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete vendor' });
  }
});

// NOTE (Part A): The explicit vendor-item link endpoint has been removed.
// vendor_items is now updated automatically on every procurement save as a price history record.
// There is no pre-linking requirement — any item can be procured from any vendor freely.

// ─────────────────────────────────────────────────────────────────────────────
// ITEM MASTER & ITEM-VENDOR RELATIONS
// ─────────────────────────────────────────────────────────────────────────────

// List Items
router.get(['/items', '/catalog/items'], requireAuth, requirePermission('catalog', 'view'), async (req, res) => {
  try {
    const { item_type, status, search, vendor_id, stock_status } = req.query;
    let where = 'i.deleted_at IS NULL';
    const params = [];

    if (item_type) {
      params.push(item_type);
      where += ` AND i.item_type = ?`;
    }

    if (status) {
      params.push(status);
      where += ` AND i.status = ?`;
    }

    if (search) {
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      where += ` AND (i.name LIKE ? OR i.code LIKE ? OR i.hsn_code LIKE ?)`;
    }

    const stockSubquery = `COALESCE((SELECT SUM(CASE WHEN il.transaction_type = 'in' THEN il.quantity ELSE -il.quantity END) FROM inventory_ledger il WHERE il.item_id = i.id), 0)`;

    if (stock_status === 'in_stock') {
      where += ` AND ${stockSubquery} > 0`;
    } else if (stock_status === 'low_stock') {
      where += ` AND ${stockSubquery} <= i.reorder_level AND i.reorder_level IS NOT NULL AND i.reorder_level > 0`;
    } else if (stock_status === 'out_of_stock') {
      where += ` AND ${stockSubquery} <= 0`;
    }

    const countRes = await req.tenantDb.query(`SELECT COUNT(*) AS count FROM items i WHERE ${where}`, params);
    const total = parseInt(countRes.rows[0]?.count || 0, 10);

    const isTable = req.query.table === '1';
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(parseInt(req.query.page_size || req.query.limit || (isTable ? '20' : '200'), 10), 10000);
    const offset = (page - 1) * pageSize;

    let query = `SELECT i.*, 
      ${stockSubquery} AS current_stock,
      COALESCE(
        NULLIF(i.last_purchase_price, 0),
        (SELECT pi.rate_per_unit FROM procurement_items pi JOIN procurements p ON p.id = pi.procurement_id WHERE pi.item_id = i.id AND p.deleted_at IS NULL ORDER BY p.date DESC, p.created_at DESC LIMIT 1),
        (SELECT vi.last_purchase_price FROM vendor_items vi WHERE vi.item_id = i.id AND vi.last_purchase_price > 0 ORDER BY vi.last_purchase_date DESC LIMIT 1),
        (SELECT il.unit_cost FROM inventory_ledger il WHERE il.item_id = i.id AND il.unit_cost > 0 ORDER BY il.created_at DESC LIMIT 1),
        0
      ) AS effective_purchase_price
    FROM items i WHERE ${where} ORDER BY i.name ASC`;
    const queryParams = [...params];
    if (isTable || req.query.page || req.query.limit) {
      query += ` LIMIT ? OFFSET ?`;
      queryParams.push(pageSize, offset);
    }

    const result = await req.tenantDb.query(query, queryParams);
    let items = (result.rows || []).map((item) => {
      const resolvedPrice = Number(item.effective_purchase_price || item.last_purchase_price || 0);
      return {
        ...item,
        purchase_price: resolvedPrice,
        effective_purchase_price: resolvedPrice,
        last_purchase_price: resolvedPrice || Number(item.last_purchase_price || 0)
      };
    });

    // If vendor_id provided, annotate each item with that vendor's last purchase price as a hint
    if (vendor_id && items.length > 0) {
      const phRes = await req.tenantDb.query(
        `SELECT item_id, last_purchase_price, vendor_item_code, last_purchase_date
         FROM vendor_items WHERE vendor_id = ?`,
        [vendor_id]
      );
      const priceMap = {};
      for (const ph of phRes.rows) priceMap[ph.item_id] = ph;
      items = items.map((item) => ({
        ...item,
        last_vendor_price: priceMap[item.id]?.last_purchase_price || null,
        vendor_item_code: priceMap[item.id]?.vendor_item_code || null,
        last_purchase_date: priceMap[item.id]?.last_purchase_date || null
      }));
    }

    if (isTable) {
      return res.json({
        items,
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

    return res.json(items);
  } catch (err) {
    console.error('get items error', err);
    return res.status(500).json({ error: 'Failed to fetch items' });
  }
});

// Create Item
router.post('/items', requireAuth, requirePermission('catalog', 'create'), async (req, res) => {
  const { name, code, item_type = 'Raw Material', unit = 'kg', hsn_code, last_purchase_price = 0, default_price = null, reorder_level, tax_rate = 18, notes, status = 'Active' } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Item name is required' });

  try {
    let itemCode = code && code.trim() ? code.trim().toUpperCase() : await getNextDocumentNumber(req.tenantDb, 'item');
    await syncNumberingSeries(req.tenantDb, 'item', itemCode);
    const existingCode = await req.tenantDb.query('SELECT id FROM items WHERE code = ? AND deleted_at IS NULL', [itemCode]);
    if (existingCode.rowCount > 0) {
      itemCode = `${itemCode}-${Date.now().toString().slice(-4)}`;
    }

    const id = crypto.randomUUID();
    await req.tenantDb.query(
      `INSERT INTO items (id, name, code, item_type, unit, hsn_code, last_purchase_price, default_price, reorder_level, tax_rate, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name.trim(), itemCode, item_type, unit, hsn_code, last_purchase_price, default_price != null && default_price !== '' ? Number(default_price) : null, reorder_level, tax_rate, notes, status]
    );

    // Also sync into raw_materials table if Raw Material for backward compatibility
    const normType = (item_type || '').toLowerCase().replace(/[\s_]+/g, '');
    if (normType === 'rawmaterial') {
      await req.tenantDb.query(
        `INSERT INTO raw_materials (id, name, unit, reorder_level)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), unit = VALUES(unit), reorder_level = VALUES(reorder_level)`,
        [id, name.trim(), unit, reorder_level]
      ).catch(() => { });
    }

    const fetched = await req.tenantDb.query('SELECT * FROM items WHERE id = ?', [id]);
    return res.status(201).json(fetched.rows[0]);
  } catch (err) {
    console.error('create item error', err);
    return res.status(500).json({ error: 'Failed to create item: ' + err.message });
  }
});

const { getWeightedAvgCost } = require('../lib/analytics');

// Get Item Detail with Price History (informational, not a restriction)
router.get('/items/:id', requireAuth, requirePermission('catalog', 'view'), async (req, res) => {
  try {
    const stockSubquery = `COALESCE((SELECT SUM(CASE WHEN il.transaction_type = 'in' THEN il.quantity ELSE -il.quantity END) FROM inventory_ledger il WHERE il.item_id = i.id), 0)`;
    const itemRes = await req.tenantDb.query(
      `SELECT i.*, ${stockSubquery} AS current_stock FROM items i WHERE i.id = ? AND i.deleted_at IS NULL`,
      [req.params.id]
    );
    if (itemRes.rowCount === 0) return res.status(404).json({ error: 'Item not found' });
    const item = itemRes.rows[0];

    // Compute unified weighted average cost
    const avgCost = await getWeightedAvgCost(req.tenantDb, item.id);
    item.weighted_average_cost = avgCost;
    if (!item.last_purchase_price || Number(item.last_purchase_price) === 0) {
      item.last_purchase_price = avgCost;
    }

    // Part A: price history — which vendors have supplied this item before, and at what price (merged from vendor_items & procurements)
    const priceHistoryRes = await req.tenantDb.query(
      `SELECT 
        v.id AS vendor_id,
        v.name AS vendor_name,
        v.vendor_code,
        COALESCE(v.phone, v.contact) AS phone,
        v.email,
        COALESCE(vi.last_purchase_price, p_stats.last_rate) AS last_purchase_price,
        COALESCE(vi.last_purchase_date, p_stats.last_date) AS last_purchase_date,
        COALESCE(vi.is_preferred_vendor, 0) AS is_preferred_vendor,
        vi.vendor_item_code,
        p_stats.total_orders,
        p_stats.total_qty_supplied,
        p_stats.last_po_number
      FROM vendors v
      LEFT JOIN vendor_items vi ON vi.vendor_id = v.id AND vi.item_id = ?
      LEFT JOIN (
        SELECT 
          p.vendor_id,
          SUBSTRING_INDEX(GROUP_CONCAT(pi.rate_per_unit ORDER BY p.date DESC, p.created_at DESC), ',', 1) AS last_rate,
          MAX(p.date) AS last_date,
          COUNT(DISTINCT p.id) AS total_orders,
          SUM(pi.quantity) AS total_qty_supplied,
          SUBSTRING_INDEX(GROUP_CONCAT(p.procurement_number ORDER BY p.date DESC, p.created_at DESC), ',', 1) AS last_po_number
        FROM procurements p
        JOIN procurement_items pi ON pi.procurement_id = p.id
        WHERE pi.item_id = ? AND p.deleted_at IS NULL
        GROUP BY p.vendor_id
      ) p_stats ON p_stats.vendor_id = v.id
      WHERE (vi.id IS NOT NULL OR p_stats.vendor_id IS NOT NULL)
        AND v.deleted_at IS NULL
      ORDER BY last_purchase_date DESC, last_purchase_price ASC`,
      [item.id, item.id]
    );

    item.price_history_vendors = priceHistoryRes.rows;
    // Backward compat alias
    item.supplying_vendors = priceHistoryRes.rows;
    return res.json(item);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch item details' });
  }
});

// Update Item
router.put('/items/:id', requireAuth, requirePermission('catalog', 'edit'), async (req, res) => {
  const { name, code, item_type = 'Raw Material', unit = 'kg', hsn_code, last_purchase_price = 0, default_price, reorder_level, tax_rate = 18, notes, status = 'Active' } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Item name is required' });

  try {
    const updateRes = await req.tenantDb.query(
      `UPDATE items SET
        name = ?,
        code = COALESCE(?, code),
        item_type = COALESCE(?, item_type),
        unit = COALESCE(?, unit),
        hsn_code = ?,
        last_purchase_price = COALESCE(?, last_purchase_price),
        default_price = ?,
        reorder_level = ?,
        tax_rate = COALESCE(?, tax_rate),
        notes = ?,
        status = COALESCE(?, status),
        updated_at = NOW()
       WHERE id = ? AND deleted_at IS NULL`,
      [
        name.trim(), code ? code.trim().toUpperCase() : null, item_type, unit, hsn_code ? hsn_code.trim() : null,
        last_purchase_price != null ? Number(last_purchase_price) : null,
        default_price != null && default_price !== '' ? Number(default_price) : null,
        reorder_level != null ? Number(reorder_level) : null,
        tax_rate != null ? Number(tax_rate) : null,
        notes || null, status || null,
        req.params.id
      ]
    );

    if (updateRes.rowCount === 0) return res.status(404).json({ error: 'Item not found' });

    // Sync into raw_materials table if Raw Material
    const normType = (item_type || '').toLowerCase().replace(/[\s_]+/g, '');
    if (normType === 'rawmaterial') {
      await req.tenantDb.query(
        `INSERT INTO raw_materials (id, name, unit, reorder_level)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), unit = VALUES(unit), reorder_level = VALUES(reorder_level)`,
        [req.params.id, name.trim(), unit, reorder_level != null ? Number(reorder_level) : null]
      ).catch(() => {});
    }

    const fetched = await req.tenantDb.query('SELECT * FROM items WHERE id = ?', [req.params.id]);
    return res.json(fetched.rows[0]);
  } catch (err) {
    console.error('update item error', err);
    return res.status(500).json({ error: 'Failed to update item: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER MASTER & CUSTOMER-PRODUCT LINKS
// ─────────────────────────────────────────────────────────────────────────────

// List Customers with Lifetime Value, Outstanding Balance, and Advanced Filters
router.get('/customers', requireAuth, requirePermission('parties', 'view'), async (req, res) => {
  try {
    const { status, search, state, has_gstin, has_outstanding, connection_status, sort_by, sort_order } = req.query;
    let where = 'c.deleted_at IS NULL';
    const params = [];

    if (status && status.trim()) {
      const s = status.trim();
      if (s.toLowerCase() === 'active') {
        where += ` AND (c.status = 'Active' OR c.status IS NULL OR c.status = '')`;
      } else {
        params.push(s);
        where += ` AND c.status = ?`;
      }
    }

    if (state && state.trim()) {
      params.push(state.trim());
      where += ` AND c.state = ?`;
    }

    if (connection_status && connection_status.trim()) {
      params.push(connection_status.trim());
      where += ` AND c.connection_status = ?`;
    }

    if (has_gstin === '1') {
      where += ` AND (c.gstin IS NOT NULL AND TRIM(c.gstin) != '')`;
    } else if (has_gstin === '0') {
      where += ` AND (c.gstin IS NULL OR TRIM(c.gstin) = '')`;
    }

    if (has_outstanding === '1') {
      where += ` AND (SELECT COALESCE(SUM(s.amount_due), 0) FROM sales s WHERE s.customer_id = c.id AND s.deleted_at IS NULL) > 0`;
    } else if (has_outstanding === '0') {
      where += ` AND (SELECT COALESCE(SUM(s.amount_due), 0) FROM sales s WHERE s.customer_id = c.id AND s.deleted_at IS NULL) <= 0`;
    }

    if (search && search.trim()) {
      const q = `%${search.trim()}%`;
      where += ` AND (c.name LIKE ? OR c.customer_code LIKE ? OR c.contact_person_name LIKE ? OR c.phone LIKE ? OR c.contact LIKE ? OR c.email LIKE ? OR c.gstin LIKE ? OR c.pan LIKE ? OR c.city LIKE ? OR c.state LIKE ?)`;
      params.push(q, q, q, q, q, q, q, q, q, q);
    }

    const countRes = await req.tenantDb.query(`SELECT COUNT(*) AS count FROM customers c WHERE ${where}`, params);
    const total = parseInt(countRes.rows[0]?.count || 0, 10);

    const isTable = req.query.table === '1';
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(parseInt(req.query.page_size || req.query.limit || (isTable ? '20' : '200'), 10), 10000);
    const offset = (page - 1) * pageSize;

    let orderClause = 'ORDER BY c.created_at DESC';
    const orderDir = (sort_order || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    if (sort_by === 'total_business_value') {
      orderClause = `ORDER BY total_business_value ${orderDir}`;
    } else if (sort_by === 'outstanding_balance') {
      orderClause = `ORDER BY outstanding_balance ${orderDir}`;
    } else if (sort_by === 'name') {
      orderClause = `ORDER BY c.name ${orderDir}`;
    } else if (sort_by === 'code' || sort_by === 'customer_code') {
      orderClause = `ORDER BY c.customer_code ${orderDir}`;
    }

    let query = `
      SELECT c.*,
        COALESCE((SELECT SUM(s.total_amount) FROM sales s WHERE s.customer_id = c.id AND s.deleted_at IS NULL), 0) AS total_business_value,
        COALESCE((SELECT SUM(s.amount_due) FROM sales s WHERE s.customer_id = c.id AND s.deleted_at IS NULL), 0) AS outstanding_balance,
        (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.deleted_at IS NULL) AS total_orders_count,
        CASE
          WHEN c.connection_status = 'connected' OR (SELECT COUNT(*) FROM customer_portal_users cpu WHERE cpu.customer_id = c.id AND (cpu.last_login_at IS NOT NULL OR cpu.password_hash IS NOT NULL)) > 0 THEN 'member'
          WHEN c.connection_status = 'invited' OR (SELECT COUNT(*) FROM customer_portal_users cpu WHERE cpu.customer_id = c.id) > 0 THEN 'invited'
          ELSE 'not_invited'
        END AS portal_status,
        (SELECT COUNT(*) FROM customer_portal_users cpu WHERE cpu.customer_id = c.id AND (cpu.last_login_at IS NOT NULL OR cpu.password_hash IS NOT NULL)) AS portal_logged_in_count,
        (SELECT COUNT(*) FROM customer_portal_users cpu WHERE cpu.customer_id = c.id) AS portal_users_count,
        (SELECT MAX(cpu.last_login_at) FROM customer_portal_users cpu WHERE cpu.customer_id = c.id) AS portal_last_login_at
      FROM customers c
      WHERE ${where}
      ${orderClause}
    `;

    const queryParams = [...params];
    if (isTable || req.query.page || req.query.limit) {
      query += ` LIMIT ? OFFSET ?`;
      queryParams.push(pageSize, offset);
    }

    const result = await req.tenantDb.query(query, queryParams);
    result.rows.forEach(parsePartyContacts);

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
    console.error('get customers error', err);
    return res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

// Get Customer Detail with Metrics and Recent Sales
router.get('/customers/:id', requireAuth, requirePermission('parties', 'view'), async (req, res) => {
  try {
    const cRes = await req.tenantDb.query(
      `SELECT c.*,
        COALESCE((SELECT SUM(s.total_amount) FROM sales s WHERE s.customer_id = c.id AND s.deleted_at IS NULL), 0) AS total_business_value,
        COALESCE((SELECT SUM(s.amount_due) FROM sales s WHERE s.customer_id = c.id AND s.deleted_at IS NULL), 0) AS outstanding_balance,
        (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.deleted_at IS NULL) AS total_orders_count,
        CASE
          WHEN c.connection_status = 'connected' OR (SELECT COUNT(*) FROM customer_portal_users cpu WHERE cpu.customer_id = c.id AND (cpu.last_login_at IS NOT NULL OR cpu.password_hash IS NOT NULL)) > 0 THEN 'member'
          WHEN c.connection_status = 'invited' OR (SELECT COUNT(*) FROM customer_portal_users cpu WHERE cpu.customer_id = c.id) > 0 THEN 'invited'
          ELSE 'not_invited'
        END AS portal_status,
        (SELECT COUNT(*) FROM customer_portal_users cpu WHERE cpu.customer_id = c.id AND (cpu.last_login_at IS NOT NULL OR cpu.password_hash IS NOT NULL)) AS portal_logged_in_count,
        (SELECT COUNT(*) FROM customer_portal_users cpu WHERE cpu.customer_id = c.id) AS portal_users_count,
        (SELECT MAX(cpu.last_login_at) FROM customer_portal_users cpu WHERE cpu.customer_id = c.id) AS portal_last_login_at
       FROM customers c
       WHERE c.id = ? AND c.deleted_at IS NULL`,
      [req.params.id]
    );
    if (cRes.rowCount === 0) return res.status(404).json({ error: 'Customer not found' });

    const customer = cRes.rows[0];
    parsePartyContacts(customer);

    // Fetch recent sales (top 5)
    const salesRes = await req.tenantDb.query(
      `SELECT id, invoice_number, date, total_amount, amount_due, payment_status AS status
       FROM sales
       WHERE customer_id = ? AND deleted_at IS NULL
       ORDER BY date DESC, created_at DESC
       LIMIT 5`,
      [customer.id]
    );
    customer.recent_sales = salesRes.rows || [];

    return res.json(customer);
  } catch (err) {
    console.error('get customer detail error', err);
    return res.status(500).json({ error: 'Failed to fetch customer detail' });
  }
});

// Create Customer
router.post('/customers', requireAuth, requirePermission('parties', 'create'), async (req, res) => {
  const {
    name, customer_code, contact_person_name, contact, phone, email,
    street, billing_address, shipping_address, address, city, state, pincode, country = 'India',
    gstin, pan, payment_terms = 'Net 30', credit_limit, notes, status = 'Active',
    contacts
  } = req.body;

  const validationError = validatePartyInput({
    name,
    code: customer_code,
    phone,
    email,
    pincode,
    gstin,
    pan,
    type: 'customer'
  });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const currentCompanyId = req.user?.company_id || req.user?.workspace_id;
  const duplicateTaxError = await checkGstinAndPanUniqueness({
    tenantDb: req.tenantDb,
    currentId: null,
    gstin,
    pan,
    currentCompanyId
  });
  if (duplicateTaxError) {
    return res.status(400).json({ error: duplicateTaxError });
  }

  const cleanGstin = gstin && typeof gstin === 'string' && gstin.trim() ? gstin.trim().toUpperCase() : null;
  if (cleanGstin) {
    const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    if (!gstinRegex.test(cleanGstin)) {
      return res.status(400).json({ error: 'Invalid 15-character Indian GSTIN format' });
    }
  }

  const contactList = Array.isArray(contacts) ? contacts : [];
  const primaryContact = contactList.length > 0 ? contactList[0] : {};

  const finalContactPerson = contact_person_name || primaryContact.name || contact || null;
  const finalPhone = phone || primaryContact.phone || contact || null;
  const finalEmail = email || primaryContact.email || null;
  const finalContact = contact || finalPhone || finalContactPerson || null;
  const finalBillingAddress = street || billing_address || address || null;
  const finalAddress = address || street || billing_address || null;

  try {
    const code = customer_code && customer_code.trim() ? customer_code.trim().toUpperCase() : await getNextDocumentNumber(req.tenantDb, 'customer');
    await syncNumberingSeries(req.tenantDb, 'customer', code);
    const id = crypto.randomUUID();
    await req.tenantDb.query(
      `INSERT INTO customers (
        id, name, customer_code, contact_person_name, phone, contact, email,
        billing_address, shipping_address, address, city, state, pincode, country,
        gstin, pan, payment_terms, credit_limit, notes, status, contacts
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, name.trim(), code, finalContactPerson, finalPhone, finalContact, finalEmail,
        finalBillingAddress, shipping_address || null, finalAddress, city || null, state || null, pincode || null, country,
        cleanGstin, pan ? pan.trim().toUpperCase() : null,
        payment_terms, credit_limit || null, notes || null, status,
        JSON.stringify(contactList)
      ]
    );

    const fetched = await req.tenantDb.query('SELECT * FROM customers WHERE id = ?', [id]);
    return res.status(201).json(parsePartyContacts(fetched.rows[0]));
  } catch (err) {
    console.error('create customer error', err);
    return res.status(500).json({ error: 'Failed to create customer: ' + err.message });
  }
});

// Update Customer
router.put('/customers/:id', requireAuth, requirePermission('parties', 'edit'), async (req, res) => {
  const {
    name, customer_code, contact_person_name, contact, phone, email,
    street, billing_address, shipping_address, address, city, state, pincode, country,
    gstin, pan, payment_terms, credit_limit, notes, status,
    contacts
  } = req.body;

  const validationError = validatePartyInput({
    name,
    code: customer_code,
    phone,
    email,
    pincode,
    gstin,
    pan,
    type: 'customer',
    isUpdate: true
  });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const updateCompanyId = req.user?.company_id || req.user?.workspace_id;
  const duplicateTaxError = await checkGstinAndPanUniqueness({
    tenantDb: req.tenantDb,
    currentId: req.params.id,
    gstin,
    pan,
    currentCompanyId: updateCompanyId
  });
  if (duplicateTaxError) {
    return res.status(400).json({ error: duplicateTaxError });
  }

  const updates = [];
  const params = [];

  if (name !== undefined) {
    updates.push('name = ?');
    params.push(name.trim());
  }

  if (customer_code !== undefined) {
    updates.push('customer_code = ?');
    params.push(customer_code && customer_code.trim() ? customer_code.trim().toUpperCase() : null);
  }

  const contactList = Array.isArray(contacts) ? contacts : null;
  const primaryContact = contactList && contactList.length > 0 ? contactList[0] : {};

  if (contact_person_name !== undefined || primaryContact.name !== undefined) {
    updates.push('contact_person_name = ?');
    params.push(contact_person_name || primaryContact.name || null);
  }

  if (phone !== undefined || primaryContact.phone !== undefined) {
    updates.push('phone = ?');
    params.push(phone || primaryContact.phone || null);
  }

  if (contact !== undefined) {
    updates.push('contact = ?');
    params.push(contact || null);
  }

  if (email !== undefined || primaryContact.email !== undefined) {
    updates.push('email = ?');
    params.push(email || primaryContact.email || null);
  }

  const newBilling = street !== undefined ? street : (billing_address !== undefined ? billing_address : (address !== undefined ? address : undefined));
  if (newBilling !== undefined) {
    updates.push('billing_address = ?');
    params.push(newBilling || null);
    updates.push('address = ?');
    params.push(newBilling || null);
  }

  if (shipping_address !== undefined) {
    updates.push('shipping_address = ?');
    params.push(shipping_address || null);
  }

  if (city !== undefined) {
    updates.push('city = ?');
    params.push(city || null);
  }

  if (state !== undefined) {
    updates.push('state = ?');
    params.push(state || null);
  }

  if (pincode !== undefined) {
    updates.push('pincode = ?');
    params.push(pincode || null);
  }

  if (country !== undefined) {
    updates.push('country = ?');
    params.push(country || null);
  }

  if (gstin !== undefined) {
    const cleanGstin = gstin && typeof gstin === 'string' && gstin.trim() ? gstin.trim().toUpperCase() : null;
    if (cleanGstin) {
      const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
      if (!gstinRegex.test(cleanGstin)) {
        return res.status(400).json({ error: 'Invalid 15-character Indian GSTIN format' });
      }
    }
    updates.push('gstin = ?');
    params.push(cleanGstin);
  }

  if (pan !== undefined) {
    updates.push('pan = ?');
    params.push(pan && typeof pan === 'string' && pan.trim() ? pan.trim().toUpperCase() : null);
  }

  if (payment_terms !== undefined) {
    updates.push('payment_terms = ?');
    params.push(payment_terms || null);
  }

  if (credit_limit !== undefined) {
    updates.push('credit_limit = ?');
    params.push(credit_limit != null && credit_limit !== '' ? Number(credit_limit) : null);
  }

  if (notes !== undefined) {
    updates.push('notes = ?');
    params.push(notes || null);
  }

  if (status !== undefined) {
    updates.push('status = ?');
    params.push(status || null);
  }

  if (contactList !== null) {
    updates.push('contacts = ?');
    params.push(JSON.stringify(contactList));
  }

  try {
    if (updates.length > 0) {
      updates.push('updated_at = NOW()');
      params.push(req.params.id);

      const updateRes = await req.tenantDb.query(
        `UPDATE customers SET ${updates.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
        params
      );

      if (updateRes.rowCount === 0) return res.status(404).json({ error: 'Customer not found' });
    }

    const fetched = await req.tenantDb.query('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (fetched.rowCount === 0) return res.status(404).json({ error: 'Customer not found' });
    const custRow = fetched.rows[0];

    // Sync updated customer data to any linked global portal user
    const companyId = req.user?.company_id || req.user?.workspace_id;
    if (companyId) {
      queryMaster(
        `SELECT global_user_id FROM global_portal_memberships 
         WHERE company_id = ? AND entity_id = ? AND portal_type = 'customer'`,
        [companyId, req.params.id]
      ).then((mRes) => {
        if (mRes.rowCount > 0) {
          const gId = mRes.rows[0].global_user_id;
          queryMaster(
            `UPDATE global_portal_users
             SET company_name = COALESCE(?, company_name),
                 name = COALESCE(?, name),
                 phone = COALESCE(?, phone),
                 gstin = COALESCE(?, gstin),
                 pan = COALESCE(?, pan),
                 address = COALESCE(?, address),
                 city = COALESCE(?, city),
                 state = COALESCE(?, state),
                 pincode = COALESCE(?, pincode)
             WHERE id = ?`,
            [
              custRow.name,
              custRow.contact_person_name || custRow.contact || custRow.name,
              custRow.phone || custRow.contact,
              custRow.gstin,
              custRow.pan,
              custRow.billing_address || custRow.shipping_address || custRow.address,
              custRow.city,
              custRow.state,
              custRow.pincode,
              gId
            ]
          ).catch(() => {});
        }
      }).catch(() => {});
    }

    return res.json(parsePartyContacts(custRow));
  } catch (err) {
    console.error('update customer error', err);
    return res.status(500).json({ error: 'Failed to update customer: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PACKAGING CONFIGURATIONS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/packaging-configs', requireAuth, requirePermission('catalog', 'view'), async (req, res) => {
  try {
    const { product_id } = req.query;
    let query = `
      SELECT ppl.id, ppl.product_id, ppl.product_type, ppl.name AS package_name, ppl.package_unit,
             ppl.base_quantity_equivalent AS units_per_package,
             ppl.contains_quantity AS fill_quantity,
             ppl.contains_unit AS fill_unit,
             ppl.parent_level_id AS parent_config_id,
             ppl.selling_price, ppl.mrp, ppl.barcode, ppl.is_default, ppl.notes,
             parent.name AS parent_package_name, parent.package_unit AS parent_package_unit,
             parent.base_quantity_equivalent AS parent_units_per_package
      FROM product_packaging_levels ppl
      LEFT JOIN product_packaging_levels parent ON parent.id = ppl.parent_level_id
      WHERE ppl.status != 'archived'
    `;
    const params = [];
    if (product_id) {
      params.push(product_id);
      query += ` AND ppl.product_id = ?`;
    }
    query += ' ORDER BY ppl.base_quantity_equivalent ASC, ppl.created_at ASC';
    const result = await req.tenantDb.query(query, params);
    return res.json(result.rows);
  } catch (err) {
    console.error('get packaging configs error', err);
    return res.status(500).json({ error: 'Failed to fetch packaging configurations' });
  }
});

router.post('/packaging-configs', requireAuth, requirePermission('catalog', 'create'), async (req, res) => {
  const {
    product_id,
    product_type = 'finished_good',
    package_name,
    package_unit,
    units_per_package,
    fill_quantity,
    fill_unit,
    parent_config_id,
    mrp = 0,
    selling_price = 0,
    barcode,
    is_default = false,
    notes
  } = req.body;

  if (!product_id && product_type !== 'global_template') return res.status(400).json({ error: 'Product ID is required' });
  if (!package_name || !package_name.trim()) return res.status(400).json({ error: 'Package Name is required' });
  if (!package_unit || !package_unit.trim()) return res.status(400).json({ error: 'Package Unit (e.g. Strip, Packet, Box) is required' });

  try {
    let finalUnits = Number(units_per_package) || 1;
    let finalFillQty = Number(fill_quantity) || finalUnits;
    let finalFillUnit = fill_unit ? fill_unit.trim() : null;

    if (parent_config_id) {
      const parentRes = await req.tenantDb.query('SELECT units_per_package, package_unit FROM packaging_configs WHERE id = ?', [parent_config_id]);
      if (parentRes.rowCount > 0) {
        const parentUnits = Number(parentRes.rows[0].units_per_package) || 1;
        finalUnits = (Number(fill_quantity) || 1) * parentUnits;
        if (!finalFillUnit) finalFillUnit = parentRes.rows[0].package_unit;
      }
    }

    const id = crypto.randomUUID();
    await req.tenantDb.query(
      `INSERT INTO packaging_configs 
         (id, product_id, product_type, package_name, package_unit, units_per_package, fill_quantity, fill_unit, parent_config_id, mrp, selling_price, barcode, is_default, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        product_id || null,
        product_type,
        package_name.trim(),
        package_unit.trim(),
        finalUnits,
        finalFillQty,
        finalFillUnit,
        parent_config_id || null,
        Number(mrp) || 0,
        Number(selling_price) || 0,
        barcode || null,
        Boolean(is_default) ? 1 : 0,
        notes || null
      ]
    );

    const fetched = await req.tenantDb.query(
      `SELECT pc.*, 
              parent.package_name AS parent_package_name, 
              parent.package_unit AS parent_package_unit,
              parent.units_per_package AS parent_units_per_package
       FROM packaging_configs pc
       LEFT JOIN packaging_configs parent ON parent.id = pc.parent_config_id
       WHERE pc.id = ?`,
      [id]
    );
    return res.status(201).json(fetched.rows[0]);
  } catch (err) {
    console.error('create packaging config error', err);
    return res.status(500).json({ error: 'Failed to create packaging config: ' + err.message });
  }
});

router.put('/packaging-configs/:id', requireAuth, requirePermission('catalog', 'edit'), async (req, res) => {
  const {
    package_name,
    package_unit,
    units_per_package,
    fill_quantity,
    fill_unit,
    parent_config_id,
    mrp,
    selling_price,
    barcode,
    is_default,
    notes
  } = req.body;

  try {
    let finalUnits = units_per_package !== undefined ? Number(units_per_package) : undefined;
    if (parent_config_id) {
      const parentRes = await req.tenantDb.query('SELECT units_per_package, package_unit FROM packaging_configs WHERE id = ?', [parent_config_id]);
      if (parentRes.rowCount > 0 && fill_quantity !== undefined) {
        finalUnits = Number(fill_quantity) * (Number(parentRes.rows[0].units_per_package) || 1);
      }
    }

    const updateRes = await req.tenantDb.query(
      `UPDATE packaging_configs SET
        package_name = COALESCE(?, package_name),
        package_unit = COALESCE(?, package_unit),
        units_per_package = COALESCE(?, units_per_package),
        fill_quantity = COALESCE(?, fill_quantity),
        fill_unit = COALESCE(?, fill_unit),
        parent_config_id = COALESCE(?, parent_config_id),
        mrp = COALESCE(?, mrp),
        selling_price = COALESCE(?, selling_price),
        barcode = COALESCE(?, barcode),
        is_default = COALESCE(?, is_default),
        notes = COALESCE(?, notes),
        updated_at = NOW()
       WHERE id = ?`,
      [
        package_name,
        package_unit,
        finalUnits,
        fill_quantity,
        fill_unit,
        parent_config_id,
        mrp,
        selling_price,
        barcode,
        is_default !== undefined ? (is_default ? 1 : 0) : undefined,
        notes,
        req.params.id
      ]
    );
    if (updateRes.rowCount === 0) return res.status(404).json({ error: 'Packaging config not found' });
    const fetched = await req.tenantDb.query(
      `SELECT pc.*, 
              parent.package_name AS parent_package_name, 
              parent.package_unit AS parent_package_unit,
              parent.units_per_package AS parent_units_per_package
       FROM packaging_configs pc
       LEFT JOIN packaging_configs parent ON parent.id = pc.parent_config_id
       WHERE pc.id = ?`,
      [req.params.id]
    );
    return res.json(fetched.rows[0]);
  } catch (err) {
    console.error('update packaging config error', err);
    return res.status(500).json({ error: 'Failed to update packaging config' });
  }
});

router.delete('/packaging-configs/:id', requireAuth, requirePermission('catalog', 'delete'), async (req, res) => {
  try {
    await req.tenantDb.query('DELETE FROM packaging_configs WHERE id = ?', [req.params.id]);
    return res.json({ message: 'Packaging config deleted successfully' });
  } catch (err) {
    console.error('delete packaging config error', err);
    return res.status(500).json({ error: 'Failed to delete packaging config' });
  }
});

// Soft Delete Item (Purchasing / Raw Materials)
router.delete('/items/:id', requireAuth, requirePermission('catalog', 'delete'), async (req, res) => {
  const userId = req.user.user_id || req.user.id;
  try {
    const updateRes = await req.tenantDb.query(
      'UPDATE items SET deleted_at = NOW(), deleted_by = ? WHERE id = ? AND deleted_at IS NULL',
      [userId, req.params.id]
    );
    // Also soft-delete in raw_materials if present
    await req.tenantDb.query(
      'UPDATE raw_materials SET deleted_at = NOW(), deleted_by = ? WHERE id = ? AND deleted_at IS NULL',
      [userId, req.params.id]
    ).catch(() => {});

    if (updateRes.rowCount === 0) {
      return res.status(404).json({ error: 'Item not found or already deleted' });
    }

    const { logTenantAudit } = require('../lib/auditCrypto');
    await logTenantAudit(req.tenantDb, {
      user_id: userId,
      action: 'delete',
      entity_type: 'raw_material',
      entity_id: req.params.id,
      metadata: { item_id: req.params.id }
    }).catch(() => {});

    return res.json({ ok: true, message: 'Item deleted successfully' });
  } catch (err) {
    console.error('delete item error:', err);
    return res.status(500).json({ error: 'Failed to delete item: ' + err.message });
  }
});

// Soft Delete Vendor
router.delete('/vendors/:id', requireAuth, requirePermission('parties', 'delete'), async (req, res) => {
  const userId = req.user.user_id || req.user.id;
  try {
    const updateRes = await req.tenantDb.query(
      'UPDATE vendors SET deleted_at = NOW(), deleted_by = ? WHERE id = ? AND deleted_at IS NULL',
      [userId, req.params.id]
    );
    if (updateRes.rowCount === 0) {
      return res.status(404).json({ error: 'Vendor not found or already deleted' });
    }

    const { logTenantAudit } = require('../lib/auditCrypto');
    await logTenantAudit(req.tenantDb, {
      user_id: userId,
      action: 'delete',
      entity_type: 'vendor',
      entity_id: req.params.id,
      metadata: { vendor_id: req.params.id }
    }).catch(() => {});

    return res.json({ ok: true, message: 'Vendor deleted successfully' });
  } catch (err) {
    console.error('delete vendor error:', err);
    return res.status(500).json({ error: 'Failed to delete vendor: ' + err.message });
  }
});

// Soft Delete Customer
router.delete('/customers/:id', requireAuth, requirePermission('parties', 'delete'), async (req, res) => {
  const userId = req.user.user_id || req.user.id;
  try {
    const updateRes = await req.tenantDb.query(
      'UPDATE customers SET deleted_at = NOW(), deleted_by = ? WHERE id = ? AND deleted_at IS NULL',
      [userId, req.params.id]
    );
    if (updateRes.rowCount === 0) {
      return res.status(404).json({ error: 'Customer not found or already deleted' });
    }

    const { logTenantAudit } = require('../lib/auditCrypto');
    await logTenantAudit(req.tenantDb, {
      user_id: userId,
      action: 'delete',
      entity_type: 'customer',
      entity_id: req.params.id,
      metadata: { customer_id: req.params.id }
    }).catch(() => {});

    return res.json({ ok: true, message: 'Customer deleted successfully' });
  } catch (err) {
    console.error('delete customer error:', err);
    return res.status(500).json({ error: 'Failed to delete customer: ' + err.message });
  }
});

module.exports = router;

