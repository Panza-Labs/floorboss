// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Ratings: the blind rating set, saving the user's ratings, and voice rules learned from them.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allowedPath } from '../../../../lib/paths.mjs';
import { noteText } from '../../../../lib/normalize.mjs';
import { need } from '../../../../lib/args.mjs';
import { readJson, writeJson, writeText } from '../../../../lib/jsonio.mjs';
import { addNeverSay } from '../../../flow/scripts/profile-write.mjs';
import { approvalHash } from '../../../../lib/sendcheck.mjs';
import { SAMENESS_NOTE } from '../sameness.mjs';
import { whereAt } from './routes.mjs';
import { ctxOf, led, skillsOf } from './context.mjs';
import { readTodo, savedDraft } from './saved-drafts.mjs';

// rate-set --event <slug> [--n 12]: a blind set of drafts for the user to rate, the way their readers would
// see them. Drawn across structures and segments, in a shuffled order; the key (which draft is which) is
// written apart. rate --text-file: the user's "1: 6 too salesy" lines, saved to the ledger by draft.
export function rateSet(opts) {
  need(opts, 'event');
  const c = ctxOf(opts.event, opts);
  const n = Math.max(3, Math.min(30, Number(opts.n) || 12));
  const pool = [];
  for (const [id, p] of Object.entries(c.folded.people))
    for (const [t, x] of Object.entries(p.touches)) {
      if (!x.hash || x.kind !== 'message' || x.critic?.hash !== x.hash || x.critic?.verdict !== 'PASS') continue;
      if (p.ratings.some((r) => r.hash === x.hash)) continue;
      const d = readJson(join(c.paths.drafts, `${x.hash}.json`), null);
      if (d) pool.push({ id, touch: Number(t), hash: x.hash, structure: x.structure, d, ct: c.byId[id] });
    }
  // Spread across structures: round-robin by structure, stable order within each.
  const by = {};
  for (const x of pool) (by[x.structure || 'none'] ||= []).push(x);
  const picked = [];
  while (picked.length < n && Object.values(by).some((l) => l.length))
    for (const l of Object.values(by)) if (l.length && picked.length < n) picked.push(l.shift());
  const order = picked
    .map((x, i) => ({ x, k: (i * 7919 + 13) % 101 }))
    .sort((a, b) => a.k - b.k)
    .map((o) => o.x);
  const lines = [
    '# Blind set',
    '',
    'For each, give a number 1-10: how likely is this reader to reply? A few words if something stands out. Answer as `1: 6 too salesy`, one per line.',
    ''
  ];
  const key = [];
  order.forEach((x, i) => {
    // Labelled by where it goes: an email, a LinkedIn message or a note in the event's app.
    // With no event app set up, a paste message names no app: it's the user's to paste wherever they reach them.
    const where =
      x.d.channel === 'email'
        ? 'email'
        : whereAt(c, x.id, x.touch) === 'LinkedIn'
          ? 'LinkedIn message'
          : c.event.app_name
            ? `message in ${c.event.app_name}`
            : null;
    const kind = where ? `${x.touch > 1 ? 'follow-up' : 'first'} ${where}` : `${x.touch > 1 ? 'follow-up' : 'first message'}, to paste`;
    lines.push(
      `## ${i + 1}. To: ${x.ct?.title || 'someone'}, ${x.ct?.company || ''} (${kind})`,
      '',
      ...(x.d.subject ? [`Subject: ${x.d.subject}`, ''] : []),
      '```',
      x.d.body,
      '```',
      ''
    );
    key.push({ n: i + 1, id: x.id, touch: x.touch, hash: x.hash, structure: x.structure || null });
  });
  const file = join(c.paths.derived, 'rate-set.md');
  writeText(file, lines.join('\n'));
  writeJson(join(c.paths.derived, 'rate-key.json'), key);
  return {
    drafts: key.length,
    file,
    next: key.length
      ? 'Show the set (the file, or paste it in), ask for a number per draft, write their answer to a file and run rate --text-file.'
      : 'Nothing to rate yet: no draft has passed the critic.'
  };
}

export function rate(opts) {
  need(opts, 'event', 'text');
  const c = ctxOf(opts.event, opts);
  const key = readJson(join(c.paths.derived, 'rate-key.json'), []);
  // "skip" needs no blind set: it's answered before one is made, too.
  if (/^\s*(skip|no|later|not now)\b/i.test(String(opts.text))) {
    led(c, { type: 'answered', who: 'user', ask: 'rate', value: 'skipped', said: String(opts.text).slice(0, 200) });
    return { rated: 0, skipped: true };
  }
  if (!key.length) throw new Error('No blind set: run rate-set first.');
  const out = [],
    low = [],
    alike = [];
  // "1: 6 too salesy", "1 7", "#1 7/10", "1 - 6/10 a bit long", "draft 1 = 7", "1: 6, 2: 7": the draft's number,
  // then its rating (1-10). A range ("1-3: 7") or a line that could be read two ways is listed back, not guessed.
  const unread = [];
  const segments = String(opts.text)
    .split(/\r?\n/)
    .flatMap((l) => l.split(/[,;]\s*(?=(?:#|draft\s*)?\d{1,2}\s*[:=)])/));
  for (const line of segments) {
    if (!line.trim()) continue;
    if (/^\s*(?:#|draft\s*)?\d{1,2}\s*[-–]\s*\d{1,2}\s*[:=]/.test(line)) {
      unread.push(`${line.trim()} (a range: rate each draft on its own line)`);
      continue;
    }
    const m = /^\s*(?:#|no\.?\s*|draft\s*)?(\d{1,2})\s*(?:([:)=\-–])\s*|(\.)\s*|\s+)(10|[1-9])(\s*\/\s*10)?(?=$|[\s,;.!?])\s*[,;:\-–]?\s*(.*)$/i.exec(line);
    if (!m) {
      if (/\d/.test(line)) unread.push(line.trim());
      continue;
    }
    // "1. 2 sentences too long, 6": after a full stop, a number followed by words could be the note, not the rating.
    if (m[3] && !m[5] && /\b(10|[1-9])\b/.test(m[6] || '')) {
      unread.push(`${line.trim()} (which number is the rating? write "1: 6")`);
      continue;
    }
    const [, num, , , ratingText, , ratingNote] = m;
    const k = key.find((x) => x.n === Number(num));
    const r = Number(ratingText);
    const note = noteText(ratingNote, 300);
    if (!k) {
      unread.push(`${line.trim()} (there is no draft ${num})`);
      continue;
    }
    led(c, {
      type: 'copy_rating',
      who: 'user',
      id: k.id,
      touch: k.touch,
      hash: k.hash,
      rating: r,
      note: note.slice(0, 200) || null,
      said: line.trim().slice(0, 200)
    });
    out.push({ n: k.n, id: k.id, rating: r, structure: k.structure });
    // A draft the user says nobody would answer goes back to be written again, with their words.
    if (r <= 3) {
      led(c, { type: 'revise', who: 'user', id: k.id, touch: k.touch, feedback: note || `rated ${r} of 10`, said: line.trim().slice(0, 200) });
      low.push(k.id);
    }
    // "same as 1", "identical to 4": a draft that reads like another goes back whatever its rating, written
    // apart from the rest of the batch.
    else if (SAMENESS_NOTE.test(note)) {
      led(c, {
        type: 'revise',
        who: 'user',
        id: k.id,
        touch: k.touch,
        feedback: `It reads like another draft in this batch (your note: "${note.slice(0, 120)}"): write it so it doesn't share an opening, an angle or sentences with the others.`,
        said: line.trim().slice(0, 200)
      });
      alike.push(`${k.id}:${k.touch}`);
    }
  }
  if (!out.length)
    throw new Error(`No ratings read. Each line looks like "1: 6 too salesy".${unread.length ? ` Not read: ${unread.slice(0, 5).join('; ')}` : ''}`);
  // A note that bans a phrase ("don't say 'circle back'") is a rule for every draft, not only the one
  // rated: it goes into the never-say line, and every unsent draft with that phrase is written again.
  const banned = [
    ...new Set(
      segments.flatMap((l) =>
        [
          ...l.matchAll(
            /\b(?:don'?t|do not|never|stop|no)\s+(?:say(?:ing)?|use|using|write|writing|call(?:ing)? (?:me|myself|it|us))\s+["'“‘]([^"'”’]{2,40})["'”’]/gi
          )
        ].map((m) => m[1].trim())
      )
    )
  ];
  const rewritten = [];
  if (banned.length) {
    const skills = skillsOf(c);
    if (skills.dir) {
      const p = join(skills.dir, 'what-you-bring', 'SKILL.md');
      if (existsSync(p)) writeText(p, addNeverSay(readFileSync(p, 'utf8'), banned));
    }
    const t = readTodo(c, null);
    for (const j of t?.jobs || []) {
      if (j.kind !== 'message' || c.state[j.id]?.sent?.[j.touch]) continue;
      const d = savedDraft(c, j.id, j.touch);
      const hit = banned.find((b) => d?.body && d.body.toLowerCase().includes(b.toLowerCase()));
      if (hit && !low.includes(j.id)) {
        led(c, {
          type: 'revise',
          who: 'user',
          id: j.id,
          touch: j.touch,
          feedback: `don't say "${hit}" (your note on the blind ratings)`,
          said: `rule from rating notes: ${hit}`
        });
        rewritten.push(`${j.id}:${j.touch}`);
      }
    }
  }
  led(c, { type: 'answered', who: 'user', ask: 'rate', value: `${out.length} rated` });
  const mean = out.reduce((a, x) => a + x.rating, 0) / out.length;
  const byStructure = {};
  for (const x of out) (byStructure[x.structure || 'none'] ||= []).push(x.rating);
  return {
    rated: out.length,
    ...(banned.length ? { never_say_added: banned, rewritten_for_it: rewritten } : {}),
    ...(alike.length ? { rewritten_as_alike: alike } : {}),
    ...(unread.length ? { not_read: unread, note: 'Ask the user about the lines not read.' } : {}),
    mean: +mean.toFixed(1),
    by_structure: Object.fromEntries(Object.entries(byStructure).map(([s, l]) => [s, +(l.reduce((a, b) => a + b, 0) / l.length).toFixed(1)])),
    sent_back: low
  };
}

// voice-save --event <slug> --file <{samples:[{subject, body}]}>: emails the sender wrote that got replies,
// into the voice file under "Emails that got replies" (at most five; addresses and signatures' phone numbers
// taken out). They show how the sender writes; drafts copy their moves, never their sentences.
export function voiceSave(opts) {
  need(opts, 'event', 'file');
  const c = ctxOf(opts.event, opts);
  const data = readJson(allowedPath(opts.file));
  const samples = (Array.isArray(data) ? data : data?.samples || []).filter((x) => x && String(x.body || '').trim()).slice(0, 5);
  if (!samples.length) throw new Error('No emails in the file: {"samples":[{"subject","body"}]}.');
  const skills = skillsOf(c);
  if (!skills.dir) throw new Error('No context profile yet, so there is no voice file.');
  const p = join(skills.dir, 'voice', 'SKILL.md');
  const text = existsSync(p) ? readFileSync(p, 'utf8') : '# Voice\n';
  const clean = (s) =>
    String(s || '')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[address]')
      .replace(/\+?\d[\d ()-]{7,}\d/g, '[number]')
      .replace(/^```/gm, "'''")
      .trim()
      .slice(0, 2000);
  const block = samples
    .map(
      (x, i) =>
        `### ${i + 1}${
          x.subject
            ? `. ${clean(x.subject)
                .replace(/[\r\n\u2028\u2029]+/g, ' ')
                .slice(0, 120)}`
            : ''
        }\n\n${clean(x.body)
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n')}`
    )
    .join('\n\n');
  const head = '## Emails that got replies';
  const rest = text.includes(head)
    ? text.slice(0, text.indexOf(head)) + text.slice(text.indexOf(head)).replace(/^## Emails that got replies[\s\S]*?(?=\n## |$)/, '')
    : text;
  writeText(p, `${rest.trimEnd()}\n\n${head}\n\n${block}\n`);
  for (const x of samples)
    led(c, {
      type: 'voice_sample',
      who: 'user',
      source: x.source || 'pasted',
      message_id: x.message_id || null,
      hash: approvalHash({ channel: 'email', subject: x.subject || '', body: x.body }, 'sender'),
      said: 'emails that got replies'
    });
  return { saved: samples.length, file: p };
}
