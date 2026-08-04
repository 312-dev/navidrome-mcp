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
 * Parallel in-flight requests on the synchronous path.
 *
 * Measured against the account's real limits (10k RPM, 2M output tokens/min),
 * 32-way concurrency consumes ~4% of the output budget -- throughput here is
 * bounded by per-request latency (~90s for 40 records), not by throttling.
 */
const CONCURRENCY = Number(process.env.MOOD_CONCURRENCY ?? 32) || 32;
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

/** Per-million-token prices, so a measured run can be costed exactly. */
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

export interface Usage {
  /** Uncached input tokens, billed at full rate. */
  input: number;
  /** Written to cache this run, billed at 1.25x. */
  cacheWrite: number;
  /** Served from cache, billed at 0.1x. */
  cacheRead: number;
  output: number;
  batches: number;
}

export interface MoodProgress {
  running: boolean;
  done: number;
  total: number;
  cachedTokens: number;
  note: string;
  usage: Usage;
  /** Dollars spent so far, from real usage rather than an estimate. */
  costSoFar: number;
  /** Extrapolated dollars for every remaining unlabelled track. */
  projectedTotal: number;
  /** Set when running through the Batch API. */
  batchId?: string;
  /** True when the 50% Batch API discount applies to costSoFar. */
  discounted: boolean;
}

export class MoodEnricher {
  private readonly client: Anthropic;
  private readonly model: string;
  progress: MoodProgress = {
    running: false,
    done: 0,
    total: 0,
    cachedTokens: 0,
    note: "idle",
    usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, batches: 0 },
    costSoFar: 0,
    projectedTotal: 0,
    discounted: false,
  };

  /** Cost of the usage recorded so far, at this model's published rates. */
  private cost(u: Usage): number {
    const p = PRICES[this.model] ?? PRICES["claude-opus-5"]!;
    const inTok = u.input + u.cacheWrite * 1.25 + u.cacheRead * 0.1;
    const gross = (inTok / 1e6) * p.in + (u.output / 1e6) * p.out;
    // The Batch API bills every token at half the standard rate.
    return this.progress.discounted ? gross / 2 : gross;
  }

  constructor(apiKey?: string, model?: string) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
    this.model = model || DEFAULT_MODEL;
  }

  private async labelBatch(system: string, batch: Track[]): Promise<{
    rows: (Mood & { id: string })[];
    usage: Omit<Usage, "batches">;
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

    const u = res.usage as {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    const usage = {
      input: u.input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
    };
    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return { rows: [], usage };
    const parsed = JSON.parse(text.text) as { tracks?: (Mood & { id: string })[] };
    return { rows: parsed.tracks ?? [], usage };
  }

  /** The request body shared by both the sync and batched paths. */
  private params(system: string, batch: Track[]): Anthropic.MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      max_tokens: 8000,
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> },
      },
      system: [
        { type: "text", text: system, cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "user",
          content: `Label these ${batch.length} tracks:\n\n${batch.map(describe).join("\n")}`,
        },
      ],
    } as Anthropic.MessageCreateParamsNonStreaming;
  }

  /**
   * Label everything via the Message Batches API.
   *
   * Measured on this library, the synchronous path costs ~$27.50 for 9,311
   * tracks on Opus -- output is ~78% of that and prompt caching cannot touch it.
   * Batching is 50% off every token, which halves it, and the trade it asks for
   * (asynchronous, typically under an hour) costs nothing for a one-time offline
   * enrichment. So this is the default for a full run; the synchronous path is
   * kept for small trial runs where waiting on a queue is the worse deal.
   */
  async runBatched(
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
      note: `submitting ${batches.length} batches to the Batch API (${this.model})`,
      usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, batches: 0 },
      costSoFar: 0,
      projectedTotal: 0,
      batchId: undefined,
      discounted: true,
    };

    try {
      const created = await this.client.messages.batches.create({
        requests: batches.map((b, i) => ({
          custom_id: `b${i}`,
          params: this.params(system, b),
        })),
      });
      this.progress.batchId = created.id;
      this.progress.note = `queued as ${created.id}; polling`;
      console.error(`[navidrome-mcp] mood: submitted batch ${created.id} (${batches.length} requests)`);

      // Poll until the batch ends. Anthropic's guidance is most batches finish
      // within an hour; the hard ceiling is 24h, so the loop is bounded well
      // past that rather than looping forever on a wedged job.
      let status = created.processing_status;
      for (let i = 0; i < 3000 && status !== "ended"; i++) {
        await new Promise((r) => setTimeout(r, 20_000));
        const b = await this.client.messages.batches.retrieve(created.id);
        status = b.processing_status;
        const c = b.request_counts;
        this.progress.note =
          `${status}: ${c.succeeded} ok, ${c.processing} running, ${c.errored} errored`;
        this.progress.done = Math.min(pending.length, c.succeeded * BATCH);
      }
      if (status !== "ended") throw new Error(`batch ${created.id} did not finish in time`);

      // Results come back in arbitrary order, so they are keyed by custom_id --
      // but every row also carries its own track id, so ordering is irrelevant
      // to correctness here.
      const acc = this.progress.usage;
      let done = 0;
      for await (const entry of await this.client.messages.batches.results(created.id)) {
        if (entry.result.type !== "succeeded") {
          console.error(`[navidrome-mcp] mood: ${entry.custom_id} ${entry.result.type}`);
          continue;
        }
        const msg = entry.result.message;
        const u = msg.usage as {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
        acc.input += u.input_tokens ?? 0;
        acc.cacheWrite += u.cache_creation_input_tokens ?? 0;
        acc.cacheRead += u.cache_read_input_tokens ?? 0;
        acc.output += u.output_tokens ?? 0;
        acc.batches += 1;
        const text = msg.content.find((b) => b.type === "text");
        if (!text || text.type !== "text") continue;
        try {
          const parsed = JSON.parse(text.text) as { tracks?: (Mood & { id: string })[] };
          const rows = parsed.tracks ?? [];
          done += rows.length;
          await onBatch(rows);
        } catch (e) {
          console.error(`[navidrome-mcp] mood: unparseable result ${entry.custom_id}: ${String(e)}`);
        }
      }
      this.progress.done = done;
      this.progress.costSoFar = Number(this.cost(acc).toFixed(4));
      this.progress.note = `done (${done} labelled)`;
    } finally {
      this.progress.running = false;
    }
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
      note: `${batches.length} batches on ${this.model}, ${CONCURRENCY}-way`,
      usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, batches: 0 },
      costSoFar: 0,
      projectedTotal: 0,
      discounted: false,
    };
    const libraryTotal = store.tracks.filter((t) => !t.mood && !t.missing).length;

    const runOne = async (batch: Track[]): Promise<void> => {
      try {
        const { rows, usage } = await this.labelBatch(system, batch);
        const acc = this.progress.usage;
        acc.input += usage.input;
        acc.cacheWrite += usage.cacheWrite;
        acc.cacheRead += usage.cacheRead;
        acc.output += usage.output;
        acc.batches += 1;
        this.progress.cachedTokens += usage.cacheRead;
        this.progress.costSoFar = Number(this.cost(acc).toFixed(4));
        // Project the whole library from measured per-track cost. The first
        // batch pays an uncached prefix the rest do not, so this over-estimates
        // early -- deliberately, so the projection errs high, not low.
        const perTrack = this.cost(acc) / Math.max(1, acc.batches * BATCH);
        this.progress.projectedTotal = Number((perTrack * libraryTotal).toFixed(2));
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
