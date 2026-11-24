// Round 3 (a simulated beginner Codex run): the readback holds a sequence that isn't whole; a missed first message
// is re-planned; said-files never stop the sync; save-company takes the skill's own no-results reply; a booking holds
// an auto-send message offering its time; `on` says plainly when the data isn't in a repo; plain words for the user;
// auto-send's news before the replies question. (The flow end to end: test/sims/codex-autosend.test.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { world, approvedLines, addLines, ledgerLines, git, autosend, said, PEOPLE, NOW, ROOT } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { dueNow } from '../lib/autosend/plan.mjs';
import { TIME_TAKEN } from '../lib/autosend/common.mjs';
import { writeCompanyBrief } from '../skills/attendee-research/scripts/companies.mjs';
import { HAND_SEND_ASKS } from '../skills/flow/scripts/steps/wording.mjs';
import { autosendNews } from '../skills/flow/scripts/steps/replies.mjs';

const at = (iso) => Date.parse(iso);
const AUTO_PICK = '1'; // the user's pick: 1, approve and send automatically
function approved(opts = {}) {
  const w = world({ touches: 2, ...opts });
  process.env.FLOORBOSS_HOME = w.HOME;
  const r = readback(w.evDir, at(NOW));
  approve(w.evDir, { digest: r.digest, said: AUTO_PICK }, at(NOW));
  return w;
}
const waitOf = (r, id) => r.waits.find((w) => w.id === id)?.why || '';

test('item 1: the readback holds anyone whose planned sequence is not all written and approved', () => {
  const w = world({ touches: 1 });
  process.env.FLOORBOSS_HOME = w.HOME;
  const ev = JSON.parse(readFileSync(join(w.evDir, 'event.json'), 'utf8'));
  writeFileSync(join(w.evDir, 'event.json'), JSON.stringify({ ...ev, settings: { ...ev.settings, touches: 2 } }));
  const r = readback(w.evDir, at(NOW));
  assert.equal(r.items.length, 0);
  assert.equal(r.refused.length, 3);
  for (const x of r.refused) assert.match(x.why, /message 2 of their sequence isn't written and approved yet: run flow next/);
});

test('item 2: a first message whose day and the day after went by is offered again with a new day; a fresh yes makes it due', () => {
  const w = approved();
  assert.match(waitOf(dueNow(w.HOME, at('2026-10-15T09:00:00Z')), 'c001'), /more than a day ago/);
  const rb = readback(w.evDir, at('2026-10-15T08:30:00Z'));
  assert.equal(new Set(rb.items.map((x) => x.id)).size, 3);
  assert.equal(rb.items.find((x) => x.id === 'c001' && x.touch === 1).planned_day, '2026-10-15');
  // It was the user's on the outbox meanwhile: the yes needs their word it wasn't sent by hand (round 4, item 1).
  assert.throws(() => approve(w.evDir, { digest: rb.digest, said: AUTO_PICK }, at('2026-10-15T08:30:00Z')), /If you sent it yourself, tell me 'sent'/);
  approve(w.evDir, { digest: rb.digest, said: AUTO_PICK, notSentSaid: "I didn't send them" }, at('2026-10-15T08:30:00Z'));
  assert.deepEqual(dueNow(w.HOME, at('2026-10-15T09:00:00Z')).due.map((x) => x.id), ['c001', 'c002', 'c003']);
  // Still in its window: nothing to re-plan.
  const w2 = approved();
  assert.equal(readback(w2.evDir, at('2026-10-13T08:30:00Z')).items.length, 0);
});

test('item 3: setup step 1 (init), a said-file in work/, then sync start: the said-file never reaches the repo and never stops the sync', () => {
  const w = approved();
  const base = mkdtempSync(join(tmpdir(), 'fb-as-remote-'));
  const bare = join(base, 'data.git');
  git(base, ['init', '--bare', '-q', '-b', 'main', bare]);
  const init = autosend(w.HOME, ['init', '--remote', bare]);
  assert.ok(!init.ERROR, init.ERROR);
  assert.equal(init.pushed, true, JSON.stringify(init));
  assert.ok(existsSync(join(w.HOME, '.gitignore')));
  const f = said(w.HOME, 'yes it is private, the token is for that repo only');
  assert.ok(f.includes(join(w.HOME, 'work')));
  const s = autosend(w.HOME, ['sync', 'start', '--who', 'laptop', '--run', 'laptop-1']);
  assert.equal(s.started, true, JSON.stringify(s));
  assert.deepEqual(autosend(w.HOME, ['sync', 'end', '--run', 'laptop-1']), { ok: true });
  const tree = git(bare, ['ls-tree', '-r', '--name-only', init.branch]).split('\n').filter(Boolean);
  assert.ok(tree.includes('events/harbor-expo/ledger.jsonl') && tree.includes('config.json'));
  assert.ok(!tree.some((p) => p.startsWith('work/')), tree.join(' '));
  // A second init refuses: it is a checkout already.
  assert.match(autosend(w.HOME, ['init', '--remote', bare]).ERROR || '', /checkout already/);
});

test('item 5: save-company takes the skill\'s own no-results reply when web search is off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-as-co-'));
  mkdirSync(join(dir, 'companies'), { recursive: true });
  // The skill's words for web search off (SKILL.md, agents/attendee-researcher.md): exactly this.
  assert.equal(writeCompanyBrief(dir, 'Iron Ridge', { nothing_found: true, searched: [] }).saved, false, 'an empty list alone is no search');
  const r = writeCompanyBrief(dir, 'Iron Ridge', { nothing_found: true, searched: [], search_off: true });
  assert.equal(r.saved, true, JSON.stringify(r));
  assert.equal(r.nothing_found, true);
  const r2 = writeCompanyBrief(dir, 'Harbor Arms', { nothing_found: true, searched: ['harbor arms retail'] });
  assert.equal(r2.saved, true);
  assert.equal(writeCompanyBrief(dir, 'Nobody', { nothing_found: true }).saved, false, 'no searched list at all is not the reply');
  const skill = readFileSync(join(ROOT, '.agents/skills/floorboss/SKILL.md'), 'utf8');
  assert.ok(skill.includes('`{"nothing_found": true, "searched": [], "search_off": true}`'));
  assert.ok(readFileSync(join(ROOT, 'agents/attendee-researcher.md'), 'utf8').includes('{"nothing_found": true, "searched": [], "search_off": true}'));
});

test('item 6: an auto-send message offering a time someone else booked is held, never sent offering it', () => {
  // As the real code writes it: the text by saveDraft, the time it offers on its drafted line, then both approvals.
  const w = world({ touches: 2 });
  process.env.FLOORBOSS_HOME = w.HOME;
  writeFileSync(join(w.evDir, 'slots.json'), JSON.stringify({ slots: [{ id: 's20261103-1000', start: '2026-11-03T10:00:00Z', end: '2026-11-03T10:30:00Z' }] }));
  addLines(w.evDir, approvedLines(w.evDir, PEOPLE[0], 1, { at: '2026-10-12T07:30:00Z', extra: ' Tuesday at 10:00 suits?', slot_ids: ['s20261103-1000'] }).lines);
  const rb = readback(w.evDir, at(NOW));
  approve(w.evDir, { digest: rb.digest, said: '1' }, at(NOW));
  assert.ok(dueNow(w.HOME, at('2026-10-12T09:00:00Z')).due.some((x) => x.id === 'c001'));
  addLines(w.evDir, [{ at: '2026-10-12T08:30:00Z', type: 'booked', who: 'user', id: 'c002', slot: 's20261103-1000', start: '2026-11-03T10:00:00Z', blocks: ['s20261103-1000'], said: 'Bo booked Tuesday 10:00' }]);
  const r = dueNow(w.HOME, at('2026-10-12T09:00:00Z'));
  assert.ok(!r.due.some((x) => x.id === 'c001'));
  assert.equal(waitOf(r, 'c001'), TIME_TAKEN);
});

test('item 7: on, with the data folder not yet a repo, says plainly to do setup step 1', () => {
  const w = world({ touches: 2 });
  const r = autosend(w.HOME, ['on', '--event', 'harbor-expo', '--said-file', said(w.HOME, 'yes')]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.pushed, null);
  assert.match(r.say, /your data isn't in a repo yet: do setup step 1 first/i);
});

test('item 9: the skill lets floorboss run setup step 1 (init) on the user\'s yes, and the agent never runs git itself', () => {
  const skill = readFileSync(join(ROOT, '.agents/skills/floorboss/SKILL.md'), 'utf8');
  const part = skill.slice(skill.indexOf('## Auto-send from the cloud'));
  assert.match(part, /on their yes, run `init --remote https:\/\/github\.com\/<you>\/<repo>`/);
  assert.match(part, /setup step 1 included \(`init`\)/);
  assert.match(part, /that is the user's to type, never yours/);
});

test('item 10: plain words: the sign-off question has no agent note in hand-send; the rate question says what the rules are; auto-send news opens the replies question', () => {
  const q = HAND_SEND_ASKS.about_you.question({});
  assert.ok(!/propose|never suggest/i.test(q), q);
  assert.match(HAND_SEND_ASKS.about_you.how, /never suggest a name/);
  // In hand-send the rate question says what the rules are; Claude Code's words stay as at 8e9f440
  // (test/autosend-round5.test.mjs pins both).
  const drafting = readFileSync(join(ROOT, 'skills/flow/scripts/steps/drafting.mjs'), 'utf8');
  assert.match(drafting, /handSend\(\) \? 'and floorboss keeps them as rules for how you write/);
  const people = { c001: { name: 'Ana Ito' }, c002: { name: 'Bo Li' }, c003: { name: 'Cy Moss' } };
  const e = (entries) => ({ event: { autosend: true }, entries, state: { people } });
  assert.equal(autosendNews(e([])), null);
  const lines = [
    { type: 'answered', ask: 'replies_since' },
    { type: 'sent', source: 'autosend', id: 'c001' },
    { type: 'replied', source: 'autosend', id: 'c002' },
    { type: 'send_unclear', who: 'floorboss', id: 'c003' }
  ];
  assert.equal(autosendNews(e(lines)), "Since last time, auto-send sent 1 message (Ana Ito); stopped Bo Li (a reply, a bounce or an out-of-office in your Gmail); couldn't tell whether Cy Moss's message went: check your Sent folder.");
  assert.equal(autosendNews(e([...lines, { type: 'answered', ask: 'replies_since' }])), null, 'only since the last answer');
  assert.equal(autosendNews({ ...e(lines), event: { autosend: false } }), null);
  void PEOPLE;
});
