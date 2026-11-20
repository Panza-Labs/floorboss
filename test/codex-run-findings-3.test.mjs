// Round 3 of the gpt-run fixes: the outbox page's own CRM log CSV (built in the browser by the page's script) keeps a
// formula-like cell as text by the same rule as lib/csv.mjs toCsv.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';
import { toCsv } from '../lib/csv.mjs';

// The page's escape function, taken from the script the page carries, and run here as the browser would run it.
function pageEsc() {
  const html = renderOutbox({ event: { name: 'Test Expo', slug: 'ev', start_date: '2026-11-10', end_date: '2026-11-12', time_zone: 'Europe/Amsterdam' }, cards: [], counts: {}, generatedAt: 'x' });
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const m = /var esc = (function\(v\)\{[\s\S]*?\});\n/.exec(script);
  assert.ok(m, 'the page builds its CSV with an esc function');
  return new Function(`return (${m[1]});`)();
}

test("the outbox page's CRM log CSV: the same formula rule as lib/csv.mjs", () => {
  const esc = pageEsc();
  const cells = ['=1+1', '+1', '-1', '@cmd', '\tx', '\rx', '\nx', ' =1+1', '  +SUM(A1)', '\n=1', '　=1', '＝SUM(A1)', '＋1', '－1', '＠cmd', ' ＝1', 'Acme Freight', '2026-11-10', 'a=b', 'Hi, there', 'say "hi"', ''];
  for (const v of cells) assert.equal(esc(v), toCsv(['a'], [{ a: v }]).split('\n').slice(1).join('\n').replace(/\n$/, ''), JSON.stringify(v));
  // And each formula-like one starts with the quote that keeps it text.
  for (const v of [' =1+1', '\n=1', '＝SUM(A1)', '＋1', '－1', '＠cmd']) assert.match(esc(v), /^"?'/, JSON.stringify(v));
});
