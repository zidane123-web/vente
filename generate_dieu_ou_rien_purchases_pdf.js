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
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'XOF',
    maximumFractionDigits: 0
  }).format(Math.round(amount));
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
  return date.toLocaleString('fr-FR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
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
  const normalized = typeof raw === 'string' ? raw.replace(/[^0-9.,-]/g, '').replace(/,/g, '.') : raw;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
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
  const normalized = typeof raw === 'string' ? raw.replace(/[^0-9.,-]/g, '').replace(/,/g, '.') : raw;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
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

function writePdfReport(purchases, start, end, outputPath) {
  const doc = new PDFDocument({ margin: 48 });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  const reportDateLabel = formatDateForTitle(start);
  const headerTitle = `Achats du ${reportDateLabel} - ${SUPPLIER_NAME}`;

  doc.fontSize(20).text(headerTitle, { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(11).fillColor('#444444');
  doc.text(`Plage horaire: ${formatDateForDisplay(start)} -> ${formatDateForDisplay(end)}`, { align: 'center' });
  doc.moveDown(0.75);

  if (purchases.length === 0) {
    doc.fontSize(14).fillColor('#000000');
    doc.text("Aucun achat enregistre pour ce fournisseur aujourd'hui.", { align: 'center' });
    doc.end();
    return new Promise((resolve, reject) => {
      stream.on('finish', () => resolve(outputPath));
      stream.on('error', reject);
    });
  }

  const totalAmount = purchases.reduce((acc, purchase) => acc + purchase.totalCost, 0);
  doc.fontSize(12).fillColor('#000000');
  doc.text(`Approvisionnements trouves: ${purchases.length}`);
  doc.text(`Montant total estime: ${formatCurrency(totalAmount)}`);
  doc.moveDown();

  purchases.forEach((purchase, index) => {
    if (index > 0) {
      doc.addPage();
    }
    doc.fontSize(16).fillColor('#000000').text(`Approvisionnement ${purchase.id}`, { underline: true });
    doc.moveDown(0.5);
    const timestamp = purchase.timestampMs ? new Date(purchase.timestampMs) : null;
    doc.fontSize(12);
    doc.text(`Heure: ${timestamp ? formatDateForDisplay(timestamp) : 'N/A'}`);
    doc.text(`Type: ${purchase.type}`);
    doc.text(`Montant estime: ${formatCurrency(purchase.totalCost)}`);
    if (purchase.note) {
      doc.moveDown(0.35);
      doc.fontSize(11).fillColor('#444444').text(`Note: ${purchase.note}`);
      doc.fillColor('#000000');
    }
    doc.moveDown(0.5);
    doc.fontSize(13).text('Articles', { underline: true });
    doc.moveDown(0.25);

    if (purchase.items.length === 0) {
      doc.fontSize(11).fillColor('#444444');
      doc.text('Aucun detail produit disponible.');
      doc.fillColor('#000000');
    } else {
      purchase.items.forEach(item => {
        doc.fontSize(11).fillColor('#000000');
        doc.text(`- ${item.name}`);
        doc.fontSize(10).fillColor('#444444');
        doc.text(`  Qte: ${item.qty} | Cout unitaire: ${formatCurrency(item.unitCost)} | Cout total: ${formatCurrency(item.lineCost)}`);
        doc.fillColor('#000000');
        doc.moveDown(0.2);
      });
    }
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
