#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const SERVICE_ACCOUNT_FILE = 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json';

function printUsage() {
  console.log('Usage: node dump_firestore_doc.js <collection> <docId>');
  console.log('Example: node dump_firestore_doc.js ventes Evy60DxCyUY4IACv4zfY');
}

async function main() {
  const [collection, docId] = process.argv.slice(2);
  if (!collection || !docId || collection === '--help' || collection === '-h') {
    printUsage();
    process.exit(collection ? 0 : 1);
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

  try {
    const db = admin.firestore();
    const snap = await db.collection(collection).doc(docId).get();
    if (!snap.exists) {
      console.error(`Document ${collection}/${docId} introuvable.`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(snap.data(), null, 2));
  } catch (error) {
    console.error('Erreur lors de la lecture du document:', error);
    process.exitCode = 1;
  } finally {
    if (admin.apps.length) {
      await admin.app().delete().catch(() => {});
    }
  }
}

main();

