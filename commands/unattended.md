---
description: What floorboss does on its own (the morning brief, and your follow-ups put in your drafts folder). Turn unattended drafts on for an event, authorise its follow-ups, turn everything off, or see what is installed and what it did.
argument-hint: "on | authorise | off | status"
allowed-tools: ["Bash(node \"${CLAUDE_PLUGIN_ROOT}/scripts/unattended.mjs\" off)", "Bash(node \"${CLAUDE_PLUGIN_ROOT}/scripts/unattended.mjs\" status)", "Bash(node \"${CLAUDE_PLUGIN_ROOT}/skills/connectors/scripts/cli.mjs\" unattended-on:*)", "Bash(node \"${CLAUDE_PLUGIN_ROOT}/skills/connectors/scripts/cli.mjs\" unattended-status)", "Bash(node \"${CLAUDE_PLUGIN_ROOT}/skills/event-outreach/scripts/cli.mjs\" authorise-unattended:*)", "Bash(node \"${CLAUDE_PLUGIN_ROOT}/skills/flow/scripts/cli.mjs\" next:*)", "Bash(node \"${CLAUDE_PLUGIN_ROOT}/skills/connectors/scripts/cli.mjs\" run-end)", "Write(~/.floorboss/**)", "Edit(~/.floorboss/**)"]
---

Arguments: `$ARGUMENTS` (`on`, `authorise`, `off` or `status`; with none, `status`).

Running on its own is macOS only for now. Linux (systemd timers) and Windows (Task Scheduler) are planned.

## off

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/unattended.mjs" off`, with nothing before or after it, and show the user
what it prints. It stops the morning brief and the follow-up drafts until the user turns them on again from their own
terminal. Nothing is removed. It works in any session, even one where floorboss is running.

## status

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/unattended.mjs" status` and show the user what it prints: what is installed,
which events have unattended drafts on, whether it is off, and the last runs. Each day's summary of what floorboss did
on its own is in `~/.floorboss/unattended/summary-<day>.md`; show the latest one if the user asks what happened.

## on

Unattended drafts for one event. Turning it on takes three steps, and each needs the user:

1. **Their words.** Ask which event, if this run isn't about one already (`flow next` says it as `event`). Then show
   this, exactly, and ask the user to type the sentence at the end themselves:

   > **Put your follow-ups in your drafts without asking you? Read this first.**
   >
   > Right now Claude Code asks you before floorboss puts drafts in your mailbox. If you turn this on, follow-ups you
   > approved and then authorised can go into your drafts folder on their day **while you are not there: no question,
   > no click.** Nothing is sent. Each draft waits in your drafts folder until you read it and press Send. A first
   > message never goes in on its own.
   >
   > Before each draft goes in, floorboss reads your mailbox for anything from that person since your last email
   > (with Gmail: your whole thread with them, and a search for anything from or to them in any thread, which must
   > find your own last email to them or the draft waits; it searches every folder but Spam, which Gmail leaves out,
   > and floorboss can only show that the search covered your own last email and the time since, not that it matched
   > mail from them), and your CRM's logged
   > activity too, through your CRM activity reader (a reader that lists only emails never shows calls or notes).
   > **If a CRM is connected with no activity reader (only a lookup), every draft waits for you,** since a reply
   > logged there could never be seen: connect the reader in /floorboss:event-setup first. Only with no CRM
   > connected at all is email alone checked. Anything from them
   > holds the draft: it waits for you. If the mailbox or the CRM can't be read, nothing goes in. Other CRM activity, such as a colleague's note or someone else's email on a
   > thread they were copied on, is judged by Claude: hold, or go with the text you approved. Unsure means hold. Each
   > judgement and its reason is in that day's summary. floorboss can't read Salesforce or Close activity on its own,
   > so with either of those connected every draft waits for you.
   >
   > What can still go wrong:
   > - **A reply floorboss can't see** (to another address, in a folder it can't search, a call) won't stop the draft.
   > - **floorboss can't see replies on LinkedIn or in the event app in an unattended run.** Check those inboxes
   >   regularly and tell floorboss or your CRM when one comes in. If you installed the morning brief, the morning
   >   page names the people you wrote to there whose draft goes in that day.
   > - **Plans change.** If something changed after you approved a message, the draft still says what you approved.
   > - **Claude's judgement of CRM activity can be wrong.** The summary shows each call it made, so you can check.
   >
   > - **It uses your Claude Code usage.** Each run is a Claude Code session on your account: it counts toward your
   >   plan's usage and limits, the same ones your own sessions use. A run can start every hour something is due.
   > - **A follow-up after a draft waits for that draft to be sent.** Once you send it from your mail app, run
   >   floorboss (it reads your mailbox for it).
   >
   > Limits: email only, follow-ups only, on a follow-up's day or the day after, on weekdays from 09:00 to 17:00 in
   > the event's time zone, never after the event's last day. There is no limit on how many per run or per day.
   > floorboss doesn't track your mail provider's daily sending limit; mail you send from these drafts counts toward
   > it as usual. It ends with the event. macOS only.
   >
   > To turn it on, type exactly: **put my approved follow-ups in my drafts without asking me**
   > Anything else leaves it off.

   Never type the sentence for them, suggest it as an answer, or accept anything else.
2. **Claude Code's prompt.** Write exactly what the user typed to
   `~/.floorboss/work/answers/unattended_on.txt` (the Write tool), then run
   `node "${CLAUDE_PLUGIN_ROOT}/skills/connectors/scripts/cli.mjs" unattended-on --event <slug> --said-file <file>`, with
   that file as `<file>`.
   floorboss's guard checks the words and asks the user in a Claude Code prompt that names the event and its last day.
   Only if they allow it is anything turned on. Show them what it prints.
3. **The schedule, in their own terminal.** Print the line it gives under `step_3_in_your_terminal` for the user to
   copy, and run it nowhere yourself. floorboss's guard refuses it from any Claude session. It shows the warning
   again and asks them to type a code. Tell them: for 30 minutes after floorboss last ran something, the schedule
   waits (it tries again each hour).

Then offer to authorise this event's follow-ups (below).

## authorise

Turning it on authorises nothing by itself. Once a sequence is approved, run
`node "${CLAUDE_PLUGIN_ROOT}/skills/event-outreach/scripts/cli.mjs" authorise-unattended --event <slug>`. floorboss's
guard shows the user one Claude Code prompt with every follow-up that could go in on its own: each person's name, id
and address, the day it is due and its full text. Only if they allow it are those follow-ups authorised. A change to any
text, address or thread afterwards means that one waits for them again. Show them what it prints.

**When `on` or `authorise` ends** (finished, stopped by the user, or stopped on an error), run
`node "${CLAUDE_PLUGIN_ROOT}/skills/connectors/scripts/cli.mjs" run-end`. It ends floorboss's run lock, which holds the connectors floorboss was given to reads while a run
is under way (for any other session it lapses on its own 30 minutes after floorboss last ran a script). This session read the
run's lists and pages, so it stays held to reads, and to writing only floorboss's data folder, until it ends, or at the latest 12 hours after its last floorboss step or file tool call:
if the user wants those limits off, tell them `/clear` or a new session lifts them. Never edit or delete
floorboss's files to get past a limit.

That is all this command does. Installing, removing or turning things back on is the user's, from their own terminal:

- install the morning brief: `node "${CLAUDE_PLUGIN_ROOT}/scripts/unattended.mjs" install-brief`
- install the follow-up drafts: `node "${CLAUDE_PLUGIN_ROOT}/scripts/unattended.mjs" install-followups`
- turn back on: `node "${CLAUDE_PLUGIN_ROOT}/scripts/unattended.mjs" on`
- remove: `node "${CLAUDE_PLUGIN_ROOT}/scripts/unattended.mjs" uninstall-brief` or `uninstall-followups`
