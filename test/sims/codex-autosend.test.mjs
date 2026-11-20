// Auto-send in Codex, end to end (design 2026-11-20, cases 1 to 16): the mock event run through the real flow in
// Codex with auto-send on (the whole sequence drafted and approved up front), the readback and the second yes, the
// data folder pushed to a fake remote (a bare repo in a temp folder), and cloud runs: each a fresh clone driven by a
// scripted model that does exactly what each step says, against a fake Gmail (an in-memory mailbox). Nothing is sent
// anywhere and nothing leaves this machine. What isn't caught, and the tests don't pretend it is: a model that sends
// other text, or calls the send tool outside a step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { drive, simplePersona, ROOT } from './lib/driver.mjs';
import { remoteFor, cloneOf, commitsOf, remoteFile, git } from '../fixtures/autosend-world.mjs';
import { email, searchResult, sendResult, profileResult, threadResult } from '../fixtures/gmail-real.mjs';
import { htmlBody } from '../../lib/autosend/sendrecord.mjs';

const SLUG = 'mock-harbour-haul';
const CLI = join(ROOT, 'skills/autosend/scripts/cli.mjs');
const OWN = 'sam@lanecraft.example';
const BUILT_AT = '2026-10-12T08:00:00Z'; // Monday, 09:00 in Lisbon
const MARKERS = ['CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_TOOL_CALL_ID', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED'];

// The laptop: Codex (a marker, no CLAUDECODE). The cloud: an unknown program (no marker), FLOORBOSS_AUTOSEND=cloud.
const laptopEnv = (HOME, at) => {
  const env = { ...process.env, FLOORBOSS_TEST: '1', FLOORBOSS_HOME: HOME, FLOORBOSS_NOW: at, FLOORBOSS_SCAN_HOME: join(HOME, 'scan-home'), FLOORBOSS_SCAN_CWD: join(HOME, 'scan-home'), CODEX_SESSION_ID: 'codex-sess', CODEX_THREAD_ID: 'codex-thread', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.CLAUDECODE;
  delete env.FLOORBOSS_AUTOSEND;
  return env;
};
const cloudEnv = (HOME, at) => {
  const env = { ...process.env, FLOORBOSS_TEST: '1', FLOORBOSS_HOME: HOME, FLOORBOSS_NOW: at, FLOORBOSS_AUTOSEND: 'cloud', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.CLAUDECODE;
  for (const k of MARKERS) delete env[k];
  return env;
};
const run = (cmd, args, env) => {
  const r = spawnSync(cmd, args, { env, encoding: 'utf8' });
  if (r.status !== 0) return { ERROR: String(r.stderr || r.stdout).slice(0, 1500) };
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { ERROR: `not JSON: ${r.stdout.slice(0, 300)}` };
  }
};
const laptop = (HOME, at, args) => run(process.execPath, [CLI, ...args], laptopEnv(HOME, at));
const saidFile = (HOME, words) => {
  const f = join(HOME, 'work', `said-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(f, words);
  return f;
};

// The mock event, in Codex, with auto-send on before drafting; every sequence approved for content, then the second
// yes. Built once per process, copied for each test.
let BUILT = null;
function build() {
  const HOME = mkdtempSync(join(tmpdir(), 'fb-autosend-sim-'));
  mkdirSync(join(HOME, 'work'), { recursive: true });
  mkdirSync(join(HOME, 'scan-home'), { recursive: true });
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  const env = laptopEnv(HOME, BUILT_AT);
  execFileSync(process.execPath, [join(ROOT, 'examples/mock-event/load.mjs'), '--goal', 'buyers', '--now', BUILT_AT], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const on = laptop(HOME, BUILT_AT, ['on', '--event', SLUG, '--said', 'yes, send them from the cloud', '--own', OWN]);
  assert.ok(!on.ERROR, on.ERROR);
  const per = simplePersona({ slug: SLUG, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), rate: 'skip', voice_samples: 'skip', replies_since: 'none' } });
  const steps = [];
  const r = drive({ HOME, now: BUILT_AT, env }, per, { maxSteps: 260, onStep: (s) => steps.push(s) });
  assert.ok(r.last.done || r.last.step === 'waiting', r.trail.slice(-6).join(' '));
  // Not one step asked the laptop session for a connected tool or a send.
  assert.deepEqual(steps.filter((s) => s.call).map((s) => s.step), []);
  const rb = laptop(HOME, BUILT_AT, ['readback', '--event', SLUG]);
  assert.ok(!rb.ERROR, rb.ERROR);
  // "yes" is not the sentence: nothing is written.
  assert.match(laptop(HOME, BUILT_AT, ['approve', '--event', SLUG, '--digest', rb.digest, '--said-file', saidFile(HOME, 'yes')]).ERROR, /auto-send these sequences/);
  const ok = laptop(HOME, BUILT_AT, ['approve', '--event', SLUG, '--digest', rb.digest, '--said-file', saidFile(HOME, 'auto-send these sequences')]);
  assert.ok(!ok.ERROR, ok.ERROR);
  const lines = readFileSync(join(HOME, 'events', SLUG, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const yes = lines.filter((e) => e.type === 'autosend_approved');
  const items = yes.map((e) => {
    const d = JSON.parse(readFileSync(join(HOME, 'events', SLUG, 'drafts', `${e.hash}.json`), 'utf8'));
    return { id: e.id, touch: e.touch, to: e.to, subject: d.subject, body: d.body };
  });
  return { HOME, rb, items, people: [...new Set(items.map((x) => x.id))].sort() };
}
const built = () => (BUILT ||= build());

// A laptop data folder of its own (a copy of the built one), with only these people left approved, pushed to a fresh
// bare remote.
function fresh(keep = null) {
  const b = built();
  const HOME = join(mkdtempSync(join(tmpdir(), 'fb-autosend-laptop-')), 'floorboss');
  cpSync(b.HOME, HOME, { recursive: true });
  if (keep) {
    const others = b.people.filter((id) => !keep.includes(id));
    const r = laptop(HOME, BUILT_AT, ['revoke', '--event', SLUG, '--ids', others.join(','), '--said', 'only these two for this test']);
    assert.ok(!r.ERROR, r.ERROR);
  }
  const { bare } = remoteFor(HOME);
  return { HOME, bare, items: b.items.filter((x) => !keep || keep.includes(x.id)) };
}

// The fake Gmail: an in-memory mailbox, answering in the real tools' shapes (a live ChatGPT/Codex cloud run,
// 2026-11-20; test/fixtures/gmail-real.mjs): an MCP CallToolResult with the data in structuredContent. search filters by
// the query's from: and after:, and finds a bounce from mailer-daemon or postmaster that names the quoted address,
// answering { emails: [{ id, thread_id, from_, ... }], next_page_token }; send takes the send tool's own input, stores
// the message (reply_message_id puts it in that message's thread) and answers the response_fields asked for.
class FakeGmail {
  constructor() {
    this.inbox = [];
    this.sentMail = [];
    this.searches = 0;
    this.mode = { search: 'ok', send: 'ok', profile: 'ok' };
    this.account = OWN;
    this.profiles = 0;
    this.threads = 0;
    this.n = 0;
  }
  deliver(m) {
    this.inbox.push({ id: `in${++this.n}`, threadId: `th${this.n}`, labels: ['INBOX'], ...m });
  }
  search(args) {
    this.searches++;
    assert.deepEqual(Object.keys(args).sort(), ['max_results', 'query']);
    if (this.mode.search === 'throws') throw new Error('the Gmail tool is not available');
    if (this.mode.search === 'garbage') return 'Error: something went wrong reading the mailbox';
    if (this.mode.search === 'error') return { content: [{ type: 'text', text: 'Rate limit exceeded' }], isError: true };
    const after = Number(/after:(\d+)/.exec(args.query)[1]) * 1000;
    const froms = [...args.query.matchAll(/from:([^\s()]+)/g)].map((m) => m[1].toLowerCase()).filter((f) => !['mailer-daemon', 'postmaster'].includes(f));
    // The quoted address (the bounce part also quotes the notice subjects, which aren't addresses).
    const quoted = [...args.query.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase()).find((q) => q.includes('@'));
    assert.match(args.query, /subject:\("Delivery Status Notification" OR "Undeliverable" OR "Mail delivery failed" OR "Returned mail"\)/);
    const addr = (f) => (/<([^>]+)>/.exec(f)?.[1] || f).toLowerCase();
    const notice = (m) => /^(mailer-daemon|postmaster)@/.test(addr(m.from)) || /^(Delivery Status Notification|Undeliverable|Mail delivery failed|Returned mail)/i.test(String(m.subject || ''));
    const hits = this.inbox.filter((m) => Date.parse(m.date) > after && (froms.includes(addr(m.from)) || (notice(m) && quoted && String(m.body).toLowerCase().includes(quoted))));
    const emails = hits.slice(0, args.max_results).map((m) => email({ id: m.id, thread_id: m.threadId, from_: m.from, subject: m.subject, snippet: String(m.body || '').slice(0, 80), labels: m.labels, email_ts: m.date }));
    return searchResult(emails, { next_page_token: this.mode.search === 'incomplete' ? 'page-2' : null });
  }
  // gmail_get_profile({}): the connected account, in the real shape.
  profile(args) {
    this.profiles++;
    assert.deepEqual(args, {});
    if (this.mode.profile === 'throws') throw new Error('the Gmail tool is not available');
    return profileResult({ email: this.account });
  }
  // gmail_read_email_thread({ thread_id, max_messages }): every message in that thread, sent and received, in the
  // search's item shape (the result's shape wasn't captured: assumed, as floorboss assumes it).
  thread(args) {
    this.threads++;
    assert.deepEqual(Object.keys(args).sort(), ['max_messages', 'thread_id']);
    const mine = this.sentMail.filter((m) => m.threadId === args.thread_id).map((m) => email({ id: m.id, thread_id: m.threadId, from_: `Sam Lane <${this.account}>`, to: m.to, subject: m.subject, labels: ['SENT'], email_ts: m.date }));
    const theirs = this.inbox.filter((m) => m.threadId === args.thread_id).map((m) => email({ id: m.id, thread_id: m.threadId, from_: m.from, subject: m.subject, labels: m.labels, email_ts: m.date }));
    return threadResult([...mine, ...theirs].slice(0, args.max_messages));
  }
  send(args) {
    const keys = ['payload', 'response_fields', 'subject', 'to'];
    assert.deepEqual(Object.keys(args).filter((k) => k !== 'reply_message_id').sort(), keys, 'no cc, bcc, sender or anything else');
    assert.equal(typeof args.to, 'string');
    assert.deepEqual(Object.keys(args.payload).sort(), ['body', 'charset', 'mime_type']);
    assert.deepEqual([args.payload.mime_type, args.payload.charset, Object.keys(args.payload.body)], ['text/html', 'UTF-8', ['content']]);
    assert.deepEqual(args.response_fields, ['id', 'thread_id']);
    if (this.mode.send === 'throws') throw new Error('no answer from the tool');
    const replied = 'reply_message_id' in args ? this.sentMail.find((x) => x.id === args.reply_message_id) : null;
    if ('reply_message_id' in args) assert.ok(replied, `reply_message_id ${args.reply_message_id} is a message this mailbox sent`);
    const id = `out${++this.n}`;
    const m = { id, threadId: replied ? replied.threadId : `ot${this.n}`, to: [args.to], subject: args.subject, html: args.payload.body.content, reply_message_id: args.reply_message_id ?? null, date: new Date().toISOString() };
    this.sentMail.push(m);
    if (this.mode.send === 'noids') return sendResult({});
    return sendResult({ id: m.id, thread_id: m.threadId });
  }
}

// A cloud run: a fresh clone, and a model that does exactly what each step says. bad: a model that answers out of turn.
function cloudRun(bare, at, gmail, { onStep = null, extraEnv = {} } = {}) {
  const dir = cloneOf(bare);
  const env = { ...cloudEnv(dir, at), ...extraEnv };
  let id = 'new';
  let waits = 0;
  const steps = [];
  for (let i = 0; i < 400; i++) {
    const s = run(process.execPath, [CLI, 'next', '--run', id], env);
    assert.ok(!s.ERROR, s.ERROR);
    steps.push(s);
    if (s.run) id = s.run;
    if (onStep && onStep(s, { dir, env, id }) === 'halt') return { last: s, steps, id, dir, env };
    if (s.step === 'stop' || s.step === 'done') return { last: s, steps, id, dir, env, waits };
    if (s.step === 'wait') {
      // The gap between sends: the model sleeps; here the clock moves on by those seconds.
      assert.ok(s.seconds > 0 && s.seconds <= 40, String(s.seconds));
      env.FLOORBOSS_NOW = new Date(Date.parse(env.FLOORBOSS_NOW) + s.seconds * 1000).toISOString();
      waits++;
      continue;
    }
    if (s.step === 'profile' || s.step === 'thread') {
      assert.equal(s.tool, s.step === 'profile' ? 'mcp__codex_apps__gmail_get_profile' : 'mcp__codex_apps__gmail_read_email_thread');
      let ans;
      try {
        ans = s.step === 'profile' ? gmail.profile(s.args) : gmail.thread(s.args);
      } catch (e) {
        ans = `Error: ${e.message}`;
      }
      writeFileSync(s.write, typeof ans === 'string' ? ans : JSON.stringify(ans));
    } else if (s.step === 'search') {
      assert.equal(s.tool, 'mcp__codex_apps__gmail_search_emails');
      let ans;
      try {
        ans = gmail.search(s.args);
      } catch (e) {
        ans = `Error: ${e.message}`;
      }
      writeFileSync(s.write, typeof ans === 'string' ? ans : JSON.stringify(ans));
    } else if (s.step === 'send') {
      assert.equal(s.tool, 'mcp__codex_apps__gmail_send_email');
      let ans;
      try {
        ans = gmail.send(s.args);
      } catch {
        ans = undefined; // no answer: the model writes nothing
      }
      if (ans !== undefined) writeFileSync(s.write, JSON.stringify(ans));
    } else assert.fail(`unknown step ${JSON.stringify(s).slice(0, 200)}`);
    // The command carries its own settings (env FLOORBOSS_HOME=… FLOORBOSS_AUTOSEND=cloud node …): run as given, by a
    // shell with none of them set.
    assert.deepEqual(s.then.slice(0, 4), ['env', `FLOORBOSS_HOME=${dir}`, 'FLOORBOSS_AUTOSEND=cloud', 'node']);
    const bare = { ...env };
    delete bare.FLOORBOSS_HOME;
    delete bare.FLOORBOSS_AUTOSEND;
    const t = run(s.then[0], s.then.slice(1).map((a) => (a === 'node' ? process.execPath : a)), bare);
    assert.ok(!t.ERROR, t.ERROR);
  }
  assert.fail('the run never ended');
}
const remoteLedger = (bare) => (remoteFile(bare, `events/${SLUG}/ledger.jsonl`) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sentTo = (gmail, to) => gmail.sentMail.filter((m) => m.to[0] === to);
const T = (iso) => iso;

test('cases 1, 2, 4, 11: a whole sequence across cloud runs and the laptop: first messages, one a day, replies, a bounce, an auto-reply, a stop on the laptop, the follow-ups', { timeout: 1500000 }, () => {
  const { HOME, bare, items } = fresh();
  const gmail = new FakeGmail();
  const first = items.filter((x) => x.touch === 1);
  const people = first.length;
  assert.ok(people >= 10, `people approved for auto-send: ${people}`);

  // Case 1: the planned day, 10:00 in Lisbon. Every first message goes once, with the exact text, to the one address.
  const r1 = cloudRun(bare, T('2026-10-12T09:00:00Z'), gmail);
  assert.equal(r1.last.step, 'done', JSON.stringify(r1.last).slice(0, 400));
  assert.equal(gmail.sentMail.length, people);
  for (const x of first) {
    const got = sentTo(gmail, x.to);
    assert.equal(got.length, 1, x.id);
    assert.deepEqual([got[0].to, got[0].subject, got[0].html], [[x.to], x.subject, htmlBody(x.body)], x.id);
  }
  let led = remoteLedger(bare);
  for (const x of first) {
    const mine = led.filter((e) => e.id === x.id && e.touch === 1 && ['autosend_released', 'sent'].includes(e.type));
    assert.deepEqual(mine.map((e) => e.type), ['autosend_released', 'sent'], x.id);
    assert.match(mine[1].message_id, /^out\d+$/);
    assert.match(mine[1].thread_id, /^ot\d+$/);
  }
  const commits = commitsOf(bare);
  assert.ok(commits.some((c) => /^lock cloud /.test(c)) && commits.some((c) => /^release /.test(c)) && commits.some((c) => /^sent /.test(c)) && /^unlock cloud /.test(commits[0]), commits.slice(0, 5).join(' | '));
  assert.equal(remoteFile(bare, 'autosend/lock.json'), null, 'lock gone');
  assert.match(remoteFile(bare, 'autosend/log-2026-10-12.md'), /sent mock-harbour-haul c\d+ message 1/);

  // Case 2: the same day, a second run: nothing more goes.
  const r2 = cloudRun(bare, T('2026-10-12T10:00:00Z'), gmail);
  assert.equal(r2.last.step, 'done');
  assert.equal(gmail.sentMail.length, people);
  assert.equal(r2.last.summary.waiting, people);

  // Replies come in: one person answers, one address bounces, one sends an out-of-office.
  const [a, b, c, d] = first;
  gmail.deliver({ from: `Someone <${a.to}>`, subject: `Re: ${a.subject}`, date: '2026-10-14T10:00:00Z', body: 'Tuesday works' });
  gmail.deliver({ from: 'Mail Delivery Subsystem <mailer-daemon@mail.example>', subject: 'Delivery Status Notification (Failure)', date: '2026-10-12T09:05:00Z', body: `Your message to ${b.to} couldn't be delivered.` });
  gmail.deliver({ from: c.to, subject: 'Automatic reply: away this week', date: '2026-10-13T08:00:00Z', body: 'I am away' });
  // A colleague answers in the first message's thread (from another address: the address search never finds it), and
  // another server bounces by its notice subject from an address that isn't mailer-daemon.
  const [f, g] = first.slice(4);
  const fMail = sentTo(gmail, f.to)[0];
  gmail.deliver({ from: 'Bo Chen <bo@colleague.example>', subject: `Re: ${f.subject}`, date: '2026-10-14T11:00:00Z', body: 'I look after this now', threadId: fMail.threadId });
  gmail.deliver({ from: 'Microsoft Outlook <MicrosoftExchange329e@gateway.example>', subject: `Undeliverable: ${g.subject}`, date: '2026-10-12T09:10:00Z', body: `Delivery has failed to these recipients: ${g.to}` });

  // The laptop, a later day: it pulls the cloud's sends, takes the lock and records a stop the user tells it about.
  const day7 = T('2026-10-19T08:30:00Z');
  const s = laptop(HOME, day7, ['sync', 'start', '--who', 'laptop', '--run', 'laptop-1']);
  assert.equal(s.started, true, JSON.stringify(s));
  const lapLed = readFileSync(join(HOME, 'events', SLUG, 'ledger.jsonl'), 'utf8');
  assert.ok(lapLed.includes('"source":"autosend"'), "the laptop has the cloud's sends");
  const rec = join(HOME, 'work', 'stop.json');
  writeFileSync(rec, JSON.stringify({ items: [{ who: d.id, what: 'stop', said: 'asked me to stop' }] }));
  const recorded = run(process.execPath, [join(ROOT, 'skills/event-outreach/scripts/cli.mjs'), 'record', '--event', SLUG, '--file', rec], laptopEnv(HOME, day7));
  assert.equal(recorded.applied, true, JSON.stringify(recorded).slice(0, 300));

  // Case 11: the laptop holds the lock: the cloud run stops before anything, and says who holds it.
  const r3 = cloudRun(bare, T('2026-10-19T09:00:00Z'), gmail);
  assert.equal(r3.last.step, 'stop');
  assert.match(r3.last.why, /held by the laptop \(run laptop-1\)/);
  assert.equal(gmail.sentMail.length, people);
  assert.equal(gmail.searches, people, 'no search either');
  const e = laptop(HOME, T('2026-10-19T08:45:00Z'), ['sync', 'end', '--run', 'laptop-1']);
  assert.deepEqual(e, { ok: true });

  // Case 4: the follow-ups on their day, for everyone but the reply, the bounce, the auto-reply and the stop.
  const r4 = cloudRun(bare, T('2026-10-19T10:00:00Z'), gmail);
  assert.equal(r4.last.step, 'done', JSON.stringify(r4.last).slice(0, 400));
  const second = items.filter((x) => x.touch === 2);
  for (const x of second) {
    const got = sentTo(gmail, x.to).filter((m) => m.subject === x.subject && m.html === htmlBody(x.body));
    const quiet = ![a.id, b.id, c.id, d.id, f.id, g.id].includes(x.id);
    assert.equal(got.length, quiet ? 1 : 0, `${x.id} follow-up`);
    // The follow-up replies to their first message, so it goes in that thread.
    if (quiet) {
      const firstMail = sentTo(gmail, x.to)[0];
      assert.equal(got[0].reply_message_id, firstMail.id, `${x.id} follow-up threads`);
      assert.equal(got[0].threadId, firstMail.threadId);
      assert.equal(firstMail.reply_message_id, null, 'a first message is a new email');
    }
  }
  assert.equal(gmail.sentMail.length, people + second.length - 6);
  led = remoteLedger(bare);
  assert.ok(led.some((e2) => e2.type === 'replied' && e2.id === f.id && /bo@colleague\.example/.test(e2.text)), 'the colleague in the thread stops them');
  assert.ok(led.some((e2) => e2.type === 'bounced' && e2.id === g.id), 'a bounce by its subject');
  // Every run checked the account first, and every follow-up read its thread.
  assert.ok(gmail.profiles >= 4, `profiles: ${gmail.profiles}`);
  assert.ok(gmail.threads >= second.length - 4, `threads: ${gmail.threads}`);
  assert.ok(led.some((e2) => e2.type === 'replied' && e2.id === a.id && e2.outcome === 'replied'));
  assert.ok(led.some((e2) => e2.type === 'bounced' && e2.id === b.id));
  assert.ok(led.some((e2) => e2.type === 'replied' && e2.id === c.id && e2.outcome === 'auto_reply'));
  assert.deepEqual(r4.last.summary.stopped_people.map((x) => x.split(' ')[1].replace(':', '')).sort(), [a.id, b.id, c.id, f.id, g.id].sort());
  // Never due again.
  const r5 = cloudRun(bare, T('2026-10-20T10:00:00Z'), gmail);
  assert.equal(r5.last.step, 'done');
  assert.equal(gmail.sentMail.length, people + second.length - 6);
  // Another Gmail account connected: the run stops at its first step, before any search or send.
  const searches = gmail.searches;
  gmail.account = 'someone@else.example';
  const r6 = cloudRun(bare, T('2026-10-20T11:00:00Z'), gmail);
  assert.equal(r6.last.step, 'stop');
  assert.match(r6.last.why, /connected Gmail account is someone@else\.example/);
  assert.equal(gmail.searches, searches);
  gmail.account = OWN;

  // The laptop's next session pulls it all: nothing to settle.
  assert.equal(laptop(HOME, T('2026-10-21T08:00:00Z'), ['sync', 'start', '--who', 'laptop', '--run', 'laptop-2']).started, true);
  const st = laptop(HOME, T('2026-10-21T08:00:00Z'), ['status']);
  assert.deepEqual(st.events[0].to_settle, []);
  assert.equal(st.blocked, null);
  assert.deepEqual(laptop(HOME, T('2026-10-21T08:01:00Z'), ['sync', 'end', '--run', 'laptop-2']), { ok: true });
});

test('case 3 and 8: out of hours nothing is searched; a search answer that is garbage, an error or incomplete stops the run with nothing sent and the lock released', { timeout: 900000 }, () => {
  const keep = built().people.slice(0, 2);
  const { bare } = fresh(keep);
  const gmail = new FakeGmail();
  for (const at of ['2026-10-12T07:59:00Z', '2026-10-17T10:00:00Z']) {
    const r = cloudRun(bare, at, gmail);
    assert.equal(r.last.step, 'done');
    assert.match(r.last.summary.waits.join(' '), /08:59 in Lisbon|weekend/);
  }
  assert.equal(gmail.searches, 0);
  for (const mode of ['garbage', 'error', 'incomplete', 'throws']) {
    gmail.mode.search = mode;
    const r = cloudRun(bare, '2026-10-12T09:00:00Z', gmail);
    assert.equal(r.last.step, 'stop', mode);
    assert.match(r.last.why, /can't be read|incomplete/, mode);
    assert.equal(r.last.lock, 'released', mode);
    assert.equal(remoteFile(bare, 'autosend/lock.json'), null, mode);
    assert.equal(gmail.sentMail.length, 0, mode);
    assert.ok(!remoteLedger(bare).some((e) => e.type === 'autosend_released'), mode);
  }
  // The search is safe to repeat: the next run, with a good answer, sends both.
  gmail.mode.search = 'ok';
  const r = cloudRun(bare, '2026-10-12T09:30:00Z', gmail);
  assert.equal(r.last.step, 'done');
  assert.equal(gmail.sentMail.length, 2);
});

test('cases 9 and 10: a send answer with no ids, or no answer at all: unclear, the run stops, nothing more until the user settles it on the laptop; then the follow-up goes on its day', { timeout: 900000 }, () => {
  const keep = built().people.slice(0, 2);
  const { HOME, bare, items } = fresh(keep);
  const gmail = new FakeGmail();
  const [p, q] = keep.map((id) => items.find((x) => x.id === id && x.touch === 1));
  gmail.mode.send = 'noids';
  const r1 = cloudRun(bare, '2026-10-12T09:00:00Z', gmail);
  assert.equal(r1.last.step, 'stop');
  assert.match(r1.last.why, /unclear/);
  assert.equal(gmail.sentMail.length, 1, 'the one send went; nothing after it');
  assert.ok(remoteLedger(bare).some((e) => e.type === 'send_unclear' && e.id === p.id));
  assert.ok(remoteFile(bare, 'autosend/lock.json'), 'the lock stays with an unclear send');
  // The next run: nothing.
  gmail.mode.send = 'ok';
  const r2 = cloudRun(bare, '2026-10-12T10:00:00Z', gmail);
  assert.equal(r2.last.step, 'stop');
  assert.equal(gmail.sentMail.length, 1);
  // The laptop: the lock is the cloud's; status names the step; the user checks Sent, unlocks, and says it went.
  const at = '2026-10-12T11:00:00Z';
  assert.match(laptop(HOME, at, ['sync', 'start', '--who', 'laptop', '--run', 'l1']).stop, /held by the cloud/);
  const st = laptop(HOME, at, ['status']);
  assert.equal(st.events[0].to_settle.length, 1);
  assert.equal(st.events[0].to_settle[0].id, p.id);
  assert.equal(st.events[0].to_settle[0].subject, p.subject);
  assert.match(st.blocked, /unclear/);
  assert.equal(laptop(HOME, at, ['sync', 'unlock']).unlocked, false, 'shown first');
  assert.equal(laptop(HOME, at, ['sync', 'unlock', '--said', 'I looked in Sent, unlock it']).unlocked, true);
  assert.equal(laptop(HOME, at, ['sync', 'start', '--who', 'laptop', '--run', 'l2']).started, true);
  assert.equal(laptop(HOME, at, ['settle', '--event', SLUG, '--id', p.id, '--touch', '1', '--went', 'yes', '--said', "it's in my Sent folder"]).recorded, 'sent');
  assert.deepEqual(laptop(HOME, at, ['sync', 'end', '--run', 'l2']), { ok: true });
  // The other person's first message, the same day; nothing again for the settled one.
  const r3 = cloudRun(bare, '2026-10-12T12:00:00Z', gmail);
  assert.equal(r3.last.step, 'done', JSON.stringify(r3.last).slice(0, 300));
  assert.equal(sentTo(gmail, p.to).length, 1);
  assert.equal(sentTo(gmail, q.to).length, 1);
  // Case 10: no answer at all for the follow-up of the one, on its day.
  gmail.mode.send = 'throws';
  const r4 = cloudRun(bare, '2026-10-19T09:00:00Z', gmail);
  assert.equal(r4.last.step, 'stop');
  assert.match(r4.last.why, /unclear.*no answer|no answer/);
  const pending = remoteLedger(bare).filter((e) => e.type === 'send_unclear');
  assert.equal(pending.length, 2);
  // Settled as "it didn't go": never auto-sent again, back to the outbox for the user.
  const at2 = '2026-10-19T11:00:00Z';
  laptop(HOME, at2, ['sync', 'unlock', '--said', 'checked Sent, nothing there']);
  assert.equal(laptop(HOME, at2, ['sync', 'start', '--who', 'laptop', '--run', 'l3']).started, true);
  const who = pending[1].id;
  assert.equal(laptop(HOME, at2, ['settle', '--event', SLUG, '--id', who, '--touch', '2', '--went', 'no', '--said', 'not in my Sent folder']).recorded, 'not sent');
  assert.deepEqual(laptop(HOME, at2, ['sync', 'end', '--run', 'l3']), { ok: true });
  gmail.mode.send = 'ok';
  const before = gmail.sentMail.length;
  const r5 = cloudRun(bare, '2026-10-19T12:00:00Z', gmail);
  assert.equal(r5.last.step, 'done');
  assert.match(r5.last.summary.waits.join(' '), /never sent again by auto-send/);
  const other = keep.find((id) => id !== who);
  assert.equal(gmail.sentMail.length - before, 1, "only the other person's follow-up");
  assert.ok(gmail.sentMail.at(-1).to[0] === items.find((x) => x.id === other && x.touch === 2).to);
});

// A server-side hook on the fake remote that refuses a push holding a commit whose message starts with a word.
function refusePushesOf(bare, word) {
  const hook = join(bare, 'hooks', 'pre-receive');
  mkdirSync(join(bare, 'hooks'), { recursive: true });
  // Any commit in the push with that word (the push never gets it through, however often it is tried).
  writeFileSync(hook, `#!/bin/sh\nwhile read old new ref; do\n  if git log --format=%s "$old..$new" | grep -q "^${word} "; then echo "refused" >&2; exit 1; fi\ndone\nexit 0\n`);
  chmodSync(hook, 0o755);
  return () => rmSync(hook);
}

test('case 13: the release push fails: nothing is sent, the lock is released, and the step is still due next run', { timeout: 900000 }, () => {
  const keep = built().people.slice(0, 1);
  const { bare, items } = fresh(keep);
  const gmail = new FakeGmail();
  const allow = refusePushesOf(bare, 'release');
  const r1 = cloudRun(bare, '2026-10-12T09:00:00Z', gmail);
  assert.equal(r1.last.step, 'stop');
  assert.match(r1.last.why, /release mark couldn't be pushed, so nothing was sent/);
  assert.equal(gmail.sentMail.length, 0);
  assert.equal(remoteFile(bare, 'autosend/lock.json'), null);
  assert.ok(!remoteLedger(bare).some((e) => e.type === 'autosend_released'));
  allow();
  const r2 = cloudRun(bare, '2026-10-12T10:00:00Z', gmail);
  assert.equal(r2.last.step, 'done');
  assert.equal(sentTo(gmail, items[0].to).length, 1);
});

test('case 14: the record push fails after the send: the run stops with the lock kept; after unlock that step is never sent again', { timeout: 900000 }, () => {
  const keep = built().people.slice(0, 2);
  const { HOME, bare, items } = fresh(keep);
  const gmail = new FakeGmail();
  const allow = refusePushesOf(bare, 'sent');
  const r1 = cloudRun(bare, '2026-10-12T09:00:00Z', gmail);
  assert.equal(r1.last.step, 'stop');
  assert.match(r1.last.why, /record couldn't be pushed/);
  assert.equal(gmail.sentMail.length, 1);
  const firstTo = gmail.sentMail[0].to[0];
  assert.ok(remoteFile(bare, 'autosend/lock.json'), 'lock kept');
  allow();
  assert.match(cloudRun(bare, '2026-10-12T10:00:00Z', gmail).last.why, /held by the cloud/);
  laptop(HOME, '2026-10-12T11:00:00Z', ['sync', 'unlock', '--said', 'checked my Sent folder']);
  // Unlocked: the release mark is in the remote and its send isn't: every run is blocked until it is settled.
  const r3 = cloudRun(bare, '2026-10-12T12:00:00Z', gmail);
  assert.equal(r3.last.step, 'stop');
  assert.match(r3.last.why, /nothing may go/);
  assert.equal(gmail.sentMail.length, 1);
  assert.equal(laptop(HOME, '2026-10-12T13:00:00Z', ['sync', 'start', '--who', 'laptop', '--run', 'l1']).started, true);
  const who = items.find((x) => x.to === firstTo).id;
  assert.equal(laptop(HOME, '2026-10-12T13:00:00Z', ['settle', '--event', SLUG, '--id', who, '--touch', '1', '--went', 'yes', '--said', 'it is in Sent']).recorded, 'sent');
  assert.deepEqual(laptop(HOME, '2026-10-12T13:01:00Z', ['sync', 'end', '--run', 'l1']), { ok: true });
  const r4 = cloudRun(bare, '2026-10-12T14:00:00Z', gmail);
  assert.equal(r4.last.step, 'done');
  assert.equal(sentTo(gmail, firstTo).length, 1, 'never twice');
  assert.equal(gmail.sentMail.length, 2);
});

test('a bad model: a step answered out of order, another file, a send asked for twice, a send reported for a step not released: all refused, nothing sent twice', { timeout: 900000 }, () => {
  const keep = built().people.slice(0, 1);
  const { bare } = fresh(keep);
  const gmail = new FakeGmail();
  let sends = 0;
  const r = cloudRun(bare, '2026-10-12T09:00:00Z', gmail, {
    onStep: (s, { env, dir }) => {
      if (s.step === 'search') {
        // Reports a send while the search is the open step.
        const w = join(dir, '..', 'fake-send.json');
        writeFileSync(w, JSON.stringify({ id: 'x', threadId: 'y' }));
        assert.match(run(process.execPath, [CLI, 'sent', '--run', s.run, '--file', w], env).ERROR, /no send step is open/);
        // Answers with another file than the one named.
        writeFileSync(w, '{}');
        assert.match(run(process.execPath, [CLI, 'checked', '--run', s.run, '--file', w], env).ERROR, /isn't the file the current step named/);
      }
      if (s.step === 'send') {
        sends++;
        // Asks for the next step without recording the send: never asked to send again.
        const again = run(process.execPath, [CLI, 'next', '--run', s.run], env);
        assert.equal(again.step, 'stop');
        assert.match(again.why, /may have gone/);
        return 'halt';
      }
    }
  });
  assert.equal(r.last.step, 'send');
  assert.equal(sends, 1);
  assert.equal(gmail.sentMail.length, 0);
  assert.ok(remoteLedger(bare).some((e) => e.type === 'send_unclear'));
  const after = cloudRun(bare, '2026-10-12T10:00:00Z', gmail);
  assert.equal(after.last.step, 'stop');
  assert.equal(gmail.sentMail.length, 0);
});

test('a failure part-way (a ledger line that fails to write) stops the run where it is, nothing sent, the lock released', { timeout: 900000 }, () => {
  const keep = built().people.slice(0, 1);
  const { bare } = fresh(keep);
  const gmail = new FakeGmail();
  const r = cloudRun(bare, '2026-10-12T09:00:00Z', gmail, { extraEnv: { FLOORBOSS_FAIL_ENTRY: `reply_checked:${keep[0]}` } });
  assert.equal(r.last.step, 'stop');
  assert.match(r.last.why, /failed part-way/);
  assert.equal(r.last.lock, 'released');
  assert.equal(remoteFile(bare, 'autosend/lock.json'), null);
  assert.equal(gmail.sentMail.length, 0);
  const again = cloudRun(bare, '2026-10-12T10:00:00Z', gmail);
  assert.equal(again.last.step, 'done');
  assert.equal(gmail.sentMail.length, 1);
});

test('review fix 3: after a cloud run moved the repo, a stop recorded and a revoke on the laptop (no sync start) both reach the cloud: the follow-ups never go', { timeout: 900000 }, () => {
  const keep = built().people.slice(0, 2);
  const { HOME, bare, items } = fresh(keep);
  const gmail = new FakeGmail();
  const r1 = cloudRun(bare, '2026-10-12T09:00:00Z', gmail);
  assert.equal(r1.last.step, 'done');
  assert.equal(gmail.sentMail.length, 2);
  const [p, q] = keep;
  const at = '2026-10-13T08:00:00Z';
  const rec = join(HOME, 'work', 'stop-p.json');
  writeFileSync(rec, JSON.stringify({ items: [{ who: p, what: 'stop', said: 'asked me to stop' }] }));
  const recorded = run(process.execPath, [join(ROOT, 'skills/event-outreach/scripts/cli.mjs'), 'record', '--event', SLUG, '--file', rec], laptopEnv(HOME, at));
  assert.equal(recorded.applied, true, JSON.stringify(recorded).slice(0, 400));
  assert.ok(remoteLedger(bare).some((e) => e.type === 'stop' && e.id === p), 'the stop is in the remote');
  const rv = laptop(HOME, at, ['revoke', '--event', SLUG, '--ids', q, '--said-file', saidFile(HOME, 'stop auto-send for them')]);
  assert.equal(rv.pushed, true, JSON.stringify(rv).slice(0, 400));
  assert.ok(remoteLedger(bare).some((e) => e.type === 'autosend_revoked' && e.id === q));
  assert.equal(remoteFile(bare, 'autosend/lock.json'), null);
  const r2 = cloudRun(bare, '2026-10-19T09:00:00Z', gmail);
  assert.equal(r2.last.step, 'done', JSON.stringify(r2.last).slice(0, 300));
  assert.equal(gmail.sentMail.length, 2, 'no follow-up went');
  void items;
});

// Round 3, items 1 and 2: auto-send turned on after the first messages were approved (as a beginner does it). The
// flow then asks for every planned follow-up (critic and approval included) before the readback; the readback holds
// anyone whose sequence isn't whole; the first message goes, then the follow-up on its day, each after its search.
// A first message whose day went by comes back to the outbox with its buttons, and the readback plans it again.
test('round 3 items 1 and 2: on after the content approval: follow-ups drafted and approved, then both messages go, each after a search; a missed day goes back to hand-send and is re-planned', { timeout: 1500000 }, () => {
  const HOME = mkdtempSync(join(tmpdir(), 'fb-autosend-late-'));
  mkdirSync(join(HOME, 'work'), { recursive: true });
  mkdirSync(join(HOME, 'scan-home'), { recursive: true });
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  const env = laptopEnv(HOME, BUILT_AT);
  execFileSync(process.execPath, [join(ROOT, 'examples/mock-event/load.mjs'), '--goal', 'buyers', '--now', BUILT_AT], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const per = simplePersona({ slug: SLUG, asks: { check_these: (st) => st.ask.people.map((p) => `${p.id} different-person`).join('\n'), rate: 'skip', voice_samples: 'skip', replies_since: 'none' } });
  const r0 = drive({ HOME, now: BUILT_AT, env }, per, { maxSteps: 260 });
  assert.ok(r0.last.done || r0.last.step === 'waiting', r0.trail.slice(-6).join(' '));
  const ledger = () => readFileSync(join(HOME, 'events', SLUG, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(!ledger().some((e) => e.type === 'approved' && e.touch === 2), 'hand-send approved first messages only');
  const on = laptop(HOME, BUILT_AT, ['on', '--event', SLUG, '--said', 'yes, send them from the cloud', '--own', OWN]);
  assert.ok(!on.ERROR, on.ERROR);
  // Round 3 item 7: not a repo yet: said plainly.
  assert.match(on.say || '', /isn't in a repo yet: do setup step 1 first/);
  // Before the follow-ups exist, the readback holds everyone.
  const early = laptop(HOME, BUILT_AT, ['readback', '--event', SLUG]);
  assert.equal(early.messages, 0, JSON.stringify(early).slice(0, 300));
  assert.match(early.refused.map((x) => x.why).join(' '), /message 2 of their sequence isn't written and approved yet/);
  const r1 = drive({ HOME, now: BUILT_AT, env }, per, { maxSteps: 260 });
  assert.ok(r1.last.done || r1.last.step === 'waiting', r1.trail.slice(-6).join(' '));
  const approvedT2 = ledger().filter((e) => e.type === 'approved' && e.touch === 2).map((e) => e.id);
  assert.ok(approvedT2.length >= 1, 'the follow-ups were drafted, read by the critic and approved');
  const rb = laptop(HOME, BUILT_AT, ['readback', '--event', SLUG]);
  assert.ok(rb.messages >= 2 && rb.people >= 1, JSON.stringify(rb).slice(0, 300));
  const ok = laptop(HOME, BUILT_AT, ['approve', '--event', SLUG, '--digest', rb.digest, '--said-file', saidFile(HOME, 'auto-send these sequences')]);
  assert.ok(!ok.ERROR, ok.ERROR);
  const yes = ledger().filter((e) => e.type === 'autosend_approved');
  const p1 = yes.find((e) => e.touch === 2).id;
  const items = yes.filter((e) => e.id === p1).map((e) => ({ ...e, ...JSON.parse(readFileSync(join(HOME, 'events', SLUG, 'drafts', `${e.hash}.json`), 'utf8')) }));
  // Keep one person, so the runs are short.
  const others = [...new Set(yes.map((e) => e.id))].filter((id) => id !== p1);
  if (others.length) assert.ok(!laptop(HOME, BUILT_AT, ['revoke', '--event', SLUG, '--ids', others.join(','), '--said', 'only one for this test']).ERROR);
  const { bare } = remoteFor(HOME);
  const gmail = new FakeGmail();
  const seen = [];
  const watch = (s) => {
    if (s.step === 'search' || s.step === 'send') seen.push(s.step);
  };
  const d1 = cloudRun(bare, '2026-10-12T09:00:00Z', gmail, { onStep: watch });
  assert.equal(d1.last.step, 'done', JSON.stringify(d1.last).slice(0, 300));
  const t1 = items.find((x) => x.touch === 1);
  assert.deepEqual(gmail.sentMail.map((m) => [m.to[0], m.subject]), [[t1.to, t1.subject]]);
  const t2 = items.find((x) => x.touch === 2);
  const d2 = cloudRun(bare, `${t2.planned_due}T09:00:00Z`, gmail, { onStep: watch });
  assert.equal(d2.last.step, 'done', JSON.stringify(d2.last).slice(0, 300));
  assert.deepEqual(gmail.sentMail.map((m) => m.subject), [t1.subject, t2.subject]);
  assert.equal(gmail.sentMail[1].html, htmlBody(t2.body));
  assert.deepEqual(seen, ['search', 'send', 'search', 'send'], 'a reply check before each send');
});

test('round 3 item 2: a first message whose day went by is the user\'s again on the outbox, with its buttons; the readback plans it again', { timeout: 900000 }, () => {
  const keep = built().people.slice(0, 1);
  const { HOME } = fresh(keep);
  const late = '2026-10-15T09:00:00Z';
  // The outbox page with auto-send on needs this session's lock (round 6, item 3).
  assert.equal(laptop(HOME, late, ['sync', 'start', '--who', 'laptop', '--run', 'laptop-r3i2']).started, true);
  const page = run(process.execPath, [join(ROOT, 'skills/event-outreach/scripts/cli.mjs'), 'render', '--event', SLUG], laptopEnv(HOME, late));
  assert.ok(!page.ERROR, page.ERROR);
  const html = readFileSync(join(HOME, 'events', SLUG, 'outbox.html'), 'utf8');
  assert.match(html, /Auto-send missed its day/);
  const rb = laptop(HOME, late, ['readback', '--event', SLUG]);
  assert.ok(rb.people >= 1, JSON.stringify(rb).slice(0, 300));
  assert.match(rb.text, /Message 1, planned for .*\(2026-10-15\)/);
});

test('case 16: in Claude Code the auto-send commands refuse, and the laptop never runs a send step', () => {
  const HOME = mkdtempSync(join(tmpdir(), 'fb-autosend-cc-'));
  const env = { ...process.env, FLOORBOSS_TEST: '1', FLOORBOSS_HOME: HOME, CLAUDECODE: '1', FLOORBOSS_AUTOSEND: 'cloud' };
  for (const k of MARKERS) delete env[k];
  assert.match(run(process.execPath, [CLI, 'next', '--run', 'new'], env).ERROR, /auto-send is for Codex; Claude Code has its own sending/);
  assert.match(laptop(HOME, BUILT_AT, ['next', '--run', 'new']).ERROR, /cloud task only/);
  void git;
});
