/**
 * Backend commands that exist only in the admin build (Cargo feature `admin`).
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ApiTransport } from '../lib/misskey-api';
import { requestHeadersFor } from '../lib/tauri-bridge';
import type { Log } from '../lib/log';

export type DbConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
};

/** A row of Misskey's `user` table, limited to what the admin tool needs. */
export type LocalUserRow = {
  id: string;
  username: string;
  /** The native token. Endpoints marked `secure` (e.g. `i/export-*`) accept only this token. */
  token: string | null;
  isSuspended: boolean;
  isDeleted: boolean;
};

/** Looks up a local user by username (case-insensitive). Read-only. Rejects with the full error text. */
export function findLocalUser(db: DbConfig, username: string): Promise<LocalUserRow | null> {
  return invoke<LocalUserRow | null>('admin_find_user', { db, username });
}

/** A destination reached through the SSH server, as seen from that server. */
export type Forward = { host: string; port: number };

/**
 * Starts `ssh -N -L ...` with the PC's ssh command and resolves with the local port (on 127.0.0.1) of each
 * forward once all of them accept connections. A previous tunnel is stopped first.
 */
export function openTunnel(destination: string, sshPort: number, forwards: Forward[]): Promise<number[]> {
  return invoke<number[]>('admin_tunnel_open', { destination, sshPort, forwards });
}

export function closeTunnel(): Promise<void> {
  return invoke('admin_tunnel_close');
}

/** Subscribes to ssh's stderr lines and its exit. Resolves with the function that unsubscribes. */
export async function listenTunnel(onLine: (line: string) => void, onClosed: () => void): Promise<() => void> {
  const unlistenLine = await listen<string>('admin-tunnel-log', e => onLine(e.payload));
  const unlistenClosed = await listen('admin-tunnel-closed', () => onClosed());
  return () => { unlistenLine(); unlistenClosed(); };
}

/**
 * Sends API requests to `baseUrl` (e.g. `http://127.0.0.1:3000`) through the backend.
 * Each request is written to `log` without the token (`i`).
 */
export function backendTransport(baseUrl: string, log?: Log): ApiTransport {
  return async (endpoint, payload) => {
    const url = `${baseUrl}/api/${endpoint}`;
    const params = JSON.stringify(Object.fromEntries(Object.entries(payload).filter(([k]) => k !== 'i')));
    const started = Date.now();
    try {
      const res = await invoke<{ status: number; body: unknown | null }>('admin_post_json', {
        url,
        body: payload,
        headers: requestHeadersFor(url),
      });
      const line = `POST ${url} ${params} → ${res.status} (${Date.now() - started} ms)`;
      if (res.status >= 200 && res.status < 300) log?.('info', line);
      else log?.('warn', `${line}\n${JSON.stringify(res.body, null, 2)}`);
      return { status: res.status, body: res.body ?? undefined };
    } catch (e) {
      log?.('error', `POST ${url} ${params} → ${String(e)}`);
      throw e;
    }
  };
}
