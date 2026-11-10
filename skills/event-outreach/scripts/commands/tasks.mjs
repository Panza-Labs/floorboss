// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// CRM tasks: follow-up tasks to create, the receipts for those created, and their status.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { allowedPath } from '../../../../lib/paths.mjs';
import { taskItems, readOutcome } from '../tracking.mjs';
import { need } from '../../../../lib/args.mjs';
import { readJson, writeJson } from '../../../../lib/jsonio.mjs';
import { todayKeyIn } from '../../../../lib/tz.mjs';
import { taskMark } from '../../../../lib/sendcheck.mjs';
import { validateTaskReceipts, validateTaskStatus } from '../../../connectors/scripts/tasks.mjs';
import { loadConfig } from '../../../../lib/config.mjs';
import { sendRoute } from './routes.mjs';
import { ctxOf, crmIdOf, sendingOn, led, isOut, labelOf } from './context.mjs';
import { readTodo } from './saved-drafts.mjs';
import { allOutboxCards } from './cards.mjs';

// The CRM tasks floorboss wants now: event-app and LinkedIn messages to send, notes for colleagues, decisions
// for the user, and opt-outs for record owners. Written to task-list.json; the guard only lets through a
// create-task call that matches an item there word for word.
export function taskList(opts) {
  need(opts, 'event');
  const c = ctxOf(opts.event, opts);
  const today = c.today;
  // A review task made under the older tag (unclear<i>-<key>) is the same task as unclear-<key>.
  const created = new Set(
    Object.values(c.state).flatMap((s) => Object.keys(s.tasks || {}).flatMap((k) => [k, k.replace(/:review:unclear\d+-/, ':review:unclear-')]))
  );
  const held = (readTodo(c, { jobs: [] }).jobs || [])
    .filter((j) => j.held_for_user)
    .map((j) => ({
      id: j.id,
      touch: j.touch,
      tag: `held${j.touch}`,
      reason: `The message to them ${j.held_for_user.replace(/: don't draft it again;?/, ':')}`
    }));
  const unclear = Object.entries(c.state).flatMap(([id, s]) =>
    (s.unclear || []).map((u) => ({
      id,
      tag: `unclear-${u.key}`,
      reason: `A task about them came back with an outcome floorboss can't read: ${u.why}. Tell floorboss what happened (replied, booked which time, or stop).`
    }))
  );
  const stops = Object.entries(c.state)
    .filter(([, s]) => s.stopped)
    .map(([id]) => id);
  // Someone blocked since their message task was made: the task is still open in the CRM, so tell the user
  // not to send it and to close it.
  const cancel = Object.entries(c.state)
    .flatMap(([id, s]) =>
      Object.entries(s.tasks || {})
        .filter(([, t]) => t.kind === 'send' && !t.done && !s.sent?.[t.touch])
        .map(([key]) => [id, key])
    )
    .map(([id, key]) => ({ id, why: c.blocked(id), key }))
    .filter((x) => x.why)
    .map((x) => ({
      id: x.id,
      tag: `cancel-${x.key}`,
      reason: `Don't send the message in the open task for them, and close that task: they can't be contacted now (${x.why}).`
    }));
  c.config = loadConfig();
  const items = taskItems({
    cards: allOutboxCards(c),
    review: [...held, ...unclear, ...cancel],
    stops,
    created,
    event: c.event,
    byId: c.byId,
    crmOf: (id) => (crmIdOf(c, id) ? { ...(c.triage.pre?.[id]?.crm || {}), crm_id: crmIdOf(c, id) } : c.triage.pre?.[id]?.crm),
    today,
    now: c.now.toISOString(),
    selfSends: (card) => sendingOn(c.settings) && !!sendRoute(c, card.id, card.channel, card.touch)
  });
  const file = join(c.paths.dir, 'task-list.json');
  writeJson(file, items);
  const recipe = loadConfig().connectors?.['crm.create_task'] || null;
  return {
    to_create: items.length,
    by_kind: items.reduce((m, x) => ({ ...m, [x.kind]: (m[x.kind] || 0) + 1 }), {}),
    file,
    connected: recipe ? `${recipe.server} · ${recipe.tool}` : null,
    rule: 'Create one task per item with the crm.create_task recipe: title, body, due and contact_ref exactly as written. Never assign, complete, update or delete a task. Then save the ids with tasks-created.'
  };
}

export function tasksCreated(opts) {
  need(opts, 'event', 'file');
  const c = ctxOf(opts.event, opts);
  const wanted = readJson(join(c.paths.dir, 'task-list.json'), []);
  const r = validateTaskReceipts(readJson(allowedPath(opts.file)), wanted);
  if (r.errors.length) return { saved: 0, errors: r.errors };
  const byKey = Object.fromEntries(wanted.map((w) => [w.key, w]));
  const already = new Set(Object.values(c.state).flatMap((x) => Object.keys(x.tasks || {})));
  // One CRM task id is one floorboss task: an id already recorded for another task, or given twice here, would put
  // that task's outcome (a stop among them) on the wrong person.
  const owner = new Map();
  for (const x of Object.values(c.state)) for (const [key, tk] of Object.entries(x.tasks || {})) if (tk?.task_id) owner.set(String(tk.task_id), key);
  const keysHere = new Set();
  const clash = [];
  for (const t of r.tasks) {
    if (keysHere.has(t.key)) clash.push(`${t.key} is listed twice`);
    keysHere.add(t.key);
    const o = owner.get(String(t.task_id));
    if (o && o !== t.key) clash.push(`${t.key}: CRM task ${t.task_id} is already recorded for ${o}; each task has its own id`);
    owner.set(String(t.task_id), t.key);
  }
  if (clash.length) return { saved: 0, errors: clash };
  // A receipt is for a task the guard let through and that ran (it marks each one): one for a task never made, or
  // declined at the prompt, isn't taken.
  const unmade = r.tasks.filter((t) => !existsSync(join(c.paths.dir, 'released', `task-${taskMark(t.key)}`)));
  if (unmade.length)
    return {
      saved: 0,
      errors: unmade.map(
        (t) =>
          `${t.key}: floorboss has no record of this task being created through the guard; create it from task-list (the call asks you), then save its receipt.`
      )
    };
  const refused = [];
  for (const t of r.tasks) {
    const w = byKey[t.key];
    // A task for someone blocked since the list was made, or one already recorded, isn't taken: the user is
    // told to close it in the CRM.
    const why = w.kind === 'send' || w.kind === 'coordinate' ? c.blocked(w.id, w.kind === 'coordinate' ? 'coordinate' : 'message') : null;
    if (already.has(t.key) || why) {
      refused.push({ key: t.key, task_id: t.task_id, why: why || 'already recorded', next: "Close this task in the CRM: it isn't needed." });
      continue;
    }
    led(c, { type: 'task_created', id: w.id, touch: w.touch, key: t.key, task_kind: w.kind, task_id: t.task_id });
    // A message task created counts as in the outbox for that touch.
    if (w.kind === 'send' && !isOut(c.state[w.id]?.touches?.[w.touch]?.status)) led(c, { type: 'outboxed', id: w.id, touch: w.touch });
  }
  // What's recorded leaves the list, so the guard can't let the same task through again.
  const done = new Set(r.tasks.map((t) => t.key));
  writeJson(
    join(c.paths.dir, 'task-list.json'),
    wanted.filter((w) => !done.has(w.key))
  );
  return { saved: r.tasks.length - refused.length, refused: refused.length ? refused : undefined };
}

// What the CRM says about floorboss's tasks: a done message task means sent; its outcome may say replied,
// booked or stop. Anything unclear goes back to the user as a task, never guessed.
export function taskStatus(opts) {
  need(opts, 'event', 'file');
  const c = ctxOf(opts.event, opts);
  const known = {};
  const twice = new Set();
  for (const [id, s] of Object.entries(c.state))
    for (const [key, t] of Object.entries(s.tasks || {})) {
      if (known[t.task_id]) twice.add(t.task_id);
      known[t.task_id] = { id, key, ...t };
    }
  const r = validateTaskStatus(readJson(allowedPath(opts.file)), new Set(Object.keys(known)));
  if (r.errors.length) return { applied: false, errors: r.errors };
  // A task listed twice in one read is one task: applied once.
  const repeated = r.tasks.map((t) => t.task_id).filter((id, i, a) => a.indexOf(id) !== i);
  if (repeated.length) return { applied: false, errors: [`task ${[...new Set(repeated)].join(', ')} is listed more than once: one entry per task`] };
  const out = { sent: [], replied: [], booked: [], stopped: [], unclear: [] };
  for (const t of r.tasks) {
    const k = known[t.task_id];
    const st = c.state[k.id] || {};
    if (t.status !== 'done' || k.done) continue;
    if (twice.has(t.task_id)) {
      if (!(c.entries || []).some((e) => e.type === 'outcome_unclear' && e.key === `task-${t.task_id}`)) {
        led(c, {
          type: 'outcome_unclear',
          id: k.id,
          key: `task-${t.task_id}`,
          why: `CRM task ${t.task_id} is recorded for more than one person, so its outcome wasn't applied: whose is it, and what did it say (sent, replied, booked which time, or stop)?`
        });
        out.unclear.push(k.id);
      }
      continue;
    }
    // The day it was done: never ahead of now, never before the task was made (it sets when follow-ups are due).
    const doneMs = t.completed_at ? Math.min(Date.parse(t.completed_at), c.now.getTime()) : c.now.getTime();
    const madeMs = k.at ? Date.parse(k.at) || 0 : 0;
    const day = todayKeyIn(c.event.time_zone, new Date(Math.max(doneMs, madeMs)));
    led(c, { type: 'task_done', id: k.id, key: k.key, date: day });
    // A decision task answered in the CRM: its note is read like any outcome, and the question is settled.
    if (k.kind === 'review') {
      // Only the question this review task was made for (its tag names it): a held-message or a close-the-task
      // review settles none, and a question raised since stays open.
      const asked = /:review:unclear\d*-(.+)$/.exec(k.key)?.[1];
      if (asked && st.unclear?.some((u) => u.key === asked)) led(c, { type: 'unclear_resolved', id: k.id, key: asked });
      const ro = readOutcome(t.outcome, []);
      if (ro.kind === 'stop' && !st.stopped) {
        led(c, { type: 'stop', id: k.id });
        out.stopped.push(k.id);
      }
      if (ro.kind === 'replied' && !st.replied) {
        led(c, { type: 'replied', id: k.id });
        out.replied.push(k.id);
      }
      continue;
    }
    if (k.kind !== 'send') continue;
    if (!st.sent?.[k.touch]) {
      led(c, { type: 'sent', id: k.id, touch: k.touch, date: day, via: 'crm task' });
      out.sent.push(k.id);
    }
    const labels = (c.short.assignments?.[k.id] || []).map((x) => ({
      id: x,
      label: labelOf(c, x)
    }));
    const o = readOutcome(t.outcome, labels);
    if (o.kind === 'stop' && !st.stopped) {
      led(c, { type: 'stop', id: k.id });
      out.stopped.push(k.id);
    }
    if (o.kind === 'replied' && !st.replied) {
      led(c, { type: 'replied', id: k.id });
      out.replied.push(k.id);
    }
    if (o.kind === 'booked') {
      // The same check a pasted status gets: one person per time.
      const holder = Object.entries(c.state).find(([cid, x]) => cid !== k.id && x.booked === o.slot && !x.stopped);
      if (holder) {
        led(c, { type: 'outcome_unclear', id: k.id, key: k.key, why: `the outcome books ${o.slot}, but ${holder[0]} already has that time` });
        out.unclear.push(k.id);
      } else {
        led(c, { type: 'booked', id: k.id, slot: o.slot, via: 'crm task' });
        c.state[k.id] = { ...st, booked: o.slot };
        out.booked.push(k.id);
      }
    }
    if (o.kind === 'unclear') {
      led(c, { type: 'outcome_unclear', id: k.id, key: k.key, why: o.why });
      out.unclear.push(k.id);
    }
  }
  // Reading a person's tasks checks their app and LinkedIn replies (what the user logged there).
  // A task read as done is a look at what was logged on it (an app or LinkedIn reply included): only those count as a
  // reply check. An open task says nothing about replies.
  for (const id of new Set(
    r.tasks
      .filter((t) => t.status === 'done')
      .map((t) => known[t.task_id]?.id)
      .filter(Boolean)
  ))
    led(c, { type: 'checked', id, source: 'tasks' });
  led(c, { type: 'tasks_read' });
  return { applied: true, ...out };
}
