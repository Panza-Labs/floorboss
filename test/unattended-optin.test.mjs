// Turning unattended drafts on (the typed sentence, then the guard's prompt) and authorising a sequence's follow-ups
// (one prompt for all of them): each is written only by the guard's PostToolUse hook once its call ran after the user
// allowed it. A declined prompt, a call that never ran, another call's post, or a list that changed in between write
// nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { world, clone, bashCall, scriptCmd, hook, logOf, ledgerOf, ROOT, NOW } from './fixtures/unattended-world.mjs';
import { DRAFTS_SENTENCE, normSentence } from '../lib/unattended-drafts.mjs';

const BASE = world();
const fresh = () => {
  const H = clone(BASE);
  rmSync(join(H.HOME, 'unattended'), { recursive: true, force: true });
  H.now = NOW;
  return H;
};
const said = (H, words) => {
  const f = join(H.HOME, 'work', `said-${Math.random().toString(36).slice(2)}.txt`);
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  writeFileSync(f, words);
  return f;
};
const optin = (H) => join(H.HOME, 'unattended', 'optin', `${H.slug}.json`);
const authorised = (H) => join(H.HOME, 'unattended', 'authorised.jsonl');
const on = (H, words = DRAFTS_SENTENCE, o = {}) => bashCall(H, scriptCmd('connectors', 'unattended-on', '--event', H.slug, '--said-file', said(H, words)), o);

test('the sentence: typed as given (case, spaces, quotes and a full stop aside), and nothing else', () => {
  assert.equal(normSentence(`  "Put my approved follow-ups in my drafts without asking me."  `), DRAFTS_SENTENCE);
  assert.notEqual(normSentence('put my follow-ups in my drafts'), DRAFTS_SENTENCE);
  for (const words of ['yes', 'put my approved follow-ups in my drafts', 'send my approved follow-ups without asking me', `${DRAFTS_SENTENCE} and send them`]) {
    const H = fresh();
    const r = on(H, words);
    assert.equal(r.pre.code, 2, words);
    assert.match(r.pre.stderr, /aren't the sentence the user types/);
    assert.ok(!existsSync(optin(H)));
  }
});

test('the opt-in prompt names the event and its end; only the post hook writes it, once the call ran', () => {
  const H = fresh();
  const declined = on(H, DRAFTS_SENTENCE, { allowed: false });
  assert.equal(declined.pre.decision, 'ask');
  assert.match(declined.pre.reason, /"Test Expo" \(ev\), until Thu 12 Nov 2026, the event's last day/);
  assert.match(declined.pre.reason, /Allow only if you typed "put my approved follow-ups in my drafts without asking me" yourself, just now/);
  assert.ok(!existsSync(optin(H)), 'declined: nothing');
  // A post for another call, or with no proof the script ran, writes nothing.
  hook(H, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo x' }, session_id: 's-att', tool_use_id: 'other', tool_response: { stdout: `FLOORBOSS-OPTIN-OK:${H.slug}` } }, { args: ['post'] });
  assert.ok(!existsSync(optin(H)));
  const ran = on(H);
  assert.equal(ran.pre.decision, 'ask');
  assert.ok(existsSync(optin(H)));
  const o = JSON.parse(readFileSync(optin(H), 'utf8'));
  assert.deepEqual([o.event, o.mode, o.sentence, o.end_date], [H.slug, 'drafts', DRAFTS_SENTENCE, '2026-11-12']);
  assert.equal(o.expires, '2026-11-12T22:59:59.999Z', 'the end of the last day in Amsterdam');
  assert.ok(logOf(H).some((e) => e.type === 'optin_on'));
  // The script's own words name step 3, which is the user's, in their terminal.
  assert.match(ran.stdout, /install-followups/);
});

test('the opt-in is refused for the mock event, after the event, off macOS, and without the draft tool, the mailbox reader or the own address', () => {
  {
    const H = fresh();
    const r = bashCall(H, scriptCmd('connectors', 'unattended-on', '--event', H.slug, '--said-file', said(H, DRAFTS_SENTENCE)), { env: { FLOORBOSS_PLATFORM: 'linux' } });
    assert.equal(r.pre.code, 2);
    assert.match(r.pre.stderr, /macOS only for now\. Linux \(systemd timers\) and Windows \(Task Scheduler\) are planned/);
  }
  {
    const H = fresh();
    const r = on(H, DRAFTS_SENTENCE, { now: '2026-11-13T09:00:00Z' });
    assert.match(r.pre.stderr, /is over/);
  }
  for (const drop of ['stage_draft', 'email.messages', 'own_email']) {
    const H = fresh();
    const p = join(H.HOME, 'config.json');
    const c = JSON.parse(readFileSync(p, 'utf8'));
    if (drop === 'own_email') delete c.own_email;
    else delete c.connectors[drop];
    writeFileSync(p, JSON.stringify(c));
    const r = on(H);
    assert.equal(r.pre.code, 2, drop);
    assert.ok(!existsSync(optin(H)));
  }
  {
    const H = fresh();
    const ev = join(H.dir, 'event.json');
    writeFileSync(ev, JSON.stringify({ ...JSON.parse(readFileSync(ev, 'utf8')), mock: true }));
    assert.match(on(H).pre.stderr, /isn't a real event/);
  }
});

test('the authorisation: refused before the opt-in; one prompt for the whole sequence; only the post hook writes it', () => {
  const H = fresh();
  const before = bashCall(H, scriptCmd('event-outreach', 'authorise-unattended', '--event', H.slug));
  assert.equal(before.pre.code, 2);
  assert.match(before.pre.stderr, /turn unattended drafts on for it first/);
  on(H);
  const declined = bashCall(H, scriptCmd('event-outreach', 'authorise-unattended', '--event', H.slug), { allowed: false });
  assert.equal(declined.pre.decision, 'ask');
  assert.ok(!existsSync(authorised(H)), 'declined: nothing');
  // The list changed between the prompt and the call (a stop recorded): nothing is written, and the log says why.
  const id = 'tu-changed';
  const cmd = scriptCmd('event-outreach', 'authorise-unattended', '--event', H.slug);
  const pre = hook(H, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, session_id: 's-att', tool_use_id: id });
  assert.equal(pre.decision, 'ask');
  const hash = ledgerOf(H).filter((e) => e.type === 'approved' && e.touch === 3).pop().hash;
  appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: NOW, type: 'critic', who: 'floorboss', id: H.ana, touch: 3, hash, verdict: 'FAIL', reasons: ['x'] })}\n`);
  hook(H, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: cmd }, session_id: 's-att', tool_use_id: id, tool_response: { stdout: `FLOORBOSS-AUTHORISE-OK:${H.slug}` } }, { args: ['post'] });
  assert.ok(!existsSync(authorised(H)));
  assert.ok(logOf(H).some((e) => e.type === 'authorise_dropped'));
  // Asked again, allowed: written, for the follow-up the critic still passes.
  const ok = bashCall(H, scriptCmd('event-outreach', 'authorise-unattended', '--event', H.slug));
  assert.equal(ok.pre.decision, 'ask');
  assert.doesNotMatch(ok.pre.reason, /follow-up 2,/, 'a text the critic failed is never offered');
  const lines = readFileSync(authorised(H), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.touch), [2]);
  // Nothing new to authorise: no prompt at all.
  const again = bashCall(H, scriptCmd('event-outreach', 'authorise-unattended', '--event', H.slug));
  assert.equal(again.pre.code, 0);
  assert.equal(again.pre.decision, null);
});

test('turning on and authorising are never done inside an unattended run', async () => {
  const { ticket, start } = await import('./fixtures/unattended-world.mjs');
  const H = clone(BASE);
  const t = await ticket(H);
  start(H, t);
  for (const cmd of [scriptCmd('connectors', 'unattended-on', '--event', H.slug, '--said-file', said(H, DRAFTS_SENTENCE)), scriptCmd('event-outreach', 'authorise-unattended', '--event', H.slug)]) {
    const r = bashCall(H, cmd, { session: t.session, env: { FLOORBOSS_UNATTENDED: t.token } });
    assert.equal(r.pre.code, 2, cmd);
    assert.match(r.pre.stderr, /done with you there, never in an unattended run/);
  }
});
