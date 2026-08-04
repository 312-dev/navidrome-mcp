/**
 * The compound query engine.
 *
 * This is the part Navidrome's REST API cannot do. Every filter below composes
 * with every other, ranges are real ranges, and the result can be diversified and
 * ranked by a personal-affinity score built from play counts, listen history,
 * curated-playlist membership and time-of-day fit.
 */

import type { Store, Track } from "./store.js";
import { norm } from "./listenbrainz.js";

export interface SearchParams {
  query?: string;
  artists?: string[];
  exclude_artists?: string[];
  albums?: string[];
  genres?: string[];
  exclude_genres?: string[];
  tags?: string[];
  tags_mode?: "any" | "all";
  exclude_tags?: string[];
  vibes?: string[];
  exclude_vibes?: string[];
  year_min?: number;
  year_max?: number;
  decades?: string[];
  released_after?: string;
  released_before?: string;
  added_within_days?: number;
  added_before_days?: number;
  played_within_days?: number;
  not_played_within_days?: number;
  never_played?: boolean;
  play_count_min?: number;
  play_count_max?: number;
  listen_count_min?: number;
  listen_count_max?: number;
  not_listened_within_days?: number;
  listened_within_days?: number;
  hour_of_day?: number;
  day_of_week?: number;
  duration_min_sec?: number;
  duration_max_sec?: number;
  bpm_min?: number;
  bpm_max?: number;
  starred?: boolean;
  // Inferred mood axes (0-100), covering the whole library including tracks on
  // no curated playlist. See mood.ts.
  energy_min?: number;
  energy_max?: number;
  valence_min?: number;
  valence_max?: number;
  intensity_min?: number;
  intensity_max?: number;
  organic_min?: number;
  organic_max?: number;
  moods?: string[];
  exclude_moods?: string[];
  /** Vibes the model inferred, whether or not the track is on that playlist. */
  mood_vibes?: string[];
  fits_time?: string;
  include_missing?: boolean;
  exclude_track_ids?: string[];
  exclude_recent_daylists?: number;
  max_per_artist?: number;
  max_per_album?: number;
  sort?: SortKey;
  seed?: number;
  limit?: number;
  offset?: number;
}

export type SortKey =
  | "affinity"
  | "random"
  | "play_count"
  | "listen_count"
  | "recently_played"
  | "least_recently_played"
  | "recently_added"
  | "year_desc"
  | "year_asc"
  | "duration_asc"
  | "duration_desc"
  | "hour_fit"
  | "title";

const DAY_MS = 86_400_000;

/** Deterministic PRNG so a `seed` reproduces the same shuffle exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function anyMatch(hay: string[], needles: string[]): boolean {
  if (!needles.length) return true;
  const set = new Set(needles.map((n) => n.toLowerCase()));
  return hay.some((h) => set.has(h.toLowerCase()));
}

function containsAny(hay: string, needles: string[]): boolean {
  const h = norm(hay);
  return needles.some((n) => h.includes(norm(n)));
}

export interface Scored {
  track: Track;
  score: number;
}

export function search(store: Store, p: SearchParams): { total: number; tracks: Track[] } {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);

  const excluded = new Set(p.exclude_track_ids ?? []);
  if (p.exclude_recent_daylists && p.exclude_recent_daylists > 0) {
    for (const id of store.recentDaylistTrackIds(p.exclude_recent_daylists)) excluded.add(id);
  }

  const qTerms = p.query ? norm(p.query).split(" ").filter(Boolean) : [];
  const decadeSet = new Set(
    (p.decades ?? []).map((d) => Number(String(d).replace(/[^0-9]/g, ""))).filter(Boolean),
  );
  const releasedAfter = p.released_after ? Date.parse(p.released_after) : NaN;
  const releasedBefore = p.released_before ? Date.parse(p.released_before) : NaN;

  const out: Track[] = [];
  for (const t of store.tracks) {
    if (!p.include_missing && t.missing) continue;
    if (excluded.has(t.id)) continue;

    if (qTerms.length) {
      const hay = `${norm(t.title)} ${norm(t.artist)} ${norm(t.album)} ${t.tags
        .map((x) => x.name)
        .join(" ")}`;
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
      const ok =
        p.tags_mode === "all"
          ? wanted.every((w) => names.some((n) => n.includes(w)))
          : wanted.some((w) => names.some((n) => n.includes(w)));
      if (!ok) continue;
    }
    if (p.exclude_tags?.length) {
      const names = t.tags.map((x) => x.name);
      if (p.exclude_tags.some((w) => names.some((n) => n.includes(w.toLowerCase())))) continue;
    }

    if (p.year_min !== undefined && (!t.year || t.year < p.year_min)) continue;
    if (p.year_max !== undefined && (!t.year || t.year > p.year_max)) continue;
    if (decadeSet.size && (!t.year || !decadeSet.has(Math.floor(t.year / 10) * 10))) continue;
    if (Number.isFinite(releasedAfter)) {
      const d = t.date ? Date.parse(t.date) : NaN;
      if (!Number.isFinite(d) || d < releasedAfter) continue;
    }
    if (Number.isFinite(releasedBefore)) {
      const d = t.date ? Date.parse(t.date) : NaN;
      if (!Number.isFinite(d) || d > releasedBefore) continue;
    }

    if (p.added_within_days !== undefined && !(t.addedAt && now - t.addedAt <= p.added_within_days * DAY_MS)) continue;
    if (p.added_before_days !== undefined && !(t.addedAt && now - t.addedAt >= p.added_before_days * DAY_MS)) continue;

    if (p.never_played && (t.playCount > 0 || t.listens > 0)) continue;
    if (p.played_within_days !== undefined && !(t.playDate && now - t.playDate <= p.played_within_days * DAY_MS)) continue;
    if (p.not_played_within_days !== undefined && t.playDate && now - t.playDate < p.not_played_within_days * DAY_MS) continue;
    if (p.play_count_min !== undefined && t.playCount < p.play_count_min) continue;
    if (p.play_count_max !== undefined && t.playCount > p.play_count_max) continue;

    if (p.listen_count_min !== undefined && t.listens < p.listen_count_min) continue;
    if (p.listen_count_max !== undefined && t.listens > p.listen_count_max) continue;
    if (p.listened_within_days !== undefined && !(t.lastListen && nowSec - t.lastListen <= p.listened_within_days * 86400)) continue;
    if (p.not_listened_within_days !== undefined && t.lastListen && nowSec - t.lastListen < p.not_listened_within_days * 86400) continue;

    if (p.hour_of_day !== undefined && !(t.hourHist.length && t.hourHist[p.hour_of_day]! > 0)) continue;
    if (p.day_of_week !== undefined && !(t.dowHist.length && t.dowHist[p.day_of_week]! > 0)) continue;

    if (p.duration_min_sec !== undefined && t.duration < p.duration_min_sec) continue;
    if (p.duration_max_sec !== undefined && t.duration > p.duration_max_sec) continue;
    if (p.bpm_min !== undefined && !(t.bpm && t.bpm >= p.bpm_min)) continue;
    if (p.bpm_max !== undefined && !(t.bpm && t.bpm <= p.bpm_max)) continue;
    if (p.starred !== undefined && t.starred !== p.starred) continue;

    // Vibe matching across all three sources: hand-curated membership, the
    // LLM mood pass, and tag-propagated guesses. Checked before the mood-axis
    // block because propagation works with no mood labels at all -- that is the
    // whole point of it.
    if (p.mood_vibes?.length) {
      const guessed = (t.guessedVibes ?? []).map((g) => g.vibe);
      const all = [...t.vibes, ...(t.mood?.vibes ?? []), ...guessed];
      if (!anyMatch(all, p.mood_vibes)) continue;
    }

    // Mood-axis filters. A track with no mood yet cannot satisfy one, so it
    // drops out rather than silently passing -- otherwise an unlabelled library
    // would look like every track matched every mood.
    const needsMood =
      p.energy_min !== undefined || p.energy_max !== undefined ||
      p.valence_min !== undefined || p.valence_max !== undefined ||
      p.intensity_min !== undefined || p.intensity_max !== undefined ||
      p.organic_min !== undefined || p.organic_max !== undefined ||
      Boolean(p.moods?.length) || Boolean(p.fits_time);
    if (needsMood) {
      const m = t.mood;
      if (!m) continue;
      if (p.energy_min !== undefined && m.energy < p.energy_min) continue;
      if (p.energy_max !== undefined && m.energy > p.energy_max) continue;
      if (p.valence_min !== undefined && m.valence < p.valence_min) continue;
      if (p.valence_max !== undefined && m.valence > p.valence_max) continue;
      if (p.intensity_min !== undefined && m.intensity < p.intensity_min) continue;
      if (p.intensity_max !== undefined && m.intensity > p.intensity_max) continue;
      if (p.organic_min !== undefined && m.organic < p.organic_min) continue;
      if (p.organic_max !== undefined && m.organic > p.organic_max) continue;
      if (p.moods?.length) {
        const want = p.moods.map((x) => x.toLowerCase());
        if (!want.some((w) => m.moods.some((x) => x.includes(w)))) continue;
      }
      if (p.fits_time && !m.times.some((x) => x.toLowerCase() === p.fits_time!.toLowerCase())) continue;
    }
    if (p.exclude_moods?.length && t.mood) {
      const bad = p.exclude_moods.map((x) => x.toLowerCase());
      if (bad.some((w) => t.mood!.moods.some((x) => x.includes(w)))) continue;
    }

    out.push(t);
  }

  const total = out.length;
  const sorted = sortTracks(out, p, store, nowSec);
  const diversified = diversify(sorted, p.max_per_artist, p.max_per_album);
  const offset = p.offset ?? 0;
  const limit = p.limit ?? 50;
  return { total, tracks: diversified.slice(offset, offset + limit) };
}

/**
 * How well a track fits *this* listener, right now.
 *
 * Deliberately blends long-run evidence (lifetime listens, curated-playlist
 * membership) with short-run state (recency, so today's rotation does not repeat
 * yesterday's) and, when asked, time-of-day fit. Weights are heuristic; the point
 * is a stable ordering that surfaces things he demonstrably likes without
 * collapsing onto the same 40 tracks every time.
 */
function affinity(t: Track, hour: number | undefined, nowSec: number): number {
  let s = 0;
  s += Math.log1p(t.listens) * 3; // lifetime evidence, compressed
  s += Math.log1p(t.playCount) * 1.5;
  s += t.vibes.length * 2.5; // he put it on a mood playlist himself
  if (t.starred) s += 4;
  s += (t.rating || 0) * 1.5;
  if (hour !== undefined && t.hourHist.length && t.listens) {
    // Share of this track's listens that happen in this hour, versus the 1/24
    // a uniform listener would show. Rewards genuine time-of-day habits.
    const share = t.hourHist[hour]! / t.listens;
    s += Math.min(share * 24, 6) * 2;
  }
  if (t.lastListen) {
    const days = (nowSec - t.lastListen) / 86400;
    if (days < 3) s -= 5; // just heard it
    else if (days < 14) s -= 2;
    else if (days > 365) s += 1.5; // pleasant rediscovery
  }
  return s;
}

function sortTracks(list: Track[], p: SearchParams, store: Store, nowSec: number): Track[] {
  const sort = p.sort ?? "affinity";
  const arr = [...list];
  const rnd = mulberry32(p.seed ?? 1);
  switch (sort) {
    case "random": {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
      }
      return arr;
    }
    case "play_count":
      return arr.sort((a, b) => b.playCount - a.playCount);
    case "listen_count":
      return arr.sort((a, b) => b.listens - a.listens);
    case "recently_played":
      return arr.sort((a, b) => Math.max(b.playDate, b.lastListen * 1000) - Math.max(a.playDate, a.lastListen * 1000));
    case "least_recently_played":
      return arr.sort((a, b) => Math.max(a.playDate, a.lastListen * 1000) - Math.max(b.playDate, b.lastListen * 1000));
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
      const h = p.hour_of_day ?? new Date().getHours();
      return arr.sort(
        (a, b) =>
          (b.hourHist[h] ?? 0) / Math.max(1, b.listens) - (a.hourHist[h] ?? 0) / Math.max(1, a.listens),
      );
    }
    case "affinity":
    default: {
      // A small seeded jitter keeps repeat runs from producing an identical list
      // while preserving the ranking's shape.
      const scored = arr.map((t) => ({
        t,
        s: affinity(t, p.hour_of_day, nowSec) + rnd() * 1.5,
      }));
      scored.sort((a, b) => b.s - a.s);
      return scored.map((x) => x.t);
    }
  }
}

/** Cap tracks per artist/album while preserving the incoming order. */
function diversify(list: Track[], maxArtist?: number, maxAlbum?: number): Track[] {
  if (!maxArtist && !maxAlbum) return list;
  const byArtist = new Map<string, number>();
  const byAlbum = new Map<string, number>();
  const out: Track[] = [];
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

/** Compact shape returned to the model -- small enough to list 100 of them. */
export function brief(t: Track): Record<string, unknown> {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    year: t.year || undefined,
    genres: t.genres.length ? t.genres : undefined,
    duration_sec: Math.round(t.duration),
    plays: t.playCount || undefined,
    listens: t.listens || undefined,
    last_listened: t.lastListen ? new Date(t.lastListen * 1000).toISOString().slice(0, 10) : undefined,
    vibes: t.vibes.length ? t.vibes : undefined,
    reads_as: t.vibes.length
      ? undefined
      : t.guessedVibes?.length
        ? t.guessedVibes.map((g) => `${g.vibe} (${g.score})`)
        : undefined,
    tags: t.tags.length ? t.tags.slice(0, 6).map((x) => x.name) : undefined,
    starred: t.starred || undefined,
    mood: t.mood
      ? {
          energy: t.mood.energy,
          valence: t.mood.valence,
          intensity: t.mood.intensity,
          organic: t.mood.organic,
          moods: t.mood.moods,
          fits: t.mood.times,
          reads_as: t.mood.vibes.length ? t.mood.vibes : undefined,
        }
      : undefined,
  };
}
