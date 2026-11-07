// A path the user types with "~/" is read from their home folder, as a shell would: the attendee list, the CRM
// export, the do-not-contact file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setup, ROOT, NOW } from './fixtures/harness.mjs';
import { expandHome } from '../lib/paths.mjs';

test('expandHome: "~/x" is in the home folder; other paths are as typed', () => {
  assert.equal(expandHome('~/Downloads/list.csv'), join(homedir(), 'Downloads/list.csv'));
  assert.equal(expandHome('  ~/a.csv '), join(homedir(), 'a.csv'));
  assert.equal(expandHome('~'), homedir());
  assert.equal(expandHome('/tmp/a.csv'), '/tmp/a.csv');
  assert.equal(expandHome('~other/a.csv'), '~other/a.csv', 'another user\'s home is not guessed');
  assert.equal(expandHome(undefined), undefined);
});

test('a "~/" path answers the attendee-list, CRM-export and do-not-contact questions', () => {
  const H = setup({});
  // The user's home folder for the scripts (a temp folder, never the real one).
  const userHome = mkdtempSync(join(tmpdir(), 'fb-userhome-'));
  mkdirSync(join(userHome, 'Downloads'));
  writeFileSync(join(userHome, 'Downloads', 'list.csv'), 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n');
  writeFileSync(join(userHome, 'Downloads', 'crm.csv'), 'Name,Company,Email,Owner,Status,Opted Out\nAna Berg,Acme,ana@acme.test,Sam Rivera,Customer,no\n');
  writeFileSync(join(userHome, 'Downloads', 'dnc.txt'), 'bo@globex.test\n');
  const env = { ...process.env, HOME: userHome, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW };
  const answer = (ask, value) => { const f = join(H.HOME, 'work', `${ask}.txt`); mkdirSync(join(H.HOME, 'work'), { recursive: true }); writeFileSync(f, value); return JSON.parse(execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'answer', '--event', H.slug, '--ask', ask, '--value-file', f], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); };
  answer('attendee_list', '~/Downloads/list.csv');
  assert.ok(existsSync(join(H.dir, 'inputs', 'attendees.csv')));
  answer('crm_export', '~/Downloads/crm.csv');
  assert.ok(existsSync(join(H.dir, 'inputs', 'crm.csv')));
  answer('dnc', '~/Downloads/dnc.txt');
  assert.ok(existsSync(join(H.dir, 'inputs', 'dnc.txt')));
});
