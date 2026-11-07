#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Research: who to research, saving profiles, and the collection prompt.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { run, need } from '../../../lib/args.mjs';
import { readJson, writeText } from '../../../lib/jsonio.mjs';
import { companyFromSlug } from '../../../lib/normalize.mjs';
import { loadEvent, contextFor } from '../../../lib/event.mjs';
import { CONSTANTS } from '../../../lib/config.mjs';
import { parseSegments } from '../../event-context/scripts/context-check.mjs';
import { hasProfile, writeProfile, profileMeta } from './profiles.mjs';
import { estimate, pickForResearch } from './estimate.mjs';
import { collectPrompt } from './collect-prompt.mjs';
import { hasCompanyBrief, writeCompanyBrief, companyBriefPath, recentBriefElsewhere, resultFromMeta } from './companies.mjs';
import { stampRun } from '../../../lib/runlock.mjs';

function plan(opts) {
  need(opts, 'event');
  const { event, settings, paths } = loadEvent(opts.event);
  const triage = readJson(paths.triage, null);
  if (!triage?.ranked) throw new Error('Run the triage "fit" step first.');
  const store = readJson(paths.contacts);
  const byId = Object.fromEntries(store.contacts.map((c) => [c.id, c]));
  const warm = triage.ranked.filter((id) => triage.final[id]?.group === 'warm');
  const has = (id) => hasProfile(paths.dir, id);
  const choices = {
    all: pickForResearch(triage.ranked, { scale: 'all', has }),
    top: pickForResearch(triage.ranked, { scale: 'top', n: CONSTANTS.research_default_n, warm, has })
  };
  const scale = opts.scale;
  const n = Number(opts.n || opts.cap || CONSTANTS.research_default_n);
  const ids = scale ? pickForResearch(triage.ranked, { scale, n, warm, has }) : null;
  const segs = Object.fromEntries(parseSegments(contextFor(settings, event).whoToMeet || '').map((s) => [s.slug, s]));
  // Searches: a per-person budget, and batches small enough that no batch runs out halfway (one shared cap
  // hit mid-batch leaves the people after it thin). Batches run one after another.
  const perPerson = Math.max(3, Math.min(20, Number(settings.research_searches_per_person) || 10));
  const budget = Math.max(perPerson, Number(settings.research_search_budget) || 200);
  const batchSize = Math.max(1, Math.floor(budget / perPerson));
  const job = (id) => {
    const c = byId[id],
      seg = segs[triage.final[id]?.segment];
    return { id, name: c.name, title: c.title, company: c.company, segment: seg?.name || null, source_hints: seg?.sources || null, search_budget: perPerson };
  };
  return {
    already_have_profiles: triage.ranked.filter(has).length,
    options: {
      all: { ...estimate(choices.all.length), meaning: 'everyone shortlisted' },
      top: { ...estimate(choices.top.length), meaning: `warm contacts plus the top ${CONSTANTS.research_default_n}` },
      cap: { meaning: 'the first N in ranking order; run again for more' },
      none: { meaning: 'skip research; reasons come from role and company' }
    },
    searches_per_person: perPerson,
    ...(ids
      ? {
          scale,
          to_research: ids.map(job),
          batches: Array.from({ length: Math.ceil(ids.length / batchSize) }, (_, i) => ids.slice(i * batchSize, (i + 1) * batchSize)),
          batch_note: `Run the batches one after another (at most 3 researchers at a time within a batch). Each researcher has ${perPerson} searches. Anyone whose research is cut short is picked up again by the next plan.`
        }
      : {}),
    thin_profiles: triage.ranked.filter((id) => !has(id) && profileMeta(paths.dir, id)).length
  };
}

function save(opts) {
  need(opts, 'event', 'id', 'json');
  const { paths } = loadEvent(opts.event);
  const store = readJson(paths.contacts);
  const c = store.contacts.find((x) => x.id === opts.id);
  if (!c) throw new Error(`${opts.id} isn't in this event.`);
  let result;
  const raw = String(opts.json)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '');
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error('The researcher reply wasn\'t JSON like {"claims":[{"text":"…","url":"https://…"}]}.');
  }
  return { id: c.id, ...writeProfile(paths.dir, c, result) };
}

function prompt(opts) {
  need(opts, 'event');
  const { event, settings, paths } = loadEvent(opts.event);
  const segments = parseSegments(contextFor(settings, event).whoToMeet || '').map((s) => ({ name: s.name, who: s.who }));
  const mustMeet = String(opts['must-meet'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const text = collectPrompt({ event, listUrl: opts.url || event.list_url || null, segments, mustMeet, savePath: paths.attendees });
  writeText(paths.collectPrompt, text);
  // --now: floorboss reads the list in the user's browser in this run, so the run lock limits the browser too.
  if (opts.now) stampRun({ browser: true });
  return {
    prompt_file: paths.collectPrompt,
    save_path: paths.attendees,
    reminder: "Check the event's and the platform's terms before collecting or using a list."
  };
}

// Companies on the shortlist without a brief. Briefs come before any draft: the angle is built from them.
function companyPlan(opts) {
  need(opts, 'event');
  const { paths, settings } = loadEvent(opts.event);
  const files = [readJson(paths.shortlist, null), readJson(join(paths.dir, 'derived', 'shortlist.json'), null)];
  const short = files.find((x) => x?.ranked?.length) || null;
  // A shortlist with nobody on it (everyone held): nothing to brief; the flow says so instead of failing.
  if (!short && files.some((x) => Array.isArray(x?.ranked)))
    return {
      companies: [],
      to_brief: [],
      sender_company: settings.own_company || null,
      note: 'Nobody is on the shortlist, so there are no companies to brief.'
    };
  if (!short?.ranked) throw new Error('No shortlist yet: run the triage gate first.');
  const store = readJson(paths.contacts);
  const byId = Object.fromEntries(store.contacts.map((c) => [c.id, c]));
  const seen = new Map();
  const domains = new Map();
  for (const id of short.ranked) {
    const c = byId[id];
    if (c?.company && !seen.has(c.company)) seen.set(c.company, []);
    if (c?.company) seen.get(c.company).push({ id, name: c.name, title: c.title });
    // The company's own domain, from a work address: it tells the researcher which company of that name it is.
    const d = String(c?.email || '')
      .toLowerCase()
      .split('@')[1];
    // Only a domain that carries the company's name: a mail provider or an agency's domain says nothing about which
    // company it is.
    const stop = [
      'the',
      'and',
      'group',
      'port',
      'global',
      'international',
      'logistics',
      'freight',
      'services',
      'gmbh',
      'inc',
      'ltd',
      'llc',
      'plc',
      'bv',
      'ag',
      'sa'
    ];
    const words = String(c?.company || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((x) => x.length >= 3 && !stop.includes(x));
    // Any word of the name: four letters or more anywhere in the domain, a three-letter one (HXL, ABC) only as the
    // domain's own name ("dhl.com", "dhl-freight.de").
    const fits = (dom) => words.some((w) => (w.length >= 4 ? dom.replace(/[^a-z0-9]/g, '').includes(w) : new RegExp(`^${w}([.-]|$)`).test(dom)));
    const word = words[0];
    const provider =
      /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|mac|aol|proton|protonmail|pm|gmx|web|mail|yandex|zoho|hey|fastmail|t-online|btinternet|comcast|orange|free|libero|qq|163|naver|seznam)\./;
    if (c?.company && d && word && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) && !provider.test(d) && fits(d))
      (domains.get(c.company) || domains.set(c.company, new Set()).get(c.company)).add(d);
  }
  // The mock event's companies are made up: a canned brief each, rather than web research that can only find
  // nothing (or a real company with the same name). What's known comes from the mock's person profiles.
  const ev = loadEvent(opts.event).event;
  if (ev.mock)
    for (const company of seen.keys())
      if (!hasCompanyBrief(paths.dir, company))
        writeCompanyBrief(
          paths.dir,
          company,
          { nothing_found: true, canned: true, searched: [`${company} is a fictional company in floorboss's mock event: not searched`] },
          knownAbout(paths, settings, ev, company)
        );
  const companies = [...seen.entries()].map(([company, people]) => {
    const k = knownAbout(paths, settings, loadEvent(opts.event).event, company);
    const has = hasCompanyBrief(paths.dir, company);
    const earlier = !has && !ev.mock ? recentBriefElsewhere(paths.dir, company) : null;
    return {
      company,
      people,
      ...(domains.get(company)?.size === 1 ? { domain: [...domains.get(company)][0] } : {}),
      has_brief: has,
      file: companyBriefPath(paths.dir, company),
      ...(k.customer || k.proof.length ? { known: k } : {}),
      ...(earlier ? { researched_earlier: { event: earlier.event, days_ago: earlier.days_ago } } : {})
    };
  });
  return { sender_company: settings.own_company || null, companies, to_brief: companies.filter((x) => !x.has_brief).map((x) => x.company) };
}

// What floorboss knows about a company before any research: a customer in the CRM (a contact there at the
// user's account, or a customer status), or a customer named in the proof library.
function knownAbout(paths, settings, event, company) {
  const low = String(company).toLowerCase().trim();
  const store = readJson(paths.contacts, { contacts: [] });
  const resolved = readJson(join(paths.dir, 'derived', 'resolved.json'), {});
  const at = store.contacts.filter(
    (c) =>
      String(c.company || '')
        .toLowerCase()
        .trim() === low
  );
  // The account's own status counts too: at a customer through an account-level row only (no named record), the
  // job's account note says "your customer …", and the brief says so as well.
  // A live partner label or a won deal counts as the status does ("Partner - active" is no prospect).
  const named = (r) => ['customer', 'partner'].includes(r.crm?.relation) || /customer|closed won|won\b/i.test(r.crm?.status || '');
  const cust = at
    .map((c) => resolved[c.id])
    .find((r) => r && (named(r) || (/^(?:at your account|your customer)\b/.test(r.account_note || '') && /customer|won/i.test(r.account_note || ''))));
  const accountStatus = (/\(CRM: "([^"]+)"\)|\(([^()]*(?:customer|won)[^()]*)\)/i.exec(cust?.account_note || '') || []).slice(1).find(Boolean);
  const bring = contextFor(settings, event).whatYouBring || '';
  const proof =
    low.length >= 4
      ? bring
          .split('\n')
          .filter((l) => /^\|/.test(l) && !/^\|\s*(claim|---)/.test(l) && l.toLowerCase().includes(low))
          .map((l) => l.split('|')[1]?.trim())
          .filter(Boolean)
      : [];
  // Whether there is a CRM at all for this event, so a brief never says "from the CRM" without one.
  const hasCrm = ['crm.csv', 'crm-records.json'].some((f) => existsSync(join(paths.inputs, f))) || !!(event.crm?.path && existsSync(event.crm.path));
  const customer = !cust
    ? null
    : named(cust)
      ? `the CRM says "${cust.crm.status}"${cust.crm.deal_stage ? ` (deal${cust.crm.deal ? ` "${cust.crm.deal}"` : ''}: ${cust.crm.deal_stage})` : ''}`
      : accountStatus
        ? `the CRM says "${accountStatus}" on the account`
        : `the CRM says "${cust.account_note}"`;
  return { customer, ...(cust?.crm?.relation === 'partner' ? { relation: 'partner' } : {}), proof, has_crm: hasCrm };
}

function saveCompany(opts) {
  const { paths, settings, event } = loadEvent(opts.event);
  if (opts['company-slug'] && !opts.company)
    opts.company = companyFromSlug(
      (readJson(paths.contacts, { contacts: [] }).contacts || []).map((x) => x.company),
      opts['company-slug']
    );
  need(opts, 'event', 'company', 'json');
  let result;
  const raw = String(opts.json)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '');
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error(
      'The company brief wasn\'t JSON like {"sells","relation_to_us","existing_vendors","what_they_would_want","do_not_tell_them","sources":[…]}.'
    );
  }
  return writeCompanyBrief(paths.dir, String(opts.company), result, knownAbout(paths, settings, event, opts.company));
}

// skip-companies: the user chose no company research: every shortlisted company without a brief (or only
// those in --companies '["Acme"]') gets one that says it wasn't researched, so drafts say nothing about it.
function skipCompanies(opts) {
  need(opts, 'event');
  const p = companyPlan(opts);
  const { paths, settings, event } = loadEvent(opts.event);
  const only = opts.companies ? new Set(JSON.parse(opts.companies).map((x) => String(x).toLowerCase())) : null;
  if (only) p.to_brief = p.to_brief.filter((co) => only.has(String(co).toLowerCase()));
  // Researched for another event in the last two weeks: "skip" uses that research (written again with this
  // event's CRM), rather than a brief that says nothing.
  const reused = [];
  for (const company of p.to_brief) {
    const earlier = event.mock ? null : recentBriefElsewhere(paths.dir, company);
    const r = earlier ? writeCompanyBrief(paths.dir, company, resultFromMeta(earlier.meta), knownAbout(paths, settings, event, company)) : null;
    if (r?.saved) {
      reused.push({ company, from: earlier.event, days_ago: earlier.days_ago });
      continue;
    }
    writeCompanyBrief(
      paths.dir,
      company,
      { nothing_found: true, skipped: true, searched: ['not searched: you chose to skip company research'] },
      knownAbout(paths, settings, event, company)
    );
  }
  return { skipped: p.to_brief.length, companies: p.to_brief, ...(reused.length ? { reused_research: reused } : {}) };
}

run({ plan, save, prompt, 'company-plan': companyPlan, 'save-company': saveCompany, 'skip-companies': skipCompanies });
