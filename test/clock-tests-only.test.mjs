// floorboss's clock moves (FLOORBOSS_NOW, --now, --now-file) only under its own tests: set in a session's
// environment it could date a reply check, a send window or a pause into the future or the past.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { movedNow, nowMs } from '../lib/clock.mjs';
import { parseArgs } from '../lib/args.mjs';

const withEnv = (vars, fn) => { const old = { ...process.env }; Object.assign(process.env, vars); for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; try { return fn(); } finally { process.env = old; } };

test('FLOORBOSS_NOW is ignored outside floorboss\'s tests', () => {
  withEnv({ FLOORBOSS_TEST: undefined, FLOORBOSS_NOW: '2030-01-01T00:00:00Z' }, () => {
    assert.equal(movedNow(), null);
    assert.ok(Math.abs(nowMs() - Date.now()) < 5000, 'the real time');
  });
  withEnv({ FLOORBOSS_TEST: '1', FLOORBOSS_NOW: '2030-01-01T00:00:00Z' }, () => assert.equal(nowMs(), Date.parse('2030-01-01T00:00:00Z')));
});

test('--now and --now-file are refused outside floorboss\'s tests', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'fb-now-')), 'now.txt');
  writeFileSync(f, '2030-01-01T00:00:00Z');
  withEnv({ FLOORBOSS_TEST: undefined }, () => {
    assert.throws(() => parseArgs(['x', '--now', '2030-01-01T00:00:00Z']), /tests only/);
    assert.throws(() => parseArgs(['x', '--now-file', f]), /tests only/);
  });
});
