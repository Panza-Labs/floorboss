// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// `flow next`: picks the event this run is about, runs the steps that are only one of floorboss's own commands,
// and returns the first step that needs Claude or the user.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJson, writeJson } from '../../../lib/jsonio.mjs';
import { context, nextStep, script } from './steps.mjs';
import { sessionEvent, touchSession, listEvents, isMockEvent } from '../../../lib/scope.mjs';
import { configPath } from '../../../lib/paths.mjs';
import { nowFrom } from '../../../lib/event.mjs';
import { dirname } from 'node:path';
import { refreshOutbox } from '../../event-outreach/scripts/commands/cards.mjs';
import { unattendedNext } from './steps/unattended.mjs';
import { handSend } from './steps/shared.mjs';

// Steps that only run one of floorboss's own commands (no judgement, no question, no send): next runs them
// itself and moves on, so Claude gets a turn only where it has something to do. What each reported comes back
// in "ran" (with the fields the step asked to show).
const AUTO = new Set(['todo', 'batch_check', 'load', 'crm_lookup_list', 'mail_list', 'defaults', 'company_skip']);
const isAuto = (s) => s.run && (AUTO.has(s.step) || /^propose_mapping_/.test(s.step));
// Where the user's answer to a question is written (with the Write tool) before `answer --value-file`: in
// floorboss's data folder, the one place the commands let Claude write without asking.
function withAnswerFile(out) {
  if (out?.ask?.id && /^[a-z_]+$/.test(out.ask.id)) {
    const dir = join(dirname(configPath()), 'work', 'answers');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    out.ask.answer_file = join(dir, `${out.ask.id}.txt`);
  }
  return out;
}

export function next(opts) {
  // A scheduled run (/floorboss:followups-due): its own steps, for the follow-ups its ticket names, and nothing else.
  if (opts.unattended) return unattendedNext(opts);
  return withAnswerFile(nextStepOut(opts));
}
function nextStepOut(opts) {
  const ran = [];
  let c, s;
  // Which event this run is about. With events already on this device and no run going, ask first: a rep runs
  // floorboss for one event after another, and a step must never act on the last one set up by default.
  const nowMs = nowFrom(opts).getTime();
  // --new-run (the first next of /floorboss:start): the event of an earlier run isn't carried into this one.
  if (opts['new-run']) {
    touchSession(undefined, nowMs, { clear: true });
    // A new run tries an automatic step that stalled before again, from the start.
    clearStall();
    // After the mock event, a new run is for a real event: the mock is left behind, never reopened.
    const ob = readJson(join(dirname(configPath()), 'onboarding.json'), {});
    if (ob.event && readJson(join(dirname(configPath()), 'events', ob.event, 'event.json'), {}).mock)
      spawnSync(process.execPath, [script('event-context'), 'onboarding', '--new-event'], { encoding: 'utf8', env: process.env });
  }
  if (!opts.event) {
    const sess = sessionEvent(nowMs);
    const evs = listEvents(nowMs);
    const live = evs.filter((x) => !x.over);
    // Hand-send, a later day: plain `next` with one event on this computer that isn't over goes on with it, as a new
    // run (so its first step asks what came back). --new-run still asks, so a new event can be started.
    if (!sess && !opts['new-run'] && handSend() && live.length === 1 && readJson(join(dirname(configPath()), 'config.json'), {}).disclaimer_ack) {
      touchSession(undefined, nowMs, { clear: true });
      clearStall();
      opts = { ...opts, event: live[0].slug };
    } else if (!sess && evs.length && readJson(join(dirname(configPath()), 'config.json'), {}).disclaimer_ack) {
      return {
        step: 'which_event',
        why: 'There are events on this device already: this run is for one of them, or a new one.',
        ask: {
          id: 'which_event',
          question: `Which event is this for? ${live.length ? `${live.map((x) => `${x.name} (${x.start})`).join(', ')}, or a new one?` : 'A new one? (Earlier events here are over.)'}`,
          options: [...live.slice(0, 3).map((x) => x.name), 'a new event'],
          events: evs.slice(0, 10),
          answer_format: 'the event\'s name or slug, or "a new event"'
        },
        event: null,
        loop: 'Ask this, save it with flow answer --ask which_event, then run flow next again.'
      };
    }
    if (sess) opts = { ...opts, event: sess.slug || null };
  }
  if (opts.event) makeCurrent(opts.event);
  // The outbox page, checked at every step and rebuilt when anything it is built from changed since (the ledger, a list
  // or a setting edited by hand, what another event's record lends this one, the day): the page a user copies from is
  // current. The check reads file sizes and times (page-inputs.mjs); the event is loaded only to rebuild. A page that
  // could not be built last time is tried again here, at its own event's step.
  const page = opts.event ? refreshOutbox(opts.event, opts, { retryFailed: true }) : null;
  const out = finishNext(opts, ran);
  if (page?.not_rebuilt && out && typeof out === 'object') out.outbox_not_rebuilt = page.not_rebuilt;
  // The run's event, kept for the next step: the one this step was about (an error keeps the one chosen).
  touchSession(out?.event ?? opts.event ?? null, nowMs);
  return out;
}
// Whatever a command is about becomes the current event first, so every answer and setting it saves lands on
// that event (saving went to the last event set up while reading came from the one asked about).
export function makeCurrent(slug) {
  const ob = readJson(join(dirname(configPath()), 'onboarding.json'), {});
  // The mock event never becomes the current event: its answers and settings go to its own files (--for-event).
  if (slug && ob.event !== slug && !isMockEvent(slug) && existsSync(join(dirname(configPath()), 'events', slug, 'event.json')))
    spawnSync(process.execPath, [script('event-context'), 'onboarding', '--event', slug], { encoding: 'utf8', env: process.env });
}
let lastSlug = null;
// An automatic step that kept coming back (stalled): remembered, so the next flow next stops at its first repeat
// instead of running it 40 times again. A step that isn't automatic, or --new-run, clears it.
const stallPath = () => join(dirname(configPath()), 'stall.json');
const clearStall = () => {
  if (existsSync(stallPath())) writeJson(stallPath(), {});
};
// The command as the user would type it: arguments with spaces or quotes in single quotes.
const typed = (argv) => argv.map((a) => (/^[\w./:=@%+-]+$/.test(String(a)) ? String(a) : `'${String(a).replace(/'/g, `'\\''`)}'`)).join(' ');
function finishNext(opts, ran) {
  let c, s;
  const stall = readJson(stallPath(), {});
  let repeats = 0,
    last = null;
  for (let i = 0; i < 40; i++) {
    c = context(opts.event || null, opts);
    s = nextStep(c);
    if (!isAuto(s)) break;
    // The same command again, straight after itself: it ran and changed nothing the next step reads.
    const key = JSON.stringify(s.run);
    repeats = key === last ? repeats + 1 : 0;
    last = key;
    if (repeats >= (stall.event === (c.slug || null) && stall.step === s.step ? 1 : 3)) break;
    const r = spawnSync(s.run[0] === 'node' ? process.execPath : s.run[0], s.run.slice(1), { encoding: 'utf8', env: process.env });
    if (r.status !== 0)
      return {
        ...s,
        event: c.slug || null,
        ran,
        auto_failed: String(r.stderr || r.stdout)
          .trim()
          .slice(0, 600),
        loop: 'This step failed when run automatically: run it yourself, fix what it says, then run flow next again.'
      };
    let out = null;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      out = null;
    }
    ran.push({ step: s.step, ...(s.show && out ? Object.fromEntries(s.show.filter((k) => out[k] != null).map((k) => [k, out[k]])) : {}) });
  }
  lastSlug = c.slug || null;
  if (isAuto(s)) {
    const count = (stall.event === (c.slug || null) && stall.step === s.step ? stall.count || 0 : 0) + 1;
    writeJson(stallPath(), { event: c.slug || null, step: s.step, count, at: new Date().toISOString() });
    const cmd = typed(s.run);
    return {
      step: 'stalled',
      stalled_step: s.step,
      why: `floorboss kept re-running its automatic "${s.step}" step: it ran, and the next step was the same one again.`,
      run_by_hand: cmd,
      tell_user: `floorboss got stuck on its "${s.step}" step (${s.why ? s.why.replace(/[.\s]+$/, '') : 'an automatic step'}): it ran it and was asked for it again${count > 1 ? `, ${count} times now` : ''}. Run it once by hand: ${cmd}. Then ${handSend() ? 'start a new floorboss run' : 'start again with /floorboss:start'} (a new run tries the step afresh).`,
      ran: ran.slice(-6),
      event: c.slug || null
    };
  }
  clearStall();
  // A judge step with rows to prepare writes its input file now, so Claude reads one file.
  if (s.judge?.prepare) {
    mkdirSync(join(s.judge.prepare.file, '..'), { recursive: true, mode: 0o700 });
    writeJson(s.judge.prepare.file, s.judge.prepare.rows);
    delete s.judge.prepare;
  }
  return { ...s, event: c.slug || null, ...(ran.length ? { ran } : {}), loop: s.done ? undefined : 'Do this one thing, then run flow next again.' };
}
