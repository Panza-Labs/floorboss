// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Savers for the questions about tools and data: coworkers' contacts, the inbox, the CRM (reading, logging,
// new contacts), do-not-contact lists, connections, the mailbox, the calendar, where the attendee list is,
// and looking up contact details.
import { withLock } from '../../../../lib/lock.mjs';
import { lookupCount } from '../../../../lib/normalize.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { allowedPath, expandHome } from '../../../../lib/paths.mjs';
import { readJson, writeJson } from '../../../../lib/jsonio.mjs';
import { context, nextStep } from '../steps.mjs';
import { readUrl, listFileProblem } from '../../../../lib/security.mjs';
import { saysNoOptOut } from '../../../crm-triage/scripts/mapping-words.mjs';
import { ownerMatch } from '../../../../lib/names.mjs';
import { parseRoute } from '../../../../lib/route.mjs';
import { parseGap, gapWords } from '../../../../lib/spacing.mjs';
import { approvedDays, gapNote } from './gap.mjs';
import { crmOwners, config, answers, ledger, windowYes, cli, isNo, fileAnswer, writeWorkText, namedFile, pathOf, writeWork, listSourceOnly } from './helpers.mjs';

export const TOOLS_SAVERS = {
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
  message_route: (v, c) => {
    const t = String(Array.isArray(v) ? v.join(',') : v).toLowerCase().replace(/\([^)]*\)/g, '').trim();
    // Marked asked only once it saved: an answer it can't read is asked again.
    const saved = config(c, { route: parseRoute(t) });
    answers(c, { message_route_asked: true });
    return saved;
  },
  // The days between follow-ups, in the user's words ("3 days", "a week apart", "2 days, then 5", "the default"). One
  // it can't read as whole days from 1 to 14 is refused with what to type, and the question stays open.
  // It's the user's setting for every event (like the route); the answer names each approved follow-up it moves.
  followup_gap: (v, c) => {
    const gap = parseGap(v);
    const before = approvedDays(c);
    const saved = config(c, { followup_gap: gap });
    answers(c, { followup_gap_asked: true });
    const note = gapNote(c, gap, before, approvedDays(c));
    // Said back whole: what was saved, and every approved follow-up it moves or drops.
    return { ...saved, followup_gap: gap ? gapWords(gap) : 'the default', note, say_to_user: note, show: 'Say say_to_user to the user as written.' };
  },
  crm_create_contacts: (v, c) => {
    const t = String(v).toLowerCase();
    const mode = /(?:^yes)|create them/.test(t) ? 'yes' : /ask/.test(t) ? 'ask' : /(?:^no)|list them/.test(t) ? 'no' : null;
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
  crm_fill_blanks: (v, c) => config(c, { crm_fill_blanks: /(?:^y)|fill/i.test(String(v)) && !/(?:^no)|don/i.test(String(v)) ? 'yes' : 'no' }),
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
    const n = /no wait|(?:^none)|(?:^0\b)|never mind|like anyone/.test(s)
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
  mailbox_use: (v, c) => answers(c, { mailbox_choice: /(?:^y)|yes/i.test(String(v)) ? 'yes' : 'no' }),
  known_contacts: (v, c) => {
    if (isNo(v)) return answers(c, { known_asked: true });
    const p = allowedPath(pathOf(v), { list: true });
    const bad = existsSync(p) ? listFileProblem(p, 0, 'known') : `${p} isn't there.`;
    if (bad) throw new Error(`${bad} Nothing was saved.`);
    const have = c.cfg.known_contacts_paths || [];
    config(c, { known_contacts_paths: [...new Set([...have, p])] });
    return answers(c, { known_asked: true });
  },
  calendar_use: (v, c) => answers(c, { calendar_choice: /(?:^y)|yes/i.test(String(v)) ? 'yes' : 'no' }),
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
};
