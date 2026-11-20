#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// floorboss auto-send, for Codex (lib/autosend/, 2026-11-20 design). On the laptop: turn an event on, read back and
// approve the sequences (the second yes), stop them, settle an unclear send, and the data repo's lock. In the user's
// own ChatGPT cloud task: `next` gives one step at a time (search, send, stop, done) and `checked` / `sent` take each
// tool answer back. Every command refuses in Claude Code, which has its own sending.
import { join, dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../../../lib/args.mjs';
import { isMain } from '../../../lib/main.mjs';
import { home } from '../../../lib/paths.mjs';
const h0 = home;
import { nowMs as clockNow } from '../../../lib/clock.mjs';
import { writeJson } from '../../../lib/jsonio.mjs';
import { append } from '../../../lib/ledger.mjs';
import { eventStateAt } from '../../../lib/sendcheck.mjs';
import { plainAddress } from '../../event-outreach/scripts/mailto.mjs';
import { refusedHere, eventDirOf, eventJson, autosendEvents, readEvent, unsettled, stepMark, draftOf, ledgerOf, claudeSendsEmail, liveApproval, handSentCommand } from '../../../lib/autosend/common.mjs';
import { readback, approve, revoke } from '../../../lib/autosend/approval.mjs';
import { dueNow } from '../../../lib/autosend/plan.mjs';
import { start, end, unlock, repair, laptopWrite, initRepo, publishedWhy, readLock, isRepo, remoteUrl, headOf, pinWhy, redact, repoConfigWhy, LOCK_LIVE_MS, PAUSE_STEPS } from '../../../lib/autosend/sync.mjs';
import { next, checked, sent } from './driver.mjs';

const FLOORBOSS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const need = (opts, ...ks) => {
  const miss = ks.filter((k) => opts[k] === undefined || opts[k] === true || opts[k] === '');
  if (miss.length) throw new Error(`Missing ${miss.map((k) => `--${k}`).join(', ')}.`);
};
const nowOf = () => clockNow();
const cloud = () => process.env.FLOORBOSS_AUTOSEND === 'cloud';
const laptopOnly = (what) => {
  if (cloud()) throw new Error(`${what} is for the user on their laptop, never in the cloud run.`);
};
// A laptop change to auto-send state, through the sync (lib/autosend/sync.mjs laptopWrite): pull, the lock, the
// write, push. keep: a revoke, which is written here even when it can't be pushed.
const synced = (what, keep, fn) => laptopWrite({ home: home(), nowMs: nowOf(), keep, what }, fn);
const pushWords = (w) => ({ pushed: w.pushed, ...(w.say ? { say: w.say } : {}) });

// The event folder for --event, which must be set to auto-send (except for `on`).
function eventOf(opts, { on = false } = {}) {
  need(opts, 'event');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(opts.event))) throw new Error('--event is an event slug.');
  const dir = eventDirOf(home(), opts.event);
  const ev = eventJson(dir);
  if (!ev) throw new Error(`No event "${opts.event}" in the data folder.`);
  if (!on && ev.autosend !== true) throw new Error(`"${opts.event}" isn't set to auto-send: ask the user first, then run on --event ${opts.event}.`);
  return { dir, ev };
}
// After a laptop command changed what the outbox may offer, its page is rebuilt (best effort).
async function rebuild(slug) {
  try {
    const { rebuildOutbox } = await import('../../event-outreach/scripts/commands/cards.mjs');
    rebuildOutbox(slug, {}, {});
  } catch {
    /* the page is rebuilt on the next floorboss command */
  }
}

// on --event <slug> --said <the user's words> --own <their address>: the setup answer ("Should floorboss send
// these on its own from the cloud?"). Saved in event.json; the whole sequence is then drafted and approved up front.
async function on(opts) {
  laptopOnly('Turning auto-send on');
  const { dir, ev } = eventOf(opts, { on: true });
  need(opts, 'said');
  // Claude Code sending email from this same data folder could send a step the cloud sends too (its guard doesn't read
  // auto-send's marks): one or the other, never both. The planner holds every send if it comes on later.
  if (claudeSendsEmail(h0(), ev))
    throw new Error('Claude Code sends email for this data folder (its sending setting is on): auto-send can\'t be on as well. Turn Claude Code\'s email sending off first, in Claude Code.');
  // The Gmail account it sends from is required: the approval records it, and every cloud run checks the connected
  // account against it first (gmail_get_profile).
  const own = opts.own == null || opts.own === true ? ev.autosend_own || null : String(opts.own).trim().toLowerCase();
  if (own == null) throw new Error("Missing --own: the Gmail address auto-send sends from (the account connected in ChatGPT). Ask the user for it.");
  if (!plainAddress(own)) throw new Error('--own is the user\'s own address (the Gmail account it sends from), one plain address.');
  const w = synced('autosend on', false, () => {
    const now = eventJson(dir) || ev;
    writeJson(join(dir, 'event.json'), { ...now, autosend: true, autosend_said: String(opts.said).slice(0, 200), autosend_own: own });
  });
  return {
    autosend: true,
    event: opts.event,
    own,
    ...pushWords(w),
    ...(w.pushed === null ? { say: "Your data isn't in a repo yet: do setup step 1 first (init, then setup). Auto-send can't run until then." } : {}),
    next: 'Run flow next: every planned follow-up of each sequence is drafted, read by the critic and approved before the readback.'
  };
}

async function readbackCmd(opts) {
  laptopOnly('The readback');
  const { dir } = eventOf(opts);
  const r = readback(dir, nowOf());
  return {
    people: new Set(r.items.map((x) => x.id)).size,
    messages: r.items.length,
    digest: r.digest,
    text: r.text,
    refused: r.refused,
    // A message whose day went by (it was on the outbox): the user may have sent it. Their "sent" is recorded with
    // exactly this command, never settle (which is for a step auto-send let go).
    ...(r.items.some((x) => x.missed) ? { hand_sent: r.items.filter((x) => x.missed).map((x) => ({ id: x.id, touch: x.touch, record: handSentCommand(opts.event, x.id, x.touch) })) } : {}),
    show: `Show the user \`text\` word for word, then the people left out and why. Ask them to type "auto-send these sequences" if they want exactly these sent on these days. Put their words in a file and run approve with --digest and --said-file.${r.items.some((x) => x.missed) ? " If they say they sent a message in hand_sent themselves, record it with that item's \`record\` command (never settle) and run readback again; if they say it wasn't sent, put those words in a file too and add --not-sent-said-file." : ''}`
  };
}

async function approveCmd(opts) {
  laptopOnly('The auto-send approval');
  const { dir } = eventOf(opts);
  need(opts, 'digest', 'said');
  // --not-sent-said: the user's word that a missed message (on their outbox since its day went by) wasn't sent by hand.
  const notSentSaid = typeof opts['not-sent-said'] === 'string' ? opts['not-sent-said'] : null;
  const w = synced(`autosend approve ${opts.event}`, false, () => approve(dir, { digest: opts.digest, said: opts.said, notSentSaid }, nowOf()));
  await rebuild(opts.event);
  return { ...w.result, ...pushWords(w), next: w.pushed === null ? 'The data folder is not a checkout of your repo yet: the README setup, step 1.' : 'It is in your repo: the cloud task sends from its next run on.' };
}

async function revokeCmd(opts) {
  laptopOnly('Stopping auto-send');
  need(opts, 'ids', 'said');
  // No event named: "stop auto-send" for every auto-send event in the data folder (ids all only: ids are per event).
  const all = opts.event === undefined || opts.event === true;
  if (all && opts.ids !== 'all') throw new Error('With no --event, revoke stops every auto-send event: --ids all. To stop some people, name their event.');
  const evs = all ? autosendEvents(home()) : [{ slug: opts.event, dir: eventOf(opts).dir }];
  // Each event's stop is written (and pushed) on its own: one that fails loses none of the others. A revoke always
  // wins: it is written here whatever happens, and if it can't reach your repo the answer says so and how to pause the
  // scheduled task.
  const done = [];
  const failed = [];
  for (const e of evs) {
    try {
      const w = synced(`autosend revoke ${e.slug}`, true, () => revoke(e.dir, { ids: all || opts.ids === 'all' ? 'all' : String(opts.ids), said: opts.said }, nowOf()));
      done.push({ slug: e.slug, w });
    } catch (err) {
      failed.push({ slug: e.slug, why: String(err.message).slice(0, 300) });
    }
    await rebuild(e.slug);
  }
  if (failed.length) {
    const ok = done.map((d) => `${d.slug}${d.w.pushed === false ? ' (here only, not in your repo yet)' : ''}`);
    throw new Error(`Auto-send was not stopped: ${failed.map((f) => `${f.slug} (${f.why})`).join('; ')}.${ok.length ? ` Stopped: ${ok.join(', ')}.` : ''} Not stopped: ${failed.map((f) => f.slug).join(', ')}. ${PAUSE_STEPS}.`);
  }
  const notPushed = done.filter((d) => d.w.pushed === false);
  const next = notPushed.length
    ? "Tell the user `say` first, word for word: the cloud task doesn't know yet. Don't offer these messages to send by hand until the task is paused."
    : `Those messages are back on the outbox page${all ? 's' : ''}, to send by hand. Tell the user to pause or delete the scheduled task too, if they want nothing more sent.`;
  if (!all) return { ...done[0].w.result, ...pushWords(done[0].w), next };
  return {
    revoked: Object.fromEntries(done.map((d) => [d.slug, d.w.result.revoked])),
    events: done.map((d) => d.slug),
    pushed: done.every((d) => d.w.pushed === true) ? true : done.some((d) => d.w.pushed === false) ? false : null,
    ...(notPushed.length ? { say: notPushed.map((d) => `${d.slug}: ${d.w.say}`).join(' ') } : {}),
    next
  };
}

// status: the lock, every auto-send step that may have gone unrecorded (to settle), and what is due or waiting now.
async function status() {
  laptopOnly('The status');
  const h = home();
  const events = autosendEvents(h).map((e) => {
    const { entries } = readEvent(e.dir);
    const open = unsettled(entries).map((u) => {
      const a = [...entries].reverse().find((x) => x?.type === 'autosend_released' && x.id === u.id && (x.touch ?? 1) === u.touch);
      const d = a ? draftOf(e.dir, a.hash) : null;
      return { id: u.id, touch: u.touch, to: a?.to || null, subject: d?.subject ?? null, state: u.mark === 'unclear' ? "the send tool's answer was unclear" : 'let go, and nothing recorded since' };
    });
    const approved = new Set(entries.filter((x) => x?.type === 'autosend_approved').map((x) => x.id));
    return { event: e.slug, people: approved.size, to_settle: open };
  });
  let plan = null;
  try {
    plan = dueNow(h, nowOf());
  } catch (err) {
    plan = { blocked: err.message, due: [], waits: [] };
  }
  return {
    lock: isRepo(h) ? readLock(h) : null,
    repo: isRepo(h) ? redact(remoteUrl(h)) || null : null,
    events,
    blocked: plan.blocked,
    due_now: plan.due.map((x) => `${x.slug} ${x.id} message ${x.touch} to ${x.to}`),
    waiting: plan.waits.map((w) => `${w.slug} ${w.id} message ${w.touch}: ${w.why}`),
    show: 'Say each step to settle with its person, address and subject: ask the user to look in Gmail\'s Sent folder, then run settle with their words. Never settle on a guess.'
  };
}

// settle --event <slug> --id <c…> --touch <n> --went yes|no --said <their words> [--message-id <id> --thread-id <id>]: an auto-send step that may have
// gone. "yes" records it sent (the user saw it in Sent); "no" clears it: it is never auto-sent again, and goes back to
// the outbox page to send by hand.
async function settle(opts) {
  laptopOnly('Settling a send');
  const { dir } = eventOf(opts);
  need(opts, 'id', 'touch', 'went', 'said');
  const touch = Number(opts.touch);
  const { entries, folded } = readEvent(dir);
  const mark = stepMark(entries, opts.id, touch);
  // A step with no release line at all (a remote that lost it) can still be recorded as gone, never as not gone: the
  // user saw it in Sent. Only an auto-send step: approved for it, not recorded as sent.
  const lost = !mark && /^(yes|it went|went|sent)$/.test(String(opts.went).toLowerCase()) && liveApproval(entries, opts.id, touch) && !folded.people[opts.id]?.touches?.[touch]?.sent;
  if (!mark && !lost) throw new Error(`${opts.id} message ${touch} isn't waiting to be settled.`);
  const said = String(opts.said).trim();
  if (said.length < 2) throw new Error("Say what the user found, in their words (--said \"it's in my Sent folder\").");
  const went = String(opts.went).toLowerCase();
  // The ids from Gmail (the message in Sent: its id and thread), when the user has them: a follow-up goes in that
  // thread only with both recorded.
  const ids = {};
  for (const [flag, key] of [['message-id', 'message_id'], ['thread-id', 'thread_id']]) {
    if (opts[flag] === undefined) continue;
    if (!/^[\w-]{1,128}$/.test(String(opts[flag]))) throw new Error(`--${flag} is the Gmail id (letters, digits, "-" and "_").`);
    ids[key] = String(opts[flag]);
  }
  const rel = [...entries].reverse().find((x) => x?.type === 'autosend_released' && x.id === opts.id && (x.touch ?? 1) === touch);
  const now = new Date(nowOf());
  // A run may still be going: the send may not show in Sent yet. Settled only once that run must be over.
  if (rel && now.getTime() - Date.parse(rel.at) < LOCK_LIVE_MS) throw new Error(`${opts.id} message ${touch} was let go less than 30 minutes ago: its run may still be going. Settle it after ${new Date(Date.parse(rel.at) + LOCK_LIVE_MS).toISOString().slice(11, 16)} UTC.`);
  if (/^(yes|it went|went|sent)$/.test(went)) {
    // Auto-send's own send only when it let this step go (a release line): with none, nothing says the cloud sent it,
    // so it is the user's own send (source hand), and the rest of their sequence is the user's (handSentAfter) until a
    // fresh yes. Recorded as auto-send's, the cloud would send the follow-ups after a message the user sent.
    const source = rel ? 'autosend' : 'hand';
    synced(`autosend settle ${opts.event} ${opts.id} ${touch}: sent`, false, () => append(ledgerOf(dir), { type: 'sent', who: 'user', id: opts.id, touch, via: 'email.send', channel: 'email', date: eventStateAt(dir, now.getTime()).today || now.toISOString().slice(0, 10), hash: rel?.hash || folded.people[opts.id]?.touches?.[touch]?.hash, ...ids, source, settled: true, said: said.slice(0, 200) }, now));
    await rebuild(opts.event);
    return rel
      ? { recorded: 'sent', next: 'It is in your repo.' }
      : { recorded: 'sent', by: 'you', next: "Auto-send never let it go, so it is recorded as your own send: the rest of their sequence is yours to send (or give auto-send a fresh yes for it: readback). It is in your repo." };
  }
  if (/^(no|did not go|didn't go|not sent)$/.test(went)) {
    synced(`autosend settle ${opts.event} ${opts.id} ${touch}: not sent`, false, () => append(ledgerOf(dir), { type: 'release_cleared', who: 'user', id: opts.id, touch, said: said.slice(0, 200) }, now));
    await rebuild(opts.event);
    return { recorded: 'not sent', next: 'It is never auto-sent again: it is back on the outbox page, to send by hand.' };
  }
  throw new Error('--went is yes or no.');
}

// The task prompt for the user's scheduled task, with their repo, floorboss's pinned commit and the data repo filled in.
export function taskPrompt({ sha, dataRepo }) {
  const text = readFileSync(join(FLOORBOSS, 'codex', 'autosend-task.md'), 'utf8');
  const body = text.slice(text.indexOf('```') + 3, text.lastIndexOf('```')).replace(/^\w*\n/, '');
  return body.replaceAll('<PINNED_SHA>', sha || '<PINNED_SHA>').replaceAll('<USER>/<DATA_REPO>', dataRepo || '<USER>/<DATA_REPO>');
}

// setup [--private-said <the user's words>]: the checks floorboss can make before the cloud task is set up. The data
// folder is a git checkout whose remote is a github.com repo over https; the user says it is private (floorboss can't
// see GitHub's settings). Prints the task prompt with the pinned floorboss commit.
async function setup(opts) {
  laptopOnly('Setup');
  const h = home();
  const unsafe = repoConfigWhy(h);
  if (unsafe) throw new Error(`Setup refused: ${unsafe}. Nothing was set up.`);
  if (!isRepo(h)) throw new Error(`The data folder (${h}) isn't a git checkout yet. README "Auto-send from the cloud", step 1.`);
  const url = remoteUrl(h);
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(String(url || ''));
  if (!m) throw new Error('The data folder\'s remote must be a private repo on https://github.com/<you>/<repo>. Nothing was set up.');
  if (!opts['private-said'] || String(opts['private-said']).trim().length < 2)
    return { private: 'unconfirmed', repo: url, ask: `Ask the user: "Is ${m[1]}/${m[2]} a private repo, and is the token for it limited to that one repo?" Run setup again with --private-said and their words.` };
  // The pin is the code that will run: a floorboss folder with changes not committed has none.
  const dirty = pinWhy(FLOORBOSS);
  if (dirty) throw new Error(`${dirty}. Commit or undo them (or use a clean copy of floorboss), then run setup again. Nothing was set up.`);
  const sha = headOf(FLOORBOSS);
  const unpublished = publishedWhy(FLOORBOSS, sha);
  return {
    ...(unpublished ? { warn: `${unpublished}.` } : { pin_published: true }),
    repo: url,
    private: 'the user said so',
    pinned_commit: sha,
    events: autosendEvents(h).map((e) => e.slug),
    task_prompt: taskPrompt({ sha, dataRepo: `${m[1]}/${m[2]}` }),
    show: 'Give the user task_prompt to paste into a new standalone scheduled task (Work in Cloud), schedule RRULE:FREQ=HOURLY, and the README steps 2 to 4 (token, Gmail connection, internet access).'
  };
}

// init --remote https://github.com/<you>/<repo>: README setup step 1 (lib/autosend/sync.mjs initRepo), on the user's yes.
async function init(opts) {
  laptopOnly('init');
  need(opts, 'remote');
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(String(opts.remote));
  if (!m && process.env.FLOORBOSS_TEST !== '1') throw new Error('--remote is your new private repo, https://github.com/<you>/<repo>, with nothing in it yet.');
  const r = initRepo({ home: home(), remote: String(opts.remote) });
  if (r.stop) throw new Error(`${r.stop}. Nothing was set up.`);
  return { ...r, next: r.pushed ? 'Now run setup.' : 'After that push, run setup.' };
}

// sync start --who laptop --run <id> | sync end --run <id> | sync repair | sync unlock [--said <words>]: the laptop's
// side. repair brings a data folder that moved apart from the repo back in line (lib/autosend/sync.mjs repair).
async function sync(opts, argv) {
  const verb = argv[1];
  const h = home();
  if (verb === 'start') {
    laptopOnly('sync start on the laptop');
    if (opts.who !== 'laptop') throw new Error('sync start is --who laptop here; the cloud run takes the lock through next.');
    need(opts, 'run');
    const r = start({ home: h, who: 'laptop', runId: String(opts.run), nowMs: nowOf() });
    if (r.stop) return { started: false, stop: r.stop, say: 'Tell the user and change nothing in floorboss until it is settled.' };
    return r.took_over
      ? { started: true, took_over: r.took_over, say: `An earlier laptop session (run ${r.took_over}) ended without sync end: this session took its lock over. Nothing was sent under it (the laptop never sends).` }
      : { started: true };
  }
  if (verb === 'end') {
    // The laptop's own session lock only. A cloud run drops its lock itself (the driver); a lock the cloud holds is
    // removed only by the user's unlock, after they checked Sent mail: its run may have sent something.
    laptopOnly('sync end');
    need(opts, 'run');
    const l = readLock(h);
    if (l && l.who !== 'laptop')
      throw new Error(`The data folder is held by the ${l.who === 'cloud' ? 'cloud' : 'another writer'} (run ${l.run}), not this laptop session: sync end leaves it. If that run is over, ask the user to check Gmail's Sent folder, settle what it sent (status), then run sync unlock with their words.`);
    return end({ home: h, runId: String(opts.run) });
  }
  if (verb === 'repair') {
    laptopOnly('sync repair');
    return repair({ home: h, who: 'laptop', nowMs: nowOf() });
  }
  if (verb === 'unlock') {
    return unlock({ home: h, who: cloud() ? 'cloud' : 'laptop', said: typeof opts.said === 'string' ? opts.said : null, nowMs: nowOf() });
  }
  throw new Error('sync start, sync end, sync repair or sync unlock.');
}

async function nextCmd(opts) {
  if (!cloud()) throw new Error('next is for the cloud task only (FLOORBOSS_AUTOSEND=cloud): on the laptop floorboss never sends.');
  need(opts, 'run');
  return next(home(), { run: String(opts.run), nowMs: nowOf() });
}
async function checkedCmd(opts) {
  if (!cloud()) throw new Error('checked is for the cloud task only.');
  need(opts, 'run', 'file');
  return checked(home(), { run: String(opts.run), file: String(opts.file), nowMs: nowOf() });
}
async function sentCmd(opts) {
  if (!cloud()) throw new Error('sent is for the cloud task only.');
  need(opts, 'run', 'file');
  return sent(home(), { run: String(opts.run), file: String(opts.file), nowMs: nowOf() });
}

export const HANDLERS = { init, on, readback: readbackCmd, approve: approveCmd, revoke: revokeCmd, status, settle, setup, sync, next: nextCmd, checked: checkedCmd, sent: sentCmd };

export async function main(argv = process.argv.slice(2)) {
  const no = refusedHere();
  if (no) {
    process.stderr.write(`floorboss: ${no}.\n`);
    process.exit(1);
  }
  let sub, opts;
  try {
    ({ sub, opts } = parseArgs(argv));
  } catch (err) {
    process.stderr.write(`floorboss: ${err.message}\n`);
    process.exit(1);
  }
  const h = HANDLERS[sub];
  if (!h) {
    process.stderr.write(`Unknown command "${sub}". Use one of: ${Object.keys(HANDLERS).join(', ')}\n`);
    process.exit(2);
  }
  try {
    const out = await h(opts, argv);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`floorboss: ${err.message}\n`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) main();
