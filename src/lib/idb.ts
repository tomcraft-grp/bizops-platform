// Minimal IndexedDB key-value wrapper (state + media blobs). Falls back to memory if IDB is unavailable.
const DB_NAME = 'bizops-platform';
let dbp: Promise<IDBDatabase | null> | null = null;
const mem = new Map<string, unknown>();

function open(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('kv');
        req.result.createObjectStore('blobs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

function tx<T>(store: 'kv' | 'blobs', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) return resolve(undefined);
        try {
          const t = db.transaction(store, mode);
          const r = fn(t.objectStore(store));
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const v = await tx<T>('kv', 'readonly', (s) => s.get(key));
  return v === undefined ? (mem.get(key) as T | undefined) : v;
}
export async function kvSet(key: string, value: unknown): Promise<boolean> {
  mem.set(key, value);
  const ok = await open().then((db) => !!db);
  if (!ok) return false;
  await tx('kv', 'readwrite', (s) => s.put(value, key));
  return true;
}
export async function kvDel(key: string) {
  mem.delete(key);
  await tx('kv', 'readwrite', (s) => s.delete(key));
}
export async function blobPut(key: string, blob: Blob) {
  mem.set('blob:' + key, blob);
  await tx('blobs', 'readwrite', (s) => s.put(blob, key));
}
export async function blobGet(key: string): Promise<Blob | undefined> {
  const v = await tx<Blob>('blobs', 'readonly', (s) => s.get(key));
  return v ?? (mem.get('blob:' + key) as Blob | undefined);
}
export async function blobDel(key: string) {
  mem.delete('blob:' + key);
  await tx('blobs', 'readwrite', (s) => s.delete(key));
}
