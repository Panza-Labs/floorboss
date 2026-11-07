import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcsBusy } from '../skills/slot-finder/scripts/ics.mjs';
import { buildEml, emlFileName } from '../skills/event-outreach/scripts/eml.mjs';

const WIN = { from: '2026-10-01T00:00:00Z', to: '2026-12-01T00:00:00Z' };
const cal = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flat(), 'END:VCALENDAR'].join('\r\n') + '\r\n';
const ev = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const spans = (r) => r.busy.map((b) => [b.start, b.end]);

test('ics: folded lines, UTC times, ignores VTODO and VALARM', () => {
  const text = cal(
    ['BEGIN:VEVENT', 'UID:a', 'SUMMARY:Board meeting with a very long', '  title folded', 'DTSTART:20261103T090000Z', 'DTEND:20261103T100000Z',
      'BEGIN:VALARM', 'TRIGGER:-PT15M', 'DTSTART:20261103T080000Z', 'END:VALARM', 'END:VEVENT'],
    ['BEGIN:VTODO', 'SUMMARY:todo', 'DTSTART:20261104T090000Z', 'DUE:20261104T100000Z', 'END:VTODO'],
  ).replace('very long\r\n  title', 'very long\n  title');
  const r = parseIcsBusy(text, WIN);
  assert.deepEqual(r.busy, [{ start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:00:00.000Z', summary: 'Board meeting with a very long title folded', all_day: false }]);
  assert.deepEqual(r.warnings, []);
});

test('ics: TZID, Windows TZID, unknown TZID and floating times', () => {
  const text = cal(
    ev('UID:b1', 'SUMMARY:Berlin', 'DTSTART;TZID=Europe/Berlin:20261103T090000', 'DTEND;TZID=Europe/Berlin:20261103T093000'),
    ev('UID:b2', 'SUMMARY:Outlook', 'DTSTART;TZID="W. Europe Standard Time":20261104T090000', 'DTEND;TZID="W. Europe Standard Time":20261104T100000'),
    ev('UID:b3', 'SUMMARY:Eastern', 'DTSTART;TZID=Eastern Standard Time:20261105T090000', 'DTEND;TZID=Eastern Standard Time:20261105T100000'),
    ev('UID:b4', 'SUMMARY:Odd zone', 'DTSTART;TZID=Customized Time Zone:20261106T090000', 'DTEND;TZID=Customized Time Zone:20261106T100000'),
    ev('UID:b5', 'SUMMARY:Floating', 'DTSTART:20261107T090000', 'DTEND:20261107T100000'),
  );
  const r = parseIcsBusy(text, { ...WIN, assumeZone: 'Europe/Lisbon' });
  assert.deepEqual(spans(r), [
    ['2026-11-03T08:00:00.000Z', '2026-11-03T08:30:00.000Z'],
    ['2026-11-04T08:00:00.000Z', '2026-11-04T09:00:00.000Z'],
    ['2026-11-05T14:00:00.000Z', '2026-11-05T15:00:00.000Z'],
    ['2026-11-06T09:00:00.000Z', '2026-11-06T10:00:00.000Z'],
    ['2026-11-07T09:00:00.000Z', '2026-11-07T10:00:00.000Z'],
  ]);
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings.join('\n'), /Customized Time Zone/);
  assert.match(r.warnings.join('\n'), /"Floating".*Europe\/Lisbon/);
});

test('ics: DURATION, all-day, transparent and cancelled', () => {
  const text = cal(
    ev('UID:c1', 'SUMMARY:Call', 'DTSTART:20261103T090000Z', 'DURATION:PT1H30M'),
    ev('UID:c2', 'SUMMARY:Offsite', 'DTSTART;VALUE=DATE:20261110', 'DTEND;VALUE=DATE:20261112'),
    ev('UID:c3', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20261120'),
    ev('UID:c4', 'SUMMARY:Free', 'TRANSP:TRANSPARENT', 'DTSTART:20261104T090000Z', 'DTEND:20261104T100000Z'),
    ev('UID:c5', 'SUMMARY:Gone', 'STATUS:CANCELLED', 'DTSTART:20261105T090000Z', 'DTEND:20261105T100000Z'),
  );
  const r = parseIcsBusy(text, { ...WIN, assumeZone: 'Europe/Berlin' });
  assert.deepEqual(r.busy.map((b) => [b.summary, b.start, b.end, b.all_day]), [
    ['Call', '2026-11-03T09:00:00.000Z', '2026-11-03T10:30:00.000Z', false],
    ['Offsite', '2026-11-09T23:00:00.000Z', '2026-11-11T23:00:00.000Z', true],
    ['Holiday', '2026-11-19T23:00:00.000Z', '2026-11-20T23:00:00.000Z', true],
  ]);
});

test('ics: weekly BYDAY with COUNT, EXDATE; daily with UNTIL', () => {
  const text = cal(
    ev('UID:d1', 'SUMMARY:Gym', 'DTSTART:20261012T070000Z', 'DTEND:20261012T080000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=4', 'EXDATE:20261014T070000Z'),
    ev('UID:d2', 'SUMMARY:Standup', 'DTSTART;TZID=Europe/Lisbon:20261012T093000', 'DURATION:PT15M', 'RRULE:FREQ=DAILY;UNTIL=20261015T235959Z'),
  );
  const r = parseIcsBusy(text, WIN);
  assert.deepEqual(r.busy.filter((b) => b.summary === 'Gym').map((b) => b.start.slice(0, 10)), ['2026-10-12', '2026-10-16', '2026-10-19']);
  assert.deepEqual(r.busy.filter((b) => b.summary === 'Standup').map((b) => b.start), [
    '2026-10-12T08:30:00.000Z', '2026-10-13T08:30:00.000Z', '2026-10-14T08:30:00.000Z', '2026-10-15T08:30:00.000Z',
  ]);
});

test('ics: RECURRENCE-ID override replaces one occurrence', () => {
  const text = cal(
    ev('UID:e1', 'SUMMARY:1:1', 'DTSTART:20261013T100000Z', 'DTEND:20261013T103000Z', 'RRULE:FREQ=WEEKLY;COUNT=3'),
    ev('UID:e1', 'SUMMARY:1:1 moved', 'RECURRENCE-ID:20261020T100000Z', 'DTSTART:20261020T150000Z', 'DTEND:20261020T153000Z'),
    ev('UID:e1', 'SUMMARY:1:1', 'STATUS:CANCELLED', 'RECURRENCE-ID:20261027T100000Z', 'DTSTART:20261027T100000Z', 'DTEND:20261027T103000Z'),
  );
  const r = parseIcsBusy(text, WIN);
  assert.deepEqual(r.busy.map((b) => [b.summary, b.start]), [
    ['1:1', '2026-10-13T10:00:00.000Z'],
    ['1:1 moved', '2026-10-20T15:00:00.000Z'],
  ]);
});

test('ics: weekly meeting keeps wall-clock time across the Berlin DST change', () => {
  const text = cal(ev('UID:f1', 'SUMMARY:Weekly', 'DTSTART;TZID=Europe/Berlin:20261015T090000', 'DTEND;TZID=Europe/Berlin:20261015T100000', 'RRULE:FREQ=WEEKLY;COUNT=4'));
  const r = parseIcsBusy(text, WIN);
  assert.deepEqual(r.busy.map((b) => b.start), [
    '2026-10-15T07:00:00.000Z', '2026-10-22T07:00:00.000Z', '2026-10-29T08:00:00.000Z', '2026-11-05T08:00:00.000Z',
  ]);
});

test('ics: unsupported rule keeps the first occurrence and warns', () => {
  const text = cal(ev('UID:g1', 'SUMMARY:Monthly review', 'DTSTART:20261006T090000Z', 'DTEND:20261006T100000Z', 'RRULE:FREQ=MONTHLY;BYDAY=1TU;BYSETPOS=1'));
  const r = parseIcsBusy(text, WIN);
  assert.equal(r.busy.length, 1);
  assert.match(r.warnings[0], /Monthly review/);
});

test('ics: window clipping', () => {
  const text = cal(
    ev('UID:h1', 'SUMMARY:Straddles', 'DTSTART:20261102T230000Z', 'DTEND:20261103T010000Z'),
    ev('UID:h2', 'SUMMARY:Before', 'DTSTART:20261102T100000Z', 'DTEND:20261102T110000Z'),
    ev('UID:h3', 'SUMMARY:Daily', 'DTSTART:20261101T090000Z', 'DTEND:20261101T100000Z', 'RRULE:FREQ=DAILY'),
  );
  const r = parseIcsBusy(text, { from: '2026-11-03T00:00:00Z', to: '2026-11-05T00:00:00Z' });
  assert.deepEqual(r.busy.map((b) => [b.summary, b.start, b.end]), [
    ['Straddles', '2026-11-03T00:00:00.000Z', '2026-11-03T01:00:00.000Z'],
    ['Daily', '2026-11-03T09:00:00.000Z', '2026-11-03T10:00:00.000Z'],
    ['Daily', '2026-11-04T09:00:00.000Z', '2026-11-04T10:00:00.000Z'],
  ]);
});

const decodeQp = (s) => Buffer.from(s.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');

test('eml: headers, encoded subject, quoted-printable body, CRLF', () => {
  const long = 'This line is deliberately long so that the encoder has to break it with a soft line break somewhere.';
  const body = `Hi Ana,\n${long}\nCost: 2+2=4, about 30 €.\nThanks`;
  const eml = buildEml({ from: 'Me <me@example.com>', to: 'Ana <ana@example.com>', subject: 'Café on Tuesday?', body, date: new Date('2026-10-10T09:05:03Z') });
  assert.ok(!/[^\r]\n/.test(eml), 'every newline is CRLF');
  const [head, encoded] = eml.split('\r\n\r\n');
  const h = head.split('\r\n');
  assert.ok(h.includes('To: Ana <ana@example.com>'));
  assert.ok(h.includes('From: Me <me@example.com>'));
  assert.ok(h.includes('Date: Sat, 10 Oct 2026 09:05:03 +0000'));
  assert.ok(h.includes('MIME-Version: 1.0'));
  assert.ok(h.includes('Content-Type: text/plain; charset=UTF-8'));
  assert.ok(h.includes('Content-Transfer-Encoding: quoted-printable'));
  assert.ok(h.includes('X-Unsent: 1'));
  const subj = h.find((l) => l.startsWith('Subject: '));
  assert.match(subj, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  assert.equal(Buffer.from(subj.slice(19, -2), 'base64').toString('utf8'), 'Café on Tuesday?');
  assert.ok(encoded.split('\r\n').every((l) => l.length <= 76));
  assert.match(encoded, /2\+2=3D4/);
  assert.match(encoded, /=E2=82=AC/);
  assert.match(encoded, /=\r\n/);
  assert.equal(decodeQp(encoded.replace(/\r\n$/, '')).replace(/\r\n/g, '\n'), body);
});

test('eml: plain ASCII subject, no From, header injection rejected, file name', () => {
  const eml = buildEml({ to: 'a@example.com', subject: 'Quick one', body: 'x' });
  assert.match(eml, /\r\nSubject: Quick one\r\n/);
  assert.ok(!/^From:/m.test(eml));
  assert.throws(() => buildEml({ to: 'a@example.com\r\nBcc: x@evil.test', subject: 's', body: 'b' }), /line break/);
  assert.throws(() => buildEml({ to: 'a@example.com', subject: 'hi\nBcc: x@evil.test', body: 'b' }), /line break/);
  assert.equal(emlFileName('c001', 1), 'c001-t1.eml');
  assert.equal(emlFileName('c001', 2), 'c001-t2.eml');
});
