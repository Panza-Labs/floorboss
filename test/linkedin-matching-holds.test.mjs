// Matching by LinkedIn link, colleague holds, who may draft, the prefilter, onboarding answers, calendar moves,
// free-time parsing, record by first name, the gate and message languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, cli, triage, idOf, draftApprove, todoJobs, groups } from './fixtures/harness.mjs';
import { summarize, toolsRisk } from '../skills/event-context/scripts/scan.mjs';
import { drafterFor } from '../skills/event-outreach/scripts/drafter.mjs';
import { parseFreeTimes } from '../skills/slot-finder/scripts/freetimes.mjs';
import { readLedger, fold } from '../lib/ledger.mjs';

// These tests save a drafter as the flow does while saving that answer (drafter and drafting_mode are answer-only).
process.env.FLOORBOSS_SAVED_BY = 'drafter';

const file = (H, data, name = `f${Math.random().toString(36).slice(2)}.json`) => { const f = join(H.dir, name); writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data)); return f; };

test('a rejected candidate is found by LinkedIn link, and an exact name with no company is checked', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email,Profile URL\nSara Lindqvist,Controls Engineer,Brightarm Robotics,,https://www.linkedin.com/in/saralindqvist-example/\nHiro Sato,Engineer,Torvik,,\nNew Person,Engineer,Kestrel Automation,,\n', settings: { channels: ['email', 'paste'] } });
  const ats = file(H, 'Name,Email,Stage,Owner,LinkedIn URL,Unsubscribed\nSara Lindqvist,sara@old.test,Rejected,Marcus Lee,https://linkedin.com/in/SaraLindqvist-example,false\nHiro Sato,hiro@x.test,Rejected,Dana,,false\nSomeone Else,se@x.test,Applied,Dana,,false\n', 'ats.csv');
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug, '--crm', ats]);
  assert.ok(!load.ERROR, load.ERROR);
  const g = groups(H);
  assert.notEqual(g['Sara Lindqvist'], 'open', 'never a stranger: her LinkedIn link is in the ATS');
  assert.equal(g['Hiro Sato'], 'check', 'same name, no company to compare');
  assert.equal(g['New Person'], 'open');
});

test('a colleague\'s account stays theirs when its status is mapped to hold; an off-limits account beats a colleague', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nOpp Contact,VP Ops,Northgate,opp@northgate.test\nOther Person,COO,Northgate,other@northgate.test\nVictor Lang,CFO,Globex,victor@globex.test\n',
    settings: { status_map: { opportunity: 'hold', Lead: 'coordinate' }, crm_accounts: 'apply', crm_user_name: 'Marcus' } });
  const crm = file(H, 'Name,Email,Company,Owner,Status,Unsubscribed\nOpp Contact,opp@northgate.test,Northgate,Ana Ruiz,opportunity,false\nVictor Lang,victor@globex.test,Globex,Marcus,Lead,false\n', 'crm.csv');
  const acc = file(H, 'Company,Status\nGlobex,Off-limits: tender\n', 'accounts.csv');
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug, '--crm', crm, '--accounts', acc]);
  assert.ok(!load.ERROR, load.ERROR);
  const g = groups(H);
  assert.equal(g['Other Person'], 'coordinate', 'Ana\'s account still covers the rest of Northgate');
  assert.equal(g['Victor Lang'], 'suppressed', 'the tender beats the coordinate status');
});

test('an agent that can send is never the drafter; its instructions go to floorboss\'s writer; floorboss\'s own skills aren\'t the user\'s', () => {
  assert.equal(toolsRisk(undefined), 'all tools');
  assert.equal(toolsRisk('["WebSearch", "mcp__hubspot__search_contacts"]'), 'reads');
  assert.equal(toolsRisk('["WebSearch", "mcp__gmail__send_message", "Bash"]'), 'can send or write');
  const inv = summarize([], { skills: [{ name: 'floorboss:event-outreach', description: 'Write short pre-event outreach' }, { name: 'floorboss:crm-triage', description: 'crm' }], agents: [{ name: 'floorboss:outreach-critic', description: 'critic for outreach' }] });
  assert.equal(inv.outbound, 'none');
  assert.deepEqual(inv.found.crm, []);
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  writeFileSync(join(H.HOME, 'inventory.json'), JSON.stringify({ items: [{ type: 'agent', name: 'sdr-agent', tools: '["mcp__gmail__send_message"]', tools_risk: 'can send or write' }] }));
  const r = cli(H, 'event-context', ['config', '--set', JSON.stringify({ drafting_mode: 'delegate', drafter: { invoke: 'sdr-agent', type: 'agent' } })]);
  assert.match(r.ERROR, /can't be the drafter as an agent/);
  // The user's agent file lives in an agents folder (a project's .claude/agents here).
  mkdirSync(join(H.HOME, 'proj', '.claude', 'agents'), { recursive: true });
  const agentFile = join(H.HOME, 'proj', '.claude', 'agents', 'sdr-agent.md');
  writeFileSync(agentFile, '---\nname: sdr-agent\n---\nWrite short emails.');
  assert.equal(cli(H, 'event-context', ['config', '--set', JSON.stringify({ drafting_mode: 'delegate', drafter: { invoke: 'sdr-agent', type: 'instructions', path: agentFile } })]).ERROR, undefined);
  const d = drafterFor({ drafting_mode: 'delegate', drafter: { invoke: 'sdr-agent', type: 'instructions', path: agentFile } }, { kind: 'message', channel: 'email' });
  assert.deepEqual([d.invoke, d.instructions], ['floorboss:outreach-writer', agentFile]);
});

test('prefilter: a must-meet given with a company is kept; dropped people aren\'t "unjudged"', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nCy Ng,Branch Manager,Big Bank,cy@bank.test\nBo Li,Teller,First Credit Union,bo@fcu.test\nAna Berg,Head of Sales,Quorra AI,ana@quorra.test\n', settings: { must_meet: ['Cy Ng (Big Bank)', 'e'] } });
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const r = cli(H, 'crm-triage', ['prefilter', '--event', H.slug, '--rules-file', file(H, { keep_companies: ['ai'] })]);
  assert.deepEqual([r.kept, r.dropped], [2, 1], 'Cy kept by name; the one-letter must-meet protects nobody');
  const fits = JSON.parse(readFileSync(r.to_judge_file, 'utf8')).map((x) => ({ id: x.id, segment: 'ops-leaders', reason: `${x.title} at ${x.company}`, score: 80 }));
  const fit = cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits-file', file(H, fits)]);
  assert.equal(fit.unjudged, undefined, JSON.stringify(fit.unjudged));
  const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  assert.match(JSON.stringify(g.left_out), /dropped by the prefilter/);
});

test('onboarding: files given in answers land on the event; question ids work as answer keys; progress comes from the tree', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const crm = file(H, 'Name,Email\nx,x@y.test\n', 'crm.csv');
  writeFileSync(join(H.HOME, 'onboarding.json'), JSON.stringify({ rounds: {}, event: H.slug, answers: {} }));
  const r = cli(H, 'event-context', ['onboarding', '--answer-file', file(H, { crm_path: crm, browser: 'later', __proto__: { x: 1 } })]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8')).crm.path, realpathSync(crm));
  const st = JSON.parse(readFileSync(join(H.HOME, 'onboarding.json'), 'utf8'));
  assert.equal(st.events[H.slug].answers.browser_choice, 'later', 'an answer about this event\'s list is kept with the event');
  assert.equal(r.next, 'scan', 'nothing scanned yet: the tree says so');
});

test('calendar: a move frees the old time; a cancel-and-reinvite stays booked', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  triage(H); draftApprove(H);
  cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, { items: [{ who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00' }] })]);
  const ev = (status, start) => ({ start, end: start.replace(':00:00', ':30:00'), summary: 'x', self_response: 'accepted', attendees: [{ email: 'ana@acme.test', response: 'accepted' }], status });
  cli(H, 'event-outreach', ['calendar-bookings', '--event', H.slug, '--file', file(H, { events: [ev('confirmed', '2026-11-10T12:00:00Z')] })]);
  const ana = fold(readLedger(join(H.dir, 'ledger.jsonl')).entries).people[idOf(H, 'Ana Berg')];
  assert.equal(ana.booked, 's20261110T1300', 'the meeting is at its new time');
  assert.ok(!(ana.booked_blocks || []).includes('s20261110T1000'), JSON.stringify(ana.booked_blocks));
  const r = cli(H, 'event-outreach', ['calendar-bookings', '--event', H.slug, '--file', file(H, { events: [ev('cancelled', '2026-11-10T12:00:00Z'), ev('confirmed', '2026-11-10T12:00:00Z')] })]);
  assert.deepEqual(r.unbooked, [], 're-invited at the same time');
});

test('free times: "and"/"y" separators, weekday with a date, Spanish days', () => {
  const ev = ['2026-11-03', '2026-11-04', '2026-11-05'];
  assert.equal(parseFreeTimes('both days 10-12 and 14-17', { eventDays: ev.slice(0, 2) }).ranges.length, 4);
  assert.equal(parseFreeTimes('Tue 3 Nov 10:00-12:30 and 14:00-17:00', { eventDays: ev }).ranges.length, 2);
  assert.equal(parseFreeTimes('mié 4: 10:00-13:00 y 15:00-18:00', { eventDays: ev }).ranges.length, 2);
});

test('record: a first name alone finds the one person you\'re reaching; a cut leaves the shortlist file', () => {
  let att = 'Name,Title,Company,Email\nIlse Adams,AE,Spindle,ilse@spindle.test\n';
  for (let i = 0; i < 5; i++) att += `Ilse Other${i},Analyst,Co${i},a${i}@co${i}.test\n`;
  const H = setup({ attendees: att });
  triage(H, [], 'keep 1');
  draftApprove(H);
  const r = cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, { items: [{ who: 'ilse', what: 'sent' }] })]);
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.match(r.notes[0], /taken as Ilse Adams/);
  assert.ok(JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'shortlist.json'), 'utf8')).approved.includes(idOf(H, 'Ilse Adams')), 'on the shortlist before the cut');
  cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, { items: [{ who: 'Ilse Adams', what: 'cut' }] })]);
  assert.equal(fold(readLedger(join(H.dir, 'ledger.jsonl')).entries).people[idOf(H, 'Ilse Adams')].decision.group, 'skip');
  assert.ok(!JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'shortlist.json'), 'utf8')).approved.includes(idOf(H, 'Ilse Adams')));
});

test('gate: "keep N" then "rescue" keeps the rescued person', () => {
  let att = 'Name,Title,Company,Email\n';
  for (let i = 0; i < 8; i++) att += `P${i} Person,COO,Co${i},p${i}@co${i}.test\n`;
  const H = setup({ attendees: att });
  triage(H);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'keep 3']);
  const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', `rescue ${idOf(H, 'P6 Person')}`]);
  // keep 3 is three in all: the rescued person takes a place, the lowest-ranked stranger gives one up.
  assert.equal(g.shortlisted, 3);
  assert.ok(g.top.some((x) => x.id === idOf(H, 'P6 Person')));
});

test('languages: messages only in a language the sender meets in, with that language\'s opt-out line', async () => {
  const { checkDraft } = await import('../skills/event-outreach/scripts/checks.mjs');
  const base = { contact: { name: 'Begoña Muñoz' }, slotLabels: [], eventName: 'Cumbre Sur', pasteLimit: 600, languages: ['English', 'Spanish'] };
  const es = 'Hola Begoña, nos vemos en Cumbre Sur?\n\nLucía\n\nSi no te encaja, dímelo y no insisto.';
  assert.deepEqual(checkDraft({ channel: 'email', subject: 'x', body: es }, { ...base, language: 'Spanish', optout: 'Si no te encaja, dímelo y no insisto.' }), []);
  assert.ok(checkDraft({ channel: 'email', subject: 'x', body: es }, { ...base, language: 'Spanish', optout: 'If this isn\'t relevant, say so.' }).some((p) => /opt-out sentence in Spanish/.test(p)));
  assert.ok(checkDraft({ channel: 'email', subject: 'x', body: 'Bonjour, Cumbre Sur?' }, { ...base, language: 'French', optout: null }).some((p) => /isn't one of the languages you meet in/.test(p)));
});

test('onboarding: several CRMs → which one is used for this outreach; the languages question comes up', async () => {
  const { planQuestions } = await import('../skills/event-context/scripts/onboarding-tree.mjs');
  const inv = summarize([{ type: 'mcp', name: 'hubspot', kinds: ['crm'] }, { type: 'mcp', name: 'pipedrive', kinds: ['crm'] }]);
  const s = { inv, cfg: { company_caps: { mode: 'scale' }, goal: 'x', own_company: 'A', home_tz: 'Europe/Madrid' }, ev: { slug: 'e', name: 'E', no_app: true }, ans: { setup_level: 'full', inventory_confirmed: true, goal_type: 'selling', meetings_wanted_asked: true, must_meet_asked: true, works_alone: true, accounts_asked: true, dnc_asked: true }, slots: 0 };
  // One confirm for the tools names both CRMs; asked separately, the CRM question offers each by name.
  const listed = { ...s, ans: { ...s.ans, list_source: 'export' } };
  const t = planQuestions(listed, { batch: 20, phase: 'first' }).questions.find((x) => x.id === 'tools');
  assert.match(t.ask, /hubspot or pipedrive/);
  const q = planQuestions({ ...listed, ans: { ...listed.ans, tools_confirmed: true } }, { batch: 20, phase: 'first' }).questions.find((x) => x.id === 'crm_use');
  assert.match(q.ask, /holds your contacts/);
  assert.deepEqual(q.options.slice(0, 2), ['hubspot', 'pipedrive']);
  const { NODES } = await import('../skills/event-context/scripts/onboarding-tree.mjs');
  assert.ok(NODES.some((n) => n.id === 'languages'));
});
