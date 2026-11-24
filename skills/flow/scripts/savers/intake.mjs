// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Savers for the guided intake (steps/intake.mjs): the two multi-selects, each pick's own step, the CRM check and
// the one-line summary.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readCsvText, toCsv, decode } from '../../../../lib/csv.mjs';
import { allowedPath, notSensitive, readChecked, expandHome } from '../../../../lib/paths.mjs';
import { listFileProblem } from '../../../../lib/security.mjs';
import { context, nextStep } from '../steps.mjs';
import { answers, cli, writeWork, writeWorkText, namedFile, pathOf, ledger } from './helpers.mjs';
import { readPicks, accountChoices, SHOW_CHOICES } from '../steps/intake.mjs';
import { connected } from '../../../../lib/harness.mjs';
import { readUrl } from '../../../../lib/security.mjs';
import { personName } from '../../../event-context/scripts/scan.mjs';

const said = (v) => String(typeof v === 'object' && v ? v.said || v.answer || v.url || v.path || '' : v ?? '').trim();
const asking = (c, id) => nextStep(context(c.slug, {})).ask?.id === id;
const refuseOutOfTurn = (c, id) => {
  if (!asking(c, id)) throw new Error(`floorboss isn't asking "${id}" right now, so this answer wasn't saved. Run flow next and answer what it asks.`);
};

export const INTAKE_SAVERS = {
  account_intake: (v, c) => {
    const offered = accountChoices(c.ob.ans || {});
    const picks = readPicks(v, offered).filter((x) => x !== 'none');
    if (!picks.length && !/^\s*(none|nothing|no|skip)\b/i.test(said(v)) && !(Array.isArray(v) && v.includes('none')))
      throw new Error(`Ask again: pick any of ${offered.map((x) => x.label).join(', ')}, or "none for now".`);
    const a = c.ob.ans || {};
    // A CRM not picked is off; picked again later, it's asked for afresh. But a CRM that is connected here (standard
    // and full setup) is not turned off by an unpicked item that reads as a question about voice: it keeps its checks
    // (opt-outs, coworkers' contacts, lost deals) and the tools question asks about it. The intake only adds sources.
    const connectedHere = (c.ob.inv?.found?.crm || []).length > 0 && connected() && a.setup_level !== 'quick';
    const crm = picks.includes('crm')
      ? a.crm_choice === 'none'
        ? { crm_choice: null, tools_confirmed: null }
        : {}
      : !a.crm_choice
        ? connectedHere
          ? {}
          : { crm_choice: 'none' }
        : {};
    return answers(c, { account_intake: picks.join(',') || 'none', crm_connect: null, crm_verify_missed: null, crm_verify_other: null, ...crm });
  },
  show_intake: (v, c) => {
    const picks = readPicks(v, SHOW_CHOICES);
    if (!picks.length && !/^\s*(none|nothing|no|skip)\b/i.test(said(v)))
      throw new Error(`Ask again: pick any of ${SHOW_CHOICES.map((x) => x.label).join(', ')}.`);
    return answers(c, { show_intake: picks.join(',') || 'none', intake_confirmed: false });
  },
  intake_website: (v, c) => {
    refuseOutOfTurn(c, 'intake_website');
    const t = said(v);
    const url = (/https?:\/\/\S+/.exec(t) || [])[0]?.replace(/[).,]+$/, '');
    if (!url) {
      if (/\bapp\b/i.test(t)) return answers(c, { intake_site: 'only in the app', list_source: c.event?.inputs?.attendees ? 'export' : 'app' });
      throw new Error('Ask again: the link to the page (starting https://), or "only in the app".');
    }
    // The link the user gave is the one page of the event's site let in for the list (as the list question's link).
    const u = readUrl(url, { ports: true });
    const host = (u?.host || '').replace(/^www\./, '');
    const page = u && !u.odd && u.host ? `${u.scheme}//${u.host}${u.port ? `:${u.port}` : ''}${u.path}` : null;
    if (c.event && host && t.toLowerCase().includes(host)) ledger(c, { type: 'site_allowed', who: 'user', host, said: t.slice(0, 300), ...(page ? { url: page } : {}) });
    // With a file or typed people as the list, the page is the event's site; on its own, the list is built from it.
    return answers(c, { intake_site: url, ...(c.event?.inputs?.attendees ? {} : { list_source: 'app', list_url: url }) });
  },
  intake_names: (v, c) => {
    refuseOutOfTurn(c, 'intake_names');
    return savePeople(v, c);
  },
  intake_material: (v, c) => {
    refuseOutOfTurn(c, 'intake_material');
    const t = said(v);
    const url = (/https?:\/\/\S+/.exec(t) || [])[0]?.replace(/[).,]+$/, '');
    const file = url ? null : namedFile(t, { bare: true });
    if (!url && !file) throw new Error('Ask again: the link to your site, or the name of the file in your show folder.');
    // A file is read only as floorboss reads any file: an allowed folder, no place that holds keys, a plain file.
    if (file) {
      const src = notSensitive(allowedPath(expandHome(file), { list: true }));
      readChecked(src, 20 * 1024 * 1024);
      return answers(c, { material_source: src });
    }
    return answers(c, { material_source: url });
  },
  // The CRM's tools as this session lists them (a scan with the session file), or the user's answer when they weren't
  // visible: check again, an export instead, or no CRM.
  crm_verify: (v, c) => {
    const a = c.ob.ans || {};
    if (typeof v === 'object' && v && (Array.isArray(v.tools) || Array.isArray(v.mcp))) {
      const f = writeWork(c, 'session.json', v);
      const r = cli('event-context', ['scan', '--session-file', f], c);
      const want = String(a.crm_connect || '').toLowerCase();
      // Only the CRM the user named counts. A different one that is visible is reported, and offered by name for a yes.
      const hit = (r.found?.crm || []).find((x) => personName(x).toLowerCase().includes(want));
      if (hit) {
        return { ...answers(c, { crm_choice: 'connector', crm_server: String(hit).replace(/^mcp:/, ''), crm_verify_missed: null, crm_verify_other: null }), say_to_user: `${a.crm_connect || personName(hit)} is visible here: floorboss connects it now. It reads it, and writes there only what you say yes to, each kind asked first.` };
      }
      const other = (r.found?.crm || [])[0];
      const otherName = other ? personName(other) : null;
      return {
        ...answers(c, { crm_verify_missed: true, crm_verify_other: other ? String(other).replace(/^mcp:/, '') : null }),
        say_to_user: `${a.crm_connect} isn't visible in this session yet.${otherName ? ` ${otherName} is, though: say "use ${otherName} instead" to check the list against it.` : ''}`
      };
    }
    const t = said(v).toLowerCase();
    // The other visible CRM, offered by name: connected only on the user's own yes to it.
    if (a.crm_verify_other && /^\s*(yes|y|ok|okay|sure)\b|\buse\b.*\binstead\b/.test(t) && !/export|csv|\bno\b/.test(t))
      return { ...answers(c, { crm_choice: 'connector', crm_server: a.crm_verify_other, crm_verify_missed: null, crm_verify_other: null }), say_to_user: `${personName(a.crm_verify_other)} is visible here: floorboss connects it now. It reads it, and writes there only what you say yes to, each kind asked first.` };
    if (/export|csv/.test(t)) return answers(c, { crm_choice: 'other', crm_label: `${a.crm_connect} (an export)`, crm_connect: null, crm_verify_missed: null });
    if (/\bno\b|none|without|skip/.test(t)) return answers(c, { crm_choice: 'none', crm_connect: null, crm_verify_missed: null });
    return answers(c, { crm_verify_missed: null });
  },
  intake_summary: (v, c) => {
    const t = said(v).toLowerCase();
    if (/^\s*(y|yes|yep|ok|okay|right|correct|sure|go|looks (right|good)|that'?s right)\b/.test(t) && !/change/.test(t)) return answers(c, { intake_confirmed: true });
    // Picked again: both questions come back (what's loaded stays loaded).
    return answers(c, { account_intake: null, show_intake: null, intake_confirmed: false, crm_connect: null, crm_verify_missed: null });
  }
};

// A list file the user named, read the way `crm-triage inputs` reads one: an allowed folder, no secret place, a list's
// kind and size, a plain file (no link at its end, not another account's in a shared temp folder).
function readListFile(p, kind) {
  const src = notSensitive(allowedPath(expandHome(p), { list: true }));
  const why = listFileProblem(src, 0, kind);
  if (why) throw new Error(why);
  return readChecked(src, 50 * 1024 * 1024, { raw: true });
}

// Typed people (or a CSV of them), saved as the attendee list, or added to the file already given in its own columns.
export function savePeople(v, c) {
    let people = [];
    const p = typeof v === 'string' ? namedFile(v, { bare: true }) || (existsSync(pathOf(v) || '') ? pathOf(v) : null) : null;
    if (p) people = readCsvText(readListFile(p, 'attendees')).records.map((r) => ({ name: r.Name || r.name, title: r.Title || r.title, company: r.Company || r.company, email: r.Email || r.email }));
    else if (typeof v === 'object' && v && Array.isArray(v.people)) people = v.people;
    else
      people = String(v)
        .split(/\n|;/)
        .map((l) => l.split(',').map((x) => x.trim()))
        .filter((x) => x[0])
        .map(([name, company = '', ...rest]) => ({ name, company, email: rest.find((x) => /@/.test(x)) || '' }));
    people = people.filter((x) => x && String(x.name || '').trim());
    if (!people.length) throw new Error('Ask again: name, company and email for each person, one per line.');
    // A file already given: the typed people are added to it, in its own columns.
    const att = c.event?.inputs?.attendees;
    const baseBuf = att && existsSync(att) ? readChecked(att, 50 * 1024 * 1024, { raw: true }) : null;
    const base = baseBuf ? readCsvText(baseBuf) : null;
    const headers = base?.headers?.length ? base.headers : ['Name', 'Title', 'Company', 'Email'];
    const col = (re) => headers.find((h) => re.test(h));
    const map = { name: col(/^(full )?name$/i), title: col(/title/i), company: col(/company|organi[sz]ation/i), email: col(/e-?mail/i) };
    const typed = people.map((x) => Object.fromEntries(headers.map((h) => [h, h === map.name ? x.name : h === map.title ? x.title || '' : h === map.company ? x.company || '' : h === map.email ? x.email || '' : ''])));
    // The user's own file is never re-written: its text is kept as it is and the typed people follow it, in its own
    // delimiter, so no column of its rows can move.
    const body = base ? decode(baseBuf).text.replace(/\s*$/, '\n') + toCsv(headers, typed, { header: false, delimiter: base.delimiter }) : toCsv(headers, typed);
    const f = writeWorkText(c, 'typed-attendees.csv', body);
    const r = cli('crm-triage', ['inputs', '--event', c.slug, '--kind', 'attendees', '--file', f], c);
    return { ...r, ...answers(c, { intake_names_done: true, ...(base ? {} : { list_source: 'own' }) }), typed: people.length };
  }
