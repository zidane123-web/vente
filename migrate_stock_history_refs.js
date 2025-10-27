#!/usr/bin/env node
/**
 * Migration script pour enrichir les mouvements d'achat existants dans
 * stock/<article>/history avec { sourceApproId, sourceApproItemName }.
 *
 * Usage:
 *   node migrate_stock_history_refs.js [--dry-run]
 *
 * --dry-run  : effectue l'analyse sans écrire en base.
 */

const path = require('path');
const admin = require('firebase-admin');

const DRY_RUN = process.argv.includes('--dry-run');
const SERVICE_ACCOUNT_PATH = path.resolve(
  __dirname,
  'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json'
);

// Initialisation Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(require(SERVICE_ACCOUNT_PATH)),
});

const db = admin.firestore();

// Utilitaires de normalisation -------------------------------------------------
function normalizeName(raw) {
  return (raw || '').toString().trim().toLowerCase();
}

function simplifyName(raw) {
  return normalizeName(raw)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function toDate(ts) {
  if (!ts) return null;
  if (ts instanceof Date) return ts;
  if (typeof ts === 'number') return new Date(ts);
  if (typeof ts === 'string') {
    const parsed = new Date(ts);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof ts.toDate === 'function') {
    return ts.toDate();
  }
  return null;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Construction de l'index d'approvisionnements ---------------------------------
async function buildApproIndex() {
  const index = [];
  const approSnap = await db.collection('approvisionnement').get();
  console.log(`Approvisionnements chargés: ${approSnap.size}`);

  for (const doc of approSnap.docs) {
    const data = doc.data() || {};
    const approId = doc.id;
    const baseTimestamp = toDate(data.timestamp) || toDate(data.createdAt) || null;
    const items = Array.isArray(data.items) ? data.items : [];

    for (const item of items) {
      const product = item.produit || item.name || '';
      const quantity = toNumber(item.quantite);
      index.push({
        type: 'approvisionnement',
        approId,
        productName: product,
        productNorm: normalizeName(product),
        productSimple: simplifyName(product),
        quantity,
        timestamp: baseTimestamp,
      });
    }

    // Récupération des réceptions partielles éventuelles
    try {
      const receptionsSnap = await doc.ref.collection('receptions').get();
      receptionsSnap.forEach(receptionDoc => {
        const receptionData = receptionDoc.data() || {};
        const receptionTs =
          toDate(receptionData.timestamp) ||
          toDate(receptionData.date) ||
          toDate(receptionData.createdAt) ||
          baseTimestamp;
        const lignes = Array.isArray(receptionData.lignes) ? receptionData.lignes : [];
        lignes.forEach(ligne => {
          const product = ligne.produit || '';
          const quantity = toNumber(ligne.quantite);
          index.push({
            type: 'approvisionnement-reception',
            approId,
            productName: product,
            productNorm: normalizeName(product),
            productSimple: simplifyName(product),
            quantity,
            timestamp: receptionTs,
          });
        });
      });
    } catch (err) {
      console.warn(`Impossible de lire les réceptions pour ${approId}: ${err.message}`);
    }
  }

  return index;
}

// Correspondance d'un mouvement d'historique avec un approvisionnement ----------
function isProductMatch(entry, productNorm, productSimple) {
  if (!entry.productNorm && !entry.productSimple) return false;
  if (entry.productNorm === productNorm || entry.productSimple === productSimple) return true;
  if (productNorm && entry.productNorm && productNorm.includes(entry.productNorm)) return true;
  if (productNorm && entry.productNorm && entry.productNorm.includes(productNorm)) return true;
  if (
    productSimple &&
    entry.productSimple &&
    (productSimple.includes(entry.productSimple) || entry.productSimple.includes(productSimple))
  ) {
    return true;
  }
  return false;
}

function findBestCandidate({ entries, histType, productNorm, productSimple, change, histDate }) {
  const absChange = Math.abs(toNumber(change) || 0);
  const primary = entries.filter(
    entry => entry.type === histType && !entry.used && isProductMatch(entry, productNorm, productSimple)
  );
  const secondary =
    primary.length > 0
      ? []
      : entries.filter(
          entry => entry.type === histType && isProductMatch(entry, productNorm, productSimple)
        );
  const candidates = primary.length > 0 ? primary : secondary;
  if (!candidates.length) {
    return null;
  }

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;

  candidates.forEach(entry => {
    const qty =
      entry.quantity != null && Number.isFinite(entry.quantity)
        ? Math.abs(entry.quantity)
        : null;
    const qtyDiff = qty != null ? Math.abs(qty - absChange) : null;
    const timeDiff =
      histDate && entry.timestamp ? Math.abs(entry.timestamp - histDate) : Number.NaN;

    const qtyPenalty = qtyDiff != null ? qtyDiff : 5;
    const timePenalty = Number.isNaN(timeDiff) ? 5 * 24 * 60 * 60 * 1000 : timeDiff; // 5 jours sans timestamp
    const score = qtyPenalty * 1e9 + timePenalty;

    if (score < bestScore) {
      bestScore = score;
      best = entry;
    }
  });

  if (!best) {
    return null;
  }

  const timeAcceptable =
    !histDate ||
    !best.timestamp ||
    Math.abs(best.timestamp - histDate) <= 5 * 24 * 60 * 60 * 1000; // ±5 jours
  const qtyAcceptable =
    best.quantity == null || Math.abs(Math.abs(best.quantity) - absChange) <= 0.001;

  if (!timeAcceptable && !qtyAcceptable) {
    return null;
  }

  return best;
}

// Migration principale ---------------------------------------------------------
async function migrate() {
  const entries = await buildApproIndex();
  console.log(`Index approvisionnements prêt (${entries.length} entrées).`);

  const stockSnap = await db.collection('stock').get();
  console.log(`Articles stock trouvés: ${stockSnap.size}`);

  let updated = 0;
  let skippedLinked = 0;
  const unmatched = [];

  for (const stockDoc of stockSnap.docs) {
    const stockData = stockDoc.data() || {};
    const stockName = stockData.name || '';
    const productNorm = normalizeName(stockName);
    const productSimple = simplifyName(stockName);

    const historySnap = await stockDoc.ref
      .collection('history')
      .where('type', 'in', ['approvisionnement', 'approvisionnement-reception'])
      .get();

    if (historySnap.empty) continue;

    for (const historyDoc of historySnap.docs) {
      const data = historyDoc.data() || {};
      if (data.sourceApproId && data.sourceApproItemName) {
        skippedLinked += 1;
        continue;
      }

      const histType = data.type;
      const histDate = toDate(data.timestamp) || toDate(data.date) || toDate(data.createdAt);
      const change = toNumber(data.change) || 0;

      const candidate = findBestCandidate({
        entries,
        histType,
        productNorm,
        productSimple,
        change,
        histDate,
      });

      if (!candidate) {
        unmatched.push({
          stockId: stockDoc.id,
          historyId: historyDoc.id,
          type: histType,
          change,
          stockName,
          timestamp: histDate ? histDate.toISOString() : null,
        });
        continue;
      }

      if (!DRY_RUN) {
        await historyDoc.ref.update({
          sourceApproId: candidate.approId,
          sourceApproItemName: candidate.productName,
        });
      }
      candidate.used = true;
      updated += 1;
    }
  }

  console.log(`Mouvements déjà liés ignorés: ${skippedLinked}`);
  console.log(
    `${DRY_RUN ? '[DRY-RUN] ' : ''}Mouvements enrichis: ${updated}`
  );

  if (unmatched.length) {
    console.log(
      `Mouvements restés sans correspondance (${unmatched.length}) :`
    );
    unmatched.slice(0, 20).forEach(item => {
      console.log(
        `- stock=${item.stockId} (${item.stockName}) history=${item.historyId} type=${item.type} change=${item.change} date=${item.timestamp}`
      );
    });
    if (unmatched.length > 20) {
      console.log('... (liste tronquée)');
    }
  }
}

migrate()
  .then(() => {
    console.log('Migration terminée.');
    if (DRY_RUN) {
      console.log('Aucun enregistrement modifié (mode dry run).');
    }
    return process.exit(0);
  })
  .catch(err => {
    console.error('Erreur pendant la migration:', err);
    process.exit(1);
  });
