// The disclaimer is shown word for word wherever a command shows it, and the commands describe the run lock
// with the same window the code uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_LOCK_MINUTES } from '../lib/runlock.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

// The quoted block right after the disclaimer marker, exactly as written (the "> " prefixes included).
function disclaimer(file) {
  const lines = read(file).split('\n');
  const at = lines.findIndex((l) => l.startsWith('<!-- disclaimer:'));
  assert.ok(at >= 0, `${file} has no disclaimer marker`);
  const quote = [];
  for (const l of lines.slice(at + 1)) { if (!l.startsWith('>')) break; quote.push(l); }
  assert.ok(quote.length > 0, `${file} has no quoted disclaimer after its marker`);
  return quote.join('\n');
}

test('disclaimer: start.md shows exactly the text in event-setup.md step 1', () => {
  const setup = disclaimer('commands/event-setup.md');
  assert.match(setup, /Nothing here is legal\n> advice\./);
  assert.equal(disclaimer('commands/start.md'), setup);
  assert.doesNotMatch(read('commands/start.md'), /show it as in/, 'start.md quotes the text instead of pointing at it');
  for (const f of ['commands/start.md', 'commands/event-setup.md']) assert.match(read(f), /character for character/, f);
});

test('disclaimer: the config read needs only Node (no jq)', () => {
  for (const f of readdirSync(join(ROOT, 'commands'))) {
    const s = read(join('commands', f));
    assert.doesNotMatch(s.replace(/don't pipe it into jq[^.;)]*/g, ''), /\bjq\b/, f);
    if (/disclaimer_ack/.test(s)) assert.match(s, /config --get disclaimer_ack/, f);
  }
});

test('run lock: every command clears it at the end and names the window the code uses', () => {
  for (const f of readdirSync(join(ROOT, 'commands'))) {
    const s = read(join('commands', f)).replace(/\s+/g, ' ');
    assert.match(s, /scripts\/cli\.mjs" run-end`/, `${f} runs run-end`);
    assert.match(s, new RegExp(`lapses on its own ${RUN_LOCK_MINUTES} minutes`), `${f} names ${RUN_LOCK_MINUTES} minutes`);
    assert.match(s, /stays held to reads.*until it ends.*`\/clear` or a new session lifts them/, `${f} says the session stays held`);
    assert.doesNotMatch(s, /delete [^ ]*active\.json/, `${f} never tells Claude to delete the lock`);
  }
  const code = read('lib/runlock.mjs') + read('lib/args.mjs') + read('hooks/guard.mjs');
  assert.doesNotMatch(code, /last hour|3 \* 60 \* 60|three hours/i, 'no other window named in the code');
});

test('disclaimer: the flow shows the same words as one plain paragraph (no quote marks, no broken lines)', async () => {
  const { DISCLAIMER } = await import('../skills/flow/scripts/steps.mjs');
  const quoted = disclaimer('commands/start.md').split('\n').map((l) => l.replace(/^>\s?/, '')).join(' ').replace(/\s+/g, ' ').trim();
  assert.equal(DISCLAIMER, quoted);
  assert.doesNotMatch(DISCLAIMER, />|\n/);
});
