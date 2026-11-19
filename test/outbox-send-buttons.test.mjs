// The outbox's send buttons (skills/event-outreach/scripts/mailto.mjs, outbox.mjs mailOf): "Open in your mail app"
// carries the approved subject and body exactly, opt-out line included, and "Download .eml" the same as an unsent
// draft. Only cards that offer Copy get them; crafted list text can't break out of the page or add a recipient.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, symlinkSync, lstatSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mailtoHref, emlText, plainAddress, crlf, MAILTO_MAX, emlName } from '../skills/event-outreach/scripts/mailto.mjs';
import { renderOutbox, mailOf, offersCopy } from '../skills/event-outreach/scripts/outbox.mjs';
import { clearMailFiles } from '../skills/event-outreach/scripts/commands/cards.mjs';

const OPTOUT = "If this isn't relevant, say so and I won't follow up.";
const BODY = `Hi Zoë,\n\nPorts in Rotterdam & Antwerp cut dwell time 18% (Q3) — worth 20 min? #cargo +1 100%\nTue 10:00 or Wed 14:30?\n\nBest, Noor\n${OPTOUT}`;
const SUBJECT = 'Dwell time & Q3: café? #1 = 50% + more';

const parse = (href) => {
  const u = new URL(href);
  return { to: decodeURIComponent(u.pathname), subject: u.searchParams.get('subject'), body: u.searchParams.get('body'), keys: [...u.searchParams.keys()] };
};

test('mailto carries the exact subject and body, CRLF line breaks, and nothing else', () => {
  const { href } = mailtoHref({ to: 'zoe.van-dijk+events@north-wind.example', subject: SUBJECT, body: BODY });
  assert.ok(href.startsWith('mailto:zoe.van-dijk+events@north-wind.example?subject='));
  const p = parse(href);
  assert.equal(p.to, 'zoe.van-dijk+events@north-wind.example');
  assert.deepEqual(p.keys, ['subject', 'body'], 'no cc, bcc or second recipient');
  assert.equal(p.subject, SUBJECT);
  assert.equal(p.body, BODY.replace(/\n/g, '\r\n'));
  assert.ok(p.body.endsWith(OPTOUT), 'the opt-out line is there, last');
  assert.match(href, /%0D%0A/);
  assert.ok(!/[\s<>"']/.test(href), 'no raw space, quote or angle bracket');
  // "&", "?", "#", "+", "=" in the text are encoded, so they can't end a field: the query is exactly two fields.
  const q = href.slice(href.indexOf('?') + 1);
  assert.equal(q.split('&').length, 2);
  assert.ok(!/[#+?]/.test(q) && q.split('=').length === 3);
  // Every kind of line break becomes CRLF, exactly once.
  assert.equal(crlf('a\rb\nc\r\nd e'), 'a\r\nb\r\nc\r\nd\r\ne');
});

test('only one plain address gets a button: no name part, second recipient, header or odd character', () => {
  for (const bad of [
    'a@b.example, c@d.example',
    'a@b.example;c@d.example',
    '"Ana" <a@b.example>',
    'a@b.example?bcc=x@evil.example',
    'a@b.example&cc=x@evil.example',
    'a@b.example\r\nBcc: x@evil.example',
    'a b@c.example',
    'a%40b@c.example',
    'zoë@b.example',
    'a@b',
    'a@-b.example',
    '.a@b.example',
    'a..b@c.example',
    ' a@b.example',
    'javascript:alert(1)//@b.example',
    '',
    null,
    'a@b.example#x'
  ])
    assert.equal(plainAddress(bad), null, String(bad));
  assert.equal(mailtoHref({ to: 'a@b.example?bcc=x@evil.example', subject: 's', body: 'b' }).href, null);
  assert.equal(emlText({ to: 'a@b.example\r\nBcc: x@evil.example', subject: 's', body: 'b' }), null);
  // A subject with a line break would start a header: no button at all.
  assert.equal(mailtoHref({ to: 'a@b.example', subject: 'Hi\r\nBcc: x@evil.example', body: 'b' }).href, null);
  assert.equal(emlText({ to: 'a@b.example', subject: 'Hi\nBcc: x@evil.example', body: 'b' }), null);
});

test('the .eml is an unsent draft: To, encoded subject, X-Unsent, a Message-ID, base64 UTF-8 body, CRLF, no From', () => {
  const eml = emlText({ to: 'zoe@north-wind.example', subject: SUBJECT, body: BODY, id: 'c012' });
  const [head, b64] = eml.split('\r\n\r\n');
  const lines = head.split('\r\n');
  assert.equal(lines[0], 'To: zoe@north-wind.example');
  assert.ok(lines.includes('X-Unsent: 1'));
  assert.ok(lines.some((l) => /^Message-ID: <floorboss\.c012\.[0-9a-f]{24}@floorboss\.invalid>$/.test(l)));
  assert.ok(lines.includes('Content-Type: text/plain; charset=UTF-8'));
  assert.ok(lines.includes('Content-Transfer-Encoding: base64'));
  assert.ok(!lines.some((l) => /^(From|Cc|Bcc|Reply-To):/i.test(l)));
  // Every line ends CRLF (no bare LF anywhere).
  assert.ok(!/[^\r]\n/.test(eml));
  // The subject decodes back exactly, and the body is the approved text with CRLF.
  const subj = head.match(/^Subject: (.*(?:\r\n .*)*)/m)[1];
  const decoded = subj.startsWith('=?') ? subj.split('\r\n ').map((w) => Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(w)[1], 'base64').toString('utf8')).join('') : subj;
  assert.equal(decoded, SUBJECT);
  assert.equal(Buffer.from(b64.replace(/\r\n/g, ''), 'base64').toString('utf8'), BODY.replace(/\n/g, '\r\n'));
  // A non-ASCII subject is split on whole characters into encoded words under 76 characters.
  const long = emlText({ to: 'a@b.example', subject: 'Zoë, café ☕ und Grüße '.repeat(6), body: 'x', id: 'c1' });
  const words = long.split('\r\n\r\n')[0].match(/=\?UTF-8\?B\?[^?]*\?=/g);
  assert.ok(words.length > 2 && words.every((w) => w.length <= 75));
  assert.equal(words.map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join(''), 'Zoë, café ☕ und Grüße '.repeat(6));
  assert.equal(emlName('c012', 2), 'c012-t2.eml');
  assert.equal(emlName('../../x', 1), 'x-t1.eml');
});

test('a message too long for a mail link keeps only the .eml', () => {
  const body = 'Sentence with words and a café. '.repeat(80) + OPTOUT;
  const r = mailtoHref({ to: 'a@b.example', subject: 's', body });
  assert.equal(r.href, null);
  assert.equal(r.why, 'long');
  assert.ok(r.length > MAILTO_MAX);
  const card = { ...baseCard(), body };
  const m = mailOf(card);
  assert.equal(m.href, null);
  assert.ok(m.eml);
  const html = page([card]);
  assert.ok(!html.includes('Open in your mail app'));
  assert.ok(html.includes('Download .eml'));
  assert.match(html, /Too long for a mail link/);
});

function baseCard(over = {}) {
  return {
    kind: 'message',
    id: 'c001',
    touch: 1,
    name: 'Zoë van Dijk',
    title: 'Head of Ops',
    company: 'Northwind',
    channel: 'email',
    address: 'zoe@north-wind.example',
    send_to: 'zoe@north-wind.example',
    you_send: true,
    subject: SUBJECT,
    body: BODY,
    verdict: { verdict: 'PASS', reasons: [] },
    slots: [],
    pending: false,
    ...over
  };
}
const page = (cards) => renderOutbox({ event: { name: 'Harbour & Haul', slug: 'ev-one', city: 'Lisbon', start_date: '2027-03-01', end_date: '2027-03-02', time_zone: 'Europe/Lisbon' }, cards, slots: [], counts: {}, generatedAt: 'now' });
const hrefs = (html) => [...html.matchAll(/href="(mailto:[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

test('the page: one button pair per sendable email, the href escaped, and its text the card text', () => {
  const html = page([baseCard()]);
  const [h] = hrefs(html);
  assert.ok(h);
  const p = parse(h);
  assert.equal(p.body, BODY.replace(/\n/g, '\r\n'));
  assert.equal(p.subject, SUBJECT);
  assert.match(html, /href="mail\/c001-t1\.eml" download="c001-t1\.eml">Download \.eml</);
  // The href has its "&" escaped for the attribute, and nothing in it can close the attribute.
  assert.ok(html.includes('&amp;body='));
  assert.ok(!/href="mailto:[^"]*[<>]/.test(html));
  // The script hash still matches (the CSP lets only the page's own script run).
  assert.match(html, /script-src 'sha256-[A-Za-z0-9+/=]+'/);
});

test('crafted names, companies and text in a card cannot break the page or the link', () => {
  const evil = '"><script>alert(1)</script><a href="javascript:alert(2)">';
  const card = baseCard({ name: evil, company: `</pre>${evil}`, title: evil, subject: `Hi ${evil}`, body: `Hello ${evil}\n</a><img src=x onerror=alert(3)>\n${OPTOUT}` });
  const html = page([card]);
  assert.ok(!html.includes('<script>alert(1)'), 'no injected script tag');
  assert.ok(!/<a href="javascript:/i.test(html));
  assert.ok(!html.includes('<img src=x'));
  assert.equal((html.match(/<script/g) || []).length, 2, 'only the page data and its own script');
  const [h] = hrefs(html);
  assert.equal(parse(h).body, card.body.replace(/\n/g, '\r\n'));
  // An address from the list that carries a second header gets no buttons, but the card stays readable.
  const bad = page([baseCard({ send_to: 'zoe@north-wind.example?bcc=all@evil.example', address: 'zoe@north-wind.example?bcc=all@evil.example' })]);
  assert.equal(hrefs(bad).length, 0);
  assert.ok(!bad.includes('Download .eml'));
  assert.ok(bad.includes('class="copy"'));
});

test('no buttons for anyone the page offers nothing to copy for', () => {
  const holds = {
    'not going (event over, or opted out elsewhere)': { not_going: 'the event is over' },
    'not today (one a day)': { not_today: 'another event wrote to them today' },
    'pending approval': { pending: true },
    'may have gone': { may_have_gone: '2027-02-20T10:00:00Z' },
    'already in their drafts': { staged: true },
    'LinkedIn note': { channel: 'paste', where: 'LinkedIn', subject: null },
    'event-app note': { channel: 'paste', routed: 'app', subject: null },
    'coordinate note': { kind: 'coordinate', channel: 'note', holder: 'Sam' },
    'email sending on (floorboss sends it after a prompt)': { you_send: undefined }
  };
  for (const [why, over] of Object.entries(holds)) {
    const c = baseCard(over);
    assert.equal(mailOf(c), null, why);
    const html = page([c]);
    assert.ok(!html.includes('Open in your mail app') && !html.includes('Download .eml'), why);
  }
  // A held card offers no Copy either: the buttons follow Copy exactly.
  assert.equal(offersCopy(baseCard({ not_today: 'x' })), false);
  assert.equal(offersCopy(baseCard()), true);
  // Event-app and LinkedIn notes keep their per-message Copy.
  const app = page([baseCard({ channel: 'paste', routed: 'app', subject: null })]);
  assert.match(app, /data-copy="c001-t1-body"/);
});

test('mail/ is emptied before each build; a link there is removed, never followed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-mail-'));
  const outbox = join(dir, 'outbox.html');
  mkdirSync(join(dir, 'mail'));
  writeFileSync(join(dir, 'mail', 'c009-t1.eml'), 'old');
  clearMailFiles(outbox);
  assert.ok(!existsSync(join(dir, 'mail')));
  const elsewhere = mkdtempSync(join(tmpdir(), 'fb-mail-target-'));
  writeFileSync(join(elsewhere, 'keep.txt'), 'keep');
  symlinkSync(elsewhere, join(dir, 'mail'));
  clearMailFiles(outbox);
  assert.throws(() => lstatSync(join(dir, 'mail')));
  assert.equal(readFileSync(join(elsewhere, 'keep.txt'), 'utf8'), 'keep');
  assert.deepEqual(readdirSync(elsewhere), ['keep.txt']);
});

// End to end, through the real build (fixtures/harness.mjs): Claude Code with email sending on keeps its page as it
// was (floorboss sends those after a prompt; a hand-send button too could send one twice); with sending off, every
// approved email gets its buttons and its .eml.
test('built pages: no send buttons where floorboss sends email itself, buttons where the user sends', async () => {
  const { setup, cli, triage, draftApprove } = await import('./fixtures/harness.mjs');
  const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Ruiz,Head of Ops,Initech,cy@initech.test\n';
  const built = (settings) => {
    const H = setup({ attendees: LIST, settings });
    triage(H);
    draftApprove(H);
    cli(H, 'event-outreach', ['open', '--event', H.slug, '--no-open']);
    const html = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
    return { html, mail: existsSync(join(H.dir, 'mail')) ? readdirSync(join(H.dir, 'mail')) : [] };
  };
  const off = built({});
  assert.ok((off.html.match(/Open in your mail app/g) || []).length >= 2, 'sending off: buttons');
  assert.equal(off.mail.length, (off.html.match(/Download \.eml/g) || []).length);
  const on = built({ sending: { channels: ['email'], followups: 'scheduled', linkedin_ack: false } });
  assert.ok((on.html.match(/<article class="card/g) || []).length >= 2, 'the same cards are on the page');
  assert.ok(!on.html.includes('Open in your mail app') && !on.html.includes('Download .eml'), 'email sending on: no buttons');
  assert.deepEqual(on.mail, []);
});

test('text that is not well-formed Unicode gets no buttons, and the page still builds', () => {
  const card = baseCard({ body: `Hi \ud800 there\n${OPTOUT}` });
  assert.equal(mailOf(card), null);
  assert.equal(mailOf(baseCard({ subject: 'Hi \udc00' })), null);
  assert.equal(mailtoHref({ to: 'a@b.example', subject: 's', body: 'x\ud800' }).href, null);
  assert.equal(emlText({ to: 'a@b.example', subject: 's', body: 'x\ud800' }), null);
  const html = page([card, baseCard({ id: 'c002' })]);
  assert.equal(hrefs(html).length, 1, 'the other card keeps its buttons');
});

test('the stale-time note names a floorboss command only in Claude Code', () => {
  const stale = (html) => /<p class="stale" hidden>([^<]*)<\/p>/.exec(html)[1];
  assert.match(stale(page([baseCard()])), /\/floorboss:event-draft/);
  const hand = renderOutbox({ hand_send: true, event: { name: 'X', slug: 'ev-one', city: 'L', start_date: '2027-03-01', end_date: '2027-03-02', time_zone: 'Europe/Lisbon' }, cards: [baseCard()], slots: [], counts: {}, generatedAt: 'now' });
  assert.match(stale(hand), /Run floorboss again/);
  assert.doesNotMatch(stale(hand), /\/floorboss:/);
});

test('no opener on the system: open writes the page, says where it is, and exits cleanly', async () => {
  const { setup, triage, draftApprove, ROOT } = await import('./fixtures/harness.mjs');
  const { spawnSync } = await import('node:child_process');
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  triage(H);
  draftApprove(H);
  const empty = mkdtempSync(join(tmpdir(), 'fb-nopath-'));
  const r = spawnSync(process.execPath, [join(ROOT, 'skills/event-outreach/scripts/cli.mjs'), 'open', '--event', H.slug], {
    env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: '2026-10-12T08:00:00Z', PATH: empty },
    encoding: 'utf8'
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /couldn't open the page .*outbox\.html/);
  assert.ok(existsSync(join(H.dir, 'outbox.html')));
});
