const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const admin = require('firebase-admin');

const serviceAccountPath = path.join(__dirname, 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json');

let serviceAccount;
try {
  serviceAccount = require(serviceAccountPath);
} catch (error) {
  console.error("Impossible de charger le service account Firebase:", error.message);
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 14;
const SUPPLIER_NAME = 'Abdoul';
const TARGET_BUDGET = 5_000_000;
const MIN_ITEM_COST = 1_000;
const MIN_SALES_THRESHOLD = 10;
const ORDER_RATIO = 0.95;

const SUPPLIER_CANONICALS = new Map([
  ['abdoul', 'Abdoul'],
  ['abdoul tg', 'Abdoul'],
  ['abdoul tg.', 'Abdoul'],
  ['abdoul tg ', 'Abdoul'],
  ['abdoul tg-', 'Abdoul'],
  ['abdoul tg/', 'Abdoul']
]);

function canonicalSupplier(raw) {
  if (!raw) return '';
  const normalized = raw.toString().trim().toLowerCase();
  return SUPPLIER_CANONICALS.get(normalized) || raw.toString().trim();
}

function normalizeName(value) {
  return (value || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
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
    item.produit ||
    item.name ||
    item.designation ||
    item.label ||
    item.modele ||
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
    item.totalAchat;
  const parsed = parseNumeric(explicit);
  if (parsed > 0) return parsed;
  return getItemUnitCost(item) * getItemQuantity(item);
}

function getSaleTotal(item) {
  if (!item || typeof item !== 'object') return 0;
  const explicit =
    item.total ??
    item.totalVente ??
    item.prixTotal ??
    item.ligneTotal ??
    item.lineTotal ??
    item.totalPrice ??
    item.amount;
  const parsed = parseNumeric(explicit);
  if (parsed > 0) return parsed;
  const unitPrice = parseNumeric(item.prixVente ?? item.prix ?? item.price ?? 0);
  return unitPrice * getItemQuantity(item);
}

function getSaleProfit(item, saleTotal, saleCost) {
  if (!item || typeof item !== 'object') return 0;
  const explicit = parseNumeric(item.profitTotal ?? item.totalProfit ?? item.profit);
  if (Math.abs(explicit) > 0.01) return explicit;
  if (saleTotal !== undefined && saleCost !== undefined) {
    return saleTotal - saleCost;
  }
  return 0;
}

function isPhoneItem(item) {
  if (!item || typeof item !== 'object') return false;
  const category = (item.category ?? item.categorie ?? item.typeProduit ?? '')
    .toString()
    .toLowerCase();
  if (category.includes('phone') || category.includes('téléphone') || category.includes('telephone')) {
    return true;
  }
  const name = normalizeName(getItemName(item));
  return (
    name.includes('itel') ||
    name.includes('tecno') ||
    name.includes('infinix') ||
    name.includes('nokia') ||
    name.includes('samsung') ||
    name.includes('iphone') ||
    name.includes('smart') ||
    name.includes('phone') ||
    name.includes('gsm') ||
    name.includes('redmi') ||
    name.includes('oppo')
  );
}

function formatCurrency(amount) {
  if (!Number.isFinite(amount)) return '';
  const rounded = Math.round(amount);
  const absValue = Math.abs(rounded);
  const formatted = absValue
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const sign = rounded < 0 ? '-' : '';
  return `${sign}${formatted} FCFA`;
}

function formatQuantity(qty) {
  if (!Number.isFinite(qty)) return '';
  if (Math.abs(qty % 1) < 1e-6) return `${qty}`;
  return qty.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '';
  return `${(value * 100).toFixed(1)} %`;
}

function slugify(value) {
  return (value || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '');
}

function getDateRange() {
  const end = new Date();
  const start = new Date(end.getTime() - LOOKBACK_DAYS * DAY_MS);
  start.setHours(0, 0, 0, 0);
  return { start, end };
}

async function fetchPurchases(startTimestamp, endTimestamp) {
  const snapshot = await db
    .collection('approvisionnement')
    .where('timestamp', '>=', startTimestamp)
    .where('timestamp', '<=', endTimestamp)
    .orderBy('timestamp', 'asc')
    .get();

  return snapshot.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(doc => canonicalSupplier(doc.fournisseur ?? doc.supplier ?? '') === SUPPLIER_NAME);
}

async function fetchSales(startTimestamp, endTimestamp) {
  const snapshot = await db
    .collection('ventes')
    .where('timestamp', '>=', startTimestamp)
    .where('timestamp', '<=', endTimestamp)
    .orderBy('timestamp', 'asc')
    .get();

  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

function summarizePurchases(purchases) {
  const aggregated = new Map();

  for (const purchase of purchases) {
    const items = Array.isArray(purchase.items) ? purchase.items : [];
    for (const item of items) {
      if (!isPhoneItem(item)) continue;
      const name = getItemName(item);
      const normalized = normalizeName(name);
      if (!normalized) continue;
      const qty = getItemQuantity(item);
      if (qty <= 0) continue;
      const lineCost = getItemLineCost(item);
      const record = aggregated.get(normalized) || {
        name,
        purchaseQty: 0,
        purchaseValue: 0,
        remainingPurchaseQty: 0,
        saleQty: 0,
        saleRevenue: 0,
        saleCost: 0,
        saleProfit: 0,
        unmatchedSaleQty: 0,
        unmatchedSaleValue: 0,
        unmatchedSaleCost: 0
      };
      record.name = name;
      record.purchaseQty += qty;
      record.purchaseValue += lineCost;
      record.remainingPurchaseQty += qty;
      aggregated.set(normalized, record);
    }
  }

  return aggregated;
}

function summarizeSales(sales, aggregated) {
  for (const sale of sales) {
    const items = Array.isArray(sale.items) ? sale.items : [];
    for (const item of items) {
      if (!isPhoneItem(item)) continue;

      const supplierField =
        item.fournisseur ??
        item.supplier ??
        item.sourceFournisseur ??
        item.depotFournisseurNom ??
        item.depotFournisseur ??
        '';
      const supplierCanonical = canonicalSupplier(supplierField);
      const normalizedName = normalizeName(getItemName(item));
      const isKnownAbdoulItem = aggregated.has(normalizedName);

      if (supplierCanonical !== SUPPLIER_NAME && !isKnownAbdoulItem) {
        continue;
      }

      if (!aggregated.has(normalizedName)) {
        aggregated.set(normalizedName, {
          name: getItemName(item),
          purchaseQty: 0,
          purchaseValue: 0,
          remainingPurchaseQty: 0,
          saleQty: 0,
          saleRevenue: 0,
          saleCost: 0,
          saleProfit: 0,
          unmatchedSaleQty: 0,
          unmatchedSaleValue: 0,
          unmatchedSaleCost: 0
        });
      }

      const record = aggregated.get(normalizedName);
      if (!record) continue;

      const qty = getItemQuantity(item);
      if (qty <= 0) continue;
      const saleTotal = getSaleTotal(item);
      const unitCost = getItemUnitCost(item);
      const saleCost = unitCost * qty;
      const saleProfit = getSaleProfit(item, saleTotal, saleCost);

      const availableQty = Math.max(0, record.remainingPurchaseQty || 0);
      const allocatedQty = Math.min(availableQty, qty);
      const unmatchedQty = Math.max(0, qty - allocatedQty);
      const allocationRatio = qty > 0 ? allocatedQty / qty : 0;
      const unmatchedRatio = qty > 0 ? unmatchedQty / qty : 0;

      if (allocatedQty > 0) {
        const allocatedRevenue = saleTotal * allocationRatio;
        const allocatedCost = saleCost * allocationRatio;
        const allocatedProfit = saleProfit * allocationRatio;

        record.saleQty += allocatedQty;
        record.saleRevenue += allocatedRevenue;
        record.saleCost += allocatedCost;
        record.saleProfit += allocatedProfit;
        record.remainingPurchaseQty = Math.max(0, availableQty - allocatedQty);
      }

    if (unmatchedQty > 0) {
      record.unmatchedSaleQty += unmatchedQty;
      record.unmatchedSaleValue += saleTotal * unmatchedRatio;
      record.unmatchedSaleCost += saleCost * unmatchedRatio;
    }
  }
}
}

function buildRecommendations(aggregated) {
  const items = [];

  for (const record of aggregated.values()) {
    const purchaseQty = record.purchaseQty || 0;
    const saleQty = record.saleQty || 0;
    const unmatchedQty = record.unmatchedSaleQty || 0;
    const totalSold = saleQty + unmatchedQty;
    if (totalSold < MIN_SALES_THRESHOLD) continue;

    const sellThrough = purchaseQty > 0 ? Math.min(1, saleQty / purchaseQty) : 1;

    const unitCostCandidate = purchaseQty > 0 ? record.purchaseValue / purchaseQty : 0;
    const totalSalesCost = (record.saleCost || 0) + (record.unmatchedSaleCost || 0);
    const fallbackUnitCost = totalSold > 0 ? totalSalesCost / totalSold : 0;
    const unitCost = unitCostCandidate > 0 ? unitCostCandidate : fallbackUnitCost;
    if (!Number.isFinite(unitCost) || unitCost <= MIN_ITEM_COST) continue;

    let minQty = Math.max(1, Math.floor(totalSold * ORDER_RATIO));
    if (minQty >= totalSold && totalSold >= 2) {
      minQty = totalSold - 1;
    }
    minQty = Math.max(1, Math.min(minQty, totalSold));
    const maxQty = totalSold;
    const unitCostRounded = Math.round(unitCost);

    items.push({
      name: record.name,
      purchaseQty,
      saleQty,
      unmatchedQty,
      totalDemandQty: totalSold,
      sellThrough,
      unitCost,
      unitCostRounded,
      minQty,
      maxQty,
      saleRevenue: record.saleRevenue || 0,
      saleProfit: record.saleProfit || 0
    });
  }

  if (items.length === 0) {
    return { recommendations: [], budgetUsed: 0, candidates: [], exactMatch: false };
  }

  items.sort((a, b) => {
    if (b.saleQty !== a.saleQty) return b.saleQty - a.saleQty;
    if (b.unitCostRounded !== a.unitCostRounded) return b.unitCostRounded - a.unitCostRounded;
    return a.name.localeCompare(b.name);
  });

  const restMinCost = new Array(items.length + 1).fill(0);
  const restMaxCost = new Array(items.length + 1).fill(0);
  for (let i = items.length - 1; i >= 0; i--) {
    restMinCost[i] = restMinCost[i + 1] + items[i].unitCostRounded * items[i].minQty;
    restMaxCost[i] = restMaxCost[i + 1] + items[i].unitCostRounded * items[i].maxQty;
  }

  const minCost = restMinCost[0];
  const maxCost = restMaxCost[0];

  const selection = new Array(items.length).fill(0);
  let found = false;

  function search(index, currentCost) {
    if (index === items.length) {
      if (currentCost === TARGET_BUDGET) {
        found = true;
        return true;
      }
      return false;
    }
    const item = items[index];
    for (let qty = item.maxQty; qty >= item.minQty; qty--) {
      const cost = item.unitCostRounded * qty;
      const newCost = currentCost + cost;
      if (newCost > TARGET_BUDGET) continue;
      const minPossible = newCost + restMinCost[index + 1];
      const maxPossible = newCost + restMaxCost[index + 1];
      if (minPossible > TARGET_BUDGET || maxPossible < TARGET_BUDGET) continue;
      selection[index] = qty;
      if (search(index + 1, newCost)) {
        return true;
      }
    }
    return false;
  }

  let recommendations = [];
  let budgetUsed = 0;
  let exactMatch = false;

  if (TARGET_BUDGET >= minCost && TARGET_BUDGET <= maxCost && search(0, 0)) {
    exactMatch = true;
    recommendations = items.map((item, index) => {
      const qty = selection[index];
      const totalCost = item.unitCostRounded * qty;
      budgetUsed += totalCost;
      return {
        ...item,
        recommendedQty: qty,
        totalCost
      };
    });
  } else {
    budgetUsed = minCost;
    recommendations = items.map(item => {
      const qty = item.minQty;
      const totalCost = item.unitCostRounded * qty;
      return {
        ...item,
        recommendedQty: qty,
        totalCost
      };
    });

    let residual = TARGET_BUDGET - budgetUsed;
    if (residual > 0) {
      const order = items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => a.item.unitCostRounded - b.item.unitCostRounded);
      for (const entry of order) {
        if (residual <= 0) break;
        const item = entry.item;
        const rec = recommendations[entry.index];
        const available = item.maxQty - rec.recommendedQty;
        if (available <= 0) continue;
        const affordable = Math.min(available, Math.floor(residual / item.unitCostRounded));
        if (affordable <= 0) continue;
        rec.recommendedQty += affordable;
        const addedCost = affordable * item.unitCostRounded;
        rec.totalCost += addedCost;
        residual -= addedCost;
        budgetUsed += addedCost;
      }
    }
  }

  recommendations.sort((a, b) => b.totalCost - a.totalCost);

  return { recommendations, budgetUsed, candidates: items, exactMatch };
}

function writePdf(recommendations, budgetUsed, dateRange, outputPath, exactMatch) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, info: { Title: `Commande Abdoul ${LOOKBACK_DAYS} jours` } });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const generatedAt = new Date();
    const remainingBudget = Math.max(0, TARGET_BUDGET - budgetUsed);

    doc.font('Helvetica-Bold').fontSize(20).text(`Commande recommandee - ${SUPPLIER_NAME}`, { align: 'center' });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(12).text(`Analyse des ventes du ${dateRange.start.toLocaleDateString('fr-FR')} au ${dateRange.end.toLocaleDateString('fr-FR')}`, { align: 'center' });
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(10).text(`Genere le ${generatedAt.toLocaleDateString('fr-FR')} a ${generatedAt.toLocaleTimeString('fr-FR')}`, { align: 'center' });
    doc.moveDown(0.8);

    doc.font('Helvetica-Bold').fontSize(14).text('Resume');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(11);
    doc.text(`Budget cible: ${formatCurrency(TARGET_BUDGET)}`);
    doc.text(`Montant propose: ${formatCurrency(budgetUsed)} (reste ${formatCurrency(remainingBudget)})${exactMatch ? ' - pile 5 000 000 FCFA' : ''}`);
    doc.text(`Articles retenus: ${recommendations.length}`);
    doc.text(`Quantite visee ~ ${Math.round(ORDER_RATIO * 100)} % des ventes realisees (arrondi a l'inferieur)`);
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(9).fillColor('#444444').text(
      "Les quantites recommandees s'appuient sur les ventes prouvees sur les 14 derniers jours pour Abdoul. Elles sont legerement inferieures au volume vendu afin de securiser l'ecoulement complet dans les deux semaines.",
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
    );
    doc.fillColor('#000000');
    if (!exactMatch) {
      doc.font('Helvetica').fontSize(9).fillColor('#aa0000').text(
        "Note : impossible d'atteindre 5 000 000 FCFA avec les volumes vendus disponibles.",
        { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
      );
      doc.fillColor('#000000');
      doc.moveDown(0.5);
    }
    doc.moveDown(0.8);

    if (recommendations.length === 0) {
      doc.font('Helvetica-Bold').fontSize(14).text('Aucun modele eligible.');
      doc.moveDown(0.4);
      doc.font('Helvetica').fontSize(11).text("Aucun telephone n'a depasse 10 ventes sur les deux dernieres semaines.");
      doc.end();
      stream.on('finish', () => resolve(outputPath));
      stream.on('error', reject);
      return;
    }

    const headers = [
      'Produit',
      'Qte recommendee',
      'Cout unitaire',
      'Cout total',
      'Ventes 14 j',
      'Sell-through',
      'Remarque'
    ];
    const startX = doc.page.margins.left;
    const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const baseWidths = [0.3, 0.1, 0.13, 0.13, 0.1, 0.1].map(ratio => Math.floor(availableWidth * ratio));
    const used = baseWidths.reduce((sum, value) => sum + value, 0);
    const commentWidth = availableWidth - used;
    const columnWidths = [...baseWidths, Math.max(commentWidth, 90)];
    const limitY = doc.page.height - doc.page.margins.bottom;

    const headerHeight = drawHeaderRow(doc, headers, startX, doc.y, columnWidths);
    doc.y += headerHeight;

    recommendations.forEach((item, index) => {
      const commentParts = [];
      commentParts.push(`${formatQuantity(item.saleQty)} vendus / ${formatQuantity(item.purchaseQty)} recus`);
      if (item.unmatchedQty > 0) {
        commentParts.push(`${formatQuantity(item.unmatchedQty)} ventes manquantes`);
      }
      const comment = commentParts.join(' | ');

      const cells = [
        item.name,
        formatQuantity(item.recommendedQty),
        formatCurrency(item.unitCostRounded),
        formatCurrency(item.totalCost),
        formatQuantity(item.totalDemandQty),
        formatPercent(item.sellThrough),
        comment
      ];

      const rowHeight = calculateRowHeight(doc, cells, columnWidths, { font: 'Helvetica', fontSize: 10 });
      if (doc.y + rowHeight > limitY) {
        doc.addPage();
        const h = drawHeaderRow(doc, headers, startX, doc.y, columnWidths);
        doc.y += h;
      }
      const y = doc.y;
      drawBodyRow(doc, cells, startX, y, columnWidths, { zebra: index % 2 === 0 });
      doc.y = y + rowHeight;
    });

    doc.end();
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

function calculateRowHeight(doc, cells, widths, options = {}) {
  const { font = 'Helvetica', fontSize = 10 } = options;
  let maxHeight = 0;
  cells.forEach((rawCell, idx) => {
    const cell = String(rawCell ?? '');
    doc.font(font).fontSize(fontSize);
    const width = Math.max(12, widths[idx] - 8);
    const height = doc.heightOfString(cell, { width, lineGap: 2 });
    maxHeight = Math.max(maxHeight, height);
  });
  return maxHeight + 8;
}

function drawHeaderRow(doc, headers, startX, y, widths) {
  const headerHeight = calculateRowHeight(doc, headers, widths, { font: 'Helvetica-Bold', fontSize: 10 });
  let x = startX;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000');
  headers.forEach((header, idx) => {
    doc.save();
    doc.rect(x, y, widths[idx], headerHeight).fill('#efefef');
    doc.restore();
    doc.rect(x, y, widths[idx], headerHeight).stroke();
    doc.text(String(header ?? ''), x + 4, y + 4, { width: Math.max(10, widths[idx] - 8), lineGap: 2 });
    x += widths[idx];
  });
  doc.font('Helvetica').fontSize(10).fillColor('#000000');
  return headerHeight;
}

function drawBodyRow(doc, cells, startX, y, widths, options = {}) {
  const { zebra = false } = options;
  const rowHeight = calculateRowHeight(doc, cells, widths, { font: 'Helvetica', fontSize: 10 });
  let x = startX;
  doc.font('Helvetica').fontSize(10).fillColor('#000000');
  cells.forEach((rawCell, idx) => {
    const cell = String(rawCell ?? '');
    if (zebra) {
      doc.save();
      doc.rect(x, y, widths[idx], rowHeight).fill('#f8f8f8');
      doc.restore();
    }
    doc.rect(x, y, widths[idx], rowHeight).stroke();
    doc.text(cell, x + 4, y + 4, { width: Math.max(10, widths[idx] - 8), lineGap: 2 });
    x += widths[idx];
  });
  return rowHeight;
}

async function main() {
  const { start, end } = getDateRange();
  const startTimestamp = admin.firestore.Timestamp.fromDate(start);
  const endTimestamp = admin.firestore.Timestamp.fromDate(end);

  try {
    console.log(`Analyse des ventes Abdoul entre ${start.toISOString()} et ${end.toISOString()}...`);
    const [purchases, sales] = await Promise.all([
      fetchPurchases(startTimestamp, endTimestamp),
      fetchSales(startTimestamp, endTimestamp)
    ]);
    console.log(`Achats Abdoul: ${purchases.length}`);
    console.log(`Ventes total: ${sales.length}`);

    const aggregated = summarizePurchases(purchases);
    summarizeSales(sales, aggregated);

    const { recommendations, budgetUsed, candidates, exactMatch } = buildRecommendations(aggregated);
    console.log('Modeles eligibles:', candidates.length);
    console.log('Modeles retenus:', recommendations.length);
    for (const rec of recommendations) {
      console.log(
        `- ${rec.name}: recommander ${rec.recommendedQty} (ventes ${formatQuantity(rec.saleQty)}) -> ${formatCurrency(rec.totalCost)} -> sell-through ${(rec.sellThrough * 100).toFixed(1)} %`
      );
    }
    console.log(`Budget propose: ${formatCurrency(budgetUsed)} / ${formatCurrency(TARGET_BUDGET)}${exactMatch ? ' (exact)' : ''}`);

    const filename = `commande_${slugify(SUPPLIER_NAME)}_${start.toISOString().slice(0, 10).replace(/-/g, '')}_${end.toISOString().slice(0, 10).replace(/-/g, '')}.pdf`;
    const outputPath = path.join(__dirname, filename);
    await writePdf(recommendations, budgetUsed, { start, end }, outputPath, exactMatch);

    console.log(`PDF genere: ${outputPath}`);
  } catch (error) {
    console.error("Erreur lors de la generation de la commande:", error);
    process.exitCode = 1;
  } finally {
    await admin.app().delete().catch(() => {});
  }
}

main();







