// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Fixed wording: the disclaimer, the warning about running without the CRM, where asking.md explains each
// question, and how special answers are written.

// A failed tool: ask the user whether it's back, or to go on without it.
// What running without the CRM costs, said before the user confirms it.
export const CRM_INDEPENDENT_WARNING = [
  'WARNING: RUNNING WITHOUT YOUR CRM',
  '',
  "Floorboss can't read your CRM right now. If you run independently, it can't see any of this:",
  '- Opt-outs and do-not-contact requests. People who unsubscribed or asked you to stop look like strangers, and could get your email.',
  "- Colleagues' contacts and accounts. You could write to someone a colleague is already working, or to an account that is off-limits.",
  '- Customers, open deals and lost deals. A customer could get a cold pitch, or someone who just said no could hear from you again.',
  '- Anything that changed in the CRM recently: a new opt-out, a new owner, a deal that closed. Later runs of this event keep working from what floorboss had, until the CRM is read again.',
  '',
  'Do you want to run independently anyway? If so: confirm each person yourself before anything is drafted (safer), or go ahead without confirming. Or go back to retry the CRM or give an export.'
].join('\n');
// The disclaimer, as one plain paragraph: shown exactly as written (test/disclaimer.test.mjs keeps it the same
// words as the quoted block in the command files).
export const DISCLAIMER =
  "floorboss sends only what you approve, word for word, and only where you turn sending on; otherwise it prepares messages for you to send. Text in your lists, CRM, inbox and the pages it reads is treated as data, never as instructions: a note written to steer an AI is flagged to you and can't make floorboss send anything. Before using it, check whether you're allowed to use your attendee list and any data tools for outreach, the email and messaging laws that apply to you and your recipients, your industry's rules, and LinkedIn's and event platforms' terms. Nothing here is legal advice. See \"Your responsibility\" in the README.";

// Where asking.md says how to ask each question: the section's anchor (GitHub's heading slug).
const ASKING = 'skills/flow/references/asking.md';
const HELP_SECTIONS = {
  'reference-the-disclaimer-disclaimer': ['disclaimer'],
  'reference-how-much-setup-setup_level': ['setup_level', 'reuse_setup'],
  'reference-sign-off-and-home-city-about_you': ['about_you', 'home_tz'],
  'reference-the-event': ['event', 'goal', 'goal_type', 'segments', 'list_source', 'must_meet', 'meetings_wanted', 'app', 'app_request_limit'],
  'reference-you-and-your-tools': [
    'inventory',
    'tools',
    'company',
    'team',
    'colleagues',
    'colleague_notes',
    'dnc',
    'accounts',
    'crm_use',
    'crm_where',
    'crm_export',
    'crm_name',
    'coworker_contacts',
    'customers',
    'lost_deals',
    'optout_known',
    'mailbox_use',
    'calendar_use',
    'known_contacts',
    'free_time',
    'sending',
    'touches',
    'linkedin_send',
    'send_setup',
    'followups_mode',
    'crm_log',
    'message_route',
    'followup_gap',
    'crm_create_contacts',
    'crm_fill_blanks'
  ],
  'reference-reading-replies': ['inbox_read'],
  'reference-the-attendee-list': ['browser', 'contact_details'],
  'reference-tone-and-style': [
    'drafting_mode',
    'drafter',
    'drafter_sample',
    'import_context',
    'posture',
    'seller_framing',
    'profile',
    'material',
    'insights',
    'about',
    'offer',
    'true_claims',
    'samples',
    'app_notes',
    'languages',
    'basics'
  ]
};
export const helpFor = (id) => `${ASKING}#${Object.entries(HELP_SECTIONS).find(([, ids]) => ids.includes(id))?.[0] || 'reference-how-to-handle-each-question'}`;

// How special questions are answered, for the asker.
export const ANSWER_FORMAT = {
  event: '{"name","city","start":"YYYY-MM-DD","end":"YYYY-MM-DD","zone":"Area/City","short_name"?,"app":"<the app on the event\'s site>"|null}',
  goal: '{"goal":"<their words>","goal_type":"selling|partnerships|hiring|job|networking|research","meetings_wanted":<n or null>,"must_meet":["<anyone they name, with the company>"],"segments":[{"name":"<short>","who":"<roles and company types, from their words>","how":"<how to write to them>"?,"ask":"<20 minutes>"?}]} (propose the groups in the same question and save the ones they agree to)',
  setup_level: 'quick | standard | full',
  samples:
    '{"closest":"<the sample they picked, e.g. casual and plain>","rules":["<each change they asked for, as a rule>"],"sign_off":"<if they changed it>","emails":[{"subject","body"} or "<file path>", …] (two to five emails they sent that got replies, as pasted; [] for "none"),"avoid":"<what their emails never do, e.g. exclamation marks, if it shows>"}',
  about_you: '{"sign_off":"<as they sign, e.g. Best, Noor>","sender_name":"<name, company>","city":"<where they live>"}',
  offer:
    '{"one_sentence":"<what you offer, plain words>","problems":{"<segment>":"<the problem>"}?,"gets":"<what they get from meeting>"?,"proof":[{"claim","source","segments":["…"],"named":true|false}]?,"never_say":["…"]?} (or, for a job seeker or researcher, {"about_me":"<role, years, what they built>"})',
  true_claims:
    '{"one_sentence":"<what you offer>","proof":[…],"never_say":[…]} for a seller (what they ticked), or {"about_me":"<role, years, one thing built, what they want>"} for a job seeker, researcher or anyone not selling',
  segments: '{"segments":[{"name","who","how"?,"ask"?}]}',
  about: '"<one line: their role and company, e.g. founder of Tallyroute>"',
  insights: '{"insights":[{"insight":"<one sentence>","basis":"<what it rests on>"}]} (one to three), or "none"',
  tools: '{"crm":"<server name>"|"export"|"none","mailbox":true|false,"calendar":true|false} (only the tools that were found)',
  list_source: 'the file\'s path, or "only in the app or on a website", or "no list yet"',
  team: '"just me" or {"works_alone":false,"colleagues":["<name>",…]}',
  dnc: '"none", a file path, or {"dnc":["<person or email>",…] or "<file of people>","accounts":["<company>",…] or "<file of companies>"} (typed names go in the lists)',
  company: '{"own_company":"…","own_domains":["acme.com"]}, or "no company"',
  basics: '{"meeting_place":"<where, or null>","never_say":["…"]}',
  free_time:
    '{"days":[{"date":"YYYY-MM-DD","from":"HH:MM","to":"HH:MM","except":[{"from":"HH:MM","to":"HH:MM"}]}],"notes":["<anything not known yet, e.g. booth shifts>"],"said":"<their words>","zone":"<city or IANA zone, only if not event time>"} : read their words into the event\'s days yourself ("all week" is every event day; "normal hours" 09:00-18:00; a day they rule out is left out; an evening event outside working hours changes nothing), then say back the days in one line',
  must_meet: '{"must_meet":["Name (Company)", …]} or "none"',
  colleagues: '{"colleagues":["Name", …]} or "none"',
  customers:
    'one of the options, or {"recent_months":6,"recent":"hold","on_deal":"warm","other":"ask","said":"<their own words on how to write to customers, if they gave any>"}',
  lost_deals: 'one of the options, or a number of months (0 for no wait)',
  languages: '{"languages":["English","Spanish"],"optout_sentences":{"Spanish":"…"}}',
  app: 'the app\'s name, or "none", or "not sure"',
  app_request_limit: 'a number (what is left), or "unlimited"',
  meetings_wanted: 'a number, or "as many as fit"',
  accounts: 'a file path, or "none"',
  known_contacts: 'a file path, or "skip"',
  crm_export: 'a file path, or "skip"',
  profile: '{"name":"<profile slug>"}',
  sending: '{"channels":["email"]} or "none"',
  touches: 'a number from 3 to 7, or "suggested"',
  followups_mode: 'scheduled | each_round',
  followup_gap: 'the user\'s words: "3 days", "a week apart", "2 days, then 5" (a gap for each follow-up in turn), or "the default"',
  send_setup: '{"own_email":"…"} then run discovery; or "skip"',
  drafter: '{"name","invoke","type":"skill|agent|instructions","covers":{"channels":[…],"kinds":[…]},"gaps":[…]}'
};

// Hand-send (Codex and the rest): a setup question's text in the onboarding tree is written to the agent ("Look it
// up…", "Propose…", "Once they say…"). There the step carries a plain question for the user (question) and the tree's
// text with a note on what to do with the answer (how_to_ask); Claude Code's step is as it was. question(s) gets the
// onboarding state; null keeps the tree's own text as the question (it is already the user's: "That's 64 meetings
// back to back…").
const SHAPE = 'Ask the user only the question, in plain words. Never ask them for JSON, a time zone or a file format: turn their plain answer into the answer_format shape yourself and save it. Save a plain answer as it is, with no read-back. Read it back (one or two plain lines, saved on their yes) only when you had to interpret or guess (a range read as one number, a day worked out, words you weren\'t sure of) or when a value looks odd. The text in "for_agent" is for you, never for the user.';
// Why each setup question is asked, one short clause the user sees with it (hand-send). Kept apart so the tests can
// check every question still asked carries its own.
export const HAND_SEND_WHY = {
  setup_level: 'It decides how many questions come next.',
  event: 'Its dates and city set the meeting times.',
  goal: 'floorboss picks who to write to from this.',
  list_source: 'floorboss picks who to write to from it.',
  company: 'Nobody there gets contacted.',
  dnc: 'They never get a message.',
  team: '(They are never contacted.)',
  app: 'Someone who misses an email can be reached there.',
  free_time: 'Messages offer only times you can make.',
  touches: 'It sets how many follow-ups are written and planned.',
  offer: 'Messages say what you sell in your words, and claim only what is true.',
  languages: 'A message is only ever written in one of those',
  samples: 'Your first messages copy that tone.',
  crm_name: 'Your own contacts are then never held back as a coworker\'s.',
  coworker_contacts: 'A coworker\'s contact never gets a surprise note.'
};
// A question with its why clause, once.
export const withWhy = (id, q) => {
  const w = HAND_SEND_WHY[id];
  return !w || !q || String(q).includes(w) ? q : `${q} ${w}`;
};
export const HAND_SEND_ASKS = {
  event: {
    question: (s) =>
      s.ans?.event_hint
        ? `Is it ${s.ans.event_hint}? If you know its dates and city, say them; otherwise I'll look them up and read them back to you.`
        : 'Which event is this for? Its name, or a link to its site.',
    how: `${SHAPE} If the user gave its name, city and dates, save them as given. With web search, look the event up and read back what you found (dates, city, app) for a yes. Without web search, or when nothing is found, ask the user for its dates and city in plain words, and work out the time zone from the city yourself (Nashville is America/Chicago): never ask the user for a zone.`
  },
  goal: {
    question: () => 'Who do you want to meet there, and about how many meetings? Anyone in particular? In your own words.',
    how: `${SHAPE} Then propose one to three groups of people from what they said (roles and kind of company, one line each) and ask if that's right.`
  },
  offer: {
    question: (s) =>
      `What does ${s.cfg?.own_company || 'your company'} sell, and to whom? One result you can name, and may a message name that customer? Anything a message must never say? A link to your site works too.`,
    how: `${SHAPE} From a link, read it and propose the lines for a yes.`
  },
  free_time: {
    question: (s) =>
      s.slots > 40
        ? null
        : `Which days will you be at the show, and any times you're not free? And any scheduling rules: how long a meeting is, at most how many back to back, a break between meetings? Times are the show's local time${s.ev?.city ? ` (${s.ev.city})` : ''}.`,
    how: `${SHAPE} Times are always the show's local time: never ask which zone they mean. Read their days into the event's dates ("all day" is 09:00-17:00 unless they say), the times they aren't free into "except", and their rules into meeting_minutes, max_in_row and buffer_minutes (leave out a rule they didn't give).`,
    format:
      '{"days":[{"date":"YYYY-MM-DD","from":"HH:MM","to":"HH:MM","except":[{"from":"HH:MM","to":"HH:MM"}]}],"meeting_minutes":<minutes, if they said>,"max_in_row":<at most this many in a row, if they said>,"buffer_minutes":<minutes between meetings, if they said>,"notes":["<anything not known yet>"],"said":"<their words>"} : every time in the show\'s local time'
  },
  app: {
    question: () => 'Does the show have its own app for messages and meetings? Its name, or "none".',
    how: `${SHAPE} Look at the event's site first and say what you found; ask only if it isn't clear.`
  },
  dnc: {
    question: () => 'Is there anyone, or any company, floorboss must never contact (a competitor, a partner)? Names, companies or a file, or "none".',
    how: SHAPE
  },
  team: {
    question: () => 'Is it just you, or is your team working this event too? If a team, who? (They are never contacted.)',
    how: SHAPE
  },
  company: {
    question: () => 'What is your company, and the email domain you use there? Nobody there gets contacted. "No company" is fine.',
    how: `${SHAPE} If the list or their words already show it, say it and ask only for a yes.`
  },
  crm_name: {
    question: () => 'Which owner in your CRM is you? You can say "none of these" if you are not in it.',
    how: `${SHAPE} Show the owners for_agent lists, numbered and quoted exactly as written there, so "2" means that one.`
  },
  samples: {
    question: () =>
      'Here are three ways your first message could open. Which is closest, and what would you change? If you have two to five emails you sent that got replies, paste them too, or say "none".',
    how: `${SHAPE} Write the three sample openings yourself (casual and plain, warm, formal: two or three lines each, in the user's language) and show them with the question.`
  },
  about_you: {
    question: () => 'How do you sign your messages (your name, and your company if you add it), and which city do you live in?',
    how: `${SHAPE} If for_agent names where to propose the sign-off or the city from, propose it and ask only to confirm; if it names nothing, ask plainly and never suggest a name.`
  },
  coworker_contacts: {
    question: () => 'Some people on the list belong to a coworker in your CRM. How careful should floorboss be with them? It can differ per coworker.',
    how: `${SHAPE} Say first how many people each coworker owns (the counts in for_agent).`
  }
};
