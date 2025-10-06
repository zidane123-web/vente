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

const APPRO_ID = 'MsAZjQ05dyPlLMF3nrcB';
const STOCK_ID = 'fRF4bA8Je6TWT9QSWHGK';
const HISTORY_ID = 'W6DHgFoAg5iuYbwBMbQ8';
const TARGET_PRODUCT = 'nokia 106';
const CORRECT_UNIT_COST = 3600;
const START_DATE = new Date('2025-10-01T00:00:00Z');
const END_DATE = new Date('2025-10-05T23:59:59Z');

function toFixedNumber(value, decimals = 2) {
  return Number(Number(value).toFixed(decimals));
}

async function fixApprovisionnement(transaction) {
  const approRef = db.collection('approvisionnement').doc(APPRO_ID);
  const approSnap = await transaction.get(approRef);
  if (!approSnap.exists) {
    throw new Error('Approvisionnement introuvable');
  }
  const approData = approSnap.data();
  const items = Array.isArray(approData.items) ? approData.items.map(item => ({ ...item })) : [];
  let totalCost = 0;
  let updated = false;
  for (const item of items) {
    if ((item.produit || '').toLowerCase() === TARGET_PRODUCT) {
      item.prixAchat = CORRECT_UNIT_COST;
      item.adjustedPrixAchat = CORRECT_UNIT_COST;
      item.coutTotal = (CORRECT_UNIT_COST * (item.quantite || 0)).toFixed(2);
      updated = true;
    }
    const unitCost = typeof item.prixAchat === 'number' ? item.prixAchat : parseFloat(item.prixAchat) || 0;
    const qty = item.quantite || item.qty || 0;
    totalCost += unitCost * qty;
  }
  if (!updated) {
    console.warn('Aucun item Nokia 106 trouvé dans l\'approvisionnement.');
  }
  transaction.update(approRef, {
    items,
    totalCost
  });
}

async function fixStockEntries() {
  const historyRef = db.collection('stock').doc(STOCK_ID).collection('history').doc(HISTORY_ID);
  await historyRef.update({ costOfChange: CORRECT_UNIT_COST * 50 });
  await db.collection('stock').doc(STOCK_ID).update({ price: CORRECT_UNIT_COST });
}

function normalizeNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return parseFloat(value) || 0;
  return 0;
}

async function fixSales() {
  const startTs = admin.firestore.Timestamp.fromDate(START_DATE);
  const endTs = admin.firestore.Timestamp.fromDate(END_DATE);
  const salesSnap = await db.collection('ventes')
    .where('timestamp', '>=', startTs)
    .where('timestamp', '<=', endTs)
    .get();

  let totalUpdated = 0;
  let totalAdjustedProfit = 0;
  const batches = [];
  let batch = db.batch();
  let batchCounter = 0;

  salesSnap.forEach(doc => {
    const data = doc.data();
    const items = Array.isArray(data.items) ? data.items.map(item => ({ ...item })) : [];
    let touched = false;

    items.forEach(item => {
      const name = (item.produit || '').toLowerCase();
      if (name === TARGET_PRODUCT) {
        const oldCost = normalizeNumber(item.coutAchat);
        const oldProfit = normalizeNumber(item.profitTotal);
        if (oldCost > 10000 || oldProfit < 0) {
          const qty = normalizeNumber(item.quantite || item.qty || 0);
          if (qty <= 0) {
            return;
          }
          const total = normalizeNumber(item.total);
          const totalRevenue = total > 0 ? total : normalizeNumber(item.prix) * qty;
          const unitPrice = totalRevenue / qty;
          const unitProfit = unitPrice - CORRECT_UNIT_COST;
          const profitTotal = unitProfit * qty;

          item.coutAchat = CORRECT_UNIT_COST;
          item.profitUnitaire = toFixedNumber(unitProfit, 2);
          item.profitTotal = toFixedNumber(profitTotal, 2);
          touched = true;
        }
      }
    });

    if (touched) {
      const newTotalProfit = items.reduce((sum, item) => sum + normalizeNumber(item.profitTotal), 0);
      const roundedTotalProfit = toFixedNumber(newTotalProfit, 2);
      totalAdjustedProfit += roundedTotalProfit - normalizeNumber(data.totalProfit);
      const payload = {
        items,
        totalProfit: roundedTotalProfit.toFixed(2)
      };
      batch.update(doc.ref, payload);
      totalUpdated += 1;
      batchCounter += 1;
      if (batchCounter === 400) {
        batches.push(batch);
        batch = db.batch();
        batchCounter = 0;
      }
    }
  });

  if (batchCounter > 0) {
    batches.push(batch);
  }

  for (const b of batches) {
    await b.commit();
  }

  return { totalUpdated, totalAdjustedProfit };
}

async function main() {
  await db.runTransaction(fixApprovisionnement);
  console.log('Approvisionnement corrigé.');

  await fixStockEntries();
  console.log('Stock et historique mis à jour.');

  const { totalUpdated, totalAdjustedProfit } = await fixSales();
  console.log(`Ventes corrigées: ${totalUpdated}`);
  console.log(`Ajout de profit total (approx): ${totalAdjustedProfit.toFixed(2)} FCFA`);

  await admin.app().delete();
}

main().catch(err => {
  console.error('Erreur lors de la correction:', err);
  admin.app().delete().catch(() => {});
  process.exit(1);
});
