import { BlobReader, BlobWriter, ZipWriter, configure } from '@zip.js/zip.js';
import { fetchBlob, isTauri, type FolderTarget } from './tauri-bridge';
import { getCachedFile, cacheFile } from './archive-db';
import type {
  MisskeyNote, MisskeyUser, MisskeyDriveFile,
  ExportedNote, FavoriteExportItem, ClipExport,
  ArchiveNote, ArchiveFavoriteItem, ArchiveClip,
  ArchiveIndex, ArchiveNoteRef,
} from '../types/misskey';
import type { MisskeyClient } from './misskey-api';
import { viewerHtml, archiveDataJs, archiveDataPartJs, type ArchiveDataKind } from './viewer-template';
import { VERSION } from '../version';

configure({ useWebWorkers: false });

export type SectionMode = 'api' | 'upload' | 'none';

export type ExportOptions = {
  notesMode: 'api' | 'upload';
  favoritesMode: SectionMode;
  clipsMode: SectionMode;
};

// Data provided in upload mode
export type UploadData = {
  exportedNotes: ExportedNote[];
  favItems?: FavoriteExportItem[];
  clipExports?: ClipExport[];
};

export type ExportProgress = {
  phase: 'notes-api' | 'favorites-api' | 'clips-api' | 'files' | 'packaging';
  message: string;
  noteCount?: number;
  newNoteCount?: number;
  cachedNoteCount?: number;
  fileCount?: number;
  totalFiles?: number;
  failCount?: number;
  currentFile?: string;
};

/** Writes `data` to `<folder>/<name>` inside the archive. */
type AddFile = (name: string, data: Blob) => Promise<void>;

/** Maps a file URL to the URL it is actually downloaded from. The archive keeps the original URL. */
export type UrlRewriter = (url: string) => string;

/** Receives one line per downloaded file or emoji (success and failure) for the log panel. */
export type ArchiveLog = (level: 'info' | 'warn' | 'error', text: string) => void;

// ---- helpers ----

// Upper bound for any single string built during packaging. JS engines cap strings at roughly
// 2^29 characters, so large JSON is assembled from pieces of this size instead of one string.
const MAX_CHUNK_CHARS = 16 * 1024 * 1024;

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 200);
}

function guessExt(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm',
    'audio/mpeg': '.mp3', 'audio/ogg': '.ogg',
  };
  return map[mimeType] ?? '';
}

/** Assigns each file a unique `<folderPath>/<name>` path inside the archive. */
function assignLocalPaths(files: MisskeyDriveFile[], folderPath: string): Map<string, string> {
  const fileMap = new Map<string, string>();
  const usedNames = new Set<string>();
  for (const f of files) {
    const ext = f.name.includes('.') ? '' : guessExt(f.type);
    let safeName = sanitizeFilename(f.name) + ext;
    if (!safeName) safeName = f.id;
    if (usedNames.has(safeName)) safeName = f.id.slice(0, 8) + '_' + safeName;
    if (usedNames.has(safeName)) safeName = f.id + '_' + safeName;
    usedNames.add(safeName);
    fileMap.set(f.id, `${folderPath}/${safeName}`);
  }
  return fileMap;
}

// Misskey's UserLite fields. The `i` response also carries account settings (policies, achievements,
// muted words, pinned notes, ...) that would otherwise be repeated in every note.
const NOTE_USER_KEYS = [
  'id', 'username', 'name', 'host', 'avatarUrl', 'avatarBlurhash', 'avatarDecorations',
  'isBot', 'isCat', 'emojis', 'badgeRoles',
];

function toNoteUser(user: MisskeyUser): MisskeyUser {
  const src = user as unknown as Record<string, unknown>;
  return Object.fromEntries(NOTE_USER_KEYS.filter(k => k in src).map(k => [k, src[k]])) as unknown as MisskeyUser;
}

/** Same text as `JSON.stringify(items, null, 2)`, assembled as a Blob of bounded-size pieces. */
function jsonArrayBlob(items: unknown[]): Blob {
  if (items.length === 0) return new Blob(['[]']);
  const parts: Blob[] = [];
  let buf: string[] = [];
  let size = 0;
  items.forEach((item, i) => {
    const s = (i === 0 ? '[\n  ' : ',\n  ') + JSON.stringify(item, null, 2).replace(/\n/g, '\n  ');
    buf.push(s);
    size += s.length;
    if (size >= MAX_CHUNK_CHARS) {
      parts.push(new Blob(buf));
      buf = [];
      size = 0;
    }
  });
  buf.push('\n]');
  parts.push(new Blob(buf));
  return new Blob(parts);
}

/** Viewer data scripts for `items`, each holding at most about MAX_CHUNK_CHARS characters. */
function* viewerDataParts(kind: ArchiveDataKind, items: unknown[]): Generator<string> {
  let buf: string[] = [];
  let size = 0;
  for (const item of items) {
    const s = JSON.stringify(item);
    buf.push(s);
    size += s.length + 1;
    if (size >= MAX_CHUNK_CHARS) {
      yield archiveDataPartJs(kind, buf);
      buf = [];
      size = 0;
    }
  }
  if (buf.length > 0) yield archiveDataPartJs(kind, buf);
}

async function downloadFile(
  file: MisskeyDriveFile,
  useCache: boolean,
  rewriteUrl?: UrlRewriter,
): Promise<{ blob: Blob | null; error?: string; fromCache?: boolean }> {
  // Check cache first
  if (useCache) {
    const cached = await getCachedFile(file.url).catch(() => null);
    if (cached) return { blob: cached, fromCache: true };
  }

  const tried: string[] = [];

  async function attempt(url: string): Promise<Blob | null> {
    const target = rewriteUrl ? rewriteUrl(url) : url;
    const r = await fetchBlob(target);
    if (r.blob) return r.blob;
    tried.push(`${target} → ${r.error ?? 'unknown'}`);
    return null;
  }

  // 1. Primary URL as-is
  const b1 = await attempt(file.url);
  if (b1) {
    if (useCache) await cacheFile(file.url, b1).catch(() => {});
    return { blob: b1 };
  }

  // 2. thumbnailUrl as last resort (server-agnostic; at least preserve a thumbnail for images)
  if (file.thumbnailUrl && file.thumbnailUrl !== file.url) {
    const b2 = await attempt(file.thumbnailUrl);
    if (b2) {
      // Don't cache under primary URL since it's a fallback thumbnail
      return { blob: b2, error: `primary failed, used thumbnailUrl: ${tried.join(' / ')}` };
    }
  }

  return { blob: null, error: tried.join(' / ') };
}

/** The notes a file belongs to, for error.log: the place in this archive's viewer and the original URL. */
function noteRefsText(refs: ArchiveNoteRef[] | undefined): string {
  if (!refs?.length) return '\n  (ノートへの参照なし / ドライブのみのファイル)';
  return refs.map(r => `\n  添付ノート: index.html#note-${r.id}（元の URL: ${r.url}）`).join('');
}

/** Download a collection of files into an archive folder. Returns { fileMap, failCount, errors }. */
async function downloadFilesToFolder(
  files: MisskeyDriveFile[],
  addFile: AddFile,
  folderPath: string,
  signal: AbortSignal,
  onProgress: (done: number, total: number, name: string, fails: number) => void,
  fileToNotes?: Map<string, ArchiveNoteRef[]>,
  useCache = false,
  rewriteUrl?: UrlRewriter,
  onLog?: ArchiveLog,
): Promise<{ fileMap: Map<string, string>; failCount: number; errors: string[] }> {
  const fileMap = assignLocalPaths(files, folderPath);

  const notesSuffix = (fileId: string) => noteRefsText(fileToNotes?.get(fileId));

  let done = 0, failCount = 0;
  const errors: string[] = [];
  const warn = (entry: string) => { errors.push(entry); onLog?.('warn', entry); };
  const fail = (entry: string) => { errors.push(entry); onLog?.('error', entry); };
  for (const f of files) {
    if (signal.aborted) break;
    const localName = fileMap.get(f.id)!.replace(`${folderPath}/`, '');
    onProgress(done, files.length, f.name, failCount);
    if (f.url || f.thumbnailUrl) {
      const target = f.url ? f : { ...f, url: f.thumbnailUrl! };
      const { blob, error, fromCache } = await downloadFile(target, useCache, rewriteUrl);
      if (blob) {
        await addFile(localName, blob);
        const urlLabel = f.url || f.thumbnailUrl!;
        onLog?.('info', `OK [${folderPath}]${fromCache ? ' [cache]' : ''} ${localName} ← ${urlLabel}`);
        if (!f.url) warn(`WARN [${folderPath}] url=null, used thumbnailUrl: ${f.thumbnailUrl}${notesSuffix(f.id)}`);
        else if (error) warn(`WARN [${folderPath}]${fromCache ? ' [cache]' : ''} ${urlLabel}\n  → ${error}${notesSuffix(f.id)}`);
      } else {
        fileMap.set(f.id, f.url || f.thumbnailUrl || '');
        failCount++;
        fail(`FAIL [${folderPath}] ${f.url || f.thumbnailUrl || '(no url)'}\n  → ${error ?? 'unknown error'}${notesSuffix(f.id)}`);
      }
    } else {
      fileMap.set(f.id, '');
      fail(`FAIL [${folderPath}] (no url, no thumbnailUrl) fileId=${f.id} name=${f.name}${notesSuffix(f.id)}`);
      failCount++;
    }
    done++;
  }
  return { fileMap, failCount, errors };
}

type EmojiSource = Pick<MisskeyNote, 'text' | 'cw' | 'reactions'> & { reply?: EmojiSource; renote?: EmojiSource };

// Same pattern as renderEmoji() in the viewer
const EMOJI_PATTERN = /:([a-zA-Z0-9_@.-]+):/g;

/** Names of the server's own custom emojis used in the text, CW or reactions of `notes` (including replies and renotes). */
function usedLocalEmojis(notes: (EmojiSource | undefined)[], instanceEmojis: Record<string, string>): string[] {
  const used = new Set<string>();
  // Local emojis appear as `name` in text and as `name@.` in reaction keys.
  const add = (name: string) => {
    const local = name.replace(/@\.$/, '');
    if (instanceEmojis[local]) used.add(local);
  };
  const scan = (n: EmojiSource | undefined) => {
    if (!n) return;
    for (const text of [n.text, n.cw]) {
      if (text) for (const m of text.matchAll(EMOJI_PATTERN)) add(m[1]);
    }
    for (const key of Object.keys(n.reactions ?? {})) add(key.replace(/^:|:$/g, ''));
    scan(n.reply);
    scan(n.renote);
  };
  notes.forEach(scan);
  return [...used].sort();
}

/** File extension for an image: from the URL when it has one, otherwise from the first bytes. */
async function imageExtension(url: string, blob: Blob): Promise<string> {
  let path = url;
  try { path = new URL(url).pathname; } catch { /* not an absolute URL */ }
  const fromUrl = path.match(/\.(png|apng|gif|webp|jpe?g|avif|svg)$/i);
  if (fromUrl) return fromUrl[0].toLowerCase();
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const ascii = (from: number, to: number) => String.fromCharCode(...head.slice(from, to));
  if (head[0] === 0x89 && ascii(1, 4) === 'PNG') return '.png';
  if (ascii(0, 3) === 'GIF') return '.gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return '.webp';
  if (head[0] === 0xff && head[1] === 0xd8) return '.jpg';
  if (ascii(4, 8) === 'ftyp') return '.avif';
  return '';
}

function deduplicateFiles(files: MisskeyDriveFile[]): MisskeyDriveFile[] {
  const seen = new Set<string>();
  return files.filter(f => { if (seen.has(f.id)) return false; seen.add(f.id); return true; });
}

/** Convert MisskeyNote (from API) → ArchiveNote. */
function apiNoteToArchiveNote(n: MisskeyNote, fileMap: Map<string, string>): ArchiveNote {
  return {
    ...n,
    files: (n.files ?? []).map(f => ({ ...f, localPath: fileMap.get(f.id) ?? f.url })),
    reply: n.reply ? {
      ...n.reply,
      files: (n.reply.files ?? []).map(f => ({ ...f, localPath: fileMap.get(f.id) ?? f.url })),
    } as ArchiveNote : undefined,
    renote: n.renote ? {
      ...n.renote,
      files: (n.renote.files ?? []).map(f => ({ ...f, localPath: fileMap.get(f.id) ?? f.url })),
    } as ArchiveNote : undefined,
  };
}

/** Convert ExportedNote (from Misskey export JSON) → ArchiveNote using authenticated user. */
function exportedToArchiveNote(n: ExportedNote, user: MisskeyUser, fileMap: Map<string, string>): ArchiveNote {
  return {
    id: n.id,
    createdAt: n.createdAt,
    text: n.text,
    cw: n.cw,
    visibility: n.visibility,
    localOnly: n.localOnly,
    renoteCount: 0,
    replyCount: 0,
    reactions: {},
    reactionEmojis: {},
    emojis: {},
    tags: [],
    fileIds: n.fileIds,
    files: n.files.map(f => ({ ...f, localPath: fileMap.get(f.id) ?? f.url })),
    replyId: n.replyId,
    renoteId: n.renoteId,
    user,
    poll: n.poll ?? undefined,
  };
}

/**
 * For favorites/clips from Misskey export: notes only have fileIds (no URLs).
 * Calls notes/show for notes that have files, downloads them, builds ArchiveNote map.
 */
async function resolveForeignNotes(
  notes: import('../types/misskey').ExportedForeignNote[],
  client: MisskeyClient,
  addFile: AddFile,
  folderPath: string,
  signal: AbortSignal,
  onProgress: (done: number, total: number, name: string) => void,
  useFileCache = false,
  rewriteUrl?: UrlRewriter,
  onLog?: ArchiveLog,
): Promise<{ noteMap: Map<string, ArchiveNote>; errors: string[] }> {
  const result = new Map<string, ArchiveNote>();
  const errors: string[] = [];
  const warn = (entry: string) => { errors.push(entry); onLog?.('warn', entry); };
  const fail = (entry: string) => { errors.push(entry); onLog?.('error', entry); };

  // Fetch full note info only for notes that have files
  const notesWithFiles = notes.filter(n => n.fileIds.length > 0);
  const filesByNoteId = new Map<string, MisskeyDriveFile[]>();
  for (const n of notesWithFiles) {
    if (signal.aborted) break;
    try {
      const full = await client.fetchNoteShow(n.id);
      if (full.files?.length) filesByNoteId.set(n.id, full.files);
    } catch { /* note might not be accessible */ }
  }

  const allFiles = deduplicateFiles(Array.from(filesByNoteId.values()).flat());
  const fileMap = assignLocalPaths(allFiles, folderPath);

  // Build file→note map for error reporting
  const fileNoteMap = new Map<string, ArchiveNoteRef[]>();
  for (const [noteId, files] of filesByNoteId) {
    const noteRef = notes.find(n => n.id === noteId);
    const ref = { id: noteId, url: noteRef?.url ?? noteRef?.uri ?? '' };
    for (const f of files) {
      const existing = fileNoteMap.get(f.id) ?? [];
      if (!existing.some(r => r.id === noteId)) existing.push(ref);
      fileNoteMap.set(f.id, existing);
    }
  }

  const notesSuffix = (fileId: string) => noteRefsText(fileNoteMap.get(fileId));

  let done = 0;
  for (const f of allFiles) {
    if (signal.aborted) break;
    onProgress(done, allFiles.length, f.name);
    if (f.url || f.thumbnailUrl) {
      const target = f.url ? f : { ...f, url: f.thumbnailUrl! };
      const { blob, error } = await downloadFile(target, useFileCache, rewriteUrl);
      if (blob) {
        const localName = fileMap.get(f.id)!.replace(`${folderPath}/`, '');
        await addFile(localName, blob);
        onLog?.('info', `OK [${folderPath}] ${localName} ← ${f.url || f.thumbnailUrl}`);
        if (!f.url) warn(`WARN [${folderPath}] url=null, used thumbnailUrl: ${f.thumbnailUrl}${notesSuffix(f.id)}`);
        else if (error) warn(`WARN [${folderPath}] ${f.url}\n  → ${error}${notesSuffix(f.id)}`);
      } else {
        fileMap.set(f.id, f.url || f.thumbnailUrl || '');
        fail(`FAIL [${folderPath}] ${f.url || f.thumbnailUrl || '(no url)'}\n  → ${error ?? 'unknown error'}${notesSuffix(f.id)}`);
      }
    } else {
      fileMap.set(f.id, '');
      fail(`FAIL [${folderPath}] (no url, no thumbnailUrl) fileId=${f.id} name=${f.name}${notesSuffix(f.id)}`);
    }
    done++;
  }

  for (const n of notes) {
    const resolvedFiles = (filesByNoteId.get(n.id) ?? []).map(f => ({
      ...f,
      localPath: fileMap.get(f.id) ?? f.url,
    }));
    result.set(n.id, {
      id: n.id,
      createdAt: n.createdAt,
      text: n.text,
      cw: n.cw,
      visibility: n.visibility as MisskeyNote['visibility'],
      localOnly: n.localOnly,
      renoteCount: 0,
      replyCount: 0,
      reactions: {},
      reactionEmojis: {},
      emojis: {},
      tags: [],
      fileIds: n.fileIds,
      files: resolvedFiles,
      replyId: n.replyId,
      renoteId: n.renoteId,
      user: n.user,
      uri: n.uri,
      url: n.url,
      poll: n.poll ?? undefined,
    });
  }
  return { noteMap: result, errors };
}

// ---- output ----

/** Where the archive is written. Paths are relative to the archive root. */
export interface ArchiveSink {
  /** `store` skips compression. */
  add(path: string, data: Blob | string, store?: boolean): Promise<void>;
  /** Finishes the output. Returns the ZIP as a Blob when it was built in memory, otherwise null. */
  close(): Promise<Blob | null>;
}

/** ZIP output. Streams into `output` when given; otherwise the ZIP is built in memory and returned by close(). */
export function zipSink(rootFolder: string, output?: WritableStream<Uint8Array>): ArchiveSink {
  const zipWriter = new ZipWriter<unknown>(output ?? new BlobWriter('application/zip'));
  return {
    async add(path, data, store = false) {
      const blob = typeof data === 'string' ? new Blob([data]) : data;
      await zipWriter.add(`${rootFolder}/${path}`, new BlobReader(blob), store ? { level: 0 } : undefined);
    },
    async close() {
      const zipped = await zipWriter.close();
      return output ? null : zipped as Blob;
    },
  };
}

/** Plain files written into a folder on disk (desktop only). */
export function folderSink(target: FolderTarget): ArchiveSink {
  return {
    async add(path, data) {
      await target.writeFile(path, typeof data === 'string' ? new Blob([data]) : data);
    },
    async close() {
      await target.finish();
      return null;
    },
  };
}

// ---- main export ----

/**
 * Builds the archive into `sink`. Entries are written as soon as they are ready.
 * Returns the result of `sink.close()`, or null when aborted.
 */
export async function buildArchive(
  instanceUrl: string,
  user: MisskeyUser,
  options: ExportOptions,
  client: MisskeyClient,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
  sink: ArchiveSink,
  // API mode: notes fetched by ExportPage (with IndexedDB cache)
  apiNotes?: MisskeyNote[],
  // Upload mode: parsed from user-provided JSON files
  uploadData?: UploadData,
  useFileCache = false,
  rewriteUrl?: UrlRewriter,
  onLog?: ArchiveLog,
  // Emojis are cached by their original URL in the same store as drive files (one store for all users and servers).
  useEmojiCache = useFileCache,
): Promise<Blob | null> {
  const addEntry = (path: string, data: Blob | string) => sink.add(path, data);
  // Drive files are mostly already-compressed media, so they are stored without recompression.
  const fileAdder = (folderPath: string): AddFile => (name, data) => sink.add(`${folderPath}/${name}`, data, true);

  // 1. Fetch instance emojis
  const instanceEmojis = await client.fetchEmojis();

  // 2. Notes
  let archiveNotes: ArchiveNote[] = [];
  let totalFiles = 0, failCount = 0;
  const allErrors: string[] = [];
  // The entries have already been passed to onLog where they occurred.
  const reportErrors = (entries: string[]) => {
    allErrors.push(...entries);
  };

  // A file of a reply or renote belongs to the note in the list (the one the viewer shows).
  function buildFileNoteMap(noteList: Array<{ id: string; files?: MisskeyDriveFile[]; reply?: { files?: MisskeyDriveFile[] }; renote?: { files?: MisskeyDriveFile[] } }>): Map<string, ArchiveNoteRef[]> {
    const m = new Map<string, ArchiveNoteRef[]>();
    for (const n of noteList) {
      const ref = { id: n.id, url: `https://${instanceUrl}/notes/${n.id}` };
      const allNoteFiles = [...(n.files ?? []), ...(n.reply?.files ?? []), ...(n.renote?.files ?? [])];
      for (const f of allNoteFiles) {
        const existing = m.get(f.id) ?? [];
        if (!existing.some(r => r.id === n.id)) existing.push(ref);
        m.set(f.id, existing);
      }
    }
    return m;
  }

  if (options.notesMode === 'upload' && uploadData) {
    const { exportedNotes } = uploadData;
    const allFiles = deduplicateFiles(exportedNotes.flatMap(n => n.files));
    totalFiles += allFiles.length;
    onProgress({ phase: 'files', message: 'ノートのファイルをダウンロード中...', noteCount: exportedNotes.length, fileCount: 0, totalFiles, failCount: 0 });
    const fileNoteMap = buildFileNoteMap(exportedNotes);
    const { fileMap, failCount: fc, errors } = await downloadFilesToFolder(
      allFiles, fileAdder('files'), 'files', signal,
      (done, total, name, fails) => onProgress({ phase: 'files', message: 'ノートのファイルをダウンロード中...', noteCount: exportedNotes.length, fileCount: done, totalFiles: total, failCount: fails, currentFile: name }),
      fileNoteMap, useFileCache, rewriteUrl, onLog,
    );
    failCount += fc;
    reportErrors(errors);
    const noteUser = toNoteUser(user);
    archiveNotes = exportedNotes.map(n => exportedToArchiveNote(n, noteUser, fileMap));
  } else {
    const notes = apiNotes ?? [];
    const allFiles = deduplicateFiles(notes.flatMap(n => [
      ...(n.files ?? []),
      ...(n.reply?.files ?? []),
      ...(n.renote?.files ?? []),
    ]));
    totalFiles += allFiles.length;
    onProgress({ phase: 'files', message: 'ノートのファイルをダウンロード中...', noteCount: notes.length, fileCount: 0, totalFiles, failCount: 0 });
    const fileNoteMap = buildFileNoteMap(notes);
    const { fileMap, failCount: fc, errors } = await downloadFilesToFolder(
      allFiles, fileAdder('files'), 'files', signal,
      (done, total, name, fails) => onProgress({ phase: 'files', message: 'ノートのファイルをダウンロード中...', noteCount: notes.length, fileCount: done, totalFiles: total, failCount: fails, currentFile: name }),
      fileNoteMap, useFileCache, rewriteUrl, onLog,
    );
    failCount += fc;
    reportErrors(errors);
    archiveNotes = notes.map(n => apiNoteToArchiveNote(n, fileMap));
  }

  if (signal.aborted) return null;

  // 3. Favorites
  let archiveFavorites: ArchiveFavoriteItem[] = [];
  if (options.favoritesMode !== 'none') {
    if (options.favoritesMode === 'upload' && uploadData?.favItems) {
      // Upload mode: resolve file URLs via notes/show
      const allFavNotes = uploadData.favItems.map(f => f.note);
      const { noteMap, errors: favErrors } = await resolveForeignNotes(
        allFavNotes, client, fileAdder('fav-files'), 'fav-files', signal,
        (done, total, name) => onProgress({ phase: 'files', message: 'お気に入りのファイルをダウンロード中...', fileCount: done, totalFiles: total, currentFile: name, failCount }),
        useFileCache, rewriteUrl, onLog,
      );
      reportErrors(favErrors);
      archiveFavorites = uploadData.favItems.map(f => ({
        id: f.id,
        createdAt: f.createdAt,
        note: noteMap.get(f.note.id)!,
      }));
    } else {
      // API mode: fetch all favorites
      const favItems: { id: string; createdAt: string; note: MisskeyNote }[] = [];
      onProgress({ phase: 'favorites-api', message: 'お気に入りを取得中...' });
      for await (const batch of client.fetchAllFavorites((count) => {
        onProgress({ phase: 'favorites-api', message: 'お気に入りを取得中...', noteCount: count });
      })) {
        if (signal.aborted) return null;
        favItems.push(...batch);
      }
      if (favItems.length > 0) {
        const allFavFiles = deduplicateFiles(favItems.flatMap(fi => [
          ...(fi.note.files ?? []),
          ...(fi.note.reply?.files ?? []),
          ...(fi.note.renote?.files ?? []),
        ]));
        totalFiles += allFavFiles.length;
        const favFileNoteMap = buildFileNoteMap(favItems.map(fi => fi.note));
        const { fileMap: favFileMap, failCount: favFc, errors: favErrors } = await downloadFilesToFolder(
          allFavFiles, fileAdder('fav-files'), 'fav-files', signal,
          (done, total, name, fails) => onProgress({ phase: 'files', message: 'お気に入りのファイルをダウンロード中...', fileCount: done, totalFiles: total, currentFile: name, failCount: fails }),
          favFileNoteMap, useFileCache, rewriteUrl, onLog,
        );
        failCount += favFc;
        reportErrors(favErrors);
        archiveFavorites = favItems.map(fi => ({
          id: fi.id,
          createdAt: fi.createdAt,
          note: apiNoteToArchiveNote(fi.note, favFileMap),
        }));
      }
    }
  }

  if (signal.aborted) return null;

  // 4. Clips
  let archiveClips: ArchiveClip[] = [];
  if (options.clipsMode !== 'none') {
    if (options.clipsMode === 'upload' && uploadData?.clipExports) {
      // Upload mode: resolve file URLs via notes/show
      const allClipNotes = uploadData.clipExports.flatMap(c => c.clipNotes.map(cn => cn.note));
      const { noteMap: clipNoteMap, errors: clipUploadErrors } = await resolveForeignNotes(
        allClipNotes, client, fileAdder('clip-files'), 'clip-files', signal,
        (done, total, name) => onProgress({ phase: 'files', message: 'クリップのファイルをダウンロード中...', fileCount: done, totalFiles: total, currentFile: name, failCount }),
        useFileCache, rewriteUrl, onLog,
      );
      reportErrors(clipUploadErrors);
      archiveClips = uploadData.clipExports.map(c => ({
        id: c.id,
        name: c.name,
        description: c.description,
        lastClippedAt: c.lastClippedAt,
        clipNotes: c.clipNotes.map(cn => ({
          id: cn.id,
          createdAt: cn.createdAt,
          note: clipNoteMap.get(cn.note.id)!,
        })),
      }));
    } else {
      // API mode: fetch all clips
      onProgress({ phase: 'clips-api', message: 'クリップ一覧を取得中...' });
      const clipsList = await client.fetchClipsList();
      const clipData: { clip: typeof clipsList[0]; notes: MisskeyNote[] }[] = [];
      for (const clip of clipsList) {
        if (signal.aborted) return null;
        const clipNotes: MisskeyNote[] = [];
        onProgress({ phase: 'clips-api', message: `クリップ「${clip.name}」のノートを取得中...` });
        for await (const batch of client.fetchClipNotes(clip.id)) {
          if (signal.aborted) return null;
          clipNotes.push(...batch);
        }
        clipData.push({ clip, notes: clipNotes });
      }
      const allClipNotes = clipData.flatMap(d => d.notes);
      const allClipFiles = deduplicateFiles(allClipNotes.flatMap(n => [
        ...(n.files ?? []),
        ...(n.reply?.files ?? []),
        ...(n.renote?.files ?? []),
      ]));
      totalFiles += allClipFiles.length;
      let clipFileMap = new Map<string, string>();
      if (allClipFiles.length > 0) {
        const clipFileNoteMap = buildFileNoteMap(allClipNotes);
        const result = await downloadFilesToFolder(
          allClipFiles, fileAdder('clip-files'), 'clip-files', signal,
          (done, total, name, fails) => onProgress({ phase: 'files', message: 'クリップのファイルをダウンロード中...', fileCount: done, totalFiles: total, currentFile: name, failCount: fails }),
          clipFileNoteMap, useFileCache, rewriteUrl, onLog,
        );
        clipFileMap = result.fileMap;
        failCount += result.failCount;
        reportErrors(result.errors);
      }
      archiveClips = clipData.map(({ clip, notes }) => ({
        id: clip.id,
        name: clip.name,
        description: clip.description,
        lastClippedAt: clip.lastClippedAt,
        clipNotes: notes.map(note => ({
          id: note.id,
          createdAt: note.createdAt,
          note: apiNoteToArchiveNote(note, clipFileMap),
        })),
      }));
    }
  }

  if (signal.aborted) return null;

  // 5. The server's custom emojis used in the archived notes are stored in the archive, so that they
  //    still show after the server and its storage are gone. Other emojis keep their URLs.
  const archiveEmojis = { ...instanceEmojis };
  const emojiNames = usedLocalEmojis([
    ...archiveNotes,
    ...archiveFavorites.map(f => f.note),
    ...archiveClips.flatMap(c => c.clipNotes.map(cn => cn.note)),
  ], instanceEmojis);
  const usedEmojiFileNames = new Set<string>();
  let emojiDone = 0;
  for (const name of emojiNames) {
    if (signal.aborted) return null;
    onProgress({ phase: 'files', message: '絵文字をダウンロード中...', fileCount: emojiDone, totalFiles: emojiNames.length, currentFile: `:${name}:`, failCount });
    const url = instanceEmojis[name];
    const { blob, error, fromCache } = await downloadFile({ id: name, name, type: '', url, thumbnailUrl: null, size: 0, md5: '' }, useEmojiCache, rewriteUrl);
    if (blob) {
      let fileName = sanitizeFilename(name) + await imageExtension(url, blob);
      // Names differing only in case would collide on case-insensitive file systems.
      if (usedEmojiFileNames.has(fileName.toLowerCase())) fileName = `${emojiDone}_${fileName}`;
      usedEmojiFileNames.add(fileName.toLowerCase());
      await sink.add(`emojis/${fileName}`, blob, true);
      archiveEmojis[name] = `emojis/${fileName}`;
      onLog?.('info', `OK [emojis]${fromCache ? ' [cache]' : ''} :${name}: emojis/${fileName} ← ${url}`);
      if (error) {
        const entry = `WARN [emojis] :${name}: ${url}\n  → ${error}`;
        reportErrors([entry]);
        onLog?.('warn', entry);
      }
    } else {
      failCount++;
      const entry = `FAIL [emojis] :${name}: ${url}\n  → ${error ?? 'unknown error'}`;
      reportErrors([entry]);
      onLog?.('error', entry);
    }
    emojiDone++;
  }

  if (signal.aborted) return null;

  // 6. Package ZIP
  onProgress({ phase: 'packaging', message: 'アーカイブを書き出し中...', noteCount: archiveNotes.length, fileCount: totalFiles, totalFiles, failCount });

  const index: ArchiveIndex = {
    exportedAt: new Date().toISOString(),
    instanceUrl,
    user,
    noteCount: archiveNotes.length,
    fileCount: totalFiles,
    hasFavorites: archiveFavorites.length > 0,
    hasClips: archiveClips.length > 0,
    emojis: archiveEmojis,
  };

  await addEntry('notes.json', jsonArrayBlob(archiveNotes));
  await addEntry('index.json', JSON.stringify(index, null, 2));
  if (archiveFavorites.length > 0) await addEntry('favorites.json', jsonArrayBlob(archiveFavorites));
  if (archiveClips.length > 0) await addEntry('clips.json', jsonArrayBlob(archiveClips));

  const dataParts: string[] = [];
  const dataSets: [ArchiveDataKind, unknown[]][] = [['notes', archiveNotes], ['favorites', archiveFavorites], ['clips', archiveClips]];
  for (const [kind, items] of dataSets) {
    let n = 0;
    for (const part of viewerDataParts(kind, items)) {
      const path = `data/${kind}-${String(++n).padStart(3, '0')}.js`;
      await addEntry(path, part);
      dataParts.push(path);
    }
  }
  await addEntry('archive-data.js', archiveDataJs(JSON.stringify(index), dataParts));
  await addEntry('index.html', viewerHtml(VERSION));
  {
    const header = [
      `export: ${new Date().toISOString()}`,
      `tauri: ${isTauri()}`,
      `failed: ${allErrors.length}`,
      '',
    ].join('\n');
    const errorLog = allErrors.length > 0 ? header + allErrors.join('\n\n') : header + '(no errors)';
    await addEntry('error.log', errorLog);
    // The viewer shows error.log in a popup. Opened from file://, it can read the text only through a script.
    await addEntry('error-log.js', `window.__ARCHIVE_ERROR_LOG__ = ${JSON.stringify(errorLog)};\n`);
  }

  return sink.close();
}

/** Parse a Misskey notes export JSON (plain array or ActivityPub-wrapped). */
export function parseNotesExport(raw: unknown[]): ExportedNote[] {
  return raw.map((item: unknown) => {
    const i = item as Record<string, unknown>;
    if (i.type === 'Note' && i.object) return i.object as ExportedNote;
    return item as ExportedNote;
  });
}
