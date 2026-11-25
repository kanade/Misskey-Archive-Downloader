import type { MisskeyNote } from '../types/misskey';

const DB_NAME = 'misskey-archive-cache';
const DB_VERSION = 3;

let _db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('notes')) {
        const ns = db.createObjectStore('notes', { keyPath: ['instanceUrl', 'userId', 'id'] });
        ns.createIndex('byAccount', ['instanceUrl', 'userId'], { unique: false });
      }
      // v3: restore files store (keyed by URL)
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'url' });
      }
    };
    req.onsuccess = (e) => {
      _db = (e.target as IDBOpenDBRequest).result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(db: IDBDatabase, stores: string | string[], mode: IDBTransactionMode) {
  return db.transaction(stores, mode);
}

// ---- Notes ----

export async function getCachedNotes(instanceUrl: string, userId: string): Promise<MisskeyNote[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = tx(db, 'notes', 'readonly');
    const store = t.objectStore('notes');
    const index = store.index('byAccount');
    const req = index.getAll([instanceUrl, userId]);
    req.onsuccess = () => {
      const rows = req.result as ({ instanceUrl: string; userId: string } & MisskeyNote)[];
      resolve(rows.map(({ instanceUrl: _i, userId: _u, ...note }) => note as MisskeyNote));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getLatestNoteId(instanceUrl: string, userId: string): Promise<string | null> {
  const notes = await getCachedNotes(instanceUrl, userId);
  if (notes.length === 0) return null;
  return notes.reduce((best, n) => n.id > best ? n.id : best, notes[0].id);
}

export async function saveNotes(instanceUrl: string, userId: string, notes: MisskeyNote[]): Promise<void> {
  if (notes.length === 0) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = tx(db, 'notes', 'readwrite');
    const store = t.objectStore('notes');
    for (const note of notes) {
      store.put({ instanceUrl, userId, ...note });
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ---- Files ----

export async function getCachedFile(url: string): Promise<Blob | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = tx(db, 'files', 'readonly');
    const req = t.objectStore('files').get(url);
    req.onsuccess = () => {
      const row = req.result as { url: string; blob: Blob } | undefined;
      resolve(row?.blob ?? null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function cacheFile(url: string, blob: Blob): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = tx(db, 'files', 'readwrite');
    t.objectStore('files').put({ url, blob });
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function clearFileCache(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = tx(db, 'files', 'readwrite');
    t.objectStore('files').clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
