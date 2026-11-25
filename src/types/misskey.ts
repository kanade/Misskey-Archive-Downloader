export interface MisskeyUser {
  id: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  host?: string | null;
  instance?: { name: string; softwareName: string };
}

export interface MisskeyDriveFile {
  id: string;
  name: string;
  type: string;
  url: string;
  thumbnailUrl: string | null;
  size: number;
  md5: string;
}

export interface MisskeyNote {
  id: string;
  createdAt: string;
  text: string | null;
  cw: string | null;
  visibility: 'public' | 'home' | 'followers' | 'specified';
  localOnly: boolean;
  renoteCount: number;
  replyCount: number;
  reactions: Record<string, number>;
  reactionEmojis?: Record<string, string>;
  emojis?: Record<string, string>;
  files: MisskeyDriveFile[];
  fileIds?: string[];
  replyId: string | null;
  renoteId: string | null;
  reply?: MisskeyNote;
  renote?: MisskeyNote;
  user: MisskeyUser;
  tags?: string[];
  uri?: string | null;
  url?: string | null;
  poll?: {
    expiresAt: string | null;
    multiple: boolean;
    choices: { text: string; votes: number; isVoted: boolean }[];
  };
}

// ---- Export format types (from Misskey's own export feature) ----

// From i/export-notes: has files[] with URLs but no user/reactions/tags
export interface ExportedNote {
  id: string;
  createdAt: string;
  text: string | null;
  cw: string | null;
  visibility: 'public' | 'home' | 'followers' | 'specified';
  visibleUserIds: string[];
  localOnly: boolean;
  reactionAcceptance: string | null;
  fileIds: string[];
  files: MisskeyDriveFile[];
  replyId: string | null;
  renoteId: string | null;
  poll: {
    expiresAt: string | null;
    multiple: boolean;
    choices: { text: string; votes: number; isVoted: boolean }[];
  } | null;
}

// Notes inside favorites/clips exports: has user + uri/url but only fileIds (no file URLs)
export interface ExportedForeignNote {
  id: string;
  createdAt: string;
  text: string | null;
  cw: string | null;
  visibility: string;
  localOnly: boolean;
  fileIds: string[];
  replyId: string | null;
  renoteId: string | null;
  poll: null | {
    expiresAt: string | null;
    multiple: boolean;
    choices: { text: string; votes: number; isVoted: boolean }[];
  };
  user: MisskeyUser;
  uri: string | null;
  url: string | null;
}

export interface FavoriteExportItem {
  id: string;
  createdAt: string;
  note: ExportedForeignNote;
}

export interface ClipExport {
  id: string;
  name: string;
  description: string | null;
  lastClippedAt: string;
  clipNotes: { id: string; createdAt: string; note: ExportedForeignNote }[];
}

// ---- Archive types (stored in ZIP) ----

export interface ArchiveDriveFile extends MisskeyDriveFile {
  localPath: string;
}

export interface ArchiveNote extends Omit<MisskeyNote, 'files'> {
  files: ArchiveDriveFile[];
  reactionUsers?: Record<string, string[]>;
}

export interface ArchiveFavoriteItem {
  id: string;
  createdAt: string;
  note: ArchiveNote;
}

export interface ArchiveClip {
  id: string;
  name: string;
  description: string | null;
  lastClippedAt: string;
  clipNotes: { id: string; createdAt: string; note: ArchiveNote }[];
}

/** A note a file belongs to: `id` opens it in the viewer (`index.html#note-<id>`), `url` is where it was on the server. */
export interface ArchiveNoteRef {
  id: string;
  url: string;
}

export interface ArchiveIndex {
  exportedAt: string;
  instanceUrl: string;
  user: MisskeyUser;
  noteCount: number;
  fileCount: number;
  hasFavorites: boolean;
  hasClips: boolean;
  emojis?: Record<string, string>;
}
