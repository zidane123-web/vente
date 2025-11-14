#!/usr/bin/env node

/**
 * Audit tool to inspect the Firestore stock history for a given article.
 * Usage:
 *   node audit_stock_movements.js --name "Itel it5626" [--days 3]
 *   node audit_stock_movements.js --id <stockDocId> --since 2025-11-10
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const SERVICE_ACCOUNT_FILE = 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json';
const DEFAULT_LOOKBACK_DAYS = 3;
const DEFAULT_HISTORY_LIMIT = 150;

function printHelp() {
  console.log(`Usage: node audit_stock_movements.js [options]

Options:
  --id <stockDocId>       Identifiant du document dans /stock
  --name <produit>        Nom exact ou approché du produit (ex: "Itel it5626")
  --days <n>              Nombre de jours à analyser (défaut: ${DEFAULT_LOOKBACK_DAYS})
  --since <AAAA-MM-JJ>    Date de début explicite (UTC)
  --limit <n>             Nombre max de mouvements à charger (défaut: ${DEFAULT_HISTORY_LIMIT})
  --search <texte>        Liste les articles dont le nom contient ce texte puis quitte
  --help                  Affiche cette aide

Au moins --id ou --name est requis.`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--id':
        args.id = argv[++i];
        break;
      case '--name':
        args.name = argv[++i];
        break;
      case '--days':
        args.days = Number(argv[++i]);
        break;
      case '--since':
        args.since = argv[++i];
        break;
      case '--limit':
        args.limit = Number(argv[++i]);
        break;
      case '--search':
        args.search = argv[++i];
        break;
      case '--help':
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

function normalizeName(value) {
  if (!value) return '';
  return value
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDateInput(raw) {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Date invalide: ${raw}`);
    }
    return date;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Date invalide: ${raw}`);
  }
  return parsed;
}

function computeStartDate(days) {
  const today = new Date();
  const start = new Date(today);
  start.setHours(0, 0, 0, 0);
  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : DEFAULT_LOOKBACK_DAYS;
  start.setDate(start.getDate() - (safeDays - 1));
  return start;
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
    minute: '2-digit',
    second: '2-digit'
  });
}

function extractName(data) {
  return (
    data?.name ||
    data?.produit ||
    data?.designation ||
    data?.label ||
    data?.modele ||
    ''
  );
}

function extractQuantity(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function extractCurrency(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const normalized = value.replace(/[^0-9.-]/g, '');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
}

async function resolveStockDoc(db, { id, name }) {
  if (id) {
    const snap = await db.collection('stock').doc(id).get();
    if (!snap.exists) {
      throw new Error(`Aucun document stock trouvé pour l'id ${id}`);
    }
    return { id: snap.id, data: snap.data() || {} };
  }

  if (!name) {
    throw new Error('Veuillez fournir --id ou --name');
  }

  const target = normalizeName(name);
  const snapshot = await db.collection('stock').get();
  const matches = [];
  snapshot.forEach(doc => {
    const data = doc.data() || {};
    const docName = extractName(data);
    if (normalizeName(docName) === target) {
      matches.push({ id: doc.id, data });
    }
  });

  if (!matches.length) {
    throw new Error(`Impossible de trouver un article dont le nom correspond à "${name}"`);
  }
  if (matches.length > 1) {
    console.warn(`Plusieurs articles correspondent à "${name}", utilisez --id pour être précis. IDs: ${matches.map(m => m.id).join(', ')}`);
  }
  return matches[0];
}

async function fetchHistoryEntries(db, stockId, options) {
  const limit = Number.isFinite(options.limit) && options.limit > 0
    ? Math.min(options.limit, 500)
    : DEFAULT_HISTORY_LIMIT;

  const historySnap = await db
    .collection('stock')
    .doc(stockId)
    .collection('history')
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .get();

  const entries = historySnap.docs
    .map(doc => {
      const data = doc.data() || {};
      const ts = data.timestamp && typeof data.timestamp.toDate === 'function'
        ? data.timestamp.toDate()
        : null;
      return {
        id: doc.id,
        timestamp: ts,
        ...data
      };
    })
    .sort((a, b) => {
      const ta = a.timestamp instanceof Date ? a.timestamp.getTime() : 0;
      const tb = b.timestamp instanceof Date ? b.timestamp.getTime() : 0;
      return ta - tb;
    });

  let baseline = null;
  const since = options.since;
  const filtered = [];

  entries.forEach(entry => {
    if (!since || !entry.timestamp) {
      filtered.push(entry);
      return;
    }
    if (entry.timestamp < since) {
      baseline = entry;
      return;
    }
    filtered.push(entry);
  });

  return { baseline, filtered, all: entries };
}

async function fetchSalesForProduct(db, normalizedName, sinceDate) {
  if (!sinceDate) return [];
  const startTs = admin.firestore.Timestamp.fromDate(sinceDate);
  const snapshot = await db
    .collection('ventes')
    .where('timestamp', '>=', startTs)
    .orderBy('timestamp', 'asc')
    .get();

  const matches = [];
  snapshot.forEach(doc => {
    const data = doc.data() || {};
    const items = Array.isArray(data.items) ? data.items : [];
    const relevantItems = items.filter(item => normalizeName(extractName(item)) === normalizedName);
    if (!relevantItems.length) return;
    const ts = data.timestamp && typeof data.timestamp.toDate === 'function'
      ? data.timestamp.toDate()
      : null;
    matches.push({
      id: doc.id,
      timestamp: ts,
      status: data.status || data.statut || '',
      client: data.client || data.clientNom || '',
      source: data.source || data.mode || '',
      items: relevantItems
    });
  });
  return matches;
}

async function fetchPurchasesForProduct(db, normalizedName, sinceDate) {
  if (!sinceDate) return [];
  const startTs = admin.firestore.Timestamp.fromDate(sinceDate);
  const snapshot = await db
    .collection('approvisionnement')
    .where('timestamp', '>=', startTs)
    .orderBy('timestamp', 'asc')
    .get();

  const matches = [];
  snapshot.forEach(doc => {
    const data = doc.data() || {};
    const items = Array.isArray(data.items) ? data.items : [];
    const relevantItems = items.filter(item => normalizeName(extractName(item)) === normalizedName);
    if (!relevantItems.length) return;
    const ts = data.timestamp && typeof data.timestamp.toDate === 'function'
      ? data.timestamp.toDate()
      : null;
    matches.push({
      id: doc.id,
      timestamp: ts,
      supplier: data.fournisseur || data.supplier || '',
      location: data.destination || '',
      items: relevantItems
    });
  });
  return matches;
}

function describeHistoryEntry(entry) {
  const change = typeof entry.change === 'number' ? entry.change : Number(entry.change) || 0;
  const newStock = typeof entry.newStock === 'number' ? entry.newStock : Number(entry.newStock);
  const prevStock = Number.isFinite(newStock) ? newStock - change : null;
  return {
    change,
    newStock,
    prevStock
  };
}

function logHistory(entries, sinceDate) {
  if (!entries.length) {
    console.log('Aucun mouvement dans la période demandée.');
    return;
  }
  console.log(`Mouvements depuis ${sinceDate ? formatDateTime(sinceDate) : 'le début'} :`);
  entries.forEach(entry => {
    const { change, newStock, prevStock } = describeHistoryEntry(entry);
    const label = entry.type || 'mouvement';
    const reason = entry.reason ? ` · raison: ${entry.reason}` : '';
    const location = entry.location ? ` · lieu: ${entry.location}` : '';
    const transfer = entry.transferDirection ? ` · transfert: ${entry.transferDirection}` : '';
    const source = entry.sourceApproId ? ` · appro: ${entry.sourceApproId}` : '';
    console.log(
      `  - ${formatDateTime(entry.timestamp)} | ${label.padEnd(26)} | ` +
      `${change > 0 ? '+' : ''}${change} → stock ${Number.isFinite(newStock) ? newStock : 'N/A'}` +
      `${prevStock != null ? ` (avant ${prevStock})` : ''}${reason}${location}${transfer}${source}`
    );
  });
}

function logTransactions(label, list, formatter) {
  if (!list.length) {
    console.log(`${label}: aucun enregistrement.`);
    return;
  }
  console.log(`${label}:`);
  list.forEach(item => {
    console.log(formatter(item));
  });
}

function formatSaleEntry(entry) {
  const totalQty = entry.items.reduce((sum, item) => sum + extractQuantity(item.quantite ?? item.qty ?? item.quantity ?? 0), 0);
  const totalAmount = entry.items.reduce((sum, item) => sum + extractCurrency(item.total ?? item.totalVente ?? item.prixTotal ?? item.lineTotal ?? 0), 0);
  const details = entry.items
    .map(item => {
      const label = extractName(item) || 'Article';
      const qty = extractQuantity(item.quantite ?? item.qty ?? item.quantity ?? 0);
      const unit = formatNumber(item.prix || item.prixUnitaire || item.price || 0);
      return `${label}: ${qty}u @${unit}`;
    })
    .join(', ');
  return `  - ${formatDateTime(entry.timestamp)} | Vente ${entry.id} · ${totalQty}u · ${formatNumber(totalAmount)} FCFA · client: ${entry.client || 'N/A'} · statut: ${entry.status || 'n/a'} (${details})`;
}

function formatPurchaseEntry(entry) {
  const totalQty = entry.items.reduce((sum, item) => sum + extractQuantity(item.quantite ?? item.qty ?? item.quantity ?? 0), 0);
  const totalCost = entry.items.reduce((sum, item) => sum + extractCurrency(item.coutTotal ?? item.totalCost ?? item.totalAchat ?? 0), 0);
  return `  - ${formatDateTime(entry.timestamp)} | Appro ${entry.id} · ${totalQty}u · ${formatNumber(totalCost)} FCFA · fournisseur: ${entry.supplier || 'N/A'} · destination: ${entry.location || 'inconnu'}`;
}

async function listMatchingStockItems(db, query) {
  const normalizedQuery = normalizeName(query);
  const snapshot = await db.collection('stock').get();
  const matches = [];
  snapshot.forEach(doc => {
    const data = doc.data() || {};
    const label = extractName(data);
    const normalizedLabel = normalizeName(label);
    if (
      normalizedLabel.includes(normalizedQuery) ||
      label.toLowerCase().includes(query.toLowerCase())
    ) {
      matches.push({
        id: doc.id,
        name: label,
        stock: data.stockTotal ?? data.stock ?? data.stockBoutique ?? 0
      });
    }
  });
  if (!matches.length) {
    console.log(`Aucun article ne correspond à "${query}".`);
    return;
  }
  matches
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
    .forEach(match => {
      console.log(`${match.id} · ${match.name} · stock: ${formatNumber(match.stock)}`);
    });
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      return;
    }

    const serviceAccountPath = path.join(__dirname, SERVICE_ACCOUNT_FILE);
    if (!fs.existsSync(serviceAccountPath)) {
      throw new Error(`Service account introuvable: ${serviceAccountPath}`);
    }

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountPath)
      });
    }
    const db = admin.firestore();

    if (args.search) {
      await listMatchingStockItems(db, args.search);
      if (!args.id && !args.name) {
        return;
      }
    }

    const stockDoc = await resolveStockDoc(db, { id: args.id, name: args.name });
    const productName = extractName(stockDoc.data) || '(nom indisponible)';
    const normalizedName = normalizeName(productName);
    const sinceDate = args.since ? parseDateInput(args.since) : computeStartDate(args.days || DEFAULT_LOOKBACK_DAYS);
    const boutique = Number(stockDoc.data.stockBoutique ?? 0);
    const magasin = Number(stockDoc.data.stockMagasin ?? 0);
    const rawTotal = stockDoc.data.stockTotal ?? stockDoc.data.stock;
    const total = Number(rawTotal != null ? rawTotal : boutique + magasin);
    console.log(`Article ciblé: ${productName} (${stockDoc.id})`);
    console.log(`Stock déclaré: ${formatNumber(total)} (boutique ${formatNumber(boutique)} · magasin ${formatNumber(magasin)})`);
    console.log(`Fenêtre analysée depuis: ${formatDateTime(sinceDate)}`);

    const history = await fetchHistoryEntries(db, stockDoc.id, {
      since: sinceDate,
      limit: args.limit
    });
    let baselineStockValue = null;
    if (history.baseline) {
      const baselineInfo = describeHistoryEntry(history.baseline);
      baselineStockValue = Number.isFinite(baselineInfo.newStock) ? baselineInfo.newStock : null;
      const baselineTime = history.baseline.timestamp
        ? formatDateTime(history.baseline.timestamp)
        : 'date inconnue';
      console.log(
        `Stock juste avant ${formatDateTime(sinceDate)}: ` +
        `${baselineInfo.newStock != null ? `${baselineInfo.newStock}` : 'inconnu'} ` +
        `(mouvement ${history.baseline.id} · ${history.baseline.type || 'type inconnu'} le ${baselineTime})`
      );
    } else {
      console.log('Impossible de déterminer le stock juste avant la période (pas de mouvement plus ancien dans la limite).');
    }

    logHistory(history.filtered, sinceDate);

    const sales = await fetchSalesForProduct(db, normalizedName, sinceDate);
    const purchases = await fetchPurchasesForProduct(db, normalizedName, sinceDate);

    logTransactions('Ventes correspondantes', sales, formatSaleEntry);
    const totalSaleQty = sales.reduce((sum, sale) => {
      const saleQty = sale.items.reduce((acc, item) => acc + extractQuantity(item.quantite ?? item.qty ?? item.quantity ?? 0), 0);
      return sum + saleQty;
    }, 0);
    if (totalSaleQty > 0) {
      console.log(`→ Total vendu sur la période: ${formatNumber(totalSaleQty)} unités`);
    }

    logTransactions('Approvisionnements correspondants', purchases, formatPurchaseEntry);
    const totalPurchaseQty = purchases.reduce((sum, appro) => {
      const qty = appro.items.reduce((acc, item) => acc + extractQuantity(item.quantite ?? item.qty ?? item.quantity ?? 0), 0);
      return sum + qty;
    }, 0);
    if (totalPurchaseQty > 0) {
      console.log(`→ Total approvisionné sur la période: ${formatNumber(totalPurchaseQty)} unités`);
    }

    if (baselineStockValue != null && (totalPurchaseQty > 0 || totalSaleQty > 0)) {
      const theoreticalStock = baselineStockValue + totalPurchaseQty - totalSaleQty;
      console.log(
        `[Synthèse] Stock théorique = ${formatNumber(theoreticalStock)} ` +
        `| Stock Firestore = ${formatNumber(total)} ` +
        `| Ecart = ${formatNumber(theoreticalStock - total)}`
      );
    }
  } catch (error) {
    console.error('Erreur lors de l’audit:', error);
    process.exitCode = 1;
  } finally {
    if (admin.apps.length) {
      await admin.app().delete().catch(() => {});
    }
  }
}

main();
