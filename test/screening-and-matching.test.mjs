// Tool screening, greetings, shared mail domains and company names, calendars, the gate, confirmations,
// opt-ins, time zones and status parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { screenTool } from '../skills/connectors/scripts/tasks.mjs';
import { checkDraft } from '../skills/event-outreach/scripts/checks.mjs';
import { analyzeBatch } from '../skills/event-outreach/scripts/sameness.mjs';
import { isSharedDomain, companyKey, normPersonName } from '../lib/normalize.mjs';
import { parseDncLine } from '../skills/crm-triage/scripts/dnc.mjs';
import { subtractBusy } from '../skills/slot-finder/scripts/busy.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const NOW = '2026-10-09T08:00:00Z';
const SLUG = 'mock-harbour-haul';
const cliIn = (home) => (skill, args) => JSON.parse(execFileSync('node', [skill === 'mock' ? join(ROOT, 'examples/mock-event/load.mjs') : join(ROOT, 'skills', skill, 'scripts/cli.mjs'), ...args], { env: { ...process.env, FLOORBOSS_HOME: home, FLOORBOSS_NOW: NOW }, encoding: 'utf8' }));

test('MCP tools as Claude Code names them (mcp__server__tool) are screened on the tool part', () => {
  assert.ok(screenTool('calendar.busy', 'mcp__google_calendar__freebusy_query').ok);
  assert.ok(screenTool('stage_draft', 'mcp__claude_ai_Gmail__create_draft').ok);
  assert.ok(!screenTool('stage_draft', 'mcp__claude_ai_Gmail__send_message').ok);
  assert.ok(!screenTool('crm.lookup', 'mcp__hubspot__delete_contact').ok);
});

test('greeting skips honorifics; a sender\'s signature block is ignored by the batch check', () => {
  const ctx = { contact: { name: 'Ing. Roberto Díaz', company: 'Acme' }, slotLabels: [], eventName: 'Expo', optout: 'Opt out.', pasteLimit: 600, otherNames: [] };
  assert.deepEqual(checkDraft({ channel: 'email', subject: 's', body: 'Hi Roberto, see you at Expo.\n\nOpt out.' }, ctx), []);
  const sig = 'Best,\nOliver Kamau\nPartner, Ember Ventures\n+254 700 000 000 | ember.example';
  const drafts = ['Ana', 'Bo', 'Cy', 'Di', 'Ed'].map((n, i) => ({ id: `c${i}`, company_key: `k${i}`, contact: { name: n, company: `Co${i}` }, body: `Hi ${n}, ${['cold chain stalls when power drops at night', 'mobility fleets lose a fifth of range in heat', 'solar retailers carry stock for nine weeks', 'grid minutes vary by district more than by season', 'pay-as-you-go repayment slips in the planting months'][i]}. ${['Coffee at Expo on Tuesday?', 'Could we meet at Expo?', 'Free for twenty minutes at Expo?', 'See you at Expo, maybe Wednesday?', 'Time for a quick chat at Expo?'][i]}\n\n${sig}` }));
  const r = analyzeBatch(drafts, { eventName: 'Expo', signoff: 'Best,' });
  assert.equal(r.verdict, 'PASS', r.reasons.join(' | '));
});

test('webmail on any domain is shared; legal forms in Spanish, Polish and Australian names are stripped', () => {
  assert.ok(isSharedDomain('gmail.test') && isSharedDomain('outlook.com.br') && isSharedDomain('yahoo.fr'));
  assert.ok(!isSharedDomain('mail.acme.example'));
  assert.equal(companyKey('Grupo Halcón S.A. de C.V.'), 'grupo halcon');
  assert.equal(companyKey('Constructora Norte, S. de R.L. de C.V.'), 'constructora norte');
  assert.equal(companyKey('Polska Sp. z o.o.'), 'polska');
  assert.equal(companyKey('Acme Pty Ltd'), 'acme');
  assert.equal(normPersonName('Dr. med. Anna Weber'), 'anna weber');
});

test('calendar: typed times minus busy; all-day markers named and ignorable; no slots explained', () => {
  const sub = subtractBusy([{ date: '2026-10-27', start: 540, end: 1020 }, { date: '2026-10-27', start: 1170, end: 1320, minutes: 150, label: 'dinner' }],
    [{ start: '2026-10-27T15:00:00Z', end: '2026-10-27T15:45:00Z' }, { start: '2026-10-27T20:00:00Z', end: '2026-10-27T21:00:00Z' }], { sourceZone: 'Europe/Lisbon', eventZone: 'Europe/Lisbon' });
  assert.deepEqual(sub.ranges, [{ date: '2026-10-27', start: 540, end: 900 }, { date: '2026-10-27', start: 945, end: 1020 }]);
  assert.equal(sub.dropped.length, 1, 'a labelled dinner overlapping a meeting is dropped whole');

  const home = mkdtempSync(join(tmpdir(), 'fb-cal-'));
  const cli = cliIn(home);
  cli('mock', ['--goal', 'buyers', '--now', NOW]);
  const ev = JSON.parse(readFileSync(join(home, 'events', SLUG, 'event.json'), 'utf8'));
  const win = cli('slot-finder', ['calendar-window', '--event', SLUG]);
  const bf = join(home, 'busy.json');
  writeFileSync(bf, JSON.stringify({ busy: [{ start: win.from, end: win.to, summary: 'Lisbon trip', all_day: true }, { start: `${ev.start_date}T10:00:00Z`, end: `${ev.start_date}T11:00:00Z`, summary: 'Board call' }] }));
  const none = cli('slot-finder', ['build', '--event', SLUG, '--busy-file', bf]);
  assert.equal(none.slots, 0);
  assert.match(none.no_slots_note, /--ignore-all-day/);
  assert.equal(none.from_calendar.all_day_items[0].summary, 'Lisbon trip');
  const some = cli('slot-finder', ['build', '--event', SLUG, '--busy-file', bf, '--ignore-all-day']);
  assert.ok(some.slots > 0);
  assert.ok(!some.by_day[ev.start_date].some((s) => /T10\d\d$/.test(s.id)), 'the board call still blocks its hour');
  const both = cli('slot-finder', ['build', '--event', SLUG, '--free', 'day1 9-12', '--busy-file', bf, '--ignore-all-day']);
  assert.match(both.from_calendar.source, /subtracted from your typed times/);
  assert.ok(both.by_day[ev.start_date].every((s) => !/T10\d\d$/.test(s.id)));
});

test('a contact rescued at the gate is shortlisted and keeps a later fit, and the gate keeps removals', () => {
  const home = mkdtempSync(join(tmpdir(), 'fb-resc-'));
  const cli = cliIn(home);
  cli('mock', ['--goal', 'buyers', '--now', NOW]);
  const load = cli('crm-triage', ['load', '--event', SLUG]);
  const fits = load.needs_fit.map((r) => ({ id: r.id, segment: /operations|coo/i.test(r.title) ? 'ops-leaders' : null, reason: 'fit', score: 80 }));
  const fp = join(home, 'fits.json');
  writeFileSync(fp, JSON.stringify(fits));
  cli('crm-triage', ['fit', '--event', SLUG, '--fits-file', fp]);
  const out = fits.find((f) => !f.segment).id;
  const removeMe = fits.find((f) => f.segment).id;
  const g = cli('crm-triage', ['gate', '--event', SLUG, '--answers', `rescue ${out}; remove ${removeMe}`]);
  assert.ok(g.top.some((x) => x.id === out && /^you said: reach/.test(x.says)), 'the rescued person is pinned on the shortlist');
  const xp = join(home, 'extra.json');
  writeFileSync(xp, JSON.stringify([{ id: out, segment: 'procurement', reason: 'runs carrier tenders, says the user', score: 70 }]));
  cli('crm-triage', ['fit', '--event', SLUG, '--fits-file', xp]);
  const g2 = cli('crm-triage', ['gate', '--event', SLUG, '--answers', 'defaults']);
  assert.ok(g2.top.find((x) => x.id === out).segment === 'procurement');
  const t = JSON.parse(readFileSync(join(home, 'events', SLUG, 'derived', 'compat', 'triage.json'), 'utf8'));
  assert.equal(t.final[out].segment, 'procurement');
  assert.equal(t.fits[out].reason, 'runs carrier tenders, says the user');
  assert.ok(t.ranked.includes(out));
  assert.ok(!t.ranked.includes(removeMe), 'the earlier removal still holds');
  assert.equal(t.final[removeMe].group, 'suppressed');
});

test('warm contacts keep their place under a company cap; a list with no emails warns; an email column is found by its values', () => {
  const home = mkdtempSync(join(tmpdir(), 'fb-warm-'));
  const cli = cliIn(home);
  cli('mock', ['--goal', 'buyers', '--now', NOW]);
  const csv = join(home, 'list.csv');
  writeFileSync(csv, 'Who,Co.,Role,email/linkedin\nAna Sousa,Acme,VP Ops,ana@acme.example\nBo Li,Acme,COO,https://example.com/in/bo\nCy Ng,Acme,Head of Ops,cy@acme.example\n');
  const l = cli('crm-triage', ['load', '--event', SLUG, '--csv', csv]);
  assert.ok(!l.ERROR, l.ERROR);
  assert.equal(l.attendees.mapping_confirmed, false, 'a new file layout: the mapping is proposed, not confirmed');
  const view = readFileSync(cli('crm-triage', ['propose-mapping', '--event', SLUG, '--kind', 'attendees']).view, 'utf8');
  assert.match(view, /^email\/linkedin \| email \|/m, 'found by its values');
  assert.equal(l.needs_fit.find((r) => r.name === 'Ana Sousa').company, 'Acme');
  const none = join(home, 'none.csv');
  writeFileSync(none, 'Who,Co.\nAna Sousa,Acme\n');
  assert.match(cli('crm-triage', ['load', '--event', SLUG, '--csv', none]).warnings.join(' '), /NO EMAIL ADDRESSES/);
});

test('the ask may name the event without its year; no meeting place is needed', () => {
  const ctx = { contact: { name: 'Achieng Otieno', company: 'X' }, slotLabels: ['Tue 27 Oct, 10:00 Nairobi time'], eventName: 'GreenRift Climate Forum 2026', eventAliases: ['GreenRift'], optout: 'Opt out.', pasteLimit: 600, otherNames: [] };
  const body = (at) => `Hi Achieng, could we take 30 minutes at ${at}, Tue 27 Oct, 10:00 Nairobi time?\n\nOpt out.`;
  assert.deepEqual(checkDraft({ channel: 'email', subject: 's', body: body('GreenRift') }, ctx), []);
  assert.deepEqual(checkDraft({ channel: 'email', subject: 's', body: body('GreenRift Climate Forum') }, { ...ctx, eventAliases: [] }), []);
  assert.match(checkDraft({ channel: 'email', subject: 's', body: body('the forum') }, { ...ctx, eventAliases: [] }).join(' '), /doesn't name the event/);
});

test('accented segments, user notes reach the critic, held drafts get a fresh attempt on request', async () => {
  const { parseSegments, parseInsights } = await import('../skills/event-context/scripts/context-check.mjs');
  assert.equal(parseSegments('## Segment: Hostelería\n- **Who:** jefes de compras\n')[0].slug, 'hosteleria');
  assert.deepEqual(parseInsights('| insight | basis | segments | situations |\n|---|---|---|---|\n| X | y | Hostelería | z |\n')[0].segments, ['hosteleria']);
  const home = mkdtempSync(join(tmpdir(), 'fb-note-'));
  const cli = cliIn(home);
  cli('mock', ['--goal', 'buyers', '--now', NOW]);
  const load = cli('crm-triage', ['load', '--event', SLUG]);
  const fp = join(home, 'fits.json');
  writeFileSync(fp, JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment: /operations|coo/i.test(r.title) ? 'ops-leaders' : null, reason: 'fit', score: 80 }))));
  cli('crm-triage', ['fit', '--event', SLUG, '--fits-file', fp]);
  cli('crm-triage', ['gate', '--event', SLUG, '--answers', 'defaults']);
  const todo0 = cli('event-outreach', ['todo', '--event', SLUG]);
  const job0 = JSON.parse(readFileSync(todo0.todo_file, 'utf8')).jobs.find((j) => j.kind === 'message');
  cli('crm-triage', ['note', '--event', SLUG, '--id', job0.id, '--text', 'met at the Rotterdam port forum last year']);
  const todo = cli('event-outreach', ['todo', '--event', SLUG]);
  const job = JSON.parse(readFileSync(todo.todo_file, 'utf8')).jobs.find((j) => j.id === job0.id);
  assert.equal(job.user_note, 'met at the Rotterdam port forum last year');
  const dp = join(home, 'd.json');
  writeFileSync(dp, JSON.stringify([{ id: job.id, touch: 1, subject: 'x', body: `Hi, 30 minutes at Harbour & Haul, ${job.slot_labels.join(' or ')}?\n\n${todo.optout_sentence}` }]));
  cli('event-outreach', ['save-drafts', '--event', SLUG, '--drafts-file', dp]);
  assert.equal(cli('event-outreach', ['critic-batch', '--event', SLUG, '--ids', `${job.id}:1`])[0].input.user_note, 'met at the Rotterdam port forum last year');
  const vp = join(home, 'v.txt');
  for (let i = 0; i < 2; i++) {
    writeFileSync(vp, `${job.id} FAIL: could go to anyone`);
    cli('event-outreach', ['verdicts', '--event', SLUG, '--ids', `${job.id}:1`, '--text-file', vp]);
    if (i === 0) cli('event-outreach', ['save-drafts', '--event', SLUG, '--drafts-file', dp]);
  }
  const held = JSON.parse(readFileSync(cli('event-outreach', ['todo', '--event', SLUG]).todo_file, 'utf8')).jobs.find((j) => j.id === job.id);
  assert.match(held.held_for_user, /failed the critic twice/);
  cli('event-outreach', ['redraft', '--event', SLUG, '--ids', job.id]);
  const again = JSON.parse(readFileSync(cli('event-outreach', ['todo', '--event', SLUG]).todo_file, 'utf8')).jobs.find((j) => j.id === job.id);
  assert.equal(again.held_for_user, undefined, 'drafted again after the user asked');
});

test('a place in the segment ask is dropped; the times sentence and umlauts don\'t trip the batch check; German and Spanish checks; "Not a fit" stays out of segments', async () => {
  const { relativeWordsIn } = await import('../skills/event-outreach/scripts/leadtime.mjs');
  assert.deepEqual(relativeWordsIn('Guten Morgen Jana'), []);
  assert.deepEqual(relativeWordsIn('Hast du morgen Zeit?'), ['morgen']);
  assert.deepEqual(relativeWordsIn('¿Te va bien mañana?'), ['mañana']);
  const ctx = { contact: { name: 'Jana Hoffmann', company: 'X' }, slotLabels: [], eventName: 'BuildConf Spree', optout: 'Opt.', pasteLimit: 600, otherNames: [] };
  assert.match(checkDraft({ channel: 'email', subject: 's', body: 'Hallo Maria, BuildConf Spree?\n\nOpt.' }, ctx).join(' '), /greets "Maria"/);
  const { parseSegments } = await import('../skills/event-context/scripts/context-check.mjs');
  const segs = parseSegments('## Segment: Engineering managers\n- **Who:** EMs\n\n## Not a fit\n- Rheinfeld Bank\n');
  assert.ok(!segs[0].body.includes('Rheinfeld'));
  const T = ['Di 28 Okt, 10:00 Berliner Zeit', 'Mi 29 Okt, 14:00 Berliner Zeit'];
  const topics = ['Plattform-Teams wachsen schneller als ihre Tools', 'Hättest du Lust auf einen Austausch über Rust', 'Eure Migration auf Kubernetes klingt spannend', 'Wir suchen Leute, die Observability lieben', 'Datenpipelines in Echtzeit sind unser Alltag'];
  const drafts = topics.map((x, i) => ({ id: `c${i}`, company_key: `k${i}`, contact: { name: `P${i} Q`, company: `C${i}` }, slotLabels: T, body: `Hallo P${i}, ${x}. Hättest du 30 Minuten auf der BuildConf, ${T[0]} oder ${T[1]}?` }));
  const r = analyzeBatch(drafts, { eventName: 'BuildConf Spree 2026', eventAliases: ['BuildConf'], slotLabels: T });
  assert.ok(!r.shared_sentences.length, JSON.stringify(r.shared_sentences));
});

test('a booked slot replaces only the lost time; gate decisions survive a fit re-run; "Do not pitch" is a header', async () => {
  const { assignSlots } = await import('../skills/slot-finder/scripts/assign.mjs');
  const slots = [
    { id: 's1', day: '2026-11-18', start: '2026-11-18T01:00:00Z' }, { id: 's2', day: '2026-11-19', start: '2026-11-19T01:00:00Z' },
    { id: 's3', day: '2026-11-19', start: '2026-11-19T05:00:00Z' }, { id: 's4', day: '2026-11-20', start: '2026-11-20T01:00:00Z' },
  ];
  const r = assignSlots([{ id: 'c1' }], slots.filter((s) => s.id !== 's2'), { existing: { c1: ['s1'] }, topUp: ['c1'] });
  assert.equal(r.assignments.c1[0], 's1', 'the free time stays');
  assert.equal(r.assignments.c1.length, 2);
  assert.equal(parseDncLine('Do not pitch'), null);
  const home = mkdtempSync(join(tmpdir(), 'fb-keep-'));
  const cli = cliIn(home);
  cli('mock', ['--goal', 'buyers', '--now', NOW]);
  const load = cli('crm-triage', ['load', '--event', SLUG]);
  const fits = load.needs_fit.map((r) => ({ id: r.id, segment: /operations|coo/i.test(r.title) ? 'ops-leaders' : null, reason: 'fit', score: 80 }));
  const fp = join(home, 'fits.json');
  writeFileSync(fp, JSON.stringify(fits));
  cli('crm-triage', ['fit', '--event', SLUG, '--fits-file', fp]);
  const gone = fits.find((f) => f.segment).id;
  cli('crm-triage', ['gate', '--event', SLUG, '--answers', `remove ${gone}`]);
  cli('crm-triage', ['load', '--event', SLUG]);
  cli('crm-triage', ['fit', '--event', SLUG, '--fits-file', fp]);
  const t = JSON.parse(readFileSync(join(home, 'events', SLUG, 'derived', 'compat', 'triage.json'), 'utf8'));
  assert.ok(!t.ranked.includes(gone), 'still removed after load and fit again');
});

test('a booking gets a confirmation with the time and the meeting place', () => {
  const home = mkdtempSync(join(tmpdir(), 'fb-conf-'));
  const cli = cliIn(home);
  cli('mock', ['--goal', 'buyers', '--now', NOW]);
  const cfg = join(home, 'cfg.json');
  writeFileSync(cfg, JSON.stringify({ meeting_place: 'Lanecraft stand B14' }));
  cli('event-context', ['config', '--set-file', cfg]);
  const load = cli('crm-triage', ['load', '--event', SLUG]);
  const fp = join(home, 'fits.json');
  writeFileSync(fp, JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment: /operations|coo/i.test(r.title) ? 'ops-leaders' : null, reason: 'fit', score: 80 }))));
  cli('crm-triage', ['fit', '--event', SLUG, '--fits-file', fp]);
  cli('crm-triage', ['gate', '--event', SLUG, '--answers', 'defaults']);
  const todo = cli('event-outreach', ['todo', '--event', SLUG]);
  const job = JSON.parse(readFileSync(todo.todo_file, 'utf8')).jobs.find((j) => j.kind === 'message' && j.channel === 'email');
  const dp = join(home, 'd.json');
  writeFileSync(dp, JSON.stringify([{ id: job.id, touch: 1, subject: 'Onboarding', body: `Hi, 30 minutes at Harbour & Haul, ${job.slot_labels.join(' or ')}?\n\n${todo.optout_sentence}` }]));
  cli('event-outreach', ['save-drafts', '--event', SLUG, '--drafts-file', dp]);
  const vp = join(home, 'v.txt');
  writeFileSync(vp, `${job.id} PASS`);
  cli('event-outreach', ['verdicts', '--event', SLUG, '--ids', `${job.id}:1`, '--text-file', vp]);
  cli('event-outreach', ['gate', '--event', SLUG, '--answers', `approve ${job.id}`]);
  const sp = join(home, 's.txt');
  writeFileSync(sp, `floorboss-status v1 event=${SLUG} at=2026-10-09T08:05:00Z\n${job.id} sent=2026-10-09 booked=${job.slot_ids[0]}`);
  cli('event-outreach', ['status', '--event', SLUG, '--text-file', sp], );
  const t2 = cli('event-outreach', ['todo', '--event', SLUG]);
  const conf = JSON.parse(readFileSync(t2.todo_file, 'utf8')).jobs.find((j) => j.id === job.id);
  assert.equal(conf.kind, 'confirmation');
  assert.ok(conf.meeting_place, 'the meeting place comes with the job');
  writeFileSync(dp, JSON.stringify([{ id: job.id, touch: 0, body: `Thanks, see you ${conf.slot_labels[0]}.` }]));
  assert.match(cli('event-outreach', ['save-drafts', '--event', SLUG, '--drafts-file', dp])[0].checks.join(' '), /where to meet/);
  writeFileSync(dp, JSON.stringify([{ id: job.id, touch: 0, body: `Thanks, see you ${conf.slot_labels[0]} at ${conf.meeting_place}.` }]));
  assert.equal(cli('event-outreach', ['save-drafts', '--event', SLUG, '--drafts-file', dp])[0].checks, 'pass');
  const g = cli('event-outreach', ['gate', '--event', SLUG, '--answers', 'approve all']);
  assert.match(readFileSync(g.outbox, 'utf8'), /booked: confirmation/);
});

test('attendee type reaches fit; people who opted out of meeting requests are suppressed', () => {
  const home = mkdtempSync(join(tmpdir(), 'fb-optin-'));
  const cli = cliIn(home);
  cli('mock', ['--goal', 'buyers', '--now', NOW]);
  const csv = join(home, 'list.csv');
  writeFileSync(csv, 'First Name,Last Name,Job Position,Company,Email,Attendee Type,Matchmaking opt-in\nAna,Sousa,Head of Partnerships,Pitanga Commerce,ana@pitanga.example,Agency,Yes\nBo,Li,COO,Vitrinex,bo@vitrinex.example,Platform,No\n');
  const l = cli('crm-triage', ['load', '--event', SLUG, '--csv', csv]);
  const ana = l.needs_fit.find((r) => /Ana/.test(r.name));
  assert.equal(ana.type, 'Agency');
  const t = JSON.parse(readFileSync(join(home, 'events', SLUG, 'derived', 'compat', 'triage.json'), 'utf8'));
  const contacts = JSON.parse(readFileSync(join(home, 'events', SLUG, 'derived', 'compat', 'contacts.json'), 'utf8')).contacts;
  const bo = contacts.find((c) => /Bo Li/.test(c.name));
  assert.match(t.pre[bo.id].reason, /said no on the event's opt-in/);
});

test('bare times typed in another zone are read the way that fits the event; surname-first names match; "·" separates gate answers', () => {
  const home = mkdtempSync(join(tmpdir(), 'fb-ampm-'));
  const cli = cliIn(home);
  cli('mock', ['--goal', 'buyers', '--now', NOW]);
  const ev = JSON.parse(readFileSync(join(home, 'events', SLUG, 'event.json'), 'utf8'));
  // Lisbon event, typed in New York: "5-8" meant 05:00-08:00 New York = 10:00-13:00 Lisbon.
  const b = cli('slot-finder', ['build', '--event', SLUG, '--free', 'day1 5-8', '--zone', 'America/New_York']);
  assert.ok(b.slots > 0, JSON.stringify(b));
  assert.match(b.am_pm_note, /read as written \(morning\)/);
  assert.ok(b.by_day[ev.start_date].some((s) => /T1[012]\d\d$/.test(s.id)));
  assert.equal(normPersonName('DOE-SMITH, Jane'), normPersonName('Jane Doe-Smith'));
});

test('the am/pm reading also applies with a calendar; a known contact reads as warm; the sender line may repeat', () => {
  const home = mkdtempSync(join(tmpdir(), 'fb-known-'));
  const cli = cliIn(home);
  cli('mock', ['--goal', 'buyers', '--now', NOW]);
  const ev = JSON.parse(readFileSync(join(home, 'events', SLUG, 'event.json'), 'utf8'));
  const bf = join(home, 'busy.json');
  writeFileSync(bf, JSON.stringify({ busy: [{ start: `${ev.start_date}T15:00:00Z`, end: `${ev.start_date}T16:00:00Z` }] }));
  const b = cli('slot-finder', ['build', '--event', SLUG, '--free', 'day1 5-8', '--zone', 'America/New_York', '--busy-file', bf]);
  assert.match(b.am_pm_note || '', /morning/);
  assert.ok(b.slots > 0);
  const load = cli('crm-triage', ['load', '--event', SLUG]);
  const id = load.needs_fit[0].id;
  assert.equal(cli('crm-triage', ['note', '--event', SLUG, '--id', id, '--text', 'contributor to our open-source repo', '--known']).known, true);
  const drafts = ['Ana', 'Bo', 'Cy', 'Di', 'Ed'].map((n, i) => ({ id: `c${i}`, company_key: `k${i}`, contact: { name: `${n} Q`, company: `C${i}` }, body: `Hi ${n}, ${['alpha beta gamma delta', 'epsilon zeta eta theta', 'iota kappa lambda mu', 'nu xi omicron pi', 'rho sigma tau upsilon'][i]} matters here. I run partnerships at Tessellate DB and build the connectors.` }));
  const r = analyzeBatch(drafts, { sender: 'Tessellate DB' });
  assert.ok(!r.shared_sentences.length, JSON.stringify(r.shared_sentences));
});

test('greetings with letters like "ı" (Dear Dr. Yıldız) pass', () => {
  const ctx = { contact: { name: 'Dr. Mehmet Yıldız', company: 'X' }, slotLabels: [], eventName: 'Forum', optout: 'O.', pasteLimit: 600, otherNames: [] };
  assert.deepEqual(checkDraft({ channel: 'email', subject: 's', body: 'Dear Dr. Yıldız, see you at Forum.\n\nO.' }, ctx), []);
  assert.match(checkDraft({ channel: 'email', subject: 's', body: 'Dear Dr. Aydın, see you at Forum.\n\nO.' }, ctx).join(' '), /greets/);
});

test('gate answers by name and by c017:2; drafts left out at the gate wait for the user', async () => {
  const { namesToIds, parseGate } = await import('../lib/gate.mjs');
  const people = [{ id: 'c003', name: 'Maud de Vries' }, { id: 'c009', name: 'Zoé Marchetti' }, { id: 'c010', name: 'Jordan Lee' }];
  assert.equal(namesToIds('approve maud, drop Zoe Marchetti; cap jordan-logistics 2', people), 'approve c003, drop c009; cap jordan-logistics 2');
  assert.doesNotThrow(() => parseGate('approve c017:2', { kind: 'draft' }));
  const home = mkdtempSync(join(tmpdir(), 'fb-left-'));
  const cli = cliIn(home);
  cli('mock', ['--goal', 'buyers', '--now', NOW]);
  const load = cli('crm-triage', ['load', '--event', SLUG]);
  const fp = join(home, 'fits.json');
  writeFileSync(fp, JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment: /operations|coo/i.test(r.title) ? 'ops-leaders' : null, reason: 'fit', score: 80 }))));
  cli('crm-triage', ['fit', '--event', SLUG, '--fits-file', fp]);
  cli('crm-triage', ['gate', '--event', SLUG, '--answers', 'defaults']);
  const todo = cli('event-outreach', ['todo', '--event', SLUG]);
  const jobs = JSON.parse(readFileSync(todo.todo_file, 'utf8')).jobs.filter((j) => j.kind === 'message').slice(0, 2);
  const dp = join(home, 'd.json');
  writeFileSync(dp, JSON.stringify(jobs.map((j) => ({ id: j.id, touch: 1, subject: 'x', body: `Hi, 30 minutes at Harbour & Haul, ${j.slot_labels.join(' or ')}?\n\n${todo.optout_sentence}` }))));
  cli('event-outreach', ['save-drafts', '--event', SLUG, '--drafts-file', dp]);
  const vp = join(home, 'v.txt');
  writeFileSync(vp, jobs.map((j) => `${j.id} PASS`).join('\n'));
  cli('event-outreach', ['verdicts', '--event', SLUG, '--ids', jobs.map((j) => `${j.id}:1`).join(','), '--text-file', vp]);
  const [kept, skipped] = jobs;
  cli('event-outreach', ['gate', '--event', SLUG, '--answers', `approve ${kept.id}:1`]);
  const next = JSON.parse(readFileSync(cli('event-outreach', ['todo', '--event', SLUG]).todo_file, 'utf8')).jobs.find((j) => j.id === skipped.id);
  assert.match(next.held_for_user, /left out at the last gate/);
});

test('status rows may be separated by "|"; the event is named once per spelling; the critic sees changed times', async () => {
  const { parseStatus } = await import('../skills/event-outreach/scripts/status.mjs');
  const r = parseStatus('floorboss-status v1 event=x at=2026-10-09T08:00:00Z\nc014 sent=2026-10-05 | c022 stop', { slug: 'x' });
  assert.deepEqual(r.rows.map((x) => x.id), ['c014', 'c022']);
  const ctx = { contact: { name: 'A B', company: 'X' }, slotLabels: [], eventName: 'Retail Ops', eventAliases: ['retail ops', 'Retail Ops'], optout: 'O.', pasteLimit: 600, otherNames: [] };
  const msg = checkDraft({ channel: 'email', subject: 's', body: 'Hi A, quick one.\n\nO.' }, ctx).join(' ');
  assert.ok(!/Retail Ops or retail ops/i.test(msg), msg);
  const { buildCriticInput } = await import('../skills/event-outreach/scripts/critic-input.mjs');
  const ci = buildCriticInput({ draft: { body: 'x' }, timesChanged: { no_longer_free: ['Wed 14:00'] }, contact: {}, event: {} });
  assert.deepEqual(ci.times_changed.no_longer_free, ['Wed 14:00']);
});
test('research keeps facts about a company named "Kids" and drops a running route; "defaults" after other gate answers works', async () => {
  const { writeProfile } = await import('../skills/attendee-research/scripts/profiles.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'fb-prof2-'));
  const r = writeProfile(dir, { id: 'c002', name: 'Sofie', company: 'Petit Lapin Kids' }, { claims: [{ text: 'Petit Lapin Kids opened two stores in Germany', url: 'https://x.example/a' }, { text: 'Runs the same 10k route by the canal every Sunday', url: 'https://x.example/b' }, { text: 'Posted a marathon personal best', url: 'https://x.example/c' }] });
  assert.equal(r.kept, 1);
  const { parseGate } = await import('../lib/gate.mjs');
  const g = parseGate('remove c003; defaults', { kind: 'triage', knownIds: new Set(['c003']) });
  assert.equal(g.defaults, true);
  assert.equal(g.actions.length, 1);
});

