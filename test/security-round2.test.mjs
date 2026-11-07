// Second security review: the CRM log window held to the send window's rules, case and new credential
// places in the key screen, event sites only from the user's own words, a guard that fails closed when it
// can't start, Grep over the home folder, the session backstop, the agenda's page policy, the send
// prompt's recipient, the drafter's instructions file and the live tool check's server match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, cpSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, ROOT, NOW, fakeHomeDir } from './fixtures/harness.mjs';
import { check, fileRefusal, logTyping, recipientShown } from '../hooks/guard.mjs';
import { crmPageAllowed } from '../lib/security.mjs';
import { sensitiveKind, notSensitive, realPath, home } from '../lib/paths.mjs';
import { append, validateEntry } from '../lib/ledger.mjs';
import { renderHtml } from '../skills/event-outreach/scripts/agenda.mjs';

// These tests save a drafter as the flow does while saving that answer (drafter and drafting_mode are answer-only).
process.env.FLOORBOSS_SAVED_BY = 'drafter';

const hook = (H, input, { now = NOW, env = {} } = {}) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify(input), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now, ...env }, encoding: 'utf8' });
const guard = (H, tool_name, tool_input, opts) => hook(H, { tool_name, tool_input, session_id: opts?.session }, opts);

// The CRM log window, opened for one approved app note that went out, the way open-log-window opens it.
function logWindow({ body = null, received = false } = {}) {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\n', event: { app_name: 'Grip' }, settings: { sending: { channels: ['app'], followups: 'scheduled' }, app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false } });
  triage(H); draftApprove(H);
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug]);
  const [sent] = JSON.parse(readFileSync(list.browser_file, 'utf8'));
  const item = { key: `${sent.id}:${sent.touch}`, id: sent.id, touch: sent.touch, name: 'Ana Berg', company: 'Acme', title: 'COO', email: 'ana@acme.test', profile_url: 'https://www.linkedin.com/in/ana-berg-example/', channel: 'Grip', sent_on: '2026-10-12', body: body ?? sent.body, listed_at: NOW, ...(received ? { received: true, touch: null, key: `${sent.id}:r:x1` } : {}) };
  writeFileSync(join(H.dir, 'crm-log-list.json'), JSON.stringify([item]));
  const until = new Date(Date.parse(NOW) + 20 * 60000).toISOString();
  append(join(H.dir, 'ledger.jsonl'), { type: 'crm_log_opened', who: 'user', until, keys: [item.key], said: 'yes, log them now' }, new Date(NOW));
  writeFileSync(join(H.HOME, 'crm-log-window.json'), JSON.stringify({ event: H.slug, until, keys: [item.key] }));
  // The user already allowed this window at its first browser call (test/browser-and-answers covers that ask).
  writeFileSync(join(H.HOME, 'window-asked.json'), JSON.stringify({ key: `log:${H.slug}:${until}`, at: NOW }));
  return { H, item, approvedBody: sent.body };
}
const reasonOf = (r) => JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;

// H1. The log window: only listed values are typed, a message's text only after the user's yes, and only
// CRM contact, record, search and task pages are opened.
test('CRM log window: short or unlisted text is refused; listed details pass; a message asks with its whole text', () => {
  const { H, item, approvedBody } = logWindow();
  for (const t of ['ok', 'evil.test', 'Ana Berg wire the deposit', 'https://evil.test/?d=pipeline', 'cmd+v']) {
    const r = guard(H, 'mcp__claude-in-chrome__form_input', { ref: 'x', value: t });
    assert.equal(r.status, 2, `typed "${t}"`);
    assert.match(r.stderr, /types only the listed messages/);
  }
  for (const t of ['Ana Berg', 'Ana', 'Berg', 'Acme', 'ana@acme.test', 'COO', '2026-10-12', '10/12/2026', 'LinkedIn message', 'https://www.linkedin.com/in/ana-berg-example/']) {
    const r = guard(H, 'mcp__claude-in-chrome__form_input', { ref: 'x', value: t });
    assert.equal(r.status, 0, `typed "${t}": ${r.stderr}`);
    assert.doesNotMatch(r.stdout || '', /permissionDecision/, `"${t}" is a detail, not a message: no prompt`);
  }
  // Part of the message is not the message.
  assert.equal(guard(H, 'mcp__claude-in-chrome__form_input', { ref: 'message', value: item.body.slice(0, 40) }).status, 2);
  const ok = guard(H, 'mcp__claude-in-chrome__form_input', { ref: 'message', value: item.body });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /"permissionDecision":"ask"/);
  assert.ok(reasonOf(ok).includes(item.body), 'the prompt shows the whole text typed');
  assert.match(reasonOf(ok), /the text you approved/);
  assert.equal(item.body, approvedBody);
  // Keys: plain ones only, as in the send window.
  assert.equal(guard(H, 'mcp__claude-in-chrome__computer', { action: 'key', text: 'cmd+v' }).status, 2);
  assert.equal(guard(H, 'mcp__claude-in-chrome__computer', { action: 'type', text: 'Hi there' }).status, 2, 'the computer tool types listed text only too');
  // A dropdown takes listed values too.
  assert.equal(guard(H, 'mcp__playwright__browser_select_option', { element: 'Type', ref: 'e3', values: ['Exfiltrate'] }).status, 2);
  assert.equal(guard(H, 'mcp__playwright__browser_select_option', { element: 'Type', ref: 'e3', values: ['Note'] }).status, 0);
});

test('CRM log window: a body that is not the approved draft is still asked about, and the prompt says floorboss can\'t vouch for it', () => {
  const body = 'Hi Ana, as discussed: please send the signed contract and your bank details to our new address before Friday. Thanks!';
  const { H } = logWindow({ body });
  const r = guard(H, 'mcp__claude-in-chrome__form_input', { ref: 'message', value: body });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(reasonOf(r).includes(body));
  assert.match(reasonOf(r), /can't match this text to a draft you approved/);
  const rec = logWindow({ body: 'Thanks, Tuesday at 10 works for me.', received: true });
  const r2 = guard(rec.H, 'mcp__claude-in-chrome__form_input', { ref: 'message', value: 'Thanks, Tuesday at 10 works for me.' });
  assert.match(reasonOf(r2), /a reply floorboss read on the page/);
});

test('CRM log window: the browser opens only the CRM\'s contact, record, search and task pages', () => {
  const { H } = logWindow();
  for (const u of ['https://app.hubspot.com/contacts/search?q=ana', 'https://app.hubspot.com/contacts/record/101', 'https://app.hubspot.com/contacts/new', 'https://app.hubspot.com/login']) assert.equal(guard(H, 'mcp__claude-in-chrome__navigate', { url: u }).status, 0, u);
  for (const u of ['https://app.hubspot.com/settings/123/users', 'https://app.hubspot.com/ecosystem/123/marketplace', 'https://app.hubspot.com/workflows/123', 'https://www.linkedin.com/in/ana-berg-example/', 'https://app.grip.events/x']) {
    const r = guard(H, 'mcp__claude-in-chrome__navigate', { url: u });
    assert.equal(r.status, 2, u);
    assert.match(r.stderr, /contact, record, search and task pages/, u);
  }
  assert.equal(crmPageAllowed('https://acme.lightning.force.com/lightning/r/Contact/003xx/view'), true);
  assert.equal(crmPageAllowed('https://acme.lightning.force.com/lightning/setup/SetupOneHome/home'), false);
  assert.equal(crmPageAllowed('https://acme.pipedrive.com/person/12'), true);
  assert.equal(crmPageAllowed('https://acme.pipedrive.com/settings/api'), false);
  assert.equal(crmPageAllowed('http://app.hubspot.com/contacts/1'), false, 'https only');
});

test('logTyping: every value is checked; a listed body is returned to ask about', () => {
  const items = [{ key: 'c001:1', id: 'c001', name: 'Ana Berg', company: 'Acme', body: 'Hello Ana, a long listed note.', sent_on: '2026-10-12', fill: { title: 'COO' } }];
  assert.match(logTyping(['Hello Ana, a long listed note.', 'x'], items).why || '', /isn't one of them/);
  assert.equal(logTyping(['hello ana,  a long listed note.'], items).bodies.length, 1, 'whitespace and case aside');
  assert.equal(logTyping(['COO', '12.10.2026'], items).bodies.length, 0);
});

// M1. Case: on a case-insensitive disk an upper-case spelling is the same file.
const SECRET_SAMPLES = ['.ssh/id_ed25519', '.aws/credentials', '.gnupg/pubring.kbx', '.gcloud/x', '.azure/x', '.kube/config', '.docker/config.json', '.netrc', '.npmrc', '.pypirc', '.git-credentials',
  '.pgpass', '.my.cnf', '.vault-token', '.s3cfg', '.boto', '.terraformrc', '.terraform.d/credentials.tfrc.json', '.cargo/credentials.toml', '.gem/credentials', '.m2/settings.xml', '.gradle/gradle.properties',
  '.password-store/x.gpg', '.local/share/keyrings/login.keyring', '.mozilla/firefox/x', '.claude.json', '.claude/.credentials.json', '.1password/x', '.op/config', '.oci/config', '.databrickscfg', '.dbt/profiles.yml',
  '.wrangler/config', '.netlify/config.json', '.vercel/auth.json', '.zsh_history', '.history', '.zsh_sessions/x', '.lesshst', '.viminfo', 'Library/Keychains/login.keychain-db', 'Library/Cookies/Cookies.binarycookies',
  'Library/Safari/History.db', 'Library/Containers/com.apple.Safari/x', 'Library/Mail/V10/x', 'Library/Messages/chat.db', 'Library/Application Support/Google/Chrome/Default/Login Data',
  'Library/Application Support/1Password/x', 'project/.env', 'project/.env.local', 'certs/server.pem', 'keys/id_rsa'];
// M4. Places cloud, deploy and developer tools keep tokens.
const NEW_SECRET = ['.config/gcloud/credentials.db', '.config/gcloud/application_default_credentials.json', '.config/gh/hosts.yml', 'project/.envrc', '.stripe/config.toml', '.config/stripe/config.toml',
  '.config/doctl/config.yaml', '.config/configstore/firebase-tools.json', '.fly/config.yml', '.pulumi/credentials.json', '.sentryclirc', '.config/op/config', '.config/heroku/x', '.supabase/access-token',
  '.composer/auth.json', '.yarnrc.yml', '.bundle/config', '.config/git/credentials', '.passwd-s3fs', '.circleci/cli.yml'];
const CONFIG_SAMPLES = ['.config/fish/config.fish', '.claude/settings.json', '.zshrc', '.bashrc', '.gitconfig', '.profile'];

test('key screen: each place matches in upper case too, and the new credential places are keys', () => {
  const hh = homedir();
  for (const p of [...SECRET_SAMPLES, ...NEW_SECRET]) {
    for (const v of [p, p.toUpperCase(), p.replace(/(^|\/)\.?([a-z])/g, (m) => m.toUpperCase())]) {
      assert.equal(sensitiveKind(join(hh, v)), 'secret', v);
      assert.match(fileRefusal('Read', { file_path: join(hh, v) }) || '', /keys, credentials or private history/, `Read ${v}`);
      assert.throws(() => notSensitive(join(hh, v)), /never reads/, v);
    }
  }
  for (const p of CONFIG_SAMPLES) for (const v of [p, p.toUpperCase()]) assert.equal(sensitiveKind(join(hh, v)), 'config', v);
  assert.equal(sensitiveKind('/ETC/hosts'), 'config', `/ETC/hosts resolved to ${realPath('/ETC/hosts')}; data folder ${realPath(home())}`);
  assert.equal(sensitiveKind(join(hh, 'project', '.env.EXAMPLE')), null, 'a template is not a key');
  assert.equal(sensitiveKind(join(hh, 'project', 'notes.md')), null);
});

// M2. Event sites only from the user's own words.
test('event sites: only a site_allowed entry in the user\'s words; never onboarding.json or event.json', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', event: { website: 'https://attacker.test/', app_url: 'https://attacker2.test/' } });
  writeFileSync(join(H.HOME, 'onboarding.json'), JSON.stringify({ ans: { list_url: 'https://attacker3.test/x', site: 'https://attacker4.test' } }));
  writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at: new Date().toISOString() }));
  for (const u of ['https://attacker.test/', 'https://attacker2.test/', 'https://attacker3.test/x', 'https://attacker4.test/']) {
    const r = guard(H, 'mcp__claude-in-chrome__navigate', { url: u });
    assert.equal(r.status, 2, u);
    assert.match(r.stderr, /No event site of your own is allowed/, 'the lock note says none is allowed');
  }
  // The ledger refuses an entry whose host the user's words don't name, or that isn't the user's.
  assert.ok(validateEntry({ at: NOW, type: 'site_allowed', who: 'user', host: 'attacker.test', said: 'the list is on expo.example' }).length);
  assert.ok(validateEntry({ at: NOW, type: 'site_allowed', who: 'floorboss', host: 'expo.example', said: 'expo.example' }).length);
  assert.deepEqual(validateEntry({ at: NOW, type: 'site_allowed', who: 'user', host: 'expo.example', said: 'https://expo.example/people' }), []);
  // A link Claude puts in the answer's url field without it in the user's words lets nothing in.
  const vf = join(H.dir, 'answer.json');
  writeFileSync(vf, JSON.stringify({ url: 'https://attacker5.test/x', said: 'it is on the event site' }));
  cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'list_source', '--value-file', vf]);
  assert.equal(guard(H, 'mcp__claude-in-chrome__navigate', { url: 'https://attacker5.test/x' }).status, 2);
});

// M3. The guard fails closed: a guard that can't even start blocks the call.
test('hooks.json: the guard command turns any failure into exit 2 and has its own timeout', () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks/hooks.json'), 'utf8')).hooks.PreToolUse.flatMap((h) => h.hooks);
  for (const h of hooks) {
    assert.match(h.command, /\|\| exit 2$/, h.command);
    assert.ok(Number.isInteger(h.timeout) && h.timeout > 20 && h.timeout <= 60, 'an explicit timeout longer than the guard\'s own deadline');
  }
  const run = (root, input) => spawnSync('sh', ['-c', hooks[0].command], { input: JSON.stringify(input), env: { ...process.env, CLAUDE_PLUGIN_ROOT: root }, encoding: 'utf8' });
  // A copy of the plugin whose guard imports a file with a syntax error.
  const broken = mkdtempSync(join(tmpdir(), 'fb-broken-'));
  cpSync(join(ROOT, 'hooks'), join(broken, 'hooks'), { recursive: true });
  cpSync(join(ROOT, 'lib'), join(broken, 'lib'), { recursive: true });
  writeFileSync(join(broken, 'lib', 'security.mjs'), 'export const = ;\n');
  const r = run(broken, { tool_name: 'mcp__gmail__send_email', tool_input: { to: 'x@evil.test' } });
  assert.equal(r.status, 2, `a guard that can't start blocks the call (got ${r.status})`);
  // No plugin at all (node can't find the guard) blocks too.
  assert.equal(run(join(broken, 'missing'), { tool_name: 'Read', tool_input: { file_path: '/x' } }).status, 2);
  // The real guard, run the same way: a refusal is 2, a pass is 0, and a prompt still reaches Claude Code.
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW };
  const real = (input) => spawnSync('sh', ['-c', hooks[0].command], { input: JSON.stringify(input), env, encoding: 'utf8' });
  assert.equal(real({ tool_name: 'Read', tool_input: { file_path: join(homedir(), '.ssh', 'id_rsa') } }).status, 2);
  assert.equal(real({ tool_name: 'Read', tool_input: { file_path: join(H.dir, 'event.json') } }).status, 0);
  const guardSrc = readFileSync(join(ROOT, 'hooks/guard.mjs'), 'utf8');
  assert.match(guardSrc, /GUARD_DEADLINE_MS = 20000/, 'the guard blocks on its own before the hook timeout');
});

// L1. Grep: the file filter is screened like Glob's pattern; printing lines over the home folder is refused.
test('Grep: a key-named file filter is refused; content over the home folder or ~/Library is refused, run or not', () => {
  const hh = homedir();
  for (const g of ['**/.ssh/*', '**/.aws/*', '*.pem', '**/.env', '**/id_rsa*', '**/.config/gh/*']) assert.match(fileRefusal('Grep', { pattern: 'x', glob: g, path: join(hh, 'project') }) || '', /looks for keys/, g);
  assert.match(fileRefusal('Grep', { pattern: 'token', path: hh, output_mode: 'content' }) || '', /prints matching lines/);
  assert.match(fileRefusal('Grep', { pattern: 'token', path: '/', output_mode: 'content' }) || '', /prints matching lines/);
  assert.match(fileRefusal('Grep', { pattern: 'token', path: join(hh, 'Library', 'Application Support'), output_mode: 'content' }) || '', /prints matching lines/);
  assert.equal(fileRefusal('Grep', { pattern: 'token', path: join(hh, 'project'), output_mode: 'content' }), null, 'a project folder is fine');
  assert.match(fileRefusal('Grep', { pattern: 'token', path: hh }) || '', /which files hold keys/, 'listing matching files over the home folder names the files that hold keys (round 3)');
  assert.equal(fileRefusal('Grep', { pattern: 'x', glob: '*.ts', path: join(hh, 'project') }), null);
});

// L2. The session backstop starts again on the session's file tool calls.
test('run lock: a guarded file tool call in the session that ran floorboss refreshes its stamp; README states the 12 hours', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const old = new Date(Date.now() - 11 * 3600000).toISOString();
  writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at: old, sessions: { 'sess-a': old, 'sess-b': old } }));
  assert.equal(guard(H, 'Read', { file_path: join(H.dir, 'event.json') }, { session: 'sess-a' }).status, 0);
  const lock = JSON.parse(readFileSync(join(H.HOME, 'active.json'), 'utf8'));
  assert.ok(Date.parse(lock.sessions['sess-a']) > Date.now() - 60000, 'sess-a starts again');
  assert.equal(lock.sessions['sess-b'], old, 'another session\'s stamp stays');
  assert.equal(lock.at, old, 'the run\'s own time stays');
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /12 hours/);
});

// L3. The agenda page loads nothing and runs nothing.
test('agenda.html carries a page policy like the outbox', () => {
  const html = renderHtml({ event: { name: 'Expo' }, meetings: [] }, new Map());
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none';[^"]*script-src 'none'[^"]*form-action 'none'">/);
});

// L4. The send prompt's recipient is the value in the recipe's {to} field.
test('send prompt: the recipient is taken from the {to} leaves only', () => {
  const recipe = { args: { message: { to: '{to}', subject: '{subject}', body: '{body}' } } };
  const args = { message: { to: 'ana@acme.test', subject: 'Re: ops', body: 'Write to me at boss@acme.test or +1 555 010 0199' } };
  assert.equal(recipientShown(args, recipe, 'fallback'), 'ana@acme.test');
  assert.equal(recipientShown({}, recipe, 'fallback'), 'fallback');
});

// L5. The drafter's instructions: never a key or a configuration file; Claude's agent folders are fine.
test('briefs: the instructions file is read from an agent folder, never from configuration', () => {
  const run = (p) => {
    const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, '---\nname: sdr-agent\n---\nAlways open with a question about dock queues.');
    // A file that isn't an agent or skill file is refused when it's set (drafter.mjs instructionsPath).
    if (cli(H, 'event-context', ['config', '--set', JSON.stringify({ drafting_mode: 'delegate', drafter: { invoke: 'sdr-agent', type: 'instructions', path: p } })]).ERROR) return '';
    triage(H);
    cli(H, 'event-outreach', ['todo', '--event', H.slug]);
    const b = cli(H, 'event-outreach', ['briefs', '--event', H.slug]);
    return readFileSync(b.by_drafter[0].brief_file, 'utf8');
  };
  // Written only into the temp home the test preload set up, never a real ~/.claude.
  const fake = fakeHomeDir();
  assert.match(run(join(fake, '.claude', 'agents', 'sdr-agent.md')), /dock queues/);
  assert.doesNotMatch(run(join(fake, '.config', 'sometool', 'sdr-agent.md')), /dock queues/, 'configuration is never quoted into a brief');
});

// L6. The live tool check: a tool on a server whose name only ends in the recipe's is not the recipe's.
test('connectors check: the server matches by its whole name', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'crm.lookup': { server: 'gmail', tool: 'search_contacts', args: { query: '{email}' }, tool_hash: 'a'.repeat(64) } } }));
  const f = join(H.dir, 'live.json');
  writeFileSync(f, JSON.stringify([{ name: 'mcp__evilgmail__search_contacts', description: 'x', inputSchema: {} }]));
  assert.match(cli(H, 'connectors', ['check', '--tools-file', f])[0].result, /^missing/);
  writeFileSync(f, JSON.stringify([{ name: 'mcp__claude_ai_Gmail__search_contacts', description: 'x', inputSchema: {} }]));
  assert.match(cli(H, 'connectors', ['check', '--tools-file', f])[0].result, /^changed/, 'the claude.ai spelling of the same server is the same server');
});

// check() itself, for the log window's page rule outside the hook.
test('check: inside the log window, a non-CRM page is refused even with no run under way', () => {
  const r = check({ tool_name: 'mcp__claude-in-chrome__navigate', tool_input: { url: 'https://app.hubspot.com/settings/1' } }, { config: {}, active: false, crmLog: { event: 'x' } });
  assert.match(r || '', /contact, record, search and task pages/);
  assert.equal(check({ tool_name: 'mcp__claude-in-chrome__navigate', tool_input: { url: 'https://app.hubspot.com/contacts/1/record/0-1/2' } }, { config: {}, active: false, crmLog: { event: 'x' } }), null);
});
