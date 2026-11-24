// The guard's PostToolUse hook on AskUserQuestion records the user's pick at the final approval, from the tool's own
// answer: the approve command in Claude Code reads only that record. A subagent's question, a question that isn't
// floorboss's as written, and no answer record nothing, so the agent can't approve by itself.
import { withSeen, withoutRecord } from './fixtures/guard-seen.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { world, autosend, ledgerLines, ROOT, EVENT, envFor, said } from './fixtures/autosend-world.mjs';
import { PICKS, picksFile } from '../lib/autosend/pick.mjs';

const post = (HOME, input) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs'), 'post'], { input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'sess-1', tool_name: 'AskUserQuestion', ...input }), env: envFor(HOME, { claude: true }), encoding: 'utf8' });
const asked = (rb, answer, extra = {}) => ({ tool_use_id: 'toolu_01', tool_input: rb.choice.ask_user_question, tool_response: { questions: rb.choice.ask_user_question.questions, answers: { [rb.choice.ask_user_question.questions[0].question]: answer } }, ...extra });
const routineEvent = { ...EVENT, autosend_mode: 'routine' };

test('Claude Code: approve reads the pick the hook recorded from AskUserQuestion; without one nothing is approved', () => {
  const { HOME, evDir } = world({ touches: 2, event: routineEvent });
  const rb = autosend(HOME, ['readback', '--event', 'harbor-expo'], { claude: true });
  assert.ok(!rb.ERROR, rb.ERROR);
  assert.equal(rb.choice.ask_user_question.questions[0].options[0].label, PICKS[0].label);
  assert.match(rb.show, /AskUserQuestion/);
  // The agent's own words are not a pick: approve refuses with none recorded, --said or not.
  assert.match(autosend(HOME, withSeen(HOME, ['approve', '--event', 'harbor-expo', '--digest', rb.digest, '--said-file', said(HOME, '1')]), { claude: true }).ERROR, /No pick of the user's is recorded/);
  // A subagent's question, and floorboss's question with an option reworded, record nothing.
  assert.equal(post(HOME, asked(rb, PICKS[0].label, { agent_id: 'sub-1' })).status, 0);
  const re = JSON.parse(JSON.stringify(rb));
  re.choice.ask_user_question.questions[0].options[0].label = 'Approve and send now';
  assert.equal(post(HOME, asked(re, 'Approve and send now')).status, 0);
  assert.ok(!existsSync(picksFile(HOME)), 'nothing recorded');
  // The user's pick, as the tool answered it.
  assert.equal(post(HOME, asked(rb, PICKS[0].label)).status, 0);
  const rec = readFileSync(picksFile(HOME), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual([rec.length, rec[0].pick, rec[0].call, rec[0].slug], [1, 'auto', 'toolu_01', 'harbor-expo']);
  const ok = autosend(HOME, withSeen(HOME, ['approve', '--event', 'harbor-expo', '--digest', rb.digest]), { claude: true });
  assert.ok(!ok.ERROR, ok.ERROR);
  assert.equal(ok.pick, 'auto');
  assert.match(ok.next, /drafts next --event harbor-expo --run new/);
  assert.equal(ledgerLines(evDir).filter((e) => e.type === 'autosend_approved' && e.pick_call === 'toolu_01').length, 6);
  // Used once: the same pick again approves nothing.
  assert.match(autosend(HOME, withSeen(HOME, ['approve', '--event', 'harbor-expo', '--digest', rb.digest]), { claude: true }).ERROR, /Nothing is waiting|already used/);
});

test('Claude Code: a pick of "put them in my drafts" and of the user\'s own words', () => {
  const { HOME, evDir } = world({ touches: 1, event: routineEvent });
  const rb = autosend(HOME, ['readback', '--event', 'harbor-expo'], { claude: true });
  post(HOME, asked(rb, 'approve all except Bo', { tool_use_id: 'toolu_02' }));
  assert.match(autosend(HOME, withSeen(HOME, ['approve', '--event', 'harbor-expo', '--digest', rb.digest]), { claude: true }).ERROR, /the user wrote "approve all except Bo"/);
  post(HOME, asked(rb, PICKS[1].label, { tool_use_id: 'toolu_03' }));
  const ok = autosend(HOME, withSeen(HOME, ['approve', '--event', 'harbor-expo', '--digest', rb.digest]), { claude: true });
  assert.equal(ok.pick, 'drafts', JSON.stringify(ok));
  assert.equal(ledgerLines(evDir).filter((e) => e.type === 'drafts_approved').length, 3);
  assert.ok(!ledgerLines(evDir).some((e) => e.type === 'autosend_approved'));
});

test('Claude Code: the flow\'s review readback says what pick 1 does and gives the same choice, for the same digest', () => {
  const { HOME } = world({ touches: 2, event: routineEvent });
  const r = spawnSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'review', '--event', 'harbor-expo', '--readback'], { env: envFor(HOME, { claude: true }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rv = JSON.parse(r.stdout);
  const rb = autosend(HOME, ['readback', '--event', 'harbor-expo'], { claude: true });
  assert.equal(rv.digest, rb.digest);
  assert.deepEqual(rv.choice, rb.choice);
  assert.match(rv.how_it_goes, /laptop can be off/);
  assert.match(rv.show, /AskUserQuestion/);
  assert.ok(!/\u2014/.test(r.stdout), 'no em dashes');
});

// The one-use record (0.1.7): the same kind of call with no record of the guard's is refused, and changes nothing.
test('without the guard\'s record, approve is refused in Claude Code and changes nothing', async () => {
  const r = await withoutRecord('approve');
  assert.match(r.error, /safety check did not see this command/);
  assert.ok(r.unchanged);
});
