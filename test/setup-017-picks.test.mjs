// 0.1.7 setup, second review F2: each of the three follow-up answers at setup (onboarding-tree followups_mode, Claude
// Code with the claude.ai Gmail) leads to the final four-option choice, with the setup answer named there; nothing is
// sent from the session before that choice; with no address saved, the flow asks for it instead of going on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { makeHome, drive, simplePersona, ROOT } from './sims/lib/driver.mjs';
import { PICKS } from '../lib/autosend/pick.mjs';
import { seen, withSeen } from './fixtures/guard-seen.mjs';

const OWN = 'priya@tidewell.example';
const LIST = 'Name,Title,Company,Email\nMarta Okoye,VP Operations,Saltmarsh Foods,marta@saltmarsh.example\nRaj Patel,Director of Logistics,Northgate Freight,raj@northgate.example\n';
const recipe = (server, tool, args, extra = {}) => ({ server, tool, args, tool_hash: 'b'.repeat(64), reading: 'x', probe: { ok: true }, ...extra });
const RECIPES = {
  'email.history': recipe('claude_ai_Gmail', 'search_threads', { query: 'from:{email} OR to:{email}' }),
  'email.messages': recipe('claude_ai_Gmail', 'search_threads', { query: 'from:{email} in:anywhere' }),
  'email.send': recipe('claude_ai_Gmail', 'send_message', { to: '{to}', subject: '{subject}', body: '{body}' }, { reading: 'the id and threadId it returns', test_draft: { draft_id: 'm-test', user_confirmed: true } })
};
const GMAIL = ['search_threads', 'get_thread', 'list_drafts', 'create_draft', 'get_draft', 'list_labels', 'send_message'].map((n) => `mcp__claude_ai_Gmail__${n}`);

// Setup in Claude Code up to the final choice, answering the follow-up question with `answer`. Every step, in order.
function toFinal(answer, { own = OWN } = {}) {
  const H = makeHome({ context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' }, attendees: LIST });
  H.env = { ...H.env, CLAUDECODE: '1' };
  const saveRecipe = (task) => {
    const r = RECIPES[task];
    if (!r) return false;
    const f = join(H.HOME, 'config.json');
    const c = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
    c.connectors = { ...(c.connectors || {}), [task]: r };
    writeFileSync(f, JSON.stringify(c));
    return true;
  };
  let pendingSend = false;
  const persona = simplePersona({
    asks: {
      setup_level: 'standard', list_source: join(H.HOME, 'inputs', 'attendees.csv'), touches: '3', rate: 'skip',
      check_these: (s) => s.ask.people.map((p) => `${p.id} different-person all`).join('\n'),
      account_intake: 'emails', show_intake: 'file', tools: { crm: 'none', mailbox: true, calendar: false }, sending: 'email (your connected mailbox)',
      send_setup: (s) => (own && /test email/.test(s.ask?.question || '') ? ((pendingSend = true), { own_email: own, done: true }) : own ? own : { done: true }),
      followups_mode: answer
    },
    judge: {
      scan: () => ({ tools: GMAIL }),
      mail_history: () => ({ people: [] }),
      check_replies: (read) => ({ people: (read.people || read).map((p) => ({ id: p.id, messages: [] })) }),
      check_replies_one: (read) => ({ people: (read.people || read).map((p) => ({ id: p.id, messages: [] })) })
    }
  });
  persona.connect = (s) => {
    const ok = saveRecipe(s.task);
    if (ok && s.task === 'email.history') saveRecipe('email.messages');
    return ok ? { task: s.task, answer: 'try again' } : { task: s.task, answer: `no ${s.task} tool in this setup, don't use it` };
  };
  const steps = [];
  let stop = null;
  try {
    drive(H, persona, {
      maxSteps: 300,
      onStep: (s) => {
        if (pendingSend) {
          pendingSend = false;
          saveRecipe('email.send');
        }
        steps.push(s);
        // A state-changing auto-send call the step hands the model: the guard's record first, as the guard writes it
        // for the plain Bash form in Claude Code (since v017-record).
        if (Array.isArray(s.run) && /skills\/autosend\/scripts\/cli\.mjs$/.test(String(s.run[1]))) seen(H.HOME, s.run.slice(2));
        if (s.step === 'second_yes' || s.step === 'send_one' || (s.step === 'autosend_own' && !own)) {
          stop = s;
          throw new Error('stop');
        }
      }
    });
  } catch (e) {
    if (e.message !== 'stop') throw e;
  }
  return { H, seen: steps, stop };
}

for (const n of [1, 2, 3]) {
  test(`F2. setup answer ${n} leads to the final four-option choice, named there, with nothing sent before it`, { timeout: 600000 }, () => {
    const answer = [
      'Automatically, even with your laptop closed (recommended)',
      'In my Gmail drafts',
      "I'll send them myself"
    ][n - 1];
    const { H, seen, stop } = toFinal(answer);
    assert.ok(stop, `reached the end: ${seen.slice(-6).map((s) => s.step).join(' ')}`);
    assert.equal(stop.step, 'second_yes', seen.slice(-8).map((s) => s.step).join(' '));
    assert.ok(!seen.some((s) => s.step === 'send_one'), 'nothing sent from the session before the choice');
    // The choice itself, from the readback the step runs first.
    const rb = JSON.parse(execFileSync(stop.run_first[0], stop.run_first.slice(1), { env: H.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const q = rb.choice?.ask_user_question?.questions?.[0];
    const text = JSON.stringify(rb.choice);
    assert.ok(PICKS.every((p) => text.includes(p.label)), 'the four picks are offered');
    assert.match(text, new RegExp(`At setup you chose: ${PICKS[n - 1].label.replace(/[()]/g, '\\$&')}`), q?.question || text.slice(0, 400));
  });
}

test('F2. with no address saved, option 1 asks for the Gmail address instead of sending from the session', { timeout: 600000 }, () => {
  const { seen, stop } = toFinal('Automatically, even with your laptop closed (recommended)', { own: null });
  assert.ok(stop, seen.slice(-6).map((s) => s.step).join(' '));
  assert.notEqual(stop.step, 'send_one');
  assert.equal(stop.step, 'autosend_own', seen.slice(-6).map((s) => s.step).join(' '));
  assert.match(stop.ask.question, /Gmail address/);
});

// The user's final pick, as the guard's PostToolUse hook records an AskUserQuestion answer, then approve.
const runCli = (H, rel, args, input = null) => {
  const r = spawnSync('node', [join(ROOT, rel), ...args], { env: H.env, encoding: 'utf8', ...(input ? { input } : {}) });
  try { return JSON.parse(r.stdout); } catch { return { ERROR: String(r.stderr || r.stdout).slice(0, 800) }; }
};
function finalPick(H, n) {
  const rb = runCli(H, 'skills/autosend/scripts/cli.mjs', ['readback', '--event', 'test-expo']);
  assert.ok(!rb.ERROR, rb.ERROR);
  const q = rb.choice.ask_user_question;
  const input = JSON.stringify({ session_id: 'sess-pick', hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: q, tool_response: { questions: q.questions, answers: { [q.questions[0].question]: PICKS[n - 1].label } }, tool_use_id: `toolu_pick_${n}` });
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs'), 'post'], { input, env: H.env, encoding: 'utf8' });
  const ap = runCli(H, 'skills/autosend/scripts/cli.mjs', withSeen(H.HOME, ['approve', '--event', 'test-expo', '--digest', rb.digest]));
  assert.ok(!ap.ERROR, ap.ERROR);
  return rb;
}

test('N2. routine-status: nothing due after setup 3 and final pick 3; the update is due after 1 and 1', { timeout: 900000 }, () => {
  const a = toFinal("I'll send them myself");
  assert.equal(a.stop.step, 'second_yes');
  finalPick(a.H, 3);
  const s3 = runCli(a.H, 'skills/autosend/scripts/cli.mjs', ['routine-status']);
  assert.ok(!s3.ERROR, s3.ERROR);
  assert.equal(s3.show_update, undefined, JSON.stringify(s3).slice(0, 400));
  const b = toFinal('Automatically, even with your laptop closed (recommended)');
  finalPick(b.H, 1);
  const s1 = runCli(b.H, 'skills/autosend/scripts/cli.mjs', ['routine-status']);
  assert.match(s1.show_update || '', /needs an update/);
});

test('the setup step\'s `autosend on --setup-pick` with no guard record is refused and changes nothing', async () => {
  const { world, autosend, said, EVENT, SLUG, OWN } = await import('./fixtures/autosend-world.mjs');
  const w = world({ touches: 1, event: { ...EVENT, autosend: false } });
  const snap = () => readFileSync(join(w.evDir, 'event.json'), 'utf8') + readFileSync(join(w.evDir, 'ledger.jsonl'), 'utf8');
  const before = snap();
  const args = ['on', '--event', SLUG, '--said', "I'll send them myself", '--own', OWN, '--setup-pick', 'self'];
  const r = autosend(w.HOME, args, { claude: true });
  assert.ok(r.ERROR, JSON.stringify(r).slice(0, 300));
  assert.equal(snap(), before);
  // With the record the guard writes, the same call goes through.
  const ok = autosend(w.HOME, withSeen(w.HOME, args), { claude: true });
  assert.ok(!ok.ERROR, ok.ERROR);
  assert.match(readFileSync(join(w.evDir, 'event.json'), 'utf8'), /"autosend_setup_pick":\s*"self"/);
  void said;
});
