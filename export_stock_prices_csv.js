#!/usr/bin/env node

/**
 * Exporte la collection Firestore `stock` dans un CSV avec prix unitaire et stock.
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const SERVICE_ACCOUNT_FILE = 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json';
const DEFAULT_OUTPUT = 'stock_inventory_snapshot.csv';

function parseArgs(argv) {
  const args = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--output':
      case '-o':
        args.output = argv[i + 1];
        i += 1;
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
  console.log(`Usage: node export_stock_prices_csv.js [options]

Options:
  -o, --output <fichier>    Fichier de sortie (defaut: ${DEFAULT_OUTPUT})
  -h, --help                Affiche cette aide
`);
}

function coerceNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const normalized = Number(trimmed.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(normalized) ? normalized : 0;
  }
  if (typeof value.toNumber === 'function') {
    const asNumber = Number(value.toNumber());
    return Number.isFinite(asNumber) ? asNumber : 0;
  }
  if (typeof value.valueOf === 'function' && value.valueOf !== value) {
    return coerceNumber(value.valueOf());
  }
  return 0;
}

function getItemName(raw = {}, fallback = 'Article sans nom') {
  return (
    raw.name ||
    raw.nom ||
    raw.produit ||
    raw.designation ||
    raw.label ||
    raw.modele ||
    fallback
  );
}

function getUnitPrice(raw = {}) {
  const candidates = [
    raw.price,
    raw.prix,
    raw.prixVente,
    raw.prixUnitaire,
    raw.unitPrice,
    raw.sellingPrice,
    raw.pu,
    raw.prixVenteUnitaire,
    raw.publicPrice,
    raw.prixPublic,
    raw.coutAchat,
    raw.prixAchat,
    raw.cost
  ];
  for (const candidate of candidates) {
    const parsed = coerceNumber(candidate);
    if (parsed > 0) {
      return parsed;
    }
  }
  return 0;
}

function toCsvRow(fields) {
  return fields
    .map((value) => {
      const strValue = value === undefined || value === null ? '' : String(value);
      if (/["\n,]/.test(strValue)) {
        return `"${strValue.replace(/"/g, '""')}"`;
      }
      return strValue;
    })
    .join(',');
}

async function fetchStockItems(db) {
  const snapshot = await db.collection('stock').get();
  return snapshot.docs
    .map((doc) => {
      const data = doc.data() || {};
      return {
        id: doc.id,
        name: getItemName(data, doc.id),
        unitPrice: getUnitPrice(data),
        stock: coerceNumber(data.stock),
        category: data.category || data.categorie || ''
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

async function writeCsv(items, outputPath) {
  const rows = [
    toCsvRow(['Produit', 'Prix unitaire (FCFA)', 'Stock', 'Categorie'])
  ];
  items.forEach((item) => {
    rows.push(
      toCsvRow([
        item.name,
        item.unitPrice,
        item.stock,
        item.category
      ])
    );
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, rows.join('\n'), 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

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
  const outputPath = args.output
    ? path.resolve(process.cwd(), args.output)
    : path.join(__dirname, DEFAULT_OUTPUT);

  try {
    console.log('Recuperation des articles en stock...');
    const items = await fetchStockItems(db);
    if (!items.length) {
      console.warn('Aucun article trouve dans la collection `stock`.');
    }
    await writeCsv(items, outputPath);
    console.log(`CSV genere: ${outputPath}`);
  } catch (error) {
    console.error("Erreur lors de l'export CSV:", error.message);
    process.exitCode = 1;
  } finally {
    if (admin.apps.length) {
      await admin.app().delete().catch(() => {});
    }
  }
}

main();
