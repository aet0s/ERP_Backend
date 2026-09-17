const PDFDocument = require('pdfkit');
const { numberToWordsINR } = require('./numberToWords');

function streamInvoicePdf(res, data) {
  const {
    workspace = {},
    customer = {},
    invoice = {},
    items = [],
    template = 'standard' // 'standard' or 'clean_minimal'
  } = data;

  const doc = new PDFDocument({ margin: 36, size: 'A4', bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Invoice_${invoice.invoice_number || 'INV'}.pdf"`);
  doc.pipe(res);

  const brandColor = workspace.accent_color || '#1e3a8a';
  const darkSlate = '#0f172a';
  const mutedSlate = '#64748b';
  const lightBg = '#f8fafc';
  const borderSlate = '#cbd5e1';

  const pageMargin = 36;
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const contentWidth = pageWidth - (pageMargin * 2);

  // 1. Header Banner & Branding
  doc.rect(0, 0, pageWidth, 60).fill(brandColor);
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#ffffff').text(workspace.name || 'COMPANY NAME', pageMargin, 16);
  doc.font('Helvetica').fontSize(9).fillColor('#cbd5e1').text(`TAX INVOICE`, pageMargin, 18, { align: 'right' });
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff').text(invoice.invoice_number || 'INV-0001', pageMargin, 32, { align: 'right' });

  let currentY = 75;

  // 2. Company & Customer Details Cards
  doc.rect(pageMargin, currentY, contentWidth / 2 - 6, 90).fillAndStroke(lightBg, borderSlate);
  doc.rect(pageMargin + contentWidth / 2 + 6, currentY, contentWidth / 2 - 6, 90).fillAndStroke(lightBg, borderSlate);

  // Left: Seller Info
  doc.font('Helvetica-Bold').fontSize(9).fillColor(brandColor).text('SELLER / ISSUED BY', pageMargin + 10, currentY + 8);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(darkSlate).text(workspace.name || 'Company', pageMargin + 10, currentY + 22);
  doc.font('Helvetica').fontSize(8.5).fillColor(mutedSlate);
  doc.text(`GSTIN: ${workspace.gstin || 'Unregistered'}`, pageMargin + 10, currentY + 36);
  doc.text(`State: ${workspace.state || 'N/A'}`, pageMargin + 10, currentY + 48);
  doc.text(`Address: ${workspace.address || 'N/A'}`, pageMargin + 10, currentY + 60, { width: contentWidth / 2 - 26, truncate: true });

  // Right: Buyer Info
  const rightX = pageMargin + contentWidth / 2 + 16;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(brandColor).text('BILL TO / BUYER', rightX, currentY + 8);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(darkSlate).text(customer.name || 'Walk-in Customer', rightX, currentY + 22);
  doc.font('Helvetica').fontSize(8.5).fillColor(mutedSlate);
  doc.text(`GSTIN: ${customer.gstin || 'Unregistered'}`, rightX, currentY + 36);
  doc.text(`Billing State: ${customer.state || 'N/A'}`, rightX, currentY + 48);
  doc.text(`Date: ${invoice.date || ''} | Due: ${invoice.due_date || 'On Receipt'}`, rightX, currentY + 60);

  currentY += 105;

  // 3. Line Items Table Header
  const cols = [
    { label: 'ITEM & SPECIFICATION', width: contentWidth * 0.35, align: 'left' },
    { label: 'HSN', width: contentWidth * 0.10, align: 'left' },
    { label: 'QTY', width: contentWidth * 0.08, align: 'right' },
    { label: 'RATE', width: contentWidth * 0.12, align: 'right' },
    { label: 'TAXABLE', width: contentWidth * 0.13, align: 'right' },
    { label: 'TAX %', width: contentWidth * 0.08, align: 'right' },
    { label: 'TOTAL', width: contentWidth * 0.14, align: 'right' }
  ];

  doc.rect(pageMargin, currentY, contentWidth, 22).fill('#1e293b');
  let colX = pageMargin;
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
  cols.forEach((c) => {
    doc.text(c.label, colX + 4, currentY + 6, { width: c.width - 8, align: c.align });
    colX += c.width;
  });

  currentY += 22;

  // 4. Line Items Rows
  items.forEach((row, idx) => {
    const rowHeight = 20;
    if (idx % 2 === 1) {
      doc.rect(pageMargin, currentY, contentWidth, rowHeight).fill('#f8fafc');
    }

    doc.font('Helvetica').fontSize(8).fillColor(darkSlate);
    let cX = pageMargin;

    doc.text(row.name || 'Item', cX + 4, currentY + 5, { width: cols[0].width - 8, align: 'left', truncate: true });
    cX += cols[0].width;

    doc.text(row.hsn_code || '-', cX + 4, currentY + 5, { width: cols[1].width - 8, align: 'left' });
    cX += cols[1].width;

    doc.text(Number(row.quantity || 0).toLocaleString(), cX + 4, currentY + 5, { width: cols[2].width - 8, align: 'right' });
    cX += cols[2].width;

    doc.text(Number(row.rate_per_unit || 0).toFixed(2), cX + 4, currentY + 5, { width: cols[3].width - 8, align: 'right' });
    cX += cols[3].width;

    doc.text(Number(row.taxable_value || (row.quantity * row.rate_per_unit)).toFixed(2), cX + 4, currentY + 5, { width: cols[4].width - 8, align: 'right' });
    cX += cols[4].width;

    doc.text(`${Number(row.tax_rate || 0)}%`, cX + 4, currentY + 5, { width: cols[5].width - 8, align: 'right' });
    cX += cols[5].width;

    doc.text(Number(row.line_total || 0).toFixed(2), cX + 4, currentY + 5, { width: cols[6].width - 8, align: 'right' });

    currentY += rowHeight;
    doc.moveTo(pageMargin, currentY).lineTo(pageWidth - pageMargin, currentY).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
  });

  currentY += 10;

  // 5. Totals & Tax Split Breakdown
  const summaryWidth = 220;
  const summaryX = pageWidth - pageMargin - summaryWidth;

  doc.font('Helvetica').fontSize(8.5).fillColor(darkSlate);

  function drawSummaryRow(label, value, bold = false) {
    if (bold) doc.font('Helvetica-Bold'); else doc.font('Helvetica');
    doc.text(label, summaryX, currentY, { width: 120, align: 'left' });
    doc.text(value, summaryX + 120, currentY, { width: 100, align: 'right' });
    currentY += 14;
  }

  drawSummaryRow('Subtotal:', Number(invoice.subtotal || 0).toFixed(2));
  if (Number(invoice.cgst_amount) > 0) {
    drawSummaryRow('CGST:', Number(invoice.cgst_amount).toFixed(2));
    drawSummaryRow('SGST:', Number(invoice.sgst_amount).toFixed(2));
  } else if (Number(invoice.igst_amount) > 0) {
    drawSummaryRow('IGST:', Number(invoice.igst_amount).toFixed(2));
  } else if (Number(invoice.total_tax) > 0) {
    drawSummaryRow('Total Tax:', Number(invoice.total_tax).toFixed(2));
  }

  if (Number(invoice.discount_amount) > 0) {
    drawSummaryRow('Discount:', `-${Number(invoice.discount_amount).toFixed(2)}`);
  }

  if (Number(invoice.round_off_amount) !== 0) {
    const ro = Number(invoice.round_off_amount);
    const roStr = ro > 0 ? `+${ro.toFixed(2)}` : `${ro.toFixed(2)}`;
    drawSummaryRow('Round Off:', roStr);
  }

  doc.rect(summaryX, currentY, summaryWidth, 20).fill(brandColor);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#ffffff');
  doc.text('GRAND TOTAL:', summaryX + 8, currentY + 5, { width: 100, align: 'left' });
  doc.text(`INR ${Number(invoice.total_amount || 0).toFixed(2)}`, summaryX + 108, currentY + 5, { width: 104, align: 'right' });

  currentY += 30;

  // 6. Total in Words Card
  doc.rect(pageMargin, currentY, contentWidth, 24).fillAndStroke('#f1f5f9', borderSlate);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(darkSlate);
  doc.text(`Amount in Words: ${numberToWordsINR(invoice.total_amount || 0)}`, pageMargin + 10, currentY + 7);

  currentY += 35;

  // 7. Terms, Bank Details & Footer
  doc.font('Helvetica-Bold').fontSize(8).fillColor(brandColor).text('TERMS & BANK DETAILS', pageMargin, currentY);
  currentY += 12;
  doc.font('Helvetica').fontSize(7.5).fillColor(mutedSlate);
  doc.text(invoice.terms_and_conditions || workspace.bank_details || '1. Goods once sold will not be taken back.\n2. Subject to local jurisdiction.', pageMargin, currentY, { width: contentWidth - 150 });

  doc.font('Helvetica-Bold').fontSize(8).fillColor(darkSlate).text(`For ${workspace.name || 'Company'}`, pageWidth - pageMargin - 140, currentY + 15, { align: 'right' });
  doc.font('Helvetica').fontSize(7.5).fillColor(mutedSlate).text('Authorized Signatory', pageWidth - pageMargin - 140, currentY + 35, { align: 'right' });

  // Page Numbers Footer
  const totalPages = doc.bufferedPageRange().count;
  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(i);
    doc.moveTo(pageMargin, pageHeight - 25).lineTo(pageWidth - pageMargin, pageHeight - 25).strokeColor('#cbd5e1').lineWidth(0.5).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(mutedSlate);
    doc.text(`Generated via ERP Studio Enterprise · GST Compliant Invoice`, pageMargin, pageHeight - 18);
    doc.text(`Page ${i + 1} of ${totalPages}`, pageMargin, pageHeight - 18, { align: 'right' });
  }

  doc.end();
}

module.exports = { streamInvoicePdf };
