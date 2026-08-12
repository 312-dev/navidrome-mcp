#!/usr/bin/env python3
"""Write planned play counts into Navidrome's database, reversibly.

Python and not TypeScript because this has to run where `navidrome.db` is, and
that machine is not guaranteed to have node. Standard library only, for the same
reason.

Read `plan-playcounts.ts` first: it explains why the database is the target and
why Navidrome's own scrobble endpoint is not. In short, that endpoint forwards
to ListenBrainz and Last.fm, so replaying a history through it submits the whole
history back to where it came from.

Three rules hold whatever the plan says:

  A count is a floor, never an assignment. Navidrome increments `play_count`
  itself every time it serves a track, so a later run must not roll back plays
  it did not know about. `max(existing, planned)` also makes the whole thing
  idempotent, which matters because the obvious failure of a backfill is running
  it twice and doubling everything.

  Only `play_count` and `play_date` are touched. The same row carries `starred`,
  `starred_at` and `rating`, which are the user's own judgements and are worth
  more than any imported number. An upsert that rewrote the row wholesale would
  quietly clear them.

  Every previous value is written out before anything changes, so the import can
  be undone exactly.

Usage: apply-playcounts.py <playcounts.json> <navidrome.db> [--write] [--user NAME]
"""

import datetime
import json
import os
import sqlite3
import sys

ITEM_TYPE = "media_file"

#: How Navidrome stores `play_date`. Matched exactly so the values this writes
#: sort against the ones Navidrome wrote as plain strings, which is what lets a
#: later run compare them without parsing.
STAMP = "%Y-%m-%d %H:%M:%S+00:00"


def stamp(ts):
    """A unix timestamp in Navidrome's own play_date format, UTC."""
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime(STAMP)


def resolve_user(con, wanted):
    """The user id to file these annotations under.

    Annotations are per user. Guessing wrong writes a complete, plausible
    history onto an account nobody listens from, which looks from the UI exactly
    like the import having done nothing.
    """
    rows = con.execute("select id, user_name from user order by user_name").fetchall()
    if not rows:
        raise SystemExit("no users in this database")
    if wanted:
        for uid, name in rows:
            if name == wanted:
                return uid, name
        raise SystemExit(f"no user named {wanted!r}; have {[n for _, n in rows]}")
    if len(rows) > 1:
        raise SystemExit(
            f"{len(rows)} users ({[n for _, n in rows]}); name one with --user")
    return rows[0]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    write = "--write" in sys.argv
    wanted = None
    for i, a in enumerate(sys.argv):
        if a == "--user" and i + 1 < len(sys.argv):
            wanted = sys.argv[i + 1]
    if len(args) < 2:
        raise SystemExit(__doc__.strip().splitlines()[-1])
    plan_path, db_path = args[0], args[1]
    rollback_path = os.path.splitext(plan_path)[0] + ".rollback.json"

    with open(plan_path, encoding="utf-8") as fh:
        plan = json.load(fh)

    con = sqlite3.connect(db_path, timeout=30)
    con.execute("pragma busy_timeout = 30000")
    uid, uname = resolve_user(con, wanted)

    known = {r[0] for r in con.execute("select id from media_file")}
    existing = {
        item_id: (count or 0, date)
        for item_id, count, date in con.execute(
            "select item_id, play_count, play_date from annotation "
            "where user_id = ? and item_type = ?", (uid, ITEM_TYPE))
    }

    raised = same = missing = 0
    rollback, writes = [], []
    for row in plan:
        tid, plays = row["id"], int(row["plays"])
        if tid not in known:
            # A track in the plan that the library no longer has. Navidrome
            # keeps annotation rows for missing files, so writing one would be
            # harmless and pointless; counting it is the useful part.
            missing += 1
            continue
        had_count, had_date = existing.get(tid, (0, None))
        want_count = max(had_count, plays)
        # Both sides are the same fixed-width UTC format, so the later one is
        # the larger string and no parsing is needed.
        want_date = max(stamp(row["last"]), had_date or "")
        if want_count == had_count and want_date == (had_date or ""):
            same += 1
            continue
        rollback.append({"id": tid, "play_count": had_count, "play_date": had_date})
        writes.append((uid, tid, ITEM_TYPE, want_count, want_date))
        raised += 1

    print(f"user {uname}")
    print(f"  {raised:6d} tracks to raise")
    print(f"  {same:6d} already at or above the planned count")
    print(f"  {missing:6d} planned tracks are not in the library")
    print(f"  {sum(w[3] for w in writes):6d} total plays after the raise")
    if not write:
        print("\ndry run. pass --write to apply.")
        return

    with open(rollback_path, "w", encoding="utf-8") as fh:
        json.dump(rollback, fh)
    with con:
        con.executemany(
            "insert into annotation (user_id, item_id, item_type, play_count, play_date) "
            "values (?, ?, ?, ?, ?) "
            "on conflict (user_id, item_id, item_type) do update set "
            "  play_count = excluded.play_count, play_date = excluded.play_date",
            writes)
    print(f"\nwrote {len(writes)} rows. previous values in {rollback_path}")
    print("Navidrome caches nothing here, but a running instance will not show "
          "the change in an already-rendered page; reload it.")


if __name__ == "__main__":
    main()
