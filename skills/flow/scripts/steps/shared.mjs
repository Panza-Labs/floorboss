// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// What every phase uses to build a step: the step itself, the command line for one of floorboss's scripts,
// running one now, what to do when a connected tool fails, and the column-mapping step.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJson } from '../../../../lib/jsonio.mjs';
import { eventDir } from '../../../../lib/paths.mjs';
import { listSources, fingerprint, optOutSays } from '../../../crm-triage/scripts/sources.mjs';
import { readCsv } from '../../../../lib/csv.mjs';
import { TASKS } from '../../../connectors/scripts/tasks.mjs';
import { sessionRun } from '../../../../lib/scope.mjs';
import { script } from '../context.mjs';
import { connected } from '../../../../lib/harness.mjs';

export const TASK_FORMAT_ENRICH = TASKS['enrich.person'].format;
export const node = (skill, ...args) => ['node', script(skill), ...args];
export const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);

export function mappingConfirmed(e, kind) {
  const path = e.inputs[kind];
  if (!path) return null;
  const { headers } = readCsv(path);
  const fp = fingerprint(headers);
  const src = listSources(e.paths.dir).find((m) => m.fingerprint === fp);
  return src ? !!src.confirmed : false;
}

// The latest time an input was added, from the ledger.
export const lastInputAt = (e) => Math.max(0, ...e.entries.filter((x) => x.type === 'input_added').map((x) => Date.parse(x.at)));

export function cli(skill, args, c) {
  const r = spawnSync(process.execPath, [script(skill), ...args], { encoding: 'utf8', env: { ...process.env, FLOORBOSS_NOW: c.now.toISOString() } });
  if (r.status !== 0)
    throw new Error(
      `${skill} ${args[0]} failed: ${String(r.stderr || r.stdout)
        .trim()
        .replace(/^floorboss:\s*/, '')
        .slice(0, 400)}`
    );
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { raw: r.stdout };
  }
}

// The saved send recipe, so Claude calls exactly that tool with exactly those arguments (the guard checks it).
export const sendRecipe = (c) => {
  const r = c.cfg.connectors?.['email.send'];
  return r ? { server: r.server, tool: r.tool, mcp_name: `mcp__${r.server}__${r.tool}`, args: r.args } : null;
};
// "scheduled: each goes on its day…" is scheduled (it says "each" too); "I approve each round…" is each_round.
export const followupsModeOf = (v) => {
  const t = String(typeof v === 'object' && v ? v.mode || v.followups || '' : v).toLowerCase();
  // Asking first wins over any mention of "its day" ("never on its day automatically" means each round).
  if (/never .*(on its day|automatic)|not automatic|round|approve|ask me|before each|let me|myself|manual|in bulk|check (them|each) first/.test(t))
    return 'each_round';
  if (/(?:^\s*sched)|on its day|automatic|just send|go on (its|their) day/.test(t)) return 'scheduled';
  return null;
};
// What Claude runs when a connected tool's call fails: the error is recorded, and the next step says what to do.
// The tool's error text goes in a file Claude writes (never inside a shell command, where the shell could read it as
// more than a value): ERROR_FILE, then this command.
export const errorFile = (slug) => join(eventDir(slug), 'work', 'tool-error.txt');
export const onToolError = (slug, task) => node('event-outreach', 'tool-failed', '--event', slug, '--task', task, '--error-file', errorFile(slug));

// "later", said after the latest failure in this run, stops the run for now instead of asking again; the next
// run asks again.
export const toolDown = (e, task, what, options) =>
  e.state.answered.tool_down?.value === 'later' &&
  (!e.state.answered.tool_down.task || e.state.answered.tool_down.task === task) &&
  (e.state.answered.tool_down.run || null) === (sessionRun() || null) &&
  e.state.tool_failed[task] &&
  Date.parse(e.state.answered.tool_down.at) >= Date.parse(e.state.tool_failed[task].at)
    ? step('waiting', `Stopped for now: the ${what} isn't answering. Reconnect it, then run /floorboss:start again.`, { done: false })
    : step('tool_down', `The ${what} stopped answering (${String(e.state.tool_failed[task].error || 'no answer').slice(0, 120)}).`, {
        ask: {
          id: 'tool_down',
          task,
          question: `Your ${what} isn't answering. Reconnect it in Claude and say "retry"${options.includes('export') ? ', give a CRM export instead (the path)' : ''}${options.includes('skip') ? ', or say "skip" to go on without it' : ''}${options.includes('independent') ? ', or say "run independently" to go on without your CRM (you\'ll see what that risks before anything happens)' : ''}${options.includes('ask me') ? ', or say "ask me instead" and you\'ll be asked about each person\'s replies before their follow-up' : ''}${options.includes('later') ? ', or say "later" to stop here for now' : ''}.`,
          options,
          answer_format: '{"task":"' + task + '","answer":"retry | skip | later | <path>"}'
        }
      });
// Which answers settle a check: an uncertain match is settled by same-person / different-person; a question
// about whether to contact them (the customer rule, an unknown status, a vague title) by reach, warm or skip.
export const answersFor = (r) =>
  r.rung === 'fuzzy'
    ? [
        'same-person',
        'different-person',
        // A CRM lookup that gave no answer: the user says the CRM has nobody for them.
        ...(/gave no answer/.test(r.says || '') ? ['not-in-crm', 'not-in-crm reach|warm because <why> (on one line)'] : []),
        'skip',
        'same-person crm:<row> reach|warm because <why> (the match and the decision on one line)'
      ]
    : [...(r.holder || (r.alternatives || []).some((a) => a.holder) ? ['hold (leave them to their owner)'] : []), 'reach', 'warm', 'skip'];
// Every question with a fixed set of answers carries them as `choices` ({label, value, description}), `multi` and
// `other_allowed`, so the host shows them as buttons (Claude Code's AskUserQuestion) or a numbered list (Codex). The
// value is the option's own text: the answer is saved through flow answer exactly as before. An option that is a
// template for the user's own words ("my team too: <names>", "your own, like …") isn't a choice: other_allowed covers it.
const TEMPLATE = /<[^>]+>|^your own\b|^somewhere else\b/i;
const MULTI = new Set(['sending']);
export function choicesFrom(options) {
  const fixed = (options || []).filter((o) => typeof o === 'string' && o.trim() && !TEMPLATE.test(o));
  return fixed.map((o) => {
    const m = /^([^:]{1,40}):\s+(.+)$/s.exec(o);
    return m ? { label: m[1].trim(), value: o, description: m[2].trim() } : { label: o, value: o, description: '' };
  });
}
const header = (id) => {
  const w = String(id || '').replace(/^onboarding:/, '').replace(/_/g, ' ');
  const t = w.charAt(0).toUpperCase() + w.slice(1);
  return t.length <= 12 ? t : t.slice(0, 12).replace(/\s+\S*$/, '') || t.slice(0, 12);
};
function withChoices(ask) {
  if (!ask || typeof ask !== 'object' || ask.choices || !Array.isArray(ask.options)) return ask;
  const choices = choicesFrom(ask.options);
  if (choices.length < 2) return ask;
  return { ...ask, header: ask.header || header(ask.id), choices, multi: MULTI.has(ask.id) && choices.length > 2, other_allowed: true };
}
export const step = (id, why, action) => ({ step: id, why, ...action, ...(action?.ask ? { ask: withChoices(action.ask) } : {}) });
// Who the shortlist holds as floorboss reads it now (resolved.json: reach and warm), sorted: what the user said yes to
// at the shortlist, kept to compare with after a reloaded list.
export const shortlistIds = (derived) =>
  Object.entries(readJson(join(derived, 'resolved.json'), {}))
    .filter(([, r]) => ['reach', 'warm'].includes(r.group))
    .map(([id]) => id)
    .sort();
// Hand-send (Codex, or any program but Claude Code: lib/harness.mjs): a step's words name no Claude Code way of
// working (agents in parallel, a send floorboss makes, a slash command). Claude Code's own words stay as they are.
export const handSend = () => !connected();
// The user may decline the critic: their words are saved, and those drafts go to approval marked unreviewed.
export const SKIP_REVIEW_HINT = {
  answer: '"skip review all" or "skip review <ids>"',
  save: 'flow answer --ask skip_review --value-file <file with their words>',
  means: 'those drafts go to approval unreviewed, and their cards say "not reviewed"'
};

export function summaryOf(c, e) {
  try {
    return { summary: cli('event-outreach', ['summary', '--event', e.event.slug], c) };
  } catch (err) {
    return { summary_error: err.message };
  }
}

export function mappingStep(c, e, kind) {
  const json = join(e.paths.derived, `mapping-${kind}.json`);
  if (!existsSync(json) || mtime(json) < mtime(e.inputs[kind]))
    return step(`propose_mapping_${kind}`, `Work out what each column of the ${kind} file holds, with sample values, so the user can confirm it once.`, {
      run: node('crm-triage', 'propose-mapping', '--event', e.event.slug, '--kind', kind),
      show: ['reused_from']
    });
  // An attendee list whose headers say plainly what they are (Name, Title, Company, Email, LinkedIn: the list
  // floorboss wrote itself from a public page, or a plain export) is accepted without a question.
  // Headers compared as words ("profile_url" is "profile url"); a notes column is plain too (read as data).
  const PLAIN =
    /^(name|full name|first name|last name|title|job title|company|company name|organisation|organization|email|e-mail|email address|work email|linkedin|linkedin url|linkedin profile|profile url|notes?|location|country|city)$/i;
  if (kind === 'attendees' && (readCsv(e.inputs[kind]).headers || []).every((h) => PLAIN.test(String(h).trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' '))))
    return step(`map_columns_${kind}`, "The list's columns say plainly what they hold: accepted without asking.", {
      run: node('crm-triage', 'confirm-mapping', '--event', e.event.slug, '--kind', kind, '--accept', '--said', 'plain column names, accepted without asking')
    });
  const remembered = e.event.mock
    ? "it's remembered for this mock run only (never for your real events)"
    : "it's remembered for this layout, at this event and the next ones";
  return step(`map_columns_${kind}`, `The ${kind} file has a column layout floorboss hasn't seen before. Confirm what each column means once; ${remembered}.`, {
    show: [join(e.paths.derived, `mapping-${kind}.md`)],
    ask: {
      id: `map_columns_${kind}`,
      question: `Does this mapping look right? If not, say which column means what${kind === 'crm' ? `, and what each status means (warm, hold, coordinate, ignore, customer, lost, do_not_contact). Opt-outs: ${(c.ob.ans.crm_opt_out_none ? optOutSays({ ...readJson(json, {}), opt_out_none: true }).replace('you said there is none', 'you said so with the export; not asked again') : optOutSays(readJson(json, {}))).replace(/\.$/, '')}` : ''}.`,
      options: ['looks right', 'change something'],
      answer_format: `the word ok, the user's correction in their own words as they said it (floorboss reads "<column> is the <field> column", "<status value> means customer|warm|hold|lost|opted out|colleague|ignore", "ignore <column>", "there's no opt-out column", and refuses what it can't read), or the corrected mapping as JSON (a copy of ${json} with the fields changed; "ignore": ["<column>", …] leaves columns out), or "ignore <column>"`
    }
  });
}

// A reading a gate showed back and is holding for the user's yes (lib/reading.mjs): the question is that text, word
// for word, and the answer is the user's own, saved like any other.
// Judged by the gate itself, as a yes would judge it (the list, the time, the event): a stale reading is never shown.
const waitingText = (e, gate) => {
  const r = spawnSync(process.execPath, [script(gate === 'shortlist' ? 'crm-triage' : 'event-outreach'), 'gate', '--event', e.event.slug, '--pending-check', '--answers', 'check'], { encoding: 'utf8', env: process.env });
  try {
    const out = JSON.parse(r.stdout);
    return out.pending ? out.text : null;
  } catch {
    return null;
  }
};
export function pendingLine(e, gate) {
  const text = waitingText(e, gate);
  return text
    ? `A reading of the user's last answer is waiting for their yes. Show them exactly this, word for word, and wait for their own reply (never answer it for them): ${JSON.stringify(text)} If they say yes, save "yes"; if they say anything else, save that instead, as a new answer. `
    : '';
}
export const pendingAsk = (e, gate) => {
  const text = waitingText(e, gate);
  return text ? { pending_confirmation: text } : {};
};
