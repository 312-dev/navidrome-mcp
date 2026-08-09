/**
 * The query-side view of the mood vocabulary.
 *
 * This server does not define the vocabulary and cannot produce a label. The
 * `navidrome-mood` plugin owns both: it holds each term's anchor in mood-space,
 * each region's centre and radius, and the LLM pass that places tracks against
 * them. It writes the result into the audio files as tags, where Navidrome's own
 * smart playlists and every Subsonic client can read them too.
 *
 * What stays here is only what a *consumer* needs:
 *
 *   - the term list and synonyms, so someone typing "chill" gets `mellow` rather
 *     than nothing. That is input folding, not definition.
 *   - each region's time-of-day affinity, which is genuinely this side's
 *     concern. The labeller has no opinion about clocks; scheduling a playlist
 *     for 7am is a playlist question.
 *
 * Keeping the anchors here as well would mean the same numbers maintained in two
 * languages, drifting apart the first time either is revised. See PLAN.md.
 *
 * The lists below must stay in step with the plugin's by hand. `npm run
 * check:vocab` catches what it can from this side -- a synonym pointing at a
 * term that no longer exists, a region name that is unsafe as a tag value -- but
 * it cannot see the plugin, so a term the plugin dropped will still look valid
 * here and simply stop appearing in results.
 */

/**
 * The controlled vocabulary, in the plugin's own order.
 *
 * A closed set is the point. An open one fragments into near-synonyms
 * (`wistful` / `wistfulness` / `bittersweet-wistful`) and quietly stops matching.
 */
export const MOOD_VOCABULARY = [
  "serene", "tender", "gentle", "warm", "mellow", "pastoral",
  "intimate", "hushed", "dreamy", "melancholy", "mournful", "lonesome",
  "bleak", "weary", "wistful", "sunny", "sweet", "playful",
  "breezy", "groovy", "funky", "swinging", "jaunty", "moody",
  "brooding", "tense", "restless", "smouldering", "defiant", "euphoric",
  "exuberant", "triumphant", "anthemic", "driving", "danceable", "aggressive",
  "furious", "menacing", "frantic", "savage", "heavy", "gritty",
  "fuzzy", "glossy", "shimmering", "pulsing", "cold", "sparse",
  "lush", "raucous", "hypnotic", "stark",
] as const;

export type MoodTerm = string;

const CANON = new Set<string>(MOOD_VOCABULARY);

/**
 * Alternatives folded onto canonical terms.
 *
 * Language-level equivalences, not one library's habits: `angry` and `furious`
 * name the same region regardless of whose collection it is. Several of these
 * are words the vocabulary deliberately excludes because they describe
 * association rather than sound and so span the whole space -- `nostalgic`,
 * `raw`, `lush` -- but people type them anyway, so they resolve rather than fail.
 */
export const SYNONYMS: Record<string, string> = {
  angry: "furious", ferocious: "furious", enraged: "furious",
  abrasive: "aggressive", violent: "aggressive", punishing: "aggressive",
  sinister: "menacing", ominous: "menacing", dark: "menacing",
  crushing: "heavy", pounding: "heavy", thunderous: "heavy", "bass-heavy": "heavy",
  raw: "gritty", scrappy: "gritty", rough: "gritty",
  distorted: "fuzzy", saturated: "fuzzy",
  slick: "glossy", polished: "glossy", sleek: "glossy", clean: "glossy",
  sparkling: "shimmering", glistening: "shimmering", twinkling: "shimmering",
  throbbing: "pulsing", pumping: "pulsing", motorik: "pulsing",
  icy: "cold", clinical: "cold", detached: "cold",
  minimal: "sparse", skeletal: "sparse", spare: "sparse",
  layered: "lush", orchestral: "lush", symphonic: "lush", widescreen: "lush",
  rowdy: "raucous", boisterous: "raucous", unruly: "raucous",
  trancey: "hypnotic", looping: "hypnotic", droning: "hypnotic",
  bare: "stark", austere: "stark",
  calm: "serene", peaceful: "serene", tranquil: "serene", still: "serene",
  soft: "gentle", delicate: "gentle", fragile: "gentle",
  cosy: "warm", cozy: "warm", comforting: "warm",
  laidback: "mellow", "laid-back": "mellow", chill: "mellow", relaxed: "mellow",
  rustic: "pastoral", folksy: "pastoral", bucolic: "pastoral",
  quiet: "hushed", whispered: "hushed",
  hazy: "dreamy", ethereal: "dreamy", woozy: "dreamy", floaty: "dreamy",
  sad: "melancholy", sorrowful: "melancholy", downcast: "melancholy",
  grieving: "mournful", elegiac: "mournful", funereal: "mournful",
  desolate: "bleak", barren: "bleak", grim: "bleak",
  tired: "weary", resigned: "weary", worn: "weary",
  yearning: "wistful", longing: "wistful", nostalgic: "wistful",
  bright: "sunny", cheerful: "sunny", upbeat: "sunny",
  charming: "sweet", endearing: "sweet", romantic: "sweet",
  whimsical: "playful", cheeky: "playful", giddy: "playful",
  breezily: "breezy", carefree: "breezy", easygoing: "breezy",
  soulful: "groovy", "in-the-pocket": "groovy",
  syncopated: "funky", strutting: "funky",
  swung: "swinging", jazzy: "swinging",
  jolly: "jaunty", sprightly: "jaunty",
  overcast: "moody", sullen: "moody", introspective: "moody",
  simmering: "brooding", ominously: "brooding",
  anxious: "tense", uneasy: "tense", nervy: "tense",
  agitated: "restless", jittery: "restless", antsy: "restless",
  sultry: "smouldering", smoldering: "smouldering", seductive: "smouldering",
  rebellious: "defiant", confrontational: "defiant", swaggering: "defiant",
  ecstatic: "euphoric", rapturous: "euphoric", blissful: "euphoric",
  joyful: "exuberant", jubilant: "exuberant", celebratory: "exuberant",
  victorious: "triumphant", heroic: "triumphant", soaring: "triumphant",
  singalong: "anthemic", stadium: "anthemic", rousing: "anthemic",
  propulsive: "driving", insistent: "driving", motoring: "driving",
  clubby: "danceable", "club-ready": "danceable", dancey: "danceable", party: "danceable",
  chaotic: "frantic", breakneck: "frantic", manic: "frantic",
  brutal: "savage", vicious: "savage", feral: "savage",
};

/**
 * Fold a raw descriptor onto the vocabulary.
 *
 * Returns null when nothing matches. Callers decide what to do with that: a
 * query keeps the raw term so a substring match can still succeed, which fails
 * closed rather than quietly widening the search.
 */
export function canonicalise(raw: string): MoodTerm | null {
  const w = raw.trim().toLowerCase();
  if (CANON.has(w)) return w;
  if (SYNONYMS[w]) return SYNONYMS[w];
  const squashed = w.replace(/[\s_]+/g, "-");
  if (CANON.has(squashed)) return squashed;
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

/**
 * When each vibe region suits, and what it means.
 *
 * The hours are a *fallback*. Where listen history exists, measured lift at an
 * hour beats any declared affinity and should override these; where it does not
 * -- a fresh install, or someone who never connected a scrobbler -- these are
 * what makes 7am and 11pm produce different playlists on day one.
 *
 * The region names must match what the plugin writes into the `vibe` tag. A name
 * here that the plugin never writes shows up as a region with zero tracks, which
 * is visible rather than silent.
 */
export interface VibeSchedule {
  hours: number[];
  gloss: string;
}

export const VIBE_SCHEDULE: Record<string, VibeSchedule> = {
  "wind down":      { hours: [21, 22, 23, 0, 1], gloss: "settling toward sleep" },
  "slow morning":   { hours: [5, 6, 7, 8, 9], gloss: "easing into the day" },
  "focus":          { hours: [9, 10, 11, 14, 15, 16], gloss: "steady, undemanding, stays out of the way" },
  "background":     { hours: [11, 12, 13, 14], gloss: "pleasant and unobtrusive" },
  "uplift":         { hours: [8, 9, 10, 16, 17], gloss: "a deliberate lift in mood" },
  "workout":        { hours: [6, 7, 17, 18, 19], gloss: "sustained physical push" },
  "hype":           { hours: [20, 21, 22], gloss: "getting up for something" },
  "driving":        { hours: [8, 9, 16, 17, 18], gloss: "motion; miles passing" },
  "golden hour":    { hours: [17, 18, 19], gloss: "warm light, day easing off" },
  "late night":     { hours: [23, 0, 1, 2, 3, 4], gloss: "after hours; low light" },
  "melancholy":     { hours: [21, 22, 23], gloss: "sitting with something sad" },
  "heavy":          { hours: [15, 16, 17, 21, 22], gloss: "loud, dark and physical" },
  "dinner":         { hours: [18, 19, 20], gloss: "convivial but not competing with conversation" },
  "party":          { hours: [20, 21, 22, 23], gloss: "a room full of people" },
};

export const VIBE_NAMES = Object.keys(VIBE_SCHEDULE);
