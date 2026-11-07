// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// The outreach commands that never read the times work whatever slots.json holds: the slot lookup is built
// only when a command asks for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, triage, cli } from './fixtures/harness.mjs';

test('a slots.json without a slots list stops only the commands that read the times', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  triage(H);
  for (const content of ['{"free_times":"x"}', '[{"id":"s1","start":"2026-11-10T09:00:00Z"}]']) {
    writeFileSync(join(H.dir, 'slots.json'), content);
    assert.equal(cli(H, 'event-outreach', ['tool-failed', '--event', H.slug, '--task', 'x', '--error', 'y']).recorded, true, content);
    assert.ok(!cli(H, 'event-outreach', ['summary', '--event', H.slug]).ERROR, content);
  }
});
