import { useEffect, useRef, useState } from 'react';
import { MisskeyClient } from '../lib/misskey-api';
import { buildArchive, parseNotesExport, zipSink, folderSink, type ArchiveSink, type SectionMode, type ExportOptions, type ExportProgress, type UploadData } from '../lib/exporter';
import type { MisskeyNote, MisskeyUser, FavoriteExportItem, ClipExport } from '../types/misskey';
import { saveAccount, removeAccount } from '../lib/miauth';
import { getCachedNotes, getLatestNoteId, saveNotes, clearFileCache } from '../lib/archive-db';
import { isTauri, openSaveTarget, openFolderTarget } from '../lib/tauri-bridge';
import { LATEST_VIEWER_URL, openLinkInBrowser } from '../lib/links';
import { formatLog } from '../lib/log';
import { useLog } from '../lib/use-log';
import { LogPanel } from '../components/LogPanel';

type Props = { token: string; instanceUrl: string; onGoHome: () => void };
type Phase = 'idle' | 'running' | 'done' | 'error';

async function readJsonFile<T>(file: File): Promise<T> {
  const text = await file.text();
  return JSON.parse(text) as T;
}

type NotesSectionMode = 'api' | 'upload';
// Desktop only: a single ZIP file, or plain files written into a folder.
type OutputMode = 'zip' | 'folder';

const modeButtonClass = (active: boolean) =>
  `px-3 py-1 text-xs rounded-md border transition-colors ${
    active
      ? 'bg-violet-600 text-white border-violet-600'
      : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-300 dark:border-gray-600 hover:border-violet-400'
  }`;

function SectionModeSelect({
  label,
  value,
  onChange,
  hasNone,
  uploadLabel,
}: {
  label: string;
  value: SectionMode;
  onChange: (v: SectionMode) => void;
  hasNone: boolean;
  uploadLabel?: string;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-gray-600 dark:text-gray-400 w-20 shrink-0">{label}</span>
      <div className="flex gap-1">
        {(['api', 'upload', ...(hasNone ? ['none'] : [])] as SectionMode[]).map(m => (
          <button
            key={m}
            onClick={() => onChange(m)}
            className={`px-3 py-1 text-xs rounded-md border transition-colors ${
              value === m
                ? 'bg-violet-600 text-white border-violet-600'
                : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-300 dark:border-gray-600 hover:border-violet-400'
            }`}
          >
            {m === 'api' ? 'API' : m === 'upload' ? (uploadLabel ?? 'JSONアップロード') : 'なし'}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ExportPage({ token, instanceUrl, onGoHome }: Props) {
  const [user, setUser] = useState<MisskeyUser | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [cachedNoteCount, setCachedNoteCount] = useState(0);
  const [newNoteCount, setNewNoteCount] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [savedPath, setSavedPath] = useState('');
  const [savedAs, setSavedAs] = useState<OutputMode>('zip');
  const [outputMode, setOutputMode] = useState<OutputMode>(() => localStorage.getItem('output_mode') === 'folder' ? 'folder' : 'zip');
  const [zipBaseName, setZipBaseName] = useState('');

  const [notesMode, setNotesMode] = useState<NotesSectionMode>('api');
  const [favoritesMode, setFavoritesMode] = useState<SectionMode>('none');
  const [clipsMode, setClipsMode] = useState<SectionMode>('none');
  const [useFileCache, setUseFileCache] = useState(() => localStorage.getItem('use_file_cache') === '1');
  const [useEmojiCache, setUseEmojiCache] = useState(() => localStorage.getItem('use_emoji_cache') !== '0');
  const [useNoteCache, setUseNoteCache] = useState(() => localStorage.getItem('use_note_cache') !== '0');

  const [notesFile, setNotesFile] = useState<File | null>(null);
  const [favoritesFile, setFavoritesFile] = useState<File | null>(null);
  const [clipsFile, setClipsFile] = useState<File | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { entries: logs, entriesRef: logEntriesRef, log, clear: clearLogs } = useLog();

  const client = new MisskeyClient(instanceUrl, token);

  useEffect(() => {
    client.getMe().then((u) => {
      setUser(u);
      saveAccount(instanceUrl, {
        token, userId: u.id, username: u.username, name: u.name, avatarUrl: u.avatarUrl,
      });
    }).catch(() => {});
  }, []);

  const canStart =
    (notesMode === 'api' || notesFile != null) &&
    (favoritesMode !== 'upload' || favoritesFile != null) &&
    (clipsMode !== 'upload' || clipsFile != null);

  async function startExport() {
    if (!user) return;
    const s = new Date().toLocaleString('sv', { timeZone: 'Asia/Tokyo' }).replace(/[-: ]/g, '');
    const baseName = `misskey-archive-${instanceUrl}-${s.slice(0, 8)}-${s.slice(8, 14)}`;

    // On desktop the archive is written straight to disk, so the destination is chosen first.
    let output: ArchiveSink;
    let outputPath = '';
    let discard: (() => Promise<void>) | undefined;
    if (isTauri()) {
      try {
        if (outputMode === 'folder') {
          const target = await openFolderTarget(baseName);
          if (!target) return;
          output = folderSink(target);
          outputPath = target.path;
          discard = target.abort;
        } else {
          const target = await openSaveTarget(`${baseName}.zip`);
          if (!target) return;
          output = zipSink(baseName, target.writable);
          outputPath = target.path;
          discard = target.abort;
        }
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setPhase('error');
        return;
      }
    } else {
      output = zipSink(baseName);
    }

    // buildArchive writes error.log only when it finishes. When a folder is kept after a failure,
    // the errors of this export up to the failure are written there instead.
    const logStart = logEntriesRef.current.length;
    const writeErrorLog = () => output.add(
      'error.log',
      formatLog(logEntriesRef.current.slice(logStart).filter(e => e.level === 'error')),
    );

    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('running');

    let lastMessage = '';
    const showProgress = (p: ExportProgress) => {
      setProgress(p);
      if (p.message === lastMessage) return;
      lastMessage = p.message;
      log('info', p.message);
    };
    log('info', `作成開始: @${user.username}@${instanceUrl}（ノート: ${notesMode === 'api' ? 'API' : 'JSONアップロード'}、お気に入り: ${favoritesMode}、クリップ: ${clipsMode}）`);
    if (outputPath) log('info', `保存先: ${outputPath}`);

    let completed = false;
    try {
      setZipBaseName(baseName);

      const options: ExportOptions = { notesMode, favoritesMode, clipsMode };
      let apiNotes: MisskeyNote[] | undefined;
      let uploadData: UploadData | undefined;

      if (notesMode === 'api') {
        if (useNoteCache) {
          showProgress({ phase: 'notes-api', message: 'キャッシュを読み込み中...' });
          const cached = await getCachedNotes(instanceUrl, user.id);
          setCachedNoteCount(cached.length);
          const latestId = await getLatestNoteId(instanceUrl, user.id);

          const fresh: MisskeyNote[] = [];
          for await (const batch of client.fetchAllNotes(user.id, (n) => {
            setNewNoteCount(n);
            showProgress({ phase: 'notes-api', message: 'APIでノートを取得中...', noteCount: cached.length + n, newNoteCount: n, cachedNoteCount: cached.length });
          }, latestId ?? undefined)) {
            if (controller.signal.aborted) return;
            fresh.push(...batch);
          }
          if (fresh.length > 0) await saveNotes(instanceUrl, user.id, fresh);
          setNewNoteCount(fresh.length);
          apiNotes = [...fresh, ...cached].sort((a, b) => b.id > a.id ? 1 : -1);
        } else {
          const fresh: MisskeyNote[] = [];
          for await (const batch of client.fetchAllNotes(user.id, (n) => {
            setNewNoteCount(n);
            showProgress({ phase: 'notes-api', message: 'APIでノートを取得中（キャッシュなし）...', noteCount: n, newNoteCount: n, cachedNoteCount: 0 });
          })) {
            if (controller.signal.aborted) return;
            fresh.push(...batch);
          }
          await saveNotes(instanceUrl, user.id, fresh);
          setNewNoteCount(fresh.length);
          apiNotes = fresh.sort((a, b) => b.id > a.id ? 1 : -1);
        }
      } else {
        if (!notesFile) throw new Error('ノートのJSONファイルを選択してください');
        showProgress({ phase: 'files', message: 'JSONファイルを読み込み中...' });
        const rawNotes = await readJsonFile<unknown[]>(notesFile);
        uploadData = { exportedNotes: parseNotesExport(rawNotes) };
      }

      if (favoritesMode === 'upload' && favoritesFile) {
        const favItems = await readJsonFile<FavoriteExportItem[]>(favoritesFile);
        uploadData = { ...(uploadData ?? { exportedNotes: [] }), favItems };
      }
      if (clipsMode === 'upload' && clipsFile) {
        const clipExports = await readJsonFile<ClipExport[]>(clipsFile);
        uploadData = { ...(uploadData ?? { exportedNotes: [] }), clipExports };
      }

      const blob = await buildArchive(
        instanceUrl, user, options, client,
        (p) => showProgress(p),
        controller.signal,
        output,
        apiNotes,
        uploadData,
        useFileCache,
        undefined,
        log,
        useEmojiCache,
      );
      if (controller.signal.aborted) return;
      completed = true;
      log('info', outputPath ? `完了: ${outputPath}` : '完了');

      setSavedAs(outputMode);
      if (outputPath) {
        setSavedPath(outputPath);
      } else if (blob) {
        setDownloadUrl(URL.createObjectURL(blob));
      }
      setPhase('done');
    } catch (e) {
      if ((e as Error).message === 'aborted') return;
      let message = e instanceof Error ? e.message : '不明なエラーが発生しました';
      // A partially written folder is still usable, unlike a truncated ZIP.
      const keepFolder = outputMode === 'folder' && outputPath !== '';
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
    }
  }

  function handleReset() {
    abortRef.current?.abort();
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    onGoHome();
  }

  function handleRemoveAccount() {
    if (user) removeAccount(instanceUrl, user.id);
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    onGoHome();
  }

  const phaseLabel = progress ? progress.message : '';

  return (
    // The log panel sits to the right on wide windows and below the form on narrow ones.
    // The bottom padding keeps it clear of the theme button and version label fixed at the bottom (App.tsx).
    <div className="min-h-dvh lg:h-dvh bg-gray-50 dark:bg-gray-950 p-4 pb-16 flex flex-col lg:flex-row gap-4">
      <div className="w-full max-w-md mx-auto lg:mx-0 lg:shrink-0 lg:overflow-y-auto lg:flex lg:flex-col">
        <div className="lg:my-auto bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-800 p-6">

          {user && (
            <div className="flex items-center gap-3 mb-6 pb-6 border-b border-gray-100 dark:border-gray-800">
              {user.avatarUrl && <img src={user.avatarUrl} className="w-10 h-10 rounded-full object-cover" alt="" />}
              <div>
                <p className="font-medium text-gray-900 dark:text-white text-sm">{user.name || user.username}</p>
                <p className="text-xs text-gray-500">@{user.username}@{instanceUrl}</p>
              </div>
            </div>
          )}

          {phase === 'idle' && (
            <div className="space-y-5">
              <div className="space-y-3">
                <p className="text-xs font-medium text-gray-700 dark:text-gray-300">取得方法</p>

                {/* Notes */}
                <div className="space-y-2">
                  <SectionModeSelect
                    label="ノート"
                    value={notesMode}
                    onChange={v => setNotesMode(v as NotesSectionMode)}
                    hasNone={false}
                  />
                  {notesMode === 'api' && (
                    <div className="ml-22 space-y-0.5">
                      <p className="text-xs text-green-600 dark:text-green-400">✓ ノートに付いたリアクションも取得できます</p>
                      <p className="text-xs text-amber-500">⚠️ APIレート制限に引っかかる場合があります</p>
                    </div>
                  )}
                  {notesMode === 'upload' && (
                    <div className="ml-22 space-y-1">
                      <p className="text-xs text-gray-400">設定 → データのエクスポート で入手できます</p>
                      <p className="text-xs text-amber-500">⚠️ ノートに付いたリアクションは取得できません</p>
                      <input
                        type="file" accept=".json,application/json"
                        onChange={e => setNotesFile(e.target.files?.[0] ?? null)}
                        className="block w-full text-xs text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-violet-50 file:text-violet-700 hover:file:bg-violet-100 dark:file:bg-violet-900/30 dark:file:text-violet-300"
                      />
                      {notesFile && <p className="text-xs text-green-600">✓ {notesFile.name}</p>}
                    </div>
                  )}
                </div>

                {/* Favorites */}
                <div className="space-y-2">
                  <SectionModeSelect
                    label="お気に入り"
                    value={favoritesMode}
                    onChange={setFavoritesMode}
                    hasNone={true}
                  />
                  {favoritesMode !== 'none' && (
                    <p className="text-xs text-gray-400 ml-22">外部サーバーの画像は取得できない場合があります</p>
                  )}
                  {favoritesMode === 'upload' && (
                    <div className="ml-22 space-y-1">
                      <input
                        type="file" accept=".json,application/json"
                        onChange={e => setFavoritesFile(e.target.files?.[0] ?? null)}
                        className="block w-full text-xs text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-violet-50 file:text-violet-700 hover:file:bg-violet-100 dark:file:bg-violet-900/30 dark:file:text-violet-300"
                      />
                      {favoritesFile && <p className="text-xs text-green-600">✓ {favoritesFile.name}</p>}
                    </div>
                  )}
                </div>

                {/* Clips */}
                <div className="space-y-2">
                  <SectionModeSelect
                    label="クリップ"
                    value={clipsMode}
                    onChange={setClipsMode}
                    hasNone={true}
                  />
                  {clipsMode !== 'none' && (
                    <p className="text-xs text-gray-400 ml-22">外部サーバーの画像は取得できない場合があります</p>
                  )}
                  {clipsMode === 'upload' && (
                    <div className="ml-22 space-y-1">
                      <input
                        type="file" accept=".json,application/json"
                        onChange={e => setClipsFile(e.target.files?.[0] ?? null)}
                        className="block w-full text-xs text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-violet-50 file:text-violet-700 hover:file:bg-violet-100 dark:file:bg-violet-900/30 dark:file:text-violet-300"
                      />
                      {clipsFile && <p className="text-xs text-green-600">✓ {clipsFile.name}</p>}
                    </div>
                  )}
                </div>
              </div>

              {isTauri() && (
                <div className="border-t border-gray-100 dark:border-gray-800 pt-4 space-y-2">
                  <p className="text-xs font-medium text-gray-700 dark:text-gray-300">保存形式</p>
                  <div className="flex gap-1">
                    {([['zip', 'ZIPファイル'], ['folder', 'フォルダ（圧縮しない）']] as [OutputMode, string][]).map(([m, label]) => (
                      <button
                        key={m}
                        onClick={() => {
                          setOutputMode(m);
                          localStorage.setItem('output_mode', m);
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
              )}

              <div className="border-t border-gray-100 dark:border-gray-800 pt-4 space-y-2">
                <p className="text-xs font-medium text-gray-700 dark:text-gray-300">オプション</p>
                {notesMode === 'api' && (
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useNoteCache}
                      onChange={e => {
                        setUseNoteCache(e.target.checked);
                        localStorage.setItem('use_note_cache', e.target.checked ? '1' : '0');
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
                      localStorage.setItem('use_file_cache', e.target.checked ? '1' : '0');
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
                      localStorage.setItem('use_emoji_cache', e.target.checked ? '1' : '0');
                    }}
                    className="mt-0.5 accent-violet-600"
                  />
                  <div>
                    <span className="text-xs text-gray-700 dark:text-gray-300">絵文字をキャッシュする</span>
                    <p className="text-xs text-gray-400 mt-0.5">取得した絵文字をURLごとにIndexedDBに保存し、次のエクスポートからはURLが同じ絵文字を取得し直さずに使います。</p>
                  </div>
                </label>
                {(useFileCache || useEmojiCache) && (
                  <button
                    type="button"
                    onClick={async () => {
                      if (confirm('キャッシュされたファイル（ドライブファイルと絵文字）をすべて削除しますか？')) {
                        await clearFileCache();
                      }
                    }}
                    className="ml-5 text-xs text-gray-400 hover:text-red-500 transition-colors"
                  >
                    キャッシュを削除（ドライブファイル・絵文字）
                  </button>
                )}
              </div>

              <button
                onClick={startExport}
                disabled={!canStart}
                className="w-full py-2.5 bg-violet-600 hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium rounded-lg text-sm transition-colors"
              >
                アーカイブを作成する
              </button>

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
                <span className="text-sm text-gray-700 dark:text-gray-300">{phaseLabel}</span>
              </div>
              {progress && (
                <div className="space-y-1.5 text-xs text-gray-500 dark:text-gray-400">
                  {progress.noteCount != null && (
                    <div className="flex justify-between">
                      <span>ノート</span>
                      <span className="font-mono">
                        {progress.noteCount.toLocaleString()}
                        {notesMode === 'api' && cachedNoteCount > 0 && (
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
              <button onClick={handleReset} className="mt-2 w-full py-2 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                キャンセルして最初に戻る
              </button>
            </div>
          )}

          {phase === 'done' && (
            <div className="space-y-4">
              <div className="text-center">
                <div className="text-4xl mb-2">✅</div>
                <p className="font-medium text-gray-900 dark:text-white">アーカイブの作成が完了しました</p>
              </div>
              {!isTauri() && downloadUrl && (
                <a
                  href={downloadUrl}
                  download={`${zipBaseName}.zip`}
                  className="block w-full py-2.5 text-center bg-violet-600 hover:bg-violet-700 text-white font-medium rounded-lg text-sm transition-colors"
                >
                  ZIPをダウンロード
                </a>
              )}
              {savedPath && (
                <p className="text-xs text-gray-500 dark:text-gray-400 text-center break-all">保存先: {savedPath}</p>
              )}
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-xs text-gray-500 space-y-1">
                <p className="font-medium text-gray-700 dark:text-gray-300">使い方</p>
                <p>1. {savedAs === 'folder' ? '保存したフォルダを開く' : 'ZIPを解凍する'}</p>
                <p>2. <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">index.html</code> をブラウザで開く</p>
                <p>3. ノートを閲覧・検索できます</p>
              </div>
              <div className="space-y-1">
                <button onClick={handleReset} className="w-full py-2 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                  TOPに戻る
                </button>
                <button onClick={handleRemoveAccount} className="w-full py-2 text-xs text-gray-400 hover:text-red-500">
                  このアカウントのトークンを削除
                </button>
              </div>
            </div>
          )}

          {phase === 'error' && (
            <div className="space-y-4">
              <div className="text-center">
                <div className="text-4xl mb-2">❌</div>
                <p className="text-red-500 text-sm whitespace-pre-wrap break-all">{errorMsg}</p>
              </div>
              <button onClick={handleReset} className="w-full py-2.5 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg text-sm hover:bg-gray-300 dark:hover:bg-gray-600">
                最初からやり直す
              </button>
            </div>
          )}
        </div>
      </div>
      <LogPanel entries={logs} onClear={clearLogs} className="h-96 lg:h-auto lg:flex-1 min-w-0" />
    </div>
  );
}
