const path = require('path');
const admin = require('firebase-admin');

const serviceAccountPath = path.join(__dirname, 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json');
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require(serviceAccountPath))
  });
}

const db = admin.firestore();

const ACCOUNT_ID = 'caisse';
const TARGET_DATE = '2025-10-30';
const TARGET_AMOUNTS = [3994500, 837500];

async function removeMovements() {
  const accountRef = db
    .collection('tresorerie')
    .doc('balance')
    .collection('comptesTresorerie')
    .doc(ACCOUNT_ID);

  const snapshot = await accountRef
    .collection('mouvements')
    .where('dateString', '==', TARGET_DATE)
    .where('type', '==', 'paiement_fournisseur')
    .get();

  if (snapshot.empty) {
    console.log('Aucun mouvement trouvé pour la date ciblée.');
    return;
  }

  const pending = new Map(TARGET_AMOUNTS.map(amount => [amount, null]));

  snapshot.forEach(doc => {
    const data = doc.data() || {};
    const amount = Math.round(Number(data.montant) || 0);
    if (!pending.has(amount) || pending.get(amount)) {
      return;
    }
    const description = (data.description || '').toLowerCase();
    if (!description.includes('abdoul') || !description.includes('tg')) {
      return;
    }
    pending.set(amount, {
      ref: doc.ref,
      description: data.description || '',
      timestamp: data.timestamp || null
    });
  });

  for (const [amount, info] of pending.entries()) {
    if (!info) {
      console.warn('Impossible de localiser le mouvement pour ' + amount + ' FCFA.');
      continue;
    }
    await info.ref.delete();
    console.log('Suppression effectuée pour ' + amount + ' FCFA (#' + info.ref.id + ').');
  }
}

removeMovements()
  .then(() => admin.app().delete())
  .catch(error => {
    console.error('Erreur lors de la suppression des mouvements:', error);
    admin.app().delete().catch(() => {});
    process.exitCode = 1;
  });
