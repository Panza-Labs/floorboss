// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// CRM tasks: follow-up tasks to create, the receipts for those created, and their status.
import { stateOf } from '../../../../lib/spacing.mjs';
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
import { sendRoute, writtenInApp, appLimitReached, whereAt } from './routes.mjs';
import { ctxOf, crmIdOf, sendingOn, led, isOut, labelOf } from './context.mjs';
import { readTodo } from './saved-drafts.mjs';
import { allOutboxCards, tasksToClose, latestTask, superseded } from './cards.mjs';
import { PASSED_WHY } from '../../../../lib/route.mjs';

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
  const cancel = tasksToClose(c).map((x) => ({
    id: x.id,
    tag: `cancel-${x.key}`,
    plain: true,
    reason:
      x.why === 'already went'
        ? `The message in the open task for ${c.byId[x.id]?.name || x.id} already went: close that task, don't send it.`
        : x.why === PASSED_WHY
        ? `The LinkedIn message in the open task for ${c.byId[x.id]?.name || x.id} was ${PASSED_WHY}. Close that task, don't send it.`
        : c.blocked(x.id)
      ? `Don't send the message in the open task for them, and close that task: they can't be contacted now (${x.why}).`
      : `Don't send the message in the open task for them, and close that task: they ${x.why}, so it isn't needed.`
  }));
  c.config = loadConfig();
  // The app's request limit holds for notes the user sends by hand too: a send task for someone not yet written to in
  // the app takes a place, and past the limit it isn't made (the note stays in the outbox).
  const inApp = (card) => card.channel === 'paste' && card.kind === 'message' && card.touch !== 0 && whereAt(c, card.id, card.touch) !== 'LinkedIn';
  const appUsed = writtenInApp(c);
  for (const [id, s] of Object.entries(c.state))
    for (const tk of Object.values(s.tasks || {})) if (tk?.kind === 'send' && Number(tk.touch) > 0 && whereAt(c, id, Number(tk.touch)) !== 'LinkedIn') appUsed.add(id);
  const cards = allOutboxCards(c).filter((card) => {
    // A follow-up not due yet (its day by the one rule, due_on, as taskItems reads it) takes no place in the limit yet.
    const day = card.due_on === undefined ? card.planned_due : card.due_on;
    // (Nor one held today because another event wrote to that address: card.not_today.)
    if (!inApp(card) || card.due_waits || card.due_on === null || card.not_today || (day && day > today) || created.has(`${card.id}:${card.touch}`)) return true;
    if (sendingOn(c.settings) && sendRoute(c, card.id, card.channel, card.touch)) return true;
    if (appLimitReached(c, card.id, appUsed)) return false;
    appUsed.add(card.id);
    return true;
  });
  const items = taskItems({
    cards,
    review: [...held, ...unclear, ...cancel],
    stops,
    created,
    event: c.event,
    byId: c.byId,
    crmOf: (id) => (crmIdOf(c, id) ? { ...(c.triage.pre?.[id]?.crm || {}), crm_id: crmIdOf(c, id) } : c.triage.pre?.[id]?.crm),
    today,
    dayState: c.dayState,
    now: c.now.toISOString(),
    taskOf: (id, touch) => latestTask(c.state[id], touch),
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
    // Over, or its dates can't be read: no send task is made (reviews and opt-outs still are), and it says why.
    note: stateOf(c).state !== 'ok' ? `No task to send anything is made for ${c.event.name}: ${stateOf(c).why}.` : undefined,
    rule: 'Create one task per item with the crm.create_task recipe: title, body, due and contact_ref exactly as written. Never assign, complete, update or delete a task. Then save the ids with tasks-created.'
  };
}

const SENT_SAID = /\b(sent|sent it|went|done)\b/i;

// The user's answer to "Did you send the message in the task for <name>?": yes records that send, with the text the
// task held; no counts the task as not needed, so the message gets a new task.
export function taskSent(opts) {
  need(opts, 'event', 'key', 'went');
  const c = ctxOf(opts.event, opts);
  const hit = Object.entries(c.state).map(([id, s]) => [id, s.tasks?.[opts.key]]).find(([, t]) => t?.ask_sent);
  if (!hit) throw new Error(`No task ${opts.key} is waiting for that answer.`);
  const [id, tk] = hit;
  const went = /^(yes|y|sent|it went)\b/i.test(String(opts.went)) ? 'yes' : /^(no|n|not sent|didn'?t)\b/i.test(String(opts.went)) ? 'no' : null;
  if (!went) throw new Error('Answer "yes" or "no".');
  if (went === 'yes' && !c.state[id]?.sent?.[tk.touch])
    led(c, { type: 'sent', id, touch: tk.touch, date: typeof tk.ask_sent === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(tk.ask_sent) ? tk.ask_sent : c.today, via: 'crm task', ...(tk.hash ? { hash: tk.hash } : {}) });
  led(c, { type: 'task_send_settled', id, key: opts.key, went });
  return { recorded: went === 'yes' ? 'sent' : 'not sent: a new task follows' };
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
    led(c, { type: 'task_created', id: w.id, touch: w.touch, key: t.key, task_kind: w.kind, task_id: t.task_id, ...(w.kind === 'send' && w.hash ? { hash: w.hash, day: w.day || null } : {}) });
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
  const sentHere = new Set();
  // Message tasks floorboss asked (or is about to ask) the user to close: finishing one records nothing as sent.
  const toClose = new Set(tasksToClose(c).map((x) => x.key));
  for (const card of allOutboxCards(c)) if (card.task_changed) toClose.add(latestTask(c.state[card.id], card.touch)?.key);
  // Whether the request to close this task still stands now (replaced, or the text, the day or the person changed).
  const stands = (k, st) =>
    k.kind === 'send' &&
    (superseded(st, k.key) || toClose.has(k.key) || !!(k.hash && st.touches?.[k.touch]?.approved?.hash && st.touches[k.touch].approved.hash !== k.hash));
  // A close request made for this task before it was finished (a cancel or a changed review task).
  const reviewBefore = (k, st, doneMs) =>
    [`${k.id}:review:cancel-${k.key}`, `${k.id}:review:changed-${k.key}`].some((rk) => st.tasks?.[rk] && (!st.tasks[rk].at || Date.parse(st.tasks[rk].at) <= doneMs));
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
    // Its message already went (another task for it was finished as sent, now or before): no second send.
    if (k.kind === 'send' && (st.sent?.[k.touch] || sentHere.has(`${k.id}:${k.touch}`))) {
      led(c, { type: 'task_done', id: k.id, key: k.key, date: day });
      continue;
    }
    // "Done" means sent, unless floorboss asked the user to close this task first and that still stands. The outcome
    // text says which when it says "sent"; anything else doubtful is asked once.
    const sentSaid = k.kind === 'send' && SENT_SAID.test(String(t.outcome || '')) && !/\b(not|never|didn'?t|haven'?t|no)\b/i.test(String(t.outcome || ''));
    // An outcome that says it wasn't sent, or asks ("not sent", "didn't send", "sent? no"): nothing is recorded until
    // the user answers. (A stop is read as a stop, whatever else it says.)
    const outText = String(t.outcome || '');
    const negated = k.kind === 'send' && !!outText.trim() && readOutcome(outText, []).kind !== 'stop' && /\b(not|never|didn'?t|did not|haven'?t|no)\b|\?/i.test(outText);
    const doubtful = negated || (!sentSaid && stands(k, st));
    const unneeded = !negated && doubtful && reviewBefore(k, st, doneMs);
    led(c, { type: 'task_done', id: k.id, key: k.key, date: day, ...(unneeded ? { unneeded: true } : {}) });
    if (doubtful && !unneeded) {
      led(c, { type: 'task_send_unclear', id: k.id, key: k.key, touch: k.touch, date: day });
      out.unclear.push(k.id);
      continue;
    }
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
    // A task replaced by a newer one, or one the user was asked to close: closing it in the CRM records nothing.
    if (unneeded) continue;
    if (!st.sent?.[k.touch]) {
      led(c, { type: 'sent', id: k.id, touch: k.touch, date: day, via: 'crm task', ...(k.hash ? { hash: k.hash } : {}) });
      sentHere.add(`${k.id}:${k.touch}`);
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
    // An outcome that only says it was sent ("sent", "done") is clear: the send is recorded above.
    if (o.kind === 'unclear' && !/^\s*(?:sent|sent it|done|it went|went)\s*[.!]?\s*$/i.test(String(t.outcome || ''))) {
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
