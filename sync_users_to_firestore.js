const admin = require("firebase-admin");
const path = require("path");

const serviceAccountPath = path.resolve(__dirname, "africaphone1-accfb-firebase-adminsdk-fbsvc-37efae2abd.json");

admin.initializeApp({
  credential: admin.credential.cert(require(serviceAccountPath)),
});

const db = admin.firestore();

async function listAllAuthUsers() {
  const users = [];
  let nextPageToken;
  do {
    const result = await admin.auth().listUsers(1000, nextPageToken);
    users.push(...result.users);
    nextPageToken = result.pageToken;
  } while (nextPageToken);
  return users;
}

function buildDisplayName(userRecord) {
  if (userRecord.displayName) return userRecord.displayName;
  if (userRecord.email) return userRecord.email;
  if (userRecord.phoneNumber) return userRecord.phoneNumber;
  return userRecord.uid;
}

async function syncUsers() {
  const users = await listAllAuthUsers();
  const stats = {
    totalAuthUsers: users.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
  };

  for (const user of users) {
    const docRef = db.collection("users").doc(user.uid);
    try {
      const snap = await docRef.get();
      const now = admin.firestore.FieldValue.serverTimestamp();
      const displayName = buildDisplayName(user);
      const dataToWrite = {
        name: displayName,
        email: user.email || null,
        phoneNumber: user.phoneNumber || null,
        photoURL: user.photoURL || null,
        disabled: user.disabled || false,
        updatedAt: now,
      };

      if (!snap.exists) {
        dataToWrite.createdAt = now;
        await docRef.set(dataToWrite, { merge: true });
        stats.created += 1;
      } else {
        const existing = snap.data() || {};
        const needsUpdate =
          !existing.name ||
          existing.name !== displayName ||
          existing.email !== dataToWrite.email ||
          existing.phoneNumber !== dataToWrite.phoneNumber ||
          existing.photoURL !== dataToWrite.photoURL ||
          existing.disabled !== dataToWrite.disabled;

        if (needsUpdate) {
          await docRef.set(dataToWrite, { merge: true });
          stats.updated += 1;
        } else {
          stats.skipped += 1;
        }
      }
    } catch (error) {
      stats.errors += 1;
      console.error(`Impossible de synchroniser ${user.uid}:`, error.message);
    }
  }

  return stats;
}

syncUsers()
  .then((stats) => {
    console.log("Synchronisation terminée :", stats);
    process.exit(0);
  })
  .catch((error) => {
    console.error("Erreur lors de la synchronisation :", error);
    process.exit(1);
  });
