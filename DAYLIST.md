# The hourly daylist

A Spotify-style daylist: one playlist rewritten every hour with music that fits the
time of day, the day of week, and what you have actually been listening to.

## How it behaves

There is exactly **one** playlist. Every run replaces its tracks *and* renames it, so
your sidebar shows a single entry whose name changes through the day:

```
08:00   daylist -> "soft morning strum stories"
12:00   daylist -> "midday cranked haze"
18:00   daylist -> "golden hour synth cruise"
23:00   daylist -> "late night verse vibes"
```

Nothing accumulates. To keep one, copy it: the next run overwrites the rolling list.

## The prompt

Paste this into a recurring Claude task (hourly, or every 2-3 hours if you'd rather it
moved more slowly):

```
Generate my Navidrome daylist for right now.

1. Call daylist_context. Read the vibe_fit lift values, the hour_profile, and what
   I have heard in the last few days. Note the recent daylist titles.

2. Pick the vibe for THIS hour. Prefer one with lift > 1: measured evidence I
   reach for it now. Where lift is null there is no history for that region, so
   fall back to suits_hour. If two are close, take whichever the recent daylists
   used least. get_vibe_profile shows what it holds here, and its mood_spread
   warns you when the region is too loose to use as-is.

3. Source ~25 tracks with search_tracks. Use the mood fields, NOT `vibes`:
     - mood_vibes: ["<the vibe you picked>"]
     - fits_time: "<from the context: morning / golden hour / late night / ...>"
     - narrow it with the axes: tempo_feel and intensity above all, since two
       tracks sharing a mood word can still sound nothing alike
     - exclude_recent_daylists: 6     (so this is not a rerun)
     - max_per_artist: 2              (so it doesn't collapse onto one artist)
     - hour_of_day from the context, sort left on "affinity"
     - limit: 60, then choose the final ~25 yourself for flow

   Aim for roughly 70% things I clearly love and 30% either long-unheard
   (not_listened_within_days: 180) or recently added (added_within_days: 60).

4. Sequence them: strong opener, energy coherent with the hour, never two songs by
   the same artist back to back, and never a sparse acoustic track next to a dense
   loud one however well they match on mood.

5. Name it like Spotify names a daylist: lowercase, 2-4 words, concrete and
   evocative of the time and feel rather than the genre. Do not reuse a recent title.

6. Publish with commit_daylist (title, ordered track_ids, one-line description).

Reply with just: the title, the mood and why the data supported it, and 3-4
highlights. Do not list every track.
```

The server also ships this as an MCP **prompt** named `daylist`, so in a normal chat you
can invoke that instead of pasting the above.

## Why it picks what it picks

The generator does not guess what "6pm on a Thursday" sounds like. It measures it.

**`daylist_context`** reports, for the current hour, which vibe regions you actually reach
for, scored as **lift**, not raw count. Lift asks "does this region appear more than its
own average at this hour?" Raw counts would just rank regions by size, and the biggest one
would win every hour.

Where a region has no listen history behind it, lift is `null` and its declared `hours`
stand in, so an install with no scrobbling connected still gets a sensible answer on day
one rather than an empty ranking.

**`search_tracks`** then sources candidates. `mood_vibes` is the important field: membership
is computed from each track's mood coordinates, so it covers every labelled track rather
than only the ones you filed onto a playlist by hand.

**`commit_daylist`** publishes and records the run, which is what makes the rotation guard
work on the next pass.

## Tuning

| Want | Change |
|---|---|
| Less repetition between hours | Raise `exclude_recent_daylists` to 10-12 |
| More variety within a list | Lower `max_per_artist` to 1 |
| Calmer | `energy_max: 45`, `intensity_max: 40` |
| More driving | `energy_min: 70` |
| More acoustic | `acousticness_min: 65` |
| More electronic | `acousticness_max: 30` |
| Brighter | `valence_min: 65` |
| Moodier | `valence_max: 40` |
| Sparser | `density_max: 35` |
| Instrumental only | `vocal: ["instrumental"]` |
| Tighter flow | Narrow `tempo_feel`, e.g. `["slow","mid"]` |
| More discovery | Raise `not_listened_within_days`, or add `added_within_days: 60` |
| Longer sets | Ask for 40 tracks; ~25 is about 90 minutes |
| A different clock | Set `NAVIDROME_TZ`: all time-of-day analysis keys off it |

## Caveats worth knowing

- **The Mac Mini must be awake.** Navidrome runs there, and the gateway reaches it
  through the Mini's SOCKS proxy. Mini asleep means the connector is down.
- **Time-of-day signal needs history.** It is built from ListenBrainz listens, so hours
  you rarely listen at have thin data and noisy lift numbers.
- **Newly scrobbled plays take a moment to matter.** Call `refresh_index` if a very
  recent binge should influence the next run.
- **Mood covers 98.7% of the library.** The gap is the 116 tracks whose files are
  missing, which are excluded from search anyway.
