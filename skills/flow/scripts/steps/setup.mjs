// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Phase 1 of nextStep, and the setup questions the first three phases ask (onboardingAsk).
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { planQuestions, NODES, defaultsFor } from '../../../event-context/scripts/onboarding-tree.mjs';
import { crmReaderHint } from '../../../connectors/scripts/tasks.mjs';
import { plural } from '../../../../lib/plural.mjs';
import { step, node, handSend } from './shared.mjs';
import { ownerSaid } from '../../../../lib/names.mjs';
import { ANSWER_FORMAT, helpFor, DISCLAIMER, HAND_SEND_ASKS, withWhy } from './wording.mjs';
import { coworkerCounts, customerCounts, lostCounts } from './counts.mjs';
import { intakeSteps } from './intake.mjs';

// The next onboarding question of one phase, or null when that phase is done.
export function onboardingAsk(c, phase) {
  const plan = planQuestions(c.ob, { batch: 1, phase });
  if (plan.done || !plan.questions.length) return null;
  const q = plan.questions[0];
  const n = NODES.find((x) => x.id === q.id);
  // The counts the three CRM questions say, worked out here from the files. They are shown to the user in the question
  // itself, never left in the agent's notes. Every name in them comes from the user's files or the CRM, so each is shown as
  // data (as written when it is plainly a name, else in quotes, ownerSaid) and nothing in a cell can pose as an instruction.
  let counted = '';
  // How many people on the list each coworker owns in the CRM, worked out here, so the question can say it.
  if (q.id === 'coworker_contacts') {
    const counts = coworkerCounts(c);
    if (counts)
      counted = `The counts: ${counts.map((x) => `${ownerSaid(x.owner)} owns ${x.on_list} on the list (${x.records} in the CRM)${x.through_accounts ? `, plus ${x.through_accounts} held through their accounts` : ''}`).join('; ') || 'no coworker owns anyone on the list'}.`;
  }
  // And who on the list is at the user's customers, for the customers question.
  if (q.id === 'customers') {
    const at = customerCounts(c);
    if (at)
      counted = `The count: ${at.people ? `${plural(at.people, 'person', 'people')} on the list at ${plural(at.companies.length, 'customer')}: ${at.companies.map((x) => `${ownerSaid(x.company)} (${x.names.map(ownerSaid).join(', ')})`).join('; ')}` : 'nobody on the list is at one of your customers'}.`;
  }
  // And who on the list has a lost deal or a rejection, for the lost-deals question.
  if (q.id === 'lost_deals') {
    const lost = lostCounts(c);
    if (lost)
      counted = `The count: ${lost.length ? `${plural(lost.length, 'person', 'people')} on the list: ${lost.map((x) => `${ownerSaid(x.name)} (${x.why}${x.at ? `, last in touch ${x.at}` : ', no date'})`).join('; ')}` : 'nobody on the list has a lost deal or a rejection in the CRM'}.`;
  }
  // The CRM owner question: a reading of the last answer waiting for the user's yes is the question itself; otherwise the
  // owners to pick from, numbered as the saver reads a number (crm-triage crmOwnerList) and shown as data.
  let crmReading = '';
  if (q.id === 'crm_name') {
    const reading = String(c.ob?.crmOwnerReading?.text || '');
    if (reading) crmReading = reading;
    else {
      const o = typeof c.ob?.crmOwners === 'function' ? c.ob.crmOwners() : [];
      if (o.length)
        counted = `The owners in your CRM: ${o.slice(0, 12).map((x, i) => `${i + 1}. ${ownerSaid(x)}`).join('; ')}${o.length > 12 ? `; and ${o.length - 12} more` : ''}.`;
    }
  }
  // Hand-send: the sign-off isn't asked. "Best," and the first name the agent already knows, saved as the answer.
  if (q.id === 'about_you') return signOffStep(c);
  // Hand-send: the user's question apart from the notes for the agent (wording.mjs HAND_SEND_ASKS).
  const hs = HAND_SEND_ASKS[q.id] || null;
  const plain0 = hs ? hs.question({ ...c.ob, ans: c.ob.ans || {}, cfg: c.ob.cfg || {} }) : null;
  const plain = crmReading || (plain0 && counted ? `${plain0} ${counted}` : plain0);
  return step(
    `onboarding:${q.id}`,
    `Onboarding (${phase === 'first' ? 'before the first look at the list' : phase === 'triage' ? (c.ob.ans.crm_choice && c.ob.ans.crm_choice !== 'none' ? 'now the CRM is read' : 'now the list is read') : 'after the shortlist'}): ${q.id.replace(/_/g, ' ')}.`,
    {
      ask: {
        id: q.id,
        question: withWhy(q.id, plain || (counted ? `${q.ask} ${counted}` : q.ask)),
        ...(hs ? { how_to_ask: hs.how, ...(plain ? { for_agent: q.ask } : {}) } : {}),
        options: q.options || undefined,
        answer_format: hs?.format || ANSWER_FORMAT[q.id] || (q.options ? "one of the options, or the user's own words" : "the user's words"),
        saves: n?.saves
      },
      help: helpFor(q.id)
    }
  );
}

// The sender name already in the voice file, when it is one (not the template's "<name, company…>").
function voiceSender(c) {
  const p = c.ob?.cfg?.context_profile || c.cfg?.context_profile;
  if (!p) return null;
  const f = join(c.home, 'context', p, 'voice', 'SKILL.md');
  if (!existsSync(f)) return null;
  const m = /^-\s*\*\*Sender name:\*\*\s*(.+)$/m.exec(readFileSync(f, 'utf8'));
  const v = m ? m[1].trim() : '';
  return v && !v.startsWith('<') ? v.slice(0, 120) : null;
}

// Hand-send: the sign-off is "Best," and the user's first name, never a question. The first name comes from what is
// known, in this order: the sender name already saved, the name on the ChatGPT or Codex account the agent works in, and
// last the local part of the address they send from (said back only then: "gary.holt" may not be how he signs). The
// home zone is the computer's (the defaults step), so no city is asked either.
export function signOffStep(c) {
  const known = voiceSender(c);
  const own = c.event?.event?.autosend_own || c.cfg?.own_email || null;
  const write = join(c.home, 'work', 'about-you.json');
  return step('onboarding:about_you', "The sign-off: \"Best,\" and the user's first name, from what's already known. Not a question.", {
    judge: {
      read: null,
      ...(known || own ? { known: { ...(known ? { sender_name: known } : {}), ...(own ? { sends_from: own } : {}) } } : {}),
      how: `Don't ask the user how they sign. Messages are signed "Best," and their first name on the next line. Take the first name from, in order: ${known ? `the sender name already saved (${JSON.stringify(known)}), ` : ''}the name on the ChatGPT or Codex account you're working in, if you know it; or, last, the local part of the address they send from${own ? ` (${own})` : ''}, before the @, as a name ("gary.holt" is Gary). Write {"first_name":"<it>","from":"sender_name|account|email"} and run then. Only when it came from the address, say the sign-off back in one line (the answer's say_to_user) so they can correct it. If you know none of these, ask one short question: "What first name should your messages be signed with?", and write their answer with "from":"user". If they later ask for another sign-off, save it with flow answer --ask about_you as {"sign_off":"<as they sign>","sender_name":"<name, company>"}.`,
      write,
      format: '{"first_name":"<first name>","from":"sender_name|account|email|user"}',
      then: node('flow', 'answer', ...(c.event?.event?.slug ? ['--event', c.event.event.slug] : []), '--ask', 'about_you', '--value-file', write)
    },
    accepts: ['about_you'],
    help: helpFor('about_you')
  });
}

// Before there is an event: the disclaimer, the scan of what is connected, the first questions, the event itself.
export function setupSteps(x) {
  const { c } = x;
  const cfg = c.cfg;
  // The mock's yes is kept in the mock's own settings, so it never stands for the real start.
  const acked =
    c.event?.event?.mock === true ? c.event.settings?.disclaimer_ack === true || c.event.event.settings?.disclaimer_ack === true : cfg.disclaimer_ack === true;
  if (!acked)
    return step('disclaimer', 'Before anything else, the user confirms they have read what floorboss does and does not do.', {
      ask: {
        id: 'disclaimer',
        question: `${DISCLAIMER}\n\nHave you read this?`,
        show_as: 'the question text exactly as given: one plain paragraph, then the question (no quote marks, no line breaks inside it)',
        options: ["I've read it"],
        answer_format: 'the word ok'
      },
      help: helpFor('disclaimer')
    });
  // The mock event comes with its settings: after the disclaimer it goes straight to the lists.
  const mock = c.event?.event?.mock === true;
  // "check again" after connecting a mailbox (mailbox_connect): the scan runs once more.
  // An inventory saved before 0.1.7 doesn't say which mailboxes can send or draft: scanned again, never read as "can't".
  const stale = !!c.ob.inv && (c.ob.inv.found?.email || []).length > 0 && !Array.isArray(c.ob.inv.found?.email_send);
  const rescan = stale || (!!c.ob.inv && !!c.ob.ans?.rescan_at && !(String(c.ob.inv.scanned_at || '') >= String(c.ob.ans.rescan_at)));
  if ((!c.ob.inv || rescan) && !mock)
    return step(
      'scan',
      "floorboss hasn't looked at what this Claude setup already has (skills, agents, connected tools). The scan decides which questions are worth asking.",
      {
        judge: {
          read: null,
          write: join(c.home, 'work', 'session.json'),
          format:
            '{"tools": ["mcp__server__tool", …], "skills": [{"name","description"}], "agents": [{"name","description"}]} : every MCP tool name in this session\'s tool list, and the skills and agents listed to you; nothing else',
          then: node('event-context', 'scan', '--session-file', join(c.home, 'work', 'session.json'))
        }
      }
    );

  // A tool the user chose is connected before anything relies on it: discovery for that task, or the user's
  // own fallback. Without a recipe, the CRM lookup used to be skipped without a word, and the cold list then
  // held opt-outs, customers and coworkers' contacts.
  if (!mock) {
    const a = c.ob.ans || {};
    const CONNECT = [
      {
        task: 'crm.lookup',
        chosen: a.crm_choice === 'connector',
        what: 'CRM',
        server: a.crm_server,
        also: '',
        fallback: '"use an export instead" or "no CRM for this event"'
      },
      // Replies: the CRM's record of the user's email, read by the tool that holds it for that CRM (CRM_READERS),
      // set up with the lookup so a CRM that logs mail reads replies by design.
      {
        task: 'crm.activity',
        chosen: a.crm_choice === 'connector' && !!cfg.connectors?.['crm.lookup'] && a.crm_activity !== 'none',
        what: "CRM's record of your email",
        server: a.crm_server,
        also: ` Where this CRM keeps logged email: ${crmReaderHint(a.crm_server, a.crm_label, cfg.connectors?.['crm.lookup']?.server)} Probe it with someone the user says they emailed recently, by that person's record id (or email); an answer with none of the user's email in it means this CRM doesn't log their mail.`,
        fallback: '"my CRM doesn\'t log my email" (replies are then asked about)'
      },
      {
        task: 'email.history',
        chosen: a.mailbox_choice === 'yes',
        what: 'mailbox',
        server: null,
        also: " Also save email.messages with the tool that reads one person's messages, if one fits (follow-ups check replies with it).",
        fallback: '"don\'t use the mailbox"'
      },
      {
        task: 'calendar.busy',
        chosen: a.calendar_choice === 'yes',
        what: 'calendar',
        server: null,
        also: ' Also save calendar.events if a tool fits.',
        fallback: '"I\'ll type my free time"'
      },
      {
        task: 'enrich.person',
        chosen: a.contact_details === 'mcp',
        what: `people-data tool (${a.enrich_server || 'enrichment'})`,
        server: a.enrich_server || null,
        also: ' Probe it with one person the user names themselves (their own work address is fine), never someone on the list: each lookup can spend a credit.',
        fallback: '"give me a CSV instead"'
      }
    ];
    const k = CONNECT.find((x) => x.chosen && !cfg.connectors?.[x.task]);
    if (k)
      return step('connect', `The user chose their ${k.what}. Connect it now, before anything relies on it, so nothing is skipped without a word.`, {
        judge: {
          how: `Follow skills/connectors/SKILL.md "Discovery" for ${k.task} only${k.server ? `, on ${k.server}` : ''}: list its tools and screen them, probe read-only, validate, and save-recipe.${k.also} Then tell the user in one line which tool it uses and that it only reads. If it can't be saved after two tries, say what went wrong and ask: try again, or ${k.fallback}. Save that answer with flow answer --ask connect_fallback --value-file <file> as {"task":"${k.task}","answer":"<their words>"}.`,
          then: node('connectors', 'status')
        },
        task: k.task,
        accepts: ['connect_fallback'],
        help: 'skills/connectors/SKILL.md#discovery-in-setup'
      });
  }

  // What is never asked (the cap per company, home zone, posture, who writes…) is saved first, without a
  // question; the profile starts once there's a goal.
  if (!mock && (defaultsFor(c.ob) || (c.cfg.goal && !c.cfg.context_profile)))
    return step('defaults', 'Settings that follow from the scan, the event and earlier answers, saved without asking.', {
      run: node('event-context', 'onboarding-defaults'),
      show: ['saved']
    });
  // The guided intake (intake.mjs): what floorboss can learn from, and who to reach at this show, one step per pick.
  const intake = intakeSteps(c, { mock });
  if (intake) return intake;
  // Onboarding, first phase: what's needed to show who on the list fits. One question at a time.
  const ask1 = !mock && onboardingAsk(c, 'first');
  if (ask1) return ask1;
  const e = c.event;
  if (!e)
    return step('event', 'Onboarding is done but no event is set: create it.', {
      ask: {
        id: 'event',
        question: withWhy('event', 'Which event is this for? A name or a link.'),
        how_to_ask: HAND_SEND_ASKS.event.how,
        answer_format: '{"name","city","start":"YYYY-MM-DD","end":"YYYY-MM-DD","zone":"Area/City"}'
      }
    });
  Object.assign(x, { cfg, mock, e });
}
