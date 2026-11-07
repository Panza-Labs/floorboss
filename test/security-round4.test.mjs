// Fourth security review: every tool on the people-data server held to the lookup window; asks recorded only
// once the call ran (the PostToolUse hook), so a "no" stops the rest; the event site's port; list files that
// are files, of their own kind; the hold history's wording; agent_id of any type; ".env.local" searches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { readUrl, pageKey, listFileProblem, SECRET_SEARCH } from '../lib/security.mjs';
import { join } from 'node:path';
import { check, holdHistory, personName, isSubagent, fileRefusal, globSeeksSecrets } from '../hooks/guard.mjs';
import { setup, cli, triage, draftApprove, atListSource, ROOT, NOW } from './fixtures/harness.mjs';
import { cli as simCli } from './sims/lib/driver.mjs';
const PEOPLE = [{ id: 'c001', name: 'Ana Berg', company: 'Acme' }, { id: 'c002', name: 'Bo Li', company: 'Globex' }, { id: 'c003', name: 'Cy Park', company: 'Initech' }];

const hook = (H, input, { now = NOW, env = {}, args = [] } = {}) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs'), ...args], { input: JSON.stringify(input), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now, ...env }, encoding: 'utf8' });
const guard = (H, tool_name, tool_input, opts) => hook(H, { tool_name, tool_input, session_id: opts?.session || 's1', ...(opts?.extra || {}) }, opts);
const post = (H, tool_name, tool_input, opts = {}) => hook(H, { hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response: { content: [{ type: 'text', text: 'ok' }] }, session_id: 's1', ...(opts.extra || {}) }, { ...opts, args: ['post'] });
const asks = (r) => /"permissionDecision":"ask"/.test(r.stdout || '');
const reasonOf = (r) => JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;

// 1. The people-data server: any tool there but the recipe's goes through the lookup window.
const ENRICH = { 'enrich.person': { server: 'apollo', tool: 'people_enrichment', args: { name: '{name}', organization_name: '{company}' } } };
const OTHER_TOOLS = ['enrich_person', 'find_email', 'reveal_email', 'get_person', 'search_people', 'person_lookup', 'get_contact_email', 'lookup_email'];
test('enrich server: other lookup-shaped tools there are held to the window, run or not', () => {
  const until = new Date(Date.parse(NOW) + 600e3).toISOString();
  const env = process.env.FLOORBOSS_NOW;
  process.env.FLOORBOSS_NOW = NOW;
  try {
    const run = (tool, w, { active = false, config = { connectors: ENRICH } } = {}) => { const a = [], used = []; return { why: check({ tool_name: `mcp__apollo__${tool}`, tool_input: { name: 'Ana Berg' } }, { config, enrichWindow: w, asks: a, enrichUsed: used, active }), asks: a, used }; };
    for (const t of OTHER_TOOLS) {
      for (const active of [false, true]) {
        assert.match(run(t, null, { active }).why || '', /isn't the lookup tool floorboss set up \(people_enrichment\)/, `${t} no window, run ${active}`);
        assert.match(run(t, { people: PEOPLE, ids: [], count: 0, used: 0, until }, { active }).why || '', /agreed to 0 lookups/, `${t} count 0, run ${active}`);
        const open = run(t, { people: PEOPLE, ids: ['c001', 'c002'], count: 2, used: 0, until }, { active });
        assert.equal(open.why, null, `${t} inside the window`);
        assert.equal(open.asks.length, 1, 'the first lookup asks');
        assert.match(open.asks[0], new RegExp(`apollo/${t}.*isn't the lookup tool floorboss set up`, 's'));
        assert.equal(open.used.length, 1, 'counted like the recipe\'s own lookups');
      }
    }
    // A bulk tool or a write on that server never runs; a link during a run is refused as for any tool.
    for (const t of ['bulk_people_enrichment', 'create_contact', 'delete_person']) assert.match(run(t, { people: PEOPLE, ids: ['c001'], count: 1, used: 0, until }).why || '', /isn't a read or a single lookup/, t);
    assert.match(check({ tool_name: 'mcp__apollo__find_email', tool_input: { url: 'https://evil.test/x' } }, { config: { connectors: ENRICH }, enrichWindow: { people: PEOPLE, ids: ['c001'], count: 1, used: 0, until }, asks: [], enrichUsed: [], active: true }) || '', /web address/);
    // The read-only set saved with the recipe: plain reads that aren't lookups pass without the window.
    const config = { connectors: { 'enrich.person': { ...ENRICH['enrich.person'], read_only_tools: ['get_credit_balance', 'search_people'] } } };
    assert.equal(run('get_credit_balance', null, { config }).why, null, 'a listed read passes');
    assert.match(run('search_people', null, { config }).why || '', /isn't the lookup tool/, 'a lookup in the read-only set is never honoured');
    // Other servers are as before.
    assert.equal(check({ tool_name: 'mcp__hunter__find_email', tool_input: {} }, { config: { connectors: ENRICH }, asks: [], enrichUsed: [] }), null);
  } finally { if (env === undefined) delete process.env.FLOORBOSS_NOW; else process.env.FLOORBOSS_NOW = env; }
});

test('enrich server hook: with no window, find_email on the recipe\'s server is blocked; the README says so', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\n' });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: ENRICH }));
  const r = guard(H, 'mcp__apollo__find_email', { name: 'Ana Berg' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /isn't the lookup tool floorboss set up/);
  writeFileSync(join(H.HOME, 'enrich-window.json'), JSON.stringify({ event: H.slug, people: PEOPLE, ids: [], count: 0, used: 0, until: new Date(Date.parse(NOW) + 600e3).toISOString() }));
  assert.equal(guard(H, 'mcp__claude_ai_Apollo__reveal_email', { name: 'Ana Berg' }).status, 2, 'the claude.ai spelling of the server too');
  assert.match(readFileSync(join(ROOT, 'README.md'), 'utf8'), /any other tool on that\s+server/);
});

// 2. An ask is recorded only once the call ran (PostToolUse): a "no" (no post) leaves the next call asking.
const STAGE = { server: 'gmail', tool: 'create_draft', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'd'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
test('stage_draft: a declined first prompt asks again at the next draft; after the post hook the rest of the batch goes', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Ng,CTO,Initech,cy@initech.test\n' });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { stage_draft: STAGE } }));
  triage(H); draftApprove(H);
  const sl = cli(H, 'event-outreach', ['stage-list', '--event', H.slug]);
  const items = JSON.parse(readFileSync(sl.file, 'utf8'));
  assert.equal(items.length, 3);
  const input = (it) => ({ to: it.to, subject: it.subject, body: it.body });
  const call = (it) => guard(H, 'mcp__gmail__create_draft', input(it));
  const marker = join(H.dir, 'stage-asked.json');
  // Asked, and declined: no post. Nothing is recorded, and the next draft asks again.
  assert.ok(asks(call(items[0])));
  assert.ok(!existsSync(marker), 'the pre hook writes no marker');
  const again = call(items[1]);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(asks(again), 'a no to the first prompt stops the rest: the next asks');
  // Asked, allowed: the call ran and the post hook confirms the batch. The rest goes without asking.
  assert.equal(post(H, 'mcp__gmail__create_draft', input(items[1])).status, 0);
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).batch.length, 24);
  const rest = call(items[2]);
  assert.equal(rest.status, 0, rest.stderr);
  assert.ok(!asks(rest), 'the rest of the batch goes in');
  // A post for a call that matches no listed draft, or a list replaced since the prompt, confirms nothing.
  const H2 = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n' });
  writeFileSync(join(H2.HOME, 'config.json'), JSON.stringify({ connectors: { stage_draft: STAGE } }));
  triage(H2); draftApprove(H2);
  const sl2 = cli(H2, 'event-outreach', ['stage-list', '--event', H2.slug]);
  const two = JSON.parse(readFileSync(sl2.file, 'utf8'));
  post(H2, 'mcp__gmail__create_draft', { to: 'x@evil.test', subject: 's', body: 'b' });
  assert.ok(!existsSync(join(H2.dir, 'stage-asked.json')), 'no listed draft, nothing confirmed');
  assert.ok(asks(guard(H2, 'mcp__gmail__create_draft', input(two[0]))));
  const later = new Date(Date.parse(NOW) + 60e3).toISOString();
  cli(H2, 'event-outreach', ['stage-list', '--event', H2.slug], later);
  post(H2, 'mcp__gmail__create_draft', input(two[0]), { now: later });
  assert.ok(!existsSync(join(H2.dir, 'stage-asked.json')), 'the list was replaced after the prompt: a new batch, not confirmed');
  // The marker and the pending note are records: Claude's Write can't fake either.
  for (const f of ['stage-asked.json', 'stage-pending.json']) assert.equal(guard(H2, 'Write', { file_path: join(H2.dir, f), content: '{}' }).status, 2, f);
});

test('enrich: a declined first lookup leaves the count at 0 and the next asks; after the post hook it counts and the rest go (a declined one holds its slot)', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\n' });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: ENRICH }));
  const wpath = join(H.HOME, 'enrich-window.json');
  writeFileSync(wpath, JSON.stringify({ event: H.slug, people: PEOPLE, ids: ['c001', 'c002', 'c003'], count: 3, used: 0, until: new Date(Date.parse(NOW) + 600e3).toISOString() }));
  const look = (name, org = 'Acme') => guard(H, 'mcp__apollo__people_enrichment', { name, organization_name: org });
  const used = () => JSON.parse(readFileSync(wpath, 'utf8')).used;
  assert.ok(asks(look('Ana Berg')));
  assert.equal(used(), 0, 'the pre hook counts nothing');
  assert.ok(asks(look('Ana Berg')), 'declined (no post): the next lookup asks again');
  post(H, 'mcp__apollo__people_enrichment', { name: 'Ana Berg', organization_name: 'Acme' });
  assert.equal(used(), 1, 'counted once it ran');
  const b = look('Bo Li', 'Globex');
  assert.equal(b.status, 0, b.stderr);
  assert.ok(!asks(b), 'the rest of the count goes without asking');
  post(H, 'mcp__apollo__find_email', { name: 'Bo Li', organization_name: 'Globex' });
  assert.equal(used(), 2, 'another tool on the server counts too');
  // The declined first call never ran, but floorboss can't tell: it holds the third slot.
  assert.match(look('Cy Ng').stderr, /agreed to 3 lookups in this window: 2 ran and 1 was let through without running yet/);
  // A new window (another yes) isn't counted by a post for a lookup the old one let through.
  writeFileSync(wpath, JSON.stringify({ event: H.slug, people: PEOPLE, ids: ['c003'], count: 1, used: 0, until: new Date(Date.parse(NOW) + 900e3).toISOString() }));
  post(H, 'mcp__apollo__people_enrichment', { name: 'Cy Ng', organization_name: 'Acme' });
  assert.equal(used(), 0);
  // Another server's post touches nothing.
  post(H, 'mcp__hunter__find_email', { name: 'x' });
  assert.equal(used(), 0);
});

test('hooks.json runs the guard after MCP calls; SECURITY.md and the README say what it records', () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks/hooks.json'), 'utf8')).hooks;
  const p = hooks.PostToolUse?.[0];
  assert.equal(p.matcher, 'mcp__.*');
  assert.match(p.hooks[0].command, /guard\.mjs" post$/);
  assert.equal(p.hooks[0].timeout, 30);
  for (const f of ['SECURITY.md', 'README.md']) assert.match(readFileSync(join(ROOT, f), 'utf8'), /PostToolUse/, f);
});

// 3. The event site's list page: the port is part of it.
test('readUrl: a port of its own is odd unless the saved page has that host and port', () => {
  assert.equal(readUrl('https://www.expo.example:8443/attendees').odd, true);
  assert.equal(readUrl('https://www.expo.example:8443/attendees').port, '8443');
  assert.equal(readUrl('https://www.expo.example:8443/attendees', { ports: ['www.expo.example:8443'] }).odd, false);
  assert.equal(readUrl('https://www.expo.example:8443/attendees', { ports: ['www.expo.example:9000'] }).odd, true);
  assert.equal(readUrl('https://www.expo.example:443/attendees').odd, false, 'the scheme\'s own port is no port');
  assert.equal(pageKey(readUrl('https://www.expo.example:8443/attendees/', { ports: true })), 'https://www.expo.example:8443/attendees');
  assert.equal(pageKey(readUrl('https://www.expo.example/attendees')), 'https://www.expo.example/attendees');
});

test('event site: :8443 never opens as the saved page without a port; a page saved with its port opens only on it', () => {
  const site = (url) => {
    const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
    appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: NOW, type: 'site_allowed', who: 'user', host: 'expo.example', said: `the list is at ${url}`, url })}\n`);
    writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at: new Date().toISOString(), sessions: { s1: new Date().toISOString() } }));
    return (u) => guard(H, 'mcp__claude-in-chrome__navigate', { url: u });
  };
  const plain = site('https://www.expo.example/attendees');
  const ok = plain('https://www.expo.example/attendees');
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(!asks(ok), 'the saved page opens');
  for (const u of ['https://www.expo.example:8443/attendees', 'https://www.expo.example:80/attendees', 'https://www.expo.example:8443/other']) assert.equal(plain(u).status, 2, u);
  const ported = site('https://www.expo.example:8443/attendees');
  const same = ported('https://www.expo.example:8443/attendees');
  assert.equal(same.status, 0, same.stderr);
  assert.ok(!asks(same), 'the saved page with its port opens');
  assert.ok(asks(ported('https://www.expo.example/attendees')), 'without the port it is another page: asks');
  assert.ok(asks(ported('https://www.expo.example:8443/admin')), 'another page on that port asks');
  assert.equal(ported('https://www.expo.example:9000/attendees').status, 2, 'another port is refused');
});

test('list_source: a link with a port is saved with it', { timeout: 120000 }, () => {
  const H = atListSource();
  const f = join(H.dir, 'ls.json');
  writeFileSync(f, JSON.stringify('the attendees are at https://www.expo.example:8443/attendees'));
  const r = simCli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'list_source', '--value-file', f]);
  assert.ok(!r.ERROR, r.ERROR);
  const e = readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.type === 'site_allowed');
  assert.equal(e.url, 'https://www.expo.example:8443/attendees');
});

// 4. A list file is a plain file, of its own kind's types.
const config = (H) => (existsSync(join(H.HOME, 'config.json')) ? JSON.parse(readFileSync(join(H.HOME, 'config.json'), 'utf8')) : {});
const run = (H, skill, args) => spawnSync('node', [join(ROOT, 'skills', skill, 'scripts/cli.mjs'), ...args], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW }, encoding: 'utf8', timeout: 15000 });
test('list files: a folder or a FIFO is refused, and never lands in config.known_contacts_paths', { timeout: 120000 }, () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const proj = join(H.HOME, 'proj');
  mkdirSync(join(proj, 'dir.csv'), { recursive: true });
  const fifo = join(proj, 'fifo.csv');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  assert.match(listFileProblem(join(proj, 'dir.csv'), 0), /isn't a file/);
  assert.match(listFileProblem(fifo, 0), /isn't a file/);
  for (const p of [join(proj, 'dir.csv'), fifo]) {
    for (const args of [['inputs', '--event', H.slug, '--kind', 'dnc', '--file', p], ['inputs', '--event', H.slug, '--kind', 'attendees', '--file', p], ['load', '--event', H.slug, '--known', p], ['load', '--event', H.slug, '--crm', p]]) {
      const r = run(H, 'crm-triage', args);
      assert.equal(r.signal, null, `${args.join(' ')}: ended, didn't hang`);
      assert.notEqual(r.status, 0, args.join(' '));
      assert.match(r.stderr, /isn't a file/, args.join(' '));
    }
    // The flow's known_contacts answer refuses it before saving anything.
    const f = join(H.dir, 'kc.json');
    writeFileSync(f, JSON.stringify(p));
    const a = run(H, 'flow', ['answer', '--event', H.slug, '--ask', 'known_contacts', '--value-file', f]);
    assert.equal(a.signal, null);
    assert.match(a.stderr + a.stdout, /isn't a file.*Nothing was saved/s);
  }
  assert.deepEqual(config(H).known_contacts_paths || [], [], 'nothing saved');
  // A good --csv with a bad --known: neither is taken (nothing is copied before every file is checked).
  const good = join(proj, 'people.csv');
  writeFileSync(good, 'Name,Title,Company,Email\nBo Li,VP Ops,Globex,bo@globex.test\n');
  assert.match(cli(H, 'crm-triage', ['load', '--event', H.slug, '--csv', good, '--known', join(proj, 'dir.csv')]).ERROR || '', /isn't a file/);
  assert.ok(!existsSync(join(H.dir, 'inputs', 'attendees.csv')) || !readFileSync(join(H.dir, 'inputs', 'attendees.csv'), 'utf8').includes('Bo Li'));
  // A contacts path saved before this check (a folder) is left out with a note; the load still works.
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ ...config(H), known_contacts_paths: [join(proj, 'dir.csv')] }));
  const l = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.ok(!l.ERROR, l.ERROR);
  assert.match(JSON.stringify(l), /isn't a file/);
});

test('list files: each kind takes its own file types; a .json do-not-contact list is refused', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const put = (name, text = 'Email\nx@y.test\n') => { const p = join(H.HOME, 'proj', name); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); return p; };
  for (const bad of ['dnc.json', 'dnc.xlsx', 'dnc.md', 'dnc.ics', 'dnc.eml']) assert.match(cli(H, 'crm-triage', ['inputs', '--event', H.slug, '--kind', 'dnc', '--file', put(bad)]).ERROR || '', /do-not-contact list from \(txt, csv\)/, bad);
  for (const bad of ['people.json', 'people.md']) {
    assert.match(cli(H, 'crm-triage', ['inputs', '--event', H.slug, '--kind', 'attendees', '--file', put(bad)]).ERROR || '', /attendees list from/, bad);
    assert.match(cli(H, 'crm-triage', ['load', '--event', H.slug, '--known', put(bad)]).ERROR || '', /contacts list from/, bad);
  }
  assert.match(cli(H, 'crm-triage', ['inputs', '--event', H.slug, '--kind', 'crm-records', '--file', put('records.csv')]).ERROR || '', /crm-records list from \(json\)/);
  assert.equal(listFileProblem('/x/dnc.TXT', 10, 'dnc'), null);
  assert.equal(listFileProblem('/x/a.xlsx', 10, 'crm'), null);
  assert.equal(listFileProblem('/x/r.json', 10, 'mail-history'), null);
  assert.deepEqual(config(H).known_contacts_paths || [], []);
});

// 5. The hold history: the user's decide is the clearer when a list was imported too; the person by name.
test('holdHistory: with a list imported and a decide after the match, the decide is named as what cleared it', () => {
  const hold = { at: '2026-10-12T08:00:00.000Z', type: 'hold_seen', id: 'c001', says: 'on your do-not-contact list' };
  const added = { at: '2026-10-12T09:00:00.000Z', type: 'input_added', who: 'user', kind: 'dnc' };
  const decide = { at: '2026-10-12T10:00:00.000Z', type: 'decide', who: 'user', id: 'c001', group: 'reach' };
  assert.deepEqual(holdHistory([hold, added, decide], 'c001', 'Ana Berg'), ['"Ana Berg" (c001) matched "on your do-not-contact list" at 2026-10-12T08:00:00.000Z, cleared by your decide reach at 2026-10-12T10:00:00.000Z.']);
  assert.match(holdHistory([hold, decide, added], 'c001')[0], /cleared by your decide reach at 2026-10-12T10/);
  assert.match(holdHistory([hold, added], 'c001')[0], /cleared by input_added \(a new dnc file\) at 2026-10-12T09/, 'only a list: the list is named');
  assert.match(holdHistory([hold, { ...decide, who: 'claude' }, added], 'c001')[0], /input_added/, 'a decide not by the user doesn\'t count');
  assert.match(holdHistory([hold], 'c001')[0], /cleared by nothing in the record\./);
});

test('stage prompt: a list item without a name shows the person\'s name from the event\'s contacts', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { stage_draft: STAGE } }));
  triage(H); draftApprove(H);
  const sl = cli(H, 'event-outreach', ['stage-list', '--event', H.slug]);
  const [it] = JSON.parse(readFileSync(sl.file, 'utf8'));
  assert.ok(!it.name, 'the stage list carries no name');
  const r = guard(H, 'mcp__gmail__create_draft', { to: it.to, subject: it.subject, body: it.body });
  assert.equal(r.status, 0, r.stderr);
  assert.match(reasonOf(r), /This one is to "Ana Berg" \(c001, "ana@acme\.test"\)/);
  assert.match(reasonOf(r), /- "Ana Berg" \(c001, "ana@acme\.test"\)/);
  assert.equal(personName(H.dir, it.id), 'Ana Berg');
  assert.equal(personName(H.dir, 'c999'), 'c999', 'no such person: the id');
});

// 6. agent_id of any type marks a subagent.
test('subagent: an agent_id that is a number or an object is a subagent, not the main session', () => {
  for (const id of [5, 0, {}, [1], 'ag1', true]) assert.equal(isSubagent({ agent_id: id }), true, JSON.stringify(id));
  for (const id of [undefined, null, '', '  ']) assert.equal(isSubagent({ agent_id: id }), false, JSON.stringify(id));
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const old = new Date(Date.now() - 2 * 3600e3).toISOString();
  writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at: old, sessions: { 'sess-a': new Date().toISOString() } }));
  for (const agent_id of [5, {}]) {
    const r = guard(H, 'mcp__x__send_email', { to: 'a@b.test' }, { session: 'sess-b', extra: { agent_id } });
    assert.equal(r.status, 2, JSON.stringify(agent_id));
    assert.match(r.stderr, /comes from a subagent/);
  }
  assert.equal(guard(H, 'mcp__x__send_email', { to: 'a@b.test' }, { session: 'sess-b' }).status, 0, 'no agent_id: another session, as before');
});

// 7. ".env.local" and its kind are a search for keys.
test('SECRET_SEARCH: .env followed by a dot is caught, in Glob, a Grep filter and a list file\'s path', () => {
  for (const g of ['**/.env.local', '.env.production', 'app/.env.development.local', '**/.env.*', '~/proj/.env.local']) {
    assert.ok(SECRET_SEARCH.test(g) || globSeeksSecrets(g), g);
    assert.match(fileRefusal('Glob', { pattern: g }) || '', /looks for keys/, g);
  }
  assert.match(fileRefusal('Grep', { pattern: 'KEY', glob: '**/.env.local', path: '/tmp/project' }) || '', /looks for keys/);
  assert.match(listFileProblem('/tmp/proj/.env.local.csv', 1) || '', /keys or credentials/);
  // Names that only start the same are not.
  for (const g of ['**/environment.ts', 'src/.envelope/*.md', '**/*.env-example.md']) assert.equal(fileRefusal('Glob', { pattern: g }), null, g);
});
