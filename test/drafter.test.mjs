// Who writes the messages: floorboss, the user's own outbound skill or agent (delegate), or a mix (blend).
// Whoever drafts, floorboss's checks and critic read every message before the gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, idOf, todoJobs } from './fixtures/harness.mjs';
import { drafterFor } from '../skills/event-outreach/scripts/drafter.mjs';

// These tests save a drafter as the flow does while saving that answer (drafter and drafting_mode are answer-only).
process.env.FLOORBOSS_SAVED_BY = 'drafter';

const SDR = { name: 'our SDR agent', invoke: 'acme-sdr', type: 'agent', covers: { channels: ['email'], kinds: ['first'] }, gaps: ['voice'] };

test('drafterFor: floorboss, delegate and blend route each job to the right writer', () => {
  const first = { kind: 'message', channel: 'email', followup: false };
  const app = { kind: 'message', channel: 'paste', followup: false };
  const fu = { kind: 'message', channel: 'email', followup: true };
  assert.equal(drafterFor({ drafting_mode: 'floorboss', drafter: SDR }, first).by, 'floorboss');
  assert.equal(drafterFor({ drafting_mode: null }, first).by, 'floorboss', 'not asked yet: floorboss, and todo says so');
  // Delegate: everything it covers; a skill that names only first emails doesn't improvise follow-ups.
  const ALL = { ...SDR, covers: { channels: [], kinds: [] } };
  for (const j of [first, app, fu, { kind: 'confirmation', channel: 'email' }]) assert.equal(drafterFor({ drafting_mode: 'delegate', drafter: ALL }, j).by, 'user');
  assert.equal(drafterFor({ drafting_mode: 'delegate', drafter: SDR }, first).by, 'user');
  assert.match(drafterFor({ drafting_mode: 'delegate', drafter: SDR }, fu).why, /doesn't write follow-ups/);
  assert.match(drafterFor({ drafting_mode: 'delegate', drafter: SDR }, app).why, /doesn't write event-app/);
  const blend = { drafting_mode: 'blend', drafter: SDR };
  assert.deepEqual(drafterFor(blend, first), { by: 'user', name: 'our SDR agent', invoke: 'acme-sdr', type: 'agent', gaps: ['voice'] });
  assert.match(drafterFor(blend, app).why, /doesn't write event-app or LinkedIn notes/);
  assert.match(drafterFor(blend, fu).why, /doesn't write follow-ups/);
  assert.equal(drafterFor({ drafting_mode: 'delegate', drafter: SDR }, { kind: 'coordinate' }).by, 'floorboss', 'notes to colleagues stay internal');
});

test('settings: delegate and blend need a real drafter', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const set = (o) => cli(H, 'event-context', ['config', '--set', JSON.stringify(o)]);
  assert.equal(set({ drafting_mode: 'delegate' }).ERROR, undefined, 'the mode can be saved before the drafter (the tree asks the drafter next)');
  assert.match(set({ drafting_mode: 'sometimes' }).ERROR, /"floorboss", "delegate" or "blend"/);
  assert.match(set({ drafting_mode: 'blend', drafter: { invoke: 'rm -rf /' } }).ERROR, /needs "invoke"/);
  assert.match(set({ drafting_mode: 'blend', drafter: { invoke: 'acme-sdr', covers: { channels: ['sms'] } } }).ERROR, /covers.channels/);
  assert.match(set({ drafting_mode: 'blend', drafter: SDR }).ERROR, /unknown \(not in the scan\)/, 'an agent the scan hasn\'t checked isn\'t trusted');
  writeFileSync(join(H.HOME, 'inventory.json'), JSON.stringify({ items: [{ type: 'agent', name: 'acme-sdr', tools: '["WebSearch"]', tools_risk: 'reads' }] }));
  assert.equal(set({ drafting_mode: 'blend', drafter: SDR }).ERROR, undefined);
});

test('delegate: the user\'s drafter gets a full brief; its draft is saved as its own and still needs the critic', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,\n', event: { app_name: 'Grip' },
    settings: { drafting_mode: 'delegate', drafter: { ...SDR, covers: { channels: ['email', 'paste'], kinds: ['first', 'followup', 'confirmation'] }, gaps: [] }, app_note_times: 'in_app', app_note_optout: false } });
  triage(H);
  const { t, jobs } = todoJobs(H);
  assert.deepEqual([t.drafting.mode, t.drafting.by_user, t.drafting.by_floorboss], ['delegate', 2, 0]);
  const b = cli(H, 'event-outreach', ['briefs', '--event', H.slug]);
  assert.equal(b.briefs, 2, JSON.stringify(b));
  const ana = idOf(H, 'Ana Berg'), bo = idOf(H, 'Bo Li');
  const brief = (id) => readFileSync(b.by_drafter.find((x) => x.id === id).brief_file, 'utf8');
  assert.match(brief(ana), /To: Ana Berg, COO at Acme/);
  assert.match(brief(ana), /Offer exactly these times/);
  assert.match(brief(ana), /End with this sentence on its own line/);
  assert.match(brief(ana), /What the sender may say about themselves/);
  assert.match(brief(ana), /Answer with JSON only/);
  assert.match(brief(bo), /meeting request carries them\. Do not put times in the note/);
  assert.doesNotMatch(brief(bo), /End with this sentence/, 'opt-out off for app notes');
  const j = jobs.find((x) => x.id === ana);
  const saved = cli(H, 'event-outreach', ['save-drafts', '--event', H.slug, '--drafts', JSON.stringify([{ id: ana, touch: 1, subject: 'Test Expo', body: `Hi Ana, we're both at Test Expo. Could you do ${j.slot_labels.join(' or ')}?\n\nBest, Sam\n\n${t.optout_sentence}`, brief: 'x', drafted_by: 'acme-sdr' }])]);
  assert.ok(!saved.ERROR, saved.ERROR);
  assert.equal(JSON.parse(readFileSync(join(H.dir, 'work', 'drafts', `${ana}-t1.json`), 'utf8')).drafted_by, 'acme-sdr');
  const g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all']);
  assert.ok(JSON.stringify(g).includes('the critic hasn\'t read it'), 'a delegated draft still goes to the critic');
});

test('blend: the drafter takes what it covers, with floorboss\'s voice for its gap; floorboss drafts the rest', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,\n', event: { app_name: 'Grip' }, settings: { drafting_mode: 'blend', drafter: SDR } });
  triage(H);
  const { t, jobs } = todoJobs(H);
  assert.deepEqual([t.drafting.by_user, t.drafting.by_floorboss], [1, 1]);
  assert.match(jobs.find((x) => x.id === idOf(H, 'Bo Li')).drafter.why, /event-app or LinkedIn/);
  const b = cli(H, 'event-outreach', ['briefs', '--event', H.slug]);
  assert.deepEqual(b.by_drafter.map((x) => x.id), [idOf(H, 'Ana Berg')]);
  assert.match(readFileSync(b.by_drafter[0].brief_file, 'utf8'), /Your material has no voice for this; use the sender's voice from floorboss/);
});

test('not asked yet: todo says to settle who writes the messages before drafting', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  triage(H);
  assert.match(todoJobs(H).t.drafting.note, /Nobody has said who writes the messages/);
});
