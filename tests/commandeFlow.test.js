const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const INDEX_SOURCE = fs.readFileSync(INDEX_PATH, 'utf8');

function extractChunk(startMarker, endMarker) {
  const start = INDEX_SOURCE.indexOf(startMarker);
  const end = INDEX_SOURCE.indexOf(endMarker, start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Impossible de trouver le bloc "${startMarker}" dans index.html`);
  }
  return INDEX_SOURCE.substring(start, end);
}

const APPRO_CHUNK = extractChunk(
  'async function finaliserApprovisionnement() {',
  'async function recordCreditPayment'
);

const RECEPTION_CHUNK = extractChunk(
  'async function soumettreReceptionCommande() {',
  'async function ouvrirFournisseurBalance'
);

function createDocFactory() {
  let counter = 0;
  const create = (pathPrefix, id) => {
    const docId = id || `${pathPrefix.split('/').pop()}-${++counter}`;
    const fullPath = `${pathPrefix}/${docId}`;
    return {
      id: docId,
      __path: fullPath,
      collection(sub) {
        return {
          doc(subId) {
            const nestedId = subId || `${sub}-${++counter}`;
            return create(`${fullPath}/${sub}`, nestedId);
          }
        };
      }
    };
  };
  return { create };
}

function createCommandeDom() {
  return new JSDOM(`
    <!doctype html><body>
      <select id="typeAchatAppro">
        <option value="normal">Normal</option>
        <option value="commande" selected>Commande</option>
      </select>
      <input id="fraisTransportAppro" value="0" />
      <select id="compteSelectTransportAppro"><option value=""></option></select>
      <input id="commandeDatePrevue" value="2025-10-20" />
      <input id="commandeReference" value="CMD-001" />
      <textarea id="commandeNotes">Notes internes</textarea>
      <select id="purchasePaymentStatus">
        <option value="no">No</option>
        <option value="yes" selected>Yes</option>
      </select>
      <div id="purchase-tabs"></div>
    </body>
  `, { url: 'http://localhost/#approvisionnement' });
}

function createApproFirestoreStub(context) {
  const factory = createDocFactory();
  return {
    batch() {
      return {
        set(ref, data) {
          if (!context.__batchSets) context.__batchSets = [];
          context.__batchSets.push({ ref: ref.__path, data });
          if (ref.__path.startsWith('approvisionnement/') && ref.__path.split('/').length === 2) {
            context.__capturedApproData = data;
          }
        },
        update() {},
        commit: () => Promise.resolve()
      };
    },
    collection(name) {
      if (name === 'approvisionnement') {
        return {
          doc(id) {
            return factory.create('approvisionnement', id);
          },
          where() { return this; },
          async get() {
            return { empty: true, docs: [] };
          }
        };
      }
      if (name === 'depenses') {
        return {
          doc(id) {
            return factory.create('depenses', id);
          }
        };
      }
      if (name === 'stock') {
        const col = {
          doc(id) {
            return factory.create('stock', id);
          },
          where() { return col; },
          limit() { return col; },
          async get() {
            return { empty: true, docs: [] };
          }
        };
        return col;
      }
      return {
        doc(id) {
          return factory.create(name, id);
        }
      };
    }
  };
}

function setupCommandeContext() {
  const dom = createCommandeDom();
  const win = dom.window;
  const alerts = [];
  win.console = console;
  win.alert = (msg) => alerts.push(msg);
  win.showSaleLoader = () => {};
  win.hideSaleLoader = () => {};
  win.updatePanierApprovisionnement = () => {};
  win.handlePurchaseTypeChange = () => {};
  win.resetApproPayments = () => { win.approPayments = []; };
  win.chargerApprovisionnements = () => {};
  win.updateStockSummary = () => {};
  win.updateBalanceDisplay = () => {};
  win.enregistrerMouvementTresorerie = async () => {};
  win.getCompteNomById = (id) => id;
  win.comptesCache = [{ id: 'banque', nom: 'Banque' }];
  const context = vm.createContext(win);

  context.dbFirestore = createApproFirestoreStub(context);
  context.firebase = {
    auth: () => ({ currentUser: { uid: 'user1', displayName: 'Test User' } }),
    firestore: {
      FieldValue: { serverTimestamp: () => 'server-ts' },
      Timestamp: { now: () => 'ts-now' }
    }
  };

  context.currentApproItems = [{
    fournisseur: 'ABDOUL TG',
    produit: 'Redmi A5',
    quantite: 2,
    coutTotal: 100000,
    prixAchat: 50000,
    category: 'telephones',
    imeis: ['IMEI1', 'IMEI2']
  }];

  context.approPayments = [{
    id: 1,
    montant: '15000',
    compteId: 'banque'
  }];

  context.validateApproPayments = (showAlert) => {
    if (showAlert) {
      return { valid: true, totalPaid: 15000, due: 100000 };
    }
    return { valid: true, totalPaid: 15000, due: 100000 };
  };

  context.renderCommandeReceptionSummary = () => {};
  context.renderCommandeReceptionItems = () => {};
  context.actualiserTotalReception = () => {};

  vm.runInContext(APPRO_CHUNK, context);

  dom.window.document.getElementById('purchase-tabs').value = 'all';

  return { context, alerts };
}

function createReceptionDom() {
  return new JSDOM(`
    <!doctype html><body>
      <input id="commandeReceptionTransport" value="0" />
      <select id="compteSelectCommandeReceptionTransport"><option value=""></option></select>
      <textarea id="commandeReceptionNotes"></textarea>
      <div id="commandeReceptionSummary"></div>
      <div id="commandeReceptionItemsContainer"></div>
      <div id="commandeReceptionTotal"></div>
      <button id="commandeReceptionSubmitBtn"></button>
    </body>
  `, { url: 'http://localhost/#commande-reception' });
}

function createReceptionFirestoreStub(context, approSnapshotData) {
  const factory = createDocFactory();
  const approDocRef = factory.create('approvisionnement', approSnapshotData.id || 'appro-123');
  const stockCollection = {
    doc(id) {
      return factory.create('stock', id);
    },
    where() { return stockCollection; },
    limit() { return stockCollection; },
    async get() {
      return { empty: true, docs: [] };
    }
  };

  return {
    db: {
      collection(name) {
        if (name === 'stock') {
          return stockCollection;
        }
        if (name === 'approvisionnement') {
          return {
            doc(id) {
              if (!id || id === approDocRef.id) {
                return approDocRef;
              }
              return factory.create('approvisionnement', id);
            },
            where() {
              return {
                async get() {
                  return { empty: true, docs: [] };
                }
              };
            },
            async get() {
              return { empty: true, docs: [] };
            }
          };
        }
        if (name === 'depenses') {
          return {
            doc(id) {
              return factory.create('depenses', id);
            }
          };
        }
        return {
          doc(id) {
            return factory.create(name, id);
          }
        };
      },
      runTransaction: async (callback) => {
        context.__txSets = [];
        const tx = {
          async get(ref) {
            return { exists: true, data: () => JSON.parse(JSON.stringify(approSnapshotData)) };
          },
          set(ref, data) {
            context.__txSets.push({ ref: ref.__path, data });
            if (ref.__path.includes('/receptions/')) {
              context.__lastReceptionRecord = data;
            }
          },
          update(ref, data) {
            context.__lastTransactionUpdateRef = ref.__path;
            context.__lastTransactionUpdate = data;
          }
        };
        return callback(tx);
      }
    },
    approDocRef
  };
}

function setupReceptionContext(options) {
  const {
    paymentsTotalPaid,
    unitCost,
    qtyToReceive,
    expectedRemainingBefore = 5,
    initialReceivedTotal = 0,
    paymentsDetails = []
  } = options;

  const dom = createReceptionDom();
  const win = dom.window;
  const alerts = [];
  win.console = console;
  win.alert = (msg) => alerts.push(msg);
  win.showSaleLoader = () => {};
  win.hideSaleLoader = () => {};
  win.enregistrerMouvementTresorerie = async () => {};
  win.chargerApprovisionnements = () => {};
  win.updateStockSummary = () => {};
  win.updateBalanceDisplay = () => {};
  win.resetCommandeReceptionUI = () => { win.__receptionReset = true; };
  win.renderCommandeReceptionSummary = () => {};
  win.renderCommandeReceptionItems = () => {};
  win.actualiserTotalReception = () => {};
  win.getCompteNomById = (id) => id;

  const context = vm.createContext(win);

  const snapshotData = {
    id: 'appro-123',
    status: 'commande',
    items: [{
      quantite: expectedRemainingBefore,
      category: 'telephones',
      receivedQty: 0,
      remainingQty: expectedRemainingBefore,
      imeis: []
    }],
    receptionStats: {
      totalOrdered: expectedRemainingBefore,
      totalReceived: 0,
      totalRemaining: expectedRemainingBefore
    },
    orderTotalCost: expectedRemainingBefore * unitCost,
    totalCost: 0,
    paymentsTotalPaid,
    receivedTotalCost: initialReceivedTotal,
    paymentMethod: 'commande'
  };

  const firestoreStub = createReceptionFirestoreStub(context, snapshotData);
  context.dbFirestore = firestoreStub.db;
  context.currentCommandeReception = { ref: firestoreStub.approDocRef };
  context.firebase = {
    auth: () => ({ currentUser: { uid: 'user1', displayName: 'Test User' } }),
    firestore: { FieldValue: { serverTimestamp: () => 'server-ts' } }
  };

  context.currentReceptionDraft = {
    id: snapshotData.id,
    fournisseur: 'ABDOUL TG',
    orderTotalCost: snapshotData.orderTotalCost,
    paymentsTotalPaid,
    remainingAmount: 0,
    commandeMeta: {},
    receptionStats: snapshotData.receptionStats,
    receivedTotalCost: initialReceivedTotal,
    items: [{
      index: 0,
      produit: 'Redmi A5',
      category: 'telephones',
      quantiteCommandee: expectedRemainingBefore,
      dejaRecu: 0,
      restant: expectedRemainingBefore,
      qtyToReceive,
      unitCost,
      imeis: Array.from({ length: qtyToReceive }, (_, idx) => `IMEI${idx + 1}`),
      existingImeis: []
    }]
  };

  vm.runInContext(RECEPTION_CHUNK, context);

  return { context, alerts };
}

async function testCommandeCreationUsesReceivedCost() {
  const { context } = setupCommandeContext();
  await context.finaliserApprovisionnement();
  const data = context.__capturedApproData;
  assert.ok(data, 'Les données approvisionnement doivent être capturées');
  assert.strictEqual(data.receivedTotalCost, 0, 'Une commande ne doit pas comptabiliser de coût reçu initialement');
  assert.strictEqual(data.remainingAmount, 0, 'Le reste à payer d’une commande doit être nul tant que rien n’est reçu');
  assert.strictEqual(data.paymentMethod, 'commande', 'Le mode de paiement reste "commande" tant que la réception n\'a pas débuté');
  assert.strictEqual(data.isPaid, false, 'Une commande ne doit pas être marquée comme payée lors de la création');
  assert.strictEqual(data.netSupplierBalance, 15000, 'Le solde fournisseur doit refléter l\'acompte saisi');
}

async function testReceptionRecomputesRemainingAmount() {
  const unitCost = 12000;
  const qtyToReceive = 2;
  const paymentsTotalPaid = 10000;
  const { context } = setupReceptionContext({
    paymentsTotalPaid,
    unitCost,
    qtyToReceive
  });
  await context.soumettreReceptionCommande();
  const update = context.__lastTransactionUpdate;
  assert.ok(update, 'La transaction Firestore doit mettre à jour la commande');
  const expectedValue = qtyToReceive * unitCost;
  assert.strictEqual(update.receivedTotalCost, expectedValue, 'La valeur reçue doit correspondre aux articles r�ceptionn�s');
  assert.strictEqual(update.remainingAmount, Math.max(0, expectedValue - paymentsTotalPaid), 'Le solde doit se baser sur la valeur vraiment reçue');
  assert.strictEqual(update.paymentMethod, 'credit', 'Le mode de paiement reste "credit" tant qu\'il reste un solde');
  assert.strictEqual(update.isPaid, false, 'La commande ne doit pas être marquée réglée si un solde subsiste');
  assert.strictEqual(update.netSupplierBalance, paymentsTotalPaid - expectedValue, 'Le net fournisseur doit refléter acompte - valeur reçue');
}

async function testReceptionClearsWhenAdvanceCovers() {
  const unitCost = 12000;
  const qtyToReceive = 2;
  const paymentsTotalPaid = 60000;
  const { context } = setupReceptionContext({
    paymentsTotalPaid,
    unitCost,
    qtyToReceive
  });
  await context.soumettreReceptionCommande();
  const update = context.__lastTransactionUpdate;
  assert.ok(update, 'Une mise à jour de la commande est attendue');
  const expectedValue = qtyToReceive * unitCost;
  assert.strictEqual(update.remainingAmount, 0, 'Le solde doit être soldé si l\'acompte couvre la livraison');
  assert.strictEqual(update.paymentMethod, 'paid', 'Le mode de paiement devient "paid" lorsque le solde est nul');
  assert.strictEqual(update.isPaid, true, 'La commande doit être marquée réglée quand le solde est nul');
  assert.strictEqual(update.netSupplierBalance, paymentsTotalPaid - expectedValue, 'Le net fournisseur doit refléter le trop perçu');
}

async function run() {
  await testCommandeCreationUsesReceivedCost();
  await testReceptionRecomputesRemainingAmount();
  await testReceptionClearsWhenAdvanceCovers();
  console.log('Commande flow tests: OK');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
