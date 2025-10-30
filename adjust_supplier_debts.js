const path = require('path');
const admin = require('firebase-admin');

const serviceAccountPath = path.join(__dirname, 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json');
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require(serviceAccountPath))
  });
}

const db = admin.firestore();

const TARGET_TOTALS = {
  'Dieu ou Rien': 380000,
  'Abdoul': 837500,
  'Aladji': 320000
};

const CANONICAL_LOOKUP = new Map([
  ['abdoul', 'Abdoul'],
  ['abdoul tg', 'Abdoul'],
  ['abdoul tg.', 'Abdoul'],
  ['abdoul tg ', 'Abdoul'],
  ['abdoul tg-', 'Abdoul'],
  ['dieu ou rien', 'Dieu ou Rien'],
  ['dieu ou rien ', 'Dieu ou Rien'],
  ['dieu ou rien.', 'Dieu ou Rien'],
  ['god is only', 'Dieu ou Rien'],
  ['aladji', 'Aladji'],
  ['alladji', 'Aladji'],
  ['alladja', 'Aladji'],
  ['alladji ', 'Aladji'],
  ['alladja ', 'Aladji'],
  ['aladja', 'Aladji'],
  ['alladjie', 'Aladji'],
  ['aladgi', 'Aladji'],
  ['aladji ', 'Aladji'],
  ['aladji.', 'Aladji']
]);

function canonicalName(raw) {
  if (!raw) return 'UNKNOWN';
  const normalized = raw.toString().trim().toLowerCase();
  return CANONICAL_LOOKUP.get(normalized) || raw.toString().trim();
}

function toNumber(value) {
  const num = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(num) ? num : 0;
}

async function adjustApprovisionnements() {
  const snapshot = await db.collection('approvisionnement').get();
  console.log('Loaded ' + snapshot.size + ' approvisionnement documents');
  const supplierDocs = new Map();

  snapshot.forEach(doc => {
    const data = doc.data();
    const canonical = canonicalName(data.fournisseur);
    const received = toNumber(data.receivedTotalCost !== undefined ? data.receivedTotalCost : data.totalCost);
    const payments = toNumber(data.paymentsTotalPaid);
    const explicitRemaining = data.remainingAmount !== undefined ? toNumber(data.remainingAmount) : null;
    const computedRemaining = Math.max(0, received - payments);
    const remaining = explicitRemaining !== null ? Math.max(0, explicitRemaining) : computedRemaining;

    const entry = supplierDocs.get(canonical) || { canonical, docs: [] };
    entry.docs.push({
      ref: doc.ref,
      received,
      paid: payments,
      remaining
    });
    supplierDocs.set(canonical, entry);
  });

  const writer = db.bulkWriter();
  writer.onWriteError(error => {
    console.error('BulkWriter error:', error);
    return false;
  });

  for (const [canonical, entry] of supplierDocs.entries()) {
    const desired = TARGET_TOTALS[canonical];
    if (desired === undefined) {
      entry.docs.forEach(docInfo => {
        const newPaid = docInfo.received;
        const payload = {
          fournisseur: canonical,
          paymentsTotalPaid: newPaid,
          remainingAmount: 0,
          netSupplierBalance: newPaid - docInfo.received,
          paymentMethod: 'paid',
          isPaid: true
        };
        writer.update(docInfo.ref, payload);
      });
      continue;
    }

    const docsSorted = entry.docs.slice().sort((a, b) => b.remaining - a.remaining);
    const currentTotal = docsSorted.reduce((sum, docInfo) => sum + docInfo.remaining, 0);
    let difference = currentTotal - desired;
    console.log(canonical + ': current=' + currentTotal + ' desired=' + desired + ' diff=' + difference);

    if (difference < 0) {
      console.warn('Current debt for ' + canonical + ' is already below desired target. Skipping reduction.');
      difference = 0;
    }

    docsSorted.forEach(docInfo => {
      if (difference <= 0) {
        return;
      }
      const available = Math.max(0, docInfo.remaining);
      if (available <= 0) {
        return;
      }
      const apply = Math.min(available, difference);
      docInfo.paid += apply;
      docInfo.remaining = Math.max(0, docInfo.received - docInfo.paid);
      difference -= apply;
    });

    if (difference > 0.5) {
      console.warn('Unable to fully adjust ' + canonical + '. Remaining difference: ' + difference);
    }

    docsSorted.forEach(docInfo => {
      const newRemaining = Math.max(0, docInfo.received - docInfo.paid);
      const isPaid = newRemaining <= 0.01;
      const payload = {
        fournisseur: canonical,
        paymentsTotalPaid: docInfo.paid,
        remainingAmount: newRemaining,
        netSupplierBalance: docInfo.paid - docInfo.received,
        paymentMethod: isPaid ? 'paid' : 'credit',
        isPaid
      };
      writer.update(docInfo.ref, payload);
    });
  }

  await writer.close();
  console.log('Approvisionnement adjustments applied.');
}

async function deduplicateFournisseurs() {
  const snapshot = await db.collection('fournisseurs').get();
  const seen = new Set();
  const keepNames = new Set(Object.keys(TARGET_TOTALS));

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const canonical = canonicalName(data.name || data.nom || '');
    if (!keepNames.has(canonical)) {
      await doc.ref.delete();
      continue;
    }
    if (seen.has(canonical)) {
      await doc.ref.delete();
      continue;
    }
    seen.add(canonical);
    await doc.ref.set({ name: canonical }, { merge: true });
  }
  console.log('Fournisseurs deduplicated. Remaining: ' + Array.from(seen).join(', '));
}

async function verifyTotals() {
  const snapshot = await db.collection('approvisionnement').get();
  const totals = new Map();
  snapshot.forEach(doc => {
    const data = doc.data();
    const name = canonicalName(data.fournisseur);
    const received = toNumber(data.receivedTotalCost !== undefined ? data.receivedTotalCost : data.totalCost);
    const paid = toNumber(data.paymentsTotalPaid);
    const remaining = toNumber(data.remainingAmount !== undefined ? data.remainingAmount : Math.max(0, received - paid));
    const entry = totals.get(name) || { name, received: 0, paid: 0, remaining: 0 };
    entry.received += received;
    entry.paid += paid;
    entry.remaining += remaining;
    totals.set(name, entry);
  });
  console.log('Verification summary (remaining > 0):');
  Array.from(totals.values())
    .filter(entry => entry.remaining > 0.01)
    .sort((a, b) => b.remaining - a.remaining)
    .forEach(entry => {
      console.log(entry.name + ': remaining=' + entry.remaining + ' received=' + entry.received + ' paid=' + entry.paid);
    });
}

async function main() {
  try {
    await adjustApprovisionnements();
    await deduplicateFournisseurs();
    await verifyTotals();
  } catch (error) {
    console.error('Erreur lors de la mise à jour des dettes fournisseurs:', error);
    process.exitCode = 1;
  } finally {
    await admin.app().delete().catch(() => {});
  }
}

main();
