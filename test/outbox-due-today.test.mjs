// 0.1.7, without a CRM (and always in Codex): the outbox page opens with "Due today", every by-hand message due today
// or overdue, each with the name, the profile link, a Copy button for its text and the Sent tick. The page says plainly
// that a tick is recorded only once the user pastes the status into the chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';

const EVENT = { slug: 'ev', name: 'Test Expo', city: 'Rotterdam', start_date: '2026-11-10', end_date: '2026-11-12', time_zone: 'Europe/Amsterdam' };
const base = { kind: 'message', channel: 'paste', where: 'LinkedIn', title: 'COO', company: 'Acme', verdict: { verdict: 'PASS', reasons: [] }, slots: [] };
const cards = [
  { ...base, id: 'c001', touch: 1, name: 'Ana Berg', profile_url: 'https://www.linkedin.com/in/ana', body: 'Hi Ana, first note.' },
  { ...base, id: 'c002', touch: 2, name: 'Bo Li', profile_url: 'https://www.linkedin.com/in/bo', body: 'Hi Bo, overdue note.', due_on: '2026-10-10' },
  { ...base, id: 'c003', touch: 2, name: 'Cy Ode', profile_url: 'https://www.linkedin.com/in/cy', body: 'Hi Cy, later note.', due_on: '2026-10-20' },
  { ...base, id: 'c004', touch: 2, name: 'Di Fox', profile_url: 'https://www.linkedin.com/in/di', body: 'Waits.', due_waits: true },
  { ...base, id: 'c005', touch: 1, name: 'Ed <b>Gray</b>', profile_url: 'https://www.linkedin.com/in/ed"><script>x</script>', body: 'Hi </pre><script>alert(1)</script>' },
  { ...base, id: 'c006', touch: 1, name: 'Fay Hu', channel: 'email', where: undefined, address: 'fay@x.test', subject: 's', body: 'An email.' }
];
const page = () => renderOutbox({ event: EVENT, generatedAt: 'now', today: '2026-10-12', cards, counts: {}, slots: [], visit: [] });
const dueSection = (html) => {
  const m = /<section[^>]*id="dueToday"[^>]*>([\s\S]*?)<\/section>/.exec(html);
  assert.ok(m, 'there is a Due today section');
  return m[1];
};

test('"Due today" comes first on the page, before the messages', () => {
  const html = page();
  assert.ok(html.indexOf('id="dueToday"') > 0 && html.indexOf('id="dueToday"') < html.indexOf('<h2>Messages'));
  assert.match(dueSection(html), /<h2>Due today, Mon 12 Oct \(3\)<\/h2>/);
});

test('it lists each by-hand message due today or overdue, not one due later, one whose day is not known, or an email', () => {
  const s = dueSection(page());
  assert.match(s, /Ana Berg/);
  assert.match(s, /Bo Li/);
  assert.match(s, /overdue since Sat 10 Oct/);
  assert.doesNotMatch(s, /Cy Ode|Di Fox|Fay Hu/);
});

test('each one has its profile link, a Copy button for its text, and the Sent tick', () => {
  const s = dueSection(page());
  const item = /<div class="dueitem" data-id="c001" data-touch="1"[\s\S]*?(?=<div class="dueitem"|$)/.exec(s);
  const t = item[0];
  assert.match(t, /href="https:\/\/www\.linkedin\.com\/in\/ana"/);
  assert.match(t, /<button type="button" class="copy" data-copy="c001-t1-due">Copy message<\/button>/);
  assert.match(t, /<pre id="c001-t1-due">Hi Ana, first note\.<\/pre>/);
  assert.match(t, /<input type="checkbox" data-tick="sent"> Sent/);
});

test('every value from the list is escaped, and a link that is not a LinkedIn profile is not shown', () => {
  const s = dueSection(page());
  assert.doesNotMatch(s, /<script>|<b>Gray/);
  assert.match(s, /Ed &lt;b&gt;Gray&lt;\/b&gt;/);
  assert.match(s, /&lt;\/pre&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('the page says in one plain sentence that ticks count only once the status is pasted into the chat, here and by Copy status', () => {
  const html = page();
  const line = "Ticks stay on this page until you press Copy status and paste it into the chat: only then does floorboss record them.";
  assert.ok(dueSection(html).includes(line));
  const bar = /<div class="bar">([\s\S]*?)<\/div>/.exec(html)[1];
  assert.ok(bar.includes(line), bar);
});

test('nothing due: no section', () => {
  const html = renderOutbox({ event: EVENT, generatedAt: 'now', today: '2026-10-12', cards: [cards[2]], counts: {}, slots: [], visit: [] });
  assert.doesNotMatch(html, /id="dueToday"/);
});
