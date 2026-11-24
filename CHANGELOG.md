# Changelog

All notable changes to floorboss are listed here. The format follows Keep a Changelog.

## [0.1.7] - 2026-11-24

This release also holds the 0.1.6 work, which was not published on its own.

### Security
- A checked file read could be led outside floorboss's folders in two ways: a parent folder swapped for a link
  while the read ran, or a second name (a hard link) for another file. Both are in 0.1.5; update. The read now walks
  to the file one folder at a time, refuses a link inside the data folder and any file with a second name, and
  returns to the folder it started in or stops (`lib/paths.mjs`).
- Auto-send state changes need a one-use record that only the guard writes, so the model can't turn auto-send on
  by running the command itself. A stop never needs one.
- The data repo's git calls are pinned to the folder's own `.git`, its remote is bound to the user's yes, and a repo
  with program-starting git settings, links in `.git` or `objects/info/alternates` is refused.
- SECURITY.md now states the limits of auto-send through Gmail drafts: the daily task sees only Gmail, so a queued
  draft that is edited goes as edited, and a stop on the laptop reaches a queued draft only once its hold run has
  labelled it.

### Channels and LinkedIn
- Setup asks which channels you use. floorboss never sends a LinkedIn message: each one is yours to send by hand, on
  a "Due today" list, with a CRM task on its due day when a CRM is connected.
- A by-hand LinkedIn step that was not sent never pauses the sequence. It is dropped when the next step goes.
- A first message you skip no longer blocks the messages after it.

### CRM holds
- A CRM hold applies on every channel. A do-not-contact hold is carried across your events and checked again at
  the last step before a send.

### Approval and drafting
- The approve step offers only what the send check would approve, by that check's own rule. Each message it would
  refuse shows as one held line that names the real blocker and what to do.
- Nobody leaves a run without a word: each person is offered, held with a line, or out for a stated reason.
- Drafting stops after three tries at a message that keeps failing its checks; the same failing text saved again
  uses up a try.
- An approval taken back and restored can't make an already-sent message sendable again, and a redraft keeps the
  one-message-a-day mark.

### Setup
- Guided intake: what floorboss can learn from, and who to reach at this show. Questions with a fixed set of answers
  are choices; a typed digit picks the numbered option.
- Setup, research and the review read the same in Claude Code and in Codex. The final approval is a choice, not a
  typed sentence.
- A connected CRM is confirmed by name, and a CRM that is not listed is refused.

### Auto-send in Claude Code
- Daily sending through a Claude routine: the first message goes through Claude Code's own send, the follow-ups wait
  as Gmail drafts, and a stop on the laptop deletes the routine's queued drafts.

### Known limits
- A hold on a queued Gmail draft is not read back after the label call; an empty answer from the label tool counts
  as done. Delete the draft, or pause the daily task, when a hold must be certain.

## [0.1.0] (unreleased)

The first public version.

### Codex and hand-send
- Auto-send from the cloud (Codex, Gmail only): after the content approval and a second yes ("auto-send these
  sequences", bound to the readback the user saw), a ChatGPT scheduled task on the user's own account sends each
  approved message on its day, first message included, with a Gmail reply check decided in code before each one.
  The data folder lives in the user's private GitHub repo, pulled and pushed with a lock (`lib/autosend/`,
  `skills/autosend/`, `codex/autosend-task.md`). There is no guard in Codex: floorboss trusts the model with
  sending, and SECURITY.md says so. Tested with a fake Gmail and a local bare repo only; untested on a live account.
  A send step is shown only once its release mark is confirmed in the repo, within 3 minutes of its search, in the
  event's hours and with Claude Code's email sending off. The laptop's auto-send changes (on, the second yes, a stop,
  a settled send, a reply or stop recorded) are pushed as they are made, and `autosend sync repair` brings a laptop
  that moved apart from the repo back in line without dropping a stop.
- Auto-send reads the Gmail tools as a live ChatGPT/Codex cloud run showed them (`mcp__codex_apps__gmail_search_emails`,
  `mcp__codex_apps__gmail_send_email`): the search's emails and the send's ids come from the result's
  `structuredContent`, and an `isError` result stops the run (a send's is unclear, never sent or retried). The send
  goes as `text/plain` with the approved body byte for byte, and a follow-up replies to the first email's message id,
  so it stays in the thread. The task prompt sets git's sign-in to GitHub for the whole run (a global credential
  helper reading `GITHUB_TOKEN`) and asks for the whole tool result as JSON.
- floorboss runs in OpenAI's Codex: the whole event, with you sending every message from your own mail app. A
  Codex pack (`.codex-plugin/plugin.json`, `.agents/skills/floorboss/`, `AGENTS.md`) asks in the chat and runs the
  critic in the same conversation, and says so. Untested in Codex itself, on Windows and with Outlook.
- A mode table (`lib/harness.mjs`): connected sending, CRM writes, browser notes and connected reads only in Claude
  Code (`CLAUDECODE=1`, no Codex marker). Codex and any unknown program get hand-send, and nothing in a setting can
  switch it.
- The outbox page: each approved email that may go today gets "Open in your mail app" (a mailto: link with the
  exact approved text) and "Download .eml" (an unsent draft file), in Claude Code too. Only cards that offer Copy
  get them.
- From a simulated Codex run: the critic's batches keep their numbers until their verdicts are in, so a command
  given earlier still matches after `next`; hand-send step texts no longer say "in parallel", "with sending on" or
  `/floorboss:start` (Claude Code's are unchanged); the critic's instructions and the Codex skill agree on the batch
  file; the outbox's "N of M sent" counts recorded sends; the shortlist gives a LinkedIn-only person's link as `to`;
  `verdicts --ids ""` says the ids are empty.
- Second round: a critic verdict counts only for the text the critic was shown (the step's command carries each
  draft's fingerprint), and a batch numbered afresh starts with no old reply file; a rescheduled meeting drops the
  outcome of its old time; the mock event's settings save and the CRM web-app log window follow hand-send's rules;
  a subject holding an encoded word (`=?…?=`) is flagged by the checks and encoded whole in the .eml; the CSVs keep a
  cell as text when a formula sign follows spaces or a line break, or is full-width; command output in hand-send
  names no slash command or Claude Code tool; the unattended job's install, remove and on refuse a shell with any
  Codex marker, terminal or not.
- The outbox page's own CRM log CSV keeps a formula-like cell as text by the same rule as the other CSVs.

### Meeting outcomes
- Record how each booked meeting went (held, no-show, cancelled, rescheduled) and walk-ups, in your own words; the
  day's agenda shows outcomes and the meetings not marked yet; `/floorboss:report` writes an after-show page and CSV.

### Setup
- `/floorboss:start` with three setup levels (quick, standard, full), scan-first onboarding that asks only
  what it can't work out, and answers in your own words.
- Event after event: your setup is asked once; each new event asks only its own questions, and every run
  confirms which event it's for. Do-not-contact lists and stops carry over between events.
- With a CRM, setup asks whether emails to people you already know (customers, open deals, anyone marked
  warm) end with the opt-out line too, or only cold emails do. Unanswered, every email keeps it.
- A CRM deal stage floorboss doesn't know ("Parked", a pipeline's own name) is put to you as open, won or lost,
  never read as an open deal; lost deals under other names ("Not interested", "No decision", "Churned") are held.
- With a CRM, setup names who on the list has a lost deal or a rejection and asks how long after the last
  contact they're fair to approach again: 3, 6 or 12 months, your own number, or no wait. Quick setup uses 6.
- `/floorboss:event-setup mock buyers` and `mock investors`: a made-up event to try it with nothing connected.
  The mock keeps its own answers and never touches your real setup, stops or events.
- The answer to "which CRM owner are you?" is read against the owners of your CRM export, in the order the question
  shows them: one list for the question and the answer, whatever export, column correction or layout from another
  event it came from, so "2" picks the owner you were shown second. If the export changed after the question was
  shown, a number is read back with the list as it is now. Every owner value the CRM has is offered as a numbered
  choice (the first 12; type any other), shown quoted, after removing control and invisible characters and capping its
  length. Nothing you pick or type is refused for its wording: only an empty answer, one too long, a number that isn't
  on the list, or one that names no one ("yes" with several owners listed, a bare "no"). An owner's name with nothing
  beside it but words like "that's me", "I'm" or "yes" is that owner; "none of these" saves no owner. A value that is
  plainly a name, or plainly an email address, saves at once. Anything else (a remark, a tag, a label, a negation, a
  word addressed to Claude or an assistant, a word such as send, skip, hold or stop, or anything the check can't
  place) is read back word for word, for example: Save "X" as you in the CRM? (yes or no). It is saved only on yes, so
  a false alarm costs one read-back, never a lockout. The same goes for an answer read from more than your words (a
  question mark, "yes" with one owner listed, words that are no owner listed here), one that reads as two different
  owners, and any change that would take an approved message from you at any event, said with what it changes; if that
  has changed by your yes, the reading is over 30 minutes old or it was made at another event, the yes saves nothing.
  Triage reasons and the say-back show a doubtful value quoted, as data, and it is never offered as your sign-off. A
  saved value that reads as two different owners at an event makes neither yours there: the people they own are held,
  and the question is asked again there. An owner written with only your first name ("Bram"), in a CRM that also
  writes your name in full, holds the people it owns for you to decide (an account owned so, only where a coworker's
  account would hold them); in a CRM that writes owners by first name alone, your full name is read back as that
  owner. The setting is yours at every event: a change says who changes group here and at your other events, and names
  approved messages that are ready to send again or no longer yours. At the mock, an answer changes only the mock. The
  owner is saved only through this question: `event-context config --set` refuses it. A value saved some other way
  that isn't plainly a name, or a sentence saved by an older version that names no owner, is asked about again.
  Do-not-contact, opt-out and uncertain-match holds still apply.

### Lists and triage
- Attendee lists from a file or an event's public page; CRM and contacts exports; column mappings confirmed
  once per file layout and reused at later events, corrected in your own words ("Lifecycle is the status
  column, Closed Lost is lost").
- Duplicate merging, company matching, and one written order of rules: skip, colleague, warm, reach, check,
  unfit. Uncertain matches are shown with the reason, never guessed. A reason you give with a decision
  ("warm c008 because we met at Tillcon") travels with the draft as your note. A bare "no" at the mapping
  asks what to change, and two answers that say different things about one column are asked about.
- Someone written to at an earlier event is held as in touch at the next one, ahead of the customer rule.
  A match you settle at one event carries to the next only for the same person (same email, or same
  company), and never clears an opt-out or a hold.
- Your rules: target accounts, must-meets, a per-company cap, warm notes for your own accounts, a note to the
  colleague who holds an account (colleague notes, off by default; `notes on` or `note <name>` at the
  check turns them on), and how many people to reach.
- Missing emails filled from your CRM and earlier events first, then from a people-data tool you've
  connected, only as many lookups as you agreed to, and never twice for the same person.

### Drafts
- Company and person research with a source on every claim. What you say about a person at the check, and
  what your CRM's notes say about them or their account, reach the writer and the critic as allowed facts.
- Short messages and follow-ups in your voice, learned from emails of yours that got replies, with rotating
  structures (a rule of yours about the opening narrows them), two real times from your calendar, and checks
  on names, times, length and banned words. A draft you edited yourself is never rewritten by floorboss.
  People you know get a note that opens from the relationship, never a cold question.
- A separate critic agent with no file or tool access reads every draft and can fail it. A draft that
  still fails floorboss's own checks after three tries is kept from the critic and named to you. You can skip
  the critic for named drafts ("skip review c012"); an edit sends a draft back to it.
- Optional blind ratings before approval, with rewrites from your notes. A one-word note counts; praise is
  never turned into a rule.
- "approve all, c016 too" approves c016 only if the critic passed it; "approve all, c016 anyway" (or
  "as is") approves it over a fail.
- Your own outbound skill or agent can write the messages it covers; floorboss checks them.

### Sending and tracking
- Each person's sequence goes on a route of channels, one per message: by default email, the event app, LinkedIn,
  email. Anyone you can't reach on a step skips it, and you can make the route longer, shorter or a different order.
  Before any message goes, their replies are checked on every channel they were written to, so someone who answered
  in the event app doesn't get the next email; where floorboss can't read a channel, it asks you. A step you won't send can be skipped ("skip LinkedIn for Ana").
- Follow-ups are spaced by how far off the event is (7, 4 or 2 days apart), or by your own gap: set it in full
  setup or say it at any step ("3 days between follow-ups", "a week apart", "2 days, then 5", "the default").
  Whole days from 1 to 14; an answer it can't read is asked again, and so is a range, "twice a week" or "day 3, day
  7". The gap is your setting for every event. One rule works out each follow-up's day for the drafting list, the
  outbox, the send list, the CRM task and the guard: never sooner than its gap after the message before it really
  went, moved off a weekend in a sequence approved up front, and dropped (never moved closer) when that lands after
  the event's last day; you're told which. Approved follow-ups keep their text when the gap changes, and the answer names each approved follow-up at this event whose day moves or that is dropped (with its old and new day once the message before it has gone, and its gap until then), and gives counts for other events; those counts are a projection that takes a first message still waiting as going today.
  The guard refuses a follow-up before its day, saying the day in the event's time. When every message goes on its
  planned day, every follow-up goes on the day planned for it. Once the event is over (today, in its time, past its
  last day) nothing more is sent, made a send task, staged in the mailbox, shown as due in the summary or offered to
  copy on the outbox page (cards say "not going: the event is over"): first messages, follow-ups and confirmations
  alike. Recording what happened, opt-out and review tasks, exports and the agenda still work. At most one message
  goes to a person a day: the guard enforces it on its own (a send in progress counts, and two calls at once can't
  both pass; a meeting confirmation, which answers the person's booking, is the one exception), and the send list, task list and stage list list the earliest step and hold the other.
  It is one message a day to a person across all your events, by address. A message at another event counts when
  the two events share an address for the person: their email, another email on their list entry, their profile
  link, an address a message was approved to go to, or a new address after a bounce, whichever of them each
  message goes to. That holds for a send recorded there, for a message floorboss let through there and not yet
  recorded, and for a guard's mark there (below). A profile link written two ways
  ("https://www.linkedin.com/in/ana", "linkedin.com/in/ana/") is one address. An address two people's list
  entries at one event both have is no one's alone: it counts only for a message that goes to that address (a send
  you record with no channel counts as an email), never for their other addresses, so a LinkedIn note to one of
  them never holds the other's. Who has an address comes from the list entries: an approval or a bounce that names
  another person's address doesn't make it shared, and a note for the colleague who holds someone names no address
  of theirs. An address that is often a team's inbox (info@, hello@, hi@, contact@, mail@, ops@, enquiry@,
  reception@, bookings@, accounts@ and more; SECURITY.md lists them all) links two events only when both give the
  person the same name: a solo owner known by hello@ at two events is one person, and two colleagues who each give
  info@ at a different event are two. The merge never joins two people by such an address; the list now also has
  ops@, operations@, enquiry@, inquiry@, reception@, frontdesk@, booking@, bookings@, accounts@, accounting@,
  billing@, invoices@, orders@, general@ and welcome@. The guard checks a send under a lock for the address it goes
  to, each address the person has alone at its event and each inbox address of theirs together with their name,
  taken in one sorted order, so two calls at the same moment at two events that share an address for her, even
  when each goes to a different one of her addresses, are checked one after the other and the second is held.
  Someone each event knows only by addresses the other doesn't have, or only by an inbox address under two
  different names, is not recognised. At one event a
  day is a calendar day in the event's zone (23:58 and 00:01 are different days). A message to the same address at
  another event counts as today when it falls on today's date in this event's zone or in that event's own zone. So
  two events can't both write to a person on the same date in either zone, whether the calls come at the same moment
  or one after the other. As at one event, two sends either side of midnight in both zones can both go, minutes
  apart. A message floorboss let through holds the person for no more than a day. A send you record yourself counts
  on the date you give, in its event's zone (and from the time you recorded it, when you recorded it that day or
  when that event's zone can't be read). A message let through today counts for today whatever is recorded about it later (a hand record dating it
  earlier, a send-outcome saying it didn't go): only that same step can go again that day. `send-list --resend`
  takes only an unclear send, and says why when it refuses: the step was recorded as sent, it was never let through,
  it was already settled (by a bounce, send-outcome or an earlier resend), in which case it is listed again on its
  own once it can go, or a call for it started less than a minute ago and may still be going through. A guard
  stopped between its first mark for a message and the release it writes leaves an unclear send too, once that mark
  is a minute old (no guard still checking is that old): the send list and the flow ask about it, and `--resend` or
  `send-outcome` with your words settles it. Before then, `--resend` and `send-outcome` refuse, and the guard checks
  the message again under its locks, before its release, so a message whose first call is still going through
  isn't let through a second time. Such a mark at another
  event holds the person's addresses there too, from the time it was made. If another event can't be read (its
  folder can't be opened or is a link to a folder that is gone, or its ledger can't be read or is a link to a file
  that is gone), sends wait and say why: floorboss can't tell what went there. So does a line there floorboss can't
  read that names the address. A send lock left by a guard that died is broken at once when the process id it holds
  shows that guard has ended; one with no readable id holds that address for up to a minute, and a call in that time
  is told to try again in a minute. A new lock that a stale break renamed away in a race is removed
  once it is a day old, the next time a lock is taken. The outbox page, the
  task list and the summary hold a message to an address another event wrote to today: its card says "Not today"
  with the reason and has nothing to copy, and its send task comes another day. The stage list puts a
  follow-up in your drafts only after the message before it went, never a step already sent, and each step's draft
  once per stage list (never again once its receipt is saved, unless you change its text and approve it again: the
  old draft in your mailbox is then flagged). It holds a person another event wrote to today, and says why. A draft
  call waits while a send to that person at another event is being checked under a lock they share, and is held by
  it. A draft in your
  drafts holds nothing at your other events: you send it yourself. A second call for the same draft within 30
  seconds is refused, as the first may still be going in; a call that was declined or failed can be tried again
  after that. A step
  recorded as sent out of order (by hand, or found in the mailbox) passes over the earlier steps that hadn't gone
  (their text was written to come before it), and the next step goes never sooner than its gap after that send, and
  not before its planned day. An event whose dates or zone can't be read (a missing, empty or odd date, a day that
  doesn't exist like 2026-11-31 or 2026-13-01, a start after the end, an unknown zone) sends and stages nothing, and says so ("floorboss can't read
  this event's dates") on the outbox page, in the summary, the send list, the task list, todo, the stage list and the
  flow, and at the guard; the gap answer says that event can't be planned now. floorboss's own setup always writes
  both dates, so an event with no end date counts as unreadable too, and setup refuses a day that doesn't exist. A
  send date recorded in a form floorboss can't read (2026-02-30 and 2026-13-45 included) skips the step after it with
  a note naming it. A send recorded with no date (or a date of 0) still went: that step never goes again, and the
  step after it waits with a note. A hand-edited ledger line stops nothing that reads the ledger: a list on a
  person's line that isn't a list is ignored, and a line floorboss can't take at all (no id where one is needed, or
  an id like "__proto__") holds the person it names, or everyone at that event, with a reason that names its line. With the default spacing, three timings differ from before: a message sent
  late (after its planned day) a day or less before the event starts, or during it, no longer gets a follow-up
  after it; with sending off, a last follow-up that fits before the event's last day is now offered (it used to need
  room for one more gap after it), as sending on always did; and zones at UTC+12 or further east read the lead time
  on the event's own date. Answers are read whole ("every other day", "a fortnight", "3 días, luego una semana"); one with a
  part floorboss can't read, a negation, a comparison, an ordinal or a channel is asked again, never half saved, and
  so is one cut off at its end ("3 days, then", "3 días, y", "3 days, every", "3 days, after that", "3 days: after
  that", "3 days,", "3 days -", "3 days..."). "3 days, then 5 days after that" is whole, and saved.
  The lead time is read at the event's own date (it was read at midday UTC, which is the next day at UTC+12 or
  further east). With sending on and every message on time, the days there are the same as before; they differ with
  sending off, and after a late send. A follow-up planned again (written again because the message before it changed) plans the
  follow-ups after it again from its new day, keeping their text and approval, so one sequence never holds days from
  two plans; and every day any reader works out passes one final check (after the real send, at least its gap after
  it, a weekday in a plan made off weekends, within the event as it is now).
- Approval of each person's whole sequence; you can edit or drop any touch, in the file or inline
  ("edit c012: …"). Checks refuse a figure (%, x, money) that none of the draft's sources holds.
- Optional sending by email, with Claude Code asking before every send. Event-app notes through your browser.
- Replies read for intent (reply, booked, decline, stop, referral, cancelled, out of office, bounce); a reply or a
  booking ends the rest of that person's sequence, and a cancellation from them frees the meeting's time (one
  from anyone else is put to you). Times that get
  booked are dropped from later follow-ups.
- Automatic replies never end a sequence: an out-of-office is noted, with the day it gives, and follow-ups keep
  their days; acknowledgements and delay notices are ignored. They're told by the reader and by their
  subject (Outlook, Exchange, Lotus and other languages' formats), so one a CRM logged without its text counts too.
  A delivery failure from the mail system stops everything to that address.
- Every run starts by reading what came in since the last one, before anything is drafted, sent or summed
  up: from your mailbox, or from your CRM, which logs your email. A CRM read counts as the reply check before
  an email follow-up only when it shows the CRM has that person's email since your last message and has
  logged incoming email at the event at all (a CRM that logs only what you send can't see a reply); anyone it
  can't see, and everyone when nothing connected can see replies, you're asked about instead.
- With a CRM connected, setup also sets up reading the email it logged, from where that CRM keeps it
  (HubSpot's email engagements, Pipedrive's mail messages, Salesforce's EmailMessage, Close's email
  activities), or records that it doesn't log your email, so replies are asked about.
- With a CRM connected, anyone about to get a first email who isn't in it is added first (name, email,
  company, title), through a create-contact tool with a prompt for each, or by an import you make; their
  first email waits until then, unless you say to go on without.
- Replies that need an answer (a question, a counter-offer, "maybe Thursday?") are yours: floorboss stops the
  follow-ups and leaves the answer and any invite to you. A time you offer yourself is held once you record
  it as booked.
- Telling floorboss "sent" after a booking records the confirmation, and `unsent` takes back a send you
  recorded yourself by mistake (never one floorboss sent or found in your mailbox). A reply you report
  shows in the meeting brief.
- One ledger per event and CRM logging that fills blank fields only. Logging through
  your browser types only listed details, and asks you before each message text. With your yes in setup, someone
  the CRM doesn't have is added there so the message can be logged; the recommended answer asks once per batch, naming them.
- Someone who sent an out-of-office is noted as away until the day they're back in the run's summary, and their
  follow-ups keep their days. `contacted.csv` tells meeting booked, declined, cancelled, replied,
  bounced and away apart, counts meeting confirmations, and adds the meeting's time as a last column.
- The outbox page offers Copy only for messages that are approved and not yet sent, to people who may still be
  contacted, judged at this event and at your others. The page records what it was built from: this event's record,
  settings, lists, mappings and drafts, your settings, the day, and every other event's settings, lists and record.
  After any command that writes something a page reads, each page is checked (the sizes and times of those files, a
  hash of this event's record, and for a record that changed at another event, what it says about who was messaged,
  approved or said stop there and its answers about CRM matches) and rebuilt only if something it reads changed. A
  cut, a keep or a cap, a rewrite, a drop, an edit, a send, a stop, a decline, a bounce, a skip or a coworker's hold
  takes the card off at once. So does a send, an approval or a stop for the same person at another event (a message
  to their address another event let through today makes the card "Not today", above), also a stop from someone
  never messaged there. A cut or a group decision at one event, for someone the other pages don't
  have, leaves those pages as they were; an answer there about whether a CRM record is someone is read by every
  other event, so their pages are rebuilt. A message floorboss let through to send, with no receipt yet, is not
  offered to copy: its card says it may have gone. `flow next` checks the page the same way, which also catches a
  list, or this event's record, edited by hand, and the day after the event ends; `open` always rebuilds it.
  Commands run at the same time leave the page in step: one rebuild at a time per event. The page's lock is broken
  at once when the process holding it was killed (after 3 seconds when it was killed before it wrote its id); while
  that process still runs, it is broken only after 10 minutes on one build. A read that meets a file another command
  is replacing is tried once more. A page that still can't be rebuilt is replaced by one that offers nothing to copy
  and says it is out of date; the command saves and says so, naming the event (the approval gate still exits with
  that message as an error). It is tried again at a step at its own event or once something it reads changes, so a
  write elsewhere that changes nothing it reads doesn't say it again. Folders in `events/` that aren't events are
  skipped. The review page shows drafts not yet approved with nothing to copy, and leaves out messages already sent
  or answered; the final page says how many drafts wait for approval. No email card is offered to someone whose
  address bounced with no new one. The page is a view, and floorboss's own send check never reads it. At each send
  that check reads the sending event's record, and what your other events' records say about that person: a stop, a
  send or an approval recorded there since the send list was made stops the send until the list is made again, which
  reads them in full. A send list made while another event's record changed holds every item it lists. Drafts put in
  your mailbox while sending is off are held the same way: a draft whose person had a stop, a send or an approval
  recorded at another event since the stage list was made isn't staged, and a stage list made while another event's
  record changed holds every draft.

### Meeting day
- `/floorboss:agenda`: a brief for each booked meeting (who they are, how you know them, what's new, what to
  talk about), as a page, a short version and an `.ics` file. It names the companies before any web search.
- The morning brief, on its own (macOS only for now; Linux and Windows are planned). You install it in your own
  terminal with `node scripts/unattended.mjs install-brief`. Every day at 07:00 on the Mac's clock, or when it next
  wakes, a floorboss script checks for a booked meeting that day (in the event's time zone) and, if there is one,
  builds a brief from floorboss's records and opens it; the last one built is also at `~/.floorboss/today.html`.
  The page also opens on a day with no meeting when it only names people whose unattended follow-up goes into your
  drafts that day and who were also written to on LinkedIn or in the event app.
  No Claude session, no network, nothing sent, and it stops itself after 60 seconds. `agenda-facts` is the script
  command behind it. It writes no talking points. An agenda saved for that same day is kept while every fact on it
  is unchanged; otherwise the page is rebuilt, keeps the talking points of meetings that did not change, and says
  the others are missing. `/floorboss:unattended off` stops it, `status` shows it, and `uninstall-brief`
  (terminal) removes it. Each run is logged in `unattended/log.jsonl`.
- Agenda pages: a news link is a link only when it is a plain web address; control characters and characters a
  reader can't see (bidi overrides, zero-width spaces) are taken out of every name, note and news line, except the
  joiners that are part of how Persian and Indic names and joined emoji are written; long lines in `agenda.ics` are
  folded at 75 bytes, as the calendar format asks. For ordinary input the page and the short version are byte for
  byte what they were; the calendar file differs only by that folding.

### Unattended follow-up drafts
- Follow-ups you approved and authorised can go into your mailbox's drafts folder on their day while you are away,
  with no prompt (macOS only for now; Linux and Windows are planned). Nothing is sent: you press Send. A first
  message never goes in on its own.
- Turning it on is three steps, each yours: `/floorboss:unattended on` asks you to type a sentence; Claude Code asks
  you to allow it, naming the event and its last day; and `node scripts/unattended.mjs install-followups`, in your
  own terminal, asks you to type a code and installs one launchd job that runs every hour, day and night (a draft
  still goes in only on a weekday from 09:00 to 17:00 in the event's time zone). The opt-in ends with the event.
- One Claude Code prompt authorises a whole sequence's follow-ups, showing each person, address, day and full
  text. A changed text, address, thread or mail tool after that means it waits for you.
- With nothing due, the hourly job starts no model. Otherwise it starts one `claude -p` run with a one-time ticket,
  and for each person floorboss's guard reads the mailbox's own answer (and the CRM's, through its activity reader)
  for anything since your last email, each read exactly as its saved recipe. Anything from them holds the draft. Other CRM activity is judged by Claude (hold, or go
  with the approved text; unsure holds), and each judgement and reason is logged. The guard lets a draft in only
  on a weekday from 09:00 to 17:00 event time, on its due day or the next, before the event's end, once, in your
  thread with them, and the run stops at the first refusal or failure.
- Each day's summary is built from the log; your next floorboss run shows it first, and Claude Code mentions it
  once. If you installed the morning brief, the morning page names people you wrote to on LinkedIn or in the event
  app whose draft goes in that day, since floorboss can't see replies there in an unattended run. It names only
  those the launcher will put on that day's run, by the launcher's own checks. A draft whose
  result never came back is said as "may or may not be in your drafts folder" (`outreach draft-missing` lets it go
  in again once you confirm at Claude Code's prompt, on its own, but not on the day the first draft was let through), and a due follow-up that can't go in is said once, with why.
  The job waits only when floorboss ran something in the last 30 minutes, not for a session left open.
- Works with the claude.ai Gmail connector: with it, floorboss reads the whole thread of your last email to them and
  searches for anything from or to them since then, and the draft goes in as a reply to that email. It searches
  every folder but Spam, which Gmail leaves out, and floorboss can only show that the search covered your own last
  email and the time since, not that it matched mail from them.
- With a CRM connected, its logged activity is always checked: Salesforce or Close (which floorboss can't read on its
  own), or a CRM with no activity reader connected, holds every draft, with the reason, and the opt-in says so first.
- Each run is a Claude Code session on your account and counts toward your plan's usage and limits.
- `/floorboss:unattended off` stops it and the brief. The guard refuses the job's install, its launcher mode and the
  run's token from any session, and `launchctl setenv`, `unsetenv` and `config` too. `npm run self-check` pins
  where the launcher checks its Claude Code run's flags and its main flags.
- An unattended draft has every check an attended one has. That covers one message a day to a person across all
  your events, and the same send locks for each of their addresses. It also covers a stop, a send or an approval
  recorded for them at another event since the run's stage list, which holds it. The draft counts as that day's
  message to them at your other events, as a send does. The hourly job doesn't put anyone on a ticket whom that
  rule holds today: it starts no run for them and says why once.

### Connections and safety
- What floorboss runs on its own is installed, removed and switched back on only by the user, in their own
  terminal: the install script refuses without a real terminal (with `--yes` too) and from Claude Code's shell.
  In every session the guard refuses `unattended.mjs` with anything but `off` or `status`, the job's name or
  launchd file, `launchctl` with a word after it that loads or starts a job, and floorboss's `unattended` folder,
  in Bash, PowerShell and Monitor commands and in the input of connected (MCP) tools that aren't plainly reads;
  those tools and Claude's file tools can't write the launchd file, that folder, `today.html` or floorboss's other
  records. The rules read text, not the shell: SECURITY.md lists what they miss and what they refuse that is
  harmless, and nothing that sends relies on them. A connected tool's input is read in one pass; over 2 MB of values or 512 levels of nesting, a tool
  that isn't plainly a read is refused. `npm run self-check` holds the launcher to one process, the opener at
  `/usr/bin/open`, and the install script to one, `/bin/launchctl`.
- The guard's 20-second deadline now holds for a check that kept the process busy: its answer after the deadline
  is a refusal. A send is checked against it once more just before its release is written, so a send refused for
  time leaves nothing that holds the message, and trying again works. The check of a person's sends at your other
  events reads each event once per call, not once per listed message, so a home with many events stays well
  inside the deadline. Resolving a very long path no longer takes time in proportion to the square of its length.
- A subagent can hand its result back during a run on current Claude Code, which delivers results through a tool of its
  own that the guard refused as unknown: critics, researchers and writers did the work and couldn't report it.
- From a seventh audit (17 Nov, 8 confirmed findings, all low, each fixed here with a regression test in
  `test/audit-run7-fixes.test.mjs`; it includes the three the sixth left for later):
  - The thread a follow-up goes in, and the message it replies to, come only from the guard's own reading of the send
    or draft tool's answer. A thread or message id that only a send receipt, `send-outcome` or a mailbox file written
    by Claude names is never used, for any kind of mailbox: an attended follow-up then starts a new thread, and an
    unattended one waits for you. A receipt id that differs from the tool's answer is not kept, and `outreach sent`
    says which. The claude.ai Gmail connector's send answers its thread, so Gmail works as before. On Gmail, after a
    floorboss draft you sent yourself, the next unattended follow-up replies to your email as the run's own read of the
    thread shows it, and a held draft says to send that follow-up yourself. A follow-up authorised before it had a day,
    after a send known only from your mailbox, counts from the later of the mailbox's day and the thread read's on
    Gmail, and elsewhere is offered again with its day shown.
  - An account lends its CRM words and its customer standing only when that account match is itself bound (an address
    at the account's own domain, or the person's own bound record at that very account); a bound personal record at
    another company no longer lends them, in the job or in the company brief. A mailbox provider's domain (a relay, an
    ISP, webmail) never binds anyone to an account, though it still matches one for its holds (off limits, a
    coworker's). Your customer rule's "hold" or "ask" still applies to everyone at a customer account and to every
    name match, bound or not; only its "warm" or "treated as new" needs the binding. The company brief in a draft job
    keeps its CRM lines only for someone bound to that standing at the brief's own company; for anyone else the
    relation is left unsaid. A customer account
    the CRM knows only from a row with no address binds nobody on the list: its people get "at your account X" and no
    customer brief (a deliberate trade-off, SECURITY.md).
  - In an unattended run, Claude's file tools write only the CRM judgement file of a follow-up on the run's ticket.
    Your voice, offer and who-to-meet files, the session's event and the attendee lists are refused, and so is a write
    through a link put at that file's name or on the way to it. The run's command pre-approves that one file.
  - The check that holds a "go" on CRM activity whose own text speaks to floorboss or Claude reads the activity's whole
    record (a HubSpot task's or call's own fields, a long note past its first 600 characters, property names), as
    stored, folded (HTML tags and entities out, full-width letters folded) and with its markup (an HTML comment or
    attribute counts). Steering text in the answer outside its activities, or two activities sharing an id, holds every
    "go" on that answer. A steering note in another activity is a known limit, planned for 0.1.1 (SECURITY.md). A
    task, a call or a deal is named by its title in the judgement step and the summary; that title never makes an
    activity count as floorboss's own sent email, which is told by the email's own subject alone.
  - A follow-up authorised before it had a day ("due on its day") is held if the days between follow-ups change
    afterwards, and the flow offers to authorise it again under the new gap.
  - A first name that picks an owner cell of several names joined by "|" ("I'm Bram" for "Bram Janssens|Carla Diaz")
    is read back before it is saved, since every name in it would count as you. A plain name still saves at once.
  - A CRM record lends a list row its notes, its warm, customer or partner standing and its account's CRM words only
    when the message goes to one of the record's own identifiers: the same address (at a shared mail domain, the same
    mailbox), or, with no address, the same LinkedIn link. Anything else (a name, another mailbox at the company, a
    merged row's other address, a copied link beside another address, a record with neither) goes to check-these with
    both, the record's holds applying at once. A row with no address waits until the record's own address is filled
    in for it. Someone at your account gets the CRM's words about it only with a bound record of their own or an
    address at the account's own domain; anyone else there (and everyone at an account row with no address, whose
    company brief no longer says customer from it) gets "at your account X" and no CRM words.
    The record's holds apply at once; its notes and warm or customer status wait until you say it's the same person.
  - A saved contacts export, your voice emails and an earlier event's do-not-contact list are read as plain files each
    time (no link at the name, and in a shared temp folder only a file of yours). A path that would be refused is never
    saved, and a saved one that is refused later is left out, said so.
  - "skip" with one company alone ("skip altogether", "Skip Altogether.", with a company called Altogether) is said
    back instead of being read as that company, however it is written: "skip only Altogether" skips just that one,
    "skip all" every company, and two or more named are skipped at once. The same goes for the news heads-up.
- From a sixth full audit (11 Nov, 13 confirmed findings, all low; ten fixed here, each with a regression test, and
  three planned for a later release: numbers 4, 7 and 10 of its report, list files read from a shared temp folder, a
  CRM record matched by name to a row with another address, and thread ids taken from a receipt Claude writes), and
  independent reviews of those fixes:
  - At the shortlist and approval gates, an answer made only of the gate's own words, IDs and whole names that can
    mean one person ("approve all", "approve all except c004", "approve John Lind") is saved at once. Anything else
    that reads one way ("approve Ana" with one Ana, "drop Cy please", "looks good", a remark beside "approve all", a
    name another row shares a first name with, a name holding a command word) is read back by ID and name ("This
    answer reads as: drop c003 "Cy Ek". Reply yes to save, or answer again.") and saved only on the user's own yes
    (while it waits, "ok", "sure" and "yes please" agree to exactly that reading, never to "approve all"); the
    reading waits 30 minutes, a change to the list or to anyone's state drops it, any other answer replaces it, and
    nothing can be sent from it. A word that could be two people is asked about ("Which "ana": c001 "Ana Costa" or c002 "Ana
    Berg"? …"). Every saved answer says what it saved, by ID and name, and names in read-backs are cleaned of
    everything but letters, digits, spaces, hyphens and apostrophes inside a word, and of anything shaped like an ID. Names are compared with invisible characters and accents removed and
    look-alike letters read as Latin; a row written with those goes by ID only. An answer the code can't read is read
    by Claude from the list, by ID only, and always shown back quoting the user's words for their yes
    (`flow answer --interpreted`): every refusal at either gate says it can be read that way and lists the people by
    ID, so an ordinary answer that the code can't read is read back rather than refused. A yes or an "ok" is
    recognised however it is punctuated ("ok;", "ok\n;"), the same way the gate reads it. Only the gate reads or
    changes a waiting reading; the flow hands it the whole answer. At the approval gate an answer that reads as
    nothing but "ok" ("ok", "defaults", "looks good", "ok gracias", however it is written) is never saved at once: it
    agrees to a valid reading the user was shown, or else it is read back listing by ID who would be approved and who
    would not. Approving everyone at once takes the words "approve all". At the shortlist gate "ok" keeps the
    shortlist as shown only when no earlier reading is on disk in any state; otherwise it saves nothing, says the
    earlier reading can't be used, and the next "ok" works. A gate's answer is saved whole or not at all: a failure
    part-way writes nothing and keeps the reading waiting, and a failure only in rebuilding the outbox page afterwards
    says the answer was saved. A reading shown before the critic failed a draft, or before a
    shortlist answer changed who can be written to, is never applied after it, and a
    read-back of "approve all" names the drafts it would not approve as not ready. A message number ("c001:1") is
    refused at the shortlist.
  - A do-not-contact entry, an opt-out, a coworker's record or an uncertain match is checked again when a reach comes
    after the user's own skip or hold-until for that person: "skip Bo" and then "reach Bo" asks for the same words a
    reach on a held person always needs. A coworker's hold behind another open question (their lost deal) counts too; one behind a "doesn't fit" verdict is still only shown on the card, not asked for. A
    reach covers only the holds that were there when it was given: an uncertain match that turns up later puts the
    person back on check-these. What the user lifted in its own form ("reach Cy anyway", their own words through
    decide, "separate" on an uncertain match) stays lifted. Saving "leave <name> with <coworker>" works again (it
    stopped with an error).
  - In the sentences floorboss says (hold messages, refusals, the card's left-out lines), names, companies, titles,
    owners, CRM notes and do-not-contact lines keep only letters, digits, spaces and : ( ) , . / - and never a quote
    mark, a ; or anything shaped like an ID. The card's own fields (a person's name, company, title, what the CRM
    says) carry the list's text as it is, as data.
  - A LinkedIn or app message counts as that inbox unless its label is nothing but email; send-outcome no longer records
    a note typed in the browser as an email; a "nothing changed" word or an outbox paste no longer clears the LinkedIn
    or app inbox; the send prompt says how old the oldest reply check it needs is.
  - A server is a browser only by its exact known name, the browser package it starts, or the tools the first setup
    scan saw; an inventory saved before this keeps the browsers its own record shows came from tools. The package a
    runner starts is never read from the value of -p, --package, -c, --call, --from or --with; a cmd, env or shell
    wrapper that chains another command (&, |, ;, a backtick, $( or a new line) is never a browser, and neither is
    an aliased or linked package (@npm:, a URL, git+, file:), a runner given --registry or --node-options, or an env
    wrapper setting NODE_OPTIONS or npm_config_*.
  - The app limit keeps the place of anyone whose note was ever let through, whatever was said or done about it since,
    and counts later-step app notes at todo and in the CRM tasks.
  - A follow-up saved before the message ahead of it had any text is written again, and the gate says why.
  - A company named like an ordinary word ("Step", "Later") no longer narrows "skip this step" or "skip, later", and
    a listed name in the words after another ("skip Acme as well as Globex") or "the rest" beside one is asked again;
    "please skip Acme", "skip only Acme" and "skip both Acme and Globex" skip just those.
  - Creating an event never replaces an existing event's file, and the mock events stay mock by their names; a
    LinkedIn step whose link the outbox can't show is still labelled LinkedIn.
  - A draft greeting a name in Devanagari, Thai, Bengali, Tamil, Arabic or Hebrew no longer fails its checks, and the
    agenda no longer offers a 07:00 scheduled task it couldn't run.
- From a fifth full audit (9 Nov, 14 confirmed findings, all low, each fixed here with a regression test; its one open
  lead and three bugs it set aside are fixed too): a browser note is checked again when it is typed (one the window
  wasn't opened for, sent already, let through already, or to someone who said stop is refused, a repeat stays refused
  until you clear it and the next prompt says so), and an app window opens only the app, LinkedIn only for a LinkedIn
  note with its warning accepted; a note approved for one channel needs approving again if the route moves it; a CRM
  read no longer clears the app or LinkedIn inbox, and "no reply" answers for the one channel it was asked about; a
  route step goes on its own channel, whatever else the contact has; a follow-up approved before a skipped step keeps
  its approval, and goes back when the message actually before it is rewritten; a step sent back, dropped or let
  through holds the steps after it; the app limit counts later-step app messages; a name beside "approve all" that
  can't be read as one person, or a word of a listed company, stops the approval, and a name counts only as a whole
  item of a list, so a stray word between names is refused and names with only spaces between them are asked for
  with commas (two people with the same first name go by ID); during a run the browser's read rules apply only to a
  browser floorboss knows by its exact name or one the first setup scan found by its tools. A route answer floorboss can't read is asked again, and "email only" keeps the
  follow-ups.
- From a fourth full audit (9 confirmed findings, all low; six fixed here, each with regression tests, and three planned
  for 0.1.1): the guard reads a backslash in a script's path as the shell does; what the first setup scan found a
  connector to be can't be changed by a later scan; a `browser_` tool on a server not known to be a browser is held as
  that server, and browser reads take short values during a run; the mock event reaches no real connector; an attendee
  named like a word of the answer ("Drop") can't change what it does; a company named like a word of the question
  ("Companies", "News") can't turn "skip" into a yes for the others.
- From a third full audit (4 confirmed findings, all low; the two that touch the run lock are fixed here, each with
  regression tests, and the other two are planned for 0.1.1): during a run, saving a connection to a server setup
  didn't find, or moving one to another server, asks you first, and forgetting one always asks; a subagent can do
  none of these; a change goes through only as the guard saw it; a test call runs only on its own job's server. The
  guard reads a floorboss script call the way bash and zsh read it.
- The leads both audits left open, each closed with a regression test:
  - A web search opens only the hosts it returned, exactly as returned (never their subdomains), never one named in
    the search (also with its dots spaced out, doubled or written as other full stops), and never a known hosting suffix such as co.uk or github.io.
  - A browser reached through another server (remote devices) is held as a browser.
  - While floorboss runs, a search that prints lines runs only over floorboss's data folder; listing the files that
    match, then reading them, works as before (Read refuses the key files it knows by name).
  - A test chat message carries no thread or reply id.
  - A connector's server is matched as written (claude.ai's prefix the only alias), the same way in the guard and the
    connector check, and a tool name with a further `__` is never the given server's.
  - While floorboss runs, an agent runs on this machine only.
  - Every lookup let through in a window and not finished counts against the number you agreed, before the first one
    has run as after, checked under a lock so lookups started at once can't pass it; one declined at its prompt
    holds its slot until the window ends.
  - A long transcript is read to the end (up to 4 seconds; past that, while a run is live, the run's limits hold)
    before a call is judged.
  - `--…-file` inputs, JSON records and CRM inputs are opened once, as plain files at their own place (no symlink,
    FIFO or someone else's file in a shared temp folder).
  - A calendar or CSV export can't start a new line or field from a person's text.
  - A CRM task receipt is taken only for a task the guard let through and that ran, and only a done task counts as a
    reply check.
- From a second, scoped audit of connector answers (3 confirmed findings, all low, each with a regression test): a
  cancelled or declined calendar event frees a booking only when you or they organised it and it isn't older than
  the booking, otherwise you're asked once; a cancellation email older than the booking is asked about too (that check
  never saw the booking's time before, so a booking you record after their cancellation is now asked about, not
  dropped);
  your own declined answer on an invite wins over a colleague's acceptance; a review task done in the CRM settles
  only the question it asked; one CRM task id belongs to one task, and a task's done date can't be set ahead of now.
- From a full security audit (6 Nov, 11 confirmed findings, all low, each with a regression test): the inbox
  permission is saved only from your answer; a later setup scan or a free-text answer can't add a server to the ones
  a run may read; a browser window asks you at its first call; only a plain yes opens one; a message released once
  says so at its next prompt; a confirmation for a moved booking, or a follow-up offering a taken time, is refused
  at the send; a draft batch puts each draft in once; an attendee named like an id can't redirect your answers; a
  do-not-contact date that could be day/month or month/day counts as the later one; a webmail address from an
  enrichment export waits for your check like any other outside address.
- What a run reads can't be carried out through the side doors an independent review found: the researcher
  opens only pages its searches found and the companies' own sites, and its brief no longer carries CRM
  details; browser addresses have the same limits as web fetches (300 characters, no line break, no email
  address), and a CRM tenant's own subdomain asks first; people-data lookups carry one listed person only;
  the session that ran floorboss can't use connected tools floorboss doesn't use, or Claude Code tools it has
  no rule for, until it ends, and a resumed session gets those limits back; staged drafts keep to their own
  thread; a write through a link that doesn't exist yet is judged by where it lands; the CRM test task is in
  floorboss's own words, once.
- `npm run self-check` checks the security claims on your own copy; SECURITY.md lists everything floorboss
  can write and where your data can go. CI pins every action to a commit, with a test that holds it to that,
  and adds OpenSSF Scorecard.
- The README says what floorboss depends on (no third-party packages), what its hooks run and when, how to
  pin a release by commit, and how it treats text in your files as data, never instructions. The opening
  notice says the last of these too.
- Connector discovery: a proposal, one read-only test call per job, and saved recipes.
- A guard hook that checks every call to a connected tool and Claude's own file tools; send tools only when
  sending is on, one message at a time; a prompt before every send, CRM task, new CRM contact, staged batch, paid lookup and
  page of the event's own site, recorded only once the call has run; every tool on a people-data server counts
  against the lookups you agreed to; a do-not-contact match stays until you release the person; data kept in
  `~/.floorboss/` with private file permissions.
- During a run, Claude's web fetches reach only event and connector sites, and no address or search query
  may be long enough to carry data out. A floorboss script can't have another command joined to it, and a
  write through a link in the data folder can't reach key files or leave the folder. Script inputs come
  only from the data folder or the temp folder; lists you name, and list paths you save, can also come
  from the working folder. A floorboss script call is `node` and one of floorboss's own scripts, with nothing
  before it and no flags between.
- The approval gate, the outbox and every send take the critic's verdict, the checks and the text from
  floorboss's own records, never from a draft file Claude can edit. A draft changed outside floorboss's own
  edit command goes back to the critic. A script's output goes only into a work folder, never over a record.
- A follow-up you drop, or send back for a rewrite, never goes with its old approval. "skip review" never
  passes a text the critic failed. A confirmation carries no link or outside address (your own email and a
  phone number are fine) and stays under 70 words.
- Drafts with invisible or control characters, or a line break in the subject, fail the checks.
- Your own outbound instructions file must sit in a `.claude/agents` or `.claude/skills` folder.
- No third-party packages: floorboss runs only Node's built-in modules and its own scripts.

### Known limits
- An approved first message whose offered time someone else booked, or that has passed, waits in the send list as
  "redraft it with new times", and nothing hands it out again by itself: `outreach revise` on it brings it back.
- An approved follow-up whose offered time someone else books leaves the outbox page; the send list gives the reason.
