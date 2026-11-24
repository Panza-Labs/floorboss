// From the first live cloud send (2026-11-20: three emails sent and delivered, SPF/DKIM/DMARC pass):
// 1. the Codex Gmail tool hard-wraps text/plain at about 70 characters, so the body goes as HTML built from the
//    approved text (escaped, a paragraph per blank-line block, a <br> for each single line break), a pure function of
//    it; the approval hash and the release stay bound to the plain text;
// 2. the three went within seconds and landed in spam: the run waits 20 to 40 seconds between sends (a wait step),
//    the gap fixed by the person's id, not random;
// 3. the cloud workspace keeps files between runs: each run clones into a fresh mktemp -d folder (RUN).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { world, remoteFor, cloneOf, pastProfile, PEOPLE, NOW, ROOT } from './fixtures/autosend-world.mjs';
import { searchResult, sendResult, written } from './fixtures/gmail-real.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { approvalHash } from '../lib/sendcheck.mjs';
import * as sr from '../lib/autosend/sendrecord.mjs';
import * as drv from '../skills/autosend/scripts/driver.mjs';
import { taskPrompt } from '../skills/autosend/scripts/cli.mjs';

const at = (iso) => Date.parse(iso);
const ITEM = { slug: 'harbor-expo', id: 'c001', touch: 1, to: 'ana@north.example', subject: 'At Harbor Expo', body: 'Hi', hash: 'a'.repeat(24) };
const html = (body) => sr.sendArgs({ ...ITEM, body }).payload.body.content;

test('live 1: the body goes as HTML, one mime type constant', () => {
  assert.equal(sr.BODY_MIME, 'text/html');
  const a = sr.sendArgs({ ...ITEM, body: 'Hi Ana,\n\nOne long paragraph that would be wrapped by the tool.\n\nBest,\nSam' });
  assert.deepEqual(a.payload, { mime_type: 'text/html', charset: 'UTF-8', body: { content: '<p>Hi Ana,</p>\n<p>One long paragraph that would be wrapped by the tool.</p>\n<p>Best,<br>Sam</p>' } });
});

test('live 1: escaping, paragraphs, the sign-off and the opt-out line on their own lines, nothing made a link', () => {
  assert.equal(html('<script>alert("x")</script> & &amp; \'q\''), '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &amp;amp; &#39;q&#39;</p>');
  assert.equal(html('One.\n\n\nTwo.\n \nThree.'), '<p>One.</p>\n<p>Two.</p>\n<p>Three.</p>');
  assert.equal(html('Thanks,\nGary\n\nNot for you? Reply "no" and I won\'t write again.'), '<p>Thanks,<br>Gary</p>\n<p>Not for you? Reply &quot;no&quot; and I won&#39;t write again.</p>');
  assert.equal(html('Hi\r\n\r\nBest,\r\nSam\r\n'), '<p>Hi</p>\n<p>Best,<br>Sam</p>');
  const link = html('See https://harbor.example/agenda or www.harbor.example');
  assert.ok(!/<a\b|href|style|<img/i.test(link), link);
  assert.equal(link, '<p>See https://harbor.example/agenda or www.harbor.example</p>');
});

test('live 1: the same input gives the same args; the hash and release stay on the plain text', () => {
  const body = 'Hi Ana,\n\nTuesday?\n\nBest,\nSam';
  assert.deepEqual(sr.sendArgs({ ...ITEM, body }), sr.sendArgs({ ...ITEM, body }));
  assert.equal(JSON.stringify(sr.sendArgs({ ...ITEM, body })), JSON.stringify(sr.sendArgs({ ...ITEM, body })));
  const hash = approvalHash({ channel: 'email', subject: ITEM.subject, body }, ITEM.to);
  assert.notEqual(approvalHash({ channel: 'email', subject: ITEM.subject, body: html(body) }, ITEM.to), hash, 'the hash is of the plain text');
});

// 2. The gap between sends.
const cloudEnv = (HOME, now) => {
  const env = { ...process.env, FLOORBOSS_TEST: '1', FLOORBOSS_HOME: HOME, FLOORBOSS_NOW: now, FLOORBOSS_AUTOSEND: 'cloud', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.CLAUDECODE;
  for (const k of ['CODEX_SESSION_ID', 'CODEX_THREAD_ID']) delete env[k];
  return env;
};
const CLI = join(ROOT, 'skills/autosend/scripts/cli.mjs');
function cloud(HOME, now, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: cloudEnv(HOME, now), encoding: 'utf8' });
  if (r.status !== 0) return { ERROR: String(r.stderr || r.stdout).slice(0, 1500) };
  return JSON.parse(r.stdout);
}
const thenOf = (HOME, now, s) => cloud(HOME, now, s.then.slice(s.then.indexOf(CLI) + 1));

test('live 2: the gap is 20 to 40 seconds, fixed by the id', () => {
  assert.equal(typeof drv.sendGapMs, 'function');
  const ids = Array.from({ length: 50 }, (_, i) => `c${String(i).padStart(3, '0')}`);
  for (const id of ids) {
    const g = drv.sendGapMs(id);
    assert.ok(g >= 20000 && g <= 40000, `${id}: ${g}`);
    assert.equal(drv.sendGapMs(id), g);
  }
  assert.ok(new Set(ids.map(drv.sendGapMs)).size > 5, 'not one value for all');
});

test('live 2: after a send, the next person waits for the gap before their search', () => {
  const w = world({ touches: 1, people: PEOPLE.slice(0, 2) });
  process.env.FLOORBOSS_HOME = w.HOME;
  const rb = readback(w.evDir, at(NOW));
  approve(w.evDir, { digest: rb.digest, said: '1' }, at(NOW));
  const { bare } = remoteFor(w.HOME);
  const X = cloneOf(bare, 'g');
  const t0 = '2026-10-12T09:00:00Z';
  const call = (now) => (a) => cloud(X, now, a);
  let s = pastProfile(cloud(X, t0, ['next', '--run', 'new']), call(t0));
  assert.equal(s.step, 'search');
  writeFileSync(s.write, written(searchResult()));
  assert.equal(thenOf(X, t0, s).checked, 'go');
  s = cloud(X, t0, ['next', '--run', s.run]);
  assert.equal(s.step, 'send');
  writeFileSync(s.write, written(sendResult({ id: 'm1', thread_id: 't1' })));
  assert.equal(thenOf(X, t0, s).recorded, 'sent');
  const run = s.run;
  // Straight after: wait, with the seconds, and a then that is next again.
  const t1 = '2026-10-12T09:00:05Z';
  const wt = cloud(X, t1, ['next', '--run', run]);
  assert.equal(wt.step, 'wait', JSON.stringify(wt).slice(0, 300));
  assert.ok(wt.seconds >= 15 && wt.seconds <= 40, String(wt.seconds));
  assert.ok(Number.isInteger(wt.seconds));
  assert.ok(!('then' in wt), 'no then: the model runs next again, as after every step');
  assert.match(wt.say, /sleep/);
  // Once the gap went by: the search.
  const t2 = new Date(at(t0) + 41000).toISOString();
  assert.equal(cloud(X, t2, ['next', '--run', run]).step, 'search');
});

// 3. A fresh folder per run.
test('live 3: the task clones into a new mktemp -d folder each run, and names no ./floorboss or ./data', () => {
  const task = readFileSync(join(ROOT, 'codex/autosend-task.md'), 'utf8');
  const p = taskPrompt({ sha: 'f'.repeat(40), dataRepo: 'someone/fb-data' });
  for (const t of [task, p]) {
    assert.match(t, /mktemp -d/);
    assert.match(t, /RUN\/floorboss/);
    assert.match(t, /RUN\/data/);
    assert.ok(!/\.\/floorboss|\.\/data/.test(t), 'no ./ paths left');
    assert.match(t, /never set\s+this in RUN\/data's own git config/);
    assert.match(t, /never edit any file\s+in RUN\/data/);
    assert.match(t, /Never reuse an older folder/i);
    assert.match(t, /never delete anything/i);
    assert.match(t, /wait: run `sleep/);
  }
});
