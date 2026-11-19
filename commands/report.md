---
description: The after-show report for an event: every meeting booked and how it went (held, no-show, cancelled, moved, not marked yet), the walk-ups, and how and when each person was first contacted. A page and a CSV in floorboss's data folder; nothing leaves your machine.
argument-hint: "[event slug]"
allowed-tools: ["Bash(node \"${CLAUDE_PLUGIN_ROOT}/skills/event-outreach/scripts/cli.mjs\":*)", "Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/event-outreach/scripts/cli.mjs:*)", "Bash(node \"${CLAUDE_PLUGIN_ROOT}/skills/connectors/scripts/cli.mjs\":*)", "Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/connectors/scripts/cli.mjs:*)", "Read(~/.floorboss/**)", "Write(~/.floorboss/**)", "Edit(~/.floorboss/**)", "Glob"]
---

Arguments: `$ARGUMENTS` (the event's slug). With none, list the events (`~/.floorboss/events/*/event.json`, the folder
name is the slug) and ask the user which one, in one question.

1. If the user has outcomes to tell you first ("Ana's meeting happened", "Raj didn't show", "Lena moved to Thu
   11:00", "Tom from Acme stopped by"), record them before the report, as the event-outreach skill's "Recording what
   happened" says (`held`, `no_show`, `rescheduled`, `cancelled`, `walkup`): run `record` with `--check` first, say
   back its `would_record` lines, and record only on the user's yes.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/skills/event-outreach/scripts/cli.mjs" report --event <slug>`.
3. Say its `say` line, list any `not_marked` meetings (offer to record how each went, then build the report again),
   and give the two paths: `page` (open it in a browser) and `csv` (for a spreadsheet or the client's invoice).

The report is built from floorboss's own record of the event. It only knows what was recorded: a meeting nobody
marked is "not marked yet", never "held".

**When this command ends** (finished, stopped by the user, or stopped on an error), run
`node "${CLAUDE_PLUGIN_ROOT}/skills/connectors/scripts/cli.mjs" run-end`. It ends floorboss's run lock, which holds the connectors floorboss was given to reads while a run
is under way (for any other session it lapses on its own 30 minutes after floorboss last ran a script). This session read the
run's lists and pages, so it stays held to reads, and to writing only floorboss's data folder, until it ends, or at the latest 12 hours after its last floorboss step or file tool call:
if the user wants those limits off, tell them `/clear` or a new session lifts them. Never edit or delete
floorboss's files to get past a limit.
