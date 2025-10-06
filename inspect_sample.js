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

async function inspect() {
  const ventesSnap = await db.collection('ventes').orderBy('timestamp', 'desc').limit(5).get();
  console.log('Ventes (5 derniers):', ventesSnap.docs.length);
  ventesSnap.forEach(doc => {
    const data = doc.data();
    console.log(doc.id, Object.keys(data));
    console.log(' timestamp:', data.timestamp, data.timestamp && data.timestamp.constructor && data.timestamp.constructor.name);
    console.log(' overallTotal:', data.overallTotal);
  });

  const approSnap = await db.collection('approvisionnement').orderBy('timestamp', 'desc').limit(5).get();
  console.log('Approvisionnements (5 derniers):', approSnap.docs.length);
  approSnap.forEach(doc => {
    const data = doc.data();
    console.log(doc.id, Object.keys(data));
    console.log(' timestamp:', data.timestamp, data.timestamp && data.timestamp.constructor && data.timestamp.constructor.name);
    console.log(' totalCost:', data.totalCost);
  });

  await admin.app().delete();
}

inspect().catch(err => {
  console.error(err);
  admin.app().delete().catch(() => {});
});
