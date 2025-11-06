const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const DEFAULT_TIME_ZONE = 'Africa/Abidjan';
const DEFAULT_USER_UID = 'service-account-cli';
const DEFAULT_USER_NAME = 'Service Account (CLI)';
const SERVICE_ACCOUNT_PATH = path.join(
  __dirname,
  'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json'
);

const comptesCache = new Map();

function loadServiceAccount() {
  try {
    return require(SERVICE_ACCOUNT_PATH);
  } catch (error) {
    throw new Error(`Impossible de charger le service account (${error.message})`);
  }
}

function initFirebaseApp() {
  if (admin.apps.length) {
    return admin.app();
  }
  return admin.initializeApp({
    credential: admin.credential.cert(loadServiceAccount())
  });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._ = args._ || [];
      args._.push(token);
      continue;
    }
    const trimmed = token.slice(2);
    const [rawKey, rawValue] = trimmed.split('=', 2);
    const key = rawKey.toLowerCase();
    if (rawValue !== undefined) {
      args[key] = rawValue;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function parseAmount(input, label = 'montant') {
  if (input == null) {
    throw new Error(`Champ obligatoire manquant : ${label}`);
  }
  const normalized = String(input)
    .replace(/mille/gi, '000')
    .replace(/[^0-9,.\-]/g, '')
    .replace(/,/g, '.');
  const value = Number(normalized);
  if (!Number.isFinite(value) || value === 0) {
    throw new Error(`Valeur numerique invalide pour ${label} : ${input}`);
  }
  return value;
}

function parseDateParts(raw, referenceYear) {
  if (!raw) {
    throw new Error('Le champ date est obligatoire (ex: 2025-11-05 ou 05/11).');
  }
  const value = raw.trim();
  let year;
  let month;
  let day;

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return { year: y, month: m, day: d };
  }

  const ddmmyyyy = /^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/.exec(value);
  if (ddmmyyyy) {
    day = Number(ddmmyyyy[1]);
    month = Number(ddmmyyyy[2]);
    year = Number(ddmmyyyy[3]);
    return { year, month, day };
  }

  const ddmm = /^(\d{2})[\/\-](\d{2})$/.exec(value);
  if (ddmm) {
    day = Number(ddmm[1]);
    month = Number(ddmm[2]);
    year = referenceYear;
    return { year, month, day };
  }

  throw new Error(`Format de date invalide: ${value}`);
}

function parseTimeParts(raw) {
  if (!raw) {
    return { hour: 8, minute: 0 };
  }
  const value = raw.toString().trim();
  const hhmm = /^(\d{1,2})[:h](\d{2})$/.exec(value);
  if (hhmm) {
    const hour = Number(hhmm[1]);
    const minute = Number(hhmm[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error(`Heure invalide: ${value}`);
    }
    return { hour, minute };
  }
  const hhOnly = /^(\d{1,2})$/.exec(value);
  if (hhOnly) {
    const hour = Number(hhOnly[1]);
    if (hour < 0 || hour > 23) {
      throw new Error(`Heure invalide: ${value}`);
    }
    return { hour, minute: 0 };
  }
  throw new Error(`Format d'heure invalide: ${value}`);
}

function parseDateTimeParts(rawDateTime) {
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(rawDateTime);
  if (!isoMatch) {
    throw new Error(`Format datetime invalide: ${rawDateTime}`);
  }
  return {
    date: { year: Number(isoMatch[1]), month: Number(isoMatch[2]), day: Number(isoMatch[3]) },
    time: { hour: Number(isoMatch[4]), minute: Number(isoMatch[5]) }
  };
}

function buildTimestamp(dateParts, timeParts) {
  const { year, month, day } = dateParts;
  const { hour, minute } = timeParts;
  if (
    !Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
    !Number.isInteger(hour) || !Number.isInteger(minute)
  ) {
    throw new Error('Impossible de construire le timestamp, pieces invalides.');
  }
  return Date.UTC(year, month - 1, day, hour, minute, 0, 0);
}

function formatDateString(timestamp, timeZone = DEFAULT_TIME_ZONE) {
  return new Intl.DateTimeFormat('fr-FR', { timeZone }).format(new Date(timestamp));
}

async function resolveCompteDisplayName(db, compteId, fallback) {
  const key = compteId.trim();
  if (comptesCache.has(key)) {
    const cached = comptesCache.get(key);
    return cached.nom || fallback || key;
  }
  const result = { nom: fallback || '' };
  try {
    const compteDoc = await db.collection('comptes').doc(key).get();
    if (compteDoc.exists) {
      const data = compteDoc.data() || {};
      result.nom = data.nom || data.label || result.nom;
      result.type = data.type || null;
    }
  } catch (error) {
    console.warn(`[WARN] Impossible de lire comptes/${key} : ${error.message}`);
  }
  if (!result.nom) {
    try {
      const balanceDoc = await db
        .collection('tresorerie')
        .doc('balance')
        .collection('comptesTresorerie')
        .doc(key)
        .get();
      if (balanceDoc.exists) {
        const data = balanceDoc.data() || {};
        result.nom = data.nom || data.label || result.nom;
        result.type = result.type || data.type || null;
        result.solde = data.solde;
      }
    } catch (error) {
      console.warn(`[WARN] Impossible de lire tresorerie/balance/comptesTresorerie/${key} : ${error.message}`);
    }
  }
  if (!result.nom) {
    result.nom = fallback || key;
  }
  comptesCache.set(key, result);
  return result.nom;
}

function loadBatchFile(batchPath) {
  const absolute = path.isAbsolute(batchPath)
    ? batchPath
    : path.join(process.cwd(), batchPath);
  const content = fs.readFileSync(absolute, 'utf8');
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error(`Le fichier batch (${batchPath}) doit contenir un tableau JSON.`);
  }
  return parsed;
}

async function normalizeEntry(db, rawEntry, options = {}) {
  const referenceYear = options.referenceYear || new Date().getUTCFullYear();
  const timezone = rawEntry.timezone || options.timezone || DEFAULT_TIME_ZONE;
  const montant = parseAmount(
    rawEntry.amount ?? rawEntry.montant ?? rawEntry.value,
    'montant'
  );
  const description = (rawEntry.description ?? rawEntry.desc ?? '').toString().trim();
  if (!description) {
    throw new Error('La description est obligatoire.');
  }
  const compteId = (rawEntry.compte ?? rawEntry['compte-id'] ?? rawEntry.compteId ?? rawEntry.account ?? '').toString().trim();
  if (!compteId) {
    throw new Error('Le champ compte est obligatoire (ex: --compte=caisse).');
  }
  let timestamp = null;
  if (rawEntry.timestamp) {
    timestamp = Number(rawEntry.timestamp);
  } else if (rawEntry.datetime) {
    const parts = parseDateTimeParts(rawEntry.datetime);
    timestamp = buildTimestamp(parts.date, parts.time);
  } else {
    const dateParts = parseDateParts(rawEntry.date ?? rawEntry.jour, referenceYear);
    const timeParts = parseTimeParts(rawEntry.time ?? rawEntry.heure);
    timestamp = buildTimestamp(dateParts, timeParts);
  }
  if (!Number.isFinite(timestamp)) {
    throw new Error('Timestamp invalide calcule pour la depense.');
  }

  const type = (rawEntry.type || 'papa').toString().trim() || 'papa';
  const sens = (rawEntry.sens || (type === 'papa' ? 'out' : 'out')).toString().trim().toLowerCase();
  const userUid = (rawEntry['user-uid'] ?? rawEntry.userUid ?? rawEntry.uid ?? options.userUid ?? DEFAULT_USER_UID).toString().trim();
  const userName = (rawEntry['user-name'] ?? rawEntry.userName ?? rawEntry.utilisateur ?? options.userName ?? DEFAULT_USER_NAME).toString().trim();
  const compteNom = rawEntry['compte-nom']
    ? rawEntry['compte-nom'].toString().trim()
    : await resolveCompteDisplayName(db, compteId, rawEntry.compteNom || null);

  let proofPhoto = rawEntry['proof-photo'] || rawEntry.proofPhoto || rawEntry.proof || null;
  const proofFilePath = rawEntry['proof-file'] || rawEntry.proofFile;
  if (!proofPhoto && proofFilePath) {
    const absolute = path.isAbsolute(proofFilePath)
      ? proofFilePath
      : path.join(process.cwd(), proofFilePath);
    const mime = absolute.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    const buffer = fs.readFileSync(absolute);
    proofPhoto = `data:${mime};base64,${buffer.toString('base64')}`;
  }

  return {
    montant,
    description,
    type,
    sens,
    compteId,
    compteNom,
    timestamp,
    dateIso: new Date(timestamp).toISOString(),
    dateString: formatDateString(timestamp, timezone),
    enregistreParUid: userUid,
    enregistreParNom: userName,
    proofPhoto: proofPhoto || null,
    timezone
  };
}

async function recordTresorerieMovement(db, entry) {
  const balanceDoc = db.collection('tresorerie').doc('balance');
  const comptesCol = balanceDoc.collection('comptesTresorerie');
  const compteDoc = comptesCol.doc(entry.compteId);
  const delta = entry.sens === 'in' ? entry.montant : -entry.montant;
  const FieldValue = admin.firestore.FieldValue;

  return db.runTransaction(async tx => {
    const compteSnap = await tx.get(compteDoc);
    const currentBalance = compteSnap.exists ? Number(compteSnap.get('solde')) || 0 : 0;
    const newBalance = currentBalance + delta;

    tx.set(compteDoc, { solde: newBalance }, { merge: true });

    const mouvementRef = compteDoc.collection('mouvements').doc();
    const mouvementPayload = {
      timestamp: entry.timestamp,
      dateString: new Date(entry.timestamp).toISOString().slice(0, 10),
      type: entry.type,
      sens: entry.sens,
      montant: entry.montant,
      description: entry.description,
      refId: null,
      newBalance
    };
    if (entry.proofPhoto) {
      mouvementPayload.encaissementPhotos = [entry.proofPhoto];
    }

    tx.set(mouvementRef, mouvementPayload);

    tx.set(
      balanceDoc,
      { montant: FieldValue.increment(delta) },
      { merge: true }
    );

    return {
      mouvementId: mouvementRef.id,
      newBalance
    };
  });
}

async function writeDepenseDocument(db, entry) {
  const payload = {
    montant: entry.montant,
    description: entry.description,
    type: entry.type,
    timestamp: entry.timestamp,
    date: entry.dateIso,
    dateString: entry.dateString
  };
  if (entry.proofPhoto) {
    payload.proofPhoto = entry.proofPhoto;
  }
  if (entry.enregistreParUid) {
    payload.enregistreParUid = entry.enregistreParUid;
  }
  if (entry.enregistreParNom) {
    payload.enregistreParNom = entry.enregistreParNom;
  }
  if (entry.compteId) {
    payload.compteId = entry.compteId;
  }
  if (entry.compteNom) {
    payload.compteNom = entry.compteNom;
  }
  return db.collection('depenses').add(payload);
}

function printEntryPreview(entry, dryRun) {
  console.log('--------------------------------------------');
  console.log(dryRun ? '[SIMULATION]' : '[DEPENSE]');
  console.log(`Date         : ${entry.dateString}`);
  console.log(`Description  : ${entry.description}`);
  console.log(`Montant      : ${entry.montant}`);
  console.log(`Type/Sens    : ${entry.type} / ${entry.sens}`);
  console.log(`Compte       : ${entry.compteId} (${entry.compteNom})`);
  console.log(`Timestamp    : ${entry.timestamp}`);
  console.log(`Enregistre par : ${entry.enregistreParNom} (${entry.enregistreParUid})`);
  console.log('--------------------------------------------');
}

async function processEntries(db, entries, options) {
  const results = [];
  for (const rawEntry of entries) {
    const normalized = await normalizeEntry(db, rawEntry, options);
    const dryRun = Boolean(options.dryRun || rawEntry['dry-run'] || rawEntry.dryRun);
    printEntryPreview(normalized, dryRun);
    if (dryRun) {
      results.push({ dryRun: true, entry: normalized });
      continue;
    }
    const mouvement = await recordTresorerieMovement(db, normalized);
    const depenseRef = await writeDepenseDocument(db, normalized);
    console.log(`[OK] Depense enregistree avec l'ID ${depenseRef.id}`);
    results.push({
      entry: normalized,
      depenseId: depenseRef.id,
      mouvement
    });
  }
  return results;
}

async function listComptes(db) {
  const summary = new Map();

  function upsert(id, data) {
    if (!id) {
      return;
    }
    if (!summary.has(id)) {
      summary.set(id, { id, nom: '', type: '', solde: null });
    }
    const current = summary.get(id);
    if (data.nom && !current.nom) {
      current.nom = data.nom;
    }
    if (data.label && !current.nom) {
      current.nom = data.label;
    }
    if (data.type && !current.type) {
      current.type = data.type;
    }
    if (typeof data.solde === 'number') {
      current.solde = data.solde;
    }
  }

  try {
    const comptesSnap = await db.collection('comptes').get();
    comptesSnap.forEach(doc => upsert(doc.id, doc.data() || {}));
  } catch (error) {
    console.warn('[WARN] Lecture de la collection "comptes" impossible :', error.message);
  }

  try {
    const tresoSnap = await db
      .collection('tresorerie')
      .doc('balance')
      .collection('comptesTresorerie')
      .get();
    tresoSnap.forEach(doc => upsert(doc.id, doc.data() || {}));
  } catch (error) {
    console.warn('[WARN] Lecture des comptes de tresorerie impossible :', error.message);
  }

  console.log('Comptes disponibles :');
  summary.forEach(item => {
    console.log(
      `- ${item.id.padEnd(12)} | ${item.nom || '---'}${item.type ? ` | ${item.type}` : ''}${item.solde != null ? ` | solde: ${item.solde}` : ''}`
    );
  });
  if (!summary.size) {
    console.log('(Aucun compte detecte)');
  }
}

function buildEntriesFromArgs(args) {
  if (args.batch) {
    return loadBatchFile(args.batch);
  }
  return [args];
}

function printUsage() {
  console.log('Usage: node record_depense_papa.js --date=2025-11-05 --time=09:15 --description="..." --amount=12000 --compte=caisse');
  console.log('Options utiles :');
  console.log('  --time=HH:MM           Heure (par defaut: 08:00)');
  console.log('  --timezone=Zone        Zone IANA (par defaut: Africa/Abidjan)');
  console.log('  --user-name=Nom        Nom du declarant');
  console.log('  --user-uid=UID         UID du declarant');
  console.log('  --dry-run              Affiche la depense sans ecriture Firestore');
  console.log('  --batch=fichier.json   Fournit plusieurs depenses a enregistrer');
  console.log('  --list-comptes         Affiche les comptes disponibles et quitte');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h || args['?']) {
    printUsage();
    return;
  }

  const app = initFirebaseApp();
  try {
    const db = admin.firestore();
    if (args['list-comptes']) {
      await listComptes(db);
      return;
    }
    const entries = buildEntriesFromArgs(args);
    await processEntries(db, entries, {
      referenceYear: new Date().getUTCFullYear(),
      timezone: args.timezone || DEFAULT_TIME_ZONE,
      dryRun: args['dry-run'] || false,
      userName: args['user-name'],
      userUid: args['user-uid']
    });
  } catch (error) {
    console.error('[ERREUR] Impossible de traiter les depenses :', error.message);
    process.exitCode = 1;
  } finally {
    await app.delete().catch(() => {});
  }
}

if (require.main === module) {
  main();
}
