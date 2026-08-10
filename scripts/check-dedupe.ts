/**
 * Regression checks on cross-submitter listen deduplication.
 *
 * Scrobbling to both Last.fm and ListenBrainz, then also running ListenBrainz's
 * Last.fm importer, delivers every play twice with timestamps minutes apart.
 * dedupeListens collapses those, and it is the only place in this server that
 * DELETES history rather than deriving from it, so the interesting checks are
 * the ones proving it stays narrow.
 *
 * The failure to guard against is not "duplicates survive". It is a window wide
 * enough to also swallow a track genuinely played twice in a row, which looks
 * identical apart from the submitter. Run with `npm run check:dedupe`.
 */
import { DUPLICATE_WINDOW_SEC, dedupeListens, type Listen } from "../src/listenbrainz.js";

const failures: string[] = [];
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${msg}`);
  if (!ok) failures.push(msg);
};

const T = 1_700_000_000;
const listen = (ts: number, client: string | undefined, track = "Redbone", artist = "Childish Gambino"): Listen => ({
  ts,
  artist,
  track,
  client,
});

// ── 1. the case this exists for ───────────────────────────────────────────────
// Measured median offset on the real account is 219s: the Last.fm importer
// stamps at submission, a direct submitter stamps at playback start.
{
  const { kept, dropped } = dedupeListens([
    listen(T, "listenbrainz"),
    listen(T + 219, "ListenBrainz lastfm importer v2"),
  ]);
  check(dropped === 1 && kept.length === 1, "two submitters reporting one play collapse to one");
  check(kept[0]?.ts === T, "the EARLIER timestamp survives, being the one that means playback start");
  check(kept[0]?.client === "listenbrainz", "the surviving row keeps its own submitter");
}

// ── 2. what must NOT be collapsed ─────────────────────────────────────────────
// On the measured sample this split was 984 cross-submitter against 38
// same-submitter. Treating closeness alone as proof would have deleted the 38.
{
  const { kept, dropped } = dedupeListens([
    listen(T, "listenbrainz"),
    listen(T + 219, "listenbrainz"),
  ]);
  check(dropped === 0 && kept.length === 2, "one submitter reporting twice is a real repeat, kept");
}
{
  const { dropped } = dedupeListens([
    listen(T, "listenbrainz"),
    listen(T + DUPLICATE_WINDOW_SEC + 1, "ListenBrainz lastfm importer v2"),
  ]);
  check(dropped === 0, "two submitters outside the window are two plays, kept");
}
{
  const { dropped } = dedupeListens([
    listen(T, undefined),
    listen(T + 219, "ListenBrainz lastfm importer v2"),
  ]);
  check(dropped === 0, "an unknown submitter is never treated as a duplicate of anything");
}
{
  const { dropped } = dedupeListens([
    listen(T, "listenbrainz"),
    listen(T + 10, "ListenBrainz lastfm importer v2", "Sober"),
  ]);
  check(dropped === 0, "different tracks at the same moment never collapse");
}
{
  const { dropped } = dedupeListens([
    listen(T, "listenbrainz"),
    listen(T + 10, "ListenBrainz lastfm importer v2", "Redbone", "Bon Iver"),
  ]);
  check(dropped === 0, "same title by a different artist never collapses");
}

// ── 3. the window matches what was measured ───────────────────────────────────
// p90 of the observed cross-submitter offset was 306s. A window under that
// leaves a tenth of the duplicates in place; far over it starts reaching into
// plausible back-to-back replays.
check(
  DUPLICATE_WINDOW_SEC >= 306 && DUPLICATE_WINDOW_SEC <= 420,
  `window ${DUPLICATE_WINDOW_SEC}s covers the measured p90 of 306s without reaching a replay`,
);

// ── 4. properties the sync loop depends on ────────────────────────────────────
// syncListens runs this over the WHOLE history on every tick, so a second pass
// must be a no-op or the history would erode one sync at a time.
{
  const raw: Listen[] = [
    listen(T, "listenbrainz"),
    listen(T + 219, "ListenBrainz lastfm importer v2"),
    listen(T + 5000, "listenbrainz"),
    listen(T + 5180, "ListenBrainz lastfm importer v2"),
  ];
  const first = dedupeListens(raw);
  const second = dedupeListens(first.kept);
  check(first.dropped === 2 && first.kept.length === 2, "a session of two doubled plays reduces to two");
  check(second.dropped === 0, "running again drops nothing: the pass is idempotent");
  check(
    JSON.stringify(first.kept) === JSON.stringify(second.kept),
    "a second pass returns an identical history",
  );
}
{
  // The caller assigns listensSyncedAt from the LAST element, so order matters.
  const { kept } = dedupeListens([
    listen(T + 5000, "listenbrainz"),
    listen(T, "listenbrainz"),
    listen(T + 900, "listenbrainz"),
  ]);
  const ascending = kept.every((l, i) => i === 0 || kept[i - 1]!.ts <= l.ts);
  check(ascending, "output is sorted oldest first, which listensSyncedAt relies on");
}
{
  const { kept, dropped } = dedupeListens([]);
  check(kept.length === 0 && dropped === 0, "an empty history is handled");
}

// ── 5. a real repeat surrounded by duplicates ─────────────────────────────────
// The hard case: played twice about ten minutes apart, each play reported by
// both submitters. Two must survive, not one and not four.
{
  const { kept } = dedupeListens([
    listen(T, "listenbrainz"),
    listen(T + 200, "ListenBrainz lastfm importer v2"),
    listen(T + 600, "listenbrainz"),
    listen(T + 800, "ListenBrainz lastfm importer v2"),
  ]);
  check(kept.length === 2, "two doubled plays of the same track ten minutes apart stay two plays");
  check(
    kept[0]?.ts === T && kept[1]?.ts === T + 600,
    "and both survivors are the playback-start timestamps",
  );
}

console.log(`\nwindow ${DUPLICATE_WINDOW_SEC}s`);
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("all checks passed.");
