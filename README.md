# navidrome-mcp

An MCP server for [Navidrome](https://www.navidrome.org/) that builds playlists which
actually match a described mood — grounded in what you own, what you have listened to,
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
   rules out AcousticBrainz as a primary mood source — its audio-derived mood models are
   keyed by MBID, and resolving the rest via ISRC → MusicBrainz (rate-limited to 1 req/s)
   would still only reach ~23% of the library.

So this server maintains its own index and joins three sources:

| Source | Provides |
|---|---|
| Navidrome (native + Subsonic APIs) | Authoritative metadata, similarity agents, the playlist write path |
| ListenBrainz | Timestamped listen history — time-of-day and weekday habits |
| Last.fm | A real descriptive tag vocabulary (`nu-disco`, `melancholy`, `shoegaze`) |

Only the first is required. Listen history, Last.fm tags and your own playlists each improve
ranking and time-of-day fit where they exist, and none of them is load-bearing — the same
query means the same thing in a library that has none of them.

## Where mood comes from

**Not from here.** This server has no LLM client and no way to label a track. Mood is
produced by [`navidrome-mood`](https://github.com/312-dev/navidrome-mood), a Navidrome
plugin that judges each track and writes the values into the audio files as tags. This
server reads those tags and does everything downstream: filtering, cohesion, sequencing,
playlist writing.

The split is deliberate and one-directional. The plugin never calls this server and is
useful without it — its tags drive Navidrome's own smart playlists, and Music Assistant
and every Subsonic client can read them too. This server depends on the plugin only for
mood; install it if you want mood-aware playlists, skip it and everything else still
works.

Keeping a second labelling path here as a fallback would mean maintaining the same
vocabulary in two languages and shipping two answers to one question. There is deliberately
no fallback.

What the plugin writes, per track: **energy, valence, intensity, acousticness, density, how
fast it feels, whether it is sung, two to four vocabulary terms, the times of day it fits,
and the vibe regions it falls in**.

The vocabulary is **defined, not derived**. Each of its 52 terms carries an explicit anchor
in mood-space, and each of the 14 vibes is a named region with a centre and a radius, so the
same track gets the same coordinates in anyone's library. Deriving the words from one
collection instead would bake that collection's shape into them: a rock-heavy library yields
`riffy` and `bass-heavy`, which say nothing useful about a jazz one.

Words alone cannot carry cohesion, which is why the axes exist. Measured on a real library,
`tender` covered both Debussy's *Suite bergamasque* and Metallica's *Nothing Else Matters* —
both labels correct, and useless as a playlist filter. Distance in mood-space separates them.

Call `mood_coverage` to see how much of a library is labelled. When the answer is none it
says which of the three causes applies — plugin never run, plugin ran but wrote nothing, or
tags written but not registered in Navidrome's `mappings.yaml` — because those need
different fixes and all three otherwise read as an empty library.

## Design notes

- **In-memory index, no database.** A full library pull is ~20s for ~10k tracks; once
  local, every compound query is a single array pass. A JSON snapshot on disk makes
  restarts instant. Deliberately no native dependency, so it installs under
  `npm ci --ignore-scripts` on Node 20.
- **The index is a cache, never a source of truth.** If the snapshot is missing or
  unreadable the server just re-syncs.
- **Navidrome's own compound engine is still exposed** via `create_smart_playlist`, for
  standing playlists that should keep re-evaluating server-side. Note those rules can
  only see Navidrome's own fields — not ListenBrainz listens or Last.fm tags.
- **`npm run check:vocab`** asserts what typechecking cannot about this side's copy of the
  vocabulary: every synonym resolves and is reachable, no term or region name contains a
  character Navidrome splits tag values on, and every hour of the day is claimed by some
  region. The anchors and region geometry live in the plugin and are asserted there.

## Tools

| Tool | Purpose |
|---|---|
| `describe_library` | Orientation: size, genres, decades, vibe regions, tag vocabulary |
| `mood_coverage` | How much of the library is labelled, and what to fix when none of it is |
| `search_tracks` | The workhorse — full compound filtering, diversity caps, affinity ranking |
| `get_vibe_profile` | What a vibe actually consists of in *this* library, and how tightly it clusters |
| `similar_tracks` | Expand from seeds via agents + playlist co-occurrence |
| `listening_history` | recent / top / by_hour / by_weekday / rediscover / trending |
| `list_playlists`, `get_playlist` | Read playlists |
| `create_playlist`, `update_playlist`, `delete_playlist` | Write playlists |
| `create_smart_playlist` | Self-updating rules-based playlists |
| `daylist_context` | Everything needed to generate this hour's daylist |
| `commit_daylist` | Publish the rolling daylist atomically |
| `refresh_index` | Re-sync from Navidrome / ListenBrainz |

Prompt: **`daylist`** — generates a Spotify-style daylist for the current hour.

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
| `DAYLIST_PLAYLIST_NAME` | no | Default `daylist` |
| `NAVIDROME_ENRICH` | no | `0` disables background Last.fm tag fetching |

## Licence

MIT
