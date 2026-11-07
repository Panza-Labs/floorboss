// The yes to the disclaimer during the mock stays with the mock: the user's own config never gets it, and the
// real start asks again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MOCK, run, loadMock, home, answer } from './fixtures/r2.mjs';

test('mock: the disclaimer ack goes to the mock\'s own settings; the real start asks for it again', () => {
  const HOME = home();
  loadMock(HOME);
  const s = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.equal(s.step, 'disclaimer', JSON.stringify(s).slice(0, 200));
  const r = answer(HOME, 'disclaimer', 'ok');
  assert.ok(!r.ERROR, r.ERROR);
  const cfg = existsSync(join(HOME, 'config.json')) ? JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8')) : {};
  assert.notEqual(cfg.disclaimer_ack, true, 'the real config has no ack');
  assert.equal(JSON.parse(readFileSync(join(HOME, 'events', MOCK, 'event.json'), 'utf8')).settings.disclaimer_ack, true);
  const next = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.notEqual(next.step, 'disclaimer', 'the mock goes on');
  const real = run(HOME, 'flow', ['next', '--new-run']);
  assert.equal(real.step, 'disclaimer', JSON.stringify(real).slice(0, 200));
});
