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
const SELL_THROUGH_THRESHOLD = 0.95;
const TARGET_BUDGET = 5_000_000;
const MIN_ITEM_COST = 1_000;

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
        unmatchedSaleValue: 0
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
          unmatchedSaleValue: 0
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
      }
    }
  }
}

function buildRecommendations(aggregated) {
  const candidates = [];

  for (const record of aggregated.values()) {
    const purchaseQty = record.purchaseQty || 0;
    const saleQty = record.saleQty || 0;
    const unmatchedQty = record.unmatchedSaleQty || 0;
    const totalDemandQty = saleQty + unmatchedQty;
    if (purchaseQty <= 0 || totalDemandQty <= 0) continue;

    const sellThrough = purchaseQty > 0 ? saleQty / purchaseQty : 0;
    if (sellThrough < SELL_THROUGH_THRESHOLD) continue;

    const unitCostCandidate = purchaseQty > 0 ? record.purchaseValue / purchaseQty : 0;
    const fallbackUnitCost = saleQty > 0 ? record.saleCost / saleQty : 0;
    const unitCost = unitCostCandidate > 0 ? unitCostCandidate : fallbackUnitCost;
    if (!Number.isFinite(unitCost) || unitCost <= MIN_ITEM_COST) continue;

    const recommendedQty = Math.max(1, Math.round(totalDemandQty));
    const totalCost = unitCost * recommendedQty;

    candidates.push({
      name: record.name,
      purchaseQty,
      saleQty,
      unmatchedQty,
      totalDemandQty,
      sellThrough,
      unitCost,
      recommendedQty,
      totalCost,
      saleRevenue: record.saleRevenue || 0,
      saleProfit: record.saleProfit || 0
    });
  }

  candidates.sort((a, b) => {
    if (b.sellThrough !== a.sellThrough) return b.sellThrough - a.sellThrough;
    if (b.totalDemandQty !== a.totalDemandQty) return b.totalDemandQty - a.totalDemandQty;
    return a.name.localeCompare(b.name);
  });

  const selected = [];
  let budgetUsed = 0;

  for (const candidate of candidates) {
    if (budgetUsed >= TARGET_BUDGET) break;
    const remaining = TARGET_BUDGET - budgetUsed;
    if (candidate.totalCost <= remaining) {
      selected.push({ ...candidate });
      budgetUsed += candidate.totalCost;
    } else {
      const partialQty = Math.floor(remaining / candidate.unitCost);
      if (partialQty >= 1) {
        const partialCost = candidate.unitCost * partialQty;
        selected.push({
          ...candidate,
          recommendedQty: partialQty,
          totalCost: partialCost,
          partial: true
        });
        budgetUsed += partialCost;
        break;
      }
    }
  }

  if (budgetUsed < TARGET_BUDGET * 0.85) {
    const spareBudget = TARGET_BUDGET - budgetUsed;
    if (spareBudget > MIN_ITEM_COST) {
      for (const candidate of selected) {
        const remaining = TARGET_BUDGET - budgetUsed;
        if (remaining <= MIN_ITEM_COST) break;
        const extraQty = Math.floor(remaining / candidate.unitCost);
        if (extraQty <= 0) continue;
        candidate.recommendedQty += extraQty;
        candidate.totalCost = candidate.unitCost * candidate.recommendedQty;
        candidate.partial = false;
        budgetUsed += candidate.unitCost * extraQty;
      }
    }
  }

  const finalBudget = selected.reduce((sum, item) => sum + item.totalCost, 0);
  selected.sort((a, b) => b.totalCost - a.totalCost);

  return { recommendations: selected, budgetUsed: finalBudget, candidates };
}

function writePdf(recommendations, budgetUsed, dateRange, outputPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, info: { Title: `Commande Abdoul ${LOOKBACK_DAYS} jours` } });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const generatedAt = new Date();
    const remainingBudget = Math.max(0, TARGET_BUDGET - budgetUsed);

    doc.font('Helvetica-Bold').fontSize(20).text(`Commande recommandée – ${SUPPLIER_NAME}`, { align: 'center' });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(12).text(`Analyse des ventes du ${dateRange.start.toLocaleDateString('fr-FR')} au ${dateRange.end.toLocaleDateString('fr-FR')}`, { align: 'center' });
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(10).text(`Généré le ${generatedAt.toLocaleDateString('fr-FR')} à ${generatedAt.toLocaleTimeString('fr-FR')}`, { align: 'center' });
    doc.moveDown(0.8);

    doc.font('Helvetica-Bold').fontSize(14).text('Résumé');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(11);
    doc.text(`Budget cible: ${formatCurrency(TARGET_BUDGET)}`);
    doc.text(`Montant proposé: ${formatCurrency(budgetUsed)} (reste ${formatCurrency(remainingBudget)})`);
    doc.text(`Articles retenus: ${recommendations.length}`);
    doc.text(`Seuil d'écoulement: ${(SELL_THROUGH_THRESHOLD * 100).toFixed(0)} % minimum sur 14 jours`);
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(9).fillColor('#444444').text(
      "Les quantités recommandées s'appuient sur les ventes prouvées sur les 14 derniers jours pour Abdoul. Elles n'excèdent jamais les volumes réellement écoulés sur la période, afin de garantir un écoulement complet en deux semaines.",
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
    );
    doc.fillColor('#000000');
    doc.moveDown(0.8);

    if (recommendations.length === 0) {
      doc.font('Helvetica-Bold').fontSize(14).text('Aucun modèle éligible.');
      doc.moveDown(0.4);
      doc.font('Helvetica').fontSize(11).text("Aucun téléphone n'a atteint un seuil d'écoulement de 95 % sur les deux dernières semaines.");
      doc.end();
      stream.on('finish', () => resolve(outputPath));
      stream.on('error', reject);
      return;
    }

    const headers = [
      'Produit',
      'Qté recommandée',
      'Coût unitaire',
      'Coût total',
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
      commentParts.push(`${formatQuantity(item.saleQty)} vendus / ${formatQuantity(item.purchaseQty)} reçus`);
      if (item.unmatchedQty > 0) {
        commentParts.push(`${formatQuantity(item.unmatchedQty)} ventes manquantes`);
      }
      if (item.partial) {
        commentParts.push('Quantité ajustée pour budget');
      }
      const comment = commentParts.join(' · ');

      const cells = [
        item.name,
        formatQuantity(item.recommendedQty),
        formatCurrency(item.unitCost),
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

    const { recommendations, budgetUsed, candidates } = buildRecommendations(aggregated);
    console.log('Modèles éligibles:', candidates.length);
    console.log('Modèles retenus:', recommendations.length);
    for (const rec of recommendations) {
      console.log(
        `- ${rec.name}: ${rec.recommendedQty} unités · ${formatCurrency(rec.totalCost)} · sell-through ${(rec.sellThrough * 100).toFixed(1)} %`
      );
    }
    console.log(`Budget proposé: ${formatCurrency(budgetUsed)} / ${formatCurrency(TARGET_BUDGET)}`);

    const filename = `commande_${slugify(SUPPLIER_NAME)}_${start.toISOString().slice(0, 10).replace(/-/g, '')}_${end.toISOString().slice(0, 10).replace(/-/g, '')}.pdf`;
    const outputPath = path.join(__dirname, filename);
    await writePdf(recommendations, budgetUsed, { start, end }, outputPath);

    console.log(`PDF généré: ${outputPath}`);
  } catch (error) {
    console.error("Erreur lors de la génération de la commande:", error);
    process.exitCode = 1;
  } finally {
    await admin.app().delete().catch(() => {});
  }
}

main();
