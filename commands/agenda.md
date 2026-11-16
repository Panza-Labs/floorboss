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

**When it's built:** floorboss builds the agenda whenever it runs on the day before a meeting day or that morning.
Never offer to schedule it from this session, and never try: floorboss's guard blocks scheduling tools in a session
that ran floorboss, a schedule made in a session ends with it, and the guard refuses any install from Claude.

**A brief that arrives on its own (macOS only for now).** If the user asks for the agenda without opening
floorboss, tell them it is theirs to install, from their own terminal, and print this line for them to copy:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/unattended.mjs" install-brief`

Never run that line yourself, in the shell or through any connected tool: it works only in a terminal with the
user at it, and floorboss's guard refuses it from a session (and `uninstall-brief`, `on`, `launchctl` loading or
starting a job, and writes to the job's launchd file or floorboss's `unattended` folder).

Say what it does in two or three lines. Early each morning (or when the Mac next wakes), on a day with a booked
meeting (or, with unattended drafts on, a day a follow-up draft goes in for someone you also wrote to on LinkedIn
or in the event app: then a short page names them), a small floorboss script builds a brief from what floorboss
already recorded and opens it in the browser; the last one built is also at `today.html` in floorboss's folder. It looks up no news and writes no
talking points: those still come from `/floorboss:agenda`. An agenda saved for that day is kept while its facts
are unchanged; if they changed, the page is rebuilt from the facts, keeps the talking points of meetings that did
not change, and says in one line that some were built before the facts changed.
No Claude session starts, no network is used and nothing is sent. To stop it: `/floorboss:unattended off`. To
remove it, from their terminal: the same script with `uninstall-brief`. On Linux and Windows this isn't available
yet; tell them to open floorboss on the evening before or the morning of each meeting day.

**When this command ends** (finished, stopped by the user, or stopped on an error), run
`node "${CLAUDE_PLUGIN_ROOT}/skills/connectors/scripts/cli.mjs" run-end`. It ends floorboss's run lock, which holds the connectors floorboss was given to reads while a run
is under way (for any other session it lapses on its own 30 minutes after floorboss last ran a script). This session read the
run's lists and pages, so it stays held to reads, and to writing only floorboss's data folder, until it ends, or at the latest 12 hours after its last floorboss step or file tool call:
if the user wants those limits off, tell them `/clear` or a new session lifts them. Never edit or delete
floorboss's files to get past a limit.
