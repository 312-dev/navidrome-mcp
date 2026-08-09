/**
 * Mood-space: distance, cohesion, and sequencing.
 *
 * This is the module that answers "would these two tracks sit comfortably next
 * to each other", which mood *words* cannot. Measured on the real library, one
 * word routinely spans the room:
 *
 *   tender      Debussy, Suite bergamasque  I8  O95   <->  Metallica, Nothing Else Matters  I55 O60
 *   brooding    Hozier, Son of Nyx          I20 O55   <->  Avenged Sevenfold, Waking...     I92 O25
 *   anthemic    The Beatles, All You Need   I30 V80   <->  Slipknot, Unsainted              I95 V30
 *
 * Each label is correct. "Tender" describes emotional content, and content is
 * genre-independent — so it is a fine thing to search for and a terrible thing
 * to sequence by. Cohesion has to come from the sonic axes instead.
 */

import type { MoodTerm } from "./vocabulary.js";

/** Where a track sits. v2 adds density/tempo/vocal, which drive flow. */
export interface MoodPoint {
  /** 0-100, still -> frantic. */
  energy: number;
  /** 0-100, bleak -> joyful. */
  valence: number;
  /** 0-100, gentle -> heavy. */
  intensity: number;
  /** 0-100, electronic -> acoustic. */
  acousticness: number;
  /** 0-100, sparse/solo -> wall of sound. */
  density: number;
  tempoFeel: TempoFeel;
  vocal: VocalKind;
  moods: MoodTerm[];
}

export const TEMPO_FEELS = ["still", "slow", "mid", "driving", "frantic"] as const;
export type TempoFeel = (typeof TEMPO_FEELS)[number];

export const VOCAL_KINDS = ["instrumental", "sung", "rapped", "mixed"] as const;
export type VocalKind = (typeof VOCAL_KINDS)[number];

/**
 * How much each axis contributes to "these clash".
 *
 * The weights are not uniform, and the two interesting ones are:
 *
 *   - `valence` is CHEAP. A sad song and a happy song sit together fine if they
 *     sound alike — a melancholy folk tune next to a joyful folk tune is a good
 *     transition. Weighting valence heavily is what makes a playlist emotionally
 *     monotonous, which is a different failure from the one we are fixing.
 *   - `intensity` and `acousticness` are EXPENSIVE, because together they are the
 *     Debussy/Metallica axis — the actual observed failure.
 */
const W = {
  intensity: 1.6,
  acousticness: 1.4,
  density: 1.0,
  energy: 1.0,
  valence: 0.45,
} as const;

/** Tempo is ordinal, so a mismatch is measured in steps, not identity. */
const TEMPO_INDEX: Record<TempoFeel, number> = {
  still: 0, slow: 1, mid: 2, driving: 3, frantic: 4,
};
/** One step of tempo costs about as much as 18 points on a numeric axis. */
const TEMPO_STEP_COST = 18;

/**
 * Vocal is categorical: instrumental -> rapped is jarring at any energy, but
 * sung -> mixed barely registers. Asymmetric pairs, so a lookup rather than a
 * distance.
 */
function vocalCost(a: VocalKind, b: VocalKind): number {
  if (a === b) return 0;
  const pair = [a, b].sort().join("|");
  switch (pair) {
    case "mixed|sung": return 4;
    case "mixed|rapped": return 8;
    case "rapped|sung": return 20;
    case "instrumental|sung": return 16;
    case "instrumental|mixed": return 18;
    case "instrumental|rapped": return 28;
    default: return 12;
  }
}

/**
 * Distance between two points, roughly on a 0-100 scale.
 *
 * Weighted Euclidean over the numeric axes, plus additive ordinal/categorical
 * penalties. Additive rather than folded into the Euclidean term because a
 * tempo or vocal clash is a *disqualifier*, not something that should be
 * averaged away by four axes that happen to agree.
 */
export function moodDistance(a: MoodPoint, b: MoodPoint): number {
  const sq =
    W.intensity * (a.intensity - b.intensity) ** 2 +
    W.acousticness * (a.acousticness - b.acousticness) ** 2 +
    W.density * (a.density - b.density) ** 2 +
    W.energy * (a.energy - b.energy) ** 2 +
    W.valence * (a.valence - b.valence) ** 2;
  const totalW = W.intensity + W.acousticness + W.density + W.energy + W.valence;
  const numeric = Math.sqrt(sq / totalW);
  const tempo = Math.abs(TEMPO_INDEX[a.tempoFeel] - TEMPO_INDEX[b.tempoFeel]) * TEMPO_STEP_COST;
  return numeric + tempo + vocalCost(a.vocal, b.vocal);
}

/** Centroid of a set — the "region" a vibe occupies. */
export function centroid(points: MoodPoint[]): MoodPoint | null {
  if (!points.length) return null;
  const mean = (f: (p: MoodPoint) => number) =>
    points.reduce((s, p) => s + f(p), 0) / points.length;
  // Ordinal median rather than mean, so a bimodal vibe lands on a real value
  // instead of halfway between two it never contains.
  const tempos = points.map((p) => TEMPO_INDEX[p.tempoFeel]).sort((x, y) => x - y);
  const tIdx = tempos[Math.floor(tempos.length / 2)]!;
  const vocalCounts = new Map<VocalKind, number>();
  for (const p of points) vocalCounts.set(p.vocal, (vocalCounts.get(p.vocal) ?? 0) + 1);
  const vocal = [...vocalCounts.entries()].sort((x, y) => y[1] - x[1])[0]![0];
  const moodCounts = new Map<MoodTerm, number>();
  for (const p of points) for (const m of p.moods) moodCounts.set(m, (moodCounts.get(m) ?? 0) + 1);
  return {
    energy: mean((p) => p.energy),
    valence: mean((p) => p.valence),
    intensity: mean((p) => p.intensity),
    acousticness: mean((p) => p.acousticness),
    density: mean((p) => p.density),
    tempoFeel: TEMPO_FEELS[tIdx]!,
    vocal,
    moods: [...moodCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([m]) => m),
  };
}

/**
 * Radius covering a given share of a set — the natural cohesion radius for a
 * vibe, computed at index time rather than guessed at query time.
 */
export function spreadRadius(points: MoodPoint[], quantile = 0.75): number {
  const c = centroid(points);
  if (!c || points.length < 2) return 0;
  const ds = points.map((p) => moodDistance(p, c)).sort((a, b) => a - b);
  return ds[Math.min(ds.length - 1, Math.floor(ds.length * quantile))]!;
}

/**
 * Order a chosen set so consecutive tracks flow.
 *
 * Two things are in tension: minimising transition cost pulls toward a flat,
 * samey run, while an energy arc gives the list a shape. So the cost is
 * transition distance plus a penalty for deviating from the target energy at
 * that position — greedy nearest-neighbour under the combined cost.
 *
 * Greedy rather than optimal on purpose: this is a ~25-item ordering where a
 * good answer now beats a perfect one, and exact TSP buys nothing a listener
 * would notice.
 */
export function sequence(
  tracks: { id: string; mood: MoodPoint }[],
  opts: { arc?: "rise" | "fall" | "peak" | "flat"; startFrom?: string } = {},
): { id: string; mood: MoodPoint }[] {
  if (tracks.length < 3) return tracks;
  const arc = opts.arc ?? "peak";
  const n = tracks.length;

  // Target energy at position i, as a fraction of the set's own range.
  const energies = tracks.map((t) => t.mood.energy).sort((a, b) => a - b);
  const lo = energies[0]!;
  const hi = energies[energies.length - 1]!;
  const target = (i: number): number => {
    const f = i / Math.max(1, n - 1);
    const shape =
      arc === "rise" ? f
      : arc === "fall" ? 1 - f
      : arc === "flat" ? 0.5
      : Math.sin(Math.PI * f); // peak: rise then settle
    return lo + (hi - lo) * shape;
  };

  const remaining = [...tracks];
  // Open on something that fits the arc's start, and land it well: the first
  // track is the one a listener judges the list by.
  let bestIdx = 0;
  let bestScore = Infinity;
  remaining.forEach((t, i) => {
    const s = Math.abs(t.mood.energy - target(0));
    if (s < bestScore) { bestScore = s; bestIdx = i; }
  });
  if (opts.startFrom) {
    const forced = remaining.findIndex((t) => t.id === opts.startFrom);
    if (forced >= 0) bestIdx = forced;
  }
  const out = [remaining.splice(bestIdx, 1)[0]!];

  while (remaining.length) {
    const prev = out[out.length - 1]!;
    const pos = out.length;
    let pick = 0;
    let best = Infinity;
    remaining.forEach((t, i) => {
      const transition = moodDistance(prev.mood, t.mood);
      const arcMiss = Math.abs(t.mood.energy - target(pos));
      const score = transition + arcMiss * 0.8;
      if (score < best) { best = score; pick = i; }
    });
    out.push(remaining.splice(pick, 1)[0]!);
  }
  return out;
}

/** Mean transition cost — a single number for how well a list flows. */
export function flowScore(ordered: { mood: MoodPoint }[]): number {
  if (ordered.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < ordered.length; i++) {
    total += moodDistance(ordered[i - 1]!.mood, ordered[i]!.mood);
  }
  return total / (ordered.length - 1);
}
