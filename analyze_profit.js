const admin = require('firebase-admin');
const path = require('path');

const serviceAccountPath = path.join(__dirname, 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json');
const serviceAccount = require(serviceAccountPath);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

const START_DATE = new Date('2025-10-01T00:00:00Z');
const END_DATE = new Date();

const startMs = START_DATE.getTime();
const endMs = END_DATE.getTime();
const startTimestamp = admin.firestore.Timestamp.fromDate(START_DATE);
const endTimestamp = admin.firestore.Timestamp.fromDate(END_DATE);

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const normalized = value.replace(/[^0-9.,-]/g, '').replace(/,/g, '.');
    const parsed = parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value.toMillis === 'function') {
    return value.toMillis();
  }
  return 0;
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

function formatCurrency(amount) {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'XOF',
    maximumFractionDigits: 0
  }).format(Math.round(amount));
}

function getItemName(item) {
  return (
    item.produit ||
    item.name ||
    item.designation ||
    item.label ||
    'Article inconnu'
  );
}

function getItemQuantity(item) {
  return toNumber(item.quantite ?? item.quantity ?? item.qty ?? 0);
}

function computeItemProfit(item) {
  if (item == null || typeof item !== 'object') return 0;
  if (item.profitTotal != null) {
    return toNumber(item.profitTotal);
  }
  const unitPrice = toNumber(item.prix ?? item.price ?? item.prixVente ?? item.sellingPrice ?? 0);
  const unitCost = toNumber(
    item.coutAchat ??
    item.cout ??
    item.prixAchat ??
    item.purchasePrice ??
    0
  );
  const qty = getItemQuantity(item);
  return (unitPrice - unitCost) * qty;
}

function computeItemCost(item) {
  const unitCost = toNumber(
    item.coutAchat ??
    item.cout ??
    item.prixAchat ??
    item.purchasePrice ??
    item.cost ??
    0
  );
  return unitCost * getItemQuantity(item);
}

async function fetchSales() {
  const query = db
    .collection('ventes')
    .where('timestamp', '>=', startTimestamp)
    .where('timestamp', '<=', endTimestamp)
    .orderBy('timestamp', 'asc');

  const snapshot = await query.get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function fetchPurchases() {
  const query = db
    .collection('approvisionnement')
    .where('timestamp', '>=', startTimestamp)
    .where('timestamp', '<=', endTimestamp)
    .orderBy('timestamp', 'desc');

  const snapshot = await query.get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

function buildDailyStats(sales) {
  const daily = new Map();
  const itemTotals = new Map();

  for (const sale of sales) {
    const ts = toMillis(sale.timestamp);
    if (!ts) continue;
    const dateKey = new Date(ts).toISOString().slice(0, 10);

    const saleRevenue = toNumber(
      sale.overallTotal ??
      sale.total ??
      sale.totalAmount ??
      sale.montant ??
      sale.totalPrice ??
      0
    );
    const saleProfit = toNumber(sale.totalProfit);

    const dayEntry = daily.get(dateKey) ?? {
      totalRevenue: 0,
      totalProfit: 0,
      salesCount: 0,
      sales: [],
      itemContrib: new Map()
    };

    dayEntry.totalRevenue += saleRevenue;
    dayEntry.totalProfit += saleProfit;
    dayEntry.salesCount += 1;

    const items = Array.isArray(sale.items) ? sale.items : [];
    const saleSummary = {
      id: sale.id,
      client: sale.client ?? sale.customer ?? sale.clientNom ?? null,
      vendeur: sale.vendeur ?? sale.seller ?? null,
      revenue: saleRevenue,
      profit: saleProfit,
      items: []
    };

    for (const item of items) {
      const name = getItemName(item);
      const qty = getItemQuantity(item);
      const profit = computeItemProfit(item);
      const cost = computeItemCost(item);
      const revenueItem = toNumber(
        item.total ?? item.totalPrice ?? item.montant ?? item.prix ?? 0
      );

      saleSummary.items.push({ name, qty, profit, cost, revenue: revenueItem });

      const current = dayEntry.itemContrib.get(name) ?? {
        qty: 0,
        profit: 0,
        cost: 0,
        revenue: 0
      };
      current.qty += qty;
      current.profit += profit;
      current.cost += cost;
      current.revenue += revenueItem;
      dayEntry.itemContrib.set(name, current);

      const totalItem = itemTotals.get(name) ?? {
        qty: 0,
        profit: 0,
        cost: 0,
        revenue: 0,
        negativeSales: 0
      };
      totalItem.qty += qty;
      totalItem.profit += profit;
      totalItem.cost += cost;
      totalItem.revenue += revenueItem;
      if (profit < 0) {
        totalItem.negativeSales += 1;
      }
      itemTotals.set(name, totalItem);
    }

    dayEntry.sales.push(saleSummary);
    daily.set(dateKey, dayEntry);
  }

  return { daily, itemTotals };
}

function summarizeNegativeDays(dailyMap) {
  const issues = [];
  for (const [date, stats] of dailyMap.entries()) {
    if (stats.totalProfit < 0) {
      const sortedItems = Array.from(stats.itemContrib.entries())
        .map(([name, data]) => ({ name, ...data }))
        .sort((a, b) => a.profit - b.profit);
      issues.push({
        date,
        totalProfit: stats.totalProfit,
        totalRevenue: stats.totalRevenue,
        salesCount: stats.salesCount,
        worstItems: sortedItems.slice(0, 5)
      });
    }
  }
  issues.sort((a, b) => new Date(a.date) - new Date(b.date));
  return issues;
}

function summarizeRecentPurchases(purchases, limit = 5) {
  const sorted = purchases
    .slice()
    .sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));

  return sorted.slice(0, limit).map(p => {
    const ts = toMillis(p.timestamp);
    const date = ts ? new Date(ts).toISOString() : 'N/A';
    const items = Array.isArray(p.items) ? p.items : [];
    const totalCost = items.reduce((acc, item) => acc + computeItemCost(item), 0);
    return {
      id: p.id,
      fournisseur: p.fournisseur ?? p.supplier ?? 'Inconnu',
      type: p.typeAchat ?? p.type ?? 'standard',
      date,
      totalCost,
      itemCount: items.length,
      items: items.map(it => ({
        name: getItemName(it),
        qty: getItemQuantity(it),
        cost: computeItemCost(it),
        unitCost: getItemQuantity(it) ? computeItemCost(it) / getItemQuantity(it) : 0
      }))
    };
  });
}

async function main() {
  console.log('Analyse des ventes et approvisionnements du', START_DATE.toISOString(), 'au', END_DATE.toISOString());

  const [sales, purchases] = await Promise.all([fetchSales(), fetchPurchases()]);
  console.log(`Ventes trouvées: ${sales.length}`);
  console.log(`Approvisionnements trouvés: ${purchases.length}`);

  const { daily, itemTotals } = buildDailyStats(sales);
  const negativeDays = summarizeNegativeDays(daily);
  const recentPurchases = summarizeRecentPurchases(purchases, 5);

  console.log('\n--- Jours avec profit total négatif ---');
  if (negativeDays.length === 0) {
    console.log('Aucun jour négatif détecté.');
  } else {
    for (const day of negativeDays) {
      console.log(`\nDate: ${day.date}`);
      console.log(`Profit total: ${formatCurrency(day.totalProfit)} | CA: ${formatCurrency(day.totalRevenue)} | Ventes: ${day.salesCount}`);
      if (day.worstItems.length === 0) {
        console.log('  Aucun détail d article disponible.');
      } else {
        console.log('  Articles les plus déficitaires:');
        for (const item of day.worstItems) {
          const avgPrice = item.qty ? item.revenue / item.qty : 0;
          const avgCost = item.qty ? item.cost / item.qty : 0;
          const unitProfit = item.qty ? item.profit / item.qty : 0;
          console.log(`    - ${item.name}: profit ${formatCurrency(item.profit)} | Qté ${item.qty} | Prix moyen ${formatCurrency(avgPrice)} | Coût moyen ${formatCurrency(avgCost)} | Profit unitaire ${formatCurrency(unitProfit)}`);
        }
      }
    }
  }

  console.log('\n--- Articles cumulés sur la période ---');
  const sortedItems = Array.from(itemTotals.entries())
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => a.profit - b.profit)
    .slice(0, 10);

  for (const item of sortedItems) {
    const avgPrice = item.qty ? item.revenue / item.qty : 0;
    const avgCost = item.qty ? item.cost / item.qty : 0;
    const unitProfit = item.qty ? item.profit / item.qty : 0;
    console.log(`- ${item.name}: profit ${formatCurrency(item.profit)} | Qté ${item.qty} | Prix moyen ${formatCurrency(avgPrice)} | Coût moyen ${formatCurrency(avgCost)} | Profit unitaire ${formatCurrency(unitProfit)} | Ventes déficitaires: ${item.negativeSales}`);
  }

  console.log('\n--- Derniers approvisionnements ---');
  if (recentPurchases.length === 0) {
    console.log('Aucun approvisionnement récent.');
  } else {
    for (const purchase of recentPurchases) {
      console.log(`\nApprovisionnement ${purchase.id} (${purchase.type}) | Fournisseur: ${purchase.fournisseur}`);
      console.log(`Date: ${purchase.date}`);
      console.log(`Coût total estimé: ${formatCurrency(purchase.totalCost)} | Nombre d articles: ${purchase.itemCount}`);
      for (const item of purchase.items) {
        console.log(`  - ${item.name}: Qté ${item.qty} | Coût ${formatCurrency(item.cost)} | Coût unitaire ${formatCurrency(item.unitCost)}`);
      }
    }
  }

  await admin.app().delete();
}

main().catch(err => {
  console.error('Erreur lors de l\'analyse:', err);
  admin.app().delete().catch(() => {});
  process.exit(1);
});
