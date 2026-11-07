import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeProfile, hasProfile, readProfile } from '../skills/attendee-research/scripts/profiles.mjs';
import { estimate, pickForResearch } from '../skills/attendee-research/scripts/estimate.mjs';
import { collectPrompt, CSV_HEADER } from '../skills/attendee-research/scripts/collect-prompt.mjs';
import { contextCheck, parseSegments, parseProof, parseInsights, insightCap, insightBudget } from '../skills/event-context/scripts/context-check.mjs';

test('profiles: claims without a URL are rejected; resume skips existing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-'));
  const c = { id: 'c001', name: 'Marta Ribeiro', title: 'VP Ops', company: 'Northwind' };
  const r = writeProfile(dir, c, { claims: [{ text: 'Opened a Rotterdam hub', url: 'https://example.com/news' }, { text: 'Likes golf' }, { text: 'x', url: 'javascript:alert(1)' }] });
  assert.deepEqual([r.kept, r.rejected, r.identity_confirmed, r.complete], [1, 2, false, true], 'identity is unconfirmed unless research says so');
  assert.ok(hasProfile(dir, 'c001'));
  assert.match(readProfile(dir, 'c001'), /Rotterdam hub \[https:\/\/example.com\/news\]/);
  assert.equal(pickForResearch(['c001', 'c002', 'c003'], { scale: 'all', has: (id) => hasProfile(dir, id) }).join(), 'c002,c003');
});

test('estimate and research picks', () => {
  assert.deepEqual(estimate(30), { contacts: 30, minutes: 15, searches: 120 });
  assert.deepEqual(pickForResearch(['a', 'b', 'c', 'd'], { scale: 'top', n: 2, warm: ['d'] }), ['d', 'a', 'b']);
  assert.deepEqual(pickForResearch(['a', 'b', 'c'], { scale: 'cap', n: 2 }), ['a', 'b']);
  assert.throws(() => pickForResearch([], { scale: 'lots' }));
});

test('collection prompt: event, everyone captured (no filter), header, rules, cap, save path, shown total, reminder', () => {
  const p = collectPrompt({
    event: { name: 'Retail Expo', city: 'Chicago', start_date: '2026-11-03', end_date: '2026-11-05' },
    listUrl: 'https://retailexpo.example/attendees',
    segments: [{ name: 'Category buyers', who: 'titles containing buyer, category manager or merchandising at grocery retailers' }],
    mustMeet: ['Dana Wu'], savePath: '/srv/fb/.floorboss/events/retail-expo/attendees.csv',
  });
  for (const s of ['Retail Expo', 'https://retailexpo.example/attendees', 'Dana Wu', CSV_HEADER, 'Read only', 'Never visit LinkedIn', 'captcha', '5000 rows', 'attendees.csv', 'attendees.meta.json', 'shown_total', "Don't filter", "platform's terms"]) {
    assert.ok(p.includes(s), s);
  }
  assert.ok(!p.includes('category manager'), 'segments are not a collection filter');
});

const WHO = `# Who to meet
## Segment: Ops leaders
- **Who:** VP or Director of Operations at freight and logistics companies
- **Ask:** 30-minute meeting
- **Research sources:** company news, conference talks
## Segment: Procurement
- **Who:** heads of procurement at shippers
`;
const BRING = `# What you bring
| claim | source | segments | named | date |
|---|---|---|---|---|
| Cut carrier onboarding from 9 days to 4 | https://example.com/case | ops-leaders | yes | 2026-05 |
| Saved a top-10 retailer 12% on freight | internal | ops-leaders | no | 2026-02 |
`;

test('context check: segments, proof by segment, anonymous proofs, missing pieces', () => {
  const segs = parseSegments(WHO);
  assert.deepEqual(segs.map((s) => [s.slug, s.ask]), [['ops-leaders', '30-minute meeting'], ['procurement', null]]);
  assert.equal(parseProof(BRING).length, 2);
  const r = contextCheck({ whoToMeet: WHO, whatYouBring: BRING, voice: 'tone: direct' });
  assert.deepEqual(r.problems, []);
  const n = r.notes.join(' | ');
  assert.match(n, /No proof points for the Procurement segment/);
  assert.match(n, /1 proof point\(s\) are anonymous/);
  assert.match(n, /no sign-off/);
  assert.match(n, /Procurement" has no ask/);
  const four = WHO + '## Segment: A\n- **Who:** a\n## Segment: B\n- **Who:** b\n';
  assert.match(contextCheck({ whoToMeet: four, whatYouBring: BRING, voice: 'sign-off: Sam' }).problems[0], /limit is 3/);
});

test('insights: numbered, depth note under 10, budget warns per segment when spread thin', () => {
  const row = (i, seg) => `| Insight ${i} | internal | ${seg} | growth |`;
  const table = (rows) => `${BRING}\n| insight | basis | segments | situations |\n|---|---|---|---|\n${rows.join('\n')}\n`;
  const six = table([1, 2, 3, 4, 5].map((i) => row(i, 'ops-leaders')).concat(row(6, 'procurement')));
  const ins = parseInsights(six);
  assert.deepEqual(ins.map((x) => x.id), ['I1', 'I2', 'I3', 'I4', 'I5', 'I6']);
  assert.match(contextCheck({ whoToMeet: WHO, whatYouBring: six, voice: 'sign-off: Sam' }).notes.join(' | '), /has 6 insights .* aim for 10–15/);
  const ten = table(Array.from({ length: 10 }, (_, i) => row(i + 1, 'ops-leaders, procurement')));
  assert.ok(!/aim for 10–15/.test(contextCheck({ whoToMeet: WHO, whatYouBring: ten, voice: 'sign-off: Sam' }).notes.join(' | ')));
  assert.deepEqual([1, 3, 4, 25, 40].map(insightCap), [1, 1, 1, 6, 10]);
  const batch = [...Array.from({ length: 20 }, (_, i) => ({ id: `o${i}`, segment: 'ops-leaders' })), ...Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, segment: 'procurement' }))];
  const b = insightBudget(ins, batch, { 'ops-leaders': 'Ops leaders', procurement: 'Procurement' });
  assert.equal(b.cap, 6);
  assert.equal(b.notes.length, 2);
  assert.match(b.notes[0], /^5 insights for 20 Ops leaders contacts: expect repetition\./);
  assert.match(b.notes[1], /^1 insight for 5 Procurement contacts: expect repetition\. More rows/);
  const one = insightBudget(ins.slice(0, 1), batch.slice(0, 20).concat(batch.slice(0, 5)));
  assert.match(one.notes[0], /^1 insight for 25 ops-leaders contacts: .* at most 6, so about 19 of them will get a question instead/);
  assert.deepEqual(insightBudget(parseInsights(ten), batch).notes, []);
});
