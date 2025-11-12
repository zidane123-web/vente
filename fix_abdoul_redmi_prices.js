const path = require('path');
const admin = require('firebase-admin');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const SERVICE_ACCOUNT_FILE = 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json';
const DEFAULT_SUPPLIER = 'Abdoul';
const DEFAULT_PAYMENT_ISO = '2025-11-06T10:38:00+01:00';
const TARGET_PRICE = 34000;

const TARGET_NAMES = [
  'redmi a5 64 + 3',
  'redmi a5 64+3',
  'redmi a5 64gb',
  'redmi a5 64 g'
];

const argv = yargs(hideBin(process.argv))
  .option('since', {
    alias: 's',
    type: 'string',
    describe: 'Date/heure minimale pour filtrer les approvisionnements (ISO ou lisible)',
    default: DEFAULT_PAYMENT_ISO
  })
  .option('supplier', {
    alias: 'p',
    type: 'string',
    default: DEFAULT_SUPPLIER,
    describe: 'Nom du fournisseur cible'
  })
  .option('apply', {
    alias: 'a',
    type: 'boolean',
    default: false,
    describe: 'Applique effectivement les modifications (sinon dry-run)'
  })
  .option('limit', {
    alias: 'l',
    type: 'number',
    describe: 'Nombre max. de documents a traiter'
  })
  .help()
  .alias('help', 'h')
  .parse();

const serviceAccountPath = path.join(__dirname, SERVICE_ACCOUNT_FILE);
let serviceAccount;
try {
  serviceAccount = require(serviceAccountPath);
} catch (error) {
  console.error('Impossible de charger le service account Firebase:', error.message);
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

function parseDateInput(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function parseNumeric(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const normalized = trimmed.replace(/[^0-9.,-]/g, '').replace(/,/g, '.');
    if (!normalized) return 0;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === 'object') {
    if (typeof value.toNumber === 'function') {
      return parseNumeric(value.toNumber());
    }
    if (typeof value.valueOf === 'function' && value !== value.valueOf()) {
      return parseNumeric(value.valueOf());
    }
  }
  return 0;
}

function normalizeLabel(value) {
  return (value || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function getItemName(item) {
  if (!item || typeof item !== 'object') return '';
  return (
    item.produit ??
    item.name ??
    item.designation ??
    item.label ??
    item.modele ??
    ''
  );
}

function getItemQuantity(item) {
  if (!item || typeof item !== 'object') return 0;
  return parseNumeric(item.quantite ?? item.qty ?? item.quantity ?? item.qte ?? 0);
}

function getItemLineCost(item) {
  if (!item || typeof item !== 'object') return 0;
  const explicit =
    item.coutTotal ??
    item.totalCost ??
    item.ligneCout ??
    item.lineCost ??
    item.totalAchat ??
    item.totalPrice;
  const parsedExplicit = parseNumeric(explicit);
  if (parsedExplicit > 0) {
    return parsedExplicit;
  }
  const unit = parseNumeric(
    item.prixAchat ??
    item.coutAchat ??
    item.cost ??
    item.unitCost ??
    item.purchasePrice ??
    item.cout ??
    0
  );
  return unit * getItemQuantity(item);
}

function shouldOverride(name) {
  if (!name) return false;
  const normalized = normalizeLabel(name);
  return TARGET_NAMES.includes(normalized);
}

function updateDocumentItems(items) {
  const sanitized = Array.isArray(items) ? items : [];
  const updatedItems = [];
  let changed = false;
  let oldTotal = 0;
  let newTotal = 0;

  for (const original of sanitized) {
    const item = { ...original };
    const qty = getItemQuantity(item);
    const name = getItemName(item);
    const currentLine = getItemLineCost(item);
    oldTotal += currentLine;

    if (qty > 0 && shouldOverride(name)) {
      changed = true;
      item.prixAchat = TARGET_PRICE;
      item.coutAchat = TARGET_PRICE;
      item.cost = TARGET_PRICE;
      item.unitCost = TARGET_PRICE;
      item.purchasePrice = TARGET_PRICE;
      const newLine = TARGET_PRICE * qty;
      item.coutTotal = newLine;
      item.totalCost = newLine;
      item.ligneCout = newLine;
      item.lineCost = newLine;
      item.totalAchat = newLine;
      item.totalPrice = newLine;
      newTotal += newLine;
    } else {
      newTotal += currentLine;
    }
    updatedItems.push(item);
  }

  if (!changed) {
    return null;
  }

  return {
    items: updatedItems,
    oldTotal,
    newTotal
  };
}

async function fetchTargetPurchases(startDate, supplier) {
  const timestamp = admin.firestore.Timestamp.fromDate(startDate);
  let query = db
    .collection('approvisionnement')
    .where('timestamp', '>=', timestamp)
    .orderBy('timestamp', 'asc');

  if (supplier) {
    query = query.where('fournisseur', '==', supplier);
  }

  const snapshot = await query.get();
  return snapshot.docs;
}

function buildDocUpdates(docData, itemsInfo) {
  const updates = {
    items: itemsInfo.items
  };
  const fieldsToMirror = ['total', 'montant', 'montantTotal', 'amount', 'totalAchat'];
  for (const field of fieldsToMirror) {
    if (docData[field] !== undefined) {
      updates[field] = itemsInfo.newTotal;
    }
  }
  return updates;
}

async function main() {
  const startDate = parseDateInput(argv.since);
  if (!startDate) {
    console.error('Date invalide pour --since. Valeur fournie :', argv.since);
    process.exit(1);
  }

  console.log(`Recherche des approvisionnements ${argv.supplier} depuis ${startDate.toISOString()}...`);
  const docs = await fetchTargetPurchases(startDate, argv.supplier);
  const limit = Number.isFinite(argv.limit) && argv.limit > 0 ? argv.limit : docs.length;
  const slice = docs.slice(0, limit);

  const targets = [];

  for (const docSnap of slice) {
    const data = docSnap.data();
    const itemsInfo = updateDocumentItems(data.items);
    if (!itemsInfo) continue;

    const updates = buildDocUpdates(data, itemsInfo);
    targets.push({
      id: docSnap.id,
      ref: docSnap.ref,
      timestamp: data.timestamp?.toDate?.() ?? null,
      oldTotal: itemsInfo.oldTotal,
      newTotal: itemsInfo.newTotal,
      delta: itemsInfo.newTotal - itemsInfo.oldTotal,
      updates
    });
  }

  if (!targets.length) {
    console.log('Aucun article cible necessitant une correction.');
    return;
  }

  console.log(`Documents identifies: ${targets.length}`);
  targets.forEach((target, index) => {
    console.log(
      `${index + 1}. ${target.id} - ancien: ${target.oldTotal} | nouveau: ${target.newTotal} | delta: ${target.delta}`
    );
  });

  if (!argv.apply) {
    console.log('\nDry-run termine. Relancez avec --apply pour ecrire les modifications.');
    return;
  }

  console.log('\nApplication des mises a jour...');
  for (const target of targets) {
    await target.ref.update(target.updates);
    console.log(` - ${target.id} mis a jour (delta ${target.delta} FCFA)`);
  }
  console.log('Termine.');
}

main()
  .catch(error => {
    console.error('Erreur lors de la correction des prix:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await admin.app().delete().catch(() => {});
  });
