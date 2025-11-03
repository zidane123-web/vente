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

const TARGET_DATE = '2025-11-02';
const START_DATE = new Date(`${TARGET_DATE}T00:00:00Z`);
const END_DATE = new Date(`${TARGET_DATE}T23:59:59.999Z`);
const TARGET_PATTERNS = [
  'pop 10',
  'pop10'
];
const APPLY_CHANGES = process.argv.includes('--apply');

function normalizeNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value.replace(/,/g, '.'));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function matchesPop10(rawName = '') {
  const name = rawName.toString().toLowerCase();
  const compact = name.replace(/\s+/g, ' ');
  return TARGET_PATTERNS.some(pattern => compact.includes(pattern)) && name.includes('128');
}

function formatTimestamp(ts) {
  if (!ts) return 'n/a';
  if (ts.toDate) return ts.toDate().toISOString();
  if (ts instanceof Date) return ts.toISOString();
  return String(ts);
}

async function loadTargetSales() {
  const startTs = admin.firestore.Timestamp.fromDate(START_DATE);
  const endTs = admin.firestore.Timestamp.fromDate(END_DATE);
  const snapshot = await db.collection('ventes')
    .where('timestamp', '>=', startTs)
    .where('timestamp', '<=', endTs)
    .get();

  const result = [];
  snapshot.forEach(doc => {
    const data = doc.data() || {};
    const items = Array.isArray(data.items) ? data.items : [];
    const targetItems = items.filter(item => matchesPop10(item.produit || item.name || item.modele || ''));
    if (targetItems.length === 0) {
      return;
    }
    result.push({
      id: doc.id,
      createTime: doc.createTime ? doc.createTime.toDate() : null,
      updateTime: doc.updateTime ? doc.updateTime.toDate() : null,
      timestamp: data.timestamp || null,
      overallTotal: normalizeNumber(data.overallTotal),
      reglementTotal: normalizeNumber(data.reglementTotal || data.reglement || data.totalReglement),
      totalProfit: normalizeNumber(data.totalProfit),
      items: targetItems.map(item => ({
        produit: item.produit || item.name || item.modele || '',
        quantite: normalizeNumber(item.quantite || item.qty || 0),
        total: normalizeNumber(item.total),
        prix: normalizeNumber(item.prix),
        coutAchat: normalizeNumber(item.coutAchat || item.cout || item.coutTotal || 0),
        profitTotal: normalizeNumber(item.profitTotal || 0)
      }))
    });
  });

  result.sort((a, b) => {
    const timeA = a.createTime ? a.createTime.getTime() : 0;
    const timeB = b.createTime ? b.createTime.getTime() : 0;
    return timeA - timeB;
  });
  return result;
}

function matchesAmount(amount) {
  const rounded = Math.round(Math.abs(amount));
  return rounded >= 44000 && rounded <= 52000;
}

function isHelloPhoneMovement(movement) {
  const description = (movement.description || '').toString().toLowerCase();
  const type = (movement.type || '').toString();
  return matchesAmount(movement.montant) &&
    description.includes('hello phone') &&
    type === 'livraison_encaissement';
}

async function loadCaisseMovements() {
  const mouvementRef = db
    .collection('tresorerie')
    .doc('balance')
    .collection('comptesTresorerie')
    .doc('caisse')
    .collection('mouvements');

  const snapshot = await mouvementRef
    .where('dateString', '==', TARGET_DATE)
    .get();

  const movements = [];
  snapshot.forEach(doc => {
    const data = doc.data() || {};
    const montant = normalizeNumber(data.montant);
    if (!matchesAmount(montant)) {
      return;
    }
    movements.push({
      id: doc.id,
      montant,
      description: data.description || '',
      timestamp: data.timestamp || null,
      origine: data.origine || '',
      type: data.type || '',
      createTime: doc.createTime ? doc.createTime.toDate() : null
    });
  });
  movements.sort((a, b) => {
    const timeA = a.createTime ? a.createTime.getTime() : 0;
    const timeB = b.createTime ? b.createTime.getTime() : 0;
    return timeA - timeB;
  });
  return movements;
}

function matchesStockName(rawName = '') {
  const name = rawName.toString().toLowerCase();
  return name.includes('pop') && name.includes('10') && name.includes('128');
}

async function loadStockEntries() {
  const stockSnap = await db.collection('stock').get();
  const matches = [];
  stockSnap.forEach(doc => {
    const data = doc.data() || {};
    const candidates = [
      data.name,
      data.nom,
      data.modele,
      data.model,
      data.productName,
      data.product
    ];
    const aliasArray = Array.isArray(data.alias) ? data.alias : [];
    const matched = candidates.some(entry => entry && matchesStockName(entry))
      || aliasArray.some(entry => matchesStockName(entry));
    if (!matched) {
      return;
    }
    matches.push({
      id: doc.id,
      name: data.name || data.nom || data.productName || '',
      currentQuantity: normalizeNumber(data.quantity || data.stock || data.qte || 0),
      data,
      ref: doc.ref
    });
  });
  return matches;
}

async function loadStockHistory(stockEntry) {
  const historyRef = stockEntry.ref.collection('history');
  const startTs = admin.firestore.Timestamp.fromDate(START_DATE);
  const endTs = admin.firestore.Timestamp.fromDate(END_DATE);
  const snapshot = await historyRef
    .where('timestamp', '>=', startTs)
    .where('timestamp', '<=', endTs)
    .orderBy('timestamp', 'asc')
    .get();

  const history = [];
  snapshot.forEach(doc => {
    const data = doc.data() || {};
    const change = normalizeNumber(data.change || data.quantite || data.qty || 0);
    if (change === 0) {
      return;
    }
    history.push({
      id: doc.id,
      change,
      costOfChange: normalizeNumber(data.costOfChange),
      reason: data.reason || data.motif || '',
      attachedSaleId: data.saleId || data.venteId || data.relatedSaleId || '',
      timestamp: data.timestamp || null
    });
  });
  return history;
}

async function inspect() {
  const sales = await loadTargetSales();
  console.log(`Ventes Pop 10 128GB trouvées le ${TARGET_DATE}: ${sales.length}`);
  sales.forEach((sale, idx) => {
    console.log(`  #${idx + 1} ${sale.id}`);
    console.log(`    createTime: ${sale.createTime ? sale.createTime.toISOString() : 'n/a'}`);
    console.log(`    timestamp: ${formatTimestamp(sale.timestamp)}`);
    console.log(`    overallTotal: ${sale.overallTotal}`);
    console.log(`    reglementTotal: ${sale.reglementTotal}`);
    console.log(`    totalProfit: ${sale.totalProfit}`);
    sale.items.forEach(item => {
      console.log(`      produit: ${item.produit}`);
      console.log(`        quantite: ${item.quantite}`);
      console.log(`        total: ${item.total}`);
      console.log(`        prix: ${item.prix}`);
      console.log(`        coutAchat: ${item.coutAchat}`);
      console.log(`        profitTotal: ${item.profitTotal}`);
    });
  });

  const movements = await loadCaisseMovements();
  console.log(`Mouvements caisse filtrés le ${TARGET_DATE}: ${movements.length}`);
  movements.forEach((mv, idx) => {
    console.log(`  mouvement #${idx + 1} ${mv.id}`);
    console.log(`    montant: ${mv.montant}`);
    console.log(`    type: ${mv.type}`);
    console.log(`    origine: ${mv.origine}`);
    console.log(`    description: ${mv.description}`);
    console.log(`    timestamp: ${formatTimestamp(mv.timestamp)}`);
    console.log(`    createTime: ${mv.createTime ? mv.createTime.toISOString() : 'n/a'}`);
  });

  const stockEntries = await loadStockEntries();
  console.log(`Entrées stock correspondantes: ${stockEntries.length}`);
  for (const stock of stockEntries) {
    console.log(`  stock ${stock.id} (${stock.name || 'sans nom'}) - quantité actuelle: ${stock.currentQuantity}`);
    console.log(`    champs: ${Object.keys(stock.data || {}).join(', ')}`);
    const history = await loadStockHistory(stock);
    console.log(`    historique ${TARGET_DATE}: ${history.length}`);
    history.forEach((entry, idx) => {
      console.log(`      #${idx + 1} ${entry.id}`);
      console.log(`        change: ${entry.change}`);
      console.log(`        costOfChange: ${entry.costOfChange}`);
      console.log(`        reason: ${entry.reason}`);
      console.log(`        attachedSaleId: ${entry.attachedSaleId}`);
      console.log(`        timestamp: ${formatTimestamp(entry.timestamp)}`);
    });
  }
}

function getMovementRef(id) {
  return db
    .collection('tresorerie')
    .doc('balance')
    .collection('comptesTresorerie')
    .doc('caisse')
    .collection('mouvements')
    .doc(id);
}

function sortByFirestoreTime(a, b) {
  const timeA = a.createTime ? a.createTime.getTime() : 0;
  const timeB = b.createTime ? b.createTime.getTime() : 0;
  return timeA - timeB;
}

async function applyFix() {
  const sales = await loadTargetSales();
  if (sales.length === 0) {
    throw new Error('Aucune vente Pop 10 trouvée pour la date ciblée.');
  }

  const saleQuantity = sales.reduce((sum, sale) => {
    return sum + sale.items.reduce((acc, item) => acc + item.quantite, 0);
  }, 0);

  const movements = await loadCaisseMovements();
  const targetMovements = movements.filter(isHelloPhoneMovement).sort(sortByFirestoreTime);
  const movementKeeps = targetMovements.slice(0, 1);
  const movementDeletes = targetMovements.slice(1);

  const stockEntries = await loadStockEntries();
  const stockFixes = [];
  for (const stock of stockEntries) {
    const history = await loadStockHistory(stock);
    if (history.length === 0) {
      continue;
    }
    const negatives = history.filter(entry => entry.change < 0);
    if (negatives.length === 0) {
      continue;
    }
    const expected = saleQuantity > 0 ? saleQuantity : 1;
    const duplicatesToRemove = Math.max(0, negatives.length - expected);
    if (duplicatesToRemove <= 0) {
      continue;
    }
    const duplicateEntries = negatives.slice(expected);
    stockFixes.push({
      stock,
      duplicateEntries
    });
  }

  if (movementDeletes.length === 0 && stockFixes.length === 0) {
    console.log('Aucun doublon détecté, aucune action requise.');
    return;
  }

  const batch = db.batch();
  movementDeletes.forEach(mv => {
    batch.delete(getMovementRef(mv.id));
  });

  let totalRestored = 0;
  stockFixes.forEach(({ stock, duplicateEntries }) => {
    duplicateEntries.forEach(entry => {
      batch.delete(stock.ref.collection('history').doc(entry.id));
    });
    const restoreCount = duplicateEntries.reduce((sum, entry) => {
      return sum + Math.abs(entry.change);
    }, 0);
    if (restoreCount > 0) {
      batch.update(stock.ref, {
        stock: admin.firestore.FieldValue.increment(restoreCount)
      });
      totalRestored += restoreCount;
    }
  });

  await batch.commit();

  console.log('Corrections appliquées:');
  console.log(`  Mouvement conservé: ${movementKeeps.map(mv => mv.id).join(', ') || 'aucun'}`);
  console.log(`  Mouvements supprimés: ${movementDeletes.map(mv => mv.id).join(', ') || 'aucun'}`);
  stockFixes.forEach(({ stock, duplicateEntries }) => {
    console.log(`  Stock ${stock.id}: suppression history [${duplicateEntries.map(e => e.id).join(', ')}], restauration +${duplicateEntries.length}`);
  });
  if (totalRestored > 0) {
    console.log(`  Quantité restituée au stock: ${totalRestored}`);
  }
}

async function main() {
  try {
    if (APPLY_CHANGES) {
      await applyFix();
    } else {
      await inspect();
    }
  } catch (err) {
    console.error('Erreur lors de l\'inspection Pop 10:', err);
    process.exitCode = 1;
  } finally {
    await admin.app().delete().catch(() => {});
  }
}

main();
