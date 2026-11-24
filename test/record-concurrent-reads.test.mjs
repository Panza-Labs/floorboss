// A file floorboss reads while another command replaces it (every write is a new file renamed over the old one,
// lib/jsonio.mjs writeText) is read again, never a random "changed while floorboss read it" failure. And `record`
// takes who is held from its own view in memory, not from derived/resolved.json, which another record command
// rewrites at the same moment. (Four record commands at once at one event: one exited 1 with no output, about every
// other run of test/outbox-rebuilt.test.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, triage, draftApprove, idOf, NOW, ROOT } from './fixtures/harness.mjs';
import { readJson } from '../lib/jsonio.mjs';

// A process that replaces `path` with its own current contents, over and over, as floorboss writes it (a new file
// renamed over the old one), until it is killed. Resolves once it has made its first swap.
function swapper(path, tmp) {
  const code = `
    const { readFileSync, writeFileSync, renameSync } = require('node:fs');
    const [path, tmp] = process.argv.slice(1);
    let n = 0;
    for (;;) {
      let text;
      try { text = readFileSync(path); } catch { continue; }
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, path);
      if (++n === 1) process.stdout.write('go\\n');
    }`;
  const p = spawn(process.execPath, ['-e', code, path, tmp], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((res) => p.stdout.once('data', () => res(p)));
}
const stop = (p) => new Promise((res) => (p.exitCode !== null ? res() : (p.once('exit', res), p.kill('SIGKILL'))));

const file = (H, name, o) => {
  const f = join(H.dir, `${name}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(f, JSON.stringify(o));
  return f;
};
const recordAsync = (H, items) =>
  new Promise((res) => {
    const p = spawn(process.execPath, [join(ROOT, 'skills/event-outreach/scripts/cli.mjs'), 'record', '--event', H.slug, '--file', file(H, 'rec.json', { items })], {
      env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => res({ code, out, err }));
  });

test('a JSON file replaced again and again while it is read: every read returns it whole, none fails', async () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const f = join(H.dir, 'derived-like.json');
  const value = { people: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`c${i}`, { group: 'reach', says: 'x'.repeat(40) }])) };
  writeFileSync(f, JSON.stringify(value));
  const p = await swapper(f, join(H.HOME, 'swap.tmp'));
  const failed = [];
  try {
    const until = Date.now() + 1500;
    let reads = 0;
    while (Date.now() < until || reads < 2000) {
      reads++;
      try {
        assert.deepEqual(readJson(f, null), value);
      } catch (e) {
        failed.push(e.message);
      }
    }
  } finally {
    await stop(p);
  }
  assert.deepEqual(failed.slice(0, 3), [], `${failed.length} reads failed`);
});

test('"added" after "cut", while derived/resolved.json is being replaced: every record succeeds, and adds them back', async () => {
  const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nSigne Dahl,Ops Lead,All Nordic,signe@allnordic.test\nCy Ruiz,Head of Ops,Initech,cy@initech.test\n';
  const H = setup({ attendees: LIST });
  triage(H);
  draftApprove(H);
  const names = ['Ana Berg', 'Bo Li', 'Signe Dahl', 'Cy Ruiz'];
  const ids = names.map((n) => idOf(H, n));
  const p = await swapper(join(H.dir, 'derived', 'resolved.json'), join(H.HOME, 'swap.tmp'));
  try {
    for (let t = 0; t < 6; t++) {
      for (const what of ['cut', 'added']) {
        // One command per person, all at once, and one command naming all four (heldWhy is asked once per person).
        const rs = await Promise.all([
          ...names.map((who) => recordAsync(H, [{ who, what, reason: 'x' }])),
          recordAsync(H, names.map((who) => ({ who, what, reason: 'x' })))
        ]);
        for (const r of rs) assert.equal(r.code, 0, `round ${t} (${what}): ${r.err.trim() || r.out.slice(0, 300)}`);
      }
    }
  } finally {
    await stop(p);
  }
  // Added back: all four on the shortlist again.
  const ranked = JSON.parse(readFileSync(join(H.dir, 'derived', 'shortlist.json'), 'utf8')).ranked;
  for (const id of ids) assert.ok(ranked.includes(id), `${id} added back`);
});
