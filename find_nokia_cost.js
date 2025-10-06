const admin = require('firebase-admin');
const path = require('path');

const serviceAccountPath = path.join(__dirname, 'africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json');
const serviceAccount = require(serviceAccountPath);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function main() {
  const target = 'Nokia 106';
  const snapshot = await db.collection('approvisionnement')
    .orderBy('timestamp', 'desc')
    .limit(50)
    .get();

  console.log('Recherche des approvisionnements contenant', target);
  snapshot.forEach(doc => {
    const data = doc.data();
    const items = Array.isArray(data.items) ? data.items : [];
    const match = items.filter(it => (it.produit || '').toLowerCase().includes(target.toLowerCase()));
    if (match.length > 0) {
      const ts = data.timestamp && data.timestamp.toDate ? data.timestamp.toDate().toISOString() : 'N/A';
      console.log(`\nApprovisionnement ${doc.id} | Date: ${ts} | Fournisseur: ${data.fournisseur}`);
      match.forEach(it => {
        const qty = it.quantite || it.qty || 0;
        const unitCost = it.coutAchat || it.prixAchat || it.purchasePrice || 0;
        console.log(`  - ${it.produit} | Qté ${qty} | Coût unitaire ${unitCost}`);
      });
    }
  });

  await admin.app().delete();
}

main().catch(err => {
  console.error(err);
  admin.app().delete().catch(() => {});
});
