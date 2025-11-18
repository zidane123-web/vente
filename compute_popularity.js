#!/usr/bin/env node

/**
 * Calcule un score de popularité par article sur les 30 derniers jours,
 * convertit ce score en étoiles (1 à 5) puis écrit le résultat dans chaque
 * document de la collection "stock". Produit également un résumé en console.
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const SERVICE_ACCOUNT_FILE = 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json';
const DAYS_WINDOW = 30;
const RECENT_DAYS = 7;
const STALE_DAYS = 90;

/**
 * Récupère un objet Date représentant "maintenant - n jours".
 */
function daysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return fallback;
}

function ensureFirebase() {
  if (!admin.apps.length) {
    const absolute = path.resolve(__dirname, SERVICE_ACCOUNT_FILE);
    if (!fs.existsSync(absolute)) {
      throw new Error(`Service account introuvable: ${absolute}`);
    }
    admin.initializeApp({
      credential: admin.credential.cert(require(absolute))
    });
  }
  return admin.firestore();
}

async function fetchStockDocs(db) {
  const snapshot = await db.collection('stock').get();
  const documents = [];
  snapshot.forEach(doc => {
    documents.push({ id: doc.id, data: doc.data() || {} });
  });
  return documents;
}

async function fetchRecentSales(db) {
  const since = daysAgo(DAYS_WINDOW);
  const snapshot = await db.collection('ventes')
    .where('timestamp', '>=', admin.firestore.Timestamp.fromDate(since))
    .get();
  const ventes = [];
  snapshot.forEach(doc => {
    ventes.push({ id: doc.id, data: doc.data() || {} });
  });
  return ventes;
}

function computeDemandScores(stockDocs, sales) {
  const thirtyDaysAgo = daysAgo(DAYS_WINDOW);
  const sevenDaysAgo = daysAgo(RECENT_DAYS);
  const ninetyDaysAgo = daysAgo(STALE_DAYS);

  const entries = new Map();

  const getEntry = (name) => {
    if (!entries.has(name)) {
      entries.set(name, {
        name,
        volumePoints: 0,
        recentVolumePoints: 0,
        historicVolumePoints: 0,
        frequencyPoints: 0,
        totalUnits: 0,
        salesCount: 0,
        lastSaleAt: null
      });
    }
    return entries.get(name);
  };

  for (const sale of sales) {
    const data = sale.data;
    const saleTimestamp = data.timestamp && typeof data.timestamp.toDate === 'function'
      ? data.timestamp.toDate()
      : null;
    if (!saleTimestamp || saleTimestamp < thirtyDaysAgo) {
      continue;
    }
    const isRecent = saleTimestamp >= sevenDaysAgo;
    const weight = isRecent ? 2 : 1;
    const saleProducts = new Set();

    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      const productName = (item.produit || item.name || '').trim();
      if (!productName) {
        continue;
      }
      const quantity = toNumber(item.quantite || item.qty || item.quantity, 0);
      if (quantity <= 0) {
        continue;
      }
      const entry = getEntry(productName);
      entry.totalUnits += quantity;
      entry.volumePoints += quantity * weight;
      if (isRecent) {
        entry.recentVolumePoints += quantity * weight;
      } else {
        entry.historicVolumePoints += quantity * weight;
      }
      if (!saleProducts.has(productName)) {
        entry.frequencyPoints += 1;
        entry.salesCount += 1;
        saleProducts.add(productName);
      }
      if (!entry.lastSaleAt || saleTimestamp > entry.lastSaleAt) {
        entry.lastSaleAt = saleTimestamp;
      }
    }
  }

  const stockByName = new Map();
  for (const doc of stockDocs) {
    const name = (doc.data.name || '').trim();
    if (!name) continue;
    stockByName.set(name, doc);
    if (!entries.has(name)) {
      entries.set(name, {
        name,
        volumePoints: 0,
        recentVolumePoints: 0,
        historicVolumePoints: 0,
        frequencyPoints: 0,
        totalUnits: 0,
        salesCount: 0,
        lastSaleAt: null
      });
    }
  }

  const list = [];
  entries.forEach((entry, name) => {
    const stockDoc = stockByName.get(name);
    const createdAt = stockDoc?.data?.createdAt;
    const createdAtDate = createdAt && typeof createdAt.toDate === 'function' ? createdAt.toDate() : null;
    const categoryRaw = (stockDoc?.data?.category || '').toString().toLowerCase().trim();
    const category = categoryRaw || 'autre';
    const demandScore = entry.volumePoints + entry.frequencyPoints;
    const status = {};
    const isNewProduct = createdAtDate ? createdAtDate >= sevenDaysAgo : false;
    const hasSalesLast90 = entry.lastSaleAt ? entry.lastSaleAt >= ninetyDaysAgo : false;

    status.isNew = isNewProduct;
    status.isStale = !hasSalesLast90;

    list.push({
      name,
      category,
      demandScore,
      ...entry,
      status,
      createdAt: createdAtDate,
      stockDocId: stockDoc?.id || null
    });
  });

  return list;
}

function assignStars(entries) {
  const byCategory = new Map();
  entries.forEach(entry => {
    const key = entry.category || 'autre';
    if (!byCategory.has(key)) {
      byCategory.set(key, []);
    }
    byCategory.get(key).push(entry);
  });

  const TOP_N = 5;

  byCategory.forEach(group => {
    if (!group.length) {
      return;
    }
    const sorted = group.slice().sort((a, b) => b.demandScore - a.demandScore);
    const positives = sorted.filter(entry => entry.demandScore > 0);
    const maxScore = positives.length ? positives[0].demandScore : 0;
    if (!positives.length || maxScore <= 0) {
      sorted.forEach(entry => {
        entry.baseStars = 1;
      });
      return;
    }

    const ratioToStars = (ratio) => {
      if (ratio >= 0.8) return 5;
      if (ratio >= 0.5) return 4;
      if (ratio >= 0.2) return 3;
      return 2;
    };

    sorted.forEach(entry => {
      if (entry.demandScore <= 0) {
        entry.baseStars = 1;
        return;
      }
      const ratio = entry.demandScore / maxScore;
      entry.baseStars = ratioToStars(ratio);
    });
  });
}

function applyOverrides(entry) {
  let stars = entry.baseStars || 1;
  let demandStatus = 'normal';
  const hasDemand = (entry.demandScore > 0) && (entry.totalUnits > 0);

  if (!hasDemand) {
    stars = 1;
    demandStatus = 'no-sales';
  } else if (entry.status.isNew) {
    demandStatus = 'new';
  } else if (entry.status.isStale) {
    demandStatus = 'stale';
  }
  entry.demandStars = stars;
  entry.demandStatus = demandStatus;
  return entry;
}

async function updateStockDocs(db, entries) {
  const BATCH_LIMIT = 400;
  let batch = db.batch();
  const results = [];
  let writesInBatch = 0;
  const commitBatch = async () => {
    if (writesInBatch === 0) return;
    await batch.commit();
    batch = db.batch();
    writesInBatch = 0;
  };

  for (const entry of entries) {
    if (!entry.stockDocId) continue;
    const docRef = db.collection('stock').doc(entry.stockDocId);
    const payload = {
      demandScore: entry.demandScore,
      demandStars: entry.demandStars,
      demandStatus: entry.demandStatus,
      demandBreakdown: {
        volumePoints: entry.volumePoints,
        recentVolumePoints: entry.recentVolumePoints,
        historicVolumePoints: entry.historicVolumePoints,
        frequencyPoints: entry.frequencyPoints,
        totalUnits: entry.totalUnits,
        salesCount: entry.salesCount,
        lastSaleAt: entry.lastSaleAt || null
      },
      demandLastComputedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    batch.set(docRef, payload, { merge: true });
    writesInBatch += 1;
    results.push(entry);
    if (writesInBatch >= BATCH_LIMIT) {
      await commitBatch();
    }
  }

  await commitBatch();
  return results;
}

function printSummary(entries) {
  const sorted = entries.slice().sort((a, b) => b.demandScore - a.demandScore);
  console.log('\n=== Top 15 articles (par score de demande) ===');
  sorted.slice(0, 15).forEach((entry, index) => {
    const lastSaleLabel = entry.lastSaleAt ? entry.lastSaleAt.toISOString().slice(0, 10) : 'Jamais';
    console.log(
      `${index + 1}. ${entry.name} — score ${entry.demandScore.toFixed(1)} — ${'★'.repeat(entry.demandStars)} ` +
      `(volume:${entry.totalUnits}, tickets:${entry.salesCount}, dernier:${lastSaleLabel}, statut:${entry.demandStatus})`
    );
  });

  const ruptures = entries
    .filter(entry => {
      const totalStock = toNumber(entry.stockTotal ?? entry.stock);
      return totalStock <= 1;
    })
    .sort((a, b) => b.demandStars - a.demandStars || b.demandScore - a.demandScore);

  if (ruptures.length) {
    console.log('\n=== Articles en rupture/priorité (stock <= 1) ===');
    ruptures.slice(0, 20).forEach(entry => {
      console.log(
        `${entry.name} — ${'★'.repeat(entry.demandStars)} — stock:${entry.stockTotal ?? entry.stock ?? 'N/A'} — score:${entry.demandScore.toFixed(1)}`
      );
    });
  }
}

async function main() {
  const db = ensureFirebase();
  console.log('Chargement du stock…');
  const stockDocs = await fetchStockDocs(db);
  console.log(`Stock: ${stockDocs.length} articles.`);

  console.log(`Analyse des ventes sur ${DAYS_WINDOW} jours…`);
  const sales = await fetchRecentSales(db);
  console.log(`Ventes chargées: ${sales.length}.`);

  let entries = computeDemandScores(stockDocs, sales);
  entries = entries.map(entry => {
    const stockDoc = stockDocs.find(doc => doc.id === entry.stockDocId);
    const stockTotal = stockDoc?.data?.stockTotal ?? stockDoc?.data?.stock ?? null;
    return { ...entry, stockTotal };
  });

  assignStars(entries);
  entries = entries.map(applyOverrides);
  await updateStockDocs(db, entries);
  printSummary(entries);
}

main()
  .catch(error => {
    console.error('Erreur lors du calcul de popularité:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (admin.apps.length) {
      await admin.app().delete().catch(() => {});
    }
  });
