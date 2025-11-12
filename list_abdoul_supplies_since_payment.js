const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const SERVICE_ACCOUNT_FILE = 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json';
const DEFAULT_PAYMENT_ISO = '2025-11-06T10:38:00+01:00';
const DEFAULT_BASE_DEBT = 3000000;
const SUPPLIER_NAME = 'Abdoul';

const SUPPLIER_CANONICALS = new Map([
  ['abdoul', 'Abdoul'],
  ['abdoul tg', 'Abdoul'],
  ['abdoul tg.', 'Abdoul'],
  ['abdoul tg ', 'Abdoul'],
  ['abdoul tg-', 'Abdoul'],
  ['abdoul tg/', 'Abdoul']
]);

const PRICE_OVERRIDES = new Map([
  ['redmi a5 64 + 3', 34000],
  ['redmi a5 64+3', 34000],
  ['redmi a5 64gb', 34000],
  ['redmi a5 64 g', 34000]
]);

const argv = yargs(hideBin(process.argv))
  .option('since', {
    alias: 's',
    type: 'string',
    describe: "Date/heure du paiement MoMo (ISO, timestamp numerique ou texte lisible)"
  })
  .option('base-debt', {
    alias: 'b',
    type: 'number',
    describe: 'Dette initiale a ajouter aux achats (par defaut 3 000 000 FCFA)'
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
    const name = getItemName(item);
    const normalized = normalizeLabel(name);
    let effectiveLineCost = lineCost;
    let unitCost = qty > 0 ? lineCost / qty : getItemUnitCost(item);
    const override = getPriceOverride(normalized);
    if (override !== null && qty > 0) {
      unitCost = override;
      effectiveLineCost = override * qty;
    }
    totalQty += qty;
    totalValue += effectiveLineCost;
    itemSummaries.push({
      name,
      qty,
      unitCost,
      lineCost: effectiveLineCost,
      overrideApplied: override !== null
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

function normalizeLabel(value) {
  return (value || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function getPriceOverride(normalizedName) {
  if (!normalizedName) return null;
  const override = PRICE_OVERRIDES.get(normalizedName);
  return Number.isFinite(override) && override > 0 ? override : null;
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
  const totals = {
    totalQty: 0,
    totalValue: 0,
    totalTransport: 0
  };
  if (!summaries.length) {
    console.log('Aucun mouvement trouve dans Firestore.');
    return totals;
  }

  summaries.forEach((summary, index) => {
    totals.totalQty += summary.totalQty;
    totals.totalValue += summary.totalValue;
    totals.totalTransport += summary.transport;
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
  console.log(` - Quantite achetee: ${formatQuantity(totals.totalQty)} unites`);
  console.log(` - Achats estimes: ${formatCurrency(totals.totalValue)}`);
  if (totals.totalTransport > 0) {
    console.log(` - Frais identifies: ${formatCurrency(totals.totalTransport)}`);
    console.log(` - Achats + frais: ${formatCurrency(totals.totalValue + totals.totalTransport)}`);
  }

  return totals;
}

function consolidateItems(summaries) {
  const aggregated = new Map();
  for (const summary of summaries) {
    const items = Array.isArray(summary.items) ? summary.items : [];
    for (const item of items) {
      const normalized = normalizeLabel(item.name);
      if (!normalized) continue;
      const existing = aggregated.get(normalized) || { name: item.name, qty: 0, totalCost: 0 };
      if (!existing.name && item.name) {
        existing.name = item.name;
      }
      existing.qty += item.qty;
      existing.totalCost += item.lineCost;
      aggregated.set(normalized, existing);
    }
  }
  return Array.from(aggregated.values()).map(entry => ({
    name: entry.name,
    qty: entry.qty,
    totalCost: entry.totalCost,
    unitCost: entry.qty > 0 ? entry.totalCost / entry.qty : 0
  }));
}

function printConsolidatedSummary(summaries, totals, baseDebt) {
  console.log('\nVue consolidee par produit:');
  const rows = consolidateItems(summaries).sort((a, b) => b.qty - a.qty);
  if (!rows.length) {
    console.log('  Aucun article a consolider.');
  } else {
    rows.forEach(row => {
      console.log(
        ` - ${row.name}: ${formatQuantity(row.qty)} unites @ ${formatCurrency(row.unitCost)} => ${formatCurrency(row.totalCost)}`
      );
    });
  }

  const safeBaseDebt = Number.isFinite(baseDebt) && baseDebt >= 0 ? baseDebt : DEFAULT_BASE_DEBT;
  const currentDebt = safeBaseDebt + totals.totalValue;
  const currentDebtWithFees = currentDebt + totals.totalTransport;

  console.log('\nDette actualisee:');
  console.log(` - Dette initiale (override possible via --base-debt): ${formatCurrency(safeBaseDebt)}`);
  console.log(` - Dette hors frais: ${formatCurrency(currentDebt)}`);
  if (totals.totalTransport > 0) {
    console.log(` - Dette avec frais: ${formatCurrency(currentDebtWithFees)}`);
  }
}

async function main() {
  try {
    console.log('Connexion a Firestore en utilisant le service account local...');
    const purchases = await fetchAbdoulPurchasesSince(sinceDate);
    const limit = Number.isFinite(argv.limit) && argv.limit > 0 ? argv.limit : purchases.length;
    const summaries = purchases.slice(0, limit).map(summarizePurchase);

    const baseDebt =
      argv.baseDebt !== undefined
        ? Math.max(0, parseNumeric(argv.baseDebt))
        : DEFAULT_BASE_DEBT;

    const totals = printReport(summaries, sinceDate);
    printConsolidatedSummary(summaries, totals, baseDebt);

    if (argv.json) {
      const consolidated = consolidateItems(summaries);
      const currentDebt = baseDebt + totals.totalValue;
      const payload = {
        since: sinceDate.toISOString(),
        generatedAt: new Date().toISOString(),
        supplier: SUPPLIER_NAME,
        baseDebt,
        totals,
        currentDebt,
        currentDebtWithFees: currentDebt + totals.totalTransport,
        consolidated,
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
