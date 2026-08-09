/**
 * Full-library mood enrichment.
 *
 * The problem this solves: nothing in a music library says how a track *feels*.
 * Genre tags are coarse and usually top-heavy (one genre covered 47% of the
 * library this was built against), and the audio-derived alternatives are not
 * reachable in practice -- AcousticBrainz's mood models are keyed by MusicBrainz
 * recording ID, which under 3% of files carry, and resolving the rest via ISRC
 * is rate-limited to 1 req/s. Last.fm tags cover everything but describe genre
 * and scene far more than mood.
 *
 * So mood is inferred once, per track, and cached forever. The inference is
 * grounded in the defined vocabulary in `vocabulary.ts`: every term the model
 * may use carries an anchor in mood-space and a one-line gloss, so labelling is
 * placement against fixed definitions rather than free association. That is what
 * makes the output comparable across libraries -- and what lets a library with
 * no playlists and no listening history be labelled just as well as one with
 * years of both.
 *
 * Cost control comes from three places: batching ~40 tracks per request, prompt
 * caching the (large, identical) taxonomy prefix across every request, and
 * running with thinking disabled at low effort -- this is classification, not
 * reasoning. The taxonomy prefix is what makes caching worth it: it is the
 * biggest part of each request and byte-identical every time.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Store, Track } from "./store.js";
import { TEMPO_FEELS, VOCAL_KINDS, type MoodPoint } from "./moodspace.js";
import { MOOD_ANCHORS, MOOD_VOCABULARY } from "./vocabulary.js";

/**
 * Where a track sits in mood-space, plus when it fits.
 *
 * Extends `MoodPoint` so a labelled track is directly usable by the cohesion and
 * sequencing engine with no conversion step.
 *
 * Note what is NOT here: which vibes the track belongs to. Vibe membership is
 * computed from these coordinates (see `vibesFor`), not asked of the model --
 * so it costs no tokens, cannot drift between batches, and updates for free if a
 * region is ever redefined.
 */
export interface Mood extends MoodPoint {
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

/**
 * The system prompt: a fixed taxonomy, identical for every library.
 *
 * Built once from the vocabulary module rather than from any library's contents.
 * That is deliberate and it is the whole portability argument -- a prompt that
 * showed the model examples from the listener's own playlists would teach it
 * that collection's shape, so the same track would be labelled differently
 * depending on whose library it sat in, and the labels would not be comparable.
 *
 * Every term is given with its coordinates AND its gloss, so the model has two
 * consistent descriptions of the same region to place a track against.
 */
function taxonomyPrompt(): string {
  const axis = (name: string, lo: string, hi: string) => `  ${name.padEnd(13)} 0-100  ${lo} -> ${hi}`;
  const lines: string[] = [
    "You are labelling a music library so it can be searched and sequenced by mood.",
    "",
    "Judge each track on how it actually SOUNDS, not on its genre label, its lyrics, its",
    "reputation or its popularity. Two tracks with the same label should be usable one after",
    "the other without the transition feeling wrong.",
    "",
    "## Axes",
    "",
    axis("energy", "still and sleepy", "frantic activity"),
    axis("valence", "bleak", "joyful"),
    axis("intensity", "gentle", "heavy and aggressive"),
    axis("acousticness", "fully electronic", "fully acoustic"),
    axis("density", "sparse, one or two elements", "wall of sound"),
    "",
    `  tempoFeel     one of: ${TEMPO_FEELS.join(", ")}  (how fast it FEELS, not its BPM)`,
    `  vocal         one of: ${VOCAL_KINDS.join(", ")}`,
    "",
    "Be decisive and use the full range -- clustering everything near 50 makes the labels",
    "useless. `density` is about how much is happening at once: a solo voice is low even when",
    "it is loud, a shoegaze wall is high even when it is calm.",
    "",
    "## Vocabulary",
    "",
    "Pick 2-4 `moods` from this list and nothing else. Each term is a fixed REGION of the",
    "space above, given as its coordinates (E/V/I/A/D) and what it means. Choose the terms",
    "whose regions your numbers actually land in -- the two should agree.",
    "",
  ];

  for (const [term, a] of Object.entries(MOOD_ANCHORS)) {
    const coords = `E${a.energy} V${a.valence} I${a.intensity} A${a.acousticness} D${a.density}`;
    lines.push(`  ${term.padEnd(12)} ${coords.padEnd(28)} ${a.gloss}`);
  }

  lines.push(
    "",
    "## Times of day",
    "",
    `  times  when the track fits, from: ${TIME_SLOTS.join(", ")}`,
    "",
    "Judge this by the sound, not by habit: quiet and spacious suits late night, bright and",
    "propulsive suits morning. Give every track at least one.",
    "",
    "## Notes",
    "",
    "Do not guess at random. If a track is unfamiliar, infer from the artist, the album and",
    "the era -- an informed placement is far more useful than a hedged one at 50.",
    "Return one entry per track, preserving the given id exactly.",
  );
  return lines.join("\n");
}

/**
 * `moods` is an enum of the whole vocabulary, so an off-list term is not a thing
 * the model can return. `canonicalise` still exists for descriptors arriving from
 * elsewhere -- the Navidrome plugin, or a user's own query -- but nothing written
 * by this path needs folding after the fact.
 */
const SCHEMA = {
  type: "object",
  properties: {
    tracks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "The track id exactly as given." },
          energy: { type: "integer", description: "0-100, still to frantic." },
          valence: { type: "integer", description: "0-100, bleak to joyful." },
          intensity: { type: "integer", description: "0-100, gentle to aggressive." },
          acousticness: { type: "integer", description: "0-100, electronic to acoustic." },
          density: { type: "integer", description: "0-100, sparse to wall-of-sound." },
          tempoFeel: {
            type: "string",
            enum: [...TEMPO_FEELS],
            description: "How fast the track feels.",
          },
          vocal: { type: "string", enum: [...VOCAL_KINDS] },
          moods: {
            type: "array",
            items: { type: "string", enum: [...MOOD_VOCABULARY] },
            minItems: 2,
            maxItems: 4,
            description: "2-4 terms from the vocabulary, matching the axes given.",
          },
          times: {
            type: "array",
            items: { type: "string", enum: [...TIME_SLOTS] },
            minItems: 1,
            description: "Times of day the track fits.",
          },
        },
        required: [
          "id", "energy", "valence", "intensity", "acousticness",
          "density", "tempoFeel", "vocal", "moods", "times",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["tracks"],
  additionalProperties: false,
} as const;

/**
 * What the model sees about one track.
 *
 * Metadata only. Curated-playlist membership is deliberately absent: telling the
 * labeller a track already sits on a playlist called "late night" would make the
 * label a restatement of the filing rather than a judgement about the sound, and
 * would produce different coordinates for the same track in two libraries.
 */
function describe(t: Track): string {
  const bits = [
    `id=${t.id}`,
    `${t.artist} — ${t.title}`,
    t.year ? `(${t.year})` : "",
    t.album ? `album: ${t.album}` : "",
    t.genres.length ? `genre: ${t.genres.join("/")}` : "",
    t.tags.length ? `tags: ${t.tags.slice(0, 8).map((x) => x.name).join(", ")}` : "",
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
    pending: Track[],
    onBatch: (rows: (Mood & { id: string })[]) => Promise<void>,
  ): Promise<void> {
    const system = taxonomyPrompt();
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
    const system = taxonomyPrompt();
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
