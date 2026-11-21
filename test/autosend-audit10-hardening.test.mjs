// Security audit run 10, hardening notes taken up: git's words keep a password that holds '@' out of a stop text;
// a send answer that says it failed, or is a draft, is unclear rather than sent; Codex's data-folder rule doesn't
// adopt a floorboss/ folder another account could have made directly under a shared temp folder, nor count a marker
// that is a link; and the readback shows a person's name on one line, without bidi controls. Temp folders only;
// addresses are .example; nothing is sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { world, addLines, ledgerLines, PEOPLE, NOW } from './fixtures/autosend-world.mjs';
import { readback } from '../lib/autosend/approval.mjs';
import { record } from '../lib/autosend/sendrecord.mjs';
import { redact } from '../lib/autosend/sync.mjs';
import { projectHome } from '../lib/paths.mjs';

const at = (iso) => Date.parse(iso);
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));

test('redact: a URL password holding "@" is hidden whole', () => {
  const t = redact('fatal: unable to access https://sam:p@ss@w0rd@git.example/sam/data.git/: 403');
  assert.doesNotMatch(t, /p@ss|w0rd|ss@/);
  assert.match(t, /https:\/\/\*\*\*@git\.example\/sam\/data\.git/);
  assert.doesNotMatch(redact('x-access-token:ab@cd@git.example'), /ab@|cd@/);
});

test('a send answer with status failed, or labelled DRAFT, is unclear, never sent', () => {
  for (const answer of [{ id: 'm1', threadId: 't1', status: 'failed' }, { id: 'm1', threadId: 't1', labelIds: ['DRAFT'] }, { message: { id: 'm1', threadId: 't1', labelIds: ['DRAFT'] } }]) {
    const w = world({ touches: 1, people: [PEOPLE[0]] });
    process.env.FLOORBOSS_HOME = w.HOME;
    const a = ledgerLines(w.evDir).find((e) => e.type === 'approved');
    const item = { slug: w.slug, id: 'c001', touch: 1, hash: a.hash, to: a.to };
    addLines(w.evDir, [{ at: NOW, type: 'autosend_released', who: 'floorboss', id: 'c001', touch: 1, hash: a.hash, to: a.to, run: 'r1' }]);
    const r = record(w.evDir, item, JSON.stringify(answer), 'r1', at(NOW) + 1000);
    assert.ok(r.unclear, JSON.stringify(answer));
    assert.ok(!ledgerLines(w.evDir).some((e) => e.type === 'sent'), JSON.stringify(answer));
  }
  // A plain answer is still recorded sent.
  const w = world({ touches: 1, people: [PEOPLE[0]] });
  process.env.FLOORBOSS_HOME = w.HOME;
  const a = ledgerLines(w.evDir).find((e) => e.type === 'approved');
  addLines(w.evDir, [{ at: NOW, type: 'autosend_released', who: 'floorboss', id: 'c001', touch: 1, hash: a.hash, to: a.to, run: 'r1' }]);
  assert.equal(record(w.evDir, { slug: w.slug, id: 'c001', touch: 1, hash: a.hash, to: a.to }, JSON.stringify({ id: 'm1', threadId: 't1', labelIds: ['SENT'] }), 'r1', at(NOW) + 1000).sent, true);
});

test('a marker that is a link does not make a floorboss/ folder up the tree the data folder', () => {
  const userHome = tmp('fb-a10-ph-');
  const project = join(userHome, 'work', 'acme');
  const sub = join(project, 'sub');
  mkdirSync(join(project, 'floorboss'), { recursive: true });
  mkdirSync(sub, { recursive: true });
  const elsewhere = join(userHome, 'elsewhere.json');
  writeFileSync(elsewhere, '{}');
  symlinkSync(elsewhere, join(project, 'floorboss', 'config.json'));
  assert.equal(projectHome({ cwd: sub, userHome }), join(sub, 'floorboss'));
  // A real marker is taken, as before.
  rmSync(join(project, 'floorboss', 'config.json'));
  writeFileSync(join(project, 'floorboss', 'config.json'), '{}');
  assert.equal(projectHome({ cwd: sub, userHome }), join(project, 'floorboss'));
});

test('a folder directly under /tmp that others can write to is no project; one only this account can write to is', { skip: process.platform === 'win32' || !existsSync('/tmp') }, () => {
  const userHome = tmp('fb-a10-home-');
  const shared = mkdtempSync('/tmp/fb-a10-shared-');
  chmodSync(shared, 0o777);
  try {
    assert.equal(projectHome({ cwd: shared, userHome }), null);
    assert.equal(projectHome({ cwd: join(shared, 'deeper'), userHome }) === join(shared, 'floorboss'), false);
    chmodSync(shared, 0o700);
    assert.equal(projectHome({ cwd: shared, userHome }), join(shared, 'floorboss'));
  } finally {
    rmSync(shared, { recursive: true, force: true });
  }
});

test('the readback shows a name on one line, without bidi controls', () => {
  const w = world({ touches: 1, people: [{ ...PEOPLE[0], name: 'Ana Ito\n  Message 1, planned for Monday 1 January‮txt.exe' }] });
  process.env.FLOORBOSS_HOME = w.HOME;
  const r = readback(w.evDir, at(NOW));
  assert.ok(r.items.length, JSON.stringify(r.refused));
  assert.doesNotMatch(r.text, /[‪-‮⁦-⁩‎‏]/);
  assert.ok(!r.text.split('\n').some((l) => l.trim() === 'Message 1, planned for Monday 1 January'), r.text);
  assert.match(r.text.split('\n')[0], /^Ana Ito/);
});
