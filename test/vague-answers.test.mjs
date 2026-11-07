// Users who answer vaguely or wrongly: CRM stop notes, NDA numbers, bounces and odd times, what the scan
// offers for sending, loose free times, and text edited after the critic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, idOf, draftApprove, todoJobs, groups, NOW } from './fixtures/harness.mjs';
import { checkDraft } from '../skills/event-outreach/scripts/checks.mjs';
import { toolKinds, summarize } from '../skills/event-context/scripts/scan.mjs';
import { planQuestions } from '../skills/event-context/scripts/onboarding-tree.mjs';
import { parseFreeTimes } from '../skills/slot-finder/scripts/freetimes.mjs';

const file = (H, data, name = `f${Math.random().toString(36).slice(2)}.json`) => { const f = join(H.dir, name); writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data)); return f; };

test('a CRM note that says stop or don\'t pitch holds the person, even with no opt-out column', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nOllie Grant,COO,Acme,ollie@acme.test\nNew Person,COO,Globex,np@globex.test\n' });
  const crm = file(H, 'Name,Email,Company,Notes\nOllie Grant,ollie@acme.test,Acme,"dont pitch, happy customer"\n', 'sheet.csv');
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug, '--crm', crm, '--optout', 'none']);
  assert.ok(!load.ERROR, load.ERROR);
  assert.equal(groups(H)['Ollie Grant'], 'suppressed', 'a plain stop request in a note holds');
  assert.match(load.skipped_because ? Object.keys(load.skipped_because).join(' ') : '', /CRM note/);
  assert.equal(groups(H)['New Person'], 'open');
});

test('a number the profile marks NDA can\'t go in a message', () => {
  const p = checkDraft({ channel: 'email', subject: 'x', body: 'Hi Ana, Nordline cut detention fees 41% with us. Expo?' }, { contact: { name: 'Ana' }, slotLabels: [], eventName: 'Expo', pasteLimit: 600, ownFacts: '- Nordline: 41% fewer detention fees (under NDA, internal only)' });
  assert.ok(p.some((x) => /41%.*confidential/.test(x)), p.join(' | '));
});

test('bounced with a new address, met in person, and night-time or off-event times', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nGus Ho,COO,Acme,gus@acme.test\nEve Li,VP,Globex,eve@globex.test\n' });
  triage(H); draftApprove(H);
  const rec = (items) => cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, { items })]);
  rec([{ who: 'Gus Ho', what: 'sent', date: '2026-10-12' }]);
  const b = rec([{ who: 'Gus Ho', what: 'bounced', new_email: 'gus@newco.example' }]);
  assert.match(b.recorded[0], /bounced; their address is now gus@newco.example/);
  assert.equal(JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'contacts.json'), 'utf8')).contacts.find((c) => c.name === 'Gus Ho').email, 'gus@newco.example');
  assert.match(rec([{ who: 'Eve Li', what: 'met' }]).recorded[0], /met in person/);
  assert.match(rec([{ who: 'Eve Li', what: 'booked', time: '2026-11-10 03:00' }]).ERROR, /middle of the night: did they mean 15:00\?/, 'a night time is a question, not a refusal');
  assert.match(rec([{ who: 'Eve Li', what: 'booked', time: '2026-11-10 03:00', night: true }]).recorded[0], /booked/, 'confirmed by the user, it records');
  assert.match(rec([{ who: 'Eve Li', what: 'booked', time: '2026-12-01 15:00' }]).ERROR, /isn't an event day/);
});

test('scan: servers are read by what their tools do; sending offers only what the setup can do', () => {
  assert.deepEqual(toolKinds(['create_draft', 'get_thread', 'search_threads', 'send_message']), ['email']);
  assert.deepEqual(toolKinds(['search_contacts', 'get_owner', 'send_marketing_email']), ['crm']);
  const s = { inv: summarize([]), cfg: { company_caps: { mode: 'scale' } }, ev: { slug: 'e', name: 'E', app_name: 'Whova' }, ans: { setup_level: 'full', sending_asked: false }, slots: 1 };
  const q = planQuestions(s, { batch: 30 });
  const node = (await_ => null);
  const all = [];
  for (const r of ['sending']) { const st = { ...s, ans: { setup_level: 'full', inventory_confirmed: true, goal_type: 'selling', meetings_wanted_asked: true, must_meet_asked: true, app_limit_asked: true, works_alone: true, accounts_asked: true, dnc_asked: true, crm_choice: 'none', known_asked: true, list_source: 'export', contact_details: 'later', import_context: 'no', posture: 'x', seller_framing: 'no', segments_confirmed: true, material_asked: true, insights_asked: true, offer_asked: true, claims_confirmed: true, samples_ok: true, app_notes_asked: true, basics_asked: true, about_you_asked: true }, cfg: { company_caps: { mode: 'scale' }, goal: 'x', own_company: 'A', home_tz: 'Europe/London', drafting_mode: 'floorboss', context_profile: 'p', languages: ['English'] } }; all.push(planQuestions(st)); }
  const sending = all[0].questions.find((x) => x.id === 'sending');
  assert.match(sending.ask, /Nothing in your setup can send/);
  assert.deepEqual(sending.options, ['nowhere: I\'ll send them myself']);
});

test('free times: "all day every day" is working hours each day; German dates', () => {
  assert.equal(parseFreeTimes('all day every day', { eventDays: ['2026-11-09', '2026-11-10'] }).ranges.length, 2);
  assert.equal(parseFreeTimes('Mi 18.11. 10-12 und 14-16 Uhr', { eventDays: ['2026-11-18'] }).ranges.length, 2);
});

test('a text edited after the critic read it goes back to the critic before it can be approved', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  triage(H);
  const { t, jobs } = todoJobs(H);
  const j = jobs[0];
  const body = `Hi Ana, we're both at Test Expo. Could you do ${j.slot_labels.join(' or ')}?\n\nBest, Sam\n\n${t.optout_sentence}`;
  cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', '1', '--json', JSON.stringify({ subject: 'Test Expo', body, brief: 'x' })]);
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--touch', '1', '--text', 'PASS']);
  const f = join(H.dir, 'work', 'drafts', `${j.id}-t1.json`);
  const d = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...d, body: d.body.replace('Best, Sam', 'Their CFO is thrilled.\n\nBest, Sam') }));
  const g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', `approve ${j.id}`]);
  assert.match(JSON.stringify(g), /changed after the critic read it/);
});
