#!/usr/bin/env node

/**
 * Analyse les ventes attribuées à Manini et signale les articles vendus
 * sensiblement moins cher que les ventes précédentes réalisées par les autres vendeurs.
 *
 * Exemples :
 *   node compare_manini_sales.js
 *   node compare_manini_sales.js --since 2025-11-01 --min 3000
 *   node compare_manini_sales.js --product "itel 2163" --max 10
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
  console.log(`Usage: node compare_manini_sales.js [options]

Options:
  --since <AAAA-MM-JJ>   Date de début (UTC, optionnelle)
  --until <AAAA-MM-JJ>   Date de fin (UTC, optionnelle)
  --min <montant>        Écart minimal par unité à signaler (défaut: 5000)
  --product <texte>      Filtre sur le nom de produit (recherche partielle)
  --max <n>              Nombre de lignes détaillées à afficher (défaut: 20)
  --help                 Affiche cette aide

Sans filtre de dates, toutes les ventes disponibles seront chargées (attention au temps d'exécution).`);
}

function parseArgs(argv) {
  const args = {
    since: null,
    until: null,
    minDiff: 5000,
    productFilter: null,
    maxDetails: 20,
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
      case '--min':
      case '--min-diff': {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value) || value < 0) {
          throw new Error('La valeur de --min doit être un nombre positif.');
        }
        args.minDiff = value;
        break;
      }
      case '--product':
        args.productFilter = argv[++i];
        break;
      case '--max': {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error('La valeur de --max doit être un entier positif.');
        }
        args.maxDetails = Math.floor(value);
        break;
      }
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (token && token.startsWith('-')) {
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

function normalizeProductKey(name) {
  return normalizeString(name).replace(/\s+/g, ' ').trim();
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

function resolveItemQuantity(item) {
  const raw = toNumber(item?.quantite ?? item?.qty ?? item?.quantity ?? 0);
  return raw > 0 ? raw : 1;
}

function extractUnitPrice(item, qty) {
  const directUnit = toNumber(
    item?.prix ??
    item?.price ??
    item?.prixVente ??
    item?.sellingPrice ??
    item?.unitPrice
  );
  if (directUnit > 0) {
    return directUnit;
  }
  const total = toNumber(
    item?.total ??
    item?.totalVente ??
    item?.totalPrice ??
    item?.ligneTotal ??
    item?.lineTotal ??
    item?.montant
  );
  if (total > 0 && qty > 0) {
    return total / qty;
  }
  return 0;
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

function formatCurrency(amount) {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'XOF',
    maximumFractionDigits: 0
  }).format(Math.round(amount));
}

function formatNumber(value) {
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(Math.round(value));
}

function formatDateTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return 'Date inconnue';
  }
  return date.toISOString().replace('T', ' ').slice(0, 16);
}

function getSaleOwnerLabel(sale) {
  return (
    sale?.enregistreParNom ||
    sale?.enregistrePar ||
    sale?.vendeur ||
    sale?.seller ||
    sale?.userName ||
    sale?.ownerName ||
    'Vendeur inconnu'
  );
}

async function fetchSales(db, { since, until }) {
  let query = db.collection('ventes');
  const filters = [];
  if (since) {
    filters.push(['timestamp', '>=', admin.firestore.Timestamp.fromDate(since)]);
  }
  if (until) {
    filters.push(['timestamp', '<=', admin.firestore.Timestamp.fromDate(until)]);
  }
  for (const [field, op, value] of filters) {
    query = query.where(field, op, value);
  }
  query = query.orderBy('timestamp', 'asc');
  const snapshot = await query.get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

function analyzeSales(sales, options) {
  const { minDiff, productFilter } = options;
  const normalizedProductFilter = normalizeProductKey(productFilter || '');
  const sorted = sales.slice().sort((a, b) => {
    const aDate = toDate(a.timestamp)?.getTime() ?? 0;
    const bDate = toDate(b.timestamp)?.getTime() ?? 0;
    return aDate - bDate;
  });

  const baselineByProduct = new Map();
  const anomalies = [];
  const aggregateByProduct = new Map();
  const stats = {
    totalSales: sales.length,
    baselineLines: 0,
    maniniLines: 0,
    comparableLines: 0
  };

  for (const sale of sorted) {
    const saleDate = toDate(sale.timestamp);
    if (!saleDate) {
      continue;
    }
    const employeeId = detectEmployeeId(sale) || 'autre';
    const items = Array.isArray(sale.items) ? sale.items : [];
    const sellerLabel = getSaleOwnerLabel(sale);

    for (const item of items) {
      const qty = resolveItemQuantity(item);
      const unitPrice = extractUnitPrice(item, qty);
      if (unitPrice <= 0 || qty <= 0) {
        continue;
      }
      const productName = extractItemName(item);
      const productKey = normalizeProductKey(productName);
      if (!productKey) {
        continue;
      }

      if (employeeId === MANINI_ID) {
        stats.maniniLines += 1;
        if (
          normalizedProductFilter &&
          !productKey.includes(normalizedProductFilter)
        ) {
          continue;
        }
        const baseline = baselineByProduct.get(productKey);
        if (!baseline || baseline.totalQty <= 0) {
          continue;
        }
        stats.comparableLines += 1;
        const avgPrice = baseline.totalRevenue / baseline.totalQty;
        const diff = avgPrice - unitPrice;
        if (diff < minDiff) {
          continue;
        }
        const estimatedGap = diff * qty;
        anomalies.push({
          productKey,
          productName: baseline.referenceName || productName,
          saleId: sale.id,
          saleDate,
          qty,
          unitPrice,
          avgPrice,
          diffPerUnit: diff,
          estimatedGap,
          baselineSamples: baseline.samples.slice(-3),
          baselineCount: baseline.lineCount,
          baselineQty: baseline.totalQty
        });

        const aggregate = aggregateByProduct.get(productKey) || {
          productName: baseline.referenceName || productName,
          lines: 0,
          totalQty: 0,
          totalGap: 0
        };
        aggregate.lines += 1;
        aggregate.totalQty += qty;
        aggregate.totalGap += estimatedGap;
        aggregateByProduct.set(productKey, aggregate);
      } else {
        stats.baselineLines += 1;
        let baseline = baselineByProduct.get(productKey);
        if (!baseline) {
          baseline = {
            referenceName: productName,
            totalQty: 0,
            totalRevenue: 0,
            minPrice: unitPrice,
            maxPrice: unitPrice,
            lineCount: 0,
            samples: []
          };
          baselineByProduct.set(productKey, baseline);
        }
        baseline.referenceName = baseline.referenceName || productName;
        baseline.totalQty += qty;
        baseline.totalRevenue += unitPrice * qty;
        baseline.minPrice = Math.min(baseline.minPrice, unitPrice);
        baseline.maxPrice = Math.max(baseline.maxPrice, unitPrice);
        baseline.lineCount += 1;
        baseline.samples.push({
          unitPrice,
          qty,
          saleId: sale.id,
          date: saleDate,
          seller: sellerLabel
        });
        if (baseline.samples.length > 5) {
          baseline.samples.shift();
        }
      }
    }
  }

  anomalies.sort((a, b) => b.estimatedGap - a.estimatedGap);
  const aggregateList = Array.from(aggregateByProduct.values()).sort(
    (a, b) => b.totalGap - a.totalGap
  );

  return {
    anomalies,
    aggregateList,
    stats
  };
}

function printReport(result, options) {
  const { anomalies, aggregateList, stats } = result;
  const { maxDetails, minDiff, productFilter } = options;
  console.log('\n===== Comparaison des ventes de Manini =====');
  console.log(`Ventes chargées: ${stats.totalSales}`);
  console.log(`Lignes baseline (autres vendeurs): ${formatNumber(stats.baselineLines)}`);
  console.log(`Lignes Manini: ${formatNumber(stats.maniniLines)} | Comparables: ${formatNumber(stats.comparableLines)}`);
  console.log(`Écart minimal signalé: ${formatCurrency(minDiff)} par article`);
  if (productFilter) {
    console.log(`Filtre produit: "${productFilter}"`);
  }

  if (!anomalies.length) {
    console.log('\nAucune vente suspecte détectée pour les critères fournis.');
    return;
  }

  console.log(`\nAnomalies détectées: ${anomalies.length}`);
  const limited = anomalies.slice(0, maxDetails);
  for (const anomaly of limited) {
    console.log('\n------------------------------');
    console.log(`Produit: ${anomaly.productName}`);
    console.log(`Vente ${anomaly.saleId} du ${formatDateTime(anomaly.saleDate)} (${formatNumber(anomaly.qty)} unité${anomaly.qty > 1 ? 's' : ''})`);
    console.log(`  Prix Manini: ${formatCurrency(anomaly.unitPrice)}`);
    console.log(`  Prix moyen précédents (${formatNumber(anomaly.baselineQty)} unités, ${formatNumber(anomaly.baselineCount)} lignes): ${formatCurrency(anomaly.avgPrice)}`);
    console.log(`  Écart estimé: ${formatCurrency(anomaly.diffPerUnit)} par unité ➜ ${formatCurrency(anomaly.estimatedGap)} au total`);
    if (anomaly.baselineSamples.length) {
      console.log('  Références précédentes:');
      for (const sample of anomaly.baselineSamples) {
        console.log(`    - ${formatDateTime(sample.date)} | ${sample.seller} | ${formatCurrency(sample.unitPrice)} (${formatNumber(sample.qty)}u) [${sample.saleId}]`);
      }
    }
  }
  if (anomalies.length > limited.length) {
    console.log(`\n... ${anomalies.length - limited.length} lignes supplémentaires (augmentez --max pour les afficher).`);
  }

  if (aggregateList.length) {
    console.log('\nTop produits par écart cumulé:');
    for (const aggregate of aggregateList.slice(0, 10)) {
      console.log(`  - ${aggregate.productName}: ${formatCurrency(aggregate.totalGap)} (${formatNumber(aggregate.lines)} lignes, ${formatNumber(aggregate.totalQty)} unités)`);
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

  const db = initializeFirebase();
  console.log('Chargement des ventes Firestore...');
  const sales = await fetchSales(db, { since, until });
  console.log(`Ventes récupérées: ${sales.length}`);
  const result = analyzeSales(sales, {
    minDiff: args.minDiff,
    productFilter: args.productFilter
  });
  printReport(result, {
    maxDetails: args.maxDetails,
    minDiff: args.minDiff,
    productFilter: args.productFilter
  });
}

main()
  .catch(error => {
    console.error('Erreur lors de la comparaison:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (admin.apps.length) {
      try {
        await Promise.race([
          admin.app().delete(),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('délai de fermeture Firebase dépassé')), 5000);
          })
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
