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

/**
 * Requests left in the window before we stop and wait it out.
 *
 * ListenBrainz publishes its budget on every response as X-RateLimit-Limit,
 * -Remaining and -Reset-In (observed: 30 requests per 5 seconds). Overrunning it
 * does not produce a 429. The server stalls responses, first to seconds and then
 * to tens of seconds, and eventually closes the connection outright
 * (UND_ERR_SOCKET, "other side closed"). A walk that ignores the budget
 * therefore looks like it is working right up until it dies.
 *
 * Two spare requests is enough to absorb a response that arrives after the
 * window we based the decision on has already turned over.
 */
const RATE_LIMIT_HEADROOM = 2;

export class ListenBrainz {
  /** Budget from the most recent response. See RATE_LIMIT_HEADROOM. */
  private rlRemaining = Number.POSITIVE_INFINITY;
  private rlResetInMs = 0;

  constructor(
    private readonly username: string,
    private readonly dispatcher?: unknown,
  ) {}

  private async get(url: string): Promise<Record<string, unknown>> {
    const opts: Record<string, unknown> = { headers: { "user-agent": UA } };
    if (this.dispatcher) opts.dispatcher = this.dispatcher;
    const res = await fetch(url, opts as RequestInit);

    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const resetIn = Number(res.headers.get("x-ratelimit-reset-in"));
    if (Number.isFinite(remaining)) this.rlRemaining = remaining;
    if (Number.isFinite(resetIn) && resetIn >= 0) this.rlResetInMs = resetIn * 1000;

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
   * Wait out the window when the published budget is nearly spent.
   *
   * Cheap by construction: at 30 requests per 5 seconds a full 127-page history
   * costs about 20 seconds of waiting in total, against a walk that previously
   * spent 20 seconds on a SINGLE stalled page before dying.
   */
  private async pace(): Promise<void> {
    if (this.rlRemaining > RATE_LIMIT_HEADROOM || this.rlResetInMs <= 0) return;
    await sleep(this.rlResetInMs + 250);
    // Assume the window turned over. The next response corrects this either way.
    this.rlRemaining = Number.POSITIVE_INFINITY;
  }

  /**
   * Retry a page, honouring Retry-After when the server sends one.
   *
   * A 4xx that is not 429 is the caller's fault (a wrong username, a malformed
   * bound) and will fail identically on every attempt, so it is raised at once
   * rather than slept over.
   *
   * The floor of one rate-limit window matters. The failure seen in practice is
   * a dropped socket after overrunning the budget, and retrying inside the same
   * window just spends what is left of it: four retries at 1, 2, 4 and 8 seconds
   * all failed that way. Waiting for the window to turn over recovers, and the
   * error's cause is logged because "fetch failed" alone hid this for a whole
   * diagnosis.
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
        const cause = (e as { cause?: { code?: string; message?: string } }).cause;
        const wait = Math.max(
          (e instanceof LbHttpError && e.retryAfterMs) || backoff,
          this.rlResetInMs + 250,
        );
        log(
          `listens: page failed (${String(e)}${cause?.code ? `, ${cause.code}` : ""}), ` +
            `retry ${attempt}/${attempts - 1} in ${wait}ms`,
        );
        await sleep(wait);
        this.rlRemaining = Number.POSITIVE_INFINITY;
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
   *
   * `startBefore` seeds the walk somewhere other than the newest listen, which
   * is what makes a truncated walk resumable: the caller passes the oldest
   * listen it already holds and the next attempt continues from there. Without
   * it every retry restarts at the top and re-fetches what it has, which is why
   * the truncation above was not merely a failure but a permanent one.
   *
   * `reachedEnd` distinguishes "the account has no more listens" from "we
   * stopped because we hit `since`". Only the former means the history is whole.
   */
  async listens(opts: {
    since?: number;
    startBefore?: number;
    max?: number;
    attemptsPerPage?: number;
    onProgress?: (n: number) => void;
  } = {}): Promise<{ listens: Listen[]; truncated: boolean; reachedEnd: boolean }> {
    const since = opts.since ?? 0;
    const max = opts.max ?? Infinity;
    const attempts = opts.attemptsPerPage ?? 5;
    const out: Listen[] = [];
    let maxTs: number | undefined = opts.startBefore;
    let truncated = false;
    let reachedEnd = false;

    for (let page = 0; page < 2000; page++) {
      const qs = new URLSearchParams({ count: "1000" });
      if (maxTs !== undefined) qs.set("max_ts", String(maxTs));
      let body: Record<string, unknown>;
      try {
        await this.pace();
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
      if (!rows.length) {
        reachedEnd = true;
        break;
      }

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
      reachedEnd,
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
