// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Parsing the user's answers at a gate. IDs look like c014; companies use a slug (acme-freight).
// Triage: skip/remove, reach/rescue, warm, hold, "<who> is mine", confirm, separate, keep, cap. Draft: approve
// all [except …], approve, edit, drop. People may be named instead of an ID (pass `people`).

import { namesToIds, whoCouldBe } from './names.mjs';
import { shown, person, foldText } from './reading.mjs';

const ID = /^c\d{3,}$/;

// Kept here too for older callers.
export { namesToIds };

// Every answer the shortlist gate takes, as the question and the card show it: one list, so the wording the
// user is offered is always wording the parser reads.
export const TRIAGE_ANSWERS = [
  'ok',
  'skip <name or id> because <why>',
  'reach <name or id> (because <why>)',
  'warm <name or id> (because <why>)',
  '<name or id> is mine',
  'hold <name or id> until <owner> says yes',
  'leave <name or id> with <coworker>',
  'keep 40',
  'keep segment <slug>',
  'cap 2',
  'cap <company-slug> <n|all>',
  'confirm <id> (same person as the CRM record)',
  'separate <id> (a different person)',
  'note <name or id> (a note to the coworker who holds them)',
  'notes on (notes to coworkers for everyone they hold)'
];

const TRIAGE_VERBS = ['skip', 'remove', 'reach', 'rescue', 'warm', 'hold', 'leave', 'confirm', 'separate', 'cap', 'keep', 'note', 'notes'];
const DRAFT_VERBS = ['approve', 'edit', 'drop', 'hold'];
const VERB_RE = [...TRIAGE_VERBS, ...DRAFT_VERBS].join('|');
const MINE = /^(.+?)\s+is\s+(?:mine|my\s+own(?:\s+contact)?|my\s+contact|a\s+contact\s+of\s+mine)\.?$/i;

// The people whose names may stand for them in a draft answer, before it is read. An attendee called "Drop Tables" is
// addressed by id: a name that starts with a word of the answer would rewrite it, so "drop c002" became a name, and one
// with such a word later on ("All Except") counts by its first name only.
// Folded as the answer is (lib/reading.mjs foldText): combining marks out on both sides, so a Devanagari or Thai name
// compares whole.
const nameWords = (n) => foldText(n).split(/[^\p{L}\p{M}\d]+/u).filter(Boolean);
export function gatePeople(people) {
  const verb = new RegExp(`^(?:${VERB_RE}|all|except)$`, 'i');
  // A title before the name isn't part of it ("Mr. Skip Jones" starts with "Skip", so it goes by id).
  const untitled = (n) => String(n).replace(/^(?:(?:dr|dra|ing|arq|lic|prof|mr|mrs|ms|mx|sr|sra|srta)\.?\s+)+/i, '');
  return people.flatMap((p) => {
    const w = nameWords(untitled(p.name));
    if (verb.test(w[0])) return [];
    // Cut to its first word, as written ("Ana Drop" stands as "Ana").
    return w.some((x) => verb.test(x)) ? [{ ...p, name: untitled(p.name).split(/[^\p{L}\p{M}\d]+/u).filter(Boolean)[0] }] : [p];
  });
}

// The words of the names gatePeople left out: beside "approve all", a remark holding one of them may be holding that
// person back ("approve all, not Edit Kovacs"), so it's refused like one holding an id.
export function unnamedWords(people, named) {
  return people.filter((p) => !named.some((q) => q.id === p.id)).flatMap((p) => nameWords(p.name)).filter((w) => w.length > 1 && !/^(?:all|except)$/i.test(w));
}

// The words of the companies on the list, for the same check: "approve all but the Acme person" holds someone back.
// Words every company name can share don't count, or an ordinary remark would be refused.
export function companyWords(people) {
  return people.flatMap((p) => nameWords(p.company || '')).filter((w) => w.length > 1 && !/^(?:all|except|the|and|of|for|inc|llc|ltd|gmbh|co|corp|company|group)$/i.test(w));
}

// Ordinary ways of saying a gate command, read as the command ("yes, approve all", "approve everything", "approve all
// except for Cy", "keep the top 3", "drop John Lind please"). A reading made from one of these is never saved at once:
// it's shown back and waits for the user's yes (lib/reading.mjs).
const NB = '(?<![\\p{L}\\p{N}])';
const NE = '(?![\\p{L}\\p{N}])';
const AGREE = new RegExp(
  `^(?:ok|okay|sure|looks good|all good|good to go|go ahead|lgtm|fine|go|send them|send them all|send them out|approved|no changes|nothing to change|all of them|all|everyone|everything)${NE}[\\s.!,]*$`,
  'iu'
);
// names: false before the names are read, so a courtesy word that ends a listed name ("Bo Thanks") stays part of it.
function friendly(clause, names = true) {
  return clause
    .replace(new RegExp(`^ok(?:ay)?,?\\s+(?:but|and)\\s+(?=skip|remove|reach|warm|hold|leave|drop|approve|edit)`, 'iu'), '')
    .replace(names ? new RegExp(`[\\s,]+(?:please|thanks|thank you|thx|cheers|gracias)${NE}[\\s.!]*$`, 'iu') : /$^/, '')
    .replace(new RegExp(`^(?:yes|yep|yeah|ok|okay|sure|so|please|alright|go ahead and)${NE}[\\s,]+(?=\\p{L})(?!(?:please|thanks|thank you|thx|cheers|gracias)${NE}[\\s.!]*$)`, 'iu'), '')
    .replace(new RegExp(`^(?:everyone|everybody|all)\\s+(?:but|except(?:\\s+for)?)${NE}`, 'iu'), 'approve all except')
    .replace(new RegExp(`^top\\s+(\\d+)\\s*$`, 'iu'), 'keep $1')
    .replace(names ? new RegExp(`[\\s,]+(?:please|thanks|thank you|thx|cheers|gracias)${NE}[\\s.!]*$`, 'iu') : /$^/, '')
    .replace(new RegExp(`^approve\\s+(?:everything|everyone|everybody|them all|all of them|all the drafts|all drafts)${NE}`, 'iu'), 'approve all')
    .replace(new RegExp(`^approve all\\s+(?:but|apart from|other than|besides)${NE}`, 'iu'), 'approve all except')
    .replace(new RegExp(`${NB}except\\s+for${NE}`, 'iu'), 'except')
    .replace(new RegExp(`^(?:keep|only)\\s+(?:the\\s+)?top\\s+(\\d+)\\s*$`, 'iu'), 'keep $1')
    .replace(new RegExp(`^(?:max(?:imum)?|at most)\\s+(\\d+)\\s+(?:per|a|from each)\\s+company\\s*$`, 'iu'), 'cap $1');
}
// At the drafts, "skip Cy" or "remove Cy" is a drop, and "hold Cy" leaves Cy's draft unapproved.
const draftWords = (clause) => clause.replace(new RegExp(`^(?:skip|remove|cut|take out|leave out)${NE}\\s*`, 'iu'), 'drop ');
// At the shortlist, the words people use for "skip" ("drop Cy", "take out Cy", "don't contact Cy"), and "I know Ana".
const triageWords = (clause) =>
  clause
    .replace(new RegExp(`^(?:drop|take out|cut|exclude|leave out|don'?t contact|do not contact)${NE}\\s*`, 'iu'), 'skip ')
    .replace(new RegExp(`^i know\\s+(.+)$`, 'iu'), '$1 is mine');

// The same, over a whole answer, line by line: run before names are read, so "except for Cy" reads Cy's name.
export const friendlyAnswer = (text) =>
  String(text ?? '')
    .split(/(\r\n|[\n\r;])/)
    .map((x) => (/^(?:\r\n|[\n\r;])$/.test(x) ? x : friendly(x.trim(), false)))
    .join('');

function splitClauses(text) {
  // Clauses end at ; or a new line, or at a comma or "and" followed by a gate verb ("remove c003, rescue c004"),
  // or by "<who> is mine". A reason ("because …") may hold commas of its own; a verb after one still starts a clause.
  const next = `(?=(?:${VERB_RE})\\b|[^,;\\n]+?\\s+is\\s+(?:mine|my\\s+own|my\\s+contact|a\\s+contact\\s+of\\s+mine)\\b)`;
  return String(text ?? '')
    .split(new RegExp(`[;\\n·]+|,\\s*${next}|\\s+and\\s+${next}`, 'i'))
    .map((s) => s.trim())
    .filter(Boolean);
}

function ids(rest) {
  return rest
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== 'and' && s !== '&');
}

export class GateError extends Error {}

// partial: a clause that can't be read is refused on its own (out.refused: [{ line, why }]) and the others are
// read, so one misread line never drops the rest; without it, the first bad clause throws.
// among: everyone on the list ({id, name}), so a name that fits more than one is asked about by name and id.
export function parseGate(text, { kind, knownIds = null, people = null, partial = false, unnamed = [], among = people } = {}) {
  const trimmed = String(text ?? '').trim();
  const out = { actions: [], defaults: false, refused: [] };
  // No answer is no answer: "ok" (or "defaults") has to be said. "yes" answers a reading shown back (lib/reading.mjs).
  if (!trimmed) throw new GateError('No answer was given: ask the user and pass their words.');
  // Punctuation alone (";", "·") is no answer either: never read as "ok".
  if (!/[\p{L}\p{N}]/u.test(trimmed)) throw new GateError('No answer was given: ask the user and pass their words.');
  if (/^(defaults|ok)[.!]?$/i.test(trimmed)) {
    out.defaults = true;
    return out;
  }
  const verbs = kind === 'triage' ? TRIAGE_VERBS : DRAFT_VERBS;
  const usage = kind === 'triage' ? TRIAGE_ANSWERS.join(' · ') : verbs.join(', ');
  // Names are turned into IDs only in the part of a clause that names people, never in a reason or an owner.
  // What each name was read as, said back with the answer (out.read_as).
  const readAs = [];
  const toIds = (s) => (people ? namesToIds(s, people, among, { readAs }) : s);
  const seen = new Map();
  // IDs left out of an "approve all" ("except"), across every clause and line: one also approved by name is the
  // contradiction "approve all except c016" then "approve c016" was, never read as the approval.
  const excepted = new Set();
  const unknown = [];
  const bothSaid = (id) => new GateError(`${id} is both left out ("except") and approved by name in this answer: say which, on a line of its own.`);
  const noteExcept = (id) => {
    id = id.replace(/:\d+$/, '');
    if (seen.get(id) === 'approve') throw bothSaid(id);
    excepted.add(id);
  };
  // The question for a word that could be more than one listed person: "Which Ana: Ana Costa (c001) or Ana Berg (c002)?"
  const example = kind === 'triage' ? 'skip' : 'approve';
  const whichOf = (word) => {
    const may = among && !ID.test(word) ? whoCouldBe(word, among) : [];
    if (may.length < 2) return '';
    const listed = may.slice(0, 6).map((p) => person(p.id, p.name));
    return `Which ${shown(word)}: ${listed.slice(0, -1).join(', ')} or ${listed[listed.length - 1]}${may.length > 6 ? `, or ${may.length - 6} more` : ''}? Answer with the ID, for example "${example} ${may[0].id}".`;
  };
  const which = (s) => ids(String(s)).map(whichOf).find(Boolean) || '';
  const note = (id, verb) => {
    // A message number ("c001:1") is for the drafts; at the shortlist an answer is about the person.
    if (kind === 'triage' && /^c\d{3,}:\d+$/i.test(id))
      throw new GateError(`"${id}" names one message, and the shortlist is about people: say "${verb === 'remove' ? 'skip' : verb} ${id.replace(/:\d+$/, '')}".`);
    id = id.replace(/:\d+$/, ''); // "c017:2" names this run's draft for c017
    if (!ID.test(id) && whichOf(id)) throw new GateError(`"${id}" could be more than one person on this list. ${whichOf(id)}`);
    // One person it could be: named, so the user can say so by ID.
    const one = among && !ID.test(id) ? whoCouldBe(id, among) : [];
    if (!ID.test(id) && one.length === 1)
      throw new GateError(`"${id}" isn't an ID or a whole name on this list. If you mean ${person(one[0].id, one[0].name)}, answer with the ID, for example "${example} ${one[0].id}". Put commas between names, or use IDs.`);
    if (!ID.test(id)) throw new GateError(`"${id}" isn't an ID like c014${people || among ? ' or the name of one person on this list' : ''}. Put commas between names, or use IDs.`);
    if (knownIds && !knownIds.has(id)) unknown.push(id);
    if (verb === 'approve' && excepted.has(id)) throw bothSaid(id);
    if (seen.has(id) && seen.get(id) !== verb) {
      throw new GateError(`${id} has two different answers (${seen.get(id)} and ${verb}). Give it one.`);
    }
    seen.set(id, verb);
  };
  const who = (s, verb) => {
    const list = ids(toIds(s));
    if (!list.length) throw new GateError(`"${verb}" needs at least one name or ID.`);
    list.forEach((id) => note(id, verb));
    return list;
  };
  for (const original of splitClauses(trimmed)) {
    const before = {
      actions: out.actions.length,
      unknown: unknown.length,
      seen: new Map(seen),
      excepted: new Set(excepted),
      comments: out.comments?.length || 0
    };
    try {
      clause(original);
    } catch (err) {
      if (!partial || !(err instanceof GateError)) throw err;
      out.actions.length = before.actions;
      unknown.length = before.unknown;
      seen.clear();
      for (const [k, x] of before.seen) seen.set(k, x);
      excepted.clear();
      for (const k of before.excepted) excepted.add(k);
      if (out.comments) out.comments.length = before.comments;
      out.refused.push({ line: original.slice(0, 200), why: err.message });
      continue;
    }
    // An id this list doesn't have refuses its own clause only.
    if (partial && unknown.length > before.unknown) {
      out.refused.push({ line: original.slice(0, 200), why: `These IDs aren't on this list: ${[...new Set(unknown.slice(before.unknown))].join(', ')}.` });
      out.actions.length = before.actions;
      unknown.length = before.unknown;
    }
  }
  if (unknown.length) throw new GateError(`These IDs aren't on this list: ${[...new Set(unknown)].join(', ')}.`);
  // "ok" beside "approve all" is the same answer twice, perhaps two ways ("approve all except John" and "ok"): asked.
  if (out.defaults && out.actions.some((a) => a.verb === 'approve-all')) throw new GateError('"ok" and "approve all" are both said in this answer: say it once, for example "approve all except c002".');
  if (readAs.length) out.read_as = readAs;
  return out;

  function clause(said) {
    // Each action keeps the line it came from: that line, not the whole answer, is the user's words about it
    // (kept out of the action's own fields, so an action still compares as what it does).
    const original = kind === 'triage' ? triageWords(friendly(said)) : draftWords(friendly(said));
    const push = (x) => out.actions.push(Object.defineProperty(x, 'line', { value: said, enumerable: false }));
    const clause = original.toLowerCase();
    if (/^(defaults|ok)$/.test(clause) || AGREE.test(clause)) {
      out.defaults = true;
      return;
    } // "remove c003; defaults"
    // "Ana Berg is mine", "c014 is my own contact": warm, and the user knows them.
    const mine = kind === 'triage' && MINE.exec(original);
    if (mine && !verbs.includes(clause.split(/\s+/)[0])) {
      push({ verb: 'mine', ids: who(mine[1], 'mine') });
      return;
    }
    const [verb, ...restParts] = clause.split(/\s+/);
    const rest = restParts.join(' ');
    if (!verbs.includes(verb)) {
      throw new GateError(`"${verb}" isn't an answer here. Use: ${usage}.`);
    }
    if (verb === 'cap') {
      // "cap 2": at most two people from any one company (a company's own cap still wins).
      const every = /^(\d+|all|off)$/.exec(rest);
      if (every) {
        push({ verb, company: '*', value: every[1] === 'all' || every[1] === 'off' ? 'all' : Number(every[1]) });
        return;
      }
      const mt = /^([a-z0-9][a-z0-9-]*)\s+(\d+|all)$/.exec(rest);
      if (!mt) throw new GateError(`Write caps as "cap <company> <number|all>" (e.g. "cap acme-freight 50"), or "cap 2" for every company.`);
      push({ verb, company: mt[1], value: mt[2] === 'all' ? 'all' : Number(mt[2]) });
      return;
    }
    // "notes on" / "notes off": notes to the coworker who holds someone, for everyone they hold.
    if (verb === 'notes') {
      const m = /^(on|off|yes|no)$/.exec(rest);
      if (!m) throw new GateError('Write "notes on" (a note to the coworker for everyone they hold), "notes off", or "note <name>" for one person.');
      push({ verb, on: m[1] === 'on' || m[1] === 'yes' });
      return;
    }
    // "keep 40" / "keep top 40": the 40 best-ranked; "keep segment ops-leaders": only that segment.
    if (verb === 'keep') {
      const n = /^(?:top\s+)?(\d+)$/.exec(rest),
        seg = /^segments?\s+([a-z0-9][a-z0-9-]*(?:\s*,\s*[a-z0-9][a-z0-9-]*)*)$/.exec(rest);
      if (n) push({ verb, top: Number(n[1]) });
      else if (seg) push({ verb, segments: seg[1].split(/\s*,\s*/) });
      else throw new GateError('Write "keep 40" (the 40 best-ranked) or "keep segment <slug>".');
      return;
    }
    // "skip Ana because she left": a remove that keeps the user's reason, in their words.
    if (verb === 'skip' || verb === 'remove') {
      // "skip Cy, he left": a remark after a comma that starts with he, she, they… is the reason too.
      const bc = /^(.*?)(?:\s+(?:because|as|since)\s+|,\s+(?=(?:he|she|they|it|we|i)(?![\p{L}\p{N}])))(.+)$/iu.exec(original.replace(/^\S+\s+/, ''));
      push({ verb: 'remove', ids: who(bc ? bc[1] : original.replace(/^\S+\s+/, ''), 'skip'), ...(bc ? { because: bc[2].trim() } : {}) });
      return;
    }
    // "hold Ana until Dana says yes": left alone until the owner agrees.
    // "hold Ana" with no "until": left with the coworker who holds them, as "leave Ana with Dana" is.
    if (verb === 'hold') {
      const h = /^(.+?)\s+until\s+(.+?)(?:\s+(?:says?|gives?|okays?)\s+(?:yes|ok|okay|the ok|the go-ahead|so))?\.?$/i.exec(original.replace(/^\S+\s+/, ''));
      if (!h) {
        push({ verb: 'leave', ids: who(original.replace(/^\S+\s+/, '').replace(/[.!]+$/, ''), 'leave') });
        return;
      }
      push({ verb: 'hold', ids: who(h[1], 'hold'), until: h[2].trim() });
      return;
    }
    // "leave Daniel with Priya": the coworker who holds them keeps them (the choice a refused "reach" offers).
    if (verb === 'leave') {
      const l = /^(.+?)(?:\s+(?:with|to)\s+(.+?))?\.?$/i.exec(original.replace(/^\S+\s+/, ''));
      if (!l) throw new GateError('Write "leave <name or id> with <coworker>".');
      push({ verb: 'leave', ids: who(l[1], 'leave'), ...(l[2] ? { with: l[2].trim() } : {}) });
      return;
    }
    if (verb === 'approve' && /^all\b/.test(rest)) {
      // "approve all", "approve all except c019, c027", and what follows it in the user's own words: "and c016 as
      // it is" (or "anyway") approves c016 by name, a draft the critic failed too; a bare "c016 too" is approved
      // as "approve all" approves it, only if it passes. A remark with no ID and no gate word in it ("the critic
      // is being picky") is a comment, kept and said back, not an instruction. Anything else in it can't be read,
      // and an ID both left out and approved by name is a contradiction, never guessed at.
      const except = [],
        also = [],
        asIs = [];
      let mode = null;
      const allIds = (s) => {
        const l = ids(toIds(s));
        return l.length && l.every((id) => ID.test(id.replace(/:\d+$/, ''))) ? l : null;
      };
      // Once "except" is said, every list of IDs after it in the line is more of the people held back: "except John, Cy
      // too" holds back Cy as well, never approves him.
      const tail = (x) => x.replace(/\s+(?:too|as well|also|anyway|as\s+(?:it|they)?\s*(?:is|are))$/i, '');
      for (const raw of original.replace(/^\S+\s+all\b[.!]?/i, '').split(',')) {
        const piece = raw
          .trim()
          .replace(/^(?:and|plus|also)\s+/i, '')
          .replace(/[.!]+$/, '')
          .trim();
        if (!piece) continue;
        const ex = /^except\s+(.+)$/i.exec(piece);
        const extra = /^(?:approve\s+)?(?:also\s+)?(.+?)(?:\s+(?:too|as well|also))?(?:\s+(?:as\s+(?:it|they)?\s*(?:is|are)|anyway))?$/i.exec(piece);
        const override = /\s(?:as\s+(?:it\s+|they\s+)?(?:is|are)|anyway)$/i.test(` ${piece}`);
        const named = override || /\s(?:too|as well|also)$/i.test(` ${piece}`) || /^approve\s/i.test(piece);
        if (ex) {
          const l = allIds(tail(ex[1]));
          if (!l) throw new GateError(`"${piece.slice(0, 80)}" isn't a list of IDs or listed names. ${which(ex[1]) || 'Say who by their IDs, for example "approve all except c002".'}`);
          except.push(...l);
          mode = 'except';
        } else if (mode === 'except' && allIds(tail(piece))) except.push(...allIds(tail(piece)));
        else if (mode !== 'except' && named && allIds(extra[1])) (override ? asIs : also).push(...allIds(extra[1]));
        // A remark that names nobody ("the critic is being picky", "no changes", even "no enviar") is kept as a comment:
        // the reading shown back says it wasn't taken as an instruction, and nothing is saved before the user's yes. One
        // that holds an ID, a gate verb or a word of a listed name may be about someone: asked again.
        else if (
          !new RegExp(`${NB}c\\d{3,}${NE}`, 'iu').test(piece) &&
          !new RegExp(`^(?:${VERB_RE})${NE}`, 'iu').test(piece) &&
          !(unnamed.length && new RegExp(`(?<![\\p{L}\\p{M}\\d])(?:${unnamed.join('|')})(?![\\p{L}\\p{M}\\d])`, 'iu').test(piece))
        )
          (out.comments ||= []).push(piece.slice(0, 200));
        else
          throw new GateError(
            `"${piece.slice(0, 80)}" beside "approve all" may be about someone. ${which(piece) || 'Say who by their IDs, for example "approve all except c002", or say "approve all" on its own.'}`
          );
      }
      const both = [...new Set([...also, ...asIs].filter((id) => except.includes(id)))];
      if (both.length)
        throw new GateError(
          `${both.join(', ')} ${both.length > 1 ? 'are' : 'is'} both left out ("except") and approved by name in "${original.slice(0, 80)}": say which, on a line of ${both.length > 1 ? 'their' : 'its'} own.`
        );
      except.forEach((id) => {
        if (knownIds && !knownIds.has(id)) unknown.push(id);
        noteExcept(id);
      });
      // Two "approve all" answers in one ("approve all except John" and then "approve all") are two readings: asked.
      if (out.actions.some((a) => a.verb === 'approve-all')) throw new GateError('"approve all" is said twice in this answer, in two ways: say it once.');
      push({ verb: 'approve-all', except: [...new Set(except)] });
      // pass_only: approved as "approve all" approves, so a draft the critic failed stays held.
      const plain = also.filter((id) => !asIs.includes(id));
      if (plain.length) {
        plain.forEach((id) => note(id, 'approve'));
        push({ verb: 'approve', ids: plain, pass_only: true });
      }
      if (asIs.length) {
        asIs.forEach((id) => note(id, 'approve'));
        push({ verb: 'approve', ids: asIs });
      }
      return;
    }
    // "warm Kate because we met at Tillcon": the reason, in the user's words, is kept with the decision (and as
    // the person's note, for the drafter and the critic), never read as a name.
    const bc = ['reach', 'warm', 'rescue'].includes(verb) ? /^(.*?)\s+(?:because|since)\s+(\S[\s\S]*)$/i.exec(original.replace(/^\S+\s+/, '')) : null;
    const head = bc ? bc[1].toLowerCase() : rest;
    // "reach Paul anyway (say so)": the user knows a coworker holds them and writes to them all the same.
    const anyway = ['reach', 'warm', 'rescue'].includes(verb) && /\s+anyway\b.*$/i.exec(head);
    const list = ids(toIds(anyway ? head.slice(0, anyway.index) : head));
    if (!list.length) throw new GateError(`"${verb}" needs at least one ID.`);
    list.forEach((id) => note(id, verb === 'rescue' ? 'reach' : verb));
    push({ verb, ids: list, ...(anyway ? { anyway: true } : {}), ...(bc ? { because: bc[2].trim() } : {}) });
  }
}
