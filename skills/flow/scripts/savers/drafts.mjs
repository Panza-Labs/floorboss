// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Savers for the questions about the drafts and what happens after: approval, the review, ratings, what a
// send did, a tool that stopped answering, and who has or hasn't replied.
import { readLedger, fold } from '../../../../lib/ledger.mjs';
import { parseScale, SCALES } from '../../../crm-triage/scripts/sizes.mjs';
import { writeText } from '../../../../lib/jsonio.mjs';
import { context, nextStep, appOutcomeTarget } from '../steps.mjs';
import { sessionRun } from '../../../../lib/scope.mjs';
import { join } from 'node:path';
import { asRule } from '../../../event-outreach/scripts/sameness.mjs';
import { isAgreement } from '../../../../lib/reading.mjs';
import { INTERPRETED, gateWords, EDIT_WITH_TEXT, editWithText, SKIP_REVIEW, skipReview, cli, withSubject, writeWork, isNo, ledger, writeWorkText, answers, pathOf, config, windowYes, noReplySaid } from './helpers.mjs';

export const DRAFTS_SAVERS = {
  // "skip review <ids|all>" lines send those drafts on unreviewed (their cards say so); the rest go to the gate.
  approve: (v, c) => {
    // Claude's reading of the user's words, by ID: always shown back for their yes (the gate never saves it at once).
    if (v && typeof v === 'object' && v[INTERPRETED])
      return cli('event-outreach', ['gate', '--event', c.slug, '--answers', String(v.answers), '--interpreted', '--said-file', writeWorkText(c, 'interpreted-said.txt', v.said)], c);
    // The gate alone owns a reading waiting for the user's yes. This saver does the lines that aren't the gate's (an
    // edit with its text, "skip review …") and hands the gate the rest with --consumed, so the gate knows the answer
    // was more than what it reads: a bare "ok" left over is read back by ID, never saved at once.
    const t = gateWords(v, 'approval');
    if (EDIT_WITH_TEXT.test(t)) return editWithText(c, t);
    const lines = t
      .split(/[;\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
    const skips = lines.filter((x) => SKIP_REVIEW.test(x));
    if (!skips.length) return cli('event-outreach', ['gate', '--event', c.slug, '--answers', t], c);
    const rest = lines.filter((x) => !SKIP_REVIEW.test(x));
    const skipped = skipReview(c, skips.join('; '));
    const r = cli('event-outreach', ['gate', '--event', c.slug, ...(rest.length ? ['--answers', rest.join('\n')] : []), '--consumed', 'skip-review'], c);
    return { ...r, skipped_review: skipped?.skipped_review };
  },
  // A held or left-out draft after the approve step: by name only, one line per action ("approve c004",
  // "drop c007:2", "edit c009"). "all", "except" or a bare yes approves nothing here.
  approve_held: (v, c) => {
    const t = gateWords(v, 'approval');
    // A yes to a reading the gate showed at this ask goes to the gate as it is; with none waiting, a yes approves nothing.
    if (isAgreement(t)) return cli('event-outreach', ['gate', '--event', c.slug, '--answers', t, '--agree-only', 'held'], c);
    if (EDIT_WITH_TEXT.test(t)) return editWithText(c, t);
    const lines = t
      .split(/[;\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
    const ok = (l) => /^(approve|drop|edit)\s+c\d{3,}(:\d+)?(\s*,?\s*c\d{3,}(:\d+)?)*$/i.test(l);
    if (!lines.length || !lines.every(ok))
      throw new Error('Here a held draft is approved, dropped or edited by its id only: "approve c004", "drop c007:2", "edit c009". Nothing was saved.');
    // The gate approves by person ("c007" approves their held messages, past a critic fail): a message number on an
    // approval would read as one message, so it's refused and said.
    if (lines.some((l) => /^approve\b/i.test(l) && /c\d{3,}:\d+/.test(l)))
      throw new Error(
        'An approval names the person ("approve c007"), which approves all of their held messages; drop or edit takes a message number ("drop c007:2"). Nothing was saved.'
      );
    return cli('event-outreach', ['gate', '--event', c.slug, '--answers', lines.join('\n')], c);
  },
  // The user says not to wait for the critic: "skip review all", "skip review c004, c007:2".
  skip_review: (v, c) => skipReview(c, String(typeof v === 'object' && v ? v.said || v.answers || '' : v)),
  // Drafts stuck after three rewrites: "drop <ids>" or "edit <id>: …" go to the gate; "leave them for now" waits a day.
  stuck_drafts: (v, c) => {
    const t = gateWords(v, 'stuck-drafts').trim();
    if (isAgreement(t)) return cli('event-outreach', ['gate', '--event', c.slug, '--answers', t, '--agree-only', 'stuck'], c);
    if (EDIT_WITH_TEXT.test(t)) return editWithText(c, t);
    if (/^leave/i.test(t)) return { left: true };
    // Drop or edit by id only: a bare "ok" here would approve everything the gate can.
    const lines = t
      .split(/[;\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!lines.length || !lines.every((l) => /^(drop|edit)\s+c\d{3,}(:\d+)?(\s*,?\s*c\d{3,}(:\d+)?)*$/i.test(l)))
      throw new Error('Stuck drafts are dropped or edited by id ("drop c004", "edit c007:2"), or "leave them for now". Nothing was saved.');
    return cli('event-outreach', ['gate', '--event', c.slug, '--answers', lines.join('\n')], c);
  },
  // The edit the user asked for: "done" once the file is saved (it's saved as their own edit), the new text
  // itself, or "never mind".
  edit_draft: (v, c) => {
    const t = String(typeof v === 'object' && v ? v.said || v.text || '' : v).trim();
    const s = nextStep(context(c.slug, {}));
    if (s.ask?.id !== 'edit_draft') throw new Error("floorboss isn't waiting for an edit right now. Run flow next.");
    const { id, touch } = s.ask.person;
    if (/^(never ?mind|cancel|leave it|no|skip)\b/i.test(t)) return { left_as_is: `${id}${touch > 1 ? `:${touch}` : ''}` };
    if (!/^(done|saved|ok|finished|edited)\b\W*$/i.test(t) && t) writeText(s.ask.file, withSubject(s.ask.file, t));
    return cli('event-outreach', ['save-draft', '--event', c.slug, '--id', id, '--touch', String(touch), '--md-file', s.ask.file], c);
  },
  outcomes: (v, c) =>
    typeof v === 'object' && v.items
      ? cli('event-outreach', ['record', '--event', c.slug, '--file', writeWork(c, 'record.json', v)], c)
      : cli('event-outreach', ['status', '--event', c.slug, '--none', '--said', String(v)], c),
  voice_samples: (v, c) =>
    isNo(v)
      ? ledger(c, { type: 'answered', who: 'user', ask: 'voice_samples', value: 'skipped' })
      : cli(
          'event-outreach',
          ['voice-save', '--event', c.slug, '--file', writeWork(c, 'voice-samples.json', typeof v === 'object' ? v : { samples: [{ body: String(v) }] })],
          c
        ),
  rate_notes: (v, c) => {
    const yes = /^\s*(yes|every|all|apply)/i.test(String(typeof v === 'object' && v ? v.answer || '' : v));
    if (yes) {
      const notes = nextStep(context(c.slug, {})).ask?.notes || [];
      cli(
        'event-outreach',
        [
          'revise',
          '--event',
          c.slug,
          '--all',
          '--rule',
          '--feedback-file',
          writeWorkText(c, 'rate-notes.txt', `From your notes on the rated drafts: ${notes.join('; ')}`)
        ],
        c
      );
    }
    // "Only the ones I rated": each draft with a note goes back to its own note (rated 3 or less, it went back
    // when it was rated); the drafts without one stay as they are.
    const sentBack = [];
    if (!yes) {
      const entries = readLedger(c.event.paths.ledger).entries;
      const st = fold(entries);
      const noted = new Map();
      for (const x of entries) if (x.type === 'copy_rating' && x.note && asRule(x.note) && x.rating > 3) noted.set(`${x.id}:${x.touch ?? 1}`, x);
      for (const [k, x] of noted) {
        const t = st.people[x.id]?.touches?.[x.touch ?? 1];
        if (!t || t.hash !== x.hash || t.sent || t.revising || (t.approved && t.approved.hash === t.hash)) continue;
        cli(
          'event-outreach',
          [
            'revise',
            '--event',
            c.slug,
            '--ids',
            k,
            '--feedback-file',
            writeWorkText(c, `rate-note-${x.id}-${x.touch ?? 1}.txt`, `Your note on this draft in the blind ratings: ${x.note}`)
          ],
          c
        );
        sentBack.push(k);
      }
    }
    return { ...ledger(c, { type: 'answered', who: 'user', ask: 'rate_notes', value: yes ? 'all' : 'rated only' }), ...(yes ? {} : { sent_back: sentBack }) };
  },
  rate: (v, c) => cli('event-outreach', ['rate', '--event', c.slug, '--text-file', writeWorkText(c, 'ratings.txt', typeof v === 'object' ? v.text : v)], c),
  // Whether an unclear send went, from the user's look in Sent.
  send_outcome: (v, c) => {
    const o = typeof v === 'object' && v ? v : { said: String(v) };
    const text = String(o.went ?? o.said ?? '').trim();
    // Only a clear answer settles it: "it went" or "it did not go". Anything else is asked again.
    const went = /^(yes|y|it went|went|sent|it'?s there|it is there|found it|it is in (my )?sent|in sent)\b/i.test(text)
      ? 'yes'
      : /^(no|n|it did ?n.?t go|did ?n.?t go|not sent|not there|it'?s not there|not in sent)\b/i.test(text)
        ? 'no'
        : null;
    if (!went) throw new Error('Ask again: did it go? Answer "it went" or "it did not go" after looking in Sent; "not sure" can\'t be settled.');
    // The person this step is about: the first send that may or may not have gone, from the ledger.
    const st = fold(readLedger(c.event.paths.ledger).entries);
    const u = Object.entries(st.people).flatMap(([id, p]) =>
      Object.entries(p.touches)
        .filter(([, x]) => x.released && !x.sent && !x.release_cleared && x.released_via !== 'browser')
        .map(([t]) => ({ id, touch: Number(t) }))
    )[0];
    if (!u) throw new Error('No send is waiting to be settled.');
    return cli(
      'event-outreach',
      ['send-outcome', '--event', c.slug, '--id', u.id, '--touch', String(u.touch), '--went', went, '--said', String(o.said || text).slice(0, 200)],
      c
    );
  },
  // A tool that stopped answering: retry (it's back), skip it, stop for now, or (the CRM) an export instead.
  tool_down: (v, c) => {
    const o = typeof v === 'object' && v ? v : { answer: String(v) };
    // The tool this is about: the one named, else the one that failed last.
    const failed = Object.entries(fold(readLedger(c.event.paths.ledger).entries).tool_failed).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at));
    const task = String(o.task || failed[0]?.[0] || '');
    if (!task) throw new Error('No tool has failed: nothing to retry.');
    const a = String(o.answer || '').trim();
    if (/^retry|^back|^try again|reconnected/i.test(a)) return cli('event-outreach', ['tool-back', '--event', c.slug, '--task', task, '--said', a], c);
    if (/^later|^not now|^stop/i.test(a))
      return ledger(c, { type: 'answered', who: 'user', ask: 'tool_down', value: 'later', said: a.slice(0, 200), task, run: sessionRun() || null });
    if (['email.messages', 'crm.activity'].includes(task) && /ask me|instead|myself|i'?ll (say|tell)/i.test(a))
      return ledger(c, { type: 'answered', who: 'user', ask: 'reader_fallback', value: 'user', said: a.slice(0, 200), task });
    // Running without the CRM is confirmed in a step of its own, after the warning.
    if (task === 'crm.lookup' && /independ|without (the |my )?crm|^skip|^without/i.test(a))
      return ledger(c, { type: 'answered', who: 'user', ask: 'crm_choice_after_failure', value: 'independent_pending', said: a.slice(0, 200) });
    if (/^skip|^without|^no\b/i.test(a)) {
      const flag = task === 'crm.lookup' ? 'crm_lookup_skipped' : task === 'email.history' ? 'mail_history_skipped' : null;
      if (!flag) throw new Error(`"skip" isn't an answer for ${task}: say retry or later.`);
      return answers(c, { [flag]: true });
    }
    if (task === 'crm.lookup' && /\.(csv|tsv|txt)$/i.test(a)) {
      const r = cli('crm-triage', ['inputs', '--event', c.slug, '--kind', 'crm', '--file', pathOf(a)], c);
      return { ...r, ...answers(c, { crm_lookup_skipped: true, crm_path: r.saved_as }) };
    }
    throw new Error('Say retry, later, "run independently", or give the path to a CRM export.');
  },
  // After the warning: run without the CRM, confirming each person (safer) or going ahead; or go back.
  crm_independent: (v, c) => {
    const a = String(typeof v === 'object' && v ? v.answer || v.said || '' : v).trim();
    if (/go back|^back|^no\b|retry|export/i.test(a))
      return ledger(c, { type: 'answered', who: 'user', ask: 'crm_choice_after_failure', value: 'back', said: a.slice(0, 200) });
    const mode = /confirm|each|safe|myself/i.test(a) ? 'confirm_each' : /go ahead|proceed|without confirming|^yes|independently/i.test(a) ? 'go_ahead' : null;
    if (!mode) throw new Error('Say "confirm each person", "go ahead", or "go back".');
    ledger(c, { type: 'answered', who: 'user', ask: 'crm_independent', value: mode, said: a.slice(0, 200) });
    return answers(c, { crm_lookup_skipped: true });
  },
  // People per company by size: the scale named, or the user's own numbers.
  company_caps: (v, c) => {
    if (typeof v === 'object' && v) return config(c, { company_caps: v });
    const t = String(v).toLowerCase();
    const own = parseScale(t);
    const mode = /^one|one per|1 per/.test(t)
      ? 'one'
      : /more|teams|whole team|several/.test(t)
        ? 'teams'
        : /no (cap|limit)|off|any number/.test(t)
          ? 'off'
          : 'scale';
    // Numbers the user gave ("one per company, but 3 at enterprises") are used as given; else the scale named.
    const cc = !/^by company size/.test(t) && own ? { scale: own } : { mode };
    const r = config(c, { company_caps: cc });
    // Read back what was understood, so a misread is caught now.
    const sc = cc.scale || SCALES[cc.mode] || null;
    return {
      ...r,
      understood: sc
        ? `1-10 people: ${sc.micro}, 11-50: ${sc.small}, 51-500: ${sc.mid}, 501-5,000: ${sc.large}, over 5,000: ${sc.enterprise}, size unknown: ${sc.unknown}`
        : 'no limit per company'
    };
  },
  // The user's go-ahead to send in the event app now: opens floorboss's 20-minute browser send window.
  app_send_window: (v, c) => {
    const said = String(typeof v === 'object' && v ? v.said || v.answer || '' : v).trim();
    if (!windowYes(said)) return ledger(c, { type: 'answered', who: 'user', ask: 'app_send_window', value: 'not now', said: said.slice(0, 200) });
    return cli('event-outreach', ['browser-send', '--event', c.slug, '--said', (said.length < 3 ? `${said} (yes)` : said).slice(0, 200)], c);
  },
  // Whether an unconfirmed app note went, from the user's look at the app's sent messages.
  app_outcome: (v, c, s) => {
    const o = typeof v === 'object' && v ? v : { said: String(v) };
    const t = String(o.went ?? o.said ?? '').trim();
    const went = /^(yes|it went|went|sent|it'?s there)\b/i.test(t) ? 'yes' : /^(no|it did ?n.?t go|not sent|not there)\b/i.test(t) ? 'no' : null;
    if (!went) throw new Error('Ask again: did the note go? "it went" or "it did not go".');
    // The person the question named, never another note also waiting.
    const u = appOutcomeTarget(fold(readLedger(c.event.paths.ledger).entries), s);
    if (!u) throw new Error('No app note is waiting to be settled.');
    if (went === 'yes')
      cli(
        'event-outreach',
        ['app-result', '--event', c.slug, '--id', u.id, '--touch', String(u.touch), '--result', 'sent', '--said', String(o.said || t).slice(0, 200)],
        c
      );
    else if (u.released) cli('event-outreach', ['send-outcome', '--event', c.slug, '--id', u.id, '--touch', String(u.touch), '--went', 'no', '--said', String(o.said || t).slice(0, 200)], c);
    return ledger(c, { type: 'answered', who: 'user', ask: 'app_outcome', value: went, said: String(o.said || t).slice(0, 200) });
  },
  approve_round: (v, c) => {
    const o = typeof v === 'object' && v ? v : { said: String(v) };
    if (isNo(o.said || '')) return ledger(c, { type: 'answered', who: 'user', ask: 'approve_round', value: 'not now', said: String(o.said).slice(0, 200) });
    return cli(
      'event-outreach',
      [
        'approve-round',
        '--event',
        c.slug,
        '--touch',
        String(o.touch || 2),
        '--said',
        String(o.said || 'yes'),
        ...(o.ids?.length ? ['--ids', o.ids.join(',')] : [])
      ],
      c
    );
  },
  // Saved, then the card is worked out again, so the "wait for your OK" line goes.
  crm_accounts: (v, c) => {
    const r = config(c, { crm_accounts: /^(no|off)/i.test(String(v)) ? 'off' : 'apply' });
    if (c.slug) cli('crm-triage', ['view', '--event', c.slug], c);
    return r;
  },
  // What came in since the last run, asked when nothing connected can read replies: "none", or "recorded" once
  // Claude has recorded what the user said (outreach record). Anything else is a report not recorded yet.
  replies_since: (v, c) => {
    const a = String(typeof v === 'object' && v ? v.answer || v.said || '' : v).trim();
    const from = typeof v === 'object' && v ? Number(v.ledger_lines) : NaN;
    const value = /^(none|nothing( new| came in)?|no( replies| one)?|nope|nobody|not yet|none yet)[.!]?$/i.test(a)
      ? 'none'
      : /^recorded\b/i.test(a)
        ? 'recorded'
        : null;
    if (!value)
      throw new Error(
        'Record what they told you first: write it as items and run outreach record (the event-outreach skill, "Recording what happened"), read the recorded lines back, then answer "recorded". If nothing came in, answer "none".'
      );
    // "recorded" stands only on a record actually made after the question was shown: something outreach record
    // wrote past the step's ledger_lines.
    if (value === 'recorded') {
      if (!Number.isInteger(from) || from < 0)
        throw new Error('Answer {"answer":"recorded","ledger_lines":<the number the step gave>}, after running outreach record.');
      if (
        !readLedger(c.event.paths.ledger)
          .entries.slice(from)
          .some((x) => x.via === 'user' && x.type !== 'answered')
      )
        throw new Error(
          'Nothing was recorded since the question was shown. Write what they told you as items, run outreach record, read the recorded lines back, then answer "recorded".'
        );
    }
    return ledger(c, { type: 'answered', who: 'user', ask: 'replies_since', value, said: a.slice(0, 200), run: sessionRun() || null });
  },
  no_reply: (v, c, s) => {
    const o = typeof v === 'object' ? v : null;
    // Several people at once: everyone the step listed and the user didn't name had no reply.
    if (o && !o.id && (o.none || o.replied || o.stopped || Array.isArray(o.people))) {
      const said = String(o.said || (o.none ? 'none' : '')).slice(0, 200);
      const named = new Set([...(o.replied || []), ...(o.stopped || [])].map(String));
      for (const id of o.stopped || []) ledger(c, { type: 'stop', who: 'user', id: String(id), said });
      for (const id of o.replied || []) ledger(c, { type: 'replied', who: 'user', id: String(id), source: 'user', said });
      const listed = (o.people || s?.ask?.people || []).map((p) => String(p.id || p)).filter((id) => !named.has(id));
      return listed.length ? noReplySaid(c, s, listed, said || 'none of these replied') : { recorded: named.size };
    }
    if (!o?.id)
      throw new Error(
        'The answer is {"id","answer","said"}, or for several people {"none":true,"people":[ids]} / {"replied":[ids],"stopped":[ids],"people":[ids]}.'
      );
    const said = String(o.said || o.answer).slice(0, 200);
    if (/stop/i.test(o.answer)) return ledger(c, { type: 'stop', who: 'user', id: o.id, said });
    if (/replied|booked|yes/i.test(o.answer)) return ledger(c, { type: 'replied', who: 'user', id: o.id, source: 'user', said });
    return noReplySaid(c, s, [o.id], said);
  },
  list_short: (v, c) => ledger(c, { type: 'answered', who: 'user', ask: 'list_short', value: String(v).slice(0, 200) })
};
