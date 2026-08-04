#!/usr/bin/env node

// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { socksDispatcher } from "fetch-socks";
import { z } from "zod";

// src/listenbrainz.ts
var API = "https://api.listenbrainz.org/1";
var UA = "navidrome-mcp/1.0 (+https://github.com/312-dev/navidrome-mcp)";
var ListenBrainz = class {
  constructor(username, dispatcher2) {
    this.username = username;
    this.dispatcher = dispatcher2;
  }
  username;
  dispatcher;
  async get(url) {
    const opts = { headers: { "user-agent": UA } };
    if (this.dispatcher) opts.dispatcher = this.dispatcher;
    const res = await fetch(url, opts);
    if (!res.ok) {
      throw new Error(`ListenBrainz ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return await res.json();
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
   */
  async listens(opts = {}) {
    const since = opts.since ?? 0;
    const max = opts.max ?? Infinity;
    const out = [];
    let maxTs;
    for (let page = 0; page < 2e3; page++) {
      const qs = new URLSearchParams({ count: "1000" });
      if (maxTs !== void 0) qs.set("max_ts", String(maxTs));
      const body = await this.get(
        `${API}/user/${encodeURIComponent(this.username)}/listens?${qs}`
      );
      const payload = body.payload;
      const rows = payload?.listens ?? [];
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
          release: m.release_name
        });
      }
      opts.onProgress?.(out.length);
      if (hitFloor || out.length >= max || !Number.isFinite(oldest)) break;
      maxTs = oldest;
    }
    return out.slice(0, Number.isFinite(max) ? max : void 0);
  }
};
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
  const out = [];
  for (const [vibe, ids] of Object.entries(store2.vibes)) {
    let inWindow = 0;
    let totalListens = 0;
    const artistCounts = /* @__PURE__ */ new Map();
    for (const id of ids) {
      const t = store2.byId.get(id);
      if (!t || !t.listens) continue;
      totalListens += t.listens;
      for (const h of window) inWindow += t.hourHist[h] ?? 0;
      artistCounts.set(t.artist, (artistCounts.get(t.artist) ?? 0) + t.listens);
    }
    if (!totalListens) continue;
    const observed = inWindow / totalListens;
    out.push({
      vibe,
      tracks: ids.length,
      listens_in_window: inWindow,
      lift: Number((observed / windowShare).toFixed(2)),
      top_artists: [...artistCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a]) => a)
    });
  }
  return out.sort((a, b) => b.lift - a.lift);
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
function search(store2, p) {
  const now = Date.now();
  const nowSec = Math.floor(now / 1e3);
  const excluded = new Set(p.exclude_track_ids ?? []);
  if (p.exclude_recent_daylists && p.exclude_recent_daylists > 0) {
    for (const id of store2.recentDaylistTrackIds(p.exclude_recent_daylists)) excluded.add(id);
  }
  const qTerms = p.query ? norm(p.query).split(" ").filter(Boolean) : [];
  const decadeSet = new Set(
    (p.decades ?? []).map((d) => Number(String(d).replace(/[^0-9]/g, ""))).filter(Boolean)
  );
  const releasedAfter = p.released_after ? Date.parse(p.released_after) : NaN;
  const releasedBefore = p.released_before ? Date.parse(p.released_before) : NaN;
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
    vibes: t.vibes.length ? t.vibes : void 0,
    tags: t.tags.length ? t.tags.slice(0, 6).map((x) => x.name) : void 0,
    starred: t.starred || void 0,
    bpm: t.bpm || void 0
  };
}

// src/store.ts
import { mkdir, readFile, rename, writeFile } from "fs/promises";
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

// src/store.ts
var SNAPSHOT_VERSION = 3;
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
  daylistRuns = [];
  syncedAt = 0;
  listensSyncedAt = 0;
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
    }
    if (this.opts.enrich) void this.enrichInBackground();
  }
  // ── persistence ─────────────────────────────────────────────────────────
  async loadSnapshot() {
    try {
      const raw = await readFile(this.snapshotPath, "utf8");
      const s = JSON.parse(raw);
      if (s.version !== SNAPSHOT_VERSION) return false;
      this.syncedAt = s.syncedAt;
      this.listensSyncedAt = s.listensSyncedAt;
      this.vibes = s.vibes ?? {};
      this.trackTags = s.trackTags ?? {};
      this.artistTags = s.artistTags ?? {};
      this.taggedTracks = new Set(s.taggedTracks ?? []);
      this.taggedArtists = new Set(s.taggedArtists ?? []);
      this.daylistRuns = s.daylistRuns ?? [];
      this.listens = (s.listenTs ?? []).map((ts, i) => {
        const key = s.listenKeys[s.listenKi[i]] ?? " ";
        const sep = key.indexOf("\0");
        return { ts, artist: key.slice(0, sep), track: key.slice(sep + 1) };
      });
      this.build(s.songs ?? []);
      return this.tracks.length > 0;
    } catch {
      return false;
    }
  }
  async saveSnapshot() {
    const keyIndex = /* @__PURE__ */ new Map();
    const listenKeys = [];
    const listenTs = [];
    const listenKi = [];
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
      taggedTracks: [...this.taggedTracks],
      taggedArtists: [...this.taggedArtists],
      daylistRuns: this.daylistRuns.slice(-200)
    };
    await mkdir(dirname(this.snapshotPath), { recursive: true });
    const tmp = `${this.snapshotPath}.tmp`;
    await writeFile(tmp, JSON.stringify(snap), "utf8");
    await rename(tmp, this.snapshotPath);
  }
  // ── syncing ─────────────────────────────────────────────────────────────
  rawSongs = [];
  /** Pull every track and every playlist, and rebuild the derived index. */
  async syncLibrary() {
    const nd = this.opts.navidrome;
    const songs = await nd.allSongs();
    const playlists = await nd.listPlaylists();
    this.playlists = playlists;
    const vibes = {};
    for (const p of playlists) {
      if (!p.name || !p.id) continue;
      if (this.isNonVibePlaylist(p)) continue;
      try {
        const rows = await nd.playlistTracks(p.id);
        vibes[p.name] = rows.map((r) => r.id);
      } catch {
      }
    }
    this.vibes = vibes;
    this.syncedAt = Date.now();
    this.build(songs);
    return { tracks: this.tracks.length, vibes: Object.keys(vibes).length };
  }
  /**
   * Which playlists represent the user's own mood vocabulary.
   *
   * Excluded: the rolling daylist (it is our own output, so treating it as taste
   * input would feed the generator its own tail), and anything the ListenBrainz
   * plugin imported (those are LB's recommendations, not his labels).
   */
  isNonVibePlaylist(p) {
    const name = (p.name ?? "").toLowerCase();
    if (name === this.opts.daylistName.toLowerCase()) return true;
    if (name.startsWith("daylist")) return true;
    if ((p.comment ?? "").includes("listenbrainz.org/playlist")) return true;
    if (/^(listenbrainz|generated daily jams|last week's jams)/i.test(p.name ?? "")) return true;
    return false;
  }
  async syncListens(full = false) {
    if (!this.lb) return 0;
    const since = full ? 0 : this.listensSyncedAt;
    const fresh = await this.lb.listens({ since });
    if (fresh.length) {
      const seen = new Set(this.listens.map((l) => `${l.ts}|${l.artist}|${l.track}`));
      for (const l of fresh) {
        const k = `${l.ts}|${l.artist}|${l.track}`;
        if (!seen.has(k)) {
          seen.add(k);
          this.listens.push(l);
        }
      }
      this.listens.sort((a, b) => a.ts - b.ts);
    }
    this.listensSyncedAt = this.listens.length ? this.listens[this.listens.length - 1].ts : 0;
    this.applyListenStats();
    return fresh.length;
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
        nkey: matchKey(primaryArtist(artist), title)
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
  recordDaylistRun(run) {
    this.daylistRuns.push(run);
    if (this.daylistRuns.length > 200) this.daylistRuns = this.daylistRuns.slice(-200);
  }
  /** Track ids used by the last `runs` daylists, for rotation avoidance. */
  recentDaylistTrackIds(runs) {
    const out = /* @__PURE__ */ new Set();
    for (const r of this.daylistRuns.slice(-Math.max(0, runs))) {
      for (const id of r.trackIds) out.add(id);
    }
    return out;
  }
};

// src/index.ts
var env = process.env;
var TZ = env.NAVIDROME_TZ || "America/Chicago";
var DAYLIST_NAME = env.DAYLIST_PLAYLIST_NAME || "daylist";
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
  daylistName: DAYLIST_NAME,
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
    description: "Orientation for the whole library: size, genre and decade distribution, the user's own curated mood playlists (his personal vibe vocabulary), the Last.fm tag vocabulary available for filtering, and listening-history coverage. Call this FIRST when you need to build a playlist and do not yet know what the library contains.",
    inputSchema: {},
    annotations: { readOnlyHint: true }
  },
  tool(async () => {
    const totalSec = store.tracks.reduce((a, t) => a + t.duration, 0);
    const withListens = store.tracks.filter((t) => t.listens > 0).length;
    const vibes = Object.entries(store.vibes).map(([name, ids]) => ({ vibe: name, tracks: ids.length })).sort((a, b) => b.tracks - a.tracks);
    return result(
      `Library: ${store.tracks.length} tracks, ${fmtDuration(totalSec)} total. ${vibes.length} curated mood playlists. ${store.listens.length} ListenBrainz listens on file (${withListens} tracks matched).`,
      {
        tracks: store.tracks.length,
        missing_files: store.tracks.filter((t) => t.missing).length,
        artists: new Set(store.tracks.map((t) => t.artistId || t.artist)).size,
        albums: new Set(store.tracks.map((t) => t.albumId)).size,
        total_duration: fmtDuration(totalSec),
        library_synced_at: new Date(store.syncedAt).toISOString(),
        curated_vibes: vibes,
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
        note: "The whole library is a favourites sync, so every track here is already something he liked. Selection is about fit for the moment, not about whether he likes it."
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
  vibes: z.array(z.string()).optional().describe("Restrict to tracks on these curated playlists, e.g. ['golden hour','textured']."),
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
  hour_of_day: z.number().int().min(0).max(23).optional().describe("Only tracks he has actually listened to at this local hour."),
  day_of_week: z.number().int().min(0).max(6).optional().describe("0 = Sunday."),
  duration_min_sec: z.number().optional(),
  duration_max_sec: z.number().optional(),
  bpm_min: z.number().optional(),
  bpm_max: z.number().optional(),
  starred: z.boolean().optional(),
  include_missing: z.boolean().optional().describe("Include tracks whose file is missing. Default false."),
  exclude_track_ids: z.array(z.string()).optional(),
  exclude_recent_daylists: z.number().int().optional().describe("Exclude everything used by the last N daylist runs. Use ~6 for hourly rotation."),
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
  ]).optional().describe("Default 'affinity': a personal-fit blend of listens, plays, curated membership and recency."),
  seed: z.number().int().optional().describe("Makes 'random'/'affinity' reproducible."),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional()
};
server.registerTool(
  "search_tracks",
  {
    title: "Search tracks with full compound filtering",
    description: "The main query tool. Every filter composes: real year/date ranges, play and listen recency, curated mood membership, Last.fm tags, duration, BPM, time-of-day habit, plus per-artist diversity caps and personal-affinity ranking. Use this to source tracks for a playlist.",
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
    title: "Profile a curated mood playlist",
    description: "What one of the user's own mood playlists actually consists of: top artists, genres, tags, era and tempo, when during the day he plays it, and representative tracks. Use this to ground an abstract mood request in what that word means in HIS library.",
    inputSchema: {
      vibe: z.string().describe("Curated playlist name, e.g. 'golden hour'."),
      sample: z.number().int().min(0).max(50).optional().describe("Representative tracks to include. Default 12.")
    },
    annotations: { readOnlyHint: true }
  },
  tool(async ({ vibe, sample }) => {
    const key = Object.keys(store.vibes).find((k) => norm(k) === norm(vibe));
    if (!key) {
      return result(
        `No curated playlist named "${vibe}". Available: ${Object.keys(store.vibes).join(", ")}`
      );
    }
    const tracks = store.vibes[key].map((id) => store.byId.get(id)).filter(Boolean);
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
        tracks: tracks.length,
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
    description: "Expand from seed tracks or artists. Combines Navidrome's agent-backed similarity (Last.fm/Deezer/ListenBrainz) with co-occurrence in the user's own curated playlists \u2014 tracks he himself repeatedly files alongside the seed. Results are restricted to what is actually in the library.",
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
    description: "Query the ListenBrainz history: recent plays, top artists/tracks over a window, hour-of-day and weekday habits, rising/falling trends, and long-loved-but-forgotten tracks worth resurfacing. This is the only source of timestamped history \u2014 Navidrome itself keeps only a play count and a last-played time.",
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
    description: "All playlists in Navidrome, including which are curated mood playlists and which are smart (self-updating).",
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
        is_curated_vibe: Object.keys(store.vibes).includes(p.name),
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
    description: "Rename a playlist, change its description, and/or replace or append its tracks. Replacing is the normal way to refresh a rolling playlist in place.",
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
    description: `Create a playlist defined by RULES rather than a fixed track list. Navidrome re-evaluates it continuously, so it stays current without regeneration \u2014 ideal for standing playlists like '90s rock I haven't played in a year'.

Rules are Navidrome's native criteria format:
{"all":[{"is":{"genre":"Rock"}},{"inTheRange":{"year":[1990,1999]}},{"notInTheLast":{"lastPlayed":365}}],"sort":"playCount","order":"desc","limit":100}

Operators: is, isNot, gt, lt, contains, notContains, startsWith, endsWith, inTheRange, before, after, inTheLast, notInTheLast. Combine with all (AND) / any (OR), which may nest. Fields include: title, album, artist, albumartist, genre, year, dateadded, datemodified, lastplayed, playcount, rating, starred, loved, comment, bpm, length, filepath, filetype.

Note: rules operate on Navidrome's own fields only \u2014 ListenBrainz listen counts and Last.fm tags are NOT available here. For those, use search_tracks plus create_playlist.`,
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
  "daylist_context",
  {
    title: "Get daylist context for right now",
    description: "Everything needed to generate this hour's daylist: local time and part of day, which of his curated moods he actually reaches for at this hour (measured as lift over that mood's own average, so it is not just playlist size), the artists/genres/tags that dominate this hour historically, what he has heard in the last few days, and the titles of recent daylists so the new one does not repeat them.",
    inputSchema: {
      hour_of_day: z.number().int().min(0).max(23).optional().describe("Override the current hour."),
      recent_runs: z.number().int().optional().describe("How many past daylists to report. Default 8.")
    },
    annotations: { readOnlyHint: true }
  },
  tool(async ({ hour_of_day, recent_runs }) => {
    const tc = timeContext(TZ);
    const hour = hour_of_day ?? tc.hour;
    const runs = store.daylistRuns.slice(-(recent_runs ?? 8));
    return result(
      `${tc.dayName} ${String(hour).padStart(2, "0")}:00 (${tc.partOfDay}, ${tc.season}) in ${TZ}.`,
      {
        now: { ...tc, hour },
        vibe_fit: vibeFits(store, hour),
        hour_profile: hourProfile(store, hour),
        recent_activity: recentActivity(store, 7),
        recent_daylists: runs.map((r) => ({
          at: new Date(r.at).toISOString(),
          title: r.title,
          tracks: r.trackIds.length
        })),
        rotation_note: "Pass exclude_recent_daylists to search_tracks (6 is a good value for hourly runs) so the next list moves on.",
        daylist_playlist_name: DAYLIST_NAME
      }
    );
  })
);
server.registerTool(
  "commit_daylist",
  {
    title: "Publish the daylist",
    description: "Write the daylist in one atomic step: replace the rolling daylist playlist's tracks, rename it to the new title, set its description, and record the run so future daylists can avoid repeating these tracks. Creates the playlist on first use.",
    inputSchema: {
      title: z.string().describe("The daylist's name for this hour, in his voice, e.g. 'golden hour synth cruise'."),
      track_ids: z.array(z.string()).min(1),
      description: z.string().optional().describe("One line on why these tracks, shown as the playlist comment.")
    }
  },
  tool(
    async ({
      title,
      track_ids,
      description
    }) => {
      const pls = await navidrome.listPlaylists();
      let id = pls.find((p) => p.id === lastDaylistId)?.id;
      if (!id) {
        const prevTitles = new Set(store.daylistRuns.map((r) => norm(r.title)));
        id = pls.find((p) => norm(p.name) === norm(DAYLIST_NAME))?.id ?? pls.find((p) => prevTitles.has(norm(p.name)))?.id;
      }
      let created = false;
      if (!id) {
        id = await navidrome.createPlaylist({
          name: title,
          comment: description ?? "",
          public: false
        });
        created = true;
      }
      const written = created ? await navidrome.addTracks(id, track_ids) : await navidrome.replaceTracks(id, track_ids);
      if (!created) {
        await navidrome.updatePlaylist(id, { name: title, comment: description ?? "" });
      }
      lastDaylistId = id;
      store.recordDaylistRun({ at: Date.now(), title, trackIds: track_ids });
      await store.saveSnapshot();
      const dur = track_ids.map((i) => store.byId.get(i)?.duration ?? 0).reduce((a, b) => a + b, 0);
      return result(
        `Daylist published as "${title}" \u2014 ${written} tracks, ${fmtDuration(dur)}.` + (created ? " (created the rolling playlist)" : ""),
        { playlist_id: id, title, tracks: written, duration: fmtDuration(dur) }
      );
    }
  )
);
var lastDaylistId;
server.registerTool(
  "refresh_index",
  {
    title: "Refresh the local index",
    description: "Re-sync from Navidrome and/or ListenBrainz. The index is a cache: the library is pulled in full (~20s) and listens incrementally. Call this if the library changed and results look stale.",
    inputSchema: {
      scope: z.enum(["library", "listens", "all"]).optional().describe("Default 'all'."),
      full_listens: z.boolean().optional().describe("Re-pull the entire listen history, not just new ones.")
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
    title: "Generate this hour's daylist",
    description: "Spotify-style daylist: read the hour's context, pick a mood grounded in his own playlists, source ~25 tracks that fit, name it in his voice, and publish it to the rolling daylist playlist.",
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
            `Generate my daylist for right now (about ${length || "25"} tracks).`,
            steer ? `Steer: ${steer}` : "",
            "",
            "Work in this order and do not skip steps:",
            "",
            "1. Call `daylist_context`. Read the vibe_fit lift values, the hour_profile, and what I have",
            "   heard in the last few days. Note the titles of recent daylists.",
            "",
            "2. Decide the mood for THIS hour. Anchor it on my own curated playlists \u2014 the names in",
            "   vibe_fit are my vocabulary, not generic genres. Prefer a vibe with lift > 1 (I really do",
            "   reach for it at this hour). If two are close, pick the one least used by the recent",
            "   daylists. Use `get_vibe_profile` if you need to know what that mood actually sounds like.",
            "",
            "3. Source tracks with `search_tracks`. Requirements:",
            "     - pass `exclude_recent_daylists: 6` so this list is not a rerun",
            "     - pass `max_per_artist: 2` so it does not collapse onto one artist",
            "     - pass `hour_of_day` from the context and leave sort on `affinity`",
            "     - over-fetch (limit ~60) and then choose the final set yourself for flow",
            "   Mix roughly 70% things I clearly love with 30% that are either long-unheard",
            "   (`not_listened_within_days`) or recently added \u2014 a daylist that only replays this",
            "   week's rotation is boring.",
            "",
            "4. Sequence them deliberately: open with something that lands immediately, keep the energy",
            "   coherent with the hour, avoid two songs by the same artist back to back.",
            "",
            "5. Name it the way Spotify names a daylist: lowercase, 2-4 words, concrete and a little",
            "   specific, evoking the time and feel rather than the genre \u2014 e.g. 'golden hour synth cruise',",
            "   'slow shreds tuesday haze', 'late night verse vibes'. Do not reuse a recent title.",
            "",
            "6. Publish with `commit_daylist`, passing the title, the ordered track_ids, and a one-line",
            "   description of why these tracks fit this hour.",
            "",
            "Then tell me, briefly: the title, the mood you picked and why the data supported it, and",
            "3-4 highlights. Do not list every track."
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
