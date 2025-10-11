const admin = require('firebase-admin');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_OPTIONS = {
  days: 30,
  horizon: 4,
  maxDays: 10,
  budget: 3_000_000,
  currency: 'XOF',
  category: 'telephones',
  purchaseLookbackDays: 120,
  top: 10,
  maxRecommendations: Number.POSITIVE_INFINITY
};

const serviceAccountPath = path.join(__dirname, 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json');
const serviceAccount = require(serviceAccountPath);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

function parseArgs(defaults) {
  const options = { ...defaults };
  for (const raw of process.argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const [key, value] = raw.slice(2).split('=');
    if (!key) continue;
    const normalizedKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (value === undefined || value === '') {
      options[normalizedKey] = true;
      continue;
    }
    const numeric = Number(value);
    options[normalizedKey] = Number.isNaN(numeric) ? value : numeric;
  }
  if (typeof options.category === 'string') {
    options.category = options.category.toLowerCase();
  }
  if (!Number.isFinite(options.maxRecommendations) || options.maxRecommendations <= 0) {
    options.maxRecommendations = Number.POSITIVE_INFINITY;
  }
  if (!Number.isFinite(options.maxDays) || options.maxDays <= 0) {
    options.maxDays = defaults.maxDays;
  }
  options.maxDays = Math.max(options.maxDays, options.horizon);
  return options;
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const normalized = trimmed.replace(/[^0-9.,-]/g, '').replace(/,/g, '.');
    const parsed = parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value.toMillis === 'function') {
    return value.toMillis();
  }
  if (value && typeof value.seconds === 'number') {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return 0;
}

function getItemName(item) {
  return (
    item?.produit ??
    item?.name ??
    item?.designation ??
    item?.label ??
    ''
  );
}

function getItemQuantity(item) {
  return toNumber(
    item?.quantite ??
    item?.quantity ??
    item?.qty ??
    0
  );
}

function ensureRecord(map, name) {
  let record = map.get(name);
  if (!record) {
    record = {
      name,
      categories: new Set(),
      sales: {
        totalQty: 0,
        totalRevenue: 0,
        totalCost: 0,
        totalProfit: 0,
        count: 0,
        firstTs: null,
        lastTs: null,
        saleDays: new Set()
      },
      purchases: {
        totalQty: 0,
        totalCost: 0,
        history: [],
        lastPurchase: null
      },
      recent: {
        salesQty: 0,
        salesRevenue: 0,
        profit: 0,
        saleDays: new Set(),
        purchaseQty: 0,
        purchaseCost: 0
      }
    };
    map.set(name, record);
  }
  return record;
}

function formatCurrency(amount, currency) {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0
  }).format(Math.round(amount));
}

function formatNumber(value, digits = 2) {
  return Number(value || 0).toLocaleString('fr-FR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function toMillis(value) {
  if (!value && value !== 0) return null;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toDate === 'function') {
    return value.toDate().getTime();
  }
  if (value && typeof value.seconds === 'number') {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return Number(value) || null;
}

async function fetchCollectionOrdered(collectionName) {
  const snapshot = await db.collection(collectionName).orderBy('timestamp', 'desc').get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function main() {
  const options = parseArgs(DEFAULT_OPTIONS);
  const now = new Date();
  const analysisStart = new Date(now.getTime() - options.days * DAY_MS);
  const purchaseStart = new Date(now.getTime() - options.purchaseLookbackDays * DAY_MS);

  console.log(`Analyse des ventes de ${analysisStart.toISOString().slice(0, 10)} à ${now.toISOString().slice(0, 10)} (catégorie: ${options.category || 'toutes'})`);

  const [salesDocs, purchaseDocs] = await Promise.all([
    fetchCollectionOrdered('ventes'),
    fetchCollectionOrdered('approvisionnement')
  ]);

  const stats = new Map();

  // Agrégation ventes
  for (const sale of salesDocs) {
    const ts = toMillis(sale.timestamp);
    if (!ts) continue;

    const saleItems = Array.isArray(sale.items) ? sale.items : [];
    if (saleItems.length === 0) continue;

    const saleDateKey = new Date(ts).toISOString().slice(0, 10);
    const inWindow = ts >= analysisStart.getTime();

    for (const item of saleItems) {
      const rawName = getItemName(item);
      const name = typeof rawName === 'string' ? rawName.trim() : '';
      if (!name) continue;

      const category = (item.category || '').toLowerCase() || 'inconnu';
      if (options.category && category !== options.category) continue;

      const record = ensureRecord(stats, name);
      record.categories.add(category);

      const qty = getItemQuantity(item);
      if (!qty || qty <= 0) continue;

      const unitPrice = toNumber(item.prix ?? item.price ?? 0);
      const lineTotal = toNumber(item.total ?? (unitPrice * qty));
      const unitCost = toNumber(item.coutAchat ?? 0);
      const lineCost = unitCost ? unitCost * qty : 0;
      const profit = toNumber(item.profitTotal ?? (lineTotal - lineCost));

      record.sales.totalQty += qty;
      record.sales.totalRevenue += lineTotal;
      record.sales.totalCost += lineCost;
      record.sales.totalProfit += profit;
      record.sales.count += 1;
      record.sales.saleDays.add(saleDateKey);
      record.sales.firstTs = record.sales.firstTs ? Math.min(record.sales.firstTs, ts) : ts;
      record.sales.lastTs = record.sales.lastTs ? Math.max(record.sales.lastTs, ts) : ts;

      if (inWindow) {
        record.recent.salesQty += qty;
        record.recent.salesRevenue += lineTotal;
        record.recent.profit += profit;
        record.recent.saleDays.add(saleDateKey);
      }
    }
  }

  // Agrégation approvisionnements
  for (const purchase of purchaseDocs) {
    const ts = toMillis(purchase.timestamp);
    if (!ts) continue;

    const items = Array.isArray(purchase.items) ? purchase.items : [];
    if (items.length === 0) continue;

    const inPurchaseWindow = ts >= purchaseStart.getTime();

    for (const item of items) {
      const rawName = getItemName(item);
      const name = typeof rawName === 'string' ? rawName.trim() : '';
      if (!name) continue;

      const category = (item.category || '').toLowerCase() || 'inconnu';
      if (options.category && category !== options.category) continue;

      const record = ensureRecord(stats, name);
      record.categories.add(category);

      const qty = getItemQuantity(item);
      if (!qty || qty <= 0) continue;

      const unitCost =
        toNumber(item.adjustedPrixAchat) ||
        toNumber(item.prixAchat) ||
        (qty ? toNumber(item.coutTotal) / qty : 0);
      const totalCost = unitCost * qty;

      record.purchases.totalQty += qty;
      record.purchases.totalCost += totalCost;
      record.purchases.history.push({ ts, qty, unitCost, totalCost });

      if (!record.purchases.lastPurchase || ts > record.purchases.lastPurchase.ts) {
        record.purchases.lastPurchase = { ts, unitCost };
      }

      if (inPurchaseWindow) {
        record.recent.purchaseQty += qty;
        record.recent.purchaseCost += totalCost;
      }
    }
  }

  const results = [];
  for (const record of stats.values()) {
    if (record.recent.salesQty <= 0) continue;

    const analysisDays = Math.max(1, options.days);
    const avgDailySales = record.recent.salesQty / analysisDays;
    const activeSaleDays = record.recent.saleDays.size || 1;
    const avgPerSaleDay = record.recent.salesQty / activeSaleDays;

    const lastUnitCost =
      record.purchases.lastPurchase?.unitCost ||
      (record.sales.totalCost && record.sales.totalQty
        ? record.sales.totalCost / record.sales.totalQty
        : 0);

    const stock = record.purchases.totalQty - record.sales.totalQty;
    const recommendedDemand = avgDailySales * options.horizon;
    const projectedNeeded = Math.ceil(Math.max(0, recommendedDemand - Math.max(0, stock)));
    const projectedCost = lastUnitCost * projectedNeeded;
    const sellThroughRatio = record.recent.purchaseQty > 0
      ? record.recent.salesQty / record.recent.purchaseQty
      : null;

    results.push({
      name: record.name,
      categories: Array.from(record.categories),
      avgDailySales,
      avgPerSaleDay,
      activeSaleDays,
      salesQty: record.recent.salesQty,
      salesRevenue: record.recent.salesRevenue,
      salesProfit: record.recent.profit,
      stock,
      recentPurchaseQty: record.recent.purchaseQty,
      recentPurchaseCost: record.recent.purchaseCost,
      lastUnitCost,
      recommendedDemand,
      projectedNeeded,
      projectedCost,
      sellThroughRatio
    });
  }

  if (results.length === 0) {
    console.log('Aucune vente trouvée sur la période.');
    await admin.app().delete();
    return;
  }

  results.sort((a, b) => b.avgDailySales - a.avgDailySales);

  console.log(`\nTop ${Math.min(options.top, results.length)} téléphones qui tournent le plus vite:`);
  results.slice(0, options.top).forEach((item, index) => {
    const stockDisplay = item.stock != null ? ` | Stock estimé: ${item.stock}` : '';
    const costDisplay = item.lastUnitCost ? ` | Coût achat estimé: ${formatCurrency(item.lastUnitCost, options.currency)}` : '';
    const ratioDisplay = item.sellThroughRatio != null
      ? ` | Sell-through: ${formatNumber(item.sellThroughRatio, 1)}`
      : '';
    console.log(
      `${index + 1}. ${item.name} | ${formatNumber(item.avgDailySales)} u/jour | Qté vendue: ${item.salesQty}${stockDisplay}${costDisplay}${ratioDisplay}`
    );
  });

  let remainingBudget = options.budget;
  let budgetUsed = 0;
  const fastPlan = [];
  const extendedPlan = [];
  const minUnitCost = results.reduce((min, item) => {
    if (item.lastUnitCost && item.lastUnitCost > 0) {
      return Math.min(min, item.lastUnitCost);
    }
    return min;
  }, Number.POSITIVE_INFINITY);

  for (const item of results) {
    if (!item.lastUnitCost || item.lastUnitCost <= 0) continue;
    if (remainingBudget < item.lastUnitCost) continue;

    const affordableQty = Math.floor(remainingBudget / item.lastUnitCost);
    if (affordableQty <= 0) continue;

    const positiveStock = Math.max(0, item.stock ?? 0);
    const maxQtyWithinMaxDays = Math.max(
      0,
      Math.ceil(item.avgDailySales * options.maxDays - positiveStock)
    );
    if (maxQtyWithinMaxDays <= 0) continue;

    const qty = Math.min(maxQtyWithinMaxDays, affordableQty);
    if (qty <= 0) continue;

    const cost = qty * item.lastUnitCost;
    const expectedDays = item.avgDailySales > 0 ? qty / item.avgDailySales : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(expectedDays) || expectedDays > options.maxDays) continue;

    const entry = {
      name: item.name,
      qty,
      unitCost: item.lastUnitCost,
      cost,
      avgDailySales: item.avgDailySales,
      expectedDays,
      stock: item.stock
    };

    if (expectedDays <= options.horizon) {
      fastPlan.push(entry);
    } else {
      extendedPlan.push(entry);
    }

    remainingBudget -= cost;
    budgetUsed += cost;

    if (remainingBudget < minUnitCost) {
      break;
    }
  }

  console.log(`\nPlan principal (<= ${options.horizon} jours):`);
  if (fastPlan.length === 0) {
    console.log('Aucun article ne peut être écoulé dans la fenêtre demandée avec le stock actuel.');
  } else {
    fastPlan.forEach((rec, idx) => {
      const stockText = rec.stock != null ? ` | Stock actuel: ${rec.stock}` : '';
      console.log(
        `${idx + 1}. ${rec.name} -> Qté: ${rec.qty} | Coût unitaire: ${formatCurrency(rec.unitCost, options.currency)} | Ligne: ${formatCurrency(rec.cost, options.currency)} | Vitesse: ${formatNumber(rec.avgDailySales)} u/jour | Écoulement estimé: ${formatNumber(rec.expectedDays, 1)} jours${stockText}`
      );
    });
  }

  console.log(`\nCompléments rapides (<= ${options.maxDays} jours):`);
  if (extendedPlan.length === 0) {
    console.log('Pas de compléments nécessaires ou budget insuffisant pour des articles supplémentaires.');
  } else {
    extendedPlan.forEach((rec, idx) => {
      const stockText = rec.stock != null ? ` | Stock actuel: ${rec.stock}` : '';
      console.log(
        `${idx + 1}. ${rec.name} -> Qté: ${rec.qty} | Coût unitaire: ${formatCurrency(rec.unitCost, options.currency)} | Ligne: ${formatCurrency(rec.cost, options.currency)} | Vitesse: ${formatNumber(rec.avgDailySales)} u/jour | Écoulement estimé: ${formatNumber(rec.expectedDays, 1)} jours${stockText}`
      );
    });
  }

  console.log(`\nBudget utilisé: ${formatCurrency(budgetUsed, options.currency)} | Budget restant: ${formatCurrency(remainingBudget, options.currency)}`);

  const skippedForCost = results.filter(item => item.projectedNeeded > 0 && (!item.lastUnitCost || item.lastUnitCost <= 0));
  if (skippedForCost.length > 0) {
    console.log('\nArticles ignorés faute de coût d\'achat fiable:');
    skippedForCost.slice(0, 5).forEach(item => {
      console.log(`- ${item.name} (Qté projetée ${item.projectedNeeded}, ventes ${item.salesQty})`);
    });
    if (skippedForCost.length > 5) {
      console.log(`  ... ${skippedForCost.length - 5} autres`);
    }
  }

  if (remainingBudget > 0 && remainingBudget < minUnitCost && Number.isFinite(minUnitCost)) {
    console.log(`\nBudget résiduel insuffisant pour le moindre article (reste ${formatCurrency(remainingBudget, options.currency)}).`);
  }

  await admin.app().delete();
}

main().catch(err => {
  console.error('Erreur lors de la recommandation:', err);
  admin.app().delete().catch(() => {});
  process.exit(1);
});
