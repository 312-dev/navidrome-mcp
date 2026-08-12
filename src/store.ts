/**
 * The library index.
 *
 * Everything this server can answer quickly comes from one in-memory mirror of
 * the library, joined against ListenBrainz history and Last.fm tags.
 *
 * Why mirror at all: Navidrome's REST filtering is exact-match only (no ranges,
 * no AND/OR), so "90s rock I haven't played in a year, max 2 per artist" is not
 * expressible as an API call. Pulling the whole library is cheap -- 9,311 tracks
 * in ~23s -- and once it is local, every such query is a single pass over an
 * array. No SQLite: at this size a linear scan is microseconds, and avoiding a
 * native dependency matters because the gateway image installs servers with
 * `npm ci --ignore-scripts` on Node 20, where a native build would not run.
 *
 * The snapshot on disk is a cache, never a source of truth. If it is missing or
 * unreadable the server simply re-syncs.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LastFm, type Tag } from "./lastfm.js";
import { moodFromTags, moodDiagnosis, MOOD_TAG_NAMES } from "./moodtags.js";
import type { Mood } from "./moodspace.js";
import {
  ListenBrainz,
  dedupeListens,
  matchKey,
  norm,
  primaryArtist,
  type Listen,
} from "./listenbrainz.js";
import type { NdPlaylist, NdSong, Navidrome } from "./navidrome.js";

export interface Track {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  albumArtist: string;
  album: string;
  albumId: string;
  genres: string[];
  year: number;
  date?: string;
  duration: number;
  bpm?: number;
  bitRate?: number;
  suffix?: string;
  size?: number;
  playCount: number;
  /** ms since epoch; 0 when never played through Navidrome. */
  playDate: number;
  starred: boolean;
  rating: number;
  /** ms since epoch, when the file entered the library. */
  addedAt: number;
  missing: boolean;
  /**
   * Curated-playlist membership.
   *
   * Optional enrichment: a signal about this listener's taste where it exists,
   * never a foundation. Nothing needs it, most libraries will have little of it,
   * and a library with none behaves identically apart from a weaker affinity
   * ranking.
   */
  vibes: string[];
  /** Merged Last.fm tags (track-level preferred, artist-level fallback). */
  tags: Tag[];
  /** Lifetime ListenBrainz listens matched to this track. */
  listens: number;
  /** Unix seconds. */
  lastListen: number;
  firstListen: number;
  /** 24 buckets of local-time listen counts; empty when never listened. */
  hourHist: number[];
  /** 7 buckets, 0=Sunday. */
  dowHist: number[];
  /** Normalised join key. */
  nkey: string;
  /**
   * Mood, read from the tags the navidrome-mood plugin wrote into the file.
   *
   * Undefined means unlabelled, which is a normal state: the plugin is optional
   * and a library without it works for everything except mood. See moodtags.ts.
   */
  mood?: Mood;
}

/**
 * One published revision of a rolling playlist.
 *
 * `playlist` is the playlist's title, which is fixed for its whole life, so a
 * run can be attributed to the list it belongs to. `description` is the line
 * that does change between revisions, kept so a generator can see what it has
 * recently said and not repeat the phrasing.
 */
export interface PlaylistRun {
  at: number;
  playlist: string;
  description?: string;
  trackIds: string[];
}

/**
 * What gets persisted between restarts.
 *
 * Mood is deliberately absent. It is read from Navidrome's own tags on every
 * sync, so a copy here could only ever be a staler version of something the
 * server already holds.
 */
interface Snapshot {
  version: number;
  syncedAt: number;
  listensSyncedAt: number;
  songs: NdSong[];
  vibes: Record<string, string[]>;
  trackTags: Record<string, Tag[]>;
  artistTags: Record<string, Tag[]>;
  listenKeys: string[];
  listenTs: number[];
  listenKi: number[];
  /** Distinct submission clients, indexed by listenCli. */
  listenClients: string[];
  listenCli: number[];
  /**
   * Whether the backwards walk has reached the account's start or the floor.
   * Absent on a file written before resumable backfill, which correctly reads as
   * "not known to be complete" and costs one backfill attempt to settle.
   */
  historyComplete?: boolean;
  taggedTracks: string[];
  taggedArtists: string[];
  playlistRuns: PlaylistRun[];
}

/**
 * A snapshot at any other version is discarded and re-synced rather than
 * migrated. Every field in it is a cache of something Navidrome or ListenBrainz
 * will hand back on request, so re-reading a shape whose meaning has changed
 * costs more than starting again.
 *
 * Version 9 reads `vibe_near`, the region a track came closest to when it falls
 * in none. A version 8 file was built before that tag was read, so every mood in
 * it has an empty `vibesNear` and `mood_vibes_near` would match nothing at all,
 * which looks exactly like a library where no track is near any region. The tag
 * is in the files already; a re-sync is what picks it up.
 *
 * Version 8 records each listen's submission client and holds a deduplicated
 * history. A version 7 file has neither: it was written before cross-submitter
 * duplicates were recognised, so its listen counts are inflated wherever two
 * sources reported the same play, and it carries nothing to detect that with.
 * Discarding it is the migration.
 *
 * Version 7 keys the run history by playlist title. A version 6 file files each
 * run under the hour's descriptor phrase instead, which names no playlist, so
 * its track ids cannot be attributed to one.
 */
const SNAPSHOT_VERSION = 9;

/**
 * Progress goes to stderr, never stdout: stdout is the MCP JSON-RPC channel and
 * a stray line there corrupts the protocol.
 */
function log(msg: string): void {
  console.error(`[navidrome-mcp] ${msg}`);
}

export interface StoreOptions {
  navidrome: Navidrome;
  dataDir: string;
  listenBrainzUser?: string;
  lastFmKey?: string;
  timezone: string;
  /**
   * How far back to pull listen history on a cold start, in days.
   *
   * This was 730 on the reasoning that a rolling playlist reflects current
   * habits rather than a decade-old average, and that walking six figures of
   * listens 1000 at a time costs minutes before the server can answer anything.
   * The first half is still true of the daylist. It is wrong for everything
   * else: `listen_count_min`/`max` claim to be lifetime counts, and a deep cut
   * is precisely a track whose last play falls outside any recent window. Under
   * a two-year ceiling both quietly answered a different question, and a
   * Last.fm history imported into ListenBrainz was invisible.
   *
   * The cost is paid once. The walk is bounded by the account, not the window,
   * and the result is persisted; only a discarded snapshot pays it again.
   *
   * Note this bounds a COLD start. Incremental syncs resume from the newest
   * listen held, so listens backfilled with older timestamps (an importer
   * filling in history) need a full resync to be picked up, not a tick.
   */
  historyDays: number;
  /**
   * Dispatcher for *external* calls (ListenBrainz, Last.fm) only. Normally
   * undefined: those are public internet and reachable directly. Navidrome is the
   * one host that may need a proxy hop, and its client holds its own dispatcher.
   */
  externalDispatcher?: unknown;
  enrich: boolean;
}

function toMs(s: unknown): number {
  if (!s) return 0;
  const t = Date.parse(String(s));
  return Number.isFinite(t) ? t : 0;
}

export class Store {
  tracks: Track[] = [];
  byId = new Map<string, Track>();
  /** Curated playlist name -> track ids. */
  vibes: Record<string, string[]> = {};
  playlists: NdPlaylist[] = [];
  listens: Listen[] = [];
  playlistRuns: PlaylistRun[] = [];

  syncedAt = 0;
  listensSyncedAt = 0;
  /** See Snapshot.historyComplete. Drives backfillOlder. */
  historyComplete = false;
  private trackTags: Record<string, Tag[]> = {};
  private artistTags: Record<string, Tag[]> = {};
  private taggedTracks = new Set<string>();
  private taggedArtists = new Set<string>();

  private readonly lastfm: LastFm;
  private readonly lb: ListenBrainz | null;
  private ready: Promise<void> | null = null;
  enrichState: { running: boolean; done: number; total: number; phase: string } = {
    running: false,
    done: 0,
    total: 0,
    phase: "idle",
  };

  constructor(private readonly opts: StoreOptions) {
    this.lastfm = new LastFm(opts.lastFmKey, opts.externalDispatcher);
    this.lb = opts.listenBrainzUser
      ? new ListenBrainz(opts.listenBrainzUser, opts.externalDispatcher)
      : null;
  }

  private get snapshotPath(): string {
    return join(this.opts.dataDir, "index.json");
  }

  /** Idempotent: the first caller does the work, everyone else awaits it. */
  ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.init().catch((e) => {
        this.ready = null; // let a later call retry rather than wedging forever
        throw e;
      });
    }
    return this.ready;
  }

  private async init(): Promise<void> {
    const loaded = await this.loadSnapshot();
    if (!loaded) {
      await this.syncLibrary();
      await this.syncListens();
      await this.saveSnapshot();
    } else if (!this.historyComplete) {
      // A snapshot whose backwards walk was cut short. Resuming has to happen
      // without being asked, because the symptom is silent: queries answer
      // normally against a history that is simply missing its older half, and
      // nothing prompts anyone to call refresh_index. In the background, since
      // this is a repair of a usable index rather than a prerequisite for it.
      void this.resumeHistoryInBackground();
    }
    if (this.opts.enrich) void this.enrichInBackground();
  }

  private historyResuming = false;

  private async resumeHistoryInBackground(): Promise<void> {
    if (this.historyResuming) return;
    this.historyResuming = true;
    try {
      log(`listens: history is incomplete at ${this.listens.length}, resuming the walk`);
      await this.syncListens();
      await this.saveSnapshot();
    } catch (e) {
      log(`listens: resume failed, will try again on next start (${String(e)})`);
    } finally {
      this.historyResuming = false;
    }
  }

  // ── persistence ─────────────────────────────────────────────────────────

  private async loadSnapshot(): Promise<boolean> {
    try {
      const raw = await readFile(this.snapshotPath, "utf8");
      const s = JSON.parse(raw) as Snapshot;
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
        const sep = key.indexOf("\u0000");
        return {
          ts,
          artist: key.slice(0, sep),
          track: key.slice(sep + 1),
          client: s.listenClients?.[s.listenCli?.[i] ?? -1],
        };
      });
      this.build(s.songs ?? []);
      return this.tracks.length > 0;
    } catch {
      return false;
    }
  }

  private snapshotSeq = 0;
  private saveChain: Promise<void> = Promise.resolve();
  private savePending = false;

  /**
   * Coalesce concurrent save requests.
   *
   * The snapshot is a single ~15MB document, so 32 in-flight batches each asking
   * for a write would serialise 480MB of JSON for no benefit -- they all write
   * the same growing state. Instead one write runs at a time and any requests
   * arriving during it collapse into a single follow-up, which by definition
   * includes everything they wanted persisted.
   */
  saveSnapshotSoon(): Promise<void> {
    if (this.savePending) return this.saveChain;
    this.savePending = true;
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(() => {
        this.savePending = false;
        return this.saveSnapshot();
      });
    return this.saveChain;
  }

  async saveSnapshot(): Promise<void> {
    const keyIndex = new Map<string, number>();
    const listenKeys: string[] = [];
    const listenTs: number[] = [];
    const listenKi: number[] = [];
    // Clients are interned the same way the artist/track keys are: there is a
    // handful of distinct submitters across six figures of listens, so storing
    // the string on every listen would cost more than the rest of the history.
    const clientIndex = new Map<string, number>();
    const listenClients: string[] = [];
    const listenCli: number[] = [];
    for (const l of this.listens) {
      const k = `${l.artist}\u0000${l.track}`;
      let i = keyIndex.get(k);
      if (i === undefined) {
        i = listenKeys.length;
        keyIndex.set(k, i);
        listenKeys.push(k);
      }
      listenTs.push(l.ts);
      listenKi.push(i);

      const c = l.client ?? "";
      let ci = clientIndex.get(c);
      if (ci === undefined) {
        ci = listenClients.length;
        clientIndex.set(c, ci);
        listenClients.push(c);
      }
      listenCli.push(ci);
    }
    const snap: Snapshot = {
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
      playlistRuns: this.playlistRuns.slice(-200),
    };
    await mkdir(dirname(this.snapshotPath), { recursive: true });
    // A UNIQUE temp name per write. A fixed one is only atomic single-threaded:
    // with concurrent savers, one writer's rename moves the shared temp file out
    // from under another mid-write, and the second rename fails ENOENT.
    const tmp = `${this.snapshotPath}.${process.pid}.${++this.snapshotSeq}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(snap), "utf8");
      await rename(tmp, this.snapshotPath); // atomic: never leave a half-written index
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  // ── syncing ─────────────────────────────────────────────────────────────

  private rawSongs: NdSong[] = [];

  /** Pull every track and every playlist, and rebuild the derived index. */
  async syncLibrary(): Promise<{ tracks: number; vibes: number }> {
    const nd = this.opts.navidrome;
    const t0 = Date.now();
    const songs = await nd.allSongs((n) => {
      if (n % 2000 === 0) log(`library: ${n} tracks pulled`);
    });
    log(`library: ${songs.length} tracks in ${Math.round((Date.now() - t0) / 1000)}s`);
    const playlists = await nd.listPlaylists();
    this.playlists = playlists;

    const rolling = new Set(this.playlistRuns.map((r) => norm(r.playlist)));
    const vibes: Record<string, string[]> = {};
    for (const p of playlists) {
      if (!p.name || !p.id) continue;
      if (this.isNonVibePlaylist(p, rolling)) continue;
      try {
        const rows = await nd.playlistTracks(p.id);
        vibes[p.name] = rows.map((r) => r.id);
      } catch {
        // A playlist we cannot read simply contributes no taste signal.
      }
    }
    this.vibes = vibes;
    this.syncedAt = Date.now();
    log(`vibes: ${Object.keys(vibes).length} curated playlists indexed`);
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
  private isNonVibePlaylist(p: NdPlaylist, rollingTitles: Set<string>): boolean {
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
  private oldestListen(): number | undefined {
    let oldest: number | undefined;
    for (const l of this.listens) if (oldest === undefined || l.ts < oldest) oldest = l.ts;
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
  private async backfillOlder(floor: number): Promise<number> {
    if (!this.lb || this.historyComplete) return 0;
    const oldest = this.oldestListen();
    if (oldest !== undefined && oldest <= floor) {
      this.historyComplete = true;
      return 0;
    }
    const t0 = Date.now();
    log(`listens: backfilling older than ${oldest ? new Date(oldest * 1000).toISOString().slice(0, 10) : "now"}`);
    const { listens: older, truncated, reachedEnd } = await this.lb.listens({
      since: floor,
      startBefore: oldest,
      onProgress: (n) => {
        if (n % 5000 === 0) {
          log(`listens: ${n} backfilled (${Math.round((Date.now() - t0) / 1000)}s)`);
        }
      },
    });
    this.listens.push(...older);
    // Not truncated means the walk ended on its own terms: the account ran out
    // of listens, or it reached the configured floor. Either way there is
    // nothing older worth asking for again.
    if (!truncated) {
      this.historyComplete = true;
      log(
        `listens: history complete, ${older.length} backfilled in ` +
          `${Math.round((Date.now() - t0) / 1000)}s${reachedEnd ? " (account exhausted)" : " (reached floor)"}`,
      );
    } else {
      log(
        `listens: backfill INCOMPLETE, ${older.length} added in ` +
          `${Math.round((Date.now() - t0) / 1000)}s. The next sync resumes from here.`,
      );
    }
    return older.length;
  }

  async syncListens(full = false): Promise<number> {
    if (!this.lb) return 0;
    const floor = Math.floor(Date.now() / 1000) - this.opts.historyDays * 86400;
    // On a cold start take the bounded window; afterwards resume from the newest
    // listen we already hold, which is always newer than the floor.
    const since = full ? floor : Math.max(this.listensSyncedAt, floor);
    if (full) this.historyComplete = false;
    const t0 = Date.now();
    const { listens: fresh, truncated } = await this.lb.listens({
      since,
      onProgress: (n) => {
        if (n % 5000 === 0) log(`listens: ${n} fetched (${Math.round((Date.now() - t0) / 1000)}s)`);
      },
    });
    log(`listens: ${fresh.length} new in ${Math.round((Date.now() - t0) / 1000)}s`);
    if (truncated) {
      log(
        `listens: WARNING forward pass incomplete, holding ${this.listens.length + fresh.length}.`,
      );
    }
    const backfilled = await this.backfillOlder(floor);
    if (!this.historyComplete) {
      log(
        `listens: WARNING history is still incomplete. Counts and "never listened" ` +
          `are understated until a later sync finishes the walk.`,
      );
    }
    if (fresh.length || backfilled) {
      // Exact-timestamp identity, which is only re-fetch of a listen we already
      // hold. Duplicates from a second submitter never match here, since they
      // carry a different timestamp for the same play; dedupeListens below is
      // what collapses those.
      const seen = new Set(this.listens.map((l) => `${l.ts}|${l.artist}|${l.track}`));
      for (const l of fresh) {
        const k = `${l.ts}|${l.artist}|${l.track}`;
        if (!seen.has(k)) {
          seen.add(k);
          this.listens.push(l);
        }
      }
      // Over the whole history, not just the new rows: it is idempotent, so this
      // both collapses new arrivals against what we hold and repairs a history
      // fetched before a submitter started double-reporting.
      const { kept, dropped } = dedupeListens(this.listens);
      this.listens = kept;
      if (dropped) log(`listens: ${dropped} cross-submitter duplicate(s) collapsed`);
    }
    this.listensSyncedAt = this.listens.length ? this.listens[this.listens.length - 1]!.ts : 0;
    this.applyListenStats();
    return fresh.length + backfilled;
  }

  // ── derivation ──────────────────────────────────────────────────────────

  private build(songs: NdSong[]): void {
    this.rawSongs = songs;
    const vibeOf = new Map<string, string[]>();
    for (const [name, ids] of Object.entries(this.vibes)) {
      for (const id of ids) {
        const arr = vibeOf.get(id);
        if (arr) arr.push(name);
        else vibeOf.set(id, [name]);
      }
    }

    this.tracks = songs.map((s) => {
      const genres =
        Array.isArray(s.genres) && s.genres.length
          ? s.genres.map((g) => String(g.name)).filter(Boolean)
          : s.genre
            ? [String(s.genre)]
            : [];
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
        date: s.date ? String(s.date) : undefined,
        duration: Number(s.duration ?? 0) || 0,
        bpm: s.bpm ? Number(s.bpm) : undefined,
        bitRate: s.bitRate ? Number(s.bitRate) : undefined,
        suffix: s.suffix ? String(s.suffix) : undefined,
        size: s.size ? Number(s.size) : undefined,
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
        mood: moodFromTags(s.tags) ?? undefined,
      } satisfies Track;
    });

    this.byId = new Map(this.tracks.map((t) => [t.id, t]));
    this.applyTags();
    this.applyListenStats();
  }

  private applyTags(): void {
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
  vibeHistogram(): { vibe: string; tracks: number }[] {
    const counts = new Map<string, number>();
    for (const t of this.tracks) {
      for (const v of t.mood?.vibes ?? []) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([vibe, tracks]) => ({ vibe, tracks }))
      .sort((a, b) => b.tracks - a.tracks);
  }

  /**
   * How much of the library carries a usable mood label.
   *
   * Reports *why* when the answer is none. "0 labelled" reads identically
   * whether the plugin was never installed, ran but wrote nothing, or wrote tags
   * Navidrome then dropped for want of a `Tags` entry in its own config -- and
   * those need three different fixes.
   */
  moodCoverage(): { labelled: number; total: number; note: string } {
    const labelled = this.tracks.filter((t) => t.mood).length;
    const anyMoodTag = this.rawSongs.some((s) =>
      MOOD_TAG_NAMES.some((n) => (s.tags?.[n]?.length ?? 0) > 0),
    );
    return {
      labelled,
      total: this.tracks.length,
      note: moodDiagnosis(this.tracks.length, labelled, anyMoodTag),
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
  private applyListenStats(): void {
    if (!this.tracks.length) return;
    const index = new Map<string, Track[]>();
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
      weekday: "short",
    });
    const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    for (const l of this.listens) {
      const hits = index.get(matchKey(primaryArtist(l.artist), l.track));
      if (!hits) continue;
      const parts = fmt.formatToParts(new Date(l.ts * 1000));
      const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
      const dow = DOW[parts.find((p) => p.type === "weekday")?.value ?? "Sun"] ?? 0;
      for (const t of hits) {
        if (!t.hourHist.length) {
          t.hourHist = new Array(24).fill(0);
          t.dowHist = new Array(7).fill(0);
        }
        t.listens++;
        t.hourHist[hour]!++;
        t.dowHist[dow]!++;
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
  async enrichInBackground(): Promise<void> {
    if (this.enrichState.running) return;
    this.enrichState = { running: true, done: 0, total: 0, phase: "artists" };
    try {
      const artists = [...new Set(this.tracks.map((t) => norm(t.artist)).filter(Boolean))];
      const pendingArtists = artists.filter((a) => !this.taggedArtists.has(a));
      const originals = new Map<string, string>();
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
        phase: "tracks",
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
      // Enrichment is strictly an improvement; failing it must never take the
      // server down or block queries that work fine on Navidrome data alone.
    } finally {
      this.enrichState = { running: false, done: 0, total: 0, phase: "idle" };
    }
  }

  // ── vocabulary helpers ──────────────────────────────────────────────────

  tagVocabulary(limit = 120): { tag: string; tracks: number }[] {
    const counts = new Map<string, number>();
    for (const t of this.tracks) {
      for (const tag of t.tags) counts.set(tag.name, (counts.get(tag.name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, tracks]) => ({ tag, tracks }))
      .sort((a, b) => b.tracks - a.tracks)
      .slice(0, limit);
  }

  genreHistogram(): { genre: string; tracks: number }[] {
    const counts = new Map<string, number>();
    for (const t of this.tracks) {
      for (const g of t.genres) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([genre, tracks]) => ({ genre, tracks }))
      .sort((a, b) => b.tracks - a.tracks);
  }

  decadeHistogram(): { decade: string; tracks: number }[] {
    const counts = new Map<number, number>();
    for (const t of this.tracks) {
      if (!t.year) continue;
      const d = Math.floor(t.year / 10) * 10;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([d, tracks]) => ({ decade: `${d}s`, tracks }));
  }

  recordPlaylistRun(run: PlaylistRun): void {
    this.playlistRuns.push(run);
    if (this.playlistRuns.length > 200) this.playlistRuns = this.playlistRuns.slice(-200);
  }

  /** The most recent revisions of one rolling playlist, or of all of them. */
  recentRuns(runs: number, playlist?: string): PlaylistRun[] {
    // Guarded rather than clamped: slice(-0) is slice(0), which would hand back
    // every run on file for a request that asked for none.
    if (runs <= 0) return [];
    const key = playlist ? norm(playlist) : undefined;
    const rows = key ? this.playlistRuns.filter((r) => norm(r.playlist) === key) : this.playlistRuns;
    return rows.slice(-runs);
  }

  /** Distinct free-form mood descriptors across the library. */
  moodVocabulary(limit = 80): { mood: string; tracks: number }[] {
    const counts = new Map<string, number>();
    for (const t of this.tracks) {
      for (const m of t.mood?.moods ?? []) counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([mood, tracks]) => ({ mood, tracks }))
      .sort((a, b) => b.tracks - a.tracks)
      .slice(0, limit);
  }

  /**
   * Track ids the last `runs` revisions of one rolling playlist used.
   *
   * Scoped to a single playlist so each one avoids repeating itself. Pooling
   * every rolling playlist's history instead would let a busy hourly list strip
   * the candidates out from under all the others.
   */
  recentRunTrackIds(playlist: string, runs: number): Set<string> {
    const out = new Set<string>();
    for (const r of this.recentRuns(runs, playlist)) {
      for (const id of r.trackIds) out.add(id);
    }
    return out;
  }
}
