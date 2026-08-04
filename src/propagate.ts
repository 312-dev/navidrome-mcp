/**
 * Vibe propagation — extending the user's curated vibes to the whole library
 * using nothing but data already on hand.
 *
 * The curated playlists label ~34% of the library. The other 66% is invisible to
 * any `vibes` filter, which is the practical ceiling on mood search. This closes
 * that gap without an LLM and without fetching anything new: the playlists are a
 * labelled training set, Last.fm tags (98% coverage) are the feature space, and
 * a nearest-centroid classifier maps one onto the other.
 *
 * Why nearest-centroid rather than something fancier: the classes are few (11),
 * overlapping (a track can be both "good vibes" and "golden hour"), and the
 * feature space is sparse and high-dimensional -- exactly where centroids do
 * well and where a deeper model would overfit 3,150 examples. It also retrains
 * in milliseconds, so it can re-run every time tag enrichment advances.
 *
 * Measured on a 20% holdout of the real library: 63% top-1 and 85% top-2 against
 * a 28% majority-class baseline. That is good enough to *suggest* a vibe with a
 * confidence attached, which is how it is exposed -- not good enough to pretend
 * it is a hand-curated label, which is why predictions stay in a separate field
 * from `vibes` and never overwrite them.
 *
 * Direct mood-word lookup was measured and rejected: the library contains only
 * 23 distinct mood-bearing tags, the most common reaching 113 tracks (~1%).
 * The signal is in the tag space as a whole, not in the mood words.
 */

import type { Tag } from "./lastfm.js";

export interface VibeGuess {
  vibe: string;
  /** Cosine similarity to that vibe's centroid, 0-1. Higher is more confident. */
  score: number;
}

type Vector = Map<string, number>;

function unit(v: Vector): Vector {
  let n = 0;
  for (const x of v.values()) n += x * x;
  n = Math.sqrt(n) || 1;
  for (const [k, x] of v) v.set(k, x / n);
  return v;
}

function cosine(a: Vector, b: Vector): number {
  // Iterate the smaller vector; tag vectors are sparse and sizes differ a lot.
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [k, x] of small) {
    const y = big.get(k);
    if (y) s += x * y;
  }
  return s;
}

export interface PropagationInput {
  id: string;
  tags: Tag[];
  /** Curated vibe membership; empty for the tracks we want to predict. */
  vibes: string[];
}

export interface PropagationResult {
  /** trackId -> ranked guesses (curated tracks are skipped). */
  guesses: Map<string, VibeGuess[]>;
  trained: number;
  predicted: number;
}

/**
 * Learn a centroid per vibe from the curated tracks, then score every
 * uncurated track against them.
 */
export function propagateVibes(
  tracks: PropagationInput[],
  opts: { topN?: number; minScore?: number } = {},
): PropagationResult {
  const topN = opts.topN ?? 3;
  const minScore = opts.minScore ?? 0.12;

  // Document frequency over the whole library, for idf weighting. Without it the
  // ubiquitous tags ("rock" is on ~47% of this library) dominate every centroid
  // and every track looks equally close to everything.
  const df = new Map<string, number>();
  for (const t of tracks) {
    for (const tag of t.tags) df.set(tag.name, (df.get(tag.name) ?? 0) + 1);
  }
  const N = Math.max(1, tracks.length);
  const idf = (name: string) => Math.log(N / (1 + (df.get(name) ?? 0)));

  const vectorOf = (t: PropagationInput): Vector | null => {
    if (!t.tags.length) return null;
    const v: Vector = new Map();
    // Last.fm tag counts are 0-100 popularity within a track, so they already
    // encode relative strength; scale then idf-weight.
    for (const tag of t.tags) v.set(tag.name, (tag.count / 100) * idf(tag.name));
    return unit(v);
  };

  const centroids = new Map<string, Vector>();
  const seen = new Map<string, number>();
  let trained = 0;
  for (const t of tracks) {
    if (!t.vibes.length) continue;
    const v = vectorOf(t);
    if (!v) continue;
    trained++;
    for (const name of t.vibes) {
      let c = centroids.get(name);
      if (!c) {
        c = new Map();
        centroids.set(name, c);
      }
      for (const [k, x] of v) c.set(k, (c.get(k) ?? 0) + x);
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
  }
  for (const c of centroids.values()) unit(c);

  const guesses = new Map<string, VibeGuess[]>();
  let predicted = 0;
  for (const t of tracks) {
    if (t.vibes.length) continue; // already labelled by hand; never override
    const v = vectorOf(t);
    if (!v) continue;
    const scored: VibeGuess[] = [];
    for (const [vibe, c] of centroids) {
      if (!seen.get(vibe)) continue;
      const s = cosine(v, c);
      if (s >= minScore) scored.push({ vibe, score: Number(s.toFixed(3)) });
    }
    if (!scored.length) continue;
    scored.sort((a, b) => b.score - a.score);
    guesses.set(t.id, scored.slice(0, topN));
    predicted++;
  }

  return { guesses, trained, predicted };
}
