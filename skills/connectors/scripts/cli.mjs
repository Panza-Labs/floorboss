#!/usr/bin/env node
// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Connector discovery: list the tasks, screen tools, validate what a tool returned, save and show recipes.
import { allowedPath, home, configPath, assertSlug, readChecked } from '../../../lib/paths.mjs';
import { normEmail } from '../../../lib/normalize.mjs';
import { sameServer } from '../../../lib/security.mjs';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { run, need } from '../../../lib/args.mjs';
import { readJson, writeJson } from '../../../lib/jsonio.mjs';
import { loadConfig, saveConfig } from '../../../lib/config.mjs';
import { loadEvent } from '../../../lib/event.mjs';
import {
  TASKS,
  screenTools,
  screenTool,
  validateBusy,
  validateCrmRecords,
  validateThreads,
  checkRecipe,
  schemaFlags,
  toolHash,
  bareToolName,
  validateEvents,
  validateTaskStatus,
  validateMailHistory,
  validateSync,
  validateEnriched,
  TEST_TASK
} from './tasks.mjs';
import { movedNow } from '../../../lib/clock.mjs';

const now = () => (movedNow() ? new Date(movedNow()) : new Date()).toISOString();
const readFileJson = (path) => JSON.parse(readChecked(allowedPath(path)));
const listOf = (v) => (Array.isArray(v) ? v : Array.isArray(v?.tools) ? v.tools : v && typeof v === 'object' ? [v] : []);
// A check of the live tool list counts for an hour; plan, triage and draft run it right before use.
const CHECK_TTL_MS = 3600 * 1000;

// The channels the user turned sending on for: the saved setting, or, during setup before the follow-up mode is
// chosen, their answer to the sending question (so send setup can screen and test the tool it will use).
function chosenChannels() {
  const set = loadConfig().sending?.channels;
  if (Array.isArray(set) && set.length) return set;
  const raw = readJson(join(dirname(configPath()), 'onboarding.json'), {})?.answers?.sending_channels;
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(String(raw || '[]'));
    return Array.isArray(v) ? v : [];
  } catch {
    return String(raw || '')
      .split(/[\s,]+/)
      .filter(Boolean);
  }
}
function tasks() {
  return Object.entries(TASKS).map(([task, t]) => ({ task, kind: t.kind, replaces: t.replaces, without_it: t.fallback, format: t.format }));
}

// tools-file: a JSON list of {name, description} as the session (or a stand-in) lists them.
function screen(opts) {
  need(opts, 'tools-file');
  const list = readFileJson(opts['tools-file']);
  // --sending: the user turned sending on, so send tools can be mapped to email.send or chat.send (one message at a time).
  const sending = !!opts.sending && chosenChannels().length > 0;
  return {
    tools: screenTools(Array.isArray(list) ? list : list.tools || [], { sending }),
    rule: sending
      ? 'Only one-message send tools can be mapped, to email.send or chat.send, and only for messages the user approved. Bulk, scheduled, forward and delete tools are never mapped.'
      : 'Tools that send, post, delete or change records are never mapped, whatever their description says.'
  };
}

function validateRead(task, data, opts) {
  if (task === 'calendar.busy') return validateBusy(data, { from: opts.from, to: opts.to });
  if (task === 'crm.lookup') return validateCrmRecords(data);
  if (task === 'enrich.person') return validateEnriched(data);
  if (task === 'calendar.events') return validateEvents(data);
  if (task === 'email.history') return validateMailHistory(data);
  if (task === 'email.messages' || task === 'crm.activity') return validateSync(data, task);
  // The probe reads the test task back: it must be there, still open.
  if (task === 'crm.read_tasks') {
    const r = validateTaskStatus(data);
    if (!r.errors.length && !r.tasks.length) return { errors: ['the probe read no task; read the test task back'] };
    return r;
  }
  if (task === 'email.thread_has_reply') {
    // The probe is the test draft's own thread: it must read back, with no reply yet.
    const list = Array.isArray(data?.threads) ? data.threads : [];
    const r = validateThreads(
      data,
      list.map((t) => ({ id: t?.id, touch: Number(t?.touch ?? 1) }))
    );
    if (!r.errors.length && !r.threads.length) return { errors: ["the probe read no thread; use the test draft's thread"] };
    if (!r.errors.length && r.threads.some((t) => t.has_reply))
      return { errors: ["the test draft's thread shows a reply; a reply must be a message from someone else after yours, and a draft alone isn't one"] };
    return r;
  }
  throw new Error(`${task} results are checked by the step that uses them (outreach staged).`);
}

// Check a tool's answer, translated into floorboss's format. With --out, writes the normalized result.
function validate(opts) {
  need(opts, 'task', 'file');
  const r = validateRead(opts.task, readFileJson(opts.file), opts);
  if (r.errors.length)
    return {
      ok: false,
      errors: r.errors,
      next: "Fix the translation from the tool's output and validate again. If the tool can't give this, use the file option."
    };
  if (opts.out)
    writeJson(
      allowedPath(opts.out, { write: true }),
      opts.task === 'calendar.busy' ? { busy: r.busy } : opts.task === 'crm.lookup' ? { records: r.records, not_found: r.not_found } : r
    );
  if (opts.task === 'calendar.busy') return { ok: true, busy_blocks: r.busy.length, first: r.busy[0] || null, out: opts.out || null };
  if (opts.task === 'crm.lookup')
    return { ok: true, found: r.records.length, not_found: r.not_found.length, opted_out: r.records.filter((x) => x.opted_out).length, out: opts.out || null };
  if (opts.task === 'calendar.events') return { ok: true, events: r.events.length, with_attendees: r.events.filter((e) => e.attendees.length).length };
  if (opts.task === 'crm.read_tasks') return { ok: true, tasks: r.tasks.length, done: r.tasks.filter((t) => t.status === 'done').length };
  if (opts.task === 'email.history') return { ok: true, people: r.people.length, in_touch: r.people.filter((x) => x.threads > 0).length };
  if (opts.task === 'email.messages' || opts.task === 'crm.activity')
    return { ok: true, people: r.people.length, items: r.people.reduce((n, p) => n + p.items.length, 0) };
  return { ok: true };
}

// recipe-file: {server, tool, args, reading, opt_out_source?, test_draft_seen?}. probe-file: the probe call's
// result translated into floorboss's format (read tasks). The probe is validated here, not taken on trust.
function saveRecipe(opts) {
  need(opts, 'task', 'recipe-file');
  const task = opts.task;
  const recipe = readFileJson(opts['recipe-file']);
  if (TASKS[task]?.kind === 'read') {
    if (!opts['probe-file']) throw new Error(`${task} needs --probe-file: the probe call's result in floorboss's format.`);
    const r = validateRead(task, readFileJson(opts['probe-file']), opts);
    recipe.probe = {
      ok: !r.errors.length,
      at: now(),
      errors: r.errors.length ? r.errors : undefined,
      count: r.busy?.length ?? r.records?.length ?? r.threads?.length ?? r.events?.length ?? r.tasks?.length ?? r.people?.length ?? 0
    };
  }
  // The tool's own listing, as the session shows it: the recipe is bound to its hash.
  if (!opts['tool-file']) throw new Error(`${task} needs --tool-file: the tool's entry from the session's tool list (name, description, inputSchema).`);
  const entry = listOf(readFileJson(opts['tool-file'])).find((t) => bareToolName(t?.name) === bareToolName(recipe.tool));
  if (!entry) return { saved: false, errors: [`--tool-file has no entry named "${recipe.tool}"; pass the listing of the tool the recipe uses`] };
  const flags = schemaFlags(entry.inputSchema || entry.input_schema);
  // A send tool that takes a thread must be given it, or every follow-up starts a new conversation.
  if (task === 'email.send') {
    const props = Object.keys((entry.inputSchema || entry.input_schema || {}).properties || {});
    const threadKey = props.find((k) => /^(thread_?id|threadid|thread|conversation_?id|in_?reply_?to|reply_?to_?message_?id|references)$/i.test(k));
    const carried = /\{(thread_id|reply_in_thread|reply_to_message_id)\}/.test(JSON.stringify(recipe.args || {}));
    if (threadKey && !carried)
      return {
        saved: false,
        errors: [
          `"${recipe.tool}" can reply in a thread ("${threadKey}"): add it to the recipe as "${threadKey}": "{thread_id}" so follow-ups stay in the conversation`
        ]
      };
    if (!threadKey) recipe.threads = false;
  }
  if (flags.length)
    return { saved: false, errors: flags.map((f) => `"${recipe.tool}" ${f}, which can make it send or notify; floorboss never maps such a tool`) };
  delete recipe.verified;
  // A tool whose description gives assistants orders is never trusted to send or stage.
  const says = screenTools([entry])[0]?.description_says;
  if (says && (TASKS[task]?.kind === 'send' || task === 'stage_draft' || task === 'crm.create_contact'))
    return {
      saved: false,
      errors: [
        `${recipe.tool}'s description tries to tell assistants what to do, so floorboss won't let it ${TASKS[task]?.kind === 'send' ? 'send' : task === 'crm.create_contact' ? 'add records' : 'stage drafts'}. Tell the user; they can use the file option instead.`
      ]
    };
  recipe.tool_hash = toolHash(entry);
  if (task === 'stage_draft' || task === 'crm.create_task' || task === 'crm.create_contact' || TASKS[task]?.kind === 'send') {
    // Ask the user first; pass --user-confirmed only after they said they see the test draft (or task).
    if (!opts['test-draft-id'])
      throw new Error(
        `${task} needs --test-draft-id: the id of the test ${task === 'stage_draft' ? 'draft' : task === 'crm.create_task' ? 'task' : task === 'crm.create_contact' ? "record (the first listed person, created on the user's yes)" : 'message sent to the user themselves'}.`
      );
    recipe.test_draft = {
      draft_id: String(opts['test-draft-id']),
      user_confirmed: opts['user-confirmed'] === true || opts['user-confirmed'] === 'yes',
      at: now()
    };
  }
  const errors = checkRecipe(task, recipe);
  if (errors.length) return { saved: false, errors };
  const cfg = loadConfig();
  const connectors = { ...(cfg.connectors || {}), [task]: { ...recipe, task, saved_at: now() } };
  saveConfig({ connectors });
  return { saved: true, task, tool: `${recipe.server} · ${recipe.tool}`, probe: recipe.probe || undefined };
}

function forget(opts) {
  need(opts, 'task');
  if (!opts['user-confirmed']) throw new Error("Forgetting a connection needs the user's say: ask them, then run forget again with --user-confirmed.");
  const cfg = loadConfig();
  const connectors = { ...(cfg.connectors || {}) };
  const had = !!connectors[opts.task];
  delete connectors[opts.task];
  saveConfig({ connectors });
  return { forgotten: had, task: opts.task, now: TASKS[opts.task]?.fallback || null };
}

// Compare saved recipes with the live tool list. A changed or missing tool means discovery again.
function checkLive(file) {
  const live = listOf(readFileJson(file));
  const cfg = loadConfig();
  const connectors = { ...(cfg.connectors || {}) };
  const out = [];
  for (const [task, r] of Object.entries(connectors)) {
    if (!r || typeof r !== 'object' || !TASKS[task]) continue;
    // The tool on the recipe's own server: a copy with the same name on another server never stands in, and
    // two live tools sharing the name make the check fail rather than pick one.
    const serverOf = (n) => (/^mcp__(.+?)__/.exec(String(n || '')) || [])[1] || null;
    // The server by its whole name (or that name as claude.ai prefixes it), compared as the guard compares it:
    // "evilgmail" isn't "gmail", and "hub_spot" isn't "hubspot".
    const same = live.filter(
      (t) => bareToolName(t?.name) === bareToolName(r.tool) && (!serverOf(t?.name) || !r.server || sameServer(serverOf(t.name), r.server))
    );
    const hashes = same.map((t) => toolHash(t));
    const result = !r.tool_hash
      ? 'unbound: run discovery again'
      : !same.length
        ? 'missing: run discovery again'
        : same.length > 1
          ? 'ambiguous: two connected tools have this name and the list does not say whose; run discovery again'
          : hashes.includes(r.tool_hash)
            ? 'same'
            : 'changed: run discovery again';
    connectors[task] = { ...r, verified: { at: now(), result, hash: result === 'same' ? r.tool_hash : hashes[0] || null } };
    out.push({ task, tool: `${r.server} · ${r.tool}`, result });
  }
  saveConfig({ connectors });
  return out;
}

// Why a saved recipe can't be used now, or null when it can.
function notUsable(r) {
  const v = r.verified;
  if (!v)
    return {
      errors: [`${r.tool}: not checked against this session's tool list`],
      next: "Write the session's listing of the tool (name, description, inputSchema) to a file, run `cli.mjs check --tools-file <file>`, then ask for the recipe again."
    };
  if (v.result !== 'same' || v.hash !== r.tool_hash)
    return {
      errors: [`${r.tool}: ${v.result === 'same' ? 'changed: run discovery again' : v.result}`],
      next: 'Tell the user the tool changed since setup; fall back for this run and re-run discovery for this task in /floorboss:event-setup.'
    };
  if (Date.parse(now()) - Date.parse(v.at) > CHECK_TTL_MS)
    return {
      errors: [`${r.tool}: last checked ${v.at}, over an hour ago`],
      next: 'Run `cli.mjs check --tools-file <file>` with the live tool list, then ask for the recipe again.'
    };
  return null;
}

// Setup's one test draft or test task, before its recipe exists: the guard lets exactly one call through to
// this tool on this server, within 15 minutes; a test draft only to the user's own address.
function testAllow(opts) {
  need(opts, 'task', 'server', 'tool');
  if (!['stage_draft', 'crm.create_task', 'crm.create_contact', 'email.send', 'chat.send'].includes(opts.task))
    throw new Error('Only stage_draft, crm.create_task, crm.create_contact, email.send and chat.send have a test.');
  const s = screenTool(opts.task, opts.tool);
  if (!s.ok) throw new Error(s.reason);
  if (['stage_draft', 'email.send'].includes(opts.task) && !normEmail(opts.to))
    throw new Error(`A test ${opts.task === 'email.send' ? 'send' : 'draft'} needs --to <the user's own address>.`);
  // A real send can only go to the user themselves: the address or number saved as theirs in settings,
  // and only once they turned sending on for that channel.
  const cfg = loadConfig();
  if (opts.task === 'email.send' && !chosenChannels().includes('email'))
    throw new Error("Turn email sending on first (onboarding's sending question); then set it up with a test send to yourself.");
  if (opts.task === 'chat.send' && !chosenChannels().includes('chat'))
    throw new Error("Turn chat sending on first (onboarding's sending question); then set it up with a test message to yourself.");
  if (opts.task === 'email.send' && normEmail(opts.to) !== normEmail(cfg.own_email || ''))
    throw new Error("The test send goes only to the user's own address: save it first as own_email (config), then use that address.");
  // A test draft lands in a mailbox too: only the user's own address, as for a test send.
  if (opts.task === 'stage_draft' && normEmail(opts.to) !== normEmail(cfg.own_email || ''))
    throw new Error("The test draft goes only to the user's own address: save it first as own_email (config), then use that address.");
  if (opts.task === 'chat.send' && String(opts.to || '').replace(/\D/g, '') !== String(cfg.own_phone || '').replace(/\D/g, ''))
    throw new Error("The test message goes only to the user's own number: save it first as own_phone (config), then use that number.");
  // One test task, before its recipe exists, in floorboss's own words (the guard holds it to them).
  if (opts.task === 'crm.create_task' && cfg.connectors?.['crm.create_task'])
    throw new Error('crm.create_task is set up already: tasks go through its recipe, not a test.');
  // The first record is a real one: a person on the event's list to add (outreach contact-list), never anyone else.
  if (opts.task === 'crm.create_contact') {
    need(opts, 'event');
    // One test, before the recipe exists, and only on the CRM floorboss already reads people from.
    if (cfg.connectors?.['crm.create_contact']) throw new Error('crm.create_contact is set up already: new contacts go through its recipe, not a test.');
    const lookup = cfg.connectors?.['crm.lookup'];
    if (!lookup?.server) throw new Error('Set up crm.lookup first: the first new contact goes to the CRM floorboss reads people from.');
    if (!sameServer(opts.server, lookup.server))
      throw new Error(`The first new contact goes to your CRM's own server (${lookup.server}), the one crm.lookup reads, not ${opts.server}.`);
    const listed = readJson(join(home(), 'events', assertSlug(String(opts.event)), 'contact-list.json'), []);
    if (!normEmail(opts.to) || !listed.some((x) => normEmail(x?.email) === normEmail(opts.to)))
      throw new Error('The first record must be a person on the list to add: --event <slug> --to <their email, as in contact-list.json>.');
  }
  const phone = opts.task === 'chat.send' ? String(opts.to || '').replace(/[^\d+]/g, '') : null;
  if (opts.task === 'chat.send' && !(phone && phone.replace(/\D/g, '').length >= 7))
    throw new Error("A test chat message needs --to <the user's own number or handle>.");
  writeJson(join(home(), 'test-pending.json'), {
    task: opts.task,
    server: String(opts.server),
    tool: String(opts.tool),
    to: phone || normEmail(opts.to) || null,
    at: now()
  });
  return {
    allowed: `${opts.server} · ${opts.tool}`,
    for: '15 minutes, one call',
    to: normEmail(opts.to) || undefined,
    ...(opts.task === 'crm.create_task' ? { use_text: TEST_TASK } : {})
  };
}

// The readiness table: what's connected and what that means for each run.
function status() {
  const cfg = loadConfig();
  return Object.entries(TASKS).map(([task, t]) => {
    const r = cfg.connectors?.[task];
    if (r && checkRecipe(task, r).length === 0) {
      const v = r.verified;
      if (v && (v.result !== 'same' || v.hash !== r.tool_hash))
        return {
          task,
          connected: null,
          means: `${r.server} · ${r.tool}: ${v.result === 'same' ? 'changed: run discovery again' : v.result}; until then: ${t.fallback}`
        };
      return {
        task,
        connected: `${r.server} · ${r.tool}`,
        means: `replaces ${t.replaces}`,
        since: r.saved_at,
        last_check: v ? v.at : 'checked against the live tool list before each use'
      };
    }
    return { task, connected: null, means: `not connected: ${t.fallback}` };
  });
}

// What triage tells the user before anything else: the checks that are off because no connector does them,
// and what the user has to give by hand instead. A saved recipe counts as connected here; triage still
// checks it against the live tool list before use and falls back if that fails.
function missing(opts) {
  need(opts, 'event');
  const { event, config, settings, paths } = loadEvent(opts.event);
  const has = (task) => {
    const r = config.connectors?.[task];
    return !!r && checkRecipe(task, r).length === 0;
  };
  const known = [
    ...(settings.known_contacts_paths || config.known_contacts_paths || []),
    ...(config.known_contacts_path ? [config.known_contacts_path] : [])
  ].filter((p) => {
    try {
      return existsSync(p) && !!allowedPath(p, { list: true });
    } catch {
      return false;
    }
  });
  const slotsRaw = existsSync(paths.slots) ? readJson(paths.slots) : null;
  const slots = Array.isArray(slotsRaw) ? slotsRaw.length : Array.isArray(slotsRaw?.slots) ? slotsRaw.slots.length : 0;
  const off = [];
  if (!has('email.history'))
    off.push({
      check: 'already_in_touch',
      supplied: known.length > 0,
      line: known.length
        ? `Already-in-touch check: no mailbox is connected. floorboss uses your contacts export instead (${known.length} file${known.length > 1 ? 's' : ''}), so anyone you've emailed who isn't in it looks like a stranger.`
        : "Already-in-touch check is OFF: no mailbox is connected and no contacts export was given, so floorboss can't tell who you already know or are already talking to. Give a contacts export (LinkedIn Connections.csv, Gmail or Outlook contacts) with --known, or name the people you're already in touch with."
    });
  if (!has('crm.lookup'))
    off.push({
      check: 'crm_ownership',
      supplied: !!event.crm?.path,
      line: event.crm?.path
        ? "CRM ownership check: no CRM is connected. floorboss uses your CRM export instead, so it's only as current as that file."
        : "CRM ownership check is OFF: no CRM is connected and no CRM export was given, so floorboss can't see who a colleague owns, who opted out, or who is already a customer. Give a CRM export with --crm, or confirm you have no CRM."
    });
  if (!has('calendar.busy'))
    off.push({
      check: 'calendar_free_time',
      supplied: slots > 0,
      line: slots
        ? `Calendar-based free time is off: no calendar is connected. The ${slots} time${slots > 1 ? 's' : ''} floorboss offers come from the free time you typed or the .ics you gave, so a meeting booked since then won't show; tell me about any.`
        : 'Calendar-based free time is OFF: no calendar is connected and no free time was given, so floorboss has no times to offer. Type your free time or give an .ics export when /floorboss:start asks for your free time.'
    });
  return { none_connected: off.length === 3, off, by_hand: off.filter((o) => !o.supplied).map((o) => o.check) };
}

function recipe(opts) {
  need(opts, 'task');
  if (opts['tools-file']) checkLive(opts['tools-file']);
  const r = loadConfig().connectors?.[opts.task];
  if (!r) return { task: opts.task, connected: false, fallback: TASKS[opts.task]?.fallback || null };
  const errors = checkRecipe(opts.task, r);
  if (errors.length) return { task: opts.task, connected: false, errors, next: 'Re-run discovery for this task (skills/connectors/SKILL.md, "Discovery").' };
  const why = notUsable(r);
  if (why) return { task: opts.task, connected: false, ...why, fallback: TASKS[opts.task].fallback };
  return { task: opts.task, connected: true, recipe: r, format: TASKS[opts.task].format };
}

// check --task <task> --tool <name>: screen one tool. check --tools-file <live list>: compare saved recipes.
function check(opts) {
  if (opts['tools-file']) return checkLive(opts['tools-file']);
  need(opts, 'task', 'tool');
  return screenTool(opts.task, opts.tool);
}

run({ 'test-allow': testAllow, missing, tasks, screen, validate, 'save-recipe': saveRecipe, forget, status, recipe, check });
