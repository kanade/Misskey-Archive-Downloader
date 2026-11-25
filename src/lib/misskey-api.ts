import type { MisskeyNote, MisskeyUser } from '../types/misskey';

/** Sends one API request. `body` is undefined when the response has no body. */
export type ApiTransport = (endpoint: string, payload: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;

export class MisskeyApiError extends Error {
  status: number;
  /** Misskey's error code, e.g. `RATE_LIMIT_EXCEEDED`. */
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fetchTransport(instanceUrl: string): ApiTransport {
  return async (endpoint, payload) => {
    const res = await fetch(`https://${instanceUrl}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { status: res.status, body: await res.json().catch(() => undefined) };
    if (res.status === 204 || res.headers.get('content-length') === '0') return { status: res.status, body: undefined };
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
}

export class MisskeyClient {
  private token: string;
  private transport: ApiTransport;

  constructor(instanceUrl: string, token: string, transport?: ApiTransport) {
    this.token = token;
    this.transport = transport ?? fetchTransport(instanceUrl);
  }

  async post<T>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await this.transport(endpoint, { i: this.token, ...body });
    if (res.status < 200 || res.status >= 300) {
      const err = (res.body as { error?: { message?: string; code?: string } } | undefined)?.error;
      throw new MisskeyApiError(err?.message ?? `API error: ${res.status}`, res.status, err?.code);
    }
    return res.body as T;
  }

  async getMe(): Promise<MisskeyUser> {
    return this.post<MisskeyUser>('i', {});
  }

  async *fetchAllNotes(userId: string, onProgress?: (count: number) => void, sinceId?: string): AsyncGenerator<MisskeyNote[]> {
    let untilId: string | undefined;
    let total = 0;

    while (true) {
      const notes = await this.post<MisskeyNote[]>('users/notes', {
        userId,
        limit: 100,
        includeReplies: true,
        withFiles: false,
        ...(untilId ? { untilId } : {}),
      });

      if (notes.length === 0) break;

      if (sinceId) {
        const fresh = notes.filter(n => n.id > sinceId);
        if (fresh.length > 0) {
          total += fresh.length;
          onProgress?.(total);
          yield fresh;
        }
        if (fresh.length < notes.length) break;
        if (fresh.length < 100) break;
        untilId = fresh[fresh.length - 1].id;
      } else {
        total += notes.length;
        onProgress?.(total);
        yield notes;
        untilId = notes[notes.length - 1].id;
        if (notes.length < 100) break;
      }
    }
  }

  async *fetchAllFavorites(onProgress?: (count: number) => void): AsyncGenerator<{ id: string; createdAt: string; note: MisskeyNote }[]> {
    let untilId: string | undefined;
    let total = 0;
    while (true) {
      const favorites = await this.post<{ id: string; createdAt: string; note: MisskeyNote }[]>('i/favorites', {
        limit: 100,
        ...(untilId ? { untilId } : {}),
      });
      if (favorites.length === 0) break;
      total += favorites.length;
      onProgress?.(total);
      yield favorites;
      if (favorites.length < 100) break;
      untilId = favorites[favorites.length - 1].id;
    }
  }

  async fetchClipsList(): Promise<{ id: string; name: string; description: string | null; lastClippedAt: string }[]> {
    return this.post<{ id: string; name: string; description: string | null; lastClippedAt: string }[]>('clips/list', {});
  }

  async *fetchClipNotes(clipId: string, onProgress?: (count: number) => void): AsyncGenerator<MisskeyNote[]> {
    let untilId: string | undefined;
    let total = 0;
    while (true) {
      const notes = await this.post<MisskeyNote[]>('clips/notes', {
        clipId,
        limit: 100,
        ...(untilId ? { untilId } : {}),
      });
      if (notes.length === 0) break;
      total += notes.length;
      onProgress?.(total);
      yield notes;
      if (notes.length < 100) break;
      untilId = notes[notes.length - 1].id;
    }
  }

  async fetchNoteShow(noteId: string): Promise<MisskeyNote> {
    return this.post<MisskeyNote>('notes/show', { noteId });
  }

  async fetchEmojis(): Promise<Record<string, string>> {
    try {
      const data = await this.post<{ emojis?: Array<{ name?: string; url?: string }> }>('emojis', {});
      const map: Record<string, string> = {};
      for (const e of data.emojis ?? []) {
        if (e.name && e.url) map[e.name] = e.url;
      }
      return map;
    } catch {
      // 絵文字取得は補助情報なので、失敗してもアーカイブ生成は継続する。
      return {};
    }
  }
}
