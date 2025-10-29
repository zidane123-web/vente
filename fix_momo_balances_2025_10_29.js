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

const MOVEMENTS = [
  { id: 'pGz0HgNdlJWmAkRrNjsV', sens: 'in', montant: 68500 },
  { id: '2mTYFVTbGX2SD7foN2cE', sens: 'out', montant: 10500 },
  { id: '7W5lGUdUTSOK84wHxj2t', sens: 'in', montant: 87000 },
  { id: 'AqJX9voRoVHyvSBjl07C', sens: 'in', montant: 69000 },
  { id: '1YwFjKu3aMKRa10951Wb', sens: 'in', montant: 38500 },
  { id: 'ZMiloSfDNpoTOxM1yYEp', sens: 'in', montant: 134000 },
  { id: 'Rzm7tsk3MmNBxSnXvRsA', sens: 'in', montant: 45000 },
  { id: 'AZjdOd3FwspvrTHtZyCL', sens: 'out', montant: 9500 },
  { id: 'hv8RhqpPspjQYOSuoTRm', sens: 'in', montant: 2800 },
  { id: 'hmzuSD5nRPolxjtZ5xUz', sens: 'in', montant: 67500 }
];

async function main() {
  const compteRef = db
    .collection('tresorerie')
    .doc('balance')
    .collection('comptesTresorerie')
    .doc(ACCOUNT_ID);

  const mouvementsCollection = compteRef.collection('mouvements');
  const batch = db.batch();

  let runningBalance = OPENING_BALANCE;

  for (const mouvement of MOVEMENTS) {
    if (!['in', 'out'].includes(mouvement.sens)) {
      throw new Error(`Sens invalide pour ${mouvement.id}: ${mouvement.sens}`);
    }
    const ref = mouvementsCollection.doc(mouvement.id);
    const delta = mouvement.sens === 'in' ? mouvement.montant : -mouvement.montant;
    runningBalance += delta;
    batch.update(ref, {
      newBalance: runningBalance,
      openingBalance: OPENING_BALANCE,
      correctedAt: admin.firestore.FieldValue.serverTimestamp(),
      correctionSource: 'fix_momo_balances_2025_10_29.js'
    });
  }

  const snapshotRef = db.collection('tresorerieSnapshots').doc(TARGET_DATE);
  const snapshotDoc = await snapshotRef.get();
  const snapshotData = snapshotDoc.exists ? snapshotDoc.data() || {} : {};

  const timestamp = admin.firestore.FieldValue.serverTimestamp();

  batch.update(compteRef, {
    solde: runningBalance,
    lastManualOverride: timestamp,
    updatedAt: timestamp,
    lastCorrectedBy: 'fix_momo_balances_2025_10_29.js',
    lastCorrectedAt: timestamp
  });

  const openingMomo = Number(snapshotData.openingMomo) || 0;
  const openingBalanceGlobal = Number(snapshotData.openingBalanceGlobal) || 0;
  const otherOpening = openingBalanceGlobal - openingMomo;

  const closingPayload = {
    closingMomo: runningBalance,
    closingCorrectedAt: timestamp
  };

  if (Number.isFinite(otherOpening)) {
    closingPayload.closingBalanceGlobal = otherOpening + runningBalance;
  }

  if (snapshotData.openingByAccount && typeof snapshotData.openingByAccount === 'object') {
    closingPayload.closingByAccount = {
      ...snapshotData.openingByAccount,
      momo: runningBalance
    };
  }

  batch.set(snapshotRef, closingPayload, { merge: true });

  await batch.commit();
  console.log(`Correctif applique. Nouveau solde ${ACCOUNT_ID}: ${runningBalance}`);
  await admin.app().delete();
}

main().catch(error => {
  console.error('Erreur lors du correctif:', error);
  admin.app().delete().catch(() => {});
  process.exit(1);
});
