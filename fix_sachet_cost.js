const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const SERVICE_ACCOUNT_CANDIDATES = [
  path.resolve(__dirname, 'serviceaccountkey.json'),
  path.resolve(__dirname, 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json')
];

function loadServiceAccount() {
  for (const candidate of SERVICE_ACCOUNT_CANDIDATES) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      return { credentials: require(candidate), path: candidate };
    } catch (error) {
      console.warn(`Impossible de charger ${candidate}: ${error.message}`);
    }
  }
  throw new Error('Aucun fichier service account disponible (ajoutez serviceaccountkey.json ou africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json).');
}

const { credentials, path: credentialPath } = loadServiceAccount();

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(credentials)
  });
}

const db = admin.firestore();

const START_DATE = new Date(process.env.SACHET_FIX_START ?? '2025-10-01T00:00:00Z');
const END_DATE = new Date(process.env.SACHET_FIX_END ?? Date.now());
const NEW_UNIT_COST = 1000;
const TARGET_KEYWORDS = ['sachet', 'sachet pour emballage'];
const BATCH_LIMIT = 400;

function setToStartOfDay(date) {
  date.setHours(0, 0, 0, 0);
}

function toNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/[^0-9.,-]/g, '').replace(/,/g, '.');
    if (!normalized) return 0;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value.toMillis === 'function') {
    return value.toMillis();
  }
  if (value && typeof value.toDate === 'function') {
    return value.toDate().getTime();
  }
  if (value && typeof value.seconds === 'number') {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return Number(value) || 0;
}

function getItemsArray(sale) {
  const candidates = [sale.items, sale.cartItems, sale.cart, sale.lines, sale.lignes, sale.products];
  for (const list of candidates) {
    if (Array.isArray(list)) {
      return list.map(item => ({ ...item }));
    }
  }
  return [];
}

function normalizeName(value) {
  return (value || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function isTargetItem(item) {
  const name = normalizeName(item.produit || item.name || item.designation || item.label || '');
  if (!name) return false;
  return TARGET_KEYWORDS.some(keyword => name.includes(keyword));
}

function getItemQuantity(item) {
  return toNumber(item.quantite ?? item.qty ?? item.quantity ?? item.qte ?? 0);
}

function computeItemRevenue(item, qty) {
  const explicit = toNumber(
    item.total ??
    item.totalPrice ??
    item.totalVente ??
    item.montant ??
    item.prixTotal ??
    item.lineTotal
  );
  if (explicit > 0) {
    return explicit;
  }
  const unitPrice = toNumber(item.prix ?? item.price ?? item.prixVente ?? item.sellingPrice ?? 0);
  return unitPrice * qty;
}

function formatNumber(value) {
  return Number(Number(value).toFixed(2));
}

async function main() {
  const startTs = admin.firestore.Timestamp.fromDate(START_DATE);
  const endTs = admin.firestore.Timestamp.fromDate(END_DATE);

  console.log('Correction des coûts de sachets avec', path.basename(credentialPath));
  console.log(`Fenêtre: ${START_DATE.toISOString()} -> ${END_DATE.toISOString()}`);

  const snapshot = await db.collection('ventes')
    .where('timestamp', '>=', startTs)
    .where('timestamp', '<=', endTs)
    .orderBy('timestamp', 'asc')
    .get();

  let processed = 0;
  let touchedDocs = 0;
  let adjustedItems = 0;
  let profitDelta = 0;

  let batch = db.batch();
  let batchSize = 0;
  const pendingCommits = [];

  const commitBatch = () => {
    if (batchSize === 0) {
      return;
    }
    pendingCommits.push(batch.commit());
    batch = db.batch();
    batchSize = 0;
  };

  snapshot.forEach(doc => {
    processed += 1;
    const sale = doc.data();
    const originalItems = getItemsArray(sale);
    if (!originalItems.length) {
      return;
    }

    let updated = false;
    let docProfitDelta = 0;

    const items = originalItems.map(item => {
      if (!isTargetItem(item)) {
        return item;
      }
      const qty = getItemQuantity(item);
      if (!qty || qty <= 0) {
        return item;
      }

      const lineRevenue = computeItemRevenue(item, qty);
      const previousUnitCost = toNumber(item.coutAchat);
      const newCost = NEW_UNIT_COST * qty;
      const newProfit = lineRevenue - newCost;
      const newUnitProfit = qty ? newProfit / qty : 0;
      const previousProfit = toNumber(item.profitTotal);
      const needsCostUpdate = Math.abs(previousUnitCost - NEW_UNIT_COST) > 0.01;
      const needsProfitUpdate = Math.abs(previousProfit - newProfit) > 0.01;

      if (!needsCostUpdate && !needsProfitUpdate) {
        return item;
      }

      const patched = { ...item };
      patched.coutAchat = NEW_UNIT_COST;
      patched.coutTotal = formatNumber(newCost);
      patched.profitUnitaire = formatNumber(newUnitProfit);
      patched.profitTotal = formatNumber(newProfit);

      docProfitDelta += formatNumber(newProfit) - formatNumber(previousProfit);
      adjustedItems += 1;
      updated = true;
      return patched;
    });

    if (!updated) {
      return;
    }

    const newTotalProfit = items.reduce((sum, item) => sum + toNumber(item.profitTotal), 0);
    const formattedTotalProfit = typeof sale.totalProfit === 'string'
      ? formatNumber(newTotalProfit).toFixed(2)
      : formatNumber(newTotalProfit);

    batch.update(doc.ref, {
      items,
      totalProfit: formattedTotalProfit
    });
    batchSize += 1;
    touchedDocs += 1;
    profitDelta += docProfitDelta;

    if (batchSize >= BATCH_LIMIT) {
      commitBatch();
    }
  });

  commitBatch();
  await Promise.all(pendingCommits);

  console.log('Documents analysés :', processed);
  console.log('Documents mis à jour :', touchedDocs);
  console.log('Lignes sachet corrigées :', adjustedItems);
  console.log('Variation totale de profit :', formatNumber(profitDelta), 'FCFA');

  admin.app().delete().catch(() => {});
  process.exit(0);
}

main().catch(async error => {
  console.error('Erreur lors de la correction des sachets:', error);
  try {
    await admin.app().delete();
  } catch (err) {}
  process.exit(1);
});
