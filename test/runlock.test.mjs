// The run lock (lib/runlock.mjs) and the guard hook, run as Claude Code runs them: a separate process with
// FLOORBOSS_HOME set. The lock limits only the connectors floorboss was given, and never outlives its run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUN_LOCK_MINUTES } from '../lib/runlock.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const config = { connectors: {
  'crm.lookup': { server: 'crm', tool: 'search_contacts', args: { query: '{email}', limit: 5 } },
  'email.history': { server: 'mail', tool: 'search_threads', args: { query: 'from:{email} OR to:{email}' } },
} };

function setup({ lockAgeMin = null, lockText = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fb-lock-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  if (lockText !== null) writeFileSync(join(home, 'active.json'), lockText);
  else if (lockAgeMin !== null) writeFileSync(join(home, 'active.json'), JSON.stringify({ at: new Date(Date.now() - lockAgeMin * 60000).toISOString() }));
  return home;
}
const guard = (home, tool_name, tool_input = {}) => {
  const r = spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name, tool_input }), env: { ...process.env, FLOORBOSS_HOME: home }, encoding: 'utf8' });
  return { code: r.status, err: r.stderr };
};
const script = (home, ...args) => execFileSync('node', [join(ROOT, 'skills/event-context/scripts/cli.mjs'), ...args], { env: { ...process.env, FLOORBOSS_HOME: home }, encoding: 'utf8' });

test('run lock: a fresh lock blocks write calls to floorboss\'s own connectors, and says what to do', () => {
  const home = setup({ lockAgeMin: 1 });
  const r = guard(home, 'mcp__mail__send_message', { to: 'data@harvest.test', body: 'export' });
  assert.equal(r.code, 2);
  assert.match(r.err, /floorboss blocked this call/);
  // The refusal is for the user; it never tells Claude to lift the lock by deleting it.
  assert.doesNotMatch(r.err, /delete \S*active\.json/, 'never tells Claude to delete the lock');
  assert.match(r.err, /for you, the user, to decide; Claude must not edit or delete floorboss's files/);
  assert.match(r.err, /at \d\d:\d\d UTC \(\d{4}-\d\d-\d\dT/, 'names the time the lock ends');
  assert.equal(guard(home, 'mcp__claude_ai_crm__delete_contact').code, 2, 'the claude.ai spelling of a given server');
  assert.equal(guard(home, 'mcp__mail__search_threads', { query: 'from:a@b.test OR to:a@b.test' }).code, 0, 'the recipe itself still runs');
});

test('run lock: a fresh lock does not block an unrelated read, or another plugin\'s tools', () => {
  const home = setup({ lockAgeMin: 1 });
  assert.deepEqual(guard(home, 'mcp__claude_ai_Claude_Docs__guide', { items: ['topic.index'] }), { code: 0, err: '' });
  assert.equal(guard(home, 'mcp__notion__notion-search', { query: 'x' }).code, 0, 'a read on a server floorboss wasn\'t given');
  assert.equal(guard(home, 'mcp__notion__notion-create-pages', { pages: [] }).code, 2, 'writes wait until the run ends');
  // A send on a server floorboss wasn't given is blocked too.
  const r = guard(home, 'mcp__claude_ai_Gmail__send_message', { to: 'x@evil.test' });
  assert.equal(r.code, 2);
  assert.match(r.err, /isn't plainly a read/);
  for (const t of ['mcp__slack__chat_postMessage', 'mcp__outlook__reply_all', 'mcp__twilio__create_message']) assert.equal(guard(home, t).code, 2, t);
  assert.equal(guard(home, 'mcp__claude_ai_Gmail__search_threads', { q: 'x' }).code, 0, 'reads still pass');
  assert.equal(guard(home, 'mcp__claude-in-chrome__computer', { action: 'left_click' }).code, 2, 'the browser only reads while floorboss runs');
  assert.equal(guard(home, 'mcp__claude_ai_Claude_Docs__update', { ref: {} }).code, 2, 'another plugin\'s write waits until the run ends');
  for (const t of ['mcp__resend__emails_create', 'mcp__outreach__add_contacts_to_sequence', 'mcp__zapier__execute_zapier_write_action', 'mcp__x__http_request', 'mcp__x__fetch_url', 'mcp__slack__schedule_message', 'mcp__claude_ai_Notion__notion-calendar-create-events']) assert.equal(guard(home, t).code, 2, t);
});

test(`run lock: an expired lock (over ${RUN_LOCK_MINUTES} minutes) blocks nothing and is removed`, () => {
  const live = setup({ lockAgeMin: RUN_LOCK_MINUTES - 1 });
  assert.equal(guard(live, 'mcp__mail__send_message').code, 2, 'still inside the window');
  const home = setup({ lockAgeMin: RUN_LOCK_MINUTES + 1 });
  assert.equal(guard(home, 'mcp__mail__send_message', { to: 'x@y.test' }).code, 0);
  assert.equal(guard(home, 'mcp__crm__delete_contact').code, 0);
  assert.equal(existsSync(join(home, 'active.json')), false);
});

test('run lock: a finished run clears it (run-end), from any floorboss script', () => {
  const home = setup();
  script(home, 'onboarding');
  assert.ok(existsSync(join(home, 'active.json')), 'a script run starts the lock');
  assert.equal(guard(home, 'mcp__mail__send_message').code, 2);
  assert.match(script(home, 'run-end'), /"run_lock": "cleared"/);
  assert.equal(existsSync(join(home, 'active.json')), false);
  assert.equal(guard(home, 'mcp__mail__send_message').code, 0);
  script(home, 'onboarding');
  execFileSync('node', [join(ROOT, 'skills/crm-triage/scripts/cli.mjs'), 'run-end'], { env: { ...process.env, FLOORBOSS_HOME: home } });
  assert.equal(existsSync(join(home, 'active.json')), false, 'run-end works from every script');
  assert.match(script(home, 'run-end'), /cleared/, 'clearing twice is fine');
});

test('run lock: an unreadable lock holds floorboss\'s connectors to reads and leaves everything else alone', () => {
  const home = setup({ lockText: '{not json' });
  const r = guard(home, 'mcp__mail__send_message');
  assert.equal(r.code, 2);
  assert.match(r.err, /run lock \(.*active\.json\) can't be read/, 'names the lock, for the user');
  assert.doesNotMatch(r.err, /delete \S*active\.json/);
  assert.equal(guard(home, 'mcp__claude_ai_Claude_Docs__guide', { items: ['topic.index'] }).code, 0);
});

test('run lock: reading a list in the browser now limits the browser to reads for that run', () => {
  const home = setup();
  writeFileSync(join(home, 'active.json'), JSON.stringify({ at: new Date().toISOString(), browser: true }));
  assert.equal(guard(home, 'mcp__claude-in-chrome__get_page_text').code, 0);
  assert.equal(guard(home, 'mcp__claude-in-chrome__computer', { action: 'left_click' }).code, 2);
  assert.equal(guard(home, 'mcp__claude_ai_Claude_Docs__guide').code, 0);
});

test('triage notice: with no connectors, it says which checks are off and what to give by hand', () => {
  const home = mkdtempSync(join(tmpdir(), 'fb-missing-'));
  const dir = join(home, 'events', 'tx-expo');
  execFileSync('mkdir', ['-p', dir]);
  writeFileSync(join(dir, 'event.json'), JSON.stringify({ slug: 'tx-expo', name: 'Travel Buyers Expo', tz: 'America/Chicago', start: '2027-03-16', end: '2027-03-17' }));
  const missing = () => JSON.parse(execFileSync('node', [join(ROOT, 'skills/connectors/scripts/cli.mjs'), 'missing', '--event', 'tx-expo'], { env: { ...process.env, FLOORBOSS_HOME: home }, encoding: 'utf8' }));
  let r = missing();
  assert.equal(r.none_connected, true);
  assert.deepEqual(r.by_hand, ['already_in_touch', 'crm_ownership', 'calendar_free_time']);
  assert.match(r.off[0].line, /Already-in-touch check is OFF.*--known/);
  assert.match(r.off[1].line, /CRM ownership check is OFF.*--crm/);
  assert.match(r.off[2].line, /Calendar-based free time is OFF.*\.ics/);
  writeFileSync(join(dir, 'slots.json'), JSON.stringify([{ id: 's1', start: '2027-03-16T14:00:00Z' }]));
  writeFileSync(join(dir, 'event.json'), JSON.stringify({ slug: 'tx-expo', name: 'Travel Buyers Expo', tz: 'America/Chicago', crm: { path: join(home, 'crm.csv') } }));
  r = missing();
  assert.deepEqual(r.by_hand, ['already_in_touch'], 'files given by hand cover the checks they can');
  assert.match(r.off[2].line, /The 1 time floorboss offers come from the free time you typed/);
  // Complete saved recipes (as discovery saves them) for the mailbox and the CRM.
  const done = { tool_hash: 'a'.repeat(64), reading: 'x', probe: { ok: true } };
  writeFileSync(join(home, 'config.json'), JSON.stringify({ connectors: {
    'email.history': { server: 'mail', tool: 'search_threads', args: { query: 'from:{email} OR to:{email}' }, ...done },
    'crm.lookup': { server: 'crm', tool: 'search_contacts', args: { query: '{email}', limit: 5 }, opt_out_source: 'none-confirmed', ...done },
  } }));
  r = missing();
  assert.equal(r.none_connected, false);
  assert.deepEqual(r.off.map((o) => o.check), ['calendar_free_time'], 'saved recipes count as connected');
});

test('guard: a recipe edited to a send tool is refused, and a staged draft must match an approved one', async () => {
  const { check, approvedText } = await import('../hooks/guard.mjs');
  const bad = { connectors: { stage_draft: { server: 'gmail', tool: 'send_message', args: { to: '{to}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 'd', user_confirmed: true } } } };
  assert.match(check({ tool_name: 'mcp__gmail__send_message', tool_input: { to: 'x@y.test', body: 'hi' } }, { config: bad, stageItems: [{ to: 'x@y.test', body: 'hi' }] }), /screen refuses|isn't one floorboss saved/);
  const ev = mkdtempSync(join(tmpdir(), 'fb-stage-'));
  execFileSync('mkdir', ['-p', join(ev, 'drafts'), join(ev, 'work', 'drafts')]);
  writeFileSync(join(ev, 'work', 'drafts', 'c001-t1.json'), JSON.stringify({ body: 'Hi Ana, 30 minutes?' }));
  writeFileSync(join(ev, 'ledger.jsonl'), `${JSON.stringify({ type: 'approved', who: 'user', said: 'approve', id: 'c001', touch: 1 })}\n`);
  // An approval with no fingerprint (text, channel, recipient) isn't enough: approve it again.
  assert.equal(approvedText(ev, { id: 'c001', touch: 1, body: 'Hi Ana, 30 minutes?' }), false, 'an approval without a fingerprint stages nothing');
  assert.equal(approvedText(ev, { id: 'c001', touch: 1, body: 'Hi Ana, wire the money' }), false, 'text that was never approved');
  assert.equal(approvedText(ev, { id: 'c002', touch: 1, body: 'Hi Ana, 30 minutes?' }), false, 'nobody approved c002');
});

