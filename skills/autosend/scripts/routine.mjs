// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The daily Claude routine's commands, for Claude Code only (lib/autosend/routine.mjs; cli.mjs's gate lets only these
// run there). A routine is a scheduled task in the user's own Claude account that runs in the cloud, so the emails go
// with the laptop off.
//   routine-body --event <slug> [--environment env_...] [--time 9:00] [--connector-uuid <uuid>]: the exact
//     RemoteTrigger call that creates the routine, or updates the saved one.
//   routine-saved --event <slug> --id <trig_...>: the routine id RemoteTrigger answered.
//   routine-status: at the start of a session, for every routine event, the Gmail reads that show what the routine
//     sent, and whether the routine needs an update.
//   routine-checked --run <id>: those reads' answers, recorded.
// Nothing here sends, calls Gmail or calls RemoteTrigger: the model makes those calls, and only reads in status.
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, mkdirSync, lstatSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { home } from '../../../lib/paths.mjs';
import { nowMs as clockNow } from '../../../lib/clock.mjs';
import { writeJson } from '../../../lib/jsonio.mjs';
import { autosendEvents, eventDirOf, eventJson } from '../../../lib/autosend/common.mjs';
import { routineBody, routineSaved, routineState, reconcileItems, reconcileSteps, reconcile, routineName, routineStopWords, ROUTINE_MODE } from '../../../lib/autosend/routine.mjs';

const CLI = join(resolve(dirname(fileURLToPath(import.meta.url))), 'cli.mjs');
const cli = () => ['node', CLI];
const need = (opts, ...ks) => {
  const miss = ks.filter((k) => opts[k] === undefined || opts[k] === true || opts[k] === '');
  if (miss.length) throw new Error(`Missing ${miss.map((k) => `--${k}`).join(', ')}.`);
};
const str = (v) => (v === undefined || v === true ? null : String(v));
const routineEvents = (h) => autosendEvents(h).filter((e) => e.event?.autosend_mode === ROUTINE_MODE);
const bodyCmd = (slug) => [...cli(), 'routine-body', '--event', slug];

async function body(opts) {
  need(opts, 'event');
  const b = routineBody(home(), { event: String(opts.event), nowMs: clockNow(), time: str(opts.time), environmentId: str(opts.environment), connectorUuid: str(opts['connector-uuid']) });
  const call = { action: b.action, ...(b.trigger_id ? { trigger_id: b.trigger_id } : {}), body: b.body };
  return {
    remote_trigger: call,
    hash: b.hash,
    cron_utc: b.cron,
    queued: b.queued,
    ...(b.cut ? { waiting: b.cut } : {}),
    ...(b.left_out.length ? { left_out: b.left_out } : {}),
    show: [
      `Call RemoteTrigger once with exactly remote_trigger (its action${b.trigger_id ? ', trigger_id' : ''} and body), changing nothing in it.`,
      `Then run routine-saved --event ${opts.event} --id <the trigger id RemoteTrigger answered>.`,
      `Tell the user, in plain words: a daily routine named "${routineName(opts.event)}" now runs in your Claude account every day (a routine is a scheduled task Claude runs in the cloud, so your laptop can be off). Each day it sends the Gmail drafts that are due, unchanged, after checking Gmail for replies and bounces: anyone who replied or whose email bounced is skipped. A booking or a stop you record in floorboss takes effect when floorboss has you delete their drafts from Gmail. You can see it at claude.ai/code/routines.`,
      b.cut ? `${b.cut} later emails are not in the routine's list yet (it is kept short): floorboss adds them when it asks for the next update.` : null,
      b.left_out.length ? `These drafts are not in the list and won't be sent, so ask the user to delete them in Gmail Drafts: ${b.left_out.map((x) => `${x.draft_id} (to ${x.to}, message ${x.touch}: ${x.why})`).join('; ')}.` : null
    ]
      .filter(Boolean)
      .join(' ')
  };
}

async function saved(opts) {
  need(opts, 'event', 'id');
  return { ...routineSaved(home(), { event: String(opts.event), id: String(opts.id), nowMs: clockNow() }), next: 'The routine is saved. Nothing else to do.' };
}

// The reads of one status check, kept until routine-checked reads their answers.
const runsDir = (h) => join(h, 'autosend', 'routine-runs');
const answerDir = (run) => join(tmpdir(), 'floorboss-routine', run);
const RUN_RE = /^rc-[0-9a-f]{12}$/;
const stateOf = (h, slug, nowMs) => {
  const s = routineState(h, slug, nowMs);
  return { event: slug, trigger_id: s.trigger_id, update_due: s.update_due, ...(s.update_due ? { routine_body: bodyCmd(slug) } : {}) };
};

async function status() {
  const h = home();
  const nowMs = clockNow();
  const evs = routineEvents(h);
  const events = evs.map((e) => stateOf(h, e.slug, nowMs));
  const run = `rc-${randomBytes(6).toString('hex')}`;
  const reads = [];
  const per = [];
  for (const e of evs) {
    const items = reconcileItems(e.dir, nowMs);
    if (!items.length) continue;
    const steps = reconcileSteps(items).map((s, i) => ({ ...s, event: e.slug, write: join(answerDir(run), `${reads.length + i + 1}-${s.step}.json`) }));
    reads.push(...steps);
    per.push({ event: e.slug, items });
  }
  const due = events.filter((e) => e.update_due);
  // A stop recorded here whose queued drafts aren't confirmed deleted yet: the routine could still send them.
  const stops = evs.map((e) => routineStopWords(e.dir, e.slug, nowMs)).filter(Boolean);
  const out = {
    events,
    ...(stops.length ? { drafts_delete: stops.flatMap((x) => x.drafts_delete), drafts_delete_say: `${stops.map((x) => x.say).join(' ')} Tell the user this plainly.` } : {}),
    ...(due.length ? { show_update: `The daily routine for ${due.map((e) => e.event).join(', ')} needs an update (${due.map((e) => e.update_due).join('; ')}). Run each routine_body command, then do what it says.` } : {})
  };
  if (!reads.length) return out;
  mkdirSync(answerDir(run), { recursive: true, mode: 0o700 });
  writeJson(join(runsDir(h), `${run}.json`), { run, at: new Date(nowMs).toISOString(), state: 'open', per, reads: reads.map(({ step, key, event, write }) => ({ step, key, event, write })) });
  return {
    ...out,
    check: {
      run,
      reads: reads.map(({ step, key, event, tool, tool_names, args, write }) => ({ step, key, event, tool, tool_names, args, write })),
      then: [...cli(), 'routine-checked', '--run', run],
      say: "Before anything else: for each read, call that Gmail tool (or the one whose name ends the same way) once with exactly its args, and write the tool's whole answer, as JSON, to its write file (an error too). These are reads only. Then run then, and tell the user its say, word for word."
    }
  };
}

async function checked(opts) {
  need(opts, 'run');
  const run = String(opts.run);
  if (!RUN_RE.test(run)) throw new Error('--run is the run id routine-status gave');
  const h = home();
  const f = join(runsDir(h), `${run}.json`);
  if (!existsSync(f)) throw new Error(`no routine check ${run}: run routine-status`);
  const r = JSON.parse(readFileSync(f, 'utf8'));
  if (r.state !== 'open') throw new Error(`routine check ${run} was already read in: run routine-status for a new one`);
  const read = (w) => {
    if (dirname(w) !== answerDir(run) || !existsSync(w)) return null;
    const st = lstatSync(w);
    return st.isFile() && st.size <= 1024 * 1024 ? readFileSync(w, 'utf8') : '';
  };
  const nowMs = clockNow();
  r.state = 'done';
  writeJson(f, r);
  const events = [];
  const says = [];
  for (const p of r.per) {
    const answers = { search: {}, draft: {} };
    for (const x of r.reads.filter((y) => y.event === p.event)) answers[x.step === 'search' ? 'search' : 'draft'][x.key] = read(x.write);
    const evDir = eventDirOf(h, p.event);
    if (eventJson(evDir)?.autosend_mode !== ROUTINE_MODE) continue;
    const out = reconcile(evDir, p.items, answers, nowMs);
    if (out.say) says.push(out.say);
    events.push({ ...stateOf(h, p.event, nowMs), went: out.went.length, held: out.held.length, gone: out.gone.length, unknown: out.unknown.length, paused: out.paused });
  }
  return { events, say: says.join(' ') || 'Nothing to report from the daily routine.', ...(events.some((e) => e.update_due) ? { next: 'Run each routine_body command, then do what it says, so the routine has the new list.' } : {}) };
}

export const ROUTINE_HANDLERS = { 'routine-body': body, 'routine-saved': saved, 'routine-status': status, 'routine-checked': checked };
