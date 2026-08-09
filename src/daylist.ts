/**
 * Time-of-day context.
 *
 * A playlist for *right now* needs to know what "6pm on a Thursday" means, and
 * there are two ways to answer that. Where listening history exists this module
 * measures it: which mood regions actually get played at this hour, which
 * artists dominate it, and what has been heard recently so the rotation moves.
 * Where it does not, each vibe's own `hours` affinity stands in, so an install
 * with no scrobbling connected still gets a sensible answer on day one.
 *
 * The observed-vs-baseline lift is the key number in the measured case. Ranking
 * vibes by an hour's raw counts would just rank them by size -- the largest
 * region wins every hour. Lift asks instead: does this vibe show up *more than
 * its usual share* at this hour? That is what makes 7am and 11pm differ.
 */

import type { Store, Track } from "./store.js";
import { norm, primaryArtist } from "./listenbrainz.js";
import { UNIVERSAL_VIBES } from "./vocabulary.js";

export interface TimeContext {
  iso: string;
  timezone: string;
  hour: number;
  /** 0 = Sunday. */
  dayOfWeek: number;
  dayName: string;
  isWeekend: boolean;
  partOfDay: string;
  season: string;
}

const PART_OF_DAY: [number, string][] = [
  [5, "late night"],
  [8, "early morning"],
  [11, "morning"],
  [14, "midday"],
  [17, "afternoon"],
  [20, "evening"],
  [23, "night"],
  [24, "late night"],
];

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function timeContext(tz: string, at = new Date()): TimeContext {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
    weekday: "short",
    month: "numeric",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[get("weekday")] ?? 0;
  const month = Number(get("month"));
  const season =
    month <= 2 || month === 12 ? "winter" : month <= 5 ? "spring" : month <= 8 ? "summer" : "autumn";
  const part = PART_OF_DAY.find(([h]) => hour < h)?.[1] ?? "night";
  return {
    iso: at.toISOString(),
    timezone: tz,
    hour,
    dayOfWeek: dow,
    dayName: DAY_NAMES[dow]!,
    isWeekend: dow === 0 || dow === 6,
    partOfDay: part,
    season,
  };
}

/** Hours considered "this time of day" -- the target hour plus its neighbours. */
function hourWindow(hour: number, spread = 1): number[] {
  const out: number[] = [];
  for (let d = -spread; d <= spread; d++) out.push((hour + d + 24) % 24);
  return out;
}

export interface VibeFit {
  vibe: string;
  gloss: string;
  /** Library tracks whose mood label falls inside this region. */
  tracks: number;
  listens_in_window: number;
  /**
   * >1 means this vibe is over-represented at this hour versus its own average.
   * Null when the region's tracks have no listen history to measure.
   */
  lift: number | null;
  /** The region's own declared time affinity -- the fallback when lift is null. */
  suits_hour: boolean;
  top_artists: string[];
}

/**
 * How well each vibe region fits a given hour.
 *
 * Always returns every region, including empty ones. A row reading zero tracks
 * is informative rather than noise: it says the vocabulary is available but the
 * library is not labelled yet, which is a different problem from a region this
 * particular collection happens not to reach.
 */
export function vibeFits(store: Store, hour: number, spread = 1): VibeFit[] {
  const window = new Set(hourWindow(hour, spread));
  const windowShare = window.size / 24;

  const members = new Map<string, Track[]>();
  for (const t of store.tracks) {
    for (const v of t.moodVibes ?? []) {
      const arr = members.get(v.vibe);
      if (arr) arr.push(t);
      else members.set(v.vibe, [t]);
    }
  }

  const out: VibeFit[] = [];
  for (const [vibe, def] of Object.entries(UNIVERSAL_VIBES)) {
    const tracks = members.get(vibe) ?? [];
    let inWindow = 0;
    let totalListens = 0;
    const artistCounts = new Map<string, number>();
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
      lift: totalListens ? Number(((inWindow / totalListens) / windowShare).toFixed(2)) : null,
      suits_hour: def.hours.includes(hour),
      top_artists: [...artistCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([a]) => a),
    });
  }

  // Measured lift ranks first where it exists; unmeasured regions fall back to
  // their declared hours, and empty ones sink. Sorting a null lift as 0 would
  // rank "no evidence" below "evidence it is wrong for this hour", which is the
  // wrong way round for a library that has simply never been scrobbled.
  return out.sort((a, b) => {
    if (a.lift !== null && b.lift !== null) return b.lift - a.lift;
    if (a.lift !== null) return -1;
    if (b.lift !== null) return 1;
    if (a.suits_hour !== b.suits_hour) return a.suits_hour ? -1 : 1;
    return b.tracks - a.tracks;
  });
}

/** What actually gets played at this hour, regardless of vibe labelling. */
export function hourProfile(
  store: Store,
  hour: number,
  spread = 1,
): {
  listens_in_window: number;
  top_artists: { artist: string; listens: number }[];
  top_genres: { genre: string; listens: number }[];
  top_tags: { tag: string; weight: number }[];
  median_year: number | null;
} {
  const window = new Set(hourWindow(hour, spread));
  const artists = new Map<string, number>();
  const genres = new Map<string, number>();
  const tags = new Map<string, number>();
  const years: number[] = [];
  let total = 0;

  for (const t of store.tracks) {
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
  const top = <T>(m: Map<string, number>, key: string, n: number) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => ({ [key]: k, [key === "tag" ? "weight" : "listens"]: v }) as T);

  return {
    listens_in_window: total,
    top_artists: top<{ artist: string; listens: number }>(artists, "artist", 15),
    top_genres: top<{ genre: string; listens: number }>(genres, "genre", 8),
    top_tags: top<{ tag: string; weight: number }>(tags, "tag", 15),
    median_year: years.length ? years[Math.floor(years.length / 2)]! : null,
  };
}

/** Recent listening, for "don't serve me what I just heard". */
export function recentActivity(store: Store, days = 7): {
  listens: number;
  top_artists: { artist: string; listens: number }[];
  distinct_tracks: number;
} {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const artists = new Map<string, number>();
  const tracks = new Set<string>();
  let n = 0;
  for (let i = store.listens.length - 1; i >= 0; i--) {
    const l = store.listens[i]!;
    if (l.ts < cutoff) break;
    n++;
    artists.set(l.artist, (artists.get(l.artist) ?? 0) + 1);
    tracks.add(`${primaryArtist(l.artist)}|${norm(l.track)}`);
  }
  return {
    listens: n,
    distinct_tracks: tracks.size,
    top_artists: [...artists.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([artist, listens]) => ({ artist, listens })),
  };
}

/** Long-loved but long-unheard -- the "rediscovery" pool. */
export function rediscoveries(store: Store, minListens = 5, quietDays = 365, limit = 30): Track[] {
  const cutoff = Math.floor(Date.now() / 1000) - quietDays * 86400;
  return store.tracks
    .filter((t) => !t.missing && t.listens >= minListens && t.lastListen && t.lastListen < cutoff)
    .sort((a, b) => b.listens - a.listens)
    .slice(0, limit);
}
