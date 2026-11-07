// Quick setup says what it takes as given (working alone, no CRM, no samples) and asks before any web research:
// "skip" gives each shortlisted company a "not researched" brief, and no researcher is started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, drive, simplePersona, cli, ROOT } from './sims/lib/driver.mjs';
import { levelOptions } from '../skills/event-context/scripts/onboarding-tree.mjs';

const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n';

test('quick setup: the option says what it assumes', () => {
  const quick = levelOptions({ inv: { found: {} }, ans: {} })[0];
  assert.match(quick, /^quick/);
  assert.match(quick, /work alone/);
  assert.match(quick, /no CRM/);
  assert.match(quick, /no writing samples/);
  assert.match(quick, /asks before any web research/);
});

test('quick setup: asks before researching companies; "skip" starts no researcher and says so in each brief', { timeout: 300000 }, () => {
  const H = makeHome({ context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' }, attendees: LIST });
  const persona = simplePersona({ asks: { setup_level: 'quick', company_research: 'skip company research', attendee_list: join(H.HOME, 'inputs', 'attendees.csv') } });
  const agents = [];
  const { trail, slug } = drive(H, persona, { onStep: (s) => { if (s.agents) agents.push(...s.agents.map((a) => a.name)); } });
  assert.ok(trail.includes('company_research'), trail.join(' '));
  assert.ok(!trail.includes('company_briefs'), 'no web research after "skip"');
  assert.ok(!agents.includes('floorboss:attendee-researcher'), agents.join(' '));
  assert.ok(trail.indexOf('company_research') < trail.indexOf('draft'), 'asked before drafting');
  const dir = join(H.HOME, 'events', slug, 'companies');
  const briefs = readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(briefs.length >= 1);
  for (const f of briefs) {
    const md = readFileSync(join(dir, f), 'utf8');
    assert.match(md, /Not researched/, f);
    assert.doesNotMatch(md, /from the CRM/, 'no CRM here, so the brief never says "from the CRM"');
  }
  assert.match(readFileSync(join(H.HOME, 'events', slug, 'ledger.jsonl'), 'utf8'), /"ask":"company_research","value":"skip"/);
  // The README's "Where your data lives" names what a run leaves, and a run leaves what it names.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8').split('## Where your data lives')[1].split('\n## ')[0];
  const cfg = JSON.parse(readFileSync(join(H.HOME, 'config.json'), 'utf8'));
  for (const f of ['config.json', 'onboarding.json', 'inventory.json', `context/${cfg.context_profile}`]) assert.ok(existsSync(join(H.HOME, f)), f);
  for (const f of ['config.json', 'onboarding.json', 'inventory.json', 'context/<name>/']) assert.ok(readme.includes(`\`${f}\``), `README names ${f}`);
  for (const f of ['event.json', 'slots.json', 'inputs', 'sources', 'ledger.jsonl', 'companies', 'drafts', 'outbox.html', 'derived', 'work']) {
    assert.ok(existsSync(join(H.HOME, 'events', slug, f)), `a run leaves ${f}`);
    assert.ok(readme.includes(`\`${f}\``) || readme.includes(`\`${f}/\``), `README names ${f}`);
  }
});

test('quick setup: choosing it says back what it assumes', () => {
  const H = makeHome();
  writeFileSync(join(H.HOME, 'work', 'level.txt'), 'quick');
  const r = cli(H, 'flow', ['answer', '--ask', 'setup_level', '--value-file', join(H.HOME, 'work', 'level.txt')]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.match(r.result.assumes, /work alone.*no CRM.*no writing samples.*asks before any web research/s);
});
