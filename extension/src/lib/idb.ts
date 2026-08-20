/**
 * Minimal IndexedDB key/value access.
 *
 * Exists for exactly one thing: `FileSystemDirectoryHandle` is
 * structured-cloneable, so IndexedDB is the only place it can survive a browser
 * restart — `chrome.storage` serializes to JSON and would destroy it, and
 * `chrome.runtime.sendMessage` cannot carry one either.
 *
 * A library would be more code than this is.
 */

const DB_NAME = 'bugcast';
const STORE = 'handles';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
      }),
  );
}

export const idbGet = <T>(key: string): Promise<T | undefined> =>
  run<T | undefined>('readonly', (s) => s.get(key));

export const idbSet = (key: string, value: unknown): Promise<void> =>
  run<void>('readwrite', (s) => s.put(value, key));
