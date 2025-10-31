const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const admin = require('firebase-admin');

const SERVICE_ACCOUNT_PATH = path.join(
  __dirname,
  'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json'
);

let serviceAccount;
try {
  serviceAccount = require(SERVICE_ACCOUNT_PATH);
} catch (error) {
  console.error('Impossible de charger le service account Firebase :', error.message);
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

const MONTH_ARG = process.argv[2] || new Date().toISOString().slice(0, 7);
if (!/^\d{4}-\d{2}$/.test(MONTH_ARG)) {
  console.error('Format attendu : AAAA-MM (ex. 2025-10).');
  process.exit(1);
}

const [YEAR, MONTH] = MONTH_ARG.split('-').map(Number);
const monthStart = new Date(YEAR, MONTH - 1, 1, 0, 0, 0, 0);
const monthEnd = new Date(YEAR, MONTH, 0, 23, 59, 59, 999);

const startTimestamp = admin.firestore.Timestamp.fromDate(monthStart);
const endTimestamp = admin.firestore.Timestamp.fromDate(monthEnd);
const startMillis = monthStart.getTime();
const endMillis = monthEnd.getTime();

function formatCurrency(value) {
  const amount = Number(value) || 0;
  return `${amount.toLocaleString('fr-FR')} FCFA`;
}

function formatNumber(value) {
  const amount = Number(value) || 0;
  return amount.toLocaleString('fr-FR');
}

function normalizeNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const normalized = trimmed.replace(/[^0-9.,-]/g, '').replace(/,/g, '.');
    const parsed = parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function computeItemRevenue(item, defaultUnitPrice = 0) {
  const qty = normalizeNumber(item.quantite || item.qty || 0);
  if (qty <= 0) return 0;
  const explicitTotal = normalizeNumber(item.total);
  if (explicitTotal > 0) {
    return explicitTotal;
  }
  const price = normalizeNumber(item.prix || defaultUnitPrice);
  return price * qty;
}

function ensurePageBreak(doc, extraHeight = 0) {
  if (doc.y + extraHeight >= doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
}

async function fetchSales() {
  const snapshot = await db
    .collection('ventes')
    .where('timestamp', '>=', startTimestamp)
    .where('timestamp', '<=', endTimestamp)
    .get();

  const sales = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    sales.push({ id: doc.id, ...data });
  });
  return sales;
}

async function fetchDepenses() {
  const snapshot = await db
    .collection('depenses')
    .where('timestamp', '>=', startMillis)
    .where('timestamp', '<=', endMillis)
    .get();

  const depenses = [];
  snapshot.forEach(doc => {
    depenses.push(doc.data());
  });
  return depenses;
}

function analyseSales(sales) {
  let totalRevenue = 0;
  let totalProfit = 0;
  let ventesCount = 0;
  let produitsVendus = 0;

  const revenueByProduct = new Map();
  const profitByProduct = new Map();
  const quantityByProduct = new Map();

  sales.forEach(sale => {
    const status = (sale.status || '').toString().toLowerCase();
    if (status.startsWith('annul')) {
      return;
    }

    const saleRevenue = normalizeNumber(sale.overallTotal);
    const saleProfit = normalizeNumber(sale.totalProfit);

    totalRevenue += saleRevenue;
    totalProfit += saleProfit;
    ventesCount += 1;

    (sale.items || []).forEach(item => {
      const name = (item.produit || item.name || item.modele || 'Article').toString();
      const qty = normalizeNumber(item.quantite || item.qty || 0);
      const profit = normalizeNumber(item.profitTotal);
      const revenue = computeItemRevenue(item, normalizeNumber(item.prix));

      if (qty <= 0) {
        return;
      }

      produitsVendus += qty;

      quantityByProduct.set(name, (quantityByProduct.get(name) || 0) + qty);
      revenueByProduct.set(name, (revenueByProduct.get(name) || 0) + revenue);
      profitByProduct.set(name, (profitByProduct.get(name) || 0) + profit);
    });
  });

  const topProducts = Array.from(quantityByProduct.entries())
    .map(([name, qty]) => ({
      name,
      qty,
      revenue: revenueByProduct.get(name) || 0,
      profit: profitByProduct.get(name) || 0
    }))
    .sort((a, b) => b.qty - a.qty);

  return {
    totalRevenue,
    totalProfit,
    ventesCount,
    produitsVendus,
    topProducts
  };
}

function analyseDepenses(depenses) {
  let fonctionnelles = 0;
  let papa = 0;

  depenses.forEach(depense => {
    const type = (depense.type || '').toString().toLowerCase();
    const montant = normalizeNumber(depense.montant);

    if (!montant) return;

    if (type.includes('fonction')) {
      fonctionnelles += montant;
    } else if (type.includes('papa')) {
      papa += montant;
    }
  });

  return { fonctionnelles, papa };
}

function drawSummary(doc, summary) {
  doc.fontSize(14).fillColor('#111111').text('Résumé exécutif', { align: 'left' });
  doc.moveDown(0.5);
  doc.fontSize(11).fillColor('#000000');

  const rows = [
    ['Mois', MONTH_ARG],
    ['Total des ventes', formatCurrency(summary.totalRevenue)],
    ['Profit total', formatCurrency(summary.totalProfit)],
    ['Nombre de ventes', formatNumber(summary.ventesCount)],
    ['Produits vendus', formatNumber(summary.produitsVendus)],
    ['Dépenses fonctionnelles', formatCurrency(summary.depenses.fonctionnelles)],
    ['Dépenses Papa', formatCurrency(summary.depenses.papa)],
    ['Profit net', formatCurrency(summary.totalProfit - summary.depenses.fonctionnelles - summary.depenses.papa)]
  ];

  const labelX = doc.x;
  const valueX = doc.page.width / 2;
  rows.forEach(([label, value]) => {
    ensurePageBreak(doc, 20);
    doc.font('Helvetica-Bold').text(label, labelX, doc.y, { continued: true });
    doc.font('Helvetica').text(` : ${value}`, valueX - labelX - 10);
  });
  doc.moveDown();
}

function drawTopProducts(doc, products) {
  if (!products.length) {
    doc.fontSize(12).text('Aucune vente sur la période.', { align: 'left' });
    doc.moveDown();
    return;
  }

  doc.addPage();
  doc.fontSize(14).text('Articles les plus vendus', { align: 'left' });
  doc.moveDown(0.5);

  const headers = ['Article', 'Qté', 'Chiffre d\'affaires', 'Profit'];
  const columnPositions = [doc.x, doc.x + 220, doc.x + 320, doc.x + 450];

  doc.font('Helvetica-Bold').fontSize(11);
  headers.forEach((header, index) => {
    doc.text(header, columnPositions[index], doc.y, {
      width: index === 0 ? 200 : 110,
      align: index === 0 ? 'left' : 'right'
    });
  });
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(10);

  const maxRows = 25;
  products.slice(0, maxRows).forEach(product => {
    ensurePageBreak(doc, 20);
    const rowY = doc.y;
    doc.text(product.name, columnPositions[0], rowY, { width: 200, align: 'left' });
    doc.text(formatNumber(product.qty), columnPositions[1], rowY, { width: 80, align: 'right' });
    doc.text(formatCurrency(product.revenue), columnPositions[2], rowY, { width: 110, align: 'right' });
    doc.text(formatCurrency(product.profit), columnPositions[3], rowY, { width: 110, align: 'right' });
    doc.moveDown(0.4);
  });
  doc.moveDown();
}

async function main() {
  try {
    console.log(`Génération du rapport mensuel pour ${MONTH_ARG} ...`);

    const [sales, depenses] = await Promise.all([fetchSales(), fetchDepenses()]);
    const salesStats = analyseSales(sales);
    const depensesStats = analyseDepenses(depenses);

    const outputName = `Rapport_Mensuel_${MONTH_ARG.replace(/-/g, '_')}.pdf`;
    const outputPath = path.join(__dirname, outputName);
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    doc.font('Helvetica-Bold').fontSize(20).text(`Rapport mensuel - ${MONTH_ARG}`, {
      align: 'center'
    });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(10).text(`Généré le ${new Date().toLocaleString('fr-FR')}`, {
      align: 'center'
    });
    doc.moveDown();

    drawSummary(doc, {
      totalRevenue: salesStats.totalRevenue,
      totalProfit: salesStats.totalProfit,
      ventesCount: salesStats.ventesCount,
      produitsVendus: salesStats.produitsVendus,
      depenses: depensesStats
    });

    drawTopProducts(doc, salesStats.topProducts);

    doc.end();

    await new Promise((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
    });

    console.log(`Rapport généré : ${outputPath}`);
  } catch (error) {
    console.error('Erreur lors de la génération du rapport mensuel :', error);
    process.exitCode = 1;
  } finally {
    await admin.app().delete().catch(() => {});
  }
}

main();
