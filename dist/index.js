#!/usr/bin/env node

// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { socksDispatcher } from "fetch-socks";
import { z } from "zod";

// src/listenbrainz.ts
var API = "https://api.listenbrainz.org/1";
var UA = "navidrome-mcp/1.0 (+https://github.com/312-dev/navidrome-mcp)";
function log(msg) {
  console.error(`[navidrome-mcp] ${msg}`);
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var LbHttpError = class extends Error {
  constructor(status, retryAfterMs, body) {
    super(`ListenBrainz ${status}: ${body.slice(0, 200)}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
  status;
  retryAfterMs;
};
var RATE_LIMIT_HEADROOM = 2;
var ListenBrainz = class {
  constructor(username, dispatcher2) {
    this.username = username;
    this.dispatcher = dispatcher2;
  }
  username;
  dispatcher;
  /** Budget from the most recent response. See RATE_LIMIT_HEADROOM. */
  rlRemaining = Number.POSITIVE_INFINITY;
  rlResetInMs = 0;
  async get(url) {
    const opts = { headers: { "user-agent": UA } };
    if (this.dispatcher) opts.dispatcher = this.dispatcher;
    const res = await fetch(url, opts);
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const resetIn = Number(res.headers.get("x-ratelimit-reset-in"));
    if (Number.isFinite(remaining)) this.rlRemaining = remaining;
    if (Number.isFinite(resetIn) && resetIn >= 0) this.rlResetInMs = resetIn * 1e3;
    if (!res.ok) {
      const after = Number(res.headers.get("retry-after") ?? 0);
      throw new LbHttpError(
        res.status,
        Number.isFinite(after) && after > 0 ? after * 1e3 : 0,
        await res.text()
      );
    }
    return await res.json();
  }
  /**
   * Wait out the window when the published budget is nearly spent.
   *
   * Cheap by construction: at 30 requests per 5 seconds a full 127-page history
   * costs about 20 seconds of waiting in total, against a walk that previously
   * spent 20 seconds on a SINGLE stalled page before dying.
   */
  async pace() {
    if (this.rlRemaining > RATE_LIMIT_HEADROOM || this.rlResetInMs <= 0) return;
    await sleep(this.rlResetInMs + 250);
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
  async getPage(url, attempts) {
    let backoff = 1e3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.get(url);
      } catch (e) {
        const status = e instanceof LbHttpError ? e.status : 0;
        const fatal = status >= 400 && status < 500 && status !== 429;
        if (fatal || attempt >= attempts) throw e;
        const cause = e.cause;
        const wait = Math.max(
          e instanceof LbHttpError && e.retryAfterMs || backoff,
          this.rlResetInMs + 250
        );
        log(
          `listens: page failed (${String(e)}${cause?.code ? `, ${cause.code}` : ""}), retry ${attempt}/${attempts - 1} in ${wait}ms`
        );
        await sleep(wait);
        this.rlRemaining = Number.POSITIVE_INFINITY;
        backoff = Math.min(backoff * 2, 3e4);
      }
    }
  }
  async listenCount() {
    const b = await this.get(`${API}/user/${encodeURIComponent(this.username)}/listen-count`);
    const payload = b.payload;
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
  async listens(opts = {}) {
    const since = opts.since ?? 0;
    const max = opts.max ?? Infinity;
    const attempts = opts.attemptsPerPage ?? 5;
    const out = [];
    let maxTs = opts.startBefore;
    let truncated = false;
    let reachedEnd = false;
    for (let page = 0; page < 2e3; page++) {
      const qs = new URLSearchParams({ count: "1000" });
      if (maxTs !== void 0) qs.set("max_ts", String(maxTs));
      let body;
      try {
        await this.pace();
        body = await this.getPage(
          `${API}/user/${encodeURIComponent(this.username)}/listens?${qs}`,
          attempts
        );
      } catch (e) {
        log(`listens: giving up after ${out.length} listens, history is INCOMPLETE (${String(e)})`);
        truncated = true;
        break;
      }
      const payload = body.payload;
      const rows = payload?.listens ?? [];
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
          client: m.additional_info?.submission_client
        });
      }
      opts.onProgress?.(out.length);
      if (hitFloor || out.length >= max || !Number.isFinite(oldest)) break;
      maxTs = oldest;
    }
    return {
      listens: out.slice(0, Number.isFinite(max) ? max : void 0),
      truncated,
      reachedEnd
    };
  }
};
var DUPLICATE_WINDOW_SEC = 360;
function dedupeListens(listens) {
  const sorted = [...listens].sort(
    (a, b) => a.ts - b.ts || (a.client ?? "").localeCompare(b.client ?? "")
  );
  const recent = /* @__PURE__ */ new Map();
  const kept = [];
  for (const l of sorted) {
    const key = `${norm(l.artist)}\0${norm(l.track)}`;
    const seen = (recent.get(key) ?? []).filter((p) => l.ts - p.ts <= DUPLICATE_WINDOW_SEC);
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
function matchKey(artist, track) {
  return `${norm(artist)}\0${norm(track)}`;
}
function norm(s) {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\((feat|ft|with)\.?[^)]*\)/g, "").replace(/\[(feat|ft|with)\.?[^\]]*\]/g, "").replace(/\s-\s.*(remaster|remastered|mix|version|edit|mono|stereo|live).*$/g, "").replace(/\((\d{4}\s+)?(remaster|remastered|mono|stereo)[^)]*\)/g, "").replace(/[‘’“”]/g, "'").replace(/[^a-z0-9]+/g, " ").trim();
}
function primaryArtist(s) {
  return norm(
    s.split(/\s*[•;]\s*|\s*&\s*|\s+(?:feat|ft|with)\.?\s+|\s*,\s*/i)[0] ?? s
  );
}

// src/vocabulary.ts
var MOOD_VOCABULARY = [
  "serene",
  "tender",
  "gentle",
  "warm",
  "mellow",
  "pastoral",
  "intimate",
  "hushed",
  "dreamy",
  "melancholy",
  "mournful",
  "lonesome",
  "bleak",
  "weary",
  "wistful",
  "sunny",
  "sweet",
  "playful",
  "breezy",
  "groovy",
  "funky",
  "swinging",
  "jaunty",
  "moody",
  "brooding",
  "tense",
  "restless",
  "smouldering",
  "defiant",
  "euphoric",
  "exuberant",
  "triumphant",
  "anthemic",
  "driving",
  "danceable",
  "aggressive",
  "furious",
  "menacing",
  "frantic",
  "savage",
  "heavy",
  "gritty",
  "fuzzy",
  "glossy",
  "shimmering",
  "pulsing",
  "cold",
  "sparse",
  "lush",
  "raucous",
  "hypnotic",
  "stark"
];
var CANON = new Set(MOOD_VOCABULARY);
var SYNONYMS = {
  angry: "furious",
  ferocious: "furious",
  enraged: "furious",
  abrasive: "aggressive",
  violent: "aggressive",
  punishing: "aggressive",
  sinister: "menacing",
  ominous: "menacing",
  dark: "menacing",
  crushing: "heavy",
  pounding: "heavy",
  thunderous: "heavy",
  "bass-heavy": "heavy",
  raw: "gritty",
  scrappy: "gritty",
  rough: "gritty",
  distorted: "fuzzy",
  saturated: "fuzzy",
  slick: "glossy",
  polished: "glossy",
  sleek: "glossy",
  clean: "glossy",
  sparkling: "shimmering",
  glistening: "shimmering",
  twinkling: "shimmering",
  throbbing: "pulsing",
  pumping: "pulsing",
  motorik: "pulsing",
  icy: "cold",
  clinical: "cold",
  detached: "cold",
  minimal: "sparse",
  skeletal: "sparse",
  spare: "sparse",
  layered: "lush",
  orchestral: "lush",
  symphonic: "lush",
  widescreen: "lush",
  rowdy: "raucous",
  boisterous: "raucous",
  unruly: "raucous",
  trancey: "hypnotic",
  looping: "hypnotic",
  droning: "hypnotic",
  bare: "stark",
  austere: "stark",
  calm: "serene",
  peaceful: "serene",
  tranquil: "serene",
  still: "serene",
  soft: "gentle",
  delicate: "gentle",
  fragile: "gentle",
  cosy: "warm",
  cozy: "warm",
  comforting: "warm",
  laidback: "mellow",
  "laid-back": "mellow",
  chill: "mellow",
  relaxed: "mellow",
  rustic: "pastoral",
  folksy: "pastoral",
  bucolic: "pastoral",
  quiet: "hushed",
  whispered: "hushed",
  hazy: "dreamy",
  ethereal: "dreamy",
  woozy: "dreamy",
  floaty: "dreamy",
  sad: "melancholy",
  sorrowful: "melancholy",
  downcast: "melancholy",
  grieving: "mournful",
  elegiac: "mournful",
  funereal: "mournful",
  desolate: "bleak",
  barren: "bleak",
  grim: "bleak",
  tired: "weary",
  resigned: "weary",
  worn: "weary",
  yearning: "wistful",
  longing: "wistful",
  nostalgic: "wistful",
  bright: "sunny",
  cheerful: "sunny",
  upbeat: "sunny",
  charming: "sweet",
  endearing: "sweet",
  romantic: "sweet",
  whimsical: "playful",
  cheeky: "playful",
  giddy: "playful",
  breezily: "breezy",
  carefree: "breezy",
  easygoing: "breezy",
  soulful: "groovy",
  "in-the-pocket": "groovy",
  syncopated: "funky",
  strutting: "funky",
  swung: "swinging",
  jazzy: "swinging",
  jolly: "jaunty",
  sprightly: "jaunty",
  overcast: "moody",
  sullen: "moody",
  introspective: "moody",
  simmering: "brooding",
  ominously: "brooding",
  anxious: "tense",
  uneasy: "tense",
  nervy: "tense",
  agitated: "restless",
  jittery: "restless",
  antsy: "restless",
  sultry: "smouldering",
  smoldering: "smouldering",
  seductive: "smouldering",
  rebellious: "defiant",
  confrontational: "defiant",
  swaggering: "defiant",
  ecstatic: "euphoric",
  rapturous: "euphoric",
  blissful: "euphoric",
  joyful: "exuberant",
  jubilant: "exuberant",
  celebratory: "exuberant",
  victorious: "triumphant",
  heroic: "triumphant",
  soaring: "triumphant",
  singalong: "anthemic",
  stadium: "anthemic",
  rousing: "anthemic",
  propulsive: "driving",
  insistent: "driving",
  motoring: "driving",
  clubby: "danceable",
  "club-ready": "danceable",
  dancey: "danceable",
  party: "danceable",
  chaotic: "frantic",
  breakneck: "frantic",
  manic: "frantic",
  brutal: "savage",
  vicious: "savage",
  feral: "savage"
};
function canonicalise(raw) {
  const w = raw.trim().toLowerCase();
  if (CANON.has(w)) return w;
  if (SYNONYMS[w]) return SYNONYMS[w];
  const squashed = w.replace(/[\s_]+/g, "-");
  if (CANON.has(squashed)) return squashed;
  if (SYNONYMS[squashed]) return SYNONYMS[squashed];
  return null;
}
var VIBE_SCHEDULE = {
  "wind down": { hours: [21, 22, 23, 0, 1], gloss: "settling toward sleep" },
  "slow morning": { hours: [5, 6, 7, 8, 9], gloss: "easing into the day" },
  "focus": { hours: [9, 10, 11, 14, 15, 16], gloss: "steady, undemanding, stays out of the way" },
  "background": { hours: [11, 12, 13, 14], gloss: "pleasant and unobtrusive" },
  "uplift": { hours: [8, 9, 10, 16, 17], gloss: "a deliberate lift in mood" },
  "workout": { hours: [6, 7, 17, 18, 19], gloss: "sustained physical push" },
  "hype": { hours: [20, 21, 22], gloss: "getting up for something" },
  "driving": { hours: [8, 9, 16, 17, 18], gloss: "motion; miles passing" },
  "golden hour": { hours: [17, 18, 19], gloss: "warm light, day easing off" },
  "late night": { hours: [23, 0, 1, 2, 3, 4], gloss: "after hours; low light" },
  "melancholy": { hours: [21, 22, 23], gloss: "sitting with something sad" },
  "heavy": { hours: [15, 16, 17, 21, 22], gloss: "loud, dark and physical" },
  "dinner": { hours: [18, 19, 20], gloss: "convivial but not competing with conversation" },
  "party": { hours: [20, 21, 22, 23], gloss: "a room full of people" }
};
var VIBE_NAMES = Object.keys(VIBE_SCHEDULE);

// src/daylist.ts
var PART_OF_DAY = [
  [5, "late night"],
  [8, "early morning"],
  [11, "morning"],
  [14, "midday"],
  [17, "afternoon"],
  [20, "evening"],
  [23, "night"],
  [24, "late night"]
];
var DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function timeContext(tz, at = /* @__PURE__ */ new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
    weekday: "short",
    month: "numeric"
  }).formatToParts(at);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[get("weekday")] ?? 0;
  const month = Number(get("month"));
  const season = month <= 2 || month === 12 ? "winter" : month <= 5 ? "spring" : month <= 8 ? "summer" : "autumn";
  const part = PART_OF_DAY.find(([h]) => hour < h)?.[1] ?? "night";
  return {
    iso: at.toISOString(),
    timezone: tz,
    hour,
    dayOfWeek: dow,
    dayName: DAY_NAMES[dow],
    isWeekend: dow === 0 || dow === 6,
    partOfDay: part,
    season
  };
}
function hourWindow(hour, spread = 1) {
  const out = [];
  for (let d = -spread; d <= spread; d++) out.push((hour + d + 24) % 24);
  return out;
}
function vibeFits(store2, hour, spread = 1) {
  const window = new Set(hourWindow(hour, spread));
  const windowShare = window.size / 24;
  const members = /* @__PURE__ */ new Map();
  for (const t of store2.tracks) {
    for (const v of t.mood?.vibes ?? []) {
      const arr = members.get(v);
      if (arr) arr.push(t);
      else members.set(v, [t]);
    }
  }
  const out = [];
  for (const [vibe, def] of Object.entries(VIBE_SCHEDULE)) {
    const tracks = members.get(vibe) ?? [];
    let inWindow = 0;
    let totalListens = 0;
    const artistCounts = /* @__PURE__ */ new Map();
    for (const t of tracks) {
      if (!t.listens) continue;
      totalListens += t.listens;
      for (const h of window) inWindow += t.hourHist[h] ?? 0;
      artistCounts.set(t.artist, (artistCounts.get(t.artist) ?? 0) + t.listens);
    }
    out.push({
      vibe,
      gloss: def.gloss,
      tracks: tracks.length,
      listens_in_window: inWindow,
      lift: totalListens ? Number((inWindow / totalListens / windowShare).toFixed(2)) : null,
      suits_hour: def.hours.includes(hour),
      top_artists: [...artistCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a]) => a)
    });
  }
  return out.sort((a, b) => {
    if (a.lift !== null && b.lift !== null) return b.lift - a.lift;
    if (a.lift !== null) return -1;
    if (b.lift !== null) return 1;
    if (a.suits_hour !== b.suits_hour) return a.suits_hour ? -1 : 1;
    return b.tracks - a.tracks;
  });
}
function hourProfile(store2, hour, spread = 1) {
  const window = new Set(hourWindow(hour, spread));
  const artists = /* @__PURE__ */ new Map();
  const genres = /* @__PURE__ */ new Map();
  const tags = /* @__PURE__ */ new Map();
  const years = [];
  let total = 0;
  for (const t of store2.tracks) {
    if (!t.hourHist.length) continue;
    let n = 0;
    for (const h of window) n += t.hourHist[h] ?? 0;
    if (!n) continue;
    total += n;
    artists.set(t.artist, (artists.get(t.artist) ?? 0) + n);
    for (const g of t.genres) genres.set(g, (genres.get(g) ?? 0) + n);
    for (const tg of t.tags.slice(0, 5)) tags.set(tg.name, (tags.get(tg.name) ?? 0) + n);
    if (t.year) for (let i = 0; i < Math.min(n, 5); i++) years.push(t.year);
  }
  years.sort((a, b) => a - b);
  const top = (m, key, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ [key]: k, [key === "tag" ? "weight" : "listens"]: v }));
  return {
    listens_in_window: total,
    top_artists: top(artists, "artist", 15),
    top_genres: top(genres, "genre", 8),
    top_tags: top(tags, "tag", 15),
    median_year: years.length ? years[Math.floor(years.length / 2)] : null
  };
}
function recentActivity(store2, days = 7) {
  const cutoff = Math.floor(Date.now() / 1e3) - days * 86400;
  const artists = /* @__PURE__ */ new Map();
  const tracks = /* @__PURE__ */ new Set();
  let n = 0;
  for (let i = store2.listens.length - 1; i >= 0; i--) {
    const l = store2.listens[i];
    if (l.ts < cutoff) break;
    n++;
    artists.set(l.artist, (artists.get(l.artist) ?? 0) + 1);
    tracks.add(`${primaryArtist(l.artist)}|${norm(l.track)}`);
  }
  return {
    listens: n,
    distinct_tracks: tracks.size,
    top_artists: [...artists.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([artist, listens]) => ({ artist, listens }))
  };
}
function rediscoveries(store2, minListens = 5, quietDays = 365, limit = 30) {
  const cutoff = Math.floor(Date.now() / 1e3) - quietDays * 86400;
  return store2.tracks.filter((t) => !t.missing && t.listens >= minListens && t.lastListen && t.lastListen < cutoff).sort((a, b) => b.listens - a.listens).slice(0, limit);
}

// src/navidrome.ts
import { createHash, randomBytes } from "crypto";
var NavidromeError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "NavidromeError";
  }
  status;
};
var Navidrome = class {
  constructor(opts) {
    this.opts = opts;
    this.clientName = opts.clientName ?? "navidrome-mcp";
    if (!opts.baseUrl) throw new NavidromeError("NAVIDROME_URL is not set");
    if (!opts.username || !opts.password) {
      throw new NavidromeError("NAVIDROME_USERNAME / NAVIDROME_PASSWORD are not set");
    }
  }
  opts;
  session = null;
  loginInFlight = null;
  clientName;
  get base() {
    return this.opts.baseUrl.replace(/\/+$/, "");
  }
  async fetch(url, init = {}) {
    const opts = { ...init };
    if (this.opts.dispatcher) opts.dispatcher = this.opts.dispatcher;
    return fetch(url, opts);
  }
  // ── auth ────────────────────────────────────────────────────────────────
  /**
   * Navidrome's JWT is short-lived and is normally refreshed by echoing the
   * rotated token from the `x-nd-authorization` response header. This server is
   * long-running but low-traffic, so instead of tracking rotation we simply
   * re-login whenever a call comes back 401. Cheap and impossible to get wrong.
   */
  async login() {
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = (async () => {
      const res = await this.fetch(`${this.base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: this.opts.username,
          password: this.opts.password
        })
      });
      if (!res.ok) {
        throw new NavidromeError(
          `Navidrome login failed (${res.status}). Check NAVIDROME_USERNAME/PASSWORD.`,
          res.status
        );
      }
      const body = await res.json();
      const s = {
        jwt: String(body.token),
        userId: String(body.id),
        subsonicSalt: String(body.subsonicSalt ?? ""),
        subsonicToken: String(body.subsonicToken ?? ""),
        isAdmin: Boolean(body.isAdmin),
        obtainedAt: Date.now()
      };
      this.session = s;
      return s;
    })().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }
  async session_() {
    if (this.session) return this.session;
    return this.login();
  }
  async whoami() {
    const s = await this.session_();
    return { userId: s.userId, username: this.opts.username, isAdmin: s.isAdmin };
  }
  // ── native REST API ─────────────────────────────────────────────────────
  /** One native-API call, retrying once through a fresh login on 401. */
  async ndRaw(method, path, query, body, retry = true) {
    const s = await this.session_();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== void 0 && v !== null) qs.set(k, String(v));
    }
    const url = `${this.base}/api/${path}${qs.toString() ? `?${qs}` : ""}`;
    const res = await this.fetch(url, {
      method,
      headers: {
        "x-nd-authorization": `Bearer ${s.jwt}`,
        ...body !== void 0 ? { "content-type": "application/json" } : {}
      },
      ...body !== void 0 ? { body: JSON.stringify(body) } : {}
    });
    if (res.status === 401 && retry) {
      this.session = null;
      await this.login();
      return this.ndRaw(method, path, query, body, false);
    }
    return { status: res.status, headers: res.headers, text: await res.text() };
  }
  async nd(method, path, query, body) {
    const { status, headers, text } = await this.ndRaw(method, path, query, body);
    if (status < 200 || status >= 300) {
      throw new NavidromeError(
        `Navidrome ${method} /api/${path} failed (${status}): ${text.slice(0, 300)}`,
        status
      );
    }
    const totalHeader = headers.get("x-total-count");
    const total = totalHeader ? Number(totalHeader) : null;
    let data;
    try {
      data = text ? JSON.parse(text) : void 0;
    } catch {
      data = text;
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
  async ndAll(path, query = {}, pageSize = 500, onProgress) {
    const out = [];
    let start = 0;
    for (; ; ) {
      const { data } = await this.nd("GET", path, {
        ...query,
        _start: start,
        _end: start + pageSize
      });
      const chunk = Array.isArray(data) ? data : [];
      out.push(...chunk);
      onProgress?.(out.length);
      if (chunk.length < pageSize) break;
      start += pageSize;
      if (start > 5e5) break;
    }
    return out;
  }
  // ── convenience wrappers ────────────────────────────────────────────────
  allSongs(onProgress) {
    return this.ndAll("song", {}, 500, onProgress);
  }
  async listPlaylists() {
    return this.ndAll("playlist", {}, 200);
  }
  /**
   * Tracks in a playlist.
   *
   * Rows come back with `id` set to the *positional* entry id ("1", "2", ...) and
   * the real media file id under `mediaFileId`. Callers want the latter, so it is
   * normalised into `id` here and the positional one preserved as `entryId`.
   */
  async playlistTracks(id) {
    const rows = await this.ndAll(
      `playlist/${encodeURIComponent(id)}/tracks`,
      {},
      500
    );
    return rows.map((r) => ({
      ...r,
      entryId: String(r.id),
      id: String(r.mediaFileId ?? r.id)
    }));
  }
  async createPlaylist(input) {
    const { data } = await this.nd("POST", "playlist", void 0, {
      name: input.name,
      comment: input.comment ?? "",
      public: input.public ?? false,
      ...input.rules ? { rules: input.rules } : {}
    });
    if (!data?.id) throw new NavidromeError("Navidrome did not return a playlist id");
    return data.id;
  }
  async updatePlaylist(id, patch) {
    await this.nd("PUT", `playlist/${encodeURIComponent(id)}`, void 0, patch);
  }
  async deletePlaylist(id) {
    await this.nd("DELETE", `playlist/${encodeURIComponent(id)}`);
  }
  async addTracks(playlistId, trackIds) {
    let added = 0;
    for (let i = 0; i < trackIds.length; i += 200) {
      const slice = trackIds.slice(i, i + 200);
      const { data } = await this.nd(
        "POST",
        `playlist/${encodeURIComponent(playlistId)}/tracks`,
        void 0,
        { ids: slice }
      );
      added += data?.added ?? slice.length;
    }
    return added;
  }
  /** Remove every track from a playlist, leaving the playlist itself in place. */
  async clearTracks(playlistId) {
    let removed = 0;
    for (let guard = 0; guard < 1e3; guard++) {
      const { data } = await this.nd("GET", `playlist/${encodeURIComponent(playlistId)}/tracks`, {
        _start: 0,
        _end: 200
      });
      const n = Array.isArray(data) ? data.length : 0;
      if (n === 0) break;
      const qs = new URLSearchParams();
      for (let i = 1; i <= n; i++) qs.append("id", String(i));
      await this.ndRaw(
        "DELETE",
        `playlist/${encodeURIComponent(playlistId)}/tracks?${qs.toString()}`
      );
      removed += n;
    }
    return removed;
  }
  /** Replace a playlist's contents wholesale. */
  async replaceTracks(playlistId, trackIds) {
    await this.clearTracks(playlistId);
    return this.addTracks(playlistId, trackIds);
  }
  // ── Subsonic API ────────────────────────────────────────────────────────
  async subsonicUrl(view, params = {}) {
    await this.session_();
    const salt = randomBytes(8).toString("hex");
    const token = createHash("md5").update(this.opts.password + salt).digest("hex");
    const qs = new URLSearchParams({
      u: this.opts.username,
      t: token,
      s: salt,
      v: "1.16.1",
      c: this.clientName,
      f: "json"
    });
    for (const [k, v] of Object.entries(params)) {
      if (v !== void 0 && v !== null) qs.set(k, String(v));
    }
    return `${this.base}/rest/${view}?${qs}`;
  }
  async subsonic(view, params = {}) {
    const url = await this.subsonicUrl(view, params);
    const res = await this.fetch(url);
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new NavidromeError(`Subsonic ${view}: unparseable response: ${text.slice(0, 200)}`);
    }
    const r = body["subsonic-response"];
    if (!r) throw new NavidromeError(`Subsonic ${view}: missing subsonic-response`);
    if (r.status === "failed") {
      const err = r.error;
      throw new NavidromeError(`Subsonic ${view} failed: ${err?.message ?? "unknown"}`, err?.code);
    }
    return r;
  }
  /** Similar songs for an artist/track id, via the configured agent chain. */
  async similarSongs(id, count = 30) {
    const r = await this.subsonic(
      "getSimilarSongs2.view",
      { id, count }
    );
    return r.similarSongs2?.song ?? [];
  }
  async artistInfo(id, count = 20) {
    const r = await this.subsonic("getArtistInfo2.view", { id, count });
    return {
      biography: r.artistInfo2?.biography,
      similarArtist: r.artistInfo2?.similarArtist ?? []
    };
  }
  async topSongs(artistName, count = 20) {
    const r = await this.subsonic("getTopSongs.view", {
      artist: artistName,
      count
    });
    return r.topSongs?.song ?? [];
  }
  async ping() {
    return this.subsonic("ping.view");
  }
};

// src/query.ts
var DAY_MS = 864e5;
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function anyMatch(hay, needles) {
  if (!needles.length) return true;
  const set = new Set(needles.map((n) => n.toLowerCase()));
  return hay.some((h) => set.has(h.toLowerCase()));
}
function containsAny(hay, needles) {
  const h = norm(hay);
  return needles.some((n) => h.includes(norm(n)));
}
function wantedMoods(raw) {
  return raw.map((r) => canonicalise(r) ?? r.trim().toLowerCase());
}
function search(store2, p) {
  const now = Date.now();
  const nowSec = Math.floor(now / 1e3);
  const excluded = new Set(p.exclude_track_ids ?? []);
  const rotation = p.exclude_recent_runs;
  if (rotation?.playlist && rotation.runs > 0) {
    for (const id of store2.recentRunTrackIds(rotation.playlist, rotation.runs)) excluded.add(id);
  }
  const qTerms = p.query ? norm(p.query).split(" ").filter(Boolean) : [];
  const decadeSet = new Set(
    (p.decades ?? []).map((d) => Number(String(d).replace(/[^0-9]/g, ""))).filter(Boolean)
  );
  const releasedAfter = p.released_after ? Date.parse(p.released_after) : NaN;
  const releasedBefore = p.released_before ? Date.parse(p.released_before) : NaN;
  const wantMoods = p.moods?.length ? wantedMoods(p.moods) : void 0;
  const banMoods = p.exclude_moods?.length ? wantedMoods(p.exclude_moods) : void 0;
  const out = [];
  for (const t of store2.tracks) {
    if (!p.include_missing && t.missing) continue;
    if (excluded.has(t.id)) continue;
    if (qTerms.length) {
      const hay = `${norm(t.title)} ${norm(t.artist)} ${norm(t.album)} ${t.tags.map((x) => x.name).join(" ")}`;
      if (!qTerms.every((term) => hay.includes(term))) continue;
    }
    if (p.artists?.length && !containsAny(t.artist, p.artists) && !containsAny(t.albumArtist, p.artists)) continue;
    if (p.exclude_artists?.length && (containsAny(t.artist, p.exclude_artists) || containsAny(t.albumArtist, p.exclude_artists))) continue;
    if (p.albums?.length && !containsAny(t.album, p.albums)) continue;
    if (p.genres?.length && !anyMatch(t.genres, p.genres)) continue;
    if (p.exclude_genres?.length && anyMatch(t.genres, p.exclude_genres)) continue;
    if (p.vibes?.length && !anyMatch(t.vibes, p.vibes)) continue;
    if (p.exclude_vibes?.length && anyMatch(t.vibes, p.exclude_vibes)) continue;
    if (p.tags?.length) {
      const names = t.tags.map((x) => x.name);
      const wanted = p.tags.map((x) => x.toLowerCase());
      const ok = p.tags_mode === "all" ? wanted.every((w) => names.some((n) => n.includes(w))) : wanted.some((w) => names.some((n) => n.includes(w)));
      if (!ok) continue;
    }
    if (p.exclude_tags?.length) {
      const names = t.tags.map((x) => x.name);
      if (p.exclude_tags.some((w) => names.some((n) => n.includes(w.toLowerCase())))) continue;
    }
    if (p.year_min !== void 0 && (!t.year || t.year < p.year_min)) continue;
    if (p.year_max !== void 0 && (!t.year || t.year > p.year_max)) continue;
    if (decadeSet.size && (!t.year || !decadeSet.has(Math.floor(t.year / 10) * 10))) continue;
    if (Number.isFinite(releasedAfter)) {
      const d = t.date ? Date.parse(t.date) : NaN;
      if (!Number.isFinite(d) || d < releasedAfter) continue;
    }
    if (Number.isFinite(releasedBefore)) {
      const d = t.date ? Date.parse(t.date) : NaN;
      if (!Number.isFinite(d) || d > releasedBefore) continue;
    }
    if (p.added_within_days !== void 0 && !(t.addedAt && now - t.addedAt <= p.added_within_days * DAY_MS)) continue;
    if (p.added_before_days !== void 0 && !(t.addedAt && now - t.addedAt >= p.added_before_days * DAY_MS)) continue;
    if (p.never_played && (t.playCount > 0 || t.listens > 0)) continue;
    if (p.played_within_days !== void 0 && !(t.playDate && now - t.playDate <= p.played_within_days * DAY_MS)) continue;
    if (p.not_played_within_days !== void 0 && t.playDate && now - t.playDate < p.not_played_within_days * DAY_MS) continue;
    if (p.play_count_min !== void 0 && t.playCount < p.play_count_min) continue;
    if (p.play_count_max !== void 0 && t.playCount > p.play_count_max) continue;
    if (p.listen_count_min !== void 0 && t.listens < p.listen_count_min) continue;
    if (p.listen_count_max !== void 0 && t.listens > p.listen_count_max) continue;
    if (p.listened_within_days !== void 0 && !(t.lastListen && nowSec - t.lastListen <= p.listened_within_days * 86400)) continue;
    if (p.not_listened_within_days !== void 0 && t.lastListen && nowSec - t.lastListen < p.not_listened_within_days * 86400) continue;
    if (p.hour_of_day !== void 0 && !(t.hourHist.length && t.hourHist[p.hour_of_day] > 0)) continue;
    if (p.day_of_week !== void 0 && !(t.dowHist.length && t.dowHist[p.day_of_week] > 0)) continue;
    if (p.duration_min_sec !== void 0 && t.duration < p.duration_min_sec) continue;
    if (p.duration_max_sec !== void 0 && t.duration > p.duration_max_sec) continue;
    if (p.bpm_min !== void 0 && !(t.bpm && t.bpm >= p.bpm_min)) continue;
    if (p.bpm_max !== void 0 && !(t.bpm && t.bpm <= p.bpm_max)) continue;
    if (p.starred !== void 0 && t.starred !== p.starred) continue;
    if (p.mood_vibes?.length) {
      if (!anyMatch([...t.mood?.vibes ?? [], ...t.vibes], p.mood_vibes)) continue;
    }
    const needsMood = p.energy_min !== void 0 || p.energy_max !== void 0 || p.valence_min !== void 0 || p.valence_max !== void 0 || p.intensity_min !== void 0 || p.intensity_max !== void 0 || p.acousticness_min !== void 0 || p.acousticness_max !== void 0 || p.density_min !== void 0 || p.density_max !== void 0 || Boolean(p.tempo_feel?.length) || Boolean(p.vocal?.length) || Boolean(p.moods?.length) || Boolean(p.fits_time);
    if (needsMood) {
      const m = t.mood;
      if (!m) continue;
      if (p.energy_min !== void 0 && m.energy < p.energy_min) continue;
      if (p.energy_max !== void 0 && m.energy > p.energy_max) continue;
      if (p.valence_min !== void 0 && m.valence < p.valence_min) continue;
      if (p.valence_max !== void 0 && m.valence > p.valence_max) continue;
      if (p.intensity_min !== void 0 && m.intensity < p.intensity_min) continue;
      if (p.intensity_max !== void 0 && m.intensity > p.intensity_max) continue;
      if (p.acousticness_min !== void 0 && m.acousticness < p.acousticness_min) continue;
      if (p.acousticness_max !== void 0 && m.acousticness > p.acousticness_max) continue;
      if (p.density_min !== void 0 && m.density < p.density_min) continue;
      if (p.density_max !== void 0 && m.density > p.density_max) continue;
      if (p.tempo_feel?.length && !p.tempo_feel.includes(m.tempoFeel)) continue;
      if (p.vocal?.length && !p.vocal.includes(m.vocal)) continue;
      if (wantMoods && !wantMoods.some((w) => m.moods.some((x) => x.includes(w)))) continue;
      if (p.fits_time && !m.times.some((x) => x.toLowerCase() === p.fits_time.toLowerCase())) continue;
    }
    if (banMoods && t.mood && banMoods.some((w) => t.mood.moods.some((x) => x.includes(w)))) continue;
    out.push(t);
  }
  const total = out.length;
  const sorted = sortTracks(out, p, store2, nowSec);
  const diversified = diversify(sorted, p.max_per_artist, p.max_per_album);
  const offset = p.offset ?? 0;
  const limit = p.limit ?? 50;
  return { total, tracks: diversified.slice(offset, offset + limit) };
}
function affinity(t, hour, nowSec) {
  let s = 0;
  s += Math.log1p(t.listens) * 3;
  s += Math.log1p(t.playCount) * 1.5;
  s += t.vibes.length * 2.5;
  if (t.starred) s += 4;
  s += (t.rating || 0) * 1.5;
  if (hour !== void 0 && t.hourHist.length && t.listens) {
    const share = t.hourHist[hour] / t.listens;
    s += Math.min(share * 24, 6) * 2;
  }
  if (t.lastListen) {
    const days = (nowSec - t.lastListen) / 86400;
    if (days < 3) s -= 5;
    else if (days < 14) s -= 2;
    else if (days > 365) s += 1.5;
  }
  return s;
}
function sortTracks(list, p, store2, nowSec) {
  const sort = p.sort ?? "affinity";
  const arr = [...list];
  const rnd = mulberry32(p.seed ?? 1);
  switch (sort) {
    case "random": {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }
    case "play_count":
      return arr.sort((a, b) => b.playCount - a.playCount);
    case "listen_count":
      return arr.sort((a, b) => b.listens - a.listens);
    case "recently_played":
      return arr.sort((a, b) => Math.max(b.playDate, b.lastListen * 1e3) - Math.max(a.playDate, a.lastListen * 1e3));
    case "least_recently_played":
      return arr.sort((a, b) => Math.max(a.playDate, a.lastListen * 1e3) - Math.max(b.playDate, b.lastListen * 1e3));
    case "recently_added":
      return arr.sort((a, b) => b.addedAt - a.addedAt);
    case "year_desc":
      return arr.sort((a, b) => b.year - a.year);
    case "year_asc":
      return arr.sort((a, b) => a.year - b.year);
    case "duration_asc":
      return arr.sort((a, b) => a.duration - b.duration);
    case "duration_desc":
      return arr.sort((a, b) => b.duration - a.duration);
    case "title":
      return arr.sort((a, b) => a.title.localeCompare(b.title));
    case "hour_fit": {
      const h = p.hour_of_day ?? (/* @__PURE__ */ new Date()).getHours();
      return arr.sort(
        (a, b) => (b.hourHist[h] ?? 0) / Math.max(1, b.listens) - (a.hourHist[h] ?? 0) / Math.max(1, a.listens)
      );
    }
    case "affinity":
    default: {
      const scored = arr.map((t) => ({
        t,
        s: affinity(t, p.hour_of_day, nowSec) + rnd() * 1.5
      }));
      scored.sort((a, b) => b.s - a.s);
      return scored.map((x) => x.t);
    }
  }
}
function diversify(list, maxArtist, maxAlbum) {
  if (!maxArtist && !maxAlbum) return list;
  const byArtist = /* @__PURE__ */ new Map();
  const byAlbum = /* @__PURE__ */ new Map();
  const out = [];
  for (const t of list) {
    const ak = norm(t.albumArtist || t.artist);
    if (maxArtist) {
      const n = byArtist.get(ak) ?? 0;
      if (n >= maxArtist) continue;
      byArtist.set(ak, n + 1);
    }
    if (maxAlbum && t.albumId) {
      const n = byAlbum.get(t.albumId) ?? 0;
      if (n >= maxAlbum) continue;
      byAlbum.set(t.albumId, n + 1);
    }
    out.push(t);
  }
  return out;
}
function brief(t) {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    year: t.year || void 0,
    genres: t.genres.length ? t.genres : void 0,
    duration_sec: Math.round(t.duration),
    plays: t.playCount || void 0,
    listens: t.listens || void 0,
    last_listened: t.lastListen ? new Date(t.lastListen * 1e3).toISOString().slice(0, 10) : void 0,
    playlists: t.vibes.length ? t.vibes : void 0,
    tags: t.tags.length ? t.tags.slice(0, 6).map((x) => x.name) : void 0,
    starred: t.starred || void 0,
    mood: t.mood ? {
      energy: t.mood.energy,
      valence: t.mood.valence,
      intensity: t.mood.intensity,
      acousticness: t.mood.acousticness,
      density: t.mood.density,
      tempo: t.mood.tempoFeel,
      vocal: t.mood.vocal,
      moods: t.mood.moods,
      fits: t.mood.times,
      vibes: t.mood.vibes.length ? t.mood.vibes : void 0
    } : void 0
  };
}

// src/store.ts
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";

// src/lastfm.ts
var DEFAULT_KEY = "1e09b447d6dbe9ea525dec574fb5427c";
var ENDPOINT = "https://ws.audioscrobbler.com/2.0/";
var UA2 = "navidrome-mcp/1.0";
var MIN_COUNT = 5;
var JUNK = /^(seen live|albums i own|favourites?|favorites?|my .*|awesome|love|good|great|best|cool|beautiful|amazing|check out|spotify|under 2000 listeners)$/i;
var LastFm = class _LastFm {
  constructor(key, dispatcher2, minIntervalMs = 210) {
    this.dispatcher = dispatcher2;
    this.minIntervalMs = minIntervalMs;
    this.key = key || DEFAULT_KEY;
  }
  dispatcher;
  minIntervalMs;
  key;
  /** Serialises requests to stay under Last.fm's rate limit. */
  queue = Promise.resolve();
  schedule(fn) {
    const next = this.queue.then(async () => {
      const t0 = Date.now();
      try {
        return await fn();
      } finally {
        const wait = this.minIntervalMs - (Date.now() - t0);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    });
    this.queue = next.catch(() => void 0);
    return next;
  }
  async call(params) {
    const qs = new URLSearchParams({
      ...params,
      api_key: this.key,
      format: "json",
      autocorrect: "1"
    });
    const opts = { headers: { "user-agent": UA2 } };
    if (this.dispatcher) opts.dispatcher = this.dispatcher;
    try {
      const res = await fetch(`${ENDPOINT}?${qs}`, opts);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }
  static clean(raw) {
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const out = [];
    for (const t of list) {
      const name = String(t?.name ?? "").trim().toLowerCase();
      const count = Number(t?.count ?? 0);
      if (!name || name.length > 40) continue;
      if (JUNK.test(name)) continue;
      if (count < MIN_COUNT) continue;
      out.push({ name, count });
    }
    return out.slice(0, 15);
  }
  trackTags(artist, track) {
    return this.schedule(async () => {
      const b = await this.call({ method: "track.gettoptags", artist, track });
      const top = b?.toptags?.tag;
      return _LastFm.clean(top);
    });
  }
  artistTags(artist) {
    return this.schedule(async () => {
      const b = await this.call({ method: "artist.gettoptags", artist });
      const top = b?.toptags?.tag;
      return _LastFm.clean(top);
    });
  }
  similarArtists(artist, limit = 30) {
    return this.schedule(async () => {
      const b = await this.call({ method: "artist.getsimilar", artist, limit: String(limit) });
      const raw = b?.similarartists?.artist;
      const list = Array.isArray(raw) ? raw : [];
      return list.map((a) => String(a?.name ?? "")).filter(Boolean);
    });
  }
};

// src/moodspace.ts
var TEMPO_FEELS = ["still", "slow", "mid", "driving", "frantic"];
var VOCAL_KINDS = ["instrumental", "sung", "rapped", "mixed"];
var W = {
  intensity: 1.6,
  acousticness: 1.4,
  density: 1,
  energy: 1,
  valence: 0.45
};
var TEMPO_INDEX = {
  still: 0,
  slow: 1,
  mid: 2,
  driving: 3,
  frantic: 4
};
var TEMPO_STEP_COST = 18;
function vocalCost(a, b) {
  if (a === b) return 0;
  const pair = [a, b].sort().join("|");
  switch (pair) {
    case "mixed|sung":
      return 4;
    case "mixed|rapped":
      return 8;
    case "rapped|sung":
      return 20;
    case "instrumental|sung":
      return 16;
    case "instrumental|mixed":
      return 18;
    case "instrumental|rapped":
      return 28;
    default:
      return 12;
  }
}
function numericDistance(a, b) {
  const sq = W.intensity * (a.intensity - b.intensity) ** 2 + W.acousticness * (a.acousticness - b.acousticness) ** 2 + W.density * (a.density - b.density) ** 2 + W.energy * (a.energy - b.energy) ** 2 + W.valence * (a.valence - b.valence) ** 2;
  const totalW = W.intensity + W.acousticness + W.density + W.energy + W.valence;
  return Math.sqrt(sq / totalW);
}
function moodDistance(a, b) {
  const tempo = Math.abs(TEMPO_INDEX[a.tempoFeel] - TEMPO_INDEX[b.tempoFeel]) * TEMPO_STEP_COST;
  return numericDistance(a, b) + tempo + vocalCost(a.vocal, b.vocal);
}
function centroid(points) {
  if (!points.length) return null;
  const mean = (f) => points.reduce((s, p) => s + f(p), 0) / points.length;
  const tempos = points.map((p) => TEMPO_INDEX[p.tempoFeel]).sort((x, y) => x - y);
  const tIdx = tempos[Math.floor(tempos.length / 2)];
  const vocalCounts = /* @__PURE__ */ new Map();
  for (const p of points) vocalCounts.set(p.vocal, (vocalCounts.get(p.vocal) ?? 0) + 1);
  const vocal = [...vocalCounts.entries()].sort((x, y) => y[1] - x[1])[0][0];
  const moodCounts = /* @__PURE__ */ new Map();
  for (const p of points) for (const m of p.moods) moodCounts.set(m, (moodCounts.get(m) ?? 0) + 1);
  return {
    energy: mean((p) => p.energy),
    valence: mean((p) => p.valence),
    intensity: mean((p) => p.intensity),
    acousticness: mean((p) => p.acousticness),
    density: mean((p) => p.density),
    tempoFeel: TEMPO_FEELS[tIdx],
    vocal,
    moods: [...moodCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([m]) => m)
  };
}
function spreadRadius(points, quantile = 0.75) {
  const c = centroid(points);
  if (!c || points.length < 2) return 0;
  const ds = points.map((p) => moodDistance(p, c)).sort((a, b) => a - b);
  return ds[Math.min(ds.length - 1, Math.floor(ds.length * quantile))];
}

// src/moodtags.ts
var TAGS = {
  moods: "mood",
  energy: "ndmood_energy",
  valence: "ndmood_valence",
  intensity: "ndmood_intensity",
  acousticness: "ndmood_acousticness",
  density: "ndmood_density",
  tempo: "ndmood_tempo",
  vocal: "ndmood_vocal",
  times: "ndmood_time",
  vibes: "vibe"
};
var MOOD_TAG_NAMES = Object.values(TAGS);
function first(tags, name) {
  const v = tags?.[name];
  return v && v.length ? v[0] : void 0;
}
function axis(tags, name) {
  const raw = first(tags, name);
  if (raw === void 0) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n);
}
function oneOf(tags, name, allowed) {
  const raw = first(tags, name)?.trim().toLowerCase();
  return raw && allowed.includes(raw) ? raw : null;
}
function moodFromTags(tags) {
  if (!tags) return null;
  const energy = axis(tags, TAGS.energy);
  const valence = axis(tags, TAGS.valence);
  const intensity = axis(tags, TAGS.intensity);
  const acousticness = axis(tags, TAGS.acousticness);
  const density = axis(tags, TAGS.density);
  const tempoFeel = oneOf(tags, TAGS.tempo, TEMPO_FEELS);
  const vocal = oneOf(tags, TAGS.vocal, VOCAL_KINDS);
  if (energy === null || valence === null || intensity === null || acousticness === null || density === null || tempoFeel === null || vocal === null) {
    return null;
  }
  const moods = [];
  for (const raw of tags[TAGS.moods] ?? []) {
    const c = canonicalise(raw);
    if (c && !moods.includes(c)) moods.push(c);
  }
  return {
    energy,
    valence,
    intensity,
    acousticness,
    density,
    tempoFeel,
    vocal,
    moods,
    times: (tags[TAGS.times] ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
    vibes: (tags[TAGS.vibes] ?? []).map((v) => v.trim().toLowerCase()).filter(Boolean)
  };
}
function moodDiagnosis(total, labelled, anyMoodTag) {
  if (labelled > 0) return `${labelled} of ${total} tracks are mood-labelled.`;
  if (!anyMoodTag) {
    return "No mood tags exist in this library, so every mood filter will match nothing. Mood data comes from the navidrome-mood plugin, which labels tracks and writes the tags into the audio files; this server only reads them. Install and run it, then call refresh_index.";
  }
  return `Mood tags are present but none parsed into a complete label. The numeric axes (${TAGS.energy}, ${TAGS.valence}, ${TAGS.intensity}, ${TAGS.acousticness}, ${TAGS.density}) plus ${TAGS.tempo} and ${TAGS.vocal} are all required. The usual cause is that these tags are not declared under \`Tags\` in Navidrome's own config file (not \`mappings.yaml\`, which is embedded in the binary and cannot be edited), so the scanner drops them and only the built-in MOOD words survive.`;
}

// src/store.ts
var SNAPSHOT_VERSION = 8;
function log2(msg) {
  console.error(`[navidrome-mcp] ${msg}`);
}
function toMs(s) {
  if (!s) return 0;
  const t = Date.parse(String(s));
  return Number.isFinite(t) ? t : 0;
}
var Store = class {
  constructor(opts) {
    this.opts = opts;
    this.lastfm = new LastFm(opts.lastFmKey, opts.externalDispatcher);
    this.lb = opts.listenBrainzUser ? new ListenBrainz(opts.listenBrainzUser, opts.externalDispatcher) : null;
  }
  opts;
  tracks = [];
  byId = /* @__PURE__ */ new Map();
  /** Curated playlist name -> track ids. */
  vibes = {};
  playlists = [];
  listens = [];
  playlistRuns = [];
  syncedAt = 0;
  listensSyncedAt = 0;
  /** See Snapshot.historyComplete. Drives backfillOlder. */
  historyComplete = false;
  trackTags = {};
  artistTags = {};
  taggedTracks = /* @__PURE__ */ new Set();
  taggedArtists = /* @__PURE__ */ new Set();
  lastfm;
  lb;
  ready = null;
  enrichState = {
    running: false,
    done: 0,
    total: 0,
    phase: "idle"
  };
  get snapshotPath() {
    return join(this.opts.dataDir, "index.json");
  }
  /** Idempotent: the first caller does the work, everyone else awaits it. */
  ensureReady() {
    if (!this.ready) {
      this.ready = this.init().catch((e) => {
        this.ready = null;
        throw e;
      });
    }
    return this.ready;
  }
  async init() {
    const loaded = await this.loadSnapshot();
    if (!loaded) {
      await this.syncLibrary();
      await this.syncListens();
      await this.saveSnapshot();
    } else if (!this.historyComplete) {
      void this.resumeHistoryInBackground();
    }
    if (this.opts.enrich) void this.enrichInBackground();
  }
  historyResuming = false;
  async resumeHistoryInBackground() {
    if (this.historyResuming) return;
    this.historyResuming = true;
    try {
      log2(`listens: history is incomplete at ${this.listens.length}, resuming the walk`);
      await this.syncListens();
      await this.saveSnapshot();
    } catch (e) {
      log2(`listens: resume failed, will try again on next start (${String(e)})`);
    } finally {
      this.historyResuming = false;
    }
  }
  // ── persistence ─────────────────────────────────────────────────────────
  async loadSnapshot() {
    try {
      const raw = await readFile(this.snapshotPath, "utf8");
      const s = JSON.parse(raw);
      if (s.version !== SNAPSHOT_VERSION) return false;
      this.syncedAt = s.syncedAt;
      this.listensSyncedAt = s.listensSyncedAt;
      this.historyComplete = s.historyComplete ?? false;
      this.vibes = s.vibes ?? {};
      this.trackTags = s.trackTags ?? {};
      this.artistTags = s.artistTags ?? {};
      this.taggedTracks = new Set(s.taggedTracks ?? []);
      this.taggedArtists = new Set(s.taggedArtists ?? []);
      this.playlistRuns = s.playlistRuns ?? [];
      this.listens = (s.listenTs ?? []).map((ts, i) => {
        const key = s.listenKeys[s.listenKi[i]] ?? " ";
        const sep = key.indexOf("\0");
        return {
          ts,
          artist: key.slice(0, sep),
          track: key.slice(sep + 1),
          client: s.listenClients?.[s.listenCli?.[i] ?? -1]
        };
      });
      this.build(s.songs ?? []);
      return this.tracks.length > 0;
    } catch {
      return false;
    }
  }
  snapshotSeq = 0;
  saveChain = Promise.resolve();
  savePending = false;
  /**
   * Coalesce concurrent save requests.
   *
   * The snapshot is a single ~15MB document, so 32 in-flight batches each asking
   * for a write would serialise 480MB of JSON for no benefit -- they all write
   * the same growing state. Instead one write runs at a time and any requests
   * arriving during it collapse into a single follow-up, which by definition
   * includes everything they wanted persisted.
   */
  saveSnapshotSoon() {
    if (this.savePending) return this.saveChain;
    this.savePending = true;
    this.saveChain = this.saveChain.catch(() => void 0).then(() => {
      this.savePending = false;
      return this.saveSnapshot();
    });
    return this.saveChain;
  }
  async saveSnapshot() {
    const keyIndex = /* @__PURE__ */ new Map();
    const listenKeys = [];
    const listenTs = [];
    const listenKi = [];
    const clientIndex = /* @__PURE__ */ new Map();
    const listenClients = [];
    const listenCli = [];
    for (const l of this.listens) {
      const k = `${l.artist}\0${l.track}`;
      let i = keyIndex.get(k);
      if (i === void 0) {
        i = listenKeys.length;
        keyIndex.set(k, i);
        listenKeys.push(k);
      }
      listenTs.push(l.ts);
      listenKi.push(i);
      const c = l.client ?? "";
      let ci = clientIndex.get(c);
      if (ci === void 0) {
        ci = listenClients.length;
        clientIndex.set(c, ci);
        listenClients.push(c);
      }
      listenCli.push(ci);
    }
    const snap = {
      version: SNAPSHOT_VERSION,
      syncedAt: this.syncedAt,
      listensSyncedAt: this.listensSyncedAt,
      songs: this.rawSongs,
      vibes: this.vibes,
      trackTags: this.trackTags,
      artistTags: this.artistTags,
      listenKeys,
      listenTs,
      listenKi,
      listenClients,
      listenCli,
      historyComplete: this.historyComplete,
      taggedTracks: [...this.taggedTracks],
      taggedArtists: [...this.taggedArtists],
      playlistRuns: this.playlistRuns.slice(-200)
    };
    await mkdir(dirname(this.snapshotPath), { recursive: true });
    const tmp = `${this.snapshotPath}.${process.pid}.${++this.snapshotSeq}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(snap), "utf8");
      await rename(tmp, this.snapshotPath);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => void 0);
      throw e;
    }
  }
  // ── syncing ─────────────────────────────────────────────────────────────
  rawSongs = [];
  /** Pull every track and every playlist, and rebuild the derived index. */
  async syncLibrary() {
    const nd = this.opts.navidrome;
    const t0 = Date.now();
    const songs = await nd.allSongs((n) => {
      if (n % 2e3 === 0) log2(`library: ${n} tracks pulled`);
    });
    log2(`library: ${songs.length} tracks in ${Math.round((Date.now() - t0) / 1e3)}s`);
    const playlists = await nd.listPlaylists();
    this.playlists = playlists;
    const rolling = new Set(this.playlistRuns.map((r) => norm(r.playlist)));
    const vibes = {};
    for (const p of playlists) {
      if (!p.name || !p.id) continue;
      if (this.isNonVibePlaylist(p, rolling)) continue;
      try {
        const rows = await nd.playlistTracks(p.id);
        vibes[p.name] = rows.map((r) => r.id);
      } catch {
      }
    }
    this.vibes = vibes;
    this.syncedAt = Date.now();
    log2(`vibes: ${Object.keys(vibes).length} curated playlists indexed`);
    this.build(songs);
    return { tracks: this.tracks.length, vibes: Object.keys(vibes).length };
  }
  /**
   * Which playlists count as hand-curated taste signal.
   *
   * Excluded: every rolling playlist this server has published to, since
   * treating our own output as taste input feeds the generator its own tail, and
   * anything the ListenBrainz plugin imported (those are recommendations, not
   * the listener's own filing). Rolling playlists are recognised from the run
   * history rather than from a name pattern, so a listener's own playlist called
   * "daylist" still counts as taste signal until something publishes to it.
   */
  isNonVibePlaylist(p, rollingTitles) {
    if (rollingTitles.has(norm(p.name ?? ""))) return true;
    if ((p.comment ?? "").includes("listenbrainz.org/playlist")) return true;
    if (/^(listenbrainz|generated daily jams|last week's jams)/i.test(p.name ?? "")) return true;
    return false;
  }
  /**
   * Oldest listen held, or undefined when none are.
   *
   * A loop rather than Math.min over a spread: this array reaches six figures,
   * and spreading it as arguments overflows the stack.
   */
  oldestListen() {
    let oldest;
    for (const l of this.listens) if (oldest === void 0 || l.ts < oldest) oldest = l.ts;
    return oldest;
  }
  /**
   * Walk further back from the oldest listen already held.
   *
   * This is what makes an interrupted history recoverable. The forward pass
   * below resumes from the NEWEST listen held, so on its own it can never
   * retrieve anything older, and a walk that died partway left the index frozen
   * at whatever prefix it had managed. Resuming from the oldest end instead
   * means every sync gets strictly further back, and a failure costs a delay
   * rather than the history.
   */
  async backfillOlder(floor) {
    if (!this.lb || this.historyComplete) return 0;
    const oldest = this.oldestListen();
    if (oldest !== void 0 && oldest <= floor) {
      this.historyComplete = true;
      return 0;
    }
    const t0 = Date.now();
    log2(`listens: backfilling older than ${oldest ? new Date(oldest * 1e3).toISOString().slice(0, 10) : "now"}`);
    const { listens: older, truncated, reachedEnd } = await this.lb.listens({
      since: floor,
      startBefore: oldest,
      onProgress: (n) => {
        if (n % 5e3 === 0) {
          log2(`listens: ${n} backfilled (${Math.round((Date.now() - t0) / 1e3)}s)`);
        }
      }
    });
    this.listens.push(...older);
    if (!truncated) {
      this.historyComplete = true;
      log2(
        `listens: history complete, ${older.length} backfilled in ${Math.round((Date.now() - t0) / 1e3)}s${reachedEnd ? " (account exhausted)" : " (reached floor)"}`
      );
    } else {
      log2(
        `listens: backfill INCOMPLETE, ${older.length} added in ${Math.round((Date.now() - t0) / 1e3)}s. The next sync resumes from here.`
      );
    }
    return older.length;
  }
  async syncListens(full = false) {
    if (!this.lb) return 0;
    const floor = Math.floor(Date.now() / 1e3) - this.opts.historyDays * 86400;
    const since = full ? floor : Math.max(this.listensSyncedAt, floor);
    if (full) this.historyComplete = false;
    const t0 = Date.now();
    const { listens: fresh, truncated } = await this.lb.listens({
      since,
      onProgress: (n) => {
        if (n % 5e3 === 0) log2(`listens: ${n} fetched (${Math.round((Date.now() - t0) / 1e3)}s)`);
      }
    });
    log2(`listens: ${fresh.length} new in ${Math.round((Date.now() - t0) / 1e3)}s`);
    if (truncated) {
      log2(
        `listens: WARNING forward pass incomplete, holding ${this.listens.length + fresh.length}.`
      );
    }
    const backfilled = await this.backfillOlder(floor);
    if (!this.historyComplete) {
      log2(
        `listens: WARNING history is still incomplete. Counts and "never listened" are understated until a later sync finishes the walk.`
      );
    }
    if (fresh.length || backfilled) {
      const seen = new Set(this.listens.map((l) => `${l.ts}|${l.artist}|${l.track}`));
      for (const l of fresh) {
        const k = `${l.ts}|${l.artist}|${l.track}`;
        if (!seen.has(k)) {
          seen.add(k);
          this.listens.push(l);
        }
      }
      const { kept, dropped } = dedupeListens(this.listens);
      this.listens = kept;
      if (dropped) log2(`listens: ${dropped} cross-submitter duplicate(s) collapsed`);
    }
    this.listensSyncedAt = this.listens.length ? this.listens[this.listens.length - 1].ts : 0;
    this.applyListenStats();
    return fresh.length + backfilled;
  }
  // ── derivation ──────────────────────────────────────────────────────────
  build(songs) {
    this.rawSongs = songs;
    const vibeOf = /* @__PURE__ */ new Map();
    for (const [name, ids] of Object.entries(this.vibes)) {
      for (const id of ids) {
        const arr = vibeOf.get(id);
        if (arr) arr.push(name);
        else vibeOf.set(id, [name]);
      }
    }
    this.tracks = songs.map((s) => {
      const genres = Array.isArray(s.genres) && s.genres.length ? s.genres.map((g) => String(g.name)).filter(Boolean) : s.genre ? [String(s.genre)] : [];
      const id = String(s.id);
      const artist = String(s.artist ?? "");
      const title = String(s.title ?? "");
      return {
        id,
        title,
        artist,
        artistId: String(s.artistId ?? ""),
        albumArtist: String(s.albumArtist ?? ""),
        album: String(s.album ?? ""),
        albumId: String(s.albumId ?? ""),
        genres,
        year: Number(s.year ?? 0) || 0,
        date: s.date ? String(s.date) : void 0,
        duration: Number(s.duration ?? 0) || 0,
        bpm: s.bpm ? Number(s.bpm) : void 0,
        bitRate: s.bitRate ? Number(s.bitRate) : void 0,
        suffix: s.suffix ? String(s.suffix) : void 0,
        size: s.size ? Number(s.size) : void 0,
        playCount: Number(s.playCount ?? 0) || 0,
        playDate: toMs(s.playDate),
        starred: Boolean(s.starred),
        rating: Number(s.rating ?? 0) || 0,
        addedAt: toMs(s.createdAt),
        missing: Boolean(s.missing),
        vibes: vibeOf.get(id) ?? [],
        tags: [],
        listens: 0,
        lastListen: 0,
        firstListen: 0,
        hourHist: [],
        dowHist: [],
        nkey: matchKey(primaryArtist(artist), title),
        mood: moodFromTags(s.tags) ?? void 0
      };
    });
    this.byId = new Map(this.tracks.map((t) => [t.id, t]));
    this.applyTags();
    this.applyListenStats();
  }
  applyTags() {
    for (const t of this.tracks) {
      const own = this.trackTags[t.id];
      if (own && own.length) {
        t.tags = own;
        continue;
      }
      const at = this.artistTags[norm(t.artist)];
      t.tags = at ? at.slice(0, 10) : [];
    }
  }
  /** How many tracks land in each vibe region, per the plugin's `vibe` tag. */
  vibeHistogram() {
    const counts = /* @__PURE__ */ new Map();
    for (const t of this.tracks) {
      for (const v of t.mood?.vibes ?? []) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()].map(([vibe, tracks]) => ({ vibe, tracks })).sort((a, b) => b.tracks - a.tracks);
  }
  /**
   * How much of the library carries a usable mood label.
   *
   * Reports *why* when the answer is none. "0 labelled" reads identically
   * whether the plugin was never installed, ran but wrote nothing, or wrote tags
   * Navidrome then dropped for want of a `Tags` entry in its own config -- and
   * those need three different fixes.
   */
  moodCoverage() {
    const labelled = this.tracks.filter((t) => t.mood).length;
    const anyMoodTag = this.rawSongs.some(
      (s) => MOOD_TAG_NAMES.some((n) => (s.tags?.[n]?.length ?? 0) > 0)
    );
    return {
      labelled,
      total: this.tracks.length,
      note: moodDiagnosis(this.tracks.length, labelled, anyMoodTag)
    };
  }
  /**
   * Fold the listen history onto the library.
   *
   * Matching is by normalised "artist title", which is lossy in both directions
   * (a scrobble may name a featured artist the file does not, a remaster suffix
   * may differ). Unmatched listens are still kept -- they carry the time-of-day
   * signal even when we cannot say which local file they refer to.
   */
  applyListenStats() {
    if (!this.tracks.length) return;
    const index = /* @__PURE__ */ new Map();
    for (const t of this.tracks) {
      const arr = index.get(t.nkey);
      if (arr) arr.push(t);
      else index.set(t.nkey, [t]);
    }
    for (const t of this.tracks) {
      t.listens = 0;
      t.lastListen = 0;
      t.firstListen = 0;
      t.hourHist = [];
      t.dowHist = [];
    }
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: this.opts.timezone,
      hour: "numeric",
      hour12: false,
      weekday: "short"
    });
    const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    for (const l of this.listens) {
      const hits = index.get(matchKey(primaryArtist(l.artist), l.track));
      if (!hits) continue;
      const parts = fmt.formatToParts(new Date(l.ts * 1e3));
      const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
      const dow = DOW[parts.find((p) => p.type === "weekday")?.value ?? "Sun"] ?? 0;
      for (const t of hits) {
        if (!t.hourHist.length) {
          t.hourHist = new Array(24).fill(0);
          t.dowHist = new Array(7).fill(0);
        }
        t.listens++;
        t.hourHist[hour]++;
        t.dowHist[dow]++;
        if (!t.firstListen || l.ts < t.firstListen) t.firstListen = l.ts;
        if (l.ts > t.lastListen) t.lastListen = l.ts;
      }
    }
  }
  // ── Last.fm enrichment ──────────────────────────────────────────────────
  /**
   * Fetch tags in the background, artists first.
   *
   * Artist tags are ~3,000 requests and immediately give every track *some*
   * descriptive vocabulary; track tags are ~9,300 more and refine it. Both are
   * resumable via the tagged* sets, so a restart mid-run costs nothing, and the
   * snapshot is flushed periodically so progress survives a crash.
   */
  async enrichInBackground() {
    if (this.enrichState.running) return;
    this.enrichState = { running: true, done: 0, total: 0, phase: "artists" };
    try {
      const artists = [...new Set(this.tracks.map((t) => norm(t.artist)).filter(Boolean))];
      const pendingArtists = artists.filter((a) => !this.taggedArtists.has(a));
      const originals = /* @__PURE__ */ new Map();
      for (const t of this.tracks) originals.set(norm(t.artist), t.artist);
      this.enrichState.total = pendingArtists.length;
      let n = 0;
      for (const a of pendingArtists) {
        const tags = await this.lastfm.artistTags(originals.get(a) ?? a);
        if (tags.length) this.artistTags[a] = tags;
        this.taggedArtists.add(a);
        if (++n % 100 === 0) {
          this.enrichState.done = n;
          this.applyTags();
          await this.saveSnapshot();
        }
      }
      this.applyTags();
      await this.saveSnapshot();
      this.enrichState = {
        running: true,
        done: 0,
        total: this.tracks.length,
        phase: "tracks"
      };
      n = 0;
      for (const t of this.tracks) {
        if (this.taggedTracks.has(t.id)) continue;
        const tags = await this.lastfm.trackTags(t.artist, t.title);
        if (tags.length) this.trackTags[t.id] = tags;
        this.taggedTracks.add(t.id);
        if (++n % 100 === 0) {
          this.enrichState.done = n;
          this.applyTags();
          await this.saveSnapshot();
        }
      }
      this.applyTags();
      await this.saveSnapshot();
    } catch {
    } finally {
      this.enrichState = { running: false, done: 0, total: 0, phase: "idle" };
    }
  }
  // ── vocabulary helpers ──────────────────────────────────────────────────
  tagVocabulary(limit = 120) {
    const counts = /* @__PURE__ */ new Map();
    for (const t of this.tracks) {
      for (const tag of t.tags) counts.set(tag.name, (counts.get(tag.name) ?? 0) + 1);
    }
    return [...counts.entries()].map(([tag, tracks]) => ({ tag, tracks })).sort((a, b) => b.tracks - a.tracks).slice(0, limit);
  }
  genreHistogram() {
    const counts = /* @__PURE__ */ new Map();
    for (const t of this.tracks) {
      for (const g of t.genres) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return [...counts.entries()].map(([genre, tracks]) => ({ genre, tracks })).sort((a, b) => b.tracks - a.tracks);
  }
  decadeHistogram() {
    const counts = /* @__PURE__ */ new Map();
    for (const t of this.tracks) {
      if (!t.year) continue;
      const d = Math.floor(t.year / 10) * 10;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([d, tracks]) => ({ decade: `${d}s`, tracks }));
  }
  recordPlaylistRun(run) {
    this.playlistRuns.push(run);
    if (this.playlistRuns.length > 200) this.playlistRuns = this.playlistRuns.slice(-200);
  }
  /** The most recent revisions of one rolling playlist, or of all of them. */
  recentRuns(runs, playlist) {
    if (runs <= 0) return [];
    const key = playlist ? norm(playlist) : void 0;
    const rows = key ? this.playlistRuns.filter((r) => norm(r.playlist) === key) : this.playlistRuns;
    return rows.slice(-runs);
  }
  /** Distinct free-form mood descriptors across the library. */
  moodVocabulary(limit = 80) {
    const counts = /* @__PURE__ */ new Map();
    for (const t of this.tracks) {
      for (const m of t.mood?.moods ?? []) counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    return [...counts.entries()].map(([mood, tracks]) => ({ mood, tracks })).sort((a, b) => b.tracks - a.tracks).slice(0, limit);
  }
  /**
   * Track ids the last `runs` revisions of one rolling playlist used.
   *
   * Scoped to a single playlist so each one avoids repeating itself. Pooling
   * every rolling playlist's history instead would let a busy hourly list strip
   * the candidates out from under all the others.
   */
  recentRunTrackIds(playlist, runs) {
    const out = /* @__PURE__ */ new Set();
    for (const r of this.recentRuns(runs, playlist)) {
      for (const id of r.trackIds) out.add(id);
    }
    return out;
  }
};

// src/index.ts
var env = process.env;
var TZ = env.NAVIDROME_TZ || "America/Chicago";
var DATA_DIR = env.NAVIDROME_DATA_DIR || "/data/navidrome-mcp";
var proxyUrl = env.NAVIDROME_PROXY;
var dispatcher;
if (proxyUrl) {
  const u = new URL(proxyUrl);
  dispatcher = socksDispatcher({
    type: u.protocol.startsWith("socks4") ? 4 : 5,
    host: u.hostname,
    port: Number(u.port || 1080),
    ...u.username ? { userId: decodeURIComponent(u.username) } : {},
    ...u.password ? { password: decodeURIComponent(u.password) } : {}
  });
}
var navidrome = new Navidrome({
  baseUrl: env.NAVIDROME_URL ?? "",
  username: env.NAVIDROME_USERNAME ?? "",
  password: env.NAVIDROME_PASSWORD ?? "",
  dispatcher
});
var store = new Store({
  navidrome,
  dataDir: DATA_DIR,
  listenBrainzUser: env.LISTENBRAINZ_USER,
  lastFmKey: env.LASTFM_API_KEY,
  timezone: TZ,
  // Effectively the whole account. See StoreOptions.historyDays for why this is
  // not a short window: the counts this feeds are documented as lifetime.
  historyDays: Number(env.LISTENBRAINZ_HISTORY_DAYS ?? 7300) || 7300,
  enrich: env.NAVIDROME_ENRICH !== "0"
});
function result(summary, data) {
  const text = data === void 0 ? summary : `${summary}

\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\``;
  return { content: [{ type: "text", text }] };
}
function errorResult(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
}
function tool(fn) {
  return async (args) => {
    try {
      await store.ensureReady();
      return await fn(args);
    } catch (e) {
      return errorResult(e);
    }
  };
}
function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
var server = new McpServer({ name: "navidrome-mcp", version: "1.0.0" });
server.registerTool(
  "describe_library",
  {
    title: "Describe the music library",
    description: "Orientation for the whole library: size, genre and decade distribution, how the library spreads across the universal mood regions, the Last.fm tag vocabulary available for filtering, and how much listening history and mood labelling exist to work with. Call this FIRST when you need to build a playlist and do not yet know what the library contains.",
    inputSchema: {},
    annotations: { readOnlyHint: true }
  },
  tool(async () => {
    const totalSec = store.tracks.reduce((a, t) => a + t.duration, 0);
    const withListens = store.tracks.filter((t) => t.listens > 0).length;
    const playlists = Object.entries(store.vibes).map(([name, ids]) => ({ playlist: name, tracks: ids.length })).sort((a, b) => b.tracks - a.tracks);
    const coverage = store.moodCoverage();
    const labelled = coverage.labelled;
    const regionCounts = new Map(store.vibeHistogram().map((v) => [v.vibe, v.tracks]));
    return result(
      `Library: ${store.tracks.length} tracks, ${fmtDuration(totalSec)} total. ${labelled} of ${store.tracks.length} mood-labelled. ${store.listens.length} listens on file (${withListens} tracks matched).`,
      {
        tracks: store.tracks.length,
        missing_files: store.tracks.filter((t) => t.missing).length,
        artists: new Set(store.tracks.map((t) => t.artistId || t.artist)).size,
        albums: new Set(store.tracks.map((t) => t.albumId)).size,
        total_duration: fmtDuration(totalSec),
        library_synced_at: new Date(store.syncedAt).toISOString(),
        genres: store.genreHistogram(),
        decades: store.decadeHistogram(),
        tag_vocabulary: store.tagVocabulary(80),
        listening: {
          total_listens: store.listens.length,
          tracks_with_listens: withListens,
          oldest: store.listens.length ? new Date(store.listens[0].ts * 1e3).toISOString().slice(0, 10) : null,
          newest: store.listens.length ? new Date(store.listens[store.listens.length - 1].ts * 1e3).toISOString().slice(0, 10) : null
        },
        tag_enrichment: store.enrichState,
        mood_coverage: coverage,
        vibe_regions: Object.entries(VIBE_SCHEDULE).map(([vibe, d]) => ({
          vibe,
          gloss: d.gloss,
          tracks: regionCounts.get(vibe) ?? 0
        })),
        mood_vocabulary: store.moodVocabulary(60),
        curated_playlists: playlists.length ? playlists : void 0,
        note: labelled === 0 ? coverage.note + " Until then, fall back to genres, tags and listening history." : "Vibe regions are fixed definitions in mood-space, not this library's playlists, so `mood_vibes` means the same thing everywhere. `vibes` is different: it matches only tracks the listener filed onto a playlist by hand, which most libraries have little or none of." + (playlists.length ? "" : " This library has no curated playlists, so `vibes` will match nothing.")
      }
    );
  })
);
var searchShape = {
  query: z.string().optional().describe("Free text matched against title, artist, album and tags."),
  artists: z.array(z.string()).optional().describe("Only these artists (substring match)."),
  exclude_artists: z.array(z.string()).optional(),
  albums: z.array(z.string()).optional(),
  genres: z.array(z.string()).optional().describe("Any-of match on the library's own genres."),
  exclude_genres: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional().describe("Last.fm tags, e.g. ['shoegaze','melancholy']."),
  tags_mode: z.enum(["any", "all"]).optional().describe("Default 'any'."),
  exclude_tags: z.array(z.string()).optional(),
  vibes: z.array(z.string()).optional().describe(
    "Restrict to tracks the listener filed onto these named playlists by hand. Most libraries have few or none: prefer `mood_vibes`."
  ),
  exclude_vibes: z.array(z.string()).optional(),
  year_min: z.number().int().optional(),
  year_max: z.number().int().optional(),
  decades: z.array(z.string()).optional().describe("e.g. ['1990s','2000s']."),
  released_after: z.string().optional().describe("ISO date, matched against the release date."),
  released_before: z.string().optional(),
  added_within_days: z.number().optional().describe("Added to the library in the last N days."),
  added_before_days: z.number().optional().describe("Added at least N days ago."),
  played_within_days: z.number().optional(),
  not_played_within_days: z.number().optional().describe("Exclude anything played in the last N days."),
  never_played: z.boolean().optional(),
  play_count_min: z.number().optional(),
  play_count_max: z.number().optional(),
  listen_count_min: z.number().optional().describe("Lifetime ListenBrainz listens."),
  listen_count_max: z.number().optional(),
  listened_within_days: z.number().optional(),
  not_listened_within_days: z.number().optional(),
  hour_of_day: z.number().int().min(0).max(23).optional().describe("Only tracks actually listened to at this local hour. Needs listen history."),
  day_of_week: z.number().int().min(0).max(6).optional().describe("0 = Sunday."),
  duration_min_sec: z.number().optional(),
  duration_max_sec: z.number().optional(),
  bpm_min: z.number().optional(),
  bpm_max: z.number().optional(),
  starred: z.boolean().optional(),
  energy_min: z.number().optional().describe("Inferred mood axis 0-100: still -> frantic."),
  energy_max: z.number().optional(),
  valence_min: z.number().optional().describe("0-100: bleak -> joyful."),
  valence_max: z.number().optional(),
  intensity_min: z.number().optional().describe("0-100: gentle -> heavy/aggressive."),
  intensity_max: z.number().optional(),
  acousticness_min: z.number().optional().describe("0-100: fully electronic -> fully acoustic."),
  acousticness_max: z.number().optional(),
  density_min: z.number().optional().describe("0-100: sparse/solo -> wall of sound."),
  density_max: z.number().optional(),
  tempo_feel: z.array(z.enum(TEMPO_FEELS)).optional().describe("How fast the track feels, any-of. Independent of energy: a ballad can be intense."),
  vocal: z.array(z.enum(VOCAL_KINDS)).optional().describe("Any-of. Use ['instrumental'] for focus lists."),
  moods: z.array(z.string()).optional().describe(
    `Any-of match on the controlled vocabulary: ${MOOD_VOCABULARY.join(", ")}. Common synonyms are folded automatically (e.g. 'chill' -> 'mellow', 'angry' -> 'furious').`
  ),
  exclude_moods: z.array(z.string()).optional(),
  mood_vibes: z.array(z.string()).optional().describe(
    `Named regions of mood-space, any-of: ${VIBE_NAMES.join(", ")}. Membership is computed from a track's mood coordinates, so this covers every labelled track in the library. Prefer this over \`vibes\` for any mood request.`
  ),
  fits_time: z.string().optional().describe("One of: early morning, morning, midday, afternoon, golden hour, evening, late night."),
  include_missing: z.boolean().optional().describe("Include tracks whose file is missing. Default false."),
  exclude_track_ids: z.array(z.string()).optional(),
  exclude_recent_runs: z.object({
    playlist: z.string().describe("The rolling playlist's fixed title, e.g. 'daylist' or 'mix: chill'."),
    runs: z.number().int().min(1).describe("How many of its past revisions to exclude. ~6 for an hourly list.")
  }).optional().describe(
    "Exclude everything the last N revisions of ONE rolling playlist used, so it moves on rather than repeating itself. Scoped to that playlist: what a different rolling list used is not excluded."
  ),
  max_per_artist: z.number().int().optional().describe("Cap tracks per artist. Use 1-2 for playlists."),
  max_per_album: z.number().int().optional(),
  sort: z.enum([
    "affinity",
    "random",
    "play_count",
    "listen_count",
    "recently_played",
    "least_recently_played",
    "recently_added",
    "year_desc",
    "year_asc",
    "duration_asc",
    "duration_desc",
    "hour_fit",
    "title"
  ]).optional().describe("Default 'affinity': a personal-fit blend of listens, plays, playlist membership and recency. Falls back gracefully where those signals are absent."),
  seed: z.number().int().optional().describe("Makes 'random'/'affinity' reproducible."),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional()
};
server.registerTool(
  "search_tracks",
  {
    title: "Search tracks with full compound filtering",
    description: "The main query tool, over the WHOLE library. Every filter composes: real year/date ranges, play and listen recency, the seven mood axes (energy, valence, intensity, acousticness, density, tempo_feel, vocal), mood descriptors, vibe regions, Last.fm tags, duration, time-of-day fit, plus per-artist diversity caps and personal-affinity ranking.\n\nFor mood requests use `mood_vibes` / `moods` / the axis ranges. `vibes` is a different thing: it matches only tracks filed onto a named playlist by hand, which many libraries have none of.\n\nThe mood filters need the labelling pass: check `mood_coverage` in describe_library before relying on them.",
    inputSchema: searchShape,
    annotations: { readOnlyHint: true }
  },
  tool(async (args) => {
    const { total, tracks } = search(store, { limit: 50, ...args });
    const dur = tracks.reduce((a, t) => a + t.duration, 0);
    return result(
      `${total} tracks matched; returning ${tracks.length} (${fmtDuration(dur)}).`,
      { total_matched: total, returned: tracks.length, tracks: tracks.map(brief) }
    );
  })
);
server.registerTool(
  "get_vibe_profile",
  {
    title: "Profile a vibe region or playlist",
    description: "What a vibe actually consists of IN THIS LIBRARY: top artists, genres, tags, era and tempo, where it sits in mood-space and how tightly it clusters, when during the day it gets played, and representative tracks. Use this to ground an abstract mood request in real music before searching.\n\nAccepts either a universal vibe region or, where the listener has them, a curated playlist name.",
    inputSchema: {
      vibe: z.string().describe(`A vibe region (${VIBE_NAMES.join(", ")}) or a curated playlist name.`),
      sample: z.number().int().min(0).max(50).optional().describe("Representative tracks to include. Default 12.")
    },
    annotations: { readOnlyHint: true }
  },
  tool(async ({ vibe, sample }) => {
    const region = VIBE_NAMES.find((k) => norm(k) === norm(vibe));
    const playlist = Object.keys(store.vibes).find((k) => norm(k) === norm(vibe));
    if (!region && !playlist) {
      const known = [...VIBE_NAMES, ...Object.keys(store.vibes)].join(", ");
      return result(`No vibe region or playlist named "${vibe}". Known: ${known}`);
    }
    const key = region ?? playlist;
    const tracks = region ? store.tracks.filter((t) => t.mood?.vibes.includes(region)) : store.vibes[playlist].map((id) => store.byId.get(id)).filter(Boolean);
    if (!tracks.length) {
      return result(
        region ? `No tracks fall in the "${key}" region. ${store.moodCoverage().note}` : `Playlist "${key}" is empty.`
      );
    }
    const points = tracks.map((t) => t.mood).filter((m) => Boolean(m));
    const centre = centroid(points);
    const count = (vals) => {
      const m = /* @__PURE__ */ new Map();
      for (const v of vals) m.set(v, (m.get(v) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const years = tracks.map((t) => t.year).filter(Boolean).sort((a, b) => a - b);
    const bpms = tracks.map((t) => t.bpm).filter((b) => !!b).sort((a, b) => a - b);
    const hours = new Array(24).fill(0);
    for (const t of tracks) for (let h = 0; h < 24; h++) hours[h] += t.hourHist[h] ?? 0;
    const peakHour = hours.indexOf(Math.max(...hours));
    return result(
      `"${key}": ${tracks.length} tracks, ${fmtDuration(tracks.reduce((a, t) => a + t.duration, 0))}.`,
      {
        vibe: key,
        kind: region ? "vibe region" : "curated playlist",
        gloss: region ? VIBE_SCHEDULE[region].gloss : void 0,
        tracks: tracks.length,
        // Where this library's take on the vibe actually sits, and how tightly
        // it holds together -- a wide spread means the region is catching things
        // that will not sequence well next to each other.
        mood_centre: centre ? {
          energy: Math.round(centre.energy),
          valence: Math.round(centre.valence),
          intensity: Math.round(centre.intensity),
          acousticness: Math.round(centre.acousticness),
          density: Math.round(centre.density),
          tempo: centre.tempoFeel,
          vocal: centre.vocal,
          common_moods: centre.moods
        } : null,
        mood_spread: points.length > 1 ? Number(spreadRadius(points).toFixed(1)) : null,
        mood_labelled: points.length,
        top_artists: count(tracks.map((t) => t.artist)).slice(0, 15).map(([artist, n]) => ({ artist, tracks: n })),
        genres: count(tracks.flatMap((t) => t.genres)).slice(0, 10).map(([genre, n]) => ({ genre, tracks: n })),
        tags: count(tracks.flatMap((t) => t.tags.slice(0, 6).map((x) => x.name))).slice(0, 20).map(([tag, n]) => ({ tag, tracks: n })),
        era: years.length ? {
          median_year: years[Math.floor(years.length / 2)],
          p10: years[Math.floor(years.length * 0.1)],
          p90: years[Math.floor(years.length * 0.9)]
        } : null,
        median_bpm: bpms.length ? bpms[Math.floor(bpms.length / 2)] : null,
        median_track_length_sec: Math.round(
          tracks.map((t) => t.duration).sort((a, b) => a - b)[Math.floor(tracks.length / 2)] ?? 0
        ),
        listens_by_hour: hours,
        peak_hour: hours[peakHour] ? peakHour : null,
        sample_tracks: tracks.slice().sort((a, b) => b.listens - a.listens).slice(0, sample ?? 12).map(brief)
      }
    );
  })
);
server.registerTool(
  "similar_tracks",
  {
    title: "Find similar tracks in the library",
    description: "Expand from seed tracks or artists. Combines Navidrome's agent-backed similarity (Last.fm/Deezer/ListenBrainz) with co-occurrence in the listener's own playlists, where those exist: tracks repeatedly filed alongside the seed. Results are restricted to what is actually in the library.",
    inputSchema: {
      track_ids: z.array(z.string()).optional().describe("Seed track ids."),
      artists: z.array(z.string()).optional().describe("Seed artist names."),
      limit: z.number().int().min(1).max(200).optional(),
      exclude_seed_artists: z.boolean().optional().describe("Drop the seeds' own artists. Default true.")
    },
    annotations: { readOnlyHint: true }
  },
  tool(
    async ({
      track_ids,
      artists,
      limit,
      exclude_seed_artists
    }) => {
      const seeds = (track_ids ?? []).map((id) => store.byId.get(id)).filter(Boolean);
      const seedArtistNames = /* @__PURE__ */ new Set([
        ...seeds.map((t) => norm(t.artist)),
        ...(artists ?? []).map(norm)
      ]);
      const scores = /* @__PURE__ */ new Map();
      const bump = (id, w) => scores.set(id, (scores.get(id) ?? 0) + w);
      const seedIds = new Set(seeds.map((t) => t.id));
      for (const ids of Object.values(store.vibes)) {
        const set = new Set(ids);
        const overlap = [...seedIds].filter((id) => set.has(id)).length;
        if (!overlap) continue;
        for (const id of ids) if (!seedIds.has(id)) bump(id, 2 * overlap);
      }
      const artistIds = new Set(seeds.map((t) => t.artistId).filter(Boolean));
      for (const name of artists ?? []) {
        const hit = store.tracks.find((t) => norm(t.artist) === norm(name));
        if (hit?.artistId) artistIds.add(hit.artistId);
      }
      for (const aid of [...artistIds].slice(0, 6)) {
        try {
          const similar = await navidrome.similarSongs(aid, 50);
          for (const s of similar) {
            const t = store.byId.get(String(s.id));
            if (t) bump(t.id, 3);
          }
          const info = await navidrome.artistInfo(aid, 20);
          const names = new Set(info.similarArtist.map((a) => norm(a.name)));
          for (const t of store.tracks) if (names.has(norm(t.artist))) bump(t.id, 1.5);
        } catch {
        }
      }
      const dropSeedArtists = exclude_seed_artists !== false;
      const ranked = [...scores.entries()].map(([id, s]) => ({ t: store.byId.get(id), s })).filter((x) => x.t && !x.t.missing && !seedIds.has(x.t.id)).filter((x) => !dropSeedArtists || !seedArtistNames.has(norm(x.t.artist))).sort((a, b) => b.s - a.s || b.t.listens - a.t.listens).slice(0, limit ?? 40);
      return result(`${ranked.length} similar tracks found in the library.`, {
        seeds: seeds.map((t) => `${t.artist} - ${t.title}`),
        tracks: ranked.map((x) => ({ ...brief(x.t), similarity: Number(x.s.toFixed(1)) }))
      });
    }
  )
);
server.registerTool(
  "listening_history",
  {
    title: "Analyse listening history",
    description: "Query the ListenBrainz history: recent plays, top artists/tracks over a window, hour-of-day and weekday habits, rising/falling trends, and long-loved-but-forgotten tracks worth resurfacing. This is the only source of timestamped history: Navidrome itself keeps only a play count and a last-played time.",
    inputSchema: {
      mode: z.enum(["recent", "top", "by_hour", "by_weekday", "rediscover", "trending"]).describe("Which analysis to run."),
      days: z.number().int().optional().describe("Window in days. Default 30."),
      hour_of_day: z.number().int().min(0).max(23).optional().describe("For mode 'by_hour'. Defaults to now."),
      limit: z.number().int().min(1).max(200).optional()
    },
    annotations: { readOnlyHint: true }
  },
  tool(
    async ({
      mode,
      days,
      hour_of_day,
      limit
    }) => {
      const n = limit ?? 25;
      const window = days ?? 30;
      const tc = timeContext(TZ);
      if (mode === "recent") {
        const recent = store.listens.slice(-n).reverse();
        return result(`Last ${recent.length} listens.`, {
          listens: recent.map((l) => ({
            at: new Date(l.ts * 1e3).toISOString(),
            artist: l.artist,
            track: l.track
          }))
        });
      }
      if (mode === "top") {
        const cutoff = Math.floor(Date.now() / 1e3) - window * 86400;
        const tracks = /* @__PURE__ */ new Map();
        const artists = /* @__PURE__ */ new Map();
        for (let i = store.listens.length - 1; i >= 0; i--) {
          const l = store.listens[i];
          if (l.ts < cutoff) break;
          const k = `${l.artist} - ${l.track}`;
          tracks.set(k, { label: k, n: (tracks.get(k)?.n ?? 0) + 1 });
          artists.set(l.artist, (artists.get(l.artist) ?? 0) + 1);
        }
        return result(`Top listening over the last ${window} days.`, {
          window_days: window,
          top_tracks: [...tracks.values()].sort((a, b) => b.n - a.n).slice(0, n),
          top_artists: [...artists.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([artist, listens]) => ({ artist, listens }))
        });
      }
      if (mode === "by_hour") {
        const h = hour_of_day ?? tc.hour;
        return result(`What gets played around ${h}:00 (${TZ}).`, {
          hour: h,
          ...hourProfile(store, h),
          vibe_fit: vibeFits(store, h)
        });
      }
      if (mode === "by_weekday") {
        const dow = new Array(7).fill(0);
        const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" });
        const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        for (const l of store.listens) dow[map[fmt.format(new Date(l.ts * 1e3))] ?? 0]++;
        const hours = new Array(24).fill(0);
        for (const t of store.tracks) for (let i = 0; i < 24; i++) hours[i] += t.hourHist[i] ?? 0;
        return result("Listening distribution across the week and the day.", {
          by_weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => ({
            day: d,
            listens: dow[i]
          })),
          by_hour: hours.map((v, i) => ({ hour: i, listens: v }))
        });
      }
      if (mode === "rediscover") {
        const r = rediscoveries(store, 5, window > 60 ? window : 365, n);
        return result(`${r.length} long-loved tracks not heard in a long time.`, {
          tracks: r.map(brief)
        });
      }
      const nowS = Math.floor(Date.now() / 1e3);
      const recentCut = nowS - window * 86400;
      const priorCut = nowS - 2 * window * 86400;
      const recentC = /* @__PURE__ */ new Map();
      const priorC = /* @__PURE__ */ new Map();
      for (const l of store.listens) {
        if (l.ts >= recentCut) recentC.set(l.artist, (recentC.get(l.artist) ?? 0) + 1);
        else if (l.ts >= priorCut) priorC.set(l.artist, (priorC.get(l.artist) ?? 0) + 1);
      }
      const rows = [...recentC.entries()].map(([artist, now]) => ({ artist, now, before: priorC.get(artist) ?? 0 })).filter((r) => r.now >= 3).map((r) => ({ ...r, lift: Number((r.now / Math.max(1, r.before)).toFixed(2)) })).sort((a, b) => b.lift - a.lift || b.now - a.now);
      return result(`Artist momentum: last ${window}d vs the ${window}d before.`, {
        rising: rows.slice(0, n),
        fading: rows.filter((r) => r.lift < 1).slice(-n).reverse()
      });
    }
  )
);
server.registerTool(
  "list_playlists",
  {
    title: "List playlists",
    description: "All playlists in Navidrome, including which count as hand-curated taste signal and which are smart (self-updating).",
    inputSchema: {},
    annotations: { readOnlyHint: true }
  },
  tool(async () => {
    const pls = await navidrome.listPlaylists();
    return result(`${pls.length} playlists.`, {
      playlists: pls.map((p) => ({
        id: p.id,
        name: p.name,
        tracks: p.songCount,
        duration: fmtDuration(p.duration ?? 0),
        smart: Boolean(p.rules),
        file_synced: Boolean(p.sync),
        hand_curated: Object.keys(store.vibes).includes(p.name),
        comment: p.comment || void 0,
        updated: p.updatedAt
      }))
    });
  })
);
server.registerTool(
  "get_playlist",
  {
    title: "Get a playlist's tracks",
    description: "Full track list of one playlist, by id or name.",
    inputSchema: {
      playlist_id: z.string().optional(),
      name: z.string().optional(),
      limit: z.number().int().min(1).max(1e3).optional()
    },
    annotations: { readOnlyHint: true }
  },
  tool(async ({ playlist_id, name, limit }) => {
    const id = playlist_id ?? await resolvePlaylistId(name);
    if (!id) return result(`No playlist found for ${JSON.stringify(name)}.`);
    const rows = await navidrome.playlistTracks(id);
    const tracks = rows.map((r) => store.byId.get(r.id)).filter(Boolean);
    return result(`${rows.length} tracks.`, {
      playlist_id: id,
      tracks: (tracks.length ? tracks : []).slice(0, limit ?? 200).map(brief)
    });
  })
);
async function resolvePlaylistId(name) {
  if (!name) return void 0;
  const pls = await navidrome.listPlaylists();
  return pls.find((p) => norm(p.name) === norm(name))?.id;
}
server.registerTool(
  "create_playlist",
  {
    title: "Create a playlist",
    description: "Create a new playlist from an explicit list of track ids (use search_tracks to source them).",
    inputSchema: {
      name: z.string(),
      track_ids: z.array(z.string()),
      comment: z.string().optional().describe("Shown as the playlist description in Navidrome."),
      public: z.boolean().optional()
    }
  },
  tool(
    async ({
      name,
      track_ids,
      comment,
      public: isPublic
    }) => {
      const id = await navidrome.createPlaylist({ name, comment, public: isPublic });
      const added = await navidrome.addTracks(id, track_ids);
      return result(`Created "${name}" with ${added} tracks.`, { playlist_id: id, added });
    }
  )
);
server.registerTool(
  "update_playlist",
  {
    title: "Update a playlist",
    description: "Rename a playlist, change its description, and/or replace or append its tracks. For a rolling playlist use `commit_playlist` instead: it does the same refresh but cannot rename or duplicate the list.",
    inputSchema: {
      playlist_id: z.string().optional(),
      name: z.string().optional().describe("Existing playlist name, if not passing an id."),
      new_name: z.string().optional(),
      comment: z.string().optional(),
      track_ids: z.array(z.string()).optional(),
      mode: z.enum(["replace", "append"]).optional().describe("How to apply track_ids. Default 'replace'."),
      public: z.boolean().optional()
    }
  },
  tool(
    async (a) => {
      const id = a.playlist_id ?? await resolvePlaylistId(a.name);
      if (!id) return result(`No playlist found for ${JSON.stringify(a.name)}.`);
      if (a.new_name || a.comment !== void 0 || a.public !== void 0) {
        await navidrome.updatePlaylist(id, {
          ...a.new_name ? { name: a.new_name } : {},
          ...a.comment !== void 0 ? { comment: a.comment } : {},
          ...a.public !== void 0 ? { public: a.public } : {}
        });
      }
      let n = 0;
      if (a.track_ids) {
        n = (a.mode ?? "replace") === "append" ? await navidrome.addTracks(id, a.track_ids) : await navidrome.replaceTracks(id, a.track_ids);
      }
      return result(`Updated playlist${a.track_ids ? ` (${n} tracks)` : ""}.`, {
        playlist_id: id,
        tracks_written: n
      });
    }
  )
);
server.registerTool(
  "delete_playlist",
  {
    title: "Delete a playlist",
    description: "Permanently delete a playlist. Does not touch the audio files.",
    inputSchema: { playlist_id: z.string().optional(), name: z.string().optional() },
    annotations: { destructiveHint: true }
  },
  tool(async ({ playlist_id, name }) => {
    const id = playlist_id ?? await resolvePlaylistId(name);
    if (!id) return result(`No playlist found for ${JSON.stringify(name)}.`);
    await navidrome.deletePlaylist(id);
    return result(`Deleted playlist ${id}.`);
  })
);
server.registerTool(
  "create_smart_playlist",
  {
    title: "Create a smart (self-updating) playlist",
    description: `Create a playlist defined by RULES rather than a fixed track list. Navidrome re-evaluates it continuously, so it stays current without regeneration: ideal for standing playlists like '90s rock I haven't played in a year'.

Rules are Navidrome's native criteria format:
{"all":[{"is":{"genre":"Rock"}},{"inTheRange":{"year":[1990,1999]}},{"notInTheLast":{"lastPlayed":365}}],"sort":"playCount","order":"desc","limit":100}

Operators: is, isNot, gt, lt, contains, notContains, startsWith, endsWith, inTheRange, before, after, inTheLast, notInTheLast. Combine with all (AND) / any (OR), which may nest. Fields include: title, album, artist, albumartist, genre, year, dateadded, datemodified, lastplayed, playcount, rating, starred, loved, comment, bpm, length, filepath, filetype.

Note: rules operate on Navidrome's own fields only; ListenBrainz listen counts and Last.fm tags are NOT available here. For those, use search_tracks plus create_playlist.`,
    inputSchema: {
      name: z.string(),
      rules: z.record(z.any()).describe("Navidrome smart-playlist criteria object."),
      comment: z.string().optional(),
      public: z.boolean().optional()
    }
  },
  tool(
    async ({
      name,
      rules,
      comment,
      public: isPublic
    }) => {
      const id = await navidrome.createPlaylist({ name, comment, public: isPublic, rules });
      let matched = 0;
      try {
        const { total } = await navidrome.nd("GET", `playlist/${id}/tracks`, {
          _start: 0,
          _end: 1
        });
        matched = total ?? 0;
      } catch {
      }
      return result(
        `Created smart playlist "${name}" (currently matching ${matched} tracks).` + (matched === 0 ? " Zero matches usually means the rules reference an unknown field or an impossible combination." : ""),
        { playlist_id: id, matched }
      );
    }
  )
);
server.registerTool(
  "now_context",
  {
    title: "What suits right now",
    description: "What suits right now, in this library, at this hour: local time and part of day, which vibe regions fit the hour (measured as lift over each region's own average where listen history exists, falling back to the region's declared hours where it does not), the artists/genres/tags that dominate this hour historically, what has been heard in the last few days, and what the recent rolling-playlist revisions already used. Call it before building any playlist meant for the present moment, whether that is the hourly daylist or a standing mix.",
    inputSchema: {
      hour_of_day: z.number().int().min(0).max(23).optional().describe("Override the current hour."),
      playlist: z.string().optional().describe("Report only this rolling playlist's own past revisions, e.g. 'mix: chill'."),
      recent_runs: z.number().int().optional().describe("How many past revisions to report. Default 8.")
    },
    annotations: { readOnlyHint: true }
  },
  tool(
    async ({
      hour_of_day,
      playlist,
      recent_runs
    }) => {
      const tc = timeContext(TZ);
      const hour = hour_of_day ?? tc.hour;
      const runs = store.recentRuns(recent_runs ?? 8, playlist);
      return result(
        `${tc.dayName} ${String(hour).padStart(2, "0")}:00 (${tc.partOfDay}, ${tc.season}) in ${TZ}.`,
        {
          now: { ...tc, hour },
          vibe_fit: vibeFits(store, hour),
          hour_profile: hourProfile(store, hour),
          recent_activity: recentActivity(store, 7),
          recent_playlist_runs: runs.map((r) => ({
            at: new Date(r.at).toISOString(),
            playlist: r.playlist,
            description: r.description,
            tracks: r.trackIds.length
          })),
          rotation_note: "Pass exclude_recent_runs to search_tracks, naming the playlist you are about to write and how many of its past revisions to skip (6 suits an hourly list), so it moves on instead of repeating itself."
        }
      );
    }
  )
);
server.registerTool(
  "commit_playlist",
  {
    title: "Publish a revision of a rolling playlist",
    description: "Write one revision of a rolling playlist in a single step: find the playlist by its exact title, replace its tracks, and set its description. A rolling playlist keeps one title for its whole life, so the title is how it is identified and is never rewritten; the line that changes between revisions is the description. Creates the playlist the first time a title is used, and never a second time.",
    inputSchema: {
      title: z.string().describe(
        "The playlist's permanent title, e.g. 'daylist', 'on repeat' or 'mix: chill'. Matched exactly, ignoring case and surrounding space."
      ),
      track_ids: z.array(z.string()).min(1).describe("The final ordered set of tracks."),
      description: z.string().optional().describe(
        "One line on why these tracks now, shown as the playlist's comment in Navidrome. This is where a phrase like 'golden hour synth cruise' belongs."
      )
    }
  },
  tool(
    async ({
      title,
      track_ids,
      description
    }) => {
      const wanted = norm(title);
      const pls = await navidrome.listPlaylists();
      const matches = pls.filter((p) => norm(p.name ?? "") === wanted).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const existing = matches[0];
      const id = existing?.id ?? await navidrome.createPlaylist({ name: title, comment: description ?? "", public: false });
      const written = existing ? await navidrome.replaceTracks(id, track_ids) : await navidrome.addTracks(id, track_ids);
      if (existing) await navidrome.updatePlaylist(id, { comment: description ?? "" });
      store.recordPlaylistRun({ at: Date.now(), playlist: title, description, trackIds: track_ids });
      await store.saveSnapshot();
      const dur = track_ids.map((i) => store.byId.get(i)?.duration ?? 0).reduce((a, b) => a + b, 0);
      return result(
        `"${title}" now holds ${written} tracks (${fmtDuration(dur)}).` + (existing ? "" : " Created it.") + (matches.length > 1 ? ` Note: ${matches.length} playlists already share this title; wrote to ${id}.` : ""),
        {
          playlist_id: id,
          title,
          tracks: written,
          duration: fmtDuration(dur),
          created: !existing,
          description
        }
      );
    }
  )
);
server.registerTool(
  "mood_coverage",
  {
    title: "Check mood labelling coverage",
    description: "How much of the library carries a usable mood label, and what to do when the answer is none.\n\nThis server does not label anything. Mood comes from the `navidrome-mood` plugin, which runs inside Navidrome, judges each track and writes the values into the audio files as tags. That is what makes them visible to Navidrome's own smart playlists and to every Subsonic client, not just to this server.",
    inputSchema: {},
    annotations: { readOnlyHint: true }
  },
  tool(async () => {
    const c = store.moodCoverage();
    return result(c.note, { ...c, tags_read: MOOD_TAG_NAMES });
  })
);
server.registerTool(
  "refresh_index",
  {
    title: "Refresh the local index",
    description: "Re-sync from Navidrome and/or ListenBrainz. The index is a cache: the library is pulled in full (~20s) and listens incrementally. Call this if the library changed and results look stale.",
    inputSchema: {
      scope: z.enum(["library", "listens", "all"]).optional().describe("Default 'all'."),
      full_listens: z.boolean().optional().describe(
        "Re-pull the entire listen history, not just new ones. Needed when listens were added with OLDER timestamps, which is what an importer backfilling history does: an incremental sync resumes from the newest listen already held and never looks behind it."
      )
    }
  },
  tool(async ({ scope, full_listens }) => {
    const s = scope ?? "all";
    const out = {};
    if (s === "library" || s === "all") out.library = await store.syncLibrary();
    if (s === "listens" || s === "all") out.new_listens = await store.syncListens(full_listens);
    await store.saveSnapshot();
    return result(
      `Index refreshed: ${store.tracks.length} tracks, ${store.listens.length} listens.`,
      { ...out, tag_enrichment: store.enrichState }
    );
  })
);
server.registerPrompt(
  "daylist",
  {
    title: "Refresh the daylist for this hour",
    description: "Spotify-style daylist: read what suits right now, pick a vibe that fits the hour, source ~25 tracks that hold together, and publish them to the `daylist` playlist with a description that says what this hour sounds like.",
    argsSchema: {
      length: z.string().optional().describe("Roughly how many tracks. Default 25."),
      steer: z.string().optional().describe("Optional nudge, e.g. 'keep it instrumental' or 'lean older'.")
    }
  },
  ({ length, steer }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `Refresh my daylist for right now (about ${length || "25"} tracks).`,
            steer ? `Steer: ${steer}` : "",
            "",
            "Work in this order and do not skip steps:",
            "",
            '1. Call `now_context` with playlist: "daylist". Read vibe_fit, the hour_profile, and what',
            "   I have heard in the last few days. Note the descriptions of its recent revisions.",
            "",
            "2. Pick the vibe for THIS hour. Prefer one with lift > 1: that is measured evidence I",
            "   really do reach for it now. Where lift is null there is no history for that region, so",
            "   fall back to `suits_hour`. If two are close, take the one the recent revisions have used",
            "   least. Call `get_vibe_profile` to hear what that region actually contains here, and",
            "   check its mood_spread: a wide one means you will have to narrow the search yourself.",
            "",
            "3. Source tracks with `search_tracks`. Requirements:",
            "     - use `mood_vibes` with that region, plus the axis ranges and `fits_time` to shape it",
            "     - keep the set coherent: narrow `tempo_feel` and `intensity` rather than taking",
            "       whatever the region returns. Two tracks with the same mood word can still sound",
            "       nothing alike, and the axes are what stop that",
            '     - pass `exclude_recent_runs: {playlist: "daylist", runs: 6}` so this is not a rerun',
            "     - pass `max_per_artist: 2` so it does not collapse onto one artist",
            "     - pass `hour_of_day` from the context and leave sort on `affinity`",
            "     - over-fetch (limit ~60) and then choose the final set yourself for flow",
            "   Mix roughly 70% things I clearly love with 30% that are either long-unheard",
            "   (`not_listened_within_days`) or recently added: a daylist that only replays this",
            "   week's rotation is boring.",
            "",
            "4. Sequence them deliberately: open with something that lands immediately, keep the energy",
            "   coherent with the hour, avoid two songs by the same artist back to back, and do not put",
            "   a sparse acoustic track next to a dense loud one however well they match on mood.",
            "",
            "5. Write the description the way Spotify names a daylist: lowercase, 2-4 words, concrete",
            "   and a little specific, evoking the time and feel rather than the genre, e.g. 'golden hour",
            "   synth cruise', 'slow shreds tuesday haze', 'late night verse vibes'. Do not reuse a",
            "   recent one.",
            "",
            '6. Publish with `commit_playlist`, passing title: "daylist", the ordered track_ids, and that',
            "   line as the description. The playlist keeps the title `daylist` permanently: the hour's",
            "   phrase lives in the description, so do not put it in the title and do not rename anything.",
            "",
            "Then tell me, briefly: the description you wrote, the vibe you picked and why the data",
            "supported it, and 3-4 highlights. Do not list every track."
          ].filter(Boolean).join("\n")
        }
      }
    ]
  })
);
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  void store.ensureReady().catch((e) => {
    console.error("[navidrome-mcp] initial index build failed:", e);
  });
}
main().catch((e) => {
  console.error("[navidrome-mcp] fatal:", e);
  process.exit(1);
});
