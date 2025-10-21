const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const admin = require('firebase-admin');

const serviceAccountPath = path.join(__dirname, 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json');

let serviceAccount;
try {
  serviceAccount = require(serviceAccountPath);
} catch (err) {
  console.error('Impossible de charger la cle de service Firebase:', err.message);
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const SUPPLIER_NAME = 'Dieu ou rien';

function getTodayRange() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  end.setMilliseconds(end.getMilliseconds() - 1);
  return { start, end };
}

function toMillis(value) {
  if (!value && value !== 0) return null;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toDate === 'function') {
    return value.toDate().getTime();
  }
  if (value && typeof value.seconds === 'number') {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return Number(value) || null;
}

function formatCurrency(amount) {
  if (!Number.isFinite(amount)) return '';
  const rounded = Math.round(amount);
  const absolute = Math.abs(rounded);
  const formatted = absolute
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const sign = rounded < 0 ? '-' : '';
  return `${sign}${formatted} FCFA`;
}

function formatQuantityValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  if (Math.abs(num % 1) < 1e-6) {
    return num.toString();
  }
  return num.toLocaleString('fr-FR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  });
}

function formatDateForTitle(date) {
  return date.toLocaleDateString('fr-FR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function formatDateForDisplay(date) {
  return date.toLocaleDateString('fr-FR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

function formatDateForFilename(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function slugifyName(value) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '');
}

function parseNumericValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    const cleaned = value
      .trim()
      .replace(/[\s/]/g, '')
      .replace(/[^0-9.,-]/g, '')
      .replace(/,/g, '.');
    if (!cleaned) return 0;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === 'object') {
    if (typeof value.toNumber === 'function') {
      return parseNumericValue(value.toNumber());
    }
    if (typeof value.valueOf === 'function' && value !== value.valueOf()) {
      return parseNumericValue(value.valueOf());
    }
  }
  return 0;
}

function getItemName(item) {
  if (!item || typeof item !== 'object') return 'Article inconnu';
  return (
    item.produit ??
    item.name ??
    item.designation ??
    item.label ??
    'Article inconnu'
  );
}

function getItemQuantity(item) {
  if (!item || typeof item !== 'object') return 0;
  const raw = item.quantite ?? item.quantity ?? item.qty ?? item.qte ?? 0;
  return parseNumericValue(raw);
}

function getItemUnitCost(item) {
  if (!item || typeof item !== 'object') return 0;
  const raw =
    item.coutAchat ??
    item.prixAchat ??
    item.purchasePrice ??
    item.cost ??
    item.unitCost ??
    0;
  return parseNumericValue(raw);
}

function computeItemCost(item) {
  return getItemUnitCost(item) * getItemQuantity(item);
}

async function fetchTodayPurchases(startTimestamp, endTimestamp) {
  const snapshot = await db
    .collection('approvisionnement')
    .where('timestamp', '>=', startTimestamp)
    .where('timestamp', '<=', endTimestamp)
    .orderBy('timestamp', 'asc')
    .get();

  return snapshot.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(doc => {
      const supplier = (doc.fournisseur ?? doc.supplier ?? '').toString().trim().toLowerCase();
      return supplier === SUPPLIER_NAME.toLowerCase();
    });
}

function summarisePurchase(purchase) {
  const items = Array.isArray(purchase.items) ? purchase.items : [];
  const timestampMs = toMillis(purchase.timestamp);
  const itemsSummary = items.map(item => {
    const qty = getItemQuantity(item);
    const unitCost = getItemUnitCost(item);
    const lineCost = computeItemCost(item);
    return {
      name: getItemName(item),
      qty,
      unitCost,
      lineCost
    };
  });
  const totalCost = itemsSummary.reduce((acc, item) => acc + item.lineCost, 0);
  return {
    id: purchase.id,
    type: purchase.typeAchat ?? purchase.type ?? 'standard',
    note: purchase.note ?? purchase.notes ?? '',
    fournisseur: purchase.fournisseur ?? purchase.supplier ?? SUPPLIER_NAME,
    rawTimestamp: purchase.timestamp,
    timestampMs,
    items: itemsSummary,
    totalCost
  };
}

function calculateRowHeight(doc, cells, widths, options = {}) {
  const { font = 'Helvetica', fontSize = 10 } = options;
  let maxHeight = 0;
  cells.forEach((rawCell, idx) => {
    const cell = String(rawCell ?? '');
    doc.font(font).fontSize(fontSize);
    const width = Math.max(12, widths[idx] - 8);
    const height = doc.heightOfString(cell, { width, lineGap: 2 });
    maxHeight = Math.max(maxHeight, height);
  });
  return maxHeight + 8;
}

function drawHeaderRow(doc, headers, startX, y, widths) {
  const headerHeight = calculateRowHeight(doc, headers, widths, { font: 'Helvetica-Bold', fontSize: 10 });
  let x = startX;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000');
  headers.forEach((header, idx) => {
    doc.save();
    doc.rect(x, y, widths[idx], headerHeight).fill('#efefef');
    doc.restore();
    doc.rect(x, y, widths[idx], headerHeight).stroke();
    doc.text(String(header ?? ''), x + 4, y + 4, { width: Math.max(10, widths[idx] - 8), lineGap: 2 });
    x += widths[idx];
  });
  doc.font('Helvetica').fontSize(10).fillColor('#000000');
  return headerHeight;
}

function drawBodyRow(doc, cells, startX, y, widths, options = {}) {
  const { zebra = false } = options;
  const rowHeight = calculateRowHeight(doc, cells, widths, { font: 'Helvetica', fontSize: 10 });
  let x = startX;
  doc.font('Helvetica').fontSize(10).fillColor('#000000');
  cells.forEach((rawCell, idx) => {
    const cell = String(rawCell ?? '');
    if (zebra) {
      doc.save();
      doc.rect(x, y, widths[idx], rowHeight).fill('#f8f8f8');
      doc.restore();
    }
    doc.rect(x, y, widths[idx], rowHeight).stroke();
    doc.text(cell, x + 4, y + 4, { width: Math.max(10, widths[idx] - 8), lineGap: 2 });
    x += widths[idx];
  });
  return rowHeight;
}

function renderItemsTable(doc, items) {
  if (!Array.isArray(items) || items.length === 0) {
    doc.font('Helvetica').fontSize(10).fillColor('#444444').text('Aucun detail produit disponible.');
    doc.fillColor('#000000');
    doc.moveDown(0.4);
    return;
  }

  const headers = ['Article', 'Qte', 'Cout unitaire', 'Cout total'];
  const startX = doc.page.margins.left;
  const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colArticle = Math.max(Math.floor(availableWidth * 0.48), 170);
  const colQty = Math.max(Math.floor(availableWidth * 0.12), 60);
  const colUnit = Math.max(Math.floor(availableWidth * 0.2), 90);
  const colTotal = availableWidth - colArticle - colQty - colUnit;
  const columnWidths = [colArticle, colQty, colUnit, colTotal];
  const limitY = doc.page.height - doc.page.margins.bottom;

  const drawHeader = () => {
    const y = doc.y;
    const headerHeight = drawHeaderRow(doc, headers, startX, y, columnWidths);
    doc.y = y + headerHeight;
  };

  const headerHeight = calculateRowHeight(doc, headers, columnWidths, { font: 'Helvetica-Bold', fontSize: 10 });
  if (doc.y + headerHeight > limitY) {
    doc.addPage();
  }
  drawHeader();

  items.forEach((item, index) => {
    const cells = [
      item.name,
      formatQuantityValue(item.qty),
      formatCurrency(item.unitCost),
      formatCurrency(item.lineCost)
    ];
    const rowHeight = calculateRowHeight(doc, cells, columnWidths, { font: 'Helvetica', fontSize: 10 });
    if (doc.y + rowHeight > limitY) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    drawBodyRow(doc, cells, startX, y, columnWidths, { zebra: index % 2 === 0 });
    doc.y = y + rowHeight;
  });

  doc.moveDown(0.6);
}

function writePdfReport(purchases, start, end, outputPath) {
  const doc = new PDFDocument({ margin: 50, info: { Title: `Achats ${SUPPLIER_NAME}` } });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  const reportDateLabel = formatDateForTitle(start);
  const generatedAt = new Date();
  const generatedAtLabel = generatedAt.toLocaleDateString('fr-FR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const totalAmount = purchases.reduce((acc, purchase) => acc + purchase.totalCost, 0);
  const totalItems = purchases.reduce((acc, purchase) => acc + purchase.items.length, 0);

  doc.font('Helvetica-Bold').fontSize(20).text(`Achats - ${SUPPLIER_NAME}`, { align: 'center' });
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(12).text(`Jour couvert: ${reportDateLabel}`, { align: 'center' });
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(12).text(`Approvisionnements trouves: ${purchases.length}`, { align: 'center' });
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(10).text(`Export genere le ${generatedAtLabel}`, { align: 'center' });
  doc.moveDown();

  if (purchases.length === 0) {
    doc.font('Helvetica-Bold').fontSize(16).text('Resume');
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(11).text("Aucun achat enregistre pour ce fournisseur aujourd'hui.");
    doc.end();
    return new Promise((resolve, reject) => {
      stream.on('finish', () => resolve(outputPath));
      stream.on('error', reject);
    });
  }

  doc.font('Helvetica-Bold').fontSize(16).text('Resume');
  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(11);
  doc.text(`Fournisseur: ${SUPPLIER_NAME}`);
  doc.text(`Montant total estime: ${formatCurrency(totalAmount)}`);
  doc.text(`Articles references: ${totalItems}`);
  doc.moveDown(0.8);

  const limitY = doc.page.height - doc.page.margins.bottom;

  purchases.forEach((purchase, index) => {
    if (index > 0 && doc.y + 120 > limitY) {
      doc.addPage();
    }
    doc.font('Helvetica-Bold').fontSize(15).text(`Approvisionnement ${purchase.id}`);
    doc.moveDown(0.25);
    const timestamp = purchase.timestampMs ? new Date(purchase.timestampMs) : null;
    doc.font('Helvetica').fontSize(11);
    doc.text(`Date: ${timestamp ? formatDateForDisplay(timestamp) : 'N/A'}`);
    doc.text(`Type: ${purchase.type}`);
    doc.text(`Montant estime: ${formatCurrency(purchase.totalCost)}`);
    doc.text(`Nombre d'articles: ${purchase.items.length}`);
    if (purchase.note) {
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(10).fillColor('#444444').text(`Note: ${purchase.note}`, {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right
      });
      doc.fillColor('#000000');
    }
    doc.moveDown(0.35);
    renderItemsTable(doc, purchase.items);
    doc.moveDown(0.3);
  });

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

async function main() {
  const { start, end } = getTodayRange();
  const startTimestamp = admin.firestore.Timestamp.fromDate(start);
  const endTimestamp = admin.firestore.Timestamp.fromDate(end);

  try {
    console.log(`Recuperation des achats de "${SUPPLIER_NAME}" entre ${start.toISOString()} et ${end.toISOString()}...`);
    const rawPurchases = await fetchTodayPurchases(startTimestamp, endTimestamp);
    const purchases = rawPurchases.map(summarisePurchase);
    purchases.sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));

    const filename = `achats_${slugifyName(SUPPLIER_NAME)}_${formatDateForFilename(start)}.pdf`;
    const outputPath = path.join(__dirname, filename);
    const pdfPath = await writePdfReport(purchases, start, end, outputPath);

    console.log(`Rapport genere: ${pdfPath}`);
    console.log(`Approvisionnements retenus: ${purchases.length}`);
  } catch (err) {
    console.error('Erreur lors de la generation du rapport:', err);
    process.exitCode = 1;
  } finally {
    await admin.app().delete().catch(() => {});
  }
}

main();
