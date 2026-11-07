import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decode, parse, readCsvText, sniffDelimiter, toCsv } from '../lib/csv.mjs';
import { companyKey, isSharedDomain, normEmail, similarity, hasSurname, stripAccents } from '../lib/normalize.mjs';
import { zonedToUtc, labelInZone, isValidZone, offsetMinutes, addDays, daysBetween, weekdayOf } from '../lib/tz.mjs';
import { parseGate, GateError } from '../lib/gate.mjs';
import { escapeHtml, safeUrl, jsonForScript } from '../lib/escape.mjs';
import { writeJson, readJson, appendLine } from '../lib/jsonio.mjs';
import { slugify, assertSlug } from '../lib/paths.mjs';

test('csv: UTF-8 with and without BOM', () => {
  const plain = Buffer.from('name,company\nJosé,Acme\n', 'utf8');
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plain]);
  assert.equal(decode(plain).text, 'name,company\nJosé,Acme\n');
  assert.equal(decode(bom).encoding, 'utf-8-bom');
  assert.equal(readCsvText(bom).headers[0], 'name');
});

test('csv: UTF-16 LE by BOM', () => {
  const body = Buffer.from('name;company\r\nMüller;Acme\r\n', 'utf16le');
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
  const r = readCsvText(buf);
  assert.equal(r.encoding, 'utf-16le');
  assert.equal(r.delimiter, ';');
  assert.equal(r.records[0].name, 'Müller');
});

test('csv: Windows-1252 fallback decodes é and curly quotes', () => {
  const buf = Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x52, 0x65, 0x6e, 0xe9, 0x20, 0x93, 0x52, 0x94, 0x0a]);
  const r = readCsvText(buf);
  assert.equal(r.encoding, 'windows-1252');
  assert.equal(r.records[0].name, 'René “R”');
});

test('csv: quoted delimiters, quoted newlines, doubled quotes, CRLF, blank lines', () => {
  const text = 'a,b\r\n"x, y","line1\nline2"\r\n"say ""hi""",2\r\n\r\n';
  const rows = parse(text);
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'line1\nline2'], ['say "hi"', '2']]);
});

test('csv: semicolon sniffed outside quotes', () => {
  assert.equal(sniffDelimiter('"a,b";c;d\n1;2;3'), ';');
  assert.equal(sniffDelimiter('a,b,c\n'), ',');
});

test('csv: rows with replacement or control characters are flagged, not dropped', () => {
  const r = readCsvText('name\nok\nbad�row\n');
  assert.equal(r.records.length, 2);
  assert.deepEqual(r.flagged, [3]);
});

test('csv: toCsv round-trips', () => {
  const text = toCsv(['a', 'b'], [{ a: 'x, y', b: 'he said "no"' }]);
  assert.deepEqual(readCsvText(text).records[0], { a: 'x, y', b: 'he said "no"' });
});

test('normalize: company keys collapse legal suffixes and case', () => {
  assert.equal(companyKey('ACME Corp.'), 'acme');
  assert.equal(companyKey('Acme Inc'), 'acme');
  assert.equal(companyKey('Acme'), 'acme');
  assert.equal(companyKey('Société Lumière SA'), 'societe lumiere');
  assert.equal(companyKey('The Group'), 'group');
  assert.equal(companyKey('Pell & Gunn Co.'), 'pell and gunn');
});

test('normalize: shared domains', () => {
  for (const d of ['gmail.com', 'agency.gov.test', 'army.mil', 'va.gov', 'nhs.net', 'trust.nhs.net', 'x.gouv.fr']) {
    assert.ok(isSharedDomain(d), d);
  }
  for (const d of ['acme.com', 'governance.io', 'example.com']) assert.ok(!isSharedDomain(d), d);
  assert.ok(isSharedDomain('consultants.example', ['consultants.example']));
});

test('normalize: emails, surnames, similarity, accents', () => {
  assert.equal(normEmail(' Ana@Acme.example '), 'ana@acme.example');
  assert.equal(normEmail('not-an-email'), null);
  assert.ok(hasSurname('Ana Sousa'));
  assert.ok(!hasSurname('Ana'));
  assert.equal(similarity('acme', 'acme'), 1);
  assert.ok(similarity('northwind logistics', 'northwind') >= 0.5);
  assert.ok(similarity('acme', 'globex') < 0.5);
  assert.equal(stripAccents('Müller Straße'), 'Muller Strasse');
});

test('tz: wall time to UTC and labels', () => {
  const u = zonedToUtc({ y: 2027, m: 10, d: 13, hh: 10, mm: 30 }, 'Europe/Lisbon');
  assert.equal(u.toISOString(), '2027-10-13T09:30:00.000Z');
  assert.equal(labelInZone(u.toISOString(), 'Europe/Lisbon'), 'Wed 13 Oct, 10:30 Lisbon time');
  assert.equal(labelInZone(u.toISOString(), 'America/New_York'), 'Wed 13 Oct, 05:30 New York time');
});

test('tz: DST week (Lisbon falls back 25 Oct 2026)', () => {
  assert.equal(offsetMinutes(new Date('2026-10-24T12:00:00Z'), 'Europe/Lisbon'), 60);
  assert.equal(offsetMinutes(new Date('2026-10-26T12:00:00Z'), 'Europe/Lisbon'), 0);
  assert.equal(zonedToUtc({ y: 2026, m: 10, d: 26, hh: 9, mm: 0 }, 'Europe/Lisbon').toISOString(), '2026-10-26T09:00:00.000Z');
});

test('tz: zone validation and date helpers', () => {
  assert.ok(isValidZone('Europe/Lisbon'));
  assert.ok(isValidZone('UTC'));
  assert.ok(!isValidZone('Lisbon'));
  assert.ok(!isValidZone('Mars/Olympus'));
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(daysBetween('2027-10-01', '2027-10-14'), 13);
  assert.equal(weekdayOf('2026-10-13'), 'Tue');
});

test('gate: triage answers', () => {
  const g = parseGate('remove c014, c032; rescue c051; cap merriton-freight 50; cap acme all', { kind: 'triage' });
  assert.deepEqual(g.actions, [
    { verb: 'remove', ids: ['c014', 'c032'] },
    { verb: 'rescue', ids: ['c051'] },
    { verb: 'cap', company: 'merriton-freight', value: 50 },
    { verb: 'cap', company: 'acme', value: 'all' },
  ]);
});

test('gate: draft answers', () => {
  const g = parseGate('Approve all except c019, c027; edit c007', { kind: 'draft' });
  assert.deepEqual(g.actions, [
    { verb: 'approve-all', except: ['c019', 'c027'] },
    { verb: 'edit', ids: ['c007'] },
  ]);
  assert.ok(parseGate('defaults', { kind: 'draft' }).defaults);
});

test('gate: rejects unknown ids, conflicting verbs and wrong verbs', () => {
  assert.throws(() => parseGate('remove c999', { kind: 'triage', knownIds: new Set(['c001']) }), /aren't on this list: c999/);
  assert.throws(() => parseGate('remove c001; rescue c001', { kind: 'triage' }), GateError);
  assert.throws(() => parseGate('approve c001', { kind: 'triage' }), /isn't an answer here/);
  assert.throws(() => parseGate('remove bob', { kind: 'triage' }), /isn't an ID/);
});

test('escape: hostile strings and URLs', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('"><img src=x onerror=alert(1)>'), '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,hi'), null);
  assert.equal(safeUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeUrl('mailto:ana@example.com'), 'mailto:ana@example.com');
  assert.ok(!jsonForScript({ x: '</script><script>' }).includes('</script>'));
  assert.ok(!jsonForScript({ x: ' ' }).includes(' '));
});

test('jsonio: atomic write is private, corrupt JSON stops loudly, append works', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-'));
  const p = join(dir, 'a', 'x.json');
  writeJson(p, { a: 1 });
  assert.deepEqual(readJson(p, null), { a: 1 });
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(readJson(join(dir, 'missing.json'), 'fallback'), 'fallback');
  appendLine(join(dir, 'log.jsonl'), '{"a":1}');
  assert.equal(readFileSync(join(dir, 'log.jsonl'), 'utf8'), '{"a":1}\n');
});

test('jsonio: corrupt file throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-'));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'bad.json'), '{not json');
  assert.throws(() => readJson(join(dir, 'bad.json'), {}), /not valid JSON/);
});

test('paths: slugs', () => {
  assert.equal(slugify('Harbour Expo Lisbon 2026!'), 'harbour-expo-lisbon-2026');
  assert.throws(() => assertSlug('../etc'), /valid slug/);
});
