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

const TARGET_DATE = '2025-10-29';
const ACCOUNT_ID = 'momo';
const RECONSTITUTED_OPENING = 559205;
const EXPECTED_CHECKPOINT = {
  saleId: 'AqJX9voRoVHyvSBjl07C',
  balance: 773205
};

function extractTimestamp(value) {
  if (typeof value === 'number') {
    return value;
  }
  if (value && typeof value.toMillis === 'function') {
    return value.toMillis();
  }
  return 0;
}

function computeDelta(entry) {
  const amount = Number(entry.montant) || 0;
  if (entry.sens === 'out') {
    return -amount;
  }
  return amount;
}

async function main() {
  const compteRef = db.collection('tresorerie').doc('balance').collection('comptesTresorerie').doc(ACCOUNT_ID);
  const mouvementsCol = compteRef.collection('mouvements');

  const mouvementsSnap = await mouvementsCol.where('dateString', '==', TARGET_DATE).get();
  if (mouvementsSnap.empty) {
    throw new Error(`Aucun mouvement trouvé pour ${TARGET_DATE}`);
  }

  const mouvements = mouvementsSnap.docs
    .map(doc => ({ id: doc.id, data: doc.data(), ref: doc.ref }))
    .sort((a, b) => extractTimestamp(a.data.timestamp) - extractTimestamp(b.data.timestamp));

  let runningBalance = RECONSTITUTED_OPENING;
  const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();
  const batch = db.batch();

  mouvements.forEach(entry => {
    runningBalance += computeDelta(entry.data);
    const updatePayload = {
      newBalance: runningBalance,
      openingBalance: RECONSTITUTED_OPENING,
      correctedAt: serverTimestamp,
      correctionSource: 'recompute_momo_balances_2025_10_29.js'
    };
    batch.update(entry.ref, updatePayload);

    if (entry.id === EXPECTED_CHECKPOINT.saleId && runningBalance !== EXPECTED_CHECKPOINT.balance) {
      throw new Error(`Checkpoint invalide pour ${entry.id}: attendu ${EXPECTED_CHECKPOINT.balance}, obtenu ${runningBalance}`);
    }
  });

  const closingBalance = runningBalance;

  batch.update(compteRef, {
    solde: closingBalance,
    lastManualOverride: serverTimestamp,
    updatedAt: serverTimestamp,
    lastCorrectedBy: 'recompute_momo_balances_2025_10_29.js',
    lastCorrectedAt: serverTimestamp
  });

  const snapshotRef = db.collection('tresorerieSnapshots').doc(TARGET_DATE);
  const snapshotDoc = await snapshotRef.get();
  const snapshotData = snapshotDoc.exists ? snapshotDoc.data() || {} : {};

  const openingByAccount = snapshotData.openingByAccount && typeof snapshotData.openingByAccount === 'object'
    ? { ...snapshotData.openingByAccount, momo: RECONSTITUTED_OPENING }
    : { momo: RECONSTITUTED_OPENING };

  const closingByAccount = snapshotData.closingByAccount && typeof snapshotData.closingByAccount === 'object'
    ? { ...snapshotData.closingByAccount, momo: closingBalance }
    : { momo: closingBalance };

  const openingCaisse = Number(snapshotData.openingCaisse) || 0;
  const openingBanque = Number(snapshotData.openingBanque) || 0;
  const openingBalanceGlobal = openingCaisse + openingBanque + RECONSTITUTED_OPENING;
  const closingBalanceGlobal = openingCaisse + openingBanque + closingBalance;

  batch.set(snapshotRef, {
    openingMomo: RECONSTITUTED_OPENING,
    openingBalanceGlobal,
    openingByAccount,
    closingMomo: closingBalance,
    closingBalanceGlobal,
    closingByAccount,
    closingCorrectedAt: serverTimestamp,
    openingCorrectedAt: serverTimestamp
  }, { merge: true });

  await batch.commit();

  console.log(`Recalcul terminé. Solde initial reconstruit: ${RECONSTITUTED_OPENING}. Solde final: ${closingBalance}.`);
  await admin.app().delete();
}

main().catch(error => {
  console.error('Erreur lors du recalcul des soldes MoMo:', error);
  admin.app().delete().catch(() => {});
  process.exit(1);
});
