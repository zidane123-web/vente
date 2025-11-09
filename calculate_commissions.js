const path = require('path');
const admin = require('firebase-admin');

const serviceAccountPath = path.join(__dirname, 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json');
const serviceAccount = require(serviceAccountPath);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

const EMPLOYEES = [
  { id: 'manini', label: 'Manini', aliases: ['manini'] },
  { id: 'sherrif', label: 'Sherrif', aliases: ['sherrif', 'sherif', 'cherif', 'cheriff', 'sheriff'] }
];
const MANINI_ID = 'manini';

const RETAIL_BRACKETS = [
  { min: 0, max: 4999, commission: 50, label: '0 - 4 999' },
  { min: 5000, max: 20000, commission: 200, label: '5 000 - 20 000' },
  { min: 20000, max: 200000, commission: 800, label: '20 000 - 200 000' },
  { min: 200000, max: Infinity, commission: 1000, label: '200 000 +' }
];

// The brief only specifies 20k-100k and 200k+, so we stretch the 3rd bracket
// to 200k to avoid leaving a gap before the 200k+ tier.
const WHOLESALE_BRACKETS = [
  { min: 0, max: 4999, commission: 25, label: '0 - 4 999' },
  { min: 5000, max: 20000, commission: 50, label: '5 000 - 20 000' },
  { min: 20000, max: 200000, commission: 250, label: '20 000 - 200 000' },
  { min: 200000, max: Infinity, commission: 500, label: '200 000 +' }
];

const BONUS_THRESHOLDS = [
  { units: 400, bonus: 10000 },
  { units: 200, bonus: 5000 }
];

function parseYearMonth(arg) {
  if (!arg) {
    return { year: 2025, month: 10 };
  }
  const match = /^(\d{4})-(\d{2})$/.exec(arg);
  if (!match) {
    throw new Error('Format de période invalide. Utilisez AAAA-MM, exemple: 2025-10');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error('Le mois doit être compris entre 01 et 12.');
  }
  return { year, month };
}

function buildDateRange({ year, month }) {
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  return { start, end };
}

function normalizeString(value) {
  if (!value) {
    return '';
  }
  return value
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function toNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^0-9.,-]/g, '').replace(/,/g, '.');
    if (!cleaned) {
      return 0;
    }
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value.toNumber === 'function') {
    return toNumber(value.toNumber());
  }
  return 0;
}

function toDate(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value.toDate === 'function') {
    return value.toDate();
  }
  if (typeof value.seconds === 'number') {
    return new Date(value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6));
  }
  const millis = toNumber(value);
  return millis ? new Date(millis) : null;
}

function isSunday(date) {
  return date instanceof Date &&
    !Number.isNaN(date.getTime()) &&
    date.getUTCDay() === 0;
}

function resolveItemQuantity(item) {
  return Math.max(1, toNumber(item?.quantite ?? item?.qty ?? item?.quantity ?? 0));
}

function detectEmployeeId(sale) {
  const candidates = [
    sale.enregistreParNom,
    sale.enregistrePar,
    sale.createdBy,
    sale.userName,
    sale.enregistreParEmail,
    sale.ownerName
  ];

  for (const candidate of candidates) {
    const normalized = normalizeString(candidate);
    if (!normalized) {
      continue;
    }
    for (const employee of EMPLOYEES) {
      if (employee.aliases.some(alias => normalized.includes(alias))) {
        return employee.id;
      }
    }
  }
  return null;
}

function normalizeClientType(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return 'details';
  }
  if (normalized.includes('revendeur') || normalized.includes('gros') || normalized.includes('gross')) {
    return 'gros';
  }
  return 'details';
}

function pickBracket(clientType, unitPrice) {
  const brackets = clientType === 'gros' ? WHOLESALE_BRACKETS : RETAIL_BRACKETS;
  for (const bracket of brackets) {
    if (unitPrice >= bracket.min && unitPrice < bracket.max) {
      return bracket;
    }
  }
  return brackets[brackets.length - 1];
}

function extractUnitPrice(item, qty) {
  const directUnit = toNumber(
    item.prix ??
    item.price ??
    item.prixVente ??
    item.sellingPrice ??
    item.unitPrice
  );
  if (directUnit > 0) {
    return directUnit;
  }
  const total = toNumber(
    item.total ??
    item.totalVente ??
    item.totalPrice ??
    item.ligneTotal ??
    item.lineTotal
  );
  if (total > 0 && qty > 0) {
    return total / qty;
  }
  return 0;
}

function createEmptySummary(label) {
  return {
    label,
    salesCount: 0,
    totalUnits: 0,
    totalRevenue: 0,
    retailUnits: 0,
    wholesaleUnits: 0,
    retailCommission: 0,
    wholesaleCommission: 0,
    bonusVolume: 0,
    totalPayout: 0,
    bracketHits: {
      details: new Map(),
      gros: new Map()
    }
  };
}

function recordBracketHit(summary, clientType, bracket, qty, commission) {
  const targetMap = summary.bracketHits[clientType];
  if (!targetMap) {
    return;
  }
  const current = targetMap.get(bracket.label) || { units: 0, commission: 0 };
  current.units += qty;
  current.commission += commission;
  targetMap.set(bracket.label, current);
}

function applyBonus(summary) {
  for (const { units, bonus } of BONUS_THRESHOLDS) {
    if (summary.totalUnits >= units) {
      summary.bonusVolume = bonus;
      summary.totalPayout = summary.retailCommission + summary.wholesaleCommission + bonus;
      return;
    }
  }
  summary.bonusVolume = 0;
  summary.totalPayout = summary.retailCommission + summary.wholesaleCommission;
}

function formatCurrency(amount) {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'XOF',
    maximumFractionDigits: 0
  }).format(Math.round(amount));
}

function formatNumber(value) {
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(Math.round(value));
}

async function fetchSales(start, end) {
  const startTimestamp = admin.firestore.Timestamp.fromDate(start);
  const endTimestamp = admin.firestore.Timestamp.fromDate(end);
  const snapshot = await db
    .collection('ventes')
    .where('timestamp', '>=', startTimestamp)
    .where('timestamp', '<=', endTimestamp)
    .orderBy('timestamp', 'asc')
    .get();

  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

// Degressive commission per employee per month based on unit volume
// 1–200 units: 100% of band rate; 201–400: 50%; 401+: 30%
function computeDegressiveCommission({ employeeId, qty, baseCommissionPerUnit, employeeUnits }) {
  const firstThreshold = 200;
  const secondThreshold = 400;
  let current = employeeUnits.get(employeeId) || 0;
  let remaining = qty;
  let commission = 0;

  // Segment 1 (to 200)
  if (current < firstThreshold && remaining > 0) {
    const seg1Cap = firstThreshold - current;
    const seg1Qty = Math.min(remaining, seg1Cap);
    commission += seg1Qty * baseCommissionPerUnit * 1.0;
    current += seg1Qty;
    remaining -= seg1Qty;
  }
  // Segment 2 (201–400)
  if (current < secondThreshold && remaining > 0) {
    const seg2Cap = secondThreshold - current;
    const seg2Qty = Math.min(remaining, seg2Cap);
    commission += seg2Qty * baseCommissionPerUnit * 0.5;
    current += seg2Qty;
    remaining -= seg2Qty;
  }
  // Segment 3 (401+)
  if (remaining > 0) {
    commission += remaining * baseCommissionPerUnit * 0.3;
    current += remaining;
    remaining = 0;
  }

  employeeUnits.set(employeeId, current);
  return commission;
}

async function main() {
  const periodArg = process.argv[2];
  const { year, month } = parseYearMonth(periodArg || '2025-10');
  const { start, end } = buildDateRange({ year, month });

  console.log(`Calcul des commissions pour ${year}-${String(month).padStart(2, '0')}`);
  console.log(`Période UTC: ${start.toISOString()} -> ${end.toISOString()}`);
  console.log('Méthode: dégressive uniforme (1–200:100%, 201–400:50%, 401+:30%)');

  const sales = await fetchSales(start, end);
  console.log(`Ventes totales récupérées: ${sales.length}`);

  const summaries = new Map(EMPLOYEES.map(emp => [emp.id, createEmptySummary(emp.label)]));
  const sundaySkips = new Map(EMPLOYEES.map(emp => [emp.id, 0]));
  const sundaySkipUnits = new Map(EMPLOYEES.map(emp => [emp.id, 0]));
  const unmatchedSales = [];
  // Track per-employee units counted for degressive tiers
  const employeeUnits = new Map(EMPLOYEES.map(emp => [emp.id, 0]));

  for (const sale of sales) {
    const employeeId = detectEmployeeId(sale);
    if (!employeeId || !summaries.has(employeeId)) {
      unmatchedSales.push(sale);
      continue;
    }

    const items = Array.isArray(sale.items) ? sale.items : [];

    if (employeeId === MANINI_ID) {
      const saleDate = toDate(sale.timestamp);
      if (isSunday(saleDate)) {
        const sundayUnits = items.reduce((total, item) => total + resolveItemQuantity(item), 0);
        sundaySkips.set(employeeId, (sundaySkips.get(employeeId) || 0) + 1);
        sundaySkipUnits.set(employeeId, (sundaySkipUnits.get(employeeId) || 0) + sundayUnits);
        continue;
      }
    }

    const summary = summaries.get(employeeId);
    const clientType = normalizeClientType(sale.clientType);

    if (items.length === 0) {
      continue;
    }

    summary.salesCount += 1;

    for (const item of items) {
      const qty = resolveItemQuantity(item);
      const unitPrice = extractUnitPrice(item, qty);
      const lineRevenue = unitPrice * qty;
      const bracket = pickBracket(clientType, unitPrice);
      const baseCommissionPerUnit = bracket.commission;
      // Apply degressive commission uniformly to all employees
      const lineCommission = computeDegressiveCommission({
        employeeId,
        qty,
        baseCommissionPerUnit,
        employeeUnits
      });

      summary.totalUnits += qty;
      summary.totalRevenue += lineRevenue;

      if (clientType === 'gros') {
        summary.wholesaleUnits += qty;
        summary.wholesaleCommission += lineCommission;
      } else {
        summary.retailUnits += qty;
        summary.retailCommission += lineCommission;
      }

      recordBracketHit(summary, clientType, bracket, qty, lineCommission);
    }
  }

  for (const summary of summaries.values()) {
    applyBonus(summary);
  }

  for (const employee of EMPLOYEES) {
    const summary = summaries.get(employee.id);
    console.log('\n------------------------------');
    console.log(`Employé: ${employee.label}`);
    if (summary.salesCount === 0) {
      console.log('  Aucune vente associée sur la période.');
      continue;
    }
    const skippedSundayCount = sundaySkips.get(employee.id) || 0;
    const skippedSundayUnits = sundaySkipUnits.get(employee.id) || 0;
    console.log(`  Ventes traitées: ${summary.salesCount}`);
    console.log(`  Téléphones vendus: ${formatNumber(summary.totalUnits)} (détails ${formatNumber(summary.retailUnits)}, gros ${formatNumber(summary.wholesaleUnits)})`);
    console.log(`  CA estimé: ${formatCurrency(summary.totalRevenue)}`);
    console.log(`  Commission détails: ${formatCurrency(summary.retailCommission)}`);
    console.log(`  Commission gros: ${formatCurrency(summary.wholesaleCommission)}`);
    console.log(`  Bonus volume: ${formatCurrency(summary.bonusVolume)}`);
    console.log(`  Total à payer: ${formatCurrency(summary.totalPayout)}`);
    if (skippedSundayCount > 0) {
      console.log(`  Ventes ignorées (dimanche): ${skippedSundayCount} | Téléphones ignorés: ${formatNumber(skippedSundayUnits)}`);
    }

    const detailBrackets = summary.bracketHits.details;
    const wholesaleBrackets = summary.bracketHits.gros;

    if (detailBrackets.size > 0) {
      console.log('  Répartition détails:');
      for (const [label, stats] of detailBrackets.entries()) {
        console.log(`    • ${label}: ${formatNumber(stats.units)} tél. | ${formatCurrency(stats.commission)}`);
      }
    }
    if (wholesaleBrackets.size > 0) {
      console.log('  Répartition gros:');
      for (const [label, stats] of wholesaleBrackets.entries()) {
        console.log(`    • ${label}: ${formatNumber(stats.units)} tél. | ${formatCurrency(stats.commission)}`);
      }
    }
  }

  const unmatchedCount = unmatchedSales.length;
  if (unmatchedCount > 0) {
    const sample = unmatchedSales.slice(0, 5).map(sale => {
      const ts = toDate(sale.timestamp);
      const iso = ts ? ts.toISOString().slice(0, 10) : 'date inconnue';
      return `${sale.id} (${iso})`;
    });
    console.log('\n------------------------------');
    console.warn(`Attention: ${unmatchedCount} ventes n'ont pas pu être attribuées à Manini/Sherrif.`);
    console.warn(`Échantillon: ${sample.join(', ')}`);
  }

  const maniniSundaySkips = sundaySkips.get(MANINI_ID) || 0;
  const maniniSundayUnits = sundaySkipUnits.get(MANINI_ID) || 0;
  if (maniniSundaySkips > 0) {
    console.log(`\nDimanches exclus pour Manini: ${maniniSundaySkips} ventes (${formatNumber(maniniSundayUnits)} téléphones) retirées du calcul.`);
  }
}

main()
  .catch(error => {
    console.error('Erreur lors du calcul des commissions:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    admin.app().delete().catch(() => {});
  });
