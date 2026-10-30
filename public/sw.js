const CACHE_NAME = 'airbridge-shell-v1';
const DB_NAME = 'airbridge-share-db';
const STORE_NAME = 'shared-items';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function openShareDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveSharedPayload(payload) {
  const db = await openShareDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ id: 'latest', ...payload, timestamp: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname === '/_share-target' && event.request.method === 'POST') {
    event.respondWith(
      (async () => {
        try {
          const formData = await event.request.formData();
          const files = formData.getAll('files').filter((item) => item instanceof File && item.size >= 0);
          const title = formData.get('title') ? String(formData.get('title')) : '';
          const text = formData.get('text') ? String(formData.get('text')) : '';
          const sharedUrl = formData.get('url') ? String(formData.get('url')) : '';
          await saveSharedPayload({ files, title, text, url: sharedUrl });
          return Response.redirect('/?shared=1', 303);
        } catch (err) {
          return Response.redirect('/?share_error=1', 303);
        }
      })()
    );
  }
});
