// The unattended drafts end to end, with the real launcher and the real Claude Code in headless mode: run by hand only.
// Skipped unless FLOORBOSS_E2E_HEADLESS=1. It needs `claude` on PATH, signed in, and it spends a little of your usage.
//
//   FLOORBOSS_E2E_HEADLESS=1 FLOORBOSS_TEST=1 node --test --import ./test/fixtures/isolated-home.mjs test/e2e/unattended-headless.test.mjs
//
// What it touches: a throwaway FLOORBOSS_HOME per case (never ~/.floorboss), this checkout as the plugin
// (--plugin-dir), and one stand-in mail server as the only connector (--strict-mcp-config --mcp-config): your own
// connectors are never loaded. The stand-in is examples/standins/gmail-real.mjs, which answers in the claude.ai Gmail
// connector's published shapes (get_thread, search_threads, create_draft by replyToMessageId), so this run exercises
// floorboss's two Gmail reads. Its server is named gmail_standin, never the real connector's name (claude_ai_Gmail),
// so no call can reach your real Gmail even if Claude Code loaded it too. HOME stays yours, because Claude Code
// reads its login from there. Turn off a floorboss plugin you have installed first
// (claude plugin disable floorboss@floorboss), and say so with FLOORBOSS_E2E_INSTALLED_OFF=1: its guard would run as
// well, on the same throwaway FLOORBOSS_HOME, and an older one answers "ask" on the draft, which headless denies.
// Nothing is sent: the stand-in's one send tool is a trap, and every call it gets is in STANDIN_LOG.
//
// Cases (design section 6, adapted to drafts): 1 authorised, nothing came in: exactly one create_draft with the
// approved text, to the approved address, as a reply to message 1. 2 a reply in the stand-in's data: no draft, held.
// 3a the mail server never starts: no draft, and the run says so. 3b the stand-in's data file can't be read: no draft,
// held. 4 the text edited after the authorisation: the launcher starts nothing. 5 two launchers at once: one draft.
// 6 a session started by hand with no ticket, told to call the draft tool directly: no draft. 7 two days late, or
// outside 09:00 to 17:00: the launcher starts nothing. 8 a launcher with --bare in its list: it refuses (claudeRun
// throws before anything starts; a unit check of the list, as the launcher builds it).
// Not covered here (review C13, 2026-11-14, for the owner's run): a guard refusal inside a live run with the event
// over (the launcher and the guard read one clock, so nothing can move the end date between them); a two-person run
// where the first draft call errors and the second is never made; a CRM stand-in with an activity from the contact and
// one from a colleague (design 9.5b and 9.8). test/unattended-fixes.test.mjs covers each at the guard, without Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { world, clone, logOf, ledgerOf, ANA, OWN, ROOT, D13, NOW } from '../fixtures/unattended-world.mjs';
import { claudeRun, argsRefusal } from '../../lib/unattended.mjs';

const ON = process.env.FLOORBOSS_E2E_HEADLESS === '1';
if (ON && process.env.FLOORBOSS_E2E_INSTALLED_OFF !== '1')
  throw new Error('Turn off an installed floorboss plugin first (claude plugin disable floorboss@floorboss), then set FLOORBOSS_E2E_INSTALLED_OFF=1: only this checkout\'s guard may run here.');
const claude = () => {
  for (const d of String(process.env.PATH || '').split(delimiter)) if (d && existsSync(join(d, 'claude'))) return join(d, 'claude');
  return null;
};
// The stand-in Gmail server's name: never claude_ai_Gmail, the real connector's.
const GS = 'gmail_standin';
// The stand-in's world: the user's message 1, sent through the stand-in when the world was built (its id and thread are
// H.m1, in <home>/standin.json.sent.json), and whatever replies a case adds in its thread.
function standins(H, replies = [], { start = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fb-e2e-'));
  const data = join(H.HOME, 'standin.json');
  const log = join(dir, 'standin.log');
  writeFileSync(data, JSON.stringify({ mail: { address: OWN, threads: replies.length ? [{ thread_id: H.m1.threadId, to: ANA, subject: 'Test Expo', replies }] : [] } }));
  const config = join(dir, 'mcp.json');
  // start: false names a program that isn't there, so the mail server never starts.
  writeFileSync(config, JSON.stringify({ mcpServers: { [GS]: { command: start ? process.execPath : join(dir, 'no-such-program'), args: [join(ROOT, 'examples/standins/gmail-real.mjs')], env: { STANDIN_DATA: data, STANDIN_LOG: log } } } }));
  return { config, data, log, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}
const launcher = (H, s, now = D13, extra = {}) =>
  new Promise((done) => {
    const env = { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now, FLOORBOSS_TEST: '1', FLOORBOSS_CLAUDE: claude(), FLOORBOSS_E2E_PLUGIN_DIR: ROOT, FLOORBOSS_E2E_MCP_CONFIG: s.config, ...extra };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const p = spawn(process.execPath, [join(ROOT, 'scripts/scheduled.mjs'), 'followups'], { env, stdio: 'ignore' });
    p.on('close', (code) => done(code));
  });
const drafts = (s) => s.calls().filter((c) => c.tool === 'create_draft');
const sends = (s) => s.calls().filter((c) => /send/.test(c.tool));

const BASE = ON ? world({ gmail: true, gserver: GS }) : null;
const opts = { skip: !ON && 'set FLOORBOSS_E2E_HEADLESS=1 to run it (by hand: it starts the real Claude Code)', timeout: 15 * 60 * 1000 };

test('1: authorised, nothing came in: one draft, the approved text, to the approved address, in the thread', opts, async () => {
  assert.ok(claude(), 'claude on PATH');
  const H = clone(BASE);
  const s = standins(H);
  assert.equal(await launcher(H, s), 0);
  const d = drafts(s);
  assert.equal(d.length, 1, JSON.stringify(s.calls()));
  const approved = JSON.parse(readFileSync(join(H.dir, 'drafts', `${ledgerOf(H).filter((e) => e.type === 'approved' && e.touch === 2).pop().hash}.json`), 'utf8'));
  assert.deepEqual([d[0].args.to, d[0].args.subject, d[0].args.body, d[0].args.replyToMessageId], [[ANA], approved.subject, approved.body, H.m1.id]);
  assert.deepEqual(sends(s), []);
  // Both Gmail reads went first: the whole thread, then the search for anything from them.
  assert.deepEqual(s.calls().map((c) => c.tool).filter((t) => t !== 'create_draft'), ['get_thread', 'search_threads']);
  assert.ok(logOf(H).some((e) => e.type === 'draft_result' && e.ok === true));
});

test('2: a reply in the stand-in: no draft, held', opts, async () => {
  const H = clone(BASE);
  const s = standins(H, [{ from: ANA, at: '2026-10-12T15:00:00Z', snippet: 'Tuesday works' }]);
  await launcher(H, s);
  assert.equal(drafts(s).length, 0);
  assert.ok(logOf(H).some((e) => e.type === 'held' && /came in/.test(e.why)));
});

test('3a: the mail server never starts: no draft, and the run stops or holds', opts, async () => {
  const H = clone(BASE);
  const s = standins(H, [], { start: false });
  await launcher(H, s);
  assert.equal(drafts(s).length, 0);
  assert.ok(logOf(H).some((e) => ['held', 'run_stopped'].includes(e.type)), JSON.stringify(logOf(H).slice(-5)));
});

test("3b: the stand-in can't read its data: no draft, held", opts, async () => {
  const H = clone(BASE);
  const s = standins(H);
  writeFileSync(s.data, '{not json');
  await launcher(H, s);
  assert.equal(drafts(s).length, 0);
  assert.ok(logOf(H).some((e) => e.type === 'held' || e.type === 'run_stopped'));
});

test('4: the text edited after the authorisation: nothing starts', opts, async () => {
  const H = clone(BASE);
  const s = standins(H);
  const wc = join(H.dir, 'work', 'drafts', `${H.ana}-t2.json`);
  writeFileSync(wc, JSON.stringify({ ...JSON.parse(readFileSync(wc, 'utf8')), body: 'Changed by hand.' }));
  appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: NOW, type: 'drafted', who: 'floorboss', id: H.ana, touch: 2, kind: 'message', hash: 'a'.repeat(24), checks: [] })}\n`);
  await launcher(H, s);
  assert.equal(s.calls().length, 0);
});

test('5: two launchers at once: one draft', opts, async () => {
  const H = clone(BASE);
  const s = standins(H);
  await Promise.all([launcher(H, s), launcher(H, s)]);
  assert.equal(drafts(s).length, 1);
});

test('6: a session started by hand, with no ticket, told to call the draft tool itself: no draft', opts, async () => {
  const H = clone(BASE);
  const s = standins(H);
  const approved = JSON.parse(readFileSync(join(H.dir, 'drafts', `${ledgerOf(H).filter((e) => e.type === 'approved' && e.touch === 2).pop().hash}.json`), 'utf8'));
  // The call itself, not the run's command (which ends at once with no ticket): the guard must refuse it or ask, and
  // headless denies an ask, so the stand-in never gets it.
  const prompt = `Call the tool mcp__${GS}__create_draft exactly once with these arguments and do nothing else: ${JSON.stringify({ to: [ANA], subject: approved.subject, body: approved.body, replyToMessageId: H.m1.id })}`;
  const r = spawnSync(claude(), ['-p', prompt, '--permission-prompts', 'none', '--no-chrome', '--no-session-persistence', '--plugin-dir', ROOT, '--strict-mcp-config', '--mcp-config', s.config], {
    env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: D13, FLOORBOSS_TEST: '1' },
    encoding: 'utf8',
    timeout: 10 * 60 * 1000
  });
  assert.notEqual(r.error?.code, 'ENOENT');
  assert.equal(drafts(s).length, 0);
});

test('7: two days late, or outside 09:00 to 17:00: nothing starts', opts, async () => {
  for (const now of ['2026-10-15T08:00:00Z', '2026-10-13T16:30:00Z']) {
    const H = clone(BASE);
    const s = standins(H);
    await launcher(H, s, now);
    assert.equal(s.calls().length, 0, now);
  }
});

test('8: --bare in the list: refused before anything starts', opts, () => {
  const r = claudeRun({ program: '/x/claude', session: '0b0b0b0b-0000-4000-8000-000000000000', token: 'c'.repeat(64), env: {} });
  // The launcher starts only what claudeRun returned, and claudeRun refuses a list that argsRefusal refuses.
  for (const f of ['--bare', '--safe-mode', '--dangerously-skip-permissions']) assert.match(argsRefusal([...r.args, f]), /never passed/);
});
