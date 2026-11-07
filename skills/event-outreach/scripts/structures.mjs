// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Message structures. One recipe for every message reads as a template across a batch, and across senders.
// Each first message and follow-up is given a structure, rotated by rank so neighbours differ, never the one
// the person's earlier message used, and never two colleagues at one company with the same one. With no
// fact about the reader (no research, CRM history, mailbox history or anything on the list), the message is
// the plain short form, and the brief says so.
export const STRUCTURES = {
  'question-first':
    'Open with one question the reader would want to answer about their own work, then one thing they get now (a proof point or an insight), then the ask with the two times.',
  'insight-first':
    'Open with one thing they may not know (an insight from the "what you know" table), tied to their situation in a clause, then what you offer in one line, then the ask.',
  'plain-request':
    'Say plainly who you are and what you want from them, why them in one clause, and the ask. Short: under 60 words. No hook, no question for the sake of it.',
  'peer-note':
    'Write as one practitioner to another: one observation from your own work that bears on theirs, then the ask. No pitch beyond a clause naming what you do.'
};
export const STRUCTURE_IDS = Object.keys(STRUCTURES);
export const FACT_SOURCES = ['industry', 'research', 'company', 'user', 'crm', 'account', 'mailbox', 'list', 'none'];

// The user's voice rules about how a message opens, read as a structure preference, so a rule and the
// assigned structure never pull against each other (one fails the critic, the other the structure check):
//   question: a question in the first lines: only question-first, and peer-note for a warm reader;
//   no-question: never question-first;
//   insight: lead with something they may not know: insight-first, and peer-note for a warm reader;
//   plain: say who you are and what you want first, or an opening rule no structure maps to: the plain form.
// A greeting rule ("Hi <first name>,", no greeting) isn't one: the structure starts after the greeting.
const NO_QUESTION =
  /\b(?:don[’']?t|do not|never|no|avoid)\s+(?:open|start|lead|begin)\w*\s+(?:(?:my|the|an?|your)\s+)?(?:(?:emails?|messages?|notes?)\s+)?with\s+(?:a\s+)?question|\bno\s+question[\s-]*(?:openers?|openings?|first)|\bavoid\s+(?:a\s+)?question\s+(?:openers?|first)|\bnever\s+(?:open|start)\w*\s+(?:a\s+|an\s+|my\s+|your\s+)?(?:cold\s+)?(?:emails?|messages?|notes?)\s+with\s+(?:a\s+)?question|\bno\s+opening\s+questions?|first\s+line\s+is\s+never\s+a\s+question|never\s+use\s+a\s+question\s+as\s+(?:the|an)\s+opener/i;
const QUESTION =
  /\b(?:ask|open|start|lead|begin)\w*\b[^.\n]{0,40}\bquestions?\b[^.\n]{0,30}\b(?:first|opening|top|start)\b|\b(?:open|start|lead|begin)\w*\s+(?:\w+\s+){0,3}?with\s+(?:a\s+|an\s+|one\s+)?(?:\w+\s+)?question|\b(?:first|opening)\s+(?:line|sentence|two lines)\s+(?:is|are|should be|must be|has to be)\s+a\s+question/i;
const INSIGHT =
  /\b(?:open|start|lead|begin)\w*\s+(?:\w+\s+){0,3}?with\s+(?:an?\s+|one\s+|the\s+)?(?:\w+\s+)?(?:insight|observation|stat|statistic|number|data point|trend|news)\b/i;
const PLAIN =
  /\b(?:open|start|lead|begin)\w*\s+(?:\w+\s+){0,3}?with\s+(?:who\s+(?:i|we)\s+(?:am|are)|the\s+ask|why\s+(?:i[’']?m|i\s+am|we[’']?re)\s+writing|my\s+name|our\s+name|the\s+point)|\bsay\s+who\s+(?:i|we)\s+(?:am|are)\s+first|\bget\s+(?:straight\s+)?to\s+the\s+point/i;
const OPENING_ANY = /\b(?:open|start|begin|lead)(?:s|ing)?\s+(?:\w+\s+){0,3}?with\b|\b(?:first|opening)\s+(?:line|lines|sentence|two lines)\b/i;
const GREETING = /\bgreeting|\b(?:hi|hello|hey|dear)\b|\b(?:their|the reader[’']?s|first)\s+(?:first\s+)?name\b|\bsalutation/i;
export function openingRule(rule) {
  const t = String(rule || '');
  if (NO_QUESTION.test(t)) return 'no-question';
  // Any other "never start with …" ("never start with I") is about words, not the structure.
  if (/\b(?:never|don[’']?t|do not|avoid|no)\b/i.test(t)) return null;
  if (QUESTION.test(t)) return 'question';
  if (INSIGHT.test(t)) return 'insight';
  if (PLAIN.test(t)) return 'plain';
  if (OPENING_ANY.test(t) && !GREETING.test(t)) return 'plain';
  return null;
}
export const OPENINGS = {
  question: {
    only: ['question-first', 'peer-note'],
    says: "a question in the first lines (the user's voice rule): question-first, or peer-note for a warm reader"
  },
  'no-question': { banned: ['question-first'], says: "never a question as the opening (the user's voice rule): no question-first" },
  insight: {
    only: ['insight-first', 'peer-note'],
    says: "something they may not know first (the user's voice rule): insight-first, or peer-note for a warm reader"
  },
  plain: { only: ['plain-request'], says: "the user's own opening rule, which no structure matches: the plain form, opened as the rule says" }
};
// The opening the voice file asks for: its "Opening" field (set from the rules when they were saved), else
// read from the whole file (rules added later from feedback, files written by hand).
export function openingOf(voiceText) {
  const t = String(voiceText || '');
  const field = (/^-\s*\*\*Opening:\*\*\s*([a-z-]+)/im.exec(t) || [])[1];
  if (field && OPENINGS[field.toLowerCase()]) return field.toLowerCase();
  const rules = t.split('\n').filter((l) => /^\s*-\s/.test(l) && !/^\s*-\s*\*\*(?:Greeting|Sign-off|Sender name|Tone|Length|Avoid)/i.test(l));
  const found = rules.map(openingRule).filter(Boolean);
  // A rule against a question opening wins over one asking for something else; else the last rule given.
  return found.includes('no-question') && !found.includes('question')
    ? 'no-question'
    : found.length
      ? found[found.length - 1]
      : NO_QUESTION.test(t)
        ? 'no-question'
        : null;
}

// Which reader fact a job has, best first.
// A reader who knows the sender (warm, a note from the user, CRM history with them): the draft opens from the
// relationship (event-outreach SKILL.md, "Warm contacts"), so never with a question, and with an insight only
// when one fits them.
export const warmReader = (job) =>
  !!(job && (job.group === 'warm' || job.warm_because || job.known_by_user || job.user_note || job.crm_summary?.status || job.crm_summary?.last_contact));
export const FROM_RELATIONSHIP = "Open from the relationship: how you know them first (the user's words, the CRM history), then the one new thing.";

export function factSources(job) {
  const out = [];
  // A development in their market, from the brief's "Industry news": the trigger the reader doesn't already know.
  if (job.company_brief && /## Industry news[^\n]*\n+- (?!none:)[^\n]*https?:/.test(job.company_brief)) out.push('industry');
  if (job.profile && /http/.test(JSON.stringify(job.profile))) out.push('research');
  // The verified company brief: what the company runs and would want (the angle's own source).
  if (job.company_brief && /http/.test(job.company_brief)) out.push('company');
  // What the user told floorboss about them ("we met at LogiFair in the spring"): their own words, a fact.
  if (job.user_note) out.push('user');
  // Their own CRM history; the user's account at their company (account_note) is its own source: a draft that
  // calls it "crm" has no CRM summary behind it, and the critic fails it.
  if (job.crm_summary && (job.crm_summary.status || job.crm_summary.last_contact)) out.push('crm');
  if (job.account_note) out.push('account');
  if (job.mailbox_note) out.push('mailbox');
  if (job.contact?.title && job.contact?.company) out.push('list');
  return out.length ? out : ['none'];
}

// Assign a structure to every message job. jobs: in rank order. earlier: id -> { touch: structure } for
// touches already drafted (a plain list of structures is read as earlier touches). Returns id:touch ->
// structure. A touch keeps the structure it was drafted with unless a colleague's or the person's own
// earlier message now has it; only the person's earlier touches count as "used", never earlier drafts of
// the same message.
// opts.banned: structures the user's own voice rules forbid ("don't open with a question" → question-first).
// opts.proofs: how many proof points they have; with no insights and at most one proof, question-first (which
// needs one thing they get now) stays within a third, like the proof itself.
// opts.only: the structures the user's opening rule leaves (OPENINGS); those are never capped at 40% or kept
// apart between colleagues (the rule is the user's), and a job none of them fits gets the plain form.
// opts.insightRoom: per touch, how many more drafts each insight may lead ({1: {I1: 2}}): insight-first goes only
// to a job with an insight that still has room (not one it must avoid), and takes one place from it, so the
// rotation never hands out more insight-first drafts than the batch check's cap lets pass.
export function assignStructures(jobs, earlier = {}, companyOf = null, opts = {}) {
  const banned = new Set(opts.banned || []);
  const room = opts.insightRoom ? JSON.parse(JSON.stringify(opts.insightRoom)) : null;
  const leadable = (j) => (j.insight_options || []).filter((x) => !room || (!(j.avoid_insights || []).includes(x) && (room[j.touch]?.[x] ?? 0) > 0));
  const only = opts.only ? new Set(opts.only) : null;
  const out = {};
  const byCompany = {};
  // Colleagues drafted in an earlier run (not in this batch) count too: the batch check compares them all.
  if (companyOf) {
    const here = new Set(jobs.map((j) => j.id));
    for (const [id, e] of Object.entries(earlier)) {
      const co = companyOf(id);
      if (here.has(id) || !co || !e || Array.isArray(e)) continue;
      (byCompany[co] ||= []).push(...Object.values(e));
    }
  }
  const inRun = {};
  const perTouch = {};
  const sizeByTouch = {};
  for (const j of jobs) if (j.kind === 'message') sizeByTouch[j.touch] = (sizeByTouch[j.touch] || 0) + 1;
  // Messages drafted in an earlier run count too: the batch check weighs every draft of a touch, not one run's.
  {
    const here = new Set(jobs.map((j) => j.id));
    for (const [id, e] of Object.entries(earlier)) {
      if (here.has(id) || !e || Array.isArray(e)) continue;
      for (const [t, st] of Object.entries(e)) {
        if (!st) continue;
        sizeByTouch[t] = (sizeByTouch[t] || 0) + 1;
        (perTouch[t] ||= {})[st] = ((perTouch[t] || {})[st] || 0) + 1;
      }
    }
  }
  let i = 0;
  const touchesOf = (id) => {
    const e = earlier[id];
    if (!e) return {};
    return Array.isArray(e) ? Object.fromEntries(e.map((s, k) => [-(k + 1), s])) : e;
  };
  for (const j of jobs.filter((x) => x.kind === 'message')) {
    const facts = factSources(j);
    const mine = touchesOf(j.id);
    const own = new Set([
      ...Object.entries(mine)
        .filter(([t]) => Number(t) < j.touch)
        .map(([, s]) => s),
      ...(inRun[j.id] || [])
    ]);
    const colleagues = new Set(byCompany[j.company_key] || []);
    let pick;
    if (facts[0] === 'none') pick = 'plain-request';
    else {
      // Insight-first only with an insight to lead with; peer notes only for a warm or known reader.
      // A question needs one thing they get now (a proof point or an insight): with neither, no question-first.
      const nothingToGive = (opts.proofs ?? 2) === 0 && !(j.insight_options || []).length;
      // A question about their own work needs something true about them beyond a title and a company: with only
      // the list to go on, a drafter writes it as "no reader fact" and the checks then refuse it.
      const noReaderFact = !facts.some((f) => f !== 'list' && f !== 'none');
      // A warm reader opens from the relationship: never question-first (whatever the opening rule), and
      // insight-first only with an insight that fits them; peer-note, or the plain form, otherwise.
      const warm = warmReader(j);
      const allowed = STRUCTURE_IDS.filter(
        (s) =>
          !banned.has(s) &&
          !(warm && s === 'question-first') &&
          (only ? only.has(s) : !(s === 'question-first' && (nothingToGive || noReaderFact))) &&
          (s !== 'insight-first' || leadable(j).length) &&
          (s !== 'peer-note' || warm)
      );
      const kept = mine[j.touch];
      const free = (s) => !own.has(s) && !colleagues.has(s);
      const used = (x) => (perTouch[j.touch] || {})[x] || 0;
      // A structure at the 40% share of this touch's batch is passed over while another is free (with only
      // question-first and the plain form to choose from, an even split would fail the spread rule). A redraft
      // keeps its structure only below the cap, or the same over-share comes back every round.
      const scarce = (opts.proofs ?? 2) <= 1 && !(j.insight_options || []).length;
      const atCap = (x) =>
        x !== 'plain-request' && used(x) + 1 > Math.max(1, Math.floor((x === 'question-first' && scarce ? 1 / 3 : 0.4) * (sizeByTouch[j.touch] || 1)));
      if (only) {
        // The user's opening rule decides: one of the structures it leaves, the least used so far, or the plain
        // form when none fits this reader.
        const pool = allowed.filter(free).length ? allowed.filter(free) : allowed;
        if (kept && pool.includes(kept)) pick = kept;
        else if (!pool.length) pick = 'plain-request';
        else {
          const least = Math.min(...pool.map(used));
          const ties = pool.filter((s) => used(s) === least);
          pick = ties[i % ties.length];
          i++;
        }
      } else if (kept && allowed.includes(kept) && free(kept) && !atCap(kept)) pick = kept;
      else {
        // Every structure taken by a colleague or their own earlier message: the plain form, which colleagues may
        // share; a follow-up still never repeats the person's own last structure.
        const pool = [allowed.filter(free), ['plain-request'].filter((s) => !own.has(s)), allowed.filter((s) => !own.has(s)), allowed].find((l) => l.length);
        // The least used so far in this touch, rotating among ties: floorboss's own picks must pass its 40% spread rule.
        // Everything open is at the cap: the plain form, which has no cap (a plain follow-up after a plain first
        // message is fine). Taking an over-cap structure here would fail floorboss's own batch check.
        const open = pool.filter((s) => !atCap(s));
        const pickFrom = open.length ? open : ['plain-request'];
        const least = Math.min(...pickFrom.map(used));
        const ties = pickFrom.filter((s) => used(s) === least);
        pick = ties[i % ties.length];
        i++;
      }
    }
    out[`${j.id}:${j.touch}`] = pick;
    // The insight with the most room left takes this draft's place.
    if (pick === 'insight-first' && room) {
      const x = leadable(j).sort((a, b) => room[j.touch][b] - room[j.touch][a])[0];
      if (x) room[j.touch][x] -= 1;
    }
    (perTouch[j.touch] ||= {})[pick] = ((perTouch[j.touch] || {})[pick] || 0) + 1;
    (inRun[j.id] ||= []).push(pick);
    if (j.company_key) (byCompany[j.company_key] ||= []).push(pick);
  }
  return out;
}

// A draft that doesn't say its structure (the user's own drafter, a hand edit): read it from the text. A
// question in the first sentence is question-first; a short note is the plain form; anything else is left
// unnamed, and only the batch spread sees it.
export function inferStructure(draft) {
  const body = String(draft.body || '')
    .replace(/^(hi|hello|hey|dear)\b[^\n,]*,?\s*/i, '')
    .trim();
  // A full stop after an abbreviation ("Acme Bros.", "Inc.", "e.g.") doesn't end the sentence.
  const firstSentence = body.split(/(?<=[.?!])(?<!\b(?:Bros|Inc|Ltd|Co|Corp|Dr|Mr|Ms|Mrs|St|vs|e\.g|i\.e|Jr|Sr|No)\.)\s+/)[0] || '';
  if (/\?\s*$/.test(firstSentence)) return 'question-first';
  if (body && body.split(/\s+/).length <= 75) return 'plain-request';
  return null;
}

// Cheap checks that a draft is what it says it is.
// warm: the reader knows the sender, and the draft opens from the relationship: a question-first label on it (an
// older assignment, the user's own drafter) isn't held to opening with a question.
export function structureProblems(draft, { structure, factSource, insight, warm = false }) {
  const p = [];
  if (structure && !STRUCTURES[structure]) p.push(`"${structure}" isn't a structure (${STRUCTURE_IDS.join(', ')})`);
  if (factSource && !FACT_SOURCES.includes(factSource)) p.push(`"${factSource}" isn't a fact source (${FACT_SOURCES.join(', ')})`);
  const body = String(draft.body || '')
    .replace(/^(hi|hello|hey|dear)\b[^\n,]*,?\s*/i, '')
    .trim();
  const firstSentence = body.split(/(?<=[.?!])(?<!\b(?:Bros|Inc|Ltd|Co|Corp|Dr|Mr|Ms|Mrs|St|vs|e\.g|i\.e|Jr|Sr|No)\.)\s+/)[0] || '';
  if (structure === 'question-first' && !warm && !/\?\s*$/.test(firstSentence)) p.push('a question-first draft opens with a question');
  if (structure === 'insight-first' && !insight) p.push('an insight-first draft names the insight it leads with');
  if (structure === 'plain-request' && body.split(/\s+/).length > 75) p.push('the plain form is short: under 75 words');
  if (factSource === 'none' && structure && structure !== 'plain-request') p.push('with no fact about the reader, use the plain form');
  return p;
}

// Across a batch: no structure over 40% of a touch (plain requests aside), colleagues never share one.
// uncapped: the structures the user's opening rule asks for (OPENINGS[…].only), held to neither.
export function structureSpread(drafts, { uncapped = [] } = {}) {
  const free = new Set(['plain-request', ...uncapped]);
  const reasons = [];
  const n = drafts.filter((d) => d.structure).length;
  if (n >= 5) {
    const counts = {};
    for (const d of drafts) if (d.structure) counts[d.structure] = (counts[d.structure] || 0) + 1;
    // A plain request is the default for event meetings (a broad, senior ask): any share of a batch may use it;
    // the text-similarity check still catches a mail merge.
    for (const [s, k] of Object.entries(counts))
      if (!free.has(s) && k / n > 0.4) reasons.push(`${k} of ${n} drafts use the ${s} structure: vary them (no structure over 40% of a batch)`);
  }
  const byCo = {};
  for (const d of drafts) if (d.structure && d.company_key) (byCo[d.company_key] ||= []).push(d);
  for (const list of Object.values(byCo)) {
    const seen = {};
    // Colleagues may share the plain form: with more colleagues than structures it's the only way out, and the
    // similarity check still fails two notes that read alike.
    for (const d of list) {
      if (free.has(d.structure)) continue;
      if (seen[d.structure]) reasons.push(`${seen[d.structure]} and ${d.id} work at the same company and use the same ${d.structure} structure`);
      else seen[d.structure] = d.id;
    }
  }
  return reasons;
}
