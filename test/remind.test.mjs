// The reminder hook reads the view floorboss rebuilds (derived/), so naming a shortlisted person reminds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveEvents, reminder } from '../hooks/remind.mjs';

test('remind: names come from derived/shortlist.json and derived/contacts.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-remind-'));
  const ev = join(dir, 'ev');
  mkdirSync(join(ev, 'derived'), { recursive: true });
  writeFileSync(join(ev, 'event.json'), JSON.stringify({ name: 'Test Expo', start_date: '2026-11-10', end_date: '2026-11-12' }));
  writeFileSync(join(ev, 'derived', 'shortlist.json'), JSON.stringify({ ranked: ['c001'], coordinate: [] }));
  writeFileSync(join(ev, 'derived', 'contacts.json'), JSON.stringify([{ id: 'c001', name: 'Tomas Rivera' }, { id: 'c002', name: 'Omar Bell' }]));
  const events = liveEvents(dir, Date.parse('2026-11-01T00:00:00Z'));
  assert.deepEqual(events[0].names, ['tomas rivera']);
  assert.ok(reminder('Tomas moved it to Monday', events));
  assert.ok(!reminder('Omar says hi', events));
});
