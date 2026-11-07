// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Batch sameness: drafts that each pass but read as one mail merge. Looks at the whole batch at once.

const STOP = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'is',
  'it',
  'we',
  'you',
  'your',
  'i',
  'that',
  'this',
  'be',
  'as',
  'are',
  'by',
  'our'
]);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replace what legitimately differs per person (name, company, title, times, event) with placeholders,
// so only the writing itself is compared.
export function mask(body, { contact = {}, eventName, eventAliases = [], slotLabels = [], optout, signoff, meetingPlace, sender } = {}) {
  // Whitespace is collapsed first, so a sign-off split over two lines still matches.
  let t = String(body).replace(/\s+/g, ' ');
  signoff = signoff
    ? String(signoff)
        .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    : signoff;
  if (meetingPlace) t = t.replace(new RegExp(escapeRe(meetingPlace), 'gi'), ' <PLACE> ');
  if (sender) t = t.replace(new RegExp(`\\b${escapeRe(sender)}\\b`, 'gi'), ' <SENDER> ');
  if (optout) t = t.split(optout).join(' ');
  for (const l of slotLabels) t = t.split(l).join(' <TIME> ');
  for (const n of [eventName, ...(eventAliases || [])].filter(Boolean).sort((a, b) => b.length - a.length))
    t = t.replace(new RegExp(escapeRe(n), 'gi'), ' <EVENT> ');
  const parts = [contact.company, contact.title, ...String(contact.name || '').split(/\s+/)].filter((x) => x && x.length > 1);
  for (const p of parts.sort((a, b) => b.length - a.length)) t = t.replace(new RegExp(`\\b${escapeRe(p)}(?:'s)?\\b`, 'gi'), ' <X> ');
  // Everything from the sign-off down (name, signature block) is the same in every draft by design.
  if (signoff) {
    const at = t.lastIndexOf(signoff);
    if (at >= 0) t = t.slice(0, at);
  }
  return t.replace(/\s+/g, ' ').trim();
}

export function sentences(text) {
  return String(text)
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 4);
}

// Accents are folded, not dropped ("Hättest" → "hattest").
const normSentence = (s) =>
  s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9<>\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function grams(text, n = 4) {
  const w = normSentence(text)
    .split(' ')
    .filter((x) => x && !STOP.has(x));
  const g = new Set();
  for (let i = 0; i + n <= w.length; i++) g.add(w.slice(i, i + n).join(' '));
  return g;
}

export function similarity(a, b) {
  const A = grams(a),
    B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.min(A.size, B.size);
}

export const LIMITS = Object.freeze({ opener_share: 0.34, sentence_share: 0.2, mean_similarity: 0.15, same_company_similarity: 0.25 });

// drafts: [{ id, body, contact, company_key, slotLabels }]; ctx: { eventName, optout, signoff }
export function analyzeBatch(drafts, ctx = {}) {
  const items = drafts.map((d) => {
    const masked = mask(d.body, { ...ctx, contact: d.contact, slotLabels: d.slotLabels });
    const body = masked.replace(/^(hi|hello|hey|dear)\s+<X>,?\s*/i, '');
    // Overlap is measured on what the writer chose: not the ask, the sender line or approved wording.
    const own = String(body)
      .split(/(?<=[.?!])\s+/)
      .filter((s) => !/<TIME>|<EVENT>|<SENDER>/.test(s))
      .join(' ');
    const sents = sentences(body);
    // The subject and the first line together are what a reader sees in the inbox list.
    const subj = d.subject ? normSentence(mask(d.subject, { ...ctx, contact: d.contact, slotLabels: d.slotLabels })) : '';
    return { id: d.id, company_key: d.company_key, masked: own, sents, subj, first: normSentence(sents[0] || String(body).split(/(?<=[.?!])\s+/)[0] || '') };
  });
  const n = items.length;
  const out = { n, reasons: [] };
  if (n < 3) return { ...out, verdict: 'not enough drafts to judge' };

  const openers = new Map();
  for (const it of items) {
    const o = normSentence(it.sents[0] || '')
      .split(' ')
      .slice(0, 6)
      .join(' ');
    openers.set(o, [...(openers.get(o) || []), it.id]);
  }
  const top = [...openers.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  out.top_opener = { text: top[0], count: top[1].length, share: +(top[1].length / n).toFixed(2), ids: top[1] };

  const sentIds = new Map();
  for (const it of items) for (const s of new Set(it.sents.map(normSentence))) sentIds.set(s, [...(sentIds.get(s) || []), it.id]);
  // The sentence that offers the times is the same in every draft by design ("30 minutes at <EVENT>, <TIME>
  // or <TIME>?"), so it doesn't count as sameness.
  // The ask (it names the event or the times) and the user's approved wording are the same by design.
  const approved = (ctx.approved || []).map((a) => normSentence(a)).filter(Boolean);
  // An insight from what-you-bring is quoted as written (the skill says so), in as many drafts as the insight
  // cap allows: within the cap it's not sameness; over it, checkInsights says which drafts to move.
  const insights = (ctx.insights || []).map((x) => normSentence(x)).filter((x) => x.split(' ').length >= 4);
  const isInsight = (s) => insights.some((x) => s.includes(x) || x.includes(s) || similarity(s, x) >= 0.6);
  const cap = Number.isFinite(ctx.insightCap) ? ctx.insightCap : 0;
  out.shared_sentences = [...sentIds.entries()]
    .filter(
      ([s, ids]) =>
        ids.length >= 3 &&
        ids.length / n > LIMITS.sentence_share &&
        !s.includes('<time>') &&
        !s.includes('<event>') &&
        !s.includes('<sender>') &&
        !approved.some((a) => s.includes(a) || a.includes(s)) &&
        !(ids.length <= cap && isInsight(s))
    )
    .sort((a, b) => b[1].length - a[1].length)
    .map(([text, ids]) => ({ text, count: ids.length, ids }));
  // The same subject and the same first line: the drafts read as one in the inbox, however few they are.
  const firstLines = new Map();
  for (const it of items) if (it.first) firstLines.set(`${it.subj}|${it.first}`, [...(firstLines.get(`${it.subj}|${it.first}`) || []), it]);
  out.same_start = [...firstLines.values()].filter((g) => g.length >= 2).map((g) => ({ subject: g[0].subj, first: g[0].first, ids: g.map((x) => x.id) }));

  const sims = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      sims.push({
        a: items[i].id,
        b: items[j].id,
        sim: similarity(items[i].masked, items[j].masked),
        same: items[i].company_key && items[i].company_key === items[j].company_key
      });
  out.mean_similarity = +(sims.reduce((s, x) => s + x.sim, 0) / sims.length).toFixed(3);
  out.most_similar = sims
    .sort((x, y) => y.sim - x.sim)
    .slice(0, 5)
    .map((x) => ({ ...x, sim: +x.sim.toFixed(2) }));
  out.same_company = sims.filter((x) => x.same && x.sim > LIMITS.same_company_similarity).map((x) => ({ a: x.a, b: x.b, sim: +x.sim.toFixed(2) }));

  // Named, so only those are rewritten (all but the first keep its opening), never the whole batch.
  if (out.top_opener.share > LIMITS.opener_share)
    out.reasons.push(
      `${out.top_opener.count} of ${n} drafts open the same way ("${out.top_opener.text}…"): rewrite the openings of ${out.top_opener.ids.slice(1).join(', ')}`
    );
  // Each reason names the drafts to rewrite (all but one keep the line), never the whole batch.
  for (const s of out.shared_sentences)
    out.reasons.push(`${s.count} of ${n} drafts share the sentence "${s.text}": rewrite it in ${s.ids.slice(1).join(', ')}`);
  for (const g of out.same_start)
    out.reasons.push(
      `${g.ids.join(', ')} have the same ${g.subject ? 'subject and ' : ''}first line ("${g.first.slice(0, 80)}"): rewrite the opening of ${g.ids.slice(1).join(', ')}`
    );
  if (out.mean_similarity > LIMITS.mean_similarity)
    out.reasons.push(
      `drafts overlap ${Math.round(out.mean_similarity * 100)}% on average (limit ${LIMITS.mean_similarity * 100}%): rewrite the closest, ${[...new Set(out.most_similar.slice(0, 3).map((x) => x.b))].join(', ')}`
    );
  for (const p of out.same_company) out.reasons.push(`${p.a} and ${p.b} work at the same company and their drafts overlap ${Math.round(p.sim * 100)}%`);
  out.verdict = out.reasons.length ? 'FAIL' : 'PASS';
  return out;
}

// Insight spread: wording checks pass a stat retold in different words, but readers who compare notes
// still see one mail merge. drafts: [{ id, insight, company_key, previous_insight, insight_gone, fixed }];
// insights from parseInsights; cap from insightCap. Each draft names the insight it leads with, or null.
// Fixed drafts (saved in an earlier run, maybe sent) count toward the cap but are never asked to change.
export function checkInsights(drafts, { insights = [], cap }) {
  const reasons = [];
  const known = new Map(insights.map((x) => [x.id, x]));
  const users = new Map();
  for (const d of drafts) {
    if (d.insight_gone && !d.fixed) reasons.push(`${d.id} leads with an insight that's no longer in the "what you know" table ("${d.insight_gone}")`);
    if (!d.insight) continue;
    if (!known.has(d.insight)) {
      if (!d.fixed) reasons.push(`${d.id} names insight ${d.insight}, which isn't in the "what you know" table`);
      continue;
    }
    users.set(d.insight, [...(users.get(d.insight) || []), d]);
    if (!d.fixed && d.previous_insight && d.previous_insight === d.insight)
      reasons.push(`${d.id} repeats ${d.insight} from the message before; a follow-up adds something new`);
  }
  const use = {};
  const ids = (ds) => ds.map((d) => d.id).join(', ');
  for (const [id, ds] of users) {
    use[id] = ds.length;
    const movable = ds.filter((d) => !d.fixed);
    if (ds.length > cap && movable.length) {
      const n = Math.min(ds.length - cap, movable.length);
      reasons.push(
        `${id} is in ${ds.length} drafts (${ids(ds)}); the limit is ${cap}. Move ${n} of them to another insight that fits, or to a question: rewrite ${ids(movable.slice(-n))}`
      );
    }
    const byCompany = new Map();
    for (const d of ds) if (d.company_key) byCompany.set(d.company_key, [...(byCompany.get(d.company_key) || []), d]);
    for (const group of byCompany.values()) {
      const open = group.filter((d) => !d.fixed);
      if (group.length < 2 || !open.length) continue;
      const earlier = group.filter((d) => d.fixed);
      reasons.push(
        `${group.map((d) => d.id).join(' and ')} work at the same company and both use ${id}; colleagues never share an insight${earlier.length ? ` (${ids(earlier)} was drafted earlier, so change ${ids(open)})` : ''}`
      );
    }
  }
  return { cap, use, reasons };
}

// A note on a rated draft that says it reads like another ("same as 1", "identical to 4"): that draft goes back.
export const SAMENESS_NOTE =
  /\b(same (as|opening|start|first line|line|subject|sentence|message|text|angle)|identical|duplicate[sd]?|ditto|alike|copy of|word for word)\b/i;
// Praise ("plain, fine for a customer", "works"): a note that says only good things is never a rule. A word of
// criticism beside it ("fine but too long", "too plain") makes it one.
const PRAISE = /\b(fine|good|great|nice|solid|perfect|plain|ok(ay)?|works?|love it|like it|clear|clean|natural|strong|spot on|yes|sure)\b/i;
const CRITICISM =
  /\b(too|not|no|never|don[’']?t|isn[’']?t|doesn[’']?t|less|more|bit|but|though|needs?|should|could|lacks?|missing|weak|generic|abstract|brochure|salesy|vague|stiff|wordy|long|short|cut|drop|remove|change|boring|pushy|odd|weird|awkward|cheesy|robotic|jargon|clich[eé]|repetitive|unclear|formal|cold)\b/i;
// A rating's note that could be a rule for every draft: any note with something to say, one word ("generic")
// included; not praise, not a pointer to another draft ("same as 1", "see 3", "ditto", "2"), not about drafts
// reading alike (those go back on their own).
export const asRule = (note) => {
  const t = String(note || '').trim();
  return !!t && !(PRAISE.test(t) && !CRITICISM.test(t)) && !/^\s*(same as|see|ditto|like|as)\b|^[\d\s#.,]+$/i.test(t) && !SAMENESS_NOTE.test(t);
};
