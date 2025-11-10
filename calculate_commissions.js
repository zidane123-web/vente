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

const UNIT_COMMISSION_STEP = 100;
const UNIT_COMMISSION_RATE = 10000; // per tranche of 100 phones
const DAILY_REVENUE_THRESHOLD = 1_000_000; // F CFA
const DAILY_REVENUE_BONUS = 2000; // per qualifying day

const EMPLOYEE_ID_OVERRIDES = {
  '2025-10': [
    {
      source: 'zizakod',
      target: 'manini',
      start: '2025-10-01',
      end: '2025-10-15',
      note: 'Ventes attribuées à Manini (01-15 octobre)'
    }
  ]
};


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

function collectEmployeeCandidates(sale) {
  const candidates = [
    sale.enregistreParNom,
    sale.enregistrePar,
    sale.createdBy,
    sale.userName,
    sale.enregistreParEmail,
    sale.ownerName
  ];
  const seen = new Set();
  const normalizedCandidates = [];
  for (const candidate of candidates) {
    const normalized = normalizeString(candidate);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    normalizedCandidates.push(normalized);
  }
  return normalizedCandidates;
}

function detectEmployeeIdFromCandidates(candidates) {
  for (const normalized of candidates) {
    for (const employee of EMPLOYEES) {
      if (employee.aliases.some(alias => normalized.includes(alias))) {
        return employee.id;
      }
    }
  }
  return null;
}

function detectEmployeeId(sale) {
  return detectEmployeeIdFromCandidates(collectEmployeeCandidates(sale));
}

function parseDateOnly(isoDateString) {
  if (!isoDateString) {
    return null;
  }
  const parts = isoDateString.split('-').map(Number);
  if (parts.length !== 3) {
    return null;
  }
  const [year, month, day] = parts;
  if ([year, month, day].some(value => Number.isNaN(value))) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

function isWithinOverrideRange(date, start, end) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return false;
  }
  const startDate = parseDateOnly(start);
  if (startDate && date < startDate) {
    return false;
  }
  const endDate = parseDateOnly(end);
  if (endDate) {
    const endBoundary = new Date(endDate.getTime() + (24 * 60 * 60 * 1000) - 1);
    if (date > endBoundary) {
      return false;
    }
  }
  return true;
}

function applyEmployeeOverrides({ employeeId, rawIdentifier, saleDate, periodKey }) {
  const overrides = EMPLOYEE_ID_OVERRIDES[periodKey] || [];
  const normalizedRaw = normalizeString(rawIdentifier);
  const normalizedEmployee = normalizeString(employeeId);
  for (const override of overrides) {
    const normalizedSource = normalizeString(override.source);
    const matchesSource =
      (normalizedEmployee && normalizedEmployee.includes(normalizedSource)) ||
      (normalizedRaw && normalizedRaw.includes(normalizedSource));
    if (!matchesSource) {
      continue;
    }
    if (!isWithinOverrideRange(saleDate, override.start, override.end)) {
      continue;
    }
    return override.target;
  }
  return employeeId;
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
    unitsCommission: 0,
    dailyRevenueBonus: 0,
    dailyMillionDays: 0,
    totalPayout: 0,
    dailyRevenue: new Map()
  };
}

function applyCommissionRules(summary) {
  const unitsCommission = Math.floor(summary.totalUnits / UNIT_COMMISSION_STEP) * UNIT_COMMISSION_RATE;
  const millionDays = Array.from(summary.dailyRevenue.values()).filter(total => total >= DAILY_REVENUE_THRESHOLD).length;
  const dailyRevenueBonus = millionDays * DAILY_REVENUE_BONUS;
  summary.unitsCommission = unitsCommission;
  summary.dailyRevenueBonus = dailyRevenueBonus;
  summary.dailyMillionDays = millionDays;
  summary.totalPayout = unitsCommission + dailyRevenueBonus;
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

async function main() {
  const periodArg = process.argv[2];
  const { year, month } = parseYearMonth(periodArg || '2025-10');
  const { start, end } = buildDateRange({ year, month });

  const periodKey = `${year}-${String(month).padStart(2, '0')}`;
  console.log(`Calcul des commissions pour ${periodKey}`);
  console.log(`Période UTC: ${start.toISOString()} -> ${end.toISOString()}`);
  console.log('Méthode: forfait 10 000 F par tranche de 100 téléphones + bonus journalier 2 000 F si CA ≥ 1 000 000 F.');
  console.log('Règle unités: plancher(total_tél. / 100) × 10 000 F.');
  console.log('Règle journalier: nombre de jours à 1 000 000 F CA × 2 000 F.');

  const sales = await fetchSales(start, end);
  console.log(`Ventes totales récupérées: ${sales.length}`);

  const summaries = new Map(EMPLOYEES.map(emp => [emp.id, createEmptySummary(emp.label)]));
  const sundaySkips = new Map(EMPLOYEES.map(emp => [emp.id, 0]));
  const sundaySkipUnits = new Map(EMPLOYEES.map(emp => [emp.id, 0]));
  const unmatchedSales = [];

  for (const sale of sales) {
    const candidates = collectEmployeeCandidates(sale);
    const primaryIdentifier = candidates[0] || '';
    let employeeId = detectEmployeeIdFromCandidates(candidates);
    const saleDate = toDate(sale.timestamp);
    employeeId = applyEmployeeOverrides({
      employeeId,
      rawIdentifier: primaryIdentifier,
      saleDate,
      periodKey
    });

    if (!employeeId || !summaries.has(employeeId)) {
      unmatchedSales.push(sale);
      continue;
    }

    const items = Array.isArray(sale.items) ? sale.items : [];

    if (employeeId === MANINI_ID) {
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
    let saleRevenueTotal = 0;

    for (const item of items) {
      const qty = resolveItemQuantity(item);
      const unitPrice = extractUnitPrice(item, qty);
      const lineRevenue = unitPrice * qty;

      summary.totalUnits += qty;
      summary.totalRevenue += lineRevenue;
      saleRevenueTotal += lineRevenue;

      if (clientType === 'gros') {
        summary.wholesaleUnits += qty;
      } else {
        summary.retailUnits += qty;
      }
    }

    if (saleRevenueTotal > 0) {
      const dayKey = saleDate ? saleDate.toISOString().slice(0, 10) : 'date inconnue';
      summary.dailyRevenue.set(dayKey, (summary.dailyRevenue.get(dayKey) || 0) + saleRevenueTotal);
    }
  }

  for (const summary of summaries.values()) {
    applyCommissionRules(summary);
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
    console.log(`  Commission unités (10 000 F / 100 tél.): ${formatCurrency(summary.unitsCommission)}`);
    const millionDaysLabel = summary.dailyMillionDays > 0 ? ` (${summary.dailyMillionDays} jour${summary.dailyMillionDays > 1 ? 's' : ''} ≥ 1 000 000 F)` : '';
    console.log(`  Bonus jours millionnaires: ${formatCurrency(summary.dailyRevenueBonus)}${millionDaysLabel}`);
    console.log(`  Total à payer: ${formatCurrency(summary.totalPayout)}`);
    if (skippedSundayCount > 0) {
      console.log(`  Ventes ignorées (dimanche): ${skippedSundayCount} | Téléphones ignorés: ${formatNumber(skippedSundayUnits)}`);
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
