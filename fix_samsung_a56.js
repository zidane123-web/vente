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

function normalizeString(value) {
  return (value || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

const APPRO_ID = 'wqPkdv8gs1hQHldYGkY9';
const VENTE_ID = 'cULnw5gYYxc2bmeBizbo';
const CORRECT_UNIT_COST = 190300;

function formatCurrency(value) {
  return Number(value || 0).toFixed(2);
}

async function findSamsungA56Records() {
  const results = {
    approvisionnements: [],
    ventes: []
  };

  const approSnap = await db.collection('approvisionnement')
    .orderBy('timestamp', 'desc')
    .limit(50)
    .get();

  approSnap.forEach(doc => {
    const data = doc.data();
    const items = Array.isArray(data.items) ? data.items : [];
    const match = items.find(item => normalizeString(item.produit).includes('samsung a56'));
    if (match) {
      results.approvisionnements.push({
        id: doc.id,
        timestamp: data.timestamp,
        fournisseur: data.fournisseur,
        status: data.status,
        totalCost: data.totalCost,
        receivedTotalCost: data.receivedTotalCost,
        item: match
      });
    }
  });

  const now = admin.firestore.Timestamp.now();
  const twentyFourHoursAgo = admin.firestore.Timestamp.fromMillis(now.toMillis() - 24 * 60 * 60 * 1000);

  const ventesSnap = await db.collection('ventes')
    .where('timestamp', '>=', twentyFourHoursAgo)
    .orderBy('timestamp', 'desc')
    .limit(50)
    .get();

  ventesSnap.forEach(doc => {
    const data = doc.data();
    const items = Array.isArray(data.items) ? data.items : [];
    const match = items.find(item => normalizeString(item.produit).includes('samsung a56'));
    if (match) {
      results.ventes.push({
        id: doc.id,
        timestamp: data.timestamp,
        overallTotal: data.overallTotal,
        totalProfit: data.totalProfit,
        item: match
      });
    }
  });

  return results;
}

function normalizeNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return parseFloat(value) || 0;
  return 0;
}

async function inspectDetailedRecords() {
  const approRef = db.collection('approvisionnement').doc(APPRO_ID);
  const venteRef = db.collection('ventes').doc(VENTE_ID);

  const [approSnap, venteSnap] = await Promise.all([approRef.get(), venteRef.get()]);
  if (!approSnap.exists) {
    throw new Error(`Approvisionnement ${APPRO_ID} introuvable.`);
  }
  if (!venteSnap.exists) {
    throw new Error(`Vente ${VENTE_ID} introuvable.`);
  }

  return {
    approvisionnement: { id: approSnap.id, data: approSnap.data() },
    vente: { id: venteSnap.id, data: venteSnap.data() }
  };
}

async function fixApprovisionnement(transaction) {
  const approRef = db.collection('approvisionnement').doc(APPRO_ID);
  const approSnap = await transaction.get(approRef);
  if (!approSnap.exists) {
    throw new Error(`Approvisionnement ${APPRO_ID} introuvable.`);
  }

  const approData = approSnap.data();
  const items = Array.isArray(approData.items) ? approData.items.map(item => ({ ...item })) : [];
  const targetIndex = items.findIndex(item => normalizeString(item.produit).includes('samsung a56'));
  if (targetIndex === -1) {
    throw new Error('Item Samsung A56 introuvable dans l\'approvisionnement.');
  }

  const item = items[targetIndex];
  const qty = normalizeNumber(item.quantite || item.qty || 0) || 1;
  const totalCost = CORRECT_UNIT_COST * qty;

  items[targetIndex] = {
    ...item,
    prixAchat: CORRECT_UNIT_COST,
    adjustedPrixAchat: CORRECT_UNIT_COST,
    coutTotal: formatCurrency(totalCost)
  };

  const updates = {
    items,
    totalCost,
    receivedTotalCost: totalCost,
    netSupplierBalance: (normalizeNumber(approData.paymentsTotalPaid) || 0) - totalCost,
    remainingAmount: Math.max(0, totalCost - normalizeNumber(approData.paymentsTotalPaid))
  };

  if (typeof approData.orderTotalCost !== 'undefined') {
    updates.orderTotalCost = totalCost;
  }

  if (approData.receptionStats && typeof approData.receptionStats === 'object') {
    const stats = { ...approData.receptionStats };
    if (typeof stats.totalRecupere !== 'undefined') {
      stats.totalRecupere = totalCost;
    }
    if (typeof stats.totalCommande !== 'undefined') {
      stats.totalCommande = totalCost;
    }
    updates.receptionStats = stats;
  }

  transaction.update(approRef, updates);

  return {
    before: {
      totalCost: approData.totalCost,
      receivedTotalCost: approData.receivedTotalCost,
      netSupplierBalance: approData.netSupplierBalance,
      item
    },
    after: {
      totalCost,
      receivedTotalCost: totalCost,
      netSupplierBalance: updates.netSupplierBalance,
      item: items[targetIndex]
    }
  };
}

async function fixVente() {
  const venteRef = db.collection('ventes').doc(VENTE_ID);
  const venteSnap = await venteRef.get();
  if (!venteSnap.exists) {
    throw new Error(`Vente ${VENTE_ID} introuvable.`);
  }

  const venteData = venteSnap.data();
  const items = Array.isArray(venteData.items) ? venteData.items.map(item => ({ ...item })) : [];
  const targetIndex = items.findIndex(item => normalizeString(item.produit).includes('samsung a56'));
  if (targetIndex === -1) {
    throw new Error('Item Samsung A56 introuvable dans la vente.');
  }

  const item = items[targetIndex];
  const qty = normalizeNumber(item.quantite || item.qty || 0) || 1;
  const totalVente = normalizeNumber(item.total || item.prix) || 0;
  const unitPrice = qty > 0 ? totalVente / qty : 0;
  const unitProfit = unitPrice - CORRECT_UNIT_COST;
  const totalProfit = unitProfit * qty;

  items[targetIndex] = {
    ...item,
    coutAchat: CORRECT_UNIT_COST,
    profitUnitaire: Number(unitProfit.toFixed(2)),
    profitTotal: Number(totalProfit.toFixed(2))
  };

  const recalculatedTotalProfit = items.reduce((sum, current) => {
    return sum + normalizeNumber(current.profitTotal);
  }, 0);

  const payload = {
    items,
    totalProfit: formatCurrency(recalculatedTotalProfit)
  };

  await venteRef.update(payload);

  return {
    before: {
      totalProfit: venteData.totalProfit,
      item
    },
    after: {
      totalProfit: payload.totalProfit,
      item: items[targetIndex]
    }
  };
}

async function main() {
  try {
    const mode = process.argv.includes('--inspect')
      ? 'inspect'
      : process.argv.includes('--details')
        ? 'details'
        : process.argv.includes('--apply')
          ? 'apply'
          : 'inspect';

    if (mode === 'inspect') {
      const records = await findSamsungA56Records();
      console.log(JSON.stringify(records, null, 2));
      return;
    }

    if (mode === 'details') {
      const snapshot = await inspectDetailedRecords();
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }

    if (mode === 'apply') {
      const approResult = await db.runTransaction(async transaction => {
        return fixApprovisionnement(transaction);
      });
      console.log('Approvisionnement mis a jour:', JSON.stringify(approResult, null, 2));

      const venteResult = await fixVente();
      console.log('Vente mise a jour:', JSON.stringify(venteResult, null, 2));
      return;
    }
  } catch (error) {
    console.error('Erreur lors de la recherche des enregistrements Samsung A56:', error);
    process.exitCode = 1;
  } finally {
    await admin.app().delete().catch(() => {});
  }
}

main();
