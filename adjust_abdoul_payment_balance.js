const path = require('path');
const admin = require('firebase-admin');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const SERVICE_ACCOUNT_FILE = 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json';
const SUPPLIER_NAME = 'Abdoul';
const DEFAULT_EXPECTED_BALANCE = 3000000;
const DEFAULT_PREVIOUS_BALANCE = 3007500;
const BALANCE_TOLERANCE = 100;

const argv = yargs(hideBin(process.argv))
  .option('supplier', {
    type: 'string',
    default: SUPPLIER_NAME,
    describe: 'Nom du fournisseur ciblé'
  })
  .option('expected', {
    alias: 'e',
    type: 'number',
    default: DEFAULT_EXPECTED_BALANCE,
    describe: 'Solde attendu après paiement'
  })
  .option('previous', {
    alias: 'p',
    type: 'number',
    default: DEFAULT_PREVIOUS_BALANCE,
    describe: 'Valeur actuelle du solde à corriger'
  })
  .option('doc', {
    type: 'string',
    describe: "Identifiant approvisionnement à corriger (sinon auto-détection)"
  })
  .option('payment', {
    type: 'string',
    describe: "Identifiant de la sous-collection payments à corriger (sinon auto)"
  })
  .option('apply', {
    alias: 'a',
    type: 'boolean',
    default: false,
    describe: 'Applique la mise à jour (sinon simple aperçu)'
  })
  .help()
  .alias('help', 'h')
  .parse();

const serviceAccountPath = path.join(__dirname, SERVICE_ACCOUNT_FILE);
let serviceAccount;
try {
  serviceAccount = require(serviceAccountPath);
} catch (error) {
  console.error('Impossible de charger le service account Firebase:', error.message);
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

function parseNumeric(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const normalized = trimmed.replace(/[^0-9.,-]/g, '').replace(/,/g, '.');
    if (!normalized) return 0;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === 'object') {
    if (typeof value.toNumber === 'function') {
      return parseNumeric(value.toNumber());
    }
    if (typeof value.valueOf === 'function' && value !== value.valueOf()) {
      return parseNumeric(value.valueOf());
    }
  }
  return 0;
}

async function fetchSupplierPurchases(supplier) {
  const snapshot = await db
    .collection('approvisionnement')
    .where('fournisseur', '==', supplier)
    .orderBy('timestamp', 'desc')
    .get();
  return snapshot.docs;
}

async function fetchPaymentDocs(approRef) {
  const snapshot = await approRef.collection('payments').orderBy('date', 'desc').get();
  return snapshot.docs;
}

function formatAmount(value) {
  return `${Math.round(value).toLocaleString('fr-FR')} FCFA`;
}

async function findTargetPayment() {
  const supplierName = argv.supplier;
  if (!supplierName) {
    throw new Error('Fournisseur non défini.');
  }

  const docs = await fetchSupplierPurchases(supplierName);
  if (!docs.length) {
    throw new Error(`Aucun approvisionnement trouvé pour ${supplierName}.`);
  }

  const explicitDoc = argv.doc ? docs.find(doc => doc.id === argv.doc) : null;
  const scanDocs = explicitDoc ? [explicitDoc] : docs;

  const matches = [];

  for (const docSnap of scanDocs) {
    const paymentsDocs = await fetchPaymentDocs(docSnap.ref);
    for (const paymentDoc of paymentsDocs) {
      const data = paymentDoc.data();
      const balanceAfter = parseNumeric(data.balanceAfter);
      if (
        argv.payment &&
        paymentDoc.id !== argv.payment
      ) {
        continue;
      }
      if (
        Math.abs(balanceAfter - argv.previous) <= BALANCE_TOLERANCE ||
        (argv.payment && paymentDoc.id === argv.payment)
      ) {
        matches.push({
          approId: docSnap.id,
          paymentId: paymentDoc.id,
          balanceAfter,
          amount: parseNumeric(data.amount),
          appliedAmount: parseNumeric(data.appliedAmount),
          data,
          ref: paymentDoc.ref
        });
      }
    }
    if (matches.length && (!argv.payment && !argv.doc)) {
      break;
    }
  }

  if (!matches.length) {
    throw new Error("Aucun paiement correspondant n'a été trouvé.");
  }
  if (matches.length > 1 && (!argv.doc || !argv.payment)) {
    console.log('Plusieurs paiements correspondent. Fournissez --doc et --payment pour cibler:');
    matches.forEach(match => {
      console.log(
        ` - appro=${match.approId} / payment=${match.paymentId} · balanceAfter=${formatAmount(match.balanceAfter)}`
      );
    });
    throw new Error('Plusieurs correspondances détectées.');
  }

  return matches[0];
}

async function adjustPaymentBalance() {
  const targetBalance = Number.isFinite(argv.expected) ? argv.expected : DEFAULT_EXPECTED_BALANCE;
  const match = await findTargetPayment();
  console.log(`Paiement trouvé: appro=${match.approId} / payment=${match.paymentId}`);
  console.log(`Balance actuelle: ${formatAmount(match.balanceAfter)}. Balance attendue: ${formatAmount(targetBalance)}.`);

  if (!argv.apply) {
    console.log('Dry-run: aucune mise à jour appliquée. Relancez avec --apply pour corriger.');
    return;
  }

  const balanceDelta = targetBalance - match.balanceAfter;
  if (Math.abs(balanceDelta) < 1e-3) {
    console.log('Aucun écart détecté, aucune mise à jour nécessaire.');
    return;
  }
  const paymentDelta = -balanceDelta;

  const newAmount = Math.max(0, parseNumeric(match.amount) + paymentDelta);
  const newApplied = Math.max(0, parseNumeric(match.appliedAmount) + paymentDelta);

  await match.ref.update({
    balanceAfter: targetBalance,
    amount: newAmount,
    appliedAmount: newApplied
  });
  console.log(`• Paiement ajusté: montant=${formatAmount(newAmount)}, applied=${formatAmount(newApplied)}, balance=${formatAmount(targetBalance)}`);

  const approRef = match.ref.parent.parent;
  if (approRef) {
    const approSnap = await approRef.get();
    if (approSnap.exists) {
      const approData = approSnap.data();
      const paymentsTotal = parseNumeric(approData.paymentsTotalPaid) + paymentDelta;
      const remainingAmount = Math.max(0, parseNumeric(approData.remainingAmount) + balanceDelta);
      const netSupplierBalance = parseNumeric(approData.netSupplierBalance) + paymentDelta;
      await approRef.update({
        paymentsTotalPaid: paymentsTotal,
        remainingAmount,
        netSupplierBalance
      });
      console.log(
        `• Approvisionnement mis à jour: paymentsTotalPaid=${formatAmount(paymentsTotal)}, remainingAmount=${formatAmount(remainingAmount)}, netSupplierBalance=${formatAmount(netSupplierBalance)}`
      );
    }
  }

  console.log('Correction terminée.');
}

adjustPaymentBalance()
  .catch(error => {
    console.error('Erreur lors de la correction du paiement:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await admin.app().delete().catch(() => {});
  });
