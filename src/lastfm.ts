/**
 * Last.fm tag enrichment.
 *
 * The library's own metadata is far too coarse for mood work: 32 genres across
 * 9,311 tracks, with "Rock" alone covering ~47% of them, and no mood/style tags
 * at all. Last.fm's community tags are the cheapest way to get a real descriptive
 * vocabulary ("dance-pop", "nu-disco", "melancholy", "90s", "shoegaze").
 *
 * Coverage is uneven -- popular tracks are richly tagged, deep cuts often have
 * nothing -- so artist-level tags are fetched too and used as a fallback. Artist
 * tags alone already cover the whole library for ~a third of the requests.
 *
 * The API key is Navidrome's own bundled public key. It is not a secret; it ships
 * inside every Navidrome binary. Using it keeps this server from needing its own
 * credential for what is a read-only, unauthenticated endpoint.
 */

const DEFAULT_KEY = "1e09b447d6dbe9ea525dec574fb5427c";
const ENDPOINT = "https://ws.audioscrobbler.com/2.0/";
const UA = "navidrome-mcp/1.0";

export interface Tag {
  name: string;
  count: number;
}

/** Tags this low are noise ("albums i own", one-off personal tags). */
const MIN_COUNT = 5;
/** Tags that describe the listener or the artist's name, not the music. */
const JUNK = /^(seen live|albums i own|favourites?|favorites?|my .*|awesome|love|good|great|best|cool|beautiful|amazing|check out|spotify|under 2000 listeners)$/i;

export class LastFm {
  private readonly key: string;
  /** Serialises requests to stay under Last.fm's rate limit. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    key?: string,
    private readonly dispatcher?: unknown,
    private readonly minIntervalMs = 210,
  ) {
    this.key = key || DEFAULT_KEY;
  }

  private schedule<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const t0 = Date.now();
      try {
        return await fn();
      } finally {
        const wait = this.minIntervalMs - (Date.now() - t0);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    });
    this.queue = next.catch(() => undefined);
    return next as Promise<T>;
  }

  private async call(params: Record<string, string>): Promise<Record<string, unknown> | null> {
    const qs = new URLSearchParams({
      ...params,
      api_key: this.key,
      format: "json",
      autocorrect: "1",
    });
    const opts: Record<string, unknown> = { headers: { "user-agent": UA } };
    if (this.dispatcher) opts.dispatcher = this.dispatcher;
    try {
      const res = await fetch(`${ENDPOINT}?${qs}`, opts as RequestInit);
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private static clean(raw: unknown): Tag[] {
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const out: Tag[] = [];
    for (const t of list as { name?: string; count?: number | string }[]) {
      const name = String(t?.name ?? "").trim().toLowerCase();
      const count = Number(t?.count ?? 0);
      if (!name || name.length > 40) continue;
      if (JUNK.test(name)) continue;
      if (count < MIN_COUNT) continue;
      out.push({ name, count });
    }
    return out.slice(0, 15);
  }

  trackTags(artist: string, track: string): Promise<Tag[]> {
    return this.schedule(async () => {
      const b = await this.call({ method: "track.gettoptags", artist, track });
      const top = (b?.toptags as { tag?: unknown } | undefined)?.tag;
      return LastFm.clean(top);
    });
  }

  artistTags(artist: string): Promise<Tag[]> {
    return this.schedule(async () => {
      const b = await this.call({ method: "artist.gettoptags", artist });
      const top = (b?.toptags as { tag?: unknown } | undefined)?.tag;
      return LastFm.clean(top);
    });
  }

  similarArtists(artist: string, limit = 30): Promise<string[]> {
    return this.schedule(async () => {
      const b = await this.call({ method: "artist.getsimilar", artist, limit: String(limit) });
      const raw = (b?.similarartists as { artist?: unknown } | undefined)?.artist;
      const list = Array.isArray(raw) ? raw : [];
      return (list as { name?: string }[]).map((a) => String(a?.name ?? "")).filter(Boolean);
    });
  }
}
