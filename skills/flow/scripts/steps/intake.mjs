// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The guided intake: onboarding as buttons and fields. Two multi-selects, right after the event is known:
//   1. account setup, once per user and carried to every later show: what floorboss can learn from about their
//      business (a CRM, past emails that got replies, the company's site or sales material);
//   2. show setup, each show: who to reach there (an attendee file, the event's site or app, a few names).
// Each pick gets one targeted step; anything not picked asks nothing; a one-line summary ends it.
// The intake's answers are saved as text ("crm,emails"): picksOf reads them back. An answer saved before there was an
// intake (an older setup) leaves the old questions as they were: picksOf is null then.
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { planQuestions, NODES } from '../../../event-context/scripts/onboarding-tree.mjs';
import { readCsv } from '../../../../lib/csv.mjs';
import { connected } from '../../../../lib/harness.mjs';
import { step, node, handSend } from './shared.mjs';
import { withWhy } from './wording.mjs';
import { personName } from '../../../event-context/scripts/scan.mjs';

export const ACCOUNT_CHOICES = [
  { value: 'crm', label: 'A CRM', description: "HubSpot, Salesforce, Pipedrive or another: who's a customer, who you've talked to, who to leave alone" },
  { value: 'emails', label: 'Past emails', description: 'Emails you sent that got replies: they set your voice' },
  { value: 'material', label: 'Your site or material', description: 'Your company website, a deck or a one-pager: what you sell and your proof points' },
  { value: 'none', label: 'None for now', description: 'floorboss asks what it needs as it goes' }
];
export const SHOW_CHOICES = [
  { value: 'file', label: 'An attendee file', description: 'A CSV or Excel list of who is coming' },
  { value: 'website', label: "The event's site or app", description: 'A link to its attendee, exhibitor or speaker page' },
  { value: 'names', label: 'A few names', description: 'Just a few people to start: you type them' }
];
const WORDS = {
  crm: /\b(crm|hubspot|salesforce|pipedrive)\b/i,
  emails: /\b(e-?mails?|repl(y|ies|ied))\b/i,
  material: /\b(material|deck|one-?pager|company (web)?site|sales|proof|my site)\b/i,
  file: /\b(file|csv|excel|xlsx?|attendee list|spreadsheet)\b/i,
  website: /\b(web ?site|site|app|link|url|page)\b/i,
  names: /\b(names?|few|people|type)\b/i
};

// The picks as saved, or null when the question was never answered (an older setup).
export function picksOf(v) {
  if (v == null || v === '') return null;
  if (Array.isArray(v)) return v.map(String);
  const s = String(v).trim();
  if (s.startsWith('[')) {
    try {
      return JSON.parse(s).map(String);
    } catch {
      /* read as words */
    }
  }
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}
// The user's answer read as picks: the values themselves, the labels' words, or an array. Values not offered are dropped.
export function readPicks(v, offered) {
  const vals = offered.map((c) => c.value);
  const list = Array.isArray(v) ? v.map(String) : typeof v === 'object' && v ? [].concat(v.picks || v.values || []).map(String) : null;
  if (list) return vals.filter((x) => list.some((l) => l.trim().toLowerCase() === x || WORDS[x]?.test(l)));
  const t = String(v ?? '');
  if (/^\s*(none|nothing|no|skip)\b/i.test(t) && vals.includes('none')) return ['none'];
  if (/^\s*(none|nothing|no|skip)\b/i.test(t)) return [];
  // "the event's website" names a site but isn't the user's material; "past emails" isn't a file.
  return vals.filter((x) => x !== 'none' && (new RegExp(`(^|[\\s,])${x}([\\s,]|$)`, 'i').test(t) || (WORDS[x]?.test(t) && !(x === 'material' && /event/i.test(t)) && !(x === 'website' && WORDS.material.test(t) && !/event|show/i.test(t)))));
}

// What's offered: a CRM isn't read in quick setup, so it isn't offered there.
export const accountChoices = (ans) => (ans.setup_level === 'quick' ? ACCOUNT_CHOICES.filter((c) => c.value !== 'crm') : ACCOUNT_CHOICES);

// Done before there was an intake: an older setup went through the old questions (its sign-off was asked).
const olderSetup = (ans) => ans.about_you_asked === true && picksOf(ans.account_intake) === null;
export const accountPicks = (ans) => picksOf(ans.account_intake);
export const showPicks = (ans) => picksOf(ans.show_intake);
// The old questions are asked only where the intake wasn't (an older setup, or a list given before the intake).
export const intakeAnswered = (ans) => accountPicks(ans) !== null;

const ask = (id, why, a, extra = {}) =>
  step(`onboarding:${id}`, why, { ask: { ...a, question: withWhy(a.id, a.question) }, ...extra });

// The connector steps, said plainly: no link to the host's connector settings is known to floorboss.
const CONNECT_HOW =
  'To let floorboss read it here, connect it to Claude: in Claude (claude.ai or the desktop app) open Customize, then Connectors (claude.ai/customize/connectors), find your CRM and click Connect, and sign in. Then restart Claude Code (or run /mcp) so its tools show up here.';

// The intake's steps, in order, or null when it's done (or not asked: the mock, an older setup, no event yet).
export function intakeSteps(c, { mock }) {
  if (mock || !c.event) return null;
  const a = c.ob.ans || {};
  const e = c.event;
  // The setup level, the same-setup question and the event come first.
  const next = planQuestions(c.ob, { batch: 1, phase: 'first' }).questions[0]?.id;
  if (['setup_level', 'reuse_setup', 'inventory', 'event'].includes(next)) return null;
  const hasList = !!e.inputs.attendees;

  // 1. Account setup, once per user.
  const acc = accountPicks(a);
  if (acc === null && !olderSetup(a)) {
    return ask(
      'account_intake',
      'Once for your business, carried over to every later show: what floorboss can learn from. Each pick gets one short step; the rest is skipped.',
      {
        id: 'account_intake',
        header: 'Learn from',
        question: 'What can floorboss learn from about your business? Pick all that apply.',
        choices: accountChoices(a),
        multi: true,
        other_allowed: false,
        answer_format: 'the picks, as values or words ("crm, emails"), or "none"'
      }
    );
  }
  const picks = acc || [];
  // The CRM: which one, and where to connect it (or an export); then a check that its tools are visible here.
  if (picks.includes('crm') && a.setup_level !== 'quick' && !a.crm_choice) {
    if (a.crm_connect && connected()) {
      if (!a.crm_verify_missed) {
        const write = join(c.home, 'work', 'crm-verify.json');
        return step('crm_verify', `Check that ${a.crm_connect}'s tools are visible in this session before anything relies on it.`, {
          judge: {
            read: null,
            how: `Look at your tool list for ${a.crm_connect}'s tools (an MCP server whose name includes ${a.crm_connect}, tools named mcp__<server>__<tool>). Write every MCP tool name you have, as for the scan, then run then. Say in one line whether you can see ${a.crm_connect}.`,
            write,
            format: '{"tools": ["mcp__server__tool", …]} : every MCP tool name in this session\'s tool list; nothing else',
            then: node('flow', 'answer', '--event', e.event.slug, '--ask', 'crm_verify', '--value-file', write)
          },
          accepts: ['crm_verify']
        });
      }
      const otherName = String(a.crm_verify_other || '').replace(/^[a-z]+:/, '').replace(/^claude_ai_/i, '').replace(/_+/g, ' ').trim();
      return ask('crm_verify', `${a.crm_connect} isn't visible in this session yet.`, {
        id: 'crm_verify',
        header: 'CRM',
        question: `I can't see ${a.crm_connect} in this session yet. ${CONNECT_HOW} Then say "check again". Or use an export of it instead, or go on without a CRM for now.`,
        choices: [
          { value: 'check again', label: 'Check again', description: `I've connected ${a.crm_connect}` },
          ...(a.crm_verify_other
            ? [{ value: `use ${otherName} instead`, label: `Use ${otherName}`, description: `${otherName} is visible here: check the list against it instead` }]
            : []),
          { value: 'use an export instead', label: 'Use an export', description: 'A CSV export of your contacts' },
          { value: 'no CRM for now', label: 'No CRM for now', description: 'Nobody is checked against a CRM' }
        ],
        multi: false,
        other_allowed: false,
        answer_format: `"check again" | ${a.crm_verify_other ? `"use ${otherName} instead" | ` : ''}"use an export instead" | "no CRM for now"`
      });
    }
    // Found in the scan: which one to use (the tree's own question).
    // Found in the scan: the tree's own question (one confirm for every connected tool, or which CRM).
    if ((c.ob.inv?.found?.crm || []).length && connected()) return treeAsk(c, a.tools_confirmed === true ? 'crm_use' : 'tools');
    return ask('crm_where', 'The CRM tells floorboss who is a customer, who you already talk to and who to leave alone.', {
      id: 'crm_where',
      header: 'Your CRM',
      question: connected()
        ? `Which CRM do you use? ${CONNECT_HOW} Or give me an export of it (a CSV in your show folder) instead.`
        : 'Which CRM do you use? Export your contacts from it as a CSV (with owner, status and any opt-out field), put it in your show folder, and tell me its name.',
      choices: [
        { value: 'HubSpot', label: 'HubSpot', description: connected() ? 'Connect it in Claude, then I check it' : 'Export it as a CSV' },
        { value: 'Salesforce', label: 'Salesforce', description: connected() ? 'Connect it in Claude, then I check it' : 'Export it as a CSV' },
        { value: 'Pipedrive', label: 'Pipedrive', description: connected() ? 'Connect it in Claude, then I check it' : 'Export it as a CSV' },
        { value: 'an export (CSV) instead', label: 'An export', description: 'A CSV export of any CRM or spreadsheet' }
      ],
      multi: false,
      other_allowed: true,
      answer_format: "the CRM's name (another CRM is fine), or the export's file name"
    });
  }
  // An export named but not yet given: its file (the tree's question).
  if (picks.includes('crm') && ['export', 'spreadsheet', 'home-made', 'other'].includes(a.crm_choice) && !a.crm_path && !e.crm?.path && a.crm_export_skipped !== true && !e.inputs.crm)
    return treeAsk(c, 'crm_export');
  if (picks.includes('material') && !a.material_source)
    return ask('intake_material', 'What you sell and your proof points come from your own words: the site or deck is read, and the lines proposed to you.', {
      id: 'intake_material',
      header: 'Material',
      question: 'Paste the link to your company website, or put a deck or one-pager in your show folder and tell me its name.',
      answer_format: 'a link, or a file name or path'
    });

  // 2. Show setup, each show.
  const show = showPicks(a);
  // A list given before the intake (an older setup) skips it; picking again after the summary asks it again.
  if (show === null && ((!hasList && !a.list_source) || a.intake_confirmed === false))
    return ask('show_intake', 'Who to reach at this show. Each pick gets one short step.', {
      id: 'show_intake',
      header: 'Reach',
      question: 'Who do you want to reach at this show? Pick all that apply.',
      choices: SHOW_CHOICES,
      multi: true,
      other_allowed: false,
      answer_format: 'the picks, as values or words ("file, names")'
    });
  const sp = show || [];
  if (sp.includes('file') && !hasList && (!a.list_source || a.list_source === 'own'))
    return ask('list_source', 'floorboss picks who to write to from the list.', {
      id: 'list_source',
      header: 'Your file',
      question: 'Put the attendee file (CSV or Excel) in your show folder and tell me its name.',
      answer_format: 'the file name, or its path'
    });
  if (sp.includes('website') && !a.intake_site && !a.list_url)
    return ask('intake_website', "The event's page is read for the list: public pages only.", {
      id: 'intake_website',
      header: 'Event link',
      question: "Paste the link to the event's attendee, exhibitor or speaker page (or its app's page). If the list is only in the app once you log in, say so.",
      answer_format: 'a link, or "only in the app"'
    });
  if (sp.includes('names') && a.intake_names_done !== true)
    return ask('intake_names', 'A few people to start: typed in, saved as the attendee list.', {
      id: 'intake_names',
      header: 'Names',
      question: 'Type the people you want to reach: name, company and email for each, one per line (an email you don\'t have can be left out).',
      answer_format:
        '{"people":[{"name","company","email","title"?}]}, or the lines as they typed them ("Name, Company, email"), or the path of a CSV you wrote with the header Name,Title,Company,Email (invent nothing: no email means an empty Email)'
    });

  // 3. One line to confirm.
  if (a.intake_confirmed !== true) {
    const line = summaryLine(c, picks, sp);
    return ask('intake_summary', 'The intake in one line, to confirm before the questions about the show.', {
      id: 'intake_summary',
      header: 'Confirm',
      question: `${line} Right?`,
      choices: [
        { value: 'yes', label: "Yes, that's right", description: 'Go on' },
        { value: 'change something', label: 'Change something', description: 'Pick again' }
      ],
      multi: false,
      other_allowed: true,
      answer_format: '"yes", or "change something" (the picks are asked again)'
    });
  }
  return null;
}

// A tree question asked inside the intake, as the onboarding step asks it.
function treeAsk(c, id) {
  const n = NODES.find((x) => x.id === id);
  const s = { ans: {}, cfg: {}, ...c.ob };
  const options = n.options ? n.options(s) : undefined;
  return step(`onboarding:${id}`, `Intake: ${id.replace(/_/g, ' ')}.`, {
    ask: { id, question: n.ask(s), ...(options ? { options } : {}), answer_format: options ? "one of the options, or the user's own words" : "the user's words", saves: n.saves }
  });
}

export function summaryLine(c, picks, sp) {
  const a = c.ob.ans || {};
  const e = c.event;
  const have = [];
  const off = [];
  const rows = e.inputs.attendees && existsSync(e.inputs.attendees) ? readCsv(e.inputs.attendees).records.length : 0;
  if (picks.includes('crm'))
    have.push(
      a.crm_choice === 'connector'
        ? `${a.crm_server ? personName(a.crm_server) : a.crm_label || 'your CRM'}, connected: floorboss reads it, and writes there only what you say yes to, each kind asked first`
        : a.crm_choice === 'none'
          ? 'no CRM after all'
          : `your CRM export${e.inputs.crm ? ` (${basename(e.inputs.crm)})` : ''}`
    );
  else if (a.setup_level !== 'quick' && a.crm_choice !== 'none' && ((c.ob.inv?.found?.crm || []).length || a.crm_choice)) {
    // Connected here and not picked: still checked against (the tools question confirms it), never listed as off.
    have.push(a.crm_choice === 'connector' ? `${a.crm_server ? personName(a.crm_server) : 'your CRM'}, connected: floorboss reads it, and writes there only what you say yes to, each kind asked first` : 'your connected CRM (confirmed next)');
  } else if (a.setup_level !== 'quick') off.push('a CRM');
  if (picks.includes('emails')) have.push('past emails (asked for before the first drafts)');
  else off.push('past emails');
  if (picks.includes('material')) have.push(`your material (${String(a.material_source || '').slice(0, 80)})`);
  if (sp.includes('file') || a.list_source === 'export') have.push(rows ? `the attendee file (${rows} people)` : 'the attendee file (asked for next)');
  if (sp.includes('website')) have.push(`the event's page (${String(a.intake_site || a.list_url || 'only in the app').slice(0, 80)})`);
  if (sp.includes('names') && !sp.includes('file')) have.push(`${rows} ${rows === 1 ? 'person' : 'people'} you typed`);
  else if (sp.includes('names')) have.push('the people you typed, added to the file');
  return `So far: ${have.length ? have.join('; ') : 'nothing yet (you can type a few people at the list step)'}.${off.length ? ` Not using: ${off.join(', ')}.` : ''}`;
}
