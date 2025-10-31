const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const admin = require('firebase-admin');

const serviceAccountPath = path.join(__dirname, 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json');

let serviceAccount;
try {
  serviceAccount = require(serviceAccountPath);
} catch (error) {
    console.error('Impossible de charger le service account Firebase:', error.message);
    process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 14;
const SUPPLIER_NAME = 'Abdoul';

const SUPPLIER_CANONICALS = new Map([
  ['abdoul', 'Abdoul'],
  ['abdoul tg', 'Abdoul'],
  ['abdoul tg.', 'Abdoul'],
  ['abdoul tg ', 'Abdoul'],
  ['abdoul tg-', 'Abdoul'],
  ['abdoul tg/', 'Abdoul']
]);

function canonicalSupplier(raw) {
  if (!raw) return '';
  const normalized = raw.toString().trim().toLowerCase();
  return SUPPLIER_CANONICALS.get(normalized) || raw.toString().trim();
}

function normalizeName(value) {
  return (value || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumeric(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const normalized = trimmed.replace(/[^0-9.,-]/g, '').replace(/,/g, '.');
    if (!normalized) return 0;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === 'object') {
    if (typeof value.toNumber === 'function') {
      return parseNumeric(value.toNumber());
    }
    if (typeof value.valueOf === 'function' && value !== value.valueOf()) {
      return parseNumeric(value.valueOf());
    }
  }
  return 0;
}

function getItemName(item) {
  if (!item || typeof item !== 'object') return 'Article sans nom';
  return (
    item.produit ||
    item.name ||
    item.designation ||
    item.label ||
    item.modele ||
    'Article sans nom'
  );
}

function getItemQuantity(item) {
  if (!item || typeof item !== 'object') return 0;
  return parseNumeric(item.quantite ?? item.qty ?? item.quantity ?? item.qte ?? 0);
}

function getItemUnitCost(item) {
  if (!item || typeof item !== 'object') return 0;
  return parseNumeric(
    item.prixAchat ??
    item.coutAchat ??
    item.cost ??
    item.unitCost ??
    item.purchasePrice ??
    item.cout ??
    0
  );
}

function getItemLineCost(item) {
  if (!item || typeof item !== 'object') return 0;
  const explicit =
    item.coutTotal ??
    item.totalCost ??
    item.ligneCout ??
    item.lineCost ??
    item.totalAchat;
  const parsedExplicit = parseNumeric(explicit);
  if (parsedExplicit > 0) {
    return parsedExplicit;
  }
  return getItemUnitCost(item) * getItemQuantity(item);
}

function getSaleTotal(item) {
  if (!item || typeof item !== 'object') return 0;
  const explicit =
    item.total ??
    item.totalVente ??
    item.prixTotal ??
    item.ligneTotal ??
    item.lineTotal ??
    item.totalPrice ??
    item.amount;
  const parsedExplicit = parseNumeric(explicit);
  if (parsedExplicit > 0) {
    return parsedExplicit;
  }
  const unit = parseNumeric(item.prixVente ?? item.prix ?? item.price ?? 0);
  return unit * getItemQuantity(item);
}

function getSaleProfit(item, saleTotal, saleCost) {
  if (!item || typeof item !== 'object') return 0;
  const explicit = parseNumeric(item.profitTotal ?? item.totalProfit ?? item.profit);
  if (Math.abs(explicit) > 0.01) return explicit;
  if (saleTotal !== undefined && saleCost !== undefined) {
    return saleTotal - saleCost;
  }
  return 0;
}

function isPhoneItem(item) {
  if (!item || typeof item !== 'object') return false;
  const category = (item.category ?? item.categorie ?? item.typeProduit ?? '')
    .toString()
    .toLowerCase();
  if (category.includes('phone') || category.includes('téléphone') || category.includes('telephone')) {
    return true;
  }
  const name = normalizeName(getItemName(item));
  return (
    name.includes('itel') ||
    name.includes('tecno') ||
    name.includes('infinix') ||
    name.includes('nokia') ||
    name.includes('samsung') ||
    name.includes('iphone') ||
    name.includes('smart') ||
    name.includes('phone') ||
    name.includes('gsm')
  );
}

function formatCurrency(amount) {
  if (!Number.isFinite(amount)) return '';
  const rounded = Math.round(amount);
  const absValue = Math.abs(rounded);
  const formatted = absValue
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const sign = rounded < 0 ? '-' : '';
  return `${sign}${formatted} FCFA`;
}

function formatQuantity(qty) {
  if (!Number.isFinite(qty)) return '';
  if (Math.abs(qty % 1) < 1e-6) {
    return `${qty}`;
  }
  return qty.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatDate(date) {
  return date.toLocaleDateString('fr-FR', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function slugify(value) {
  return (value || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '');
}

function getDateRange() {
  const end = new Date();
  const start = new Date(end.getTime() - LOOKBACK_DAYS * DAY_MS);
  start.setHours(0, 0, 0, 0);
  return { start, end };
}

async function fetchPurchases(startTimestamp, endTimestamp) {
  const snapshot = await db
    .collection('approvisionnement')
    .where('timestamp', '>=', startTimestamp)
    .where('timestamp', '<=', endTimestamp)
    .orderBy('timestamp', 'asc')
    .get();

  return snapshot.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(doc => canonicalSupplier(doc.fournisseur ?? doc.supplier ?? '') === SUPPLIER_NAME);
}

async function fetchSales(startTimestamp, endTimestamp) {
  const snapshot = await db
    .collection('ventes')
    .where('timestamp', '>=', startTimestamp)
    .where('timestamp', '<=', endTimestamp)
    .orderBy('timestamp', 'asc')
    .get();

  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

function summarizePurchases(purchases) {
  const aggregated = new Map();
  const totals = {
    purchaseQty: 0,
    purchaseValue: 0
  };
  const itemNames = new Set();

  for (const purchase of purchases) {
    const items = Array.isArray(purchase.items) ? purchase.items : [];
    for (const item of items) {
      if (!isPhoneItem(item)) {
        continue;
      }
      const name = getItemName(item);
      const normalized = normalizeName(name);
      if (!normalized) continue;
      const qty = getItemQuantity(item);
      if (qty <= 0) continue;
      const lineCost = getItemLineCost(item);
      const record = aggregated.get(normalized) || {
        name,
        purchaseQty: 0,
        purchaseValue: 0,
        saleQty: 0,
        saleRevenue: 0,
        saleCost: 0,
        saleProfit: 0
      };
      record.name = name; // preserve latest casing
      record.purchaseQty += qty;
      record.purchaseValue += lineCost;
      aggregated.set(normalized, record);

      totals.purchaseQty += qty;
      totals.purchaseValue += lineCost;
      itemNames.add(normalized);
    }
  }

  return { aggregated, totals, itemNames };
}

function summarizeSales(sales, aggregated, totals, referenceNames) {
  for (const sale of sales) {
    const items = Array.isArray(sale.items) ? sale.items : [];
    for (const item of items) {
      if (!isPhoneItem(item)) continue;

      const supplierField =
        item.fournisseur ??
        item.supplier ??
        item.sourceFournisseur ??
        item.depotFournisseurNom ??
        item.depotFournisseur ??
        '';
      const supplierCanonical = canonicalSupplier(supplierField);

      const normalizedName = normalizeName(getItemName(item));
      const isKnownAbdoulItem = referenceNames.has(normalizedName);
      if (supplierCanonical !== SUPPLIER_NAME && !isKnownAbdoulItem) {
        continue;
      }

      const qty = getItemQuantity(item);
      if (qty <= 0) continue;
      const saleTotal = getSaleTotal(item);
      const unitCost = getItemUnitCost(item);
      const saleCost = unitCost * qty;
      const saleProfit = getSaleProfit(item, saleTotal, saleCost);

      const record = aggregated.get(normalizedName) || {
        name: getItemName(item),
        purchaseQty: 0,
        purchaseValue: 0,
        saleQty: 0,
        saleRevenue: 0,
        saleCost: 0,
        saleProfit: 0
      };

      if (!aggregated.has(normalizedName)) {
        aggregated.set(normalizedName, record);
      }

      record.saleQty += qty;
      record.saleRevenue += saleTotal;
      record.saleCost += saleCost;
      record.saleProfit += saleProfit;

      totals.saleQty = (totals.saleQty || 0) + qty;
      totals.saleRevenue = (totals.saleRevenue || 0) + saleTotal;
      totals.saleCost = (totals.saleCost || 0) + saleCost;
      totals.saleProfit = (totals.saleProfit || 0) + saleProfit;
    }
  }
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

function renderTable(doc, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    doc.font('Helvetica').fontSize(10).fillColor('#444444').text('Aucune donnée à afficher pour la période.');
    doc.fillColor('#000000');
    doc.moveDown(0.6);
    return;
  }

  const headers = [
    'Produit',
    'Qté achat',
    'Valeur achat',
    'Qté vente',
    'Valeur vente',
    'Coût ventes',
    'Profit ventes'
  ];
  const columnWidths = [140, 60, 85, 60, 85, 85, 85];
  const startX = doc.page.margins.left;
  const limitY = doc.page.height - doc.page.margins.bottom;

  const headerHeight = drawHeaderRow(doc, headers, startX, doc.y, columnWidths);
  doc.y += headerHeight;

  rows.forEach((row, index) => {
    const cells = [
      row.name,
      formatQuantity(row.purchaseQty),
      formatCurrency(row.purchaseValue),
      formatQuantity(row.saleQty),
      formatCurrency(row.saleRevenue),
      formatCurrency(row.saleCost),
      formatCurrency(row.saleProfit)
    ];
    const rowHeight = calculateRowHeight(doc, cells, columnWidths, { font: 'Helvetica', fontSize: 10 });
    if (doc.y + rowHeight > limitY) {
      doc.addPage();
      const h = drawHeaderRow(doc, headers, startX, doc.y, columnWidths);
      doc.y += h;
    }
    const y = doc.y;
    drawBodyRow(doc, cells, startX, y, columnWidths, { zebra: index % 2 === 0 });
    doc.y = y + rowHeight;
  });

  doc.moveDown(0.6);
}

function ensureSummaryTotals(totals) {
  return {
    purchaseQty: totals.purchaseQty ?? 0,
    purchaseValue: totals.purchaseValue ?? 0,
    saleQty: totals.saleQty ?? 0,
    saleRevenue: totals.saleRevenue ?? 0,
    saleCost: totals.saleCost ?? 0,
    saleProfit: totals.saleProfit ?? 0
  };
}

function writePdfReport(rows, totals, dateRange, outputPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, info: { Title: `Rapport Abdoul ${LOOKBACK_DAYS} jours` } });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const generatedAt = new Date();

    doc.font('Helvetica-Bold').fontSize(20).text(`Téléphones Abdoul – ${LOOKBACK_DAYS} derniers jours`, { align: 'center' });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(12).text(`Période du ${formatDate(dateRange.start)} au ${formatDate(dateRange.end)}`, { align: 'center' });
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(10).text(`Rapport généré le ${formatDate(generatedAt)} à ${generatedAt.toLocaleTimeString('fr-FR')}`, { align: 'center' });
    doc.moveDown(1);

    const safeTotals = ensureSummaryTotals(totals);

    doc.font('Helvetica-Bold').fontSize(14).text('Résumé', { underline: false });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(11);
    doc.text(`Total achats: ${formatQuantity(safeTotals.purchaseQty)} unités pour ${formatCurrency(safeTotals.purchaseValue)}`);
    doc.text(`Total ventes: ${formatQuantity(safeTotals.saleQty)} unités pour ${formatCurrency(safeTotals.saleRevenue)}`);
    doc.text(`Coût des ventes: ${formatCurrency(safeTotals.saleCost)} · Profit estimé: ${formatCurrency(safeTotals.saleProfit)}`);
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(9).fillColor('#444444').text(
      "Les ventes sont attribuées à Abdoul lorsqu'elles mentionnent explicitement ce fournisseur ou lorsqu'elles correspondent aux modèles achetés auprès d'Abdoul sur la période.",
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
    );
    doc.fillColor('#000000');
    doc.moveDown(0.6);

    doc.font('Helvetica-Bold').fontSize(14).text('Détail par modèle');
    doc.moveDown(0.3);
    renderTable(doc, rows);

    doc.end();

    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

async function main() {
  const { start, end } = getDateRange();
  const startTimestamp = admin.firestore.Timestamp.fromDate(start);
  const endTimestamp = admin.firestore.Timestamp.fromDate(end);

  try {
    console.log(`Récupération des achats d'Abdoul entre ${start.toISOString()} et ${end.toISOString()}...`);
    const purchases = await fetchPurchases(startTimestamp, endTimestamp);
    console.log(`Achats trouvés: ${purchases.length}`);

    const { aggregated, totals, itemNames } = summarizePurchases(purchases);

    console.log(`Analyse des ventes associées entre ${start.toISOString()} et ${end.toISOString()}...`);
    const sales = await fetchSales(startTimestamp, endTimestamp);
    console.log(`Ventes récupérées: ${sales.length}`);

    summarizeSales(sales, aggregated, totals, itemNames);

    const rows = Array.from(aggregated.values())
      .filter(row => row.purchaseQty > 0 || row.saleQty > 0)
      .sort((a, b) => b.saleQty - a.saleQty || b.purchaseQty - a.purchaseQty || a.name.localeCompare(b.name));

    const filename = `rapport_${slugify(SUPPLIER_NAME)}_telephones_${formatDate(start).replace(/\//g, '')}_${formatDate(end).replace(/\//g, '')}.pdf`;
    const outputPath = path.join(__dirname, filename);

    console.log('Génération du PDF...');
    await writePdfReport(rows, totals, { start, end }, outputPath);
    console.log(`Rapport généré: ${outputPath}`);
    console.log(`Produits suivis: ${rows.length}`);
  } catch (error) {
    console.error('Erreur lors de la génération du rapport:', error);
    process.exitCode = 1;
  } finally {
    await admin.app().delete().catch(() => {});
  }
}

main();
