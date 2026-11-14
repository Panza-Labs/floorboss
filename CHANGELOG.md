# Changelog

All notable changes to floorboss are listed here. The format follows Keep a Changelog.

## [0.1.0] (unreleased)

The first public version.

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
  both pass; a meeting confirmation, which answers the person's booking, is the one exception), and the send list, task list and stage list list the earliest step and hold the other. A step
  recorded as sent out of order (by hand, or found in the mailbox) passes over the earlier steps that hadn't gone
  (their text was written to come before it), and the next step counts its gap from that send. With the default spacing, three timings differ from before: a message sent
  late (after its planned day) a day or less before the event starts, or during it, no longer gets a follow-up
  after it; with sending off, a last follow-up that fits before the event's last day is now offered (it used to need
  room for one more gap after it), as sending on always did; and zones at UTC+12 or further east read the lead time
  on the event's own date. Answers are read whole ("every other day", "a fortnight", "3 días, luego una semana"); one with a
  part floorboss can't read, a negation, a comparison, an ordinal or a channel is asked again, never half saved.
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

### Meeting day
- `/floorboss:agenda`: a brief for each booked meeting (who they are, how you know them, what's new, what to
  talk about), as a page, a short version and an `.ics` file. It names the companies before any web search.

### Connections and safety
- A subagent can hand its result back during a run on current Claude Code, which delivers results through a tool of its
  own that the guard refused as unknown: critics, researchers and writers did the work and couldn't report it.
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
