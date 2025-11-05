const admin = require('firebase-admin');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const SERVICE_ACCOUNT_PATH = path.join(
  __dirname,
  'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json'
);

function loadServiceAccount() {
  try {
    return require(SERVICE_ACCOUNT_PATH);
  } catch (error) {
    console.error('Impossible de charger le service account :', error.message);
    process.exit(1);
  }
}

function initFirebase() {
  if (admin.apps.length) {
    return admin.app();
  }
  const credentials = admin.credential.cert(loadServiceAccount());
  return admin.initializeApp({ credential: credentials });
}

function parseArgs(argv) {
  const opts = {};
  argv.forEach(arg => {
    const match = /^--([^=]+)=(.+)$/.exec(arg);
    if (!match) {
      return;
    }
    const [, key, value] = match;
    opts[key.trim().toLowerCase()] = value.trim();
  });
  return opts;
}

function normalizeMonth(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error('Format de mois invalide. Utilisez AAAA-MM (ex: 2025-11).');
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) {
    throw new Error('Mois invalide, doit être compris entre 01 et 12.');
  }
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  return { start, end, label: `${match[1]}-${match[2]}` };
}

function normalizeDate(value, label) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Format de date invalide pour ${label}. Utilisez AAAA-MM-JJ.`);
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, monthIndex, day));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Date invalide pour ${label}.`);
  }
  return date;
}

function resolveDateRange(opts) {
  if ((opts.start && !opts.end) || (!opts.start && opts.end)) {
    throw new Error('Veuillez fournir à la fois --start et --end, ou utiliser --month.');
  }
  if (opts.start && opts.end) {
    const start = normalizeDate(opts.start, 'start');
    const inclusiveEnd = normalizeDate(opts.end, 'end');
    const end = new Date(inclusiveEnd.getTime() + DAY_MS);
    if (end <= start) {
      throw new Error('La date de fin doit être postérieure à la date de début.');
    }
    return { start, end, label: `${opts.start} -> ${opts.end}` };
  }
  if (opts.month) {
    return normalizeMonth(opts.month);
  }
  const now = new Date();
  return normalizeMonth(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`);
}

function parseAmount(value) {
  if (value == null) {
    return 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    const sanitized = value.replace(/[^0-9.,-]/g, '').replace(/,/g, '.');
    const parsed = Number(sanitized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === 'object') {
    if (typeof value.toNumber === 'function') {
      return parseAmount(value.toNumber());
    }
    if (typeof value.valueOf === 'function' && value !== value.valueOf()) {
      return parseAmount(value.valueOf());
    }
  }
  return 0;
}

function extractTimestamp(raw) {
  if (raw == null) {
    return null;
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw.toDate === 'function') {
    return raw.toDate().getTime();
  }
  if (typeof raw.seconds === 'number') {
    return raw.seconds * 1000 + (raw.nanoseconds || 0) / 1e6;
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function fetchPapaExpenses(db, range) {
  const baseQuery = db.collection('depenses').where('type', '==', 'papa');
  try {
    const query = baseQuery
      .where('timestamp', '>=', range.start.getTime())
      .where('timestamp', '<', range.end.getTime());
    const snapshot = await query.get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    const needsFallback = error.code === 9 || /index/i.test(error.message || '');
    if (!needsFallback) {
      throw error;
    }
    console.warn('[AVERTISSEMENT] Index Firestore manquant pour le filtre de date, bascule sur un scan complet.');
    const snapshot = await baseQuery.get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }
}

function filterAndSortExpenses(rawExpenses, range) {
  const startMs = range.start.getTime();
  const endMs = range.end.getTime();
  return rawExpenses
    .map(entry => {
      const timestamp = extractTimestamp(entry.timestamp ?? entry.date ?? entry.dateString);
      return {
        id: entry.id,
        montant: parseAmount(entry.montant),
        description: entry.description || '(sans description)',
        compteNom: entry.compteNom || entry.compteId || 'compte inconnu',
        timestamp
      };
    })
    .filter(entry => entry.timestamp != null && entry.montant > 0)
    .filter(entry => entry.timestamp >= startMs && entry.timestamp < endMs)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function formatCurrency(value) {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'XOF',
    maximumFractionDigits: 0
  }).format(value);
}

function formatDateTime(timestamp) {
  const date = new Date(timestamp);
  return {
    day: date.toISOString().slice(0, 10),
    time: date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', hour12: false })
  };
}

function summarizeExpenses(expenses, range) {
  const total = expenses.reduce((sum, entry) => sum + entry.montant, 0);
  const uniqueDays = new Set(expenses.map(entry => formatDateTime(entry.timestamp).day));
  const daysInPeriod = Math.max(1, Math.round((range.end.getTime() - range.start.getTime()) / DAY_MS));
  const avgPerCalendarDay = total / daysInPeriod;
  const avgPerActiveDay = uniqueDays.size > 0 ? total / uniqueDays.size : 0;
  return {
    total,
    count: expenses.length,
    daysInPeriod,
    activeDays: uniqueDays.size,
    avgPerCalendarDay,
    avgPerActiveDay
  };
}

function printReport(expenses, range, stats) {
  console.log('====================================================');
  console.log('       Rapport des dépenses "Papa"');
  console.log('====================================================');
  console.log(`Période analysée : ${range.label}`);
  console.log(`Documents retenus : ${stats.count}`);
  console.log('');

  if (expenses.length === 0) {
    console.log('Aucune dépense Papa trouvée pour cette période.');
  } else {
    console.log('Détails des dépenses :');
    expenses.forEach(entry => {
      const { day, time } = formatDateTime(entry.timestamp);
      console.log(`- ${day} ${time} · ${entry.description} (${entry.compteNom}) : ${formatCurrency(entry.montant)}`);
    });
  }

  console.log('');
  console.log('----------------- Résumé -----------------');
  console.log(`Total du mois         : ${formatCurrency(stats.total)}`);
  console.log(`Jours dans la période : ${stats.daysInPeriod}`);
  console.log(`Moyenne / jour (mois) : ${formatCurrency(stats.avgPerCalendarDay)}`);
  if (stats.activeDays > 0) {
    console.log(`Jours avec dépenses   : ${stats.activeDays}`);
    console.log(`Moyenne / jour actif  : ${formatCurrency(stats.avgPerActiveDay)}`);
  }
  console.log('------------------------------------------');
}

async function main() {
  const app = initFirebase();
  try {
    const opts = parseArgs(process.argv.slice(2));
    const range = resolveDateRange(opts);
    const rawExpenses = await fetchPapaExpenses(admin.firestore(), range);
    const expenses = filterAndSortExpenses(rawExpenses, range);
    const stats = summarizeExpenses(expenses, range);
    printReport(expenses, range, stats);
  } catch (error) {
    console.error('[ERREUR] Impossible de produire le rapport :', error.message);
    process.exitCode = 1;
  } finally {
    await app.delete().catch(() => {});
  }
}

if (require.main === module) {
  main();
}
