/**
 * Reading mood back out of Navidrome's tags.
 *
 * This is the entire seam between the two halves. The `navidrome-mood` plugin
 * writes these tags into the audio files; Navidrome indexes them; this server
 * reads them and never writes one. Everything downstream -- cohesion, vibe
 * filters, sequencing, the daylist -- is built on what this function returns.
 *
 * Tags are the right carrier rather than a private cache: they survive this
 * server being redeployed or deleted, and Music Assistant, Navidrome's own smart
 * playlists and every Subsonic client can read the same values. The cost is that
 * the numeric ones must be declared under `Tags` in Navidrome's own config file,
 * with `Type = "int"`, before they are queryable server-side, which the plugin
 * documents.
 */

import {
  TEMPO_FEELS,
  VOCAL_KINDS,
  type Mood,
  type TempoFeel,
  type VocalKind,
} from "./moodspace.js";
import { canonicalise } from "./vocabulary.js";

/**
 * The tag names the plugin writes, lowercased as Navidrome reports them.
 *
 * Changing any of these is a breaking change across two repositories, so they
 * are named once, here, rather than spelled out at each use.
 *
 * The axes deliberately sit under `ndmood_` rather than sharing the `mood`
 * prefix. Navidrome's REST filter on `tag_name` has no custom mapping and falls
 * through to a starts-with default, so the UI's Mood dropdown, which passes
 * `tag_name: 'mood'`, matched every axis tag too and buried the 52 mood words
 * under a few hundred numbers. Song-level field filters are exact, so this
 * changes identifiers only, not query behaviour.
 */
export const TAGS = {
  moods: "mood",
  energy: "ndmood_energy",
  valence: "ndmood_valence",
  intensity: "ndmood_intensity",
  acousticness: "ndmood_acousticness",
  density: "ndmood_density",
  tempo: "ndmood_tempo",
  vocal: "ndmood_vocal",
  times: "ndmood_time",
  vibes: "vibe",
} as const;

/** Every tag this server reads, for a coverage report. */
export const MOOD_TAG_NAMES: string[] = Object.values(TAGS);

type TagMap = Record<string, string[]> | undefined;

function first(tags: TagMap, name: string): string | undefined {
  const v = tags?.[name];
  return v && v.length ? v[0] : undefined;
}

/**
 * Parse an axis, rejecting anything outside 0-100.
 *
 * Returns null rather than clamping. A value of 240 means the writer and the
 * reader disagree about something, and clamping it to 100 would bury that under
 * a plausible-looking number.
 */
function axis(tags: TagMap, name: string): number | null {
  const raw = first(tags, name);
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n);
}

function oneOf<T extends string>(tags: TagMap, name: string, allowed: readonly T[]): T | null {
  const raw = first(tags, name)?.trim().toLowerCase();
  return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

/**
 * Build a Mood from a track's tags, or null if it is not fully labelled.
 *
 * All-or-nothing on the five axes plus tempo and vocal, because a partial point
 * cannot be measured against another one: `moodDistance` would silently treat a
 * missing axis as zero and report two tracks as far apart on the strength of a
 * tag that was never written. A half-labelled track is better treated as
 * unlabelled, which every filter already handles.
 *
 * `moods`, `times` and `vibes` are allowed to be empty -- they are descriptive,
 * and nothing computes a distance from them.
 */
export function moodFromTags(tags: TagMap): Mood | null {
  if (!tags) return null;
  const energy = axis(tags, TAGS.energy);
  const valence = axis(tags, TAGS.valence);
  const intensity = axis(tags, TAGS.intensity);
  const acousticness = axis(tags, TAGS.acousticness);
  const density = axis(tags, TAGS.density);
  const tempoFeel = oneOf<TempoFeel>(tags, TAGS.tempo, TEMPO_FEELS);
  const vocal = oneOf<VocalKind>(tags, TAGS.vocal, VOCAL_KINDS);
  if (
    energy === null || valence === null || intensity === null ||
    acousticness === null || density === null || tempoFeel === null || vocal === null
  ) {
    return null;
  }
  // Fold descriptors on the way in. The plugin writes canonical terms, but a
  // library can also carry MOOD tags from a tagger that knew nothing about this
  // vocabulary, and folding those is free.
  const moods: string[] = [];
  for (const raw of tags[TAGS.moods] ?? []) {
    const c = canonicalise(raw);
    if (c && !moods.includes(c)) moods.push(c);
  }
  return {
    energy,
    valence,
    intensity,
    acousticness,
    density,
    tempoFeel,
    vocal,
    moods,
    times: (tags[TAGS.times] ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
    vibes: (tags[TAGS.vibes] ?? []).map((v) => v.trim().toLowerCase()).filter(Boolean),
  };
}

/**
 * Why a library has no moods, phrased for whoever has to fix it.
 *
 * The three cases are genuinely different and lead to different actions, and
 * conflating them into "no results" is what makes a working query look broken.
 */
export function moodDiagnosis(total: number, labelled: number, anyMoodTag: boolean): string {
  if (labelled > 0) return `${labelled} of ${total} tracks are mood-labelled.`;
  if (!anyMoodTag) {
    return (
      "No mood tags exist in this library, so every mood filter will match nothing. " +
      "Mood data comes from the navidrome-mood plugin, which labels tracks and writes " +
      "the tags into the audio files; this server only reads them. Install and run it, " +
      "then call refresh_index."
    );
  }
  return (
    "Mood tags are present but none parsed into a complete label. The numeric axes " +
    `(${TAGS.energy}, ${TAGS.valence}, ${TAGS.intensity}, ${TAGS.acousticness}, ` +
    `${TAGS.density}) plus ${TAGS.tempo} and ${TAGS.vocal} are all required. The usual ` +
    "cause is that these tags are not declared under `Tags` in Navidrome's own config " +
    "file (not `mappings.yaml`, which is embedded in the binary and cannot be edited), " +
    "so the scanner drops them and only the built-in MOOD words survive."
  );
}
