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
const TARGET_KEYWORDS = ['pop', '10', '128'];
const DESIRED_STOCK = 2;

function normalizeString(value) {
  if (!value) {
    return '';
  }
  return value.toString().trim().toLowerCase();
}

function matchesTargetName(rawValue = '') {
  const value = normalizeString(rawValue);
  if (!value) {
    return false;
  }
  return TARGET_KEYWORDS.every(keyword => value.includes(keyword));
}

function extractStockValue(data = {}) {
  const candidates = [
    data.stock,
    data.quantity,
    data.qte,
    data.qty
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (!Number.isNaN(numeric)) {
      return numeric;
    }
  }
  return 0;
}

async function fetchPop10StockDocs() {
  const snapshot = await db.collection('stock').get();
  const matches = [];

  snapshot.forEach(doc => {
    const data = doc.data() || {};
    const aliases = Array.isArray(data.alias) ? data.alias : [];
    const nameCandidates = [
      data.name,
      data.nom,
      data.productName,
      data.modele,
      data.model,
      data.produit,
      ...aliases
    ];
    const hasMatch = nameCandidates.some(entry => matchesTargetName(entry));
    if (!hasMatch) {
      return;
    }
    matches.push({
      id: doc.id,
      ref: doc.ref,
      data,
      name: data.name || data.nom || data.productName || data.modele || doc.id,
      stock: extractStockValue(data),
      createTime: doc.createTime ? doc.createTime.toDate() : null
    });
  });

  return matches;
}

function describeCandidate(candidate, index) {
  const created = candidate.createTime ? candidate.createTime.toISOString() : 'inconnu';
  const aliasList = Array.isArray(candidate.data.alias) ? candidate.data.alias.join(', ') : 'aucun';
  console.log(`  #${index + 1} ${candidate.id}`);
  console.log(`     nom        : ${candidate.name}`);
  console.log(`     stock      : ${candidate.stock}`);
  console.log(`     aliases    : ${aliasList}`);
  console.log(`     créé le    : ${created}`);
}

async function deleteDocumentWithSubcollections(docRef) {
  const collections = await docRef.listCollections();
  for (const collection of collections) {
    const snapshot = await collection.get();
    for (const doc of snapshot.docs) {
      await doc.ref.delete();
    }
  }
  await docRef.delete();
}

async function applyCorrections(candidates) {
  const sorted = [...candidates].sort((a, b) => {
    if (b.stock !== a.stock) {
      return b.stock - a.stock;
    }
    const timeA = a.createTime ? a.createTime.getTime() : 0;
    const timeB = b.createTime ? b.createTime.getTime() : 0;
    return timeA - timeB;
  });

  const keeper = sorted[0];
  const duplicates = sorted.slice(1);

  if (!keeper) {
    throw new Error('Impossible de déterminer l\'article principal Pop 10 128GB.');
  }

  console.log(`Article conservé: ${keeper.id} (${keeper.name})`);
  console.log(`Doublons à supprimer: ${duplicates.length}`);

  const payload = { stock: DESIRED_STOCK };
  ['quantity', 'qte', 'qty'].forEach(key => {
    if (Object.prototype.hasOwnProperty.call(keeper.data, key)) {
      payload[key] = DESIRED_STOCK;
    }
  });
  if (Object.prototype.hasOwnProperty.call(keeper.data, 'updatedAt')) {
    payload.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  }

  await keeper.ref.set(payload, { merge: true });
  console.log(`Stock mis à jour pour ${keeper.id}: ${keeper.stock} -> ${DESIRED_STOCK}`);

  for (const duplicate of duplicates) {
    console.log(`Suppression du doublon ${duplicate.id} (${duplicate.name})`);
    await deleteDocumentWithSubcollections(duplicate.ref);
  }
}

async function main() {
  const candidates = await fetchPop10StockDocs();
  if (!candidates.length) {
    console.log('Aucun article Pop 10 128GB trouvé dans la collection stock.');
    return;
  }

  console.log(`Articles Pop 10 128GB détectés: ${candidates.length}`);
  candidates.forEach((candidate, index) => describeCandidate(candidate, index));

  if (!APPLY_CHANGES) {
    console.log('Exécution en mode lecture seule. Relancez avec --apply pour corriger les doublons.');
    return;
  }

  await applyCorrections(candidates);

  console.log('Corrections appliquées avec succès.');

  const remaining = await fetchPop10StockDocs();
  remaining.forEach((candidate, index) => describeCandidate(candidate, index));
}

main()
  .catch(error => {
    console.error('Erreur lors de la correction Pop 10:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    return admin.app().delete().catch(() => {});
  });
