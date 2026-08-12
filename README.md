# navidrome-mcp

An MCP server for [Navidrome](https://www.navidrome.org/) that builds playlists which
actually match a described mood, grounded in what you own, what you have listened to,
and how you yourself have labelled your music.

## Why this exists

Navidrome's API alone cannot do this, for three concrete reasons:

1. **Its REST filtering is exact-match only.** `year=1997` works; `year=1990-1999`
   silently returns nothing. There are no ranges and no AND/OR, so a query like
   "90s rock I haven't played in a year, max 2 per artist" is not expressible.
2. **It keeps no listen history.** Only a `playCount` and a *last* `playDate`. There is
   no way to ask "what do I put on at 7am on a Tuesday".
3. **Nothing in the library says how a track *feels*.** Measured on a real 9,311-track
   library: 32 genres with Rock alone covering 47%, BPM present on **24 tracks (0.3%)**,
   ReplayGain on 222 (2%), MusicBrainz recording IDs on 222 (2%). That last number also
   rules out AcousticBrainz as a primary mood source: its audio-derived mood models are
   keyed by MBID, and resolving the rest via ISRC → MusicBrainz (rate-limited to 1 req/s)
   would still only reach ~23% of the library.

So this server maintains its own index and joins three sources:

| Source | Provides |
|---|---|
| Navidrome (native + Subsonic APIs) | Authoritative metadata, similarity agents, the playlist write path |
| ListenBrainz | Timestamped listen history: time-of-day and weekday habits, and the source the play-count backfill below is built from |
| Last.fm | A real descriptive tag vocabulary (`nu-disco`, `melancholy`, `shoegaze`) |

Only the first is required. Listen history, Last.fm tags and your own playlists each improve
ranking and time-of-day fit where they exist, and none of them is load-bearing: the same
query means the same thing in a library that has none of them.

### Listen history has two failure modes worth knowing about

Both were live here until 2026-08-10, and both are silent.

**The history can be a prefix, and used to stay one.** ListenBrainz publishes a rate-limit
budget on every response (`X-RateLimit-Remaining`, `X-RateLimit-Reset-In`; observed 30
requests per 5 seconds). Overrunning it does not return 429. The server stalls responses,
first to seconds and then to tens of seconds, and eventually closes the connection
(`UND_ERR_SOCKET`). The walk then stopped and kept its prefix, which is a perfectly valid
history: nothing distinguishes a quarter of a large account from all of a small one.

What made that permanent rather than merely unlucky is that the walk always restarted from
the newest listen, so every later sync re-fetched what it already had and stopped at the
same wall. The index sat at 32k of 126k for months, including through an explicit full
resync. Requests are now paced against the published budget, a retry waits for the window
to turn over instead of spending what is left of it, and an interrupted walk resumes from
the OLDEST listen held. A sync that still cannot finish leaves the index usable and says
so, and the next start picks the walk up where it stopped.

**One play can arrive twice.** Scrobbling to both Last.fm and ListenBrainz while also
running ListenBrainz's Last.fm importer delivers every play from two submitters. The
timestamps differ, because Last.fm stamps a scrobble when it is submitted and a direct
submitter stamps it at playback start, so nothing that keys on an exact time notices.
Measured here: a median 219 seconds apart, inflating about a quarter of recent listens.
`dedupeListens` collapses a pair only when a *different* submitter reported it, since two
plays close together from the same submitter are what a genuine repeat looks like. The
window and the reasoning are checked by `npm run check:dedupe`.

`LISTENBRAINZ_HISTORY_DAYS` bounds a cold start and defaults to effectively the whole
account. Note that an incremental sync resumes from the newest listen already held, so
listens *backfilled* with older timestamps need `refresh_index` with `full_listens`.

## Where mood comes from

**Not from here.** This server has no LLM client and no way to label a track. Mood is
produced by [`navidrome-mood`](https://github.com/312-dev/navidrome-mood), a Navidrome
plugin that judges each track and writes the values into the audio files as tags. This
server reads those tags and does everything downstream: filtering, cohesion, sequencing,
playlist writing.

The split is deliberate and one-directional. The plugin never calls this server and is
useful without it: its tags drive Navidrome's own smart playlists, and Music Assistant
and every Subsonic client can read them too. This server depends on the plugin only for
mood; install it if you want mood-aware playlists, skip it and everything else still
works.

Keeping a second labelling path here as a fallback would mean maintaining the same
vocabulary in two languages and shipping two answers to one question. There is deliberately
no fallback.

What the plugin writes, per track: **energy, valence, intensity, acousticness, density, how
fast it feels, whether it is sung, two to four vocabulary terms, the times of day it fits,
the vibe regions it falls in, and for a track in none of them, the region it came closest
to**.

That last one is why `mood_vibes_near` exists. Region membership is strict, and about a
third of a library falls outside every region; most of those are ordinary tracks a little
past an edge rather than unusual music between the regions. Setting `mood_vibes_near`
unions them in, which on a 9,195 track library takes the share reachable by region from
65% to 94%. Leave it off when the region's character is the point.

The vocabulary is **defined, not derived**. Each of its 52 terms carries an explicit anchor
in mood-space, and each of the 14 vibes is a named region with a centre and a radius, so the
same track gets the same coordinates in anyone's library. Deriving the words from one
collection instead would bake that collection's shape into them: a rock-heavy library yields
`riffy` and `bass-heavy`, which say nothing useful about a jazz one.

The radii are the one part fitted to a collection rather than defined, and the split is
deliberate. A centre says what a vibe *means* and must not move; a radius says how close
counts as close, which depends on how tightly the music clusters. Fitting them against an
even spread of the coordinate space produced regions wider than the typical gap between any
two tracks in a real library, so they are fitted against a measured distribution instead.
Coordinates therefore travel between libraries unchanged; region membership is calibrated.

Words alone cannot carry cohesion, which is why the axes exist. Measured on a real library,
`tender` covered both Debussy's *Suite bergamasque* and Metallica's *Nothing Else Matters*:
both labels correct, and useless as a playlist filter. Distance in mood-space separates them.

Call `mood_coverage` to see how much of a library is labelled. When the answer is none it
says which of the three causes applies (plugin never run, plugin ran but wrote nothing, or
tags written but not declared in Navidrome's own config file) because those need
different fixes and all three otherwise read as an empty library.

## Backfilling Navidrome's play counts

Navidrome counts only what Navidrome served. Its scrobbler is outbound only and
`IncPlayCount` is `play_count + 1`, so there is no import path: a library
listened to for years before Navidrome existed shows a handful of plays, and
every smart playlist, client sort and `play_count_min` filter reads that
number rather than the real one. On the library this was built against it was
976 plays against a ListenBrainz history of 123,157 listens.

Run it, and that column becomes the count for everything. Ranking, sorting and
the count filters read Navidrome and nothing else; the connector's own listen
total stops being scored beside it, because after a backfill the two describe
the same plays and weighing both counts the same evidence twice. Skip it and
`describe_library` says so, rather than leaving every ordering quietly wrong.

`scripts/` closes the gap. Two steps, because they run in different places:

```sh
tsx scripts/plan-playcounts.ts /data/navidrome-mcp/index.json playcounts.json
python3 scripts/apply-playcounts.py playcounts.json /data/navidrome.db          # dry run
python3 scripts/apply-playcounts.py playcounts.json /data/navidrome.db --write
```

The planner matches the history to tracks with the same key this server uses for
everything else, so a fix to the matcher fixes both at once. The applier is
standard-library Python because it has to run wherever `navidrome.db` is, which
is often a machine with no node; pointing it at a Docker volume works:

```sh
docker run --rm -v <volume>:/data -v "$PWD":/host python:3.12-slim \
  python /host/apply-playcounts.py /host/playcounts.json /data/navidrome.db --write
```

Five things worth knowing before running it:

- **Do not use Navidrome's `/rest/scrobble` endpoint instead**, however much
  more supported it looks. Navidrome forwards a scrobble to ListenBrainz and
  Last.fm, so replaying a decade of history through it submits that history back
  to the service it came from and corrupts it permanently.
- **The write is a floor, not an assignment.** `max(existing, imported)` means
  Navidrome's own counting is never rolled back and a second run changes
  nothing. Only `play_count` and `play_date` are touched; `starred` and `rating`
  share the row and are the user's own judgements.
- **A play can land on more than one file.** Nothing in a scrobble says which
  copy was played, so a library holding both a single and an album version
  credits both. 486 of 7,580 matched tracks were in that position here. Each
  track's own count stays defensible; the library-wide total is inflated.
- **Not every listen matches.** 50,781 of 123,157 matched nothing, which is
  mostly music heard elsewhere and never acquired. The planner reports that
  number every run: a sudden jump means the matcher broke, not that taste
  changed.
- **Matching on identifiers instead is not the safer option it looks like**, and
  is worth understanding before anyone tries to "fix" the fuzzy match. Two
  reasons. Coverage: 222 of 9,200 files here carry a genuine MusicBrainz
  recording id. A further 839 carry a Discogs id in the MusicBrainz-named
  `musicbrainz_trackid` tag, which grades as total disagreement against
  ListenBrainz and means nothing. Semantics: even where both sides hold real
  ids, they disagree about a third of the time, and the sampled disagreements
  are all the same song under a different recording, never a different song.
  ListenBrainz maps a scrobble to its own canonical recording, which is rarely
  the exact pressing on disk. An id join would therefore reject plays this one
  correctly credits. It would be more precise and match less.

## Design notes

- **In-memory index, no database.** A full library pull is ~20s for ~10k tracks; once
  local, every compound query is a single array pass. A JSON snapshot on disk makes
  restarts instant. Deliberately no native dependency, so it installs under
  `npm ci --ignore-scripts` on Node 20.
- **The index is a cache, never a source of truth.** If the snapshot is missing or
  unreadable the server just re-syncs.
- **Navidrome's own compound engine is still exposed** via `create_smart_playlist`, for
  standing playlists that should keep re-evaluating server-side. Note those rules can
  only see Navidrome's own fields, not ListenBrainz listens or Last.fm tags.
- **`npm run check:vocab`** asserts what typechecking cannot about this side's copy of the
  vocabulary: every synonym resolves and is reachable, no term or region name contains a
  character Navidrome splits tag values on, and every hour of the day is claimed by some
  region. The anchors and region geometry live in the plugin and are asserted there.

## Tools

| Tool | Purpose |
|---|---|
| `describe_library` | Orientation: size, genres, decades, vibe regions, tag vocabulary |
| `mood_coverage` | How much of the library is labelled, and what to fix when none of it is |
| `search_tracks` | The workhorse: full compound filtering, diversity caps, affinity ranking |
| `get_vibe_profile` | What a vibe actually consists of in *this* library, and how tightly it clusters |
| `similar_tracks` | Expand from seeds via agents + playlist co-occurrence |
| `listening_history` | recent / top / by_hour / by_weekday / rediscover / trending |
| `list_playlists`, `get_playlist` | Read playlists |
| `create_playlist`, `update_playlist`, `delete_playlist` | Write playlists |
| `create_smart_playlist` | Self-updating rules-based playlists |
| `now_context` | What suits right now: the hour, which vibes fit it, what dominates it, what was just heard |
| `commit_playlist` | Publish one revision of a rolling playlist, by title |
| `refresh_index` | Re-sync from Navidrome / ListenBrainz |

Prompt: **`daylist`** - refreshes the `daylist` playlist for the current hour.

### Rolling playlists

A rolling playlist is one that gets rewritten on a schedule: `daylist` hourly, `mix: chill`
and the rest whenever they are asked for. **Its title is fixed for its whole life and the
phrase that changes goes in the description**, which is what `commit_playlist` enforces: it
matches on the title, never renames what it finds, and creates a playlist only when no
playlist carries that title yet. A generator that renamed its own output instead would lose
track of it and make a new one on the next run, and nobody notices that until the sidebar
holds forty near-identical lists.

`search_tracks`'s `exclude_recent_runs` keeps a rolling playlist off its own recent tracks.
It is scoped to one playlist, so the hourly daylist moving fast does not starve the others.

## Configuration

| Env var | Required | Notes |
|---|---|---|
| `NAVIDROME_URL` | yes | e.g. `http://host:4533` |
| `NAVIDROME_USERNAME` / `NAVIDROME_PASSWORD` | yes | Playlists are created as this user |
| `NAVIDROME_PROXY` | no | `socks5://host:port` if Navidrome is only reachable via a proxy hop |
| `LISTENBRAINZ_USER` | no | Listen history is a **public** read; no token needed |
| `LASTFM_API_KEY` | no | Defaults to Navidrome's bundled public key |
| `NAVIDROME_TZ` | no | Default `America/Chicago`. Time-of-day analysis depends on this |
| `NAVIDROME_DATA_DIR` | no | Snapshot location. Default `/data/navidrome-mcp` |
| `NAVIDROME_ENRICH` | no | `0` disables background Last.fm tag fetching |

## Licence

MIT
