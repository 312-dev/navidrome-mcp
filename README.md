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

## The mood pass

A library's own metadata cannot answer a mood question: genres are a few dozen coarse
buckets, and BPM, ReplayGain and MusicBrainz IDs are present on under 3% of files. So a
one-time enrichment pass places every track in mood-space — **energy, valence, intensity,
acousticness, density, how fast it feels, whether it is sung, two to four vocabulary terms,
and the times of day it fits**. Results are cached permanently, so this runs once and
afterwards only picks up new music.

The vocabulary is **defined, not derived**. Each of its 52 terms carries an explicit anchor
in mood-space, and each of the 14 vibes is a named region with a centre and a radius, so the
same track gets the same coordinates in anyone's library. Deriving the words from one
collection instead would bake that collection's shape into them: a rock-heavy library yields
`riffy` and `bass-heavy`, which say nothing useful about a jazz one.

Words alone cannot carry cohesion, which is why the axes exist. Measured on a real library,
`tender` covered both Debussy's *Suite bergamasque* and Metallica's *Nothing Else Matters* —
both labels correct, and useless as a playlist filter. Distance in mood-space separates them.

Cost stays small through three things: batching ~40 tracks per request, **prompt-caching the
large identical taxonomy prefix** (the first batch runs alone, so the rest hit a warm cache
instead of all missing it concurrently), and running with thinking disabled — this is
classification, not reasoning. Set `ANTHROPIC_API_KEY` to enable it and `MOOD_MODEL` to
trade quality for spend; without a key everything else still works and only the mood
filters go dark.

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
- **`npm run check:vocab`** asserts what typechecking cannot: that every region is
  reachable, every synonym resolves, no region swallows more than 15% of mood-space, and
  the Debussy/Metallica pair still land in different vibes.

## Tools

| Tool | Purpose |
|---|---|
| `describe_library` | Orientation: size, genres, decades, vibe regions, tag vocabulary |
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
