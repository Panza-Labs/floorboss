// 0.1.7: the sending question always ends with "nowhere: I'll send them myself", however many tools are connected
// (it showed at most four answers, so a mailbox, an event app, a chat app and a browser cut it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NODES } from '../skills/event-context/scripts/onboarding-tree.mjs';

const node = (id) => NODES.find((n) => n.id === id);
const ALL = { ev: { app_name: 'Grip' }, cfg: {}, ans: {}, inv: { found: { email: ['mcp:gmail'], chat: ['mcp:whatsapp'], browser: ['mcp:claude-in-chrome'] } } };

test('with a mailbox, an event app, a chat app and a browser connected, "nowhere: I\'ll send them myself" is still offered, last', () => {
  const opts = node('sending').options(ALL);
  assert.equal(opts.at(-1), "nowhere: I'll send them myself", JSON.stringify(opts));
  assert.ok(opts.some((o) => /^email/.test(o)) && opts.some((o) => /^Grip/.test(o)), JSON.stringify(opts));
  for (const found of [{}, { email: ['x'] }, { browser: ['x'] }, { chat: ['x'] }, { email: ['x'], browser: ['x'] }])
    assert.equal(node('sending').options({ ...ALL, inv: { found } }).at(-1), "nowhere: I'll send them myself", JSON.stringify(found));
});

