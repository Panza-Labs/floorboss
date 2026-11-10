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
    'linkedin_send',
    'send_setup',
    'followups_mode',
    'crm_log',
    'message_route',
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
  followups_mode: 'scheduled | each_round',
  send_setup: '{"own_email":"…"} then run discovery; or "skip"',
  drafter: '{"name","invoke","type":"skill|agent|instructions","covers":{"channels":[…],"kinds":[…]},"gaps":[…]}'
};
