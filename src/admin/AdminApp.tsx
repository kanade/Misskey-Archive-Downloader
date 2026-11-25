import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MisskeyClient } from '../lib/misskey-api';
import {
  buildArchive, folderSink, parseNotesExport, zipSink,
  type ArchiveSink, type ExportProgress, type SectionMode, type UploadData, type UrlRewriter,
} from '../lib/exporter';
import { fetchBlob, openFolderTarget, openSaveTarget, setRequestHeaders } from '../lib/tauri-bridge';
import { LATEST_VIEWER_URL, openLinkInBrowser } from '../lib/links';
import { clearFileCache, getCachedNotes, getLatestNoteId, saveNotes } from '../lib/archive-db';
import type { ClipExport, FavoriteExportItem, MisskeyNote, MisskeyUser } from '../types/misskey';
import { VERSION } from '../version';
import { backendTransport, closeTunnel, findLocalUser, listenTunnel, openTunnel } from './admin-bridge';
import { LogPanel } from '../components/LogPanel';
import { formatLog } from '../lib/log';
import { useLog } from '../lib/use-log';
import { invalidRewriteLines, makeUrlRewriter, parseRewriteRules } from './url-rewrite';
import { parseBypassHosts } from './bypass-hosts';
import {
  STANDARD_EXPORTS, requestStandardExports, waitForStandardExports,
  type StandardExportKind, type StandardExportState, type StandardExportStates,
} from './standard-exports';

type Phase = 'idle' | 'running' | 'done' | 'error';

type Connection = {
  /** With SSH, `misskeyUrl` and `dbHost`/`dbPort` are as seen from the SSH server. */
  useSsh: boolean;
  sshDestination: string;
  sshPort: string;
  misskeyUrl: string;
  dbHost: string;
  dbPort: string;
  dbName: string;
  dbUser: string;
  rewriteRules: string;
  /** Sends BYPASS_HEADER with HTTP requests (API, files, emojis, standard export results) to `bypassHosts`. */
  useBypassToken: boolean;
  bypassToken: string;
  /** One domain per line; its subdomains are included. */
  bypassHosts: string;
};

// Lets requests through a gateway in front of the closed server that answers 410 Gone.
const BYPASS_HEADER = 'X-Gone-Bypass-Token';

// A header value may hold visible ASCII only.
const isValidHeaderValue = (v: string) => /^[\x21-\x7e]+$/.test(v);

function applyRequestHeaders(conn: Connection): void {
  const token = conn.bypassToken.trim();
  if (conn.useBypassToken && token) setRequestHeaders({ [BYPASS_HEADER]: token }, parseBypassHosts(conn.bypassHosts).hosts);
  else setRequestHeaders({}, []);
}

const DEFAULT_CONNECTION: Connection = {
  useSsh: false,
  sshDestination: '',
  sshPort: '22',
  misskeyUrl: 'http://127.0.0.1:3000',
  dbHost: '127.0.0.1',
  dbPort: '5432',
  dbName: 'misskey',
  dbUser: 'misskey',
  rewriteRules: '',
  useBypassToken: false,
  bypassToken: '',
  bypassHosts: '',
};

// The database password is not stored.
const CONNECTION_KEY = 'admin_connection';

function loadConnection(): Connection {
  try {
    return { ...DEFAULT_CONNECTION, ...JSON.parse(localStorage.getItem(CONNECTION_KEY) ?? '{}') };
  } catch {
    return DEFAULT_CONNECTION;
  }
}

type Target = {
  client: MisskeyClient;
  user: MisskeyUser;
  /** The server's public URL (`url` in its config file). Recorded file URLs start with it. */
  originalUrl: string;
  host: string;
  /** Where the API is reached from this PC (the local end of the tunnel when SSH is used). */
  apiBase: string;
};

/**
 * Where a section of the archive comes from.
 * `export`: the standard export requested in the same run. `file`: a JSON file of a standard export on this PC.
 */
type Source = 'api' | 'export' | 'file' | 'none';

type ArchiveSection = 'notes' | 'favorites' | 'clips';

const SOURCE_LABELS: Record<Source, string> = { api: 'API', export: '標準エクスポート', file: 'JSON ファイル', none: 'なし' };

function toMode(source: Source): SectionMode {
  return source === 'api' ? 'api' : source === 'none' ? 'none' : 'upload';
}

// A single ZIP file, or plain files written into a folder.
type OutputMode = 'zip' | 'folder';

// A notes export of a large account can take a long time on the worker.
const EXPORT_TIMEOUT_MS = 60 * 60 * 1000;

const inputClass =
  'w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent text-sm';
const fileInputClass =
  'block w-full text-xs text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-violet-50 file:text-violet-700 hover:file:bg-violet-100 dark:file:bg-violet-900/30 dark:file:text-violet-300';
const labelClass = 'block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1';
const sectionTitleClass = 'text-xs font-medium text-gray-700 dark:text-gray-300';

const modeButtonClass = (active: boolean) =>
  `px-3 py-1 text-xs rounded-md border transition-colors ${
    active
      ? 'bg-violet-600 text-white border-violet-600'
      : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-300 dark:border-gray-600 hover:border-violet-400'
  }`;

function exportStateLabel(state: StandardExportState): string {
  switch (state.status) {
    case 'waiting': return state.note ?? '作成を待っています';
    case 'done': return `作成済み（${state.file.name}）`;
    case 'reused': return `直前の結果を使用（${state.file.name}）`;
    case 'failed': return `失敗: ${state.message}`;
  }
}

// `i` called with the native token also returns these, which a MiAuth token does not get.
const SECRET_USER_KEYS = ['email', 'emailVerified', 'securityKeysList'];

function withoutSecrets(user: MisskeyUser): MisskeyUser {
  const src = user as unknown as Record<string, unknown>;
  return Object.fromEntries(Object.entries(src).filter(([k]) => !SECRET_USER_KEYS.includes(k))) as unknown as MisskeyUser;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function prefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export default function AdminApp() {
  const [conn, setConn] = useState<Connection>(loadConnection);
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [target, setTarget] = useState<Target | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState('');

  const [includeArchive, setIncludeArchive] = useState(true);
  const [sources, setSources] = useState<Record<ArchiveSection, Source>>({ notes: 'api', favorites: 'api', clips: 'api' });
  const [sourceFiles, setSourceFiles] = useState<Record<ArchiveSection, File | null>>({ notes: null, favorites: null, clips: null });
  const [selectedExports, setSelectedExports] = useState<StandardExportKind[]>(STANDARD_EXPORTS.map(d => d.kind));
  const [outputMode, setOutputMode] = useState<OutputMode>(() => localStorage.getItem('admin_output_mode') === 'folder' ? 'folder' : 'zip');
  const [useNoteCache, setUseNoteCache] = useState(() => localStorage.getItem('admin_use_note_cache') !== '0');
  const [useFileCache, setUseFileCache] = useState(() => localStorage.getItem('admin_use_file_cache') === '1');
  const [useEmojiCache, setUseEmojiCache] = useState(() => localStorage.getItem('admin_use_emoji_cache') !== '0');

  const [phase, setPhase] = useState<Phase>('idle');
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [cachedNoteCount, setCachedNoteCount] = useState(0);
  const [newNoteCount, setNewNoteCount] = useState(0);
  const [archiveFailCount, setArchiveFailCount] = useState(0);
  const [exportStates, setExportStates] = useState<StandardExportStates>(new Map());
  const [savedPath, setSavedPath] = useState('');
  const [savedAs, setSavedAs] = useState<OutputMode>('zip');
  const [errorMsg, setErrorMsg] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const [themeOverridden, setThemeOverridden] = useState(() => localStorage.getItem('theme_overridden') === '1');

  const { entries: logs, entriesRef: logEntriesRef, log, clear: clearLogs } = useLog();

  // Follow the OS theme unless the user has flipped it
  useEffect(() => {
    const apply = () => document.documentElement.classList.toggle('dark', themeOverridden ? !prefersDark() : prefersDark());
    apply();
    if (themeOverridden) localStorage.setItem('theme_overridden', '1');
    else localStorage.removeItem('theme_overridden');
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [themeOverridden]);

  // ssh's own messages (authentication, forwarding failures) go to the log
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listenTunnel(
      line => log('info', `ssh: ${line}`),
      () => log('warn', 'ssh が終了しました（ポート転送は使えなくなりました）'),
    ).then(fn => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [log]);

  // F12 / Ctrl+Shift+I opens DevTools
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) {
        await invoke('toggle_devtools');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  function updateConn(patch: Partial<Connection>) {
    setConn(c => ({ ...c, ...patch }));
    setTarget(null);
  }

  const invalidRules = invalidRewriteLines(conn.rewriteRules);
  const bypassTokenInvalid = conn.useBypassToken && !isValidHeaderValue(conn.bypassToken.trim());
  const bypassHosts = parseBypassHosts(conn.bypassHosts);
  const bypassHostsInvalid = conn.useBypassToken && (bypassHosts.hosts.length === 0 || bypassHosts.invalid.length > 0);

  // Standard exports the archive is built from; they are requested whether or not they are checked.
  const requiredExports: StandardExportKind[] = includeArchive
    ? (['notes', 'favorites', 'clips'] as const).filter(s => sources[s] === 'export')
    : [];
  const requestedExports = STANDARD_EXPORTS
    .map(d => d.kind)
    .filter(k => selectedExports.includes(k) || requiredExports.includes(k));

  async function lookUp(e: React.FormEvent) {
    e.preventDefault();
    setTarget(null);
    setLookupError('');
    setLookingUp(true);
    try {
      localStorage.setItem(CONNECTION_KEY, JSON.stringify(conn));
      applyRequestHeaders(conn);
      log('info', conn.useBypassToken
        ? `${parseBypassHosts(conn.bypassHosts).hosts.join('・')}（サブドメインを含む）への HTTP 通信に ${BYPASS_HEADER} ヘッダを付けます（値はログに出しません）`
        : `${BYPASS_HEADER} ヘッダは付けません`);
      const name = username.trim().replace(/^@/, '').replace(/@.*$/, '');
      const misskeyUrl = conn.misskeyUrl.trim().replace(/\/+$/, '');
      let dbHost = conn.dbHost.trim();
      let dbPort = Number(conn.dbPort);
      let apiBase = misskeyUrl;

      if (conn.useSsh) {
        const misskey = new URL(misskeyUrl);
        const misskeyHost = misskey.hostname.replace(/^\[|\]$/g, '');
        const misskeyPort = Number(misskey.port || (misskey.protocol === 'https:' ? 443 : 80));
        log('info', `ssh ${conn.sshDestination.trim()}（ポート ${conn.sshPort}）でポート転送を開始: PostgreSQL ${dbHost}:${dbPort}、Misskey ${misskeyHost}:${misskeyPort}（サーバーから見た場所）`);
        const [dbLocal, misskeyLocal] = await openTunnel(conn.sshDestination.trim(), Number(conn.sshPort), [
          { host: dbHost, port: dbPort },
          { host: misskeyHost, port: misskeyPort },
        ]);
        dbHost = '127.0.0.1';
        dbPort = dbLocal;
        apiBase = `${misskey.protocol}//127.0.0.1:${misskeyLocal}`;
        log('info', `ポート転送を開始しました: PostgreSQL → 127.0.0.1:${dbLocal}、Misskey → ${apiBase}`);
      } else {
        await closeTunnel();
      }

      log('info', `PostgreSQL ${conn.dbUser}@${dbHost}:${dbPort}/${conn.dbName} で @${name} を検索`);
      const row = await findLocalUser(
        { host: dbHost, port: dbPort, database: conn.dbName, user: conn.dbUser, password },
        name,
      );
      if (!row) throw new Error(`@${name} はこのサーバーのユーザーとして見つかりませんでした`);
      log('info', `@${row.username}: id ${row.id}、凍結 ${row.isSuspended ? 'あり' : 'なし'}、削除 ${row.isDeleted ? 'あり' : 'なし'}、トークン ${row.token ? 'あり' : 'なし'}`);
      if (row.isDeleted) throw new Error(`@${row.username} は削除済みです`);
      if (row.isSuspended) throw new Error(`@${row.username} は凍結されています。実行する間だけ凍結を解除してください`);
      if (!row.token) throw new Error(`@${row.username} にはトークンがありません`);

      const client = new MisskeyClient(apiBase, row.token, backendTransport(apiBase, log));
      const meta = await client.post<{ uri: string }>('meta');
      const user = withoutSecrets(await client.getMe());
      log('info', `サーバーの公開 URL: ${meta.uri}`);
      setTarget({ client, user, originalUrl: meta.uri, host: new URL(meta.uri).host, apiBase });
    } catch (e) {
      const message = errorMessage(e);
      log('error', message);
      setLookupError(message);
    } finally {
      setLookingUp(false);
    }
  }

  function toggleExport(kind: StandardExportKind, on: boolean) {
    setSelectedExports(list => on ? [...list, kind] : list.filter(k => k !== kind));
  }

  async function run() {
    if (!target) return;
    applyRequestHeaders(conn);
    const { client, user, host, originalUrl, apiBase } = target;
    const rewrite: UrlRewriter = makeUrlRewriter(originalUrl, apiBase, parseRewriteRules(conn.rewriteRules));
    const s = new Date().toLocaleString('sv', { timeZone: 'Asia/Tokyo' }).replace(/[-: ]/g, '');
    const baseName = `misskey-archive-${host}-${user.username}-${s.slice(0, 8)}-${s.slice(8, 14)}`;

    // The destination is chosen first; everything is written straight to it.
    let output: ArchiveSink;
    let outputPath: string;
    let discard: (() => Promise<void>) | undefined;
    try {
      if (outputMode === 'folder') {
        const folder = await openFolderTarget(baseName);
        if (!folder) return;
        output = folderSink(folder);
        outputPath = folder.path;
        discard = folder.abort;
      } else {
        const file = await openSaveTarget(`${baseName}.zip`);
        if (!file) return;
        output = zipSink(baseName, file.writable);
        outputPath = file.path;
        discard = file.abort;
      }
    } catch (e) {
      const message = errorMessage(e);
      log('error', message);
      setErrorMsg(message);
      setPhase('error');
      return;
    }

    // buildArchive writes error.log only when it finishes. When a folder is kept after a failure,
    // the errors of this run up to the failure are written there instead.
    const logStart = logEntriesRef.current.length;
    const writeErrorLog = () => output.add(
      'error.log',
      formatLog(logEntriesRef.current.slice(logStart).filter(e => e.level === 'error')),
    );

    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;
    const states: StandardExportStates = new Map();
    const loggedStates = new Map<StandardExportKind, string>();
    // Logs each state change, then shows the states.
    const publish = () => {
      for (const def of STANDARD_EXPORTS) {
        const state = states.get(def.kind);
        if (!state) continue;
        const label = exportStateLabel(state);
        if (loggedStates.get(def.kind) === label) continue;
        loggedStates.set(def.kind, label);
        log(state.status === 'failed' ? 'error' : 'info', `標準エクスポート（${def.label}）: ${label}`);
      }
      setExportStates(new Map(states));
    };
    let lastMessage = '';
    const showProgress = (p: ExportProgress) => {
      setProgress(p);
      if (p.message === lastMessage) return;
      lastMessage = p.message;
      log('info', p.message);
    };
    setExportStates(new Map());
    setProgress(null);
    setCachedNoteCount(0);
    setNewNoteCount(0);
    setArchiveFailCount(0);
    setSavedPath('');
    setCancelling(false);
    setPhase('running');

    const archiveParts = includeArchive
      ? `ノート=${SOURCE_LABELS[sources.notes]}、お気に入り=${SOURCE_LABELS[sources.favorites]}、クリップ=${SOURCE_LABELS[sources.clips]}`
      : 'なし';
    const exportParts = STANDARD_EXPORTS.filter(d => requestedExports.includes(d.kind)).map(d => d.label).join('・') || 'なし';
    log('info', `作成開始: @${user.username}@${host}（アーカイブ: ${archiveParts}／標準エクスポート: ${exportParts}）`);
    log('info', `保存先（${outputMode === 'folder' ? 'フォルダ' : 'ZIP'}）: ${outputPath}`);
    log('info', `ノートのキャッシュ: ${useNoteCache ? '使う' : '使わない'}、ドライブファイルのキャッシュ: ${useFileCache ? '使う' : '使わない'}、絵文字のキャッシュ: ${useEmojiCache ? '使う' : '使わない'}`);
    for (const rule of parseRewriteRules(conn.rewriteRules)) log('info', `URL の置き換え: ${rule.from} → ${rule.to}`);

    let baseline = '0';

    // Downloaded once: a result used for the archive is also written to exports/.
    const exportBlobs = new Map<StandardExportKind, Blob>();
    async function downloadExport(kind: StandardExportKind): Promise<{ blob: Blob | null; message?: string }> {
      const cached = exportBlobs.get(kind);
      if (cached) return { blob: cached };
      const state = states.get(kind);
      if (state?.status !== 'done' && state?.status !== 'reused') {
        return { blob: null, message: state?.status === 'failed' ? state.message : '結果がありません' };
      }
      const url = rewrite(state.file.url);
      const r = await fetchBlob(url);
      if (!r.blob) return { blob: null, message: `ファイルを取得できませんでした: ${url} → ${r.error ?? 'unknown'}` };
      exportBlobs.set(kind, r.blob);
      log('info', `標準エクスポート（${STANDARD_EXPORTS.find(d => d.kind === kind)!.label}）: ${url} を取得（${r.blob.size.toLocaleString()} バイト）`);
      return { blob: r.blob };
    }

    /** Reads the sections whose source is a standard export or a JSON file. */
    async function loadUploadData(): Promise<UploadData | undefined> {
      const fromJson = (['notes', 'favorites', 'clips'] as const).filter(s => sources[s] === 'export' || sources[s] === 'file');
      if (fromJson.length === 0) return undefined;
      if (requiredExports.length > 0) {
        showProgress({ phase: 'packaging', message: 'アーカイブに使う標準エクスポートの完了を待っています...' });
        await waitForStandardExports(client, baseline, states, publish, signal, EXPORT_TIMEOUT_MS, requiredExports);
        if (signal.aborted) throw new Error('aborted');
      }

      const parsed = new Map<ArchiveSection, unknown[]>();
      for (const section of fromJson) {
        const label = STANDARD_EXPORTS.find(d => d.kind === section)!.label;
        let text: string;
        if (sources[section] === 'file') {
          const file = sourceFiles[section]!;
          text = await file.text();
          log('info', `${label}: JSON ファイル ${file.name} を読み込み`);
        } else {
          const { blob, message } = await downloadExport(section);
          if (!blob) throw new Error(`標準エクスポート（${label}）を使えないため、アーカイブを作れません: ${message}`);
          text = await blob.text();
        }
        const items = JSON.parse(text) as unknown[];
        parsed.set(section, items);
        log('info', `${label}: ${items.length.toLocaleString()} 件を ${SOURCE_LABELS[sources[section]]} からアーカイブに使用`);
      }
      const notes = parsed.get('notes');
      return {
        exportedNotes: notes ? parseNotesExport(notes) : [],
        favItems: parsed.get('favorites') as FavoriteExportItem[] | undefined,
        clipExports: parsed.get('clips') as ClipExport[] | undefined,
      };
    }

    /** Notes through the API, using the note cache the same way as the user app. */
    async function fetchNotes(): Promise<MisskeyNote[]> {
      if (useNoteCache) {
        showProgress({ phase: 'notes-api', message: 'キャッシュを読み込み中...' });
        const cached = await getCachedNotes(host, user.id);
        setCachedNoteCount(cached.length);
        const latestId = await getLatestNoteId(host, user.id);
        const fresh: MisskeyNote[] = [];
        for await (const batch of client.fetchAllNotes(user.id, (n) => {
          setNewNoteCount(n);
          showProgress({ phase: 'notes-api', message: 'API でノートを取得中...', noteCount: cached.length + n, newNoteCount: n, cachedNoteCount: cached.length });
        }, latestId ?? undefined)) {
          if (signal.aborted) throw new Error('aborted');
          fresh.push(...batch);
        }
        if (fresh.length > 0) await saveNotes(host, user.id, fresh);
        setNewNoteCount(fresh.length);
        log('info', `ノート: キャッシュ ${cached.length.toLocaleString()} 件 + 新規 ${fresh.length.toLocaleString()} 件`);
        return [...fresh, ...cached].sort((a, b) => b.id > a.id ? 1 : -1);
      }
      const fresh: MisskeyNote[] = [];
      for await (const batch of client.fetchAllNotes(user.id, (n) => {
        setNewNoteCount(n);
        showProgress({ phase: 'notes-api', message: 'API でノートを取得中（キャッシュなし）...', noteCount: n, newNoteCount: n, cachedNoteCount: 0 });
      })) {
        if (signal.aborted) throw new Error('aborted');
        fresh.push(...batch);
      }
      await saveNotes(host, user.id, fresh);
      setNewNoteCount(fresh.length);
      log('info', `ノート: ${fresh.length.toLocaleString()} 件を取得`);
      return fresh.sort((a, b) => b.id > a.id ? 1 : -1);
    }

    async function addStandardExports() {
      if (states.size === 0) return;
      showProgress({ phase: 'packaging', message: '標準エクスポートの完了を待っています...' });
      await waitForStandardExports(client, baseline, states, publish, signal, EXPORT_TIMEOUT_MS);
      if (signal.aborted) throw new Error('aborted');

      showProgress({ phase: 'packaging', message: '標準エクスポートのファイルを取得中...' });
      const summary: string[] = [];
      for (const def of STANDARD_EXPORTS) {
        const state = states.get(def.kind);
        if (!state) continue;
        if (state.status === 'done' || state.status === 'reused') {
          const { blob, message } = await downloadExport(def.kind);
          if (blob) {
            await output.add(`exports/${state.file.name}`, blob);
            log('info', `標準エクスポート（${def.label}）: exports/${state.file.name} に保存`);
            summary.push(`${def.label}: ${state.file.name}${state.status === 'reused' ? '（直前の結果を使用）' : ''}`);
          } else {
            states.set(def.kind, { status: 'failed', message: message ?? 'unknown' });
            summary.push(`${def.label}: 失敗 ${message}`);
          }
        } else if (state.status === 'failed') {
          summary.push(`${def.label}: 失敗 ${state.message}`);
        }
      }
      publish();
      await output.add('exports/exports.log', summary.join('\n') + '\n');
    }

    // Standard exports are added last, after the worker has had time to finish them.
    const sink: ArchiveSink = {
      add: (path, data, store) => output.add(path, data, store),
      close: async () => {
        await addStandardExports();
        return output.close();
      },
    };

    let completed = false;
    try {
      if (requestedExports.length > 0) {
        showProgress({ phase: 'packaging', message: '標準エクスポートを依頼中...' });
        baseline = await requestStandardExports(client, requestedExports, states, publish);
      }

      if (includeArchive) {
        const uploadData = await loadUploadData();
        const apiNotes = sources.notes === 'api' ? await fetchNotes() : undefined;
        await buildArchive(
          host, user,
          {
            notesMode: toMode(sources.notes) as 'api' | 'upload',
            favoritesMode: toMode(sources.favorites),
            clipsMode: toMode(sources.clips),
          },
          client,
          (p) => {
            showProgress(p);
            // The packaging event carries the total over all sections.
            if (p.phase === 'packaging') setArchiveFailCount(p.failCount ?? 0);
          },
          signal,
          sink,
          apiNotes,
          uploadData,
          useFileCache,
          rewrite,
          log,
          useEmojiCache,
        );
      } else {
        await sink.close();
      }
      if (signal.aborted) return;
      completed = true;
      log('info', `完了: ${outputPath}`);
      setSavedAs(outputMode);
      setSavedPath(outputPath);
      setPhase('done');
    } catch (e) {
      if (signal.aborted) return;
      let message = errorMessage(e);
      // A partially written folder is still usable, unlike a truncated ZIP.
      const keepFolder = outputMode === 'folder';
      if (keepFolder) {
        discard = undefined;
        message += `\n途中まで書き出したフォルダが残っています: ${outputPath}`;
      }
      log('error', message);
      if (keepFolder) {
        await writeErrorLog().catch(() => {});
        await output.close().catch(() => {});
      }
      setErrorMsg(message);
      setPhase('error');
    } finally {
      if (!completed) await discard?.().catch(() => {});
      // Back to the form only after the partial output is gone; the next run opens a new one.
      if (signal.aborted) {
        log('warn', 'キャンセルしました（書きかけの出力は削除しました）');
        setPhase('idle');
      }
    }
  }

  function cancel() {
    setCancelling(true);
    abortRef.current?.abort();
  }

  function nextUser() {
    setTarget(null);
    setUsername('');
    setSourceFiles({ notes: null, favorites: null, clips: null });
    setExportStates(new Map());
    setProgress(null);
    setPhase('idle');
  }

  const sourcesReady = !includeArchive
    || (['notes', 'favorites', 'clips'] as const).every(s => sources[s] !== 'file' || sourceFiles[s] != null);
  const canRun = target != null
    && (includeArchive || requestedExports.length > 0)
    && sourcesReady
    && invalidRules.length === 0;

  const exportList = STANDARD_EXPORTS.filter(d => exportStates.has(d.kind));

  const currentlyDark = themeOverridden ? !prefersDark() : prefersDark();

  function sectionSource(section: ArchiveSection, label: string, options: Source[], hints: Partial<Record<Source, string[]>>) {
    const source = sources[section];
    const file = sourceFiles[section];
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="w-20 shrink-0 text-xs text-gray-600 dark:text-gray-400">{label}</span>
          <div className="flex gap-1 flex-wrap">
            {options.map(o => (
              <button key={o} type="button" onClick={() => setSources(v => ({ ...v, [section]: o }))} className={modeButtonClass(source === o)}>
                {SOURCE_LABELS[o]}
              </button>
            ))}
          </div>
        </div>
        <div className="ml-22 space-y-1">
          {(hints[source] ?? []).map(h => <p key={h} className="text-xs text-gray-400">{h}</p>)}
          {source === 'file' && (
            <>
              <input
                type="file" accept=".json,application/json"
                onChange={e => setSourceFiles(v => ({ ...v, [section]: e.target.files?.[0] ?? null }))}
                className={fileInputClass}
              />
              {file && <p className="text-xs text-green-600">✓ {file.name}</p>}
            </>
          )}
        </div>
      </div>
    );
  }

  const exportHint = 'このあと依頼する標準エクスポートの結果を使います';
  const fileHint = '標準エクスポートの JSON ファイルを選びます';
  const foreignHint = '外部サーバーの画像は取得できない場合があります';

  return (
    // The log panel sits to the right on wide windows and below the form on narrow ones.
    <div className="min-h-dvh lg:h-dvh bg-gray-50 dark:bg-gray-950 p-4 flex flex-col lg:flex-row gap-4">
      <div className="w-full max-w-lg mx-auto lg:mx-0 lg:shrink-0 lg:overflow-y-auto">
        <div className="relative text-center mb-6">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Misskey Archive Admin</h1>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            閉鎖したサーバーのユーザーの代わりに、アーカイブと標準エクスポートを作成します
          </p>
          <button
            onClick={() => setThemeOverridden(v => !v)}
            title={`テーマ: ${themeOverridden ? 'OS設定に戻す' : (currentlyDark ? 'ライトモードに切り替え' : 'ダークモードに切り替え')}`}
            className="absolute top-0 right-0 w-8 h-8 flex items-center justify-center rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-sm hover:scale-110 transition-transform"
          >
            {currentlyDark ? '🌙' : '☀️'}
          </button>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-800 p-6">
          {phase === 'idle' && (
            <div className="space-y-6">
              <form onSubmit={lookUp} className="space-y-4">
                <div className="space-y-3">
                  <p className={sectionTitleClass}>接続先</p>
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={conn.useSsh} onChange={e => updateConn({ useSsh: e.target.checked })} className="accent-violet-600" />
                      <span className="text-xs text-gray-700 dark:text-gray-300">SSH のポート転送を使う</span>
                    </label>
                    {conn.useSsh && (
                      <>
                        <div className="grid grid-cols-3 gap-2">
                          <div className="col-span-2">
                            <label className={labelClass}>SSH の接続先</label>
                            <input className={inputClass} value={conn.sshDestination} onChange={e => updateConn({ sshDestination: e.target.value })} placeholder="user@server" />
                          </div>
                          <div>
                            <label className={labelClass}>SSH のポート</label>
                            <input className={inputClass} value={conn.sshPort} onChange={e => updateConn({ sshPort: e.target.value })} inputMode="numeric" />
                          </div>
                        </div>
                        <p className="text-xs text-gray-400">
                          PC の ssh コマンドで接続します（鍵・ssh-agent・~/.ssh/config・Tailscale SSH はそのまま使えます。パスワードの入力や確認の質問には答えられません）。
                          下の Misskey の URL と PostgreSQL のホストには、サーバーから見た場所（例: http://127.0.0.1:3000、127.0.0.1）を入れます
                        </p>
                      </>
                    )}
                  </div>
                  <div>
                    <label className={labelClass}>Misskey の URL</label>
                    <input className={inputClass} value={conn.misskeyUrl} onChange={e => updateConn({ misskeyUrl: e.target.value })} placeholder="http://127.0.0.1:3000" />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2">
                      <label className={labelClass}>PostgreSQL のホスト</label>
                      <input className={inputClass} value={conn.dbHost} onChange={e => updateConn({ dbHost: e.target.value })} />
                    </div>
                    <div>
                      <label className={labelClass}>ポート</label>
                      <input className={inputClass} value={conn.dbPort} onChange={e => updateConn({ dbPort: e.target.value })} inputMode="numeric" />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className={labelClass}>データベース</label>
                      <input className={inputClass} value={conn.dbName} onChange={e => updateConn({ dbName: e.target.value })} />
                    </div>
                    <div>
                      <label className={labelClass}>ユーザー</label>
                      <input className={inputClass} value={conn.dbUser} onChange={e => updateConn({ dbUser: e.target.value })} />
                    </div>
                    <div>
                      <label className={labelClass}>パスワード</label>
                      <input className={inputClass} type="password" value={password} onChange={e => { setPassword(e.target.value); setTarget(null); }} />
                    </div>
                  </div>
                  <div>
                    <label className={labelClass}>URL の置き換え（任意）</label>
                    <textarea
                      className={`${inputClass} font-mono text-xs`}
                      rows={2}
                      value={conn.rewriteRules}
                      onChange={e => updateConn({ rewriteRules: e.target.value })}
                      placeholder="https://example.com/media/ https://s3.wasabisys.com/bucket/"
                    />
                    <p className="mt-1 text-xs text-gray-400">
                      1 行に「置き換え前 置き換え後」。ファイルの URL の先頭が一致したら置き換えて取得します
                    </p>
                    {invalidRules.length > 0 && (
                      <p className="mt-1 text-xs text-red-500 break-all">読み取れない行: {invalidRules.join(' / ')}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={conn.useBypassToken} onChange={e => updateConn({ useBypassToken: e.target.checked })} className="accent-violet-600" />
                      <span className="text-xs text-gray-700 dark:text-gray-300">{BYPASS_HEADER} ヘッダを付ける</span>
                    </label>
                    {conn.useBypassToken && (
                      <>
                        <input
                          className={inputClass}
                          type="password"
                          autoComplete="off"
                          value={conn.bypassToken}
                          onChange={e => updateConn({ bypassToken: e.target.value })}
                          placeholder="トークン"
                        />
                        {bypassTokenInvalid && (
                          <p className="text-xs text-red-500">トークンを入れてください（空白や全角文字は使えません）</p>
                        )}
                        <label className={labelClass}>ヘッダを付けるドメイン（1 行に 1 つ）</label>
                        <textarea
                          className={`${inputClass} font-mono text-xs`}
                          rows={3}
                          value={conn.bypassHosts}
                          onChange={e => updateConn({ bypassHosts: e.target.value })}
                          placeholder={'example.com\nexample.net'}
                        />
                        <p className="text-xs text-gray-400">
                          閉鎖したサーバーのドメインで 410 を返す Cloudflare Workers を通すためのヘッダです。
                          ここに書いたドメインとそのサブドメインへの HTTP 通信（Misskey の API と、ファイル・絵文字・標準エクスポートの取得）にだけ付けます。
                          SSH と PostgreSQL の通信には付きません
                        </p>
                        {conn.useBypassToken && bypassHosts.hosts.length === 0 && bypassHosts.invalid.length === 0 && (
                          <p className="text-xs text-red-500">ドメインを 1 つ以上入れてください</p>
                        )}
                        {bypassHosts.invalid.length > 0 && (
                          <p className="text-xs text-red-500 break-all">ドメインとして読み取れない行: {bypassHosts.invalid.join(' / ')}</p>
                        )}
                      </>
                    )}
                  </div>
                </div>

                <div className="border-t border-gray-100 dark:border-gray-800 pt-4 space-y-2">
                  <p className={sectionTitleClass}>対象のユーザー</p>
                  <div className="flex gap-2">
                    <div className="flex flex-1 min-w-0 items-center rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 focus-within:ring-2 focus-within:ring-violet-500 focus-within:border-transparent">
                      <span className="pl-3 text-sm text-gray-400 select-none">@</span>
                      <input
                        className="flex-1 min-w-0 pl-0.5 pr-3 py-2 bg-transparent text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none text-sm"
                        value={username}
                        onChange={e => { setUsername(e.target.value.replace(/^@+/, '')); setTarget(null); }}
                        placeholder="hogehoge"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={lookingUp || !username.trim() || (conn.useSsh && !conn.sshDestination.trim()) || bypassTokenInvalid || bypassHostsInvalid}
                      className="shrink-0 px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium rounded-lg text-sm transition-colors"
                    >
                      {lookingUp ? '確認中...' : '確認'}
                    </button>
                  </div>
                  {lookupError && <p className="text-xs text-red-500 whitespace-pre-wrap break-all">{lookupError}</p>}
                  {target && (
                    <div className="flex items-center gap-3 rounded-lg bg-gray-50 dark:bg-gray-800 p-3">
                      <div className="min-w-0">
                        <p className="font-medium text-gray-900 dark:text-white text-sm truncate">{target.user.name || target.user.username}</p>
                        <p className="text-xs text-gray-500">@{target.user.username}@{target.host}</p>
                      </div>
                    </div>
                  )}
                </div>
              </form>

              {target && (
                <div className="space-y-5">
                  <div className="border-t border-gray-100 dark:border-gray-800 pt-4 space-y-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={includeArchive} onChange={e => setIncludeArchive(e.target.checked)} className="accent-violet-600" />
                      <span className={sectionTitleClass}>アーカイブ（ビューア付き）</span>
                    </label>
                    {includeArchive && (
                      <div className="space-y-3">
                        {sectionSource('notes', 'ノート', ['api', 'export', 'file'], {
                          api: ['✓ ノートに付いたリアクションも取得できます'],
                          export: [exportHint, '⚠️ ノートに付いたリアクションは取得できません'],
                          file: [fileHint, '⚠️ ノートに付いたリアクションは取得できません'],
                        })}
                        {sectionSource('favorites', 'お気に入り', ['api', 'export', 'file', 'none'], {
                          api: [foreignHint],
                          export: [exportHint, foreignHint],
                          file: [fileHint, foreignHint],
                        })}
                        {sectionSource('clips', 'クリップ', ['api', 'export', 'file', 'none'], {
                          api: [foreignHint],
                          export: [exportHint, foreignHint],
                          file: [fileHint, foreignHint],
                        })}
                      </div>
                    )}
                  </div>

                  <div className="border-t border-gray-100 dark:border-gray-800 pt-4 space-y-2">
                    <p className={sectionTitleClass}>標準エクスポート（出力の exports/ に入れます）</p>
                    <div className="grid grid-cols-2 gap-1">
                      {STANDARD_EXPORTS.map(d => {
                        const required = requiredExports.includes(d.kind);
                        return (
                          <label key={d.kind} className={`flex items-center gap-2 ${required ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                            <input
                              type="checkbox"
                              checked={required || selectedExports.includes(d.kind)}
                              disabled={required}
                              onChange={e => toggleExport(d.kind, e.target.checked)}
                              className="accent-violet-600"
                            />
                            <span className="text-xs text-gray-700 dark:text-gray-300">
                              {d.label}{required && <span className="text-gray-400">（アーカイブに使用）</span>}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    <p className="text-xs text-gray-400">
                      結果は対象のユーザーのドライブにも残ります。ノート・お気に入り・クリップは 24 時間に 1 回しか依頼できず、直前の結果があればそれを使います
                    </p>
                  </div>

                  <div className="border-t border-gray-100 dark:border-gray-800 pt-4 space-y-2">
                    <p className={sectionTitleClass}>保存形式</p>
                    <div className="flex gap-1">
                      {([['zip', 'ZIPファイル'], ['folder', 'フォルダ（圧縮しない）']] as [OutputMode, string][]).map(([m, label]) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => {
                            setOutputMode(m);
                            localStorage.setItem('admin_output_mode', m);
                          }}
                          className={modeButtonClass(outputMode === m)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-gray-400">
                      {outputMode === 'zip'
                        ? '1つのZIPファイルに保存します。解凍してから index.html を開きます'
                        : '選んだフォルダの中にそのまま書き出します。解凍不要で、フォルダ内の index.html をすぐ開けます'}
                    </p>
                  </div>

                  <div className="border-t border-gray-100 dark:border-gray-800 pt-4 space-y-2">
                    <p className={sectionTitleClass}>オプション</p>
                    {includeArchive && sources.notes === 'api' && (
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={useNoteCache}
                          onChange={e => {
                            setUseNoteCache(e.target.checked);
                            localStorage.setItem('admin_use_note_cache', e.target.checked ? '1' : '0');
                          }}
                          className="mt-0.5 accent-violet-600"
                        />
                        <div>
                          <span className="text-xs text-gray-700 dark:text-gray-300">取得済みのノートキャッシュを利用する</span>
                          <p className="text-xs text-gray-400 mt-0.5">オフにすると全件APIで再取得します。キャッシュ後に付いたリアクションを反映したい場合はオフにしてください。</p>
                        </div>
                      </label>
                    )}
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={useFileCache}
                        onChange={e => {
                          setUseFileCache(e.target.checked);
                          localStorage.setItem('admin_use_file_cache', e.target.checked ? '1' : '0');
                        }}
                        className="mt-0.5 accent-violet-600"
                      />
                      <div>
                        <span className="text-xs text-gray-700 dark:text-gray-300">ドライブファイルをキャッシュする（2回目以降高速化）</span>
                        <p className="text-xs text-gray-400 mt-0.5">ダウンロードしたファイルをIndexedDBに保存し、再エクスポート時に再利用します。</p>
                      </div>
                    </label>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={useEmojiCache}
                        onChange={e => {
                          setUseEmojiCache(e.target.checked);
                          localStorage.setItem('admin_use_emoji_cache', e.target.checked ? '1' : '0');
                        }}
                        className="mt-0.5 accent-violet-600"
                      />
                      <div>
                        <span className="text-xs text-gray-700 dark:text-gray-300">絵文字をキャッシュする</span>
                        <p className="text-xs text-gray-400 mt-0.5">取得した絵文字をURLごとにIndexedDBに保存し、URLが同じ絵文字は取得し直さずに使います（同じサーバーなら別のユーザーの作成でも再利用。サーバーが違えばURLも違うので取得します）。</p>
                      </div>
                    </label>
                    {(useFileCache || useEmojiCache) && (
                      <button
                        type="button"
                        onClick={async () => {
                          if (confirm('キャッシュされたファイル（ドライブファイルと絵文字）をすべて削除しますか？')) {
                            await clearFileCache();
                            log('info', 'ドライブファイルと絵文字のキャッシュを削除しました');
                          }
                        }}
                        className="ml-5 text-xs text-gray-400 hover:text-red-500 transition-colors"
                      >
                        キャッシュを削除（ドライブファイル・絵文字）
                      </button>
                    )}
                  </div>

                  <button
                    onClick={run}
                    disabled={!canRun}
                    className="w-full py-2.5 bg-violet-600 hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium rounded-lg text-sm transition-colors"
                  >
                    作成する
                  </button>
                </div>
              )}

              <div className="text-center">
                <a
                  href={LATEST_VIEWER_URL}
                  onClick={openLinkInBrowser}
                  className="text-xs text-gray-400 hover:text-violet-500 transition-colors"
                >
                  最新ビューア（index.html）のみダウンロード
                </a>
                <p className="text-xs text-gray-400 mt-1">ZIP の中の index.html を作成済みアーカイブの index.html と差し替えると、デザインだけ更新できます</p>
              </div>
            </div>
          )}

          {phase === 'running' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-5 h-5 border-2 border-violet-600 border-t-transparent rounded-full animate-spin shrink-0" />
                <span className="text-sm text-gray-700 dark:text-gray-300">{progress?.message ?? '準備中...'}</span>
              </div>
              {progress && (
                <div className="space-y-1.5 text-xs text-gray-500 dark:text-gray-400">
                  {progress.noteCount != null && (
                    <div className="flex justify-between">
                      <span>ノート</span>
                      <span className="font-mono">
                        {progress.noteCount.toLocaleString()}
                        {cachedNoteCount > 0 && (
                          <span className="text-gray-400 ml-1">(キャッシュ {cachedNoteCount.toLocaleString()} + 新規 {newNoteCount.toLocaleString()})</span>
                        )}
                      </span>
                    </div>
                  )}
                  {progress.totalFiles != null && progress.totalFiles > 0 && (
                    <>
                      <div className="flex justify-between">
                        <span>ファイル</span>
                        <span className="font-mono">{(progress.fileCount ?? 0).toLocaleString()} / {progress.totalFiles.toLocaleString()}</span>
                      </div>
                      <div className="w-full bg-gray-100 dark:bg-gray-800 rounded-full h-1.5">
                        <div
                          className="bg-violet-500 h-1.5 rounded-full transition-all"
                          style={{ width: `${Math.round(((progress.fileCount ?? 0) / progress.totalFiles) * 100)}%` }}
                        />
                      </div>
                    </>
                  )}
                  {progress.currentFile && <p className="truncate text-gray-400">{progress.currentFile}</p>}
                  {(progress.failCount ?? 0) > 0 && <p className="text-yellow-500">{progress.failCount} 件のダウンロードに失敗</p>}
                </div>
              )}
              {exportList.length > 0 && (
                <ExportStateList items={exportList.map(d => [d.label, exportStates.get(d.kind)!])} />
              )}
              <button
                onClick={cancel}
                disabled={cancelling}
                className="mt-2 w-full py-2 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 disabled:cursor-not-allowed"
              >
                {cancelling ? 'キャンセルしています...' : 'キャンセル'}
              </button>
            </div>
          )}

          {phase === 'done' && (
            <div className="space-y-4">
              <div className="text-center">
                <div className="text-4xl mb-2">✅</div>
                <p className="font-medium text-gray-900 dark:text-white">作成が完了しました</p>
              </div>
              {savedPath && (
                <p className="text-xs text-gray-500 dark:text-gray-400 text-center break-all">保存先: {savedPath}</p>
              )}
              {archiveFailCount > 0 && (
                <p className="text-xs text-yellow-500 text-center">{archiveFailCount} 件のファイルを取得できませんでした（error.log を参照）</p>
              )}
              {exportList.length > 0 && (
                <ExportStateList items={exportList.map(d => [d.label, exportStates.get(d.kind)!])} />
              )}
              {includeArchive && (
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-xs text-gray-500 space-y-1">
                  <p className="font-medium text-gray-700 dark:text-gray-300">使い方</p>
                  <p>1. {savedAs === 'folder' ? '保存したフォルダを開く' : 'ZIPを解凍する'}</p>
                  <p>2. <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">index.html</code> をブラウザで開く</p>
                  <p>3. ノートを閲覧・検索できます</p>
                </div>
              )}
              <button onClick={nextUser} className="w-full py-2.5 bg-violet-600 hover:bg-violet-700 text-white font-medium rounded-lg text-sm transition-colors">
                別のユーザーを処理する
              </button>
            </div>
          )}

          {phase === 'error' && (
            <div className="space-y-4">
              <div className="text-center">
                <div className="text-4xl mb-2">❌</div>
                <p className="text-red-500 text-sm whitespace-pre-wrap break-all">{errorMsg}</p>
              </div>
              {exportList.length > 0 && (
                <ExportStateList items={exportList.map(d => [d.label, exportStates.get(d.kind)!])} />
              )}
              <button onClick={() => setPhase('idle')} className="w-full py-2.5 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg text-sm hover:bg-gray-300 dark:hover:bg-gray-600">
                戻る
              </button>
            </div>
          )}
        </div>
        <p className="mt-2 text-center text-[10px] text-gray-400 dark:text-gray-500 select-none">
          {VERSION}
        </p>
      </div>
      <LogPanel entries={logs} onClear={clearLogs} className="h-96 lg:h-auto lg:flex-1 min-w-0" />
    </div>
  );
}

function ExportStateList({ items }: { items: [string, StandardExportState][] }) {
  return (
    <div className="rounded-lg bg-gray-50 dark:bg-gray-800 p-3 space-y-1">
      <p className="text-xs font-medium text-gray-700 dark:text-gray-300">標準エクスポート</p>
      {items.map(([label, state]) => (
        <div key={label} className="flex gap-2 text-xs">
          <span className="w-20 shrink-0 text-gray-500 dark:text-gray-400">{label}</span>
          <span className={`break-all ${state.status === 'failed' ? 'text-red-500' : 'text-gray-600 dark:text-gray-300'}`}>
            {exportStateLabel(state)}
          </span>
        </div>
      ))}
    </div>
  );
}
