// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Onboarding as a decision tree. After the scan, every question has a condition: it's asked only when it
// applies to this user's setup and earlier answers, and anything skipped says why. Rounds go in order:
// scan, event, tools, list, tone. planQuestions returns the next round's open questions (a few at a time).
//
// state: { inv (scan summary), cfg (settings), ev (event or null), ans (onboarding answers), slots (count),
//          list: { rows, with_email } | null, days (days until the event, or null) }
// Each node: id, round, when(s) → applies?, done(s) → answered?, ask(s) → text, options(s) → [...], saves.

import { EVENT_ANSWERS } from '../../../lib/scope.mjs';
const any = (a) => Array.isArray(a) && a.length > 0;
// A server as a person would name it: "claude_ai_Gmail" is Gmail.
const pretty = (x) =>
  x
    .replace(/^[a-z]+:/, '')
    .replace(/^claude_ai_/i, '')
    .replace(/_+/g, ' ')
    .trim();
const names = (s, k) => (s.inv?.found?.[k] || []).map(pretty);
const team = (s) => s.ans.works_alone === false;
const crmChosen = (s) => ['connector', 'export', 'spreadsheet', 'home-made', 'other'].includes(s.ans.crm_choice);

// Phases: "first" is what's needed to show the user who on their list fits (event, goal, the list, the tools,
// who must never be contacted); "triage" is asked once the CRM has been read, with real names and counts;
// "later" comes after the user has seen the shortlist (free time, tone, proof, sending). Anything that can be
// inferred or defaulted (defaultsFor) is never asked: repeats, and questions the setup already answers, cost
// the user's trust.
// Selling (or partnerships) has an offer and a sales opt-out line; hiring and research have a company and a team
// but nothing to sell; a job search or networking has neither.
const seller = (s) => !/job|networking|hiring|research/.test(s.ans.goal_type || '');
const hasCompany = (s) => !/job|networking/.test(s.ans.goal_type || '');
const englishZone = (z) =>
  /^(America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Toronto|Vancouver|Detroit|Boston)|Europe\/(London|Dublin)|Asia\/Singapore|Australia\/|Pacific\/Auckland)/.test(
    z || ''
  );

// How much setup the user wants, asked first (after the scan): quick, standard or full. Each node has the lowest
// level it's asked at (none: every level); a node above the chosen level isn't asked, and defaultsFor fills in
// its safe default. Options and their costs are said from the scan, so "quick" with a CRM connected says plainly
// that the CRM won't be checked.
export const LEVELS = ['quick', 'standard', 'full'];
const LEVEL_OF = {
  inventory: 'standard',
  browser: 'standard',
  tools: 'standard',
  crm_use: 'standard',
  mailbox_use: 'standard',
  calendar_use: 'standard',
  crm_where: 'standard',
  crm_export: 'standard',
  team: 'standard',
  colleagues: 'standard',
  colleague_notes: 'standard',
  crm_name: 'standard',
  coworker_contacts: 'standard',
  customers: 'standard',
  lost_deals: 'standard',
  known_contacts: 'standard',
  samples: 'standard',
  basics: 'standard',
  about: 'standard',
  insights: 'standard',
  posture: 'full',
  seller_framing: 'full',
  sending: 'full',
  linkedin_send: 'full',
  send_setup: 'full',
  inbox_read: 'full',
  crm_log: 'full',
  crm_create_contacts: 'full',
  message_route: 'full',
  crm_fill_blanks: 'full',
  followups_mode: 'full',
  app_request_limit: 'full'
};
const levelOf = (s) => s.ans.setup_level || null;
export const levelAllows = (id, level) => !level || LEVELS.indexOf(LEVEL_OF[id] || 'quick') <= LEVELS.indexOf(level);
const found = (s, k) => names(s, k);
export function levelOptions(s) {
  const tools = [...found(s, 'crm'), ...found(s, 'email'), ...found(s, 'calendar')];
  const crm = found(s, 'crm');
  return [
    `quick${tools.length ? '' : ' (recommended)'}: your list, who you want to meet and what you offer, then drafts for you to send yourself. It assumes you work alone, with no CRM and no writing samples, and asks before any web research.${tools.length ? ` Nothing connected is used${crm.length ? `, so ${crm.join(' or ')} isn't checked: someone you already work with, a coworker's contact or an opt-out could get a first-time note` : ''}.` : ''}`,
    `standard${tools.length ? ' (recommended)' : ''}: also checks the list against ${tools.length ? tools.join(', ') : 'your CRM export or contacts file'} (who you know, who a coworker owns, who opted out), asks about your team and customers with real names and counts, and sets your tone from samples. You send the messages.`,
    `full: everything in standard, plus floorboss sends what you approve${found(s, 'email').length ? ` from ${found(s, 'email')[0]}` : ''}, reads replies to stop follow-ups (LinkedIn and the event app only with your yes for each), and logs messages in your CRM.`
  ];
}

// The import question names each skill by what the scan found it to be: a voice, tone or humanizer skill is
// "how you write", never company context, even when its description also mentions messaging.
const WRITING = /humani[sz]e|tone|voice|style|writing|copy ?edit|proofread/i;
export function importAsk(s) {
  const voice = names(s, 'voice');
  const company = names(s, 'company_context').filter((n) => !voice.includes(n) && !WRITING.test(n));
  const writingToo = names(s, 'company_context').filter((n) => !voice.includes(n) && WRITING.test(n));
  const how = [...voice, ...writingToo].slice(0, 6),
    what = company.slice(0, 6);
  const parts = [
    how.length ? `${how.join(', ')} for how you write` : null,
    what.length ? `${what.join(', ')} for what you can say about your company` : null
  ].filter(Boolean);
  return `Use ${parts.join(', and ')}?`;
}

export const NODES = [
  {
    id: 'setup_level',
    round: 'scan',
    phase: 'first',
    when: () => true,
    done: (s) => !!s.ans.setup_level,
    ask: (s) => 'How much setup do you want? You can change it any time ("more setup").',
    options: (s) => levelOptions(s),
    saves: 'answers: setup_level (quick | standard | full)'
  },
  // A returning user, on a new event: their setup is shown once and confirmed, never asked again question by question.
  {
    id: 'reuse_setup',
    round: 'event',
    phase: 'first',
    when: (s) => !!s.ev && !!s.ans.setup_level && !s.cfg.goal && Object.keys(s.onboarding?.events || {}).some((k) => k !== s.ev.slug),
    done: (s) => s.ans.setup_reused === true,
    ask: (s) =>
      `Same setup as last time? ${[`${s.ans.setup_level} setup`, s.ans.crm_choice && s.ans.crm_choice !== 'none' ? `your CRM (${s.ans.crm_server || s.ans.crm_label || (['other', 'export', 'spreadsheet', 'home-made'].includes(s.ans.crm_choice) ? 'a CSV export' : s.ans.crm_choice)})` : 'no CRM', s.ans.mailbox_choice === 'yes' ? 'your mailbox' : null, s.ans.works_alone === false ? `your team (${(s.cfg.colleagues || []).join(', ') || 'named before'})` : 'just you', s.cfg.own_company ? `${s.cfg.own_company}` : null, (s.ans.sending_channels || []).length ? `sending by ${[].concat(s.ans.sending_channels).join(', ')}` : 'you send the messages'].filter(Boolean).join(', ')}. Your do-not-contact list and voice carry over too. Say yes, or what changed.`,
    options: () => ['yes, same setup', 'something changed: <what>'],
    saves: 'answers: setup_reused'
  },
  // first: scan
  {
    id: 'inventory',
    round: 'scan',
    phase: 'first',
    when: (s) => !s.inv || (s.inv.outbound !== 'none' && any(s.inv.writers)),
    done: (s) => !!s.inv && s.ans.inventory_confirmed === true,
    ask: (s) =>
      !s.inv
        ? 'Run the scan first.'
        : `I found ${(s.inv?.writers || []).map((w) => w.name).join(', ')}: what each one covers (writing, voice, company context). Use them? And is there anything else you use for outreach that isn't here?`,
    saves: 'answers: inventory_confirmed (true), extra_tools (their words, or null)'
  },
  // first: event
  {
    id: 'event',
    round: 'event',
    phase: 'first',
    when: () => true,
    done: (s) => !!s.ev,
    ask: (s) =>
      `${s.ans.event_hint ? `They named it already ("${s.ans.event_hint}"): don't ask for the name again; look it up and confirm in one line` : 'Which event is this for? A name or a link. (Look it up and confirm in one line'}: dates, city, and the event's own app for meetings if its site has one. Anything they say they're busy with goes into busy time later.${s.ans.event_hint ? '' : ')'}`,
    saves: 'the event (slot-finder create), onboarding --event; the app from the event\'s site in the same answer ({"app": "<name>"|null})'
  },
  {
    id: 'goal',
    round: 'event',
    phase: 'first',
    when: (s) => !!s.ev,
    done: (s) => !!s.cfg.goal,
    ask: (s) =>
      `${any(s.inv?.found?.company_context) || any(s.inv?.writers) ? 'Propose who to meet from their own outbound skill (its ICP), and about how many meetings, and ask: this, or narrower for this event?' : 'Who do you want to meet there, and about how many meetings? Anyone in particular? In your own words.'} Once they say, propose the one to three groups that follows (roles and kind of company, one line each) and save it with the goal, so it's never asked again.`,
    saves:
      'config: goal; answers: goal_type (classified from their words, never asked: selling | partnerships | hiring | job | networking | research), meetings_wanted (a number, or null), segments_confirmed; who-to-meet (the groups)'
  },
  {
    id: 'goal_type',
    round: 'event',
    phase: 'first',
    when: (s) => !!s.cfg.goal,
    done: (s) => !!s.ans.goal_type,
    ask: () => 'What are you there for, in a word?',
    options: () => ['selling', 'partnerships or design partners', 'hiring', 'looking for a job'],
    saves: 'answers: goal_type'
  },
  {
    id: 'segments',
    round: 'event',
    phase: 'first',
    when: (s) => !!s.cfg.goal && !!s.cfg.context_profile,
    done: (s) => s.ans.segments_confirmed === true,
    ask: () =>
      "Propose the groups you'll look for, from their goal (and their skill's ICP): for each, the roles and the kind of company, one line each. Ask: right, or change?",
    saves: 'who-to-meet (segments with company types); answers: segments_confirmed'
  },
  // first: the list, straight after the goal
  {
    id: 'list_source',
    round: 'event',
    phase: 'first',
    when: (s) => !!s.ev,
    done: (s) => (s.list?.rows || 0) > 0 || !!s.ans.list_source,
    ask: (s) =>
      `Where's the attendee list? Give the file's path, or say if it's only in ${s.ev?.app_name || 'the event app'} or on a website, or you don't have one yet.`,
    saves: 'answers: list_source (export | own | app | none), list_url (a link to the public page); a file path is loaded as the attendee list straight away'
  },
  {
    id: 'browser',
    round: 'event',
    phase: 'first',
    when: (s) => s.ans.list_source === 'app' && any(s.inv?.found?.browser),
    done: (s) => !!s.ans.browser_choice,
    ask: () =>
      "I can read the list for you in your own browser (read only; it never clicks message or book buttons). Check the app's terms first; it runs as you. Now, later, or not at all?",
    options: () => ['now', 'later', 'not at all'],
    saves: 'answers: browser_choice'
  },
  // first: tools, one confirm for everything connected
  {
    id: 'tools',
    round: 'tools',
    phase: 'first',
    when: (s) => any(s.inv?.found?.crm) || any(s.inv?.found?.email) || any(s.inv?.found?.calendar),
    done: (s) =>
      s.ans.tools_confirmed === true ||
      ((!!s.ans.crm_choice || !any(s.inv?.found?.crm)) &&
        (!!s.ans.mailbox_choice || !any(s.inv?.found?.email)) &&
        (!!s.ans.calendar_choice || !any(s.inv?.found?.calendar))),
    ask: (s) =>
      `Say in one line each what you'll use, and ask once: ${[any(s.inv?.found?.crm) && `"I'll check everyone against ${names(s, 'crm').join(' or ')} (who you know, who a coworker owns, who opted out)"`, any(s.inv?.found?.email) && `"see who you've already emailed in ${names(s, 'email').join(', ')}"`, any(s.inv?.found?.calendar) && `"read your free time from ${names(s, 'calendar').join(', ')}"`].filter(Boolean).join(', ')}. OK, or change any? Reading only; whether floorboss may send is a separate choice later.`,
    options: () => ['yes, use them', 'change some'],
    saves:
      'answers: crm_choice (connector | export | none) and crm_server, mailbox_choice (yes | no), calendar_choice (yes | no), tools_confirmed; each yes is connected right away'
  },
  {
    id: 'crm_use',
    round: 'tools',
    phase: 'first',
    when: (s) => any(s.inv?.found?.crm),
    done: (s) => !!s.ans.crm_choice,
    ask: (s) => `Which of ${names(s, 'crm').join(', ')} holds your contacts, owners and opt-outs for this outreach?`,
    options: (s) => [...names(s, 'crm').slice(0, 2), 'an export instead', 'none for this event'],
    saves: 'answers: crm_choice (connector | export | none) and crm_server (the one they use)'
  },
  {
    id: 'mailbox_use',
    round: 'tools',
    phase: 'first',
    when: (s) => any(s.inv?.found?.email),
    done: (s) => !!s.ans.mailbox_choice,
    ask: (s) => `Use ${names(s, 'email').join(', ')} to see who you already write to? (Reading only.)`,
    options: () => ['yes', 'no'],
    saves: 'answers: mailbox_choice'
  },
  {
    id: 'calendar_use',
    round: 'tools',
    phase: 'first',
    when: (s) => any(s.inv?.found?.calendar),
    done: (s) => !!s.ans.calendar_choice,
    ask: (s) => `Read your free time from ${names(s, 'calendar').join(', ')}?`,
    options: () => ['yes', "no, I'll type it"],
    saves: 'answers: calendar_choice'
  },
  {
    id: 'crm_where',
    round: 'tools',
    phase: 'first',
    when: (s) => !any(s.inv?.found?.crm) && hasCompany(s),
    done: (s) => !!s.ans.crm_choice,
    ask: () => "Where do you keep your contacts and who you've talked to?",
    options: () => ["a CRM that isn't connected here", 'a spreadsheet', 'something I built (an app, a database)', 'nowhere yet'],
    saves: 'answers: crm_choice (other | spreadsheet | home-made | none)'
  },
  {
    id: 'crm_export',
    round: 'tools',
    phase: 'first',
    when: (s) => ['export', 'spreadsheet', 'home-made', 'other'].includes(s.ans.crm_choice),
    done: (s) => !!s.ev?.crm?.path || !!s.ans.crm_path || s.ans.crm_export_skipped === true,
    ask: (s) =>
      s.ans.crm_choice === 'home-made'
        ? 'Export it as a CSV with one row per person: name, company, email, who owns them, status (target, messaged, spoke…) and any do-not-contact flag. Floorboss maps "target" and "messaged" to not-warm and "spoke" to warm.'
        : "Export it as a CSV (with owner, status and the opt-out field) and give me the path. I'll read the header and tell you which column I'll treat as opt-out.",
    saves:
      "answers: crm_path (the file; it's saved on the event and used at triage), or crm_export_skipped if they can't, and crm_opt_out_none when they say it has no opt-out column"
  },
  {
    id: 'company',
    round: 'tools',
    phase: 'first',
    when: (s) => hasCompany(s),
    done: (s) => !!s.cfg.own_company || s.ans.company_asked === true,
    ask: (s) =>
      `Propose their company and email domain (from ${s.ans.mailbox_choice === 'yes' ? "the connected mailbox's address, " : ''}their skills and the domains on the list; never read a tool they didn't agree to) and ask only to confirm, so nobody there is contacted. "No company" is a fine answer.`,
    saves: 'config: own_company, own_domains; answers: company_asked'
  },
  {
    id: 'team',
    round: 'tools',
    phase: 'first',
    when: (s) => hasCompany(s),
    done: (s) => typeof s.ans.works_alone === 'boolean',
    ask: (s) =>
      `Just you, or is your team working this event or these accounts too? If a team, who? (They're never contacted.${crmChosen(s) || s.ans.crm_choice === 'connector' ? ' Propose the other owners in the CRM.' : ''})`,
    options: () => ['just me', 'my team too: <names>'],
    saves: 'answers: works_alone, colleagues_asked; config: colleagues'
  },
  {
    id: 'colleagues',
    round: 'tools',
    phase: 'first',
    when: team,
    done: (s) => s.ans.colleagues_asked === true,
    ask: () => "Who else from your team is going, or works these accounts? (They're never contacted.)",
    saves: 'config: colleagues; answers: colleagues_asked'
  },
  // Asked once, with the team: someone a coworker holds is left to them; a short note to the coworker is optional.
  {
    id: 'colleague_notes',
    round: 'tools',
    phase: 'first',
    when: team,
    done: (s) => s.ans.colleague_notes_asked === true,
    ask: () =>
      'When someone on the list belongs to a coworker (their contact or their account), floorboss leaves them to that coworker. Should it also draft a short note to the coworker ("Ana from Acme is at the event: will you reach out?") for you to pass on?',
    options: () => ['no, just leave them to my coworker', 'yes, draft a note to the coworker'],
    saves: 'config: colleague_notes (true | false); answers: colleague_notes_asked'
  },
  {
    id: 'dnc',
    round: 'tools',
    phase: 'first',
    when: () => true,
    done: (s) => s.ans.dnc_asked === true,
    ask: (s) =>
      `${hasCompany(s) ? 'Anyone, or any company, that must never be contacted? A do-not-contact file, names, or companies (a competitor, a partner)' : "Anyone you'd rather not write to (a former employer, people you already know well)? Names, or a file"}. Or none.${s.ans.crm_choice && s.ans.crm_choice !== 'none' ? ' Opt-outs in your CRM apply without asking, and stop notes too where your CRM tool returns notes.' : ''}`,
    saves: 'answers: dnc_path (a file of people) and accounts_path (a file of companies), dnc_asked, accounts_asked'
  },
  {
    id: 'accounts',
    round: 'tools',
    phase: 'first',
    when: () => false,
    done: () => true,
    ask: () => '',
    saves: 'answers: accounts_path (a file) and accounts_asked'
  },
  {
    id: 'app',
    round: 'tools',
    phase: 'first',
    when: (s) => !!s.ev,
    done: (s) => !!(s.ev?.app_name || s.ev?.no_app),
    ask: () => "Check the event's site for its own app for messages and meetings, and say what you found; ask only if it isn't clear.",
    saves: "slot-finder app --name (or none). Confirmed from the event's site; until then, none"
  },
  // triage: once the CRM (or its export) has been read, with names and counts from it
  {
    id: 'crm_name',
    round: 'tools',
    phase: 'triage',
    when: (s) => crmChosen(s),
    done: (s) => !!s.cfg.crm_user_name,
    ask: () => 'Propose the CRM owner that is the user (their name, their mailbox address) from the owners in the records you read, and ask only to confirm.',
    saves: 'config: crm_user_name'
  },
  {
    id: 'coworker_contacts',
    round: 'tools',
    phase: 'triage',
    when: (s) => team(s) && crmChosen(s),
    done: (s) => !!s.cfg.coworker_contacts,
    ask: () =>
      'Say how many people on the list each coworker owns in the CRM (names and counts), then ask how careful to be with them. It can differ per coworker ("Noa: leave alone; Dana: warn me"). Opt-outs, stop requests and your do-not-contact list apply whatever you pick.',
    options: () => [
      'leave them alone, and list them for me (recommended)',
      'ask me each time',
      'write to them, but warn me before sending',
      'treat them as mine'
    ],
    saves: 'config: coworker_contacts (leave | ask | warn | mine) and coworker_overrides {"<coworker name>": "<mode>"}'
  },
  {
    id: 'customers',
    round: 'tools',
    phase: 'triage',
    when: (s) => crmChosen(s),
    done: (s) => !!s.cfg.customer_rule,
    ask: () =>
      'Say how many on the list are at customers (from the CRM). If the CRM has no close date or deal fields, ask one thing: a warm note, ask me each time, or leave them alone? Only with deal fields, ask the three cases: closed recently, on the won deal, someone else there.',
    options: () => ['a warm note (recommended)', 'ask me about each', 'leave customers alone'],
    saves:
      'config: customer_rule {"recent_months": 6, "recent": "hold", "on_deal": "warm", "other": "ask"} (each of warm, ask, hold, cold); without deal fields the one choice goes in all three'
  },
  // How long a lost deal or a rejection keeps someone off the list, counted from the last contact (or the
  // rejection's date): the user's call, as sales cycles differ.
  {
    id: 'lost_deals',
    round: 'tools',
    phase: 'triage',
    when: (s) => crmChosen(s),
    done: (s) => s.ans.lost_deals_asked === true,
    ask: () =>
      'Say how many on the list have a lost deal or a rejection in the CRM, with when they were last in touch, then ask: how long since that last contact before floorboss treats them as fair to approach again? Until then they are left out and listed with the reason.',
    options: () => ['3 months', '6 months (recommended)', '12 months', 'no wait: approach them like anyone else'],
    saves: 'config: rejected_months (a whole number of months; 0 for no wait); answers: lost_deals_asked'
  },
  // The opt-out line on emails to people the user already knows: the user's call, never floorboss's default.
  {
    id: 'optout_known',
    round: 'tools',
    phase: 'triage',
    when: (s) => crmChosen(s) && s.cfg.optout_sentence !== '',
    done: (s) => typeof s.cfg.optout_known === 'boolean',
    ask: (s) =>
      (seller(s)
        ? 'Emails to people you already know (customers, open deals, anyone marked warm):'
        : 'Emails to people you already know (anyone your records show as warm, such as candidates already in your process):') +
      ' should they end with the opt-out line too ("If this isn\'t relevant, say so and I won\'t follow up.")? Cold emails keep it either way. Check what the email rules you work under ask for.',
    options: () => ['yes, on every email', 'only on cold emails'],
    saves: 'config: optout_known (true: every email; false: cold emails only)'
  },
  {
    id: 'known_contacts',
    round: 'tools',
    phase: 'triage',
    when: (s) => hasCompany(s) && (!s.ans.crm_choice || s.ans.crm_choice === 'none') && (!any(s.inv?.found?.email) || s.ans.mailbox_choice === 'no'),
    done: (s) => s.ans.known_asked === true,
    ask: () =>
      "Know anyone on this list already? Floorboss can't see who you know without a CRM or mailbox. Your LinkedIn connections file covers it (LinkedIn: Settings, Data privacy, Get a copy of your data, Connections). Have one, or skip?",
    options: () => ["I'll give you one", 'skip'],
    saves: 'config: known_contacts_paths (a list of files); answers: known_asked'
  },
  // With a people-data tool (Apollo, Clay…), asked whenever some on the list have no email: those it can fill.
  {
    id: 'contact_details',
    round: 'list',
    phase: 'triage',
    when: (s) => (s.list?.rows || 0) > 0 && (s.list.with_email || 0) / s.list.rows < (any(s.inv?.found?.enrichment) ? 0.95 : 0.5),
    done: (s) => !!s.ans.contact_details,
    ask: (s) =>
      `Most people on the list have no email${s.ev?.app_name ? ` (you can still reach them in ${s.ev.app_name})` : ''}. Find emails or LinkedIn profiles for the people who fit?${crmChosen(s) ? ' Your CRM is checked first.' : ''}`,
    options: (s) => [
      ...(any(s.inv?.found?.enrichment) ? [`yes, with ${names(s, 'enrichment')[0]} (you'll see how many lookups first)`] : []),
      'yes: give me a CSV to fill in',
      s.ev?.app_name ? 'no, the app is enough' : "no, I'll find them myself"
    ],
    saves: 'answers: contact_details (mcp | csv | app | later), enrich_server (the tool, for mcp)'
  },
  // later: after the shortlist
  // Over 40 slots is everyone back to back: asked once more, which hours they'd really take, or "keep them all".
  {
    id: 'free_time',
    round: 'tools',
    phase: 'later',
    when: (s) => !!s.ev,
    done: (s) => s.slots > 0 && (s.slots <= 40 || s.ans.many_slots_ok === true),
    ask: (s) =>
      s.slots > 40
        ? `That's ${s.slots} meetings back to back. Which hours will you really take meetings (leave out talks, meals, travel, a break between meetings)? Or say "keep them all".`
        : s.ans.calendar_choice === 'yes'
          ? 'Say what the calendar shows as busy on the event days (from the calendar-busy file), then ask when they want to meet; their busy times are taken out of whatever they say.'
          : `When are you free to meet? Say it the way you'd say it (times are ${s.ev?.time_zone ? 'event time' : 'local'}; say if you mean another zone).`,
    saves: 'slot-finder build (from the days you read in their words); answers: many_slots_ok when they keep them all'
  },
  {
    id: 'drafting_mode',
    round: 'tone',
    phase: 'later',
    when: () => true,
    done: (s) => !!s.cfg.drafting_mode,
    ask: () => 'Who writes the messages: your tools or floorboss?',
    options: () => ['your tools', 'a mix', 'floorboss'],
    saves: 'config: drafting_mode (floorboss | delegate | blend)'
  },
  {
    id: 'drafter',
    round: 'tone',
    phase: 'later',
    when: (s) => ['delegate', 'blend'].includes(s.cfg.drafting_mode),
    done: (s) => !!s.cfg.drafter,
    ask: (s) =>
      `Read ${s.inv?.writers?.map((w) => w.name).join(', ') || 'their writer'} and say back in one line what it covers (channels; first messages, follow-ups, confirmations) and what it lacks; its voice, claims, banned words and sign-off are carried into floorboss's files. Ask only if several look alike (which is current?). An agent that can send or write is saved as type "instructions" with its file as path.`,
    saves: 'config: drafter {name, invoke, type, covers, gaps}; answers: import_context'
  },
  {
    id: 'import_context',
    round: 'tone',
    phase: 'later',
    when: (s) => (any(s.inv?.found?.voice) || any(s.inv?.found?.company_context)) && s.cfg.drafting_mode === 'floorboss',
    done: (s) => !!s.ans.import_context,
    ask: (s) => importAsk(s),
    options: () => ['yes, import them', 'only as a reference', 'no'],
    saves: "answers: import_context; yes → carry rules, claims, banned words and sign-off into floorboss's voice and what-you-bring (never edit their files)"
  },
  {
    id: 'posture',
    round: 'tone',
    phase: 'later',
    when: (s) => !!s.ans.goal_type && s.cfg.drafting_mode !== 'delegate',
    done: (s) => !!s.ans.posture,
    ask: () => 'How should you come across in the first message?',
    options: (s) =>
      /job/.test(s.ans.goal_type)
        ? ['someone looking for their next role', 'a peer comparing notes']
        : ['a seller with a clear offer', 'a peer comparing notes', 'an expert with a point of view'],
    saves: 'answers: posture; into the voice file'
  },
  {
    id: 'seller_framing',
    round: 'tone',
    phase: 'later',
    when: (s) => /peer/.test(s.ans.posture || '') && seller(s),
    done: (s) => !!s.ans.seller_framing,
    ask: () =>
      'Salespeople read "compare notes on your product" as a lead. Add "not buying anything, just comparing notes" for sellers (AE, BDR, partnerships)?',
    options: () => ['yes, for sellers', 'no'],
    saves: 'answers: seller_framing; into the voice file'
  },
  {
    id: 'profile',
    round: 'tone',
    phase: 'later',
    when: () => true,
    done: (s) => !!s.cfg.context_profile,
    ask: () => 'A name for your profile.',
    saves: 'init-profile --profile <name>, config: context_profile'
  },
  {
    id: 'offer',
    round: 'tone',
    phase: 'later',
    when: (s) => seller(s) && s.cfg.drafting_mode !== 'delegate' && !any(s.inv?.found?.company_context),
    done: (s) => s.ans.offer_asked === true,
    ask: (s) =>
      `What does ${s.cfg.own_company || 'your company'} sell, to whom, and one result you can name (and may a message name that customer)? Anything a message must never say? A link to the site or a deck works: read it and propose the lines.`,
    saves: 'what-you-bring (the one-sentence offer, problems it solves, proof); answers: offer_asked'
  },
  {
    id: 'true_claims',
    round: 'tone',
    phase: 'later',
    when: () => true,
    done: (s) => s.ans.claims_confirmed === true,
    ask: (s) =>
      seller(s)
        ? "Here's what I have about you and your company: role, numbers, customers and proof, from what you said, your skills and your site. Tick what a message may say, and add anything missing (a number or a named customer you're allowed to use). Nothing else about you goes in."
        : `In two or three lines, what may a message say about you? Your role and years, one thing you built or ran, and what you're looking for${s.ans.goal_type === 'hiring' ? " (the role you're hiring for)" : ''}. If their skills or a site say it, propose the lines and ask only to tick them. Nothing else about you goes in.`,
    saves: 'what-you-bring; answers: claims_confirmed'
  },
  {
    id: 'samples',
    round: 'tone',
    phase: 'later',
    when: (s) => s.cfg.drafting_mode === 'floorboss' || (s.cfg.drafting_mode === 'blend' && (s.cfg.drafter?.gaps || []).includes('voice')),
    done: (s) => s.ans.samples_ok === true || s.ans.samples_skipped === true,
    ask: (s) =>
      `Three sample openings (casual and plain, warm, formal), written in ${(Array.isArray(s.cfg.languages) && s.cfg.languages[0]) || 'English'}: which is closest, and what would you change? Every change becomes a rule in your voice file. And if you have them, paste two to five emails you sent that got replies (or give their files); their length and how you open become your voice too. Or say "none".`,
    saves:
      'voice file (with the emails that got replies, their length and greeting); answers: samples_ok (or samples_skipped when an email they liked already shows their voice)'
  },
  {
    id: 'drafter_sample',
    round: 'tone',
    phase: 'later',
    when: (s) => ['delegate', 'blend'].includes(s.cfg.drafting_mode) && !!s.cfg.drafter,
    done: (s) => s.ans.drafter_sample_ok === true,
    ask: (s) => `A sample written by ${s.cfg.drafter.name || s.cfg.drafter.invoke} from a floorboss brief: is that how it should sound?`,
    saves: 'answers: drafter_sample_ok'
  },
  {
    id: 'languages',
    round: 'tone',
    phase: 'later',
    when: () => true,
    done: (s) => Array.isArray(s.cfg.languages) && s.cfg.languages.length > 0,
    ask: () =>
      'Which languages can you hold a meeting in yourself? A message is only ever written in one of those: someone who gets a note in German expects to meet in German.',
    options: () => ['English only', 'English and another: <which>', 'only another language: <which>'],
    saves: 'config: languages (a list, the first is the default) and, for each extra language, optout_sentences {"<language>": "<the opt-out line in it>"}'
  },
  {
    id: 'basics',
    round: 'tone',
    phase: 'later',
    when: () => true,
    done: (s) => s.ans.basics_asked === true,
    ask: (s) =>
      `Where will you meet people at ${s.ev?.name || 'the event'} once they say yes (a stand, a lounge, "I'll send it")?${seller(s) && s.ans.offer_asked === true ? '' : ' And anything a message must never say?'}`,
    saves: 'config: meeting_place; what-you-bring (never-say, only when asked here); answers: basics_asked'
  },
  { id: 'material', round: 'tone', phase: 'later', when: () => false, done: () => true, ask: () => '', saves: 'answers: material_asked' },
  // Who the sender is, in one line: the only thing a message may say about them (the critic fails anything else).
  {
    id: 'about',
    round: 'tone',
    phase: 'later',
    when: (s) => !s.ev?.mock && s.cfg.drafting_mode !== 'delegate' && !!s.cfg.context_profile && s.bring && !s.bring.about,
    done: (s) => s.ans.about_asked === true || !!s.bring?.about,
    ask: (s) =>
      `In one line, who are you to the people you write to? Your role and ${hasCompany(s) ? `company (e.g. "founder of ${s.cfg.own_company || 'Acme'}")` : 'what you do'}. A message says only this about you.`,
    saves: 'what-you-bring: About me; answers: about_asked'
  },
  // Optional: a few things the user knows that a reader may not. With none, drafts lean on questions.
  {
    id: 'insights',
    round: 'tone',
    phase: 'later',
    when: (s) => !s.ev?.mock && seller(s) && s.cfg.drafting_mode !== 'delegate' && !!s.cfg.context_profile && s.bring && !s.bring.insights,
    done: (s) => s.ans.insights_asked === true || !!s.bring?.insights,
    ask: () =>
      'what-you-bring has no "what you know that they don\'t" table: drafts will lean on questions, since there\'s nothing new to tell readers. Optional: one to three things you know from your work that a buyer may not (a pattern across your customers, where the time or money really goes), each with what it rests on. Or "none".',
    saves: 'what-you-bring: "what you know" rows; answers: insights_asked'
  },
  { id: 'company_caps', round: 'event', phase: 'later', when: () => false, done: () => true, ask: () => '', saves: 'config: company_caps' },
  { id: 'must_meet', round: 'event', phase: 'later', when: () => false, done: () => true, ask: () => '', saves: 'config: must_meet; answers: must_meet_asked' },
  {
    id: 'meetings_wanted',
    round: 'event',
    phase: 'later',
    when: () => false,
    done: () => true,
    ask: () => '',
    saves: 'config: meetings_wanted; answers: meetings_wanted_asked'
  },
  // Who signs the messages and where they live, at every level: without it the voice file keeps the template's
  // "Best, Sam" (which the critic fails), and the home zone would be guessed from the event.
  {
    id: 'about_you',
    round: 'event',
    phase: 'later',
    when: (s) => !!s.ev,
    done: (s) => s.ans.about_you_asked === true,
    ask: (s) => {
      const crmName = s.cfg.crm_user_name && !/^not an owner/.test(s.cfg.crm_user_name) && !s.cfg.crm_user_name.includes('|') ? s.cfg.crm_user_name : null;
      const from = [
        s.cfg.drafting_mode !== 'floorboss' ? 'their own skill or agent' : null,
        s.ans.mailbox_choice === 'yes' ? 'their mailbox signature' : null,
        crmName ? `the name they gave as theirs in the CRM (${crmName}${s.cfg.own_company ? `, ${s.cfg.own_company}` : ''})` : null
      ].filter(Boolean);
      return `How do you sign your messages (your name, and company if you add it), and which city do you live in?${from.length ? ` Propose the sign-off from ${from.join(' or ')}` : ''}${s.ans.calendar_choice === 'yes' ? `${from.length ? ', and' : ' Propose'} the city from the calendar's time zone` : ''}${from.length || s.ans.calendar_choice === 'yes' ? ', and ask only to confirm.' : ' Nothing to propose from: ask plainly, never suggest a name.'}`;
    },
    saves: 'voice file (sign-off, sender name); config: home_tz; answers: about_you_asked'
  },
  {
    id: 'home_tz',
    round: 'event',
    phase: 'later',
    when: (s) => !!s.ev && s.ans.about_you_asked === true,
    done: (s) => !!s.cfg.home_tz,
    ask: (s) =>
      `Where are you based? Times go out in event time; yours is shown beside them when it differs.${s.ans.calendar_choice === 'yes' ? " (Propose the calendar's own time zone.)" : ''}`,
    options: (s) => [`${s.ev?.city || s.ev?.time_zone || "the event's city"}`, 'somewhere else: <city>'],
    saves: 'config: home_tz (an IANA zone like Europe/Madrid)'
  },
  {
    id: 'app_request_limit',
    round: 'sending',
    phase: 'later',
    when: (s) => !!s.ev?.app_name && /app/.test(String(s.ans.sending_channels || '')),
    done: (s) => s.ans.app_limit_asked === true,
    ask: (s) => `How many meeting requests does ${s.ev.app_name} let you send, and how many have you used?`,
    saves: "config: app_request_limit (what's left, or null); answers: app_limit_asked"
  },
  {
    id: 'app_notes',
    round: 'sending',
    phase: 'later',
    when: () => false,
    done: () => true,
    ask: () => '',
    saves: 'config: app_note_times, app_note_event_name, app_note_optout; answers: app_notes_asked'
  }
];

// Sending: floorboss sends approved messages itself only where the user turns it on.
NODES.push(
  {
    id: 'sending',
    round: 'sending',
    phase: 'later',
    when: () => true,
    done: (s) => s.ans.sending_asked === true,
    ask: (s) =>
      ![s.inv?.found?.email, s.inv?.found?.chat, s.inv?.found?.browser].some(any)
        ? 'Nothing in your setup can send messages (no mailbox, chat app or browser is connected), so floorboss will prepare each message for you to send yourself. If you want it to send later, connect your mailbox to Claude and run /floorboss:start again.'
        : `Should floorboss send the messages itself once you approve them, or prepare them for you to send? It never sends anything you haven't approved, word for word: you'll see each person's whole sequence (first message and follow-ups) before anything goes. Where may it send?`,
    // Only what this setup can do: a channel with nothing connected to send on isn't offered.
    options: (s) =>
      [
        ...(any(s.inv?.found?.email) ? ['email (your connected mailbox)'] : []),
        ...(s.ev?.app_name && any(s.inv?.found?.browser) ? [`${s.ev.app_name} (in your browser)`] : []),
        ...(any(s.inv?.found?.chat) ? [`${names(s, 'chat').slice(0, 2).join(' / ')} (not yet tested)`] : []),
        ...(any(s.inv?.found?.browser) ? ['LinkedIn (in your browser; not yet tested; read the warning first)'] : []),
        "nowhere: I'll send them myself"
      ].slice(0, 4),
    saves:
      'answers: sending_channels (a list of email, app, chat, linkedin; empty for none) and sending_asked; email and chat need their send connection set up (discovery, with one test message to the user themselves)'
  },
  {
    id: 'linkedin_send',
    round: 'sending',
    phase: 'later',
    when: (s) => (s.ans.sending_channels || '').includes?.('linkedin'),
    done: (s) => s.ans.linkedin_send_ack === true || s.ans.linkedin_send_declined === true,
    ask: () =>
      'LinkedIn forbids automated messaging in its terms and restricts or suspends accounts it catches, sometimes permanently. Floorboss would type and send each approved message in your own browser, slowly, as you. The risk to your account is yours. Turn it on?',
    options: () => ['yes, I accept the risk', "no, I'll send LinkedIn messages myself"],
    saves: 'answers: linkedin_send_ack true, or linkedin_send_declined true'
  },
  {
    id: 'send_setup',
    round: 'sending',
    phase: 'later',
    when: (s) => /email|chat/.test(String(s.ans.sending_channels || '')),
    done: (s) => s.ans.send_setup_done === true || s.ans.send_setup_skipped === true || !!s.cfg.connectors?.['email.send'] || !!s.cfg.connectors?.['chat.send'],
    ask: (s) =>
      `To send ${/email/.test(String(s.ans.sending_channels)) ? 'email' : 'chat messages'} itself, floorboss needs the send tool set up: your own ${/email/.test(String(s.ans.sending_channels)) ? 'address' : 'number'} (the only place a test can go), then one test message to yourself that you check arrived. ${/email/.test(String(s.ans.sending_channels)) ? "Propose the connected mailbox's own address and ask only to confirm it" : 'Which number is yours'}?`,
    saves:
      'config: own_email / own_phone; then discovery with screen --sending, test-allow to that address or number, and save-recipe for email.send / chat.send (skills/connectors/SKILL.md); answers: send_setup_done, or send_setup_skipped (that channel then stays "you send it")'
  },
  {
    id: 'inbox_read',
    round: 'sending',
    phase: 'later',
    when: (s) =>
      any(s.inv?.found?.browser) && (/linkedin|app/.test(String(s.ans.sending_channels || '')) || !!s.ev?.app_name || s.ans.list_has_linkedin === true),
    done: (s) => s.ans.inbox_read_asked === true,
    ask: (s) =>
      `Should floorboss read replies in your browser, so it can stop follow-ups and spot a "yes" or a "no"? It only reads: it never types or clicks send there. You can say yes to each one separately: your LinkedIn messages${s.ev?.app_name ? `, ${s.ev.app_name}'s inbox` : ''}.${s.ans.crm_choice && s.ans.crm_choice !== 'none' ? ' And should the replies it finds be logged in your CRM?' : ''} If not, you'll be asked "has X replied?" before each follow-up.`,
    options: (s) => [
      "no, I'll tell you myself",
      `yes: ${['LinkedIn', ...(s.ev?.app_name ? [s.ev.app_name] : [])].join(' and ')}`,
      ...(s.ans.crm_choice && s.ans.crm_choice !== 'none' ? [`yes, and log the replies in my CRM`] : [])
    ],
    saves: 'config: inbox_read {"linkedin": true|false, "app": true|false}, log_replies (true|false); answers: inbox_read_asked'
  },
  {
    id: 'crm_log',
    round: 'sending',
    phase: 'later',
    when: (s) =>
      !!s.ans.crm_choice &&
      s.ans.crm_choice !== 'none' &&
      (/linkedin|app/.test(String(s.ans.sending_channels || '')) ||
        (!/email/.test(String(s.ans.sending_channels || '')) && (!!s.ev?.app_name || s.ans.list_has_linkedin === true))),
    done: (s) => !!s.cfg.crm_log,
    ask: () => 'When a LinkedIn or event-app message goes out, how should it get into your CRM? (Email logs itself if your CRM syncs your mailbox.)',
    options: (s) =>
      any(s.inv?.found?.browser)
        ? ['log it in my CRM in the browser, automatically (recommended)', 'make a CRM task for each', "I'll import a CSV from the outbox", "don't log them"]
        : ['make a CRM task for each (recommended)', "I'll import a CSV from the outbox", "don't log them"],
    saves: 'config: crm_log (browser | tasks | csv | none) and crm_name (what the CRM is called)'
  },
  {
    id: 'message_route',
    round: 'sending',
    phase: 'later',
    when: (s) => !!s.ans.sending_asked,
    done: (s) => !!s.ans.message_route_asked,
    ask: (s) =>
      `Which channel should each message go on, in order? The usual route is email, then ${s.ev?.app_name || 'the event app'}, then LinkedIn, then email. Anyone you can't reach on a step skips it. You can make it longer, shorter or a different order.`,
    options: () => ['email, app, linkedin, email (recommended)', 'email, email (no other channels)', 'your own order, like "email, linkedin, email"'],
    saves: 'config: route (a list of email, app, linkedin); answers: message_route_asked'
  },
  {
    id: 'crm_create_contacts',
    round: 'sending',
    phase: 'later',
    when: (s) => s.cfg.crm_log === 'browser',
    done: (s) => !!s.cfg.crm_create_contacts,
    ask: () =>
      "When someone you message (often LinkedIn-only) isn't a contact in your CRM yet, should floorboss create them, so the message can be logged? It creates a new contact only (name, company, title, email, LinkedIn URL) and never edits or merges existing records.",
    options: () => ['ask me each time (one list per batch) (recommended)', 'yes, create them', 'no, just list them for me'],
    saves: 'config: crm_create_contacts (yes | ask | no)'
  },
  {
    id: 'crm_fill_blanks',
    round: 'sending',
    phase: 'later',
    when: (s) => s.cfg.crm_log === 'browser',
    done: (s) => !!s.cfg.crm_fill_blanks,
    ask: () =>
      'While logging, should floorboss fill empty fields on existing contacts, like a missing LinkedIn URL or job title? It only fills blanks: a field that already has a value is never changed.',
    options: () => ['yes, fill empty fields (recommended)', "no, don't change existing contacts"],
    saves: 'config: crm_fill_blanks (yes | no)'
  },
  {
    id: 'followups_mode',
    round: 'sending',
    phase: 'later',
    when: (s) =>
      !!s.ans.sending_channels &&
      String(s.ans.sending_channels) !== '[]' &&
      String(s.ans.sending_channels) !== '' &&
      !(s.ans.send_setup_skipped === true && !/linkedin|app|chat/.test(String(s.ans.sending_channels))),
    done: (s) => !!s.cfg.sending?.followups,
    ask: () => "Once you approve someone's sequence, how should the follow-ups go?",
    options: (s) => [
      any(s.inv?.found?.email) || any(s.inv?.found?.crm)
        ? 'scheduled: each goes on its day unless they reply, book or say stop (your mailbox or CRM is checked first)'
        : "scheduled: each goes on its day unless they reply, book or say stop (you'll be asked whether anyone replied, since nothing connected can see replies)",
      'I approve each round of follow-ups in bulk'
    ],
    saves: 'config: sending {"channels": [...], "followups": "scheduled" | "each_round", "linkedin_ack": true|false}, all at once'
  }
);

export const ROUNDS = ['scan', 'event', 'tools', 'list', 'tone', 'sending'];

// A choice answered with the option's own text ("yes, use it (connector)") is read down to its value, so a
// condition never misses it and skips a question in silence.
export const CHOICES = {
  crm_choice: ['connector', 'export', 'spreadsheet', 'home-made', 'other', 'none'],
  list_source: ['export', 'own', 'app', 'none'],
  contact_details: ['mcp', 'csv', 'app', 'later']
};
export function choiceValue(key, v) {
  if (!CHOICES[key] || typeof v !== 'string') return v;
  const low = v.trim().toLowerCase();
  if (CHOICES[key].includes(low)) return low;
  const paren = /\(([a-z-]+)\)/.exec(low);
  if (paren && CHOICES[key].includes(paren[1])) return paren[1];
  return CHOICES[key].find((c) => new RegExp(`\\b${c}\\b`).test(low)) ?? v;
}
export function normalizeAnswers(ans) {
  return Object.fromEntries(Object.entries(ans || {}).map(([k, v]) => [k, choiceValue(k, v)]));
}
export const PHASES = ['first', 'triage', 'later'];
// phase: only that phase's questions (the flow asks "first" before the list is judged, "triage" once the CRM
// is read, "later" after the shortlist); none: every phase in order.
export function planQuestions(s0, { batch = 4, phase = null } = {}) {
  const s = { ...s0, ans: normalizeAnswers(s0.ans) };
  const st = { ans: {}, cfg: {}, ...s };
  for (const [ph, round] of (phase ? [phase] : PHASES).flatMap((p) => ROUNDS.map((r) => [p, r]))) {
    const nodes = NODES.filter((n) => n.round === round && (n.phase || 'first') === ph);
    const open = nodes.filter((n) => levelAllows(n.id, levelOf(st)) && n.when(st) && !n.done(st));
    if (!open.length) continue;
    const skipped = nodes
      .filter((n) => !levelAllows(n.id, levelOf(st)) || !n.when(st))
      .map((n) => ({ id: n.id, why: !levelAllows(n.id, levelOf(st)) ? `not part of ${levelOf(st)} setup` : skipWhy(n.id, st) }));
    return {
      round,
      phase: ph,
      questions: open.slice(0, batch).map((n) => ({ id: n.id, ask: n.ask(st), ...(n.options ? { options: n.options(st) } : {}), saves: n.saves })),
      more_in_round: Math.max(0, open.length - batch),
      skipped,
      done: false
    };
  }
  return { round: null, questions: [], done: true };
}

// What is never asked: worked out from the scan, the event and earlier answers. Returns only what is still
// unset, as {config, answers}; the flow saves it without a question (and says so in "ran").
export function defaultsFor(s0) {
  const s = { ans: {}, cfg: {}, ...s0, ans: normalizeAnswers(s0.ans) };
  const cfg = {},
    ans = {};
  const job = /job|networking/.test(s.ans.goal_type || '');
  if (s.cfg.goal && s.ans.goal_type && s.cfg.company_caps == null) cfg.company_caps = { mode: job ? 'one' : 'scale' };
  if (s.cfg.goal && s.ans.meetings_wanted_asked !== true) {
    ans.meetings_wanted_asked = true;
    if (s.cfg.meetings_wanted == null) cfg.meetings_wanted = 10;
  }
  if (s.ev && s.ans.must_meet_asked !== true) ans.must_meet_asked = true;
  // Handing the drafting to a skill or agent of the user's is their choice, asked; never a default from the scan.
  if (s.inv && !s.cfg.drafting_mode && s.inv.outbound === 'none') cfg.drafting_mode = 'floorboss';
  if (s.inv && s.inv.outbound === 'none' && s.ans.inventory_confirmed !== true) ans.inventory_confirmed = true;
  if (
    ['delegate', 'blend'].includes(s.cfg.drafting_mode || cfg.drafting_mode) &&
    !s.ans.import_context &&
    (any(s.inv?.found?.voice) || any(s.inv?.found?.company_context))
  )
    ans.import_context = 'yes';
  if (s.ans.goal_type && !s.ans.posture && (s.cfg.drafting_mode || cfg.drafting_mode) !== 'delegate')
    ans.posture = job
      ? 'someone looking for their next role'
      : /hiring/.test(s.ans.goal_type)
        ? 'a hiring manager'
        : /partner|research/.test(s.ans.goal_type)
          ? 'a peer comparing notes'
          : 'a seller with a clear offer';
  if (job && s.ans.goal_type) {
    if (typeof s.ans.works_alone !== 'boolean') ans.works_alone = true;
    if (!s.ans.crm_choice && !any(s.inv?.found?.crm)) ans.crm_choice = 'none';
    if (s.ans.company_asked !== true && !s.cfg.own_company) ans.company_asked = true;
  }
  // Not selling (a job, networking, research): no opt-out line, which reads like a sales email to the reader.
  // Sellers keep it unless they turn it off: commercial email needs a way to opt out in most places.
  if (s.ans.goal_type && !s.ans.optout_default_set) {
    ans.optout_default_set = true;
    if (/job|networking|research/.test(s.ans.goal_type)) cfg.optout_sentence = '';
  }
  if (s.ans.material_asked !== true) ans.material_asked = true;
  // The insights question is asked at standard and full, for a seller whose messages floorboss writes.
  if (s.ans.insights_asked !== true && (!seller(s) || (s.cfg.drafting_mode || cfg.drafting_mode) === 'delegate')) ans.insights_asked = true;
  if (s.ans.app_notes_asked !== true && s.ev?.app_name) ans.app_notes_asked = true;
  if (s.ans.accounts_asked !== true && s.ans.dnc_asked === true) ans.accounts_asked = true;
  if (!(Array.isArray(s.cfg.languages) && s.cfg.languages.length) && s.ev && englishZone(s.ev.time_zone) && s.cfg.home_tz && englishZone(s.cfg.home_tz))
    cfg.languages = ['English'];
  // The offer answer carries the proof: its claims aren't asked again (any level).
  if (s.ans.offer_asked === true && s.ans.claims_confirmed !== true) ans.claims_confirmed = true;
  // What a level leaves out gets its safe default: nothing connected is read below standard, nothing is sent
  // below full; tone and claims come from what the user said.
  // Someone who finished onboarding before there were levels went through all of it: full.
  if (!s.ans.setup_level && s.ans.sending_asked === true) ans.setup_level = 'full';
  const lvl = s.ans.setup_level || ans.setup_level;
  if (lvl === 'quick') {
    if (s.ans.inventory_confirmed !== true && s.inv) ans.inventory_confirmed = true;
    if (!s.ans.crm_choice) ans.crm_choice = 'none';
    if (!s.ans.mailbox_choice && any(s.inv?.found?.email)) ans.mailbox_choice = 'no';
    if (!s.ans.calendar_choice && any(s.inv?.found?.calendar)) ans.calendar_choice = 'no';
    if (s.ans.tools_confirmed !== true) ans.tools_confirmed = true;
    if (typeof s.ans.works_alone !== 'boolean') ans.works_alone = true;
    if (s.ans.known_asked !== true) ans.known_asked = true;
    if (s.ans.lost_deals_asked !== true) ans.lost_deals_asked = true;
    if (s.ans.samples_ok !== true && s.ans.samples_skipped !== true) ans.samples_skipped = true;
    if (s.ans.basics_asked !== true) ans.basics_asked = true;
    if (s.ans.insights_asked !== true) ans.insights_asked = true;
    if (s.ans.about_asked !== true) ans.about_asked = true;
    if (s.ans.list_source === 'app' && !s.ans.browser_choice) ans.browser_choice = 'never';
  }
  if (lvl && lvl !== 'full') {
    if (s.ans.sending_asked !== true) {
      ans.sending_asked = true;
      ans.sending_channels = [];
    }
    if (s.ans.inbox_read_asked !== true) ans.inbox_read_asked = true;
    if (s.ans.app_limit_asked !== true && s.ev?.app_name) ans.app_limit_asked = true;
  }
  if (lvl === 'quick' && !(Array.isArray(s.cfg.languages) && s.cfg.languages.length) && s.ev && englishZone(s.ev.time_zone)) cfg.languages = ['English'];
  // An answer about one event waits for the event: saved before it, it would be dropped on reading and saved
  // again on every run.
  if (!s.ev) for (const k of Object.keys(ans)) if (EVENT_ANSWERS.has(k)) delete ans[k];
  return Object.keys(cfg).length || Object.keys(ans).length ? { config: cfg, answers: ans } : null;
}

function skipWhy(id, s) {
  const W = {
    goal_type: 'no event yet',
    goal: "asked after what they're there for",
    app_request_limit: 'the event has no app',
    colleagues: 'working alone',
    home_tz: 'no event yet',
    dnc: "doesn't apply",
    crm_use: 'no CRM found in their setup',
    crm_where: 'a CRM was found',
    crm_export: s.ans.crm_choice === 'connector' ? 'the CRM is connected' : 'no CRM',
    crm_name: 'no CRM',
    customers: 'no CRM',
    lost_deals: 'no CRM',
    unattended: 'gone',
    segments: 'the profile comes first',
    material: s.cfg.drafting_mode === 'delegate' ? 'their own tools hold their voice and proof' : 'the profile comes first',
    insights:
      s.cfg.drafting_mode === 'delegate'
        ? 'their own tools hold this'
        : /networking|job|hiring/.test(s.ans.goal_type || '')
          ? 'not needed for networking or hiring'
          : 'the profile comes first',
    mailbox_use: 'no mailbox found',
    known_contacts: 'the mailbox covers it',
    calendar_use: 'no calendar found',
    browser: s.ans.list_source === 'app' ? 'no browser tool connected' : "the list isn't only in an app",
    contact_details: (s.list?.rows || 0) > 0 ? 'the list has emails for most people' : 'asked at triage, once the list is loaded (enrichment, step 6)',
    drafter: 'floorboss writes the messages',
    import_context: 'no voice or company material found',
    posture: s.cfg.drafting_mode === 'delegate' ? 'their own tools set the voice' : "asked after what they're there for",
    seller_framing: 'not coming across as a peer',
    samples: 'their own tools write the voice',
    drafter_sample: 'floorboss writes the messages',
    app_notes: 'the event has no app'
  };
  return W[id] || "doesn't apply";
}
