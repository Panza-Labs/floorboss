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

How floorboss is built to resist these: the critic and the outreach writer agents can only list file
names (they can't read, write or call anything; the writer gets the user's instructions inside its brief),
the researcher has web search and fetch only, scripts (not the model) parse every file and pasted status,
attendee notes are fenced as untrusted and never reach the critic, the outbox escapes every field, links only
to LinkedIn, known event apps and the event's own site, and its Content-Security-Policy blocks external
loads, and all data lives in `~/.floorboss/` (or `FLOORBOSS_HOME`) with private file permissions.

A guard hook (`hooks/guard.mjs`) checks every MCP call and Claude's own file tools. Commands pre-approve only
floorboss's scripts and reads and writes in its data folder. Claude never reads keys, credentials, shell
histories or browser profiles, and never edits floorboss's records. While a run is under way (tied to the
Claude session that ran it, until that session ends), tools may only read, the browser opens only pages
floorboss has a reason to and never runs script, and Claude writes only to the data folder and the temp
folder. WebFetch is gated during a run too: it opens only LinkedIn profiles, known event apps and the event
sites the user named, and no web address or search query may run past 300 characters, a line break or an
email address, so WebFetch should not be on "always allow" in a floorboss session. Opening a browser window (to send notes in an event app or LinkedIn, or to log messages in your CRM) asks you at its first browser call, saying what the window lets the browser do; until you allow it, every call in it asks. The CRM log window is held to the same rules as the send window: only the CRM's contact, record,
search and task pages, only the listed messages and their people's own details typed, and a prompt with the
full text before each message goes in. Every send, test call, CRM task, new CRM contact, browser note and logged message asks
the user, showing the full text; a batch of mailbox drafts asks once, listing who each is to. Names and notes from lists and CRMs are scrubbed before they appear in a permission prompt (letters and a little punctuation only, cut short, quoted, with the person's id and address beside them); the approved text is shown verbatim under its own label. A message floorboss already let through once says so at its next prompt, and a draft batch's yes puts each draft in once. A PostToolUse hook records an ask (a lookup counted, a draft batch confirmed, a window allowed) only after the call has run, so a declined prompt is asked again and never counts as a yes. If the guard can't start or check a call in time, the call is blocked. The records live in
files a session could write, so that prompt is the final check: never set a send tool to "always allow".

## Where your data can go

floorboss's own scripts make no network calls (`npm run self-check` checks this). Your lists, CRM records and
mail leave your machine only through Claude and the tools you connected, and the guard holds those calls
while a run is under way:

- **Messages, drafts, CRM tasks and new CRM contacts** carry only what you approved or what floorboss listed,
  to the one person listed, and ask you each time (the table below).
- **Web pages and searches** take no address or query over 300 characters, with a line break or with an
  email address in it. WebFetch opens only LinkedIn profiles, the event apps floorboss knows and the event
  sites you named. The researcher (the one agent with the open web) opens only pages its own searches found
  and the sites of companies on your list. Its brief is a company and people's names and titles: what your
  CRM says about them stays with floorboss.
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

### What floorboss can't control

- **Anthropic.** floorboss runs inside Claude Code, so what Claude reads (your lists, CRM records, mail,
  web pages) is sent to Anthropic's model as part of the conversation, under your Claude account's terms.
- **Your session files.** Claude Code keeps each conversation in `~/.claude/projects/`, outside
  floorboss's private data folder. If that folder is synced or backed up, so is what Claude read.
- **Claude Code's own settings.** Its permission mode decides whether a call the guard lets through still
  asks you. Auto-approve or "always allow" on a send tool removes that prompt; don't use them for floorboss.
- **The services you connect.** A CRM, mailbox or people-data tool keeps and logs what it's given under its
  own rules (CRM audit logs, what coworkers can see, a vendor's retention).
- **Web search and pages.** Searches go to the search provider Claude Code uses, and the pages the browser
  opens run their own scripts and trackers. A LinkedIn profile you open while signed in shows you as a
  viewer.
- **Delivery.** Mail, chat and LinkedIn providers handle every message that's sent.

## Everything floorboss can write, and where

Nothing below happens without your yes for that kind of write in setup, and each one asks you again at the
moment it happens, showing what goes where. The guard holds every call to the saved recipe for that tool: the
same server, the same tool, and only the fields listed here. Anything else is refused.

| What | Where it goes | What it can carry | Asked | Held by |
|---|---|---|---|---|
| A send (email, chat) | your mailbox or chat tool, to one recipient | the approved message, word for word: recipient, subject, body, and the thread of the message before it | before every message, with the whole text | guard: one listed, approved item, sent once; `test/security-guard.test.mjs` |
| A draft in your mailbox | your own drafts folder | the same fields as a send; nothing is sent | once per batch, naming who each is to | guard: listed drafts only; `test/security-round3.test.mjs` |
| An event-app note (LinkedIn: in the code, not yet tested; see the README) | the app, in your browser | the approved note, to the profile floorboss listed | before every note, with the whole text | the browser send window: only that profile's page, no script; `test/security-round2.test.mjs` |
| A CRM task | your CRM | a title, a body, a due date and the one contact it's about | before every task | guard: listed tasks only; `test/security-round7.test.mjs` |
| A new CRM contact | your CRM, the server floorboss reads people from | name, email, company and title, as on the list; no owner, list, stage or other field | before every contact; each person once | guard and once-only marker; `test/crm-new-contacts.test.mjs`, `test/security-round8.test.mjs` |
| A logged message | your CRM record for that person, in your browser | the message as sent; with your yes in setup, their LinkedIn address and title where the record has none | before every message, with the full text | the CRM log window: only the CRM's contact, record, search and task pages; `test/security-round2.test.mjs` |
| A people-data lookup | your people-data tool (Apollo, Clay and the like) | the person's name and company, to find an email | the count first, then the calls | the lookup window, and only as many as you agreed |
| Files | `~/.floorboss/` (or `FLOORBOSS_HOME`), and the temp folder | your event records, drafts, the outbox page | no | guard: Claude's file tools write nowhere else during a run; `test/security-supplychain.test.mjs` |

floorboss never deletes or merges a record in a connected tool, never changes a field that has a value, never
changes who owns one, and never adds anyone to a list, sequence or campaign. The one update is the logged message's:
with your yes in setup, it fills a person's LinkedIn address and title where their record has none.

## Check it yourself

You don't need to read floorboss's code to check the main claims. From a copy of the repository, with
Node.js 22 or later:

```
npm run self-check
```

It changes nothing, installs nothing and makes no network call. It checks, and prints each result:

- `package.json` has no dependencies and no install scripts, and there's no lockfile or `node_modules`;
- every import is a Node.js built-in or one of floorboss's own files;
- no script uses a network module, `fetch` or a remote import;
- the only processes floorboss starts are Node.js running its own scripts, and your system's opener for the
  outbox page (it prints each place);
- the hooks run only `hooks/guard.mjs` and `hooks/remind.mjs`;
- every GitHub Action in CI is pinned to a full commit, and no workflow can write to the code;
- the security tests pass, in a throwaway home folder that isn't yours.

Then, in Claude Code, `/hooks` lists every hook and the command it runs.

## How the repository is kept

- **CI** runs the tests on Node.js 22, 24 and 26 and the self-check, on every push. Its workflows start with no
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
- **Reviews.** floorboss's security reviews so far were done with independent AI agents that had no part in
  building the code, each given only the code and the claims to break, with every finding fixed and kept as a
  test (`test/security-*.test.mjs`). No outside firm has audited it yet.

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
- **Inside the CRM log window.** Once you allow the window, the browser may type a listed person's own details
  (name, email, company) to find their record, and floorboss can't tell a search box from a new-contact form. It
  never types anything else there, and each message's text still asks.
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
  permission prompt before each send shows the full text and anything you released, so read it.
- **The critic's verdict.** Claude runs the critic and passes back what it said. A PASS that Claude made up
  can't be told apart from a real one. Confirmations don't go to the critic at all: the scripts keep them
  short and refuse any link or outside address they recognise (your own email and a phone number are fine).
- **Your connected tools.** CRM lookups (opt-outs among them), mailbox history, replies, bounces and
  calendar times come back through files Claude writes. An opt-out or a reply that Claude leaves out is
  never seen.
- **CRM records you found or imported.** `crm-records --via check` and `--via import` record which CRM record
  belongs to whom from what Claude read in the CRM or an export; floorboss can't tie them to a call it saw, as it
  does for records it created.
- **Your context files.** What you bring, your voice and who you want to meet live in `~/.floorboss/` and
  can be edited without a prompt. The critic checks a draft's claims against them.
- **Sending off, the default.** There is no prompt, because you send each message yourself. The outbox's
  "passed" and "approved" labels rest on the points above, so read each message as you paste it.
