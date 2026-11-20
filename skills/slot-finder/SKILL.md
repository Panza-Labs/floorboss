---
name: slot-finder
description: Turn free times typed in plain words into meeting slots in an event's time zone, and give each contact two times with a per-slot cap. Use when planning meeting times for an event with floorboss.
license: Apache-2.0
---

# Slot finder

Never work out times or caps by hand; the scripts do it, including time zones and daylight-saving changes.

`scripts/cli.mjs`:

- `create --name --city --start YYYY-MM-DD --end YYYY-MM-DD --zone <IANA zone> [--slug]`: the event.
- `build --event <slug> --free "<text>" [--zone <zone the user typed in>] [--keep-outside]`: parses text
  like "Tue 9–11, 14–17; Wed 9:30–12; day2 19:30–22:00 dinner 150" (weekday names, dates like "14 Oct",
  "day1", "every day", "after 3", "mornings"), merges overlaps, keeps working hours, cuts slots of the
  meeting length, and drops anything already past. A range with its own length ("dinner 150") becomes one
  slot of that length. Every other slot starts on :00 or :30 in the event's time. The user's scheduling rules
  are settings: `meeting_minutes` (the length), `buffer_minutes` (free minutes between two meetings) and
  `max_in_row` (at most that many in a row, then a break at least one meeting long).
- `remove --event <slug> --ids "<slot ids>"` and `show --event <slug>`.

Assignment (run by the triage gate): higher-ranked contacts pick first; each gets two slots on different
days, else two slots at least two hours apart on the same day, else one, else an open ask; no slot is
offered to more than `max_offers × per_slot` people.
