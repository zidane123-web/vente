// service-worker.js

// ⚠️ Incrémentez ce nom à chaque déploiement !
const CACHE_NAME = 'africaphone-cache-v17';

const urlsToCache = [
  '/index.html',
  '/login.html',
  '/manifest.json',
  // Bibliothèques externes
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.25/jspdf.plugin.autotable.min.js',
  'https://www.gstatic.com/firebasejs/9.17.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.17.2/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/9.17.2/firebase-firestore-compat.js',
  'https://unpkg.com/lucide@latest'
];

self.addEventListener('install', event => {
  console.log('[SW] Install');
  // Passe directement à l'état "activated" sans attendre la fermeture des onglets
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('activate', event => {
  console.log('[SW] Activate');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)  // supprime les anciens caches
          .map(key => caches.delete(key))
      )
    ).then(() => {
      // Prend le contrôle immédiat de toutes les pages clients
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(cachedResponse => {
        // si trouvé en cache, on renvoie ; sinon on va au réseau
        return cachedResponse || fetch(event.request);
      })
  );
});
