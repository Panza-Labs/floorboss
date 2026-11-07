// Round 5's small things: a figure no source has is a check fail; saving the same text again uses no try; the
// sign-off question proposes the CRM name; the home zone is said back; the coworker question has its counts;
// "same setup?" names the CRM; a new event named in "which event" isn't asked again; a meeting still to come is
// "booked", not "met"; a send dated before its approval is said; earlier ratings stand while the voice does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, cli, triage, todoJobs, idOf } from './fixtures/harness.mjs';
import { inventedFigures, checkDraft } from '../skills/event-outreach/scripts/checks.mjs';
import { NODES } from '../skills/event-context/scripts/onboarding-tree.mjs';
import { coworkerCounts, ratingsCarry } from '../skills/flow/scripts/steps.mjs';
import { earlierEvents } from '../skills/crm-triage/scripts/evidence.mjs';

test('checks: a percentage, multiple or amount no source has fails, named; one the material has passes', () => {
  assert.deepEqual(inventedFigures('Railyard cuts truck waiting time by 70% at most DCs, 3x faster, for €40k.', 'Castella cut waits from 52 to 19 minutes'), ['70%', '3x', '€40k']);
  assert.deepEqual(inventedFigures('about 60% of the elapsed days', 'Most onboarding delay is waiting on insurance certificates: about 60 % of the elapsed days'), []);
  const p = checkDraft({ channel: 'email', subject: 'x', body: 'Hi Ana, we cut waiting by 70% at Test Expo sites.' }, { contact: { name: 'Ana Berg' }, ownFacts: 'proof: 52 to 19 minutes', factText: '' });
  assert.ok(p.some((x) => /^uses 70%, which nothing floorboss has for this message says/.test(x)), JSON.stringify(p));
});

test('save-drafts on an unchanged draft uses up no try', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  triage(H);
  const { t, jobs } = todoJobs(H);
  const j = jobs.find((x) => x.kind === 'message');
  const d = JSON.stringify({ subject: 'Test Expo', body: `Hi Ana, a plain ask about Test Expo. Could you do ${j.slot_labels.join(' or ')}?\n\nBest, Sam\n\n${t.optout_sentence}`, brief: 'x', structure: 'plain-request', fact_source: 'list' });
  const save = () => cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', '1', '--json', d]);
  assert.equal(save().attempts, 1);
  assert.equal(save().attempts, 1, 'the same text again');
});

test('onboarding: about_you proposes the name saved as the user\'s in the CRM; "same setup?" names the CRM export; a named new event is not asked for again', () => {
  const ask = (id, st) => NODES.find((n) => n.id === id).ask({ inv: { found: {} }, ev: { slug: 'ev' }, cfg: {}, ans: {}, slots: 0, list: null, ...st });
  const about = ask('about_you', { cfg: { crm_user_name: 'Jordan Lee', own_company: 'Railyard Software', drafting_mode: 'floorboss' } });
  assert.match(about, /Propose the sign-off from the name they gave as theirs in the CRM \(Jordan Lee, Railyard Software\)/);
  assert.doesNotMatch(about, /Nothing to propose/);
  assert.match(ask('reuse_setup', { ans: { setup_level: 'standard', crm_choice: 'other', crm_label: 'HubSpot (an export)' } }), /your CRM \(HubSpot \(an export\)\)/);
  assert.match(ask('reuse_setup', { ans: { setup_level: 'standard', crm_choice: 'other' } }), /your CRM \(a CSV export\)/);
  assert.match(ask('event', { ev: null, ans: { event_hint: 'ColdChain Summit in Rotterdam' } }), /They named it already \("ColdChain Summit in Rotterdam"\): don't ask for the name again/);
  assert.match(ask('event', { ev: null }), /^Which event is this for\?/);
});

test('the coworker question\'s counts: per owner, how many on the list and in the CRM', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nOlivia Grant,Head,Brightway,olivia@brightway.test\nDan Novak,Manager,Danubia,dan@danubia.test\n', crm: 'Name,Email,Company,Owner,Status,Opted Out\nOlivia Grant,olivia@brightway.test,Brightway,Priya Shah,Proposal,no\nRaj Patel,raj@meridian.test,Meridian,Priya Shah,Lead,no\nDan Novak,dan@danubia.test,Danubia,Sam Rivera,Lead,no\n' });
  cli(H, 'crm-triage', ['propose-mapping', '--event', H.slug, '--kind', 'crm']);
  assert.ok(!cli(H, 'crm-triage', ['confirm-mapping', '--event', H.slug, '--kind', 'crm', '--accept']).ERROR);
  const counts = coworkerCounts({ event: { inputs: { crm: join(H.dir, 'crm.csv'), attendees: join(H.dir, 'attendees.csv') }, paths: { dir: H.dir } }, cfg: { crm_user_name: 'Sam Rivera' } });
  assert.deepEqual(counts, [{ owner: 'Priya Shah', records: 2, on_list: 1 }]);
});

test('an earlier event\'s meeting still to come is "booked 11 Nov", not "met"; ratings from it stand while the voice hasn\'t changed', () => {
  const HOME = mkdtempSync(join(tmpdir(), 'fb-r5-'));
  process.env.FLOORBOSS_HOME = HOME;
  process.env.FLOORBOSS_NOW = '2026-10-31T09:00:00Z';
  const ev = (slug, name, lines) => { const d = join(HOME, 'events', slug); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'event.json'), JSON.stringify({ slug, name, start_date: '2026-11-11', end_date: '2026-11-12', time_zone: 'Europe/Amsterdam' })); writeFileSync(join(d, 'ledger.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); return d; };
  const h = 'a'.repeat(24);
  ev('supplyflow', 'SupplyFlow Expo 2026', [
    { at: '2026-10-30T10:00:00Z', type: 'person', who: 'floorboss', id: 'c001', name: 'Elena Marsh', company: 'Nordhaven', email: 'elena@nordhaven.test', keys: [], lines: [2] },
    { at: '2026-10-30T10:01:00Z', type: 'drafted', who: 'floorboss', id: 'c001', touch: 1, kind: 'message', hash: h },
    { at: '2026-10-30T10:02:00Z', type: 'copy_rating', who: 'user', id: 'c001', touch: 1, hash: h, rating: 7, said: '1: 7' },
    { at: '2026-10-30T10:03:00Z', type: 'approved', who: 'user', id: 'c001', touch: 1, hash: h, to: 'elena@nordhaven.test', via: 'you', said: 'approve all' },
    { at: '2026-10-30T10:04:00Z', type: 'sent', who: 'user', id: 'c001', touch: 1, date: '2026-10-30', said: 'sent' },
    { at: '2026-10-30T10:05:00Z', type: 'booked', who: 'user', id: 'c001', slot: 's1', start: '2026-11-11T09:00:00.000Z', said: 'Wed 10:00' },
  ]);
  const dir = ev('coldchain', 'ColdChain Summit 2026', []);
  const met = earlierEvents('coldchain').people.find((p) => p.name === 'Elena Marsh');
  assert.equal(met.outcome, 'booked 11 Nov');
  assert.match(met.says, /\(booked 11 Nov\)/);
  const ctx = join(HOME, 'context', 'p'); mkdirSync(join(ctx, 'voice'), { recursive: true });
  const voice = join(ctx, 'voice', 'SKILL.md'); writeFileSync(voice, '# Voice\n');
  const e = { event: { slug: 'coldchain', context_profile: 'p', context_dir: ctx }, settings: {}, paths: { dir } };
  utimesSync(voice, new Date('2026-10-29T00:00:00Z'), new Date('2026-10-29T00:00:00Z'));
  assert.equal(ratingsCarry(e), 'SupplyFlow Expo 2026');
  utimesSync(voice, new Date('2026-10-31T00:00:00Z'), new Date('2026-10-31T00:00:00Z'));
  assert.equal(ratingsCarry(e), null, 'the voice changed since: rate again');
});

test('record: a send dated before its approval is recorded, and said', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  triage(H);
  const { t, jobs } = todoJobs(H, '2026-10-14T08:00:00Z');
  const j = jobs.find((x) => x.kind === 'message');
  cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', '1', '--json', JSON.stringify({ subject: 'Test Expo', body: `Hi Ana, a plain ask about Test Expo. Could you do ${j.slot_labels.join(' or ')}?\n\nBest, Sam\n\n${t.optout_sentence}`, brief: 'x', structure: 'plain-request', fact_source: 'list' })], '2026-10-14T08:00:00Z');
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--text', 'PASS'], '2026-10-14T08:00:00Z');
  assert.ok(!cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all'], '2026-10-14T08:00:00Z').ERROR);
  const f = join(H.dir, 'sent.json'); writeFileSync(f, JSON.stringify({ items: [{ who: 'Ana Berg', what: 'sent', date: '2026-10-12' }] }));
  const r = cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', f], '2026-10-14T09:00:00Z');
  assert.ok(!r.ERROR, r.ERROR);
  assert.ok(r.notes.some((n) => /sent on 2026-10-12, before it was approved on 2026-10-14; recorded anyway/.test(n)), JSON.stringify(r.notes));
  assert.ok(idOf(H, 'Ana Berg'));
});
