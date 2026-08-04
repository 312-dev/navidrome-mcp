# The hourly daylist

A Spotify-style daylist: one playlist that gets rewritten every hour with music that
fits the time of day, the day of week, and what you have actually been listening to.

## How it behaves

There is exactly **one** playlist. Every run replaces its tracks *and* renames it, so
your sidebar shows a single entry whose name changes through the day:

```
08:00   daylist -> "soft morning strum stories"
12:00   daylist -> "midday cranked haze"
18:00   daylist -> "golden hour synth cruise"
23:00   daylist -> "late night verse vibes"
```

Nothing accumulates. If you want to keep one, copy it — `update_playlist` will
overwrite the rolling list on the next run.

## Why it picks what it picks

The generator does not guess what "6pm on a Thursday" sounds like. It measures it.

1. **`daylist_context`** reports, for the current hour, which of *your own* curated
   playlists you actually reach for — scored as **lift**, not raw count. Lift asks
   "does this mood appear more than its own average at this hour?" Raw counts would
   just rank playlists by size and `bedtime` (718 tracks) would win every hour.

   A real example, Tuesday midday: `hype mode` 2.01, `good vibes` 1.86, `cranked`
   1.77 — while `bedtime`, the largest playlist, does not place at all.

2. **`search_tracks`** then sources candidates with `hour_of_day` set, per-artist caps,
   and `exclude_recent_daylists` so consecutive hours do not repeat each other.

3. **`commit_daylist`** publishes and records the run, which is what makes the
   rotation guard work on the next pass.

## Setting up the recurring task

Create a recurring task in Claude (hourly, or every 2-3 hours if you would rather it
moved more slowly) with this prompt:

```
Generate my Navidrome daylist for right now.

1. Call daylist_context. Read the vibe_fit lift values, the hour_profile, and
   what I have heard in the last few days. Note the recent daylist titles.

2. Pick the mood for THIS hour, anchored on my own curated playlists (the names
   in vibe_fit are my vocabulary, not generic genres). Prefer a vibe with
   lift > 1. If two are close, pick whichever the recent daylists used least.

3. Source ~25 tracks with search_tracks:
     - exclude_recent_daylists: 6
     - max_per_artist: 2
     - hour_of_day from the context, sort left on "affinity"
     - over-fetch (limit 60) and pick the final set yourself for flow
   Aim for roughly 70% things I clearly love and 30% either long-unheard
   (not_listened_within_days) or recently added.

4. Sequence them: strong opener, energy coherent with the hour, never two songs
   by the same artist back to back.

5. Name it like Spotify names a daylist — lowercase, 2-4 words, concrete and
   evocative of the time and feel rather than the genre. Do not reuse a recent
   title.

6. Publish with commit_daylist (title, ordered track_ids, one-line description).

Reply with just: the title, the mood and why the data supported it, and 3-4
highlights. Do not list every track.
```

The server also ships this as an MCP **prompt** named `daylist`, so in a chat you can
simply invoke that instead of pasting the above.

## Tuning

| Want | Change |
|---|---|
| Less repetition between hours | Raise `exclude_recent_daylists` to 10-12 |
| More variety within a list | Lower `max_per_artist` to 1 |
| More familiar / comfort listening | Ask for 85% loved, drop the rediscovery share |
| More discovery | Raise `not_listened_within_days`, or add `added_within_days: 60` |
| Longer sets | Ask for 40 tracks; ~25 is about 90 minutes |
| A different clock | Set `NAVIDROME_TZ` — all time-of-day analysis keys off it |

## Caveats worth knowing

- **The Mac Mini must be awake.** Navidrome runs there, and the gateway reaches it
  through the Mini's SOCKS proxy. Mini asleep means the connector is down.
- **Time-of-day signal needs history.** It is built from ListenBrainz listens, so
  hours you rarely listen at will have thin data and the lift numbers will be noisy.
- **Newly scrobbled plays take a moment to matter.** The index refreshes listens on
  demand; call `refresh_index` if a very recent binge should influence the next run.
