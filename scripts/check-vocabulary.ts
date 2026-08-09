/**
 * Regression checks on this server's copy of the vocabulary.
 *
 * The vocabulary is DEFINED in the navidrome-mood plugin, which owns the anchors
 * and the region geometry and asserts those on its own side. What lives here is a
 * consumer's subset -- the term list, the synonyms that fold user input, and each
 * region's time-of-day affinity -- and it can drift from the plugin without
 * anything failing to compile.
 *
 * Every failure below is silent in production: a synonym pointing at a renamed
 * term simply stops folding, and a region name the plugin never writes simply
 * reports zero tracks forever. Run with `npm run check:vocab`.
 */
import { MOOD_VOCABULARY, SYNONYMS, VIBE_SCHEDULE, canonicalise } from "../src/vocabulary.js";
import { TAGS } from "../src/moodtags.js";

const failures: string[] = [];
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${msg}`);
  if (!ok) failures.push(msg);
};

// ── 1. terms survive a round trip through Navidrome ───────────────────────────
// Navidrome splits every tag value on these, declared for `mood` in
// resources/mappings.yaml. A term containing one would fragment across the whole
// library and still look like it worked.
const SEPARATORS = ",;/";
const unsafe = MOOD_VOCABULARY.filter((t) => [...SEPARATORS].some((c) => t.includes(c)));
check(!unsafe.length, `no term contains a tag separator ${JSON.stringify(SEPARATORS)} (${unsafe.join(", ") || "none"})`);

const malformed = MOOD_VOCABULARY.filter((t) => t !== t.trim().toLowerCase() || !t);
check(!malformed.length, `every term is lowercase and trimmed (${malformed.join(", ") || "none"})`);

const dupes = MOOD_VOCABULARY.filter((t, i) => MOOD_VOCABULARY.indexOf(t) !== i);
check(!dupes.length, `no duplicate terms (${dupes.join(", ") || "none"})`);

// ── 2. synonyms resolve, and can actually be reached ──────────────────────────
const vocab = new Set<string>(MOOD_VOCABULARY);
const dangling = Object.entries(SYNONYMS).filter(([, to]) => !vocab.has(to));
check(!dangling.length, `every synonym resolves to a term (${dangling.map(([k, v]) => `${k}->${v}`).join(", ") || "none"})`);

const shadowed = Object.keys(SYNONYMS).filter((k) => vocab.has(k));
check(!shadowed.length, `no synonym shadows a real term (${shadowed.join(", ") || "none"})`);

// canonicalise lowercases and trims before lookup, so a key not already in that
// form can never match and is dead weight that still reads as configured.
const unreachable = Object.keys(SYNONYMS).filter((k) => k !== k.trim().toLowerCase());
check(!unreachable.length, `every synonym key is reachable by canonicalise (${unreachable.join(", ") || "none"})`);

check(canonicalise("chill") === "mellow", "canonicalise folds a synonym ('chill' -> 'mellow')");
check(canonicalise("banana") === null, "canonicalise rejects an unknown word rather than inventing one");

// ── 3. the region table matches what a tag can carry ──────────────────────────
const regions = Object.entries(VIBE_SCHEDULE);
const badHours = regions.filter(([, d]) => !d.hours.length || d.hours.some((h) => h < 0 || h > 23));
check(!badHours.length, `every region has hours in 0-23 (${badHours.map(([v]) => v).join(", ") || "none"})`);

const noGloss = regions.filter(([, d]) => !d.gloss.trim());
check(!noGloss.length, `every region has a gloss (${noGloss.map(([v]) => v).join(", ") || "none"})`);

const regionUnsafe = regions.filter(([v]) => [...SEPARATORS].some((c) => v.includes(c)));
check(!regionUnsafe.length, `no region name contains a tag separator (${regionUnsafe.map(([v]) => v).join(", ") || "none"})`);

// Every hour of the day must have somewhere to go, or the daylist has nothing to
// suggest at that hour on a library with no listen history.
const uncovered = Array.from({ length: 24 }, (_, h) => h).filter(
  (h) => !regions.some(([, d]) => d.hours.includes(h)),
);
check(!uncovered.length, `every hour is claimed by some region (uncovered: ${uncovered.join(", ") || "none"})`);

// ── 4. tag names are distinct ─────────────────────────────────────────────────
// These are a contract with a separate repository. Two fields reading the same
// tag would silently make one of them a copy of the other.
const names = Object.values(TAGS);
check(new Set(names).size === names.length, `every tag name is distinct (${names.length} tags)`);

console.log(
  `\n${MOOD_VOCABULARY.length} terms, ${Object.keys(SYNONYMS).length} synonyms, ${regions.length} regions`,
);
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("all checks passed.");
