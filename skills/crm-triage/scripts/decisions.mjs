// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The user's answers on check-these, one person per line: "c012 same-person crm:3", "c020 reach because she
// asked; we met in May". A reason may hold ; and , of its own, so a line ends at a new line, or at a ; or ,
// that starts the next answer ("…; c021 skip"). Group lines answer many at once: "all intern: skip because not
// buyers", "all at Acme: reach", "everyone else: warm". A line for one person beats a group line.
import { stripAccents, companyKey, companyRelated } from '../../../lib/normalize.mjs';

const GROUP = 'same-person|different-person|not-in-crm|reach|warm|skip|colleague|hold';
// "c009 reach anyway because …": the user knows a coworker holds them and writes to them all the same.
// "c008 same-person crm:5 warm because we met at Tillcon": the match settled, then the decision, on one line.
const LINE = new RegExp(
  `^(c\\d+)\\s+(${GROUP})(\\s+anyway)?(?:\\s+(crm:\\d+|all))?(?:\\s+(reach|warm|skip)(\\s+anyway)?)?(?:\\s+(?:because|as|since)\\s+(.+))?$`,
  'is'
);
// Group lines take reach, warm or skip only: a CRM match is settled one person at a time.
// "all of Dana's: hold" answers everyone a coworker holds at once (hold: leave them to that coworker).
const GROUP_LINE =
  /^(?:all\s+of\s+(.+?)['’]s|all\s+at\s+(.+?)|all\s+(.+?)|everyone\s+else)\s*:\s*(reach|warm|skip|hold|colleague)(?:\s+(?:because|as|since)\s+(.+))?$/is;
const GROUP_START = 'all\\s+[^:;,\\n]+:\\s*(?:reach|warm|skip|hold|colleague)\\b|everyone\\s+else\\s*:';

export const DECISION_FORMS =
  'one line per person: "<id> same-person crm:<row>", "<id> different-person", "<id> not-in-crm" (the CRM lookup gave no answer and the CRM has nobody for them), or "<id> reach|warm|skip because <why>" (an uncertain match and the decision on one line: "<id> same-person crm:<row> warm because <why>"); or one line per group: "all of <coworker>\'s: hold|reach|skip" (everyone that coworker holds), "all <words in their title>: reach|warm|skip because <why>", "all at <company>: …", "everyone else: …" (a line for one person beats a group line)';

export function splitDecisionLines(v) {
  const text = Array.isArray(v) ? v.join('\n') : String(v ?? '');
  return text
    .split(new RegExp(`\\n+|[;,]\\s*(?=c\\d+\\s+(?:${GROUP})\\b|${GROUP_START})`, 'i'))
    .map((x) => x.trim())
    .filter(Boolean);
}

// Every line is read before anything is saved: one line that isn't a decision refuses the batch, so a batch is
// saved whole or not at all. Group lines come back with `scope` (title, company or rest) instead of an id.
export function parseDecisionLines(v) {
  const lines = splitDecisionLines(v);
  const out = [],
    bad = [];
  for (const line of lines) {
    const m = LINE.exec(line);
    const first = m && (m[2].toLowerCase() === 'hold' ? 'colleague' : m[2].toLowerCase());
    // A second verb only follows a match answer: "c008 reach warm" isn't a decision.
    // "not-in-crm" names no CRM row (there was none): a row, "all" or "anyway" after it isn't this answer.
    if (m && first === 'not-in-crm' && (m[3] || m[4])) {
      bad.push(`${line} (not-in-crm takes no CRM row, "all" or "anyway": "${m[1]} not-in-crm")`);
      continue;
    }
    if (m && m[5] && !['same-person', 'different-person', 'not-in-crm'].includes(first)) {
      bad.push(line);
      continue;
    }
    if (m && m[5]) {
      out.push(
        { id: m[1].toLowerCase(), group: first, ref: m[4] ? m[4].toLowerCase() : null, because: null, line },
        { id: m[1].toLowerCase(), group: m[5].toLowerCase(), ref: null, because: m[7] ? m[7].trim() : null, ...(m[6] ? { anyway: true } : {}), line }
      );
      continue;
    }
    if (m) {
      out.push({
        id: m[1].toLowerCase(),
        group: first,
        ref: m[4] ? m[4].toLowerCase() : null,
        because: m[7] ? m[7].trim() : null,
        ...(m[3] ? { anyway: true } : {}),
        line
      });
      continue;
    }
    const g = GROUP_LINE.exec(line);
    if (g) {
      const grp = g[4].toLowerCase() === 'hold' ? 'colleague' : g[4].toLowerCase();
      out.push({
        id: null,
        scope: g[1] ? { owner: g[1].trim() } : g[2] ? { company: g[2].trim() } : g[3] ? { title: g[3].trim() } : { rest: true },
        group: grp,
        ref: null,
        because: g[5] ? g[5].trim() : null,
        line
      });
      continue;
    }
    bad.push(line);
  }
  if (bad.length)
    throw new Error(
      `${bad.map((l) => `"${l.slice(0, 80)}"`).join(', ')} ${bad.length > 1 ? "aren't decisions" : "isn't a decision"}. Write ${DECISION_FORMS}. Nothing was saved.`
    );
  return out;
}

const fold = (s) => stripAccents(String(s ?? '')).toLowerCase();
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole words of the title, in order, a plural s allowed: "intern" is "Interns", never "Internal Comms".
const titleHas = (title, words) =>
  new RegExp(`(?:^|[^a-z0-9])${fold(words).trim().split(/\s+/).map(esc).join('[^a-z0-9]+')}s?(?:[^a-z0-9]|$)`).test(fold(title));

// Who each group line covers among the people on check-these (people: [{ id, title, company, company_key }]).
// taken: ids a line of their own answers. Lines go in the order written, "everyone else" last; a person goes to
// the first line that names them. Returns per line the ids it matched.
export function matchGroups(groups, people, taken = new Set()) {
  const done = new Set(taken);
  const order = [...groups.filter((g) => !g.scope.rest), ...groups.filter((g) => g.scope.rest)];
  return order.map((g) => {
    const ownerHit = (p) => !!p.holder && (fold(p.holder) === fold(g.scope.owner) || fold(p.holder).split(/\s+/)[0] === fold(g.scope.owner).split(/\s+/)[0]);
    const hit = people.filter(
      (p) =>
        !done.has(p.id) &&
        (g.scope.rest ||
          (g.scope.owner
            ? ownerHit(p)
            : g.scope.title
              ? titleHas(p.title, g.scope.title)
              : p.company_key && companyRelated(companyKey(g.scope.company), p.company_key)))
    );
    for (const p of hit) done.add(p.id);
    return { ...g, ids: hit.map((p) => p.id) };
  });
}
