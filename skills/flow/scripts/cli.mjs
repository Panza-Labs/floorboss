#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The flow: `next` says the one thing to do now; `answer` saves what the user said where it belongs.
// Claude never chooses where an answer is saved: each question id has one saver here.
import { withLock } from '../../../lib/lock.mjs';
import { lookupCount } from '../../../lib/normalize.mjs';
import { readLedger, fold } from '../../../lib/ledger.mjs';
import { parseScale, SCALES } from '../../crm-triage/scripts/sizes.mjs';
import { existsSync, writeFileSync, mkdirSync, readFileSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, need } from '../../../lib/args.mjs';
import { allowedPath, contextDir, expandHome } from '../../../lib/paths.mjs';
import { parseSegments } from '../../event-context/scripts/context-check.mjs';
import { readJson, writeJson, writeText, appendLine } from '../../../lib/jsonio.mjs';
import { context, nextStep, ROOT, followupsModeOf, script } from './steps.mjs';
import { NODES, levelOptions } from '../../event-context/scripts/onboarding-tree.mjs';
import { append } from '../../../lib/ledger.mjs';
import { readUrl, listFileProblem } from '../../../lib/security.mjs';
import { sessionEvent, touchSession, listEvents, isMockEvent, sessionRun } from '../../../lib/scope.mjs';
import { configPath } from '../../../lib/paths.mjs';
import { nowFrom } from '../../../lib/event.mjs';
import { dirname } from 'node:path';
import { zoneFrom } from '../../../lib/tz.mjs';
import { parseDncReport } from '../../crm-triage/scripts/dnc.mjs';
import { listSources } from '../../crm-triage/scripts/sources.mjs';
import { saysNoOptOut } from '../../crm-triage/scripts/mapping-words.mjs';
import { ownerMatch } from '../../../lib/names.mjs';
import { openingOf, OPENINGS } from '../../event-outreach/scripts/structures.mjs';
import { asRule } from '../../event-outreach/scripts/sameness.mjs';
import { DEFAULTS, OPTOUT_BUILT_IN } from '../../../lib/config.mjs';
const DEFAULT_OPTOUT = DEFAULTS.optout_sentence;
import {
  segmentsMd,
  bringMd,
  setAbout,
  addInsights,
  addNeverSay,
  stillTemplate,
  setVoiceField,
  clearVoicePlaceholders,
  voiceFromEmails,
  splitEmails,
  lengthRule
} from './profile-write.mjs';

// A yes to opening a browser window (to log in the CRM, or send in the event app): 'yes' when the answer says yes and
// nothing in it defers or refuses ("send them later", "yes but not now" are a not-now), 'no' for a refusal or a
// deferral, and null for anything else, which is asked again rather than guessed.
const WINDOW_NO = /\b(no|not|nope|nah|later|tomorrow|tonight|skip|don'?t|do not|wait|stop|after|hold|never|cancel)\b/i;
const WINDOW_YES = /\b(y|yes|yeah|yep|yup|ok|okay|sure|go|go ahead|do it|log|send|ready|absolutely|please|now|done|logged in)\b/i;
const windowAnswer = (said) => {
  const t = String(said).replace(/[\u2018\u2019\u02bc]/g, "'");
  return WINDOW_NO.test(t) || /\b\w+n'?t\b/i.test(t) ? 'no' : WINDOW_YES.test(t) ? 'yes' : null;
};
const windowYes = (said) => {
  const a = windowAnswer(said);
  if (a === null) throw new Error(`"${String(said).slice(0, 60)}" isn't a yes or a not-now: ask again (open it now, or not now).`);
  return a === 'yes';
};

// The answer being saved right now, so a setting only an answer may set (sending, own_email) can say which
// question it answers (FLOORBOSS_SAVED_BY on the command run for it).
let savingAsk = '';
function cli(skill, args, c) {
  const r = spawnSync(process.execPath, [script(skill), ...args], {
    encoding: 'utf8',
    env: { ...process.env, FLOORBOSS_NOW: c.now.toISOString(), FLOORBOSS_SAVED_BY: savingAsk }
  });
  // The command's own "floorboss: " is dropped: this answer's error gets one of its own.
  if (r.status !== 0)
    throw new Error(
      `${skill} ${args[0]}: ${String(r.stderr || r.stdout)
        .trim()
        .replace(/^floorboss:\s*/, '')
        .slice(0, 1200)}`
    );
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { raw: r.stdout };
  }
}

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

function next(opts) {
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
    if (!sess && evs.length && readJson(join(dirname(configPath()), 'config.json'), {}).disclaimer_ack) {
      const live = evs.filter((x) => !x.over);
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
  const out = finishNext(opts, ran);
  // The run's event, kept for the next step: the one this step was about (an error keeps the one chosen).
  touchSession(out?.event ?? opts.event ?? null, nowMs);
  return out;
}
// Whatever a command is about becomes the current event first, so every answer and setting it saves lands on
// that event (saving went to the last event set up while reading came from the one asked about).
function makeCurrent(slug) {
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
      tell_user: `floorboss got stuck on its "${s.step}" step (${s.why ? s.why.replace(/[.\s]+$/, '') : 'an automatic step'}): it ran it and was asked for it again${count > 1 ? `, ${count} times now` : ''}. Run it once by hand: ${cmd}. Then start again with /floorboss:start (a new run tries the step afresh).`,
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

const text = (v) => (typeof v === 'string' ? v.trim() : v);
// An example zone near the user: the event's own zone (or its region's), never one on another continent.
const zoneExample = (c) => c.event?.event?.time_zone || 'Europe/Amsterdam or America/Chicago';
// A gate answer is the user's words. A JSON file that landed here instead (another question's answer file) is
// said for what it is, never read as the word "undefined".
const gateWords = (v, what) => {
  if (typeof v !== 'object' || v == null) return String(v ?? '');
  if (typeof v.answers === 'string') return v.answers;
  if (typeof v.said === 'string') return v.said;
  const kind =
    Array.isArray(v.days) || 'free' in v
      ? 'a free-time file'
      : Array.isArray(v.segments)
        ? 'a segments file'
        : Array.isArray(v.items)
          ? 'an outcomes file'
          : 'a JSON file';
  throw new Error(
    `That looks like ${kind}, not ${what === 'shortlist' ? 'a shortlist' : what === 'approval' ? 'an approval' : 'an'} answer: pass the user's own words ("ok", or the changes they asked for).`
  );
};
// A file named inside a sentence ("I exported it to ~/Downloads/export.csv."), as a full path, when it exists.
// bare: a plain file name ("export.csv") counts too, read from where the command runs.
const namedFile = (t, { bare = false } = {}) => {
  const found = String(t || '').match(bare ? /(?:~\/|\/)[^\s"'`,;]+|[\w.-]+\.(?:csv|xlsx?|tsv)\b/gi : /(?:~\/|\/)[^\s"'`,;]+/g) || [];
  const hit = found.map((x) => x.replace(/[.)]+$/, '')).find((x) => existsSync(expandHome(x)));
  return hit ? expandHome(hit) : null;
};
// The people-research part of a research answer: "people: top 5", "and the people, none", "skip the people",
// "skip all research" (neither). Null when it says nothing about the people.
const peopleScaleOf = (t) => {
  if (/\b(?:skip|no)\s+(?:all\s+(?:the\s+)?)?research\b|\bskip\s+(?:it\s+)?all\b|\bno research at all\b|\bskip everything\b/i.test(t)) return 'none';
  const m = /\b(?:people|persons?|attendees)\b\W*(?:research\W*)?(all|top|none|no|skip)\b/i.exec(t) || /\b(skip|no)\s+(?:the\s+)?people\b/i.exec(t);
  if (!m) return null;
  const w = m[1].toLowerCase();
  return w === 'all' ? 'all' : w === 'top' ? 'top' : 'none';
};
const isNo = (v) => typeof v === 'string' && /^(none|no|skip|nothing|n\/a|-)$/i.test(v.trim());
// A path the user typed, with "~/" read as their home folder.
const pathOf = (v) => expandHome(typeof v === 'string' ? v : v?.path || v?.file);

// What quick setup takes as given instead of asking, said back to the user when they choose it.
const QUICK_ASSUMES =
  'Quick setup assumes you work alone (no coworkers\' contacts to hold back), with no CRM and no mailbox or contacts check (nobody is held as already known), and no writing samples (the tone comes from your sign-off and offer). It asks before any web research. Say "standard setup" any time to change it.';

// Savers by question id. Each takes (value, c) and does what the question's answer means.
const SAVERS = {
  // The event this run is for: an existing one (its name or slug), or a new one (its own answers start empty;
  // the user's setup carries over).
  which_event: (v, c) => {
    const t = String(typeof v === 'object' && v ? v.slug || v.name || '' : v).trim();
    const evs = listEvents(c.now.getTime());
    const exact = evs.find((x) => x.slug === t.toLowerCase() || String(x.name).toLowerCase() === t.toLowerCase());
    const near = exact ? [] : evs.filter((x) => t.length >= 3 && String(x.name).toLowerCase().includes(t.toLowerCase()));
    if (!exact && near.length > 1) throw new Error(`"${t}" could be ${near.map((x) => `${x.name} (${x.start})`).join(' or ')}: ask which.`);
    const pick = exact || near[0];
    if (!pick && !/new/i.test(t))
      throw new Error(`"${t}" isn't one of the events here (${evs.map((x) => x.name).join(', ')}): say its name, or "a new event".`);
    const r = pick ? cli('event-context', ['onboarding', '--event', pick.slug], c) : cli('event-context', ['onboarding', '--new-event'], c);
    touchSession(pick ? pick.slug : null, c.now.getTime());
    // "a new one, ColdChain Summit in Rotterdam": the event's name is in the answer, so it isn't asked again.
    const hint = pick ? null : (/\bnew(?: one| event)?\b[\s,:;-]*(?:it'?s |called )?(.{3,})$/i.exec(t)?.[1] || '').replace(/[.!]+$/, '').trim();
    if (!pick) answers(c, { event_hint: hint && !/^(event|one)$/i.test(hint) ? hint.slice(0, 120) : null });
    // After --restart nothing carries over but the profile files: the setup questions come again.
    const restarted = !!readJson(join(c.home, 'onboarding.json'), {}).restarted_at;
    return {
      event: pick ? pick.slug : null,
      ...(pick
        ? restarted
          ? { note: 'You restarted: the setup questions come again for this event (your profile files are kept).' }
          : {}
        : {
            note: restarted
              ? 'A new event: its questions come next, and the setup questions too, since you restarted (your profile files are kept).'
              : 'A new event: its questions come next; your setup (tools, team, voice) carries over.'
          }),
      onboarding: r.next
    };
  },
  disclaimer: (v, c) => cli('event-context', ['ack', ...forMock(c)], c),
  inventory: (v, c) =>
    answers(c, {
      inventory_confirmed: true,
      extra_tools: typeof v === 'object' ? v.extra_tools || null : /^(yes|ok|confirmed|right|correct)/i.test(String(v)) ? null : String(v).slice(0, 300)
    }),
  event: (v, c) => {
    const o = typeof v === 'object' ? v : null;
    if (!o?.name || !o.start || !o.end || !o.zone) throw new Error('The event answer is {"name","city","start","end","zone"}.');
    const r = cli(
      'slot-finder',
      [
        'create',
        '--name',
        o.name,
        '--city',
        o.city || '',
        '--start',
        o.start,
        '--end',
        o.end,
        '--zone',
        o.zone,
        ...(o.short_name ? ['--short-name', o.short_name] : [])
      ],
      c
    );
    // The do-not-contact list and the off-limits companies of the event before carry into this one: who must
    // never be contacted doesn't change with the event.
    // Every earlier event counts (not only the latest), and a list given as a path on the event counts too.
    const others = listEvents(c.now.getTime())
      .filter((x) => x.slug !== r.slug)
      .map((x) => x.slug);
    cli('event-context', ['onboarding', '--event', r.slug], c);
    const carried = {},
      failed = [];
    // A path an older event names is read only from where lists are read; one outside them is asked for again.
    const fileOf = (slug, name, field) => {
      const a = join(c.home, 'events', slug, 'inputs', name);
      if (existsSync(a)) return a;
      const ev = readJson(join(c.home, 'events', slug, 'event.json'), {});
      if (!ev[field] || !existsSync(ev[field])) return null;
      try {
        return allowedPath(ev[field], { list: true });
      } catch (err) {
        failed.push(`${name === 'dnc.txt' ? 'do-not-contact list' : 'off-limits companies'}: ${err.message.slice(0, 120)}`);
        return null;
      }
    };
    // Each list is read with its own columns, then written as one plain list (a header from one file read the
    // rows of another, and entries were lost).
    const entries = others
      .map((x) => fileOf(x, 'dnc.txt', 'dnc_path'))
      .filter(Boolean)
      .flatMap((f) => parseDncReport(readFileSync(f, 'utf8')).entries);
    const rowOf = (en) =>
      `${en.type === 'domain' ? `@${en.value}` : en.type === 'company' ? `company: ${en.label || en.value}` : en.type === 'name' ? en.label || en.value : en.value},${en.until || ''}`;
    const dncRows = [...new Set(entries.map(rowOf))];
    if (dncRows.length) {
      try {
        cli(
          'crm-triage',
          ['inputs', '--event', r.slug, '--kind', 'dnc', '--file', writeWorkText(c, 'dnc-carried.csv', `Value,Until\n${dncRows.join('\n')}\n`)],
          { ...c, slug: r.slug }
        );
        carried.do_not_contact = dncRows.length;
      } catch (err) {
        failed.push(`do-not-contact list: ${err.message.slice(0, 120)}`);
      }
    }
    const acc = others.map((x) => fileOf(x, 'accounts.csv', 'accounts_path')).find(Boolean);
    if (acc) {
      try {
        cli('crm-triage', ['inputs', '--event', r.slug, '--kind', 'accounts', '--file', acc], { ...c, slug: r.slug });
        carried.off_limits_companies = acc;
      } catch (err) {
        failed.push(`off-limits companies: ${err.message.slice(0, 120)}`);
      }
    }
    // A list that couldn't be carried over is asked for again, never assumed.
    if (failed.length) answers({ ...c, slug: r.slug }, { dnc_asked: false, accounts_asked: false });
    r.carried_over = {
      ...carried,
      ...(failed.length ? { not_carried: failed, note: 'Tell the user: these lists could not be carried over, so they are asked for again.' } : {})
    };
    // The event's own app, from its site, in the same answer (null: the site shows none).
    if (o.app !== undefined) cli('slot-finder', ['app', '--event', r.slug, '--name', o.app ? String(o.app) : 'none'], { ...c, slug: r.slug });
    return r;
  },
  // "yes": the setup stands for this event. Anything they say changed is asked again (its answers cleared).
  reuse_setup: (v, c) => {
    const t = String(typeof v === 'object' && v ? v.said || v.answer || '' : v).toLowerCase();
    // "yes" (and nothing about a change after it) keeps everything; otherwise only what they name is asked again.
    const rest = t.replace(/^\s*(yes|yeah|same|ok|right|correct|y)\b[,.!]?\s*(same setup|all the same)?[,.!]?\s*/, '');
    if (
      (/^\s*(yes|yeah|yep|yup|same|ok|right|correct|y)\b/.test(t) && (!rest.trim() || /^(do not|don'?t) change|nothing chang|no change/.test(rest))) ||
      /^\s*(nothing( has)? changed|no changes?|same as (before|last time)|(do not|don'?t) change anything|all the same)\b/.test(t)
    )
      return answers(c, { setup_reused: true });
    const AGAIN = {
      '\\b(team|colleagues?|coworkers?)\\b': ['works_alone', 'colleagues_asked', 'colleague_notes_asked'],
      '\\b(crm|tools?|mailbox|gmail|outlook|calendar|hubspot|salesforce|pipedrive)\\b': ['tools_confirmed', 'crm_choice', 'mailbox_choice', 'calendar_choice'],
      '\\b(company|job|employer|work at|new role)\\b': ['company_asked', 'about_you_asked', 'offer_asked', 'claims_confirmed'],
      '\\b(voice|tone)\\b': ['samples_ok', 'samples_skipped'],
      '\\b(sign|sign-off|signature|name)\\b|\\b(moved|live in|city)\\b': ['about_you_asked'],
      '\\b(offer|product|proof|sell)\\b': ['offer_asked', 'claims_confirmed'],
      '\\b(send|sending)\\b': ['sending_asked', 'sending_channels', 'send_setup_done'],
      'setup level|more setup|less setup|\\b(quick|full|standard) setup\\b': ['setup_level'],
      'do-not-contact|do not contact list|\\bdnc\\b': ['dnc_asked', 'accounts_asked']
    };
    const clear = Object.entries(AGAIN)
      .filter(([re]) => new RegExp(re).test(rest || t))
      .flatMap(([, keys]) => keys);
    if (!clear.length)
      throw new Error(
        'Say "yes, same setup", or what changed (the team, the CRM or tools, the company, the voice, the offer, sending, the setup level, the do-not-contact list).'
      );
    cli('event-context', ['onboarding', '--forget', clear.join(',')], c);
    // A new company: the old one isn't proposed or used again.
    if (clear.includes('company_asked')) config(c, { own_company: null, own_domains: [] });
    return answers(c, { setup_reused: true });
  },
  goal_type: (v, c) => answers(c, { goal_type: text(v) }),
  // The goal line carries what they're there for and how many meetings (classified, not asked again).
  goal: (v, c) => {
    const o = typeof v === 'object' && v ? v : { goal: text(v) };
    if (!o.goal)
      throw new Error(
        'The answer is {"goal":"<their words>","goal_type":"selling|partnerships|hiring|job|networking|research","meetings_wanted":<n or null>}.'
      );
    // People they name as must-meets in the same breath are kept (the shortlist card asks "anyone missing?" too).
    const must = Array.isArray(o.must_meet) ? o.must_meet.map(String).filter(Boolean) : [];
    config(c, {
      goal: o.goal,
      ...(o.meetings_wanted != null && Number.isFinite(Number(o.meetings_wanted)) ? { meetings_wanted: Number(o.meetings_wanted) } : {}),
      ...(must.length ? { must_meet: must } : {})
    });
    const r = answers(c, {
      ...(o.goal_type ? { goal_type: String(o.goal_type) } : {}),
      ...(o.meetings_wanted !== undefined ? { meetings_wanted_asked: true } : {})
    });
    // The groups proposed with the goal are written into who-to-meet now (and not asked again).
    if (Array.isArray(o.segments) && o.segments.length) {
      writeProfile(c, 'who-to-meet', segmentsMd(o.goal, o.segments));
      return answers(c, { segments_confirmed: true });
    }
    return r;
  },
  // How much setup: quick (the list and drafts, nothing connected used), standard (+ the CRM, mailbox and
  // calendar read, team and customers, tone), full (+ sending, reading replies, CRM logging). Changeable any time.
  setup_level: (v, c) => {
    const t = String(typeof v === 'object' && v ? v.level : v).toLowerCase();
    const rec = (levelOptions(c.ob).find((o) => /\(recommended\)/.test(o)) || 'standard').split(/[ :(]/)[0];
    const first = (/^\W*(quick|standard|full)\b/.exec(t) || [])[1];
    const level =
      first ||
      (/\bquick\b|\bfast\b|\bminimal\b|\blight\b/.test(t)
        ? 'quick'
        : /\bfull\b|\beverything\b|\badvanced\b/.test(t)
          ? 'full'
          : /\bstandard\b|\bmiddle\b|\bnormal\b/.test(t)
            ? 'standard'
            : /recommended/.test(t)
              ? rec
              : null);
    if (!level) throw new Error('Say quick, standard or full.');
    const r = answers(c, { setup_level: level });
    return level === 'quick' ? { ...r, assumes: QUICK_ASSUMES } : r;
  },
  meetings_wanted: (v, c) => {
    const n = typeof v === 'number' ? v : parseInt(String(v).replace(/\D/g, ''), 10);
    config(c, { meetings_wanted: Number.isFinite(n) ? n : null });
    return answers(c, { meetings_wanted_asked: true });
  },
  must_meet: (v, c) => {
    const list = isNo(v)
      ? []
      : Array.isArray(v)
        ? v
        : v?.must_meet ||
          String(v)
            .split(/[;\n]|,\s(?=[A-Z])/)
            .map((x) => x.trim())
            .filter(Boolean);
    config(c, { must_meet: list });
    return answers(c, { must_meet_asked: true });
  },
  about_you: (v, c) => {
    const o = typeof v === 'object' && v ? v : null;
    if (!o?.sign_off || !o?.city)
      throw new Error('The answer is {"sign_off":"<as they sign, e.g. Best, Noor>","sender_name":"<name, company>","city":"<where they live>"}.');
    const z = zoneFrom(o.city);
    if (!z) throw new Error(`"${o.city}" isn't a city floorboss knows: ask for the nearest big city, or a time zone like ${zoneExample(c)}.`);
    const f = profileFile(c, 'voice');
    writeProfile(
      c,
      'voice',
      setVoiceField(
        setVoiceField(f.text || f.template, 'Sign-off', o.sign_off),
        'Sender name',
        o.sender_name || o.sign_off.replace(/^\s*(best|thanks|cheers|regards|kind regards|all the best|warmly)[,!]?\s*/i, '')
      )
    );
    config(c, { home_tz: z });
    // The zone the city was read as, said back, so a misread is caught now.
    return { ...answers(c, { about_you_asked: true }), home_zone: `${o.city} → ${z}` };
  },
  // "Berlin", "New York", the option text ("somewhere else: Madrid"): read as a zone, or asked again.
  home_tz: (v, c) => {
    const t = text(v).replace(/^somewhere else:\s*/i, '');
    const z = zoneFrom(t);
    if (!z) throw new Error(`"${t}" isn't a city floorboss knows: ask for the nearest big city, or a time zone like ${zoneExample(c)}.`);
    return { ...config(c, { home_tz: z }), home_zone: `${t} → ${z}` };
  },
  // "not sure / none", "no app", "don't know": no app (the name is never the option's text).
  app: (v, c) =>
    cli(
      'slot-finder',
      [
        'app',
        '--event',
        c.slug,
        '--name',
        isNo(v) || /^\s*(not sure|none|no app|no\b|n\/a|don'?t know|unsure)/i.test(text(v))
          ? 'none'
          : text(v)
              .replace(/\s*\(.*\)\s*$/, '')
              .trim()
      ],
      c
    ),
  app_request_limit: (v, c) => {
    const n = parseInt(String(v).replace(/\D/g, ''), 10);
    config(c, { app_request_limit: Number.isFinite(n) ? n : null });
    return answers(c, { app_limit_asked: true });
  },
  company: (v, c) => {
    const o =
      typeof v === 'object' && v
        ? v
        : { own_company: isNo(v) || /^no company|^none|independent|between jobs/i.test(String(v)) ? null : text(v), own_domains: [] };
    if (o.own_company) config(c, { own_company: o.own_company, own_domains: o.own_domains || [] });
    return answers(c, { company_asked: true });
  },
  team: (v, c) => {
    const o = typeof v === 'object' && v ? v : { answer: String(v) };
    const alone = o.works_alone ?? /just me|alone|^me$|only me/i.test(String(o.answer || ''));
    const named = Array.isArray(o.colleagues)
      ? o.colleagues
      : (/:\s*(.+)$/.exec(String(o.answer || ''))?.[1] || '')
          .split(/[,;\n]| and /)
          .map((x) => x.trim())
          .filter((x) => x && !/^<.*>$/.test(x));
    if (!alone && named.length) config(c, { colleagues: named });
    return answers(c, { works_alone: !!alone, ...(alone || named.length ? { colleagues_asked: true } : {}) });
  },
  // "leave them alone" | "ask me each time" | "write…but warn me" | "treat them as mine", optionally with
  // per-coworker lines ("Noa: leave alone; Dana: warn me") or {"mode","overrides":{name: mode}}.
  coworker_contacts: (v, c) => {
    const modeOf = (t) => {
      t = String(t || '').toLowerCase();
      return /warn/.test(t) ? 'warn' : /ask/.test(t) ? 'ask' : /mine|own|as if/.test(t) ? 'mine' : /leave|alone|skip|no\b/.test(t) ? 'leave' : null;
    };
    const o = typeof v === 'object' && v ? v : null;
    const text = o ? '' : String(v);
    const overrides = { ...(o?.overrides || {}) };
    // One rule per coworker, however it's typed: "Dana: leave alone. Noa: warn me, Sam: treat as mine" splits before
    // each "Name:", so a later coworker's mode never lands on an earlier one.
    const parts = text.split(/[;\n]|[.,]\s*(?=[^.;,\n:]{2,60}:)/);
    for (const part of parts) {
      const m = /^\s*([^:]{2,60}):\s*(.+)$/.exec(part);
      if (m && modeOf(m[2])) overrides[m[1].trim()] = modeOf(m[2]);
    }
    const mode = (o && modeOf(o.mode)) || modeOf(parts.find((p) => !/:/.test(p)) || '') || (Object.keys(overrides).length ? 'leave' : null);
    if (!mode) throw new Error('Say one of: leave them alone, ask me each time, write but warn me, treat them as mine (optionally "Name: mode" per coworker).');
    // A coworker named as the user says it ("Ben: warn me") is saved as the CRM's owner value ("Ben Hartley"),
    // which is what the rule is looked up by; a name that is no owner at all is asked again.
    const owners = crmOwners(c);
    if (owners.length)
      for (const k of Object.keys(overrides)) {
        const hit = ownerMatch(k, owners, { first: true });
        if (!hit) throw new Error(`"${k}" isn't an owner in your CRM: ${owners.slice(0, 12).join(', ')}? Say "Name: mode" with one of these.`);
        if (hit !== k) {
          overrides[hit] = overrides[k];
          delete overrides[k];
        }
      }
    // The account-level rule follows: a coworker's company stays theirs unless their contacts count as the user's.
    return config(c, { coworker_contacts: mode, coworker_overrides: overrides, crm_accounts: mode === 'mine' ? 'off' : 'apply' });
  },
  // Reading replies in the browser: each inbox only on a yes for it; "no" leaves both closed.
  // Reading replies in the browser: each inbox only on a yes for it; "no" leaves both closed.
  // {"linkedin":bool,"app":bool,"log_replies":bool}, or the option's words.
  inbox_read: (v, c) => {
    const o = typeof v === 'object' && v ? v : null;
    const t = String(o ? '' : v)
      .toLowerCase()
      .trim();
    const appName = String(c.event?.event?.app_name || '').toLowerCase();
    const yes = /^yes/.test(t);
    const both = yes && (/ and /.test(t.replace(/, and log.*/, '')) || /log the replies/.test(t));
    // A channel the user names with a "not", "no", "never", "except" or "without" before it is a no, whatever else
    // the sentence says ("yes but only Meetwell, not LinkedIn"); "only <one>" leaves the other out.
    const said = (w) => !!w && t.includes(w);
    const refused = (w) =>
      !!w && new RegExp(`\\b(?:not|no|never|except|without|but not)\\b(?:\\s+\\S+){0,2}?\\s+${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t);
    const only = (w) => !!w && new RegExp(`\\bonly\\s+(?:\\S+\\s+){0,2}?${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t);
    const linkedin = o ? o.linkedin === true : yes && !refused('linkedin') && !only(appName) && (both || said('linkedin'));
    const app = o ? o.app === true : yes && !!appName && !refused(appName) && !only('linkedin') && (both || said(appName));
    config(c, { inbox_read: { linkedin, app }, log_replies: o ? o.log_replies === true : yes && /log/.test(t) });
    return answers(c, { inbox_read_asked: true });
  },
  crm_log: (v, c) => {
    const t = String(typeof v === 'object' ? v.mode || '' : v).toLowerCase();
    const mode = /browser|automatic/.test(t) ? 'browser' : /task/.test(t) ? 'tasks' : /csv|import/.test(t) ? 'csv' : /don|none|^no/.test(t) ? 'none' : null;
    if (!mode) throw new Error("Say one of: in the browser, tasks, CSV, or don't log them.");
    return config(c, { crm_log: mode, ...(typeof v === 'object' && v.crm_name ? { crm_name: String(v.crm_name).slice(0, 40) } : {}) });
  },
  crm_create_contacts: (v, c) => {
    const t = String(v).toLowerCase();
    const mode = /^yes|create them/.test(t) ? 'yes' : /ask/.test(t) ? 'ask' : /^no|list them/.test(t) ? 'no' : null;
    if (!mode) throw new Error('Say yes, ask me each time, or no.');
    return config(c, { crm_create_contacts: mode });
  },
  // The list of people to create in the CRM, for "ask": "yes" creates all listed; anything else declines them.
  crm_create_ok: (v, c) => {
    const o = typeof v === 'object' && v ? v : { answer: String(v) };
    const ids = (o.ids || []).map(String);
    if (!ids.length) throw new Error('The answer is {"answer":"yes"|"no","ids":[<the ids listed>]}.');
    return ledger(c, {
      type: /^y/i.test(String(o.answer || '')) ? 'crm_create_ok' : 'crm_create_declined',
      who: 'user',
      ids,
      said: String(o.answer || '').slice(0, 120)
    });
  },
  // People about to be emailed who aren't in the connected CRM: add them through the connection, import them, or
  // go on without (those are left off the list to add, and their replies are asked about).
  crm_contacts: (v, c) => {
    const a = String(typeof v === 'object' && v ? v.answer || v.said || '' : v).trim();
    const said = String(typeof v === 'object' && v ? v.said || v.answer || '' : v).slice(0, 200);
    const value = /without|go on|skip|don'?t add|leave them/i.test(a)
      ? 'without'
      : /import/i.test(a)
        ? 'imported'
        : /add|create|now|connect|^y/i.test(a)
          ? 'create'
          : null;
    if (!value) throw new Error('Say "add them now", "imported" or "go on without them".');
    if (value === 'without') {
      // About the people named (one person's "no" at the prompt), else everyone on the list the question named.
      const listed = readJson(join(c.event.paths.dir, 'contact-list.json'), []).map((x) => String(x.id));
      const named = typeof v === 'object' && v && Array.isArray(v.ids) ? v.ids.map(String) : null;
      const ids = named ? listed.filter((id) => named.includes(id)) : listed;
      return ids.length ? ledger(c, { type: 'crm_create_declined', who: 'user', ids, said }) : { nothing_to_add: true };
    }
    // A yes for some people names them: it lets only those be added again after a no.
    const ids = typeof v === 'object' && v && Array.isArray(v.ids) ? v.ids.map(String).slice(0, 200) : undefined;
    return ledger(c, { type: 'answered', who: 'user', ask: 'crm_contacts', value, said, ...(ids ? { ids } : {}) });
  },
  crm_fill_blanks: (v, c) => config(c, { crm_fill_blanks: /^y|fill/i.test(String(v)) && !/^no|don/i.test(String(v)) ? 'yes' : 'no' }),
  // A browser window opens only on a plain yes: anything else ("no", "later", "skip it") is a not-now.
  crm_log_window: (v, c) => {
    const said = String(typeof v === 'object' && v ? v.said || v.answer || '' : v).trim();
    if (!windowYes(said)) return ledger(c, { type: 'answered', who: 'user', ask: 'crm_log_window', value: 'not now', said: said.slice(0, 200) });
    return cli('event-outreach', ['open-log-window', '--event', c.slug, '--said', said.slice(0, 200)], c);
  },
  // Notes to the coworker who holds a contact: on or off, asked once with the team (and "notes on" at the gate).
  colleague_notes: (v, c) => {
    const t = String(typeof v === 'object' && v ? (v.answer ?? v.colleague_notes ?? '') : v)
      .trim()
      .toLowerCase();
    const on =
      typeof v === 'object' && v && typeof v.colleague_notes === 'boolean'
        ? v.colleague_notes
        : /^(yes|y|on|draft|sure|ok)\b/.test(t)
          ? true
          : /^(no|n|off|just leave|leave|don'?t|none)\b/.test(t)
            ? false
            : null;
    if (on == null) throw new Error('Say "yes, draft a note to the coworker" or "no, just leave them to my coworker".');
    config(c, { colleague_notes: on });
    answers(c, { colleague_notes_asked: true });
    return {
      colleague_notes: on,
      note: on
        ? 'A short note to the coworker is drafted for each person they hold, approved with the rest.'
        : 'People a coworker holds are left to them, with no note. Say "notes on" at the shortlist to change it.'
    };
  },
  colleagues: (v, c) => {
    config(c, {
      colleagues: isNo(v)
        ? []
        : Array.isArray(v)
          ? v
          : v?.colleagues ||
            String(v)
              .split(/[,;\n]/)
              .map((x) => x.trim())
              .filter(Boolean)
    });
    return answers(c, { colleagues_asked: true });
  },
  accounts: (v, c) => fileAnswer(c, v, 'accounts', { accounts_asked: true }),
  // People and companies that must never be contacted, in one answer: {"dnc": <file>, "accounts": <file>}.
  // Typed names and companies are saved as lists too ("never Globex, they're a competitor"): only a file used to
  // work, and a typed name was lost.
  dnc: (v, c) => {
    if (typeof v === 'string' && !isNo(v) && !existsSync(expandHome(v)))
      throw new Error('Typed names or companies go in as {"dnc":["<person or email>",…],"accounts":["<company>",…]}: people in dnc, companies in accounts.');
    if (typeof v === 'object' && v && (v.dnc || v.accounts)) {
      const asFile = (x, name, body) =>
        Array.isArray(x)
          ? writeWorkText(
              c,
              name,
              body(
                x
                  .map((y) =>
                    String(y)
                      .replace(/[\r\n,]+/g, ' ')
                      .trim()
                  )
                  .filter(Boolean)
              )
            )
          : x;
      const acc = v.accounts
        ? asFile(v.accounts, 'accounts-typed.csv', (l) => `Company,Status\n${l.map((x) => `${x},do not contact this company`).join('\n')}\n`)
        : null;
      const dnc = v.dnc ? asFile(v.dnc, 'dnc-typed.txt', (l) => `${l.join('\n')}\n`) : null;
      if (acc) fileAnswer(c, acc, 'accounts', { accounts_asked: true });
      return dnc ? fileAnswer(c, dnc, 'dnc', { dnc_asked: true, accounts_asked: true }) : answers(c, { dnc_asked: true, accounts_asked: true });
    }
    return fileAnswer(c, v, 'dnc', { dnc_asked: true, accounts_asked: true });
  },
  // Connecting a chosen tool failed: the user's fallback changes the choice itself (an export, typing free
  // time, no mailbox), so the flow goes on knowing the tool isn't there.
  connect_fallback: (v, c) => {
    const o = typeof v === 'object' && v ? v : { answer: v };
    const a = String(o.answer || o.said || '').trim();
    const task = String(o.task || '');
    if (/^(try|retry|again)/i.test(a)) return { retry: true };
    if (task === 'crm.lookup') return answers(c, { crm_choice: /export|csv|file/i.test(a) ? 'export' : 'none', crm_connect_failed: a.slice(0, 200) });
    if (task === 'crm.activity') return answers(c, { crm_activity: 'none', crm_activity_failed: a.slice(0, 200) });
    if (task === 'email.history') return answers(c, { mailbox_choice: 'no', mail_connect_failed: a.slice(0, 200) });
    if (task === 'calendar.busy') return answers(c, { calendar_choice: 'no', calendar_connect_failed: a.slice(0, 200) });
    throw new Error('task is crm.lookup, crm.activity, email.history or calendar.busy.');
  },
  tools: (v, c) => {
    const o = typeof v === 'object' && v ? v : null;
    if (!o)
      throw new Error(
        'The answer is {"crm":"<server>"|"export"|"none","mailbox":true|false,"calendar":true|false}, with what was found and the user\'s changes.'
      );
    const crm = o.crm == null ? null : String(o.crm);
    return answers(c, {
      tools_confirmed: true,
      ...(crm
        ? {
            crm_choice: /^export/i.test(crm) ? 'export' : /^none|^no$/i.test(crm) ? 'none' : 'connector',
            ...(/^(export|none|no)$/i.test(crm) ? {} : { crm_server: crm })
          }
        : {}),
      ...(o.mailbox != null ? { mailbox_choice: o.mailbox ? 'yes' : 'no' } : {}),
      ...(o.calendar != null ? { calendar_choice: o.calendar ? 'yes' : 'no' } : {})
    });
  },
  crm_use: (v, c) =>
    answers(c, {
      crm_choice: /export/i.test(String(v)) ? 'export' : /none|not for this/i.test(String(v)) ? 'none' : 'connector',
      ...(typeof v === 'object' && v.crm_server ? { crm_server: v.crm_server } : {})
    }),
  // "HubSpot, not connected. I exported it to ~/Downloads/export.csv": a file named in the answer that exists is
  // the export, so it isn't asked for again.
  crm_where: (v, c) => {
    const t = String(typeof v === 'object' && v ? v.answer || v.said || '' : v);
    // The CRM's name when they say it ("HubSpot, I exported it"), for the next event's "same setup?".
    const label = (/\b(hubspot|salesforce|pipedrive|zoho|dynamics|attio|close|copper|freshsales|monday|insightly|odoo|sugarcrm)\b/i.exec(t) || [])[1] || null;
    const choice = {
      crm_choice: /spreadsheet/i.test(t) ? 'spreadsheet' : /built|home/i.test(t) ? 'home-made' : /nowhere|none/i.test(t) ? 'none' : 'other',
      ...(label ? { crm_label: `${label[0].toUpperCase()}${label.slice(1).toLowerCase()} (an export)`.replace(/^Hubspot/, 'HubSpot') } : {})
    };
    const named = namedFile(t, { bare: true });
    if (named && c.slug) return { ...fileAnswer(c, named, 'crm', { ...choice, ...(saysNoOptOut(t) ? { crm_opt_out_none: true } : {}) }), export_saved: named };
    return answers(c, choice);
  },
  // A path inside a sentence ("here: ~/Downloads/export.csv") is the file, as for the attendee list.
  crm_export: (v, c) => {
    if (isNo(v)) return answers(c, { crm_export_skipped: true });
    const whole = pathOf(v);
    const said = String(typeof v === 'object' && v ? v.said || v.path || v.file || '' : v);
    const p = whole && existsSync(String(whole).trim()) ? whole : namedFile(said, { bare: true }) || whole;
    // "There's no opt-out column in it, we never added one": kept for the mapping question, which then doesn't
    // ask it again.
    return fileAnswer(c, typeof v === 'object' && v ? { ...v, path: p } : p, 'crm', saysNoOptOut(said) ? { crm_opt_out_none: true } : {});
  },
  // Matched against the owners the CRM read holds ("Maya Okafor, that's me" is Maya Okafor): the owner value is
  // saved as the CRM writes it, or the user's own customers would read as a coworker's.
  crm_name: (v, c) => {
    const said = String(typeof v === 'object' && v ? v.name || v.crm_user_name || v.said || '' : v).trim();
    const owners = crmOwners(c);
    if (!owners.length) return config(c, { crm_user_name: said });
    // Someone who holds no records in it says so: no owner there is them, so every owner reads as a coworker.
    const none = /^(none of (these|them)|not (an owner|in (it|there))|i own nothing|nobody)\b/i.exec(said);
    if (none) {
      const me = 'not an owner in the CRM';
      return {
        ...config(c, { crm_user_name: me }),
        crm_user_name: me,
        note: `No owner in your CRM is you: every owner there (${owners.slice(0, 6).join(', ')}) reads as a coworker.`
      };
    }
    // Several spellings ("Maya Okafor|M. Okafor") are kept as given when one of them is an owner.
    const hit = said.includes('|') ? (said.split('|').some((x) => ownerMatch(x, owners)) ? said : null) : ownerMatch(said, owners, { first: true });
    if (!hit)
      throw new Error(
        `"${said}" isn't an owner in your CRM: ${owners.slice(0, 12).join(', ')}? Say which of these is you, or "none of these" if you own no records in it.`
      );
    return { ...config(c, { crm_user_name: hit }), crm_user_name: hit, ...(hit !== said ? { note: `Saved as "${hit}", as your CRM writes it.` } : {}) };
  },
  customers: (v, c) => {
    const s = String(typeof v === 'object' ? '' : v).toLowerCase();
    // The option's own words decide, before "(recommended)" does: "a warm note (recommended)" is warm for all.
    const all = (x) => ({ recent_months: 6, recent: x, on_deal: x, other: x });
    const rule =
      typeof v === 'object'
        ? v
        : /^a warm note|^warm/.test(s)
          ? all('warm')
          : /^ask me/.test(s)
            ? all('ask')
            : /^leave customers|^leave all/.test(s)
              ? all('hold')
              : /recommended|6 months/.test(s)
                ? { recent_months: 6, recent: 'hold', on_deal: 'warm', other: 'ask' }
                : /warm note for every/.test(s)
                  ? { recent_months: 6, recent: 'warm', on_deal: 'warm', other: 'warm' }
                  : /leave all/.test(s)
                    ? { recent_months: 6, recent: 'hold', on_deal: 'hold', other: 'hold' }
                    : /ask/.test(s)
                      ? { recent_months: 6, recent: 'ask', on_deal: 'ask', other: 'ask' }
                      : null;
    if (!rule) throw new Error('The customers answer is one of the options, or a rule object.');
    // Their own words, beyond an option's ("warm, but just a hello and a coffee, no pitch"), go to the drafts.
    // What's left once the options' own words are taken out: two words or more (beyond filler) are the user's guidance.
    const beyond = s
      .replace(
        /\(recommended\)|\brecommended\b|\ba warm note\b|\bwarm note\b|\bwarm\b|\bask me( about)?( each( one)?| each time)?\b|\bleave (customers|them|all)( alone)?\b|\bcustomers\b/g,
        ' '
      )
      .replace(/[^a-z0-9']+/g, ' ')
      .trim();
    // Words that only pick an option ("yes", "the first one", "for all of them") aren't guidance either.
    const left = beyond
      .replace(
        /\b(yes|ok|okay|the|one|default|option|first|thanks|thank you|please|for|all|of|them|every|each|customer|go with|pick|i'?ll take|that|is|fine|a|i|guess|sounds|good|by|me|great|sure)\b/g,
        ' '
      )
      .split(/\s+/)
      .filter(Boolean);
    const said = String(typeof v === 'object' ? v.said || '' : left.length >= 2 ? String(v) : '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    const cleanRule = typeof v === 'object' ? { recent_months: rule.recent_months, recent: rule.recent, on_deal: rule.on_deal, other: rule.other } : rule;
    return config(c, { customer_rule: cleanRule, customer_said: said });
  },
  lost_deals: (v, c) => {
    const s = String(typeof v === 'object' ? (v.months ?? v.rejected_months ?? '') : v).toLowerCase();
    const n = /no wait|^none|^0\b|never mind|like anyone/.test(s)
      ? 0
      : /(\d+)\s*(year|yr)/.test(s)
        ? 12 * Number(/(\d+)\s*(?:year|yr)/.exec(s)[1])
        : /^\D*(\d+)/.test(s)
          ? Number(/(\d+)/.exec(s)[1])
          : /recommended/.test(s)
            ? 6
            : null;
    if (n == null || !Number.isInteger(n) || n < 0 || n > 120)
      throw new Error('The lost-deals answer is one of the options, or a whole number of months (0 for no wait).');
    config(c, { rejected_months: n });
    return answers(c, { lost_deals_asked: true });
  },
  mailbox_use: (v, c) => answers(c, { mailbox_choice: /^y|yes/i.test(String(v)) ? 'yes' : 'no' }),
  known_contacts: (v, c) => {
    if (isNo(v)) return answers(c, { known_asked: true });
    const p = allowedPath(pathOf(v), { list: true });
    const bad = existsSync(p) ? listFileProblem(p, 0, 'known') : `${p} isn't there.`;
    if (bad) throw new Error(`${bad} Nothing was saved.`);
    const have = c.cfg.known_contacts_paths || [];
    config(c, { known_contacts_paths: [...new Set([...have, p])] });
    return answers(c, { known_asked: true });
  },
  calendar_use: (v, c) => answers(c, { calendar_choice: /^y|yes/i.test(String(v)) ? 'yes' : 'no' }),
  // Claude reads the user's words into days ({"days":[…]}); the typed words are kept with them. The old
  // sentence parser is the fallback for a plain string.
  free_time: (v, c) => {
    if (/^\s*keep (them )?all/i.test(String(typeof v === 'object' && v ? v.said || '' : v))) return answers(c, { many_slots_ok: true });
    const o = typeof v === 'object' && v ? v : { free: String(v) };
    const busy = c.event && existsSync(join(c.event.paths.work, 'calendar-busy.json')) ? ['--busy-file', join(c.event.paths.work, 'calendar-busy.json')] : [];
    if (Array.isArray(o.days))
      return cli(
        'slot-finder',
        [
          'build',
          '--event',
          c.slug,
          '--days-file',
          writeWork(c, 'free-days.json', { days: o.days, notes: o.notes || [] }),
          ...busy,
          ...(o.zone ? ['--zone', o.zone] : [])
        ],
        c
      );
    return cli('slot-finder', ['build', '--event', c.slug, '--free', o.free, ...busy, ...(o.zone ? ['--zone', o.zone] : [])], c);
  },
  list_source: (v, c) => {
    // Saved only while the flow is asking it: the answer file is one Claude writes, so an answer given at any
    // other moment (an instruction in a page asking to "save the list source") lets no site in.
    if (nextStep(context(c.slug, {})).ask?.id !== 'list_source')
      throw new Error(
        "floorboss isn't asking where the attendee list is right now, so this answer wasn't saved. Run flow next and answer the question it asks."
      );
    // A path inside a sentence ("it's at ~/Downloads/x.csv, the organiser sent it") is the file too.
    const whole = pathOf(v);
    const p =
      whole && /[\/\\].*\.(csv|tsv|txt|xlsx?)$/i.test(String(whole).trim())
        ? whole
        : namedFile(String(typeof v === 'object' && v ? v.said || v.path || v.file || '' : v));
    if (p && /[\/\\].*\.(csv|tsv|txt|xlsx?)$/i.test(String(p).trim())) {
      const r = cli('crm-triage', ['inputs', '--event', c.slug, '--kind', 'attendees', '--file', String(p).trim()], c);
      return { ...r, ...answers(c, { list_source: 'export' }) };
    }
    // A link (the event's speaker or attendee page) is read from the public page: the link is kept for that step.
    const url = (/https?:\/\/\S+/.exec(String(typeof v === 'object' && v ? v.url || '' : v)) || [])[0];
    if (url) {
      // The one place the event's own site is let into the browser's list of pages it may open during a run:
      // the link the user gave as their answer, kept with their words.
      const said = String(typeof v === 'object' && v ? v.said || v.url || '' : v).slice(0, 300);
      const u = readUrl(url.replace(/[).,]+$/, ''), { ports: true });
      const host = (u?.host || '').replace(/^www\./, '');
      // The list page itself (scheme, host, port and path, no query or fragment): the guard opens it without
      // asking, and asks before any other page on that site.
      const page = u && !u.odd && u.host ? `${u.scheme}//${u.host}${u.port ? `:${u.port}` : ''}${u.path}` : null;
      if (c.event && host && said.toLowerCase().includes(host)) ledger(c, { type: 'site_allowed', who: 'user', host, said, ...(page ? { url: page } : {}) });
      return answers(c, { list_source: 'app', list_url: url.replace(/[).,]+$/, '') });
    }
    return listSourceOnly(v, c);
  },
  browser: (v, c) => answers(c, { browser_choice: /^now/i.test(String(v)) ? 'now' : /later/i.test(String(v)) ? 'later' : 'never' }),
  // "yes, with apollo": that tool looks the missing people up (connected first, lookups agreed first).
  contact_details: (v, c) => {
    const t = String(typeof v === 'object' && v ? v.answer || '' : v);
    const tool = ((/with (.+?)(?:\s*\(|$)/i.exec(t) || [])[1] || '').trim() || (typeof v === 'object' && v?.server) || null;
    const mode = /csv/i.test(t) ? 'csv' : tool ? 'mcp' : /decide|later/i.test(t) ? 'later' : 'app';
    return answers(c, { contact_details: mode, ...(mode === 'mcp' ? { enrich_server: tool } : {}) });
  },
  // How many lookups the user agrees to (the credits): all of them, the top n, a CSV instead, or none.
  enrich_ok: (v, c) => {
    const t = String(typeof v === 'object' && v ? v.answer || '' : v).toLowerCase();
    const step = nextStep(context(c.slug, {}));
    // Only while the flow asks it, and only people on the list with no email now: the count can't grow past them.
    if (step.ask?.id !== 'enrich_ok') throw new Error("floorboss isn't asking about lookups right now, so this answer wasn't saved. Run flow next.");
    const stored = readJson(join(c.event.paths.derived, 'contacts.json'), []);
    const noEmail = new Set(stored.filter((x) => x && !x.email).map((x) => x.id));
    const byId = Object.fromEntries(stored.filter(Boolean).map((x) => [x.id, x]));
    const ids = (step.ask.ids || []).filter((id) => noEmail.has(id));
    if (/csv/.test(t)) {
      answers(c, { contact_details: 'csv' });
      return ledger(c, { type: 'answered', who: 'user', ask: 'enrich_ok', value: 'csv' });
    }
    if (/^\s*(no|skip|none|not now)\b/.test(t)) return ledger(c, { type: 'answered', who: 'user', ask: 'enrich_ok', value: 'skip' });
    const n = lookupCount(t, ids.length);
    const chosen = ids.slice(0, n);
    // Under the lookup lock: a lookup being counted at this moment can't write the old window back over this one.
    withLock('enrich', () =>
      writeJson(join(c.home, 'enrich-window.json'), {
        event: c.slug,
        ids: chosen,
        // Who may be looked up, as the list has them: a lookup carries one of these people and nothing else.
        people: chosen.map((id) => {
          const p = byId[id] || {};
          return { id, name: p.name || '', company: p.company || '', title: p.title || '', profile_url: p.profile_url || '' };
        }),
        count: chosen.length,
        used: 0,
        until: new Date(c.now.getTime() + 30 * 60e3).toISOString(),
        said: t.slice(0, 120)
      })
    );
    return ledger(c, { type: 'answered', who: 'user', ask: 'enrich_ok', value: `yes:${chosen.join(',')}` });
  },
  drafting_mode: (v, c) =>
    config(c, { drafting_mode: /your tools write everything/i.test(String(v)) ? 'delegate' : /mix/i.test(String(v)) ? 'blend' : 'floorboss' }),
  drafter: (v, c) => config(c, { drafter: v }),
  import_context: (v, c) => answers(c, { import_context: /yes/i.test(String(v)) ? 'yes' : /reference/i.test(String(v)) ? 'reference' : 'no' }),
  posture: (v, c) => answers(c, { posture: text(v) }),
  optout_known: (v, c) => {
    const t = String(typeof v === 'object' && v ? v.answer || '' : v).toLowerCase();
    const cold = /only|cold|\boff\b|drop|leave it out|without|not on|don'?t|\bno\b|\bnope\b|fr[ií]os?|s[oó]lo/.test(t),
      every = /every|\byes\b|always|keep it on|on all|all of them|todos|siempre/.test(t);
    if (cold === every) throw new Error('Didn\'t catch that: say "yes, on every email" or "only on cold emails". Nothing was saved.');
    return config(c, { optout_known: every });
  },
  seller_framing: (v, c) => answers(c, { seller_framing: /^y|yes/i.test(String(v)) ? 'yes' : 'no' }),
  profile: (v, c) => {
    const name =
      typeof v === 'object'
        ? v.name
        : String(v)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 40);
    cli('event-context', ['init-profile', '--profile', name], c);
    return config(c, { context_profile: name });
  },
  // These three answers live in the profile's files: saving refuses until they're written there (confirmed
  // but never written, drafts would have no groups, claims or never-say rules).
  segments: (v, c) => {
    if (typeof v === 'object' && v && Array.isArray(v.segments)) {
      writeProfile(c, 'who-to-meet', segmentsMd(v.goal || c.cfg.goal, v.segments));
      return answers(c, { segments_confirmed: true });
    }
    const f = profileFile(c, 'who-to-meet');
    if (!parseSegments(f.text).length || /^##\s+Segment:\s*</m.test(f.text))
      throw new Error(`Write the groups into ${f.path} first (one "## <name>" section each, as its template shows), then save.`);
    return answers(c, { segments_confirmed: true });
  },
  material: (v, c) => answers(c, { material_asked: true }),
  // One line on who the sender is, into what-you-bring's "About me" (what the critic lets a message say).
  about: (v, c) => {
    const line = String(typeof v === 'object' && v ? v.about || v.about_me || v.said || '' : v)
      .replace(/[\u0000-\u001f`#<>|]+/g, ' ')
      .trim()
      .slice(0, 200);
    if (!line || isNo(line)) throw new Error('Say who you are in one line: your role and company ("founder of Tallyroute").');
    const f = profileFile(c, 'what-you-bring');
    writeProfile(c, 'what-you-bring', setAbout(f.text || f.template, line));
    return { ...answers(c, { about_asked: true }), about: line };
  },
  // One to three insights, or none: rows in the "what you know" table, tagged for every segment unless given.
  insights: (v, c) => {
    if (isNo(v) || (typeof v === 'object' && v && isNo(v.said || '')))
      return {
        ...answers(c, { insights_asked: true }),
        note: 'No insights: drafts lead with questions and proof. Add rows to the "what you know" table in what-you-bring any time.'
      };
    const list = (Array.isArray(v) ? v : Array.isArray(v?.insights) ? v.insights : String(v).split(/\n+/))
      .map((x) => (typeof x === 'string' ? { insight: x.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, '') } : x))
      .filter((x) => String(x?.insight || '').trim())
      .slice(0, 3);
    if (!list.length) throw new Error('Give one to three insights ({"insights":[{"insight","basis"}]}), or "none".');
    const segs = parseSegments(profileFile(c, 'who-to-meet').text || '').map((x) => x.slug);
    const rows = list.map((x) => ({
      insight: String(x.insight)
        .replace(/[\u0000-\u001f`#<>]+/g, ' ')
        .trim(),
      basis: String(x.basis || "the user's own work")
        .replace(/[\u0000-\u001f`#<>]+/g, ' ')
        .trim(),
      segments: x.segments || segs,
      situations: x.situations || ''
    }));
    const f = profileFile(c, 'what-you-bring');
    writeProfile(c, 'what-you-bring', addInsights(f.text || f.template, rows));
    return { ...answers(c, { insights_asked: true }), insights_saved: rows.length };
  },
  // What they sell lives in what-you-bring: saving refuses until it's written there.
  offer: (v, c) => {
    if (typeof v === 'object' && v && (v.one_sentence || v.about_me)) {
      writeProfile(c, 'what-you-bring', bringMd(v));
      return answers(c, { offer_asked: true, ...(v.proof || v.about_me ? { claims_confirmed: true } : {}) });
    }
    const f = profileFile(c, 'what-you-bring');
    if (f.text === f.template || stillTemplate(f.text))
      throw new Error(`Write the offer into ${f.path} first (one sentence, the problems it solves, any proof), then save.`);
    return answers(c, { offer_asked: true });
  },
  true_claims: (v, c) => {
    if (typeof v === 'object' && v && (v.one_sentence || v.about_me)) {
      writeProfile(c, 'what-you-bring', bringMd(v));
      return answers(c, { claims_confirmed: true, offer_asked: true });
    }
    const f = profileFile(c, 'what-you-bring');
    if (f.text === f.template || stillTemplate(f.text))
      throw new Error(`Write what they ticked into ${f.path} first ("About me", the offer and the proof they may use), then save.`);
    return answers(c, { claims_confirmed: true });
  },
  // What they'd change in the samples becomes rules in the voice file, here, not left to be written by hand.
  samples: (v, c) => {
    const o = typeof v === 'object' && v ? v : { said: String(v) };
    const rules = (Array.isArray(o.rules) ? o.rules : [])
      .map((r) =>
        String(r)
          .replace(/[\u0000-\u001f`#<>]+/g, ' ')
          .trim()
      )
      .filter(Boolean)
      .slice(0, 10);
    // Their own emails that got replies (pasted, or files): kept in the voice file, and their length and
    // greeting set from them. With none, the fields they would fill are left out, not left blank.
    // A file (or a pasted block) can hold several emails: each is split out, so its length and greeting are
    // read per email, not from one block that starts with "Email 1 (to a CFO…)".
    const emails = (Array.isArray(o.emails) ? o.emails : [])
      .flatMap((x) => {
        if (typeof x !== 'string')
          return x && String(x.body || '').trim()
            ? x.subject
              ? [{ subject: String(x.subject || ''), body: String(x.body) }]
              : splitEmails(String(x.body))
            : [];
        const p = allowedPath(expandHome(x.trim()), { list: true });
        return splitEmails(readFileSync(p, 'utf8').slice(0, 8000)).map((e) => ({ ...e, source: 'file' }));
      })
      .slice(0, 5);
    if (emails.length && c.slug) cli('event-outreach', ['voice-save', '--event', c.slug, '--file', writeWork(c, 'voice-samples.json', { samples: emails })], c);
    const fromEmails = voiceFromEmails(emails.map((x) => x.body));
    let openingSaid = null;
    if (rules.length || o.sign_off || o.closest || emails.length || o.avoid) {
      const f = profileFile(c, 'voice');
      let md = f.text || f.template;
      if (o.sign_off) md = setVoiceField(md, 'Sign-off', o.sign_off);
      if (o.closest) md = setVoiceField(md, 'Tone', o.closest);
      // The user's own length rule wins over the length read from their emails.
      const ruled = lengthRule(rules);
      if (ruled || fromEmails.length) md = setVoiceField(md, 'Length', ruled || fromEmails.length);
      if (fromEmails.greeting) md = setVoiceField(md, 'Greeting', fromEmails.greeting);
      if (o.avoid && !isNo(o.avoid))
        md = setVoiceField(
          md,
          'Avoid',
          String(o.avoid)
            .replace(/[\u0000-\u001f`#<>]+/g, ' ')
            .slice(0, 200)
        );
      if (rules.length) {
        const head = '## Rules from your feedback';
        const add = rules.map((r) => `- ${r}`).join('\n');
        md = md.includes(head) ? md.replace(head, () => `${head}\n${add}`) : `${md.trimEnd()}\n\n${head}\n${add}\n`;
      }
      // A rule about how messages open becomes the voice file's Opening, which the structures follow.
      const opening = rules.length ? openingOf(rules.map((r) => `- ${r}`).join('\n')) : null;
      if (opening) md = setVoiceField(md, 'Opening', opening);
      writeProfile(c, 'voice', md);
      if (opening) openingSaid = `Your rule about the opening is kept as "Opening: ${opening}": ${OPENINGS[opening].says}.`;
    }
    const r = answers(c, { samples_ok: true });
    const out = emails.length ? { ...r, emails_saved: emails.length, from_emails: fromEmails } : r;
    return openingSaid ? { ...out, opening: openingSaid } : out;
  },
  drafter_sample: (v, c) => answers(c, { drafter_sample_ok: true }),
  // "English and another: German" is English and German. An extra language needs its own opt-out line when
  // messages carry one, or a German draft would end in English.
  languages: (v, c) => {
    const o =
      typeof v === 'object'
        ? v
        : {
            languages: /english only/i.test(String(v))
              ? ['English']
              : String(v)
                  .replace(/\b(and )?(only )?another( language)?:\s*/gi, ', ')
                  .replace(/\blanguage\b/gi, '')
                  .split(/,| and /)
                  .map((x) => x.trim())
                  .filter(Boolean)
          };
    const langs = (o.languages || [])
      .map((x) =>
        String(x)
          .trim()
          .replace(/^./, (ch) => ch.toUpperCase())
      )
      .filter(Boolean);
    // floorboss's own opt-out line in common languages, used when the user kept the default one.
    const BUILT_IN = OPTOUT_BUILT_IN;
    const own = { ...(c.cfg.optout_sentences || {}), ...(o.optout_sentences || {}) };
    if (c.cfg.optout_sentence === DEFAULT_OPTOUT) for (const l of langs) if (!own[l] && BUILT_IN[l]) own[l] = BUILT_IN[l];
    o.optout_sentences = Object.keys(own).length ? own : o.optout_sentences;
    const missing = c.cfg.optout_sentence ? langs.filter((l) => l.toLowerCase() !== 'english' && !own[l]) : [];
    if (missing.length)
      throw new Error(
        `Give the opt-out line in ${missing.join(', ')} too: {"languages":${JSON.stringify(langs)},"optout_sentences":{${missing.map((l) => `"${l}":"<the opt-out line in ${l}>"`).join(',')}}}.`
      );
    config(c, { languages: langs, ...(o.optout_sentences ? { optout_sentences: o.optout_sentences } : {}) });
    // What was saved, not the whole config: the user asked about languages.
    return {
      languages: langs,
      ...(o.optout_sentences && langs.some((l) => o.optout_sentences[l])
        ? { optout_sentences: Object.fromEntries(langs.filter((l) => o.optout_sentences[l]).map((l) => [l, o.optout_sentences[l]])) }
        : {})
    };
  },
  app_notes: (v, c) => {
    const o = typeof v === 'object' ? v : {};
    config(c, {
      app_note_times: o.app_note_times || 'in_app',
      app_note_event_name: o.app_note_event_name !== false,
      app_note_optout: o.app_note_optout !== false
    });
    return answers(c, { app_notes_asked: true });
  },
  basics: (v, c) => {
    const o = typeof v === 'object' && v ? v : { said: String(v) };
    if (o.meeting_place) config(c, { meeting_place: String(o.meeting_place).slice(0, 200) });
    const never = (Array.isArray(o.never_say) ? o.never_say : o.never_say ? [o.never_say] : []).map((x) => String(x).trim()).filter(Boolean);
    // Into what-you-bring's own "Never say" line, the one the drafter and the critic read.
    if (never.length) {
      const f = profileFile(c, 'what-you-bring');
      writeProfile(c, 'what-you-bring', addNeverSay(f.text || f.template, never));
    }
    return answers(c, { basics_asked: true });
  },
  // Send setup reads these channels straight away (connectors' chosenChannels); the full sending setting is written with the follow-up mode.
  sending: (v, c) => {
    const chans =
      isNo(v) || /myself|nowhere/i.test(String(v))
        ? []
        : Array.isArray(v)
          ? v
          : v?.channels ||
            [
              /email/i.test(String(v)) ? 'email' : null,
              /linkedin/i.test(String(v)) ? 'linkedin' : null,
              /app|brella|grip|swapcard/i.test(String(v)) ? 'app' : null
            ].filter(Boolean);
    return answers(c, { sending_channels: chans, sending_asked: true });
  },
  linkedin_send: (v, c) => answers(c, /accept/i.test(String(v)) ? { linkedin_send_ack: true } : { linkedin_send_declined: true }),
  send_setup: (v, c) => {
    if (isNo(v)) return answers(c, { send_setup_skipped: true });
    const o = typeof v === 'object' ? v : { own_email: String(v) };
    config(c, { ...(o.own_email ? { own_email: o.own_email } : {}), ...(o.own_phone ? { own_phone: o.own_phone } : {}) });
    return answers(c, o.done ? { send_setup_done: true } : {});
  },
  followups_mode: (v, c) => {
    if (!followupsModeOf(v)) throw new Error('Ask again: should follow-ups go on their day by themselves, or wait for the user to approve each round?');
    const raw = c.ob.ans.sending_channels || [];
    let chans = raw;
    if (typeof raw === 'string') {
      try {
        chans = JSON.parse(raw);
      } catch {
        chans = raw.split(/[\s,]+/).filter(Boolean);
      }
    }
    return config(c, { sending: { channels: chans, followups: followupsModeOf(v), linkedin_ack: c.ob.ans.linkedin_send_ack === true } });
  },
  // Not onboarding: the steps after it.
  // A reply's time is booked, or the person it pointed to is added (with a note saying who sent them).
  reply_action: (v, c) => {
    const o = typeof v === 'object' && v ? v : null;
    if (!o?.id || !o.action) throw new Error('The answer is {"id","ext","action","answer",…} as the step gives it.');
    const a = String(o.answer || '').trim();
    const done = (answer) =>
      ledger(c, {
        type: 'reply_action_done',
        who: 'user',
        id: o.id,
        ext: o.ext ?? null,
        answer: String(answer).slice(0, 120),
        said: a.slice(0, 200) || String(answer).slice(0, 120)
      });
    if (o.action === 'book') {
      const given = (/^(?:booked for:\s*|a different time:\s*)?(\d{4}-\d{2}-\d{2} \d{2}:\d{2})$/i.exec(a) || [])[1];
      if (!given && /^y/i.test(a) && !o.time)
        throw new Error('There is no time to book yet: give it as "booked for: YYYY-MM-DD HH:MM", or say "not booked yet".');
      const time = given || (/^y/i.test(a) ? o.time : null);
      if (!time) return done(a || 'not booked');
      const f = writeWork(c, 'book.json', { items: [{ who: o.id, what: 'booked', time, said: a }] });
      const r = cli('event-outreach', ['record', '--event', c.slug, '--file', f], c);
      done(`booked ${time}`);
      return r;
    }
    if (!/^y/i.test(a)) return done('no');
    const ref = o.referral || {};
    if (!ref.name && !ref.email) throw new Error('The answer needs the referral ({"name","email","title"}) as the step gives it.');
    // A new row on the event's own copy of the list, then the list is read again so they're judged like anyone.
    const list = join(c.event.paths.inputs, 'attendees.csv');
    if (!existsSync(list)) throw new Error('No attendee list on the event to add them to.');
    const m = c.event.state.mappings?.attendees?.columns || {};
    const header = readFileSync(list, 'utf8').split(/\r?\n/)[0];
    const delim = header.includes(';') && !header.includes(',') ? ';' : ',';
    const cols = header.split(delim).map((h) => h.replace(/^"|"$/g, '').trim());
    const [first, ...rest] = String(ref.name || '')
      .trim()
      .split(/\s+/);
    const val = { name: ref.name || '', first: first || '', last: rest.join(' '), title: ref.title || '', company: o.company || '', email: ref.email || '' };
    // A list with First and Last name columns gets the name split; otherwise one Name column.
    const PAT = {
      name: '(full )?name$',
      first: 'first ?name',
      last: '(last ?name|surname)',
      company: '(company|organi[sz]ation|account name)',
      title: '((job )?title|role|position)',
      email: 'e-?mail'
    };
    const colFor = (k) => m[k] || cols.find((h) => new RegExp(`^${PAT[k]}`, 'i').test(h.trim()));
    const keys = colFor('first') && colFor('last') ? ['first', 'last', 'title', 'company', 'email'] : ['name', 'title', 'company', 'email'];
    const row = cols.map((h) => {
      const k = keys.find((x) => colFor(x) === h);
      const v2 = k ? val[k] : '';
      return /[",;\n]/.test(v2) ? `"${v2.replace(/"/g, '""')}"` : v2;
    });
    // appendLine starts on a fresh line, and never writes through a link or a second name.
    appendLine(list, row.join(delim));
    cli('crm-triage', ['load', '--event', c.slug], c);
    const contacts = readJson(join(c.event.paths.derived, 'contacts.json'), []);
    const low = (x) => String(x || '').toLowerCase();
    const added = contacts.find(
      (x) => (ref.email && low(x.email) === low(ref.email)) || (low(x.name) === low(ref.name) && (!o.company || low(x.company) === low(o.company)))
    );
    if (!added) throw new Error(`Added a row for ${ref.name || ref.email}, but the list didn't pick it up: check the attendee list's columns.`);
    const referrer = c.event.state.people[o.id]?.name || o.id;
    ledger(c, {
      type: 'note',
      who: 'user',
      id: added.id,
      text: `${referrer} pointed you to them: say so in the first line`,
      known: false,
      said: `yes, add ${ref.name || ref.email} (${referrer}'s referral)`
    });
    const f = writeWork(c, 'add.json', { items: [{ who: added.id, what: 'added' }] });
    const r = cli('event-outreach', ['record', '--event', c.slug, '--file', f], c);
    done(`added ${added.id}`);
    return { added: added.id, ...r };
  },
  attendee_list: (v, c) => cli('crm-triage', ['inputs', '--event', c.slug, '--kind', 'attendees', '--file', pathOf(v)], c),
  map_columns_attendees: (v, c) => mapping(c, 'attendees', v),
  map_columns_crm: (v, c) => mapping(c, 'crm', v),
  check_these: (v, c) => decisions(c, v),
  gate: (v, c) => cli('crm-triage', ['gate', '--event', c.slug, '--answers', gateWords(v, 'shortlist')], c),
  fit_doubts: (v, c) => {
    const step = nextStep(context(c.slug, {}));
    const people = step.ask?.people || [];
    const all = [...new Set(people.map((p) => p.company))];
    const t = String(typeof v === 'object' && v ? '' : v).toLowerCase();
    const cut =
      typeof v === 'object' && v && Array.isArray(v.cut)
        ? v.cut.map(String)
        : /^\s*cut (them )?all/.test(t)
          ? all
          : /^\s*keep/.test(t)
            ? []
            : all.filter((co) => t.includes(co.toLowerCase()) && new RegExp(`cut[^.;]*${co.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t));
    const ids = people.filter((p) => cut.some((co) => co.toLowerCase() === p.company.toLowerCase())).map((p) => p.id);
    // The cut is the user's answer to the shortlist too: the card isn't shown again for it.
    if (ids.length) {
      cli('crm-triage', ['gate', '--event', c.slug, '--answers', `remove ${ids.join(',')} because research says the company may not fit`], c);
      ledger(c, { type: 'answered', who: 'user', ask: 'gate', value: 'ok' });
    }
    return ledger(c, { type: 'answered', who: 'user', ask: 'fit_doubts', value: ids.length ? `cut ${cut.join(', ')}` : 'kept them' });
  },
  enrich_csv: (v, c) => {
    if (isNo(v) || /^\s*later/i.test(String(v))) return ledger(c, { type: 'answered', who: 'user', ask: 'enrich_csv', value: 'later' });
    const r = cli('crm-triage', ['enrich-import', '--event', c.slug, '--file', pathOf(v), '--source', 'filled by the user'], c);
    if (r.saved === false) throw new Error((r.errors || []).join('; '));
    ledger(c, { type: 'answered', who: 'user', ask: 'enrich_csv', value: 'imported' });
    cli('crm-triage', ['load', '--event', c.slug], c);
    return r;
  },
  research_scale: (v, c) =>
    ledger(c, { type: 'answered', who: 'user', ask: 'research_scale', value: /^all/i.test(String(v)) ? 'all' : /top/i.test(String(v)) ? 'top' : 'none' }),
  // Quick setup: web research on the shortlisted companies only on a yes.
  // "skip Acme, Globex": those get a brief that says they weren't researched; the rest are looked up.
  company_research: (v, c) => {
    const t = String(typeof v === 'object' && v ? v.answer || '' : v).trim();
    const listed = nextStep(context(c.slug, {})).ask?.companies || [];
    // The people question asked in the same breath ("go, and people: top 5", "skip all research"): saved too, so
    // it isn't asked again.
    const scale = peopleScaleOf(t);
    const people = () => {
      if (!scale || !c.event || c.event.state.answered.research_scale) return {};
      ledger(c, { type: 'answered', who: 'user', ask: 'research_scale', value: scale, said: t.slice(0, 200) });
      return { research_scale: scale };
    };
    const some = /^(skip|leave out|not)\b/i.test(t) ? listed.filter((co) => t.toLowerCase().includes(String(co).toLowerCase())) : [];
    if (some.length && some.length < listed.length) {
      cli('attendee-research', ['skip-companies', '--event', c.slug, '--companies', JSON.stringify(some)], c);
      return { ...ledger(c, { type: 'answered', who: 'user', ask: 'company_research', value: 'yes', said: t.slice(0, 200) }), skipped: some, ...people() };
    }
    const value = /^(skip|no|none|don'?t|not)\b/i.test(t) ? 'skip' : /^(yes|y|go|ok|sure|research|look|refresh)/i.test(t) ? 'yes' : null;
    if (!value) throw new Error('Say "go", "skip <companies>", "skip companies", or "skip all" (and for the people, "people: all|top|none").');
    return { ...ledger(c, { type: 'answered', who: 'user', ask: 'company_research', value, said: t.slice(0, 200) }), ...people() };
  },
  // The heads-up before the agenda's news searches: "go", "skip <companies>", or "skip the news". A company
  // skipped gets an empty news file (nothing looked up), so the agenda goes on without it.
  agenda_news: (v, c) => {
    const t = String(typeof v === 'object' && v ? v.answer || '' : v).trim();
    // The companies the heads-up named (the step as it is when the agenda is asked for).
    const listed = nextStep(context(c.slug, { agenda: true })).ask?.companies || [];
    const all = /^(skip|no|none|don'?t|not)\b/i.test(t) && !listed.some((co) => t.toLowerCase().includes(String(co).toLowerCase()));
    const some = all ? listed : /^(skip|leave out|not)\b/i.test(t) ? listed.filter((co) => t.toLowerCase().includes(String(co).toLowerCase())) : [];
    if (!some.length && !/^(yes|y|go|ok|sure|look)/i.test(t)) throw new Error('Say "go", "skip <companies>", or "skip the news".');
    for (const co of some) cli('event-outreach', ['agenda-news', '--event', c.slug, '--company', co, '--skipped'], c);
    return {
      ...ledger(c, {
        type: 'answered',
        who: 'user',
        ask: 'agenda_news',
        value: some.length ? `skip:${some.join('|')}`.slice(0, 200) : 'yes',
        said: t.slice(0, 200)
      }),
      ...(some.length ? { skipped: some } : {})
    };
  },
  // "skip review <ids|all>" lines send those drafts on unreviewed (their cards say so); the rest go to the gate.
  approve: (v, c) => {
    const t = gateWords(v, 'approval');
    if (EDIT_WITH_TEXT.test(t)) return editWithText(c, t);
    const lines = t
      .split(/[;\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
    const skips = lines.filter((x) => SKIP_REVIEW.test(x));
    const rest = lines.filter((x) => !SKIP_REVIEW.test(x));
    const skipped = skips.length ? skipReview(c, skips.join('; ')) : null;
    if (!rest.length) return skipped;
    const r = cli('event-outreach', ['gate', '--event', c.slug, '--answers', skips.length ? rest.join('\n') : t], c);
    return skipped ? { ...r, skipped_review: skipped.skipped_review } : r;
  },
  // A held or left-out draft after the approve step: by name only, one line per action ("approve c004",
  // "drop c007:2", "edit c009"). "all", "except" or a bare yes approves nothing here.
  approve_held: (v, c) => {
    const t = gateWords(v, 'approval');
    if (EDIT_WITH_TEXT.test(t)) return editWithText(c, t);
    const lines = t
      .split(/[;\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
    const ok = (l) => /^(approve|drop|edit)\s+c\d{3,}(:\d+)?(\s*,?\s*c\d{3,}(:\d+)?)*$/i.test(l);
    if (!lines.length || !lines.every(ok))
      throw new Error('Here a held draft is approved, dropped or edited by its id only: "approve c004", "drop c007:2", "edit c009". Nothing was saved.');
    // The gate approves by person ("c007" approves their held messages, past a critic fail): a message number on an
    // approval would read as one message, so it's refused and said.
    if (lines.some((l) => /^approve\b/i.test(l) && /c\d{3,}:\d+/.test(l)))
      throw new Error(
        'An approval names the person ("approve c007"), which approves all of their held messages; drop or edit takes a message number ("drop c007:2"). Nothing was saved.'
      );
    return cli('event-outreach', ['gate', '--event', c.slug, '--answers', lines.join('\n')], c);
  },
  // The user says not to wait for the critic: "skip review all", "skip review c004, c007:2".
  skip_review: (v, c) => skipReview(c, String(typeof v === 'object' && v ? v.said || v.answers || '' : v)),
  // Drafts stuck after three rewrites: "drop <ids>" or "edit <id>: …" go to the gate; "leave them for now" waits a day.
  stuck_drafts: (v, c) => {
    const t = gateWords(v, 'stuck-drafts').trim();
    if (EDIT_WITH_TEXT.test(t)) return editWithText(c, t);
    if (/^leave/i.test(t)) return { left: true };
    // Drop or edit by id only: a bare "ok" here would approve everything the gate can.
    const lines = t
      .split(/[;\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!lines.length || !lines.every((l) => /^(drop|edit)\s+c\d{3,}(:\d+)?(\s*,?\s*c\d{3,}(:\d+)?)*$/i.test(l)))
      throw new Error('Stuck drafts are dropped or edited by id ("drop c004", "edit c007:2"), or "leave them for now". Nothing was saved.');
    return cli('event-outreach', ['gate', '--event', c.slug, '--answers', lines.join('\n')], c);
  },
  // The edit the user asked for: "done" once the file is saved (it's saved as their own edit), the new text
  // itself, or "never mind".
  edit_draft: (v, c) => {
    const t = String(typeof v === 'object' && v ? v.said || v.text || '' : v).trim();
    const s = nextStep(context(c.slug, {}));
    if (s.ask?.id !== 'edit_draft') throw new Error("floorboss isn't waiting for an edit right now. Run flow next.");
    const { id, touch } = s.ask.person;
    if (/^(never ?mind|cancel|leave it|no|skip)\b/i.test(t)) return { left_as_is: `${id}${touch > 1 ? `:${touch}` : ''}` };
    if (!/^(done|saved|ok|finished|edited)\b\W*$/i.test(t) && t) writeText(s.ask.file, withSubject(s.ask.file, t));
    return cli('event-outreach', ['save-draft', '--event', c.slug, '--id', id, '--touch', String(touch), '--md-file', s.ask.file], c);
  },
  outcomes: (v, c) =>
    typeof v === 'object' && v.items
      ? cli('event-outreach', ['record', '--event', c.slug, '--file', writeWork(c, 'record.json', v)], c)
      : cli('event-outreach', ['status', '--event', c.slug, '--none', '--said', String(v)], c),
  voice_samples: (v, c) =>
    isNo(v)
      ? ledger(c, { type: 'answered', who: 'user', ask: 'voice_samples', value: 'skipped' })
      : cli(
          'event-outreach',
          ['voice-save', '--event', c.slug, '--file', writeWork(c, 'voice-samples.json', typeof v === 'object' ? v : { samples: [{ body: String(v) }] })],
          c
        ),
  rate_notes: (v, c) => {
    const yes = /^\s*(yes|every|all|apply)/i.test(String(typeof v === 'object' && v ? v.answer || '' : v));
    if (yes) {
      const notes = nextStep(context(c.slug, {})).ask?.notes || [];
      cli(
        'event-outreach',
        [
          'revise',
          '--event',
          c.slug,
          '--all',
          '--rule',
          '--feedback-file',
          writeWorkText(c, 'rate-notes.txt', `From your notes on the rated drafts: ${notes.join('; ')}`)
        ],
        c
      );
    }
    // "Only the ones I rated": each draft with a note goes back to its own note (rated 3 or less, it went back
    // when it was rated); the drafts without one stay as they are.
    const sentBack = [];
    if (!yes) {
      const entries = readLedger(c.event.paths.ledger).entries;
      const st = fold(entries);
      const noted = new Map();
      for (const x of entries) if (x.type === 'copy_rating' && x.note && asRule(x.note) && x.rating > 3) noted.set(`${x.id}:${x.touch ?? 1}`, x);
      for (const [k, x] of noted) {
        const t = st.people[x.id]?.touches?.[x.touch ?? 1];
        if (!t || t.hash !== x.hash || t.sent || t.revising || (t.approved && t.approved.hash === t.hash)) continue;
        cli(
          'event-outreach',
          [
            'revise',
            '--event',
            c.slug,
            '--ids',
            k,
            '--feedback-file',
            writeWorkText(c, `rate-note-${x.id}-${x.touch ?? 1}.txt`, `Your note on this draft in the blind ratings: ${x.note}`)
          ],
          c
        );
        sentBack.push(k);
      }
    }
    return { ...ledger(c, { type: 'answered', who: 'user', ask: 'rate_notes', value: yes ? 'all' : 'rated only' }), ...(yes ? {} : { sent_back: sentBack }) };
  },
  rate: (v, c) => cli('event-outreach', ['rate', '--event', c.slug, '--text-file', writeWorkText(c, 'ratings.txt', typeof v === 'object' ? v.text : v)], c),
  // Whether an unclear send went, from the user's look in Sent.
  send_outcome: (v, c) => {
    const o = typeof v === 'object' && v ? v : { said: String(v) };
    const text = String(o.went ?? o.said ?? '').trim();
    // Only a clear answer settles it: "it went" or "it did not go". Anything else is asked again.
    const went = /^(yes|y|it went|went|sent|it'?s there|it is there|found it|it is in (my )?sent|in sent)\b/i.test(text)
      ? 'yes'
      : /^(no|n|it did ?n.?t go|did ?n.?t go|not sent|not there|it'?s not there|not in sent)\b/i.test(text)
        ? 'no'
        : null;
    if (!went) throw new Error('Ask again: did it go? Answer "it went" or "it did not go" after looking in Sent; "not sure" can\'t be settled.');
    // The person this step is about: the first send that may or may not have gone, from the ledger.
    const st = fold(readLedger(c.event.paths.ledger).entries);
    const u = Object.entries(st.people).flatMap(([id, p]) =>
      Object.entries(p.touches)
        .filter(([, x]) => x.released && !x.sent && !x.release_cleared)
        .map(([t]) => ({ id, touch: Number(t) }))
    )[0];
    if (!u) throw new Error('No send is waiting to be settled.');
    return cli(
      'event-outreach',
      ['send-outcome', '--event', c.slug, '--id', u.id, '--touch', String(u.touch), '--went', went, '--said', String(o.said || text).slice(0, 200)],
      c
    );
  },
  // A tool that stopped answering: retry (it's back), skip it, stop for now, or (the CRM) an export instead.
  tool_down: (v, c) => {
    const o = typeof v === 'object' && v ? v : { answer: String(v) };
    // The tool this is about: the one named, else the one that failed last.
    const failed = Object.entries(fold(readLedger(c.event.paths.ledger).entries).tool_failed).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at));
    const task = String(o.task || failed[0]?.[0] || '');
    if (!task) throw new Error('No tool has failed: nothing to retry.');
    const a = String(o.answer || '').trim();
    if (/^retry|^back|^try again|reconnected/i.test(a)) return cli('event-outreach', ['tool-back', '--event', c.slug, '--task', task, '--said', a], c);
    if (/^later|^not now|^stop/i.test(a))
      return ledger(c, { type: 'answered', who: 'user', ask: 'tool_down', value: 'later', said: a.slice(0, 200), task, run: sessionRun() || null });
    if (['email.messages', 'crm.activity'].includes(task) && /ask me|instead|myself|i'?ll (say|tell)/i.test(a))
      return ledger(c, { type: 'answered', who: 'user', ask: 'reader_fallback', value: 'user', said: a.slice(0, 200), task });
    // Running without the CRM is confirmed in a step of its own, after the warning.
    if (task === 'crm.lookup' && /independ|without (the |my )?crm|^skip|^without/i.test(a))
      return ledger(c, { type: 'answered', who: 'user', ask: 'crm_choice_after_failure', value: 'independent_pending', said: a.slice(0, 200) });
    if (/^skip|^without|^no\b/i.test(a)) {
      const flag = task === 'crm.lookup' ? 'crm_lookup_skipped' : task === 'email.history' ? 'mail_history_skipped' : null;
      if (!flag) throw new Error(`"skip" isn't an answer for ${task}: say retry or later.`);
      return answers(c, { [flag]: true });
    }
    if (task === 'crm.lookup' && /\.(csv|tsv|txt)$/i.test(a)) {
      const r = cli('crm-triage', ['inputs', '--event', c.slug, '--kind', 'crm', '--file', pathOf(a)], c);
      return { ...r, ...answers(c, { crm_lookup_skipped: true, crm_path: r.saved_as }) };
    }
    throw new Error('Say retry, later, "run independently", or give the path to a CRM export.');
  },
  // After the warning: run without the CRM, confirming each person (safer) or going ahead; or go back.
  crm_independent: (v, c) => {
    const a = String(typeof v === 'object' && v ? v.answer || v.said || '' : v).trim();
    if (/go back|^back|^no\b|retry|export/i.test(a))
      return ledger(c, { type: 'answered', who: 'user', ask: 'crm_choice_after_failure', value: 'back', said: a.slice(0, 200) });
    const mode = /confirm|each|safe|myself/i.test(a) ? 'confirm_each' : /go ahead|proceed|without confirming|^yes|independently/i.test(a) ? 'go_ahead' : null;
    if (!mode) throw new Error('Say "confirm each person", "go ahead", or "go back".');
    ledger(c, { type: 'answered', who: 'user', ask: 'crm_independent', value: mode, said: a.slice(0, 200) });
    return answers(c, { crm_lookup_skipped: true });
  },
  // People per company by size: the scale named, or the user's own numbers.
  company_caps: (v, c) => {
    if (typeof v === 'object' && v) return config(c, { company_caps: v });
    const t = String(v).toLowerCase();
    const own = parseScale(t);
    const mode = /^one|one per|1 per/.test(t)
      ? 'one'
      : /more|teams|whole team|several/.test(t)
        ? 'teams'
        : /no (cap|limit)|off|any number/.test(t)
          ? 'off'
          : 'scale';
    // Numbers the user gave ("one per company, but 3 at enterprises") are used as given; else the scale named.
    const cc = !/^by company size/.test(t) && own ? { scale: own } : { mode };
    const r = config(c, { company_caps: cc });
    // Read back what was understood, so a misread is caught now.
    const sc = cc.scale || SCALES[cc.mode] || null;
    return {
      ...r,
      understood: sc
        ? `1-10 people: ${sc.micro}, 11-50: ${sc.small}, 51-500: ${sc.mid}, 501-5,000: ${sc.large}, over 5,000: ${sc.enterprise}, size unknown: ${sc.unknown}`
        : 'no limit per company'
    };
  },
  // The user's go-ahead to send in the event app now: opens floorboss's 20-minute browser send window.
  app_send_window: (v, c) => {
    const said = String(typeof v === 'object' && v ? v.said || v.answer || '' : v).trim();
    if (!windowYes(said)) return ledger(c, { type: 'answered', who: 'user', ask: 'app_send_window', value: 'not now', said: said.slice(0, 200) });
    return cli('event-outreach', ['browser-send', '--event', c.slug, '--said', (said.length < 3 ? `${said} (yes)` : said).slice(0, 200)], c);
  },
  // Whether an unconfirmed app note went, from the user's look at the app's sent messages.
  app_outcome: (v, c) => {
    const o = typeof v === 'object' && v ? v : { said: String(v) };
    const t = String(o.went ?? o.said ?? '').trim();
    const went = /^(yes|it went|went|sent|it'?s there)\b/i.test(t) ? 'yes' : /^(no|it did ?n.?t go|not sent|not there)\b/i.test(t) ? 'no' : null;
    if (!went) throw new Error('Ask again: did the note go? "it went" or "it did not go".');
    const st = fold(readLedger(c.event.paths.ledger).entries);
    const u = Object.entries(st.people).flatMap(([id, p]) =>
      Object.entries(p.touches)
        .filter(([, x]) => x.app_result?.result === 'failed' && !x.sent)
        .map(([tt]) => ({ id, touch: Number(tt) }))
    )[0];
    if (!u) throw new Error('No app note is waiting to be settled.');
    if (went === 'yes')
      cli(
        'event-outreach',
        ['app-result', '--event', c.slug, '--id', u.id, '--touch', String(u.touch), '--result', 'sent', '--said', String(o.said || t).slice(0, 200)],
        c
      );
    return ledger(c, { type: 'answered', who: 'user', ask: 'app_outcome', value: went, said: String(o.said || t).slice(0, 200) });
  },
  approve_round: (v, c) => {
    const o = typeof v === 'object' && v ? v : { said: String(v) };
    if (isNo(o.said || '')) return ledger(c, { type: 'answered', who: 'user', ask: 'approve_round', value: 'not now', said: String(o.said).slice(0, 200) });
    return cli(
      'event-outreach',
      [
        'approve-round',
        '--event',
        c.slug,
        '--touch',
        String(o.touch || 2),
        '--said',
        String(o.said || 'yes'),
        ...(o.ids?.length ? ['--ids', o.ids.join(',')] : [])
      ],
      c
    );
  },
  // Saved, then the card is worked out again, so the "wait for your OK" line goes.
  crm_accounts: (v, c) => {
    const r = config(c, { crm_accounts: /^(no|off)/i.test(String(v)) ? 'off' : 'apply' });
    if (c.slug) cli('crm-triage', ['view', '--event', c.slug], c);
    return r;
  },
  // What came in since the last run, asked when nothing connected can read replies: "none", or "recorded" once
  // Claude has recorded what the user said (outreach record). Anything else is a report not recorded yet.
  replies_since: (v, c) => {
    const a = String(typeof v === 'object' && v ? v.answer || v.said || '' : v).trim();
    const from = typeof v === 'object' && v ? Number(v.ledger_lines) : NaN;
    const value = /^(none|nothing( new| came in)?|no( replies| one)?|nope|nobody|not yet|none yet)[.!]?$/i.test(a)
      ? 'none'
      : /^recorded\b/i.test(a)
        ? 'recorded'
        : null;
    if (!value)
      throw new Error(
        'Record what they told you first: write it as items and run outreach record (the event-outreach skill, "Recording what happened"), read the recorded lines back, then answer "recorded". If nothing came in, answer "none".'
      );
    // "recorded" stands only on a record actually made after the question was shown: something outreach record
    // wrote past the step's ledger_lines.
    if (value === 'recorded') {
      if (!Number.isInteger(from) || from < 0)
        throw new Error('Answer {"answer":"recorded","ledger_lines":<the number the step gave>}, after running outreach record.');
      if (
        !readLedger(c.event.paths.ledger)
          .entries.slice(from)
          .some((x) => x.via === 'user' && x.type !== 'answered')
      )
        throw new Error(
          'Nothing was recorded since the question was shown. Write what they told you as items, run outreach record, read the recorded lines back, then answer "recorded".'
        );
    }
    return ledger(c, { type: 'answered', who: 'user', ask: 'replies_since', value, said: a.slice(0, 200), run: sessionRun() || null });
  },
  no_reply: (v, c, s) => {
    const o = typeof v === 'object' ? v : null;
    // Several people at once: everyone the step listed and the user didn't name had no reply.
    if (o && !o.id && (o.none || o.replied || o.stopped || Array.isArray(o.people))) {
      const said = String(o.said || (o.none ? 'none' : '')).slice(0, 200);
      const named = new Set([...(o.replied || []), ...(o.stopped || [])].map(String));
      for (const id of o.stopped || []) ledger(c, { type: 'stop', who: 'user', id: String(id), said });
      for (const id of o.replied || []) ledger(c, { type: 'replied', who: 'user', id: String(id), source: 'user', said });
      const listed = (o.people || s?.ask?.people || []).map((p) => String(p.id || p)).filter((id) => !named.has(id));
      return listed.length ? ledger(c, { type: 'no_reply_said', who: 'user', ids: listed, said: said || 'none of these replied' }) : { recorded: named.size };
    }
    if (!o?.id)
      throw new Error(
        'The answer is {"id","answer","said"}, or for several people {"none":true,"people":[ids]} / {"replied":[ids],"stopped":[ids],"people":[ids]}.'
      );
    const said = String(o.said || o.answer).slice(0, 200);
    if (/stop/i.test(o.answer)) return ledger(c, { type: 'stop', who: 'user', id: o.id, said });
    if (/replied|booked|yes/i.test(o.answer)) return ledger(c, { type: 'replied', who: 'user', id: o.id, source: 'user', said });
    return ledger(c, { type: 'no_reply_said', who: 'user', ids: [o.id], said });
  },
  list_short: (v, c) => ledger(c, { type: 'answered', who: 'user', ask: 'list_short', value: String(v).slice(0, 200) })
};

// The event an answer or setting is for, named every time: on the mock it goes to the mock's own files, never
// the user's setup; on a real event the run's session (which may still name the mock) is never consulted.
const forMock = (c) => (c.event?.event?.slug ? ['--for-event', c.event.event.slug] : []);
// The owner values the CRM read holds (every CRM file read for this event), as the CRM writes them.
function crmOwners(c) {
  const dir = c.event?.paths?.dir;
  if (!dir) return [];
  return [
    ...new Set(
      listSources(dir)
        .filter((m) => m.kind === 'crm')
        .flatMap((m) => m.owner_values || [])
        .map((x) => String(x).trim())
        .filter(Boolean)
    )
  ];
}
function answers(c, obj) {
  const f = writeWork(c, 'answer.json', obj);
  return cli('event-context', ['onboarding', '--answer-file', f, ...forMock(c)], c);
}
// The answer's output is what was saved, not the whole config.
function config(c, obj) {
  const f = writeWork(c, 'config.json', obj);
  cli('event-context', ['config', '--set-file', f, ...forMock(c)], c);
  return { saved_settings: obj };
}
function writeWorkText(c, name, text) {
  const dir = join(c.home, 'work');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = join(dir, name);
  writeText(f, String(text));
  return f;
}
function writeWork(c, name, obj) {
  const dir = join(c.home, 'work');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = join(dir, name);
  writeJson(f, obj);
  return f;
}
function ledger(c, e) {
  if (!c.event) throw new Error('No event yet.');
  return append(c.event.paths.ledger, e, c.now);
}
// The folder of the profile this event drafts from: the event's own (the mock keeps its profile inside its
// folder), else the user's profile. The mock's profile is never written for a real event, and a real profile is
// never written from the mock.
function profileDir(c, { start = false } = {}) {
  const ev = c.event?.event || c.ob?.ev || null;
  if (ev?.context_dir) return ev.context_dir;
  const own = (p) => (p && !/^mock-/.test(p) ? p : null);
  if (start && !own(c.cfg?.context_profile)) cli('event-context', ['onboarding-defaults'], c);
  const prof = own(readJson(join(c.home, 'config.json'), {}).context_profile) || own(c.cfg?.context_profile);
  return prof ? contextDir(prof) : null;
}
function writeProfile(c, name, md) {
  const base = profileDir(c, { start: true });
  if (!base) throw new Error('No profile yet: run flow next (it starts one once there is a goal).');
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeText(join(dir, 'SKILL.md'), name === 'voice' ? clearVoicePlaceholders(md) : md);
  return { written: join(dir, 'SKILL.md') };
}
function profileFile(c, name) {
  const base = profileDir(c);
  if (!base) throw new Error('No profile yet: run flow next (it starts one once there is a goal).');
  const path = join(base, name, 'SKILL.md');
  const template = readFileSync(join(ROOT, 'skills', 'event-context', 'templates', `${name}.md`), 'utf8');
  return { path, text: existsSync(path) ? readFileSync(path, 'utf8') : '', template };
}
const listSourceOnly = (v, c) =>
  answers(c, {
    list_source: /organiser|export/i.test(String(v)) ? 'export' : /own/i.test(String(v)) ? 'own' : /app|website|only in/i.test(String(v)) ? 'app' : 'none'
  });
function fileAnswer(c, v, kind, flags) {
  if (!isNo(v)) {
    if (!c.slug) throw new Error('No event yet: the file is given once the event exists.');
    const r = cli('crm-triage', ['inputs', '--event', c.slug, '--kind', kind, '--file', pathOf(v)], c);
    // The question is answered: the tree sees the file (crm_path, accounts_path, dnc_path).
    flags = { ...flags, [`${kind}_path`]: r.saved_as };
    const extra = typeof v === 'object' && v.account_cap != null ? { account_cap: v.account_cap } : null;
    if (extra) config(c, extra);
  }
  return answers(c, flags);
}
// The mapping answer: "ok", the corrected mapping (JSON, or the path of a file holding it), or the correction in
// words ("Lifecycle is the status column. Customer means customer, Open Deal is warm. There's no opt-out
// column."), read clause by clause by confirm-mapping --words: a clause it can't read refuses the whole answer,
// naming it, so a correction is never dropped while the mapping is marked confirmed.
function mapping(c, kind, v) {
  // "No opt-out column", said with the export (crm_export), counts here without being asked again.
  const none = kind === 'crm' && c.ob?.ans?.crm_opt_out_none ? ['--opt-out-none'] : [];
  if (typeof v === 'string' && /^\s*(ok|okay|looks right|looks good|yes|yep|accept|correct|that'?s right)\W*$/i.test(v))
    return cli('crm-triage', ['confirm-mapping', '--event', c.slug, '--kind', kind, '--accept', ...none, '--said', v.trim().slice(0, 200)], c);
  if (typeof v === 'object' && v)
    return cli(
      'crm-triage',
      ['confirm-mapping', '--event', c.slug, '--kind', kind, '--file', writeWork(c, `mapping-${kind}.json`, v), ...none, '--said', 'corrected'],
      c
    );
  const t = String(v).trim();
  if (/^[~./][^\n]*\.json$/i.test(t) && existsSync(expandHome(t)))
    return cli('crm-triage', ['confirm-mapping', '--event', c.slug, '--kind', kind, '--file', pathOf(t), ...none, '--said', 'corrected'], c);
  if (!t)
    throw new Error(
      `The answer is "ok", the correction in words, or the corrected mapping as JSON (a copy of ${join(c.event.paths.derived, `mapping-${kind}.json`)} with the fields changed). Nothing was saved.`
    );
  return cli(
    'crm-triage',
    [
      'confirm-mapping',
      '--event',
      c.slug,
      '--kind',
      kind,
      '--words-file',
      writeWorkText(c, `mapping-${kind}-words.txt`, t),
      ...none,
      '--said',
      t.slice(0, 200)
    ],
    c
  );
}
const SKIP_REVIEW = /^\s*(skip|no)\s+(the\s+)?(critic|review)\b/i;
// "edit c013: <the new text>": the draft is opened for editing as "edit c013" would, the text goes in its file
// and is saved as the user's own edit (floorboss never rewrites it; the critic still reads it).
const EDIT_WITH_TEXT = /^\s*edit\s+(c\d{3,})(?::(\d+))?\s*:\s*(\S[\s\S]*)$/i;
// A pasted text with no "Subject:" line keeps the draft's subject.
function withSubject(file, text) {
  if (/^\s*subject:/i.test(text)) return `${text.trim()}\n`;
  const old = existsSync(file) ? (/^subject:\s*(.*)$/im.exec(readFileSync(file, 'utf8')) || [])[1] : null;
  return `${old ? `Subject: ${old.trim()}\n\n` : ''}${text.trim()}\n`;
}
function editWithText(c, t) {
  const [, id, touch, text] = EDIT_WITH_TEXT.exec(t);
  const r = cli('event-outreach', ['gate', '--event', c.slug, '--answers', `edit ${id}${touch ? `:${touch}` : ''}`], c);
  const e = (r.to_edit || [])[0];
  if (!e) throw new Error(`${id} has no draft to edit. Nothing was saved.`);
  writeText(e.file, withSubject(e.file, text));
  const saved = cli('event-outreach', ['save-draft', '--event', c.slug, '--id', id, '--touch', String(e.touch), '--md-file', e.file], c);
  return { edited: id, file: e.file, ...saved };
}
function skipReview(c, said) {
  const t = said.trim();
  const ids = [...new Set(t.match(/\bc\d{3,}(?::\d+)?\b/g) || [])];
  const all = /\b(all|every|them|these)\b/i.test(t) && !ids.length;
  if (!ids.length && !all) throw new Error('Say "skip review all", or "skip review <ids>" (c004, c007:2).');
  // The words after the ids are the user's reason ("I know that's true, I was on that deal"): kept with the skip,
  // and as their note on the person.
  const last = ids[ids.length - 1];
  const because = last
    ? t
        .slice(t.lastIndexOf(last) + last.length)
        .replace(/^[\s,;:.\-–—]+/, '')
        .replace(/^(?:because|as|since)\s+/i, '')
        .trim()
    : '';
  return cli(
    'event-outreach',
    [
      'skip-review',
      '--event',
      c.slug,
      ...(all ? ['--all'] : ['--ids', ids.join(',')]),
      '--said',
      t.slice(0, 300),
      ...(because.length >= 3 ? ['--because', because.slice(0, 200)] : [])
    ],
    c
  );
}
// "c012 same-person crm:3; c020 reach because she asked" → decide entries.
// Check-these answers, saved as one batch (a reason may carry ; or ,): every line is read first, and one bad line
// saves nothing. An uncertain match is settled first (same person or not) inside decide-batch.
function decisions(c, v) {
  const text = Array.isArray(v) ? v.join('\n') : String(typeof v === 'object' ? v.text : v);
  const r = cli('crm-triage', ['decide-batch', '--event', c.slug, '--text', text], c);
  const res = readJson(join(c.event.paths.derived, 'resolved.json'), {});
  // Only what was settled is called saved: an answer that settled nobody else says so.
  const rest = Math.max(0, (r.decided || 0) - r.still_unsettled?.length);
  if (r.still_unsettled?.length)
    throw new Error(
      `Still unsettled: ${r.still_unsettled.map((id) => `${id} (${String(res[id]?.says || '').slice(0, 90)}: answer ${res[id]?.rung === 'fuzzy' ? (/gave no answer/.test(res[id]?.says || '') ? `"${id} not-in-crm" if the CRM has nobody for them (or look them up in it)${/; /.test(res[id]?.says || '') ? `, and "${id} same-person crm:<row>" or "${id} different-person" for the rest` : ''}` : `"${id} same-person crm:<row>" or "${id} different-person"`) : `"${id} reach|warm|skip because <why>"`})`).join('; ')}. ${rest ? `The rest (${rest}) were saved.` : 'Nothing else was saved.'}`
    );
  return {
    decided: r.decided,
    groups: r.groups,
    ...(r.not_in_check ? { not_in_check: r.not_in_check } : {}),
    ...(r.refused ? { refused: r.refused } : {}),
    ...(r.tell_user ? { tell_user: r.tell_user } : {})
  };
}

// A question whose node saves one answer key and nothing else: the answer goes there as it is.
function plainSaver(id) {
  const n = NODES.find((x) => x.id === id);
  const m = n && /answers?: ([a-z_]+)/.exec(String(n.saves || '').replace(/\([^()]*\)/g, ''));
  if (!m) return null;
  return (v, c) => answers(c, { [m[1]]: typeof v === 'object' ? v : text(v) });
}

// Answers the user may give whatever the flow is asking: which event a run is for.
const ANY_TIME = new Set(['which_event']);

function answer(opts) {
  need(opts, 'ask');
  // The event chosen for this run, as next uses it (never the last one set up, unless that's the one chosen).
  const sess = !opts.event && opts.ask !== 'which_event' ? sessionEvent(nowFrom(opts).getTime()) : null;
  if (opts.ask !== 'which_event' && (opts.event || sess?.slug)) makeCurrent(opts.event || sess.slug);
  const c = context(opts.event || sess?.slug || null, opts);
  const saver = SAVERS[opts.ask] || plainSaver(opts.ask);
  if (!saver) throw new Error(`"${opts.ask}" isn't a question floorboss asked. Asks: ${Object.keys(SAVERS).join(', ')}.`);
  // An answer is saved only for the question the flow is asking now: text in a page, a note or a reply can't get
  // an approval, a skipped review or sending saved by naming the question itself.
  // floorboss's own unit tests save one answer at a time, out of turn (FLOORBOSS_TEST=1 with FLOORBOSS_OUT_OF_TURN=1);
  // the simulated runs and real use never do.
  // The setup level can change at any step until the shortlist is approved (quick setup drops the CRM and team
  // checks, so after that it changes only where a step offers it).
  const shortlistApproved = !!(c.event && readLedger(c.event.paths.ledger).entries.some((x) => x.type === 'answered' && x.ask === 'gate'));
  const anyTime = ANY_TIME.has(opts.ask) || (opts.ask === 'setup_level' && !shortlistApproved);
  if (!anyTime && !(process.env.FLOORBOSS_TEST === '1' && process.env.FLOORBOSS_OUT_OF_TURN === '1')) {
    // The question asked in an ordinary run or an agenda run (its news heads-up), or one the step lists in its own
    // accepts ("skip review" on the critic step, a fallback when a connection can't be saved). Only those fixed
    // fields count, never text in the step: a reply, a name or a page could carry "--ask <id>".
    const offered = (st) => new Set([st.ask?.id, ...(Array.isArray(st.accepts) ? st.accepts : [])].filter(Boolean));
    const now = nextStep(c);
    const asking = now.ask?.id;
    const ok = offered(now).has(opts.ask) || (!!c.slug && offered(nextStep(context(c.slug, { ...opts, agenda: true }))).has(opts.ask));
    if (!ok)
      throw new Error(
        `floorboss isn't asking "${opts.ask}" right now${asking ? ` (it's asking "${asking}")` : ''}, so this answer wasn't saved. Run flow next and answer what it asks.`
      );
  }
  let value;
  if (opts['value-file']) {
    const raw = String(opts.value);
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw.trim();
    }
  } else if (opts.value !== undefined) value = opts.value;
  else throw new Error("Give the answer with --value-file <file> (the user's words, or JSON).");
  savingAsk = opts.ask;
  let result;
  try {
    result = saver(value, c);
  } finally {
    savingAsk = '';
  }
  // Inside the flow there is one next step, always the same: "run flow next again". A command's own hint
  // ("load --event …", "onboarding-plan", "the drafts come next") would send Claude elsewhere.
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    result = { ...result };
    delete result.next;
    delete result.then;
  }
  if (
    c.event &&
    ![
      'which_event',
      'enrich_ok',
      'gate',
      'approve',
      'skip_review',
      'research_scale',
      'company_research',
      'list_short',
      'check_these',
      'tool_down',
      'replies_since',
      'crm_independent',
      'send_outcome',
      'approve_round',
      'app_send_window',
      'crm_log_window',
      'app_outcome',
      'crm_contacts'
    ].includes(opts.ask)
  ) {
    try {
      append(c.event.paths.ledger, { type: 'answered', who: 'user', ask: opts.ask, value: typeof value === 'string' ? value.slice(0, 300) : value }, c.now);
    } catch {
      /* onboarding answers before the event exists live in onboarding.json */
    }
  }
  return { saved: opts.ask, result, next: 'run flow next again' };
}

function ids(opts) {
  return { asks: Object.keys(SAVERS), onboarding_questions: NODES.map((n) => n.id) };
}

run({ next, answer, asks: ids });
