const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const INDEX_SOURCE = fs.readFileSync(INDEX_PATH, 'utf8');

function extractLivraisonChunk() {
  const startMarker = 'function ouvrirModalLivraisonEncaissement() {';
  const endMarker = '</script>';
  const start = INDEX_SOURCE.indexOf(startMarker);
  const end = INDEX_SOURCE.indexOf(endMarker, start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Impossible de localiser le module d'encaissement livraison dans index.html");
  }
  return INDEX_SOURCE.substring(start, end);
}

const LIVRAISON_CHUNK = extractLivraisonChunk();

function createDom() {
  return new JSDOM(`
    <!doctype html><body>
      <div id="modalLivraisonEncaissement" style="display:none"></div>
      <div id="livraison-payments-container-wrapper">
        <div id="livraisonPaymentsContainer"></div>
      </div>
      <div id="livraison-summary-total-due"></div>
      <div id="livraison-summary-total-paid"></div>
      <div id="livraison-summary-total-change"></div>
      <div id="livraison-summary-net"></div>
      <div id="livraison-payment-warning"></div>
    </body>
  `, { url: 'http://localhost/#livraison-detail' });
}

function setupLivraisonContext(overrides = {}) {
  const dom = createDom();
  const win = dom.window;
  win.console = console;
  win.lucide = { createIcons: () => {} };
  win.formatXofAmount = (value) => `${Number(value || 0).toFixed(0)} FCFA`;
  win.setLivraisonDetailAlert = () => {};
  win.computeLivraisonTotals = () => ({ due: 0, totalEncaisse: 0, totalChange: 0, net: 0, outstanding: 0 });
  win.remplirTousSelectComptes = () => {};
  win.showLivraisonDetailLoader = () => {};
  win.updateSaleFirestore = async () => {};
  win.enregistrerMouvementTresorerie = async () => {};
  win.updateStockAfterSaleFirestore = async () => {};
  win.populateLivraisonDetailView = () => {};
  win.filterSalesHistory = () => {};
  win.afficherLivraisons = () => {};
  win.comptesCache = [];
  win.firebase = { firestore: { FieldValue: { serverTimestamp: () => 'timestamp' } } };

  Object.assign(win, overrides);

  const context = vm.createContext(win);
  vm.runInContext(LIVRAISON_CHUNK, context);

  context.livraisonPayments = [];
  context.livraisonPaymentAutoId = 0;
  context.livraisonModalContext = null;
  context.currentLivraisonData = null;
  context.currentLivraisonId = null;

  return { dom, context };
}

function testOuvrirModalSansSelection() {
  const { context, dom } = setupLivraisonContext();
  const alerts = [];
  context.setLivraisonDetailAlert = (message, level) => {
    alerts.push({ message, level });
  };
  const modal = dom.window.document.getElementById('modalLivraisonEncaissement');
  context.ouvrirModalLivraisonEncaissement();
  assert.strictEqual(alerts.length, 1, "Une alerte doit informer l'utilisateur qu'aucune livraison n'est selectionnee");
  assert.strictEqual(alerts[0].level, 'danger');
  assert.strictEqual(modal.style.display, 'none', 'Le modal doit rester masque');
  assert.strictEqual(context.livraisonModalContext, null, 'Le contexte du modal ne doit pas etre initialise');
}

function testOuvrirModalAvecSelection() {
  const totals = { due: 1200, totalEncaisse: 300, totalChange: 50, net: 250, outstanding: 900 };
  const { context, dom } = setupLivraisonContext({
    computeLivraisonTotals: () => totals
  });

  let resumeCalled = 0;
  const originalResume = context.rafraichirResumePaiementLivraison;
  context.rafraichirResumePaiementLivraison = function wrapped() {
    resumeCalled += 1;
    return originalResume.apply(this, arguments);
  };

  context.currentLivraisonData = { id: 'liv1' };
  context.currentLivraisonId = 'liv1';

  const modal = dom.window.document.getElementById('modalLivraisonEncaissement');
  context.ouvrirModalLivraisonEncaissement();

  assert.deepStrictEqual(context.livraisonModalContext.totals, totals, 'Les totaux doivent etre stockes pour le modal');
  assert.strictEqual(modal.style.display, 'flex', "Le modal doit s'afficher");
  assert.strictEqual(context.livraisonPayments.length, 1, 'Une ligne de paiement par defaut doit etre ajoutee');
  assert.strictEqual(context.livraisonPayments[0].montantEncaisse, totals.outstanding.toFixed(2), 'Le montant presaisi doit correspondre au restant du');
  assert.ok(resumeCalled >= 1, 'Le resume des paiements doit etre recalcule');
}

async function testValiderAvecMontantRestant() {
  const { context, dom } = setupLivraisonContext();
  context.currentLivraisonData = { id: 'liv2' };
  context.currentLivraisonId = 'liv2';
  context.livraisonModalContext = {
    totals: { due: 1000, totalEncaisse: 0, totalChange: 0, net: 0, outstanding: 1000 }
  };
  context.livraisonPayments = [{ id: 1, compteId: '', montantEncaisse: '', monnaieRendue: '' }];
  context.livraisonPaymentAutoId = 1;
  const warningEl = dom.window.document.getElementById('livraison-payment-warning');

  await context.validerEncaissementLivraison();

  assert.match(warningEl.textContent, /Il reste/, 'Le message doit indiquer le montant encore a encaisser');
}

async function testValiderEncaissementComplet() {
  const { context, dom } = setupLivraisonContext();
  context.currentLivraisonData = {
    clientNom: 'Client Test',
    paymentsDetails: [],
    paymentsTotalEncaisse: 0,
    paymentsTotalChange: 0,
    paymentsNetEncaisse: 0
  };
  context.currentLivraisonId = 'liv3';
  context.livraisonModalContext = {
    totals: { due: 1000, totalEncaisse: 0, totalChange: 0, net: 0, outstanding: 1000 }
  };
  context.comptesCache = [{ id: 'caisse', nom: 'Caisse Centrale' }];
  context.livraisonPayments = [{
    id: 1,
    compteId: 'caisse',
    montantEncaisse: '1000',
    monnaieRendue: '0'
  }];
  context.livraisonPaymentAutoId = 1;

  const modal = dom.window.document.getElementById('modalLivraisonEncaissement');
  modal.style.display = 'flex';

  const callLog = [];
  const originalApply = context.appliquerEncaissementsLivraison;
  context.appliquerEncaissementsLivraison = async function wrapped(payments) {
    callLog.push({ type: 'appliquer', count: payments.length });
    await originalApply.call(this, payments);
  };
  context.finaliserLivraisonReussie = async () => {
    callLog.push({ type: 'finaliser' });
  };

  await context.validerEncaissementLivraison();

  assert.deepStrictEqual(callLog.map(entry => entry.type), ['appliquer', 'finaliser'], "L'encaissement doit appliquer les paiements puis finaliser la livraison");
  assert.strictEqual(context.currentLivraisonData.paymentsDetails.length, 1, 'Le paiement doit etre rattache a la livraison');
  assert.strictEqual(modal.style.display, 'none', 'Le modal doit etre ferme apres validation');
  assert.strictEqual(context.livraisonModalContext, null, 'Le contexte du modal doit etre reinitialise');
}

async function run() {
  testOuvrirModalSansSelection();
  testOuvrirModalAvecSelection();
  await testValiderAvecMontantRestant();
  await testValiderEncaissementComplet();
  console.log('[OK] Tests encaissement livraison executes avec succes.');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
