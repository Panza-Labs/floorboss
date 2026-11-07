// Sellers and recruiters (ATS exports, LinkedIn by browser): every notes-like column is read for stop
// wording; no-poach holds; first LinkedIn notes are capped; "nobody replied" needs the user's words; a bounced
// address gets nothing; a follow-up prompt says when replies were checked; a one-way record isn't warm; a
// stale check is explained.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, cli, triage, idOf, draftApprove, groups, ROOT, NOW } from './fixtures/harness.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const guard = (H, input, now = NOW) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
const file = (H, data) => { const f = join(H.dir, `f${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify(data)); return f; };
const AT = (d, m = 0) => new Date(Date.parse(NOW) + d * 864e5 + m * 60000).toISOString();

test('an "Application Notes" column that says never contact again holds the person; a no-poach status holds', () => {
  const crm = 'Name,Email,Company,Stage,Application Notes,Unsubscribed\nIngrid Solberg,ingrid@x.test,Volt,Sourced,Candidate asked never to be contacted again,false\nPia Falk,pia@falke.test,Falke,No-poach partner,,false\n';
  const H = setup({ attendees: 'Name,Title,Company,Email\nIngrid Solberg,COO,Volt,ingrid@x.test\nPia Falk,COO,Falke,pia@falke.test\n', crm });
  triage(H);
  const g = groups(H);
  assert.equal(g['Ingrid Solberg'], 'suppressed');
  assert.equal(g['Pia Falk'], 'suppressed');
});

test('a one-way CRM record ("Attempted to contact") with a recent date is not warm', () => {
  const crm = 'Name,Email,Company,Lead Status,Last Contacted,Unsubscribed\nJoris Hendriks,joris@x.test,Volt,Attempted to contact,2026-09-20,false\n';
  const H = setup({ attendees: 'Name,Title,Company,Email\nJoris Hendriks,COO,Volt,joris@x.test\n', crm });
  triage(H);
  assert.notEqual(groups(H)['Joris Hendriks'], 'warm');
});

test('"nobody replied" needs the user\'s words', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  triage(H);
  assert.match(cli(H, 'event-outreach', ['status', '--event', H.slug, '--none']).ERROR, /--said/);
});

test('follow-up prompt says when replies were checked; a stale check is explained; a bounced address gets nothing', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP,Globex,bo@globex.test\n', settings: { touches: 3, sending: { channels: ['email'], followups: 'scheduled', linkedin_ack: false } } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H); draftApprove(H);
  const l = cli(H, 'event-outreach', ['send-list', '--event', H.slug]);
  const sends = [];
  for (const it of JSON.parse(readFileSync(l.file, 'utf8'))) { guard(H, { to: it.to, subject: it.subject, body: it.body }); sends.push({ id: it.id, touch: 1, message_id: `m-${it.id}` }); }
  cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', file(H, { sends })]);
  cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody replied'], AT(8));
  const l2 = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nobody replied'], AT(8));
  const fu = JSON.parse(readFileSync(l2.file, 'utf8')).find((x) => x.name === 'Ana Berg');
  const ok = guard(H, { to: fu.to, subject: fu.subject, body: fu.body }, AT(8, 1));
  assert.match(ok.stdout, /replies were checked 60 seconds ago/);
  const bo = JSON.parse(readFileSync(l2.file, 'utf8')).find((x) => x.name === 'Bo Li');
  const stale = guard(H, { to: bo.to, subject: bo.subject, body: bo.body }, AT(8, 7));
  assert.equal(stale.status, 2);
  assert.match(stale.stderr, /"Bo Li" \(c\d+\) can't go now: their replies weren't checked/);
  cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, { items: [{ who: 'Bo Li', what: 'bounced' }] })], AT(8, 8));
  const l3 = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--resend', `${idOf(H, 'Bo Li')}:1`, '--said', 'send it again', '--no-reply-check', 'nobody replied'], AT(8, 9));
  assert.ok(!JSON.parse(readFileSync(l3.file, 'utf8')).some((x) => x.name === 'Bo Li'), 'nothing more to a bounced address');
});

test('any unmapped CRM column whose cells say stop is read; the rest are listed back', () => {
  const crm = 'Name,Email,Company,Stage,Recruiter Remarks 2,Hobby,Unsubscribed\nIngrid Solberg,ingrid@x.test,Volt,Sourced,please never contact this person again,chess,false\nAl Ok,al@y.test,Volt,Sourced,,golf,false\n';
  const H = setup({ attendees: 'Name,Title,Company,Email\nIngrid Solberg,COO,Volt,ingrid@x.test\n', crm });
  const { load } = triage(H);
  assert.equal(groups(H)['Ingrid Solberg'], 'suppressed');
  assert.deepEqual(load.crm.stop_like_cells.map((x) => [x.column, x.stop_rows]), [['Recruiter Remarks 2', 1]]);
  const view = readFileSync(cli(H, 'crm-triage', ['propose-mapping', '--event', H.slug, '--kind', 'crm']).view, 'utf8');
  assert.match(view, /^Hobby \| not read \| chess/m, 'the column nobody reads is listed back');
  assert.match(view, /Recruiter Remarks 2: 1 stop/);
});

test('a rejection inside rejected_months holds; an older one no longer does', () => {
  const crm = 'Name,Email,Company,Stage,Rejected Date,Unsubscribed\nNew Rej,new@x.test,Volt,Rejected,2026-06-01,false\nOld Rej,old@x.test,Volt,Rejected,2025-06-01,false\n';
  const H = setup({ attendees: 'Name,Title,Company,Email\nNew Rej,COO,Volt,new@x.test\nOld Rej,COO,Volt,old@x.test\n', crm });
  triage(H);
  const g = groups(H);
  assert.equal(g['New Rej'], 'suppressed');
  assert.notEqual(g['Old Rej'], 'suppressed');
});

test('a LinkedIn link shared with a differently named CRM record, or the exact name at another company, goes to check', () => {
  const crm = 'Name,Email,Company,LinkedIn URL,Stage,Unsubscribed\nAnna Keller,anna@k.test,Volt,https://www.linkedin.com/in/anna-keller-example,Rejected,false\nTobias Renner,tobias@old.test,OldCo,,Rejected,false\n';
  const att = 'Name,Title,Company,Email,LinkedIn\nMatteo Rossi,COO,Veltro,,https://www.linkedin.com/in/anna-keller-example\nTobias Renner,COO,NewCo,,\n';
  const H = setup({ attendees: att, crm });
  triage(H);
  const pre = JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'triage.json'), 'utf8')).pre;
  assert.match(pre[idOf(H, 'Matteo Rossi')].reason || '', /same LinkedIn link as Anna Keller/);
  assert.match(pre[idOf(H, 'Tobias Renner')].reason || '', /moved jobs, or someone else/);
});

test('"never contacted" is a fact, not a stop; a no-poach account holds; short unlisted typing in the browser window is refused', () => {
  const crm = 'Name,Email,Company,Stage,Application Notes,Unsubscribed\nRafael Costa,rafael@x.test,Volt,Sourced,Added from conference talk list; never contacted.,false\n';
  const H = setup({ attendees: 'Name,Title,Company,Email\nRafael Costa,COO,Volt,rafael@x.test\nMira Dost,COO,Falke Systems,mira@falke.test\n', crm, accounts: 'Company,Owner,Status\nFalke Systems,Partnerships (Kestrel),no-poach partner\n' });
  triage(H);
  const g = groups(H);
  assert.notEqual(g['Rafael Costa'], 'suppressed');
  assert.equal(g['Mira Dost'], 'suppressed');
  const B = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\n', event: { app_name: 'Grip' }, settings: { sending: { channels: ['app'], followups: 'scheduled' }, app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false } });
  triage(B); draftApprove(B);
  cli(B, 'event-outreach', ['send-list', '--event', B.slug]);
  writeFileSync(join(B.HOME, 'active.json'), JSON.stringify({ at: NOW }));
  cli(B, 'event-outreach', ['browser-send', '--event', B.slug, '--said', 'go ahead']);
  const r = spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__claude-in-chrome__computer', tool_input: { action: 'type', text: 'Hi, quick one' } }), env: { ...process.env, FLOORBOSS_HOME: B.HOME, FLOORBOSS_NOW: NOW }, encoding: 'utf8' });
  // Typed text must be a listed note exactly (or a listed person's name): part of a note, or a note edited
  // down, is refused rather than asked about.
  assert.equal(r.status, 2);
  assert.match(r.stderr, /listed notes only, typed exactly as listed/);
});

test('onboarding: every answer id a question says it saves is accepted', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const f = join(H.dir, 'a.json');
  writeFileSync(f, JSON.stringify({ accounts_asked: true, dnc_asked: true, sending_asked: true }));
  assert.equal(cli(H, 'event-context', ['onboarding', '--answer-file', f]).ERROR, undefined);
});

test('an approved confirmation is sent to the person who booked; a late first message pushes its follow-up back', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP,Globex,bo@globex.test\n', settings: { touches: 3, sending: { channels: ['email'], followups: 'scheduled', linkedin_ack: false } } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H); draftApprove(H);
  cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, { items: [{ who: 'Ana Berg', what: 'sent' }, { who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00' }] })]);
  draftApprove(H);
  const l = cli(H, 'event-outreach', ['send-list', '--event', H.slug]);
  const conf = JSON.parse(readFileSync(l.file, 'utf8')).find((x) => x.name === 'Ana Berg');
  assert.equal(conf?.touch, 0, JSON.stringify(l).slice(0, 300));
  const g = guard(H, { to: conf.to, subject: conf.subject, body: conf.body });
  assert.equal(g.status, 0, g.stderr);
  assert.match(g.stdout, /"permissionDecision":"ask"/);
  // Bo's first message goes a week late: his follow-up isn't due the same day.
  cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, { items: [{ who: 'Bo Li', what: 'sent', date: '2026-10-19' }] })], AT(7));
  cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody replied'], AT(7));
  const late = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nobody replied'], AT(7));
  assert.ok(!JSON.parse(readFileSync(late.file, 'utf8')).some((x) => x.name === 'Bo Li' && x.touch === 2), 'no follow-up on the day the late first message went');
});

test('onboarding: crm_server and extra_tools are accepted answer ids', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const f = join(H.dir, 'b.json');
  writeFileSync(f, JSON.stringify({ crm_server: 'hubspot', extra_tools: null, inventory_confirmed: true }));
  assert.equal(cli(H, 'event-context', ['onboarding', '--answer-file', f]).ERROR, undefined);
});
