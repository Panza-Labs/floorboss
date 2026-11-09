// Runs of the execution half: a Lanecraft AE at a one-day New York event, with different tools
// connected, an event app (a Grip-style stand-in) or none, LinkedIn links on part of the list, follow-ups as a
// sequence or approved round by round, and things that happen afterwards: replies logged or not, replies in the
// app, tools that drop, a logged-out browser, an app's daily limit, LinkedIn's note cap. The checks in
// generated.mjs hold for every run, plus the UX checks for the LinkedIn copy-paste outbox and CRM tasks.
const EVENT = { name: 'Harbour Summit NYC', city: 'New York', start: '2027-10-21', end: '2027-10-21', zone: 'America/New_York' };
const FREE = { free: 'Thu 21 Oct 8-12, 13:30-18', zone: 'America/New_York' };
const OWN = { company: 'Lanecraft', domain: 'lanecraft.test', user: 'Jordan Pike', email: 'jordan.pike@lanecraft.test', colleagues: ['Dana Kessler', 'Noa Ben-David'] };
const SEQ = 'scheduled: each goes on its day unless they reply, book or say stop';
const ROUND = 'I approve each round of follow-ups in bulk';
const BASE_GEN = { industry: 'logistics', n: 40, companies: 18, listStyle: 'plain', crmStyle: 'hubspot', crmShare: 0.35, dnc: 1, optouts: 1, stopNotes: 1 };
const APP = { slug: 'harbour-nyc', daily_limit: 40, missing: 5, messages_off: 10 };

const mk = (n, about, o) => ({
  id: `x${String(n).padStart(2, '0')}-${o.tag}`,
  about,
  seed: 100 + n,
  now: o.now || '2027-10-18T14:00:00Z',
  event: EVENT,
  own: OWN,
  gen: { ...BASE_GEN, ...(o.gen || {}) },
  connected: o.connected || [],
  ...(o.app ? { app: { ...APP, ...(o.app === true ? {} : o.app) } } : {}),
  ...(o.appSend === false ? { appSend: false } : {}),
  ...(o.linkedin ? { linkedin: o.linkedin } : {}),
  followups: o.followups || SEQ,
  style: o.style || {},
  ...(o.faults ? { faults: o.faults } : {}),
  ...(o.toolDown ? { toolDown: o.toolDown } : {}),
  asks: { free_time: FREE, home_tz: 'America/New_York', company_caps: 'more: we sell to whole teams, several per company is normal', goal: 'heads of operations and senior people in warehouse teams', meetings_wanted: 'as many as fit', followups_mode: o.followups || SEQ, ...(o.asks || {}) },
  ...(o.later ? { later: o.later } : {}),
  ...(o.coworkers ? { coworkers: o.coworkers } : {}),
  ...(o.crmLog ? { crmLog: o.crmLog } : {}),
  ...(o.crmWeb ? { crmWeb: o.crmWeb } : {}),
  ...(o.crmCreate ? { crmCreate: o.crmCreate } : {}),
  ...(o.crmCreateOk === false ? { crmCreateOk: false } : {}),
  ...(o.crmFill ? { crmFill: o.crmFill } : {}),
  ...(o.channels ? { channels: o.channels } : {}),
  ...(o.coworkerYes ? { coworkerYes: o.coworkerYes } : {}),
  ...(o.coworkerOverrides ? { coworkerOverrides: o.coworkerOverrides } : {}),
  ...(o.inbox ? { inbox: o.inbox } : {}),
});
const LATER = (extra = {}) => [{ now: '2027-10-20T13:00:00Z', ...extra }];
const LI = (share) => ({ linkedinShare: share, connectedShare: 0.3 });

export const SPECS = [
  // Nothing connected: everything is prepared for the user.
  mk(1, 'Nothing connected, plain list, prepares everything; comes back two days later.', { tag: 'bare', later: LATER() }),
  mk(2, 'Nothing connected, Grip-style list with LinkedIn links for most people; copies LinkedIn notes by hand.', { tag: 'bare-li', gen: { listStyle: 'grip', missingEmail: 0.5, ...LI(0.7) } }),
  mk(3, 'Nothing connected, CRM export, a Grip app floorboss may use; sends round by round.', { tag: 'bare-app-round', app: true, followups: ROUND, later: LATER({ appReplies: 2 }) }),
  mk(4, 'Nothing connected, Grip app but the user sends notes themselves.', { tag: 'bare-app-self', app: true, appSend: false }),
  // Email send only.
  mk(5, 'Gmail send only, a sequence; two replies logged in the mailbox two days later (but nothing reads the mailbox).', { tag: 'send-seq', connected: ['send'], later: LATER({ replies: 2 }) }),
  mk(6, 'Gmail send only, round by round; replies the user only knows about (not logged).', { tag: 'send-round-unlogged', connected: ['send'], followups: ROUND, later: LATER({ replies: 3, logged: false }) }),
  mk(7, 'Gmail send only; the send tool drops for two calls part way.', { tag: 'send-drop', connected: ['send'], faults: { 'gmail.send_message': { after: 3, for: 2, mode: 'error' } }, later: LATER({ faults: {} }) }),
  mk(8, 'Gmail send only; the send times out once (never answers).', { tag: 'send-timeout', connected: ['send'], faults: { 'gmail.send_message': { after: 2, for: 1, mode: 'timeout' } } }),
  // Send + mailbox read.
  mk(9, 'Send and mailbox read, a sequence; three replies logged; follow-ups only to the rest.', { tag: 'send-read-seq', connected: ['send', 'messages'], later: LATER({ replies: 3 }) }),
  mk(10, 'Send and mailbox read, round by round; replies logged.', { tag: 'send-read-round', connected: ['send', 'messages'], followups: ROUND, later: LATER({ replies: 2 }) }),
  mk(11, 'Send and mailbox read; the mailbox read fails at follow-up time.', { tag: 'read-drops', connected: ['send', 'messages'], later: LATER({ faults: { 'gmail.list_messages': { after: 0, mode: 'down' } } }) }),
  mk(12, 'Send and mailbox history (who they wrote to before).', { tag: 'send-history', connected: ['send', 'history'], gen: { emailedBefore: 0.2 }, later: LATER({ replies: 1 }) }),
  // CRM connected.
  mk(13, 'HubSpot connected instead of exported, nothing else.', { tag: 'crm', connected: ['crm'], gen: { crmShare: 0.4 } }),
  mk(14, 'HubSpot connected; the CRM drops after five lookups; the user hands over an export.', { tag: 'crm-drops', connected: ['crm'], faults: { 'crm-a.search_contacts': { after: 5, mode: 'down' } }, toolDown: { 'crm.lookup': ['retry', '<export>'] } }),
  mk(15, 'HubSpot connected with CRM tasks, LinkedIn links on a third of the list, user sends LinkedIn by hand.', { tag: 'crm-tasks-li', connected: ['crm', 'tasks'], gen: { listStyle: 'grip', missingEmail: 0.4, ...LI(0.35) } }),
  mk(16, 'HubSpot with tasks and Gmail send; LinkedIn by hand; the user wants CRM tasks to log LinkedIn.', { tag: 'crm-tasks-send-li', connected: ['crm', 'tasks', 'send'], gen: { listStyle: 'grip', missingEmail: 0.4, ...LI(0.4) }, later: LATER({ replies: 2 }) }),
  // LinkedIn sending in the browser.
  mk(17, 'LinkedIn sending on (browser), nothing else; most people LinkedIn only.', { tag: 'li-send', linkedin: { send: true }, gen: { listStyle: 'grip', missingEmail: 0.6, ...LI(0.8) } }),
  mk(18, 'LinkedIn sending on with Gmail send; mixed list.', { tag: 'li-email-send', connected: ['send'], linkedin: { send: true }, gen: { listStyle: 'grip', missingEmail: 0.4, ...LI(0.5) } }),
  mk(19, 'LinkedIn sending on; LinkedIn logged out in the browser.', { tag: 'li-logged-out', linkedin: { send: true, logged_in: false }, gen: { listStyle: 'grip', missingEmail: 0.6, ...LI(0.8) } }),
  mk(20, 'LinkedIn sending on; a 200-character invitation note cap (free account).', { tag: 'li-short-cap', linkedin: { send: true, note_limit: 200 }, gen: { listStyle: 'grip', missingEmail: 0.6, ...LI(0.8), connectedShare: 0 } }),
  mk(21, 'LinkedIn sending on, round by round, follow-ups days later (nothing can read LinkedIn replies).', { tag: 'li-round', linkedin: { send: true }, followups: ROUND, gen: { listStyle: 'grip', missingEmail: 0.6, ...LI(0.8) }, later: LATER() }),
  mk(22, 'LinkedIn sending on and the weekly invitation limit nearly used up.', { tag: 'li-invite-limit', linkedin: { send: true, weekly_invites: 3 }, gen: { listStyle: 'grip', missingEmail: 0.6, ...LI(0.8), connectedShare: 0 } }),
  // Grip app sending.
  mk(23, 'Grip app sending on, nothing else; most attendees have no email.', { tag: 'app-only', app: true, gen: { missingEmail: 0.7 } }),
  mk(24, 'Grip app and Gmail send, a sequence; replies in the app two days later.', { tag: 'app-email-seq', app: true, connected: ['send'], later: LATER({ appReplies: 2, replies: 1 }) }),
  mk(25, 'Grip app with a 300-character message cap and a daily limit of 5.', { tag: 'app-limits', app: { char_limit: 300, daily_limit: 5 }, gen: { missingEmail: 0.6 }, later: [{ now: '2027-10-19T14:00:00Z' }] }),
  mk(26, 'Grip app; the browser is logged out of the app.', { tag: 'app-logged-out', app: { logged_in: false }, gen: { missingEmail: 0.6 } }),
  mk(27, 'Grip app with many people who turned messages off.', { tag: 'app-msgs-off', app: { messages_off: 50 }, gen: { missingEmail: 0.6 } }),
  mk(28, 'Grip app and LinkedIn sending both on; Gmail send too.', { tag: 'app-li-email', app: true, connected: ['send'], linkedin: { send: true }, gen: { listStyle: 'grip', missingEmail: 0.4, ...LI(0.5) } }),
  // Everything connected.
  mk(29, 'Everything connected (send, read, history, CRM, tasks), a sequence, replies logged.', { tag: 'all-seq', connected: ['send', 'messages', 'history', 'crm', 'tasks'], later: LATER({ replies: 3 }) }),
  mk(30, 'Everything connected, round by round, replies not logged anywhere.', { tag: 'all-round-unlogged', connected: ['send', 'messages', 'history', 'crm', 'tasks'], followups: ROUND, later: LATER({ replies: 2, logged: false }) }),
  mk(31, 'Everything connected plus Grip app and LinkedIn sending.', { tag: 'all-app-li', app: true, connected: ['send', 'messages', 'crm', 'tasks'], linkedin: { send: true }, gen: { listStyle: 'grip', missingEmail: 0.3, ...LI(0.5) }, later: LATER({ replies: 2, appReplies: 1 }) }),
  // Timing.
  mk(32, 'Starts two weeks early (standard lead time), sequence, comes back twice.', { tag: 'early', now: '2027-10-04T14:00:00Z', connected: ['send', 'messages'], later: [{ now: '2027-10-11T14:00:00Z', replies: 2 }, { now: '2027-10-18T14:00:00Z', replies: 1 }] }),
  mk(33, 'Starts the day before the event (last-minute).', { tag: 'last-minute', now: '2027-10-20T15:00:00Z', connected: ['send'] }),
  mk(34, 'Comes back the day after the event: nothing should still go out.', { tag: 'after-event', connected: ['send', 'messages'], later: [{ now: '2027-10-22T14:00:00Z' }] }),
  // Approval styles and data shapes.
  mk(35, 'Approves all but two by name.', { tag: 'approve-except', connected: ['send'], style: { approve: (s) => 'approve all' } }),
  mk(36, 'A 200-row badge export with dupes and colleagues, CRM export, send.', { tag: 'big-list', connected: ['send'], gen: { n: 200, companies: 60, listStyle: 'badge', dupes: 6, colleagueOwnShare: 0.3 } }),
  mk(37, 'Messy list, lazy answers, nothing connected, LinkedIn on a fifth.', { tag: 'messy-lazy', gen: { listStyle: 'messy', ...LI(0.2) }, style: { check: 'lazy' } }),
  mk(38, 'No CRM at all, Gmail send, Grip app.', { tag: 'no-crm', app: true, connected: ['send'], gen: { crm: false } }),
  mk(39, 'CRM export with many colleague-owned records and do-not-contacts.', { tag: 'colleague-heavy', connected: ['send'], gen: { colleagueOwnShare: 0.6, dnc: 4, optouts: 3 } }),
  mk(40, 'Grip list, CRM tasks, LinkedIn by hand, round by round; replies the user reports later.', { tag: 'tasks-round', connected: ['crm', 'tasks'], followups: ROUND, gen: { listStyle: 'grip', missingEmail: 0.5, ...LI(0.6) }, later: LATER({ replies: 1, logged: false }) }),
  // Coworkers' contacts: how careful to be.
  // Logging LinkedIn and app messages in the CRM's web app.
  mk(45, 'LinkedIn sending + HubSpot export; logs every LinkedIn message in HubSpot in the browser.', { tag: 'log-li', crmLog: 'browser', linkedin: { send: true }, gen: { listStyle: 'grip', missingEmail: 0.3, crmShare: 0.6, ...LI(0.6) } }),
  mk(46, 'Grip app sending + HubSpot; logs app notes in HubSpot; HubSpot logged out in the browser.', { tag: 'log-app-out', crmLog: 'browser', crmWeb: { logged_in: false }, app: true, gen: { missingEmail: 0.6, crmShare: 0.6 } }),
  mk(47, 'Everything: email, LinkedIn and app sending, HubSpot connected, browser logging, follow-ups days later.', { tag: 'log-all', crmLog: 'browser', app: true, connected: ['send', 'messages', 'crm'], linkedin: { send: true }, gen: { listStyle: 'grip', missingEmail: 0.3, crmShare: 0.6, ...LI(0.5) }, later: LATER({ replies: 1 }) }),
  mk(48, 'LinkedIn by hand (no sending), marks them sent in the outbox status; logs in HubSpot.', { tag: 'log-manual', crmLog: 'browser', gen: { listStyle: 'grip', missingEmail: 0.5, crmShare: 0.6, ...LI(0.6) } }),
  mk(49, 'LinkedIn sending, mostly LinkedIn-only people; creates missing HubSpot contacts automatically and logs.', { tag: 'create-yes', crmLog: 'browser', crmCreate: 'yes, create them', linkedin: { send: true }, gen: { listStyle: 'grip', missingEmail: 0.6, crmShare: 0.6, ...LI(0.8) } }),
  mk(50, 'Same, but asks per batch and the user says yes.', { tag: 'create-ask-yes', crmLog: 'browser', crmCreate: 'ask me each time (one list per batch)', linkedin: { send: true }, gen: { listStyle: 'grip', missingEmail: 0.6, crmShare: 0.6, ...LI(0.8) } }),
  mk(51, 'Same, asks per batch and the user says no: nothing created, they are listed.', { tag: 'create-ask-no', crmLog: 'browser', crmCreate: 'ask me each time (one list per batch)', crmCreateOk: false, linkedin: { send: true }, gen: { listStyle: 'grip', missingEmail: 0.6, crmShare: 0.6, ...LI(0.8) } }),
  mk(52, 'Logging with fill-blanks on: existing contacts with an empty LinkedIn URL or title get it filled; filled ones are left alone.', { tag: 'fill-yes', channels: ['paste'], crmLog: 'browser', crmFill: 'yes, fill empty fields (recommended)', crmCreate: 'yes, create them', linkedin: { send: true }, gen: { listStyle: 'grip', missingEmail: 0.2, crmShare: 0.7, ...LI(0.9) } }),
  mk(41, 'Coworkers: ask me each time; says yes for Dana\'s, no for Noa\'s.', { tag: 'cw-ask', connected: ['send'], gen: { colleagueOwnShare: 0.4 }, coworkers: 'ask me each time', coworkerYes: ['Dana Kessler'] }),
  mk(42, 'Coworkers: write to them, but warn me before sending.', { tag: 'cw-warn', connected: ['send'], gen: { colleagueOwnShare: 0.4 }, coworkers: 'write to them, but warn me before sending' }),
  mk(43, 'Coworkers: treat them as mine.', { tag: 'cw-mine', connected: ['send'], gen: { colleagueOwnShare: 0.4 }, coworkers: 'treat them as mine' }),
  mk(44, 'Coworkers per person: leave Noa\'s alone, warn me for Dana\'s.', { tag: 'cw-per', connected: ['send'], gen: { colleagueOwnShare: 0.4 }, coworkers: 'leave them alone; Dana Kessler: warn me', coworkerOverrides: { 'Dana Kessler': 'warn' } }),
  // Part 2: what replies say. Every kind at once, read from the mailbox, as a sequence and round by round.
  mk(53, 'Send and mailbox read, a sequence: replies of every kind (out of office, stop, no thanks, a referral, a time, an assistant, a new thread, a bounce, a plain reply).', { tag: 'replies-kinds-seq', connected: ['send', 'messages'], later: [{ now: '2027-10-18T20:00:00Z', replyKinds: ['ooo', 'stop', 'decline', 'referral', 'booked', 'assistant', 'newthread', 'bounce', 'reply'] }, { now: '2027-10-20T13:00:00Z' }] }),
  mk(54, 'Same replies, round by round.', { tag: 'replies-kinds-round', connected: ['send', 'messages'], followups: ROUND, later: [{ now: '2027-10-18T20:00:00Z', replyKinds: ['ooo', 'stop', 'decline', 'referral', 'booked', 'assistant', 'newthread', 'bounce', 'reply'] }, { now: '2027-10-20T13:00:00Z' }] }),
  mk(55, 'Everything connected, replies of every kind, CRM tasks.', { tag: 'replies-kinds-all', connected: ['send', 'messages', 'history', 'crm', 'tasks'], later: [{ now: '2027-10-18T20:00:00Z', replyKinds: ['stop', 'referral', 'booked', 'bounce', 'ooo'] }, { now: '2027-10-20T13:00:00Z' }] }),
  // Part 2b: replies read in the browser, only where the user allowed it; calendar accepts.
  mk(56, 'LinkedIn sending, reading LinkedIn replies allowed and logged in HubSpot: a stop, a referral, a plain reply, an out of office.', { tag: 'li-read-log', crmLog: 'browser', crmCreate: 'yes, create them', inbox: 'yes, and log the replies in my CRM', linkedin: { send: true }, gen: { listStyle: 'grip', missingEmail: 0.6, crmShare: 0.6, ...LI(0.8) }, later: [{ now: '2027-10-18T20:00:00Z', liReplyKinds: ['stop', 'referral', 'reply', 'ooo'] }, { now: '2027-10-20T13:00:00Z' }] }),
  mk(57, 'LinkedIn sending, reading LinkedIn refused: floorboss never opens the messages and asks the user instead.', { tag: 'li-read-no', linkedin: { send: true }, inbox: 'no, I\'ll tell you myself', gen: { listStyle: 'grip', missingEmail: 0.6, ...LI(0.8) }, later: [{ now: '2027-10-18T20:00:00Z', liReplyKinds: ['stop', 'reply'] }, { now: '2027-10-20T13:00:00Z' }] }),
  mk(58, 'Grip app sending, reading the app inbox allowed and logged: a decline, a booking, a reply.', { tag: 'app-read-log', app: true, crmLog: 'browser', crmCreate: 'yes, create them', inbox: 'yes: LinkedIn and Meetwell', gen: { missingEmail: 0.7, crmShare: 0.5 }, later: [{ now: '2027-10-18T20:00:00Z', appReplyKinds: ['decline', 'reply'] }, { now: '2027-10-20T13:00:00Z' }] }),
  mk(59, 'LinkedIn reading allowed, but LinkedIn is logged out: falls back to asking.', { tag: 'li-read-out', linkedin: { send: true, logged_in_later: false }, inbox: 'yes: LinkedIn', gen: { listStyle: 'grip', missingEmail: 0.6, ...LI(0.8) }, later: [{ now: '2027-10-18T20:00:00Z', liReplyKinds: ['reply'], liLoggedOut: true }, { now: '2027-10-20T13:00:00Z' }] }),
  mk(61, 'Apollo-style people-data tool: 40% of the list has no email; the user agrees to the top 3 lookups only.', { tag: 'enrich-apollo', connected: ['crm', 'enrich'], gen: { missingEmail: 0.4 } }),
  mk(60, 'Send, mailbox and calendar: two people accept the invite without replying.', { tag: 'calendar-accept', connected: ['send', 'messages', 'calendar'], later: [{ now: '2027-10-18T20:00:00Z', calendarAccepts: 2 }, { now: '2027-10-20T13:00:00Z' }] }),
];
