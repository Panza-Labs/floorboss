// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// The opt-out line on emails to people the user already knows is the user's call, asked in setup: "only on
// cold emails" leaves it off for warm readers (customers, open deals, anyone marked warm) and keeps it for
// everyone else; unanswered, every email keeps it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, cli, todoJobs, idOf, fitAll } from './fixtures/harness.mjs';
import { optoutForReader, DEFAULTS } from '../lib/config.mjs';
import { NODES } from '../skills/event-context/scripts/onboarding-tree.mjs';

const CRM = `Contact Name,Email,Company,Job Title,Deal Stage,Contact Owner,Last Activity,Notes
Hannah Brooks,hannah.brooks@vandermolen.example,Vandermolen Logistics,COO,Customer,Jordan Lee,2026-08-02,Went live on yard module in June
`;
const LIST = `Name,Title,Company,Email
Hannah Brooks,COO,Vandermolen Logistics,hannah.brooks@vandermolen.example
Amira Haddad,Director of Operations,Pellworth Grocers,amira.haddad@pellworth.example
`;
const RULE = { recent_months: 6, recent: 'warm', on_deal: 'warm', other: 'warm' };

function ready(settings) {
  const H = setup({ attendees: LIST, crm: CRM, settings: { crm_user_name: 'Jordan Lee', customer_rule: RULE, ...settings } });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.ok(!load.ERROR, load.ERROR);
  fitAll(H, load);
  assert.ok(!cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'ok']).ERROR);
  const r = todoJobs(H);
  const job = (name) => r.jobs.find((x) => x.id === idOf(H, name) && x.kind === 'message');
  return { H, job };
}
const save = (H, j, body) => cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', '1', '--json', JSON.stringify({ subject: 'Test Expo', body: `${body} Could you do ${j.slot_labels.join(' or ')} at Test Expo?\n\nBest, Sam`, brief: 'x', structure: j.structure, fact_source: j.fact_sources?.[0] || 'none' })]);
const optoutProblem = (r) => JSON.stringify(r).includes('missing the opt-out sentence');

test('"only on cold emails": a warm reader\'s email ends at the sign-off, a cold one keeps the line', () => {
  const { H, job } = ready({ optout_known: false });
  const warm = job('Hannah Brooks'), cold = job('Amira Haddad');
  assert.equal(warm.group, 'warm');
  assert.equal(warm.optout_line, null);
  assert.equal(cold.optout_line, DEFAULTS.optout_sentence);
  assert.ok(!optoutProblem(save(H, warm, 'Hi Hannah, good to see the yard module live.')), 'no line needed for a customer');
  assert.ok(optoutProblem(save(H, cold, 'Hi Amira, a question about your docks.')), 'a cold email still needs it');
  const critic = cli(H, 'event-outreach', ['critic-batch', '--event', H.slug, '--ids', `${warm.id}:1`, '--compact']).drafts[0].input;
  assert.equal(critic.optout_sentence ?? null, null, 'the critic is not told to expect a line');
});

test('unanswered (or "every email"), a warm reader keeps the line', () => {
  for (const settings of [{}, { optout_known: true }]) {
    const { H, job } = ready(settings);
    const warm = job('Hannah Brooks');
    assert.equal(warm.optout_line, DEFAULTS.optout_sentence);
    assert.ok(optoutProblem(save(H, warm, 'Hi Hannah, good to see the yard module live.')));
  }
  assert.equal(optoutForReader({ optout_sentence: 'x' }, null, true), 'x');
  assert.equal(optoutForReader({ optout_sentence: 'x', optout_known: false }, null, false), 'x');
  assert.equal(optoutForReader({ optout_sentence: 'x', optout_known: false }, null, true), null);
});

test('setup asks it of a seller with a CRM, never of a job seeker or a run with no CRM', () => {
  const node = NODES.find((n) => n.id === 'optout_known');
  assert.ok(node, 'the question exists');
  const s = (ans, cfg = {}) => ({ ans, cfg, ev: {}, inv: {} });
  assert.equal(node.when(s({ goal_type: 'selling', crm_choice: 'connector' })), true);
  assert.equal(node.when(s({ goal_type: 'looking for a job', crm_choice: 'connector' }, { optout_sentence: '' })), false);
  assert.equal(node.when(s({ goal_type: 'selling', crm_choice: 'none' })), false);
  assert.equal(node.done(s({}, { optout_known: false })), true);
  assert.equal(node.done(s({}, {})), false);
  assert.match(node.ask(s({})), /cold emails keep it/i);
});

test('a recruiter with an ATS export is asked too, in hiring words', () => {
  const node = NODES.find((n) => n.id === 'optout_known');
  const s = { ans: { goal_type: 'hiring', crm_choice: 'export' }, cfg: {}, ev: {}, inv: {} };
  assert.equal(node.when(s), true);
  assert.match(node.ask(s), /candidates already in your process/);
});

test('the user\'s own edit of a German draft keeps the draft\'s language, so the German line is the one checked', () => {
  const DE = 'Wenn das nicht passt, sag kurz Bescheid, dann melde ich mich nicht mehr.';
  const { H, job } = ready({ languages: ['English', 'German'], optout_sentences: { German: DE } });
  const j = job('Amira Haddad');
  const body = (t) => `Hallo Amira, kurze Frage zu euren Docks. Passt ${j.slot_labels.join(' oder ')} auf der Test Expo?\n\nBeste Grüße, Sam\n\n${t}`;
  const first = cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', '1', '--json', JSON.stringify({ subject: 'Test Expo', body: body(DE), brief: 'x', language: 'German', structure: j.structure, fact_source: j.fact_sources?.[0] || 'none' })]);
  assert.ok(!optoutProblem(first), JSON.stringify(first).slice(0, 400));
  const edit = cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', '1', '--json', JSON.stringify({ subject: 'Test Expo', body: body(DE).replace('kurze Frage', 'eine Frage') })]);
  assert.ok(!optoutProblem(edit), `an edit with the German line is not refused: ${JSON.stringify(edit).slice(0, 400)}`);
});

test('someone marked known and then reached as cold keeps the opt-out line', () => {
  const { H, job } = ready({ optout_known: false });
  const id = job('Amira Haddad').id;
  // The user's word that they know her, then "reach anyway because we have never met".
  assert.ok(!cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', `warm ${id} because she is mine`]).ERROR);
  assert.ok(!cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', `reach ${id} because we have never met`]).ERROR);
  const j = todoJobs(H).jobs.find((x) => x.id === id && x.kind === 'message');
  if (j.group !== 'warm') assert.equal(j.optout_line, DEFAULTS.optout_sentence, `group ${j.group} keeps the line`);
});

test('a stranger at a customer account (no CRM record of their own) keeps the line; a known reader\'s email that adds it is refused', () => {
  const crm = `${CRM},,Pellworth Grocers,,Customer,Jordan Lee,2026-05-14,Account row\n`;
  const H = setup({ attendees: LIST, crm, settings: { crm_user_name: 'Jordan Lee', customer_rule: RULE, crm_accounts: 'apply', optout_known: false } });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.ok(!load.ERROR, load.ERROR);
  fitAll(H, load);
  assert.ok(!cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'ok']).ERROR);
  const jobs = todoJobs(H).jobs;
  const job = (name) => jobs.find((x) => x.id === idOf(H, name) && x.kind === 'message');
  const stranger = job('Amira Haddad'), known = job('Hannah Brooks');
  assert.equal(stranger.optout_line, DEFAULTS.optout_sentence, `group ${stranger.group}: a stranger at a customer keeps the line`);
  assert.equal(known.optout_line, null);
  assert.match(JSON.stringify(save(H, known, `Hi Hannah, good to see the yard module live.`) ), /./);
  const withLine = cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', known.id, '--touch', '1', '--json', JSON.stringify({ subject: 'Test Expo', body: `Hi Hannah, good to see the yard module live. Could you do ${known.slot_labels.join(' or ')} at Test Expo?\n\nBest, Sam\n\n${DEFAULTS.optout_sentence}`, brief: 'x', structure: known.structure, fact_source: known.fact_sources?.[0] || 'none' })]);
  assert.match(JSON.stringify(withLine), /chose to leave off emails to people you already know/);
});
