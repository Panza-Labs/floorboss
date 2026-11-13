// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// How a gate answer about people is taken. An answer made only of the gate's own commands, IDs and whole names that
// can mean one person and nothing else is saved at once (DIRECT). Anything else that still reads one way is shown
// back as that reading and saved only on the user's own "yes" (CONFIRM): the reading waits on disk, and a "yes"
// applies exactly that reading, nothing else. The DIRECT test is a list of what may pass, never a list of what may not.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from './jsonio.mjs';

// Characters that change nothing a reader sees: format characters (a right-to-left override, zero-width spaces),
// variation selectors, the combining grapheme joiner and the Hangul fillers. Stripped before names are compared, and a
// row that held one goes by ID only.
const INVISIBLE = /[\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u034F\u115F\u1160\u3164\uFFA0]/gu;
// Letters from other scripts that look like Latin ones ("Аna" with a Cyrillic A, "ТОМ СОХ" in Cyrillic capitals):
// compared as the Latin letter. Read before lower case, since a capital and its small letter may look like different
// Latin ones (Greek Ν is N, ν is v).
const LOOKALIKE = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y', І: 'I', Ј: 'J', Ѕ: 'S',
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
  α: 'a', ο: 'o', ν: 'v', τ: 't', ρ: 'p', κ: 'k', ι: 'i', ε: 'e', υ: 'u', χ: 'x',
  ɑ: 'a', ı: 'i', ʏ: 'y', ո: 'n', ս: 'u', օ: 'o'
};
export const hasInvisible = (s) => new RegExp(INVISIBLE.source, 'u').test(String(s ?? ''));
// A name as names are compared: compatibility forms folded ("Ａｎａ" is "Ana"), invisible characters and combining
// marks removed, look-alike letters read as Latin, lower case, single spaces.
export const fold = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(INVISIBLE, '')
    .replace(/\p{M}/gu, '')
    .replace(/./gu, (ch) => LOOKALIKE[ch] || ch)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
// For comparing whole names: titles off, and every dash and space one separator ("Mary-Ann Lee", "Mary‐Ann Lee" and
// "Mary Ann Lee" are written alike).
const TITLE = /^(?:(?:dr|dra|ing|arq|lic|prof|mr|mrs|ms|mx|sr|sra|srta)\.?\s+)+/;
export const sameName = (s) => fold(s).replace(TITLE, '').replace(/[\p{Pd}\s]+/gu, ' ').trim();
// An answer as names are read in it: the same folding, line breaks kept, look-alike letters left as typed.
export const foldText = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(INVISIBLE, '')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
const SCRIPTS = ['Latin', 'Cyrillic', 'Greek', 'Armenian', 'Georgian', 'Arabic', 'Hebrew', 'Devanagari', 'Bengali', 'Tamil', 'Thai', 'Hangul', 'Han', 'Hiragana', 'Katakana'].map((x) => [x, new RegExp(`\\p{Script=${x}}`, 'u')]);
// Letters from more than one script in one name ("Ana 安娜", "Аna" with a Cyrillic A). Japanese mixes three by nature.
export function mixedScripts(name) {
  const seen = new Set();
  for (const ch of String(name ?? '').normalize('NFC')) {
    if (!/\p{L}/u.test(ch)) continue;
    const s = SCRIPTS.find(([, re]) => re.test(ch))?.[0] || 'other';
    seen.add(['Han', 'Hiragana', 'Katakana'].includes(s) ? 'cjk' : s);
  }
  return seen.size > 1;
}
// A row that can be confused with others by how it is written: it goes by ID only.
export const suspicious = (name) => hasInvisible(name) || mixedScripts(name);

// A name as it is shown back: ID first, then this in quotes. Nothing that could pose as part of the sentence around
// it: only letters, marks, digits, spaces, hyphens and an apostrophe inside a word are kept (no quotes, brackets,
// colons, full stops or look-alikes of them such as ʺ ꞉ 。), nothing shaped like an ID anywhere in it (read as names
// are: look-alike letters, other digits, glued to other characters), no invisible or control characters; no longer
// than a name. keepIds: the user's own words, quoted, keep their IDs.
export const shown = (name, max = 40, { keepIds = false, prose = false } = {}) => {
  // prose: row text inside a sentence (a CRM status, a deal name, a note), which keeps : ( ) , . / as well; quote
  // marks, ; and every other sign still go.
  const keep = prose ? /[\p{Lu}\p{Ll}\p{Lt}\p{Lo}\p{M}\p{N} '’:(),./-]/u : /[\p{Lu}\p{Ll}\p{Lt}\p{Lo}\p{M}\p{N}\s'’-]/u;
  const plain = [...String(name ?? '').normalize('NFKC').replace(INVISIBLE, '')]
    .map((ch) => (keep.test(ch) ? ch : ' '))
    .join('')
    .replace(/(^|[^\p{L}])['’]+|['’]+(?=[^\p{L}]|$)/gu, '$1 ');
  let out = plain;
  if (!keepIds) {
    // Found on the folded spelling (one character for one), and blanked in the text shown.
    const folded = [...plain].map((ch) => String(LOOKALIKE[ch] || ch).toLowerCase()[0] || ch);
    const chars = [...plain];
    const re = /(?<![\p{L}\p{N}])c\p{Nd}+(?![\p{L}\p{N}])/gu;
    for (const m of folded.join('').matchAll(re)) {
      const start = [...folded.join('').slice(0, m.index)].length;
      for (let i = start; i < start + [...m[0]].length; i++) chars[i] = ' ';
    }
    out = chars.join('');
  }
  const cleaned = (prose ? out : out.replace(/(^|\s)[-'’]+|[-'’]+(?=\s|$)/gu, '$1 ')).replace(/\s+/g, ' ').trim().slice(0, max);
  return prose ? cleaned : `"${cleaned || 'no name'}"`;
};
// Row, CRM and list text inside a sentence the user is shown: never a quote mark, a ; or an ID shape.
export const plainText = (x, max = 120) => shown(x, max, { prose: true });
export const person = (id, name) => `${id} ${shown(name)}`;

// Every word either gate reads as a command or a keyword, and the words of courtesy and of a change of mind: a name
// holding one ("Jo Cut", "Bo Thanks", "Ana All") is never taken by its name at once.
export const COMMAND_WORDS = new Set(
  (
    'approve approved edit drop dropped skip remove reach rescue warm hold leave confirm separate note notes keep cap cut all except ' +
    'no none nothing nobody not nor but and or plus too also anyway as well is it mine my own contact ok okay yes y si sí defaults ' +
    'please pls thanks thank thx you kindly gracias por favor merci because since until with without only just everyone everything ' +
    'everybody them top segment segments says go ahead fine good great looks lgtm send sent later wait stop hold off out back ' +
    'change changes edits send instead rather excluding exclude excepto menos sin todos todo ' +
    'the rest others other those these first last next anyone each every one two three four five six seven eight nine ten'
  ).split(' ')
);
// A word that counts as a command for the DIRECT test: one of those, or digits alone.
const commandWord = (w) => COMMAND_WORDS.has(w) || /^\p{Nd}+$/u.test(w);

// The fold of a typed answer, for the DIRECT test: invisible characters out, lower case, single spaces, no full stop
// or exclamation mark at the end of a line.
const foldAnswer = (t) =>
  String(t ?? '')
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .toLowerCase()
    .split(/\r\n|[\n\r;]/)
    .map((l) => l.replace(/[ \t]+/g, ' ').trim().replace(/[.!]+$/, '').trim())
    .filter(Boolean);
const ID_ITEM = /^c\d{3,}(?::\d+)?$/;
const N = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';

// The DIRECT reading of an answer, or null. rows: everyone the gate lists ({ id, name }); ids: the IDs it may name.
// Returns the reading's signature (see signature), comparable with what the parser read.
export function directReading(text, { kind, rows, ids }) {
  const lines = foldAnswer(text);
  if (!lines.length) return null;
  const R = rows.map((r) => ({ id: r.id, raw: r.name, n: sameName(r.name), w: sameName(r.name).split(/[^\p{L}\p{N}'’]+/u).filter(Boolean) })).map((r) => ({ ...r, parts: [...r.w, ...r.w.flatMap((x) => x.split(/['’]+/).filter(Boolean))] }));
  // A whole name that can only be this one person: two words or more, exactly one row written so, no other row with
  // that first name or holding all of its words, no command word in it, nothing in it that hides how it reads.
  const byName = (typed) => {
    const item = sameName(typed);
    const words = item.split(' ');
    if (words.length < 2) return null;
    const hits = R.filter((r) => r.n === item);
    if (hits.length !== 1) return null;
    const r = hits[0];
    if (suspicious(r.raw) || r.w.some(commandWord) || !/^[\p{L}'’ ]+$/u.test(r.n)) return null;
    const others = R.filter((x) => x.id !== r.id);
    if (others.some((x) => x.w[0] === r.w[0] || words.every((q) => x.parts.includes(q)) || suspicious(x.raw))) return null;
    return r.id;
  };
  const list = (s) => {
    const items = s.split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map((x) => x.trim());
    const out = [];
    for (const it of items) {
      if (!it) return null;
      // IDs with only spaces between them ("approve c002 c003") are a list of IDs; names never are.
      const spaced = it.split(' ');
      if (spaced.length > 1 && spaced.every((x) => ID_ITEM.test(x))) {
        if (ids && spaced.some((x) => !ids.has(x.replace(/:\d+$/, '')))) return null;
        out.push(...spaced);
        continue;
      }
      if (ID_ITEM.test(it)) {
        if (ids && !ids.has(it.replace(/:\d+$/, ''))) return null;
        out.push(it);
        continue;
      }
      const id = byName(it);
      if (!id) return null;
      out.push(id);
    }
    return out.length ? out : null;
  };
  // The words in a reason, an owner or a coworker's name ("because …", "until …", "with …") act on nobody: a slot that
  // holds an ID, a gate verb or a listed name might, so that answer is read back first.
  const VERB_WORDS = new Set('approve edit drop skip remove reach rescue warm hold leave confirm separate note notes keep cap cut take'.split(' '));
  const slotOk = (t) => {
    if (t == null) return true;
    const w = sameName(t).split(/[^\p{L}\p{N}'’]+/u).filter(Boolean);
    return !w.some((x) => /^c\p{Nd}+$/u.test(x) || VERB_WORDS.has(x) || R.some((r) => r.w[0] === x)) && !R.some((r) => r.w.length > 1 && ` ${w.join(' ')} `.includes(` ${r.n} `));
  };
  const verbs = kind === 'triage' ? 'skip|remove|reach|rescue|warm|hold|leave|confirm|separate|note|keep|cap|notes' : 'approve|edit|drop';
  const clauses = lines.flatMap((l) => l.split(new RegExp(`\\s*,\\s*(?=(?:${verbs})${E})|\\s+and\\s+(?=(?:${verbs})${E})`, 'u')));
  const sig = [];
  for (const c of clauses) {
    let m;
    if (/^(?:ok|defaults)(?:[\s,]+(?:thanks|thank you|gracias|please))?$/.test(c)) sig.push('defaults');
    else if (kind !== 'triage' && c === 'approve all') sig.push('approve-all:');
    else if (kind !== 'triage' && (m = /^approve all except (.+)$/.exec(c))) {
      const l = list(m[1]);
      if (!l) return null;
      sig.push(`approve-all:${[...new Set(l)].sort().join(',')}`);
    } else if ((m = new RegExp(`^(approve|edit|drop)${E} (.+)$`, 'u').exec(c)) && kind !== 'triage') {
      if (/^all(?![\p{L}\p{N}])/u.test(m[2])) return null;
      const l = list(m[2]);
      if (!l) return null;
      sig.push(`${m[1]}:${l.sort().join(',')}`);
    } else if (kind === 'triage' && (m = /^(skip|remove) (.+?)(?: because (.+))?$/.exec(c))) {
      if (!slotOk(m[3])) return null;
      const l = list(m[2]);
      if (!l) return null;
      sig.push(`remove:${l.sort().join(',')}`);
    } else if (kind === 'triage' && (m = /^(reach|warm|rescue) (.+?)( anyway)?(?: because (.+))?$/.exec(c))) {
      if (!slotOk(m[4])) return null;
      const l = list(m[2]);
      if (!l) return null;
      sig.push(`${m[1]}:${l.sort().join(',')}${m[3] ? ':anyway' : ''}`);
    } else if (kind === 'triage' && (m = /^(.+) is mine$/.exec(c))) {
      const l = list(m[1]);
      if (!l) return null;
      sig.push(`mine:${l.sort().join(',')}`);
    } else if (kind === 'triage' && (m = /^hold (.+?) until (.+)$/.exec(c))) {
      if (!slotOk(m[2])) return null;
      const l = list(m[1]);
      if (!l) return null;
      sig.push(`hold:${l.sort().join(',')}`);
    } else if (kind === 'triage' && (m = /^(?:leave (.+?)(?: with (.+))?|hold (.+))$/.exec(c))) {
      if (!slotOk(m[2])) return null;
      const l = list(m[1] || m[3]);
      if (!l) return null;
      sig.push(`leave:${l.sort().join(',')}`);
    } else if (kind === 'triage' && (m = /^(confirm|separate) (c\d{3,}(?:\s*,\s*c\d{3,})*)$/.exec(c))) {
      const l = list(m[2]);
      if (!l) return null;
      sig.push(`${m[1]}:${l.sort().join(',')}`);
    } else if (kind === 'triage' && (m = /^note (.+)$/.exec(c))) {
      const l = list(m[1]);
      if (!l) return null;
      sig.push(`note:${l.sort().join(',')}`);
    } else if (kind === 'triage' && (m = /^notes (on|off)$/.exec(c))) sig.push(`notes:${m[1]}`);
    else if (kind === 'triage' && (m = /^keep (?:top )?(\d+)$/.exec(c))) sig.push(`keep:${Number(m[1])}`);
    else if (kind === 'triage' && (m = /^keep segments? ([a-z0-9][a-z0-9-]*(?:\s*,\s*[a-z0-9][a-z0-9-]*)*)$/.exec(c))) sig.push(`keep:${m[1].split(/\s*,\s*/).sort().join(',')}`);
    else if (kind === 'triage' && (m = /^cap (\d+|all|off)$/.exec(c))) sig.push(`cap:*:${m[1] === 'off' ? 'all' : m[1]}`);
    else if (kind === 'triage' && (m = /^cap ([a-z0-9][a-z0-9-]*) (\d+|all)$/.exec(c))) sig.push(`cap:${m[1]}:${m[2]}`);
    else return null;
  }
  // "ok" and "approve all" stand alone; nobody is named in two places.
  if (sig.length > 1 && sig.some((s) => s === 'defaults' || s.startsWith('approve-all'))) return null;
  // Every ID the reading names, message numbers kept ("drop:c001:2,c001:2" names c001:2 twice): the same item twice, or a
  // person both whole and by one message, is not plainly one answer.
  const named = sig.flatMap((s) => s.replace(/^[^:]+:/, '').replace(/:anyway$/, '').split(',').filter((x) => ID_ITEM.test(x)));
  if (new Set(named).size !== named.length) return null;
  const whole = new Set(named.filter((x) => !x.includes(':')));
  if (named.some((x) => x.includes(':') && whole.has(x.replace(/:\d+$/, '')))) return null;
  if (kind === 'triage' && named.some((x) => x.includes(':'))) return null;
  return sig.sort();
}

// An answer Claude worked out from the user's words when the code couldn't read them ("everyone but the two Johns"):
// only the gate's own commands with list IDs, the DIRECT grammar with no names at all. It is never saved at once.
export const interpretedReading = (text, { kind, ids }) => directReading(text, { kind, rows: [], ids });
// The line a refusal ends with, for Claude: it may work out what the user meant and send it back as an interpreted
// answer, by ID, for the user's yes. Names are shown as other read-backs are.
// The list is cut by whole entries; the full list comes from `crm-triage people --event <slug>`.
export function interpretHint(rows, slug = '<slug>') {
  const seen = new Set();
  const people = (rows || []).filter((r) => r && !seen.has(r.id) && seen.add(r.id));
  const out = [];
  let size = 0;
  for (const r of people) {
    const e = `${r.id} ${shown(r.name)}`;
    if (size + e.length > 900) break;
    out.push(e);
    size += e.length + 2;
  }
  const more = people.length - out.length;
  return `\ncan_interpret: true\npeople: ${out.join('; ')}${more ? `; and ${more} more: ask for the full list with crm-triage people --event ${slug}` : ''}`;
}

// The parser's reading in the same shape as directReading's, to see whether the two agree.
export function signature(g) {
  const sig = [];
  if (g.defaults) sig.push('defaults');
  for (const a of g.actions) {
    if (a.verb === 'approve-all') sig.push(`approve-all:${[...new Set(a.except)].sort().join(',')}`);
    else if (a.verb === 'keep') sig.push(`keep:${a.top ?? [...a.segments].sort().join(',')}`);
    else if (a.verb === 'cap') sig.push(`cap:${a.company}:${a.value}`);
    else if (a.verb === 'notes') sig.push(`notes:${a.on ? 'on' : 'off'}`);
    else if (a.verb === 'approve' && a.pass_only) return null;
    else sig.push(`${a.verb}:${[...a.ids].sort().join(',')}${a.anyway ? ':anyway' : ''}`);
  }
  return sig.sort();
}
export const sameReading = (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

// "yes" to a reading shown: the whole answer, and only these words. While a reading waits, any of the words of
// agreement takes it ("ok", "sure", "yes please"): the user is agreeing to the text they were just shown.
const AGREEMENT = /^(?:yes|y|yep|yeah|yup|ok|okay|sure|correct|confirm|s[ií]|ok yes|yes please)(?:[\s,]+(?:please|thanks|thank you))?[\s.!]*$/iu;
const BARE_YES = /^(?:yes|y|yep|yeah|yup|correct|confirm|s[ií]|ok yes|yes please)(?:[\s,]+(?:please|thanks|thank you))?[\s.!]*$/iu;
// Every "is this only a yes / only ok" test reads the answer as the DIRECT test does (foldAnswer: invisible
// characters out, split on ; and new lines, empty clauses gone, a full stop at the end dropped): "ok;", ";ok",
// "ok ;\n" and "ok" are one answer to all of them, so a yes test and the DIRECT reading never disagree.
export const answerClauses = (t) => foldAnswer(t);
const every = (re) => (t) => {
  const c = foldAnswer(t);
  return c.length > 0 && c.every((x) => re.test(x));
};
export const isAgreement = every(AGREEMENT);
// A yes that, with nothing waiting, does nothing ("ok" and "sure" stay the gate's own "ok").
export const isYes = every(BARE_YES);
// The gate's own "ok" or "defaults" alone, however it is punctuated.
const OK_WORDS = /^(?:ok|okay|sure|defaults)(?:[\s,]+(?:thanks|thank you|gracias|please))?[\s.!]*$/iu;

// The pending reading, next to the gate's other state. It holds the reading (the parser's actions, every ID spelt
// out), the gate, the event, a hash of the rows it was read against, and when. A reading older than a run's lock
// (30 minutes), or read against rows that have changed since, is never applied.
export const PENDING_MINUTES = 30;
const pendingFile = (derived, gate) => join(derived, `pending-${gate}.json`);
export const rowsHash = (rows) => createHash('sha256').update(JSON.stringify(rows.map((r) => [r.id, r.name, r.touch ?? null]))).digest('hex').slice(0, 32);
// Only the two gates call these (a test greps for it): a saver, a step or a wrapper passes the user's whole answer to
// the gate and the gate alone decides what a waiting reading means.
// The one pending file per gate holds a reading waiting for the user's yes, or the trace of one that was dropped
// (dropped: true). While any file is there, in any state (waiting, dropped, too old, read against other rows,
// unreadable), an answer that is only "ok" is never the gate's own "ok": the user may think they are agreeing to the
// reading they saw. A save at the gate, or the next ok-only answer that says so, clears it.
export function savePending(derived, gate, data) {
  writeJson(pendingFile(derived, gate), { gate, ...data });
  removeLegacyMarker(derived, gate);
}
// A new answer replaced the reading: what stays is its trace. Returns whether any file was there.
export function dropPending(derived, gate) {
  const f = pendingFile(derived, gate);
  const had = existsSync(f) || existsSync(legacyMarker(derived, gate));
  if (had) writeJson(f, { gate, dropped: true, at: new Date().toISOString() });
  removeLegacyMarker(derived, gate);
  return had;
}
export function clearPending(derived, gate) {
  try {
    unlinkSync(pendingFile(derived, gate));
  } catch {
    /* none */
  }
  removeLegacyMarker(derived, gate);
}
// The marker file an earlier version kept beside the reading: read as a dropped reading, and removed when the pending
// file is next written or cleared.
const legacyMarker = (derived, gate) => join(derived, `pending-${gate}-dropped.json`);
function removeLegacyMarker(derived, gate) {
  try {
    unlinkSync(legacyMarker(derived, gate));
  } catch {
    /* none */
  }
}
// A bare word that would be the gate's own "ok" or "defaults", or an agreement.
export const bareOk = (t) => {
  const c = foldAnswer(t);
  return c.length > 0 && c.every((x) => AGREEMENT.test(x) || OK_WORDS.test(x));
};
function judgePending(p, gate, { event, hash, nowMs }) {
  if (p && p.dropped === true) return { stale: 'it was dropped, since another answer came after it' };
  if (!p || p.gate !== gate || p.event !== event || !p.reading || typeof p.reading !== 'object' || !Array.isArray(p.reading.actions)) return { stale: 'it could not be read' };
  if (p.rows_hash !== hash) return { stale: 'the list changed since it was read' };
  const age = nowMs - Date.parse(p.created_at);
  if (!Number.isFinite(age) || age < -60000) return { stale: "the clock is earlier than when it was read, so it can't be trusted" };
  if (age > PENDING_MINUTES * 60000) return { stale: `it was read more than ${PENDING_MINUTES} minutes ago` };
  return { pending: p };
}
// What the gate has on disk: { none }, { pending } (a reading a yes would apply) or { stale } (a file is there, in any
// other state). Nothing is removed by looking.
export function peekPending(derived, gate, opts) {
  const f = pendingFile(derived, gate);
  if (!existsSync(f)) return existsSync(legacyMarker(derived, gate)) ? { stale: 'it was dropped, since another answer came after it' } : { none: true };
  let p = null;
  try {
    p = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    p = null;
  }
  return judgePending(p, gate, opts);
}
