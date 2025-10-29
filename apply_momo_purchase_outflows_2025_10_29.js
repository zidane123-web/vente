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
const OPENING_BALANCE = 704205;

const NEW_PAYMENTS = [
  { amount: 195000, description: 'Paiement achats' },
  { amount: 355550, description: 'Paiement achats' },
  { amount: 168500, description: 'Paiement achats' }
];

function toMillis(value) {
  if (typeof value === 'number') {
    return value;
  }
  if (value && typeof value.toMillis === 'function') {
    return value.toMillis();
  }
  return 0;
}

async function main() {
  const compteRef = db.collection('tresorerie').doc('balance').collection('comptesTresorerie').doc(ACCOUNT_ID);
  const mouvementsCol = compteRef.collection('mouvements');

  const snap = await mouvementsCol.where('dateString', '==', TARGET_DATE).get();
  const entries = snap.docs.map(doc => ({
    ref: doc.ref,
    data: doc.data(),
    timestamp: toMillis(doc.data().timestamp),
    isNew: false
  }));

  let maxTimestamp = entries.reduce((max, entry) => Math.max(max, entry.timestamp), 0);
  if (!Number.isFinite(maxTimestamp) || maxTimestamp <= 0) {
    const parsedDate = new Date(`${TARGET_DATE}T00:00:00`);
    maxTimestamp = parsedDate.getTime();
  }

  NEW_PAYMENTS.forEach((payment, index) => {
    const timestamp = maxTimestamp + (index + 1) * 1000;
    const ref = mouvementsCol.doc();
    entries.push({
      ref,
      isNew: true,
      timestamp,
      data: {
        timestamp,
        dateString: TARGET_DATE,
        type: 'paiement_achat',
        sens: 'out',
        montant: payment.amount,
        description: payment.description
      }
    });
  });

  entries.sort((a, b) => a.timestamp - b.timestamp);

  const batch = db.batch();
  const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();
  let runningBalance = OPENING_BALANCE;

  entries.forEach(entry => {
    const { ref, data, isNew } = entry;
    const amount = Number(data.montant) || 0;
    const sens = data.sens === 'out' ? 'out' : 'in';
    const delta = sens === 'out' ? -amount : amount;
    runningBalance += delta;

    const payload = {
      newBalance: runningBalance,
      openingBalance: OPENING_BALANCE,
      correctedAt: serverTimestamp,
      correctionSource: 'apply_momo_purchase_outflows_2025_10_29.js'
    };

    if (isNew) {
      batch.set(ref, {
        ...data,
        newBalance: runningBalance,
        openingBalance: OPENING_BALANCE,
        createdAt: serverTimestamp,
        correctedAt: serverTimestamp,
        correctionSource: 'apply_momo_purchase_outflows_2025_10_29.js'
      });
    } else {
      batch.update(ref, payload);
    }
  });

  const snapshotRef = db.collection('tresorerieSnapshots').doc(TARGET_DATE);
  const snapshotDoc = await snapshotRef.get();
  const snapshotData = snapshotDoc.exists ? snapshotDoc.data() || {} : {};

  const openingMomo = Number(snapshotData.openingMomo) || 0;
  const openingBalanceGlobal = Number(snapshotData.openingBalanceGlobal) || 0;
  const otherOpening = openingBalanceGlobal - openingMomo;

  const snapshotUpdate = {
    closingMomo: runningBalance,
    closingCorrectedAt: serverTimestamp
  };

  if (Number.isFinite(otherOpening)) {
    snapshotUpdate.closingBalanceGlobal = otherOpening + runningBalance;
  }

  if (snapshotData.openingByAccount && typeof snapshotData.openingByAccount === 'object') {
    snapshotUpdate.closingByAccount = {
      ...snapshotData.openingByAccount,
      momo: runningBalance
    };
  }

  batch.set(snapshotRef, snapshotUpdate, { merge: true });
  batch.update(compteRef, {
    solde: runningBalance,
    lastManualOverride: serverTimestamp,
    updatedAt: serverTimestamp,
    lastCorrectedBy: 'apply_momo_purchase_outflows_2025_10_29.js',
    lastCorrectedAt: serverTimestamp
  });

  await batch.commit();

  console.log(`Trois paiements ajoutes, solde final MoMo: ${runningBalance}`);
  await admin.app().delete();
}

main().catch(error => {
  console.error('Erreur lors de l\'ajout des paiements achats:', error);
  admin.app().delete().catch(() => {});
  process.exit(1);
});
