// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Savers for the questions between the list and the drafts: what to do with a reply, the attendee list and
// its columns, people to check, the shortlist, fit doubts, and research.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, appendLine } from '../../../../lib/jsonio.mjs';
import { context, nextStep } from '../steps.mjs';
import { skipNames, unclearSkip, skipReadBack } from '../../../../lib/names.mjs';
import { INTERPRETED, ledger, writeWork, writeWorkText, cli, pathOf, mapping, decisions, gateWords, isNo, peopleScaleOf } from './helpers.mjs';

export const SHORTLIST_SAVERS = {
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
  gate: (v, c) =>
    v && typeof v === 'object' && v[INTERPRETED]
      ? cli('crm-triage', ['gate', '--event', c.slug, '--answers', String(v.answers), '--interpreted', '--said-file', writeWorkText(c, 'interpreted-said.txt', v.said)], c)
      : cli('crm-triage', ['gate', '--event', c.slug, '--answers', gateWords(v, 'shortlist')], c),
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
    // "please skip Acme", "ok, skip Acme": read as the skip they are.
    const t = String(typeof v === 'object' && v ? v.answer || '' : v)
      .trim()
      .replace(/^(?:please|pls|ok|okay|so|alright|yes)(?![\p{L}\p{N}])[\s,]+(?=skip|leave out|not)/iu, '');
    if (unclearSkip(t)) throw new Error('Name the companies to skip ("skip Acme, Globex"), or say "skip all".');
    const listed = nextStep(context(c.slug, {})).ask?.companies || [];
    // The people question asked in the same breath ("go, and people: top 5", "skip all research"): saved too, so
    // it isn't asked again.
    const scale = peopleScaleOf(t);
    const people = () => {
      if (!scale || !c.event || c.event.state.answered.research_scale) return {};
      ledger(c, { type: 'answered', who: 'user', ask: 'research_scale', value: scale, said: t.slice(0, 200) });
      return { research_scale: scale };
    };
    const read = /^(skip|leave out|not)\b/i.test(t) ? skipNames(t, listed) : { named: [], unclear: false };
    // A company's name inside other words ("skip this step", with a company called Step) is asked again: read as a
    // list it would start web research on the others.
    if (read.unclear) throw new Error('Name the companies to skip as they are listed, with commas ("skip Acme, Globex"), or say "skip all".');
    // One company alone that could be a refusal word ("skip altogether", with a company called Altogether): read back.
    if (read.doubtful) throw new Error(skipReadBack(t, read.named[0], listed, 'skip all'));
    const some = read.named;
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
    const t = String(typeof v === 'object' && v ? v.answer || '' : v)
      .trim()
      .replace(/^(?:please|pls|ok|okay|so|alright|yes)(?![\p{L}\p{N}])[\s,]+(?=skip|leave out|not)/iu, '');
    // The companies the heads-up named (the step as it is when the agenda is asked for).
    if (unclearSkip(t)) throw new Error('Name the companies to skip ("skip Acme, Globex"), or say "skip all".');
    const listed = nextStep(context(c.slug, { agenda: true })).ask?.companies || [];
    // Only a skip names companies: "go for Acme and Globex" and "yes, especially Acme" are a go.
    const read = /^(skip|leave out|not)\b/i.test(t) ? skipNames(t, listed) : { named: [], unclear: false };
    if (read.unclear) throw new Error('Name the companies to skip as they are listed, with commas ("skip Acme, Globex"), or say "skip the news".');
    if (read.doubtful) throw new Error(skipReadBack(t, read.named[0], listed, 'skip the news'));
    const named = read.named;
    const all = /^(skip|no|none|don'?t|not)\b/i.test(t) && !named.length;
    const some = all ? listed : /^(skip|leave out|not)\b/i.test(t) ? named : [];
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
};
