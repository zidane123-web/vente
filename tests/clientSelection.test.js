const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const INDEX_SOURCE = fs.readFileSync(INDEX_PATH, 'utf8');

function extractChunk(startMarker, endMarker) {
  const start = INDEX_SOURCE.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Impossible de trouver le marqueur: ${startMarker}`);
  }
  const end = INDEX_SOURCE.indexOf(endMarker, start);
  if (end === -1 || end <= start) {
    throw new Error(`Impossible de trouver la fin de segment à partir de ${startMarker}`);
  }
  return INDEX_SOURCE.slice(start, end);
}

const CLIENTS_CHUNK_RAW = extractChunk(
  '// Gestion des clients (',
  '// Initialisation Firebase'
);

const CLIENTS_CHUNK = CLIENTS_CHUNK_RAW
  .replace(/const /g, 'var ')
  .replace(/let /g, 'var ');

const STEPPER_CHUNK_RAW = extractChunk(
  '// Gestion des \u00E9tapes de vente (Stepper)',
  'function prevStep()'
);

const STEPPER_INITIAL = STEPPER_CHUNK_RAW
  .replace('let currentStep = 0;', 'var currentStep = 0;')
  .replace('const steps = document.querySelectorAll(".sale-step");', 'var steps = document.querySelectorAll(".sale-step");');

const HTML_TEMPLATE = `
<!doctype html>
<html>
  <body>
    <div id="progressBar" style="width:0"></div>
    <span id="progressText"></span>
    <div class="sale-step" id="step1"></div>
    <div class="sale-step" id="step2"></div>
    <div class="sale-step" id="step3"></div>
    <div class="sale-step" id="step4"></div>

    <div id="clientCard">
      <button class="client-search-chip client-type-chip" data-type="ordinaire">Ordinaire</button>
      <button class="client-search-chip client-type-chip" data-type="revendeur">Revendeur</button>
    </div>
    <div id="clientSelectedSummary" class="selection-summary">
      <p id="clientSelectedText"></p>
    </div>
    <input id="clientNom" value="Client Test">
    <input id="clientNumero" value="0700000000">
    <input id="clientId" value="client-1">
    <input id="clientType" value="">

    <div id="clientSearchResults">
      <div class="client-search-result" data-client-id="client-1"></div>
    </div>
    <div id="clientSearchFeedback"></div>
    <input id="clientSearchInput" />

    <section id="screen-choisir-client">
      <button class="client-search-chip" data-mode="nom">Nom</button>
      <button class="client-search-chip" data-mode="numero">Numero</button>
    </section>

    <section id="screen-ajouter-client">
      <input id="newClientName" />
      <input id="newClientPhone" />
      <div class="new-client-type-options">
        <label class="client-type-radio">
          <input type="radio" name="newClientType" value="ordinaire">
          <span>Client ordinaire</span>
        </label>
        <label class="client-type-radio">
          <input type="radio" name="newClientType" value="revendeur">
          <span>Revendeur</span>
        </label>
      </div>
      <div id="clientCreateFeedback" style="display:none"></div>
      <button id="createClientSubmitBtn"></button>
    </section>

    <section id="screen-choisir-livreur">
      <button class="client-search-chip" data-mode="nom">Nom</button>
      <button class="client-search-chip" data-mode="numero">Numero</button>
    </section>

    <div id="livreurSearchResults"></div>
    <div id="livreurSearchFeedback"></div>
    <input id="livreurSearchInput" />
    <div id="livreurSelectedSummary"><p id="livreurSelectedText"></p></div>
    <input id="livreurNom">
    <input id="livreurNumero">
    <input id="livreurId">

    <div id="deliveryCard"></div>
    <div id="deliveryPaymentHint"></div>
    <button id="btnValider"></button>
    <p id="saleModeSummary"></p>
    <span id="deliveryModeBadge"></span>
    <input id="lieuLivraison">

    <div id="saleRecap"></div>
    <button id="footerCheckout"></button>
    <span id="footerQuantity"></span>
    <span id="footerTotal"></span>
    <div id="offlineOverlay"></div>
  </body>
</html>
`;

const baseDom = new JSDOM(HTML_TEMPLATE, {
  url: 'http://localhost/#vendre',
  pretendToBeVisual: true
});

const baseWindow = baseDom.window;

function attachBaseStubs(windowRef, toastsRef, addCallsRef) {
  windowRef.console = console;
  windowRef.lucide = { createIcons: () => {} };
  windowRef.toggleDeliveryFields = windowRef.toggleDeliveryFields || (() => {});
  windowRef.ensureVentePaymentsInitialized = () => {};
  windowRef.rafraichirResumePaiementVente = () => ({
    valid: true,
    totalEncaisse: 0,
    totalChange: 0,
    net: 0
  });
  windowRef.updateCartFooter = () => {};
  windowRef.updatePanierPage = () => {};
  windowRef.showToast = (message) => {
    toastsRef.push(message);
  };
  windowRef.dbFirestore = {
    collection: () => ({
      add: (payload) => {
        addCallsRef.push(payload);
        return Promise.resolve({ id: 'new-client-id' });
      },
      get: () => Promise.resolve({ forEach: () => {} })
    })
  };
  windowRef.firebase = {
    firestore: {
      FieldValue: {
        serverTimestamp: () => 'ts'
      }
    }
  };
}

attachBaseStubs(baseWindow, [], []);
const baseContext = vm.createContext(baseWindow);
let clientsBootstrapped = false;
let stepperBootstrapped = false;

vm.runInContext(CLIENTS_CHUNK, baseContext);

function resetDomStructure() {
  const freshDom = new JSDOM(HTML_TEMPLATE, {
    url: 'http://localhost/#vendre',
    pretendToBeVisual: true
  });
  baseWindow.document.body.innerHTML = freshDom.window.document.body.innerHTML;
  if (baseWindow.history && typeof baseWindow.history.replaceState === 'function') {
    baseWindow.history.replaceState(null, '', '#vendre');
  } else {
    baseWindow.location.hash = '#vendre';
  }
  const input = baseWindow.document.getElementById('clientSearchInput');
  if (input && input.dataset.bound) {
    delete input.dataset.bound;
  }
}

function resetCaches() {
  baseContext.clientsCache = [];
  baseContext.clientsCacheLoaded = false;
  baseContext.clientsLoadingPromise = null;
  baseContext.selectedClientId = null;
  baseContext.currentClientType = '';

  baseContext.livreursCache = [];
  baseContext.livreursCacheLoaded = false;
  baseContext.livreursLoadingPromise = null;
  baseContext.selectedLivreurId = null;
}

function createEnvironment() {
  const toasts = [];
  const addCalls = [];

  resetDomStructure();
  if (!clientsBootstrapped) {
    vm.runInContext(CLIENTS_CHUNK, baseContext);
    clientsBootstrapped = true;
  }
  if (!stepperBootstrapped) {
    vm.runInContext(STEPPER_INITIAL, baseContext);
    stepperBootstrapped = true;
  }
  attachBaseStubs(baseWindow, toasts, addCalls);
  resetCaches();
  vm.runInContext('currentStep = 0;', baseContext);
  vm.runInContext('steps = document.querySelectorAll(".sale-step");', baseContext);

  return { dom: baseDom, context: baseContext, toasts, addCalls };
}

function testSetClientTypeActivation() {
  const { dom, context } = createEnvironment();
  const ordButton = dom.window.document.querySelector('[data-type="ordinaire"]');
  const revButton = dom.window.document.querySelector('[data-type="revendeur"]');

  context.setClientType('revendeur');

  assert.strictEqual(dom.window.document.getElementById('clientType').value, 'revendeur');
  assert.ok(revButton.classList.contains('active'), 'Le chip revendeur doit \u00EAtre actif');
  assert.ok(!ordButton.classList.contains('active'), 'Le chip ordinaire ne doit pas \u00EAtre actif');
  assert.ok(
    dom.window.document.getElementById('clientSelectedText').textContent.includes('Revendeur'),
    'Le r\u00E9sum\u00E9 client doit mentionner Revendeur'
  );
}

function testClearSelectedClientResetsSummary() {
  const { dom, context } = createEnvironment();
  context.setClientType('ordinaire');
  dom.window.document.getElementById('clientNom').value = 'Fatou';
  dom.window.document.getElementById('clientNumero').value = '0700000000';

  context.clearSelectedClient();

  assert.strictEqual(dom.window.document.getElementById('clientNom').value, '');
  assert.strictEqual(dom.window.document.getElementById('clientNumero').value, '');
  assert.strictEqual(dom.window.document.getElementById('clientType').value, '');
  assert.strictEqual(
    dom.window.document.getElementById('clientSelectedText').textContent,
    'Aucun client s\u00E9lectionn\u00E9.'
  );
}

function testNextStepRequiresClientType() {
  const { dom, context, toasts } = createEnvironment();
  dom.window.document.getElementById('clientNom').value = 'A\u00EFcha';
  dom.window.document.getElementById('clientNumero').value = '0700000000';
  context.clearSelectedClient();
  dom.window.document.getElementById('clientNom').value = 'A\u00EFcha';
  dom.window.document.getElementById('clientNumero').value = '0700000000';
  context.currentStep = 1;

  const initialToastCount = toasts.length;
  context.nextStep();

  assert.strictEqual(context.currentStep, 1, 'Le step ne doit pas avancer sans type client');
  assert.strictEqual(toasts.length, initialToastCount + 1);
  assert.strictEqual(
    toasts[toasts.length - 1],
    'Choisissez le type de client avant de continuer.'
  );
}

function testNextStepAdvancesWithType() {
  const { dom, context, toasts } = createEnvironment();
  dom.window.document.getElementById('clientNom').value = 'Ibrahim';
  dom.window.document.getElementById('clientNumero').value = '0700000000';
  context.setClientType('revendeur');
  context.currentStep = 1;

  const initialToasts = toasts.length;
  context.nextStep();

  assert.strictEqual(context.currentStep, 2, 'Le step doit avancer lorsque le type est renseign\u00E9');
  assert.strictEqual(toasts.length, initialToasts, 'Aucun toast ne doit \u00EAtre affich\u00E9');
  const steps = dom.window.document.querySelectorAll('.sale-step');
  assert.ok(steps[2].classList.contains('active'), "L\u2019\u00E9tape 3 doit \u00EAtre active apr\u00E8s nextStep");
}

function testCreateClientRequiresType() {
  const { dom, context, addCalls } = createEnvironment();
  dom.window.document.getElementById('newClientName').value = 'Sara';
  dom.window.document.getElementById('newClientPhone').value = '0755000000';
  dom.window.location.hash = '#ajouter-client';

  context.createClientFromSale();

  const feedback = dom.window.document.getElementById('clientCreateFeedback');
  assert.strictEqual(addCalls.length, 0, 'Aucun enregistrement ne doit \u00EAtre tent\u00E9 sans type');
  assert.strictEqual(feedback.style.display, 'block');
  assert.strictEqual(feedback.textContent, 'S\u00E9lectionnez le type du client.');
}

async function testCreateClientWithTypePersists() {
  const { dom, context, addCalls } = createEnvironment();
  dom.window.document.getElementById('newClientName').value = 'Mamadou';
  dom.window.document.getElementById('newClientPhone').value = '0744000000';
  dom.window.document.querySelector('input[name="newClientType"][value="ordinaire"]').checked = true;
  dom.window.location.hash = '#ajouter-client';

  context.createClientFromSale();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.strictEqual(addCalls.length, 1, 'Un appel \u00E0 Firestore doit \u00EAtre effectu\u00E9');
  assert.strictEqual(addCalls[0].typeClient, 'ordinaire', 'Le type doit \u00EAtre persist\u00E9');
  assert.strictEqual(
    dom.window.document.getElementById('clientType').value,
    'ordinaire',
    'Le champ masqu\u00E9 doit refl\u00E9ter le type choisi'
  );
  assert.strictEqual(
    dom.window.document.getElementById('clientNom').value,
    'Mamadou',
    'Le r\u00E9sum\u00E9 doit \u00EAtre aliment\u00E9 avec le nouveau client'
  );

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.strictEqual(dom.window.location.hash, '#vendre', 'Le flux doit revenir sur la vente');
  const checkedRadio = dom.window.document.querySelector('input[name="newClientType"]:checked');
  assert.strictEqual(checkedRadio, null, 'Le nouveau formulaire doit \u00EAtre r\u00E9initialis\u00E9');
}

async function run() {
  testSetClientTypeActivation();
  testClearSelectedClientResetsSummary();
  testNextStepRequiresClientType();
  testNextStepAdvancesWithType();
  testCreateClientRequiresType();
  await testCreateClientWithTypePersists();
  console.log('✅ Tests de s\u00E9lection client/livreur ex\u00E9cut\u00E9s avec succ\u00E8s.');
}

run().catch((err) => {
  console.error('❌ \u00C9chec des tests de s\u00E9lection client/livreur:', err);
  process.exit(1);
});
