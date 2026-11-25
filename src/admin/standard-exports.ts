/**
 * Misskey's own exports (Settings → Import/Export), run on behalf of a user.
 * The API only queues a job; the worker writes the result into the user's drive root.
 */
import { MisskeyApiError, type MisskeyClient } from '../lib/misskey-api';
import type { MisskeyDriveFile } from '../types/misskey';

export type StandardExportKind =
  | 'notes' | 'favorites' | 'clips' | 'following' | 'muting' | 'blocking' | 'userLists' | 'antennas';

type StandardExportDef = {
  kind: StandardExportKind;
  label: string;
  endpoint: string;
  /** Result files are named `<filePrefix>-yyyy-MM-dd-HH-mm-ss.<json|csv>`. */
  filePrefix: string;
  /** The endpoint's rate limit window. */
  limitMs: number;
};

const HOUR = 60 * 60 * 1000;

export const STANDARD_EXPORTS: StandardExportDef[] = [
  { kind: 'notes', label: 'ノート', endpoint: 'i/export-notes', filePrefix: 'notes', limitMs: 24 * HOUR },
  { kind: 'favorites', label: 'お気に入り', endpoint: 'i/export-favorites', filePrefix: 'favorites', limitMs: 24 * HOUR },
  { kind: 'clips', label: 'クリップ', endpoint: 'i/export-clips', filePrefix: 'clips', limitMs: 24 * HOUR },
  { kind: 'following', label: 'フォロー', endpoint: 'i/export-following', filePrefix: 'following', limitMs: HOUR },
  { kind: 'muting', label: 'ミュート', endpoint: 'i/export-mute', filePrefix: 'mute', limitMs: HOUR },
  { kind: 'blocking', label: 'ブロック', endpoint: 'i/export-blocking', filePrefix: 'blocking', limitMs: HOUR },
  { kind: 'userLists', label: 'リスト', endpoint: 'i/export-user-lists', filePrefix: 'user-lists', limitMs: 60 * 1000 },
  { kind: 'antennas', label: 'アンテナ', endpoint: 'i/export-antennas', filePrefix: 'antennas', limitMs: HOUR },
];

type DriveFileItem = MisskeyDriveFile & { createdAt: string };

export type StandardExportState =
  /** Requested; the result is not in the drive yet. */
  | { status: 'waiting'; note?: string }
  | { status: 'done'; file: DriveFileItem }
  /** Rate limited; the result of the earlier request within the limit window is used. */
  | { status: 'reused'; file: DriveFileItem }
  | { status: 'failed'; message: string };

export type StandardExportStates = Map<StandardExportKind, StandardExportState>;

const POLL_INTERVAL_MS = 5000;

function isResultOf(def: StandardExportDef, file: DriveFileItem): boolean {
  return new RegExp(`^${def.filePrefix}-\\d{4}(-\\d{2}){5}\\.(json|csv)$`).test(file.name);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * Queues the selected exports and records their state in `states`.
 * Returns the newest drive file ID before the requests; results are searched for after it.
 */
export async function requestStandardExports(
  client: MisskeyClient,
  kinds: StandardExportKind[],
  states: StandardExportStates,
  onChange: () => void,
): Promise<string> {
  // Without sinceId/untilId, `sort: '+createdAt'` returns the newest first.
  const latest = await client.post<DriveFileItem[]>('drive/files', { limit: 1, sort: '+createdAt' });
  const baseline = latest[0]?.id ?? '0';

  for (const def of STANDARD_EXPORTS.filter(d => kinds.includes(d.kind))) {
    try {
      await client.post(def.endpoint);
      states.set(def.kind, { status: 'waiting' });
    } catch (e) {
      if (e instanceof MisskeyApiError && e.code === 'RATE_LIMIT_EXCEEDED') {
        const recent = await client.post<DriveFileItem[]>('drive/files', { limit: 100, sort: '+createdAt' });
        const earlier = recent.find(f => isResultOf(def, f) && Date.now() - Date.parse(f.createdAt) < def.limitMs);
        // No result yet: the earlier job may still be running.
        states.set(def.kind, earlier
          ? { status: 'reused', file: earlier }
          : { status: 'waiting', note: '直前に依頼済みのため、その結果を待っています' });
      } else {
        states.set(def.kind, { status: 'failed', message: e instanceof Error ? e.message : String(e) });
      }
    }
    onChange();
  }
  return baseline;
}

/**
 * Polls the drive until every waiting export (or every one in `only`) has its result, `signal` aborts,
 * or `timeoutMs` passes. Exports still awaited at the timeout are marked as failed.
 */
export async function waitForStandardExports(
  client: MisskeyClient,
  baseline: string,
  states: StandardExportStates,
  onChange: () => void,
  signal: AbortSignal,
  timeoutMs: number,
  only?: StandardExportKind[],
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let sinceId = baseline;
  for (;;) {
    const waiting = STANDARD_EXPORTS.filter(d => states.get(d.kind)?.status === 'waiting');
    const awaited = only ? waiting.filter(d => only.includes(d.kind)) : waiting;
    if (awaited.length === 0 || signal.aborted) return;
    if (Date.now() > deadline) {
      for (const d of awaited) {
        states.set(d.kind, { status: 'failed', message: '時間内に完了しませんでした（Misskey のログでジョブの失敗を確認してください）' });
      }
      onChange();
      return;
    }

    // With sinceId, files come in ascending ID order.
    const files = await client.post<DriveFileItem[]>('drive/files', { limit: 100, sinceId });
    for (const f of files) {
      const def = waiting.find(d => isResultOf(d, f) && states.get(d.kind)?.status === 'waiting');
      if (def) {
        states.set(def.kind, { status: 'done', file: f });
        onChange();
      }
    }
    if (files.length > 0) sinceId = files[files.length - 1].id;
    if (files.length < 100) await sleep(POLL_INTERVAL_MS, signal);
  }
}
