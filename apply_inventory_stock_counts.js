#!/usr/bin/env node

/**
 * Met à jour les quantités magasin/boutique pour une sélection d'articles
 * Firestore `stock` à partir d'un inventaire manuel.
 */

const path = require('path');
const admin = require('firebase-admin');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const SERVICE_ACCOUNT_FILE = 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json';

const INVENTORY_ENTRIES = [
  { stockName: 'Tecno Pop 10 128 + 3', boutique: 1, magasin: 7 },
  { stockName: 'Tecno Pop 10 64+3', boutique: 2, magasin: 0 },
  { stockName: 'Tecno Pop 10c 64 + 2', boutique: 2, magasin: 7 },
  { stockName: 'Tecno Spark 40 128 + 4', boutique: 1, magasin: 0 },
  { stockName: 'Tecno spark 40 256+8', boutique: 1, magasin: 4 },
  { stockName: 'Tecno T528', boutique: 2, magasin: 60 },
  { stockName: 'Infinix Hot 60i 128+4', boutique: 1, magasin: 0 },
  { stockName: 'Infinix smart 10 HD 64+2', boutique: 1, magasin: 0 },
  { stockName: 'Itel it5626', boutique: 9, magasin: 25 },
  { stockName: 'Redmi 14c 256 + 8', boutique: 1, magasin: 0 },
  { stockName: 'Redmi note 13 pro 256+8', boutique: 1, magasin: 0 },
  { stockName: 'Redmi note 14 Pro 512 + 12', boutique: 1, magasin: 0 },
  { stockName: 'Samsung A16 128 + 4', boutique: 1, magasin: 0 },
  { stockName: 'Samsung Galaxy A35 256+8', boutique: 1, magasin: 0 },
  { stockName: 'Homi H10', boutique: 1, magasin: 0 },
  { stockName: 'Nokia 106', boutique: 0, magasin: 29 },
  { stockName: 'Tablette Smart 8 PRO 256 + 8', boutique: 2, magasin: 0 },
  { stockName: 'Villaon v105', boutique: 8, magasin: 0 },
  { stockName: 'VILLAON V20 SE 32 + 4 OCCASION', boutique: 2, magasin: 0 },
  { stockName: 'Villaon v230', boutique: 2, magasin: 4 },
  { stockName: 'Villaon V25 64 + 2', boutique: 1, magasin: 0 },
  { stockName: 'Villaon V45 64 + 2', boutique: 2, magasin: 0 },
  { stockName: 'X-tigi L300', boutique: 2, magasin: 0 },
  { stockName: 'X-tigi S56', boutique: 1, magasin: 0 }
];

function normalizeLabel(value) {
  return (value || '')
    .toString()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function normalizeNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value.toNumber === 'function') {
    const parsed = Number(value.toNumber());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value.valueOf === 'function') {
    return normalizeNumber(value.valueOf());
  }
  return 0;
}

function buildStockMaps(docs) {
  const exactMap = new Map();
  const normalizedMap = new Map();

  docs.forEach(entry => {
    const name = (entry.name || '').trim();
    if (!name) {
      return;
    }
    const exactKey = name.toLowerCase();
    if (!exactMap.has(exactKey)) {
      exactMap.set(exactKey, []);
    }
    exactMap.get(exactKey).push(entry);

    const normalizedKey = normalizeLabel(name);
    if (!normalizedMap.has(normalizedKey)) {
      normalizedMap.set(normalizedKey, []);
    }
    normalizedMap.get(normalizedKey).push(entry);
  });

  return { exactMap, normalizedMap };
}

function findStockEntry(targetName, maps) {
  if (!targetName) return null;
  const exactKey = targetName.trim().toLowerCase();
  if (maps.exactMap.has(exactKey)) {
    const matches = maps.exactMap.get(exactKey);
    if (matches.length === 1) {
      return matches[0];
    }
    const strict = matches.find(match => (match.name || '').trim() === targetName.trim());
    return strict || matches[0];
  }
  const normalizedKey = normalizeLabel(targetName);
  if (maps.normalizedMap.has(normalizedKey)) {
    return maps.normalizedMap.get(normalizedKey)[0];
  }
  return null;
}

function describeChange(label, before, after) {
  if (before === after) {
    return '';
  }
  return `${label}: ${before} → ${after}`;
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('apply', {
      type: 'boolean',
      default: false,
      describe: 'Applique réellement les mises à jour (sinon simulation).'
    })
    .option('filter', {
      type: 'string',
      describe: 'Filtre les articles par nom (contient).'
    })
    .help('h')
    .alias('h', 'help')
    .alias('a', 'apply')
    .argv;

  const filterValue = argv.filter ? argv.filter.toLowerCase() : null;
  const entries = INVENTORY_ENTRIES.filter(entry => {
    if (!filterValue) return true;
    return entry.stockName.toLowerCase().includes(filterValue);
  });

  if (!entries.length) {
    console.log('Aucun article à traiter avec ce filtre.');
    return;
  }

  const serviceAccountPath = path.join(__dirname, SERVICE_ACCOUNT_FILE);
  let serviceAccount;
  try {
    serviceAccount = require(serviceAccountPath);
  } catch (error) {
    console.error('Impossible de charger le fichier service account:', error.message);
    process.exit(1);
  }

  const app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  const db = admin.firestore();

  console.log(`Récupération de ${entries.length} article(s) à mettre à jour...`);
  const snapshot = await db.collection('stock').get();
  const stockEntries = snapshot.docs.map(doc => ({
    id: doc.id,
    ref: doc.ref,
    name: doc.data().name || '',
    data: doc.data()
  }));
  const maps = buildStockMaps(stockEntries);

  const pendingUpdates = [];
  const notFound = [];

  entries.forEach(entry => {
    const match = findStockEntry(entry.stockName, maps);
    if (!match) {
      notFound.push(entry.stockName);
      return;
    }
    const currentBoutique = normalizeNumber(match.data.stockBoutique);
    const currentMagasin = normalizeNumber(match.data.stockMagasin);
    const currentTotal = normalizeNumber(
      match.data.stockTotal !== undefined ? match.data.stockTotal : match.data.stock
    );

    const nextBoutique = normalizeNumber(entry.boutique);
    const nextMagasin = normalizeNumber(entry.magasin);
    const nextTotal = Math.max(0, nextBoutique + nextMagasin);

    const changes = [
      describeChange('Boutique', currentBoutique, nextBoutique),
      describeChange('Magasin', currentMagasin, nextMagasin),
      describeChange('Total', currentTotal, nextTotal)
    ].filter(Boolean);

    if (!changes.length) {
      return;
    }

    pendingUpdates.push({
      name: entry.stockName,
      ref: match.ref,
      before: {
        boutique: currentBoutique,
        magasin: currentMagasin,
        total: currentTotal
      },
      payload: {
        stockBoutique: nextBoutique,
        stockMagasin: nextMagasin,
        stockTotal: nextTotal,
        stock: nextTotal
      }
    });
  });

  if (notFound.length) {
    console.warn('Articles introuvables dans Firestore:');
    notFound.forEach(name => console.warn(` - ${name}`));
  }

  if (!pendingUpdates.length) {
    console.log('Aucune mise à jour nécessaire.');
    await app.delete().catch(() => {});
    process.exit(notFound.length ? 1 : 0);
    return;
  }

  console.log(`Préparation de ${pendingUpdates.length} mise(s) à jour:`);
  pendingUpdates.forEach(item => {
    const parts = [];
    parts.push(describeChange('Boutique', item.before.boutique, item.payload.stockBoutique));
    parts.push(describeChange('Magasin', item.before.magasin, item.payload.stockMagasin));
    parts.push(describeChange('Total', item.before.total, item.payload.stockTotal));
    console.log(` - ${item.name}: ${parts.filter(Boolean).join(' | ')}`);
  });

  if (!argv.apply) {
    console.log('\nSimulation terminée. Relancez avec --apply pour enregistrer.');
    await app.delete().catch(() => {});
    return;
  }

  console.log('\nApplication des mises à jour dans Firestore...');
  const batch = db.batch();
  pendingUpdates.forEach(item => {
    batch.update(item.ref, item.payload);
  });
  await batch.commit();
  console.log(`Mises à jour appliquées: ${pendingUpdates.length}`);

  await app.delete().catch(() => {});
}

main().catch(async error => {
  console.error('Erreur lors de la mise à jour des stocks:', error);
  if (admin.apps.length) {
    await admin.app().delete().catch(() => {});
  }
  process.exit(1);
});
