// The findings of the 8 Nov security audit (security-audit skill, run-4) fixed before launch, each as the attack that
// worked then and must fail now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, idOf, ROOT, NOW } from './fixtures/harness.mjs';
import { bashRefusal, foundServer, check, listed, listedSends, browserItems, logItems, testOnItsServer } from '../hooks/guard.mjs';
import { namedCompanies, unclearSkip } from '../lib/names.mjs';
import { gatePeople } from '../lib/gate.mjs';
import { makeHome, drive, simplePersona, cli as simCli } from './sims/lib/driver.mjs';

const run = (H, skill, args) =>
  spawnSync('node', [join(ROOT, 'skills', skill, 'scripts', 'cli.mjs'), ...args], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW }, encoding: 'utf8' });
const TWO = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n';
const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const RUN = { active: true, session: true, until: '2026-10-30T12:00:00.000Z' };
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
const session = (H, mcp) => {
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', `s${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify({ mcp }));
  return f;
};
const browserCall = (tool, tool_input, extra = {}) => check({ tool_name: tool, tool_input }, { config: {}, active: RUN, ...extra });

test('C1: a backslash in double quotes is read as the shell reads it, in the script word too', () => {
  const P = join(ROOT, 'skills/connectors/scripts/cli.mjs').replace(/\/{2,}/g, '/');
  assert.equal(bashRefusal(`node "${P}" next`), null, 'the plain call still runs');
  assert.match(bashRefusal(`node "\\${P}" next`) || '', /first word/);
  const skills = P.replace('/skills/', '/\\skills/');
  assert.match(bashRefusal(`node "${skills}" next`) || '', /first word/);
});

test('C2: a rescan cannot change what the first scan found a server to be', () => {
  const H = setup({ attendees: TWO });
  const scan = (mcp) => run(H, 'event-context', ['scan', '--session-file', session(H, mcp)]);
  const plain = { name: 'notes', tools: ['do_thing'] };
  const crm = { name: 'notes', tools: ['search_contacts'] };
  assert.equal(scan([plain, { name: 'hubspot', tools: ['search_contacts'] }]).status, 0);
  inHome(H, () => {
    assert.equal(foundServer('hubspot'), true);
    assert.equal(foundServer('notes'), false, 'seen at the first scan, but not found to be anything');
  });
  const again = JSON.parse(scan([crm, { name: 'hubspot', tools: ['search_contacts'] }]).stdout);
  assert.ok(again.found.crm.includes('mcp:notes'), 'setup still shows what this scan found');
  inHome(H, () => assert.equal(foundServer('notes'), false, 'a rescan reclassifies nothing'));
  // A restart moves the inventory aside and keeps what the first scan found.
  assert.equal(run(H, 'event-context', ['onboarding', '--reset']).status, 0);
  assert.equal(scan([crm]).status, 0);
  inHome(H, () => {
    assert.equal(foundServer('notes'), false, 'nor does a restart and a scan');
    assert.equal(foundServer('hubspot'), true);
  });
});

test('C2: an inventory from before setup_found keeps what it had found, once', () => {
  const H = setup({ attendees: TWO });
  writeFileSync(join(H.HOME, 'inventory.json'), JSON.stringify({ items: [], setup_servers: ['hubspot', 'notes'], found: { crm: ['mcp:hubspot'] } }));
  inHome(H, () => assert.equal(foundServer('hubspot'), true, 'read as it is, before any rescan'));
  assert.equal(run(H, 'event-context', ['scan', '--session-file', session(H, [{ name: 'notes', tools: ['search_contacts'] }])]).status, 0);
  inHome(H, () => {
    assert.equal(foundServer('hubspot'), true);
    assert.equal(foundServer('notes'), false);
  });
});

test('C2: a test call runs on what the first scan found, whatever a rescan says', () => {
  const H = setup({ attendees: TWO });
  writeFileSync(join(H.HOME, 'inventory.json'), JSON.stringify({ setup_servers: ['hubspot', 'notes'], setup_found: { crm: ['mcp:hubspot'] }, found: { crm: ['mcp:hubspot', 'mcp:notes'] } }));
  inHome(H, () => {
    assert.equal(testOnItsServer({ task: 'crm.create_task', server: 'hubspot' }, {}), true);
    assert.equal(testOnItsServer({ task: 'crm.create_task', server: 'notes' }, {}), false);
  });
});

test('C3: a Playwright server under its own name is found as a browser, from its tools', () => {
  const H = setup({ attendees: TWO });
  assert.equal(run(H, 'event-context', ['scan', '--session-file', session(H, [{ name: 'pw', tools: ['browser_navigate', 'browser_snapshot', 'browser_click'] }, { name: 'notes', tools: ['browser_find'] }])]).status, 0);
  inHome(H, () => {
    assert.equal(browserCall('mcp__pw__browser_snapshot', {}), null);
    assert.ok(browserCall('mcp__notes__browser_find', { query: 'short' }), 'a stray browser_find makes no browser');
  });
});

test('C3: an open window changes neither limit', () => {
  const H = setup({ attendees: TWO });
  const crmLog = { event: 'ev', until: '2026-10-30T12:00:00.000Z' };
  inHome(H, () => {
    assert.ok(browserCall('mcp__notes__browser_find', { query: 'x'.repeat(5000) }, { crmLog }), 'not a browser, window or no window');
    assert.ok(browserCall('mcp__notes__browser_click', { ref: 'e1' }, { crmLog }));
    assert.match(browserCall('mcp__playwright__browser_find', { query: 'x'.repeat(5000) }, { crmLog }) || '', /long or spans lines/);
  });
});

test('C3: a browser_ tool on a server not known to be a browser is held as that server', () => {
  const H = setup({ attendees: TWO });
  inHome(H, () => {
    assert.match(browserCall('mcp__notes__browser_find', { query: 'x'.repeat(5000) }) || '', /long or spans lines/);
    assert.match(browserCall('mcp__notes__browser_find', { query: 'short' }) || '', /wasn't given and didn't find/);
    assert.equal(browserCall('mcp__playwright__browser_snapshot', {}), null, 'a browser-named server still reads');
    assert.equal(browserCall('mcp__remote-devices__Claude_Browser__browser_snapshot', {}), null, 'and one reached through another server');
    writeFileSync(join(H.HOME, 'inventory.json'), JSON.stringify({ setup_servers: ['pw'], setup_found: { browser: ['mcp:pw'] }, found: {} }));
    assert.equal(browserCall('mcp__pw__browser_snapshot', {}), null, 'as does one the first scan found to be a browser');
  });
});

test('C3: a browser read takes short values only during a run', () => {
  const H = setup({ attendees: TWO });
  inHome(H, () => {
    assert.match(browserCall('mcp__playwright__browser_find', { query: 'x'.repeat(301) }) || '', /long or spans lines/);
    assert.match(browserCall('mcp__playwright__browser_find', { query: 'a\nb' }) || '', /long or spans lines/);
    assert.equal(browserCall('mcp__playwright__browser_find', { query: 'Sign in' }), null);
  });
});

test('C4: the mock event reaches no real connector', () => {
  const H = setup({ attendees: TWO, settings: { sending: { channels: ['email'], followups: 'scheduled', linkedin_ack: false } } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H);
  draftApprove(H);
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug]);
  const [it] = JSON.parse(readFileSync(list.file, 'utf8'));
  const send = () =>
    spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], {
      input: JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: { to: it.to, subject: it.subject, body: it.body } }),
      env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW },
      encoding: 'utf8'
    });
  const real = send();
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /"permissionDecision":"ask"/, 'a real event: its send goes to the prompt');
  const item = { id: 'c001', name: 'Ana Berg', email: 'ana@acme.test' };
  writeFileSync(join(H.dir, 'contact-list.json'), JSON.stringify([item]));
  writeFileSync(join(H.dir, 'derived', 'browser-send-list.json'), JSON.stringify([{ id: 'c001', via: 'browser' }]));
  inHome(H, () => {
    assert.equal(listed('contact-list.json').length, 1);
    assert.equal(browserItems(H.slug).length, 1);
  });
  writeFileSync(join(H.dir, 'crm-log-list.json'), JSON.stringify([{ key: 'c001:1', id: 'c001', touch: 1, body: 'x' }]));
  inHome(H, () => assert.equal(logItems(H.slug).length, 1));
  const ev = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  writeFileSync(join(H.dir, 'event.json'), JSON.stringify({ ...ev, mock: true }));
  assert.equal(send().status, 2, 'the mock: refused');
  inHome(H, () => {
    assert.deepEqual(listedSends(), []);
    assert.deepEqual(listed('contact-list.json'), []);
    assert.deepEqual(browserItems(H.slug), []);
    assert.deepEqual(logItems(H.slug), []);
  });
});

test('C5: an attendee called Drop cannot turn "drop" into an approval', () => {
  const H = setup({ attendees: `${TWO}Drop Tables,CIO,Initech,drop@initech.test\n` });
  triage(H);
  const ana = idOf(H, 'Ana Berg'),
    bo = idOf(H, 'Bo Li');
  const { gate } = draftApprove(H, NOW, `approve ${ana}, drop ${bo}`);
  assert.ok(!gate.ERROR, gate.ERROR);
  const ledger = readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8');
  const approved = ledger.trim().split('\n').map((l) => JSON.parse(l)).filter((e) => /approved/.test(e.type)).map((e) => e.id);
  assert.ok(approved.includes(ana), ledger.slice(-400));
  assert.ok(!approved.includes(bo), 'the dropped person stays unapproved');
  assert.ok(!approved.includes(idOf(H, 'Drop Tables')), 'and the attendee named Drop was never approved');
});

test('C5: a refused line about someone another line approves still stops the approval, when they are named', () => {
  for (const answers of ['approve Ana Berg, Bo Li; hold Bo Li', 'approve Ana Berg\napprove Bo Li\nBo Li not yet, check with legal first']) {
    const H = setup({ attendees: `${TWO}Drop Tables,CIO,Initech,drop@initech.test\n` });
    triage(H);
    const { gate } = draftApprove(H, NOW, answers);
    assert.match(gate.ERROR || '', /Nothing was approved|can't be read|isn't/, answers);
    assert.doesNotMatch(readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8'), /"type":"approved"/, answers);
  }
});

test('C5: naming someone beside "approve all" still holds the approval', () => {
  for (const answers of ['approve all but Bo Li', 'approve all, but not Bo Li', 'approve all, Bo Li can wait', 'approve all minus Bo Li']) {
    const H = setup({ attendees: `${TWO}Drop Tables,CIO,Initech,drop@initech.test\n` });
    triage(H);
    const { gate } = draftApprove(H, NOW, answers);
    assert.ok(gate.ERROR, answers);
    assert.doesNotMatch(readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8'), /"type":"approved"/, answers);
  }
});

test('C4: a damaged event.json stops only itself', () => {
  const H = setup({ attendees: TWO });
  mkdirSync(join(H.HOME, 'events', 'other'), { recursive: true });
  writeFileSync(join(H.HOME, 'events', 'other', 'event.json'), '{not json');
  const r = spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__notes__search_x', tool_input: {} }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // A damaged mock's lists stay closed all the same.
  writeFileSync(join(H.HOME, 'events', 'other', 'contact-list.json'), JSON.stringify([{ id: 'c001', name: 'Ana Berg', email: 'ana@acme.test' }]));
  inHome(H, () => assert.deepEqual(listed('contact-list.json'), []));
});

test('C5: a remark about someone addressed only by id still holds "approve all"', () => {
  for (const answers of ['approve all, not Edit Kovacs', 'approve all without Edit']) {
    const H = setup({ attendees: `${TWO}Edit Kovacs,CIO,Initech,edit@initech.test\n` });
    triage(H);
    const { gate } = draftApprove(H, NOW, answers);
    assert.ok(gate.ERROR, answers);
    assert.doesNotMatch(readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8'), /"type":"approved"/, answers);
  }
});

test('C9: an answer the simple reading would get backwards is asked again', () => {
  for (const t of ['skip all but Globex', 'skip all of them except Globex', 'skip everything other than Globex', 'skip Acme but research Globex', 'go but skip Acme', 'yes, skip Acme', 'ok but not Acme', 'skip nothing', "don't skip Acme", 'no, go ahead'])
    assert.equal(unclearSkip(t), true, t);
  for (const t of ['go', 'yes', 'skip Globex, the rest is fine', 'skip Acme, people: none', 'skip all', 'skip the news', 'skip company research, and people: none', 'go, and people: none', 'go, skip the people', 'no', 'skip all research'])
    assert.equal(unclearSkip(t), false, t);
});

test('C5: names built from words of the answer never rewrite it', () => {
  assert.deepEqual(gatePeople([{ id: 'c1', name: 'Drop: Tables' }, { id: 'c2', name: 'Drop, Tables' }, { id: 'c3', name: 'Ana Drop' }, { id: 'c4', name: 'All Except' }, { id: 'c5', name: 'Bo Li' }]), [{ id: 'c3', name: 'Ana' }, { id: 'c5', name: 'Bo Li' }]);
});

test('C9: the words of the question never name a company', () => {
  const listed = ['Companies', 'All', 'News', 'Acme', 'Ai', 'People', 'None', 'People.ai'];
  for (const t of ['skip companies', 'skip all', 'skip the news', 'no, skip the news', 'skip all of them', 'skip all please', 'skip research for all companies', 'skip news please', 'skip all research', 'skip company research', 'skip companies, people: none', 'skip companies, people: top 5', 'skip the people', 'skip news.', 'no'])
    assert.deepEqual(namedCompanies(t, listed), [], t);
  assert.deepEqual(namedCompanies('skip Acme', listed), ['Acme']);
  assert.deepEqual(namedCompanies('skip Acme and News', listed), ['News', 'Acme']);
  assert.deepEqual(namedCompanies('skip what he said', listed), [], 'a name counts whole, never inside a word');
  assert.deepEqual(namedCompanies('skip Acme, people: all', listed), ['Acme']);
  assert.deepEqual(namedCompanies('skip Acme, people: none', listed), ['Acme']);
  assert.deepEqual(namedCompanies('skip People.ai', listed), ['People.ai']);
  assert.deepEqual(namedCompanies('skip People, Acme', listed), ['Acme', 'People']);
  for (const t of ['skip all for now', 'skip news today', 'skip companies and people', 'skip companies and news']) assert.deepEqual(namedCompanies(t, listed), [], t);
  assert.deepEqual(namedCompanies('skip People Data Labs', ['People Data Labs', 'Globex']), ['People Data Labs']);
  assert.deepEqual(namedCompanies('skip People All Stars', ['People All Stars', 'Globex']), ['People All Stars']);
});

const ODD = 'Name,Title,Company,Email\nAna Berg,COO,Companies,ana@companies.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Oh,COO,News,cy@news.test\n';
test('C9: "skip companies" with a company called Companies is a skip of them all; "all but" is asked again', { timeout: 300000 }, () => {
  const H = makeHome({ context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' }, attendees: ODD });
  const asked = [];
  const persona = simplePersona({
    asks: {
      setup_level: 'standard',
      research_scale: 'none',
      attendee_list: join(H.HOME, 'inputs', 'attendees.csv'),
      company_research: (s) => {
        asked.push(...s.ask.companies);
        const f = join(H.HOME, 'work', 'all-but.txt');
        writeFileSync(f, 'skip all but Globex');
        assert.match(simCli(H, 'flow', ['answer', '--event', s.event, '--ask', 'company_research', '--value-file', f]).ERROR || '', /Name the companies/);
        return 'skip companies';
      }
    }
  });
  const { trail, slug } = drive(H, persona, { maxSteps: 200 });
  assert.ok(asked.includes('Companies') && asked.includes('Globex'), asked.join(' '));
  assert.ok(!trail.includes('company_briefs'), 'no web research');
  assert.match(readFileSync(join(H.HOME, 'events', slug, 'ledger.jsonl'), 'utf8'), /"ask":"company_research","value":"skip"/);
});

test('C9: "skip the news" with a company called News skips the news for every company', { timeout: 300000 }, () => {
  const H = makeHome({ context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' }, attendees: ODD });
  const persona = simplePersona({ asks: { setup_level: 'standard', attendee_list: join(H.HOME, 'inputs', 'attendees.csv'), research_scale: 'none' } });
  const { slug } = drive(H, persona, { maxSteps: 200 });
  const f = join(H.HOME, 'work', 'booked.json');
  writeFileSync(f, JSON.stringify({ items: [{ who: 'Cy Oh', what: 'booked', time: '2026-11-10 10:00', said: 'ten works' }, { who: 'Bo Li', what: 'booked', time: '2026-11-10 11:00', said: 'eleven works' }] }));
  assert.ok(!simCli(H, 'event-outreach', ['record', '--event', slug, '--file', f]).ERROR);
  const s = simCli(H, 'flow', ['next', '--event', slug, '--agenda']);
  assert.equal(s.step, 'agenda_news_ok', JSON.stringify(s).slice(0, 300));
  assert.ok(s.ask.companies.includes('News') && s.ask.companies.includes('Globex'), JSON.stringify(s.ask.companies));
  const a = join(H.HOME, 'work', 'agenda-news.txt');
  writeFileSync(a, 'skip the news');
  const r = simCli(H, 'flow', ['answer', '--event', slug, '--ask', 'agenda_news', '--value-file', a]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.deepEqual([...r.result.skipped].sort(), [...s.ask.companies].sort());
});
