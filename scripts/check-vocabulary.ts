/**
 * Regression checks on the vocabulary and the vibe regions.
 *
 * These exist because every failure they catch typechecks cleanly. A region no
 * track can reach, a synonym pointing at a term that was renamed, or a radius
 * loose enough that a "vibe" matches a third of the library are all silent: the
 * server starts, the tool returns, the answer is just wrong. Run with
 * `npm run check:vocab`.
 */
import {
  MOOD_ANCHORS,
  MOOD_VOCABULARY,
  SYNONYMS,
  UNIVERSAL_VIBES,
  canonicalise,
  vibesFor,
} from "../src/vocabulary.js";
import { TEMPO_FEELS, VOCAL_KINDS, type MoodAxes, type MoodPoint } from "../src/moodspace.js";

const failures: string[] = [];
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${msg}`);
  if (!ok) failures.push(msg);
};

// ── 1. every term reaches at least one region, every region at least one term ──
// An anchor has no tempo or vocal of its own, so probe every combination: that
// is the set of regions a real track carrying this term could land in.
const reach = new Map<string, string[]>(Object.keys(UNIVERSAL_VIBES).map((v) => [v, []]));
const orphans: string[] = [];
for (const [term, a] of Object.entries(MOOD_ANCHORS)) {
  const hits = new Set<string>();
  for (const tempoFeel of TEMPO_FEELS) {
    for (const vocal of VOCAL_KINDS) {
      for (const m of vibesFor({ ...a, tempoFeel, vocal, moods: [term] }, 99)) hits.add(m.vibe);
    }
  }
  if (!hits.size) orphans.push(term);
  for (const h of hits) reach.get(h)!.push(term);
}
const emptyRegions = [...reach].filter(([, t]) => !t.length).map(([v]) => v);
check(!emptyRegions.length, `every region is reachable (empty: ${emptyRegions.join(", ") || "none"})`);
check(!orphans.length, `every term lands in a region (orphans: ${orphans.join(", ") || "none"})`);

// ── 2. synonyms resolve ───────────────────────────────────────────────────────
const dangling = Object.entries(SYNONYMS).filter(([, target]) => !(target in MOOD_ANCHORS));
check(!dangling.length, `every synonym resolves (dangling: ${dangling.map(([k, v]) => `${k}->${v}`).join(", ") || "none"})`);
check(canonicalise("chill") === "mellow", "canonicalise folds a synonym ('chill' -> 'mellow')");
check(canonicalise("banana") === null, "canonicalise rejects an unknown word rather than inventing one");

// ── 3. regions are filters, not thirds of the library ─────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(7);
const N = 20000;
const sample: MoodPoint[] = Array.from({ length: N }, () => ({
  energy: rnd() * 100,
  valence: rnd() * 100,
  intensity: rnd() * 100,
  acousticness: rnd() * 100,
  density: rnd() * 100,
  tempoFeel: TEMPO_FEELS[Math.floor(rnd() * TEMPO_FEELS.length)]!,
  vocal: VOCAL_KINDS[Math.floor(rnd() * VOCAL_KINDS.length)]!,
  moods: [],
}));
const counts = sample.map((p) => vibesFor(p, 99).length);
const mean = counts.reduce((a, b) => a + b, 0) / N;
check(mean > 0.2 && mean < 1.5, `a random point lands in ${mean.toFixed(2)} regions (want 0.2-1.5)`);

const widest = Object.keys(UNIVERSAL_VIBES)
  .map((v) => ({ v, share: sample.filter((p) => vibesFor(p, 99).some((m) => m.vibe === v)).length / N }))
  .sort((a, b) => b.share - a.share)[0]!;
check(widest.share < 0.15, `widest region is ${widest.v} at ${(widest.share * 100).toFixed(1)}% of mood-space (want <15%)`);

// ── 4. the v1 failure, as a test ──────────────────────────────────────────────
// Both of these are legitimately "tender". v1 labelled them identically and a
// tender playlist put them next to each other. They must not share a vibe.
const debussy: MoodPoint = { energy: 10, valence: 55, intensity: 8, acousticness: 95, density: 15, tempoFeel: "still", vocal: "instrumental", moods: ["tender"] };
const metallica: MoodPoint = { energy: 45, valence: 40, intensity: 55, acousticness: 60, density: 65, tempoFeel: "slow", vocal: "sung", moods: ["tender"] };
const shared = vibesFor(debussy).filter((a) => vibesFor(metallica).some((b) => b.vibe === a.vibe));
check(
  !shared.length,
  `Debussy and Metallica share no vibe despite both being 'tender' (shared: ${shared.map((s) => s.vibe).join(", ") || "none"})`,
);

// ── 5. an affect-named region actually holds that affect ──────────────────────
for (const [vibe, def] of Object.entries(UNIVERSAL_VIBES)) {
  if (!def.valence) continue;
  const members = Object.entries(MOOD_ANCHORS).filter(([, a]) =>
    vibesFor({ ...(a as MoodAxes), tempoFeel: "mid", vocal: "sung", moods: [] }, 99).some((m) => m.vibe === vibe),
  );
  const strays = members.filter(([, a]) => a.valence < def.valence![0] || a.valence > def.valence![1]);
  check(!strays.length, `"${vibe}" holds only V${def.valence[0]}-${def.valence[1]} terms (${members.length} of them)`);
}

console.log(
  `\n${MOOD_VOCABULARY.length} terms, ${Object.keys(SYNONYMS).length} synonyms, ${Object.keys(UNIVERSAL_VIBES).length} regions`,
);
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("all checks passed.");
