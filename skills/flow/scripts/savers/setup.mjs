// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Savers for the first questions: which event, the disclaimer, the event itself, the goal, the setup level,
// and who the user and their company are.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { allowedPath, readChecked } from '../../../../lib/paths.mjs';
import { readJson } from '../../../../lib/jsonio.mjs';
import { levelOptions } from '../../../event-context/scripts/onboarding-tree.mjs';
import { touchSession, listEvents } from '../../../../lib/scope.mjs';
import { zoneFrom } from '../../../../lib/tz.mjs';
import { handSend } from '../../../../lib/harness.mjs';
import { parseDncReport } from '../../../crm-triage/scripts/dnc.mjs';
import { segmentsMd, setVoiceField } from '../profile-write.mjs';
import { cli, answers, forMock, writeWorkText, config, text, writeProfile, QUICK_ASSUMES, isNo, zoneExample, profileFile } from './helpers.mjs';

export const SETUP_SAVERS = {
  // The event this run is for: an existing one (its name or slug), or a new one (its own answers start empty;
  // the user's setup carries over).
  which_event: (v, c) => {
    const t = String(typeof v === 'object' && v ? v.slug || v.name || '' : v).trim();
    const evs = listEvents(c.now.getTime());
    const exact = evs.find((x) => x.slug === t.toLowerCase() || String(x.name).toLowerCase() === t.toLowerCase());
    const near = exact ? [] : evs.filter((x) => t.length >= 3 && String(x.name).toLowerCase().includes(t.toLowerCase()));
    if (!exact && near.length > 1) throw new Error(`"${t}" could be ${near.map((x) => `${x.name} (${x.start})`).join(' or ')}: ask which.`);
    const pick = exact || near[0];
    if (!pick && !/new/i.test(t))
      throw new Error(`"${t}" isn't one of the events here (${evs.map((x) => x.name).join(', ')}): say its name, or "a new event".`);
    const r = pick ? cli('event-context', ['onboarding', '--event', pick.slug], c) : cli('event-context', ['onboarding', '--new-event'], c);
    touchSession(pick ? pick.slug : null, c.now.getTime());
    // "a new one, ColdChain Summit in Rotterdam": the event's name is in the answer, so it isn't asked again.
    const hint = pick ? null : (/\bnew(?: one| event)?\b[\s,:;-]*(?:it'?s |called )?(.{3,})$/i.exec(t)?.[1] || '').replace(/[.!]+$/, '').trim();
    if (!pick) answers(c, { event_hint: hint && !/^(event|one)$/i.test(hint) ? hint.slice(0, 120) : null });
    // After --restart nothing carries over but the profile files: the setup questions come again.
    const restarted = !!readJson(join(c.home, 'onboarding.json'), {}).restarted_at;
    return {
      event: pick ? pick.slug : null,
      ...(pick
        ? restarted
          ? { note: 'You restarted: the setup questions come again for this event (your profile files are kept).' }
          : {}
        : {
            note: restarted
              ? 'A new event: its questions come next, and the setup questions too, since you restarted (your profile files are kept).'
              : 'A new event: its questions come next; your setup (tools, team, voice) carries over.'
          }),
      onboarding: r.next
    };
  },
  disclaimer: (v, c) => cli('event-context', ['ack', ...forMock(c)], c),
  inventory: (v, c) =>
    answers(c, {
      inventory_confirmed: true,
      extra_tools: typeof v === 'object' ? v.extra_tools || null : /^(yes|ok|confirmed|right|correct)/i.test(String(v)) ? null : String(v).slice(0, 300)
    }),
  event: (v, c) => {
    const o = typeof v === 'object' ? v : null;
    if (!o?.name || !o.start || !o.end || !o.zone) throw new Error('The event answer is {"name","city","start","end","zone"}.');
    const r = cli(
      'slot-finder',
      [
        'create',
        '--name',
        o.name,
        '--city',
        o.city || '',
        '--start',
        o.start,
        '--end',
        o.end,
        '--zone',
        o.zone,
        ...(o.short_name ? ['--short-name', o.short_name] : [])
      ],
      c
    );
    // The do-not-contact list and the off-limits companies of the event before carry into this one: who must
    // never be contacted doesn't change with the event.
    // Every earlier event counts (not only the latest), and a list given as a path on the event counts too.
    const others = listEvents(c.now.getTime())
      .filter((x) => x.slug !== r.slug)
      .map((x) => x.slug);
    cli('event-context', ['onboarding', '--event', r.slug], c);
    const carried = {},
      failed = [];
    // A path an older event names is read only from where lists are read; one outside them is asked for again.
    const fileOf = (slug, name, field) => {
      const a = join(c.home, 'events', slug, 'inputs', name);
      if (existsSync(a)) return a;
      const ev = readJson(join(c.home, 'events', slug, 'event.json'), {});
      if (!ev[field] || !existsSync(ev[field])) return null;
      try {
        return allowedPath(ev[field], { list: true });
      } catch (err) {
        failed.push(`${name === 'dnc.txt' ? 'do-not-contact list' : 'off-limits companies'}: ${err.message.slice(0, 120)}`);
        return null;
      }
    };
    // Each list is read with its own columns, then written as one plain list (a header from one file read the
    // rows of another, and entries were lost).
    const entries = others
      .map((x) => fileOf(x, 'dnc.txt', 'dnc_path'))
      .filter(Boolean)
      .flatMap((f) => {
        try {
          return parseDncReport(readChecked(f, 50 * 1024 * 1024)).entries;
        } catch (err) {
          failed.push(`do-not-contact list: ${String(err.message).slice(0, 120)}`);
          return [];
        }
      });
    const rowOf = (en) =>
      `${en.type === 'domain' ? `@${en.value}` : en.type === 'company' ? `company: ${en.label || en.value}` : en.type === 'name' ? en.label || en.value : en.value},${en.until || ''}`;
    const dncRows = [...new Set(entries.map(rowOf))];
    if (dncRows.length) {
      try {
        cli(
          'crm-triage',
          ['inputs', '--event', r.slug, '--kind', 'dnc', '--file', writeWorkText(c, 'dnc-carried.csv', `Value,Until\n${dncRows.join('\n')}\n`)],
          { ...c, slug: r.slug }
        );
        carried.do_not_contact = dncRows.length;
      } catch (err) {
        failed.push(`do-not-contact list: ${err.message.slice(0, 120)}`);
      }
    }
    const acc = others.map((x) => fileOf(x, 'accounts.csv', 'accounts_path')).find(Boolean);
    if (acc) {
      try {
        cli('crm-triage', ['inputs', '--event', r.slug, '--kind', 'accounts', '--file', acc], { ...c, slug: r.slug });
        carried.off_limits_companies = acc;
      } catch (err) {
        failed.push(`off-limits companies: ${err.message.slice(0, 120)}`);
      }
    }
    // A list that couldn't be carried over is asked for again, never assumed.
    if (failed.length) answers({ ...c, slug: r.slug }, { dnc_asked: false, accounts_asked: false });
    r.carried_over = {
      ...carried,
      ...(failed.length ? { not_carried: failed, note: 'Tell the user: these lists could not be carried over, so they are asked for again.' } : {})
    };
    // The event's own app, from its site, in the same answer (null: the site shows none).
    if (o.app !== undefined) cli('slot-finder', ['app', '--event', r.slug, '--name', o.app ? String(o.app) : 'none'], { ...c, slug: r.slug });
    return r;
  },
  // "yes": the setup stands for this event. Anything they say changed is asked again (its answers cleared).
  reuse_setup: (v, c) => {
    const t = String(typeof v === 'object' && v ? v.said || v.answer || '' : v).toLowerCase();
    // "yes" (and nothing about a change after it) keeps everything; otherwise only what they name is asked again.
    const rest = t.replace(/^\s*(yes|yeah|same|ok|right|correct|y)\b[,.!]?\s*(same setup|all the same)?[,.!]?\s*/, '');
    if (
      (/^\s*(yes|yeah|yep|yup|same|ok|right|correct|y)\b/.test(t) && (!rest.trim() || /^(do not|don'?t) change|nothing chang|no change/.test(rest))) ||
      /^\s*(nothing( has)? changed|no changes?|same as (before|last time)|(do not|don'?t) change anything|all the same)\b/.test(t)
    )
      return answers(c, { setup_reused: true });
    const AGAIN = {
      '\\b(team|colleagues?|coworkers?)\\b': ['works_alone', 'colleagues_asked', 'colleague_notes_asked'],
      '\\b(crm|tools?|mailbox|gmail|outlook|calendar|hubspot|salesforce|pipedrive)\\b': ['tools_confirmed', 'crm_choice', 'mailbox_choice', 'calendar_choice'],
      '\\b(company|job|employer|work at|new role)\\b': ['company_asked', 'about_you_asked', 'offer_asked', 'claims_confirmed'],
      '\\b(voice|tone)\\b': ['samples_ok', 'samples_skipped'],
      '\\b(sign|sign-off|signature|name)\\b|\\b(moved|live in|city)\\b': ['about_you_asked'],
      '\\b(offer|product|proof|sell)\\b': ['offer_asked', 'claims_confirmed'],
      '\\b(send|sending)\\b': ['sending_asked', 'sending_channels', 'send_setup_done'],
      'setup level|more setup|less setup|\\b(quick|full|standard) setup\\b': ['setup_level'],
      'do-not-contact|do not contact list|\\bdnc\\b': ['dnc_asked', 'accounts_asked']
    };
    const clear = Object.entries(AGAIN)
      .filter(([re]) => new RegExp(re).test(rest || t))
      .flatMap(([, keys]) => keys);
    if (!clear.length)
      throw new Error(
        'Say "yes, same setup", or what changed (the team, the CRM or tools, the company, the voice, the offer, sending, the setup level, the do-not-contact list).'
      );
    cli('event-context', ['onboarding', '--forget', clear.join(',')], c);
    // A new company: the old one isn't proposed or used again.
    if (clear.includes('company_asked')) config(c, { own_company: null, own_domains: [] });
    return answers(c, { setup_reused: true });
  },
  goal_type: (v, c) => answers(c, { goal_type: text(v) }),
  // The goal line carries what they're there for and how many meetings (classified, not asked again).
  goal: (v, c) => {
    const o = typeof v === 'object' && v ? v : { goal: text(v) };
    if (!o.goal)
      throw new Error(
        'The answer is {"goal":"<their words>","goal_type":"selling|partnerships|hiring|job|networking|research","meetings_wanted":<n or null>}.'
      );
    // People they name as must-meets in the same breath are kept (the shortlist card asks "anyone missing?" too).
    const must = Array.isArray(o.must_meet) ? o.must_meet.map(String).filter(Boolean) : [];
    config(c, {
      goal: o.goal,
      ...(o.meetings_wanted != null && Number.isFinite(Number(o.meetings_wanted)) ? { meetings_wanted: Number(o.meetings_wanted) } : {}),
      ...(must.length ? { must_meet: must } : {})
    });
    const r = answers(c, {
      ...(o.goal_type ? { goal_type: String(o.goal_type) } : {}),
      ...(o.meetings_wanted !== undefined ? { meetings_wanted_asked: true } : {})
    });
    // The groups proposed with the goal are written into who-to-meet now (and not asked again).
    if (Array.isArray(o.segments) && o.segments.length) {
      writeProfile(c, 'who-to-meet', segmentsMd(o.goal, o.segments));
      return answers(c, { segments_confirmed: true });
    }
    return r;
  },
  // How much setup: quick (the list and drafts, nothing connected used), standard (+ the CRM, mailbox and
  // calendar read, team and customers, tone), full (+ sending, reading replies, CRM logging). Changeable any time.
  setup_level: (v, c) => {
    const t = String(typeof v === 'object' && v ? v.level : v).toLowerCase();
    const rec = (levelOptions(c.ob).find((o) => /\(recommended\)/.test(o)) || 'standard').split(/[ :(]/)[0];
    const first = (/^\W*(quick|standard|full)\b/.exec(t) || [])[1];
    const level =
      first ||
      (/\bquick\b|\bfast\b|\bminimal\b|\blight\b/.test(t)
        ? 'quick'
        : /\bfull\b|\beverything\b|\badvanced\b/.test(t)
          ? 'full'
          : /\bstandard\b|\bmiddle\b|\bnormal\b/.test(t)
            ? 'standard'
            : /recommended/.test(t)
              ? rec
              : null);
    if (!level) throw new Error('Say quick, standard or full.');
    const r = answers(c, { setup_level: level });
    return level === 'quick' ? { ...r, assumes: QUICK_ASSUMES } : r;
  },
  meetings_wanted: (v, c) => {
    const n = typeof v === 'number' ? v : parseInt(String(v).replace(/\D/g, ''), 10);
    config(c, { meetings_wanted: Number.isFinite(n) ? n : null });
    return answers(c, { meetings_wanted_asked: true });
  },
  must_meet: (v, c) => {
    const list = isNo(v)
      ? []
      : Array.isArray(v)
        ? v
        : v?.must_meet ||
          String(v)
            .split(/[;\n]|,\s(?=[A-Z])/)
            .map((x) => x.trim())
            .filter(Boolean);
    config(c, { must_meet: list });
    return answers(c, { must_meet_asked: true });
  },
  about_you: (v, c) => {
    const o0 = typeof v === 'object' && v ? v : null;
    // Hand-send: the sign-off from the first name the agent knows ("Best," and the name), and no city: the home zone is
    // the computer's. A sign-off the user gives later is saved the same way, without a city.
    if (handSend() && o0 && (o0.first_name || (o0.sign_off && !o0.city))) {
      const first = String(o0.first_name || '').trim().split(/\s+/)[0].slice(0, 60);
      if (o0.first_name && !first) throw new Error('The answer is {"first_name":"<first name>","from":"sender_name|account|email|user"}.');
      const sign = o0.sign_off ? String(o0.sign_off) : `Best,\n${first}`;
      const sender = o0.sender_name || (o0.sign_off ? o0.sign_off.replace(/^\s*(best|thanks|cheers|regards|kind regards|all the best|warmly)[,!]?\s*/i, '') : first);
      const f = profileFile(c, 'voice');
      writeProfile(c, 'voice', setVoiceField(setVoiceField(f.text || f.template, 'Sign-off', sign), 'Sender name', sender));
      const shown = sign.replace(/\s*\n\s*/g, ' ');
      return {
        ...answers(c, { about_you_asked: true }),
        sign_off: shown,
        ...(o0.from === 'email'
          ? { say_to_user: `Your messages are signed "${shown}", the name taken from your email address. Say if it should be another name.` }
          : {})
      };
    }
    const o = o0;
    if (!o?.sign_off || !o?.city)
      throw new Error('The answer is {"sign_off":"<as they sign, e.g. Best, Noor>","sender_name":"<name, company>","city":"<where they live>"}.');
    const z = zoneFrom(o.city);
    if (!z) throw new Error(`"${o.city}" isn't a city floorboss knows: ask for the nearest big city, or a time zone like ${zoneExample(c)}.`);
    const f = profileFile(c, 'voice');
    writeProfile(
      c,
      'voice',
      setVoiceField(
        setVoiceField(f.text || f.template, 'Sign-off', o.sign_off),
        'Sender name',
        o.sender_name || o.sign_off.replace(/^\s*(best|thanks|cheers|regards|kind regards|all the best|warmly)[,!]?\s*/i, '')
      )
    );
    config(c, { home_tz: z });
    // The zone the city was read as, said back, so a misread is caught now.
    return { ...answers(c, { about_you_asked: true }), home_zone: `${o.city} → ${z}` };
  },
  // "Berlin", "New York", the option text ("somewhere else: Madrid"): read as a zone, or asked again.
  home_tz: (v, c) => {
    const t = text(v).replace(/^somewhere else:\s*/i, '');
    const z = zoneFrom(t);
    if (!z) throw new Error(`"${t}" isn't a city floorboss knows: ask for the nearest big city, or a time zone like ${zoneExample(c)}.`);
    return { ...config(c, { home_tz: z }), home_zone: `${t} → ${z}` };
  },
  // "not sure / none", "no app", "don't know": no app (the name is never the option's text).
  app: (v, c) =>
    cli(
      'slot-finder',
      [
        'app',
        '--event',
        c.slug,
        '--name',
        isNo(v) || /^\s*(not sure|none|no app|no\b|n\/a|don'?t know|unsure)/i.test(text(v))
          ? 'none'
          : text(v)
              .replace(/\s*\(.*\)\s*$/, '')
              .trim()
      ],
      c
    ),
  app_request_limit: (v, c) => {
    const n = parseInt(String(v).replace(/\D/g, ''), 10);
    config(c, { app_request_limit: Number.isFinite(n) ? n : null });
    return answers(c, { app_limit_asked: true });
  },
  company: (v, c) => {
    const o =
      typeof v === 'object' && v
        ? v
        : { own_company: isNo(v) || /(?:^no company)|(?:^none)|independent|between jobs/i.test(String(v)) ? null : text(v), own_domains: [] };
    if (o.own_company) config(c, { own_company: o.own_company, own_domains: o.own_domains || [] });
    return answers(c, { company_asked: true });
  },
  team: (v, c) => {
    const o = typeof v === 'object' && v ? v : { answer: String(v) };
    const alone = o.works_alone ?? /just me|alone|^me$|only me/i.test(String(o.answer || ''));
    const named = Array.isArray(o.colleagues)
      ? o.colleagues
      : (/:\s*(.+)$/.exec(String(o.answer || ''))?.[1] || '')
          .split(/[,;\n]| and /)
          .map((x) => x.trim())
          .filter((x) => x && !/^<.*>$/.test(x));
    if (!alone && named.length) config(c, { colleagues: named });
    return answers(c, { works_alone: !!alone, ...(alone || named.length ? { colleagues_asked: true } : {}) });
  },
};
