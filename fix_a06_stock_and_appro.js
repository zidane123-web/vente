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

const APPLY_CHANGES = process.argv.includes('--apply');
const TARGET_KEYWORDS = ['a06', '64'];
const STOCK_DECREMENT = 1;

function normalize(value) {
  return value ? value.toString().trim().toLowerCase() : '';
}

function matchesTargetName(rawName = '') {
  const name = normalize(rawName);
  if (!name) {
    return false;
  }
  return TARGET_KEYWORDS.every(keyword => name.includes(keyword));
}

function parseNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? asNumber : 0;
}

function describeStockDoc(doc, index) {
  const created = doc.createTime ? doc.createTime.toISOString() : 'inconnu';
  console.log(`Stock #${index + 1} ${doc.id}`);
  console.log(`  nom     : ${doc.name}`);
  console.log(`  stock   : ${doc.stock}`);
  console.log(`  créé le : ${created}`);
}

async function fetchStockCandidates() {
  const snapshot = await db.collection('stock').get();
  const candidates = [];
  snapshot.forEach(doc => {
    const data = doc.data() || {};
    const aliases = Array.isArray(data.alias) ? data.alias : [];
    const names = [
      data.name,
      data.nom,
      data.productName,
      data.modele,
      data.model,
      data.produit,
      ...aliases
    ];
    if (!names.some(name => matchesTargetName(name))) {
      return;
    }
    candidates.push({
      id: doc.id,
      ref: doc.ref,
      data,
      name: data.name || data.nom || data.productName || doc.id,
      stock: parseNumber(data.stock ?? data.quantity ?? data.qte ?? data.qty),
      createTime: doc.createTime ? doc.createTime.toDate() : null
    });
  });
  return candidates;
}

async function adjustStock(keeper) {
  const newStock = Math.max(0, keeper.stock - STOCK_DECREMENT);
  const payload = { stock: newStock };
  ['quantity', 'qte', 'qty'].forEach(key => {
    if (Object.prototype.hasOwnProperty.call(keeper.data, key)) {
      payload[key] = newStock;
    }
  });
  if (Object.prototype.hasOwnProperty.call(keeper.data, 'updatedAt')) {
    payload.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  }
  await keeper.ref.set(payload, { merge: true });
  console.log(`Stock ajusté pour ${keeper.id}: ${keeper.stock} -> ${newStock}`);
  return newStock;
}

function docContainsA06(data = {}) {
  const productNames = Array.isArray(data.productNames) ? data.productNames : [];
  if (productNames.some(name => matchesTargetName(name))) {
    return true;
  }
  const items = Array.isArray(data.items) ? data.items : [];
  return items.some(item => matchesTargetName(item.produit || item.name || item.modele || item.designation));
}

async function listDocCollections(docRef) {
  const subCollections = await docRef.listCollections();
  return subCollections || [];
}

async function deleteDocWithChildren(docRef) {
  const collections = await listDocCollections(docRef);
  for (const collection of collections) {
    const snapshot = await collection.get();
    for (const doc of snapshot.docs) {
      await doc.ref.delete();
    }
  }
  await docRef.delete();
}

async function findLatestApprovisionnement() {
  let snapshot = await db.collection('approvisionnement').orderBy('timestamp', 'desc').limit(60).get();
  let candidate = null;
  snapshot.forEach(doc => {
    if (candidate) {
      return;
    }
    const data = doc.data() || {};
    if (docContainsA06(data)) {
      candidate = {
        id: doc.id,
        ref: doc.ref,
        data,
        timestamp: data.timestamp && typeof data.timestamp.toDate === 'function'
          ? data.timestamp.toDate()
          : null,
        totalCost: parseNumber(data.totalCost)
      };
    }
  });

  if (candidate) {
    return candidate;
  }

  // Fallback: exhaustive search (could be heavy but guarantees result)
  console.log('Aucune entrée trouvée dans les 60 derniers achats, recherche complète...');
  snapshot = await db.collection('approvisionnement').get();
  let latest = null;
  snapshot.forEach(doc => {
    const data = doc.data() || {};
    if (!docContainsA06(data)) {
      return;
    }
    const ts = data.timestamp && typeof data.timestamp.toDate === 'function'
      ? data.timestamp.toDate()
      : null;
    if (!latest || (ts && (!latest.timestamp || ts.getTime() > latest.timestamp.getTime()))) {
      latest = {
        id: doc.id,
        ref: doc.ref,
        data,
        timestamp: ts,
        totalCost: parseNumber(data.totalCost)
      };
    }
  });
  return latest;
}

function describeAppro(appro) {
  const ts = appro.timestamp ? appro.timestamp.toISOString() : 'sans horodatage';
  console.log(`Approvisionnement cible: ${appro.id}`);
  console.log(`  date        : ${ts}`);
  console.log(`  total coût  : ${appro.totalCost}`);
  const items = Array.isArray(appro.data.items) ? appro.data.items : [];
  items
    .filter(item => matchesTargetName(item.produit || item.name || item.modele || ''))
    .forEach((item, index) => {
      const qty = parseNumber(item.quantite || item.qty || 0);
      console.log(`  ligne #${index + 1}: ${item.produit || item.name} (qty: ${qty})`);
    });
}

async function execute() {
  const stockDocs = await fetchStockCandidates();
  if (!stockDocs.length) {
    console.log('Aucun article stock A06 64GB trouvé.');
  } else {
    console.log(`Articles stock A06 64GB trouvés: ${stockDocs.length}`);
    stockDocs.forEach((doc, index) => describeStockDoc(doc, index));
  }

  const appro = await findLatestApprovisionnement();
  if (!appro) {
    console.log('Aucun approvisionnement contenant A06 64GB trouvé.');
  } else {
    describeAppro(appro);
  }

  if (!APPLY_CHANGES) {
    console.log('Mode lecture seule. Relancez avec --apply pour appliquer les changements.');
    return;
  }

  if (stockDocs.length) {
    const stockTarget = stockDocs.sort((a, b) => b.stock - a.stock)[0];
    await adjustStock(stockTarget);
  }

  if (appro) {
    console.log(`Suppression de l'approvisionnement ${appro.id}`);
    await deleteDocWithChildren(appro.ref);
  }

  console.log('Opérations terminées.');
}

execute()
  .catch(error => {
    console.error('Erreur durant la correction A06:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    return admin.app().delete().catch(() => {});
  });
