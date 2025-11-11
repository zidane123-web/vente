#!/usr/bin/env node

/**
 * Exporte la collection Firestore `stock` dans un CSV avec prix unitaire, stock,
 * et fusion optionnelle avec un CSV de prix de vente.
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const SERVICE_ACCOUNT_FILE = 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json';
const DEFAULT_OUTPUT = 'stock_inventory_snapshot.csv';
const DEFAULT_PRODUCTS_FILE = 'products.csv';

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
      case '--products':
      case '-p':
        args.products = argv[i + 1];
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
  -p, --products <fichier>  CSV des prix de vente (defaut: ${DEFAULT_PRODUCTS_FILE} si present)
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

function normalizeKey(value) {
  if (value === null || value === undefined) return '';
  return value
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeCategoryKey(value) {
  const normalized = normalizeKey(value);
  if (!normalized) return '';
  if (normalized.includes('access')) return 'accessoires';
  if (
    normalized.includes('smart') ||
    normalized.includes('portable') ||
    normalized.includes('telephone') ||
    normalized.includes('phone') ||
    normalized.includes('tablette') ||
    normalized.includes('tablet')
  ) {
    return 'telephones';
  }
  return normalized;
}

function tokenizeKey(value) {
  return normalizeKey(value)
    .split(/\s+/)
    .filter(Boolean);
}

function tokenSimilarity(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const setB = new Set(bTokens);
  let intersection = 0;
  aTokens.forEach((token) => {
    if (setB.has(token)) {
      intersection += 1;
    }
  });
  if (intersection === 0) return 0;
  const union = new Set([...aTokens, ...bTokens]).size;
  const jaccard = union ? intersection / union : 0;
  const containment = intersection / Math.max(aTokens.length, bTokens.length);
  return Math.max(jaccard, containment);
}

function parseCsv(content) {
  const rows = [];
  let current = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(current);
      current = '';
    } else if (char === '\r') {
      // ignore carriage returns
    } else if (char === '\n') {
      row.push(current);
      rows.push(row);
      row = [];
      current = '';
    } else {
      current += char;
    }
  }

  if (current.length > 0 || row.length) {
    row.push(current);
    rows.push(row);
  }

  return rows;
}

function rowsToObjects(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows
    .slice(1)
    .filter((row) => row.some((cell) => cell && cell.trim && cell.trim() !== ''))
    .map((row) => {
      const record = {};
      headers.forEach((header, index) => {
        if (!header) return;
        record[header] = row[index] !== undefined ? row[index] : '';
      });
      return record;
    });
}

function loadSaleCatalog(filePath) {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Fichier produits introuvable: ${resolvedPath}`);
  }
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const rows = parseCsv(raw);
  const records = rowsToObjects(rows);
  const map = new Map();
  const entries = [];
  records.forEach((record) => {
    const name =
      (record.name ||
        record.Name ||
        record.produit ||
        record.Produit ||
        '').trim();
    if (!name) return;
    const price = coerceNumber(
      record.price ||
        record.prix ||
        record.prixVente ||
        record.salePrice ||
        record.prix_vente
    );
    if (!Number.isFinite(price) || price <= 0) {
      return;
    }
    const category = record.category || record.categorie || record.type || '';
    const normalizedCategory = normalizeCategoryKey(category);
    const key = normalizeKey(name);
    const tokens = tokenizeKey(name);
    if (!key || !tokens.length) return;
    const entry = {
      name,
      category,
      normalizedCategory,
      price,
      tokens
    };
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(entry);
    entries.push(entry);
  });
  return { path: resolvedPath, map, entries };
}

function findSalePrice(itemName, itemCategory, saleCatalog) {
  if (!saleCatalog) return null;
  const { map, entries } = saleCatalog;
  const key = normalizeKey(itemName);
  if (!key) return null;
  const normalizedCategory = normalizeCategoryKey(itemCategory);
  const exactMatches = map.get(key);
  if (exactMatches && exactMatches.length) {
    const preferred = normalizedCategory
      ? exactMatches.find(
        (candidate) => candidate.normalizedCategory === normalizedCategory
      )
      : null;
    return (preferred || exactMatches[0]).price;
  }

  const itemTokens = tokenizeKey(itemName);
  if (!itemTokens.length) return null;

  const MIN_SCORE = 0.55;
  let best = null;

  entries.forEach((candidate) => {
    if (!candidate.tokens.length) return;
    const baseScore = tokenSimilarity(itemTokens, candidate.tokens);
    if (baseScore < MIN_SCORE) return;
    let score = baseScore;
    if (
      normalizedCategory &&
      candidate.normalizedCategory &&
      candidate.normalizedCategory === normalizedCategory
    ) {
      score += 0.15;
    }
    if (candidate.tokens[0] && itemTokens[0] && candidate.tokens[0] === itemTokens[0]) {
      score += 0.05;
    }
    if (!best || score > best.score) {
      best = { score, price: candidate.price };
    }
  });

  return best ? best.price : null;
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
    toCsvRow(['Produit', 'Categorie', 'Stock', 'Prix achat (FCFA)', 'Prix vente (FCFA)'])
  ];
  items.forEach((item) => {
    rows.push(
      toCsvRow([
        item.name,
        item.category,
        item.stock,
        item.unitPrice,
        item.salePrice ?? ''
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
  const defaultProductsPath = path.join(__dirname, DEFAULT_PRODUCTS_FILE);
  const productsPath =
    args.products !== undefined
      ? path.resolve(process.cwd(), args.products)
      : fs.existsSync(defaultProductsPath)
        ? defaultProductsPath
        : undefined;

  try {
    console.log('Recuperation des articles en stock...');
    const items = await fetchStockItems(db);
    if (!items.length) {
      console.warn('Aucun article trouve dans la collection `stock`.');
    }
    let saleCatalog = null;
    if (productsPath) {
      try {
        saleCatalog = loadSaleCatalog(productsPath);
        console.log(`Catalogue de prix de vente charge: ${productsPath}`);
      } catch (loadError) {
        throw new Error(`Impossible de charger ${productsPath}: ${loadError.message}`);
      }
    } else {
      console.log('Aucun fichier de prix de vente detecte; la colonne restera vide.');
    }

    let matchedSalePrices = 0;
    const enrichedItems = items.map((item) => {
      const salePrice = saleCatalog ? findSalePrice(item.name, item.category, saleCatalog) : null;
      if (salePrice !== null && salePrice !== undefined) {
        matchedSalePrices += 1;
      }
      return { ...item, salePrice: salePrice ?? '' };
    });

    if (saleCatalog) {
      console.log(`Prix de vente trouves pour ${matchedSalePrices}/${items.length} articles.`);
    }

    await writeCsv(enrichedItems, outputPath);
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
