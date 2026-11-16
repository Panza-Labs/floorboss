// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// What the savers share: running one of floorboss's commands for an answer, reading a yes or a no, writing
// work files and profile files, and the answers that take more than one line to save (a mapping, an edit, a
// skipped review, check-these decisions).
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { contextDir, expandHome } from '../../../../lib/paths.mjs';
import { readJson, writeJson, writeText } from '../../../../lib/jsonio.mjs';
import { ROOT, script, askedChannels } from '../steps.mjs';
import { append } from '../../../../lib/ledger.mjs';
import { crmOwnerList } from '../../../crm-triage/scripts/view.mjs';
import { DEFAULTS } from '../../../../lib/config.mjs';
import { clearVoicePlaceholders } from '../profile-write.mjs';

export const DEFAULT_OPTOUT = DEFAULTS.optout_sentence;

// A yes to opening a browser window (to log in the CRM, or send in the event app): 'yes' when the answer says yes and
// nothing in it defers or refuses ("send them later", "yes but not now" are a not-now), 'no' for a refusal or a
// deferral, and null for anything else, which is asked again rather than guessed.
const WINDOW_NO = /\b(no|not|nope|nah|later|tomorrow|tonight|skip|don'?t|do not|wait|stop|after|hold|never|cancel)\b/i;
const WINDOW_YES = /\b(y|yes|yeah|yep|yup|ok|okay|sure|go|go ahead|do it|log|send|ready|absolutely|please|now|done|logged in)\b/i;
const windowAnswer = (said) => {
  const t = String(said).replace(/[\u2018\u2019\u02bc]/g, "'");
  return WINDOW_NO.test(t) || /\b\w+n'?t\b/i.test(t) ? 'no' : WINDOW_YES.test(t) ? 'yes' : null;
};
export const windowYes = (said) => {
  const a = windowAnswer(said);
  if (a === null) throw new Error(`"${String(said).slice(0, 60)}" isn't a yes or a not-now: ask again (open it now, or not now).`);
  return a === 'yes';
};

// The answer being saved right now, so a setting only an answer may set (sending, own_email) can say which
// question it answers (FLOORBOSS_SAVED_BY on the command run for it).
let savingAsk = '';
// Sets it: answer() does, around the one saver it runs.
export function setSavingAsk(ask) {
  savingAsk = ask;
}
export function cli(skill, args, c) {
  const r = spawnSync(process.execPath, [script(skill), ...args], {
    encoding: 'utf8',
    env: { ...process.env, FLOORBOSS_NOW: c.now.toISOString(), FLOORBOSS_SAVED_BY: savingAsk }
  });
  // The command's own "floorboss: " is dropped: this answer's error gets one of its own.
  // The hint a gate ends a refusal with (can_interpret and the people by ID) is kept whole, apart from the cut.
  if (r.status !== 0) {
    const all = String(r.stderr || r.stdout).trim().replace(/^floorboss:\s*/, '');
    const at = all.indexOf('\ncan_interpret: true');
    const body = at >= 0 ? all.slice(0, at) : all;
    throw new Error(`${skill} ${args[0]}: ${body.slice(0, 1200)}${at >= 0 ? all.slice(at) : ''}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { raw: r.stdout };
  }
}

export const text = (v) => (typeof v === 'string' ? v.trim() : v);
// An example zone near the user: the event's own zone (or its region's), never one on another continent.
export const zoneExample = (c) => c.event?.event?.time_zone || 'Europe/Amsterdam or America/Chicago';
// A gate answer is the user's words. A JSON file that landed here instead (another question's answer file) is
// said for what it is, never read as the word "undefined".
// Marks a value as Claude's interpreted reading, set by flow answer --interpreted only: a JSON value file can't carry it.
export const INTERPRETED = Symbol('interpreted');
export const gateWords = (v, what) => {
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
export const namedFile = (t, { bare = false } = {}) => {
  const found = String(t || '').match(bare ? /(?:~\/|\/)[^\s"'`,;]+|[\w.-]+\.(?:csv|xlsx?|tsv)\b/gi : /(?:~\/|\/)[^\s"'`,;]+/g) || [];
  const hit = found.map((x) => x.replace(/[.)]+$/, '')).find((x) => existsSync(expandHome(x)));
  return hit ? expandHome(hit) : null;
};
// The people-research part of a research answer: "people: top 5", "and the people, none", "skip the people",
// "skip all research" (neither). Null when it says nothing about the people.
export const peopleScaleOf = (t) => {
  if (/\b(?:skip|no)\s+(?:all\s+(?:the\s+)?)?research\b|\bskip\s+(?:it\s+)?all\b|\bno research at all\b|\bskip everything\b/i.test(t)) return 'none';
  const m = /\b(?:people|persons?|attendees)\b\W*(?:research\W*)?(all|top|none|no|skip)\b/i.exec(t) || /\b(skip|no)\s+(?:the\s+)?people\b/i.exec(t);
  if (!m) return null;
  const w = m[1].toLowerCase();
  return w === 'all' ? 'all' : w === 'top' ? 'top' : 'none';
};
export const isNo = (v) => typeof v === 'string' && /^(none|no|skip|nothing|n\/a|-)$/i.test(v.trim());
// A path the user typed, with "~/" read as their home folder.
export const pathOf = (v) => expandHome(typeof v === 'string' ? v : v?.path || v?.file);

// What quick setup takes as given instead of asking, said back to the user when they choose it.
export const QUICK_ASSUMES =
  'Quick setup assumes you work alone (no coworkers\' contacts to hold back), with no CRM and no mailbox or contacts check (nobody is held as already known), and no writing samples (the tone comes from your sign-off and offer). It asks before any web research. Follow-ups are spaced by how far off the event is (7, 4 or 2 days apart); say "3 days between follow-ups" any time to set your own. Say "standard setup" any time to change it.';

// Savers by question id. Each takes (value, c) and does what the question's answer means.
// The user's word that nobody replied, once per channel the question named (askedChannels: the step's, never the answer's).
export function noReplySaid(c, s, ids, said) {
  let out;
  for (const channel of askedChannels(s)) out = ledger(c, { type: 'no_reply_said', who: 'user', ids, ...(channel ? { channel } : {}), said });
  return out;
}

// The event an answer or setting is for, named every time: on the mock it goes to the mock's own files, never
// the user's setup; on a real event the run's session (which may still name the mock) is never consulted.
export const forMock = (c) => (c.event?.event?.slug ? ['--for-event', c.event.event.slug] : []);
// The owner values of this event's CRM export, as the CRM writes them, in the order the crm_name question shows them:
// one function for the question and its answer (crm-triage view.mjs crmOwnerList).
export function crmOwners(c) {
  if (!c.event?.paths?.dir) return [];
  return crmOwnerList({ paths: c.event.paths, event: c.event.event });
}
export function answers(c, obj) {
  const f = writeWork(c, 'answer.json', obj);
  return cli('event-context', ['onboarding', '--answer-file', f, ...forMock(c)], c);
}
// The answer's output is what was saved, not the whole config.
export function config(c, obj) {
  const f = writeWork(c, 'config.json', obj);
  cli('event-context', ['config', '--set-file', f, ...forMock(c)], c);
  return { saved_settings: obj };
}
export function writeWorkText(c, name, text) {
  const dir = join(c.home, 'work');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = join(dir, name);
  writeText(f, String(text));
  return f;
}
export function writeWork(c, name, obj) {
  const dir = join(c.home, 'work');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = join(dir, name);
  writeJson(f, obj);
  return f;
}
export function ledger(c, e) {
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
export function writeProfile(c, name, md) {
  const base = profileDir(c, { start: true });
  if (!base) throw new Error('No profile yet: run flow next (it starts one once there is a goal).');
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeText(join(dir, 'SKILL.md'), name === 'voice' ? clearVoicePlaceholders(md) : md);
  return { written: join(dir, 'SKILL.md') };
}
export function profileFile(c, name) {
  const base = profileDir(c);
  if (!base) throw new Error('No profile yet: run flow next (it starts one once there is a goal).');
  const path = join(base, name, 'SKILL.md');
  const template = readFileSync(join(ROOT, 'skills', 'event-context', 'templates', `${name}.md`), 'utf8');
  return { path, text: existsSync(path) ? readFileSync(path, 'utf8') : '', template };
}
export const listSourceOnly = (v, c) =>
  answers(c, {
    list_source: /organiser|export/i.test(String(v)) ? 'export' : /own/i.test(String(v)) ? 'own' : /app|website|only in/i.test(String(v)) ? 'app' : 'none'
  });
export function fileAnswer(c, v, kind, flags) {
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
export function mapping(c, kind, v) {
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
export const SKIP_REVIEW = /^\s*(skip|no)\s+(the\s+)?(critic|review)\b/i;
// "edit c013: <the new text>": the draft is opened for editing as "edit c013" would, the text goes in its file
// and is saved as the user's own edit (floorboss never rewrites it; the critic still reads it).
export const EDIT_WITH_TEXT = /^\s*edit\s+(c\d{3,})(?::(\d+))?\s*:\s*(\S[\s\S]*)$/i;
// A pasted text with no "Subject:" line keeps the draft's subject.
export function withSubject(file, text) {
  if (/^\s*subject:/i.test(text)) return `${text.trim()}\n`;
  const old = existsSync(file) ? (/^subject:\s*(.*)$/im.exec(readFileSync(file, 'utf8')) || [])[1] : null;
  return `${old ? `Subject: ${old.trim()}\n\n` : ''}${text.trim()}\n`;
}
export function editWithText(c, t) {
  const [, id, touch, text] = EDIT_WITH_TEXT.exec(t);
  const r = cli('event-outreach', ['gate', '--event', c.slug, '--answers', `edit ${id}${touch ? `:${touch}` : ''}`], c);
  const e = (r.to_edit || [])[0];
  if (!e) throw new Error(`${id} has no draft to edit. Nothing was saved.`);
  writeText(e.file, withSubject(e.file, text));
  const saved = cli('event-outreach', ['save-draft', '--event', c.slug, '--id', id, '--touch', String(e.touch), '--md-file', e.file], c);
  // The gate says when this answer replaced a reading it was holding for a yes.
  return { edited: id, file: e.file, ...saved, ...(r.dropped_reading ? { note: 'The reading shown before was dropped, since this is a new answer.' } : {}) };
}
export function skipReview(c, said) {
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
export function decisions(c, v) {
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
