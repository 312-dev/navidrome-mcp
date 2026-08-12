/**
 * Work out what each track's play count should be, from the listen history.
 *
 * Navidrome counts only what Navidrome served. Its `core/scrobbler` is outbound
 * only and `IncPlayCount` is literally `play_count + 1`, so there is no import
 * path: a library that was listened to for years before Navidrome existed shows
 * up in its UI as barely played, and every smart playlist built on play count
 * sees that instead of the truth.
 *
 * This closes that gap in the only direction that is safe. It reads the listen
 * history this server already holds, matches it to tracks with the same key the
 * server uses everywhere else, and writes a plan. Nothing is applied here:
 * `apply-playcounts.py` does that, against the database, on the machine that
 * holds it.
 *
 * Three rules that are not obvious and matter more than the code:
 *
 *   Do not route this through Navidrome's Subsonic `/rest/scrobble` endpoint,
 *   however much more supported that looks. Navidrome forwards a scrobble on to
 *   ListenBrainz and Last.fm, so replaying a decade of history through it would
 *   submit every one of those plays back to the service they came from and
 *   corrupt the history permanently. The database is the only safe target.
 *
 *   The match is on artist and title on purpose, not on an identifier. Almost
 *   no file carries a real MusicBrainz recording id, and where both sides do
 *   carry one they disagree about a third of the time, always as the same song
 *   under a different recording: ListenBrainz resolves a scrobble to its own
 *   canonical recording, which is rarely the pressing on disk. Matching on ids
 *   would be more precise and would credit fewer real plays. The README carries
 *   the measured numbers.
 *
 *   One listen can match several files. A library with a single and an album
 *   copy of the same track has two rows sharing a match key, and the play is
 *   credited to both, because nothing in a scrobble says which file was played.
 *   That inflates the library-wide total while leaving each track's own count
 *   defensible, and the report below counts how often it happens rather than
 *   hiding it.
 *
 * Usage: tsx scripts/plan-playcounts.ts <index.json> [out.json]
 */

import { readFileSync, writeFileSync } from "node:fs";

import { matchKey, primaryArtist } from "../src/listenbrainz.js";

/**
 * The separator between artist and track in a stored listen key.
 *
 * Written as an escape rather than the character itself. A raw NUL in a source
 * file makes grep treat the whole file as binary and skip it silently, so the
 * line becomes invisible to every search that would find it, which is what
 * `npm run check:source` exists to catch.
 */
const SEP = "\u0000";

interface Snapshot {
  version: number;
  songs: { id: string; title?: string; artist?: string }[];
  listenKeys: string[];
  listenKi: number[];
  listenTs: number[];
}

interface Planned {
  id: string;
  title: string;
  artist: string;
  plays: number;
  first: number;
  last: number;
}

function main(): void {
  const [snapshotPath, outPath = "playcounts.json"] = process.argv.slice(2);
  if (!snapshotPath) {
    console.error("usage: tsx scripts/plan-playcounts.ts <index.json> [out.json]");
    process.exit(2);
  }

  const s = JSON.parse(readFileSync(snapshotPath, "utf8")) as Snapshot;
  console.error(
    `snapshot v${s.version}: ${s.songs.length} songs, ${s.listenTs.length} listens`,
  );

  // The stored key is the raw "artist\0track" a scrobble carried. Normalising
  // it here rather than at save time is what lets the matcher change without
  // invalidating a snapshot.
  const keyOf = s.listenKeys.map((raw) => {
    const sep = raw.indexOf(SEP);
    return matchKey(primaryArtist(raw.slice(0, sep)), raw.slice(sep + 1));
  });

  const byKey = new Map<string, { plays: number; first: number; last: number }>();
  for (let i = 0; i < s.listenTs.length; i++) {
    const key = keyOf[s.listenKi[i]!];
    if (key === undefined) continue;
    const ts = s.listenTs[i]!;
    const cur = byKey.get(key);
    if (cur) {
      cur.plays++;
      if (ts < cur.first) cur.first = ts;
      if (ts > cur.last) cur.last = ts;
    } else {
      byKey.set(key, { plays: 1, first: ts, last: ts });
    }
  }

  const tracksByKey = new Map<string, string[]>();
  for (const song of s.songs) {
    const key = matchKey(primaryArtist(String(song.artist ?? "")), String(song.title ?? ""));
    const arr = tracksByKey.get(key);
    if (arr) arr.push(song.id);
    else tracksByKey.set(key, [song.id]);
  }

  const planned: Planned[] = [];
  let shared = 0;
  for (const song of s.songs) {
    const key = matchKey(primaryArtist(String(song.artist ?? "")), String(song.title ?? ""));
    const hit = byKey.get(key);
    if (!hit) continue;
    if ((tracksByKey.get(key)?.length ?? 1) > 1) shared++;
    planned.push({
      id: song.id,
      title: String(song.title ?? ""),
      artist: String(song.artist ?? ""),
      plays: hit.plays,
      first: hit.first,
      last: hit.last,
    });
  }

  // Listens that matched no file at all. Normal and worth seeing: it is mostly
  // music that was listened to elsewhere and never acquired, so a number that
  // suddenly jumps means the matcher broke, not that taste changed.
  let unmatched = 0;
  for (const [key, hit] of byKey) if (!tracksByKey.has(key)) unmatched += hit.plays;

  writeFileSync(outPath, JSON.stringify(planned));
  const total = planned.reduce((a, p) => a + p.plays, 0);
  console.error(
    `matched ${planned.length} tracks, ${total} plays\n` +
      `  ${shared} of those tracks share a match key with another file, so a\n` +
      `  play credited to one is credited to all of them\n` +
      `  ${unmatched} listens matched nothing in the library\n` +
      `wrote ${outPath}`,
  );
}

main();
