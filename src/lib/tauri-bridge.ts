/**
 * Tauri integration bridge.
 * All functions in this file are safe to call in both web and desktop contexts.
 * In web context, they fall back to browser-native behavior.
 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  }
}

export const isTauri = (): boolean =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);

/**
 * Fetch a URL and return its bytes as a Blob.
 * In desktop mode: uses Rust backend (bypasses CORS).
 * In web mode: uses browser fetch.
 */
export type FetchResult = { blob: Blob | null; error?: string };

// Added to requests of fetchBlob() and of the admin app's API requests whose host is one of `hosts`
// or a subdomain of one. Never set in the user app.
let requestHeaders: Record<string, string> = {};
let requestHeaderHosts: string[] = [];

/** `hosts` are lowercase host names. */
export function setRequestHeaders(headers: Record<string, string>, hosts: string[]): void {
  requestHeaders = { ...headers };
  requestHeaderHosts = [...hosts];
}

/** The extra headers for a request to `url` (empty unless its host is one of the configured hosts). */
export function requestHeadersFor(url: string): Record<string, string> {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return {};
  }
  return requestHeaderHosts.some(h => host === h || host.endsWith(`.${h}`)) ? requestHeaders : {};
}

export async function fetchBlob(url: string): Promise<FetchResult> {
  const headers = requestHeadersFor(url);
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const bytes = await invoke<ArrayBuffer>('fetch_bytes', { url, headers });
      return { blob: new Blob([bytes]) };
    } catch (e) {
      return { blob: null, error: String(e) };
    }
  } else {
    try {
      const resp = await fetch(url, { headers });
      if (resp.ok) return { blob: await resp.blob() };
      return { blob: null, error: `HTTP ${resp.status}` };
    } catch (e) {
      return { blob: null, error: String(e) };
    }
  }
}

/** A file chosen through the native save dialog, open for streaming writes (desktop only). */
export type SaveTarget = {
  path: string;
  /** Closing the stream finishes the file. */
  writable: WritableStream<Uint8Array>;
  /** Discards the partially written file. No-op once the stream has been closed. */
  abort: () => Promise<void>;
};

/** A folder created through the native folder dialog that receives the archive as plain files (desktop only). */
export type FolderTarget = {
  path: string;
  /** Writes one file at `relPath` (forward slashes, relative to the folder). */
  writeFile: (relPath: string, data: Blob) => Promise<void>;
  finish: () => Promise<void>;
  /** Deletes the folder with everything written into it. */
  abort: () => Promise<void>;
};

type Invoke = typeof import('@tauri-apps/api/core').invoke;

// Data is sent to the backend as raw binary IPC bodies of up to this size.
const SAVE_CHUNK_BYTES = 8 * 1024 * 1024;

/** Feeds the file opened on the backend (`save_begin` / `folder_open_file`); closing the stream finishes it. */
function backendFileStream(invoke: Invoke, onClosed: () => void): WritableStream<Uint8Array> {
  const buffer = new Uint8Array(SAVE_CHUNK_BYTES);
  let used = 0;
  const flush = async () => {
    if (used === 0) return;
    await invoke('save_write', buffer.slice(0, used));
    used = 0;
  };
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      if (used + chunk.length > buffer.length) await flush();
      if (chunk.length >= buffer.length) {
        for (let i = 0; i < chunk.length; i += buffer.length) {
          await invoke('save_write', chunk.subarray(i, i + buffer.length));
        }
        return;
      }
      buffer.set(chunk, used);
      used += chunk.length;
    },
    async close() {
      await flush();
      await invoke('save_finish');
      onClosed();
    },
    async abort() {
      await invoke('save_abort');
    },
  });
}

/** Desktop only: asks for a destination and opens it for writing. Returns null if cancelled. */
export async function openSaveTarget(defaultFilename: string): Promise<SaveTarget | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  const path = await invoke<string | null>('save_begin', { defaultFilename });
  if (!path) return null;
  let closed = false;
  return {
    path,
    writable: backendFileStream(invoke, () => { closed = true; }),
    abort: async () => {
      if (!closed) await invoke('save_abort');
    },
  };
}

/** Desktop only: asks for a parent folder and creates `dirName` inside it. Returns null if cancelled. */
export async function openFolderTarget(dirName: string): Promise<FolderTarget | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  const path = await invoke<string | null>('folder_begin', { dirName });
  if (!path) return null;
  return {
    path,
    writeFile: async (relPath, data) => {
      await invoke('folder_open_file', { relPath });
      await data.stream().pipeTo(backendFileStream(invoke, () => {}));
    },
    finish: () => invoke('folder_finish'),
    abort: () => invoke('folder_abort'),
  };
}

/**
 * Save a blob to disk.
 * In desktop mode: native save dialog.
 * In web mode: blob URL + <a download>.
 */
export async function saveBlob(blob: Blob, filename: string): Promise<void> {
  if (isTauri()) {
    const target = await openSaveTarget(filename);
    if (!target) return;
    try {
      await blob.stream().pipeTo(target.writable);
    } catch (e) {
      await target.abort();
      throw e;
    }
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

/**
 * Open a URL in the system browser.
 * In desktop mode: uses shell plugin (`shell:allow-open`; http(s) URLs are allowed by default).
 * In web mode: window.open.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('plugin:shell|open', { path: url });
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

/**
 * Get the MiAuth callback URL for this environment.
 * Desktop: misskey-archive://callback
 * Web: current origin + pathname + #/callback
 */
export function getMiAuthCallbackUrl(): string {
  if (isTauri()) {
    return 'misskey-archive://callback';
  }
  return `${location.origin}${location.pathname}#/callback`;
}
