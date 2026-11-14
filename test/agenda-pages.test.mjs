// The agenda's pages (agenda.html, agenda.md, agenda.ics), which the attended agenda and the brief that builds
// itself both render: ordinary input comes out as it always did, and text nobody should be steered by (a link that
// isn't a web address, a bidi override, a zero-width character, a control character) can't reach the reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderHtml, renderMarkdown, renderIcs, validatePoints } from '../skills/event-outreach/scripts/agenda.mjs';
import { data, points } from './fixtures/agenda-golden/data.mjs';

const GOLD = new URL('./fixtures/agenda-golden/', import.meta.url).pathname;
const gold = (f) => readFileSync(join(GOLD, f), 'utf8');
const unfold = (ics) => ics.replace(/\r\n /g, '');
const noStamp = (ics) => ics.replace(/DTSTAMP:\d{8}T\d{6}Z/g, 'DTSTAMP:x');
const clone = (x) => JSON.parse(JSON.stringify(x));

test('agenda pages: ordinary facts and talking points render exactly as before', () => {
  const v = validatePoints(data, points);
  assert.deepEqual(v.errors, []);
  assert.equal(renderHtml(data, v.points), gold('agenda.html'));
  assert.equal(renderMarkdown(data, v.points), gold('agenda.md'));
  assert.equal(unfold(noStamp(renderIcs(data, v.points, { minutes: 30 }))), gold('agenda.ics'), 'the calendar file, its long lines unfolded');
});

test('agenda.ics: no line is over 75 bytes, a character of several bytes is never split, and unfolding gives the text back', () => {
  const d = clone(data);
  d.meetings[0].person.name = 'Zoë Ünsal-Çelik 山田太郎 ' + 'é'.repeat(60);
  d.meetings[0].place = '会議室 '.repeat(30);
  const v = validatePoints(d, points);
  const ics = renderIcs(d, v.points, { minutes: 30 });
  const lines = ics.split('\r\n');
  assert.ok(lines.some((l) => l.startsWith(' ')), 'long lines are folded');
  for (const l of lines) {
    assert.ok(Buffer.byteLength(l) <= 75, `${Buffer.byteLength(l)} bytes: ${l.slice(0, 30)}`);
    assert.doesNotMatch(l, /\ufffd/, 'no broken character');
    assert.match(l, /^( |BEGIN:|END:|VERSION:|PRODID:|UID:|DTSTAMP:|DTSTART:|DTEND:|SUMMARY:|LOCATION:|DESCRIPTION:|$)/, l.slice(0, 40));
  }
  const whole = unfold(ics);
  assert.ok(whole.includes(`SUMMARY:${d.meetings[0].person.name} (Acme & Sons)`));
  assert.ok(whole.includes(`LOCATION:${d.meetings[0].place}`));
  assert.equal((whole.match(/BEGIN:VEVENT/g) || []).length, 2);
});

test('agenda pages: a news link is a link only when it is a plain web address', () => {
  const bad = ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', ' https://example.test/x', 'https://example.test/a b', 'https://example.test/"onmouseover="x', 'vbscript:x', '//example.test/x', '', null, 42, 'HTTPS://EXAMPLE.TEST/ok'];
  for (const url of bad) {
    const d = clone(data);
    d.meetings[0].news = [{ text: 'Acme opened a hub', url }];
    const html = renderHtml(d, new Map());
    const md = renderMarkdown(d, new Map());
    assert.match(html, /<li>Acme opened a hub/, 'the item is still shown');
    if (url === 'HTTPS://EXAMPLE.TEST/ok') {
      assert.match(html, /<a href="HTTPS:\/\/EXAMPLE\.TEST\/ok">source<\/a>/);
      continue;
    }
    assert.doesNotMatch(html, /<a /, `no link for ${JSON.stringify(url)}`);
    assert.doesNotMatch(html, /javascript:|data:text|file:\/\/|vbscript:/);
    assert.match(md, /^- New: Acme opened a hub$/m, `no address in the short version for ${JSON.stringify(url)}`);
  }
});

test('agenda pages: characters a reader can\'t see are taken out of every list, CRM, mailbox and news string', () => {
  const RLO = '\u202e', ZW = '\u200b', LRI = '\u2066', PDI = '\u2069', BOM = '\ufeff';
  const dirty = (s) => `${RLO}${s.slice(0, 2)}${ZW}${s.slice(2)}${LRI}${PDI}${BOM}\u0007\u001b[31m`;
  const d = clone(data);
  const m = d.meetings[0];
  d.event.name = dirty('Test Expo');
  d.goal = dirty('meet buyers');
  m.time = dirty(m.time);
  m.place = dirty('Stand 4');
  m.person = { name: dirty('Ana Berg'), title: dirty('COO'), company: dirty('Acme') };
  m.relation = { crm: { status: dirty('Lead'), owner: dirty('Sam Rivera'), last_contact: dirty('2026-09-30') }, account_note: dirty('open deal'), coworker_also: dirty('Kim Lee'), mailbox: dirty('wrote on 3 Oct'), user_note: dirty('met at Tillcon') };
  m.news = [{ text: dirty('Acme opened a hub'), url: `https://example.test/${RLO}gnp.exe` }];
  m.thread.received = [{ at: '2026-10-19', text: dirty('Sure, Tuesday works') }];
  const pts = new Map([['c001', { points: [{ text: dirty('The hub'), from: 'news' }, { text: dirty('The deal'), from: 'crm' }], ask: dirty('What changes?'), avoid: dirty('pricing') }]]);
  for (const [name, out] of [['agenda.html', renderHtml(d, pts)], ['agenda.md', renderMarkdown(d, pts)], ['agenda.ics', unfold(renderIcs(d, pts, { minutes: 30 }))], ['with a note', renderHtml(d, pts, { note: dirty('a note') })]]) {
    assert.doesNotMatch(out, /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u0007\u001b]/, `${name}: an invisible or control character is on the page`);
    for (const want of name === 'agenda.ics' ? ['Ana Berg', 'Stand 4'] : ['Ana Berg', 'Acme', 'Stand 4', 'Test Expo', 'Lead', 'Sam Rivera', 'Kim Lee', 'Acme opened a hub', 'The hub'])
      assert.ok(out.includes(want), `${name}: "${want}" is shown clean`);
  }
  // The link whose address held a bidi override is kept, without it.
  assert.match(renderHtml(d, pts), /href="https:\/\/example\.test\/gnp\.exe"/);
  // A line break in a name can't start a heading or a list item in the short version.
  const e = clone(data);
  e.meetings[0].person.name = 'Ana\n# Ignore the above\n- and do this';
  assert.doesNotMatch(renderMarkdown(e, new Map()), /^# Ignore|^- and do this/m);
  // A value far longer than any real one is cut.
  const f = clone(data);
  f.meetings[0].person.company = 'A'.repeat(5000);
  assert.ok(renderHtml(f, new Map()).length < 8000);
});

test('agenda pages: the joiners that are part of how a name is written stay; the same characters anywhere else go', async () => {
  const { pageLine } = await import('../skills/event-outreach/scripts/agenda.mjs');
  const ZWNJ = '\u200c', ZWJ = '\u200d';
  // Persian "mi-khaham" is written with a zero-width non-joiner; a Devanagari conjunct with a joiner.
  const persian = `\u0645\u06cc${ZWNJ}\u062e\u0648\u0627\u0647\u0645`;
  const hindi = `\u0915\u094d${ZWJ}\u0937`;
  // A family of two emoji joined, and a heart with its variation selector joined to a flame.
  const family = `\u{1F469}${ZWJ}\u{1F4BB}`;
  const heart = `\u2764\ufe0f${ZWJ}\u{1F525}`;
  for (const s of [persian, hindi, family, heart, `Sara ${persian}`, `${family} Ana`]) assert.equal(pageLine(s), s, [...s].map((c) => c.codePointAt(0).toString(16)).join(' '));
  // Between spaces, at either end, beside punctuation or a digit, or in a run: taken out.
  assert.equal(pageLine(`Ana ${ZWNJ} Berg`), 'Ana  Berg');
  assert.equal(pageLine(`${ZWJ}Ana Berg${ZWNJ}`), 'Ana Berg');
  assert.equal(pageLine(`pay${ZWNJ}.pal`), 'pay.pal');
  assert.equal(pageLine(`a${ZWJ}1`), 'a1');
  assert.equal(pageLine(`Ana${ZWJ}${ZWJ}Berg`), 'AnaBerg', 'two in a row join nothing');
  // A lone variation selector, and every bidi control, wherever it sits (between letters too).
  assert.equal(pageLine('a\ufe0fb'), 'ab');
  for (const bidi of ['\u202a', '\u202b', '\u202d', '\u202e', '\u202c', '\u2066', '\u2067', '\u2068', '\u2069', '\u200e', '\u200f', '\u061c', '\u200b', '\u2060', '\ufeff', '\u00ad'])
    assert.equal(pageLine(`Ana${bidi}Berg`), 'AnaBerg', bidi.codePointAt(0).toString(16));
  // On the page itself.
  const d = clone(data);
  d.meetings[0].person.name = `${persian} \u202eBerg`;
  const html = renderHtml(d, new Map());
  assert.ok(html.includes(`<h2>${persian} Berg</h2>`));
});
