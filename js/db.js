// IndexedDB wrapper. Stores: settings (key/value), recipes, logs (indexed by date).

const NAME = 'food-tracker';
const VERSION = 1;
let dbPromise;

function open() {
  dbPromise ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('settings', { keyPath: 'key' });
      db.createObjectStore('recipes', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true }).createIndex('date', 'date');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const getSetting = async (key, fallback) => (await run('settings', 'readonly', (s) => s.get(key)))?.value ?? fallback;
export const setSetting = (key, value) => run('settings', 'readwrite', (s) => s.put({ key, value }));

export const allRecipes = () => run('recipes', 'readonly', (s) => s.getAll());
export const getRecipe = (id) => run('recipes', 'readonly', (s) => s.get(id));
export const putRecipe = (r) => run('recipes', 'readwrite', (s) => s.put(r)); // resolves to id
export const deleteRecipe = (id) => run('recipes', 'readwrite', (s) => s.delete(id));

export const logsByDate = (date) => run('logs', 'readonly', (s) => s.index('date').getAll(IDBKeyRange.only(date)));
export const putLog = (l) => run('logs', 'readwrite', (s) => s.put(l));
export const deleteLog = (id) => run('logs', 'readwrite', (s) => s.delete(id));

/** Backup. The API key is deliberately NOT exported. */
export async function exportAll() {
  const [recipes, logs, goals] = await Promise.all([
    allRecipes(), run('logs', 'readonly', (s) => s.getAll()), getSetting('goals', null),
  ]);
  return { app: 'food-tracker', version: 1, exportedAt: new Date().toISOString(), goals, recipes, logs };
}

export async function importAll(data) {
  if (data?.app !== 'food-tracker' || !Array.isArray(data.recipes) || !Array.isArray(data.logs)) {
    throw new Error('This file is not a food-tracker backup.');
  }
  const db = await open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['recipes', 'logs', 'settings'], 'readwrite');
    tx.objectStore('recipes').clear();
    tx.objectStore('logs').clear();
    data.recipes.forEach((r) => tx.objectStore('recipes').put(r));
    data.logs.forEach((l) => tx.objectStore('logs').put(l));
    if (data.goals) tx.objectStore('settings').put({ key: 'goals', value: data.goals });
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
