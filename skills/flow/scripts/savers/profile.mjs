// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Savers for the questions about what the user sells and how they write: segments, insights, the offer,
// writing samples, languages, and how sending and follow-ups should work.
import { connected } from '../../../../lib/harness.mjs';
import { allowedPath, expandHome, readChecked } from '../../../../lib/paths.mjs';
import { parseSegments } from '../../../event-context/scripts/context-check.mjs';
import { followupsModeOf } from '../steps.mjs';
import { openingOf, OPENINGS } from '../../../event-outreach/scripts/structures.mjs';
import { OPTOUT_BUILT_IN } from '../../../../lib/config.mjs';
import { segmentsMd, bringMd, setAbout, addInsights, addNeverSay, stillTemplate, setVoiceField, voiceFromEmails, splitEmails, lengthRule } from '../profile-write.mjs';
import { config, answers, text, cli, writeProfile, profileFile, isNo, writeWork, DEFAULT_OPTOUT } from './helpers.mjs';

export const PROFILE_SAVERS = {
  drafting_mode: (v, c) =>
    config(c, { drafting_mode: /your tools write everything/i.test(String(v)) ? 'delegate' : /mix/i.test(String(v)) ? 'blend' : 'floorboss' }),
  drafter: (v, c) => config(c, { drafter: v }),
  import_context: (v, c) => answers(c, { import_context: /yes/i.test(String(v)) ? 'yes' : /reference/i.test(String(v)) ? 'reference' : 'no' }),
  posture: (v, c) => answers(c, { posture: text(v) }),
  optout_known: (v, c) => {
    const t = String(typeof v === 'object' && v ? v.answer || '' : v).toLowerCase();
    const cold = /only|cold|\boff\b|drop|leave it out|without|not on|don'?t|\bno\b|\bnope\b|fr[ií]os?|s[oó]lo/.test(t),
      every = /every|\byes\b|always|keep it on|on all|all of them|todos|siempre/.test(t);
    if (cold === every) throw new Error('Didn\'t catch that: say "yes, on every email" or "only on cold emails". Nothing was saved.');
    return config(c, { optout_known: every });
  },
  seller_framing: (v, c) => answers(c, { seller_framing: /(?:^y)|yes/i.test(String(v)) ? 'yes' : 'no' }),
  profile: (v, c) => {
    const name =
      typeof v === 'object'
        ? v.name
        : String(v)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 40);
    cli('event-context', ['init-profile', '--profile', name], c);
    return config(c, { context_profile: name });
  },
  // These three answers live in the profile's files: saving refuses until they're written there (confirmed
  // but never written, drafts would have no groups, claims or never-say rules).
  segments: (v, c) => {
    if (typeof v === 'object' && v && Array.isArray(v.segments)) {
      writeProfile(c, 'who-to-meet', segmentsMd(v.goal || c.cfg.goal, v.segments));
      return answers(c, { segments_confirmed: true });
    }
    const f = profileFile(c, 'who-to-meet');
    if (!parseSegments(f.text).length || /^##\s+Segment:\s*</m.test(f.text))
      throw new Error(`Write the groups into ${f.path} first (one "## <name>" section each, as its template shows), then save.`);
    return answers(c, { segments_confirmed: true });
  },
  material: (v, c) => answers(c, { material_asked: true }),
  // One line on who the sender is, into what-you-bring's "About me" (what the critic lets a message say).
  about: (v, c) => {
    const line = String(typeof v === 'object' && v ? v.about || v.about_me || v.said || '' : v)
      .replace(/[\u0000-\u001f`#<>|]+/g, ' ')
      .trim()
      .slice(0, 200);
    if (!line || isNo(line)) throw new Error('Say who you are in one line: your role and company ("founder of Tallyroute").');
    const f = profileFile(c, 'what-you-bring');
    writeProfile(c, 'what-you-bring', setAbout(f.text || f.template, line));
    return { ...answers(c, { about_asked: true }), about: line };
  },
  // One to three insights, or none: rows in the "what you know" table, tagged for every segment unless given.
  insights: (v, c) => {
    if (isNo(v) || (typeof v === 'object' && v && isNo(v.said || '')))
      return {
        ...answers(c, { insights_asked: true }),
        note: 'No insights: drafts lead with questions and proof. Add rows to the "what you know" table in what-you-bring any time.'
      };
    const list = (Array.isArray(v) ? v : Array.isArray(v?.insights) ? v.insights : String(v).split(/\n+/))
      .map((x) => (typeof x === 'string' ? { insight: x.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, '') } : x))
      .filter((x) => String(x?.insight || '').trim())
      .slice(0, 3);
    if (!list.length) throw new Error('Give one to three insights ({"insights":[{"insight","basis"}]}), or "none".');
    const segs = parseSegments(profileFile(c, 'who-to-meet').text || '').map((x) => x.slug);
    const rows = list.map((x) => ({
      insight: String(x.insight)
        .replace(/[\u0000-\u001f`#<>]+/g, ' ')
        .trim(),
      basis: String(x.basis || "the user's own work")
        .replace(/[\u0000-\u001f`#<>]+/g, ' ')
        .trim(),
      segments: x.segments || segs,
      situations: x.situations || ''
    }));
    const f = profileFile(c, 'what-you-bring');
    writeProfile(c, 'what-you-bring', addInsights(f.text || f.template, rows));
    return { ...answers(c, { insights_asked: true }), insights_saved: rows.length };
  },
  // What they sell lives in what-you-bring: saving refuses until it's written there.
  offer: (v, c) => {
    if (typeof v === 'object' && v && (v.one_sentence || v.about_me)) {
      writeProfile(c, 'what-you-bring', bringMd(v));
      return answers(c, { offer_asked: true, ...(v.proof || v.about_me ? { claims_confirmed: true } : {}) });
    }
    const f = profileFile(c, 'what-you-bring');
    if (f.text === f.template || stillTemplate(f.text))
      throw new Error(`Write the offer into ${f.path} first (one sentence, the problems it solves, any proof), then save.`);
    return answers(c, { offer_asked: true });
  },
  true_claims: (v, c) => {
    if (typeof v === 'object' && v && (v.one_sentence || v.about_me)) {
      writeProfile(c, 'what-you-bring', bringMd(v));
      return answers(c, { claims_confirmed: true, offer_asked: true });
    }
    const f = profileFile(c, 'what-you-bring');
    if (f.text === f.template || stillTemplate(f.text))
      throw new Error(`Write what they ticked into ${f.path} first ("About me", the offer and the proof they may use), then save.`);
    return answers(c, { claims_confirmed: true });
  },
  // What they'd change in the samples becomes rules in the voice file, here, not left to be written by hand.
  samples: (v, c) => {
    const o = typeof v === 'object' && v ? v : { said: String(v) };
    const rules = (Array.isArray(o.rules) ? o.rules : [])
      .map((r) =>
        String(r)
          .replace(/[\u0000-\u001f`#<>]+/g, ' ')
          .trim()
      )
      .filter(Boolean)
      .slice(0, 10);
    // Their own emails that got replies (pasted, or files): kept in the voice file, and their length and
    // greeting set from them. With none, the fields they would fill are left out, not left blank.
    // A file (or a pasted block) can hold several emails: each is split out, so its length and greeting are
    // read per email, not from one block that starts with "Email 1 (to a CFO…)".
    const emails = (Array.isArray(o.emails) ? o.emails : [])
      .flatMap((x) => {
        if (typeof x !== 'string')
          return x && String(x.body || '').trim()
            ? x.subject
              ? [{ subject: String(x.subject || ''), body: String(x.body) }]
              : splitEmails(String(x.body))
            : [];
        const p = allowedPath(expandHome(x.trim()), { list: true });
        return splitEmails(readChecked(p, 50 * 1024 * 1024).slice(0, 8000)).map((e) => ({ ...e, source: 'file' }));
      })
      .slice(0, 5);
    if (emails.length && c.slug) cli('event-outreach', ['voice-save', '--event', c.slug, '--file', writeWork(c, 'voice-samples.json', { samples: emails })], c);
    const fromEmails = voiceFromEmails(emails.map((x) => x.body));
    let openingSaid = null;
    if (rules.length || o.sign_off || o.closest || emails.length || o.avoid) {
      const f = profileFile(c, 'voice');
      let md = f.text || f.template;
      if (o.sign_off) md = setVoiceField(md, 'Sign-off', o.sign_off);
      if (o.closest) md = setVoiceField(md, 'Tone', o.closest);
      // The user's own length rule wins over the length read from their emails.
      const ruled = lengthRule(rules);
      if (ruled || fromEmails.length) md = setVoiceField(md, 'Length', ruled || fromEmails.length);
      if (fromEmails.greeting) md = setVoiceField(md, 'Greeting', fromEmails.greeting);
      if (o.avoid && !isNo(o.avoid))
        md = setVoiceField(
          md,
          'Avoid',
          String(o.avoid)
            .replace(/[\u0000-\u001f`#<>]+/g, ' ')
            .slice(0, 200)
        );
      if (rules.length) {
        const head = '## Rules from your feedback';
        const add = rules.map((r) => `- ${r}`).join('\n');
        md = md.includes(head) ? md.replace(head, () => `${head}\n${add}`) : `${md.trimEnd()}\n\n${head}\n${add}\n`;
      }
      // A rule about how messages open becomes the voice file's Opening, which the structures follow.
      const opening = rules.length ? openingOf(rules.map((r) => `- ${r}`).join('\n')) : null;
      if (opening) md = setVoiceField(md, 'Opening', opening);
      writeProfile(c, 'voice', md);
      if (opening) openingSaid = `Your rule about the opening is kept as "Opening: ${opening}": ${OPENINGS[opening].says}.`;
    }
    const r = answers(c, { samples_ok: true });
    const out = emails.length ? { ...r, emails_saved: emails.length, from_emails: fromEmails } : r;
    return openingSaid ? { ...out, opening: openingSaid } : out;
  },
  drafter_sample: (v, c) => answers(c, { drafter_sample_ok: true }),
  // "English and another: German" is English and German. An extra language needs its own opt-out line when
  // messages carry one, or a German draft would end in English.
  languages: (v, c) => {
    const o =
      typeof v === 'object'
        ? v
        : {
            languages: /english only/i.test(String(v))
              ? ['English']
              : String(v)
                  .replace(/\b(and )?(only )?another( language)?:\s*/gi, ', ')
                  .replace(/\blanguage\b/gi, '')
                  .split(/,| and /)
                  .map((x) => x.trim())
                  .filter(Boolean)
          };
    const langs = (o.languages || [])
      .map((x) =>
        String(x)
          .trim()
          .replace(/^./, (ch) => ch.toUpperCase())
      )
      .filter(Boolean);
    // floorboss's own opt-out line in common languages, used when the user kept the default one.
    const BUILT_IN = OPTOUT_BUILT_IN;
    const own = { ...(c.cfg.optout_sentences || {}), ...(o.optout_sentences || {}) };
    if (c.cfg.optout_sentence === DEFAULT_OPTOUT) for (const l of langs) if (!own[l] && BUILT_IN[l]) own[l] = BUILT_IN[l];
    o.optout_sentences = Object.keys(own).length ? own : o.optout_sentences;
    const missing = c.cfg.optout_sentence ? langs.filter((l) => l.toLowerCase() !== 'english' && !own[l]) : [];
    if (missing.length)
      throw new Error(
        `Give the opt-out line in ${missing.join(', ')} too: {"languages":${JSON.stringify(langs)},"optout_sentences":{${missing.map((l) => `"${l}":"<the opt-out line in ${l}>"`).join(',')}}}.`
      );
    config(c, { languages: langs, ...(o.optout_sentences ? { optout_sentences: o.optout_sentences } : {}) });
    // What was saved, not the whole config: the user asked about languages.
    return {
      languages: langs,
      ...(o.optout_sentences && langs.some((l) => o.optout_sentences[l])
        ? { optout_sentences: Object.fromEntries(langs.filter((l) => o.optout_sentences[l]).map((l) => [l, o.optout_sentences[l]])) }
        : {})
    };
  },
  app_notes: (v, c) => {
    const o = typeof v === 'object' ? v : {};
    config(c, {
      app_note_times: o.app_note_times || 'in_app',
      app_note_event_name: o.app_note_event_name !== false,
      app_note_optout: o.app_note_optout !== false
    });
    return answers(c, { app_notes_asked: true });
  },
  basics: (v, c) => {
    const o = typeof v === 'object' && v ? v : { said: String(v) };
    if (o.meeting_place) config(c, { meeting_place: String(o.meeting_place).slice(0, 200) });
    const never = (Array.isArray(o.never_say) ? o.never_say : o.never_say ? [o.never_say] : []).map((x) => String(x).trim()).filter(Boolean);
    // Into what-you-bring's own "Never say" line, the one the drafter and the critic read.
    if (never.length) {
      const f = profileFile(c, 'what-you-bring');
      writeProfile(c, 'what-you-bring', addNeverSay(f.text || f.template, never));
    }
    return answers(c, { basics_asked: true });
  },
  // Send setup reads these channels straight away (connectors' chosenChannels); the full sending setting is written with the follow-up mode.
  sending: (v, c) => {
    // Outside Claude Code (lib/harness.mjs) floorboss sends on no channel, whatever the answer says.
    const chans =
      !connected() || isNo(v) || /myself|nowhere/i.test(String(v))
        ? []
        : Array.isArray(v)
          ? v
          : v?.channels ||
            [
              /email/i.test(String(v)) ? 'email' : null,
              /linkedin/i.test(String(v)) ? 'linkedin' : null,
              /app|brella|grip|swapcard/i.test(String(v)) ? 'app' : null
            ].filter(Boolean);
    // Codex: a yes is the user's word for auto-send through Gmail drafts; the flow turns it on before approval.
    const says = String(typeof v === 'string' ? v : v?.said || v?.answer || JSON.stringify(v ?? ''));
    const wantsAuto = !connected() && !isNo(v) && !/^\s*no\b|myself|nowhere|prepare/i.test(says) && /^\s*(?:yes|y|yeah|yep|sure|ok|okay)\b|\bgmail\b|auto/i.test(says);
    return answers(c, { sending_channels: chans, sending_asked: true, ...(wantsAuto ? { autosend_said: String(says || 'yes').slice(0, 200) } : {}) });
  },
  linkedin_send: (v, c) => answers(c, /accept/i.test(String(v)) ? { linkedin_send_ack: true } : { linkedin_send_declined: true }),
  send_setup: (v, c) => {
    if (isNo(v)) return answers(c, { send_setup_skipped: true });
    const o = typeof v === 'object' ? v : { own_email: String(v) };
    config(c, { ...(o.own_email ? { own_email: o.own_email } : {}), ...(o.own_phone ? { own_phone: o.own_phone } : {}) });
    return answers(c, o.done ? { send_setup_done: true } : {});
  },
  followups_mode: (v, c) => {
    if (!followupsModeOf(v)) throw new Error('Ask again: should follow-ups go on their day by themselves, or wait for the user to approve each round?');
    const raw = c.ob.ans.sending_channels || [];
    let chans = raw;
    if (typeof raw === 'string') {
      try {
        chans = JSON.parse(raw);
      } catch {
        chans = raw.split(/[\s,]+/).filter(Boolean);
      }
    }
    return config(c, { sending: { channels: connected() ? chans : [], followups: followupsModeOf(v), linkedin_ack: connected() && c.ob.ans.linkedin_send_ack === true } });
  },
};
