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
3. **Library genre tags are far too coarse for mood.** A typical library has a few dozen
   genres with one of them covering half the tracks, and no mood/style tags at all.

So this server maintains its own index and joins three sources:

| Source | Provides |
|---|---|
| Navidrome (native + Subsonic APIs) | Authoritative metadata, similarity agents, the playlist write path |
| ListenBrainz | Timestamped listen history — time-of-day and weekday habits |
| Last.fm | A real descriptive tag vocabulary (`nu-disco`, `melancholy`, `shoegaze`) |

It also treats **your existing curated playlists as your mood vocabulary**. If you have
playlists called `golden hour`, `cranked` and `slow shreds`, those words already mean
something specific in your library — far more than a generic genre ever will.

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

## Tools

| Tool | Purpose |
|---|---|
| `describe_library` | Orientation: size, genres, decades, curated vibes, tag vocabulary |
| `search_tracks` | The workhorse — full compound filtering, diversity caps, affinity ranking |
| `get_vibe_profile` | What one of your curated moods actually consists of |
| `similar_tracks` | Expand from seeds via agents + your own playlist co-occurrence |
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
