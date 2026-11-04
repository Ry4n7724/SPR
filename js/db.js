// Minimal IndexedDB wrapper. Stores: sets, cards (incl. progress), images (blobs).
let dbp;
function open() {
  return (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('spr', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('sets', { keyPath: 'id' });
      d.createObjectStore('cards', { keyPath: 'id' }).createIndex('setId', 'setId');
      d.createObjectStore('images', { keyPath: 'key' }).createIndex('setId', 'setId');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

async function run(stores, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(stores, mode);
    let out;
    t.oncomplete = () => res(out);
    t.onerror = t.onabort = () => rej(t.error);
    const r = fn(t);
    if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
  });
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

export const getSets = () => run('sets', 'readonly', (t) => t.objectStore('sets').getAll());
export const getCards = (setId) => run('cards', 'readonly', (t) => t.objectStore('cards').index('setId').getAll(setId));
export const getImages = (setId) => run('images', 'readonly', (t) => t.objectStore('images').index('setId').getAll(setId));

export const putMany = (store, items) => run(store, 'readwrite', (t) => {
  const s = t.objectStore(store);
  items.forEach((i) => s.put(i));
});

export async function deleteSet(id) {
  const cardKeys = await run('cards', 'readonly', (t) => t.objectStore('cards').index('setId').getAllKeys(id));
  const imgKeys = await run('images', 'readonly', (t) => t.objectStore('images').index('setId').getAllKeys(id));
  await run(['sets', 'cards', 'images'], 'readwrite', (t) => {
    t.objectStore('sets').delete(id);
    cardKeys.forEach((k) => t.objectStore('cards').delete(k));
    imgKeys.forEach((k) => t.objectStore('images').delete(k));
  });
}
