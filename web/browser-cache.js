'use strict';

const NanoBrowserCache = (() => {
  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('nanoscope-resources', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('resources');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  }
  async function readVendors() {
    let db;
    try {
      db = await open();
      return await new Promise((resolve, reject) => { const request = db.transaction('resources').objectStore('resources').get('vendors'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    } catch { return null; } finally { db?.close(); }
  }
  async function saveVendors(data) {
    let db;
    try {
      db = await open();
      await new Promise((resolve, reject) => { const transaction = db.transaction('resources', 'readwrite'); transaction.objectStore('resources').put({ data, savedAt: Date.now() }, 'vendors'); transaction.oncomplete = resolve; transaction.onerror = transaction.onabort = () => reject(transaction.error); });
    } catch {} finally { db?.close(); }
  }
  return { readVendors, saveVendors };
})();
