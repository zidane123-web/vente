#!/usr/bin/env node

/**
 * Dresse la liste des articles et des clients associés aux ventes attribuées à Manini.
 *
 * Exemples:
 *   node list_manini_sales.js
 *   node list_manini_sales.js --since 2025-11-01 --until 2025-11-14
 *   node list_manini_sales.js --max-details 10
 */

const path = require('path');
const admin = require('firebase-admin');

const SERVICE_ACCOUNT_FILE = 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json';
const MANINI_ID = 'manini';
const EMPLOYEES = [
  { id: 'manini', label: 'Manini', aliases: ['manini'] },
  { id: 'sherrif', label: 'Sherrif', aliases: ['sherrif', 'sherif', 'cherif', 'cheriff', 'sheriff'] }
];

function printHelp() {
  console.log(`Usage: node list_manini_sales.js [options]

Options:
  --since <AAAA-MM-JJ>   Date de début (UTC, optionnelle)
  --until <AAAA-MM-JJ>   Date de fin (UTC, optionnelle)
  --max-details <n>      Nombre de ventes à détailler (défaut: 15)
  --help                 Affiche cette aide`);
}

function parseArgs(argv) {
  const args = {
    since: null,
    until: null,
    maxDetails: 15,
    help: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--since':
      case '--from':
        args.since = argv[++i];
        break;
      case '--until':
      case '--to':
      case '--end':
        args.until = argv[++i];
        break;
      case '--max-details': {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error('--max-details doit être un entier positif.');
        }
        args.maxDetails = Math.floor(value);
        break;
      }
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (token.startsWith('-')) {
          throw new Error(`Option inconnue: ${token}`);
        }
        break;
    }
  }
  return args;
}

function parseDateArg(raw, { endOfDay = false } = {}) {
  if (!raw) {
    return null;
  }
  let date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    date = new Date(`${raw}T00:00:00Z`);
  } else {
    date = new Date(raw);
  }
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Date invalide: ${raw}`);
  }
  if (endOfDay) {
    date.setUTCHours(23, 59, 59, 999);
  } else {
    date.setUTCHours(0, 0, 0, 0);
  }
  return date;
}

function initializeFirebase() {
  if (!admin.apps.length) {
    const serviceAccountPath = path.join(__dirname, SERVICE_ACCOUNT_FILE);
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
  return admin.firestore();
}

function normalizeString(value) {
  if (!value) {
    return '';
  }
  return value
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function collectEmployeeCandidates(sale) {
  const candidates = [
    sale.enregistreParNom,
    sale.enregistrePar,
    sale.createdBy,
    sale.userName,
    sale.enregistreParEmail,
    sale.ownerName,
    sale.vendeur,
    sale.seller
  ];
  const seen = new Set();
  const normalized = [];
  for (const candidate of candidates) {
    const value = normalizeString(candidate);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function detectEmployeeIdFromCandidates(candidates) {
  for (const normalized of candidates) {
    for (const employee of EMPLOYEES) {
      if (employee.aliases.some(alias => normalized.includes(alias))) {
        return employee.id;
      }
    }
  }
  return null;
}

function detectEmployeeId(sale) {
  return detectEmployeeIdFromCandidates(collectEmployeeCandidates(sale));
}

function toNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^0-9.,-]/g, '').replace(/,/g, '.');
    if (!cleaned) {
      return 0;
    }
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value.toNumber === 'function') {
    return toNumber(value.toNumber());
  }
  return 0;
}

function toDate(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value.toDate === 'function') {
    return value.toDate();
  }
  if (typeof value.seconds === 'number') {
    return new Date(value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6));
  }
  const millis = toNumber(value);
  if (!millis) {
    return null;
  }
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date;
}

function extractItemName(item) {
  return (
    item?.produit ??
    item?.name ??
    item?.designation ??
    item?.label ??
    item?.modele ??
    item?.article ??
    'Article inconnu'
  );
}

function resolveItemQuantity(item) {
  const raw = toNumber(item?.quantite ?? item?.qty ?? item?.quantity ?? 0);
  return raw > 0 ? raw : 1;
}

function formatNumber(value) {
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(Math.round(value || 0));
}

function formatDateTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return 'Date inconnue';
  }
  return date.toISOString().replace('T', ' ').slice(0, 16);
}

function getClientLabels(sale) {
  const candidates = [
    sale.client,
    sale.clientNom,
    sale.nomClient,
    sale.customer,
    sale.buyer,
    sale.ownerName
  ];
  const labels = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const trimmed = candidate.toString().trim();
    if (!trimmed) {
      continue;
    }
    const normalized = normalizeString(trimmed);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    labels.push(trimmed);
  }
  return labels.length ? labels : ['Client inconnu'];
}

async function fetchSales(db, { since, until }) {
  let query = db.collection('ventes');
  if (since) {
    query = query.where('timestamp', '>=', admin.firestore.Timestamp.fromDate(since));
  }
  if (until) {
    query = query.where('timestamp', '<=', admin.firestore.Timestamp.fromDate(until));
  }
  query = query.orderBy('timestamp', 'asc');
  const snapshot = await query.get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

function analyzeManiniSales(sales) {
  const productStats = new Map();
  const clientStats = new Map();
  const saleDetails = [];

  for (const sale of sales) {
    if (detectEmployeeId(sale) !== MANINI_ID) {
      continue;
    }
    const saleDate = toDate(sale.timestamp);
    const items = Array.isArray(sale.items) ? sale.items : [];
    if (!items.length) {
      continue;
    }
    const clients = getClientLabels(sale);
    clients.forEach(label => {
      const entry = clientStats.get(label) || { label, sales: 0 };
      entry.sales += 1;
      clientStats.set(label, entry);
    });

    saleDetails.push({
      id: sale.id,
      date: saleDate,
      clients,
      items: items.map(item => ({
        name: extractItemName(item),
        qty: resolveItemQuantity(item)
      }))
    });

    for (const item of items) {
      const name = extractItemName(item);
      const qty = resolveItemQuantity(item);
      const key = normalizeString(name);
      if (!key) {
        continue;
      }
      const entry = productStats.get(key) || {
        name,
        totalQty: 0,
        sales: 0
      };
      entry.totalQty += qty;
      entry.sales += 1;
      productStats.set(key, entry);
    }
  }

  const productList = Array.from(productStats.values()).sort((a, b) => b.totalQty - a.totalQty);
  const clientList = Array.from(clientStats.values()).sort((a, b) => b.sales - a.sales);
  saleDetails.sort((a, b) => (a.date?.getTime() || 0) - (b.date?.getTime() || 0));

  return {
    productList,
    clientList,
    saleDetails
  };
}

function printSummary(result, options, meta) {
  const { productList, clientList, saleDetails } = result;
  const { maxDetails } = options;
  console.log('\n===== Ventes attribuées à Manini =====');
  console.log(`Ventes analysées: ${saleDetails.length}`);
  console.log(`Articles distincts: ${productList.length}`);
  console.log(`Clients identifiés: ${clientList.length}`);
  if (meta?.rangeLabel) {
    console.log(`Période: ${meta.rangeLabel}`);
  }

  console.log('\nArticles vendus (par quantité décroissante):');
  if (!productList.length) {
    console.log('  Aucun article trouvé.');
  } else {
    for (const entry of productList) {
      console.log(`  - ${entry.name}: ${formatNumber(entry.totalQty)} unités (${formatNumber(entry.sales)} ventes)`);
    }
  }

  console.log('\nClients servis (par nombre de ventes):');
  if (!clientList.length) {
    console.log('  Aucun client identifié.');
  } else {
    for (const client of clientList) {
      console.log(`  - ${client.label}: ${formatNumber(client.sales)} vente${client.sales > 1 ? 's' : ''}`);
    }
  }

  const limitedDetails = saleDetails.slice(0, maxDetails);
  if (limitedDetails.length) {
    console.log(`\nDétails des ${limitedDetails.length} premières ventes (ordre chronologique):`);
    for (const sale of limitedDetails) {
      console.log('------------------------------');
      console.log(`${sale.id} | ${formatDateTime(sale.date)} | Clients: ${sale.clients.join(', ')}`);
      for (const item of sale.items) {
        console.log(`   • ${item.name} x${formatNumber(item.qty)}`);
      }
    }
    if (saleDetails.length > limitedDetails.length) {
      console.log(`\n... ${saleDetails.length - limitedDetails.length} ventes supplémentaires (augmentez --max-details pour plus d'entrées).`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const since = parseDateArg(args.since);
  const until = parseDateArg(args.until, { endOfDay: true });
  if (since && until && since > until) {
    throw new Error('La date de début doit être antérieure à la date de fin.');
  }
  const rangeLabel = since || until
    ? `${since ? since.toISOString().slice(0, 10) : '∞'} ➜ ${until ? until.toISOString().slice(0, 10) : '∞'}`
    : null;

  const db = initializeFirebase();
  console.log('Chargement des ventes Firestore...');
  const sales = await fetchSales(db, { since, until });
  console.log(`Ventes récupérées: ${sales.length}`);
  const result = analyzeManiniSales(sales);
  printSummary(result, { maxDetails: args.maxDetails }, { rangeLabel });
}

main()
  .catch(error => {
    console.error('Erreur lors du listing des ventes de Manini:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (admin.apps.length) {
      try {
        await Promise.race([
          admin.app().delete(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('délai de fermeture Firebase dépassé')), 5000))
        ]);
      } catch (cleanupError) {
        console.warn('Arrêt Firebase incomplet:', cleanupError.message);
      }
    }
    if (typeof process.exitCode !== 'number') {
      process.exitCode = 0;
    }
    process.exit(process.exitCode);
  });
