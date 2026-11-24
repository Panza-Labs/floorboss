// With whole sequences (sending on), a person whose later message is stuck after its rewrites, and left by the user
// ("leave them for now"), is not offered at the approval: the approval would refuse the rest of their sequence and ask
// the same question again forever. The others are approved on the same screen, one plain line says who waits and for
// which message, the flow finishes in a few steps, and once the stuck message is dropped the person comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPECS } from './sims/varied/specs.mjs';
import { buildPersona } from './sims/lib/generated.mjs';
import { drive, cli } from './sims/lib/driver.mjs';

const BASE = SPECS.find((s) => s.id === 'crm-connected-drops');
const SPEC = { ...BASE, id: 'stuck-later-step', gen: { ...BASE.gen, n: 12 }, connected: ['send'], faults: undefined, toolDown: undefined };

const ledger = (P) => readFileSync(join(P.H.HOME, 'events', P.per.slug, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const approved = (P, id) => [...new Set(ledger(P).filter((x) => x.type === 'approved' && (!id || x.id === id)).map((x) => `${x.id}:${x.touch}`))];

function stuckRun() {
  const P = buildPersona(SPEC);
  let target = null;
  const draft = P.per.judge.draft;
  // One person's last message always has a placeholder left in it, so floorboss's checks fail it every time.
  P.per.judge.draft = (todo, ids, reasons) =>
    draft(todo, ids, reasons).map((d) => {
      const last = Math.max(...todo.jobs.filter((j) => j.id === d.id && j.kind === 'message').map((j) => j.touch));
      if (!target && d.touch > 1 && d.touch === last) target = { id: d.id, touch: d.touch };
      return target && d.id === target.id && d.touch === target.touch ? { ...d, body: `${d.body}\n\n{{first name}}` } : d;
    });
  const told = [], offered = [];
  const r = drive(P.H, P.per, { maxSteps: 200, onStep: (s) => {
    if (s.tell_user) told.push(s.tell_user);
    if (s.step === 'approve') offered.push(...s.run_first[s.run_first.indexOf('--ids') + 1].split(','));
  } });
  P.per.slug = r.slug;
  return { P, r, target, told, offered };
}

test('a stuck later step left for now: the flow finishes, the others are approved, one line says who waits for which message; dropped, they come back', { timeout: 1200000 }, () => {
  const { P, r, target, told, offered } = stuckRun();
  assert.ok(target, 'a later message was made to fail');
  assert.ok(r.last.done || ['waiting', 'second_yes'].includes(r.last.step), r.trail.slice(-8).join(' → '));
  assert.ok(r.trail.includes('stuck_drafts'), r.trail.join(' '));
  assert.ok(r.trail.filter((x) => x === 'approve').length <= 2, `the approval came back: ${r.trail.join(' ')}`);
  // Everyone else's whole sequence went through the same approval; nothing of the waiting person's did.
  assert.deepEqual(approved(P, target.id), []);
  assert.ok(!offered.some((x) => x.startsWith(`${target.id}:`)), `offered: ${offered.join(',')}`);
  const others = [...new Set(offered)];
  assert.ok(others.length >= 4, JSON.stringify(others));
  assert.deepEqual(others.filter((x) => !approved(P).includes(x)), [], 'every other message on that screen was approved');
  const line = told.find((t) => new RegExp(`held until .*\\(${target.id}:${target.touch}\\) is rewritten or dropped`).test(t));
  assert.ok(line, `one plain line names the person and the message: ${JSON.stringify(told.slice(-4))}`);
  // Dropped by the user, the person's sequence (without it) comes back to the approval, and is approved.
  const f = join(P.H.HOME, 'drop.txt');
  writeFileSync(f, `drop ${target.id}:${target.touch}`);
  const env = Object.fromEntries(Object.entries(P.H.env).filter(([k]) => k !== 'FLOORBOSS_OUT_OF_TURN'));
  const a = cli({ ...P.H, env }, 'flow', ['answer', '--event', P.per.slug, '--ask', 'approve_held', '--value-file', f]);
  assert.ok(!a.ERROR, a.ERROR);
  const seen = [];
  const r2 = drive(P.H, P.per, { maxSteps: 120, onStep: (s) => s.step === 'approve' && seen.push(s.run_first.join(' ')) });
  assert.ok(r2.last.done || ['waiting', 'second_yes'].includes(r2.last.step), r2.trail.slice(-8).join(' → '));
  assert.ok(seen.some((x) => x.includes(`${target.id}:1`)), `back at the approval: ${JSON.stringify(seen)}`);
  assert.ok(approved(P, target.id).includes(`${target.id}:1`), JSON.stringify(approved(P, target.id)));
});
