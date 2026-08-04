/**
 * Full-library mood enrichment.
 *
 * The problem this solves: nothing in the library says how a track *feels*.
 * Genres are 32 coarse buckets with one covering ~47% of everything, BPM is
 * present on 0.3% of files, ReplayGain on 2%, and MusicBrainz recording IDs on
 * 2% -- which also rules out AcousticBrainz's audio-derived mood models as a
 * primary source (its data is keyed by MBID, and resolving the rest via ISRC ->
 * MusicBrainz is rate-limited to 1 req/s and would still only reach ~23% of the
 * library). Last.fm tags cover everything but describe genre and scene far more
 * than mood.
 *
 * So mood is inferred once, per track, and cached forever. The inference is
 * grounded in the strongest signal available: the user's own curated playlists.
 * Those playlists are a hand-labelled training set in his own vocabulary --
 * "golden hour", "cranked", "slow shreds" -- covering ~3,800 tracks. The pass
 * shows the model real examples from each and asks it to extend that vocabulary
 * to the whole library, so a track that never made it onto a playlist still gets
 * placed in the same space as the ones that did.
 *
 * Cost control comes from three places: batching ~50 tracks per request, prompt
 * caching the (large, identical) taxonomy prefix across every request, and
 * running with thinking disabled at low effort -- this is classification, not
 * reasoning. The taxonomy prefix is what makes caching worth it: it is the
 * biggest part of each request and byte-identical every time.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Store, Track } from "./store.js";

/** Where a track sits in mood-space. All axes 0-100. */
export interface Mood {
  /** Sleepy/still -> frantic. */
  energy: number;
  /** Bleak/melancholy -> bright/joyful. */
  valence: number;
  /** Gentle -> heavy/aggressive. */
  intensity: number;
  /** Fully electronic -> fully acoustic. */
  organic: number;
  /** 2-4 free-form descriptors, e.g. "hazy", "anthemic", "wistful". */
  moods: string[];
  /** Which of the user's own curated vibes this track belongs with (0-3). */
  vibes: string[];
  /** Times of day it fits. */
  times: string[];
}

export const TIME_SLOTS = [
  "early morning",
  "morning",
  "midday",
  "afternoon",
  "golden hour",
  "evening",
  "late night",
] as const;

const BATCH = 40;
/**
 * Opus by default. This is a one-time pass over the whole library whose output
 * every future mood query depends on, so the model choice is worth more than the
 * few dollars it costs; override with MOOD_MODEL to trade quality for spend.
 */
const DEFAULT_MODEL = "claude-opus-5";

function taxonomyPrompt(store: Store, vibeNames: string[]): string {
  const lines: string[] = [];
  lines.push(
    "You are labelling a personal music library so it can be searched by mood.",
    "",
    "The listener has hand-curated playlists that ARE his mood vocabulary. Your job is to",
    "extend that vocabulary to every track in his library, including tracks that never made",
    "it onto one of these playlists. Judge each track on how it actually sounds and feels,",
    "not on its genre label or its popularity.",
    "",
    "His curated vibes, with real examples of each:",
    "",
  );

  for (const name of vibeNames) {
    const ids = store.vibes[name] ?? [];
    const tracks = ids
      .map((id) => store.byId.get(id))
      .filter((t): t is Track => Boolean(t));
    // Sample across the playlist rather than taking the head: the first N
    // entries of an m3u are usually one artist, which would teach the model that
    // the vibe means that artist.
    const step = Math.max(1, Math.floor(tracks.length / 18));
    const sample = tracks.filter((_, i) => i % step === 0).slice(0, 18);
    const genres = new Map<string, number>();
    for (const t of tracks) for (const g of t.genres) genres.set(g, (genres.get(g) ?? 0) + 1);
    const topGenres = [...genres.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([g]) => g)
      .join(", ");
    lines.push(
      `## ${name}  (${tracks.length} tracks; mostly ${topGenres || "mixed"})`,
      ...sample.map((t) => `  - ${t.artist} — ${t.title}${t.year ? ` (${t.year})` : ""}`),
      "",
    );
  }

  lines.push(
    "For each track you are given, return:",
    "  energy    0-100  sleepy and still -> frantic",
    "  valence   0-100  bleak or melancholy -> bright and joyful",
    "  intensity 0-100  gentle -> heavy and aggressive",
    "  organic   0-100  fully electronic -> fully acoustic",
    "  moods     2-4 short descriptors of the feeling (e.g. hazy, anthemic, wistful, menacing)",
    `  vibes     0-3 of his curated vibe names, ONLY where the track genuinely belongs: ${vibeNames.join(", ")}`,
    `  times     when it fits, from: ${TIME_SLOTS.join(", ")}`,
    "",
    "Be decisive and use the full range of each axis -- clustering everything near 50 makes",
    "the labels useless. Leave `vibes` empty rather than forcing a weak match. If you do not",
    "recognise a track, infer from the artist and era rather than guessing at random.",
    "Return one entry per track, preserving the given id exactly.",
  );
  return lines.join("\n");
}

const SCHEMA = {
  type: "object",
  properties: {
    tracks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "The track id exactly as given." },
          energy: { type: "integer", description: "0-100, sleepy to frantic." },
          valence: { type: "integer", description: "0-100, bleak to joyful." },
          intensity: { type: "integer", description: "0-100, gentle to aggressive." },
          organic: { type: "integer", description: "0-100, electronic to acoustic." },
          moods: {
            type: "array",
            items: { type: "string" },
            description: "2-4 short lowercase feeling descriptors.",
          },
          vibes: {
            type: "array",
            items: { type: "string" },
            description: "0-3 curated vibe names this track belongs with.",
          },
          times: {
            type: "array",
            items: { type: "string", enum: [...TIME_SLOTS] },
            description: "Times of day the track fits.",
          },
        },
        required: ["id", "energy", "valence", "intensity", "organic", "moods", "vibes", "times"],
        additionalProperties: false,
      },
    },
  },
  required: ["tracks"],
  additionalProperties: false,
} as const;

function describe(t: Track): string {
  const bits = [
    `id=${t.id}`,
    `${t.artist} — ${t.title}`,
    t.year ? `(${t.year})` : "",
    t.album ? `album: ${t.album}` : "",
    t.genres.length ? `genre: ${t.genres.join("/")}` : "",
    t.tags.length ? `tags: ${t.tags.slice(0, 8).map((x) => x.name).join(", ")}` : "",
    t.vibes.length ? `ALREADY ON: ${t.vibes.join(", ")}` : "",
  ].filter(Boolean);
  return bits.join(" | ");
}

export interface MoodProgress {
  running: boolean;
  done: number;
  total: number;
  cachedTokens: number;
  note: string;
}

export class MoodEnricher {
  private readonly client: Anthropic;
  private readonly model: string;
  progress: MoodProgress = { running: false, done: 0, total: 0, cachedTokens: 0, note: "idle" };

  constructor(apiKey?: string, model?: string) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
    this.model = model || DEFAULT_MODEL;
  }

  private async labelBatch(system: string, batch: Track[]): Promise<{
    rows: (Mood & { id: string })[];
    cacheRead: number;
  }> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 8000,
      // Classification, not reasoning: thinking would multiply the cost of a
      // pass this wide for no gain. Disabling it is permitted at effort `high`
      // or below, and the JSON schema constrains the output shape either way.
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> },
      },
      system: [
        {
          type: "text",
          text: system,
          // The taxonomy block is identical on every request and dwarfs the
          // per-batch track list, so caching it turns the dominant cost into a
          // cache read after the first call.
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: `Label these ${batch.length} tracks:\n\n${batch.map(describe).join("\n")}`,
        },
      ],
    } as Anthropic.MessageCreateParamsNonStreaming);

    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return { rows: [], cacheRead: 0 };
    const parsed = JSON.parse(text.text) as { tracks?: (Mood & { id: string })[] };
    return {
      rows: parsed.tracks ?? [],
      cacheRead: (res.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0,
    };
  }

  /**
   * Label every track that does not already have a mood.
   *
   * Resumable: the caller persists as it goes, so a crash or restart costs only
   * the batch in flight.
   */
  async run(
    store: Store,
    pending: Track[],
    onBatch: (rows: (Mood & { id: string })[]) => Promise<void>,
  ): Promise<void> {
    const vibeNames = Object.keys(store.vibes);
    const system = taxonomyPrompt(store, vibeNames);
    const batches: Track[][] = [];
    for (let i = 0; i < pending.length; i += BATCH) batches.push(pending.slice(i, i + BATCH));

    this.progress = {
      running: true,
      done: 0,
      total: pending.length,
      cachedTokens: 0,
      note: `${batches.length} batches on ${this.model}`,
    };

    const runOne = async (batch: Track[]): Promise<void> => {
      try {
        const { rows, cacheRead } = await this.labelBatch(system, batch);
        this.progress.cachedTokens += cacheRead;
        await onBatch(rows);
      } catch (e) {
        console.error(`[navidrome-mcp] mood batch failed: ${String(e)}`);
      } finally {
        this.progress.done += batch.length;
      }
    };

    // The first batch runs alone. Concurrent requests with an identical prefix
    // all miss the cache -- none can read what the others are still writing --
    // so paying one uncached request up front makes every later one a cache hit.
    if (batches.length) await runOne(batches[0]!);

    const CONCURRENCY = 4;
    let next = 1;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, Math.max(0, batches.length - 1)) }, async () => {
        for (;;) {
          const i = next++;
          if (i >= batches.length) return;
          await runOne(batches[i]!);
        }
      }),
    );

    this.progress.running = false;
    this.progress.note = "done";
  }
}
