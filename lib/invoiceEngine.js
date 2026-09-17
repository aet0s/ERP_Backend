// GST Invoicing Engine: Tax splitting, Rounding rules, and Numbering series

function applyRounding(val, method = 'round_half_up', target = 1) {
  const num = Number(val) || 0;
  if (method === 'none') return num;

  const mult = 1 / target;
  const scaled = num * mult;

  let roundedScaled = scaled;
  if (method === 'round_half_up') {
    roundedScaled = Math.floor(scaled + 0.5);
  } else if (method === 'round_half_down') {
    roundedScaled = Math.ceil(scaled - 0.5);
  } else if (method === 'always_up') {
    roundedScaled = Math.ceil(scaled);
  } else if (method === 'always_down') {
    roundedScaled = Math.floor(scaled);
  } else {
    roundedScaled = Math.round(scaled);
  }

  return roundedScaled / mult;
}

function calculateInvoiceLine({ quantity, ratePerUnit, discountPercent = 0, taxRate = 0, isInterstate = false }) {
  const qty = Math.max(0, Number(quantity) || 0);
  const rate = Math.max(0, Number(ratePerUnit) || 0);
  const discPct = Math.min(100, Math.max(0, Number(discountPercent) || 0));
  const tRate = Math.max(0, Number(taxRate) || 0);

  const gross = qty * rate;
  const discountAmount = gross * (discPct / 100);
  const taxableValue = gross - discountAmount;
  const taxAmount = taxableValue * (tRate / 100);

  let cgstRate = 0, cgstAmount = 0;
  let sgstRate = 0, sgstAmount = 0;
  let igstRate = 0, igstAmount = 0;

  if (isInterstate) {
    igstRate = tRate;
    igstAmount = taxAmount;
  } else {
    cgstRate = tRate / 2;
    cgstAmount = taxAmount / 2;
    sgstRate = tRate / 2;
    sgstAmount = taxAmount / 2;
  }

  const lineTotal = taxableValue + taxAmount;

  return {
    quantity: qty,
    rate_per_unit: rate,
    discount_percent: discPct,
    gross_amount: gross,
    discount_amount: discountAmount,
    taxable_value: taxableValue,
    tax_rate: tRate,
    cgst_rate: cgstRate,
    cgst_amount: cgstAmount,
    sgst_rate: sgstRate,
    sgst_amount: sgstAmount,
    igst_rate: igstRate,
    igst_amount: igstAmount,
    tax_amount: taxAmount,
    line_total: lineTotal
  };
}

function calculateInvoiceTotals(lines, options = {}) {
  const {
    invoiceDiscount = 0,
    roundingMethod = 'round_half_up',
    roundingTarget = 1
  } = options;

  let subtotal = 0;
  let cgstTotal = 0;
  let sgstTotal = 0;
  let igstTotal = 0;
  let totalTax = 0;

  for (const line of lines) {
    subtotal += line.taxable_value || 0;
    cgstTotal += line.cgst_amount || 0;
    sgstTotal += line.sgst_amount || 0;
    igstTotal += line.igst_amount || 0;
    totalTax += line.tax_amount || 0;
  }

  const preRoundingTotal = subtotal + totalTax - Math.max(0, Number(invoiceDiscount) || 0);
  const roundedGrandTotal = applyRounding(preRoundingTotal, roundingMethod, roundingTarget);
  const roundOffAmount = roundedGrandTotal - preRoundingTotal;

  return {
    subtotal,
    cgst_amount: cgstTotal,
    sgst_amount: sgstTotal,
    igst_amount: igstTotal,
    total_tax: totalTax,
    discount_amount: Math.max(0, Number(invoiceDiscount) || 0),
    pre_rounding_total: preRoundingTotal,
    round_off_amount: roundOffAmount,
    total_amount: roundedGrandTotal
  };
}

const DOCUMENT_TABLE_MAP = {
  vendor: { table: 'vendors', column: 'vendor_code' },
  customer: { table: 'customers', column: 'customer_code' },
  item: { table: 'items', column: 'code' },
  location: { table: 'locations', column: 'location_code' },
  production_run: { table: 'production_runs', column: 'run_number' },
  expense: { table: 'expenses', column: 'expense_number' },
  invoice: { table: 'invoices', column: 'invoice_number' },
  purchase_order: { table: 'purchase_orders', column: 'po_number' },
  credit_note: { table: 'credit_notes', column: 'credit_note_number' },
  debit_note: { table: 'debit_notes', column: 'debit_note_number' },
  procurement: { table: 'procurements', column: 'procurement_number' },
  production_order: { table: 'production_orders', column: 'order_number' },
  stock_transfer: { table: 'stock_transfers', column: 'transfer_number' },
  return_request: { table: 'return_requests', column: 'request_number' }
};

async function syncNumberingSeries(tenantDb, documentType, usedCode) {
  if (!tenantDb || !usedCode || typeof usedCode !== 'string') return;
  const match = usedCode.trim().match(/(\d+)$/);
  if (!match) return;
  const usedNum = parseInt(match[1], 10);
  if (isNaN(usedNum)) return;

  try {
    await tenantDb.query(
      `UPDATE numbering_series SET next_number = GREATEST(next_number, ?), updated_at = NOW() WHERE document_type = ?`,
      [usedNum + 1, documentType]
    );
  } catch (err) {
    // Non-fatal if series record not yet created
  }
}

async function getNextDocumentNumber(tenantDb, documentType, previewOnly = false) {
  const res = await tenantDb.query(
    `SELECT prefix, next_number, padding_digits, reset_period FROM numbering_series WHERE document_type = ? FOR UPDATE`,
    [documentType]
  );

  let prefix = 'DOC-';
  let nextNum = 1;
  let padding = 4;
  let resetPeriod = 'never';

  const defaultPrefixes = {
    vendor: { prefix: 'VEN-', resetPeriod: 'never' },
    customer: { prefix: 'CUST-', resetPeriod: 'never' },
    item: { prefix: 'SKU-', resetPeriod: 'never' },
    location: { prefix: 'LOC-', resetPeriod: 'never' },
    production_run: { prefix: 'RUN-', resetPeriod: 'never' },
    expense: { prefix: 'EXP-', resetPeriod: 'FY' },
    invoice: { prefix: 'INV-', resetPeriod: 'FY' },
    purchase_order: { prefix: 'PO-', resetPeriod: 'FY' },
    credit_note: { prefix: 'CN-', resetPeriod: 'FY' },
    debit_note: { prefix: 'DN-', resetPeriod: 'FY' },
    procurement: { prefix: 'PROC-', resetPeriod: 'FY' },
    production_order: { prefix: 'MFG-', resetPeriod: 'FY' },
    stock_transfer: { prefix: 'TRF-', resetPeriod: 'FY' },
    return_request: { prefix: 'RET-', resetPeriod: 'FY' }
  };

  const defaultMeta = defaultPrefixes[documentType] || {
    prefix: `${documentType.toUpperCase().slice(0, 4)}-`,
    resetPeriod: ['vendor', 'customer', 'item', 'location'].includes(documentType) ? 'never' : 'FY'
  };

  if (res.rows && res.rows.length > 0) {
    prefix = res.rows[0].prefix || defaultMeta.prefix;
    nextNum = parseInt(res.rows[0].next_number, 10) || 1;
    padding = parseInt(res.rows[0].padding_digits, 10) || 4;
    resetPeriod = res.rows[0].reset_period || defaultMeta.resetPeriod;
  } else {
    prefix = defaultMeta.prefix;
    resetPeriod = defaultMeta.resetPeriod;
    await tenantDb.query(
      `INSERT INTO numbering_series (document_type, prefix, next_number, padding_digits, reset_period)
       VALUES (?, ?, 1, 4, ?)
       ON DUPLICATE KEY UPDATE prefix = VALUES(prefix)`,
      [documentType, prefix, resetPeriod]
    ).catch(() => {});
  }

  // Cross-verify against existing table records so we never duplicate existing IDs/codes
  const tableMeta = DOCUMENT_TABLE_MAP[documentType];
  if (tableMeta) {
    try {
      const tableRows = await tenantDb.query(
        `SELECT ${tableMeta.column} AS code_val FROM ${tableMeta.table} WHERE ${tableMeta.column} IS NOT NULL AND ${tableMeta.column} != ''`
      );
      let maxExisting = 0;
      if (tableRows.rows && tableRows.rows.length > 0) {
        for (const r of tableRows.rows) {
          const val = String(r.code_val || '').trim();
          const match = val.match(/(\d+)$/);
          if (match) {
            const num = parseInt(match[1], 10);
            if (!isNaN(num) && num > maxExisting) {
              maxExisting = num;
            }
          }
        }
      }
      if (maxExisting >= nextNum) {
        nextNum = maxExisting + 1;
        // Keep numbering_series table in sync
        await tenantDb.query(
          `UPDATE numbering_series SET next_number = ?, updated_at = NOW() WHERE document_type = ?`,
          [nextNum, documentType]
        ).catch(() => {});
      }
    } catch (err) {
      // Ignore if table query fails
    }
  }

  let docNumber = '';
  if (resetPeriod === 'never') {
    docNumber = `${prefix}${String(nextNum).padStart(padding, '0')}`;
  } else {
    // Current financial year prefix if reset_period is 'FY'
    const now = new Date();
    const currentYear = now.getFullYear();
    const fyYear = now.getMonth() >= 3 ? `${currentYear}-${currentYear + 1}` : `${currentYear - 1}-${currentYear}`;
    docNumber = `${prefix}${fyYear}-${String(nextNum).padStart(padding, '0')}`;
  }

  if (!previewOnly) {
    await tenantDb.query(
      `UPDATE numbering_series SET next_number = ?, updated_at = NOW() WHERE document_type = ?`,
      [nextNum + 1, documentType]
    );
  }

  return docNumber;
}

module.exports = {
  applyRounding,
  calculateInvoiceLine,
  calculateInvoiceTotals,
  getNextDocumentNumber,
  syncNumberingSeries
};
