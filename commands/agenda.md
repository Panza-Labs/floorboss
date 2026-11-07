---
description: Your meetings agenda for an event: who each person is, how you know them, what's new about their company, and what to talk about. Built from what floorboss recorded, plus a fresh look at public news.
argument-hint: "[event slug]"
allowed-tools: ["Bash(node \"${CLAUDE_PLUGIN_ROOT}/skills/flow/scripts/cli.mjs\":*)", "Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/flow/scripts/cli.mjs:*)", "Bash(node \"${CLAUDE_PLUGIN_ROOT}/skills/event-context/scripts/cli.mjs\":*)", "Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/event-context/scripts/cli.mjs:*)", "Bash(node \"${CLAUDE_PLUGIN_ROOT}/skills/slot-finder/scripts/cli.mjs\":*)", "Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/slot-finder/scripts/cli.mjs:*)", "Bash(node \"${CLAUDE_PLUGIN_ROOT}/skills/crm-triage/scripts/cli.mjs\":*)", "Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/crm-triage/scripts/cli.mjs:*)", "Bash(node \"${CLAUDE_PLUGIN_ROOT}/skills/event-outreach/scripts/cli.mjs\":*)", "Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/event-outreach/scripts/cli.mjs:*)", "Bash(node \"${CLAUDE_PLUGIN_ROOT}/skills/connectors/scripts/cli.mjs\":*)", "Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/connectors/scripts/cli.mjs:*)", "Bash(node \"${CLAUDE_PLUGIN_ROOT}/skills/attendee-research/scripts/cli.mjs\":*)", "Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/attendee-research/scripts/cli.mjs:*)", "Read(~/.floorboss/**)", "Read(${CLAUDE_PLUGIN_ROOT}/**)", "Write(~/.floorboss/**)", "Edit(~/.floorboss/**)", "Glob", "AskUserQuestion", "Agent", "Skill"]
---

Arguments: `$ARGUMENTS` (the event slug; if none, the run asks which event).

**How it runs.** Run `node "${CLAUDE_PLUGIN_ROOT}/skills/flow/scripts/cli.mjs" next --agenda` (add `--event <slug>`
once the event is known) and do the one thing it returns, then run it again with `--agenda`, until the agenda
is saved or it says there are no booked meetings. The steps are the usual kinds (`ask`, `judge`, `agents`); the
skill at `${CLAUDE_PLUGIN_ROOT}/skills/flow/SKILL.md` says how to do each. Researchers look only at public
sources and give a URL for every item. Talking points come only from the facts in the agenda data, each
naming its source; never add anything about a person that the data doesn't give.

When it's saved, show the user where it is in one line each: the page (`agenda.html`), the short version
(`agenda.md`) and the calendar file (`agenda.ics`, which puts each brief into the meeting's notes when
imported). Then summarise the day in two or three lines: how many meetings, the first one, anything to
prepare.

**Every morning on its own:** floorboss builds the agenda by itself whenever it runs on the day before a
meeting day or that morning. To have it ready without opening floorboss, offer once to schedule this command
for 07:00 on each meeting day (a scheduled task in Claude Code), and only set it up on the user's yes.

**When this command ends** (finished, stopped by the user, or stopped on an error), run
`node "${CLAUDE_PLUGIN_ROOT}/skills/connectors/scripts/cli.mjs" run-end`. It ends floorboss's run lock, which holds the connectors floorboss was given to reads while a run
is under way (for any other session it lapses on its own 30 minutes after floorboss last ran a script). This session read the
run's lists and pages, so it stays held to reads, and to writing only floorboss's data folder, until it ends, or at the latest 12 hours after its last floorboss step or file tool call:
if the user wants those limits off, tell them `/clear` or a new session lifts them. Never edit or delete
floorboss's files to get past a limit.
