# Finishing plan

Where this effort stands and what remains. Written to survive a context compaction.

## The two halves

| | `navidrome-mcp` (this repo) | `navidrome-mood` (`~/repos/navidrome-mood`) |
|---|---|---|
| What | MCP connector, TypeScript | Navidrome WASM plugin, Go |
| Runs | Hetzner gateway, port 8012 | Inside Navidrome on the Mac Mini |
| Owns | Query engine, cohesion, daylist | **Labelling**, writes mood tags into Navidrome |
| State | deployed; v1 labels to be discarded | installed + enabled, **has never written a tag** |

**Architecture decision, locked:** the plugin labels and writes tags; the connector
reads those tags instead of keeping its own snapshot, and owns everything
downstream. Tags are the better home — they outlive the connector, and Music
Assistant plus every Subsonic client can read them. One label, many readers.

## Phase 1 — Schema v2 into the plugin

The plugin currently emits v1's four axes and free-form descriptors. Port the v2
schema (see `DESIGN-mood-v2.md`) into its prompt and output schema:

- [ ] Add `density`, `tempo_feel` (`still|slow|mid|driving|frantic`), `vocal`
      (`instrumental|sung|rapped|mixed`)
- [ ] Rename `organic` → `acousticness`
- [ ] Constrain `moods` to the 53-term controlled vocabulary (`src/vocabulary.ts`
      here is the source of truth; port the list and the synonym map)
- [ ] Write labels as Navidrome tags, one tag per axis plus `mood` multi-value
- [ ] Sweep the plugin's own comments/docs for drift (hard rule)

**Exit:** a 40-track sample run writes real tags visible in `/api/tag`, and
`mood=*` returns non-zero.

## Phase 2 — Relabel the library

- [ ] Set `dryRun: false`, `run: everything`, model Sonnet 5
- [ ] Confirm the preflight estimate before committing
- [ ] Verify `run on ingest` labels newly-added music (the question left open
      on 2026-08-06)

**Cost:** ~$11 on Sonnet 5 at intro pricing, which **ends 2026-08-31**; ~$17
after. Derived from the measured v1 run (876,734 output tokens for 9,193 tracks),
adjusted for the plugin's `batchSize: 20`. Existing `maxSpendUsd: 25` covers it.

⚠️ `dryRun` costs full price — it protects your files, not your bill. Do not run
`everything` in dry-run mode expecting a free rehearsal.

## Phase 3 — Connector reads tags, and the keystone

- [ ] Read mood from Navidrome tags rather than the local snapshot; drop the
      v1 `moods` map
- [ ] **`aestheticProfile(hourBucket, weekdayType, windowDays)`** — the keystone.
      Project the last N days of ListenBrainz listens onto their tracks' mood
      points, bucket by hour, return `{centroid, radius, topVibes, topMoods,
      drift}`. This is what turns "my Tuesday-evening aesthetic" into a region
      that can be sampled.
- [ ] `cohesion_radius` on `search_tracks`, using `moodDistance`
- [ ] Per-vibe centroid + `spreadRadius` computed at index time

**Exit:** `search_tracks` with a centroid and radius returns a set whose
`flowScore` is materially better than the same-sized set filtered by mood word
alone. Measure both; the v1 failure cases (Debussy vs Metallica under `tender`)
are the regression test.

## Phase 4 — Deterministic daylist

Every step except naming is computable:

| Step | How |
|---|---|
| Pick the vibe | `argmax(lift)` with a recency-decay penalty |
| Derive constraints | that vibe's centroid ± radius for this hour bucket |
| Select ~25 tracks | constrained sampling, `max_per_artist`, rotation exclusion |
| Sequence | `sequence()` — greedy nearest-neighbour along an energy arc |
| **Name it** | one ~200-token model call |
| Commit | `commit_daylist` |

- [ ] `generate_daylist` tool doing all of the above
- [ ] Keep the LLM path for ad-hoc conversational requests ("something for a
      rainy drive") — it supplies the region, the same engine does the rest

**Cost:** ~$0.0002/run, about **14¢/month hourly**, versus $40–100 for a
full-LLM run.

## Phase 5 — Ship

Blocked on Grayson (no credential here can do these):

- [ ] `cd ~/repos/mcp-gateway/worker && npx wrangler deploy`
- [ ] Add `https://navidrome.graysons.network/callback` to the **MCP Gateway**
      Access-for-SaaS app
- [ ] Add the connector in claude.ai at `https://navidrome.graysons.network`
- [ ] Create the recurring task (prompt in `DAYLIST.md`)

Then: verify the connector answers over the public route, and that the gateway's
navidrome server is healthy — a local probe on 8012 returned `000` on 2026-08-09
and needs re-checking.

## Phase 6 — Hygiene

- [ ] **`navidrome-mood` has no git remote.** 13 commits of Go and the built
      `.ndp` exist only on this laptop. Push it somewhere.
- [ ] Rotate the ListenBrainz token (surfaced in a transcript 2026-08-04)
- [ ] Rotate the sandbroker dashboard bearer token: `pkill -f
      '[s]andbroker/bin/sandbroker-dashboard'`, relaunches at next login
- [ ] Navidrome password rotation (pre-existing, tracked in memory)
- [ ] Delete `DESIGN-mood-v2.md`'s v1-specific numbers once v2 data exists, or
      mark them as the historical baseline

## Sequencing note

Phases 1–2 gate everything: the connector cannot read tags that do not exist, and
the cohesion work cannot be evaluated without v2 axes. Phase 5 is independent and
can happen any time. Phase 6 should not wait — the missing git remote is the one
item where delay risks real loss.
