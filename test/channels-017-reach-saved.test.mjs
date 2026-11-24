// 0.1.7 review, channel choice: the user's own route and count are never saved over; the choice is read each time.
// Negations are read the right way round; the count keeps an email at both ends; a filtered route keeps each day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, NOW } from './fixtures/harness.mjs';
import { NODES } from '../skills/event-context/scripts/onboarding-tree.mjs';
import { chosenRoute } from '../lib/route.mjs';
import { effectiveSettings } from '../lib/config.mjs';

const home = (cfg = null, ans = { setup_level: 'full' }) => {
  const H = mkdtempSync(join(tmpdir(), 'fb-reach2-'));
  mkdirSync(join(H, 'work'));
  writeFileSync(join(H, 'onboarding.json'), JSON.stringify({ rounds: {}, event: null, answers: ans }));
  if (cfg) writeFileSync(join(H, 'config.json'), JSON.stringify(cfg));
  return H;
};
const answer = (H, ask, text) => {
  const f = join(H, 'work', `${ask}.txt`);
  writeFileSync(f, text);
  try {
    return JSON.parse(execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'answer', '--ask', ask, '--value-file', f], { env: { ...process.env, FLOORBOSS_HOME: H, FLOORBOSS_NOW: NOW }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) {
    return { ERROR: String(e.stderr) };
  }
};
const cfg = (H) => JSON.parse(readFileSync(join(H, 'config.json'), 'utf8'));
const told = (r) => r?.result?.say_to_user || r?.say_to_user || '';

test('changing the answer back and forth never saves over the route: "both" again uses the app again', () => {
  const H = home();
  for (const v of ['both', 'email only', 'both']) answer(H, 'reach_channels', v);
  assert.equal(cfg(H).route ?? null, null, 'no route saved');
  assert.deepEqual(cfg(H).reach, ['app', 'linkedin']);
  assert.deepEqual(chosenRoute(cfg(H)), ['email', 'app', 'linkedin', 'email']);
});

test("the user's own route is kept as they set it; the choice is applied when it is read", () => {
  const H = home({ route: ['email', 'linkedin', 'app', 'email'] });
  answer(H, 'reach_channels', 'the app');
  assert.deepEqual(cfg(H).route, ['email', 'linkedin', 'app', 'email']);
  assert.deepEqual(chosenRoute(cfg(H)), ['email', 'app', 'email']);
  answer(H, 'reach_channels', 'both');
  assert.deepEqual(chosenRoute(cfg(H)), ['email', 'linkedin', 'app', 'email']);
});

test('negations and "just" or "only" are read the right way round', () => {
  for (const [said, reach] of [
    ['event app, not linkedin', ['app']], ['not the app, just linkedin', ['linkedin']], ['no linkedin, the app is fine', ['app']],
    ['linkedin but not the app', ['linkedin']], ['without linkedin', []], ['everything except the app', ['linkedin']],
    ['only the app', ['app']], ['linkedin only', ['linkedin']], ['just email', []], ['no app', []]
  ]) {
    const H = home();
    const r = answer(H, 'reach_channels', said);
    assert.equal(r.ERROR, undefined, `${said}: ${r.ERROR}`);
    assert.deepEqual(cfg(H).reach, reach, said);
  }
});

test('words with a "not" or "no" in them are read back in one line; unclear words are asked again', () => {
  const H = home();
  const r = answer(H, 'reach_channels', 'event app, not linkedin');
  assert.match(told(r), /^So: email and the event app, and not LinkedIn\. /, told(r));
  for (const said of ['whatever you think', 'yes', 'banana']) {
    const r2 = answer(home(), 'reach_channels', said);
    assert.match(r2.ERROR || '', /Ask again/, said);
  }
});

test('the answer says in one line what happens next', () => {
  for (const [said, words] of [['email only', /every message is an email/i], ['the app', /note in the event app/i], ['linkedin', /LinkedIn message.*you send/i], ['both', /note in the event app.*LinkedIn message/i]]) {
    const r = answer(home(), 'reach_channels', said);
    assert.match(told(r), words, `${said}: ${told(r)}`);
  }
});

test('with "both" and a count of 3 the last message is still an email: the count is raised to fit, and the user is told', () => {
  const S = (reach, touches) => effectiveSettings({ reach, touches }, {});
  assert.deepEqual(chosenRoute(S(['app', 'linkedin'], 3)), ['email', 'app', 'linkedin', 'email']);
  assert.deepEqual(chosenRoute(S(['app', 'linkedin'], 5)), ['email', 'app', 'linkedin', 'email', 'email']);
  assert.deepEqual(chosenRoute(S(['app'], 3)), ['email', 'app', 'email']);
  assert.deepEqual(chosenRoute(S([], 3)), ['email', 'email', 'email']);
  const H = home(null, { setup_level: 'quick', sending_asked: true });
  answer(H, 'reach_channels', 'both');
  const r = answer(H, 'touches', '3');
  assert.match(told(r), /no room for both .* between the first and last email, so each person gets 4/, told(r));
  // The other way round: the count first, then the channels.
  const H2 = home(null, { setup_level: 'quick', sending_asked: true });
  answer(H2, 'touches', '3');
  assert.match(told(answer(H2, 'reach_channels', 'both')), /each person gets 4/);
});

test('the count question says what it counts once other channels are chosen', () => {
  const q = NODES.find((n) => n.id === 'touches');
  const s = { ev: { app_name: 'Grip', start_date: '2026-11-10' }, cfg: { reach: ['app'] }, ans: {} };
  assert.match(q.ask(s), /How many messages per person, first one included\?/);
});

test("with a gap for each follow-up, a message left after a channel is left out keeps its day", () => {
  // email, app (+3), linkedin (+4), email (+5): days 0, 3, 7, 12. Email only: the last email stays on day 12.
  const st = effectiveSettings({ route: ['email', 'app', 'linkedin', 'email'], followup_gap: [3, 4, 5], reach: [] }, {});
  assert.deepEqual(chosenRoute(st), ['email', 'email']);
  assert.deepEqual(st.followup_gap, [12]);
  const st2 = effectiveSettings({ route: ['email', 'app', 'linkedin', 'email'], followup_gap: [3, 4, 5], reach: ['linkedin'] }, {});
  assert.deepEqual(st2.followup_gap, [7, 5]);
});
