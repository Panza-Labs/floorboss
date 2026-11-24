// F2 at the CRM task check (hooks/guard/check.mjs): a task listed before a do-not-contact hold is refused when it is
// called, never asked; a task for someone with no hold is unchanged. Invented people at .test domains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, idOf, NOW, ROOT } from './fixtures/harness.mjs';

// F2 at the CRM task check: a task listed before the hold is refused at the guard when it is called.
const TASKCFG = { connectors: { 'crm.create_task': { server: 'crm-a', tool: 'create_task', reading: 'the id it returns', tool_hash: 'f'.repeat(64), test_draft: { draft_id: 't-test', user_confirmed: true }, args: { properties: { hs_task_subject: '{title}', hs_task_body: '{body}', hs_timestamp: '{due}' }, associations: [{ to: { id: '{contact_ref}' } }] } } } };
function taskWorld() {
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,,https://www.linkedin.com/in/ana-berg-test\nBo Free,COO,Freeco,,https://www.linkedin.com/in/bo-free-test\n', event: { app_name: 'Brella' } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify(TASKCFG));
  triage(H);
  draftApprove(H);
  const items = JSON.parse(readFileSync(cli(H, 'event-outreach', ['task-list', '--event', H.slug]).file, 'utf8'));
  return { H, items };
}
const taskCall = (H, it) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], {
    input: JSON.stringify({ tool_name: 'mcp__crm-a__create_task', tool_input: { properties: { hs_task_subject: it.title, hs_task_body: it.body, hs_timestamp: it.due }, associations: [{ to: { id: it.contact_ref || '' } }] }, session_id: 's1' }),
    env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW },
    encoding: 'utf8'
  });
test('F2: a CRM task listed before the hold is refused at the guard; a task for someone with no hold is unchanged', () => {
  const { H, items } = taskWorld();
  const ana = idOf(H, 'Ana Berg'), bo = idOf(H, 'Bo Free');
  const itA = items.find((x) => x.id === ana && x.kind === 'send');
  const itB = items.find((x) => x.id === bo && x.kind === 'send');
  assert.ok(itA && itB, JSON.stringify(items.map((x) => [x.id, x.kind])));
  const before = taskCall(H, itB);
  mkdirSync(join(H.dir, 'work'), { recursive: true });
  const p = join(H.dir, 'work', 'dnc.txt');
  writeFileSync(p, 'Ana Berg\n');
  cli(H, 'crm-triage', ['inputs', '--event', H.slug, '--kind', 'dnc', '--file', p]);
  assert.ok(!cli(H, 'crm-triage', ['load', '--event', H.slug]).ERROR);
  const g = taskCall(H, itA);
  assert.equal(g.status, 2, g.stdout + g.stderr);
  assert.match(g.stderr, /this task is for someone floorboss can't write to now \(they are on your do-not-contact list: floorboss does not write to them on any channel, and nothing was sent\)\. No task was created\./);
  const after = taskCall(H, itB);
  assert.equal(after.status, before.status);
  assert.equal(after.stdout, before.stdout);
});
