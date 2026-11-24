// 0.1.7: floorboss never sends on LinkedIn, at the send check too: a LinkedIn item in a hand-written browser send list
// is refused, and LinkedIn alone never turns browser sending on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setup, triage, draftApprove, idOf, NOW } from './fixtures/harness.mjs';
import { verifySend, channelOn, eventRecord } from '../lib/sendcheck.mjs';

test('channelOn: LinkedIn alone is no browser sending', () => {
  assert.equal(channelOn({ sending: { channels: ['linkedin'] } }, 'browser'), false);
  assert.equal(channelOn({ sending: { channels: ['app'] } }, 'browser'), true);
});

test('a LinkedIn item written into browser-send-list.json by hand is refused at the send check', () => {
  const S = { sending: { channels: ['app', 'linkedin'], followups: 'scheduled', linkedin_ack: true }, route: ['linkedin', 'email'] };
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: S });
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  const item = { id: ana, touch: 1, via: 'browser', where: 'LinkedIn', to: 'https://www.linkedin.com/in/ana', body: 'Hi Ana' };
  mkdirSync(join(H.dir, 'derived'), { recursive: true });
  writeFileSync(join(H.dir, 'derived', 'browser-send-list.json'), JSON.stringify([item]));
  const [listed] = JSON.parse(readFileSync(join(H.dir, 'derived', 'browser-send-list.json'), 'utf8'));
  const r = verifySend(listed, { evDir: H.dir, settings: S, ...eventRecord(H.dir), nowMs: Date.parse(NOW) });
  assert.deepEqual([r.ok, r.why], [false, 'floorboss never sends on LinkedIn: you send this one yourself']);
});
