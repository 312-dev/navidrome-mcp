/**
 * The controlled mood vocabulary.
 *
 * v1 let the model write whatever descriptors it liked. Across 9,193 tracks that
 * produced 1,020 distinct words — 33% used exactly once, 83% used 25 times or
 * fewer. Individually reasonable, collectively unusable: no word was dense
 * enough to filter on, and near-synonyms split what usage there was five ways
 * (`club` / `clubby` / `club-ready` / `dancey` / `danceable`).
 *
 * These 53 terms were derived from that data rather than invented:
 *
 *   1. Keep words used >= 20 times whose tracks CLUSTER — measured as the mean
 *      standard deviation across intensity/acousticness/valence. Words describing
 *      SOUND score 5-8 (`pastoral`, `pounding`, `bass-heavy`); words describing
 *      atmosphere or association score 15-18 (`cinematic`, `nostalgic`, `raw`,
 *      `lush`, `hypnotic`) and were dropped. That second group is precisely what
 *      put Debussy and Metallica under the same label.
 *   2. Collapse the survivors by proximity in mood-space (radius 9), letting the
 *      most-used word win each cluster — so the vocabulary stays in the user's
 *      own idiom instead of one imposed on it.
 *
 * `SYNONYMS` maps the absorbed words back onto their canonical term, so a model
 * that reaches for "angry" or "ferocious" still lands on `heavy` / `furious`
 * rather than inventing vocabulary drift all over again.
 */

/** The canonical terms a labeller may choose from. */
export const MOOD_VOCABULARY = [
  "aggressive", "atmospheric", "bass-heavy", "brash", "bratty", "breezy", "calm",
  "catchy", "club-ready", "cold", "delicate", "drifting", "euphoric", "flexing",
  "flirty", "floating", "folky", "fragile", "furious", "fun", "fuzzy", "gentle",
  "glossy", "glowing", "grungy", "hard", "heartbroken", "heavy", "intimate",
  "jangly", "jaunty", "joyful", "lo-fi", "loose", "menacing", "moody", "party",
  "polished", "pulsing", "riffy", "rootsy", "silky", "smoldering", "snarling",
  "soft", "sunny", "sweet", "swinging", "synthy", "upbeat", "warm",
] as const;

export type MoodTerm = (typeof MOOD_VOCABULARY)[number];

const CANON = new Set<string>(MOOD_VOCABULARY);

/**
 * Absorbed near-synonyms, from the clustering pass. Keys are what a model might
 * reach for; values are the canonical term for that region of mood-space.
 */
export const SYNONYMS: Record<string, MoodTerm> = {
  // warm cluster
  mellow: "warm", wry: "warm", easygoing: "warm", devoted: "warm", sentimental: "warm",
  // sunny / upbeat
  carefree: "sunny", celebratory: "upbeat", giddy: "upbeat", youthful: "upbeat",
  // intimate / gentle / delicate
  hushed: "intimate", hymnal: "intimate", serene: "gentle", pastoral: "gentle",
  folksy: "gentle",
  // dance / club
  dancey: "euphoric", club: "euphoric", clubby: "euphoric", danceable: "flirty",
  festival: "club-ready",
  // catchy cluster
  bright: "catchy", slinky: "catchy", cheeky: "catchy", kinetic: "catchy",
  jittery: "catchy",
  // heavy / angry
  angsty: "heavy", angry: "heavy", anguished: "heavy", desperate: "heavy",
  pounding: "furious", ferocious: "furious", explosive: "aggressive",
  fierce: "aggressive", abrasive: "menacing", industrial: "menacing",
  // swagger
  cocky: "brash", hyped: "brash", "hard-hitting": "brash", surging: "brash",
  hype: "brash", street: "hard", boastful: "hard", banging: "bass-heavy",
  // texture / production
  shimmering: "glossy", confident: "glossy", slick: "glossy", sleek: "glossy",
  neon: "glossy", airy: "lo-fi", "late-night": "floating", floaty: "floating",
  sunlit: "silky",
  // acoustic / roots
  weathered: "folky", rustic: "folky", wandering: "folky", dusty: "folky",
  cozy: "gentle", vintage: "rootsy",
  // affect
  somber: "heartbroken", resigned: "heartbroken", lonesome: "fragile",
  introspective: "moody", icy: "moody",
  charming: "sweet", whimsical: "sweet", singalong: "joyful",
  tropical: "flirty", summery: "flirty",
  rousing: "jaunty", communal: "jaunty",
};

/**
 * Fold a raw descriptor onto the controlled vocabulary.
 * Returns null when it maps to nothing — callers should drop it rather than
 * inventing a term, which is how v1's tail grew.
 */
export function canonicalise(raw: string): MoodTerm | null {
  const w = raw.trim().toLowerCase();
  if (CANON.has(w)) return w as MoodTerm;
  const mapped = SYNONYMS[w];
  if (mapped) return mapped;
  // Light morphology: "dreamier" -> "dreamy" is not worth guessing at, but a
  // trailing plural or a hyphen/space mismatch is.
  const squashed = w.replace(/[\s_]+/g, "-");
  if (CANON.has(squashed)) return squashed as MoodTerm;
  if (SYNONYMS[squashed]) return SYNONYMS[squashed];
  return null;
}

/** Canonicalise a list, dedupe, and cap. */
export function canonicaliseAll(raw: string[], max = 4): MoodTerm[] {
  const out: MoodTerm[] = [];
  for (const r of raw) {
    const c = canonicalise(r);
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= max) break;
  }
  return out;
}
