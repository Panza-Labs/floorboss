// The AE persona: Marcus Bell at Tallyline, his answers and how he judges fit. Used by
// test/sims/ae-email.test.mjs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { simplePersona, ROOT } from '../../lib/driver.mjs';

export const P = join(ROOT, 'test/sims/personas/ae-email');
export const RECIPE = { server: 'gmail', tool: 'send_message', args: { to: '{to}', subject: '{subject}', body: '{body}', threadId: '{thread_id}' }, reading: 'the id and threadId it returns', tool_hash: 'b'.repeat(64), test_draft: { draft_id: 'm-test', user_confirmed: true } };

// Fit, as a careful reader of titles and companies would judge it (the persona's segments).
const VENDORS = /vigilant grid|sentra risk|fraudwise|idverity|coreline|tallymark|quillstone|northvane|paragon core|velocity card tech|beacon consent|stratus data|kinetic payments|halberd|marlow risk|westbrook|copley|thornfield|finreg|tallyline|institute|university|college|press|news|times|journal|recruit|staffing|summit organis|events/i;
const STRONG = /\b(head|director|vp|svp|evp|chief|cro|cco|officer|lead)\b/i;
const WEAK = /analyst|assistant|coordinator|engineer|designer|marketing|hr |human|it project|branch|sales|account executive|partner manager|talent|student|writer|booth|sponsor/i;
const FINTECH = /pay|neobank|remit|fintech|card|merchant/i;
function fitOf(r) {
  const t = String(r.title || ''), co = String(r.company || '');
  if (VENDORS.test(co) || WEAK.test(t) || !STRONG.test(t)) return { id: r.id, segment: null, reason: `${t || 'no title'} at ${co}: not a buyer here`, score: 10 };
  const seg = FINTECH.test(co) && /risk|fraud|trust|safety|disputes/i.test(t) ? 'fintech-payments-risk' : /aml|bsa|financial crime|compliance|transaction monitoring|sanction/i.test(t) ? 'aml-financial-crimes' : /fraud|risk|disputes|payments/i.test(t) ? 'fraud-leaders' : null;
  return seg ? { id: r.id, segment: seg, reason: `${t} at ${co}`, score: /chief|svp|head/i.test(t) ? 90 : 75 } : { id: r.id, segment: null, reason: `${t} at ${co}: outside the segments`, score: 20 };
}

export function persona(H) {
  const people = () => JSON.parse(readFileSync(join(H.HOME, 'events', 'midway-risk-summit-2027', 'derived', 'contacts.json'), 'utf8'));
  const idOf = (name) => people().find((x) => x.name === name)?.id;
  return simplePersona({
    event: { name: 'Midway Risk Summit 2027', city: 'Chicago', start: '2026-10-20', end: '2026-10-22', zone: 'America/Chicago' },
    asks: {
      goal: { goal: 'Book first meetings with fraud and financial-crimes leaders at banks, credit unions and payments companies at the Midway Risk Summit', goal_type: 'selling', meetings_wanted: 15, must_meet: ['Rachel Okafor (Merriton Bank)'] },
      home_tz: 'America/New_York', company: { own_company: 'Tallyline', own_domains: ['tallyline.example'] }, team: 'my team too',
      colleagues: { colleagues: ['Priya Raman', 'Dan Whitfield', 'Kelsey Ortiz'] }, must_meet: { must_meet: ['Rachel Okafor (Merriton Bank)'] },
      crm_where: 'a CRM that isn\'t connected here', crm_export: join(P, 'crm.csv'), crm_name: 'Marcus Bell', customers: 'warm note for every customer',
      free_time: { free: 'Tue 10-1, 3-6; Wed 10-6; Thu 10-12', zone: 'America/New_York' }, profile: { name: 'fincrime' },
      sending: { channels: ['email'] }, send_setup: { own_email: 'marcus.bell@tallyline.example', done: true }, followups_mode: 'scheduled: each goes on its day',
      attendee_list: join(P, 'attendees.csv'), map_columns_crm: 'ok', crm_accounts: 'yes, apply it',
      check_these: (s) => s.ask.people.map((p) => (p.name === 'Jessica Tran' || p.name === 'Samuel Ortiz' ? `${p.id} same-person ${(p.alternatives.find((a) => a.ref) || {}).ref || 'all'}` : `${p.id} different-person all`)).join('\n'),
      gate: [() => `cap 2, cap merriton-bank 4, remove ${idOf('Teresa Wong')}`, 'ok'],
      // One question for everyone due (batched), or one person (the older form).
      no_reply: (s) => s.ask.people ? { people: s.ask.people.map((p) => p.id), replied: s.ask.people.filter((p) => p.name === H.replied).map((p) => p.id), stopped: [], said: 'checked my inbox' } : ({ id: s.ask.person.id, answer: s.ask.person.name === H.replied ? 'they replied' : 'no reply', said: s.ask.person.name === H.replied ? 'she wrote back yesterday' : 'nothing from them' }),
    },
    judge: { fit: (rows) => rows.map(fitOf) },
  });
}

