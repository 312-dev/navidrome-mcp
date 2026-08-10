/**
 * ListenBrainz listen-history ingest.
 *
 * Navidrome knows *how many* times a track has been played and *when it was last*
 * played -- but not the play history. ListenBrainz keeps every listen with a
 * timestamp, which is the only source that can answer "what does he actually put
 * on at 7am on a Tuesday". That question is the whole basis of the daylist.
 *
 * Reads are public: `/1/user/<name>/listens` needs no token, so the history can
 * be pulled with nothing secret in this process. The token is only needed for
 * *writing* listens, which Navidrome now does itself.
 */

export interface Listen {
  /** Unix seconds. */
  ts: number;
  artist: string;
  track: string;
  release?: string;
  /**
   * Which submitter sent this listen, from `additional_info.submission_client`.
   *
   * Carried purely so dedupeListens can tell one play reported twice from the
   * same track genuinely played twice. Undefined for listens submitted without
   * it, which are then never treated as a duplicate of anything.
   */
  client?: string;
}

const API = "https://api.listenbrainz.org/1";
const UA = "navidrome-mcp/1.0 (+https://github.com/312-dev/navidrome-mcp)";

/** Progress and warnings go to stderr; stdout is the MCP JSON-RPC channel. */
function log(msg: string): void {
  console.error(`[navidrome-mcp] ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Carries the status so a retry can tell throttling from a bad username. */
class LbHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number,
    body: string,
  ) {
    super(`ListenBrainz ${status}: ${body.slice(0, 200)}`);
  }
}

export class ListenBrainz {
  constructor(
    private readonly username: string,
    private readonly dispatcher?: unknown,
  ) {}

  private async get(url: string): Promise<Record<string, unknown>> {
    const opts: Record<string, unknown> = { headers: { "user-agent": UA } };
    if (this.dispatcher) opts.dispatcher = this.dispatcher;
    const res = await fetch(url, opts as RequestInit);
    if (!res.ok) {
      const after = Number(res.headers.get("retry-after") ?? 0);
      throw new LbHttpError(
        res.status,
        Number.isFinite(after) && after > 0 ? after * 1000 : 0,
        await res.text(),
      );
    }
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * Retry a page, honouring Retry-After when the server sends one.
   *
   * A 4xx that is not 429 is the caller's fault (a wrong username, a malformed
   * bound) and will fail identically on every attempt, so it is raised at once
   * rather than slept over.
   */
  private async getPage(url: string, attempts: number): Promise<Record<string, unknown>> {
    let backoff = 1000;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.get(url);
      } catch (e) {
        const status = e instanceof LbHttpError ? e.status : 0;
        const fatal = status >= 400 && status < 500 && status !== 429;
        if (fatal || attempt >= attempts) throw e;
        const wait = (e instanceof LbHttpError && e.retryAfterMs) || backoff;
        log(`listens: page failed (${String(e)}), retry ${attempt}/${attempts - 1} in ${wait}ms`);
        await sleep(wait);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  async listenCount(): Promise<number> {
    const b = await this.get(`${API}/user/${encodeURIComponent(this.username)}/listen-count`);
    const payload = b.payload as { count?: number } | undefined;
    return payload?.count ?? 0;
  }

  /**
   * Walk listens backwards from newest, stopping once we reach `since`.
   *
   * The API pages via `max_ts` (exclusive upper bound), 1000 per call, so a full
   * ~126k-listen history is ~127 requests. Incremental refreshes pass `since` and
   * normally stop after one.
   *
   * `truncated` reports that the walk gave up before reaching `since`. It exists
   * because the failure it describes is otherwise invisible: a throttled walk
   * returns a perfectly valid prefix of the history, and the caller cannot tell
   * a quarter of an account from all of a small one. That went unnoticed here
   * for months, leaving the index holding 32k of 126k listens.
   */
  async listens(opts: {
    since?: number;
    max?: number;
    attemptsPerPage?: number;
    onProgress?: (n: number) => void;
  } = {}): Promise<{ listens: Listen[]; truncated: boolean }> {
    const since = opts.since ?? 0;
    const max = opts.max ?? Infinity;
    const attempts = opts.attemptsPerPage ?? 5;
    const out: Listen[] = [];
    let maxTs: number | undefined;
    let truncated = false;

    for (let page = 0; page < 2000; page++) {
      const qs = new URLSearchParams({ count: "1000" });
      if (maxTs !== undefined) qs.set("max_ts", String(maxTs));
      let body: Record<string, unknown>;
      try {
        body = await this.getPage(
          `${API}/user/${encodeURIComponent(this.username)}/listens?${qs}`,
          attempts,
        );
      } catch (e) {
        // Every retry is spent. Partial history is still worth keeping, but the
        // caller is told so it can say so rather than treat this as a full sync.
        log(`listens: giving up after ${out.length} listens, history is INCOMPLETE (${String(e)})`);
        truncated = true;
        break;
      }
      const payload = body.payload as { listens?: unknown[] } | undefined;
      const rows = (payload?.listens ?? []) as {
        listened_at: number;
        track_metadata?: {
          artist_name?: string;
          track_name?: string;
          release_name?: string;
          additional_info?: { submission_client?: string };
        };
      }[];
      if (!rows.length) break;

      let oldest = Number.POSITIVE_INFINITY;
      let hitFloor = false;
      for (const r of rows) {
        const ts = Number(r.listened_at);
        if (!Number.isFinite(ts)) continue;
        oldest = Math.min(oldest, ts);
        if (ts <= since) {
          hitFloor = true;
          continue;
        }
        const m = r.track_metadata ?? {};
        if (!m.artist_name || !m.track_name) continue;
        out.push({
          ts,
          artist: m.artist_name,
          track: m.track_name,
          release: m.release_name,
          client: m.additional_info?.submission_client,
        });
      }
      opts.onProgress?.(out.length);
      if (hitFloor || out.length >= max || !Number.isFinite(oldest)) break;
      maxTs = oldest; // exclusive, so this makes progress even on ties
    }
    return {
      listens: out.slice(0, Number.isFinite(max) ? max : undefined),
      truncated,
    };
  }
}

/**
 * How far apart two reports of the same play can sit.
 *
 * Measured on this account over 4,000 listens in June to August 2026: every one
 * of the 1,100 cross-submitter pairs within ten minutes was the Last.fm importer
 * against a direct submitter, offset by a median of 219 seconds (p10 142, p90
 * 306). The cause is a difference in what the timestamp means. Last.fm stamps a
 * scrobble when it is submitted, roughly halfway through the track; a direct
 * submitter stamps it at playback start.
 *
 * 360 covers p90 with room to spare while staying under the interval at which a
 * genuine repeat of the same track becomes plausible.
 */
export const DUPLICATE_WINDOW_SEC = 360;

/**
 * Collapse one play reported by two different submitters.
 *
 * Scrobbling to both Last.fm and ListenBrainz, then also running ListenBrainz's
 * Last.fm importer, delivers every play twice. On this account that inflated
 * roughly a quarter of recent listens, which reads straight through to
 * `listen_count` and to anything ranking by it.
 *
 * The rule is deliberately narrow: two listens collapse only when a DIFFERENT
 * submitter reported them. Same-submitter pairs are always kept, because that is
 * what a track genuinely played twice looks like, and the two cases are
 * indistinguishable by timestamp alone at this window. On the measured sample
 * that split was 984 cross-submitter against 38 same-submitter, so treating the
 * window alone as proof of duplication would have discarded real listens.
 *
 * The earlier timestamp survives, being the one that means "playback started".
 */
export function dedupeListens(listens: Listen[]): { kept: Listen[]; dropped: number } {
  const sorted = [...listens].sort(
    (a, b) => a.ts - b.ts || (a.client ?? "").localeCompare(b.client ?? ""),
  );
  const recent = new Map<string, Listen[]>();
  const kept: Listen[] = [];

  for (const l of sorted) {
    const key = `${norm(l.artist)}\u0000${norm(l.track)}`;
    const seen = (recent.get(key) ?? []).filter((p) => l.ts - p.ts <= DUPLICATE_WINDOW_SEC);
    // Undefined on either side means we cannot attribute the two reports, so the
    // listen is kept. Dropping on an unknown submitter would silently delete
    // real repeat plays from any source that omits the field.
    if (seen.some((p) => !!p.client && !!l.client && p.client !== l.client)) {
      recent.set(key, seen);
      continue;
    }
    seen.push(l);
    recent.set(key, seen);
    kept.push(l);
  }
  return { kept, dropped: listens.length - kept.length };
}

/** Normalisation key used to join ListenBrainz rows onto library tracks. */
export function matchKey(artist: string, track: string): string {
  return `${norm(artist)}\u0000${norm(track)}`;
}

/**
 * Fold a title down to something that survives the differences between what a
 * scrobble says and what the file's tags say: remaster/version suffixes, feature
 * credits, punctuation and case. Deliberately aggressive -- a false join between
 * two tracks by the same artist costs far less here than missing the join, since
 * the result only ever feeds ranking signals.
 */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\((feat|ft|with)\.?[^)]*\)/g, "")
    .replace(/\[(feat|ft|with)\.?[^\]]*\]/g, "")
    .replace(/\s-\s.*(remaster|remastered|mix|version|edit|mono|stereo|live).*$/g, "")
    .replace(/\((\d{4}\s+)?(remaster|remastered|mono|stereo)[^)]*\)/g, "")
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Artists as scrobbled can be "A • B" or "A feat. B"; take the primary. */
export function primaryArtist(s: string): string {
  return norm(
    s
      .split(/\s*[•;]\s*|\s*&\s*|\s+(?:feat|ft|with)\.?\s+|\s*,\s*/i)[0] ?? s,
  );
}
