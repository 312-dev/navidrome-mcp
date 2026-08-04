#!/usr/bin/env node
/**
 * Navidrome MCP server.
 *
 * Mood- and vibe-aware playlist generation over a personal Navidrome library,
 * grounded in three sources that each cover the others' blind spots:
 *
 *   Navidrome  - authoritative metadata + the playlist write path
 *   ListenBrainz - timestamped listen history (Navidrome keeps only a last-played)
 *   Last.fm    - descriptive tag vocabulary (the library's own genres are coarse)
 *
 * Speaks MCP over stdio; the gateway wraps it with mcp-proxy to serve Streamable
 * HTTP behind the OAuth worker.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { socksDispatcher } from "fetch-socks";
import { z } from "zod";
import { hourProfile, recentActivity, rediscoveries, timeContext, vibeFits } from "./daylist.js";
import { Navidrome } from "./navidrome.js";
import { brief, search, type SearchParams, type SortKey } from "./query.js";
import { Store, type Track } from "./store.js";
import { norm } from "./listenbrainz.js";

// ── config ──────────────────────────────────────────────────────────────────

const env = process.env;
const TZ = env.NAVIDROME_TZ || "America/Chicago";
const DAYLIST_NAME = env.DAYLIST_PLAYLIST_NAME || "daylist";
const DATA_DIR = env.NAVIDROME_DATA_DIR || "/data/navidrome-mcp";

/**
 * Navidrome lives on the home Mac Mini, on the tailnet. The gateway container's
 * own tailnet identity is a tagged node that is not permitted to reach port 4533,
 * but it *is* permitted to reach the Mini's SOCKS proxy -- the same hop the jewel
 * and rocketmoney servers already use. So all Navidrome traffic goes through it.
 */
const proxyUrl = env.NAVIDROME_PROXY;
let dispatcher: unknown;
if (proxyUrl) {
  const u = new URL(proxyUrl);
  dispatcher = socksDispatcher({
    type: u.protocol.startsWith("socks4") ? 4 : 5,
    host: u.hostname,
    port: Number(u.port || 1080),
    ...(u.username ? { userId: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
  });
}

const navidrome = new Navidrome({
  baseUrl: env.NAVIDROME_URL ?? "",
  username: env.NAVIDROME_USERNAME ?? "",
  password: env.NAVIDROME_PASSWORD ?? "",
  dispatcher,
});

const store = new Store({
  navidrome,
  dataDir: DATA_DIR,
  listenBrainzUser: env.LISTENBRAINZ_USER,
  lastFmKey: env.LASTFM_API_KEY,
  timezone: TZ,
  daylistName: DAYLIST_NAME,
  historyDays: Number(env.LISTENBRAINZ_HISTORY_DAYS ?? 730) || 730,
  enrich: env.NAVIDROME_ENRICH !== "0",
  anthropicKey: env.ANTHROPIC_API_KEY,
  moodModel: env.MOOD_MODEL,
});

// ── helpers ─────────────────────────────────────────────────────────────────

function result(summary: string, data?: unknown) {
  const text =
    data === undefined
      ? summary
      : `${summary}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { isError: true as const, content: [{ type: "text" as const, text: `Error: ${msg}` }] };
}

/** Wrap a handler so the index is guaranteed built and errors are never thrown. */
function tool<T>(fn: (args: T) => Promise<ReturnType<typeof result>>) {
  return async (args: T) => {
    try {
      await store.ensureReady();
      return await fn(args);
    } catch (e) {
      return errorResult(e);
    }
  };
}

function fmtDuration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const server = new McpServer({ name: "navidrome-mcp", version: "1.0.0" });

// ── describe_library ────────────────────────────────────────────────────────

server.registerTool(
  "describe_library",
  {
    title: "Describe the music library",
    description:
      "Orientation for the whole library: size, genre and decade distribution, the user's own curated mood playlists (his personal vibe vocabulary), the Last.fm tag vocabulary available for filtering, and listening-history coverage. Call this FIRST when you need to build a playlist and do not yet know what the library contains.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  tool(async () => {
    const totalSec = store.tracks.reduce((a, t) => a + t.duration, 0);
    const withListens = store.tracks.filter((t) => t.listens > 0).length;
    const vibes = Object.entries(store.vibes)
      .map(([name, ids]) => ({ vibe: name, tracks: ids.length }))
      .sort((a, b) => b.tracks - a.tracks);
    return result(
      `Library: ${store.tracks.length} tracks, ${fmtDuration(totalSec)} total. ` +
        `${vibes.length} curated mood playlists. ` +
        `${store.listens.length} ListenBrainz listens on file (${withListens} tracks matched).`,
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
          oldest: store.listens.length
            ? new Date(store.listens[0]!.ts * 1000).toISOString().slice(0, 10)
            : null,
          newest: store.listens.length
            ? new Date(store.listens[store.listens.length - 1]!.ts * 1000).toISOString().slice(0, 10)
            : null,
        },
        tag_enrichment: store.enrichState,
        mood_coverage: store.moodCoverage(),
        vibe_propagation: store.propagation,
        mood_vocabulary: store.moodVocabulary(60),
        note:
          "The whole library is a favourites sync, so every track here is already something he liked. " +
          "Selection is about fit for the moment, not about whether he likes it. " +
          "Use `mood_vibes` to reach the whole library: it matches hand-curated membership PLUS tracks predicted to belong by tag similarity to his own playlists (measured 63% top-1 / 85% top-2 on a holdout). Plain `vibes` matches only the ~3,800 tracks he filed by hand. The numeric mood axes need the mood pass, which is separate.",
      },
    );
  }),
);

// ── search_tracks ───────────────────────────────────────────────────────────

const searchShape = {
  query: z.string().optional().describe("Free text matched against title, artist, album and tags."),
  artists: z.array(z.string()).optional().describe("Only these artists (substring match)."),
  exclude_artists: z.array(z.string()).optional(),
  albums: z.array(z.string()).optional(),
  genres: z.array(z.string()).optional().describe("Any-of match on the library's own genres."),
  exclude_genres: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional().describe("Last.fm tags, e.g. ['shoegaze','melancholy']."),
  tags_mode: z.enum(["any", "all"]).optional().describe("Default 'any'."),
  exclude_tags: z.array(z.string()).optional(),
  vibes: z
    .array(z.string())
    .optional()
    .describe("Restrict to tracks on these curated playlists, e.g. ['golden hour','textured']."),
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
  hour_of_day: z
    .number()
    .int()
    .min(0)
    .max(23)
    .optional()
    .describe("Only tracks he has actually listened to at this local hour."),
  day_of_week: z.number().int().min(0).max(6).optional().describe("0 = Sunday."),
  duration_min_sec: z.number().optional(),
  duration_max_sec: z.number().optional(),
  bpm_min: z.number().optional(),
  bpm_max: z.number().optional(),
  starred: z.boolean().optional(),
  energy_min: z.number().optional().describe("Inferred mood axis 0-100: sleepy/still -> frantic."),
  energy_max: z.number().optional(),
  valence_min: z.number().optional().describe("0-100: bleak/melancholy -> bright/joyful."),
  valence_max: z.number().optional(),
  intensity_min: z.number().optional().describe("0-100: gentle -> heavy/aggressive."),
  intensity_max: z.number().optional(),
  organic_min: z.number().optional().describe("0-100: fully electronic -> fully acoustic."),
  organic_max: z.number().optional(),
  moods: z
    .array(z.string())
    .optional()
    .describe("Inferred feeling descriptors, e.g. ['hazy','wistful','anthemic']. Any-of, substring."),
  exclude_moods: z.array(z.string()).optional(),
  mood_vibes: z
    .array(z.string())
    .optional()
    .describe(
      "Tracks that READ AS one of his curated vibes, whether or not they are filed on that playlist. Matches hand-curated membership, the mood pass, and tag-similarity predictions — so it reaches the whole library, not just the ~3,800 playlisted tracks. Prefer this over `vibes` for any mood request.",
    ),
  fits_time: z
    .string()
    .optional()
    .describe("One of: early morning, morning, midday, afternoon, golden hour, evening, late night."),
  include_missing: z.boolean().optional().describe("Include tracks whose file is missing. Default false."),
  exclude_track_ids: z.array(z.string()).optional(),
  exclude_recent_daylists: z
    .number()
    .int()
    .optional()
    .describe("Exclude everything used by the last N daylist runs. Use ~6 for hourly rotation."),
  max_per_artist: z.number().int().optional().describe("Cap tracks per artist. Use 1-2 for playlists."),
  max_per_album: z.number().int().optional(),
  sort: z
    .enum([
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
      "title",
    ])
    .optional()
    .describe("Default 'affinity': a personal-fit blend of listens, plays, curated membership and recency."),
  seed: z.number().int().optional().describe("Makes 'random'/'affinity' reproducible."),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
};

server.registerTool(
  "search_tracks",
  {
    title: "Search tracks with full compound filtering",
    description:
      "The main query tool, over the WHOLE library. Every filter composes: real year/date ranges, play and listen recency, inferred mood axes (energy/valence/intensity/organic), mood descriptors, curated OR inferred vibe membership, Last.fm tags, duration, time-of-day fit, plus per-artist diversity caps and personal-affinity ranking.\n\n" +
      "For mood requests prefer `mood_vibes` / `moods` / the axis ranges over `vibes`: `vibes` matches only the ~3,800 tracks actually on a curated playlist, while the mood fields cover all 9,000+.",
    inputSchema: searchShape,
    annotations: { readOnlyHint: true },
  },
  tool(async (args: SearchParams) => {
    const { total, tracks } = search(store, { limit: 50, ...args });
    const dur = tracks.reduce((a, t) => a + t.duration, 0);
    return result(
      `${total} tracks matched; returning ${tracks.length} (${fmtDuration(dur)}).`,
      { total_matched: total, returned: tracks.length, tracks: tracks.map(brief) },
    );
  }),
);

// ── get_vibe_profile ────────────────────────────────────────────────────────

server.registerTool(
  "get_vibe_profile",
  {
    title: "Profile a curated mood playlist",
    description:
      "What one of the user's own mood playlists actually consists of: top artists, genres, tags, era and tempo, when during the day he plays it, and representative tracks. Use this to ground an abstract mood request in what that word means in HIS library.",
    inputSchema: {
      vibe: z.string().describe("Curated playlist name, e.g. 'golden hour'."),
      sample: z.number().int().min(0).max(50).optional().describe("Representative tracks to include. Default 12."),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ vibe, sample }: { vibe: string; sample?: number }) => {
    const key = Object.keys(store.vibes).find((k) => norm(k) === norm(vibe));
    if (!key) {
      return result(
        `No curated playlist named "${vibe}". Available: ${Object.keys(store.vibes).join(", ")}`,
      );
    }
    const tracks = store.vibes[key]!.map((id) => store.byId.get(id)).filter(Boolean) as Track[];
    const count = <T extends string>(vals: T[]) => {
      const m = new Map<string, number>();
      for (const v of vals) m.set(v, (m.get(v) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const years = tracks.map((t) => t.year).filter(Boolean).sort((a, b) => a - b);
    const bpms = tracks.map((t) => t.bpm).filter((b): b is number => !!b).sort((a, b) => a - b);
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
        tags: count(tracks.flatMap((t) => t.tags.slice(0, 6).map((x) => x.name)))
          .slice(0, 20)
          .map(([tag, n]) => ({ tag, tracks: n })),
        era: years.length
          ? {
              median_year: years[Math.floor(years.length / 2)],
              p10: years[Math.floor(years.length * 0.1)],
              p90: years[Math.floor(years.length * 0.9)],
            }
          : null,
        median_bpm: bpms.length ? bpms[Math.floor(bpms.length / 2)] : null,
        median_track_length_sec: Math.round(
          tracks.map((t) => t.duration).sort((a, b) => a - b)[Math.floor(tracks.length / 2)] ?? 0,
        ),
        listens_by_hour: hours,
        peak_hour: hours[peakHour] ? peakHour : null,
        sample_tracks: tracks
          .slice()
          .sort((a, b) => b.listens - a.listens)
          .slice(0, sample ?? 12)
          .map(brief),
      },
    );
  }),
);

// ── similar_tracks ──────────────────────────────────────────────────────────

server.registerTool(
  "similar_tracks",
  {
    title: "Find similar tracks in the library",
    description:
      "Expand from seed tracks or artists. Combines Navidrome's agent-backed similarity (Last.fm/Deezer/ListenBrainz) with co-occurrence in the user's own curated playlists — tracks he himself repeatedly files alongside the seed. Results are restricted to what is actually in the library.",
    inputSchema: {
      track_ids: z.array(z.string()).optional().describe("Seed track ids."),
      artists: z.array(z.string()).optional().describe("Seed artist names."),
      limit: z.number().int().min(1).max(200).optional(),
      exclude_seed_artists: z.boolean().optional().describe("Drop the seeds' own artists. Default true."),
    },
    annotations: { readOnlyHint: true },
  },
  tool(
    async ({
      track_ids,
      artists,
      limit,
      exclude_seed_artists,
    }: {
      track_ids?: string[];
      artists?: string[];
      limit?: number;
      exclude_seed_artists?: boolean;
    }) => {
      const seeds: Track[] = (track_ids ?? [])
        .map((id) => store.byId.get(id))
        .filter(Boolean) as Track[];
      const seedArtistNames = new Set<string>([
        ...seeds.map((t) => norm(t.artist)),
        ...(artists ?? []).map(norm),
      ]);
      const scores = new Map<string, number>();
      const bump = (id: string, w: number) => scores.set(id, (scores.get(id) ?? 0) + w);

      // 1. Co-occurrence in his own curated playlists. Strongest personal signal:
      //    these are pairings he made himself, not a global popularity graph.
      const seedIds = new Set(seeds.map((t) => t.id));
      for (const ids of Object.values(store.vibes)) {
        const set = new Set(ids);
        const overlap = [...seedIds].filter((id) => set.has(id)).length;
        if (!overlap) continue;
        for (const id of ids) if (!seedIds.has(id)) bump(id, 2 * overlap);
      }

      // 2. Navidrome's agent-backed similarity, per seed artist.
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
          // Agent lookups are best-effort; co-occurrence alone still works.
        }
      }

      const dropSeedArtists = exclude_seed_artists !== false;
      const ranked = [...scores.entries()]
        .map(([id, s]) => ({ t: store.byId.get(id)!, s }))
        .filter((x) => x.t && !x.t.missing && !seedIds.has(x.t.id))
        .filter((x) => !dropSeedArtists || !seedArtistNames.has(norm(x.t.artist)))
        .sort((a, b) => b.s - a.s || b.t.listens - a.t.listens)
        .slice(0, limit ?? 40);

      return result(`${ranked.length} similar tracks found in the library.`, {
        seeds: seeds.map((t) => `${t.artist} - ${t.title}`),
        tracks: ranked.map((x) => ({ ...brief(x.t), similarity: Number(x.s.toFixed(1)) })),
      });
    },
  ),
);

// ── listening_history ───────────────────────────────────────────────────────

server.registerTool(
  "listening_history",
  {
    title: "Analyse listening history",
    description:
      "Query the ListenBrainz history: recent plays, top artists/tracks over a window, hour-of-day and weekday habits, rising/falling trends, and long-loved-but-forgotten tracks worth resurfacing. This is the only source of timestamped history — Navidrome itself keeps only a play count and a last-played time.",
    inputSchema: {
      mode: z
        .enum(["recent", "top", "by_hour", "by_weekday", "rediscover", "trending"])
        .describe("Which analysis to run."),
      days: z.number().int().optional().describe("Window in days. Default 30."),
      hour_of_day: z.number().int().min(0).max(23).optional().describe("For mode 'by_hour'. Defaults to now."),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  tool(
    async ({
      mode,
      days,
      hour_of_day,
      limit,
    }: { mode: string; days?: number; hour_of_day?: number; limit?: number }) => {
      const n = limit ?? 25;
      const window = days ?? 30;
      const tc = timeContext(TZ);

      if (mode === "recent") {
        const recent = store.listens.slice(-n).reverse();
        return result(`Last ${recent.length} listens.`, {
          listens: recent.map((l) => ({
            at: new Date(l.ts * 1000).toISOString(),
            artist: l.artist,
            track: l.track,
          })),
        });
      }
      if (mode === "top") {
        const cutoff = Math.floor(Date.now() / 1000) - window * 86400;
        const tracks = new Map<string, { label: string; n: number }>();
        const artists = new Map<string, number>();
        for (let i = store.listens.length - 1; i >= 0; i--) {
          const l = store.listens[i]!;
          if (l.ts < cutoff) break;
          const k = `${l.artist} - ${l.track}`;
          tracks.set(k, { label: k, n: (tracks.get(k)?.n ?? 0) + 1 });
          artists.set(l.artist, (artists.get(l.artist) ?? 0) + 1);
        }
        return result(`Top listening over the last ${window} days.`, {
          window_days: window,
          top_tracks: [...tracks.values()].sort((a, b) => b.n - a.n).slice(0, n),
          top_artists: [...artists.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(([artist, listens]) => ({ artist, listens })),
        });
      }
      if (mode === "by_hour") {
        const h = hour_of_day ?? tc.hour;
        return result(`What gets played around ${h}:00 (${TZ}).`, {
          hour: h,
          ...hourProfile(store, h),
          vibe_fit: vibeFits(store, h),
        });
      }
      if (mode === "by_weekday") {
        const dow = new Array(7).fill(0);
        const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" });
        const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        for (const l of store.listens) dow[map[fmt.format(new Date(l.ts * 1000))] ?? 0]++;
        const hours = new Array(24).fill(0);
        for (const t of store.tracks) for (let i = 0; i < 24; i++) hours[i] += t.hourHist[i] ?? 0;
        return result("Listening distribution across the week and the day.", {
          by_weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => ({
            day: d,
            listens: dow[i],
          })),
          by_hour: hours.map((v, i) => ({ hour: i, listens: v })),
        });
      }
      if (mode === "rediscover") {
        const r = rediscoveries(store, 5, window > 60 ? window : 365, n);
        return result(`${r.length} long-loved tracks not heard in a long time.`, {
          tracks: r.map(brief),
        });
      }
      // trending
      const nowS = Math.floor(Date.now() / 1000);
      const recentCut = nowS - window * 86400;
      const priorCut = nowS - 2 * window * 86400;
      const recentC = new Map<string, number>();
      const priorC = new Map<string, number>();
      for (const l of store.listens) {
        if (l.ts >= recentCut) recentC.set(l.artist, (recentC.get(l.artist) ?? 0) + 1);
        else if (l.ts >= priorCut) priorC.set(l.artist, (priorC.get(l.artist) ?? 0) + 1);
      }
      const rows = [...recentC.entries()]
        .map(([artist, now]) => ({ artist, now, before: priorC.get(artist) ?? 0 }))
        .filter((r) => r.now >= 3)
        .map((r) => ({ ...r, lift: Number((r.now / Math.max(1, r.before)).toFixed(2)) }))
        .sort((a, b) => b.lift - a.lift || b.now - a.now);
      return result(`Artist momentum: last ${window}d vs the ${window}d before.`, {
        rising: rows.slice(0, n),
        fading: rows.filter((r) => r.lift < 1).slice(-n).reverse(),
      });
    },
  ),
);

// ── playlist reads ──────────────────────────────────────────────────────────

server.registerTool(
  "list_playlists",
  {
    title: "List playlists",
    description: "All playlists in Navidrome, including which are curated mood playlists and which are smart (self-updating).",
    inputSchema: {},
    annotations: { readOnlyHint: true },
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
        comment: p.comment || undefined,
        updated: p.updatedAt,
      })),
    });
  }),
);

server.registerTool(
  "get_playlist",
  {
    title: "Get a playlist's tracks",
    description: "Full track list of one playlist, by id or name.",
    inputSchema: {
      playlist_id: z.string().optional(),
      name: z.string().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ playlist_id, name, limit }: { playlist_id?: string; name?: string; limit?: number }) => {
    const id = playlist_id ?? (await resolvePlaylistId(name));
    if (!id) return result(`No playlist found for ${JSON.stringify(name)}.`);
    const rows = await navidrome.playlistTracks(id);
    const tracks = rows.map((r) => store.byId.get(r.id)).filter(Boolean) as Track[];
    return result(`${rows.length} tracks.`, {
      playlist_id: id,
      tracks: (tracks.length ? tracks : []).slice(0, limit ?? 200).map(brief),
    });
  }),
);

async function resolvePlaylistId(name?: string): Promise<string | undefined> {
  if (!name) return undefined;
  const pls = await navidrome.listPlaylists();
  return pls.find((p) => norm(p.name) === norm(name))?.id;
}

// ── playlist writes ─────────────────────────────────────────────────────────

server.registerTool(
  "create_playlist",
  {
    title: "Create a playlist",
    description: "Create a new playlist from an explicit list of track ids (use search_tracks to source them).",
    inputSchema: {
      name: z.string(),
      track_ids: z.array(z.string()),
      comment: z.string().optional().describe("Shown as the playlist description in Navidrome."),
      public: z.boolean().optional(),
    },
  },
  tool(
    async ({
      name,
      track_ids,
      comment,
      public: isPublic,
    }: { name: string; track_ids: string[]; comment?: string; public?: boolean }) => {
      const id = await navidrome.createPlaylist({ name, comment, public: isPublic });
      const added = await navidrome.addTracks(id, track_ids);
      return result(`Created "${name}" with ${added} tracks.`, { playlist_id: id, added });
    },
  ),
);

server.registerTool(
  "update_playlist",
  {
    title: "Update a playlist",
    description:
      "Rename a playlist, change its description, and/or replace or append its tracks. Replacing is the normal way to refresh a rolling playlist in place.",
    inputSchema: {
      playlist_id: z.string().optional(),
      name: z.string().optional().describe("Existing playlist name, if not passing an id."),
      new_name: z.string().optional(),
      comment: z.string().optional(),
      track_ids: z.array(z.string()).optional(),
      mode: z.enum(["replace", "append"]).optional().describe("How to apply track_ids. Default 'replace'."),
      public: z.boolean().optional(),
    },
  },
  tool(
    async (a: {
      playlist_id?: string;
      name?: string;
      new_name?: string;
      comment?: string;
      track_ids?: string[];
      mode?: "replace" | "append";
      public?: boolean;
    }) => {
      const id = a.playlist_id ?? (await resolvePlaylistId(a.name));
      if (!id) return result(`No playlist found for ${JSON.stringify(a.name)}.`);
      if (a.new_name || a.comment !== undefined || a.public !== undefined) {
        await navidrome.updatePlaylist(id, {
          ...(a.new_name ? { name: a.new_name } : {}),
          ...(a.comment !== undefined ? { comment: a.comment } : {}),
          ...(a.public !== undefined ? { public: a.public } : {}),
        });
      }
      let n = 0;
      if (a.track_ids) {
        n =
          (a.mode ?? "replace") === "append"
            ? await navidrome.addTracks(id, a.track_ids)
            : await navidrome.replaceTracks(id, a.track_ids);
      }
      return result(`Updated playlist${a.track_ids ? ` (${n} tracks)` : ""}.`, {
        playlist_id: id,
        tracks_written: n,
      });
    },
  ),
);

server.registerTool(
  "delete_playlist",
  {
    title: "Delete a playlist",
    description: "Permanently delete a playlist. Does not touch the audio files.",
    inputSchema: { playlist_id: z.string().optional(), name: z.string().optional() },
    annotations: { destructiveHint: true },
  },
  tool(async ({ playlist_id, name }: { playlist_id?: string; name?: string }) => {
    const id = playlist_id ?? (await resolvePlaylistId(name));
    if (!id) return result(`No playlist found for ${JSON.stringify(name)}.`);
    await navidrome.deletePlaylist(id);
    return result(`Deleted playlist ${id}.`);
  }),
);

// ── smart playlists ─────────────────────────────────────────────────────────

server.registerTool(
  "create_smart_playlist",
  {
    title: "Create a smart (self-updating) playlist",
    description:
      "Create a playlist defined by RULES rather than a fixed track list. Navidrome re-evaluates it continuously, so it stays current without regeneration — ideal for standing playlists like '90s rock I haven't played in a year'.\n\n" +
      "Rules are Navidrome's native criteria format:\n" +
      '{"all":[{"is":{"genre":"Rock"}},{"inTheRange":{"year":[1990,1999]}},{"notInTheLast":{"lastPlayed":365}}],"sort":"playCount","order":"desc","limit":100}\n\n' +
      "Operators: is, isNot, gt, lt, contains, notContains, startsWith, endsWith, inTheRange, before, after, inTheLast, notInTheLast. " +
      "Combine with all (AND) / any (OR), which may nest. " +
      "Fields include: title, album, artist, albumartist, genre, year, dateadded, datemodified, lastplayed, playcount, rating, starred, loved, comment, bpm, length, filepath, filetype.\n\n" +
      "Note: rules operate on Navidrome's own fields only — ListenBrainz listen counts and Last.fm tags are NOT available here. For those, use search_tracks plus create_playlist.",
    inputSchema: {
      name: z.string(),
      rules: z.record(z.any()).describe("Navidrome smart-playlist criteria object."),
      comment: z.string().optional(),
      public: z.boolean().optional(),
    },
  },
  tool(
    async ({
      name,
      rules,
      comment,
      public: isPublic,
    }: { name: string; rules: Record<string, unknown>; comment?: string; public?: boolean }) => {
      const id = await navidrome.createPlaylist({ name, comment, public: isPublic, rules });
      // Read it back: Navidrome accepts a malformed rule set and simply matches
      // nothing, so an empty evaluation is the only signal that the rules are wrong.
      let matched = 0;
      try {
        const { total } = await navidrome.nd<unknown[]>("GET", `playlist/${id}/tracks`, {
          _start: 0,
          _end: 1,
        });
        matched = total ?? 0;
      } catch {
        /* evaluation may lag briefly after creation */
      }
      return result(
        `Created smart playlist "${name}" (currently matching ${matched} tracks).` +
          (matched === 0
            ? " Zero matches usually means the rules reference an unknown field or an impossible combination."
            : ""),
        { playlist_id: id, matched },
      );
    },
  ),
);

// ── daylist ─────────────────────────────────────────────────────────────────

server.registerTool(
  "daylist_context",
  {
    title: "Get daylist context for right now",
    description:
      "Everything needed to generate this hour's daylist: local time and part of day, which of his curated moods he actually reaches for at this hour (measured as lift over that mood's own average, so it is not just playlist size), the artists/genres/tags that dominate this hour historically, what he has heard in the last few days, and the titles of recent daylists so the new one does not repeat them.",
    inputSchema: {
      hour_of_day: z.number().int().min(0).max(23).optional().describe("Override the current hour."),
      recent_runs: z.number().int().optional().describe("How many past daylists to report. Default 8."),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ hour_of_day, recent_runs }: { hour_of_day?: number; recent_runs?: number }) => {
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
          tracks: r.trackIds.length,
        })),
        rotation_note:
          "Pass exclude_recent_daylists to search_tracks (6 is a good value for hourly runs) so the next list moves on.",
        daylist_playlist_name: DAYLIST_NAME,
      },
    );
  }),
);

server.registerTool(
  "commit_daylist",
  {
    title: "Publish the daylist",
    description:
      "Write the daylist in one atomic step: replace the rolling daylist playlist's tracks, rename it to the new title, set its description, and record the run so future daylists can avoid repeating these tracks. Creates the playlist on first use.",
    inputSchema: {
      title: z
        .string()
        .describe("The daylist's name for this hour, in his voice, e.g. 'golden hour synth cruise'."),
      track_ids: z.array(z.string()).min(1),
      description: z.string().optional().describe("One line on why these tracks, shown as the playlist comment."),
    },
  },
  tool(
    async ({
      title,
      track_ids,
      description,
    }: { title: string; track_ids: string[]; description?: string }) => {
      const pls = await navidrome.listPlaylists();
      // The playlist is identified by the run history, not by its name -- the name
      // changes every hour, so matching on it would create a new playlist each run.
      let id = pls.find((p) => p.id === lastDaylistId)?.id;
      if (!id) {
        const prevTitles = new Set(store.daylistRuns.map((r) => norm(r.title)));
        id =
          pls.find((p) => norm(p.name) === norm(DAYLIST_NAME))?.id ??
          pls.find((p) => prevTitles.has(norm(p.name)))?.id;
      }
      let created = false;
      if (!id) {
        id = await navidrome.createPlaylist({
          name: title,
          comment: description ?? "",
          public: false,
        });
        created = true;
      }
      const written = created
        ? await navidrome.addTracks(id, track_ids)
        : await navidrome.replaceTracks(id, track_ids);
      if (!created) {
        await navidrome.updatePlaylist(id, { name: title, comment: description ?? "" });
      }
      lastDaylistId = id;
      store.recordDaylistRun({ at: Date.now(), title, trackIds: track_ids });
      await store.saveSnapshot();
      const dur = track_ids
        .map((i) => store.byId.get(i)?.duration ?? 0)
        .reduce((a, b) => a + b, 0);
      return result(
        `Daylist published as "${title}" — ${written} tracks, ${fmtDuration(dur)}.` +
          (created ? " (created the rolling playlist)" : ""),
        { playlist_id: id, title, tracks: written, duration: fmtDuration(dur) },
      );
    },
  ),
);

/** Remembered across calls so the rolling playlist is never duplicated. */
let lastDaylistId: string | undefined;

server.registerTool(
  "enrich_moods",
  {
    title: "Label the library's moods",
    description:
      "Run (or check) the one-time pass that gives EVERY track a mood: energy, valence, intensity, acoustic-vs-electronic, feeling descriptors, which curated vibe it reads as, and what times of day it fits.\n\n" +
      "This is what makes mood search work across the whole library rather than only the tracks already on a playlist. The library's own metadata cannot support it — genres are a few dozen coarse buckets, and BPM/ReplayGain/MusicBrainz IDs are present on under 3% of files. Results are cached permanently, so this normally runs once and then only picks up newly-added music.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .optional()
        .describe("Only label this many tracks (useful for a cheap trial run). Omit for all."),
      status_only: z.boolean().optional().describe("Just report coverage without starting a run."),
    },
  },
  tool(async ({ limit, status_only }: { limit?: number; status_only?: boolean }) => {
    if (status_only) return result("Mood coverage.", store.moodCoverage());
    const { started } = await store.enrichMoods(limit);
    return result(
      started
        ? `Started labelling ${started} tracks in the background. Poll with status_only.`
        : "Nothing to label (already covered, already running, or no ANTHROPIC_API_KEY).",
      store.moodCoverage(),
    );
  }),
);

// ── refresh ─────────────────────────────────────────────────────────────────

server.registerTool(
  "refresh_index",
  {
    title: "Refresh the local index",
    description:
      "Re-sync from Navidrome and/or ListenBrainz. The index is a cache: the library is pulled in full (~20s) and listens incrementally. Call this if the library changed and results look stale.",
    inputSchema: {
      scope: z.enum(["library", "listens", "all"]).optional().describe("Default 'all'."),
      full_listens: z.boolean().optional().describe("Re-pull the entire listen history, not just new ones."),
    },
  },
  tool(async ({ scope, full_listens }: { scope?: string; full_listens?: boolean }) => {
    const s = scope ?? "all";
    const out: Record<string, unknown> = {};
    if (s === "library" || s === "all") out.library = await store.syncLibrary();
    if (s === "listens" || s === "all") out.new_listens = await store.syncListens(full_listens);
    await store.saveSnapshot();
    return result(
      `Index refreshed: ${store.tracks.length} tracks, ${store.listens.length} listens.`,
      { ...out, tag_enrichment: store.enrichState },
    );
  }),
);

// ── the daylist prompt ──────────────────────────────────────────────────────

server.registerPrompt(
  "daylist",
  {
    title: "Generate this hour's daylist",
    description:
      "Spotify-style daylist: read the hour's context, pick a mood grounded in his own playlists, source ~25 tracks that fit, name it in his voice, and publish it to the rolling daylist playlist.",
    argsSchema: {
      length: z.string().optional().describe("Roughly how many tracks. Default 25."),
      steer: z.string().optional().describe("Optional nudge, e.g. 'keep it instrumental' or 'lean older'."),
    },
  },
  ({ length, steer }: { length?: string; steer?: string }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Generate my daylist for right now (about ${length || "25"} tracks).`,
            steer ? `Steer: ${steer}` : "",
            "",
            "Work in this order and do not skip steps:",
            "",
            "1. Call `daylist_context`. Read the vibe_fit lift values, the hour_profile, and what I have",
            "   heard in the last few days. Note the titles of recent daylists.",
            "",
            "2. Decide the mood for THIS hour. Anchor it on my own curated playlists — the names in",
            "   vibe_fit are my vocabulary, not generic genres. Prefer a vibe with lift > 1 (I really do",
            "   reach for it at this hour). If two are close, pick the one least used by the recent",
            "   daylists. Use `get_vibe_profile` if you need to know what that mood actually sounds like.",
            "",
            "3. Source tracks with `search_tracks`. Requirements:",
            "     - use `mood_vibes` (NOT `vibes`) so you draw on the whole library, not just the",
            "       tracks already sitting on that playlist — plus the mood axes and `fits_time` to",
            "       shape it. Fall back to `vibes` only if mood coverage is still low.",
            "     - pass `exclude_recent_daylists: 6` so this list is not a rerun",
            "     - pass `max_per_artist: 2` so it does not collapse onto one artist",
            "     - pass `hour_of_day` from the context and leave sort on `affinity`",
            "     - over-fetch (limit ~60) and then choose the final set yourself for flow",
            "   Mix roughly 70% things I clearly love with 30% that are either long-unheard",
            "   (`not_listened_within_days`) or recently added — a daylist that only replays this",
            "   week's rotation is boring.",
            "",
            "4. Sequence them deliberately: open with something that lands immediately, keep the energy",
            "   coherent with the hour, avoid two songs by the same artist back to back.",
            "",
            "5. Name it the way Spotify names a daylist: lowercase, 2-4 words, concrete and a little",
            "   specific, evoking the time and feel rather than the genre — e.g. 'golden hour synth cruise',",
            "   'slow shreds tuesday haze', 'late night verse vibes'. Do not reuse a recent title.",
            "",
            "6. Publish with `commit_daylist`, passing the title, the ordered track_ids, and a one-line",
            "   description of why these tracks fit this hour.",
            "",
            "Then tell me, briefly: the title, the mood you picked and why the data supported it, and",
            "3-4 highlights. Do not list every track.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      },
    ],
  }),
);

// ── start ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Warm the index in the background so the first real tool call is not the one
  // that pays for a full library sync.
  void store.ensureReady().catch((e) => {
    console.error("[navidrome-mcp] initial index build failed:", e);
  });
}

main().catch((e) => {
  console.error("[navidrome-mcp] fatal:", e);
  process.exit(1);
});
