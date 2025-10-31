const admin = require('firebase-admin');
const path = require('path');

const serviceAccountPath = path.join(__dirname, 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json');
const serviceAccount = require(serviceAccountPath);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

const CORRECT_UNIT_COST = 71000;
const TARGET_NAMES = [
  'tecno spark 40 256+8',
  'spark 40 256',
  'tecno spark 40 256',
  'spark 40 256+8'
];
const STOCK_DOC_ID = 'W0oEvvMDKQsfVSNyPRPD';
const HISTORY_FIXES = [
  { id: 'XkK2c6HTL1qj1NWv1rka', change: 5 },
  { id: 'YrrcynDkFzIBaI3vDJah', change: 2 }
];
const APPRO_DOC_ID = 'FT9uDyUGXIsFpISxoVVi';
const APPRO_TARGET_NAME = 'Tecno spark 40 256+8';
const START_DATE = new Date('2025-10-30T00:00:00Z');
const END_DATE = new Date('2025-10-31T23:59:59.999Z');

function normalizeNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value.replace(/,/g, '.'));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toFixedNumber(value, decimals = 2) {
  return Number(Number(value).toFixed(decimals));
}

function matchesProduct(rawName = '') {
  const name = rawName.toString().toLowerCase();
  return TARGET_NAMES.some(target => name.includes(target));
}

async function fixApprovisionnement(transaction) {
  const approRef = db.collection('approvisionnement').doc(APPRO_DOC_ID);
  const approSnap = await transaction.get(approRef);
  if (!approSnap.exists) {
    throw new Error('Approvisionnement cible introuvable');
  }

  const data = approSnap.data() || {};
  const items = Array.isArray(data.items) ? data.items.map(item => ({ ...item })) : [];
  let updated = false;
  let totalCost = 0;

  items.forEach(item => {
    const qty = normalizeNumber(item.quantite || item.qty || 0);
    if ((item.produit || '').toString() === APPRO_TARGET_NAME) {
      const newTotal = CORRECT_UNIT_COST * qty;
      item.prixAchat = CORRECT_UNIT_COST;
      item.adjustedPrixAchat = CORRECT_UNIT_COST;
      item.coutTotal = newTotal.toFixed(2);
      updated = true;
      totalCost += newTotal;
    } else {
      const unitCost = normalizeNumber(item.prixAchat);
      totalCost += unitCost * qty;
    }
  });

  if (!updated) {
    console.warn('Aucune ligne correspondante dans l\'approvisionnement.');
  }

  const payload = {
    items,
    totalCost,
    receivedTotalCost: normalizeNumber(data.receivedTotalCost || totalCost) ? totalCost : totalCost,
    paymentsTotalPaid: normalizeNumber(data.paymentsTotalPaid || totalCost) ? totalCost : totalCost
  };

  transaction.update(approRef, payload);
}

async function fixStockAndHistory() {
  const stockRef = db.collection('stock').doc(STOCK_DOC_ID);
  await stockRef.set({ price: CORRECT_UNIT_COST }, { merge: true });

  const historyRef = stockRef.collection('history');
  const updates = HISTORY_FIXES.map(async ({ id, change }) => {
    const cost = CORRECT_UNIT_COST * change;
    await historyRef.doc(id).set({ costOfChange: cost }, { merge: true });
  });
  await Promise.all(updates);
}

async function fixSales() {
  const startTs = admin.firestore.Timestamp.fromDate(START_DATE);
  const endTs = admin.firestore.Timestamp.fromDate(END_DATE);

  const salesSnap = await db.collection('ventes')
    .where('timestamp', '>=', startTs)
    .where('timestamp', '<=', endTs)
    .get();

  let touchedDocuments = 0;
  let totalProfitDelta = 0;
  const batches = [];
  let batch = db.batch();
  let batchCount = 0;

  salesSnap.forEach(doc => {
    const data = doc.data() || {};
    const items = Array.isArray(data.items) ? data.items.map(item => ({ ...item })) : [];
    let updated = false;

    items.forEach(item => {
      if (!matchesProduct(item.produit || item.name || item.modele || '')) {
        return;
      }
      const qty = normalizeNumber(item.quantite || item.qty || 0);
      if (qty <= 0) {
        return;
      }
      const total = normalizeNumber(item.total);
      const totalRevenue = total > 0 ? total : normalizeNumber(item.prix) * qty;
      if (totalRevenue <= 0) {
        return;
      }
      const unitPrice = totalRevenue / qty;
      const unitProfit = unitPrice - CORRECT_UNIT_COST;
      const profitTotal = unitProfit * qty;

      item.coutAchat = CORRECT_UNIT_COST;
      item.profitUnitaire = toFixedNumber(unitProfit, 2);
      item.profitTotal = toFixedNumber(profitTotal, 2);
      updated = true;
    });

    if (!updated) {
      return;
    }

    const newTotalProfit = items.reduce((sum, item) => sum + normalizeNumber(item.profitTotal), 0);
    const roundedProfit = toFixedNumber(newTotalProfit, 2);
    totalProfitDelta += roundedProfit - normalizeNumber(data.totalProfit);

    batch.update(doc.ref, {
      items,
      totalProfit: roundedProfit.toFixed(2)
    });
    batchCount += 1;
    touchedDocuments += 1;

    if (batchCount >= 400) {
      batches.push(batch);
      batch = db.batch();
      batchCount = 0;
    }
  });

  if (batchCount > 0) {
    batches.push(batch);
  }

  for (const b of batches) {
    await b.commit();
  }

  return { touchedDocuments, totalProfitDelta };
}

async function main() {
  await db.runTransaction(fixApprovisionnement);
  console.log('Approvisionnement mis à jour.');

  await fixStockAndHistory();
  console.log('Stock et historique mis à jour.');

  const { touchedDocuments, totalProfitDelta } = await fixSales();
  console.log(`Ventes ajustées: ${touchedDocuments}`);
  console.log(`Variation totale de profit: ${totalProfitDelta.toFixed(2)} FCFA`);

  await admin.app().delete();
}

main().catch(err => {
  console.error('Erreur pendant la correction Spark 40:', err);
  admin.app().delete().catch(() => {});
  process.exit(1);
});
