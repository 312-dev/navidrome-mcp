# Finishing plan

Written to survive a context compaction. Reflects the state on 2026-08-09.

## What this is

A **prompt-to-playlist** system for any Navidrome library. A user describes what
they want in words; that compiles into a specification; a deterministic engine
selects and sequences the tracks. The scheduled rolling playlists (the hourly
`daylist`, `on repeat`, `rediscover`, `time capsule` and the six `mix: ...`
lists) are presets of that, not the product.

Nothing in the design may assume a particular user's library, playlists, or
listening history. Those are optional enrichment, never the foundation.

## The two halves, and which way the arrow points

| | `navidrome-mood` (`~/repos/navidrome-mood`) | `navidrome-mcp` (this repo) |
|---|---|---|
| What | Navidrome WASM plugin, Go | MCP connector, TypeScript |
| Runs | Inside Navidrome on the Mac Mini | Hetzner gateway, port 8012 |
| Owns | **All enrichment.** Vocabulary, regions, the LLM pass, tag writing | **All querying.** Selection, cohesion, sequencing, playlist writing |
| Needs the other? | **No. Ever.** | For mood data, yes |
| State | installed + enabled, **has never written a tag** | deployed; v1 labels discarded at snapshot v5 |

**The dependency runs one way, and only one way.**

The plugin is standalone and complete on its own. It labels the library and
writes tags into the audio files, and that is useful with no connector anywhere
in the picture: Navidrome's own smart playlists filter on those tags, Music
Assistant reads them, so does every Subsonic client. It knows nothing about MCP.

The connector is a pure consumer. It carries **no enrichment logic at all**: no
LLM client, no API key, no labelling prompt, no vocabulary derivation. If you
want mood-aware playlists, you install the plugin; if the plugin is not
installed, the connector says so plainly and its non-mood tools keep working.

What that forbids, concretely: the connector must never grow a second way to
obtain a mood. The one it had (`src/mood.ts`, a full Anthropic batching pipeline)
is deleted, not kept as a fallback. A fallback is how you end up maintaining the
same vocabulary in two languages and shipping two answers for one question.

### Which side owns what

The split is not "the plugin does data, the connector does logic". It is
**by question**:

| Question | Owner | Why |
|---|---|---|
| What does this track sound like? | plugin | It is the one with the files and the LLM |
| Which vocabulary terms exist, and where do they sit? | plugin | It writes them |
| Which region does this track fall in? | plugin | Computed from its own anchors, written as a `vibe` tag so Navidrome can filter on it too |
| Do these two tracks sit well together? | connector | Sequencing is not the labeller's job |
| What suits 7am? | connector | Scheduling is a playlist concern; the plugin has no opinion about clocks |
| Did the user mean `mellow` when they typed `chill`? | connector | Query-side input folding |

So the connector keeps `moodspace.ts` (distance, centroid, sequencing) and a
region-to-hours table, and keeps a generated term/synonym list for folding user
input. It keeps no anchors, no radii, and no way to produce a label.

## Static playlists are the default

Navidrome's smart playlists (NSP) can express a *box* in mood-space but not a
sphere, not per-artist diversity caps, and not ordering, which is most of the
way back to the problem this whole design exists to fix. They also require
declaring numeric tags under `Tags` in Navidrome's own config file, since
nothing does that by default.

So: **static by default.** `refresh: "smart"` stays in the spec as a documented
power-user path for standing collections ("everything calm and acoustic") where
order does not matter and the set should grow with the library.

The heuristic: *"a playlist for X"* is static; *"all my Y"* is smart.

## A rolling playlist keeps its title

Ten playlists get rewritten on a schedule rather than accumulating: `daylist`,
`on repeat`, `rediscover`, `time capsule`, and `mix:` `chill` / `focus` /
`workout` / `golden hour` / `heavy` / `melancholy`. Each keeps its title for
life; the phrase describing this particular revision goes in the description.

The title is therefore the identity, and `commit_playlist` is what enforces
that: it matches on the title, never renames what it finds, creates only when
nothing matches. The alternative, a generator naming its output after the mood
of the hour, has to track identity some other way, and every miss leaves behind
a playlist nobody deletes. Forty of them is what that looks like after a week of
hourly runs.

## Phase 0: Portability pass ✅ done 2026-08-09

- [x] `mood.ts`: the labelling prompt is built from `MOOD_ANCHORS` (coordinates
      + glosses), not from anyone's playlists. `vibes` dropped from the model's
      output entirely, and `moods` is now a schema `enum` so an off-vocabulary
      term is not a thing the model can return.
- [x] Mood schema v2 in the connector: `acousticness`/`density`/`tempoFeel`/
      `vocal` added, `organic` gone, `Mood extends MoodPoint`. Snapshot version
      4 → 5, so v1 labels are discarded rather than migrated (three of the axes
      were never measured).
- [x] `daylist.ts`: `vibeFits` iterates `UNIVERSAL_VIBES`. Lift where history
      exists, the region's own `hours` where it does not, and every region is
      reported so an unlabelled library says so instead of returning nothing.
- [x] `index.ts`: `vibe_regions` replaces `curated_vibes`; `get_vibe_profile`
      resolves a region *or* a playlist and reports the library's own centroid
      and spread for it; tool descriptions no longer quote one library's counts.
- [x] `query.ts`: `mood_vibes` matches computed membership; `moods` folds
      synonyms so a caller asking for "chill" gets `mellow`; the curated-playlist
      affinity bonus survives as a term that contributes zero when absent.
- [x] **`src/propagate.ts` deleted** (140 lines). It trained a nearest-centroid
      classifier to guess vibe membership because playlists were the only labels
      available. Membership is now a measurement.
- [x] `scripts/check-vocabulary.ts` + `npm run check:vocab`.

**Exit met:** every remaining `store.vibes` read is optional enrichment: the
explicit `vibes` filter, the affinity bonus, `similar_tracks` co-occurrence, the
`curated_playlists` block, and persistence.

### Two things this turned up

**`src/store.ts` was invisible to grep.** It used a literal NUL as a string
separator, written as the raw byte rather than an escape, so `file` classed it as
`data` and plain `grep` skipped it *silently*: no match, no warning, exit 0.
That is why this plan's original call-site list missed 15 sites in that file,
including the `propagateVibes` wiring. Both occurrences are now `\u0000` escapes
and the file is ordinary text again. `matchKey` in `src/listenbrainz.ts` held a
third, hiding that file the same way, and is escaped too. Worth remembering as a
class of bug: a search that reports success while searching nothing.

**The vibe radii were wrong twice, for different reasons.** First they were
guessed by eye, and a uniform sweep of mood-space showed `driving` covering 46%
of it with a typical point falling in 3.9 regions. Retuning to ~7% of that sweep
fixed the sweep and not the problem: a library does not spread through the cube.
Measured on the 9,195 labelled tracks, two picked at random sit 17.7 apart at the
median where two uniform points sit 39.1, so radii of 18 to 24 were wider than
the typical gap between any two tracks and `driving` was tagging 45% of the
actual library while `focus` reached 111 tracks.

The radii are now fitted to the real distribution, about 8% of the library each,
in `navidrome-mood` 0.4.0. The lesson generalises past this one number: a
measurement taken against a uniform sample answers a question nobody asked, and
it will pass confidently while the thing it is standing in for fails.

Separately, no radius could keep `warm` (valence 66) out of `melancholy`
(valence 24), because a mean over five axes cannot enforce a requirement on one,
so affect-named regions carry a valence bound alongside the existing tempo/vocal
ones. Both are recorded in `DESIGN-mood-v2.md` and asserted by `check:vocab`.

## Phase 1: Connector stops enriching ✅ done 2026-08-09 (`d458b8c`)

- [x] **`src/mood.ts` deleted** (519 lines): `MoodEnricher`, the Anthropic
      client, batching, the Batch API path, cost tracking, prompt and schema
- [x] `@anthropic-ai/sdk` dropped from `package.json` and the lockfile;
      `NAVIDROME_ANTHROPIC_KEY` / `ANTHROPIC_API_KEY` removed from the code and
      from `mcp-gateway/gateway/supervisord.conf` (**that edit is uncommitted in
      the gateway repo**)
- [x] Anchors and region geometry moved out. `src/vocabulary.ts` is now a
      consumer's subset: term list, synonyms, and a region→`hours` table
- [x] `src/moodtags.ts`: new, reads `Mood` out of `NdSong.tags`. All-or-nothing
      on the five axes plus tempo and vocal
- [x] Snapshot version 5 → 6; the `moods` map is gone from the snapshot entirely
- [x] `enrich_moods` → `mood_coverage`, which reports *why* a library has no
      moods (never installed / ran but wrote nothing / not declared in
      Navidrome's config) rather than only that it has none
- [x] `check:vocab` rewritten for what this side still owns. It caught that hours
      4 and 5 belonged to no region, so a fresh install had nothing to suggest at
      4am; `late night` and `slow morning` were extended to cover them.

**Exit met:** `grep -ri anthropic src/` is empty and there is no code path here
that can produce a label.

## The tag contract

`src/moodtags.ts` `TAGS` is the source of truth for the names, and the plugin
must write exactly these. Changing one is a breaking change across two repos.

| Tag | Kind | Notes |
|---|---|---|
| `mood` | multi | 2-4 vocabulary terms. Standard Vorbis/ID3 field, mapped by Navidrome already |
| `ndmood_energy` `ndmood_valence` `ndmood_intensity` `ndmood_acousticness` `ndmood_density` | numeric 0-100 | Need declaring under `Tags` in Navidrome's config to be queryable server-side |
| `ndmood_tempo` | enum | `still\|slow\|mid\|driving\|frantic` |
| `ndmood_vocal` | enum | `instrumental\|sung\|rapped\|mixed` |
| `ndmood_time` | multi | time-of-day slots |
| `vibe` | multi | region names, computed by the plugin from its own anchors |
| `vibe_near` | single | the one region a track came closest to when it falls in none, within 1.5x that region's radius. Never set alongside `vibe` |

The connector treats the five axes plus tempo and vocal as **all-or-nothing**: a
partial point cannot be measured against another one, so a track missing any of
them is treated as unlabelled rather than as a point with a zero on one axis.

The eight axis tags sit under `ndmood_` and not `mood` on purpose. Navidrome's
REST filter on `tag_name` has no custom mapping, so it falls through to the
starts-with default in `persistence/sql_restful.go` and compiles to `tag.tag_name
LIKE 'mood%'`. The UI's Mood dropdown passes `tag_name: 'mood'`, which therefore
matched all nine tags and returned 288 rows instead of 52. Song-level field
filters are exact rather than prefix-matched, so nothing about querying changed
with the rename.

**Open: the plugin's name.** It writes ten tags now, and `mood` describes one of
them. `navidrome-moodspace` is the leading alternative -- it names the coordinate
system rather than the word list, and still contains "mood" for discoverability.
Undecided; rename before publishing a remote, not after.

## Phase 2: Plugin becomes the enrichment authority - done 2026-08-09 (`d7e9ca4`)

- [x] Port the 52 anchored terms, 146 synonyms and 14 regions into Go as the
      canonical vocabulary. **The existing 60 words were selected by frequency**
      (the source comments read "high frequency (300+)"), so they kept
      `nostalgic`, `cinematic`, `raw`, `hypnotic`, `rowdy`, every word measured
      as spanning the whole space. The ported values were diffed against
      `045184b:src/vocabulary.ts` with zero mismatches on coordinates, glosses,
      synonyms, region centres, radii and hard bounds.
- [x] Rebuild `internal/prompt` from anchors and glosses. `Library` ended up an
      empty struct: `TopGenres` and `Decades` were dropped because telling the
      model "this collection is mostly metal" invites relative scoring, so a
      mild metal track returns intensity 40 because it is mild for metal, and
      the axes would mean something different in every library.
- [x] Schema v2: add `density`, `tempo`, `vocal`; rename `organic` to
      `acousticness`. Out-of-range values are rejected rather than clamped,
      because the connector reads the seven all-or-nothing and a clamped value
      is a plausible wrong answer nothing downstream can detect.
- [x] Write all ten tags. `vibe` is computed from the axes by `mood.VibesFor`,
      never asked of the model. Relabelling replaces rather than merges, so a
      stale `vibe` cannot outlive the axes that produced it.
- [x] Ship a `Tags` config snippet and a README covering standalone use:
      each tag needs a `[Tags.<name>]` entry in Navidrome's own config file,
      with `Type = "int"` on the numeric axes, before a smart playlist can
      filter on them
- [x] Fix the manifest: it promised "keeps natural-language playlists refreshed
      on a schedule" and no such code exists
- [x] Drop the Subsonic playlist-reading permission. Grepping every `.go` file
      found zero uses of the Subsonic API, so `subsonicapi` and the `users`
      permission that existed only to support it are both gone.
- [x] Sweep the plugin's comments/docs for drift (hard rule)

Also found while doing it: `batchMode`, `statusToken`, `relayUrl` and
`sendTrackTitles` are declared config that no Go file reads. `SupportsBatch()`
and the discounted `Cost()` path exist but nothing submits to a batch endpoint,
so the manifest's "about half price" is not currently true. Left in place and
recorded under Known limits in the plugin README.

A record written before this carries the mood words alone but deserialises
cleanly with the new axes reading 0, so `RecordSchema` gates `skipTagged` and
those tracks go back through labelling.

**Exit: met against a local Navidrome 0.63.2 on 2026-08-09, not yet against the
real library.** Two fixtures were tagged by the plugin's own writer and served by
two containers, one with the `Tags` config block and one without:

- Without it, only `mood` survived. The nine other tags were dropped with no
  error, which is exactly the invisible failure the README warns about.
- With it, all ten came back through `/api/song`, `vibe` intact as a
  multi-valued tag with spaces preserved (`wind down`, `slow morning`).
- A `.nsp` smart playlist combining `gt ndmood_energy 50`, `lt ndmood_valence 45`
  and `is ndmood_vocal sung` selected the right track, so the numeric axes
  really are comparable server-side rather than string-compared.
- `moodFromTags` parsed both tracks straight from the live API response, and the
  two sat 113.6 apart in mood-space with no shared vibe. The cross-repo contract
  holds in both directions.

What remains untested is the real library: the plugin has still never labelled a
track, because no LLM API key exists in any vault, and the Mac Mini's Navidrome
config has not been given the `Tags` block.

## Phase 3: Relabel and join the halves

- [ ] `dryRun: false`, `run: everything`, provider/model set
- [ ] Confirm the preflight estimate before committing
- [ ] Verify `autoSync` labels newly-added music (default on, `*/15 * * * *`)
- [ ] **Verify the connector can actually read the tags back.** `NdSong.tags` is
      typed `Record<string, string[]>` and is the assumption the whole split
      rests on, but it has never been exercised against a custom tag. Check this
      the moment the first tag is written, not after building on top of it.
- [ ] `cohesion_radius` on `search_tracks`, using `moodDistance`
- [x] Re-measure the vibe radii against the real labelled library. Done in
      `navidrome-mood` 0.4.0: fitted to ~8% of the real distribution, applied by
      the new no-cost `revibe` run mode, which recomputes `vibe` from axes
      already in the files rather than re-labelling.
- [ ] **`aestheticProfile(hourBucket, weekdayType, windowDays)`**: optional.
      Where listening history exists, project listens onto mood points and bucket
      by hour to get a measured centroid. Where it does not, fall back to each
      vibe's `hours` affinity. History is the user's choice to connect.

**Cost:** ~$5.50 on Sonnet 5: `batchMode: true` is already on, which is the
50% Batch API discount. Intro pricing ends **2026-08-31**. Derived from the
measured v1 run: 876,734 output tokens for 9,193 tracks. `maxSpendUsd: 25` and
`lifetimeCapUsd: 100` both cover it.

⚠️ `dryRun` costs full price. It protects files, not the bill.

**Exit:** the v1 failures are the regression test: a `tender` query must stop
returning Debussy and Metallica together, and `flowScore` on a cohesion set must
beat the same-size set filtered by mood word alone.

## Phase 4: Prompt to playlist

The general capability. A `PlaylistSpec` carries: region (centre + radius),
filters, history constraints, diversity caps, size, sequencing arc, refresh mode.

| Step | How |
|---|---|
| Prompt → spec | one model call: parsing novel intent is the real job for an LLM |
| Select | constrained sampling within the region, diversity caps, rotation exclusion |
| Sequence | `sequence()`: greedy nearest-neighbour along an energy arc |
| Describe | template, or a ~200-token call. A rolling playlist is only described: its title is fixed |
| Commit | write the playlist |

- [ ] `create_playlist_from_prompt` implementing the above
- [ ] Daylist as a scheduled preset: spec derived from the hour, no prompt
- [ ] `refresh: "smart"` back-end (NSP rules) as a later add-on

## Phase 5: Ship

Verified 2026-08-09. The hostname is **`navidrome-mcp.graysons.network`**:
commit `724e5fa` renamed it from `navidrome.`

- [x] Worker deployed (2026-08-04 21:50 UTC), routing `navidrome-mcp`
- [x] Access-for-SaaS redirect URI registered
- [x] Live probe returns 403, matching the known-good `xbox` connector
- [x] Orphaned `navidrome.graysons.network/*` route deleted
- [x] Added to Claude Code as MCP server `navidrome` (user scope)
- [ ] **Complete the OAuth login**: run `/mcp`, pick `navidrome`. Currently
      "Needs authentication". This also proves the worker→backend round trip,
      which the 2026-08-06 audit flagged as never verified end to end.
- [ ] Recurring task for the daylist preset

Known drift, harmless: the live worker predates `bf8b34e` and `0a401b9`, so its
`BACKENDS` still lists sophtron / spotify / todoist / wrongcard. Their DNS is
gone. The next worker change carries the sync.

## Phase 6: Hygiene

- [ ] **`navidrome-mood` has no git remote.** 15 commits of Go and the built
      `.ndp` exist only on this laptop. The one item where delay risks real loss.
- [ ] Reissue `op://Dev/Cloudflare API Token: Worker Editor`: it is invalid
      (`code 1000`), which is why Cloudflare work currently needs the Production
      global key. Scopes: Workers Scripts:Edit, Workers Routes:Edit (zone
      graysons.network), Workers KV:Read, Account Settings:Read, Access Apps:Edit.
- [ ] Rotate the ListenBrainz token (surfaced in a transcript 2026-08-04)
- [ ] Navidrome password rotation (pre-existing)

## Blocked right now

**Navidrome is down.** The Mini answers on the tailnet (`100.93.15.8`) but
`:4533` refuses connections, which is also why the connector's port 8012 probes
`000`. No shell access to the Mini from here. Phases 1-3 need it back.

## Sequencing

Phase 0 is done. 1-2 gate 3-4: the connector cannot read tags that do not exist,
and cohesion cannot be evaluated without the v2 axes. Phase 5's remaining item is
independent. Phase 6 should not wait.
