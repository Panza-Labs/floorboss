// Auto-send against the Gmail tools' real shapes, captured from a live ChatGPT/Codex cloud run on 2026-11-20
// (test/fixtures/gmail-real.mjs): the search's CallToolResult with its emails in structuredContent, the send tool's
// arguments (to, subject, a text/plain payload, response_fields, reply_message_id for a follow-up) and its answer's
// ids in structuredContent; and the task's git sign-in, which stays out of the data repo's own config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { world, ledgerLines, NOW, OWN, ROOT } from './fixtures/autosend-world.mjs';
import { email, searchResult, sendResult, written } from './fixtures/gmail-real.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { dueNow } from '../lib/autosend/plan.mjs';
import { decide, apply } from '../lib/autosend/replycheck.mjs';
import { release, sendArgs, record, htmlBody } from '../lib/autosend/sendrecord.mjs';
import { repoConfigWhy } from '../lib/autosend/sync.mjs';
import { approvalHash } from '../lib/sendcheck.mjs';
import { draftOf } from '../lib/autosend/common.mjs';
import { SEARCH_TOOLS, SEND_TOOLS } from '../skills/autosend/scripts/driver.mjs';
import { taskPrompt } from '../skills/autosend/scripts/cli.mjs';

const at = (iso) => Date.parse(iso);
const ITEM = { slug: 'harbor-expo', id: 'c001', name: 'Ana Ito', touch: 2, to: 'ana@north.example', subject: 'One more thought', body: 'Hi Ana', hash: 'a'.repeat(24), since_ms: at('2026-10-12T09:01:00Z'), thread_id: null, reply_to_message_id: null };
const check = (result) => decide(ITEM, written(result), { own: OWN });

test('real search: an empty result is go', () => {
  assert.deepEqual(check(searchResult()), { go: true });
  assert.deepEqual(check(searchResult([], { next_page_token: '' })), { go: true });
});

test('real search: a reply from the person stops them, read from from_ ("Name <addr>" or a bare address)', () => {
  for (const from_ of ['Ana Ito <ana@north.example>', 'ana@north.example', 'Ana Ito <Ana+expo@North.example>']) {
    const r = check(searchResult([email({ from_ })]));
    assert.equal(r.stop, 'reply', from_);
    assert.match(r.evidence, /ana/i);
    assert.match(r.evidence, /2026-10-13T10:45:10-07:00/, 'the date is email_ts');
  }
  // from (no underscore) is read too.
  const { from_, ...rest } = email({ from_: 'x' });
  void from_;
  assert.equal(check(searchResult([{ ...rest, from: 'Ana Ito <ana@north.example>' }])).stop, 'reply');
  // An out-of-office from them is an auto-reply.
  assert.equal(check(searchResult([email({ from_: 'Ana Ito <ana@north.example>', subject: 'Automatic reply: At Harbor Expo' })])).stop, 'auto_reply');
});

test('real search: a bounce naming them stops them', () => {
  const r = check(searchResult([email({ from_: 'Mail Delivery Subsystem <mailer-daemon@googlemail.example>', subject: 'Delivery Status Notification (Failure)', snippet: "Address not found: ana@north.example couldn't be found" })]));
  assert.equal(r.stop, 'bounce');
});

test('real search: a next_page_token, an error result, or a sender read two ways stops the run', () => {
  const bad = [
    searchResult([], { next_page_token: 'CAEQAA' }),
    searchResult([email({ from_: 'Ana Ito <ana@north.example>' })], { next_page_token: 'CAEQAA' }),
    searchResult([], { isError: true }),
    { content: [{ type: 'text', text: 'Gmail is not connected' }], isError: true },
    { content: [{ type: 'text', text: 'Action completed.' }], structuredContent: { emails: [], next_page_token: null }, isError: true },
    // structuredContent is what is read: an unknown key beside the list stops the run, as before.
    { ...searchResult(), structuredContent: { emails: [], next_page_token: null, partial: true } },
    { ...searchResult(), structuredContent: 'emails: none' },
    searchResult([email({ from_: 'Sam <sam@lanecraft.example> <ana@north.example>' })]),
    searchResult([{ ...email({ from_: OWN }), from: 'ana@north.example' }]),
    searchResult([email({ from_: 'News <news@other.example>' })]),
    searchResult([email({ from_: undefined })]),
    searchResult(Array.from({ length: 20 }, (_, i) => email({ id: `e${i}`, from_: OWN })))
  ];
  for (const a of bad) {
    const r = check(a);
    assert.ok(r.error, JSON.stringify(a).slice(0, 160));
    assert.equal(r.go, undefined);
  }
});

test("real search: structuredContent wins over the content text; the user's own message only is go", () => {
  // The content text says nothing useful; even a JSON one is not read when structuredContent is there.
  const shadow = { content: [{ type: 'text', text: JSON.stringify({ emails: [] }) }], structuredContent: { emails: [email({ from_: 'Ana Ito <ana@north.example>' })], next_page_token: null }, isError: false };
  assert.equal(check(shadow).stop, 'reply');
  assert.deepEqual(check(searchResult([email({ from_: `Sam Lane <${OWN}>`, subject: 'At Harbor Expo, Ana', labels: ['SENT'] })])), { go: true });
});

function ready() {
  const w = world({ touches: 2 });
  process.env.FLOORBOSS_HOME = w.HOME;
  const r = readback(w.evDir, at(NOW));
  approve(w.evDir, { digest: r.digest, said: 'auto-send these sequences' }, at(NOW));
  const now = at('2026-10-12T09:00:00Z');
  return { ...w, now, item: dueNow(w.HOME, now).due[0] };
}

test('sendArgs: exactly the send tool\'s input, the body byte for byte as the approval hash covers it', () => {
  assert.deepEqual(sendArgs(ITEM), {
    to: 'ana@north.example',
    subject: 'One more thought',
    payload: { mime_type: 'text/html', charset: 'UTF-8', body: { content: '<p>Hi Ana</p>' } },
    response_fields: ['id', 'thread_id']
  });
  // The HTML is built from the plain text alone (the live tool hard-wrapped text/plain): either line end, the same.
  for (const body of ['Hi Ana,\r\n\r\nTuesday?\r\n', 'Hi Ana,\n\nTuesday?\n']) assert.equal(sendArgs({ ...ITEM, body }).payload.body.content, '<p>Hi Ana,</p>\n<p>Tuesday?</p>');
  // The approved item, through the planner: what goes is what the hash names.
  const { evDir, item } = ready();
  const a = sendArgs(item);
  const d = draftOf(evDir, item.hash);
  assert.equal(approvalHash({ channel: d.channel, subject: a.subject, body: d.body }, a.to), item.hash);
  assert.equal(a.payload.body.content, htmlBody(d.body), 'the HTML is of the approved text');
  for (const k of ['cc', 'bcc', 'from_address', 'reply_to', 'attachment_files', 'body', 'thread_id']) assert.ok(!(k in a), k);
  assert.ok(!('reply_message_id' in a), 'a first message is a new email');
  // An odd recorded id is never passed: the follow-up goes as a new email.
  assert.ok(!('reply_message_id' in sendArgs({ ...ITEM, reply_to_message_id: 'id with spaces' })));
  assert.equal(sendArgs({ ...ITEM, reply_to_message_id: '19a2b3c4d5e6f708' }).reply_message_id, '19a2b3c4d5e6f708');
});

test('record: the ids from structuredContent; a follow-up then carries reply_message_id from that send', () => {
  const { evDir, now, item, HOME } = ready();
  apply(evDir, item, { go: true }, now);
  release(evDir, item, 'r1', now + 1000, { issuedMs: now });
  const r = record(evDir, item, written(sendResult({ id: '19a2b3c4d5e6f708', thread_id: '19a2b3c4d5e6f700' })), 'r1', now + 2000);
  assert.deepEqual(r, { sent: true, message_id: '19a2b3c4d5e6f708', thread_id: '19a2b3c4d5e6f700' });
  const sent = ledgerLines(evDir).find((e) => e.type === 'sent' && e.id === item.id);
  assert.deepEqual([sent.message_id, sent.thread_id], ['19a2b3c4d5e6f708', '19a2b3c4d5e6f700']);
  const f = dueNow(HOME, at('2026-10-19T09:00:00Z')).due.find((x) => x.id === item.id);
  assert.equal(f.touch, 2);
  const a = sendArgs(f);
  assert.equal(a.reply_message_id, '19a2b3c4d5e6f708');
  assert.equal(a.subject, f.subject);
  assert.equal(a.payload.body.content, htmlBody(f.body));
  assert.equal(a.to, f.to);
});

test('record: an error result, a missing id or an unreadable answer is unclear, never sent', () => {
  const unclear = [
    sendResult(undefined, { isError: true }),
    sendResult({ id: '19a2b3c4d5e6f708', thread_id: '19a2b3c4d5e6f708' }, { isError: true }),
    { content: [{ type: 'text', text: 'Failed to send email' }], isError: true },
    sendResult({ thread_id: '19a2b3c4d5e6f708' }),
    sendResult({ id: '19a2b3c4d5e6f708' }),
    sendResult({}),
    sendResult({ id: 'has space', thread_id: 't' }),
    // structuredContent is authoritative: ids only in the text don't count when it is there without them.
    sendResult({}, { text: JSON.stringify({ id: 'm1', thread_id: 't1' }) }),
    { content: [{ type: 'text', text: 'Action completed.' }], isError: false },
    { ...sendResult(), extra: true }
  ];
  for (const ans of unclear) {
    const { evDir, now, item } = ready();
    apply(evDir, item, { go: true }, now);
    release(evDir, item, 'r1', now + 1000, { issuedMs: now });
    const r = record(evDir, item, written(ans), 'r1', now + 2000);
    assert.ok(r.unclear, JSON.stringify(ans));
    const ls = ledgerLines(evDir);
    assert.ok(!ls.some((e) => e.type === 'sent'), JSON.stringify(ans));
    assert.ok(ls.some((e) => e.type === 'send_unclear' && e.id === item.id));
    // Never retried: nothing is due until the user settles it.
    assert.match(dueNow(process.env.FLOORBOSS_HOME, now + 3000).blocked, /unclear/);
  }
  // The content-text JSON fallback, when it parses and there is no structuredContent.
  const { evDir, now, item } = ready();
  apply(evDir, item, { go: true }, now);
  release(evDir, item, 'r1', now + 1000, { issuedMs: now });
  assert.deepEqual(record(evDir, item, written({ content: [{ type: 'text', text: JSON.stringify({ id: 'm9', thread_id: 't9' }) }], isError: false }), 'r1', now + 2000), { sent: true, message_id: 'm9', thread_id: 't9' });
});

test('the driver names the real tools first', () => {
  assert.equal(SEARCH_TOOLS[0], 'mcp__codex_apps__gmail_search_emails');
  assert.equal(SEND_TOOLS[0], 'mcp__codex_apps__gmail_send_email');
});

const HELPER = `git config --global credential.https://github.com.helper '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'`;

test('the task: git sign-in for the whole run before cloning, the whole result as JSON, the real tool names', () => {
  const task = readFileSync(join(ROOT, 'codex/autosend-task.md'), 'utf8');
  const p = taskPrompt({ sha: 'f'.repeat(40), dataRepo: 'someone/fb-data' });
  for (const t of [task, p]) {
    assert.ok(t.includes(HELPER), 'the helper line, exactly');
    assert.ok(t.indexOf(HELPER) < t.indexOf('Clone '), 'before cloning');
    assert.match(t, /JSON\.stringify/);
    assert.match(t, /structuredContent/);
    assert.match(t, /mcp__codex_apps__gmail_search_emails/);
    assert.match(t, /mcp__codex_apps__gmail_send_email/);
    assert.match(t, /never put the token in a URL/i);
    assert.ok(!/x-access-token:|:\$GITHUB_TOKEN@|\$\{?GITHUB_TOKEN\}?@/.test(t), 'no token in a URL');
  }
  assert.ok(p.includes('https://github.com/someone/fb-data'));
});

// git as the cloud task runs it, with a global config of its own (never this machine's), and nothing from the network.
function gitIn(dir, args, env, input) {
  return spawnSync('git', args, { cwd: dir, env, encoding: 'utf8', input });
}

test("the task's helper signs git in from GITHUB_TOKEN, and stays out of the data repo's own config", () => {
  const T = mkdtempSync(join(tmpdir(), 'fb-cred-'));
  const env = { PATH: process.env.PATH, HOME: T, XDG_CONFIG_HOME: join(T, 'xdg'), GIT_CONFIG_GLOBAL: join(T, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GITHUB_TOKEN: 'tok-123', GIT_TERMINAL_PROMPT: '0' };
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const sh = spawnSync('sh', ['-c', HELPER], { cwd: T, env, encoding: 'utf8' });
  assert.equal(sh.status, 0, sh.stderr);
  const fill = gitIn(T, ['credential', 'fill'], env, 'protocol=https\nhost=github.com\npath=someone/fb-data.git\n\n');
  assert.equal(fill.status, 0, fill.stderr);
  assert.match(fill.stdout, /^username=x-access-token$/m);
  assert.match(fill.stdout, /^password=tok-123$/m);
  // A clone with it set (a local bare repo here) writes nothing about credentials into the repo's own config, so
  // floorboss's check of that config still passes.
  const bare = join(T, 'data.git');
  assert.equal(gitIn(T, ['init', '--bare', '-q', bare], env).status, 0);
  const data = join(T, 'data');
  assert.equal(gitIn(T, ['clone', '-q', bare, data], env).status, 0);
  assert.ok(!/credential/i.test(readFileSync(join(data, '.git', 'config'), 'utf8')));
  assert.equal(repoConfigWhy(data), null);
  // The same helper in the repo's own config is refused, as before.
  assert.equal(gitIn(data, ['config', 'credential.https://github.com.helper', '!f() { echo x; }; f'], env).status, 0);
  assert.match(repoConfigWhy(data), /credential\.https:\/\/github\.com\.helper/);
});
