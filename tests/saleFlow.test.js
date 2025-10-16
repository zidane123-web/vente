const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const INDEX_SOURCE = fs.readFileSync(INDEX_PATH, 'utf8');

function extractSaleModeChunk() {
  const startMarker = 'let currentArticleId = null;';
  const endMarker = 'function getValidationMessage()';
  const start = INDEX_SOURCE.indexOf(startMarker);
  const end = INDEX_SOURCE.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Impossible de localiser le bloc de gestion du panier dans index.html');
  }
  return INDEX_SOURCE.substring(start, end);
}

const SALE_MODE_CHUNK = extractSaleModeChunk();

function createDom(template) {
  return new JSDOM(template, {
    url: 'http://localhost/#accueil'
  });
}

function bootstrapSaleMode(dom) {
  const { window } = dom;
  window.console = console;
  window.lucide = { createIcons: () => {} };
  window.rafraichirResumePaiementVente = undefined;
  window.renderMiniPanier = window.renderMiniPanier || (() => {});
  window.showStep = window.showStep || (() => {});
  window.showToast = window.showToast || (() => {});
  window.updateSearchCartBadge = window.updateSearchCartBadge || (() => {});
  window.updateBalanceDisplay = window.updateBalanceDisplay || (() => {});
  window.creerDettesDeVente = window.creerDettesDeVente || (() => Promise.resolve());
  window.firebase = { auth: () => ({ currentUser: { uid: 'demo', displayName: 'Test User' } }) };

  const context = vm.createContext(window);
  vm.runInContext(SALE_MODE_CHUNK, context);

  const wrapCallCount = (fnName) => {
    const original = context[fnName];
    let count = 0;
    context[fnName] = function wrapped(...args) {
      count += 1;
      return original.apply(this, args);
    };
    return () => count;
  };

  const getUpdatePanierPageCalls = wrapCallCount('updatePanierPage');
  const getUpdateCartFooterCalls = wrapCallCount('updateCartFooter');

  const getCurrentSaleMode = () => vm.runInContext('currentSaleMode', context);

  return { context, getUpdatePanierPageCalls, getUpdateCartFooterCalls, getCurrentSaleMode };
}

function testAppliquerTypeVenteSansChamps() {
  const dom = createDom(`
    <!doctype html><body>
      <div id="offlineOverlay"></div>
      <div id="modalSaleType"></div>
      <div id="panierSaleTypeBadge"></div>
      <div id="searchCartIcon"></div>
      <div id="searchCartCount"></div>
      <div id="panierContainer"></div>
      <div id="deliveryCard" style="display:none"></div>
      <div id="deliveryPaymentHint" style="display:none"></div>
      <button id="btnValider"></button>
      <p id="saleModeSummary"></p>
      <span id="deliveryModeBadge"></span>
      <input id="livreurId">
      <input id="livreurNom">
      <input id="livreurNumero">
      <div id="livreurSelectedSummary" style="display:none"><p id="livreurSelectedText"></p></div>
      <div id="livreurSearchResults"></div>
      <div id="livreurSearchFeedback"></div>
      <input id="livreurSearchInput">
      <div id="livreurCreateForm"><button class="btn-modern"></button></div>
      <button id="livreurCreateToggleBtn"></button>
      <input id="lieuLivraison">
      <span id="footerQuantity"></span>
      <span id="footerTotal"></span>
      <button id="footerCheckout"></button>
    </body>
  `);

  const { context } = bootstrapSaleMode(dom);
  assert.doesNotThrow(() => context.appliquerTypeVenteAuFormulaire(), 'La mise à jour du formulaire ne doit pas échouer sans champs livraison');
}

function testSelectionFlux() {
  const dom = createDom(`
    <!doctype html><body>
      <div id="offlineOverlay"></div>
      <div id="modalSaleType" style="display:flex"></div>
      <div id="panierSaleTypeBadge" class="sale-type-badge"><span>Vente directe</span></div>
      <div id="searchCartIcon"></div>
      <div id="searchCartCount"></div>
      <div id="miniPanier"></div>
      <div id="panierContainer"></div>
      <div id="deliveryCard" style="display:none"></div>
      <div id="deliveryPaymentHint" style="display:none"></div>
      <p id="saleModeSummary"></p>
      <span id="deliveryModeBadge"></span>
      <div id="livreurSelectedSummary" style="display:none"><p id="livreurSelectedText"></p></div>
      <div id="livreurSearchResults"></div>
      <div id="livreurSearchFeedback"></div>
      <input id="livreurSearchInput">
      <div id="livreurCreateForm"><button class="btn-modern"></button></div>
      <button id="livreurCreateToggleBtn"></button>
      <input id="livreurNom">
      <input id="livreurNumero">
      <input id="lieuLivraison">
      <input id="livreurId">
      <button id="btnValider"></button>
      <span id="footerQuantity"></span>
      <span id="footerTotal"></span>
      <button id="footerCheckout"></button>
    </body>
  `);

  const { context, getUpdatePanierPageCalls, getUpdateCartFooterCalls, getCurrentSaleMode } = bootstrapSaleMode(dom);

  // Initialiser badge
  context.mettreAJourBadgeTypeVente();

  // Sélection livraison
  context.selectionnerTypeVente('delivery');
  assert.strictEqual(getCurrentSaleMode(), 'delivery', 'Le mode courant doit être "delivery"');
  assert.strictEqual(dom.window.document.getElementById('deliveryCard').style.display, 'flex', 'Le panneau livraison doit être visible');
  assert.strictEqual(dom.window.document.getElementById('btnValider').textContent, 'Valider Livraison');
  assert.match(dom.window.document.getElementById('panierSaleTypeBadge').textContent.trim(), /Livraison/, 'Le badge doit afficher Livraison');
  assert.strictEqual(dom.window.location.hash, '#panier', 'Le hash doit basculer vers #panier');

  // Sélection directe
  context.selectionnerTypeVente('direct');
  assert.strictEqual(getCurrentSaleMode(), 'direct', 'Le mode courant doit revenir à "direct"');
  assert.strictEqual(dom.window.document.getElementById('deliveryCard').style.display, 'none', 'Le panneau livraison doit être caché');
  assert.strictEqual(dom.window.document.getElementById('btnValider').textContent, 'Valider Vente');
  assert.match(dom.window.document.getElementById('panierSaleTypeBadge').textContent.trim(), /Vente directe/, 'Le badge doit afficher Vente directe');

  assert.ok(getUpdatePanierPageCalls() >= 2, 'updatePanierPage doit être appelé pour chaque sélection');
  assert.ok(getUpdateCartFooterCalls() >= 2, 'updateCartFooter doit être appelé pour chaque sélection');
}

testAppliquerTypeVenteSansChamps();
testSelectionFlux();

console.log('✅ Tests de flux de vente (directe & livraison) exécutés avec succès.');
