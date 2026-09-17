const PDFDocument = require('pdfkit');

function numeric(value) {
  const num = Number(value);
  return Number.isNaN(num) ? 0 : num;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function dateRangeFromQuery(query) {
  const end = query.end_date || todayIso();
  const defaultStart = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const start = query.start_date || defaultStart;
  return { start, end };
}

function previousPeriod(start, end) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const diffDays = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / 86400000));
  const prevEnd = new Date(startDate.getTime() - 86400000);
  const prevStart = new Date(prevEnd.getTime() - (diffDays * 86400000));
  return {
    start: prevStart.toISOString().slice(0, 10),
    end: prevEnd.toISOString().slice(0, 10)
  };
}

function paymentStatus(totalAmount, amountPaidOrReceived, amountDue) {
  const total = numeric(totalAmount);
  const paid = numeric(amountPaidOrReceived);
  if (amountDue !== undefined && numeric(amountDue) <= 0.01) return 'Paid';
  if (total <= 0) return 'Paid';
  if (paid >= total - 0.01) return 'Paid';
  if (paid > 0) return 'Partially Paid';
  return 'Unpaid';
}

function toCSV(rows, columns) {
  const headers = columns.map((c) => `"${c.label.replace(/"/g, '""')}"`).join(',');
  const lines = rows.map((row) =>
    columns
      .map((c) => {
        const val = row[c.key];
        if (val === null || val === undefined) return '""';
        return `"${String(val).replace(/"/g, '""')}"`;
      })
      .join(',')
  );
  return [headers, ...lines].join('\n');
}

async function getBatchCostContext(tenantDb) {
  const [stagesRes, procurementsRes, batchesRes] = await Promise.all([
    tenantDb.query('SELECT * FROM process_stages WHERE deleted_at IS NULL ORDER BY sequence_order ASC'),
    tenantDb.query('SELECT * FROM procurements WHERE deleted_at IS NULL'),
    tenantDb.query('SELECT * FROM production_batches WHERE deleted_at IS NULL ORDER BY date ASC, created_at ASC')
  ]);

  let procRows = procurementsRes.rows;
  try {
    const itemsRes = await tenantDb.query(`
      SELECT pi.item_id AS raw_material_id, pi.quantity, pi.rate_per_unit
      FROM procurement_items pi
      JOIN procurements p ON p.id = pi.procurement_id
      WHERE p.deleted_at IS NULL
    `);
    if (itemsRes.rowCount > 0) procRows = itemsRes.rows;
  } catch (e) {
    // Legacy procurements schema fallback
  }

  const rawTotalCost = {};
  const rawTotalQty = {};

  for (const p of procRows) {
    const rmId = p.raw_material_id || p.item_id;
    if (!rmId) continue;
    if (!rawTotalCost[rmId]) {
      rawTotalCost[rmId] = 0;
      rawTotalQty[rmId] = 0;
    }
    const qty = numeric(p.quantity);
    const rate = numeric(p.rate_per_unit || p.rate);
    rawTotalCost[rmId] += qty * rate;
    rawTotalQty[rmId] += qty;
  }

  const avgRawMaterialCost = {};
  for (const rmId in rawTotalCost) {
    avgRawMaterialCost[rmId] = rawTotalQty[rmId] > 0 ? rawTotalCost[rmId] / rawTotalQty[rmId] : 0;
  }

  const batchUnitCosts = {};
  for (const b of batchesRes.rows) {
    let inputCost = 0;
    if (b.input_material_type === 'raw_material') {
      inputCost = avgRawMaterialCost[b.input_reference_id] || 0;
    } else if (b.input_material_type === 'previous_stage_output') {
      inputCost = batchUnitCosts[b.input_reference_id] || 0;
    }

    const totalBatchCost = (numeric(b.input_quantity) * inputCost) + numeric(b.labor_cost) + numeric(b.other_cost) + numeric(b.packaging_material_cost || 0);
    const outputQty = numeric(b.output_quantity);
    batchUnitCosts[b.id] = outputQty > 0 ? totalBatchCost / outputQty : 0;
  }

  return { avgRawMaterialCost, batchUnitCosts };
}

async function getInventorySnapshot(tenantDb, locationId = null, startDate = null, endDate = null) {
  let ledgerQuery = `
    SELECT il.item_type, il.item_id, il.packaging_level_id, il.package_count, il.transaction_type, il.quantity, il.unit_cost, il.location_id, il.reference_table, il.reason, il.date,
           COALESCE(l.name, (SELECT name FROM locations WHERE is_default = 1 LIMIT 1), (SELECT name FROM locations LIMIT 1), 'Main Location') AS location_name
    FROM inventory_ledger il
    LEFT JOIN locations l ON l.id = il.location_id
    WHERE 1=1
  `;
  const ledgerParams = [];

  if (locationId) {
    ledgerQuery += ` AND (il.location_id = ? OR (il.location_id IS NULL AND (SELECT id FROM locations WHERE is_default = 1 LIMIT 1) = ?))`;
    ledgerParams.push(locationId, locationId);
  }

  if (endDate) {
    ledgerQuery += ` AND DATE(il.date) <= ?`;
    ledgerParams.push(endDate);
  }
  ledgerQuery += ` ORDER BY il.date ASC, il.created_at ASC`;

  const [rawRes, fgRes, batchesRes, ledgerRes, locsRes, runOutputsRes, pkgConfigsRes] = await Promise.all([
    tenantDb.query('SELECT * FROM raw_materials WHERE deleted_at IS NULL'),
    tenantDb.query('SELECT * FROM finished_goods WHERE deleted_at IS NULL'),
    tenantDb.query('SELECT pb.*, ps.name AS stage_name FROM production_batches pb JOIN process_stages ps ON ps.id=pb.process_stage_id WHERE pb.deleted_at IS NULL'),
    tenantDb.query(ledgerQuery, ledgerParams),
    tenantDb.query('SELECT * FROM locations WHERE deleted_at IS NULL ORDER BY is_default DESC'),
    tenantDb.query(`
      SELECT pro.*, pr.run_number
      FROM production_run_outputs pro
      JOIN production_runs pr ON pr.id = pro.run_id
      WHERE pr.deleted_at IS NULL
      ORDER BY pro.created_at DESC
    `).catch(() => ({ rows: [] })),
    tenantDb.query(`
      SELECT ppl.id, ppl.product_id, ppl.name AS package_name, ppl.package_unit,
             ppl.base_quantity_equivalent AS units_per_package, ppl.selling_price, ppl.mrp, ppl.is_default
      FROM product_packaging_levels ppl
      WHERE ppl.status != 'archived'
      ORDER BY ppl.is_default DESC, ppl.base_quantity_equivalent ASC
    `).catch(() => ({ rows: [] }))
  ]);

  const selectedLoc = locsRes.rows.find((l) => l.id === locationId);
  const locationName = selectedLoc ? selectedLoc.name : (locationId ? 'Selected Location' : 'All Locations');

  const context = await getBatchCostContext(tenantDb);
  const stockMap = {};

  for (const entry of ledgerRes.rows) {
    const key = `${entry.item_type}:${entry.item_id}`;
    if (!stockMap[key]) {
      stockMap[key] = {
        total_in: 0,
        total_out: 0,
        used_in_production: 0,
        sold_in_sales: 0,
        stock: 0,
        packagedStockMap: {},
        loose_stock: 0,
        total_in_cost_val: 0,
        total_in_cost_qty: 0,
        latestInwardCost: 0,
        minInwardCost: Infinity,
        maxInwardCost: 0,
        latestCost: numeric(entry.unit_cost)
      };
    }
    const qty = numeric(entry.quantity);
    const cost = numeric(entry.unit_cost);
    const refTable = (entry.reference_table || '').toLowerCase();
    const reason = (entry.reason || '').toLowerCase();
    const tx = (entry.transaction_type || '').toLowerCase();
    const isReversal = reason.includes('reversal') || reason.includes('correction');
    const pkgLvlId = entry.packaging_level_id || null;
    const pkgCount = entry.package_count != null ? numeric(entry.package_count) : null;

    let entryDate = null;
    if (entry.date) {
      const parsedD = new Date(entry.date);
      if (!isNaN(parsedD.getTime())) {
        entryDate = parsedD.toISOString().slice(0, 10);
      }
    }

    const inRange = !startDate || (entryDate && entryDate >= startDate);

    if (cost > 0 && !isReversal) {
      stockMap[key].latestCost = cost;
    }

    if (tx === 'in' || (tx === 'adjustment' && qty > 0)) {
      const posQty = Math.abs(qty);
      if (inRange) stockMap[key].total_in += posQty;
      stockMap[key].stock += posQty;
      if (pkgLvlId) {
        const pCount = pkgCount != null ? Math.abs(pkgCount) : posQty;
        stockMap[key].packagedStockMap[pkgLvlId] = (stockMap[key].packagedStockMap[pkgLvlId] || 0) + pCount;
      } else {
        stockMap[key].loose_stock += posQty;
      }
      // Reversals restore physical quantity; they are not genuine purchase acquisitions.
      if (cost > 0 && !isReversal) {
        stockMap[key].total_in_cost_val += (posQty * cost);
        stockMap[key].total_in_cost_qty += posQty;
        stockMap[key].latestInwardCost = cost;
        if (cost < stockMap[key].minInwardCost) stockMap[key].minInwardCost = cost;
        if (cost > stockMap[key].maxInwardCost) stockMap[key].maxInwardCost = cost;
      }
    } else if (tx === 'out' || (tx === 'adjustment' && qty < 0)) {
      const posQty = Math.abs(qty);
      if (inRange) {
        stockMap[key].total_out += posQty;
        if (refTable.includes('production') || reason.includes('production') || reason.includes('batch')) {
          stockMap[key].used_in_production += posQty;
        } else if (refTable.includes('sales') || refTable.includes('invoice') || reason.includes('sale')) {
          stockMap[key].sold_in_sales += posQty;
        }
      }
      stockMap[key].stock -= posQty;
      if (pkgLvlId) {
        const pCount = pkgCount != null ? Math.abs(pkgCount) : posQty;
        stockMap[key].packagedStockMap[pkgLvlId] = (stockMap[key].packagedStockMap[pkgLvlId] || 0) - pCount;
      } else {
        stockMap[key].loose_stock -= posQty;
      }
    } else {
      if (inRange) stockMap[key].total_in += qty;
      stockMap[key].stock += qty;
      if (pkgLvlId) {
        const pCount = pkgCount != null ? pkgCount : qty;
        stockMap[key].packagedStockMap[pkgLvlId] = (stockMap[key].packagedStockMap[pkgLvlId] || 0) + pCount;
      } else {
        stockMap[key].loose_stock += qty;
      }
    }
  }

  const allItems = [
    ...rawRes.rows.map((r) => ({ item_type: 'raw_material', item_id: r.id, name: r.name, unit: r.unit, reorder_level: r.reorder_level })),
    ...batchesRes.rows.map((b) => ({ item_type: 'wip', item_id: b.id, name: `WIP: ${b.stage_name} (Batch ${b.batch_number})`, unit: b.output_unit, reorder_level: null })),
    ...fgRes.rows.map((f) => ({ item_type: 'finished_good', item_id: f.id, name: f.name, unit: f.unit, reorder_level: f.reorder_level, default_price: f.default_price }))
  ];

  return allItems.map((row) => {
    const key = `${row.item_type}:${row.item_id}`;
    const data = stockMap[key] || { total_in: 0, total_out: 0, used_in_production: 0, sold_in_sales: 0, stock: 0, latestCost: 0, total_in_cost_val: 0, total_in_cost_qty: 0, latestInwardCost: 0 };
    const currentStock = data.stock;
    let unitCost = 0;
    let sellingPrice = 0;

    const avgWac = data.total_in_cost_qty > 0 ? (data.total_in_cost_val / data.total_in_cost_qty) : 0;

    if (row.item_type === 'raw_material') {
      unitCost = context.avgRawMaterialCost[row.item_id] || avgWac || data.latestInwardCost || data.latestCost || 0;
    } else if (row.item_type === 'wip') {
      unitCost = context.batchUnitCosts[row.item_id] || data.latestCost || 0;
    } else if (row.item_type === 'finished_good') {
      sellingPrice = numeric(row.default_price || 0);

      // Check production run outputs for this finished good
      const prodOutputs = runOutputsRes.rows.filter((o) => o.item_id === row.item_id);
      let runCost = 0;
      if (prodOutputs.length > 0) {
        const totalAllocated = prodOutputs.reduce((sum, o) => sum + numeric(o.allocated_cost), 0);
        const totalBaseQty = prodOutputs.reduce((sum, o) => sum + numeric(o.base_quantity || o.quantity_produced), 0);
        if (totalBaseQty > 0 && totalAllocated > 0) {
          runCost = totalAllocated / totalBaseQty;
        } else if (prodOutputs[0].unit_cost) {
          const unitsPerPkg = numeric(prodOutputs[0].units_per_package) || 1;
          runCost = numeric(prodOutputs[0].unit_cost) / unitsPerPkg;
        }
      }

      // Check legacy batches
      const producedBatches = batchesRes.rows.filter((b) => b.finished_good_id === row.item_id);
      let batchCost = 0;
      if (producedBatches.length > 0) {
        const totalCost = producedBatches.reduce((sum, b) => sum + (numeric(b.output_quantity) * (context.batchUnitCosts[b.id] || 0)), 0);
        const totalQty = producedBatches.reduce((sum, b) => sum + numeric(b.output_quantity), 0);
        batchCost = totalQty > 0 ? totalCost / totalQty : 0;
      }

      // True cost: run cost, or inward weighted average cost, or batch cost, or latest inward cost
      unitCost = runCost || avgWac || batchCost || data.latestInwardCost || data.latestCost || 0;
    }

    const reorder = row.reorder_level === null ? null : numeric(row.reorder_level);
    let status = 'OK';
    if (row.item_type === 'wip') {
      if (currentStock < 0) status = 'Anomaly';
      else if (currentStock === 0) status = 'Consumed';
      else status = 'OK';
    } else {
      if (currentStock < 0) status = 'Anomaly';
      else if (reorder !== null) {
        if (currentStock <= 0) status = 'Out';
        else if (currentStock <= reorder) status = 'Low';
      } else {
        if (currentStock === 0) status = 'Out';
      }
    }

    // Packaging analysis for Finished Goods
    const productPkgs = pkgConfigsRes.rows.filter((p) => p.product_id === row.item_id);
    const packagedStockMap = data.packagedStockMap || {};
    const genuineLooseStock = Math.max(0, data.loose_stock || 0);

    const packaging_options = productPkgs.map((p) => {
      const upp = numeric(p.units_per_package) || 1;
      const actualPStock = Math.max(0, packagedStockMap[p.id] != null ? packagedStockMap[p.id] : 0);
      return {
        id: p.id,
        package_name: p.package_name,
        package_unit: p.package_unit || 'pkg',
        units_per_package: upp,
        packaged_stock: actualPStock,
        loose_units: 0,
        selling_price: numeric(p.selling_price),
        mrp: numeric(p.mrp),
        package_unit_cost: unitCost * upp,
        is_default: Boolean(p.is_default)
      };
    });

    const inStockPkgs = packaging_options.filter((p) => p.packaged_stock > 0);
    let activePkg = inStockPkgs.length > 0 ? inStockPkgs[0] : null;
    if (!activePkg && productPkgs.length > 0) {
      activePkg = productPkgs.find((p) => p.is_default) || productPkgs[0];
    }

    let packaging_summary = null;
    let package_name = null;
    let package_unit = null;
    let units_per_package = 1;
    let packaged_stock = null;
    let loose_units = genuineLooseStock;
    let package_unit_cost = null;
    let package_selling_price = null;

    if (inStockPkgs.length > 0) {
      const summaryParts = inStockPkgs.map((p) => `${p.packaged_stock.toLocaleString('en-IN')} ${p.package_unit || p.package_name}`);
      if (genuineLooseStock > 0) {
        summaryParts.push(`${genuineLooseStock.toLocaleString('en-IN')} ${row.unit} (Loose)`);
      }
      packaging_summary = summaryParts.join(' + ');

      activePkg = inStockPkgs[0];
      units_per_package = activePkg.units_per_package;
      package_name = activePkg.package_name;
      package_unit = activePkg.package_unit;
      packaged_stock = activePkg.packaged_stock;
      package_unit_cost = unitCost * units_per_package;
      package_selling_price = numeric(activePkg.selling_price || (sellingPrice * units_per_package));
    } else if (genuineLooseStock > 0) {
      packaging_summary = `${genuineLooseStock.toLocaleString('en-IN')} ${row.unit} (Loose)`;
      packaged_stock = null;
    } else if (productPkgs.length > 0 && activePkg) {
      units_per_package = activePkg.units_per_package;
      package_name = activePkg.package_name;
      package_unit = activePkg.package_unit || 'pkg';
      packaged_stock = 0;
      packaging_summary = `0 ${package_unit}`;
      package_unit_cost = unitCost * units_per_package;
      package_selling_price = numeric(activePkg.selling_price || (sellingPrice * units_per_package));
    }

    const potentialRevenue = currentStock * (sellingPrice || unitCost);

    return {
      item_type: row.item_type,
      item_id: row.item_id,
      name: row.name || 'Unknown Item',
      unit: row.unit || 'unit',
      location_name: locationName,
      total_in: data.total_in,
      used_in_production: data.used_in_production,
      sold_in_sales: data.sold_in_sales,
      current_stock: currentStock,
      reorder_level: reorder,
      status,
      unit_cost: unitCost,
      value_at_cost: currentStock * unitCost,
      weighted_avg_cost: avgWac || unitCost,
      last_purchase_price: data.latestInwardCost || data.latestCost || 0,
      min_purchase_price: data.minInwardCost !== Infinity ? data.minInwardCost : null,
      max_purchase_price: data.maxInwardCost > 0 ? data.maxInwardCost : null,
      has_price_variance: (data.maxInwardCost > data.minInwardCost && data.minInwardCost !== Infinity),
      cost_method: row.item_type === 'raw_material' ? 'Weighted Average Cost (WAC)' : 'Calculated Cost',
      selling_price: sellingPrice,
      potential_revenue: potentialRevenue,
      // Packaging details
      package_name,
      package_unit,
      units_per_package,
      packaged_stock,
      loose_units: genuineLooseStock,
      loose_stock: genuineLooseStock,
      package_unit_cost,
      package_selling_price,
      packaging_summary,
      packaging_options
    };
  });
}

function getColumnWidths(columns, contentWidth) {
  const defaultWeights = {
    date: 1.1,
    vendor: 2.2,
    customer: 2.2,
    material: 2.5,
    product: 2.5,
    finished_good: 2.2,
    name: 2.5,
    party_name: 2.5,
    line_item: 3.0,
    stage: 1.4,
    batch_number: 1.2,
    item_type: 1.3,
    quantity: 1.0,
    input_quantity: 1.0,
    output_quantity: 1.0,
    wastage_quantity: 1.0,
    yield_percent: 1.0,
    rate_per_unit: 1.0,
    rate: 0.9,
    total_amount: 1.3,
    amount_paid: 1.2,
    amount_due: 1.1,
    paid: 1.1,
    due: 1.1,
    unit: 0.9,
    status: 1.0,
    unit_cost: 1.1,
    value_at_cost: 1.3,
    reorder_level: 1.0,
    notes: 2.0
  };

  let totalWeight = 0;
  const colWeights = columns.map((col) => {
    const key = String(col.key || '').toLowerCase();
    const weight = defaultWeights[key] || 1.5;
    totalWeight += weight;
    return weight;
  });

  return columns.map((_, idx) => (colWeights[idx] / totalWeight) * contentWidth);
}

function streamSimplePdf(res, options) {
  const doc = new PDFDocument({ margin: 36, size: 'A4', bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${options.filename || 'report.pdf'}"`);
  doc.pipe(res);

  const brandColor = '#1e3a8a';
  const accentBlue = '#2563eb';
  const darkSlate = '#0f172a';
  const mutedSlate = '#64748b';
  const lightBg = '#f8fafc';
  const borderSlate = '#cbd5e1';

  const companyName = options.workspace?.name || 'ERP Studio Enterprise';
  const currency = options.workspace?.currency || 'USD';
  const pageMargin = 36;
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const contentWidth = pageWidth - (pageMargin * 2);

  function drawHeader() {
    doc.rect(0, 0, pageWidth, 54).fill(brandColor);
    doc.rect(0, 54, pageWidth, 3).fill(accentBlue);

    doc.font('Helvetica-Bold').fontSize(15).fillColor('#ffffff').text(companyName, pageMargin, 14);
    doc.font('Helvetica').fontSize(8.5).fillColor('#93c5fd').text(`Operations Platform · Currency: ${currency}`, pageMargin, 34);

    const titleText = (options.title || 'OPERATIONAL REPORT').toUpperCase();
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#ffffff').text(titleText, pageMargin, 16, { align: 'right' });
    if (options.subtitle) {
      doc.font('Helvetica').fontSize(8).fillColor('#cbd5e1').text(options.subtitle, pageMargin, 33, { align: 'right' });
    }
  }

  drawHeader();
  let currentY = 70;

  if (options.summaryCards && options.summaryCards.length > 0) {
    const cards = options.summaryCards;
    const cardGap = 10;
    const numCards = Math.min(cards.length, 4);
    const cardWidth = (contentWidth - (cardGap * (numCards - 1))) / numCards;
    const cardHeight = 44;

    for (let i = 0; i < numCards; i++) {
      const card = cards[i];
      const cardX = pageMargin + (i * (cardWidth + cardGap));

      doc.roundedRect(cardX, currentY, cardWidth, cardHeight, 6)
         .fillAndStroke(lightBg, borderSlate);

      doc.font('Helvetica-Bold')
         .fontSize(7)
         .fillColor(mutedSlate)
         .text(String(card.label || '').toUpperCase(), cardX + 8, currentY + 8, { width: cardWidth - 16, truncate: true });

      doc.font('Helvetica-Bold')
         .fontSize(12)
         .fillColor(darkSlate)
         .text(String(card.value || '-'), cardX + 8, currentY + 22, { width: cardWidth - 16, truncate: true });
    }

    currentY += cardHeight + 16;
  }

  const columns = options.columns || [];
  const rows = options.rows || [];

  if (columns.length > 0) {
    const colWidths = getColumnWidths(columns, contentWidth);
    const headerHeight = 24;
    const isNumericKey = (key) => /amount|rate|qty|quantity|paid|due|received|cost|value|total|price|stock|yield/i.test(key);

    // Header Fill
    doc.rect(pageMargin, currentY, contentWidth, headerHeight).fill('#1e293b');

    doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
    let headX = pageMargin;
    columns.forEach((col, idx) => {
      const w = colWidths[idx];
      const align = isNumericKey(col.key) ? 'right' : 'left';
      doc.text(col.label.toUpperCase(), headX + 4, currentY + 7, { width: w - 8, align, truncate: true });
      headX += w;
    });

    currentY += headerHeight;

    rows.forEach((row, rowIndex) => {
      // 1. Prepare formatted cell texts
      const cellTexts = columns.map((col) => {
        const val = row[col.key];
        if (val === null || val === undefined) return '';
        if (typeof val === 'number') {
          return val.toLocaleString(undefined, { maximumFractionDigits: 2 });
        }
        return String(val);
      });

      // 2. Measure required height for each cell to prevent text overlap
      doc.font('Helvetica').fontSize(8);
      const cellHeights = cellTexts.map((text, idx) => {
        return doc.heightOfString(text, { width: colWidths[idx] - 8 });
      });
      const rowHeight = Math.max(22, Math.max(...cellHeights) + 8);

      // 3. Page overflow check
      if (currentY + rowHeight > pageHeight - 45) {
        doc.addPage();
        drawHeader();
        currentY = 70;

        doc.rect(pageMargin, currentY, contentWidth, headerHeight).fill('#1e293b');
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
        let hX = pageMargin;
        columns.forEach((col, idx) => {
          const w = colWidths[idx];
          const align = isNumericKey(col.key) ? 'right' : 'left';
          doc.text(col.label.toUpperCase(), hX + 4, currentY + 7, { width: w - 8, align, truncate: true });
          hX += w;
        });
        currentY += headerHeight;
        doc.font('Helvetica').fontSize(8);
      }

      // 4. Alternating row background fill
      if (rowIndex % 2 === 1) {
        doc.rect(pageMargin, currentY, contentWidth, rowHeight).fill('#f8fafc');
      }

      // 5. Draw cell values
      let cX = pageMargin;
      doc.fillColor(darkSlate);
      columns.forEach((col, idx) => {
        const w = colWidths[idx];
        const align = isNumericKey(col.key) ? 'right' : 'left';
        const textVal = cellTexts[idx];

        doc.text(textVal, cX + 4, currentY + 5, {
          width: w - 8,
          align,
          lineBreak: true
        });
        cX += w;
      });

      currentY += rowHeight;

      // 6. Draw row bottom border line
      doc.moveTo(pageMargin, currentY)
         .lineTo(pageWidth - pageMargin, currentY)
         .strokeColor('#e2e8f0')
         .lineWidth(0.5)
         .stroke();
    });

    // Table Bottom Accent Border
    doc.moveTo(pageMargin, currentY).lineTo(pageWidth - pageMargin, currentY).strokeColor(darkSlate).lineWidth(1).stroke();
  }

  const totalPages = doc.bufferedPageRange().count;
  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(i);
    doc.moveTo(pageMargin, pageHeight - 35).lineTo(pageWidth - pageMargin, pageHeight - 35).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(mutedSlate);
    doc.text(`Generated via ERP Studio Enterprise · Confidential Report`, pageMargin, pageHeight - 24);
    doc.text(`Page ${i + 1} of ${totalPages}`, pageMargin, pageHeight - 24, { align: 'right' });
  }

  doc.end();
}

function streamExecutiveDashboardPdf(res, options) {
  const doc = new PDFDocument({
    margin: 0,
    size: 'A4',
    bufferPages: true
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${options.filename || 'executive_dashboard.pdf'}"`);
  doc.pipe(res);

  const brandColor = '#0f172a';
  const primaryBlue = '#1d4ed8';
  const lightBg = '#f8fafc';
  const cardBorder = '#e2e8f0';
  const textDark = '#0f172a';
  const textMuted = '#64748b';
  const greenText = '#15803d';
  const redText = '#b91c1c';
  const amberText = '#b45309';

  const companyName = options.workspace?.name || 'ERP Studio Enterprise';
  const currency = options.workspace?.currency || 'USD';
  const pageMargin = 36;
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const contentWidth = pageWidth - (pageMargin * 2);

  function fmtVal(val, isCurr = false, suffix = '') {
    if (val === null || val === undefined || isNaN(Number(val))) return '-';
    const n = Number(val);
    if (isCurr) {
      return `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
  }

  function drawHeader(isPage1 = true) {
    const h = isPage1 ? 52 : 38;
    doc.rect(0, 0, pageWidth, h).fill(brandColor);
    doc.rect(0, h, pageWidth, 2.5).fill(primaryBlue);

    doc.font('Helvetica-Bold').fontSize(isPage1 ? 13 : 11).fillColor('#ffffff')
       .text(companyName, pageMargin, isPage1 ? 11 : 9, { lineBreak: false });
    doc.font('Helvetica').fontSize(7).fillColor('#93c5fd')
       .text(`Currency: ${currency} · Location: ${options.locationName || 'All Locations'}`, pageMargin, isPage1 ? 28 : 23, { lineBreak: false });

    const titleText = isPage1 ? 'EXECUTIVE DASHBOARD' : 'EXECUTIVE DASHBOARD · OPERATIONS & RISK';
    doc.font('Helvetica-Bold').fontSize(isPage1 ? 10.5 : 9).fillColor('#ffffff')
       .text(titleText, pageMargin, isPage1 ? 12 : 10, { width: contentWidth, align: 'right', lineBreak: false });
    const periodText = `Period: ${options.period?.start || ''} to ${options.period?.end || ''}`;
    doc.font('Helvetica').fontSize(7).fillColor('#cbd5e1')
       .text(periodText, pageMargin, isPage1 ? 28 : 23, { width: contentWidth, align: 'right', lineBreak: false });
  }

  function drawSectionTitle(title, curY, badge = '') {
    doc.rect(pageMargin, curY + 1, 2.5, 11).fill(primaryBlue);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(textDark)
       .text(title.toUpperCase(), pageMargin + 7, curY + 2, { lineBreak: false });
    if (badge) {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(textMuted)
         .text(badge, pageMargin, curY + 3, { width: contentWidth, align: 'right', lineBreak: false });
    }
    return curY + 16;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAGE 1: Executive KPI Summary, Financial Performance, Cash Flow & Aging
  // ═══════════════════════════════════════════════════════════════════════════
  drawHeader(true);
  let y = 64;

  // 1. Executive KPI Cards (6 cards in 3 cols x 2 rows)
  const kpis = options.kpis || [];
  if (kpis.length > 0) {
    y = drawSectionTitle('Key Performance Indicators', y);
    const cols = 3;
    const cardGap = 6;
    const cardWidth = (contentWidth - (cardGap * (cols - 1))) / cols;
    const cardHeight = 38;

    for (let i = 0; i < Math.min(kpis.length, 6); i++) {
      const colIdx = i % cols;
      const rowIdx = Math.floor(i / cols);
      const cx = pageMargin + (colIdx * (cardWidth + cardGap));
      const cy = y + (rowIdx * (cardHeight + cardGap));

      doc.roundedRect(cx, cy, cardWidth, cardHeight, 4).fillAndStroke(lightBg, cardBorder);

      const kpi = kpis[i];
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor(textMuted)
         .text(String(kpi.label || '').toUpperCase(), cx + 6, cy + 5, { width: cardWidth - 12, lineBreak: false });

      const valStr = kpi.suffix === '%' ? `${Number(kpi.value || 0).toFixed(1)}%` : fmtVal(kpi.value, true);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(textDark)
         .text(valStr, cx + 6, cy + 15, { width: cardWidth - 12, lineBreak: false });

      const pct = Number(kpi.change_percent || 0);
      const isPositive = pct >= 0;
      doc.font('Helvetica').fontSize(6).fillColor(isPositive ? greenText : redText)
         .text(`${isPositive ? '▲ +' : '▼ '}${pct.toFixed(1)}% vs previous`, cx + 6, cy + 27, { width: cardWidth - 12, lineBreak: false });
    }
    y += (cardHeight * 2) + cardGap + 12;
  }

  // 2. Financial Performance (Revenue, Cost, Profit Table - max 7 rows)
  const financialRows = (options.charts?.revenue_cost_profit || []).slice(0, 7);
  if (financialRows.length > 0) {
    y = drawSectionTitle('Revenue, Cost & Net Profit Trend', y, `${financialRows.length} Periods`);
    const fCols = [
      { key: 'period', label: 'Period', width: 90, align: 'left' },
      { key: 'revenue', label: 'Revenue', width: 105, align: 'right' },
      { key: 'total_cost', label: 'Total Cost', width: 105, align: 'right' },
      { key: 'profit', label: 'Net Profit', width: 110, align: 'right' },
      { key: 'margin', label: 'Margin %', width: contentWidth - 410, align: 'right' }
    ];

    doc.rect(pageMargin, y, contentWidth, 14).fill('#1e293b');
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#ffffff');
    let hx = pageMargin;
    fCols.forEach(c => {
      doc.text(c.label.toUpperCase(), hx + 4, y + 4, { width: c.width - 8, align: c.align, lineBreak: false });
      hx += c.width;
    });
    y += 14;

    financialRows.forEach((r, idx) => {
      if (idx % 2 === 1) doc.rect(pageMargin, y, contentWidth, 13).fill('#f8fafc');
      doc.font('Helvetica').fontSize(6.5).fillColor(textDark);

      const marginPct = Number(r.revenue) > 0 ? ((Number(r.profit) / Number(r.revenue)) * 100).toFixed(1) + '%' : '0.0%';
      let cx = pageMargin;
      fCols.forEach(c => {
        let text = '';
        if (c.key === 'period') text = String(r.period || '');
        else if (c.key === 'revenue') text = fmtVal(r.revenue, true);
        else if (c.key === 'total_cost') text = fmtVal(r.total_cost, true);
        else if (c.key === 'profit') text = fmtVal(r.profit, true);
        else if (c.key === 'margin') text = marginPct;

        doc.text(text, cx + 4, y + 3, { width: c.width - 8, align: c.align, lineBreak: false });
        cx += c.width;
      });

      y += 13;
      doc.moveTo(pageMargin, y).lineTo(pageMargin + contentWidth, y).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    });
    y += 10;
  }

  // 3. Cash Flow Summary
  const cashRows = options.charts?.cash_flow || [];
  if (cashRows.length > 0) {
    const totalIn = cashRows.reduce((s, r) => s + Number(r.money_in || 0), 0);
    const totalOut = cashRows.reduce((s, r) => s + Number(r.money_out || 0), 0);
    const netCash = totalIn - totalOut;

    y = drawSectionTitle('Cash Flow & Working Capital Liquidity', y);
    const bWidth = (contentWidth - 12) / 3;
    const bHeight = 32;

    const boxes = [
      { label: 'TOTAL INFLOW (COLLECTIONS)', val: fmtVal(totalIn, true), color: greenText },
      { label: 'TOTAL OUTFLOW (DISBURSEMENTS)', val: fmtVal(totalOut, true), color: redText },
      { label: 'NET CASH POSITION', val: fmtVal(netCash, true), color: netCash >= 0 ? greenText : redText }
    ];

    boxes.forEach((b, idx) => {
      const bx = pageMargin + (idx * (bWidth + 6));
      doc.roundedRect(bx, y, bWidth, bHeight, 4).fillAndStroke(lightBg, cardBorder);
      doc.font('Helvetica-Bold').fontSize(5.5).fillColor(textMuted).text(b.label, bx + 6, y + 5, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(9).fillColor(b.color).text(b.val, bx + 6, y + 16, { lineBreak: false });
    });
    y += bHeight + 10;
  }

  // 4. Aging Analysis (Receivables vs Payables)
  const recAging = options.aging?.receivables || [];
  const payAging = options.aging?.payables || [];
  if (recAging.length > 0 || payAging.length > 0) {
    y = drawSectionTitle('Aging Analysis (Receivables vs Payables)', y);
    const ageCols = [
      { label: 'Aging Bracket', width: 120, align: 'left' },
      { label: 'Receivables (Inbound)', width: 135, align: 'right' },
      { label: 'Payables (Outbound)', width: 135, align: 'right' },
      { label: 'Net Position', width: contentWidth - 390, align: 'right' }
    ];

    doc.rect(pageMargin, y, contentWidth, 13).fill('#1e293b');
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#ffffff');
    let ax = pageMargin;
    ageCols.forEach(c => {
      doc.text(c.label.toUpperCase(), ax + 4, y + 3.5, { width: c.width - 8, align: c.align, lineBreak: false });
      ax += c.width;
    });
    y += 13;

    const buckets = ['0-15', '16-30', '31-60', '60+'];
    buckets.forEach((b, idx) => {
      const recAmt = Number(recAging.find(r => r.bucket === b)?.amount || 0);
      const payAmt = Number(payAging.find(r => r.bucket === b)?.amount || 0);
      const diff = recAmt - payAmt;

      if (idx % 2 === 1) doc.rect(pageMargin, y, contentWidth, 12).fill('#f8fafc');

      doc.font('Helvetica').fontSize(6.5).fillColor(textDark);
      doc.text(`${b} Days Overdue`, pageMargin + 4, y + 2.5, { width: 112, lineBreak: false });
      doc.text(fmtVal(recAmt, true), pageMargin + 124, y + 2.5, { width: 127, align: 'right', lineBreak: false });
      doc.text(fmtVal(payAmt, true), pageMargin + 259, y + 2.5, { width: 127, align: 'right', lineBreak: false });
      doc.fillColor(diff >= 0 ? greenText : redText);
      doc.text(fmtVal(diff, true), pageMargin + 394, y + 2.5, { width: contentWidth - 398, align: 'right', lineBreak: false });

      y += 12;
      doc.moveTo(pageMargin, y).lineTo(pageMargin + contentWidth, y).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    });
    y += 10;
  }

  // 5. Inventory Valuation
  const invComp = options.charts?.inventory_composition || [];
  if (invComp.length > 0) {
    y = drawSectionTitle('Inventory Valuation by Category', y);
    const totInv = invComp.reduce((s, r) => s + Number(r.value || 0), 0);
    const iWidth = (contentWidth - 12) / Math.max(invComp.length, 1);

    invComp.forEach((item, idx) => {
      const ix = pageMargin + (idx * (iWidth + 6));
      const val = Number(item.value || 0);
      const pct = totInv > 0 ? ((val / totInv) * 100).toFixed(1) : '0.0';
      const label = item.type === 'raw_material' ? 'Raw Materials' : item.type === 'wip' ? 'Work-In-Progress' : 'Finished Goods';

      doc.roundedRect(ix, y, iWidth, 30, 4).fillAndStroke(lightBg, cardBorder);
      doc.font('Helvetica-Bold').fontSize(5.5).fillColor(textMuted).text(label.toUpperCase(), ix + 6, y + 4, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(textDark).text(fmtVal(val, true), ix + 6, y + 13, { lineBreak: false });
      doc.font('Helvetica').fontSize(5.5).fillColor(primaryBlue).text(`${pct}% of total inventory`, ix + 6, y + 21, { lineBreak: false });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAGE 2: Commercial Leaders, Operational Yield & Active System Risks
  // ═══════════════════════════════════════════════════════════════════════════
  doc.addPage();
  drawHeader(false);
  y = 48;

  // 6. Top Products by Revenue & Margin (Top 5)
  const topProducts = (options.leaderboards?.top_products_by_revenue || []).slice(0, 5);
  if (topProducts.length > 0) {
    y = drawSectionTitle('Commercial Leaders: Top Products', y, 'Top 5 by Revenue');
    const pCols = [
      { label: '#', width: 22, align: 'center' },
      { label: 'Product Name', width: 220, align: 'left' },
      { label: 'Units Sold', width: 75, align: 'right' },
      { label: 'Total Revenue', width: 105, align: 'right' },
      { label: 'Est. Margin', width: contentWidth - 422, align: 'right' }
    ];

    doc.rect(pageMargin, y, contentWidth, 13).fill('#1e293b');
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#ffffff');
    let px = pageMargin;
    pCols.forEach(c => {
      doc.text(c.label.toUpperCase(), px + 4, y + 3.5, { width: c.width - 8, align: c.align, lineBreak: false });
      px += c.width;
    });
    y += 13;

    topProducts.forEach((p, idx) => {
      if (idx % 2 === 1) doc.rect(pageMargin, y, contentWidth, 12).fill('#f8fafc');
      doc.font('Helvetica').fontSize(6.5).fillColor(textDark);

      const vals = [
        String(idx + 1),
        String(p.name || 'Product'),
        fmtVal(p.quantity),
        fmtVal(p.revenue, true),
        fmtVal(p.margin, true)
      ];

      let cx = pageMargin;
      vals.forEach((v, vIdx) => {
        doc.text(v, cx + 4, y + 2.5, { width: pCols[vIdx].width - 8, align: pCols[vIdx].align, lineBreak: false });
        cx += pCols[vIdx].width;
      });

      y += 12;
      doc.moveTo(pageMargin, y).lineTo(pageMargin + contentWidth, y).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    });
    y += 10;
  }

  // 7. Customers & Vendors (Side-by-Side Top 5)
  const topCustomers = (options.leaderboards?.top_customers || []).slice(0, 5);
  const topVendors = (options.leaderboards?.top_vendors || []).slice(0, 5);
  if (topCustomers.length > 0 || topVendors.length > 0) {
    y = drawSectionTitle('Key Customer & Vendor Partnerships', y, 'Top 5 Highlights');
    const halfW = (contentWidth - 8) / 2;

    doc.rect(pageMargin, y, halfW, 13).fill('#334155');
    doc.font('Helvetica-Bold').fontSize(6).fillColor('#ffffff');
    doc.text('CUSTOMER (TOP 5)', pageMargin + 4, y + 3.5, { width: halfW - 110, lineBreak: false });
    doc.text('LIFETIME VALUE', pageMargin + halfW - 105, y + 3.5, { width: 55, align: 'right', lineBreak: false });
    doc.text('DUE', pageMargin + halfW - 50, y + 3.5, { width: 46, align: 'right', lineBreak: false });

    doc.rect(pageMargin + halfW + 8, y, halfW, 13).fill('#334155');
    doc.font('Helvetica-Bold').fontSize(6).fillColor('#ffffff');
    doc.text('VENDOR (TOP 5)', pageMargin + halfW + 12, y + 3.5, { width: halfW - 110, lineBreak: false });
    doc.text('PURCHASES', pageMargin + contentWidth - 105, y + 3.5, { width: 55, align: 'right', lineBreak: false });
    doc.text('PAYABLE', pageMargin + contentWidth - 50, y + 3.5, { width: 46, align: 'right', lineBreak: false });
    y += 13;

    const maxR = Math.max(topCustomers.length, topVendors.length, 1);
    for (let r = 0; r < maxR; r++) {
      const cust = topCustomers[r];
      const vend = topVendors[r];

      if (r % 2 === 1) {
        doc.rect(pageMargin, y, halfW, 12).fill('#f8fafc');
        doc.rect(pageMargin + halfW + 8, y, halfW, 12).fill('#f8fafc');
      }

      doc.font('Helvetica').fontSize(6.5).fillColor(textDark);
      if (cust) {
        doc.text(String(cust.name || '-'), pageMargin + 4, y + 2.5, { width: halfW - 110, lineBreak: false });
        doc.text(fmtVal(cust.lifetime_value, true), pageMargin + halfW - 105, y + 2.5, { width: 55, align: 'right', lineBreak: false });
        doc.fillColor(Number(cust.outstanding_balance) > 0 ? redText : textMuted);
        doc.text(fmtVal(cust.outstanding_balance, true), pageMargin + halfW - 50, y + 2.5, { width: 46, align: 'right', lineBreak: false });
      }

      doc.fillColor(textDark);
      if (vend) {
        doc.text(String(vend.name || '-'), pageMargin + halfW + 12, y + 2.5, { width: halfW - 110, lineBreak: false });
        doc.text(fmtVal(vend.lifetime_value, true), pageMargin + contentWidth - 105, y + 2.5, { width: 55, align: 'right', lineBreak: false });
        doc.fillColor(Number(vend.outstanding_balance) > 0 ? amberText : textMuted);
        doc.text(fmtVal(vend.outstanding_balance, true), pageMargin + contentWidth - 50, y + 2.5, { width: 46, align: 'right', lineBreak: false });
      }

      y += 12;
      doc.moveTo(pageMargin, y).lineTo(pageMargin + halfW, y).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
      doc.moveTo(pageMargin + halfW + 8, y).lineTo(pageMargin + contentWidth, y).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    }
    y += 10;
  }

  // 8. Production Efficiency Summary
  const currentSummary = options.summary?.current || {};
  y = drawSectionTitle('Production Yield & Manufacturing Health', y);
  const mWidth = (contentWidth - 18) / 4;
  const mHeight = 28;

  const avgYield = Number(currentSummary.average_yield_percent || 0).toFixed(1);
  const wastage = Number(currentSummary.wastage_percent || 0).toFixed(1);
  const prodCards = [
    { label: 'AVERAGE YIELD %', val: `${avgYield}%`, color: primaryBlue },
    { label: 'TARGET BENCHMARK', val: '92.0%', color: textMuted },
    { label: 'WASTAGE %', val: `${wastage}%`, color: redText },
    { label: 'TOTAL COGS', val: fmtVal(currentSummary.cogs, true), color: textDark }
  ];

  prodCards.forEach((c, idx) => {
    const mx = pageMargin + (idx * (mWidth + 6));
    doc.roundedRect(mx, y, mWidth, mHeight, 4).fillAndStroke(lightBg, cardBorder);
    doc.font('Helvetica-Bold').fontSize(5).fillColor(textMuted).text(c.label, mx + 5, y + 4, { lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(c.color).text(c.val, mx + 5, y + 13, { lineBreak: false });
  });
  y += mHeight + 10;

  // 9. Active Alerts & Operational Risks (Top 5-6)
  const alertList = (options.alerts || []).slice(0, 6);
  if (alertList.length > 0) {
    y = drawSectionTitle('Active System Risks & Priority Alerts', y, `Top ${alertList.length} Items`);

    alertList.forEach((al) => {
      const isHigh = al.severity === 'high';
      const bg = isHigh ? '#fff1f2' : '#fffbeb';
      const border = isHigh ? '#fecdd3' : '#fef3c7';
      const tagBg = isHigh ? '#e11d48' : '#d97706';

      doc.roundedRect(pageMargin, y, contentWidth, 14, 3).fillAndStroke(bg, border);

      doc.rect(pageMargin + 3, y + 2.5, 36, 9).fill(tagBg);
      doc.font('Helvetica-Bold').fontSize(5).fillColor('#ffffff')
         .text(isHigh ? 'CRITICAL' : 'WARNING', pageMargin + 3, y + 4.5, { width: 36, align: 'center', lineBreak: false });

      doc.font('Helvetica-Bold').fontSize(6.5).fillColor(textDark)
         .text(String(al.title || al.name || ''), pageMargin + 44, y + 3.5, { width: contentWidth - 55, lineBreak: false });

      y += 16;
    });
  }

  // Multi-page Footers
  const totalPages = doc.bufferedPageRange().count;
  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(i);
    doc.moveTo(pageMargin, pageHeight - 24).lineTo(pageWidth - pageMargin, pageHeight - 24).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    doc.font('Helvetica').fontSize(6.5).fillColor(textMuted);
    doc.text('Generated via ERP Studio Enterprise · Confidential Executive Dashboard', pageMargin, pageHeight - 17, { lineBreak: false });
    doc.text(`Page ${i + 1} of ${totalPages}`, pageMargin, pageHeight - 17, { width: contentWidth, align: 'right', lineBreak: false });
  }

  doc.end();
}

async function getWeightedAvgCost(tenantDb, itemId, upToDate = new Date().toISOString().slice(0, 10)) {
  if (!itemId) return 0;
  try {
    const res = await tenantDb.query(
      `SELECT SUM(pi.quantity * pi.rate_per_unit) / NULLIF(SUM(pi.quantity), 0) AS avg_cost
       FROM procurement_items pi
       JOIN procurements p ON p.id = pi.procurement_id
       WHERE pi.item_id = ? AND p.deleted_at IS NULL AND p.date <= ?`,
      [itemId, upToDate]
    );
    const cost = Number(res.rows[0]?.avg_cost || 0);
    if (cost > 0) return cost;
  } catch (_) {}

  try {
    const res = await tenantDb.query(
      `SELECT SUM(quantity * rate_per_unit) / NULLIF(SUM(quantity), 0) AS avg_cost
       FROM procurements
       WHERE raw_material_id = ? AND deleted_at IS NULL AND date <= ?`,
      [itemId, upToDate]
    );
    const cost = Number(res.rows[0]?.avg_cost || 0);
    if (cost > 0) return cost;
  } catch (_) {}

  try {
    const itemRes = await tenantDb.query('SELECT last_purchase_price FROM items WHERE id = ?', [itemId]);
    if (itemRes.rowCount > 0) return Number(itemRes.rows[0].last_purchase_price) || 0;
  } catch (_) {}

  return 0;
}

async function getLocationAwareInventoryAlerts(tenantDb, locationId = null) {
  try {
    const locationsRes = await tenantDb.query(
      "SELECT id, name, is_default FROM locations WHERE deleted_at IS NULL ORDER BY is_default DESC"
    );
    const locations = locationsRes.rows || [];
    if (locations.length === 0) return [];

    const stockQuery = `
      SELECT 
        l.id AS location_id,
        l.name AS location_name,
        catalog.item_type,
        catalog.id AS item_id,
        catalog.name AS item_name,
        catalog.unit,
        catalog.reorder_level,
        COALESCE(SUM(CASE 
          WHEN il.transaction_type = 'in' OR (il.transaction_type = 'adjustment' AND il.quantity > 0) THEN ABS(il.quantity)
          WHEN il.transaction_type = 'out' OR (il.transaction_type = 'adjustment' AND il.quantity < 0) THEN -ABS(il.quantity)
          ELSE il.quantity END), 0) AS current_stock
      FROM locations l
      CROSS JOIN (
        SELECT id, name, 'finished_good' AS item_type, unit, reorder_level FROM finished_goods WHERE deleted_at IS NULL
        UNION ALL
        SELECT id, name, 'raw_material' AS item_type, unit, reorder_level FROM raw_materials WHERE deleted_at IS NULL
        UNION ALL
        SELECT id, name, item_type, unit, reorder_level FROM items WHERE deleted_at IS NULL AND id NOT IN (SELECT id FROM finished_goods WHERE deleted_at IS NULL UNION SELECT id FROM raw_materials WHERE deleted_at IS NULL)
      ) catalog
      LEFT JOIN inventory_ledger il ON (il.item_id = catalog.id AND il.item_type = catalog.item_type AND (il.location_id = l.id OR (il.location_id IS NULL AND l.is_default = 1)))
      WHERE l.deleted_at IS NULL
      GROUP BY l.id, l.name, catalog.item_type, catalog.id, catalog.name, catalog.unit, catalog.reorder_level
    `;

    const res = await tenantDb.query(stockQuery);
    const rows = res.rows || [];

    const itemLocationMap = {};
    for (const r of rows) {
      if (!itemLocationMap[r.item_id]) itemLocationMap[r.item_id] = [];
      itemLocationMap[r.item_id].push({
        location_id: r.location_id,
        location_name: r.location_name,
        current_stock: parseFloat(r.current_stock || 0)
      });
    }

    const alerts = [];
    for (const r of rows) {
      if (locationId && r.location_id !== locationId) continue;

      const stock = parseFloat(r.current_stock || 0);
      const reorder = r.reorder_level != null ? parseFloat(r.reorder_level) : 0;

      let status = 'OK';
      if (stock < 0) status = 'Anomaly';
      else if (stock === 0) status = 'Out';
      else if (stock <= reorder) status = 'Low';

      if (status !== 'OK') {
        const otherLocs = (itemLocationMap[r.item_id] || [])
          .filter((o) => o.location_id !== r.location_id && o.current_stock > 0)
          .sort((a, b) => b.current_stock - a.current_stock);

        const transferOpp = otherLocs.length > 0 ? {
          from_location_id: otherLocs[0].location_id,
          from_location_name: otherLocs[0].location_name,
          available_stock: otherLocs[0].current_stock
        } : null;

        alerts.push({
          type: 'low_stock',
          severity: status === 'Out' || status === 'Anomaly' ? 'high' : 'medium',
          location_id: r.location_id,
          location_name: r.location_name,
          title: status === 'Out'
            ? `${r.item_name} is out of stock at ${r.location_name} (0 ${r.unit})`
            : `${r.item_name} stock is low at ${r.location_name} (${stock} ${r.unit} left)`,
          name: r.item_name,
          current_stock: stock,
          unit: r.unit,
          status,
          entity_id: r.item_id,
          item_type: r.item_type,
          transfer_opportunity: transferOpp
        });
      }
    }

    return alerts.sort((a, b) => {
      if (a.severity === 'high' && b.severity !== 'high') return -1;
      if (b.severity === 'high' && a.severity !== 'high') return 1;
      return a.location_name.localeCompare(b.location_name);
    });
  } catch (err) {
    console.error('getLocationAwareInventoryAlerts error:', err);
    return [];
  }
}

module.exports = {
  numeric,
  todayIso,
  dateRangeFromQuery,
  previousPeriod,
  paymentStatus,
  toCSV,
  getBatchCostContext,
  getInventorySnapshot,
  getLocationAwareInventoryAlerts,
  streamSimplePdf,
  streamExecutiveDashboardPdf,
  getWeightedAvgCost
};

