const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const SERVICE_ACCOUNT_FILE = 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json';
const DEFAULT_PAYMENT_ISO = '2025-11-06T10:38:00+01:00';
const SUPPLIER_NAME = 'Abdoul';

const SUPPLIER_CANONICALS = new Map([
  ['abdoul', 'Abdoul'],
  ['abdoul tg', 'Abdoul'],
  ['abdoul tg.', 'Abdoul'],
  ['abdoul tg ', 'Abdoul'],
  ['abdoul tg-', 'Abdoul'],
  ['abdoul tg/', 'Abdoul']
]);

const argv = yargs(hideBin(process.argv))
.option('since', {
    alias: 's',
    type: 'string',
    describe: "Date/heure du paiement MoMo (ISO, timestamp numerique ou texte lisible)"
  })
  .option('json', {
    type: 'string',
    describe: 'Chemin de fichier optionnel pour enregistrer le detail en JSON'
  })
  .option('limit', {
    alias: 'l',
    type: 'number',
    describe: 'Nombre max. d approvisionnements a afficher'
  })
  .help()
  .alias('help', 'h')
  .parse();

const serviceAccountPath = path.join(__dirname, SERVICE_ACCOUNT_FILE);
let serviceAccount;
try {
  serviceAccount = require(serviceAccountPath);
} catch (error) {
  console.error("Service account Firebase introuvable :", error.message);
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

const sinceInput = argv.since || DEFAULT_PAYMENT_ISO;
const sinceDate = parseDateInput(sinceInput);
if (!sinceDate) {
  console.error('Impossible de parser la date fournie pour --since :', sinceInput);
  process.exit(1);
}

async function fetchAbdoulPurchasesSince(date) {
  const timestamp = admin.firestore.Timestamp.fromDate(date);
  const snapshot = await db
    .collection('approvisionnement')
    .where('timestamp', '>=', timestamp)
    .orderBy('timestamp', 'asc')
    .get();

  return snapshot.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(doc => canonicalSupplier(doc.fournisseur ?? doc.supplier ?? '') === SUPPLIER_NAME);
}

function summarizePurchase(purchase) {
  const items = Array.isArray(purchase.items) ? purchase.items : [];
  const itemSummaries = [];
  let totalQty = 0;
  let totalValue = 0;

  for (const item of items) {
    const qty = getItemQuantity(item);
    const lineCost = getItemLineCost(item);
    if (qty <= 0 && lineCost <= 0) {
      continue;
    }
    totalQty += qty;
    totalValue += lineCost;
    const unitCost = qty > 0 ? lineCost / qty : getItemUnitCost(item);
    itemSummaries.push({
      name: getItemName(item),
      qty,
      unitCost,
      lineCost
    });
  }

  const transport = parseNumeric(
    purchase.fraisTransport ??
    purchase.transport ??
    purchase.frais ??
    purchase.charges ??
    purchase.deliveryFees ??
    0
  );

  const declaredTotal = parseNumeric(
    purchase.total ??
    purchase.montant ??
    purchase.montantTotal ??
    purchase.amount ??
    purchase.totalAchat ??
    0
  );

  return {
    id: purchase.id,
    reference: purchase.reference ?? purchase.ref ?? purchase.code ?? purchase.numero ?? null,
    timestamp: normalizeTimestamp(purchase.timestamp ?? purchase.date ?? purchase.createdAt),
    paymentMethod: purchase.modePaiement ?? purchase.paymentMethod ?? null,
    totalQty,
    totalValue,
    transport,
    declaredTotal,
    orderCodes: extractOrderCodes(purchase),
    notes: purchase.commentaire ?? purchase.note ?? purchase.observation ?? null,
    items: itemSummaries
  };
}

function extractOrderCodes(purchase) {
  const buckets = [
    purchase.commandes,
    purchase.commande,
    purchase.commandeIds,
    purchase.orders,
    purchase.referencesCommandes,
    purchase.orderCodes
  ];
  const codes = new Set();
  for (const bucket of buckets) {
    for (const value of normalizeList(bucket)) {
      if (value.length >= 3) {
        codes.add(value);
      }
    }
  }
  return Array.from(codes);
}

function normalizeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map(entry => (typeof entry === 'string' ? entry : String(entry ?? '').trim()))
      .map(entry => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[\s,;|/]+/)
      .map(entry => entry.trim())
      .filter(Boolean);
  }
  const coerced = String(value ?? '').trim();
  return coerced ? [coerced] : [];
}

function canonicalSupplier(raw) {
  if (!raw) return '';
  const normalized = raw.toString().trim().toLowerCase();
  return SUPPLIER_CANONICALS.get(normalized) || raw.toString().trim();
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

function getItemName(item) {
  if (!item || typeof item !== 'object') return 'Article sans nom';
  return (
    item.produit ??
    item.name ??
    item.designation ??
    item.label ??
    item.modele ??
    'Article sans nom'
  );
}

function getItemQuantity(item) {
  if (!item || typeof item !== 'object') return 0;
  return parseNumeric(item.quantite ?? item.qty ?? item.quantity ?? item.qte ?? 0);
}

function getItemUnitCost(item) {
  if (!item || typeof item !== 'object') return 0;
  return parseNumeric(
    item.prixAchat ??
    item.coutAchat ??
    item.cost ??
    item.unitCost ??
    item.purchasePrice ??
    item.cout ??
    0
  );
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
  return getItemUnitCost(item) * getItemQuantity(item);
}

function normalizeTimestamp(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') {
    return value.toDate();
  }
  if (typeof value === 'object' && typeof value.seconds === 'number') {
    return new Date(value.seconds * 1000 + Math.round((value.nanoseconds || 0) / 1e6));
  }
  return parseDateInput(value);
}

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

function formatCurrency(amount) {
  if (!Number.isFinite(amount)) return '';
  const rounded = Math.round(amount);
  const absValue = Math.abs(rounded);
  const formatted = absValue.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const sign = rounded < 0 ? '-' : '';
  return `${sign}${formatted} FCFA`;
}

function formatQuantity(qty) {
  if (!Number.isFinite(qty)) return '';
  if (Math.abs(qty % 1) < 1e-6) {
    return `${qty}`;
  }
  return qty.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatDateTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return 'Date inconnue';
  }
  return date.toLocaleString('fr-FR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function printReport(summaries, cutoff) {
  console.log(`Approvisionnements ${SUPPLIER_NAME} enregistres depuis ${formatDateTime(cutoff)} (${cutoff.toISOString()})`);
  if (!summaries.length) {
    console.log('Aucun mouvement trouve dans Firestore.');
    return;
  }

  let totalQty = 0;
  let totalValue = 0;
  let totalTransport = 0;

  summaries.forEach((summary, index) => {
    totalQty += summary.totalQty;
    totalValue += summary.totalValue;
    totalTransport += summary.transport;
    const titleParts = [
      formatDateTime(summary.timestamp),
      summary.reference || summary.id
    ].filter(Boolean);
    console.log(`\n${index + 1}. ${titleParts.join(' - ')}`);
    console.log(`   Quantite: ${formatQuantity(summary.totalQty)} - Montant estime: ${formatCurrency(summary.totalValue)}`);
    if (summary.transport > 0) {
      console.log(`   Frais/transport: ${formatCurrency(summary.transport)}`);
    }
    if (summary.declaredTotal > 0) {
      console.log(`   Total declare: ${formatCurrency(summary.declaredTotal)}`);
    }
    if (summary.paymentMethod) {
      console.log(`   Mode de paiement: ${summary.paymentMethod}`);
    }
    if (summary.orderCodes.length) {
      console.log(`   Commandes: ${summary.orderCodes.join(', ')}`);
    }
    if (summary.notes) {
      console.log(`   Note: ${summary.notes}`);
    }
    summary.items.forEach(item => {
      console.log(
        `     - ${item.name}: ${formatQuantity(item.qty)} x ${formatCurrency(item.unitCost)} = ${formatCurrency(item.lineCost)}`
      );
    });
  });

  console.log('\nTotaux depuis le paiement:');
  console.log(` - Approvisionnements: ${summaries.length}`);
  console.log(` - Quantite achetee: ${formatQuantity(totalQty)} unites`);
  console.log(` - Achats estimes: ${formatCurrency(totalValue)}`);
  if (totalTransport > 0) {
    console.log(` - Frais identifies: ${formatCurrency(totalTransport)}`);
    console.log(` - Achats + frais: ${formatCurrency(totalValue + totalTransport)}`);
  }
}

async function main() {
  try {
    console.log('Connexion a Firestore en utilisant le service account local...');
    const purchases = await fetchAbdoulPurchasesSince(sinceDate);
    const limit = Number.isFinite(argv.limit) && argv.limit > 0 ? argv.limit : purchases.length;
    const summaries = purchases.slice(0, limit).map(summarizePurchase);

    printReport(summaries, sinceDate);

    if (argv.json) {
      const payload = {
        since: sinceDate.toISOString(),
        generatedAt: new Date().toISOString(),
        supplier: SUPPLIER_NAME,
        summaries
      };
      fs.writeFileSync(path.resolve(argv.json), JSON.stringify(payload, null, 2), 'utf8');
      console.log(`\nExport JSON enregistre dans ${path.resolve(argv.json)}`);
    }
  } catch (error) {
    console.error('Erreur lors de la recuperation des approvisionnements:', error);
    process.exitCode = 1;
  } finally {
    await admin.app().delete().catch(() => {});
  }
}

main();
