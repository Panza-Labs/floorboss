// The facts and talking points the pages in this folder were rendered from, at commit 76a8ac6 (agenda.html,
// agenda.md, agenda.ics with DTSTAMP masked). test/agenda-pages.test.mjs renders the same input today and compares:
// the page and the short version byte for byte, the calendar file with its long lines unfolded (lines are folded
// at 75 bytes since).
export const data = {
  event: { name: 'Test Expo "26" & Friends', city: 'Rotterdam', zone: 'Europe/Amsterdam' },
  day: '2026-11-10',
  goal: 'meet buyers; book two pilots',
  meetings: [
    {
      id: 'c001',
      start: '2026-11-10T09:00:00.000Z',
      day: '2026-11-10',
      time: 'Tue 10 Nov, 10:00',
      place: 'Stand <4>; hall a, b\\c',
      person: { name: 'Ana Berg', title: 'COO', company: 'Acme & Sons', email: 'ana@acme.test' },
      relation: {
        group: 'warm',
        says: 'a lead in your CRM',
        crm: { status: 'Lead', owner: 'Sam Rivera', last_contact: '2026-09-30' },
        account_note: 'Acme & Sons is an open deal',
        coworker_also: 'Kim Lee',
        mailbox: 'you last wrote on 3 Oct',
        user_note: 'met at Tillcon'
      },
      thread: { sent: [{ touch: 1, date: '2026-10-12', text: 'Hi Ana, could you do Tue 10 Nov at 10:00?' }], received: [{ at: '2026-10-19', text: 'Sure, Tuesday works. See you at the stand.', channel: 'email', recorded: true }], booked_via: 'user' },
      company_brief: '**Sells:** cold storage for food distributors **Relation to us:** customer. Write as to a customer, never a cold pitch. **Your customer:** the CRM says "Closed Won"',
      news: [
        { text: 'Acme opened a Rotterdam hub', url: 'https://example.test/acme?a=1&b=2', date: '2026-10', about: 'company' },
        { text: 'Ana Berg spoke at Cold Chain Week', url: 'https://example.test/talk', date: '2026-09', about: 'person' }
      ],
      profile: 'Ana Berg runs operations at Acme & Sons.'
    },
    {
      id: 'c002',
      start: '2026-11-10T10:00:00.000Z',
      day: '2026-11-10',
      time: 'Tue 10 Nov, 11:00',
      place: null,
      person: { name: 'Bo Li', title: null, company: 'Globex', email: 'bo@globex.test' },
      relation: { group: 'reach', says: null, crm: null, account_note: null, coworker_also: null, mailbox: null, user_note: null },
      thread: { sent: [], received: [], booked_via: null },
      company_brief: null,
      news: [],
      profile: null
    }
  ]
};
export const points = {
  meetings: [
    { id: 'c001', points: [{ text: 'The Rotterdam hub, and what it changes for carrier checks at "peak"', from: 'news' }, { text: 'Where the open deal stands', from: 'crm' }, { text: 'What she said about Tuesday', from: 'thread' }], ask: 'What changes first at the new hub?', avoid: 'pricing <for now>' },
    { id: 'c002', points: [{ text: 'Why they came', from: 'list' }, { text: 'Your goal for the week', from: 'goal' }], ask: 'What would make this week worth it?' }
  ]
};
