#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Setup helpers: disclaimer acknowledgement, settings, context profiles and the context check.
import { switchEvent, writeAnswers, EVENT_SETTINGS, EVENT_DEFAULTS, isMockEvent, mockTarget } from '../../../lib/scope.mjs';
import { existsSync, cpSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, need } from '../../../lib/args.mjs';
import { loadConfig, saveConfig, DEFAULTS } from '../../../lib/config.mjs';
import { contextDir, ensureDir, configPath, home } from '../../../lib/paths.mjs';
import { loadEvent, contextFor, saveEvent, nowFrom } from '../../../lib/event.mjs';
import { isValidZone } from '../../../lib/tz.mjs';
import { contextCheck, insightBudget } from './context-check.mjs';
import { readJson, writeJson, writeText, refuseLinks } from '../../../lib/jsonio.mjs';
import { scan, summarize } from './scan.mjs';
import { planQuestions, NODES, ROUNDS, CHOICES, choiceValue, defaultsFor } from './onboarding-tree.mjs';
import { onboardingPlan as planOnboarding, onboardingState } from './onboarding-state.mjs';
import { allowedPath } from '../../../lib/paths.mjs';
import { instructionsPath } from '../../event-outreach/scripts/drafter.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// The yes to the disclaimer. Read during the mock, it's the mock's only: the real start asks again.
function ack(opts = {}) {
  const mock = mockTarget(opts['for-event']);
  if (mock) {
    saveScoped({ disclaimer_ack: true }, { mock });
    return { disclaimer_ack: true, saved_for: `the mock event (${mock}) only: the real start asks again` };
  }
  saveConfig({ disclaimer_ack: true });
  return { disclaimer_ack: true, config: configPath() };
}

// A setting about one event (its goal, meetings wanted, must-meets) goes into that event's settings once there is
// an event; everything else is the user's setup, in the global config.
// The mock event (mock: its slug) keeps every setting in its own event.json: nothing set during the demo
// reaches the user's setup.
function saveScoped(patch, { mock = null } = {}) {
  if (mock) {
    const e = loadEvent(mock);
    saveEvent(mock, { ...e.event, settings: { ...(e.event.settings || {}), ...patch } });
    return { ...loadEvent(mock).settings, saved_for: `the mock event (${mock}) only` };
  }
  const ob = readJson(join(dirname(configPath()), 'onboarding.json'), {});
  const current = isMockEvent(ob.event) ? null : ob.event;
  const evPart = current ? Object.fromEntries(Object.entries(patch).filter(([k]) => EVENT_SETTINGS.has(k))) : {};
  if (Object.keys(evPart).length) {
    try {
      const e = loadEvent(current);
      saveEvent(current, { ...e.event, settings: { ...(e.event.settings || {}), ...evPart } });
    } catch {
      for (const k of Object.keys(evPart)) delete evPart[k];
    }
  }
  const rest = Object.fromEntries(Object.entries(patch).filter(([k]) => !(k in evPart)));
  return Object.keys(rest).length ? saveConfig(rest) : { ...loadConfig(), ...evPart };
}

function config(opts) {
  if (opts.set) {
    const patch = JSON.parse(opts.set);
    // Whether floorboss sends, and the address its test send goes to, are the user's answers: saved only by the
    // flow while it saves the answer to the question that asked (it marks that in the environment of the command
    // it runs), never by a config call of Claude's own.
    const savedBy = process.env.FLOORBOSS_SAVED_BY || '';
    // Who drafts is the user's answer too: the drafter decides which agent the guard lets a floorboss session start.
    const ANSWERED_ONLY = {
      sending: ['followups_mode'],
      own_email: ['send_setup'],
      own_phone: ['send_setup'],
      drafter: ['drafter', 'drafting_mode'],
      drafting_mode: ['drafting_mode', 'drafter'],
      // Opening the user's LinkedIn or event-app inbox is their answer too: the guard opens one only on it.
      inbox_read: ['inbox_read'],
      log_replies: ['inbox_read']
    };
    for (const [k, asks] of Object.entries(ANSWERED_ONLY))
      if (k in patch && !asks.includes(savedBy))
        throw new Error(
          `"${k}" is the user's answer to floorboss's question (${asks.join(' or ')}): it's saved only through that question (run flow next), never with config --set.`
        );
    for (const k of Object.keys(patch)) if (!Object.hasOwn(DEFAULTS, k)) throw new Error(`"${k}" isn't a floorboss setting.`);
    // Connections are saved only by discovery (save-recipe), which screens, probes and binds the tool.
    if ('connectors' in patch) throw new Error("Connections can't be set here; run discovery in /floorboss:event-setup.");
    if ('crm_accounts' in patch && ![null, 'apply', 'off'].includes(patch.crm_accounts)) throw new Error('crm_accounts is "apply" or "off".');
    if ('drafting_mode' in patch && ![null, 'floorboss', 'delegate', 'blend'].includes(patch.drafting_mode))
      throw new Error('drafting_mode is "floorboss", "delegate" or "blend".');
    if (patch.drafter != null) {
      const d = patch.drafter;
      if (typeof d !== 'object' || !d.invoke || !/^[A-Za-z0-9:_.-]{1,80}$/.test(String(d.invoke)))
        throw new Error('drafter needs "invoke": the skill or agent name, as Claude calls it.');
      if (d.type && !['skill', 'agent', 'instructions'].includes(d.type)) throw new Error('drafter.type is "skill", "agent" or "instructions".');
      for (const ch of d.covers?.channels || [])
        if (!['email', 'paste'].includes(ch)) throw new Error('drafter.covers.channels holds "email" and/or "paste" (event-app and LinkedIn notes).');
      for (const k of d.covers?.kinds || [])
        if (!['first', 'followup', 'confirmation'].includes(k)) throw new Error('drafter.covers.kinds holds "first", "followup" and/or "confirmation".');
      for (const g of d.gaps || [])
        if (!['voice', 'company_context', 'proof', 'research'].includes(g))
          throw new Error('drafter.gaps holds "voice", "company_context", "proof" and/or "research".');
    }
    if (patch.drafter?.type === 'agent') {
      const inv = readJson(join(dirname(configPath()), 'inventory.json'), null);
      const a = inv?.items?.find((x) => x.type === 'agent' && x.name === patch.drafter.invoke);
      const risk = a ? a.tools_risk : 'unknown (not in the scan)';
      if (!['none', 'reads'].includes(risk))
        throw new Error(
          `${patch.drafter.invoke} can't be the drafter as an agent: its tools are ${risk}${a?.tools ? ` (${a.tools})` : ''}, and a drafter must only write text. Use type "instructions" with its file as "path": floorboss's own writer (no tools) follows its instructions.`
        );
    }
    if (patch.drafter?.type === 'instructions' && !instructionsPath(patch.drafter.path))
      throw new Error(
        'A drafter of type "instructions" needs "path": the agent or skill file whose instructions floorboss\'s writer follows, a Markdown file in a .claude/agents or .claude/skills folder (a project\'s or ~/.claude\'s) or in a plugin under ~/.claude/plugins.'
      );
    if (
      'optout_sentences' in patch &&
      (typeof patch.optout_sentences !== 'object' ||
        Array.isArray(patch.optout_sentences) ||
        Object.values(patch.optout_sentences).some((v) => typeof v !== 'string' || v.length > 300))
    )
      throw new Error('optout_sentences is {"<language>": "<sentence>"}.');
    if ('sending' in patch) {
      const sd = patch.sending;
      if (!sd || typeof sd !== 'object' || Array.isArray(sd))
        throw new Error('sending is {"channels": [...], "followups": "scheduled"|"each_round", "linkedin_ack": true|false}.');
      for (const ch of sd.channels || [])
        if (!['email', 'chat', 'app', 'linkedin'].includes(ch)) throw new Error('sending.channels holds "email", "chat", "app" and/or "linkedin".');
      if (sd.followups != null && !['scheduled', 'each_round'].includes(sd.followups)) throw new Error('sending.followups is "scheduled" or "each_round".');
      if ((sd.channels || []).includes('linkedin') && sd.linkedin_ack !== true)
        throw new Error('Sending on LinkedIn needs the user to have read and accepted the LinkedIn warning (sending.linkedin_ack: true).');
      if ((sd.channels || []).length && !sd.followups)
        throw new Error('With sending on, say how follow-ups go: sending.followups "scheduled" or "each_round".');
      if (sd.unattended != null) throw new Error('There is no unattended sending: Claude Code asks before every message, so someone has to be there.');
    }
    if (patch.customer_rule != null) {
      const r = patch.customer_rule;
      const ok = (v) => ['warm', 'ask', 'hold', 'cold'].includes(v);
      if (
        typeof r !== 'object' ||
        !ok(r.recent) ||
        !ok(r.on_deal) ||
        !ok(r.other) ||
        !(Number.isInteger(Number(r.recent_months)) && Number(r.recent_months) >= 0)
      )
        throw new Error('customer_rule is {"recent_months": <n>, "recent": …, "on_deal": …, "other": …}, each of warm, ask, hold or cold.');
    }
    if ('rejected_months' in patch && !(Number.isInteger(Number(patch.rejected_months)) && Number(patch.rejected_months) >= 0))
      throw new Error('rejected_months is a whole number of months (0 for no wait).');
    if (
      'app_request_limit' in patch &&
      patch.app_request_limit !== null &&
      !(Number.isInteger(Number(patch.app_request_limit)) && Number(patch.app_request_limit) >= 0)
    )
      throw new Error('app_request_limit is a whole number (0 or more), or null for no limit.');
    if ('app_note_times' in patch && !['in_text', 'in_app'].includes(patch.app_note_times)) throw new Error('app_note_times is "in_text" or "in_app".');
    if ('optout_known' in patch && patch.optout_known !== null && typeof patch.optout_known !== 'boolean')
      throw new Error('optout_known is true, false or null.');
    for (const k of ['app_note_event_name', 'app_note_optout']) if (k in patch && typeof patch[k] !== 'boolean') throw new Error(`${k} is true or false.`);
    if (patch.home_tz && !isValidZone(patch.home_tz)) throw new Error(`"${patch.home_tz}" isn't an IANA time zone.`);
    for (const k of ['own_domains', 'shared_domains', 'channels', 'colleagues', 'known_contacts_paths', 'languages']) {
      if (k in patch && !Array.isArray(patch[k]))
        patch[k] = String(patch[k])
          .split(/[\s,]+/)
          .filter(Boolean);
    }
    // A contacts file is a list: read only from where lists are read, as `crm-triage inputs --known` takes it.
    if (Array.isArray(patch.known_contacts_paths)) patch.known_contacts_paths = patch.known_contacts_paths.map((x) => allowedPath(String(x), { list: true }));
    for (const k of ['touches', 'max_offers', 'per_slot', 'meeting_minutes', 'warm_months', 'paste_limit']) {
      if (k in patch && !(Number.isFinite(+patch[k]) && +patch[k] > 0)) throw new Error(`${k} must be a positive number.`);
    }
    if ('company_caps' in patch && patch.company_caps !== null) {
      const cc = patch.company_caps;
      const okMode = (m) => ['scale', 'one', 'teams', 'off'].includes(m);
      const okScale = (sc) =>
        sc &&
        typeof sc === 'object' &&
        Object.entries(sc).every(
          ([k, v]) => ['micro', 'small', 'mid', 'large', 'enterprise', 'unknown'].includes(k) && Number.isInteger(Number(v)) && Number(v) >= 1
        );
      if (
        !(typeof cc === 'string'
          ? okMode(cc)
          : cc && typeof cc === 'object' && (cc.mode || cc.scale) && (cc.mode ? okMode(cc.mode) : true) && (cc.scale ? okScale(cc.scale) : true))
      )
        throw new Error(
          'company_caps is {"mode":"scale"|"one"|"teams"|"off"} or {"scale":{"micro":1,"small":1,"mid":2,"large":3,"enterprise":5,"unknown":2}}.'
        );
    }
    if ('account_cap' in patch && patch.account_cap !== null && !(Number.isFinite(+patch.account_cap) && +patch.account_cap > 0))
      throw new Error('account_cap is a positive number, or null for no cap.');
    // While the mock is the event being run (or --for-event names it), its own settings are written.
    return saveScoped(patch, { mock: mockTarget(opts['for-event']) });
  }
  // --get <key>: one setting's value on its own (prints true, false, a number or JSON), so no other tool
  // is needed to read it.
  if (opts.get !== undefined) {
    const cfg = loadConfig();
    if (opts.get === true || !Object.hasOwn(cfg, opts.get)) throw new Error(`"${opts.get === true ? '' : opts.get}" isn't a floorboss setting.`);
    return cfg[opts.get] ?? null;
  }
  return loadConfig();
}

function initProfile(opts) {
  need(opts, 'profile');
  const dir = contextDir(opts.profile);
  ensureDir(dir);
  const made = [];
  for (const name of ['who-to-meet', 'what-you-bring', 'voice']) {
    const target = join(dir, name, 'SKILL.md');
    if (existsSync(target)) continue;
    ensureDir(join(dir, name));
    writeText(target, readFileSync(join(here, '..', 'templates', `${name}.md`), 'utf8'));
    made.push(target);
  }
  return { dir, created: made, next: 'Fill each SKILL.md from the user\'s resources, show it to them, then run "check".' };
}

function check(opts) {
  let ctx,
    batch = null;
  if (opts.event) {
    const { event, settings, paths } = loadEvent(opts.event);
    ctx = contextFor(settings, event);
    // Once there's an approved shortlist, say whether the insights stretch across it.
    const short = readJson(paths.shortlist, null);
    const triage = readJson(paths.triage, null);
    if (short && triage) batch = short.approved.map((id) => ({ id, segment: triage.final?.[id]?.segment }));
  } else {
    need(opts, 'profile');
    const dir = contextDir(opts.profile);
    const read = (n) => (existsSync(join(dir, n, 'SKILL.md')) ? readFileSync(join(dir, n, 'SKILL.md'), 'utf8') : null);
    ctx = { dir, whoToMeet: read('who-to-meet'), whatYouBring: read('what-you-bring'), voice: read('voice') };
  }
  const missing = ['whoToMeet', 'whatYouBring', 'voice'].filter((k) => !ctx[k]);
  const r = contextCheck(ctx);
  if (batch?.length) {
    const b = insightBudget(r.insights, batch, Object.fromEntries(r.segments.map((x) => [x.slug, x.name])));
    r.notes.push(...b.notes);
  }
  return { dir: ctx.dir, missing, ...r };
}

// Onboarding progress (/floorboss:start): the tree's rounds, each marked done when the user has answered it,
// so a stopped interview picks up at the next round.
function onboarding(opts) {
  const path = join(dirname(configPath()), 'onboarding.json');
  const state = readJson(path, { rounds: {}, event: null });
  // --restart: the setup is asked again from the disclaimer: the answers, the setup level, the scan of the
  // user's tools and the settings the questions set. The connected tools floorboss was given and the profile
  // files (who to meet, what you bring, voice) stay; the settings before are kept in config.before-restart.json.
  if (opts.reset) {
    const dir = dirname(configPath());
    const cfg = readJson(configPath(), {});
    // A second restart never writes over the first backup (by then config.json holds only what the first
    // kept): the settings go to the first free config.before-restart[.<n>].json.
    const free = (base) => {
      let n = 1,
        name = `${base}.before-restart.json`;
      while (existsSync(join(dir, name))) name = `${base}.before-restart.${++n}.json`;
      return name;
    };
    const saved = Object.keys(cfg).length ? free('config') : null;
    if (saved) writeJson(join(dir, saved), cfg);
    writeJson(configPath(), Object.fromEntries(['connectors', 'context_profile'].filter((k) => cfg[k] !== undefined).map((k) => [k, cfg[k]])));
    if (existsSync(join(dir, 'inventory.json'))) {
      const to = join(dir, free('inventory'));
      refuseLinks(join(dir, 'inventory.json'));
      refuseLinks(to);
      renameSync(join(dir, 'inventory.json'), to);
    }
    const at = new Date().toISOString();
    writeJson(path, { rounds: {}, event: null, answers: {}, started_at: at, restarted_at: at });
    return {
      reset: true,
      kept: `Starting over from the disclaimer: every setup question is asked again. Your profile files${cfg.context_profile ? ` (${cfg.context_profile}: who to meet, what you bring, voice)` : ''} and connected tools are kept; ${saved ? `your earlier settings are saved in ${saved}.` : 'there were no earlier settings to save.'}`,
      next: onboardingPlan().round
    };
  }
  // The mock event is never made the current event (its answers live in its own overlay, written below), and a
  // pointer to it left by an older version is cleared, so a real run never picks the mock up.
  // The event named (--for-event, --event; --new-event is a real one) decides; only a call that names none
  // follows the run's session.
  const named = opts['for-event'] || (typeof opts.event === 'string' ? opts.event : null) || (opts['new-event'] ? 'new-event' : null);
  const mock = mockTarget(named);
  if (isMockEvent(state.event)) {
    state.event = null;
    writeJson(path, state);
  }
  if (mock && typeof opts.event === 'string' && opts.event === mock) opts = { ...opts, event: undefined };
  // Another event (or --new-event): what belonged to the one before moves to it, so nothing about its goal or
  // list carries into the next. The user's setup stays.
  const toEvent = opts['new-event'] ? null : opts.event && typeof opts.event === 'string' ? opts.event : undefined;
  if (toEvent !== undefined && toEvent !== state.event) {
    const moved = switchEvent(state, toEvent, {
      config: readJson(configPath(), {}),
      saveEventSettings: (slug, settings) => {
        try {
          const e = loadEvent(slug);
          saveEvent(slug, {
            ...e.event,
            settings: { ...(e.event.settings || {}), ...Object.fromEntries(Object.entries(settings).filter(([k]) => e.event.settings?.[k] == null)) }
          });
        } catch {
          /* the event is gone */
        }
      },
      globalConfigWithout: (keys) => {
        const g = readJson(configPath(), {});
        for (const k of keys) delete g[k];
        writeJson(configPath(), g);
      }
    });
    Object.assign(state, moved);
  }
  // --forget a,b: setup answers asked again (the user said that part of their setup changed).
  // Answers are saved (or cleared) only by the flow, while it saves the answer to the question it asked
  // (FLOORBOSS_SAVED_BY on the command it runs); floorboss's own unit tests may write them directly.
  if (
    (opts.forget || opts['answer-file']) &&
    !process.env.FLOORBOSS_SAVED_BY &&
    !(process.env.FLOORBOSS_TEST === '1' && process.env.FLOORBOSS_OUT_OF_TURN === '1')
  )
    throw new Error('Onboarding answers are saved by the flow: run flow next and answer the question it asks (flow answer --ask <id>).');
  if (opts.forget) {
    for (const k of String(opts.forget).split(',')) {
      delete (mock ? state.events?.[mock]?.answers : state.answers)?.[k.trim()];
    }
    writeJson(path, state);
  }
  // Branch answers (works alone, where contacts live, list source…): what the decision tree reads next.
  if (opts['answer-file']) {
    const a = readJson(allowedPath(opts['answer-file']));
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('The answer file is {"<question id>": <answer>, …}.');
    // A question id written as the key works too ({"browser": "now"} for browser_choice).
    const ALIAS = {
      browser: 'browser_choice',
      crm_use: 'crm_choice',
      crm_where: 'crm_choice',
      mailbox_use: 'mailbox_choice',
      calendar_use: 'calendar_choice',
      team: 'works_alone',
      inventory: 'inventory_confirmed',
      samples: 'samples_ok',
      true_claims: 'claims_confirmed',
      drafter_sample: 'drafter_sample_ok'
    };
    // Every other question id maps to the first answer its node saves; a question whose answer is a setting
    // (goal, home_tz, customers…) can't go here, and the error says what to run instead.
    const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
    // Every answer id a question's "saves" names (the part after "answers:", up to the next ";"), so an id the
    // plan tells Claude to save is never refused.
    // crm_lookup_skipped / mail_history_skipped: the user went on without a connected tool that stopped answering.
    // *_connect_failed: connecting a tool the user chose failed, and they picked a fallback (their words).
    const answerKeys = new Set([
      'crm_label',
      'event_hint',
      'crm_lookup_skipped',
      'mail_history_skipped',
      'crm_connect_failed',
      'mail_connect_failed',
      'calendar_connect_failed',
      // crm_activity: "none" when the user said their CRM doesn't log their email (replies are then asked about).
      'crm_activity',
      'crm_activity_failed',
      'optout_default_set',
      'inbox_read_asked',
      ...Object.values(ALIAS),
      ...NODES.flatMap((n) =>
        [
          ...String(n.saves || '')
            .replace(/\([^()]*\)/g, '')
            .matchAll(/answers?: ([^;]*)/g)
        ].flatMap((m) => m[1].match(/\b[a-z]+_[a-z_]+\b/g) || [])
      )
    ]);
    const keyFor = (k) => {
      if (ALIAS[k]) return ALIAS[k];
      if (answerKeys.has(k)) return k;
      const n = byId[k];
      if (!n) throw new Error(`"${k}" isn't an answer id or a question id. Answer ids: ${[...answerKeys].sort().join(', ')}.`);
      const m = /answers?: ([a-z_]+)/.exec(String(n.saves || ''));
      if (m) return m[1];
      throw new Error(`The answer to "${k}" is a setting, not an answer: ${n.saves}. Save it with config --set-file, not the answer file.`);
    };
    const clean = (v) =>
      typeof v === 'string' ? v.slice(0, 300) : typeof v === 'boolean' || typeof v === 'number' || v === null ? v : JSON.stringify(v).slice(0, 300);
    // A choice answered with the option's text ("yes, use it (connector)") is read down to its value, so the
    // tree's conditions see "connector", never a sentence that matches nothing and silently skips questions.
    const value = (k, v) => {
      const out = choiceValue(k, v);
      if (CHOICES[k] && typeof out === 'string' && !CHOICES[k].includes(out))
        throw new Error(`"${v}" isn't an answer to ${k}: one of ${CHOICES[k].join(', ')}.`);
      return out;
    };
    const add = Object.fromEntries(
      Object.entries(a)
        .filter(([k]) => /^[a-z_]{2,40}$/.test(k) && !['__proto__', 'constructor', 'prototype'].includes(k))
        .map(([k, v]) => {
          const key = keyFor(k);
          return [key, clean(value(key, v))];
        })
    );
    // A file the user gave is read from where lists are read (the data folder, the temp folder, the working
    // folder), checked before anything is saved: an answer file can't point triage at any file on the disk.
    const listPaths = {};
    for (const k of ['crm_path', 'accounts_path', 'dnc_path']) if (add[k]) listPaths[k] = allowedPath(String(add[k]), { list: true });
    Object.assign(state, writeAnswers(state, add, { mock }));
    // Files the user gave (CRM export, off-limits accounts, do-not-contact list) are saved on the event, so
    // triage uses them without asking again.
    const target = mock || state.event;
    if (target && (add.crm_path || add.accounts_path || add.dnc_path)) {
      const e = loadEvent(target);
      const ev = { ...e.event };
      for (const [k, field] of [
        ['crm_path', 'crm'],
        ['accounts_path', 'accounts_path'],
        ['dnc_path', 'dnc_path']
      ]) {
        if (!add[k]) continue;
        const p = listPaths[k];
        if (!existsSync(p)) throw new Error(`${add[k]} doesn't exist.`);
        if (field === 'crm') ev.crm = { ...(ev.crm || {}), path: p };
        else ev[field] = p;
      }
      saveEvent(target, ev);
    }
  }
  if (opts.done) {
    if (!ROUNDS.includes(opts.done)) throw new Error(`Rounds are ${ROUNDS.join(', ')}.`);
    state.rounds[opts.done] = { done_at: new Date().toISOString() };
  }
  if (opts.event || opts['new-event'] || opts.done || opts['answer-file']) writeJson(path, state);
  if (mock) return { event: mock, mock: true, saved_for: `the mock event (${mock}) only: your own setup is unchanged`, then: 'run flow next again' };
  // Progress comes from the decision tree: the round with questions still open.
  const plan = onboardingPlan();
  return {
    event: state.event,
    next: plan.round,
    finished: plan.done,
    open_now: plan.questions.map((q) => q.id),
    then: plan.done ? 'run flow next again: the list comes next' : undefined
  };
}

// scan [--session-file <file>]: everything the user's Claude setup already has, before onboarding asks
// anything. The session file lists what Claude sees in its own tool list that no config file shows
// ({"mcp":["claude_ai_Gmail",…],"skills":[{"name","description"}],"agents":[…]}). Saved as inventory.json.
function scanCmd(opts) {
  // Another folder to scan is for tests only: an agent file Claude wrote elsewhere is never the user's setup.
  if (opts.cwd && process.env.FLOORBOSS_TEST !== '1') throw new Error('scan reads your Claude setup where Claude runs: --cwd is for tests only.');
  const base = scan({ cwd: (process.env.FLOORBOSS_TEST === '1' && opts.cwd) || process.env.FLOORBOSS_SCAN_CWD || process.cwd() });
  const session = opts['session-file'] ? readJson(allowedPath(opts['session-file'])) : null;
  const inv = summarize(base.items, session);
  // The connectors seen at the first scan (before any list or web page is read) are the ones floorboss counts as
  // found. A later scan can't add to them: a server named in a session file then could be anything a page asked
  // for. New ones are listed, not trusted (saving a connector for them works as before).
  const invPath = join(dirname(configPath()), 'inventory.json');
  const prev = readJson(invPath, null);
  const mcpOf = (list) => [...new Set(list.filter((x) => String(x).startsWith('mcp:')).map((x) => String(x).slice(4)))];
  const seenNow = [...new Set([...mcpOf(Object.values(inv.found || {}).flat()), ...inv.items.filter((x) => x.type === 'mcp').map((x) => x.name)])];
  // A restart moves inventory.json aside but keeps the first scan's set: the last backup's, so a restart made
  // mid-run can't let a session file decide it again. An inventory from before setup_servers existed counts what
  // it had found.
  const backups = readdirSync(dirname(invPath))
    .filter((f) => /^inventory\.before-restart(\.\d+)?\.json$/.test(f))
    .sort((a, b) => (Number(/\.(\d+)\.json$/.exec(a)?.[1]) || 1) - (Number(/\.(\d+)\.json$/.exec(b)?.[1]) || 1));
  const earlier = prev || (backups.length ? readJson(join(dirname(invPath), backups[backups.length - 1]), null) : null);
  const baseline = (v) =>
    Array.isArray(v?.setup_servers)
      ? v.setup_servers
      : [...new Set([...mcpOf(Object.values(v?.found || {}).flat()), ...(v?.items || []).filter((x) => x?.type === 'mcp').map((x) => x.name)])];
  const setupServers = earlier ? baseline(earlier) : seenNow;
  const unconfirmed = seenNow.filter((n) => !setupServers.includes(n));
  // What each of them was found to be is kept from the first scan the same way: "found" below comes from this scan's
  // session file, which the model writes, so a rescan mid-run could call any server a CRM.
  const mcpKinds = (f) => Object.fromEntries(Object.entries(f || {}).map(([k, l]) => [k, (Array.isArray(l) ? l : []).filter((x) => String(x).startsWith('mcp:'))]));
  const setupFound = earlier ? (earlier.setup_found ?? mcpKinds(earlier.found)) : mcpKinds(inv.found);
  // Setup still offers whatever the scan found (a CRM connected after a restart included): only the guard's "may a
  // run read this server" answer is held to setup_servers.
  const found = inv.found || {};
  const keep = {
    ...inv,
    items: inv.items.map(({ type, name, source, kinds, description, path, tools, tools_risk }) => ({
      type,
      name,
      source,
      kinds,
      description: description ? String(description).slice(0, 160) : undefined,
      path: path || undefined,
      ...(type === 'agent' ? { tools: tools ?? null, tools_risk } : {})
    })),
    found,
    setup_servers: setupServers,
    setup_found: setupFound,
    ...(unconfirmed.length ? { found_since_setup: unconfirmed } : {}),
    scanned_at: new Date().toISOString()
  };
  writeJson(invPath, keep);
  return {
    outbound: inv.outbound,
    writers: inv.writers,
    found,
    counts: inv.counts,
    ...(unconfirmed.length
      ? {
          found_since_setup: unconfirmed,
          note: `${unconfirmed.join(', ')} ${unconfirmed.length === 1 ? 'is' : 'are'} new since your first setup scan: setup can still use ${unconfirmed.length === 1 ? 'it' : 'them'} (connecting ${unconfirmed.length === 1 ? 'it' : 'them'} for a task works as before), but during a run floorboss only reads ${unconfirmed.length === 1 ? 'it' : 'them'} through a connected task.`
        }
      : {}),
    file: join(dirname(configPath()), 'inventory.json'),
    next: 'Show this to the user grouped by what floorboss uses, then run flow next again.'
  };
}

// onboarding-plan: the next questions that apply, from the scan, the settings, the event and earlier answers.
function onboardingPlan() {
  return planOnboarding();
}

// onboarding-defaults: save what is never asked (defaultsFor), and start the profile once there's a goal: the
// only profile there is, else one named after the company. Run by the flow without a question.
function onboardingDefaults() {
  const s = onboardingState();
  const d = defaultsFor(s) || { config: {}, answers: {} };
  const cfg = { ...d.config };
  if (s.cfg.goal && !s.cfg.context_profile) {
    const root = join(home(), 'context');
    // The user's own profiles only: a mock profile (older versions kept the mock's here) is never taken as theirs.
    const have = existsSync(root) ? readdirSync(root).filter((x) => !/^mock-/.test(x) && existsSync(join(root, x, 'who-to-meet'))) : [];
    const name =
      have.length === 1
        ? have[0]
        : String(s.cfg.own_company || s.cfg.crm_user_name || 'me')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 40) || 'me';
    initProfile({ profile: name });
    cfg.context_profile = name;
  }
  // Defaults that follow from this event's goal go on the event; the rest is setup.
  const evDefaults = s.ev ? Object.fromEntries(Object.entries(cfg).filter(([k]) => EVENT_DEFAULTS.has(k))) : {};
  if (Object.keys(evDefaults).length) {
    const e = loadEvent(s.ev.slug);
    saveEvent(s.ev.slug, { ...e.event, settings: { ...(e.event.settings || {}), ...evDefaults } });
    for (const k of Object.keys(evDefaults)) delete cfg[k];
  }
  if (Object.keys(cfg).length) saveScoped(cfg);
  if (Object.keys(d.answers).length) {
    const path = join(dirname(configPath()), 'onboarding.json');
    const st = readJson(path, { rounds: {}, event: null, answers: {} });
    st.answers = { ...(st.answers || {}), ...d.answers };
    writeJson(path, st);
  }
  return { saved: { ...cfg, ...d.answers } };
}

run({
  ack,
  config,
  onboarding,
  'onboarding-plan': onboardingPlan,
  'onboarding-defaults': onboardingDefaults,
  scan: scanCmd,
  'init-profile': initProfile,
  check
});
