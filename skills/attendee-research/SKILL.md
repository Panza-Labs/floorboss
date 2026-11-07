---
name: attendee-research
description: Research event contacts from public professional sources with a URL on every claim, and write a generic, read-only collection prompt for getting an event's contact list. Use when researching attendees or collecting a list with floorboss.
license: Apache-2.0
---

# Attendee research

`scripts/cli.mjs`:

- `plan --event <slug> [--scale all|top|cap --n N]`: who needs research, with time and search estimates.
  Contacts that already have a profile are skipped, so a run cut short resumes.
- `save --event <slug> --id <id> --json-file <file>` (the researcher's reply, written to a file with the Write tool; never pasted into a shell argument): writes the profile;
  claims without a URL are dropped.
- `prompt --event <slug> [--url <list page>] [--must-meet "A, B"]`: writes `collect-prompt.md`.

Research is done by the `attendee-researcher` agent (web search and fetch only), one contact at a time,
with only name, title, company, segment, source hints and a search budget (never the user's goal). Professional public information only;
nothing about anyone's personal life.

The collection prompt is generic: no code for any particular platform. It tells the user's own browser
agent to read only, stay on the event's site, never visit LinkedIn, skip hidden profiles, go slowly, stop
at the first rate limit, captcha or warning, capture everyone listed (no filtering; floorboss caps a list at 5,000 rows), and save a CSV with the exact header floorboss
reads. Check the event's and the platform's terms before running it.
