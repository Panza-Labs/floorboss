// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Phase 1 of nextStep, and the setup questions the first three phases ask (onboardingAsk).
import { join } from 'node:path';
import { planQuestions, NODES, defaultsFor } from '../../../event-context/scripts/onboarding-tree.mjs';
import { crmReaderHint } from '../../../connectors/scripts/tasks.mjs';
import { plural } from '../../../../lib/plural.mjs';
import { step, node, handSend } from './shared.mjs';
import { ANSWER_FORMAT, helpFor, DISCLAIMER, HAND_SEND_ASKS } from './wording.mjs';
import { coworkerCounts, customerCounts, lostCounts } from './counts.mjs';

// The next onboarding question of one phase, or null when that phase is done.
export function onboardingAsk(c, phase) {
  const plan = planQuestions(c.ob, { batch: 1, phase });
  if (plan.done || !plan.questions.length) return null;
  const q = plan.questions[0];
  const n = NODES.find((x) => x.id === q.id);
  // How many people on the list each coworker owns in the CRM, worked out here, so the question can say it.
  if (q.id === 'coworker_contacts') {
    const counts = coworkerCounts(c);
    if (counts)
      q.ask = `${q.ask} The counts: ${counts.map((x) => `${x.owner} owns ${x.on_list} on the list (${x.records} in the CRM)${x.through_accounts ? `, plus ${x.through_accounts} held through their accounts` : ''}`).join('; ') || 'no coworker owns anyone on the list'}.`;
  }
  // And who on the list is at the user's customers, for the customers question.
  if (q.id === 'customers') {
    const at = customerCounts(c);
    if (at)
      q.ask = `${q.ask} The count: ${at.people ? `${plural(at.people, 'person', 'people')} on the list at ${plural(at.companies.length, 'customer')}: ${at.companies.map((x) => `${x.company} (${x.names.join(', ')})`).join('; ')}` : 'nobody on the list is at one of your customers'}.`;
  }
  // And who on the list has a lost deal or a rejection, for the lost-deals question.
  if (q.id === 'lost_deals') {
    const lost = lostCounts(c);
    if (lost)
      q.ask = `${q.ask} The count: ${lost.length ? `${plural(lost.length, 'person', 'people')} on the list: ${lost.map((x) => `${x.name} (${x.why}${x.at ? `, last in touch ${x.at}` : ', no date'})`).join('; ')}` : 'nobody on the list has a lost deal or a rejection in the CRM'}.`;
  }
  // Hand-send: the user's question apart from the notes for the agent (wording.mjs HAND_SEND_ASKS).
  const hs = handSend() ? HAND_SEND_ASKS[q.id] : null;
  const plain = hs ? hs.question({ ...c.ob, ans: c.ob.ans || {}, cfg: c.ob.cfg || {} }) : null;
  return step(
    `onboarding:${q.id}`,
    `Onboarding (${phase === 'first' ? 'before the first look at the list' : phase === 'triage' ? (c.ob.ans.crm_choice && c.ob.ans.crm_choice !== 'none' ? 'now the CRM is read' : 'now the list is read') : 'after the shortlist'}): ${q.id.replace(/_/g, ' ')}.`,
    {
      ask: {
        id: q.id,
        question: plain || q.ask,
        ...(hs ? { how_to_ask: hs.how, ...(plain ? { for_agent: q.ask } : {}) } : {}),
        options: q.options || undefined,
        answer_format: ANSWER_FORMAT[q.id] || (q.options ? "one of the options, or the user's own words" : "the user's words"),
        saves: n?.saves
      },
      help: helpFor(q.id)
    }
  );
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
  if (!c.ob.inv && !mock)
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
  // Onboarding, first phase: what's needed to show who on the list fits. One question at a time.
  const ask1 = !mock && onboardingAsk(c, 'first');
  if (ask1) return ask1;
  const e = c.event;
  if (!e)
    return step('event', 'Onboarding is done but no event is set: create it.', {
      ask: {
        id: 'event',
        question: 'Which event is this for? A name or a link.',
        ...(handSend() ? { how_to_ask: HAND_SEND_ASKS.event.how } : {}),
        answer_format: '{"name","city","start":"YYYY-MM-DD","end":"YYYY-MM-DD","zone":"Area/City"}'
      }
    });
  Object.assign(x, { cfg, mock, e });
}
