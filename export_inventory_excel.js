#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const ExcelJS = require('exceljs');
const pLimit = require('p-limit');

const SERVICE_ACCOUNT_FILE = 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json';
const BRAND_ORDER = { tecno: 1, infinix: 2, itel: 3, redmi: 4, samsung: 5 };

function parseArgs(argv) {
  const args = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--date':
      case '-d':
        args.date = argv[i + 1];
        i += 1;
        break;
      case '--output':
      case '-o':
        args.output = argv[i + 1];
        i += 1;
        break;
      case '--skip-history':
        args.skipHistory = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (token.startsWith('-')) {
          throw new Error(`Option inconnue: ${token}`);
        }
        args.positional.push(token);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node export_inventory_excel.js [options]

Options:
  -d, --date <AAAA-MM-JJ>   Date de référence pour inclure les mouvements (défaut: aujourd'hui)
  -o, --output <fichier>    Chemin du fichier Excel à générer
      --skip-history        N'inclut pas les articles à stock nul avec mouvement journalier
  -h, --help                Affiche cette aide
`);
}

function parseReportDate(rawValue) {
  if (!rawValue) {
    return new Date();
  }
  const isoMatch = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const date = new Date(`${rawValue}T00:00:00`);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Date invalide: ${rawValue}`);
    }
    return date;
  }
  const date = new Date(rawValue);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Date invalide: ${rawValue}`);
  }
  return date;
}

function formatDateForDisplay(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getFullYear()}`;
}

function formatTimeForDisplay(date) {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}h${minutes}`;
}

function formatDateForFilename(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}${month}${day}`;
}

function normalizeStock(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const parsed = Number(trimmed.replace(/[^0-9-]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value.toNumber === 'function') {
    const converted = Number(value.toNumber());
    return Number.isFinite(converted) ? converted : 0;
  }
  if (value && typeof value.valueOf === 'function') {
    return normalizeStock(value.valueOf());
  }
  return 0;
}

function getItemName(rawData, fallbackId) {
  return (
    rawData?.name ||
    rawData?.produit ||
    rawData?.designation ||
    rawData?.label ||
    rawData?.modele ||
    fallbackId ||
    'Article sans nom'
  );
}

function getBrandFromName(name) {
  if (!name) return '';
  const trimmed = name.trim();
  if (!trimmed) return '';
  return trimmed.split(/\s+/)[0].toLowerCase();
}

function sortTelephones(list) {
  list.sort((a, b) => {
    const brandA = getBrandFromName(a.name);
    const brandB = getBrandFromName(b.name);
    const orderA = BRAND_ORDER[brandA] || 999;
    const orderB = BRAND_ORDER[brandB] || 999;
    if (orderA !== orderB) return orderA - orderB;
    if (brandA !== brandB) return brandA.localeCompare(brandB, 'fr');
    return a.name.localeCompare(b.name, 'fr');
  });
}

async function shouldIncludeItem(docRef, stock, timestamp, skipHistory) {
  if (!Number.isFinite(stock)) return false;
  if (stock > 0) return true;
  if (stock === 0 && skipHistory) return false;
  try {
    const historySnapshot = await docRef
      .collection('history')
      .where('timestamp', '>=', timestamp)
      .limit(1)
      .get();
    return !historySnapshot.empty;
  } catch (error) {
    console.warn(`Impossible de lire l'historique pour ${docRef.id}: ${error.message}`);
    return false;
  }
}

async function fetchInventory(db, reportDate, skipHistory) {
  const startOfDay = new Date(reportDate.getFullYear(), reportDate.getMonth(), reportDate.getDate());
  const timestamp = admin.firestore.Timestamp.fromDate(startOfDay);
  const snapshot = await db.collection('stock').get();

  const telephones = [];
  const accessoires = [];
  const autres = [];
  let zeroStockIncluded = 0;

  const limit = pLimit(10);

  await Promise.all(snapshot.docs.map((doc) => limit(async () => {
    const data = doc.data() || {};
    const stock = normalizeStock(data.stock);
    const include = await shouldIncludeItem(doc.ref, stock, timestamp, skipHistory);
    if (!include) return;
    if (stock === 0) {
      zeroStockIncluded += 1;
    }

    const item = {
      id: doc.id,
      name: getItemName(data, doc.id),
      stock,
      category: data.category || ''
    };

    if (item.category === 'telephones') {
      telephones.push(item);
    } else if (item.category === 'accessoires') {
      accessoires.push(item);
    } else {
      autres.push(item);
    }
  })));

  sortTelephones(telephones);
  accessoires.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  autres.sort((a, b) => a.name.localeCompare(b.name, 'fr'));

  return { telephones, accessoires, autres, zeroStockIncluded };
}

function applyHeaderRowStyle(row, color) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
  row.alignment = { horizontal: 'center', vertical: 'middle' };
}

function applyTotalRowStyle(row) {
  row.font = { bold: true };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0F0' } };
}

function writeSection(sheet, title, items, options) {
  if (!items.length) return;
  sheet.addRow([]);
  const titleRow = sheet.addRow([title]);
  sheet.mergeCells(titleRow.number, 1, titleRow.number, 3);
  const titleCell = sheet.getCell(titleRow.number, 1);
  titleCell.font = { bold: true, size: 16 };
  titleCell.alignment = { horizontal: 'left' };

  const headerRow = sheet.addRow(['Produit', 'Stock Actuel', 'Quantité Comptée']);
  applyHeaderRowStyle(headerRow, options.headerColor);

  let total = 0;
  items.forEach((item) => {
    const row = sheet.addRow([item.name, item.stock, '']);
    row.getCell(2).alignment = { horizontal: 'center' };
    total += item.stock;
  });

  const totalRow = sheet.addRow([options.totalLabel, total, '']);
  applyTotalRowStyle(totalRow);
  totalRow.getCell(2).alignment = { horizontal: 'center' };
}

async function buildWorkbook(inventory, reportDate, outputPath) {
  const workbook = new ExcelJS.Workbook();
  const generatedAt = new Date();
  workbook.creator = 'POS Maintenance Scripts';
  workbook.created = generatedAt;
  workbook.modified = generatedAt;

  const sheet = workbook.addWorksheet('Inventaire', {
    properties: { defaultRowHeight: 20 }
  });

  sheet.getColumn(1).width = 48;
  sheet.getColumn(2).width = 18;
  sheet.getColumn(3).width = 22;
  sheet.getColumn(2).numFmt = '#,##0';

  const titleRow = sheet.addRow([`Fiche d'Inventaire des Téléphones - ${formatDateForDisplay(reportDate)}`]);
  sheet.mergeCells(titleRow.number, 1, titleRow.number, 3);
  const titleCell = sheet.getCell(titleRow.number, 1);
  titleCell.font = { bold: true, size: 18 };
  titleCell.alignment = { horizontal: 'left' };

  const subtitleRow = sheet.addRow([`Rapport généré le ${formatDateForDisplay(generatedAt)} à ${formatTimeForDisplay(generatedAt)} (heure locale)`]);
  sheet.mergeCells(subtitleRow.number, 1, subtitleRow.number, 3);
  const subtitleCell = sheet.getCell(subtitleRow.number, 1);
  subtitleCell.font = { color: { argb: 'FF666666' }, size: 11 };
  subtitleCell.alignment = { horizontal: 'left' };

  writeSection(sheet, 'Téléphones', inventory.telephones, {
    headerColor: 'FF006064',
    totalLabel: 'TOTAL TÉLÉPHONES'
  });

  writeSection(sheet, 'Accessoires', inventory.accessoires, {
    headerColor: 'FF004D40',
    totalLabel: 'TOTAL ACCESSOIRES'
  });

  if (inventory.autres.length) {
    writeSection(sheet, 'Autres catégories', inventory.autres, {
      headerColor: 'FF455A64',
      totalLabel: 'TOTAL AUTRES'
    });
  }

  await workbook.xlsx.writeFile(outputPath);
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      return;
    }

    const reportDate = parseReportDate(args.date);
    const serviceAccountPath = path.join(__dirname, SERVICE_ACCOUNT_FILE);

    if (!fs.existsSync(serviceAccountPath)) {
      throw new Error(`Service account introuvable: ${serviceAccountPath}`);
    }

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountPath)
      });
    }
    const db = admin.firestore();

    console.log(`Récupération du stock pour le ${formatDateForDisplay(reportDate)}...`);
    const inventory = await fetchInventory(db, reportDate, Boolean(args.skipHistory));
    console.log(`Téléphones: ${inventory.telephones.length}, Accessoires: ${inventory.accessoires.length}, Autres: ${inventory.autres.length}`);
    if (!args.skipHistory && inventory.zeroStockIncluded > 0) {
      console.log(`${inventory.zeroStockIncluded} article(s) à stock nul inclus grâce aux mouvements du jour.`);
    }

    if (inventory.telephones.length === 0 && inventory.accessoires.length === 0 && inventory.autres.length === 0) {
      console.warn('Aucun article à inclure dans la fiche d’inventaire.');
      return;
    }

    const defaultFilename = `inventaire_complet_${formatDateForFilename(reportDate)}.xlsx`;
    const resolvedOutput = args.output
      ? path.resolve(process.cwd(), args.output)
      : path.join(__dirname, defaultFilename);

    fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
    await buildWorkbook(inventory, reportDate, resolvedOutput);
    console.log(`Fiche d'inventaire générée: ${resolvedOutput}`);
  } catch (error) {
    console.error('Erreur lors de la génération de la fiche d’inventaire:', error.message);
    process.exitCode = 1;
  } finally {
    if (admin.apps.length) {
      await admin.app().delete().catch(() => {});
    }
  }
}

main();
