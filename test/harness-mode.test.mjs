// The mode table (lib/harness.mjs): only Claude Code gets connected sending, CRM writes and browser notes; Codex and
// any harness floorboss doesn't recognise get hand-send, and nothing in a file or a setting can switch it on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { harness, connected, handSendView, handSendPatch, inventoryView, CODEX_MARKERS, HARNESSES } from '../lib/harness.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const bare = () => {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  for (const k of CODEX_MARKERS) delete env[k];
  return env;
};

test('mode table: Claude Code only with CLAUDECODE=1 and no Codex marker; everything else is hand-send', () => {
  assert.equal(harness(bare(), { ownProc: false }), 'unknown');
  assert.equal(connected(bare(), { ownProc: false }), false);
  assert.equal(harness({ ...bare(), CLAUDECODE: '1' }, { ownProc: false }), 'claude-code');
  assert.equal(connected({ ...bare(), CLAUDECODE: '1' }, { ownProc: false }), true);
  for (const k of CODEX_MARKERS) {
    assert.equal(harness({ ...bare(), [k]: 'x' }, { ownProc: false }), 'codex', k);
    // A Codex marker wins over CLAUDECODE=1 (Claude Code started from a Codex shell inherits both) ...
    assert.equal(connected({ ...bare(), CLAUDECODE: '1', [k]: 'x' }, { ownProc: false }), false, k);
    // ... and over floorboss's own processes.
    assert.equal(connected({ ...bare(), [k]: 'x' }, { ownProc: true }), false, k);
  }
  // Only the exact value counts; an empty marker is no marker.
  for (const v of ['true', 'yes', '0', ' 1', '']) assert.equal(connected({ ...bare(), CLAUDECODE: v }, { ownProc: false }), false, v);
  assert.equal(harness({ ...bare(), CLAUDECODE: '1', CODEX_SESSION_ID: '' }, { ownProc: false }), 'claude-code');
  // CODEX_HOME alone (a Claude Code user's shell profile) is not a Codex marker.
  assert.equal(harness({ ...bare(), CLAUDECODE: '1', CODEX_HOME: '/x' }, { ownProc: false }), 'claude-code');
  // floorboss's own processes (hooks, the scheduler) read as before with no marker.
  assert.equal(connected(bare(), { ownProc: true }), true);
  // Every harness but Claude Code is off in the table itself.
  assert.deepEqual(Object.entries(HARNESSES).filter(([, h]) => h.connected).map(([k]) => k), ['claude-code']);
});

test('the hand-send view empties connections and sending whatever the settings say', () => {
  const s = handSendView({
    connectors: { 'email.send': { server: 'gmail', tool: 'send' }, 'crm.task': { server: 'hubspot', tool: 'create_task' } },
    sending: { channels: ['email', 'linkedin', 'app', 'chat'], followups: 'scheduled', linkedin_ack: true },
    crm_log: 'browser',
    crm_create_contacts: 'yes',
    crm_fill_blanks: 'yes',
    inbox_read: { linkedin: true, app: true },
    log_replies: true,
    optout_sentence: 'Say so and I stop.'
  });
  assert.deepEqual(s.connectors, {});
  assert.deepEqual(s.sending.channels, []);
  assert.equal(s.sending.linkedin_ack, false);
  assert.equal(s.crm_log, 'csv');
  assert.equal(s.crm_create_contacts, 'no');
  assert.equal(s.crm_fill_blanks, 'no');
  assert.deepEqual(s.inbox_read, { linkedin: false, app: false });
  assert.equal(s.log_replies, false);
  assert.equal(s.optout_sentence, 'Say so and I stop.', 'what goes in a message is untouched');
  assert.equal(handSendView({ crm_log: 'tasks' }).crm_log, 'csv');
  assert.equal(handSendView({ crm_log: 'none' }).crm_log, 'none');
  // A save outside Claude Code leaves those keys out entirely, so Claude Code's own values stay in the file.
  const p = handSendPatch({ connectors: { x: 1 }, sending: { channels: ['email'], followups: 'scheduled' }, crm_log: 'browser', inbox_read: { linkedin: true }, goal: 'meet buyers' });
  assert.deepEqual(Object.keys(p), ['goal']);
  assert.equal(handSendPatch({ crm_log: 'csv' }).crm_log, 'csv');
});

test('inventoryView: outside Claude Code the scan shows nothing connected', () => {
  const inv = { items: [{ type: 'mcp', name: 'claude_ai_Gmail' }], found: { email: ['mcp:claude_ai_Gmail'], browser: ['mcp:chrome'] }, setup_servers: ['claude_ai_Gmail'] };
  assert.equal(inventoryView(inv, { ...bare(), CLAUDECODE: '1' }), inv);
  const v = inventoryView(inv, { ...bare(), CODEX_THREAD_ID: 't' });
  assert.deepEqual(v.items, []);
  assert.deepEqual(v.found, {});
  assert.deepEqual(v.setup_servers, []);
});

// A home with connections and sending saved (as a Claude Code setup would leave it), and an event whose own settings
// try to turn sending on too.
function setupHome() {
  const HOME = mkdtempSync(join(tmpdir(), 'fb-harness-'));
  mkdirSync(join(HOME, 'events', 'ev-one', 'work'), { recursive: true });
  mkdirSync(join(HOME, 'work'), { recursive: true });
  writeFileSync(
    join(HOME, 'config.json'),
    JSON.stringify({
      connectors: { 'email.send': { server: 'claude_ai_Gmail', tool: 'send_message', args: { to: '{to}' } } },
      sending: { channels: ['email'], followups: 'scheduled', linkedin_ack: false },
      crm_log: 'tasks'
    })
  );
  writeFileSync(
    join(HOME, 'events', 'ev-one', 'event.json'),
    JSON.stringify({ slug: 'ev-one', name: 'Ev One', city: 'Lisbon', time_zone: 'Europe/Lisbon', start_date: '2027-03-01', end_date: '2027-03-02', settings: { sending: { channels: ['email', 'linkedin'] }, connectors: { 'email.send': { server: 'x', tool: 'send' } } } })
  );
  return HOME;
}
const settingsIn = (HOME, env) =>
  JSON.parse(
    execFileSync('node', ['--input-type=module', '-e', `import { loadEvent } from ${JSON.stringify(join(ROOT, 'lib/event.mjs'))}; import { loadConfig } from ${JSON.stringify(join(ROOT, 'lib/config.mjs'))}; const s = loadEvent('ev-one').settings; const c = loadConfig(); console.log(JSON.stringify({ s: { connectors: s.connectors, sending: s.sending, crm_log: s.crm_log }, c: { connectors: c.connectors, sending: c.sending } }));`], {
      env: { ...env, FLOORBOSS_HOME: HOME },
      encoding: 'utf8'
    })
  );

test('a session script outside Claude Code reads no connection and no sending channel, from config.json or event.json', () => {
  const HOME = setupHome();
  for (const env of [bare(), { ...bare(), CODEX_SESSION_ID: 's1' }, { ...bare(), CLAUDECODE: '1', CODEX_THREAD_ID: 't1' }]) {
    const r = settingsIn(HOME, env);
    assert.deepEqual(r.s.connectors, {});
    assert.deepEqual(r.s.sending.channels, []);
    assert.equal(r.s.crm_log, 'csv');
    assert.deepEqual(r.c.connectors, {});
    assert.deepEqual(r.c.sending.channels, []);
  }
  // Claude Code reads what is saved, as before.
  const cc = settingsIn(HOME, { ...bare(), CLAUDECODE: '1' });
  assert.deepEqual(cc.s.sending.channels, ['email']);
  assert.ok(cc.s.connectors['email.send']);
  assert.equal(cc.s.crm_log, 'tasks');
});

test('outside Claude Code no connection can be saved, tested or forgotten, and the scan finds nothing', () => {
  const HOME = setupHome();
  const env = { ...bare(), CODEX_SESSION_ID: 's1', FLOORBOSS_HOME: HOME, FLOORBOSS_TEST: '1' };
  const run = (skill, ...args) => spawnSync('node', [join(ROOT, 'skills', skill, 'scripts/cli.mjs'), ...args], { env, encoding: 'utf8' });
  for (const args of [
    ['save-recipe', '--task', 'email.send', '--server', 'claude_ai_Gmail', '--tool', 'send_message'],
    ['test-allow', '--task', 'email.send', '--server', 'claude_ai_Gmail', '--tool', 'send_message', '--to', 'me@example.com'],
    ['forget', '--task', 'email.send'],
    ['unattended-on', '--event', 'ev-one']
  ]) {
    const r = run('connectors', ...args);
    assert.notEqual(r.status, 0, args[0]);
    assert.match(r.stderr + r.stdout, /only in Claude Code/, args[0]);
  }
  // Nothing was written: the saved file is as it was.
  assert.ok(JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8')).connectors['email.send']);
  // status reads every task as not connected.
  const st = JSON.parse(run('connectors', 'status').stdout);
  assert.ok(JSON.stringify(st).includes('not connected'));
  assert.ok(!JSON.stringify(st).includes('claude_ai_Gmail'));
  // The scan says nothing is connected, whatever is on the machine, and writes an empty inventory.
  const scanHome = join(HOME, 'scan-home');
  mkdirSync(join(scanHome, '.claude'), { recursive: true });
  writeFileSync(join(scanHome, '.claude.json'), JSON.stringify({ mcpServers: { gmail: { command: 'x' } } }));
  const sc = run('event-context', 'scan');
  assert.equal(sc.status, 0, sc.stderr);
  const out = JSON.parse(sc.stdout);
  assert.equal(out.hand_send, true);
  assert.deepEqual(out.found, {});
  assert.match(out.note, /Codex/);
  // Nothing is written: a Claude Code scan in the same data folder stays as it was.
  assert.ok(!existsSync(join(HOME, 'inventory.json')));
  writeFileSync(join(HOME, 'inventory.json'), JSON.stringify({ items: [{ type: 'mcp', name: 'gmail' }], found: { email: ['mcp:gmail'] } }));
  assert.equal(run('event-context', 'scan').status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(HOME, 'inventory.json'), 'utf8')).found, { email: ['mcp:gmail'] });
});

test('saveConfig outside Claude Code stores no connection or channel, and leaves Claude Code\'s own as they were', () => {
  const HOME = mkdtempSync(join(tmpdir(), 'fb-harness-save-'));
  const code = `import { saveConfig } from ${JSON.stringify(join(ROOT, 'lib/config.mjs'))}; saveConfig({ connectors: { 'email.send': { server: 's', tool: 't' } }, sending: { channels: ['email'], followups: 'scheduled' }, crm_log: 'browser', goal: 'buyers' });`;
  const save = (env) => execFileSync('node', ['--input-type=module', '-e', code], { env: { ...env, FLOORBOSS_HOME: HOME } });
  save({ ...bare(), CODEX_SESSION_ID: 's' });
  let saved = JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8'));
  assert.deepEqual(saved, { goal: 'buyers' });
  // A Claude Code setup saved email sending and browser logging; a later save in Codex changes neither.
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': { server: 'g', tool: 'send' } }, sending: { channels: ['email'], followups: 'scheduled' }, crm_log: 'browser' }));
  save({ ...bare(), CODEX_SESSION_ID: 's' });
  saved = JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8'));
  assert.deepEqual(saved.sending.channels, ['email']);
  assert.equal(saved.crm_log, 'browser');
  assert.ok(saved.connectors['email.send']);
  assert.equal(saved.goal, 'buyers');
});

test('the own-process mark is code in floorboss entry files only, never reachable from a setting or argument', () => {
  const entries = ['hooks/guard.mjs', 'hooks/remind.mjs', 'scripts/scheduled.mjs', 'scripts/unattended.mjs'];
  for (const f of entries) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    const firstImport = /^import [^\n]+$/m.exec(src)[0];
    assert.equal(firstImport, "import '../lib/own-process.mjs';", f);
  }
  // No other file imports it or calls ownProcess.
  const out = spawnSync('grep', ['-rlE', "own-process\\.mjs|ownProcess\\(", '--include=*.mjs', 'lib', 'skills', 'hooks', 'scripts', 'examples'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim().split('\n').sort();
  assert.deepEqual(out, ['hooks/guard.mjs', 'hooks/remind.mjs', 'lib/harness.mjs', 'lib/own-process.mjs', 'scripts/scheduled.mjs', 'scripts/unattended.mjs']);
  // harness.mjs reads no file and no setting: only the environment and the mark.
  const h = readFileSync(join(ROOT, 'lib/harness.mjs'), 'utf8');
  assert.ok(!/^import /m.test(h), 'lib/harness.mjs imports nothing');
});

test('outside Claude Code an answer that names email saves no sending channel, and no send setup is asked', () => {
  const HOME = mkdtempSync(join(tmpdir(), 'fb-harness-answers-'));
  // An earlier Claude Code setup on this machine chose email sending.
  writeFileSync(join(HOME, 'onboarding.json'), JSON.stringify({ rounds: {}, event: null, answers: { setup_level: 'full', sending_asked: true, sending_channels: ['email', 'linkedin'] } }));
  const code = `
    import { onboardingState } from ${JSON.stringify(join(ROOT, 'skills/event-context/scripts/onboarding-state.mjs'))};
    import { NODES } from ${JSON.stringify(join(ROOT, 'skills/event-context/scripts/onboarding-tree.mjs'))};
    const s = onboardingState();
    const on = NODES.filter((n) => ['linkedin_send', 'send_setup', 'inbox_read', 'crm_create_contacts', 'crm_fill_blanks', 'followups_mode'].includes(n.id) && n.when(s)).map((n) => n.id);
    console.log(JSON.stringify(on));`;
  const asked = (env) => JSON.parse(execFileSync('node', ['--input-type=module', '-e', code], { env: { ...env, FLOORBOSS_HOME: HOME }, encoding: 'utf8' }));
  assert.deepEqual(asked({ ...bare(), CODEX_SESSION_ID: 's' }), []);
  // In Claude Code the same answers still lead to send setup, as before.
  assert.ok(asked({ ...bare(), CLAUDECODE: '1' }).includes('send_setup'));
  // The saver keeps no channel outside Claude Code, whatever the user's words name.
  mkdirSync(join(HOME, 'work'), { recursive: true });
  const f = join(HOME, 'work', 'sending.txt');
  writeFileSync(f, 'ok, send them by email and linkedin');
  const r = spawnSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'answer', '--ask', 'sending', '--value-file', f], {
    env: { ...bare(), CODEX_SESSION_ID: 's', FLOORBOSS_HOME: HOME, FLOORBOSS_TEST: '1', FLOORBOSS_OUT_OF_TURN: '1' },
    encoding: 'utf8'
  });
  assert.equal(r.status, 0, r.stderr);
  const saved = JSON.parse(readFileSync(join(HOME, 'onboarding.json'), 'utf8')).answers.sending_channels;
  // Answers are kept as text: an empty list either way.
  assert.deepEqual(typeof saved === 'string' ? JSON.parse(saved) : saved, []);
});
