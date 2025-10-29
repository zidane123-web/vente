const path = require('path');
const admin = require('firebase-admin');

const serviceAccountPath = path.join(__dirname, 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json');
const serviceAccount = require(serviceAccountPath);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

const SNAPSHOT_DATE = process.env.SNAPSHOT_DATE || '2025-10-29';
const openingInputs = {
  momo: Number(process.env.OPENING_MOMO ?? 704205),
  caisse: Number(process.env.OPENING_CAISSE ?? 20000),
  banque: Number(process.env.OPENING_BANQUE ?? 0)
};

function validateOpenings(values) {
  const entries = Object.entries(values);
  for (const [key, value] of entries) {
    if (!Number.isFinite(value)) {
      throw new Error(`Valeur invalide pour ${key}: ${value}`);
    }
  }
}

async function recordSnapshot() {
  validateOpenings(openingInputs);

  const openingBalanceGlobal = openingInputs.momo + openingInputs.caisse + openingInputs.banque;
  const docRef = db.collection('tresorerieSnapshots').doc(SNAPSHOT_DATE);
  const payload = {
    dateString: SNAPSHOT_DATE,
    openingMomo: openingInputs.momo,
    openingCaisse: openingInputs.caisse,
    openingBanque: openingInputs.banque,
    openingBalanceGlobal,
    openingByAccount: {
      momo: openingInputs.momo,
      caisse: openingInputs.caisse,
      banque: openingInputs.banque
    },
    openingRecordedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  await docRef.set(payload, { merge: true });
  console.log(`Snapshot tresorerie ${SNAPSHOT_DATE} enregistre. Solde global: ${openingBalanceGlobal}`);
}

recordSnapshot()
  .then(() => admin.app().delete())
  .catch(error => {
    console.error("Erreur lors de l'enregistrement du snapshot:", error);
    admin.app().delete().catch(() => {});
    process.exitCode = 1;
  });
