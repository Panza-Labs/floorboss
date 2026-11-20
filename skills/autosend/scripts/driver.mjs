// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// U6. The cloud run's driver: a small loop the model follows, one step at a time, like the flow's `next`.
//   next     -> { step: 'search' | 'send', tool, args, write, then } | { step: 'stop', why } | { step: 'done', summary }
//   checked  <- the search tool's answer, saved by the model in the file the step named
//   sent     <- the send tool's answer, the same way
// The run file (autosend/runs/<run>.json in the data folder) holds the current step, so a step answered out of order is
// refused. Order with a send: sync start -> search -> decide, apply -> release -> push -> send -> record -> push -> ...
// -> sync end. The release mark is confirmed in the remote before any send step is shown (a push killed part-way is
// checked again: not there, the step is discarded and stays due), and the send is shown only within FRESH_MS of the
// search being given, in the event's hours, with Claude Code's email sending off; else the release is withdrawn.
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync, mkdirSync, lstatSync, openSync, closeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeJson, appendLine } from '../../../lib/jsonio.mjs';
import { append } from '../../../lib/ledger.mjs';
import { dueNow } from '../../../lib/autosend/plan.mjs';
import { query, decide, decideThread, threadArgs, profileEmail, sameAccount, apply, MAX_RESULTS } from '../../../lib/autosend/replycheck.mjs';
import { release, sendArgs, record } from '../../../lib/autosend/sendrecord.mjs';
import { start, checkpoint, end, discardUnpushed, pushedAll } from '../../../lib/autosend/sync.mjs';
import { eventDirOf, eventJson, ledgerOf, readEvent, stepMark, claudeSendsEmail, autosendEvents, FRESH_MS } from '../../../lib/autosend/common.mjs';
import { hoursWhy } from '../../../lib/unattended-drafts.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
// The Gmail tools, by the names a live ChatGPT/Codex cloud run showed (2026-11-20): the ChatGPT-connected Gmail app,
// which Codex shows with an mcp__codex_apps__ prefix. The step's args are that tool's own (sendArgs), so no other
// Gmail tool is named.
export const SEARCH_TOOLS = Object.freeze(['mcp__codex_apps__gmail_search_emails', 'gmail_search_emails']);
export const SEND_TOOLS = Object.freeze(['mcp__codex_apps__gmail_send_email', 'gmail_send_email']);
export const PROFILE_TOOLS = Object.freeze(['mcp__codex_apps__gmail_get_profile', 'gmail_get_profile']);
export const THREAD_TOOLS = Object.freeze(['mcp__codex_apps__gmail_read_email_thread', 'gmail_read_email_thread']);
const MAX_ANSWER = 1024 * 1024;

const runsDir = (home) => join(home, 'autosend', 'runs');
const runFile = (home, run) => join(runsDir(home), `${run}.json`);
const answerDir = (run) => join(tmpdir(), 'floorboss-autosend', run);
const RUN_RE = /^[\w-]{1,64}$/;
const iso = (ms) => new Date(ms).toISOString();

// A step answered out of turn, or with another file: refused, and the run goes on as it was.
class Refused extends Error {}

// Which checkout started a run: a mark under .git (never committed, never pushed), written at next --run new. The run
// file in autosend/runs/ is synced, so a later cloud run (another container, a fresh clone) reads it too; without the
// mark it never resumes that run: it can't know whether the send was shown, so it can't withdraw it, and it never
// drops that run's lock. The mark also says, for this checkout, which send steps were shown (written before the step
// is given), so a withdraw needs proof here that the send was never shown.
const ownDir = (home) => join(home, '.git', 'floorboss-autosend');
const ownFile = (home, run) => join(ownDir(home), `${run}.json`);
function claim(home, run) {
  const g = join(home, '.git');
  if (!existsSync(g) || !lstatSync(g).isDirectory()) throw new Error("the data folder isn't a plain git checkout (its .git isn't a folder), so this run can't mark itself: nothing was changed. Clone the data repo plainly (git clone, no separate git folder)");
  mkdirSync(ownDir(home), { recursive: true, mode: 0o700 });
  const nonce = randomBytes(12).toString('hex');
  writeJson(ownFile(home, run), { run, nonce, shown: [] });
  return nonce;
}
function ownMark(home, r) {
  try {
    const m = JSON.parse(readFileSync(ownFile(home, r.run), 'utf8'));
    return m && m.run === r.run && typeof r.nonce === 'string' && m.nonce === r.nonce && Array.isArray(m.shown) ? m : null;
  } catch {
    return null;
  }
}
const FOREIGN = (run) =>
  `run ${run} was started in another checkout (an earlier cloud run): it is never resumed here, its lock stays, and nothing about it is changed. If that run died, the user checks Gmail's Sent folder and settles it on the laptop (autosend status). Start with next --run new`;
function loadRun(home, run) {
  if (!RUN_RE.test(String(run || ''))) throw new Refused('--run is the run id the first step gave');
  const f = runFile(home, run);
  if (!existsSync(f)) throw new Refused(`no run ${run} in this data folder: start with next --run new`);
  const r = JSON.parse(readFileSync(f, 'utf8'));
  if (!ownMark(home, r)) throw new Refused(FOREIGN(run));
  return r;
}
const stepKey = (r) => `${r.n}`;
// Marked shown here before the send step is given: a run that dies after it is never withdrawn.
function markShown(home, r) {
  const m = ownMark(home, r);
  if (!m) throw new Refused(FOREIGN(r.run));
  writeJson(ownFile(home, r.run), { ...m, shown: [...new Set([...m.shown, stepKey(r)])] });
}
// The send step, claimed once with an exclusive create in this checkout's mark folder before it is given: of two
// next calls at once, only the one that made the file gets the send; the other stops and changes nothing.
const claimFile = (home, r) => join(ownDir(home), `${r.run}-${stepKey(r)}.send`);
function claimSend(home, r) {
  try {
    closeSync(openSync(claimFile(home, r), 'wx', 0o600));
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}
const claimed = (home, r) => existsSync(claimFile(home, r));
const shownHere = (home, r) => {
  const m = ownMark(home, r);
  return !m || m.shown.includes(stepKey(r));
};
const saveRun = (home, r) => writeJson(runFile(home, r.run), r);

// One line per thing that happened, in autosend/log-<day>.md, committed with the rest.
// Never through a link (lib/jsonio.mjs appendLine: the folders on the way and the file itself, no second name): a log
// that is one throws, and the run stops (guarded); the stop itself then logs nothing (quiet).
function log(home, r, nowMs, text, { quiet = false } = {}) {
  const day = iso(nowMs).slice(0, 10);
  const f = join(home, 'autosend', `log-${day}.md`);
  try {
    if (!existsSync(f)) appendLine(f, `# floorboss auto-send, ${day} (UTC)\n`);
    appendLine(f, `- ${iso(nowMs).slice(11, 16)} UTC, run ${r.run}: ${String(text).replace(/\s+/g, ' ').slice(0, 400)}`);
  } catch (e) {
    if (quiet) return;
    throw new Error(`the run log can't be written safely (${String(e.message).slice(0, 160)})`);
  }
}

// The next command, with the two settings it needs in front (env), so it runs the same in a fresh shell.
const then = (home, sub, run, file) => ['env', `FLOORBOSS_HOME=${home}`, 'FLOORBOSS_AUTOSEND=cloud', 'node', CLI, sub, '--run', run, '--file', file];

// The run ends here and says why. lock: drop it (end), keep it (an unclear send, or a push that failed after one), or
// discard what wasn't pushed first (a release that never reached the remote).
function stopRun(home, r, nowMs, why, { lock = 'drop' } = {}) {
  r.state = 'stopped';
  r.why = why;
  r.current = null;
  if (lock === 'discard') {
    discardUnpushed({ home });
  }
  log(home, r, nowMs, `stopped: ${why}`, { quiet: true });
  saveRun(home, r);
  if (lock === 'keep') {
    r.lock = 'kept';
    saveRun(home, r);
    const c = checkpoint({ home, message: `stop ${r.run}` });
    return { step: 'stop', why, lock: 'kept', ...(c.stop ? { push: c.stop } : {}) };
  }
  r.lock = 'released';
  saveRun(home, r);
  const e = end({ home, runId: r.run });
  return { step: 'stop', why, lock: e.ok ? 'released' : 'kept', ...(e.stop ? { push: e.stop } : {}) };
}

const WRITE_ALL = "Write the tool's whole result object as JSON (JSON.stringify of the full result, structuredContent included, an error too) to the write file, then run then.";
function profileStep(home, r) {
  return {
    step: 'profile',
    run: r.run,
    tool: PROFILE_TOOLS[0],
    tool_names: PROFILE_TOOLS,
    args: {},
    write: r.current.file,
    then: then(home, 'checked', r.run, r.current.file),
    say: `Call the Gmail profile tool ${PROFILE_TOOLS[0]} (or the one whose name ends in gmail_get_profile) with no args ({}). ${WRITE_ALL}`
  };
}
function threadStep(home, r, it) {
  return {
    step: 'thread',
    run: r.run,
    tool: THREAD_TOOLS[0],
    tool_names: THREAD_TOOLS,
    args: threadArgs(it),
    write: r.current.file,
    then: then(home, 'checked', r.run, r.current.file),
    say: `Call the Gmail thread tool ${THREAD_TOOLS[0]} (or the one whose name ends in gmail_read_email_thread) with exactly these args. ${WRITE_ALL}`
  };
}
function searchStep(home, r, it) {
  return {
    step: 'search',
    run: r.run,
    tool: SEARCH_TOOLS[0],
    tool_names: SEARCH_TOOLS,
    args: { query: query(it), max_results: MAX_RESULTS },
    write: r.current.file,
    then: then(home, 'checked', r.run, r.current.file),
    say: `Call the Gmail search tool ${SEARCH_TOOLS[0]} (or the one whose name ends in gmail_search_emails) with exactly these args. Write the tool's whole result object as JSON (JSON.stringify of the full result, structuredContent included, an error too) to the write file, then run then.`
  };
}
function sendStep(home, r, it) {
  return {
    step: 'send',
    run: r.run,
    tool: SEND_TOOLS[0],
    tool_names: SEND_TOOLS,
    args: sendArgs(it),
    expires_at: iso(r.current.expires_at),
    write: r.current.file,
    then: then(home, 'sent', r.run, r.current.file),
    say: `Check the time first: if expires_at (${iso(r.current.expires_at)}) has passed, don't call the send tool; run next again. Otherwise call the Gmail send tool ${SEND_TOOLS[0]} (or the one whose name ends in gmail_send_email) once, with exactly these args: no other recipient, no cc or bcc, no change to the subject, the body or any other arg. ${WRITE_ALL} Never call it again for this step.`
  };
}

// Why a released send can't be shown now, or null: the search it rests on was given too long ago, the event's hours
// have closed, or Claude Code's email sending came on.
function showWhy(home, r, it, nowMs) {
  const issued = r.current.issued_at;
  if (!Number.isFinite(issued) || nowMs - issued > FRESH_MS || issued - nowMs > 60000) return `the reply check for ${it.id} was given more than ${FRESH_MS / 60000} minutes ago: search again`;
  const ev = eventJson(eventDirOf(home, it.slug)) || {};
  const hours = hoursWhy(ev.time_zone, nowMs);
  if (hours) return hours.replace(/drafts go in/g, 'messages go');
  return claudeSendsEmail(home, ev);
}

// The run takes back its own release before the send was shown (nothing went): withdrawn in the ledger, pushed with
// the lock dropped, and the step stays due for a later run. Only on proof in this checkout that the send was never
// shown; without it the send may have gone: unclear, and the lock is kept.
function withdraw(home, r, it, nowMs, why) {
  if (shownHere(home, r)) return unclearStop(home, r, it, nowMs, "this checkout can't show that the send step was never given");
  append(ledgerOf(eventDirOf(home, it.slug)), { type: 'autosend_withdrawn', who: 'floorboss', id: it.id, touch: it.touch, run: r.run }, new Date(nowMs));
  return stopRun(home, r, nowMs, `${why}. The send for ${it.id} message ${it.touch} was not shown and stays due`);
}

// The send step may have been given and its answer never came back: it may have gone. Never asked for again.
function unclearStop(home, r, it, nowMs, error) {
  append(ledgerOf(eventDirOf(home, it.slug)), { type: 'send_unclear', who: 'floorboss', id: it.id, touch: it.touch, error }, new Date(nowMs));
  return stopRun(home, r, nowMs, `${it.id} message ${it.touch}: the send step's answer was never recorded, so it may have gone. Check Sent mail and settle it on the laptop`, { lock: 'keep' });
}

// next --run new|<id>
function nextStep(home, { run, nowMs }, holder = {}) {
  let r;
  if (run === 'new') {
    const id = `${iso(nowMs).slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}-${randomBytes(3).toString('hex')}`;
    // The run's mark first (under .git, never pushed): a checkout it can't be written in stops here, before the lock
    // is taken, so it never leaves a lock in the remote.
    let nonce;
    try {
      nonce = claim(home, id);
    } catch (e) {
      return { step: 'stop', why: String(e.message), lock: 'not taken' };
    }
    const s = start({ home, who: 'cloud', runId: id, nowMs });
    if (s.stop) return { step: 'stop', why: s.stop, lock: 'not taken' };
    r = { run: id, who: 'cloud', started_at: iso(nowMs), state: 'open', current: null, seen: [], sent: [], stopped_people: [], n: 0, nonce };
    saveRun(home, r);
    // From here a failure part-way ends this run cleanly (guarded): it knows the run.
    holder.run = id;
    log(home, r, nowMs, 'started');
    // The first step of every run: which Gmail account is connected, checked against the address the sends were
    // approved from, before any search or send.
    const dir = answerDir(r.run);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    r.current = { step: 'profile', file: join(dir, '0-profile.json'), issued_at: nowMs };
    saveRun(home, r);
    return profileStep(home, r);
  } else r = loadRun(home, run);
  if (r.state === 'stopped') return { step: 'stop', why: r.why, lock: r.lock || null };
  if (r.state === 'done') return { step: 'done', summary: r.summary };
  if (r.current?.step === 'profile') return profileStep(home, r);
  if (r.current?.step === 'thread') return threadStep(home, r, r.current.item);
  if (r.current?.step === 'search') return searchStep(home, r, r.current.item);
  if (r.current?.step === 'send') {
    // Claimed by another next call that hasn't shown it yet (or died part-way): this one stops and changes nothing.
    if (!r.current.shown && claimed(home, r)) return { step: 'stop', why: `another next call already has the send step for ${r.current.item.id}: nothing was changed. Run only one next at a time`, lock: null };
    if (!r.current.shown && !shownHere(home, r)) {
      const it = r.current.item;
      if (!claimSend(home, r)) return { step: 'stop', why: `another next call already has the send step for ${it.id}: nothing was changed. Run only one next at a time`, lock: null };
      // The release mark must be in the remote before the send is shown: a checked step killed mid-push may have left
      // it here only. Not confirmed: it is thrown away, nothing was shown, and the step stays due.
      if (r.current.pushed !== true) {
        const p = pushedAll({ home, release: { slug: it.slug, id: it.id, touch: it.touch, run: r.run } });
        if (!p.ok) return stopRun(home, r, nowMs, `the release mark for ${it.id} message ${it.touch} isn't confirmed in your repo (${p.why}), so nothing was sent; it stays due`, { lock: 'discard' });
        r.current.pushed = true;
        saveRun(home, r);
      }
      const late = showWhy(home, r, it, nowMs);
      if (late) return withdraw(home, r, it, nowMs, late);
      markShown(home, r);
      r.current.shown = true;
      // The send step's expiry: FRESH_MS from when the reply check was given, never later.
      r.current.expires_at = r.current.issued_at + FRESH_MS;
      saveRun(home, r);
      return sendStep(home, r, it);
    }
    return unclearStop(home, r, r.current.item, nowMs, 'the next step was asked for before the send answer was recorded');
  }
  if (typeof r.account !== 'string') return stopRun(home, r, nowMs, "the connected Gmail account wasn't checked in this run: nothing was searched or sent");
  const plan = dueNow(home, nowMs);
  if (plan.blocked) return stopRun(home, r, nowMs, `nothing may go: ${plan.blocked}`);
  const it = plan.due.find((x) => !r.seen.includes(`${x.slug}:${x.id}`));
  if (!it) {
    const summary = { sent: r.sent, stopped_people: r.stopped_people, waiting: plan.waits.length, waits: plan.waits.slice(0, 20).map((w) => `${w.slug} ${w.id} message ${w.touch}: ${w.why}`) };
    r.state = 'done';
    r.summary = summary;
    log(home, r, nowMs, `done: ${r.sent.length} sent, ${r.stopped_people.length} stopped by a reply, bounce or auto-reply, ${plan.waits.length} waiting${plan.waits.length ? ` (${summary.waits.slice(0, 5).join('; ')})` : ''}`);
    saveRun(home, r);
    const e = end({ home, runId: r.run });
    return { step: 'done', summary, ...(e.stop ? { push: e.stop } : {}) };
  }
  r.n += 1;
  const dir = answerDir(r.run);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // issued_at: when the search was given to the model, what the reply check is as fresh as.
  if (!sameAccount(it.from, r.account)) return stopRun(home, r, nowMs, `${it.id}: the connected Gmail account (${r.account}) isn't the address its sends were approved from (${it.from}): nothing more was searched or sent`);
  // A follow-up reads its thread first (a reply there from anyone but you stops them), then the address search.
  if (it.followup) {
    r.current = { step: 'thread', item: it, file: join(dir, `${r.n}-thread.json`), issued_at: nowMs };
    saveRun(home, r);
    return threadStep(home, r, it);
  }
  r.current = { step: 'search', item: it, file: join(dir, `${r.n}-search.json`), issued_at: nowMs };
  saveRun(home, r);
  return searchStep(home, r, it);
}

// Every sending address auto-send was told to use (each auto-send event's own) and every due step's approved one.
function approvedSenders(home, nowMs) {
  const out = new Set();
  for (const e of autosendEvents(home)) out.add(String(eventJson(e.dir)?.autosend_own || '').trim().toLowerCase() || '(none)');
  const plan = dueNow(home, nowMs);
  for (const x of plan.due) out.add(String(x.from || '').toLowerCase() || '(none)');
  return [...out];
}

// The profile answer: the connected account must be the approved sender, or the run stops before anything.
function profiled(home, r, a, nowMs) {
  const p = profileEmail(a.text ?? 'no answer (the file was not written)');
  if (p.error) return { checked: 'error', ...stopRun(home, r, nowMs, `the connected Gmail account can't be checked (${p.error}): nothing was searched or sent`) };
  const senders = approvedSenders(home, nowMs);
  const other = senders.find((x) => !sameAccount(x, p.email));
  if (other) return { checked: 'error', ...stopRun(home, r, nowMs, `the connected Gmail account is ${p.email}, not the address auto-send was approved to send from (${other}): nothing was searched or sent. Connect that account in ChatGPT, or approve again on the laptop`) };
  r.account = p.email;
  r.current = null;
  log(home, r, nowMs, `the connected Gmail account is ${p.email}`);
  saveRun(home, r);
  return { checked: 'profile', account: p.email, then: 'run next' };
}

// The thread answer: an inbound message stops them (recorded as the search's would be); else the address search.
function threadChecked(home, r, a, nowMs) {
  const it = r.current.item;
  const evDir = eventDirOf(home, it.slug);
  const d = decideThread(it, a.text ?? 'no answer (the file was not written)', { own: it.from });
  if (d.error) return { checked: 'error', ...stopRun(home, r, nowMs, `${it.id}: ${d.error}`) };
  if (d.stop) return stopPerson(home, r, it, evDir, d, nowMs, 'in their thread');
  r.current = { step: 'search', item: it, file: join(answerDir(r.run), `${r.n}-search.json`), issued_at: nowMs };
  saveRun(home, r);
  return { checked: 'go', then: 'run next' };
}

// A reply, a bounce or an auto-reply: that person stops, and the run goes on.
function stopPerson(home, r, it, evDir, d, nowMs, where = '') {
  apply(evDir, it, d, nowMs);
  r.seen.push(`${it.slug}:${it.id}`);
  r.stopped_people.push(`${it.slug} ${it.id}: ${d.stop}`);
  r.current = null;
  log(home, r, nowMs, `${it.slug} ${it.id} (${it.to}) not sent: ${d.stop === 'reply' ? 'a reply' : d.stop === 'bounce' ? 'a bounce' : 'an auto-reply'}${where ? ` ${where}` : ''} (${d.evidence})`);
  saveRun(home, r);
  const c = checkpoint({ home, message: `checked ${it.slug} ${it.id}: ${d.stop}` });
  if (c.stop) return { checked: d.stop, ...stopRun(home, r, nowMs, c.stop) };
  return { checked: d.stop, then: 'run next' };
}

// The answer file a step named, as the model wrote it: its text, or null when it wasn't written.
function answerText(r, file) {
  if (!r.current || resolve(String(file || '')) !== r.current.file) return { refused: `that isn't the file the current step named (${r.current ? r.current.file : 'no step is open'})` };
  if (!existsSync(file)) return { text: null };
  const st = lstatSync(file);
  if (!st.isFile() || st.size > MAX_ANSWER) return { text: '' };
  return { text: readFileSync(file, 'utf8') };
}

// checked --run <id> --file <f>: the search answer.
function checkedStep(home, { run, file, nowMs }) {
  const r = loadRun(home, run);
  if (r.state !== 'open' || !['profile', 'thread', 'search'].includes(r.current?.step)) throw new Refused('no profile, thread or search step is open in this run: run next');
  const a = answerText(r, file);
  if (a.refused) throw new Refused(a.refused);
  if (r.current.step === 'profile') return profiled(home, r, a, nowMs);
  if (r.current.step === 'thread') return threadChecked(home, r, a, nowMs);
  const it = r.current.item;
  const evDir = eventDirOf(home, it.slug);
  const ev = eventJson(evDir) || {};
  const d = decide(it, a.text ?? 'no answer (the file was not written)', { own: it.from });
  if (d.error) return { checked: 'error', ...stopRun(home, r, nowMs, `${it.id}: ${d.error}`) };
  if (d.stop) return stopPerson(home, r, it, evDir, d, nowMs);
  apply(evDir, it, d, nowMs);
  const issued = r.current.issued_at;
  const cc = claudeSendsEmail(home, ev);
  if (cc) return { checked: 'go', ...stopRun(home, r, nowMs, `${it.id}: ${cc}`) };
  try {
    release(evDir, it, r.run, nowMs, { issuedMs: issued });
  } catch (e) {
    return { checked: 'go', ...stopRun(home, r, nowMs, `${it.id}: ${e.message}`) };
  }
  // pushed: set only once the checkpoint below is accepted; until then next never shows the send.
  r.current = { step: 'send', item: it, file: join(answerDir(r.run), `${r.n}-send.json`), shown: false, pushed: false, issued_at: issued };
  saveRun(home, r);
  // The release mark is in the remote before the send, or nothing is sent.
  const c = checkpoint({ home, message: `release ${it.slug} ${it.id} ${it.touch}` });
  if (c.stop) return { checked: 'go', ...stopRun(home, r, nowMs, `the release mark couldn't be pushed, so nothing was sent (${c.stop})`, { lock: 'discard' }) };
  r.current.pushed = true;
  saveRun(home, r);
  return { checked: 'go', then: 'run next' };
}

// sent --run <id> --file <f>: the send answer.
function sentStep(home, { run, file, nowMs }) {
  const r = loadRun(home, run);
  if (r.state !== 'open' || r.current?.step !== 'send' || !r.current.shown) throw new Refused('no send step is open in this run: nothing to record');
  const a = answerText(r, file);
  if (a.refused) throw new Refused(a.refused);
  const it = r.current.item;
  const evDir = eventDirOf(home, it.slug);
  // Written after the send step's expiry (or with no expiry recorded): the send may have gone late, so it is never
  // recorded as a clean send: unclear, and the user settles it.
  const exp = r.current.expires_at;
  let late = null;
  if (!Number.isFinite(exp)) late = 'the send step had no expiry recorded';
  // The file's time, on floorboss's clock (the same clock outside tests, where FLOORBOSS_NOW moves it).
  else if (a.text != null && lstatSync(file).mtimeMs - (Date.now() - nowMs) > exp) late = `the send answer was written after the step expired (${iso(exp)})`;
  const out = record(evDir, it, a.text, r.run, nowMs, { late });
  r.current = null;
  r.seen.push(`${it.slug}:${it.id}`);
  if (out.sent) {
    r.sent.push(`${it.slug} ${it.id} message ${it.touch}`);
    log(home, r, nowMs, `sent ${it.slug} ${it.id} message ${it.touch} to ${it.to} ("${it.subject}")`);
    if (out.thread_problem) log(home, r, nowMs, `threading problem: ${it.slug} ${it.id} message ${it.touch} ${out.thread_problem}. It was sent and is never sent again; look at it in Gmail`);
    saveRun(home, r);
    const c = checkpoint({ home, message: `sent ${it.slug} ${it.id} ${it.touch}` });
    // Sent, and not pushed: the lock stays in the remote, so no run goes on until the user looks.
    if (c.stop) return { recorded: 'sent', ...stopRun(home, r, nowMs, `sent ${it.id} message ${it.touch}, and the record couldn't be pushed (${c.stop})`, { lock: 'keep' }) };
    return { recorded: 'sent', then: 'run next' };
  }
  return { recorded: 'unclear', ...stopRun(home, r, nowMs, `${it.id} message ${it.touch}: the send answer was unclear (${out.unclear}). It may have gone: check Sent mail and settle it on the laptop`, { lock: 'keep' }) };
}

// Anything that fails part-way (not a refusal) ends the run there, as any other stop: the lock is kept when a step of
// this run may have gone (released, or unclear), else released.
function guarded(home, opts, fn) {
  const holder = {};
  try {
    return fn(home, opts, holder);
  } catch (e) {
    if (e instanceof Refused) throw e;
    let r = null;
    try {
      r = opts.run === 'new' ? (holder.run ? loadRun(home, holder.run) : null) : loadRun(home, opts.run);
    } catch {
      r = null;
    }
    if (!r || r.state !== 'open') throw e;
    const it = r.current?.item;
    let mark = null;
    try {
      mark = it ? stepMark(readEvent(eventDirOf(home, it.slug)).entries, it.id, it.touch) : null;
    } catch {
      mark = 'unknown';
    }
    return stopRun(home, r, opts.nowMs, `floorboss failed part-way (${String(e.message).slice(0, 200)})`, { lock: mark ? 'keep' : 'drop' });
  }
}
export const next = (home, opts) => guarded(home, opts, nextStep);
export const checked = (home, opts) => guarded(home, opts, checkedStep);
export const sent = (home, opts) => guarded(home, opts, sentStep);
