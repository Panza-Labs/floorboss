# Security

Please report a vulnerability privately: open the repository's **Security** tab on GitHub and choose
**Report a vulnerability**. Don't open a public issue for it.

The biggest risk for a tool like this is prompt injection: text in an attendee list, CRM note, web page or
reply that tries to give the AI orders. floorboss treats all of that text as data, never as instructions.
The README's [Text in your files](README.md#text-in-your-files-is-data-never-instructions) section says how,
and what it can't fully stop. A way to get text past it is the report we most want.

Reports are especially welcome about:

- text in an attendee list, CRM export, web page or pasted status that gets an agent to do something it
  shouldn't (call a tool, change a recipient, leak CRM fields into a draft)
- anything in the generated outbox page that runs script or loads something external
- files written outside floorboss's data folder

How floorboss is built to resist these: by default Claude drafts in the main session, with attendee notes marked untrusted and
the guard on; the critic, and the outreach writer agent used only when the user's own outbound instructions do the
writing, can only list file names (they can't read, write or call anything; the writer gets those instructions
inside its brief),
the researcher has web search and fetch only, scripts (not the model) parse every file and pasted status,
attendee notes are fenced as untrusted and never reach the critic, the outbox escapes every field, links only
to LinkedIn, known event apps and the event's own site, and its Content-Security-Policy blocks external
loads, and all data lives in `~/.floorboss/` (or `FLOORBOSS_HOME`) with private file permissions.

A guard hook (`hooks/guard.mjs`, with most of its rules in `hooks/guard/`) checks every MCP call and Claude's own file tools. Commands pre-approve only
floorboss's scripts and reads and writes in its data folder. Claude never reads keys, credentials, shell
histories or browser profiles, and never edits floorboss's records. While a run is under way (tied to the
Claude session that ran it, until that session ends), tools may only read, the browser opens only pages
floorboss has a reason to and never runs script, and Claude writes only to the data folder and the temp
folder. WebFetch is gated during a run too: it opens only LinkedIn profiles, known event apps and the event
sites the user named, and no web address or search query may run past 300 characters, a line break or an
email address, so WebFetch should not be on "always allow" in a floorboss session. Opening a browser window (to send notes in an event app or LinkedIn, or to log messages in your CRM) asks you at its first browser call, saying what the window lets the browser do; until you allow it, every call in it asks. The CRM log window is held to the same rules as the send window: only the CRM's contact, record,
search and task pages, only the listed messages and their people's own details typed, and a prompt with the
full text before each message goes in. During a run, saving a connection to a server setup didn't find, moving one to another server, or forgetting one asks you first; a subagent can do none of these, and a test call runs only on its own job's server. Every send, test call, CRM task, new CRM contact, browser note and logged message asks
the user, showing the full text; a batch of mailbox drafts asks once, listing who each is to. The one call that
doesn't ask is a follow-up draft you authorised for unattended drafts, inside a run floorboss's own scheduler
started, once every check holds ([What runs on its own](#what-runs-on-its-own)); nothing is sent that way. Names and notes from lists and CRMs are scrubbed before they appear in a permission prompt (letters and a little punctuation only, cut short, quoted, with the person's id and address beside them); the approved text is shown verbatim under its own label. A message floorboss already let through once says so at its next prompt, and a draft batch's yes puts each draft in once. A PostToolUse hook records an ask (a lookup counted, a draft batch confirmed, a window allowed) only after the call has run, so a declined prompt is asked again and never counts as a yes. If the guard can't start, crashes or runs past its own 20-second deadline, the call is blocked. A guard that hangs outright, past Claude Code's 30-second hook timeout, is blocked only on Claude Code 2.1.295 or later (the hooks set `onFailure: "block"`); older versions let that call through, so use 2.1.295 or later. The records live in
files a session could write, so that prompt is the final check: never set a send tool to "always allow".

### Reading the guard

The guard is split by topic, so a reviewer can take one file at a time:

| File | What it covers |
|---|---|
| `hooks/guard.mjs` | The entry point the hooks run. It reads the call, picks the rules that apply and allows it, asks you, or blocks it. It also holds the rules for Bash and agents during a run, and the ask-once logic for sends, staged drafts, CRM tasks, lookups and browser windows. |
| `hooks/guard/check.mjs` | The decision for one connected-tool (MCP) call: the run lock, the saved recipe, lookups, the browser, sends and staged drafts. |
| `hooks/guard/connectors.mjs` | What a connected tool does, judged by its name. Whether its arguments fit the saved recipe. Which servers floorboss was given. |
| `hooks/guard/test-calls.mjs` | The one test draft, task or contact that setup tries a connection with. |
| `hooks/guard/lookups.mjs` | Contact-detail lookups: the window you agreed to, how many are left in it, and what one lookup may carry. |
| `hooks/guard/sends.mjs` | Sends and staged drafts: each is checked against the text and recipient you approved. |
| `hooks/guard/daymark.mjs` | One message a day to a person: the marker for a person's day at an event, and the locks a send is checked and released under across all your events: one for the address it goes to, one for each address the person has alone at that event, and one for each inbox address of theirs (info@, hello@) together with their name. An unattended draft takes the same marker and locks. |
| `hooks/guard/browser.mjs` | Where the browser may go during a run, and what may be clicked or typed in a send window or a CRM log window. |
| `hooks/guard/prompts.mjs` | The permission prompts: the text you read before you say yes. |
| `hooks/guard/files.mjs` | Claude's own file tools: no read of keys or credentials, no write to floorboss's records or to the launchd file of its scheduled job. |
| `hooks/guard/shell.mjs` | Bash: calls to floorboss's own scripts, saving or forgetting a connection during a run, and no installing, loading or switching on of what floorboss runs on its own. |
| `hooks/guard/web.mjs` | WebFetch and WebSearch during a run. |
| `hooks/guard/run.mjs` | The run lock and the session: which tools are checked, subagents, forked sessions. |
| `hooks/guard/after-call.mjs` | What is recorded after a call has run. |
| `hooks/guard/unattended.mjs` | Unattended follow-up drafts: the opt-in and authorisation prompts and what their post hook writes, the run's ticket, the CRM judgements, and the guard's "allow", only in a ticketed run when every check holds, for three calls: the mailbox read and the CRM read for a person on the ticket, and that person's authorised draft. |
| `hooks/guard/witness.mjs` | What the guard reads itself in a mailbox's or CRM's raw answer in an unattended run. |
| `hooks/guard/shared.mjs` | Small helpers the rules share. |
| `hooks/plugin-root.mjs` | The folder the plugin is installed in, which the file and shell rules compare paths against. |

## Where your data can go

floorboss's own scripts make no network calls (`npm run self-check` checks this). Your lists, CRM records and
mail leave your machine only through Claude and the tools you connected, and the guard holds those calls
while a run is under way:

- **Messages, drafts, CRM tasks and new CRM contacts** carry only what you approved or what floorboss listed,
  to the one person listed, and ask you each time (the table below).
- **Web pages and searches** take no address or query over 300 characters, with a line break or with an
  email address in it. WebFetch opens only LinkedIn profiles, the event apps floorboss knows and the event
  sites you named. The researcher (the one agent with the open web) opens only pages its own searches found
  and the sites of companies on your list. Its brief is names, titles and companies, each person's segment, your company
  and goal, your proof lines, and whether a company is your customer or partner or in your CRM. It never gets your
  CRM's notes, owners or statuses.
- **The browser** opens only the pages floorboss has a reason to, under the same address limits. A CRM site
  where every customer has their own address (`yourco.my.salesforce.com`) asks you first.
- **People-data lookups** (Apollo, Clay and the like) carry one person you agreed to look up: their name,
  company, title or profile link, and nothing else.
- **Your other connected tools** (Notion, Drive, Slack, GitHub and the like) get nothing from the session
  that ran floorboss until it ends, reads included. Other sessions keep their reads while a run is live;
  nothing anywhere sends, writes or deletes then.
- **Claude Code tools floorboss has no rule for** (publishing a page, scheduled or remote agents, messages to
  other sessions) wait until the session that ran floorboss ends. A session you resume later gets the
  same limits back.

### What runs on its own

Two things, each only if you install it: the morning brief, and the follow-up drafts (macOS only for now; the
README says how). The brief is described first; the follow-up drafts after it.

- **You install it, in your own terminal.** `node scripts/unattended.mjs install-brief` prints what will
  happen, asks you to type "yes", writes one file, `~/Library/LaunchAgents/com.floorboss.brief.plist`, and loads
  it with `/bin/launchctl`. `install-brief`, `uninstall-brief` and `on` run only with a real terminal on both
  ends (keyboard and screen) and never from a shell Claude Code started; `--yes` skips the question, not the
  terminal. That file holds the full path of Node.js (the one your shell runs, when that is the same program),
  the full path of `scripts/scheduled.mjs`, the word `brief`, the time (07:00 on the machine's clock, every
  day, not at login) and `FLOORBOSS_HOME` if you set one, which must be an absolute path. It holds no token or
  password and starts no shell. The paths are checked and escaped before they are written; a path with a line
  break is refused.
- **What it reads and writes.** The job reads floorboss's data folder and its own plugin files (plus a list
  file an older event points at by path, as any floorboss script does). It writes the brief (`agenda.html`,
  `agenda.md`, `agenda.ics`, `today.html`), the views floorboss rebuilds on every read, and its own log and
  state in `unattended/`. It writes nothing to the ledger, never writes through a link, and reads `today.html`
  and its own files only when they are plain files.
- **What it never does.** It starts no model and no Claude session, uses no network, calls no connected tool
  and sends nothing. The one process it starts is your system's opener, by its full path (`/usr/bin/open`),
  on the brief's page. A second thread stops it after 60 seconds, and does nothing else first. The page it
  opens is one it rendered in that same run, from the facts and from floorboss's record of saved talking
  points: no file on disk is ever the source of it. Whatever is at `agenda.html` or `today.html` is replaced
  where it differs, so the page opened loads nothing and runs no script.
  Every piece of list, CRM, mail and news text on it is escaped, has invisible and control characters taken
  out, and a news link is a link only when it is a plain web address.
- **A saved agenda.** The page is rendered again on every run. When an agenda with talking points was saved
  for that same day and every fact on it (the news shown included) is unchanged, that rendering is byte for
  byte the saved page and nothing is written. Otherwise the page comes out as the facts are now. Talking points are carried over, from
  floorboss's own record of them, only for meetings whose facts did not change; when some are missing the page
  says so in one line. A record of them that can't be read carries nothing over.
- **Claude can't install it, remove it or switch it back on.** The install script runs only in a terminal.
  And in every session the guard refuses these names:
  - `unattended.mjs` with anything but `off` or `status`;
  - the job (`com.floorboss.…`) or its launchd file;
  - the word `launchctl` with, anywhere after it in the same text, a word that loads or starts a job or runs
    a command through it: `bootstrap`, `load`, `enable`, `kickstart`, `start`, `submit`, `asuser`, `bsexec`;
  - floorboss's `unattended` folder, and a write, move or removal of `today.html`.

  Where it reads them: in Bash, PowerShell and Monitor commands, as written and again with quotes, `$'…'`,
  backslashes and backticks removed, and with the braces and commas of `{a,b}` removed (not expanded: see the
  limits below); and in the input of a connected (MCP) tool that isn't plainly a read, all of its values
  joined into one text (so a program in one field and its arguments in the next read as one command).

  What can't be written: the launchd file; any file in a folder launchd loads from whose text names the job,
  names a `scheduled.mjs` or an `unattended.mjs` (whatever path leads to it: `~`, `$HOME`, a `cd` first, a
  working folder), or names anything in this plugin's folder; anything in `unattended/`; `today.html`; and
  floorboss's other records. That holds for Claude's own file tools and for a connected tool that isn't
  plainly a read, where up to 50 short paths in the input are followed through links, for at most a second.
  It also refuses another project's own `scheduled.mjs` in a launchd file: write that one yourself. A
  different file whose name merely ends in those words (`rescheduled.mjs`, `my-scheduled.mjs`) is not refused.
  The launchd file's text is not parsed: it is decoded as Apple's reader decodes a string and read both with
  `<!-- … -->` taken out and with it left in, so the job's name inside a real comment is refused too.

  What is too large to read is refused for those connected tools with a plain message, not passed unread:
  more than 2 MB of values (each string, number or true/false counted by its own length), more than 512
  levels of nesting, more than 50 strings with a slash in them that name one of these places, or one such
  string over 1,024 characters that has no space in it (a longer one with spaces is read as text, not followed
  as a path).

  A tool is "plainly a read" by its name alone: every word of the name is looked at, one must be a read word
  (`get`, `list`, `search`, `read`, `fetch`…) and none a word that writes, runs, sends or joins two actions
  (`check_and_fix`, `fetch_to_path`). Such tools are not looked at by this rule. floorboss can't see what a
  tool does: one named like a read that writes or runs a command is not caught.

  A few exact read-only commands on floorboss's own job are let through (`launchctl print` on it, `cat`,
  `ls -l` or `plutil -lint` on its launchd file, `ls` and `cat` in `unattended/`). Turning it off is always
  allowed: `/floorboss:unattended off`. Tests: `test/security-unattended.test.mjs`,
  `test/security-schedule-differential.test.mjs` (1,563 cases from four reviews, and 200 recorded launchd files),
  `test/security-guard-speed.test.mjs`, `test/unattended-install.test.mjs`, `test/brief.test.mjs`.
- **Removing it.** From your terminal, `node scripts/unattended.mjs uninstall-brief` unloads the job and
  deletes the file. Disabling or uninstalling the plugin leaves the launchd file behind, pointing at a script
  that may be gone; remove it with that command first, or delete the file and log out and in.

#### Unattended follow-up drafts

With it on, an approved follow-up can go into your mailbox's drafts folder on its day with no prompt. Nothing is
sent: you read each draft and press Send. It is the only place floorboss's guard returns "allow" instead of "ask", and
it does so for three calls, all in a ticketed run: the mailbox read and the CRM read for a person on the run's ticket,
and that person's authorised draft. In that run those three calls skip your own Claude Code prompt rules.

- **Turning it on: three steps, each yours.** `/floorboss:unattended on` shows what happens with nobody there and
  asks you to type "put my approved follow-ups in my drafts without asking me". Claude passes your words to
  `connectors unattended-on`; the guard checks them and raises a Claude Code prompt that names the event and its
  last day. Only the PostToolUse hook, after that very call ran, writes `unattended/optin/<event>.json`; a declined
  prompt writes nothing. Then, in your own terminal, `scripts/unattended.mjs install-followups` shows the warning
  again, asks you to type a six-letter code, records the Claude Code program on your PATH, writes
  `~/Library/LaunchAgents/com.floorboss.followups.plist` (Node.js, the launcher, the word `followups`, every hour
  of the day, never at load, no token) and loads it. The guard refuses that step, and the launcher's own
  mode, in any session.
- **Authorising: one prompt for the whole sequence.** `outreach authorise-unattended` makes the guard show every
  approved email follow-up of the event that could go on its own: each person's quoted name, id and address, its
  day and its whole text. Only a text the critic passed counts (never a skipped review or an approval past a
  fail). Only the PostToolUse hook writes `unattended/authorised.jsonl`, and only if the list is still the one the
  prompt showed. Each line is bound to the approval's hash, the address, the thread and the fingerprints of the draft
  and mailbox recipes; a change to any of them means not authorised.
- **The run.** Each hour the launcher works out from floorboss's records, with no model, what is authorised and due.
  With nothing due it ends. Otherwise, with no floorboss run lock live in any session and no other unattended run,
  it writes a one-time ticket (`unattended/tickets/<session>.json`: a fresh session id, the sha256 of a random 32-byte
  token, the items) and starts `claude -p` with that session id, `--permission-prompts none`, `--no-chrome`,
  `--no-session-persistence`, the agent, web, browser and scheduling tools refused, and the token in its
  environment. It never passes `--bare`, `--safe-mode`, `--dangerously-skip-permissions` or a permission mode, and
  it refuses to start one with any of them, or with `--environment`, `--allowedTools`, `--add-dir` (and, outside
  floorboss's own tests, `--plugin-dir` or `--mcp-config`). self-check pins where that list is checked and the main
  flags; `test/unattended-fixes.test.mjs` holds the rest. The run gets the launcher's environment without a variable
  that loads code (`NODE_OPTIONS`, `BASH_ENV`, `DYLD_*` and the like) and, outside the tests, without floorboss's test
  switches; the launchd file always names your data folder. Each run is a Claude Code session on your account and
  counts toward your plan's usage and limits. It never starts from a Claude Code shell, stops the run after 40
  minutes, and the summary is written from the log afterwards. A run whose launcher was stopped before it ended (the
  Mac slept or was turned off) is ended at the next launch, so its lock doesn't hold later runs.
- **The ticket.** The guard counts a session as the scheduled run only when its SessionStart hook saw a fresh
  `startup` of that exact session id with the token, within 15 minutes of the ticket, once. A resume, a compact, a
  fork, a subagent, a wrong or missing token, or a ticket already used never counts. In a session with a token,
  every call that would ask is refused instead, Bash runs only the run's own steps (`flow next --unattended`,
  `flow run-end` and `crm-judge`), and only three connected-tool calls pass: the mailbox read and the CRM read for a
  person on the ticket, and the draft. The first refusal of anything in the run stops it.
- **What the guard reads itself.** A read passes only when its arguments are exactly its saved recipe filled with
  the run's own values for that person (their address, the day before the email this follow-up answers, the thread,
  the CRM record bound at the authorisation, your address, their name): a later day, text after the day, another
  thread, a value the model chose, or a key left out (or added, even holding an empty object or list) is refused.
  After the mailbox read, the guard's PostToolUse hook reads the tool's raw answer (a Gmail-like or Outlook-like
  shape) and counts what came from anyone but you since then; an answer with nothing in it, not even your own email
  it answers, is unreadable. With a Gmail-like reader (get_thread or search_threads, as the claude.ai Gmail
  connector has, on a server named for Gmail), two fixed reads replace the saved one in a run: the whole thread
  (get_thread, metadata only) and a search of every folder but Spam for anything from them or to them since 15
  minutes before the guard let that email or its draft through, in epoch seconds (only when that time is no later
  than the send's own record and the end of its day, with a day's slack), or else since the day before it
  (search_threads). The
  search must prove it covered that time: it must show your own last email to them (by its message id when floorboss
  has one, and then no other email of yours stands in for it; by a message of yours dated since the start only when
  it has none) and every message of each conversation it shows (only the thread of that email, which the thread read
  reads whole, may show fewer; a message count must be a whole number). Gmail's message count includes a thread's
  drafts, which it never shows: in the thread of your last email (in the search and in the thread read) a count above
  what is shown is no hold, and in any other conversation it holds the draft. An empty answer, or one without your email,
  holds the draft as a search floorboss can't trust. Anything from them, from someone else in a conversation with
  them, or an email you wrote to them yourself after your last floorboss one holds it too. In the thread of your last
  email only what is dated since the start counts. In any other conversation the search shows, every message from
  them or from anyone else but you holds the draft, whatever its date says: Gmail already kept the search to what
  came in since the start, and a date that reads older is no reason to trust it. One that shows none of its messages
  is unreadable. What this proves is that the search covered your own email: the `after:` start, sent mail and the
  `to:` half of the group. It can't show that `from:` matched inside the group (a connector that rewrote the query
  could drop it, and a reply from them in a new thread would then go unseen); no code can prove that without a
  message from them. Real calls to the claude.ai Gmail connector (15 November 2026) took the grouping, `from:`,
  `to:`, `in:anywhere` and `after:` in epoch seconds (exact to the second). Its own description says `in:anywhere`
  covers Trash but leaves out Spam (and mail it treats as confidential, encrypted or suspicious), so a reply that
  Gmail put in Spam isn't seen. A draft that replies by message id
  must reply to your latest own message in the thread the guard read, dated since that start. An answer is read
  only in one form: text and structured data that disagree, an error text, a search answer with anything beside its
  conversations and Gmail's own guess of how many matched (`resultCountEstimate`, never read), such as
  `omittedContent`, or one with no tool-result wrapper, is unreadable; so is a date it can't place for sure, a sender
  with two addresses, and an address outside plain ASCII for the search. After the CRM read, what
  the CRM logged since then (by when it was logged, too), split into what came from them, floorboss's own emails as
  the CRM logged them (the same subject within a day of each send, one per send), and the rest. "From them" is held
  by code: a message or email from their address, an inbound call, a meeting, an opt-out, a bounce, a logged
  LinkedIn, SMS, WhatsApp or chat message, a call with no direction and any kind of activity floorboss doesn't
  know. It writes `unattended/witness/<session>/`. Once it saw anything from them in a run, that person stays held
  for the rest of the run, whatever a later read shows. An answer it can't read whole (another shape, an error, one
  page of several) is no witness: the draft is held and the run stops. A reply check Claude records never counts
  here. A call that fails after it was let through (Claude Code's PostToolUseFailure) counts as an answer it couldn't
  read.
- **Claude's judgement.** For each activity in "the rest", the run's model records hold or go and a one-line reason
  (`outreach crm-judge`). The guard records it only for the activities its own witness listed, only "hold" or "go",
  and records a "go" on an activity whose own text speaks to floorboss or Claude as a hold. A hold, once recorded,
  stays for the run. Anything from the contact holds whatever the model says. Every judgement and reason goes in the
  log and the summary. Only the CRM activity your CRM activity reader (`crm.activity`) returns is read: a reader that
  lists only emails never shows calls, notes or stage changes. A CRM connected with no activity reader (only a
  lookup) holds every draft, with the reason and how to fix it, and the opt-in says so first; only with no CRM
  connected at all is email alone checked. With Salesforce or Close connected (floorboss can't read their activity
  on its own), every draft is held.
- **The draft's allow.** The guard returns "allow" for one stage_draft call only in a ticketed run, when all of these
  hold: the opt-in is live and not switched off, no earlier draft in this run is waiting on its result, the schedule
  is installed for this version, the follow-up is one of the ticket's and authorised exactly as it is now (and its
  due day is not earlier than the one the authorisation showed), no draft of the same step is going in from a
  session with you there or went in from one (or failed there) with no receipt saved, for any text of the step, no Salesforce or Close CRM is connected, it is a
  follow-up by email, your last email to them went to that
  address, in that thread, through a floorboss prompt you allowed, the critic passed this text, both reads are this
  run's and under 90 seconds old and clean, every CRM judgement is in and "go", it is a weekday from 09:00 to 17:00
  in the event's zone, its due day or the next, not after the event's last day, and every check a send or a staged
  draft has (the recipe and its exact arguments, the thread, one message a day per person across your events, a
  stop, a reply, a bounce). Your word that a draft isn't in your drafts folder (`outreach draft-missing`) gives that
  step its day back, so its next draft can go in the same day as the one you said isn't there. It also reads every other event's ledger for that address: anything that holds the
  person there, or anything done about them there since the authorisation or the email it answers (an approval, a
  send, a draft, a hold, a decision of yours), holds the draft. All of it comes from the ledgers and the stored
  authorisation, never from the outbox page or another rendered view. It then takes a once-only mark and writes `stage_released` to the ledger, marked
  unattended, before the call runs. Anything else is refused with the reason, and the run stops there.
- **What you see.** `unattended/log.jsonl` has every decision. Each day's `summary-<day>.md` is built from it
  alone, with times in the event's zone. The next attended floorboss run shows it first, the reminder hook mentions
  it once, and the ledger marks the drafts as unattended. A draft let through whose result never came back is said
  as "may or may not be in your drafts folder": nothing else goes in for that person until you look; if it isn't
  there, your words (`outreach draft-missing`, which the guard puts to you in a Claude Code prompt naming the person
  and the follow-up; only its PostToolUse hook writes `stage_cleared`) let that step go in again, once. A due follow-up that can't go in is
  said too, once: floorboss in use in the 30 minutes before the run, a weekend in the event's zone, or an earlier draft
  floorboss hasn't seen sent yet. A finished case (they replied or booked) is said once, as over.
- **Turning it off.** `/floorboss:unattended off` (allowed in any session) or `unattended.mjs off`: the same switch
  stops the brief. `uninstall-followups` removes the job. The opt-in ends with the event's last day.
- **What it can't see.** Replies on LinkedIn or in the event app: check those inboxes regularly and tell floorboss
  or your CRM when one comes in. If you installed the morning brief, the morning page names the people written to
  there whose draft can go in on its own that day.

### What floorboss can't control

- **Anthropic.** floorboss runs inside Claude Code, so what Claude reads (your lists, CRM records, mail,
  web pages) is sent to Anthropic's model as part of the conversation, under your Claude account's terms.
- **Your session files.** Claude Code keeps each conversation in `~/.claude/projects/`, outside
  floorboss's private data folder. If that folder is synced or backed up, so is what Claude read.
- **Claude Code's own settings.** Its permission mode decides whether a call the guard lets through still
  asks you. Auto-approve or "always allow" on a send tool removes that prompt; don't use them for floorboss.
  floorboss's own unattended drafts are separate: you turn them on in three steps, and they never send.
- **The services you connect.** A CRM, mailbox or people-data tool keeps and logs what it's given under its
  own rules (CRM audit logs, what coworkers can see, a vendor's retention).
- **Web search and pages.** Searches go to the search provider Claude Code uses, and the pages the browser
  opens run their own scripts and trackers. A LinkedIn profile you open while signed in shows you as a
  viewer.
- **Delivery.** Mail, chat and LinkedIn providers handle every message that's sent.

## Everything floorboss can write, and where

Apart from floorboss's own files, nothing below happens without your yes for that kind of write in setup, and
the "Asked" column says when it asks you again, showing what goes where. The guard holds every connected-tool
call to the saved recipe for that tool: the same server, the same tool, and only the fields listed here.
Anything else is refused.

| What | Where it goes | What it can carry | Asked | Held by |
|---|---|---|---|---|
| A send (email, chat) | your mailbox or chat tool, to one recipient | the approved message, word for word: recipient, subject, body, and the thread of their last email | before every message, with the whole text | guard: one listed, approved item, sent once; `test/security-guard.test.mjs` |
| A draft in your mailbox | your own drafts folder | the same fields as a send; nothing is sent | once per batch, naming who each is to | guard: listed drafts only; `test/security-round3.test.mjs` |
| An event-app note (LinkedIn is still in progress; see the README) | the app, in your browser | the approved note, to the profile floorboss listed | before every note, with the whole text | the browser send window: only the platform of a listed note (the app, or LinkedIn for a LinkedIn note you turned on), each note once, no script. It can't see which profile the page shows, so the prompt names the person and platform; `test/security-round2.test.mjs`, `test/audit-run5-fixes.test.mjs` |
| A CRM task | your CRM | a title, a body, a due date and the one contact it's about | before every task | guard: listed tasks only; `test/security-round7.test.mjs` |
| A new CRM contact | your CRM, the server floorboss reads people from | name, email, company and title, as on the list; no owner, list, stage or other field | before every contact; each person once | guard and once-only marker; `test/crm-new-contacts.test.mjs`, `test/security-round8.test.mjs` |
| A logged message | your CRM record for that person, in your browser | the message as sent; with your yes in setup, their LinkedIn address and title where the record has none | before every message, with the full text | the CRM log window: only the CRM's contact, record, search and task pages; `test/security-round2.test.mjs` |
| A new CRM contact, in your browser | your CRM's web app | name, company, title, email and LinkedIn address, as listed; only someone the CRM search didn't find, so a message to them can be logged | once per batch, naming each person, if you chose "ask" in setup (the recommended answer); only at setup if you chose "yes"; never if you chose "no" (the default) | the CRM log window: every value typed must be a listed one. The guard can't tell a search box from a new-contact form, so it can't stop those listed values going into one. A result reporting a contact floorboss didn't list is recorded as failed. Tested in simulated runs, not yet against a real CRM. `test/browser-new-contact.test.mjs` |
| A people-data lookup | your people-data tool (Apollo, Clay and the like) | the person's name and company, to find an email | the count first, then the calls | the lookup window, and only as many as you agreed |
| Files | `~/.floorboss/` (or `FLOORBOSS_HOME`), and the temp folder | your event records, drafts, the outbox page | no | guard: Claude's file tools write nowhere else during a run; `test/security-supplychain.test.mjs` |
| A follow-up draft, unattended (only if you turn it on) | your own drafts folder, in your thread with them | the authorised follow-up, word for word; nothing is sent | once, at authorisation, with every follow-up's whole text; then not again | guard: ticket, authorisation, the reads it witnessed, the time rules and every staging check; `test/unattended-drafts.test.mjs` |
| The follow-up drafts' launchd file (macOS, only if you install it) | `~/Library/LaunchAgents/com.floorboss.followups.plist` | the paths of Node.js and floorboss's launcher, the word `followups`, the hours, `FLOORBOSS_HOME` if set | by the install itself, in your terminal, with a typed code | written only by `scripts/unattended.mjs`; the guard refuses it from a session; `test/unattended-launcher.test.mjs`, `test/security-unattended-drafts.test.mjs` |
| The morning brief's launchd file (macOS, only if you install it) | `~/Library/LaunchAgents/com.floorboss.brief.plist` | the paths of Node.js and floorboss's launcher, the time, `FLOORBOSS_HOME` if set | by the install itself, in your terminal, before it writes | written only by `scripts/unattended.mjs`, which you run; the guard refuses it from a session; `test/unattended-install.test.mjs`, `test/security-unattended.test.mjs` |

Through a connected tool, floorboss never deletes or merges a record, never changes a field that has a value, never
changes who owns one, and never adds anyone to a list, sequence or campaign. The one update is the logged message's:
with your yes in setup, it fills a person's LinkedIn address and title where their record has none. Inside a browser
window, floorboss has no step that does any of these, but the guard doesn't check clicks (see
[Limits we know about](#limits-we-know-about)).

## Check it yourself

You don't need to read floorboss's code to check the main claims. From a copy of the repository, with
Node.js 22 or later:

```
npm run self-check
```

It changes nothing, installs nothing and makes no network call. It checks, and prints each result:

- `package.json` has no dependencies and no install scripts, and there's no lockfile or `node_modules`;
- every import is a Node.js built-in or one of floorboss's own files;
- no script, and no test it runs, uses a network module, `fetch` or a remote import (a pattern search, not proof);
- the only processes floorboss starts are Node.js running its own scripts, and your system's opener for the
  outbox page and the morning brief's page (it prints each place);
- `launchctl` is started by one script only, `scripts/unattended.mjs`, the install you run in a terminal, by
  its full path (the guard also names it, to refuse it); the scheduled launcher starts two processes, the
  opener by its full path and, for the follow-up drafts, Claude Code by the path the install recorded, with the
  arguments `claudeRun` builds and `argsRefusal` checks, word for word; the stand-ins the tests use for all three
  are read only under the tests, and nothing in floorboss's code sets that switch;
- the hooks run only `hooks/guard.mjs` and `hooks/remind.mjs`;
- floorboss's code creates its data folder private (0700 folders, 0600 files); this reads the code, not the
  folder on your machine;
- every GitHub Action in CI is pinned to a full commit, and no workflow can write to the code;
- the security tests pass, in a throwaway home folder that isn't yours.

Then, in Claude Code, `/hooks` lists every hook and the command it runs.

## How the repository is kept

- **CI** runs the tests on Node.js 22, 24 and 26, and the self-check on Node.js 22, on every push. Its workflows start with no
  write access, keep no token on disk after checkout, and pin every action to a full commit, with a test that
  fails if one isn't (`test/workflows.test.mjs`). The actions used are GitHub's own (`actions/checkout`,
  `actions/setup-node`, `github/codeql-action`) and the OpenSSF's Scorecard. None of them is part of what you
  install: they run on GitHub's machines against the repository, never on yours.
- **Dependabot** proposes updates to those pinned actions, and only after a new version has been out for 7
  days, so a bad release has time to be noticed. Each update is reviewed before it's merged.
- **OpenSSF Scorecard** grades how the repository is run (branch protection, pinned actions, signed releases,
  token permissions) every week and publishes the score. Its own action runs a container its maintainers name
  by tag, which a commit pin can't fix, so that job is kept apart with no write access to the code.
- **CodeQL**, GitHub's code scanning, runs on every push.
- **Secret scanning with push protection** blocks a key or token from being pushed.
- **Reviews.** floorboss's security reviews were done with AI agents that had no part in
  building the code, each given only the code and the claims to break, with the fixes kept as
  tests (`test/security-*.test.mjs`).

## Supply chain

floorboss has no third-party packages: no dependencies in `package.json`, no lockfile, and no install
scripts, downloads or network calls of its own. What runs is the code in this repository, on Claude Code
and your own Node.js. The repository itself is therefore the thing to protect and to check: its hooks run in
every Claude Code session while the plugin is enabled. The README's
[Dependencies and supply chain](README.md#dependencies-and-supply-chain) section covers what the hooks do,
how to pin a release by commit, and how to check one. A report about anything that could change what a
user installs (the release process, CI, the marketplace file) is as welcome as one about the code.

## Limits we know about

- **Your environment.** Some of floorboss's checks rely on settings Claude can't put on its own commands (the
  guard refuses a floorboss script call with anything before `node`). Whoever controls the environment Claude
  Code starts in (a shell profile, a settings `env` block) could change them; so could a shell command run
  in a session that never ran floorboss, if your settings let it run without a prompt.
- **The scheduled job's name rules.** The rules under "What runs on its own" match names in a text. They have
  no model of the shell. What they do not catch:
  - a name built when the command runs: a variable (`V=load; launchctl $V`), a wildcard (`launchctl loa*`), an
    escape the shell decodes (`$'\x6c…'`), base64, percent-encoding, or a name split across two fields of a
    connected tool's input;
  - a brace list with a real alternative (`launchctl lo{a,b}d x`): braces and commas are taken out, not
    expanded, so `lo{a,}d` is read as `load` but `lo{a,b}d` as `loabd`;
  - the start word written before `launchctl` (`echo load x | xargs launchctl`): the rule looks after the word;
  - an empty expansion inside a word (`lo$@ad`), and spaces written in code to an inner shell (`sh -c
    "launchctl$IFS""load"`);
  - a launchd file in the old (OpenStep) text format with a name written in `\U0062` or octal escapes;
  - a path in a launchd file that climbs through more than 40 rounds of `x/../` to reach the plugin's folder;
  - in a connected tool's input, a path beyond the first 50 path-like strings: only those are followed, so a
    51st that reaches a protected place through a link under another name passes;
  - two launchers started at the same instant over the lock of a run that died: both can run, and the page
    may open twice;
  - a copy of the install script under another name, a link to it made without naming the plugin's folder (`ln -s`
    with the folder's path is refused), and a relative file name with no folder;
  - another scheduler (cron), and a shell command that writes into floorboss's data folder without naming any
    of this (`rm -rf ~/.floorboss`), in a session that never ran floorboss, where Claude Code's own prompt for
    the command is the check;
  - a connected tool named like a read that writes or runs something (`d1_database_query`, `navigate`,
    `query`): the name is all the guard has.

  The install script's own tests (a terminal, not Claude Code's shell) are not a lock against a program that
  runs as you: a terminal can be faked. This is accepted for what the job is: a shell that runs without a
  prompt can already write any launchd job of its own, and floorboss's job only builds and opens a page it
  rendered itself. Nothing that sends relies on this gate, and nothing that sends will.

  What the rules cost: `launchctl` with one of the start words anywhere after it is refused even when the word
  isn't launchctl's own (`man launchctl | grep bootstrap`, `launchctl list; npm run start`, a commit message
  about `launchctl load`), so with floorboss installed Claude can't load or start any launchd job for you; a
  command that only mentions `unattended.mjs` or `com.floorboss.` is refused; a launchd file that names any
  `scheduled.mjs` or `unattended.mjs` is refused, another project's own included; and a connected tool that
  writes is refused when its input names any of these (a Slack, Notion, Jira or GitHub write that quotes a
  `launchctl load` command), when it mentions floorboss, `today.html` or the `unattended` folder and a word
  like "remove", "move" or "write" together (a note about cleaning up floorboss's page), or when it is too
  large for one pass (the caps above). Do those from your terminal, or
  turn the plugin off for that session.
- **Unattended drafts.** What they rest on, and what is left:
  - A shell that runs as you without a prompt can forge any file here, a ticket and an authorisation included
    (the "Your environment" limit). The difference from an attended run: no prompt meets a forged draft. That is
    why only a follow-up to someone you already emailed through a prompt, in that same thread, goes in, and why
    nothing is sent: your own Send in your mail app is the last check.
  - The guard's "allow" lets a call through only if Claude Code honours a hook's allow over its own prompt
    [believed: Claude Code's docs]. With `--permission-prompts none`, anything that would still prompt is denied, so
    a mistake here fails closed.
  - The run's token is in its own process's environment, so its own shell commands could read it; there, Bash runs
    only the run's own steps, and the guard refuses any command that names the token. The ticket is bound once, at
    the session's fresh start, but a hook can't tell processes apart: a second process with the run's session id
    and token would pass as the run. The token is only in the run's own process tree (its stdio MCP servers
    included, believed), so that adds nothing the run itself couldn't do.
  - The mailbox and CRM reads are as good as their search: a reply to another address, in a folder the tool
    doesn't search, or by phone isn't seen. Replies on LinkedIn or in the event app aren't seen at all.
  - Claude's judgement of CRM activity can be wrong. It can only hold a draft or let the approved text go in, and
    the summary shows each call with its reason the same day.
  - When floorboss ran something in the last 30 minutes (its run lock's own window), the schedule waits for the next
    hour. A session that ran floorboss and is only left open doesn't hold it, so a run can start while that session is
    still open: the once marks, the day markers and the attended draft marks keep two drafts of one step apart. An
    attended draft whose Claude Code prompt is still open holds that step's unattended draft for 12 hours, in the
    launcher and the guard. Once that prompt is allowed and its call runs, however long after its stage list and even
    if the list was written again since, the post hook marks that call as gone in (by the note the guard kept for that
    call). A prompt left open more than 12 hours and then allowed can still put a second draft of the step in, if an
    unattended run put one in meanwhile. An attended draft of a step that went in with no receipt saved, or whose
    call failed after it was let through (Claude Code's PostToolUseFailure), holds that step's unattended draft as
    "may or may not be in your drafts", in the launcher and the guard, whatever text it was for (one from before you
    changed and approved the text again included), until its receipt is saved or you say it isn't there (`outreach
    draft-missing`). A call mark floorboss can't date holds the step until you run floorboss once with you there. A
    draft of an older text of a follow-up (one an unattended run let through, or whose receipt was saved, before you
    changed and approved the text again) holds that follow-up's unattended draft, in the launcher and the guard, until
    you say it isn't in your drafts folder (`outreach draft-missing`, once you deleted it); the authorisation prompt
    names it.
    All of this relies on Claude Code giving each call its own id (`tool_use_id`): the guard keeps each draft call's
    note by it, so a staged draft call that comes with no id is refused, with you there or not. A run lock file that
    can't be read keeps the schedule waiting, said as that.
  - In any session the guard refuses a shell command that runs its own hooks (the plugin's `hooks` folder by its
    path; node on a file named `guard.mjs` with a hook's word such as `post` or `PostToolUse`, in any folder; or node
    with the guard named from inside the plugin folder), that links the plugin folder (`ln -s`), or that writes
    floorboss's ledger or release marks (a wildcard on the name's end, such as `ledger.json?`, included). Before
    matching it reads `~` and `$HOME` as your home folder, `//` and `/./` as `/`, and `/private/tmp` as `/tmp`. Like
    the other name rules it reads text, not the shell, so a path built some other way isn't seen: a copy of the
    guard under another name, or a hook's input read from a file by a command with no hook word in it.
  - The run's command pre-allows file writes under `~/.floorboss` only. With `FLOORBOSS_HOME` somewhere else, the CRM
    judgement file can't be written there without a prompt, so a run that needs a judgement holds and stops (fails
    closed).
  - Your own earlier email is told from theirs by `own_email` (and its `+tag` forms). Sent from another alias, it
    counts as in from someone else, and the draft is held (fails closed).
  - Not yet tested on a real Mac: launchd starting the job after sleep, and claude.ai connectors and your login in
    a run launchd started with the screen locked. The end-to-end test (`test/e2e/unattended-headless.test.mjs`,
    stand-in connectors only) is run by hand.
- **The guard's deadline.** The guard gives itself 20 seconds. A check that is still waiting then is stopped
  by a timer; a check that held the process past it is refused when it finishes, whatever it found. A send is
  checked against the deadline again just before its release is written, a second short of it, so a send refused
  for time leaves no release and no marker behind. A check that never returns at all is left to Claude Code's own
  hook timeout (blocked on 2.1.295 or later).
- **One message a day across your events.** The guard takes a lock for the address the message goes to, each
  address the person has alone at the sending event, and each inbox address of theirs together with their name (in
  one sorted order, so two calls can never each hold a lock the other is waiting for), checks every event's ledger
  for those addresses under them, then writes the release.
  Each lock holds the process id of the guard that took it: a lock whose guard has ended is broken at once, and
  one with no readable id (a guard killed before it wrote it) holds that address for up to a minute. A lock broken as stale is never given
  back, and a send checks that its locks are still its own just before its release, so two calls can't both hold
  one. A new lock that a stale break renamed away in a race is left under another name, and removed once it is a
  day old, the next time a lock is taken. A guard's mark for a message with no release counts as a send that may
  have gone only once it is a minute old: before then it may be a call still being checked, and nothing can settle
  it. A draft put in your drafts while you are there writes no release, so it holds nothing at your other events:
  you send it yourself. An unattended draft is different: the guard takes the same locks and the person's day mark
  for it, and the release it writes (stage_released) counts as that day's message to them at every event, as a
  send's does. The rule is by address: two events count as writing to one person when they share an address for
  that person (an email, a profile link, an address a message was approved to go to, a new address after a
  bounce), for a send recorded there and for one let through there. A coordinate note's approval names the
  colleague it goes to, not the person, and adds no address. An address that two people's list entries at one
  event both have is no one's alone: it counts only for a message that goes to that address (a send recorded with
  no channel counts as an email), never for their other addresses, so a LinkedIn note to one of them never holds
  the other's. Who has an address comes from the list entries (and merges): an approval or a bounce that names
  another person's address doesn't make it shared. An address on the inbox list (info@, hello@, hi@, contact@,
  team@, office@, sales@, press@, media@, tips@, news@, admin@, support@, enquiries@, inquiries@, enquiry@,
  inquiry@, jobs@, careers@, hr@, marketing@, events@, partnerships@, mail@, post@, service@, kontakt@,
  redaktion@, presse@, vertrieb@, buero@, reception@, frontdesk@, booking@, bookings@, accounts@, accounting@,
  billing@, invoices@, orders@, ops@, operations@, general@, welcome@) links two events only together with the
  person's name (case, accents, a title like Ms. and the order in "Doe, Jane" aside; a nickname or a typo is
  another name): the same name with that address at both is one person (a solo owner's hello@), and for someone
  with another name it counts only for a message that goes to it. Two different people with the same name and the
  same inbox address count as one. The merge never joins two people by such an address. Someone each event knows
  only by addresses the other doesn't have is not recognised, and their messages are checked under locks that
  share nothing. Nor is someone each event knows only by an inbox address under two different names: there, only
  two messages to that address itself count as one address's.
- **Inside the CRM log window.** Once you allow the window, the browser may type a listed person's own details
  (name, email, company) to find their record, and floorboss can't tell a search box from a new-contact form. It
  never types anything else there, and each message's text still asks.
- **Clicks in a browser window.** Once you allow a window, the guard checks the pages it opens and the text it
  types, but not what it clicks. For up to 20 minutes, a click on an allowed page (Delete on a CRM record, for
  example) gets no further prompt from floorboss. Watch the window while it's open, and close it if the browser
  does something you didn't ask for.
- **What the researcher opens.** It's held to hosts its searches returned and to the domains of people on your
  list, with their subdomains. Text that steers it could send it to a search only an attacker's page answers, and
  an attendee can register with a domain they control. A link to such a site could carry what the researcher
  holds: names, titles and companies, your label for each person's segment, your company and goal, your proof lines,
  and whether a company is your customer or partner. Email addresses are refused.
- **Search during a run.** Claude's search shows matching lines only from floorboss's data folder, but it can
  still list matching files elsewhere and open them, apart from the key files Read refuses by name.
- **Screen-control tools.** A remote-devices server's browser tools are held as a browser, but its `computer_*`
  tools (clicks and keys on the whole screen) aren't: they get the limits any other server's tools get, and
  floorboss can't see which page or app they reach.
- **A declined lookup.** floorboss can't see a lookup that never ran (declined at a prompt, failed, stopped, or
  blocked by another hook): it holds one of the lookups you agreed to until that window ends, so the count runs out
  early rather than late. A lookup allowed more than a day after floorboss let it through isn't counted.
- **What you say through Claude.** An answer reaches floorboss as text Claude passes on. floorboss saves an
  answer only for the question it's asking right then, but it can't tell your words from words Claude made up.

## What floorboss has to take on trust

floorboss's scripts decide who is held, what is approved and what may be sent, and they read those
decisions only from records Claude's file tools can't edit (the guard refuses those writes; the files
themselves sit in your home folder, so the prompt before each send stays the last check). Some inputs to those records still come through Claude, and
floorboss can't tell a faithful relay from a made-up one:

- **Your words.** Approvals, drops, "skip review", lifting a hold ("decide reach"), what you say happened
  ("sent", "booked", "stop") and your setup answers all reach the scripts as text Claude passes on. The
  permission prompt before each send shows the full text and anything you released, so read it. At the
  shortlist and approval gates, an answer that isn't made only of the gate's own words, IDs and whole names that
  can mean one person is read back by ID and name and saved only on a following "yes", "ok" or "sure" (the reading waits in the
  event's `derived` folder for 30 minutes, and a change to the list, to the shortlist, to a draft or to the critic's verdict on one drops it). A waiting reading is not an
  approval: nothing can be listed or sent from it. The "yes" is text Claude passes on like any other answer,
  so the read-back is shown to you and the yes must be yours. Answers the code can't read are read by the model,
  by ID only, and always shown back, quoting your words, for a yes before anything is saved. The waiting
  reading (`derived/pending-*.json`) carries no signature: it is one of floorboss's records, which the guard keeps
  Claude's file tools (Write, Edit) from writing, like the ledger; only floorboss's scripts write it.
  The words that settle a send that may have gone (`send-list --resend`, `send-outcome`) and that say nobody
  replied (`--no-reply-check`) are text Claude passes on too. The prompt before the send that follows says when
  floorboss let that message through before.
  In floorboss's own sentences, list and CRM text is reduced to letters, digits, spaces and : ( ) , . / -; the card's
  structured fields (a person's name, company, title, what the CRM says) are the list's own text, passed on as data,
  and the skills tell the model to treat that text as data, never as instructions.
- **The critic's verdict.** Claude runs the critic and passes back what it said. A PASS that Claude made up
  can't be told apart from a real one. Confirmations don't go to the critic at all: the scripts keep them
  short and refuse any link or outside address they recognise (your own email and a phone number are fine).
- **Your connected tools.** CRM lookups (opt-outs among them), mailbox history, replies, bounces and
  calendar times come back through files Claude writes. An opt-out or a reply that Claude leaves out is
  never seen. In an unattended run it is the other way round: the guard reads the mailbox's and the CRM's own
  answers itself, and Claude's account of them doesn't count. What is left to Claude there is its judgement of
  CRM activity that didn't come from the contact, recorded with its reason.
- **CRM records you found or imported.** `crm-records --via check` and `--via import` record which CRM record
  belongs to whom from what Claude read in the CRM or an export; floorboss can't tie them to a call it saw, as it
  does for records it created.
- **Your context files.** What you bring, your voice and who you want to meet live in `~/.floorboss/` and
  can be edited without a prompt. The critic checks a draft's claims against them.
- **Sending off, the default.** There is no prompt, because you send each message yourself. The outbox's
  "passed" and "approved" labels rest on the points above, so read each message as you paste it. The page is a
  view of the ledgers: checked after every floorboss command that writes something it reads and at every flow step,
  and rebuilt when something it reads changed (`skills/event-outreach/scripts/commands/page-inputs.mjs`,
  `test/outbox-inputs.test.mjs`, `test/outbox-round4.test.mjs`). floorboss's own sending never reads it. Each send is
  checked when it is made against the sending event's ledger, and against what your other events' ledgers say about
  that person (`lib/lent.mjs`): a stop, a send or an approval recorded there since the send list was made refuses it
  until the list is made again, which reads them in full, and a list made while one of those ledgers changed holds
  every item. A draft put in your mailbox while sending is off gets the same check against your other events when it
  is staged (`hooks/guard/sends.mjs`). The CRM owner setting, which decides whose people are yours, is saved only
  through its question (`event-context config --set` refuses it), which reads back first any change that would take
  an approved message from you, and any owner value that isn't plainly a name or an email address (it is shown
  quoted, as data, and saved only on your yes).
