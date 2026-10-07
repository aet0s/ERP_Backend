'use strict';

/**
 * returnsEngine.js — Core engine for processing returns, cancellations, debit/credit notes,
 * inventory ledger adjustments, and net balance / refund calculations.
 */

const crypto = require('crypto');
const { getNextDocumentNumber } = require('./invoiceEngine');

/**
 * Calculate net financial dues and refunds for a procurement.
 */
function getProcurementFinancials(procurement, debitNoteTotal = 0) {
  const subtotal = Number(procurement.subtotal) || 0;
  const taxAmount = Number(procurement.tax_amount) || 0;
  const discount = Number(procurement.discount_amount) || 0;
  let originalTotal = 0;
  if (subtotal > 0 || taxAmount > 0 || discount > 0) {
    originalTotal = Number((subtotal + taxAmount - discount).toFixed(2));
  } else if (procurement.total_amount != null && Number(procurement.total_amount) > 0) {
    originalTotal = Number(Number(procurement.total_amount).toFixed(2));
  } else {
    originalTotal = Number((Number(procurement.quantity || 0) * Number(procurement.rate_per_unit || 0)).toFixed(2));
  }

  const returnedAmount = Math.max(0, Number(Number(debitNoteTotal || 0).toFixed(2)));
  const netTotal = Math.max(0, Number((originalTotal - returnedAmount).toFixed(2)));
  const amountPaid = Number(Number(procurement.amount_paid || 0).toFixed(2));

  let amountDue = 0;
  let amountToReturn = 0;
  let paymentStatus = 'Unpaid';

  if (amountPaid < netTotal - 0.009) {
    amountDue = Number((netTotal - amountPaid).toFixed(2));
    amountToReturn = 0;
    paymentStatus = amountPaid > 0 ? 'Partially Paid' : 'Unpaid';
  } else if (Math.abs(amountPaid - netTotal) <= 0.01) {
    amountDue = 0;
    amountToReturn = 0;
    paymentStatus = 'Paid';
  } else {
    amountDue = 0;
    amountToReturn = Number((amountPaid - netTotal).toFixed(2));
    paymentStatus = 'Refund Due';
  }

  return {
    original_total: originalTotal,
    returned_amount: returnedAmount,
    net_total: netTotal,
    amount_paid: amountPaid,
    amount_due: amountDue,
    amount_to_return: amountToReturn,
    payment_status: paymentStatus
  };
}

/**
 * Calculate net financial dues and refunds for a sale / invoice.
 */
function getSaleFinancials(sale, creditNoteTotal = 0) {
  const subtotal = Number(sale.subtotal) || 0;
  const taxAmount = Number(sale.total_tax != null ? sale.total_tax : (sale.tax_amount || 0));
  const discount = Number(sale.discount_amount) || 0;
  let originalTotal = 0;
  if (sale.total_amount != null && Number(sale.total_amount) > 0) {
    originalTotal = Number(Number(sale.total_amount).toFixed(2));
  } else if (subtotal > 0 || taxAmount > 0 || discount > 0) {
    originalTotal = Number((subtotal + taxAmount - discount).toFixed(2));
  } else {
    originalTotal = Number((Number(sale.quantity || 0) * Number(sale.rate_per_unit || 0)).toFixed(2));
  }

  const returnedAmount = Math.max(0, Number(Number(creditNoteTotal || 0).toFixed(2)));
  const netTotal = Math.max(0, Number((originalTotal - returnedAmount).toFixed(2)));
  const amountReceived = Number(Number(sale.amount_received || 0).toFixed(2));

  let amountDue = 0;
  let amountToReturn = 0;
  let paymentStatus = 'Unpaid';

  if (amountReceived < netTotal - 0.009) {
    amountDue = Number((netTotal - amountReceived).toFixed(2));
    amountToReturn = 0;
    paymentStatus = amountReceived > 0 ? 'Partially Paid' : 'Unpaid';
  } else if (Math.abs(amountReceived - netTotal) <= 0.01) {
    amountDue = 0;
    amountToReturn = 0;
    paymentStatus = 'Paid';
  } else {
    amountDue = 0;
    amountToReturn = Number((amountReceived - netTotal).toFixed(2));
    paymentStatus = 'Refund Due';
  }

  return {
    original_total: originalTotal,
    returned_amount: returnedAmount,
    net_total: netTotal,
    amount_received: amountReceived,
    amount_due: amountDue,
    amount_to_return: amountToReturn,
    payment_status: paymentStatus
  };
}

/**
 * Execute approval of a Return Request idempotently with inventory ledger update,
 * debit/credit note creation, and procurement/sale status update.
 */
async function executeApproveReturnRequest(client, returnRequestId, userId, reviewNotes) {
  const rrRes = await client.query(
    'SELECT * FROM return_requests WHERE id = ? FOR UPDATE',
    [returnRequestId]
  );
  if (rrRes.rowCount === 0) {
    throw new Error('Return request not found');
  }
  const rr = rrRes.rows[0];

  // If already approved, return early without re-inserting
  if (rr.status === 'Approved') {
    return { ok: true, return_request: rr, already_approved: true };
  }

  let outcomeDocType = rr.outcome_document_type || null;
  let outcomeDocId = rr.outcome_document_id || null;
  const today = new Date().toISOString().slice(0, 10);

  // Parse items snapshot
  let parsedItems = [];
  try {
    if (rr.items) {
      parsedItems = typeof rr.items === 'string' ? JSON.parse(rr.items) : rr.items;
    }
  } catch (_) {}

  // 1. PURCHASE RETURN (Item returned to vendor -> Inventory REDUCED, Debit Note created)
  if (rr.request_type === 'purchase_return') {
    const procRes = await client.query(
      'SELECT * FROM procurements WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
      [rr.reference_id]
    );
    const proc = procRes.rows[0] || null;

    // Resolve location: use procurement's location or default location
    let locationId = proc?.location_id || null;
    if (!locationId) {
      const defLocRes = await client.query('SELECT id FROM locations WHERE is_default = 1 LIMIT 1');
      locationId = defLocRes.rows[0]?.id || null;
    }

    // If items snapshot was empty, load all items from procurement_items
    if ((!parsedItems || parsedItems.length === 0) && proc) {
      const piRes = await client.query(
        `SELECT pi.*, rm.name AS item_name, rm.unit
         FROM procurement_items pi
         LEFT JOIN raw_materials rm ON rm.id = pi.item_id
         WHERE pi.procurement_id = ?`,
        [proc.id]
      );
      parsedItems = piRes.rows.map(item => ({
        item_id: item.item_id,
        name: item.item_name || 'Item',
        quantity: item.quantity,
        rate_per_unit: item.rate_per_unit || item.unit_price || 0,
        total_price: Number(item.quantity) * Number(item.rate_per_unit || item.unit_price || 0)
      }));
    }

    // Check if debit note already exists
    let existingDn = null;
    if (outcomeDocId && outcomeDocType === 'debit_note') {
      const dnRes = await client.query('SELECT * FROM debit_notes WHERE id = ?', [outcomeDocId]);
      existingDn = dnRes.rows[0];
    } else if (proc) {
      const dnRes = await client.query(
        'SELECT * FROM debit_notes WHERE procurement_id = ? AND (notes LIKE ? OR reason LIKE ?)',
        [proc.id, `%${rr.request_number}%`, `%${rr.request_number}%`]
      );
      existingDn = dnRes.rows[0];
    }

    if (!existingDn) {
      try {
        const debitNoteNumber = await getNextDocumentNumber(client, 'debit_note');
        outcomeDocId = crypto.randomUUID();
        outcomeDocType = 'debit_note';
        const totalAmount = parsedItems.reduce((s, i) => s + (Number(i.quantity || 0) * Number(i.rate_per_unit || 0)), 0);

        await client.query(
          `INSERT INTO debit_notes (id, debit_note_number, vendor_id, procurement_id, date, reason, total_amount, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [outcomeDocId, debitNoteNumber, rr.vendor_id || proc?.vendor_id, rr.reference_id, today, rr.reason, totalAmount, `Return Request ${rr.request_number}: ${reviewNotes || 'Approved'}`]
        );

        for (const it of parsedItems) {
          if (!it.item_id || !it.quantity) continue;
          await client.query(
            `INSERT INTO debit_note_items (id, debit_note_id, item_id, quantity, rate_per_unit, line_total)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [crypto.randomUUID(), outcomeDocId, it.item_id, it.quantity, it.rate_per_unit || 0, Number(it.quantity) * Number(it.rate_per_unit || 0)]
          ).catch(() => {});
        }
      } catch (e) {
        console.warn('Debit note insertion warning:', e.message);
      }
    } else {
      outcomeDocId = existingDn.id;
      outcomeDocType = 'debit_note';
    }

    // REDUCE INVENTORY in inventory_ledger (transaction_type = 'out')
    for (const item of parsedItems) {
      const itemId = item.item_id || item.raw_material_id;
      const qty = Number(item.quantity);
      if (!itemId || !qty || qty <= 0) continue;

      // Idempotency: verify this specific item wasn't already written for this return_request
      const existingLedger = await client.query(
        "SELECT id FROM inventory_ledger WHERE reference_table = 'return_requests' AND reference_id = ? AND item_id = ? AND transaction_type = 'out'",
        [rr.id, itemId]
      );
      if (existingLedger.rowCount === 0) {
        await client.query(
          `INSERT INTO inventory_ledger
             (id, item_type, item_id, location_id, transaction_type, quantity, reference_table, reference_id, reason, created_by, date)
           VALUES (?, 'raw_material', ?, ?, 'out', ?, 'return_requests', ?, 'Purchase return accepted by vendor', ?, ?)`,
          [crypto.randomUUID(), itemId, locationId, qty, rr.id, userId, today]
        );
      }
    }

    // Update procurement status
    if (proc) {
      const piSumRes = await client.query('SELECT COALESCE(SUM(quantity), 0) AS total_qty FROM procurement_items WHERE procurement_id = ?', [proc.id]);
      const totalProcQty = Number(piSumRes.rows[0]?.total_qty || 0);
      const totalReturnedQty = parsedItems.reduce((s, i) => s + Number(i.quantity || 0), 0);
      const newStatus = (totalProcQty > 0 && totalReturnedQty >= totalProcQty - 0.001) ? 'Returned' : 'Partially Returned';
      await client.query(
        'UPDATE procurements SET status = ?, updated_at = NOW() WHERE id = ?',
        [newStatus, proc.id]
      );
    }

  // 2. PURCHASE CANCELLATION (Soft-delete procurement + reverse all items)
  } else if (rr.request_type === 'purchase_cancellation') {
    const procRes = await client.query(
      'SELECT * FROM procurements WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
      [rr.reference_id]
    );
    if (procRes.rowCount > 0) {
      const proc = procRes.rows[0];
      const piRes = await client.query('SELECT * FROM procurement_items WHERE procurement_id = ?', [proc.id]);
      for (const pi of piRes.rows) {
        await client.query(
          `INSERT INTO inventory_ledger
             (id, item_type, item_id, location_id, transaction_type, quantity, reference_table, reference_id, reason, created_by, date)
           VALUES (?, 'raw_material', ?, ?, 'out', ?, 'return_requests', ?, 'Purchase cancellation approved', ?, ?)`,
          [crypto.randomUUID(), pi.item_id, proc.location_id, pi.quantity, rr.id, userId, today]
        );
      }
      await client.query('UPDATE procurements SET deleted_at = NOW(), deleted_by = ?, status = \'Cancelled\' WHERE id = ?', [userId, proc.id]);
      await client.query("UPDATE payments_log SET deleted_at = NOW(), deleted_by = ? WHERE related_type = 'procurement' AND related_id = ?", [userId, proc.id]);
    }

  // 3. SALES RETURN (Customer return -> Inventory RESTOCKED / ADDED, Credit Note created)
  } else if (rr.request_type === 'sales_return') {
    const saleRes = await client.query(
      'SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
      [rr.reference_id]
    );
    const sale = saleRes.rows[0] || null;

    let locationId = sale?.location_id || null;
    if (!locationId) {
      const defLocRes = await client.query('SELECT id FROM locations WHERE is_default = 1 LIMIT 1');
      locationId = defLocRes.rows[0]?.id || null;
    }

    // If items snapshot was empty, load all items from sales_items
    if ((!parsedItems || parsedItems.length === 0) && sale) {
      const siRes = await client.query(
        `SELECT si.*, fg.name AS item_name, fg.unit AS base_unit,
                COALESCE(ppl.package_unit, pc.package_unit) AS package_unit,
                COALESCE(si.package_name, ppl.name) AS package_name,
                COALESCE(si.units_per_package, ppl.base_quantity_equivalent, 1) AS units_per_package
         FROM sales_items si
         LEFT JOIN finished_goods fg ON fg.id = si.finished_good_id
         LEFT JOIN product_packaging_levels ppl ON ppl.id = COALESCE(si.packaging_level_id, si.packaging_config_id)
         LEFT JOIN packaging_configurations pc ON pc.id = si.packaging_config_id
         WHERE si.sale_id = ?`,
        [sale.id]
      );
      parsedItems = siRes.rows.map(item => ({
        finished_good_id: item.finished_good_id,
        name: item.item_name || 'Finished Good',
        quantity: item.quantity,
        rate_per_unit: item.rate_per_unit,
        units_per_package: item.units_per_package || 1,
        packaging_level_id: item.packaging_level_id,
        package_name: item.package_name,
        total_price: Number(item.quantity) * Number(item.rate_per_unit || 0)
      }));
    }

    // Check if credit note already exists
    let existingCn = null;
    if (outcomeDocId && outcomeDocType === 'credit_note') {
      const cnRes = await client.query('SELECT * FROM credit_notes WHERE id = ?', [outcomeDocId]);
      existingCn = cnRes.rows[0];
    } else if (sale) {
      const cnRes = await client.query(
        'SELECT * FROM credit_notes WHERE sale_id = ? AND (notes LIKE ? OR reason LIKE ?)',
        [sale.id, `%${rr.request_number}%`, `%${rr.request_number}%`]
      );
      existingCn = cnRes.rows[0];
    }

    if (!existingCn) {
      try {
        const creditNoteNumber = await getNextDocumentNumber(client, 'credit_note');
        outcomeDocId = crypto.randomUUID();
        outcomeDocType = 'credit_note';
        const totalAmount = parsedItems.reduce((s, i) => s + (Number(i.quantity || 0) * Number(i.rate_per_unit || 0)), 0);

        await client.query(
          `INSERT INTO credit_notes (id, credit_note_number, customer_id, sale_id, date, reason, total_amount, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [outcomeDocId, creditNoteNumber, rr.customer_id || sale?.customer_id, rr.reference_id, today, rr.reason, totalAmount, `Return Request ${rr.request_number}: ${reviewNotes || 'Approved'}`]
        );

        for (const it of parsedItems) {
          const targetItemId = it.finished_good_id || it.item_id;
          if (!targetItemId || !it.quantity) continue;
          await client.query(
            `INSERT INTO credit_note_items (id, credit_note_id, finished_good_id, quantity, rate_per_unit, line_total)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [crypto.randomUUID(), outcomeDocId, targetItemId, it.quantity, it.rate_per_unit || 0, Number(it.quantity) * Number(it.rate_per_unit || 0)]
          ).catch(() => {});
        }
      } catch (e) {
        console.warn('Credit note insertion warning:', e.message);
      }
    } else {
      outcomeDocId = existingCn.id;
      outcomeDocType = 'credit_note';
    }

    // ADD / RESTOCK INVENTORY in inventory_ledger (transaction_type = 'in')
    for (const item of parsedItems) {
      const targetItemId = item.finished_good_id || item.item_id;
      const qty = Number(item.quantity);
      if (!targetItemId || !qty || qty <= 0) continue;

      const unitsPerPkg = Number(item.units_per_package || 1);
      const baseReturnQty = qty * unitsPerPkg;
      const pkgLevelId = item.packaging_level_id || null;
      const pkgCount = item.package_count || (unitsPerPkg > 1 ? qty : null);

      const existingLedger = await client.query(
        "SELECT id FROM inventory_ledger WHERE reference_table = 'return_requests' AND reference_id = ? AND item_id = ? AND transaction_type = 'in'",
        [rr.id, targetItemId]
      );
      if (existingLedger.rowCount === 0) {
        await client.query(
          `INSERT INTO inventory_ledger
             (id, item_type, item_id, location_id, packaging_level_id, package_count, transaction_type, quantity, reference_table, reference_id, reason, created_by, date)
           VALUES (?, 'finished_good', ?, ?, ?, ?, 'in', ?, 'return_requests', ?, 'Sales return accepted and restocked', ?, ?)`,
          [crypto.randomUUID(), targetItemId, locationId, pkgLevelId, pkgCount, baseReturnQty, rr.id, userId, today]
        );
      }
    }

    // Update sale status
    if (sale) {
      const siSumRes = await client.query('SELECT COALESCE(SUM(quantity), 0) AS total_qty FROM sales_items WHERE sale_id = ?', [sale.id]);
      const totalSaleQty = Number(siSumRes.rows[0]?.total_qty || 0);
      const totalReturnedQty = parsedItems.reduce((s, i) => s + Number(i.quantity || 0), 0);
      const newStatus = (totalSaleQty > 0 && totalReturnedQty >= totalSaleQty - 0.001) ? 'Returned' : 'Partially Returned';
      await client.query(
        'UPDATE sales SET status = ?, updated_at = NOW() WHERE id = ?',
        [newStatus, sale.id]
      );
    }

  // 4. SALES CANCELLATION (Soft-delete sale + restock all goods)
  } else if (rr.request_type === 'sales_cancellation') {
    const saleRes = await client.query(
      'SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
      [rr.reference_id]
    );
    if (saleRes.rowCount > 0) {
      const sale = saleRes.rows[0];
      const siRes = await client.query('SELECT * FROM sales_items WHERE sale_id = ?', [sale.id]);
      for (const si of siRes.rows) {
        const unitsPerPkg = Number(si.units_per_package || 1);
        const baseQty = Number(si.quantity) * unitsPerPkg;
        await client.query(
          `INSERT INTO inventory_ledger
             (id, item_type, item_id, location_id, packaging_level_id, package_count, transaction_type, quantity, reference_table, reference_id, reason, created_by, date)
           VALUES (?, 'finished_good', ?, ?, ?, ?, 'in', ?, 'return_requests', ?, 'Sales cancellation approved', ?, ?)`,
          [crypto.randomUUID(), si.finished_good_id, sale.location_id, si.packaging_level_id || null, unitsPerPkg > 1 ? si.quantity : null, baseQty, rr.id, userId, today]
        );
      }
      await client.query('UPDATE sales SET deleted_at = NOW(), deleted_by = ?, status = \'Cancelled\' WHERE id = ?', [userId, sale.id]);
      await client.query("UPDATE payments_log SET deleted_at = NOW(), deleted_by = ? WHERE related_type = 'sale' AND related_id = ?", [userId, sale.id]);
    }
  }

  // Update return_requests record to Approved
  await client.query(
    `UPDATE return_requests
     SET status = 'Approved', reviewed_by = ?, reviewed_at = NOW(), review_notes = ?,
         outcome_document_type = ?, outcome_document_id = ?, updated_at = NOW()
     WHERE id = ?`,
    [userId, reviewNotes || null, outcomeDocType, outcomeDocId, returnRequestId]
  );

  const updatedRr = await client.query('SELECT * FROM return_requests WHERE id = ?', [returnRequestId]);
  return {
    ok: true,
    return_request: updatedRr.rows[0],
    outcome_document_type: outcomeDocType,
    outcome_document_id: outcomeDocId
  };
}

module.exports = {
  getProcurementFinancials,
  getSaleFinancials,
  executeApproveReturnRequest
};
