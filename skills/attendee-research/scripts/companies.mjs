// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Company briefs: one per shortlisted company, written before the first draft. A draft's angle comes from
// what the company sells, how it relates to the sender's company and what it would want from them; without
// that, a note pitches the sender's own problem at a partner, or explains the reader's product back to them.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeText } from '../../../lib/jsonio.mjs';
import { safeUrl } from '../../../lib/escape.mjs';
import { companyKey, fileSlug } from '../../../lib/normalize.mjs';

export const RELATIONS = ['customer', 'prospect', 'partner', 'competitor', 'adjacent'];
const FIELDS = ['sells', 'relation_to_us', 'existing_vendors', 'what_they_would_want', 'do_not_tell_them'];

const slug = (company) => fileSlug(companyKey(company) || company);
export const companyBriefPath = (dir, company) => join(dir, 'companies', `${slug(company)}.md`);
const metaPath = (dir, company) => join(dir, 'companies', `${slug(company)}.json`);

export function companyBriefMeta(dir, company) {
  if (!existsSync(metaPath(dir, company))) return null;
  try {
    return JSON.parse(readFileSync(metaPath(dir, company), 'utf8'));
  } catch {
    return null;
  }
}
export const hasCompanyBrief = (dir, company) => existsSync(companyBriefPath(dir, company)) && !!companyBriefMeta(dir, company);
export const readCompanyBrief = (dir, company) => (existsSync(companyBriefPath(dir, company)) ? readFileSync(companyBriefPath(dir, company), 'utf8') : null);

// The same company researched for another of the user's (real) events in the last `days` days: { event, days_ago,
// meta }, newest first, or null. Briefs that weren't researched (skipped, the mock's canned ones) don't count.
export function recentBriefElsewhere(dir, company, { days = 14 } = {}) {
  const root = join(dir, '..');
  const here = dir.replace(/\/+$/, '').split('/').pop();
  let best = null;
  try {
    for (const slug of readdirSync(root)) {
      if (slug === here) continue;
      const ev = (() => {
        try {
          return JSON.parse(readFileSync(join(root, slug, 'event.json'), 'utf8'));
        } catch {
          return null;
        }
      })();
      if (!ev || ev.mock) continue;
      const meta = companyBriefMeta(join(root, slug), company);
      if (!meta || meta.skipped || meta.canned || !existsSync(companyBriefPath(join(root, slug), company))) continue;
      const age = (Date.now() - Date.parse(meta.saved_at)) / 864e5;
      if (!(age >= 0 && age <= days)) continue;
      if (!best || age < best.age) best = { event: ev.name || slug, days_ago: Math.floor(age), age, meta };
    }
  } catch {
    return null;
  }
  if (!best) return null;
  const { age, ...out } = best;
  return out;
}
// A saved brief's facts as the researcher's answer, to write it again for this event (with this event's CRM).
export function resultFromMeta(meta) {
  if (meta.nothing_found) return { nothing_found: true, searched: meta.searched || [] };
  return {
    ...(meta.fields || {}),
    relation: meta.relation,
    ...(meta.fit_doubt ? { fit_doubt: meta.fit_doubt } : {}),
    industry_news: meta.industry_news || [],
    industry_news_none: meta.industry_news_none || undefined,
    sources: meta.sources || []
  };
}

const clean = (v, n = 400) =>
  String(Array.isArray(v) ? v.join('; ') : (v ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);

// Industry news: developments in the company's market, not its own announcements. A note's trigger comes from
// here, because a reader's own news told back to them is something they already know.
// Items: { text, url, date? }. An item without a read source, or one that names the company itself, is refused.
export function industryNews(company, items) {
  const own = (companyKey(company) || String(company || '')).toLowerCase().split(/\s+/)[0];
  const ok = [],
    refused = [];
  for (const it of Array.isArray(items) ? items : []) {
    const text = clean(typeof it === 'string' ? it : it?.text, 300);
    const url = safeUrl(typeof it === 'string' ? '' : it?.url);
    if (!text || !url || !/^https?:/.test(url)) {
      refused.push({ text, why: 'no source URL' });
      continue;
    }
    if (own && own.length > 2 && new RegExp(`\\b${own.replace(/[^a-z0-9]/g, '')}`, 'i').test(text)) {
      refused.push({ text, why: `that's ${company}'s own news, not their industry's` });
      continue;
    }
    ok.push({ text, url, date: clean(it?.date, 20) || null });
  }
  return { ok, refused };
}

// result: { sells, relation_to_us, existing_vendors, what_they_would_want, do_not_tell_them, industry_news: [{text,url,date}],
//   industry_news_none?: why, sources: [url | {url}] }.
// Fails closed: no source, a relation that isn't one of RELATIONS, or no industry news (and no reason why), and nothing is saved.
// known: what floorboss already knows about the company from the CRM and the proof library, which beats the
// researcher's guess: {customer: "<why>"|null, proof: ["<claim naming them>"]}. A customer's people never hear
// their own company's result quoted back to them.
export function writeCompanyBrief(dir, company, result, known = {}) {
  const r = result || {};
  const nothing = r.nothing_found === true && (Array.isArray(r.searched) ? r.searched : []).filter(Boolean).length > 0;
  // The researcher may say "relation_to_us" or name the sender's company in the key: any relation_to_* field counts.
  const relKey = Object.keys(r).find((k) => /^relation_to_/.test(k));
  const relationText = clean(relKey ? r[relKey] : '', 300);
  // The relation named first wins ("competitor (and weak prospect)"; "no customer link found" later in the text doesn't count).
  const explicit = RELATIONS.includes(String(r.relation || '').toLowerCase()) ? String(r.relation).toLowerCase() : null;
  const hits = RELATIONS.map((x) => [x, relationText.toLowerCase().search(new RegExp(`\\b${x}`))])
    .filter(([, i]) => i >= 0)
    .sort((a, b) => a[1] - b[1]);
  // A live partner in the CRM is a partner, as a customer there is a customer: the researcher's guess never beats it.
  const relation = known.customer || (known.proof || []).length ? (known.relation === 'partner' ? 'partner' : 'customer') : explicit || hits[0]?.[0] || null;
  const knownLines = [
    ...(known.customer
      ? [
          known.relation === 'partner'
            ? `**Your partner:** ${clean(known.customer, 200)}. Write as to a partner, never a cold pitch.`
            : `**Your customer:** ${clean(known.customer, 200)}. Write as to a customer, never a cold pitch.`
        ]
      : []),
    ...((known.proof || []).length
      ? [
          `**Your proof customer:** your proof library names them (${known.proof.map((x) => clean(x, 120)).join('; ')}). Never quote their own result back to them.`
        ]
      : [])
  ];
  const sources = (Array.isArray(r.sources) ? r.sources : []).map((s) => safeUrl(typeof s === 'string' ? s : s?.url)).filter((u) => u && /^https?:/.test(u));
  const errors = [];
  if (!clean(r.sells) && !nothing) errors.push('sells is empty: say what the company sells and to whom');
  if (!relation && !nothing) errors.push(`relation_to_us must name one of ${RELATIONS.join(', ')}`);
  if (!clean(r.what_they_would_want) && !nothing) errors.push('what_they_would_want is empty: the angle comes from it');
  // A company with no public presence: the searches tried stand in for sources, and the brief says plainly that
  // nothing is known, so a draft may say nothing about the company (the critic holds it to that).
  if (!sources.length && !nothing)
    errors.push(
      'no source URL: every brief needs at least one page that was read (or, when searches found nothing at all, "nothing_found": true with the "searched" queries)'
    );
  const news = industryNews(company, r.industry_news);
  const noneWhy = clean(r.industry_news_none, 300);
  if (!news.ok.length && !noneWhy && !nothing)
    errors.push(
      `industry_news is empty${news.refused.length ? ` (${news.refused.map((x) => x.why).join('; ')})` : ''}: give 1-3 recent developments in their market, each with a source, that bear on why the sender matters to them; or say in industry_news_none why none fit`
    );
  if (errors.length) return { saved: false, errors };
  if (nothing) {
    // canned: the mock event's invented companies (never searched); skipped: the user chose no company research.
    const head = r.canned
      ? `**Mock event:** ${company} is invented for floorboss's mock event, so this brief is canned: nothing was searched.`
      : r.skipped
        ? '**Not researched:** you chose to skip company research, so nothing was searched.'
        : '**Nothing public found.** Searches tried: ' + r.searched.map((q) => clean(q, 120)).join('; ') + '.';
    const lines = [
      `# ${company}`,
      '',
      head,
      '',
      `**Relation to us:** ${relation || 'prospect'} (from ${known.has_crm === false ? 'the list only' : 'the CRM and list only'})`,
      ...knownLines,
      '',
      `**Don't tell them:** anything about the company itself: ${r.canned ? 'it is invented' : 'nothing is known'}. Write from their role and the event only.`,
      ''
    ];
    writeText(companyBriefPath(dir, company), lines.join('\n'));
    writeText(
      metaPath(dir, company),
      JSON.stringify(
        {
          company,
          relation: relation || 'prospect',
          nothing_found: true,
          ...(r.canned ? { canned: true } : {}),
          ...(r.skipped ? { skipped: true } : {}),
          searched: r.searched,
          sources: [],
          industry_news: [],
          saved_at: new Date().toISOString()
        },
        null,
        2
      ) + '\n'
    );
    return { saved: true, company, relation: relation || 'prospect', nothing_found: true, sources: 0 };
  }
  const lines = [
    `# ${company}`,
    '',
    `**Sells:** ${clean(r.sells)}`,
    // The relation word is said once: "prospect: they run 40 trucks" reads "prospect. they run 40 trucks", never
    // "prospect. prospect: …".
    `**Relation to us:** ${(() => {
      const rest = relationText.replace(new RegExp(`^\\s*(?:a |an )?${relation}\\b[\\s:;,.–—-]*`, 'i'), '').trim();
      return rest ? `${relation}. ${rest.charAt(0).toUpperCase()}${rest.slice(1)}` : `${relation}.`;
    })()}`,
    ...knownLines,
    `**Existing vendors:** ${clean(r.existing_vendors) || 'none found'}`,
    `**What they'd want from us (the angle):** ${clean(r.what_they_would_want)}`,
    `**Don't tell them:** ${clean(r.do_not_tell_them) || 'nothing noted'}`,
    '',
    '## Industry news (the trigger comes from here, never from their own news)',
    '',
    ...(news.ok.length ? news.ok.map((n) => `- ${n.date ? `${n.date}: ` : ''}${n.text} (${n.url})`) : [`- none: ${noneWhy}`]),
    '',
    '## Sources',
    '',
    ...sources.map((u) => `- ${u}`)
  ];
  writeText(companyBriefPath(dir, company), lines.join('\n') + '\n');
  const meta = {
    company,
    relation,
    ...(clean(r.fit_doubt) ? { fit_doubt: clean(r.fit_doubt, 300) } : {}),
    fields: Object.fromEntries(FIELDS.map((f) => [f, f === 'relation_to_us' ? relationText : clean(r[f])])),
    industry_news: news.ok,
    industry_news_none: news.ok.length ? null : noneWhy,
    sources,
    saved_at: new Date().toISOString()
  };
  writeText(metaPath(dir, company), JSON.stringify(meta, null, 2) + '\n');
  return { saved: true, company, relation, sources: sources.length, industry_news: news.ok.length, refused_news: news.refused };
}
