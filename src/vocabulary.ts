/**
 * The universal mood vocabulary.
 *
 * Every term here is DEFINED by an anchor in mood-space rather than discovered
 * by sampling a library. That distinction is the whole design:
 *
 *   - A vocabulary derived from one collection inherits its shape. Terms earn
 *     their place by being frequent there, so a rock-heavy library yields
 *     `riffy` and `bass-heavy` while a jazz collection would need distinctions
 *     neither of those covers. The list stops travelling.
 *   - A vocabulary of defined anchors covers the SPACE instead of a sample of
 *     it. Any library maps onto the same coordinates; different collections
 *     simply occupy different regions. A term nobody's music reaches is unused,
 *     not wrong.
 *
 * Coherence is therefore guaranteed by construction. An earlier free-form pass
 * over ~9,000 tracks produced 1,020 descriptors, and scoring each by how tightly
 * its tracks clustered separated them cleanly: words describing SOUND clustered,
 * words describing ASSOCIATION (`nostalgic`, `cinematic`, `raw`, `lush`) spanned
 * everything. That split is linguistic, not local — association words behave the
 * same way in any collection — so this vocabulary excludes them on principle
 * rather than on measurement.
 *
 * The organising frame is Russell's circumplex: arousal (energy) against
 * valence, the standard model in music-emotion work. Terms are laid across those
 * quadrants and then differentiated by timbre — intensity, acousticness and
 * density — which is what separates a string quartet from a doom riff when both
 * are slow, dark and heavy-hearted.
 */

import type { TempoFeel, VocalKind } from "./moodspace.js";

/** Where a term sits. Axes match MoodPoint; all 0-100. */
export interface TermAnchor {
  energy: number;
  valence: number;
  intensity: number;
  acousticness: number;
  density: number;
  /** Prose the labeller sees, so the anchor is not the only guidance. */
  gloss: string;
}

/**
 * Anchors are the definition of each term, not a summary of one library's usage.
 * Grouped by circumplex quadrant, then by timbre within it.
 */
export const MOOD_ANCHORS: Record<string, TermAnchor> = {
  // ── low arousal, positive valence: calm, warm, at ease ──────────────────
  serene:      { energy: 12, valence: 62, intensity: 10, acousticness: 85, density: 20, gloss: "still and untroubled; space around every sound" },
  tender:      { energy: 20, valence: 58, intensity: 14, acousticness: 78, density: 25, gloss: "soft and close, handled carefully" },
  gentle:      { energy: 22, valence: 56, intensity: 15, acousticness: 76, density: 26, gloss: "unhurried and mild, nothing forced" },
  warm:        { energy: 32, valence: 66, intensity: 25, acousticness: 68, density: 40, gloss: "rounded and comfortable; low-end without weight" },
  mellow:      { energy: 30, valence: 60, intensity: 20, acousticness: 62, density: 35, gloss: "relaxed and smooth-edged" },
  pastoral:    { energy: 20, valence: 58, intensity: 15, acousticness: 90, density: 22, gloss: "open, rural, acoustic; air and daylight" },
  intimate:    { energy: 22, valence: 50, intensity: 15, acousticness: 80, density: 20, gloss: "small-room close; you hear the performer breathe" },
  hushed:      { energy: 16, valence: 48, intensity: 12, acousticness: 78, density: 18, gloss: "deliberately quiet, held back" },
  dreamy:      { energy: 28, valence: 58, intensity: 20, acousticness: 45, density: 50, gloss: "blurred and reverberant, edges softened" },

  // ── low arousal, negative valence: sad, heavy-hearted, still ────────────
  melancholy:  { energy: 26, valence: 26, intensity: 22, acousticness: 62, density: 35, gloss: "settled sadness, not acute" },
  mournful:    { energy: 20, valence: 18, intensity: 20, acousticness: 70, density: 30, gloss: "grieving; weight without volume" },
  lonesome:    { energy: 24, valence: 28, intensity: 18, acousticness: 82, density: 20, gloss: "solitary and spare, often a single voice" },
  bleak:       { energy: 20, valence: 12, intensity: 28, acousticness: 45, density: 32, gloss: "cold and without consolation" },
  weary:       { energy: 22, valence: 32, intensity: 20, acousticness: 58, density: 32, gloss: "worn down, dragging slightly" },
  wistful:     { energy: 30, valence: 40, intensity: 22, acousticness: 65, density: 35, gloss: "longing, gently unresolved" },

  // ── mid arousal, positive valence: bright, moving, good-natured ─────────
  sunny:       { energy: 48, valence: 80, intensity: 30, acousticness: 58, density: 45, gloss: "bright and uncomplicated" },
  sweet:       { energy: 36, valence: 76, intensity: 20, acousticness: 70, density: 35, gloss: "affectionate and light" },
  playful:     { energy: 52, valence: 78, intensity: 30, acousticness: 55, density: 45, gloss: "bouncing, unserious" },
  breezy:      { energy: 44, valence: 72, intensity: 28, acousticness: 58, density: 40, gloss: "easy forward motion, no effort showing" },
  groovy:      { energy: 55, valence: 68, intensity: 35, acousticness: 45, density: 52, gloss: "pocket-led; the rhythm section is the point" },
  funky:       { energy: 60, valence: 70, intensity: 42, acousticness: 45, density: 58, gloss: "syncopated and physical" },
  swinging:    { energy: 50, valence: 74, intensity: 32, acousticness: 78, density: 48, gloss: "lilting triplet feel, live-band warmth" },
  jaunty:      { energy: 48, valence: 74, intensity: 30, acousticness: 72, density: 42, gloss: "chipper and stepping along" },

  // ── mid arousal, negative valence: unsettled, dark but not violent ──────
  moody:       { energy: 40, valence: 34, intensity: 40, acousticness: 40, density: 45, gloss: "overcast; withholding" },
  brooding:    { energy: 38, valence: 26, intensity: 45, acousticness: 40, density: 45, gloss: "gathering, something held down" },
  tense:       { energy: 52, valence: 30, intensity: 55, acousticness: 35, density: 50, gloss: "wound tight, unresolved" },
  restless:    { energy: 58, valence: 40, intensity: 50, acousticness: 42, density: 50, gloss: "agitated, unable to settle" },
  smouldering: { energy: 45, valence: 40, intensity: 45, acousticness: 55, density: 45, gloss: "slow-burning heat, held in reserve" },
  defiant:     { energy: 62, valence: 45, intensity: 60, acousticness: 40, density: 60, gloss: "planted and pushing back" },

  // ── high arousal, positive valence: lift, celebration, drive ────────────
  euphoric:    { energy: 84, valence: 86, intensity: 50, acousticness: 18, density: 72, gloss: "peak lift; hands in the air" },
  exuberant:   { energy: 80, valence: 82, intensity: 45, acousticness: 50, density: 65, gloss: "overflowing, unrestrained delight" },
  triumphant:  { energy: 78, valence: 78, intensity: 62, acousticness: 45, density: 78, gloss: "victorious, full-width" },
  anthemic:    { energy: 72, valence: 66, intensity: 58, acousticness: 42, density: 76, gloss: "built to be sung back by a crowd" },
  driving:     { energy: 76, valence: 56, intensity: 60, acousticness: 35, density: 66, gloss: "relentless forward propulsion" },
  danceable:   { energy: 68, valence: 72, intensity: 42, acousticness: 25, density: 60, gloss: "made to move to; steady and physical" },

  // ── high arousal, negative valence: force, threat, fury ─────────────────
  aggressive:  { energy: 85, valence: 30, intensity: 85, acousticness: 25, density: 76, gloss: "attacking; force is the message" },
  furious:     { energy: 92, valence: 24, intensity: 92, acousticness: 28, density: 82, gloss: "flat-out rage at full tilt" },
  menacing:    { energy: 68, valence: 24, intensity: 74, acousticness: 20, density: 64, gloss: "threat held just below the surface" },
  frantic:     { energy: 90, valence: 42, intensity: 70, acousticness: 38, density: 70, gloss: "too fast to hold on to" },
  savage:      { energy: 88, valence: 20, intensity: 90, acousticness: 30, density: 80, gloss: "brutal and unpolished" },

  // ── timbre-led: chosen for HOW it sounds, across the quadrants ──────────
  heavy:       { energy: 72, valence: 34, intensity: 82, acousticness: 32, density: 78, gloss: "downtuned mass; the low end dominates" },
  gritty:      { energy: 62, valence: 42, intensity: 62, acousticness: 45, density: 55, gloss: "dirt on the signal; unsmoothed" },
  fuzzy:       { energy: 58, valence: 48, intensity: 58, acousticness: 42, density: 60, gloss: "saturated and woolly-edged" },
  glossy:      { energy: 55, valence: 65, intensity: 40, acousticness: 15, density: 62, gloss: "polished studio sheen" },
  shimmering:  { energy: 45, valence: 66, intensity: 32, acousticness: 30, density: 55, gloss: "bright high-end, glittering" },
  pulsing:     { energy: 60, valence: 55, intensity: 45, acousticness: 12, density: 58, gloss: "steady synthetic throb" },
  cold:        { energy: 50, valence: 32, intensity: 50, acousticness: 15, density: 45, gloss: "clinical, unwarmed by the room" },
  sparse:      { energy: 28, valence: 45, intensity: 22, acousticness: 60, density: 12, gloss: "few elements, lots of silence" },
  lush:        { energy: 45, valence: 60, intensity: 35, acousticness: 55, density: 85, gloss: "many layers, richly filled in" },
  raucous:     { energy: 78, valence: 62, intensity: 68, acousticness: 45, density: 70, gloss: "loud, rowdy, spilling over" },
  hypnotic:    { energy: 45, valence: 48, intensity: 35, acousticness: 30, density: 50, gloss: "repetition that pulls you under" },
  stark:       { energy: 30, valence: 30, intensity: 35, acousticness: 45, density: 15, gloss: "bare and unsoftened" },
};

export const MOOD_VOCABULARY = Object.keys(MOOD_ANCHORS) as MoodTerm[];
export type MoodTerm = string;

const CANON = new Set(Object.keys(MOOD_ANCHORS));

/**
 * Common alternatives folded onto canonical terms.
 *
 * These are language-level equivalences, not one library's habits — `angry` and
 * `furious` name the same region regardless of whose collection it is.
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
 * Returns null when nothing matches — callers drop it rather than inventing a
 * term, which is how an uncontrolled tail grows in the first place.
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
 * Universal vibes — named regions any library will populate.
 *
 * Deliberately functional ("what is this for") rather than personal, so a
 * collection with no curated playlists still has a working taxonomy on first
 * run. `hours` gives a fallback time affinity for installs with no listening
 * history; where history exists, measured lift should override it.
 */
export interface VibeDefinition {
  centre: Omit<TermAnchor, "gloss">;
  radius: number;
  tempo?: TempoFeel[];
  vocal?: VocalKind[];
  hours: number[];
  gloss: string;
}

export const UNIVERSAL_VIBES: Record<string, VibeDefinition> = {
  "wind down":   { centre: { energy: 20, valence: 52, intensity: 14, acousticness: 78, density: 24 }, radius: 26, tempo: ["still", "slow"], hours: [21, 22, 23, 0, 1], gloss: "settling toward sleep" },
  "slow morning":{ centre: { energy: 32, valence: 62, intensity: 22, acousticness: 70, density: 34 }, radius: 26, tempo: ["slow", "mid"], hours: [6, 7, 8, 9], gloss: "easing into the day" },
  "focus":       { centre: { energy: 42, valence: 50, intensity: 28, acousticness: 40, density: 40 }, radius: 24, vocal: ["instrumental"], hours: [9, 10, 11, 14, 15, 16], gloss: "steady, undemanding, stays out of the way" },
  "background":  { centre: { energy: 38, valence: 58, intensity: 25, acousticness: 55, density: 38 }, radius: 28, hours: [11, 12, 13, 14], gloss: "pleasant and unobtrusive" },
  "uplift":      { centre: { energy: 68, valence: 80, intensity: 42, acousticness: 45, density: 58 }, radius: 28, hours: [8, 9, 10, 16, 17], gloss: "a deliberate lift in mood" },
  "workout":     { centre: { energy: 84, valence: 62, intensity: 70, acousticness: 25, density: 72 }, radius: 30, tempo: ["driving", "frantic"], hours: [6, 7, 17, 18, 19], gloss: "sustained physical push" },
  "hype":        { centre: { energy: 86, valence: 70, intensity: 66, acousticness: 18, density: 74 }, radius: 28, hours: [20, 21, 22], gloss: "getting up for something" },
  "driving":     { centre: { energy: 70, valence: 60, intensity: 58, acousticness: 40, density: 62 }, radius: 30, tempo: ["mid", "driving"], hours: [8, 9, 16, 17, 18], gloss: "motion; miles passing" },
  "golden hour": { centre: { energy: 48, valence: 68, intensity: 32, acousticness: 55, density: 46 }, radius: 26, hours: [17, 18, 19], gloss: "warm light, day easing off" },
  "late night":  { centre: { energy: 40, valence: 40, intensity: 38, acousticness: 35, density: 45 }, radius: 28, hours: [23, 0, 1, 2, 3], gloss: "after hours; low light" },
  "melancholy":  { centre: { energy: 28, valence: 24, intensity: 24, acousticness: 65, density: 32 }, radius: 26, hours: [21, 22, 23], gloss: "sitting with something sad" },
  "heavy":       { centre: { energy: 80, valence: 32, intensity: 84, acousticness: 28, density: 78 }, radius: 30, hours: [15, 16, 17, 21, 22], gloss: "loud, dark and physical" },
  "dinner":      { centre: { energy: 40, valence: 66, intensity: 26, acousticness: 68, density: 40 }, radius: 26, hours: [18, 19, 20], gloss: "convivial but not competing with conversation" },
  "party":       { centre: { energy: 80, valence: 82, intensity: 50, acousticness: 20, density: 72 }, radius: 30, hours: [20, 21, 22, 23], gloss: "a room full of people" },
};
