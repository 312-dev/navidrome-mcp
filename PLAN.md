# Finishing plan

Written to survive a context compaction. Reflects the state on 2026-08-09.

## What this is

A **prompt-to-playlist** system for any Navidrome library. A user describes what
they want in words; that compiles into a specification; a deterministic engine
selects and sequences the tracks. A scheduled "daylist" is one preset of that,
not the product.

Nothing in the design may assume a particular user's library, playlists, or
listening history. Those are optional enrichment, never the foundation.

## The two halves

| | `navidrome-mcp` (this repo) | `navidrome-mood` (`~/repos/navidrome-mood`) |
|---|---|---|
| What | MCP connector, TypeScript | Navidrome WASM plugin, Go |
| Runs | Hetzner gateway, port 8012 | Inside Navidrome on the Mac Mini |
| Owns | Prompt parsing, selection, sequencing | **Labelling**, writes mood tags into Navidrome |
| State | deployed; v1 labels to be discarded | installed + enabled, **has never written a tag** |

**Architecture, locked:** the plugin labels and writes tags; the connector reads
those tags and owns everything downstream. Tags outlive the connector, and Music
Assistant plus every Subsonic client can read them.

## Static playlists are the default

Navidrome's smart playlists (NSP) can express a *box* in mood-space but not a
sphere, not per-artist diversity caps, and not ordering — which is most of the
way back to the problem this whole design exists to fix. They also require an
edit to Navidrome's `mappings.yaml` to register numeric tags.

So: **static by default.** `refresh: "smart"` stays in the spec as a documented
power-user path for standing collections ("everything calm and acoustic") where
order does not matter and the set should grow with the library.

The heuristic: *"a playlist for X"* is static; *"all my Y"* is smart.

## Phase 0 — Portability pass (do first)

`src/vocabulary.ts` and `src/moodspace.ts` are already universal. The rest of the
connector still assumes one user's playlists in ~20 call sites:

- [ ] `mood.ts:90,177,334,430` — the labelling prompt is *built from* the user's
      playlist names and sampled tracks. Replace with the anchored vocabulary and
      glosses from `vocabulary.ts`, so a library with no playlists still gets a
      taxonomy to label against.
- [ ] `daylist.ts:100,104` — `vibeFits` iterates `store.vibes`; compute vibe
      membership from `UNIVERSAL_VIBES` anchors instead
- [ ] `index.ts:124,301,393,568` — `describe_library`, `get_vibe_profile`,
      `similar_tracks` co-occurrence
- [ ] `query.ts:270` — the affinity bonus for curated membership becomes
      *optional enrichment*, not a foundation. Keep it when playlists exist.
- [ ] **Delete `src/propagate.ts`.** It trained a nearest-centroid classifier to
      guess vibe membership because playlists were the only labels available.
      With defined anchors, membership is `moodDistance(track, vibe.centre) <
      vibe.radius` — exact, no training set, no accuracy caveat. ~130 lines go.

**Exit:** nothing outside an optional-enrichment path reads `store.vibes`.

## Phase 1 — Schema v2 into the plugin

- [ ] Add `density`, `tempo_feel` (`still|slow|mid|driving|frantic`), `vocal`
      (`instrumental|sung|rapped|mixed`)
- [ ] Rename `organic` → `acousticness`
- [ ] Replace the plugin's built-in 60-word vocabulary. **It was selected by
      frequency** — its own source comments read "high frequency (300+)" — so it
      kept `nostalgic`, `cinematic`, `raw`, `hypnotic`, `rowdy`, every word that
      measured as spanning the whole space. Port the 52 anchored terms and 146
      synonyms from `src/vocabulary.ts`, and put the anchors and glosses in the
      prompt so the labeller places tracks against definitions.
- [ ] Write the numeric axes as tags, not just `MOOD` words. Today it only calls
      `WriteMood(path, canonical)`; without the axes the cohesion engine has
      nothing to compute distance from.
- [ ] Sweep the plugin's comments/docs for drift (hard rule)

**Exit:** a sample run writes real tags visible in `/api/tag`, and `mood=*`
returns non-zero.

## Phase 2 — Relabel

- [ ] `dryRun: false`, `run: everything`, provider/model set
- [ ] Confirm the preflight estimate before committing
- [ ] Verify `autoSync` labels newly-added music (default on, `*/15 * * * *`)

**Cost:** ~$5.50 on Sonnet 5 — `batchMode: true` is already on, which is the
50% Batch API discount. Intro pricing ends **2026-08-31**. Derived from the
measured v1 run: 876,734 output tokens for 9,193 tracks. `maxSpendUsd: 25` and
`lifetimeCapUsd: 100` both cover it.

⚠️ `dryRun` costs full price. It protects files, not the bill.

## Phase 3 — Connector reads tags

- [ ] Read mood from Navidrome tags rather than the local snapshot; drop the v1
      `moods` map
- [ ] Vibe membership from `UNIVERSAL_VIBES` anchors
- [ ] `cohesion_radius` on `search_tracks`, using `moodDistance`
- [ ] **`aestheticProfile(hourBucket, weekdayType, windowDays)`** — optional.
      Where listening history exists, project listens onto mood points and bucket
      by hour to get a measured centroid. Where it does not, fall back to each
      vibe's `hours` affinity. History is the user's choice to connect.

**Exit:** the v1 failures are the regression test — a `tender` query must stop
returning Debussy and Metallica together, and `flowScore` on a cohesion set must
beat the same-size set filtered by mood word alone.

## Phase 4 — Prompt to playlist

The general capability. A `PlaylistSpec` carries: region (centre + radius),
filters, history constraints, diversity caps, size, sequencing arc, refresh mode.

| Step | How |
|---|---|
| Prompt → spec | one model call — parsing novel intent is the real job for an LLM |
| Select | constrained sampling within the region, diversity caps, rotation exclusion |
| Sequence | `sequence()` — greedy nearest-neighbour along an energy arc |
| Name | template, or a ~200-token call |
| Commit | write the playlist |

- [ ] `create_playlist_from_prompt` implementing the above
- [ ] Daylist as a scheduled preset — spec derived from the hour, no prompt
- [ ] `refresh: "smart"` back-end (NSP rules) as a later add-on

## Phase 5 — Ship

Verified 2026-08-09. The hostname is **`navidrome-mcp.graysons.network`** —
commit `724e5fa` renamed it from `navidrome.`

- [x] Worker deployed (2026-08-04 21:50 UTC), routing `navidrome-mcp`
- [x] Access-for-SaaS redirect URI registered
- [x] Live probe returns 403, matching the known-good `xbox` connector
- [x] Orphaned `navidrome.graysons.network/*` route deleted
- [x] Added to Claude Code as MCP server `navidrome` (user scope)
- [ ] **Complete the OAuth login** — run `/mcp`, pick `navidrome`. Currently
      "Needs authentication". This also proves the worker→backend round trip,
      which the 2026-08-06 audit flagged as never verified end to end.
- [ ] Recurring task for the daylist preset

Known drift, harmless: the live worker predates `bf8b34e` and `0a401b9`, so its
`BACKENDS` still lists sophtron / spotify / todoist / wrongcard. Their DNS is
gone. The next worker change carries the sync.

## Phase 6 — Hygiene

- [ ] **`navidrome-mood` has no git remote.** 15 commits of Go and the built
      `.ndp` exist only on this laptop. The one item where delay risks real loss.
- [ ] Reissue `op://Dev/Cloudflare API Token: Worker Editor` — it is invalid
      (`code 1000`), which is why Cloudflare work currently needs the Production
      global key. Scopes: Workers Scripts:Edit, Workers Routes:Edit (zone
      graysons.network), Workers KV:Read, Account Settings:Read, Access Apps:Edit.
- [ ] Rotate the ListenBrainz token (surfaced in a transcript 2026-08-04)
- [ ] Navidrome password rotation (pre-existing)

## Blocked right now

**Navidrome is down.** The Mini answers on the tailnet (`100.93.15.8`) but
`:4533` refuses connections, which is also why the connector's port 8012 probes
`000`. No shell access to the Mini from here. Phases 1–3 need it back.

## Sequencing

Phase 0 first — no point porting the plugin's prompt to a design the connector
still contradicts. Then 1–2 gate 3–4: the connector cannot read tags that do not
exist, and cohesion cannot be evaluated without the v2 axes. Phase 5's remaining
item is independent. Phase 6 should not wait.
