const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const OUTPUT_NAME = 'plan_commande_telephones_3M.pdf';
const OUTPUT_PATH = path.join(__dirname, OUTPUT_NAME);

function runAnalysis() {
  return new Promise((resolve, reject) => {
    const args = [
      'recommend_fast_movers.js',
      '--horizon=4',
      '--max-days=12'
    ];

    execFile('node', args, { cwd: __dirname }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr || error.message));
      }
      resolve(stdout);
    });
  });
}

function splitSections(raw) {
  const lines = raw.split(/\r?\n/).map(line => line.trimEnd());
  const sections = {
    analysis: [],
    top: [],
    fastPlan: [],
    extendedPlan: [],
    budget: [],
    footer: []
  };

  let current = 'analysis';
  for (const line of lines) {
    if (line.startsWith('Top 10 téléphones')) {
      current = 'top';
      sections[current].push(line);
      continue;
    }
    if (line.startsWith('Plan principal')) {
      current = 'fastPlan';
      sections[current].push(line);
      continue;
    }
    if (line.startsWith('Compléments rapides')) {
      current = 'extendedPlan';
      sections[current].push(line);
      continue;
    }
    if (line.startsWith('Budget utilisé')) {
      current = 'budget';
      sections[current].push(line);
      continue;
    }
    if (line === '') {
      continue;
    }
    sections[current].push(line);
  }

  if (sections.top[0]?.startsWith('Top 10')) {
    sections.top.shift();
  }
  if (sections.fastPlan[0]?.startsWith('Plan principal')) {
    sections.fastPlan.shift();
  }
  if (sections.extendedPlan[0]?.startsWith('Compléments rapides')) {
    sections.extendedPlan.shift();
  }

  return sections;
}

function extractValue(parts, label) {
  const normalizedLabel = label.toLowerCase();
  for (const part of parts) {
    const normalizedPart = part.toLowerCase();
    if (normalizedPart.startsWith(normalizedLabel)) {
      const [, ...rest] = part.split(':');
      return rest.join(':').trim();
    }
  }
  return '';
}

function stripUnits(value, units = []) {
  let result = value;
  units.forEach(unit => {
    const regex = new RegExp(`\\s*${unit}$`, 'i');
    result = result.replace(regex, '');
  });
  return result.trim();
}

function parseAmount(value) {
  if (!value) return null;
  const cleaned = value.replace(/[^0-9,.-]/g, '').replace(/,/g, '.');
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function formatCurrencyValue(amount) {
  if (!Number.isFinite(amount)) return '';
  const rounded = Math.round(amount);
  const formatted = rounded
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${formatted} FCFA`;
}

function normalizeAmount(value) {
  const amount = parseAmount(value);
  if (amount != null) {
    return formatCurrencyValue(amount);
  }
  return (value || '').replace(/\s+/g, ' ').trim();
}

function parseTopLines(lines) {
  const rows = [];
  for (const line of lines) {
    if (!line) continue;
    const noNumber = line.replace(/^\d+\.\s*/, '');
    const parts = noNumber.split(' | ').map(part => part.trim());
    if (parts.length < 5) continue;
    const name = parts[0];
    const avg = stripUnits(parts[1] || '', ['u/jour']);
    const qty = stripUnits(extractValue(parts.slice(2), 'Qté vendue'), []);
    const stock = stripUnits(extractValue(parts.slice(2), 'Stock estimé'), []);
    const cost = normalizeAmount(extractValue(parts.slice(2), 'Coût achat estimé'));
    const sellThrough = stripUnits(extractValue(parts.slice(2), 'Sell-through') || '-', []);
    rows.push([name, avg, qty, stock, cost, sellThrough || '-']);
  }
  return rows;
}

function parsePlanLines(lines, includeStock = false) {
  const rows = [];
  for (const rawLine of lines) {
    if (!rawLine || rawLine.startsWith('Aucun article')) continue;
    const line = rawLine.replace(/^\d+\.\s*/, '');
    const [namePart, detailsPart] = line.split('->').map(part => part.trim());
    if (!detailsPart) continue;
    const detailSegments = detailsPart.split('|').map(segment => segment.trim());
    const qty = stripUnits(extractValue(detailSegments, 'Qté'), []);
    const unitCost = normalizeAmount(extractValue(detailSegments, 'Coût unitaire'));
    const rawLineCost = extractValue(detailSegments, 'Ligne');
    const numericLineCost = parseAmount(rawLineCost) ?? 0;
    const lineCost = normalizeAmount(rawLineCost);
    const speed = stripUnits(extractValue(detailSegments, 'Vitesse'), ['u/jour']);
    const turnover = stripUnits(extractValue(detailSegments, 'Écoulement estimé'), ['jours', 'jour']);
    let stock = extractValue(detailSegments, 'Stock actuel');
    if (!stock) {
      stock = extractValue(detailSegments, 'Stock');
    }
    stock = stripUnits(stock || '-', []);
    if (includeStock) {
      rows.push([namePart, qty, unitCost, lineCost, speed, turnover, stock]);
    } else {
      rows.push([namePart, qty, unitCost, lineCost, speed, turnover]);
    }
    rows.total = (rows.total || 0) + numericLineCost;
  }
  return { rows, total: rows.total || 0 };
}

function calculateRowHeight(doc, cells, widths) {
  let max = 0;
  cells.forEach((cell, idx) => {
    const width = Math.max(10, widths[idx] - 8);
    const height = doc.heightOfString(cell, { width });
    max = Math.max(max, height);
  });
  return max + 8;
}

function renderRow(doc, cells, startX, y, widths, options = {}) {
  const { header = false, height } = options;
  const rowHeight = height ?? calculateRowHeight(doc, cells, widths);
  let x = startX;

  cells.forEach((cell, idx) => {
    if (header) {
      doc.save();
      doc.rect(x, y, widths[idx], rowHeight).fill('#f2f2f2');
      doc.restore();
    }
    doc.rect(x, y, widths[idx], rowHeight).stroke();
    doc.text(cell, x + 4, y + 4, { width: widths[idx] - 8, lineGap: 2 });
    x += widths[idx];
  });

  return rowHeight;
}

function drawTable(doc, title, headers, rows, columnWidths, footerText) {
  if (!rows || rows.length === 0) {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(16).text(title);
    doc.moveDown();
    doc.font('Helvetica').fontSize(11).text('Aucune donnée disponible.');
    return;
  }

  const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  let widths = columnWidths;
  if (!widths || widths.length !== headers.length) {
    const defaultWidth = availableWidth / headers.length;
    widths = new Array(headers.length).fill(defaultWidth);
  }

  const drawHeader = () => {
    doc.font('Helvetica-Bold').fontSize(16).text(title);
    let y = doc.y + 10;
    doc.font('Helvetica-Bold').fontSize(10);
    const headerHeight = calculateRowHeight(doc, headers, widths);
    renderRow(doc, headers, doc.page.margins.left, y, widths, { header: true, height: headerHeight });
    return y + headerHeight;
  };

  doc.addPage();
  let y = drawHeader();
  doc.font('Helvetica').fontSize(10);

  const limitY = doc.page.height - doc.page.margins.bottom;

  rows.forEach(row => {
    const rowHeight = calculateRowHeight(doc, row, widths);
    if (y + rowHeight > limitY) {
      doc.addPage();
      y = drawHeader();
      doc.font('Helvetica').fontSize(10);
    }
    renderRow(doc, row, doc.page.margins.left, y, widths, { height: rowHeight });
    y += rowHeight;
  });
  doc.y = y + 6;

  if (footerText) {
    if (doc.y + 20 > limitY) {
      doc.addPage();
      doc.y = doc.page.margins.top;
    }
    doc.font('Helvetica-Bold').fontSize(11).text(
      footerText,
      doc.page.margins.left,
      doc.y,
      { align: 'right', width: availableWidth }
    );
    doc.moveDown(0.5);
  }
}

function createPdf(sections) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, info: { Title: 'Plan commande téléphones 3M', Author: 'Analyse automatique' } });
    const stream = fs.createWriteStream(OUTPUT_PATH);
    doc.pipe(stream);

    const now = new Date();

    doc.font('Helvetica-Bold').fontSize(20).text('Plan de commande - Téléphones', { align: 'center' });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(12).text('Budget ciblé : 3 000 000 FCFA | Horizon principal : 4 jours | Horizon étendu : 12 jours', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).text(`Export généré le ${now.toLocaleString('fr-FR')}`, { align: 'center' });

    doc.moveDown();
    doc.font('Helvetica-Bold').fontSize(16).text('Résumé');
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(11);

    sections.analysis.forEach(line => {
      doc.text(line);
      doc.moveDown(0.2);
    });

    doc.moveDown(0.3);
    sections.budget.forEach(line => {
      doc.text(line);
      doc.moveDown(0.2);
    });

    if (sections.footer.length > 0) {
      doc.moveDown(0.3);
      sections.footer.forEach(line => {
        doc.text(line);
        doc.moveDown(0.2);
      });
    }

    const topRows = parseTopLines(sections.top);
    const fastData = parsePlanLines(sections.fastPlan);
    const extendedData = parsePlanLines(sections.extendedPlan);
    const fastRows = fastData.rows;
    const extendedRows = extendedData.rows;

    drawTable(
      doc,
      'Top 10 téléphones',
      ['Article', 'Vitesse (u/j)', 'Qté vendue', 'Stock estimé', 'Coût achat', 'Sell-through'],
      topRows,
      [200, 60, 70, 60, 80, 42]
    );

    drawTable(
      doc,
      'Plan principal (≤ 4 jours)',
      ['Article', 'Qté', 'Coût unitaire', 'Coût total', 'Vitesse (u/j)', 'Écoulement (j)'],
      fastRows,
      [200, 45, 80, 80, 55, 55],
      fastRows.length > 0 ? `Total plan principal : ${formatCurrencyValue(fastData.total)}` : ''
    );

    drawTable(
      doc,
      'Compléments rapides (≤ 12 jours)',
      ['Article', 'Qté', 'Coût unitaire', 'Coût total', 'Vitesse (u/j)', 'Écoulement (j)'],
      extendedRows,
      [200, 45, 80, 80, 55, 55],
      extendedRows.length > 0 ? `Total compléments : ${formatCurrencyValue(extendedData.total)}` : ''
    );

    doc.end();

    stream.on('finish', () => resolve(OUTPUT_PATH));
    stream.on('error', reject);
  });
}

async function main() {
  try {
    const output = await runAnalysis();
    const sections = splitSections(output);
    if (sections.budget.length === 0) {
      sections.footer.push('Avertissement : aucun total budgétaire trouvé dans le rapport.');
    }
    const pdfPath = await createPdf(sections);
    console.log(`PDF généré: ${pdfPath}`);
  } catch (error) {
    console.error('Erreur lors de la génération du PDF:', error);
    process.exitCode = 1;
  }
}

main();
