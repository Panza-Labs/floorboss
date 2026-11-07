// The batch check agrees with the insight cap: an insight quoted as written, in no more drafts than the cap
// allows, isn't "a shared sentence". When a sentence is shared, only the drafts to rewrite are named. And the
// same subject with the same first line in two drafts fails, however small the batch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBatch, checkInsights } from '../skills/event-outreach/scripts/sameness.mjs';

const INSIGHT = 'Most hospitals pay demand charges on a single fifteen minute peak each month.';
const NAMES = ['Ana Berg', 'Bo Li', 'Cy Ng', 'Dee Ho', 'Eli Fox', 'Fay Wu', 'Gus Orr', 'Hal Ito', 'Ivy Roe', 'Jon Kai', 'Kim Lo', 'Lu Pye'];
const OPEN = ['Your chillers run late on Sundays.', 'Night shifts change the load curve.', 'The new wing doubles the cooling load.', 'Two of your sites share one meter.', 'Your boiler retrofit lands in March.', 'Campus steam lines lose heat in winter.', 'Office occupancy dropped on Fridays.', 'Cold rooms cycle at odd hours.', 'Lab buildings never sleep.', 'Parking decks run lights all night.', 'Your solar array is south facing.', 'Kitchens drive the morning peak.'];
const draft = (i, { insight = false, subject = `Subject ${i}`, first = null } = {}) => ({
  id: `c${String(i + 1).padStart(3, '0')}`, subject,
  body: `Hi ${NAMES[i].split(' ')[0]},\n\n${first || OPEN[i]} ${insight ? INSIGHT : `A plain line number ${i} about ${['meters', 'tariffs', 'audits', 'boilers', 'peaks', 'loads', 'chillers', 'pumps', 'fans', 'lights', 'panels', 'valves'][i]} and what we see.`} Could we talk for 20 minutes at Midwest Expo?\n\nThanks, Jess`,
  contact: { name: NAMES[i], company: `Co ${i}` }, company_key: `co-${i}`, slotLabels: [],
});
const ctx = { eventName: 'Midwest Expo', signoff: 'Thanks, Jess', insights: [INSIGHT], insightCap: 3 };

test('an insight quoted in as many drafts as the cap allows is not a shared sentence', () => {
  const drafts = NAMES.slice(0, 10).map((_, i) => draft(i, { insight: i < 3 }));
  const out = analyzeBatch(drafts, ctx);
  assert.ok(!out.reasons.some((r) => /share the sentence/.test(r)), out.reasons.join(' | '));
  // The same insight without the cap given (or over it) is shared, and only the drafts to rewrite are named.
  const over = analyzeBatch(NAMES.slice(0, 12).map((_, i) => draft(i, { insight: i < 4 })), { ...ctx, insightCap: 3 });
  const r = over.reasons.find((x) => /share the sentence/.test(x));
  assert.match(r, /^4 of 12 drafts share the sentence ".*": rewrite it in c002, c003, c004$/);
});

test('the insight cap reason names only the drafts to move', () => {
  const ds = ['c1', 'c2', 'c3'].map((id) => ({ id, insight: 'I1' }));
  const r = checkInsights(ds, { insights: [{ id: 'I1' }], cap: 2 }).reasons[0];
  assert.match(r, /I1 is in 3 drafts \(c1, c2, c3\); the limit is 2\. Move 1 of them .*: rewrite c3$/);
});

test('two drafts with the same subject and first line fail, naming the one to rewrite', () => {
  const drafts = NAMES.slice(0, 12).map((_, i) => draft(i, i === 4 || i === 9 ? { subject: 'Quick question', first: 'How do you track the monthly peak today?' } : {}));
  const out = analyzeBatch(drafts, ctx);
  assert.equal(out.verdict, 'FAIL');
  assert.ok(out.reasons.some((x) => x === 'c005, c010 have the same subject and first line ("how do you track monthly peak today"): rewrite the opening of c010' || /^c005, c010 have the same subject and first line \(".*"\): rewrite the opening of c010$/.test(x)), out.reasons.join(' | '));
  // Different subjects, or different first lines: no such reason.
  const ok = analyzeBatch(NAMES.slice(0, 12).map((_, i) => draft(i)), ctx);
  assert.ok(!ok.reasons.some((x) => /same subject/.test(x)), ok.reasons.join(' | '));
});
