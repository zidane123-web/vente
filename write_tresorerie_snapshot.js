const admin = require('firebase-admin');
const path = require('path');

const SERVICE_ACCOUNT_PATH = path.join(
  __dirname,
  'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json'
);

function bootstrapFirebase() {
  if (admin.apps.length) {
    return admin.app();
  }

  const serviceAccount = require(SERVICE_ACCOUNT_PATH);
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

function parseArgs(argv) {
  const opts = {};
  argv.forEach(arg => {
    const match = /^--([^=]+)=(.+)$/.exec(arg);
    if (!match) {
      return;
    }
    const [, key, value] = match;
    opts[key.trim().toLowerCase()] = value.trim();
  });
  return opts;
}

function normalizeDate(raw, referenceYear = new Date().getFullYear()) {
  if (!raw) {
    throw new Error('La date est obligatoire (ex: --date=2025-11-05).');
  }
  const value = raw.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const ddmmMatch = /^(\d{2})\/(\d{2})(?:\/(\d{4}))?$/.exec(value);
  if (ddmmMatch) {
    const day = Number(ddmmMatch[1]);
    const monthIndex = Number(ddmmMatch[2]) - 1;
    const year = ddmmMatch[3] ? Number(ddmmMatch[3]) : referenceYear;
    const date = new Date(Date.UTC(year, monthIndex, day));
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Date invalide: ${raw}`);
    }
    return date.toISOString().slice(0, 10);
  }

  throw new Error(`Format de date non gere: ${raw}`);
}

function parseAmount(value, label) {
  if (value == null) {
    throw new Error(`Champ manquant: ${label}`);
  }
  const normalized = String(value).replace(/[^0-9.-]/g, '');
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) {
    throw new Error(`Valeur numerique invalide pour ${label}: ${value}`);
  }
  return amount;
}

function buildOpeningPayload(inputs) {
  const caisse = parseAmount(inputs.caisse, 'caisse');
  const momo = parseAmount(inputs.momo ?? inputs['momo!'] ?? inputs.momoo, 'momo');
  const banque = parseAmount(inputs.banque ?? inputs.bank ?? inputs.b, 'banque');
  const openingBalanceGlobal = caisse + momo + banque;

  return {
    dateString: normalizeDate(inputs.date),
    openingBalanceGlobal,
    openingCaisse: caisse,
    openingMomo: momo,
    openingBanque: banque,
    openingBalances: {
      caisse,
      momo,
      banque
    },
    openingByAccount: {
      caisse: { nom: 'Caisse', solde: caisse },
      momo: { nom: 'MoMo', solde: momo },
      banque: { nom: 'Banque', solde: banque }
    }
  };
}

async function writeSnapshot(db, payload) {
  const docRef = db.collection('tresorerieSnapshots').doc(payload.dateString);
  const fieldValue = admin.firestore.FieldValue;
  const metadata = {
    openingPreparedAt: fieldValue.serverTimestamp(),
    openingPreparedBy: 'write_tresorerie_snapshot.js',
    openingPreparedFrom: 'manual-cli'
  };

  await docRef.set(
    Object.assign({}, payload, metadata),
    { merge: true }
  );

  return docRef.get();
}

async function main() {
  const app = bootstrapFirebase();
  try {
    const args = parseArgs(process.argv.slice(2));
    const payload = buildOpeningPayload(args);
    const db = admin.firestore();
    const snapshot = await writeSnapshot(db, payload);
    const data = snapshot.data() || {};

    console.log('[OK] Snapshot mis a jour pour', payload.dateString);
    console.log('  - openingBalanceGlobal :', payload.openingBalanceGlobal);
    console.log('  - openingCaisse        :', payload.openingCaisse);
    console.log('  - openingMomo          :', payload.openingMomo);
    console.log('  - openingBanque        :', payload.openingBanque);
    if (data.closingBalanceGlobal != null) {
      console.log('  (Info) closingBalanceGlobal existant :', data.closingBalanceGlobal);
    }
  } finally {
    await app.delete().catch(() => {});
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('[ERREUR] Impossible de mettre a jour le snapshot :', error.message);
    process.exitCode = 1;
  });
}
