const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const INDEX_SOURCE = fs.readFileSync(INDEX_PATH, 'utf8');

function extractLivraisonActionsChunk() {
  const startMarker = 'function updateLivraisonQuickIndicators';
  const endMarker = 'async function validerEncaissementLivraison';
  const start = INDEX_SOURCE.indexOf(startMarker);
  const end = INDEX_SOURCE.indexOf(endMarker, start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Impossible de localiser le bloc livraison dans index.html');
  }
  return INDEX_SOURCE.substring(start, end);
}

const LIVRAISON_ACTIONS_CHUNK = extractLivraisonActionsChunk();

function extractFunctionSource(name) {
  const marker = `function ${name}`;
  const start = INDEX_SOURCE.indexOf(marker);
  if (start === -1) {
    throw new Error(`Impossible de localiser la fonction ${name}`);
  }
  let index = start;
  let source = '';
  let braceCount = 0;
  let braceStarted = false;
  let inString = false;
  let stringChar = null;
  let escaped = false;

  while (index < INDEX_SOURCE.length) {
    const ch = INDEX_SOURCE[index];
    source += ch;

    if (!braceStarted) {
      if (ch === '{') {
        braceStarted = true;
        braceCount = 1;
      }
      index += 1;
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === stringChar) {
        inString = false;
        stringChar = null;
      }
    } else {
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = true;
        stringChar = ch;
      } else if (ch === '{') {
        braceCount += 1;
      } else if (ch === '}') {
        braceCount -= 1;
        if (braceCount === 0) {
          return source;
        }
      }
    }

    index += 1;
  }

  throw new Error(`Bloc ${name} incomplet`);
}

const FUNCTION_NAMES = [
  'updateLivraisonQuickIndicators',
  'ouvrirLivraisonsDepuisAccueil',
  'peutGererLivraison',
  'peutGererLivraisonCourante',
  'updateLivraisonActionButtons'
];

function setupContext({ userRole = 'employe', currentUser = { uid: 'owner' } } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/#livraisons' });
  const { window } = dom;

  window.console = console;
  window.setLivraisonDetailAlert = (message) => { window.__lastAlert = message; };
  window.formatXofAmount = (value) => `${Number(value || 0).toLocaleString('fr-FR')} FCFA`;
  window.computeLivraisonTotals = (sale) => ({
    outstanding: sale.mockOutstanding || 0,
    due: sale.mockDue || 0,
    net: sale.mockNet || 0
  });
  window.updateSaleFirestore = async () => {};
  window.updateStockAfterSaleFirestore = async () => {};
  window.afficherLivraisons = () => {};
  window.filterSalesHistory = () => {};
  window.populateLivraisonDetailView = () => {};
  window.showLivraisonDetailLoader = () => {};
  window.lucide = { createIcons: () => {} };
  window.userRole = userRole;
  window.comptesCache = [];
  window.firebase = {
    auth: () => ({ currentUser })
  };

  const context = vm.createContext(window);
  FUNCTION_NAMES.forEach(name => {
    const source = extractFunctionSource(name);
    vm.runInContext(source, context);
  });

  return { window, dom };
}

function createActionButtons(document) {
  document.body.innerHTML = `
    <button id="livraisonMarkSuccessBtn"><span class="btn-label"></span></button>
    <button id="livraisonMarkFailedBtn"><span class="btn-label"></span></button>
    <button class="delivery-add-payment-btn"><span class="btn-label"></span></button>
    <div id="livraisonDetailStatusDescription"></div>
  `;
}

function testOwnerCanManage() {
  const { window } = setupContext({ currentUser: { uid: 'owner' } });
  createActionButtons(window.document);

  const sale = { deliveryStatus: 'en cours', enregistreParUid: 'owner' };
  const totals = { outstanding: 120, due: 200, net: 80 };

  window.updateLivraisonActionButtons(sale, totals);

  const successBtn = window.document.getElementById('livraisonMarkSuccessBtn');
  const failBtn = window.document.getElementById('livraisonMarkFailedBtn');
  const addPaymentBtn = window.document.querySelector('.delivery-add-payment-btn');

  assert.strictEqual(window.__currentLivraisonCanManage, true, 'Le propri�taire devrait pouvoir agir.');
  assert.strictEqual(successBtn.disabled, false, 'Le bouton de validation doit rester actif pour le propri�taire.');
  assert.ok(successBtn.classList.contains('primary'), 'Le bouton succ�s doit proposer un encaissement.');
  assert.strictEqual(failBtn.disabled, false);
  assert.strictEqual(addPaymentBtn.disabled, false);
}

function testEmployeeCannotManageOthers() {
  const { window } = setupContext({ currentUser: { uid: 'autre' }, userRole: 'employe' });
  createActionButtons(window.document);

  const sale = { deliveryStatus: 'en cours', enregistreParUid: 'owner' };
  const totals = { outstanding: 80, due: 200, net: 120 };

  window.updateLivraisonActionButtons(sale, totals);

  const successBtn = window.document.getElementById('livraisonMarkSuccessBtn');
  const failBtn = window.document.getElementById('livraisonMarkFailedBtn');
  const addPaymentBtn = window.document.querySelector('.delivery-add-payment-btn');
  const statusDesc = window.document.getElementById('livraisonDetailStatusDescription');

  assert.strictEqual(window.__currentLivraisonCanManage, false, 'Un employ� ne doit pas pouvoir agir sur une livraison �trang�re.');
  assert.strictEqual(successBtn.disabled, true);
  assert.strictEqual(failBtn.disabled, true);
  assert.strictEqual(addPaymentBtn.disabled, true);
  assert.ok(statusDesc.textContent.includes('Consultation uniquement'), 'Un message doit indiquer la lecture seule.');
}

function testPrivilegedRoleCanManage() {
  const { window } = setupContext({ currentUser: { uid: 'manager' }, userRole: 'patron' });
  createActionButtons(window.document);

  const sale = { deliveryStatus: 'en cours', enregistreParUid: 'owner' };
  const totals = { outstanding: 40, due: 200, net: 160 };

  window.updateLivraisonActionButtons(sale, totals);

  const successBtn = window.document.getElementById('livraisonMarkSuccessBtn');
  assert.strictEqual(window.__currentLivraisonCanManage, true, 'Un patron doit pouvoir agir sur toutes les livraisons.');
  assert.strictEqual(successBtn.disabled, false);
}

function testQuickIndicators() {
  const { window } = setupContext();
  window.document.body.innerHTML = `
    <div id="livraisonsQuickButton" style="display:none"></div>
    <span id="livraisonsEnCoursBadge"></span>
    <span id="livraisons-header-count"></span>
    <span id="accueil-livraisons-count"></span>
    <span id="accueil-livraisons-subtext"></span>
  `;

  window.updateLivraisonQuickIndicators(3);
  assert.strictEqual(window.document.getElementById('livraisonsEnCoursBadge').textContent, '3');
  assert.strictEqual(window.document.getElementById('livraisons-header-count').textContent, '3');
  assert.strictEqual(window.document.getElementById('accueil-livraisons-count').textContent, '3');
  assert.strictEqual(window.document.getElementById('accueil-livraisons-subtext').textContent, '3 livraisons \u00e0 suivre');
  assert.strictEqual(window.document.getElementById('livraisonsQuickButton').style.display, 'flex');

  window.updateLivraisonQuickIndicators(1);
  assert.strictEqual(window.document.getElementById('accueil-livraisons-subtext').textContent, '1 livraison \u00e0 suivre');

  window.updateLivraisonQuickIndicators(0);
  assert.strictEqual(window.document.getElementById('livraisonsQuickButton').style.display, 'none');
}

function run() {
  testOwnerCanManage();
  testEmployeeCannotManageOthers();
  testPrivilegedRoleCanManage();
  testQuickIndicators();
  console.log('Livraison permissions tests: OK');
}

run();
