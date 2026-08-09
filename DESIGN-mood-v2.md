# Mood schema v2 — designing for cohesion

## The problem, measured

v1 labelled 9,193 tracks with four axes and free-form descriptors. It produced
labels that are individually correct and collectively unusable for sequencing.

**Free-form descriptors don't form a vocabulary.** 1,020 distinct words for 9,193
tracks. 33% used exactly once, 61% used five times or fewer, 83% used ≤25 times.
Only 183 words are frequent enough to filter on at all.

**Mood words are semantic, not sonic.** "Tender" describes emotional content, and
content is genre-independent — so it legitimately covers both Debussy's *Suite
bergamasque* (`I8 O95`) and Metallica's *Nothing Else Matters* (`I55 O60`). The
label is right. Using it as a playlist filter is wrong. Measured worst cases:

| Word | Soft end | Heavy end | Intensity gap |
|---|---|---|---|
| `brooding` | Hozier, *Son of Nyx* | Avenged Sevenfold, *Waking The Fallen* | 72 |
| `anthemic` | The Beatles, *All You Need Is Love* | Slipknot, *Unsainted* | 65 |
| `melancholy` | Satie, *Gymnopédie No. 1* | Art Of Dying, *Raining* | 60 |
| `haunting` | Willie Watson, cowboy folk | The Cranberries, *Zombie* | 60 |

**Genre can't fix it.** Rock is 47% of the library, so it dominates every mood
word — `warm` is 392/758 Rock, `anthemic` 483/615. Filtering by genre barely
narrows anything.

## What the data says to do

Scoring every word used ≥20 times by the spread of its tracks across
intensity/acousticness/valence separates them cleanly:

| Tight (spread 5–8) | Loose (spread 15–18) |
|---|---|
| `pastoral`, `club-ready`, `angry`, `furious`, `banging`, `pounding`, `bass-heavy`, `hard-hitting`, `swinging` | `raw`, `cinematic`, `bleak`, `hypnotic`, `rowdy`, `nostalgic`, `spacious`, `theatrical`, `cathartic`, `lush`, `desolate`, `stomping` |
| describe **sound**, or affect at an extreme | describe **atmosphere, production, association** |

So the selection rule is mechanical: **keep words that describe how a track
sounds; drop words that describe how it makes you feel about something else.**
122 of 216 candidates survive at spread ≤ 12.

And the medians reveal the deeper point — a coherent word *is* a named region in
mood-space:

```
furious     I92 O30 V30      pastoral   I20 O90 V55
heavy       I80 O35 V32      hushed     I20 O85 V45
club-ready  I59 O10 V70      joyful     I40 O70 V85
```

Words and axes are not two systems. Words are labels for places.

## Schema v2

**Sonic axes** — these drive cohesion, because they're what makes two tracks sit
comfortably next to each other:

| Field | Range | Meaning |
|---|---|---|
| `energy` | 0–100 | still → frantic activity |
| `intensity` | 0–100 | gentle → heavy/aggressive |
| `acousticness` | 0–100 | fully electronic → fully acoustic *(v1's `organic`, renamed)* |
| `density` | 0–100 | sparse/solo → wall-of-sound **(new)** |
| `tempo_feel` | enum | `still` \| `slow` \| `mid` \| `driving` \| `frantic` **(new)** |
| `vocal` | enum | `instrumental` \| `sung` \| `rapped` \| `mixed` **(new)** |

**Affective axis** — deliberately separate, because two tracks can differ in
valence and still flow:

| `valence` | 0–100 | bleak → joyful |

**Semantic** — for describing and searching, never for cohesion alone:

| `moods` | 2–4 terms from a **controlled vocabulary** |
| `vibes` | which curated playlists it reads as |
| `times` | times of day it fits |

### Why the three new fields

`density`, `tempo_feel` and `vocal` are the mismatches that make a transition
jarring even when energy and intensity agree:

- A sparse solo piano and a wall-of-sound shoegaze track can both be `I30`.
- A 70bpm ballad and a 140bpm track can both be `E50`.
- An instrumental and a rap verse can be identical on every numeric axis.

BPM is unusable here — only 24 of 9,311 files carry it — so `tempo_feel` has to
be inferred rather than read.

Cost impact is negligible: ~15 extra output tokens per track against ~96 today.

## Cohesion

`search_tracks` gains `cohesion_radius`, computed as a weighted distance in
mood-space from a centroid or a set of seed tracks. Weights reflect how jarring
each mismatch actually is:

| Field | Weight | Why |
|---|---|---|
| `tempo_feel` | high | tempo clashes are the classic transition failure |
| `vocal` | high | instrumental → rap is jarring at any energy |
| `intensity` | high | the Debussy/Metallica axis |
| `acousticness` | high | timbre family |
| `density` | medium | |
| `energy` | medium | |
| `valence` | **low** | a sad and a happy song can sit together if they *sound* alike |

Valence being cheap is the non-obvious one, and it's what keeps playlists from
becoming emotionally monotonous while staying sonically coherent.

## Sequencing

Selecting a coherent set is necessary but not sufficient — order still matters.
A `sequence_tracks` step orders a chosen set to minimise total transition cost
(the same distance metric) subject to an energy arc appropriate to the hour:
a morning list ramps gently, an evening list peaks and settles.

## Where it lives

The **plugin** (`navidrome-mood`) writes labels as Navidrome tags. The
**connector** (`navidrome-mcp`) reads those tags instead of keeping its own
snapshot, and owns the query engine — cohesion, sequencing, the daylist.

Tags are the better home: they survive the connector, and Music Assistant and
every Subsonic client can see them. One label, many readers.
