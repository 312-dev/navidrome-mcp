/**
 * Navidrome client.
 *
 * Navidrome exposes two APIs and this server needs both, because they have
 * complementary and non-overlapping capabilities:
 *
 *  - The **native REST API** (`/api/...`, JWT via `/auth/login`) returns the full
 *    metadata row for a track (every tag, playCount, playDate, bpm, ...) and is
 *    the only way to create/update playlists including *smart* playlists. Its
 *    filtering, however, is exact-match only: `year=1997` works, `year=1990-1999`
 *    silently returns nothing. There are no range or boolean operators.
 *
 *  - The **Subsonic API** (`/rest/...`, salted-md5 auth) is where the external
 *    agents live: `getSimilarSongs2`, `getArtistInfo2` and `getTopSongs` are
 *    backed by Navidrome's configured agent chain (deezer,lastfm,listenbrainz),
 *    so they return real similarity data the native API cannot produce.
 *
 * The compound filtering this server advertises is therefore NOT done by asking
 * Navidrome to filter -- it is done locally against a full in-memory mirror (see
 * store.ts). Navidrome's own compound engine (smart-playlist rules) is exposed
 * separately, for playlists that should keep re-evaluating themselves server-side.
 */

import { createHash, randomBytes } from "node:crypto";

/** Raw song row as returned by the native API. Fields vary; unknowns are kept. */
export interface NdSong {
  id: string;
  title: string;
  album: string;
  albumId: string;
  artist: string;
  artistId: string;
  albumArtist: string;
  albumArtistId: string;
  genre?: string;
  genres?: { id: string; name: string }[];
  year?: number;
  date?: string;
  originalYear?: number;
  releaseYear?: number;
  duration?: number;
  size?: number;
  bitRate?: number;
  suffix?: string;
  trackNumber?: number;
  discNumber?: number;
  playCount?: number;
  playDate?: string;
  rating?: number;
  starred?: boolean;
  starredAt?: string;
  bpm?: number;
  comment?: string;
  createdAt?: string;
  updatedAt?: string;
  missing?: boolean;
  compilation?: boolean;
  path?: string;
  tags?: Record<string, string[]>;
  [k: string]: unknown;
}

export interface NdPlaylist {
  id: string;
  name: string;
  comment?: string;
  songCount?: number;
  duration?: number;
  public?: boolean;
  ownerName?: string;
  path?: string;
  sync?: boolean;
  rules?: unknown;
  createdAt?: string;
  updatedAt?: string;
  evaluatedAt?: string;
}

export class NavidromeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "NavidromeError";
  }
}

export interface NavidromeOptions {
  baseUrl: string;
  username: string;
  password: string;
  /** Optional undici Dispatcher (used to egress via the Mac Mini SOCKS proxy). */
  dispatcher?: unknown;
  clientName?: string;
}

interface Session {
  jwt: string;
  userId: string;
  subsonicSalt: string;
  subsonicToken: string;
  isAdmin: boolean;
  obtainedAt: number;
}

export class Navidrome {
  private session: Session | null = null;
  private loginInFlight: Promise<Session> | null = null;
  private readonly clientName: string;

  constructor(private readonly opts: NavidromeOptions) {
    this.clientName = opts.clientName ?? "navidrome-mcp";
    if (!opts.baseUrl) throw new NavidromeError("NAVIDROME_URL is not set");
    if (!opts.username || !opts.password) {
      throw new NavidromeError("NAVIDROME_USERNAME / NAVIDROME_PASSWORD are not set");
    }
  }

  private get base(): string {
    return this.opts.baseUrl.replace(/\/+$/, "");
  }

  private async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const opts: Record<string, unknown> = { ...init };
    if (this.opts.dispatcher) opts.dispatcher = this.opts.dispatcher;
    return fetch(url, opts as RequestInit);
  }

  // ── auth ────────────────────────────────────────────────────────────────

  /**
   * Navidrome's JWT is short-lived and is normally refreshed by echoing the
   * rotated token from the `x-nd-authorization` response header. This server is
   * long-running but low-traffic, so instead of tracking rotation we simply
   * re-login whenever a call comes back 401. Cheap and impossible to get wrong.
   */
  private async login(): Promise<Session> {
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = (async () => {
      const res = await this.fetch(`${this.base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: this.opts.username,
          password: this.opts.password,
        }),
      });
      if (!res.ok) {
        throw new NavidromeError(
          `Navidrome login failed (${res.status}). Check NAVIDROME_USERNAME/PASSWORD.`,
          res.status,
        );
      }
      const body = (await res.json()) as Record<string, string | boolean>;
      const s: Session = {
        jwt: String(body.token),
        userId: String(body.id),
        subsonicSalt: String(body.subsonicSalt ?? ""),
        subsonicToken: String(body.subsonicToken ?? ""),
        isAdmin: Boolean(body.isAdmin),
        obtainedAt: Date.now(),
      };
      this.session = s;
      return s;
    })().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async session_(): Promise<Session> {
    if (this.session) return this.session;
    return this.login();
  }

  async whoami(): Promise<{ userId: string; username: string; isAdmin: boolean }> {
    const s = await this.session_();
    return { userId: s.userId, username: this.opts.username, isAdmin: s.isAdmin };
  }

  // ── native REST API ─────────────────────────────────────────────────────

  /** One native-API call, retrying once through a fresh login on 401. */
  private async ndRaw(
    method: string,
    path: string,
    query?: Record<string, string | number | undefined>,
    body?: unknown,
    retry = true,
  ): Promise<{ status: number; headers: Headers; text: string }> {
    const s = await this.session_();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const url = `${this.base}/api/${path}${qs.toString() ? `?${qs}` : ""}`;
    const res = await this.fetch(url, {
      method,
      headers: {
        "x-nd-authorization": `Bearer ${s.jwt}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401 && retry) {
      this.session = null;
      await this.login();
      return this.ndRaw(method, path, query, body, false);
    }
    return { status: res.status, headers: res.headers, text: await res.text() };
  }

  async nd<T = unknown>(
    method: string,
    path: string,
    query?: Record<string, string | number | undefined>,
    body?: unknown,
  ): Promise<{ data: T; total: number | null }> {
    const { status, headers, text } = await this.ndRaw(method, path, query, body);
    if (status < 200 || status >= 300) {
      throw new NavidromeError(
        `Navidrome ${method} /api/${path} failed (${status}): ${text.slice(0, 300)}`,
        status,
      );
    }
    const totalHeader = headers.get("x-total-count");
    const total = totalHeader ? Number(totalHeader) : null;
    let data: T;
    try {
      data = text ? (JSON.parse(text) as T) : (undefined as T);
    } catch {
      data = text as unknown as T;
    }
    return { data, total };
  }

  /**
   * Page through a native-API collection.
   *
   * `_end` is exclusive and Navidrome caps a page well below what you might ask
   * for, so this walks in fixed windows and stops on a short/empty page rather
   * than trusting X-Total-Count (which shifts if a scan lands mid-walk).
   */
  async ndAll<T = unknown>(
    path: string,
    query: Record<string, string | number | undefined> = {},
    pageSize = 500,
    onProgress?: (n: number) => void,
  ): Promise<T[]> {
    const out: T[] = [];
    let start = 0;
    for (;;) {
      const { data } = await this.nd<T[]>("GET", path, {
        ...query,
        _start: start,
        _end: start + pageSize,
      });
      const chunk = Array.isArray(data) ? data : [];
      out.push(...chunk);
      onProgress?.(out.length);
      if (chunk.length < pageSize) break;
      start += pageSize;
      if (start > 500_000) break; // hard stop; nothing here is that large
    }
    return out;
  }

  // ── convenience wrappers ────────────────────────────────────────────────

  allSongs(onProgress?: (n: number) => void): Promise<NdSong[]> {
    return this.ndAll<NdSong>("song", {}, 500, onProgress);
  }

  async listPlaylists(): Promise<NdPlaylist[]> {
    return this.ndAll<NdPlaylist>("playlist", {}, 200);
  }

  /**
   * Tracks in a playlist.
   *
   * Rows come back with `id` set to the *positional* entry id ("1", "2", ...) and
   * the real media file id under `mediaFileId`. Callers want the latter, so it is
   * normalised into `id` here and the positional one preserved as `entryId`.
   */
  async playlistTracks(id: string): Promise<(NdSong & { entryId: string })[]> {
    const rows = await this.ndAll<NdSong & { mediaFileId?: string }>(
      `playlist/${encodeURIComponent(id)}/tracks`,
      {},
      500,
    );
    return rows.map((r) => ({
      ...r,
      entryId: String(r.id),
      id: String(r.mediaFileId ?? r.id),
    }));
  }

  async createPlaylist(input: {
    name: string;
    comment?: string;
    public?: boolean;
    rules?: unknown;
  }): Promise<string> {
    const { data } = await this.nd<{ id: string }>("POST", "playlist", undefined, {
      name: input.name,
      comment: input.comment ?? "",
      public: input.public ?? false,
      ...(input.rules ? { rules: input.rules } : {}),
    });
    if (!data?.id) throw new NavidromeError("Navidrome did not return a playlist id");
    return data.id;
  }

  async updatePlaylist(
    id: string,
    patch: { name?: string; comment?: string; public?: boolean; rules?: unknown },
  ): Promise<void> {
    await this.nd("PUT", `playlist/${encodeURIComponent(id)}`, undefined, patch);
  }

  async deletePlaylist(id: string): Promise<void> {
    await this.nd("DELETE", `playlist/${encodeURIComponent(id)}`);
  }

  async addTracks(playlistId: string, trackIds: string[]): Promise<number> {
    let added = 0;
    // Navidrome accepts large batches but the request body is the limiting
    // factor; 200 ids per call keeps it comfortably small.
    for (let i = 0; i < trackIds.length; i += 200) {
      const slice = trackIds.slice(i, i + 200);
      const { data } = await this.nd<{ added?: number }>(
        "POST",
        `playlist/${encodeURIComponent(playlistId)}/tracks`,
        undefined,
        { ids: slice },
      );
      added += data?.added ?? slice.length;
    }
    return added;
  }

  /** Remove every track from a playlist, leaving the playlist itself in place. */
  async clearTracks(playlistId: string): Promise<number> {
    let removed = 0;
    // The delete route takes the *positional* entry id ("1", "2", ...), not the
    // media file id -- and those positions RENUMBER after every delete. So a
    // chunked delete of previously-captured ids would silently remove the wrong
    // rows once past the first chunk. Instead, repeatedly delete the first N
    // positions (which are always 1..N) until the playlist reports empty.
    for (let guard = 0; guard < 1000; guard++) {
      const { data } = await this.nd<unknown[]>("GET", `playlist/${encodeURIComponent(playlistId)}/tracks`, {
        _start: 0,
        _end: 200,
      });
      const n = Array.isArray(data) ? data.length : 0;
      if (n === 0) break;
      const qs = new URLSearchParams();
      for (let i = 1; i <= n; i++) qs.append("id", String(i));
      await this.ndRaw(
        "DELETE",
        `playlist/${encodeURIComponent(playlistId)}/tracks?${qs.toString()}`,
      );
      removed += n;
    }
    return removed;
  }

  /** Replace a playlist's contents wholesale. */
  async replaceTracks(playlistId: string, trackIds: string[]): Promise<number> {
    await this.clearTracks(playlistId);
    return this.addTracks(playlistId, trackIds);
  }

  // ── Subsonic API ────────────────────────────────────────────────────────

  private async subsonicUrl(
    view: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<string> {
    await this.session_();
    // Compute the salted token ourselves rather than reusing the one handed back
    // by /auth/login: that pair is bound to the JWT's lifetime, and a stale one
    // fails with a confusing "wrong username or password".
    const salt = randomBytes(8).toString("hex");
    const token = createHash("md5")
      .update(this.opts.password + salt)
      .digest("hex");
    const qs = new URLSearchParams({
      u: this.opts.username,
      t: token,
      s: salt,
      v: "1.16.1",
      c: this.clientName,
      f: "json",
    });
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    return `${this.base}/rest/${view}?${qs}`;
  }

  async subsonic<T = Record<string, unknown>>(
    view: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const url = await this.subsonicUrl(view, params);
    const res = await this.fetch(url);
    const text = await res.text();
    let body: { "subsonic-response"?: Record<string, unknown> };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new NavidromeError(`Subsonic ${view}: unparseable response: ${text.slice(0, 200)}`);
    }
    const r = body["subsonic-response"];
    if (!r) throw new NavidromeError(`Subsonic ${view}: missing subsonic-response`);
    if (r.status === "failed") {
      const err = r.error as { code?: number; message?: string } | undefined;
      throw new NavidromeError(`Subsonic ${view} failed: ${err?.message ?? "unknown"}`, err?.code);
    }
    return r as T;
  }

  /** Similar songs for an artist/track id, via the configured agent chain. */
  async similarSongs(id: string, count = 30): Promise<NdSong[]> {
    const r = await this.subsonic<{ similarSongs2?: { song?: NdSong[] } }>(
      "getSimilarSongs2.view",
      { id, count },
    );
    return r.similarSongs2?.song ?? [];
  }

  async artistInfo(
    id: string,
    count = 20,
  ): Promise<{ biography?: string; similarArtist: { id: string; name: string }[] }> {
    const r = await this.subsonic<{
      artistInfo2?: { biography?: string; similarArtist?: { id: string; name: string }[] };
    }>("getArtistInfo2.view", { id, count });
    return {
      biography: r.artistInfo2?.biography,
      similarArtist: r.artistInfo2?.similarArtist ?? [],
    };
  }

  async topSongs(artistName: string, count = 20): Promise<NdSong[]> {
    const r = await this.subsonic<{ topSongs?: { song?: NdSong[] } }>("getTopSongs.view", {
      artist: artistName,
      count,
    });
    return r.topSongs?.song ?? [];
  }

  async ping(): Promise<{ serverVersion?: string; openSubsonic?: boolean }> {
    return this.subsonic("ping.view");
  }
}
