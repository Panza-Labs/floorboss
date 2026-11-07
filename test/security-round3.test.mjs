// Third security review: the event's own site let in only from the question that asks for it, and every page
// there but the list asks first; prompts before a CRM task, a staged batch and the first paid lookup; list
// files only of list kinds; do-not-contact matches that stick; the guard's name screen against brace and
// wildcard spellings; the test draft to the user's own address; the outbox's CSV; floorboss commands with
// command substitution; and subagent calls held to the run's limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, appendFileSync, existsSync, mkdirSync, truncateSync } from 'node:fs';
import { listFileProblem } from '../lib/security.mjs';
import { check, holdHistory, fileRefusal, globForms, globSeeksSecrets } from '../hooks/guard.mjs';
import { homedir } from 'node:os';
import { renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, atListSource, ROOT, NOW } from './fixtures/harness.mjs';
import { cli as simCli } from './sims/lib/driver.mjs';
const PEOPLE = [{ id: 'c001', name: 'Ana Berg', company: 'Acme' }, { id: 'c002', name: 'Bo Li', company: 'Globex' }, { id: 'c003', name: 'Cy Park', company: 'Initech' }];

const hook = (H, input, { now = NOW, env = {} } = {}) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify(input), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now, ...env }, encoding: 'utf8' });
const guard = (H, tool_name, tool_input, opts) => hook(H, { tool_name, tool_input, session_id: opts?.session }, opts);
// The PostToolUse hook after a call ran (round 4: an ask is recorded only once the call went through).
const post = (H, tool_name, tool_input, { now = NOW } = {}) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs'), 'post'], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response: {}, session_id: 's1' }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
const asks = (r) => /"permissionDecision":"ask"/.test(r.stdout || '');
const reasonOf = (r) => JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
const lock = (H) => writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at: new Date().toISOString() }));
const ledgerOf = (H) => readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// 1. The event's own site: saved only while list_source is the question, and only the list page opens unasked.
test('list_source: an answer given when the flow isn\'t asking it is refused and lets no site in', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const f = join(H.dir, 'ls.json');
  writeFileSync(f, JSON.stringify({ url: 'https://expo.example/people', said: 'the list is at https://expo.example/people' }));
  const r = cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'list_source', '--value-file', f]);
  assert.match(r.ERROR || '', /isn't asking where the attendee list is/);
  assert.ok(!existsSync(join(H.dir, 'ledger.jsonl')) || !readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').includes('site_allowed'), 'no site_allowed entry');
  lock(H);
  assert.equal(guard(H, 'mcp__claude-in-chrome__navigate', { url: 'https://expo.example/people' }).status, 2);
});

test('list_source: asked at its moment, the link is saved with its page; the page opens unasked, any other page there asks', { timeout: 120000 }, () => {
  const H = atListSource();
  const f = join(H.dir, 'ls.json');
  writeFileSync(f, JSON.stringify('the attendees are at https://www.expo.example/attendees?ref=mail#top'));
  const r = simCli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'list_source', '--value-file', f]);
  assert.ok(!r.ERROR, r.ERROR);
  const e = ledgerOf(H).find((x) => x.type === 'site_allowed');
  assert.equal(e.host, 'expo.example');
  assert.equal(e.url, 'https://www.expo.example/attendees', 'scheme, host and path: no query or fragment');
  lock(H);
  for (const u of ['https://www.expo.example/attendees', 'https://www.expo.example/attendees/']) {
    const ok = guard(H, 'mcp__claude-in-chrome__navigate', { url: u });
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(!asks(ok), `${u} is the list page`);
  }
  for (const u of ['https://www.expo.example/attendees?page=2', 'https://expo.example/attendees', 'https://www.expo.example/redirect?to=https://evil.test/x', 'http://www.expo.example/attendees']) {
    const a = guard(H, 'mcp__claude-in-chrome__navigate', { url: u });
    assert.equal(a.status, 0, a.stderr);
    assert.ok(asks(a), `${u} asks first`);
    assert.ok(reasonOf(a).includes(new URL(u).href), 'the prompt shows the whole address');
  }
  // LinkedIn and the known event apps are unchanged: no prompt.
  assert.ok(!asks(guard(H, 'mcp__claude-in-chrome__navigate', { url: 'https://www.linkedin.com/in/ana-berg-example/' })));
  assert.equal(guard(H, 'mcp__claude-in-chrome__navigate', { url: 'https://evil.test/x' }).status, 2);
  // The question is answered: a second answer is refused.
  writeFileSync(f, JSON.stringify('no wait, it is at https://evil.test/list'));
  assert.match(simCli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'list_source', '--value-file', f]).ERROR || '', /isn't asking/);
  assert.ok(!ledgerOf(H).some((x) => x.type === 'site_allowed' && x.host === 'evil.test'));
  assert.match(readFileSync(join(ROOT, 'README.md'), 'utf8'), /asks you before opening any other page of the event's own site/);
});

// 2. A CRM task and a staged batch ask first.
const STAGE = { server: 'gmail', tool: 'create_draft', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'd'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
test('crm.create_task: the prompt shows the title, the whole body, the contact and the due date', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\n', event: { app_name: 'Brella' } });
  triage(H); draftApprove(H);
  const tl = cli(H, 'event-outreach', ['task-list', '--event', H.slug]);
  const [it] = JSON.parse(readFileSync(tl.file, 'utf8'));
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'crm.create_task': { server: 'crm-a', tool: 'create_task', reading: 'the id it returns', tool_hash: 'f'.repeat(64), test_draft: { draft_id: 't-test', user_confirmed: true }, args: { properties: { hs_task_subject: '{title}', hs_task_body: '{body}', hs_timestamp: '{due}' }, associations: [{ to: { id: '{contact_ref}' } }] } } } }));
  const r = guard(H, 'mcp__crm-a__create_task', { properties: { hs_task_subject: it.title, hs_task_body: it.body, hs_timestamp: it.due }, associations: [{ to: { id: it.contact_ref || '' } }] });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(asks(r), 'a task asks first');
  const why = reasonOf(r);
  for (const part of [it.title, it.body, `Due: ${it.due}`, 'Contact:']) assert.ok(why.includes(part), part);
});

test('stage_draft: the first draft of a batch asks with everyone in it; once it went in, the rest of that batch goes in; a new list asks again', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n' });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { stage_draft: STAGE } }));
  triage(H); draftApprove(H);
  const sl = cli(H, 'event-outreach', ['stage-list', '--event', H.slug]);
  const items = JSON.parse(readFileSync(sl.file, 'utf8'));
  assert.equal(items.length, 2);
  const call = (it, now = NOW) => guard(H, 'mcp__gmail__create_draft', { to: it.to, subject: it.subject, body: it.body }, { now, session: 's1' });
  const first = call(items[0]);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(asks(first));
  assert.match(reasonOf(first), /put 2 approved drafts/);
  for (const it of items) assert.ok(reasonOf(first).includes(it.to), it.to);
  post(H, 'mcp__gmail__create_draft', { to: items[0].to, subject: items[0].subject, body: items[0].body });
  const second = call(items[1]);
  assert.equal(second.status, 0, second.stderr);
  assert.ok(!asks(second), 'the rest of the batch goes in without asking');
  // A new list is a new batch.
  const later = new Date(Date.parse(NOW) + 60e3).toISOString();
  cli(H, 'event-outreach', ['stage-list', '--event', H.slug], later);
  const again = JSON.parse(readFileSync(sl.file, 'utf8'));
  assert.ok(asks(call(again.find((x) => x.to === items[1].to), later)), 'a new stage-list asks again');
  // The marker is a record: Claude's Write can't fake it.
  assert.equal(guard(H, 'Write', { file_path: join(H.dir, 'stage-asked.json'), content: '{}' }).status, 2);
  assert.match(readFileSync(join(ROOT, 'README.md'), 'utf8'), /CRM task/);
  assert.match(readFileSync(join(ROOT, 'SECURITY.md'), 'utf8'), /CRM task/);
});

// 3. A list file is a list: its kind, its place and its size.
test('crm-triage inputs and load flags: only list files, never in .git, node_modules or a key place, at most 50 MB', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const put = (rel, text = 'Email\nx@y.test\n') => { const p = join(H.HOME, 'proj', rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); return p; };
  const refused = [put('app/server.js'), put('.git/config.txt'), put('node_modules/pkg/list.csv'), put('deploy/.aws/creds.csv'), put('keys/id_rsa.txt'), put('notes.key')];
  for (const p of refused) {
    for (const args of [['inputs', '--event', H.slug, '--kind', 'dnc', '--file', p], ['load', '--event', H.slug, '--dnc', p], ['load', '--event', H.slug, '--crm', p], ['load', '--event', H.slug, '--known', p]]) {
      assert.ok(cli(H, 'crm-triage', args).ERROR, `${args[0]} ${args[3]} ${p}`);
    }
  }
  const big = put('huge.csv', '');
  truncateSync(big, 50 * 1024 * 1024 + 1);
  assert.match(cli(H, 'crm-triage', ['inputs', '--event', H.slug, '--kind', 'dnc', '--file', big]).ERROR || '', /over 50 MB/);
  for (const ok of ['dnc.csv', 'dnc.txt']) assert.ok(!cli(H, 'crm-triage', ['inputs', '--event', H.slug, '--kind', 'dnc', '--file', put(ok)]).ERROR, ok);
  assert.equal(listFileProblem('/x/a.CSV', 10), null, 'the extension in any case');
  assert.match(readFileSync(join(ROOT, 'README.md'), 'utf8'), /any list-shaped file in your project folder\s+can be read this way/);
});

// 5. A do-not-contact match sticks; only the user's own decide releases it, and the prompt says so.
const groupOf = (H, id) => JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'))[id];
test('do-not-contact: re-importing the list without someone keeps them held until the user releases them', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n' });
  const put = (name, text) => { const p = join(H.dir, 'work', name); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); return p; };
  assert.ok(!cli(H, 'crm-triage', ['inputs', '--event', H.slug, '--kind', 'dnc', '--file', put('dnc1.txt', 'ana@acme.test\n')]).ERROR);
  triage(H);
  const ana = Object.entries(JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'))).find(([, r]) => /do-not-contact/.test(r.says))[0];
  assert.equal(groupOf(H, ana).group, 'skip');
  assert.ok(ledgerOf(H).some((e) => e.type === 'hold_seen' && e.id === ana && e.rung === 'do_not_contact'), 'the match is written down');
  // The list again, without her: she stays held, and the card says why.
  assert.ok(!cli(H, 'crm-triage', ['inputs', '--event', H.slug, '--kind', 'dnc', '--file', put('dnc2.txt', 'nobody@else.test\n')]).ERROR);
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.equal(groupOf(H, ana).group, 'skip');
  assert.match(groupOf(H, ana).says, /no longer in the file, still held until you release them/);
  // The gate's rescue still refuses a hard hold; the user's own decide releases her.
  assert.match(cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', `rescue ${ana}`]).ERROR || '', /held because/);
  assert.ok(!cli(H, 'crm-triage', ['decide', '--event', H.slug, '--id', ana, '--group', 'reach', '--because', 'she asked us to write after all']).ERROR);
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.equal(groupOf(H, ana).group, 'reach');
  // Two imports in a row with no load between: the first list's match was written before it was replaced.
  const H2 = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const put2 = (name, text) => { const p = join(H2.dir, name); writeFileSync(p, text); return p; };
  cli(H2, 'crm-triage', ['inputs', '--event', H2.slug, '--kind', 'dnc', '--file', put2('a.txt', 'ana@acme.test\n')]);
  cli(H2, 'crm-triage', ['inputs', '--event', H2.slug, '--kind', 'dnc', '--file', put2('b.txt', 'x@y.test\n')]);
  triage(H2);
  assert.equal(Object.values(JSON.parse(readFileSync(join(H2.dir, 'derived', 'resolved.json'), 'utf8')))[0].group, 'skip');
});

test('stage prompt: a person once held and since cleared says what matched, when, and what cleared it', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { stage_draft: STAGE } }));
  const p = join(H.dir, 'dnc1.txt');
  writeFileSync(p, 'ana@acme.test\n');
  cli(H, 'crm-triage', ['inputs', '--event', H.slug, '--kind', 'dnc', '--file', p]);
  triage(H);
  cli(H, 'crm-triage', ['decide', '--event', H.slug, '--id', 'c001', '--group', 'reach', '--because', 'she asked us to write after all']);
  triage(H); draftApprove(H);
  const sl = cli(H, 'event-outreach', ['stage-list', '--event', H.slug]);
  const [it] = JSON.parse(readFileSync(sl.file, 'utf8'));
  const r = guard(H, 'mcp__gmail__create_draft', { to: it.to, subject: it.subject, body: it.body });
  assert.equal(r.status, 0, r.stderr);
  assert.match(reasonOf(r), /Held before:\n"Ana Berg" \(c\d+\) matched "on your do-not-contact list[^"]*" at 2026-10-12T08:00:00\.000Z, cleared by your decide reach at 2026-10-12T08:00:00\.000Z\./);
  assert.deepEqual(holdHistory([], 'c001'), []);
});

test('Write in an event folder: only attendees.csv at its top level; never dnc.txt, crm.csv or accounts.csv', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const w = (rel) => guard(H, 'Write', { file_path: join(H.dir, rel), content: 'x' }).status;
  for (const rel of ['dnc.txt', 'crm.csv', 'accounts.csv', 'notes.txt', 'stage-asked.json']) assert.equal(w(rel), 2, rel);
  for (const rel of ['attendees.csv', 'work/fits.json', 'work/list-from-page.csv']) assert.equal(w(rel), 0, rel);
  assert.equal(guard(H, 'Write', { file_path: join(H.HOME, 'work', 'answers', 'gate.txt'), content: 'ok' }).status, 0);
});

// 6. Brace, "?" and "[…]" spellings of a key search; file names over the home folder.
test('Glob and Grep: braces, ? and [...] can\'t spell a search for keys past the screen; listing files over home is refused', () => {
  const hh = homedir();
  const refusedGlobs = [`${hh}/.s{s,}h/*`, '~/.s{s,x}h/id_rsa', '**/.s?h/*', '**/.[s]sh/*', '~/.a{w,}s/cred*', '~/**/credentials*', '**/id_{rsa,ed25519}', '**/.{e,}nv', '**/*_hist{ory,}', '~/Library/Key{chains,}/*', '**/.git-cred*', `${hh}/.n?trc`];
  for (const g of refusedGlobs) assert.match(fileRefusal('Glob', { pattern: g }) || '', /keys, credentials|looks for keys/, g);
  for (const g of refusedGlobs.filter((x) => !x.startsWith('/') && !x.startsWith('~'))) assert.match(fileRefusal('Grep', { pattern: 'x', glob: g, path: join(hh, 'project') }) || '', /looks for keys/, `Grep glob ${g}`);
  for (const g of ['**/*', '**/*.{ts,tsx}', 'src/**/*.mjs', '**/README.md', '**/config/*.json', `${hh}/project/**/*.csv`]) assert.equal(fileRefusal('Glob', { pattern: g }), null, g);
  assert.deepEqual(globForms('a{b,c}d?[xy]'), ['abd**', 'acd**']);
  assert.ok(globSeeksSecrets('~/**/credentials*'));
  // files_with_matches (the default) and count over home or ~/Library: refused like content.
  for (const mode of [undefined, 'files_with_matches', 'count', 'content']) {
    assert.match(fileRefusal('Grep', { pattern: 'AKIA', path: hh, ...(mode ? { output_mode: mode } : {}) }) || '', /keys and credentials/, String(mode));
    assert.match(fileRefusal('Grep', { pattern: 'AKIA', path: join(hh, 'Library'), ...(mode ? { output_mode: mode } : {}) }) || '', /keys and credentials/, `Library ${mode}`);
    assert.equal(fileRefusal('Grep', { pattern: 'AKIA', path: join(hh, 'project'), ...(mode ? { output_mode: mode } : {}) }), null, `project ${mode}`);
  }
});

// 7. The test draft goes only to the user's own address, as the test send does.
test('connectors test-allow: a test draft needs the address saved as own_email', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const allow = (to) => cli(H, 'connectors', ['test-allow', '--task', 'stage_draft', '--server', 'gmail', '--tool', 'create_draft', '--to', to]);
  assert.match(allow('victim@else.test').ERROR || '', /only to the user's own address/, 'no own_email saved');
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ own_email: 'me@own.test' }));
  assert.match(allow('victim@else.test').ERROR || '', /only to the user's own address/);
  assert.ok(!allow('Me@Own.test').ERROR, 'the user\'s own address, in any case');
  assert.equal(JSON.parse(readFileSync(join(H.HOME, 'test-pending.json'), 'utf8')).to, 'me@own.test');
});

// 8. The outbox's CRM log CSV keeps formula-looking cells as text, as lib/csv.mjs does.
test('outbox: "Copy CRM log (CSV)" prefixes a quote on cells starting with = + - @ or a tab', () => {
  const html = renderOutbox({ event: { name: 'Test Expo', no_app: true }, counts: {}, slots: [], cards: [] });
  const src = /var esc = (function\(v\)\{.*?\});/.exec(html);
  assert.ok(src, 'the CSV builder is in the page');
  const esc = new Function(`return ${src[1]}`)();
  assert.equal(esc('=HYPERLINK("https://evil.test","x")'), '"\'=HYPERLINK(""https://evil.test"",""x"")"');
  for (const v of ['+1 555', '-2+3', '@SUM(A1)', '\tx']) assert.equal(esc(v)[0] === '"' ? esc(v)[1] : esc(v)[0], "'", v);
  assert.equal(esc('Ana Berg'), 'Ana Berg');
  assert.equal(esc('a,b'), '"a,b"');
});

// 9. A floorboss script never runs with a substitution or a redirect the shell works out first.
test('Bash: a floorboss script with $(…), backticks, <(…), >(…) or an output redirect is refused; anything else passes', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const flow = `node "${ROOT}skills/flow/scripts/cli.mjs"`;
  const bash = (command) => guard(H, 'Bash', { command });
  const refused = [
    [`${flow} next --event $(cat ~/.ssh/id_rsa)`, /command substitution/],
    [`${flow} next --event "$(cat ~/.ssh/id_rsa)"`, /command substitution/],
    [`${flow} next --event \`cat ~/.aws/credentials\``, /backtick/],
    [`node "\${CLAUDE_PLUGIN_ROOT}/skills/flow/scripts/cli.mjs" answer --ask x --value-file <(cat ~/.netrc)`, /process substitution/],
    [`${flow} next > /tmp/out.json`, /output redirect/],
    [`${flow} next 2>/dev/null`, /output redirect \("2>"\)/],
    [`${flow} next >> ~/.zshrc`, /output redirect \(">>"\)/],
    [`node ${ROOT}examples/mock-event/load.mjs buyers >(tee x)`, /process substitution/],
  ];
  for (const [c, why] of refused) {
    const r = bash(c);
    assert.equal(r.status, 2, c);
    assert.match(r.stderr, why, c);
    assert.match(r.stderr, /--value-file/);
  }
  for (const c of [`${flow} next --event ev`, `${flow} answer --ask gate --value-file "/tmp/a b.txt"`, `${flow} answer --ask x --value 'a > b, $(not run)'`, `${flow} answer --ask x --value "a \\> b"`, 'ls > /tmp/x', 'echo $(date)', 'git log --oneline | head -3']) {
    const r = bash(c);
    assert.equal(r.status, 0, `${c}: ${r.stderr}`);
    assert.equal(r.stdout, '', 'no decision: the user\'s own settings apply');
  }
});

// 10. A subagent's call is held to any live run lock, and never gets a window.
test('subagent: with another session\'s lock live, a call with agent_id gets the run\'s limits; with no lock it passes as before', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const outside = '/opt/floorboss-test/notes.md';
  const call = (tool_name, tool_input, extra = {}) => hook(H, { tool_name, tool_input, session_id: 'sess-sub', ...extra });
  const agent = { agent_id: 'agent-1', agent_type: 'general-purpose' };
  // No lock: as before.
  assert.equal(call('mcp__x__send_email', { to: 'a@b.test' }, agent).status, 0);
  assert.equal(call('Write', { file_path: outside, content: 'x' }, agent).status, 0);
  // Session sess-a ran floorboss; the run's own 30 minutes are over, its session stamp is live.
  const old = new Date(Date.now() - 2 * 3600e3).toISOString();
  writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at: old, sessions: { 'sess-a': new Date().toISOString() } }));
  assert.equal(call('mcp__x__send_email', { to: 'a@b.test' }).status, 0, 'another session, no agent_id: as before');
  const sent = call('mcp__x__send_email', { to: 'a@b.test' }, agent);
  assert.equal(sent.status, 2);
  assert.match(sent.stderr, /comes from a subagent/);
  assert.equal(call('Write', { file_path: outside, content: 'x' }).status, 0);
  assert.match(call('Write', { file_path: outside, content: 'x' }, agent).stderr, /outside floorboss's data folder/);
  // A subagent holds the run's text: a server floorboss wasn't given and didn't find gets nothing then, reads included.
  assert.match(call('mcp__notion__notion-search', { query: 'Acme' }, agent).stderr, /wasn't given and didn't find at setup/);
  // A window the user opened in the main conversation never serves a subagent.
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'enrich.person': { server: 'apollo', tool: 'people_match', args: { name: '{name}', organization_name: '{company}' } } } }));
  writeFileSync(join(H.HOME, 'enrich-window.json'), JSON.stringify({ event: H.slug, people: PEOPLE, ids: ['c001'], count: 1, used: 0, until: new Date(Date.parse(NOW) + 600e3).toISOString() }));
  const look = call('mcp__apollo__people_match', { name: 'Ana Berg', organization_name: 'Acme' }, agent);
  assert.equal(look.status, 2);
  assert.match(look.stderr, /haven't agreed to any right now.*subagent/s);
  assert.equal(JSON.parse(readFileSync(join(H.HOME, 'enrich-window.json'), 'utf8')).used, 0, 'nothing counted');
});

// 4. Paid lookups: the first of each window asks; the count is never more than the people it names.
test('enrich.person: the first lookup of a window asks with the tool and the count; the rest go; the count is capped by the ids', () => {
  const config = { connectors: { 'enrich.person': { server: 'apollo', tool: 'people_match', args: { name: '{name}', organization_name: '{company}' } } } };
  const call = { tool_name: 'mcp__apollo__people_match', tool_input: { name: 'Ana Berg', organization_name: 'Acme' } };
  const until = new Date(Date.now() + 600e3).toISOString();
  const run = (w) => { const asks = []; return { why: check(call, { config, enrichWindow: w, asks }), asks }; };
  const first = run({ people: PEOPLE, ids: ['c001', 'c002', 'c003'], count: 3, used: 0, until });
  assert.equal(first.why, null);
  assert.equal(first.asks.length, 1);
  assert.match(first.asks[0], /apollo\/people_match.*allows 3 lookups/s);
  assert.deepEqual(run({ people: PEOPLE, ids: ['c001', 'c002', 'c003'], count: 3, used: 1, until }).asks, [], 'the rest of the window goes without asking');
  // A count the ids don't back (a window written with "count": 500) is held to the ids.
  assert.match(run({ people: PEOPLE, ids: ['c001'], count: 500, used: 1, until }).why || '', /agreed to 1 lookup and/);
  assert.match(run({ people: PEOPLE, count: 5, used: 0, until }).why || '', /agreed to 0 lookups/, 'no ids, no lookups');
});

test('enrich_ok: refused when the flow isn\'t asking it', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\n' });
  const f = join(H.dir, 'e.json');
  writeFileSync(f, JSON.stringify('yes, all of them'));
  assert.match(cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'enrich_ok', '--value-file', f]).ERROR || '', /isn't asking about lookups/);
  assert.ok(!existsSync(join(H.HOME, 'enrich-window.json')));
});

test('enrich hook: the first lookup asks, is counted once it ran, and the second goes without a prompt', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\n' });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'enrich.person': { server: 'apollo', tool: 'people_match', args: { name: '{name}', organization_name: '{company}' } } } }));
  writeFileSync(join(H.HOME, 'enrich-window.json'), JSON.stringify({ event: H.slug, people: PEOPLE, ids: ['c001', 'c002'], count: 2, used: 0, until: new Date(Date.parse(NOW) + 600e3).toISOString() }));
  const a = guard(H, 'mcp__apollo__people_match', { name: 'Ana Berg', organization_name: 'Acme' });
  assert.equal(a.status, 0, a.stderr);
  assert.ok(asks(a));
  post(H, 'mcp__apollo__people_match', { name: 'Ana Berg', organization_name: 'Acme' });
  const b = guard(H, 'mcp__apollo__people_match', { name: 'Bo Li', organization_name: 'Globex' });
  assert.equal(b.status, 0, b.stderr);
  assert.ok(!asks(b));
  post(H, 'mcp__apollo__people_match', { name: 'Bo Li', organization_name: 'Globex' });
  assert.equal(guard(H, 'mcp__apollo__people_match', { name: 'Cy Ng', organization_name: 'Initech' }).status, 2, 'two agreed, two used');
});

test('enrich_ok: "only 7 credits left, so just the top 6" agrees to 6, and two numbers never mean the larger', async () => {
  const { lookupCount } = await import('../lib/normalize.mjs');
  assert.equal(lookupCount('I only have 7 credits left, so just the top 6', 11), 6);
  assert.equal(lookupCount('only 7 credits, look up 5 of them', 11), 5);
  assert.equal(lookupCount('yes, all of them', 11), 11);
  assert.equal(lookupCount('top 20', 11), 11);
  assert.equal(lookupCount('only 3', 11), 3);
});
