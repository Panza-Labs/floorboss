// Round 7's small things: the opt-out line asks nothing when the mapping isn't asked again; a time is said once
// when two zones share the clock; the research heads-up has four options at most; the coworker count includes the
// people held through their accounts; a second event reuses the CRM layout, the match answers and recent company
// research; held and stuck drafts say what failed; "skip review <id>, <reason>" keeps the reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, idOf } from './fixtures/harness.mjs';
import { ftu6, ftu6Flow, ATTENDEES, CRM } from './fixtures/ftu6.mjs';
import { untilStep } from './fixtures/flow-until.mjs';
import { simplePersona } from './sims/lib/driver.mjs';
import { MOCK, envOf, run, loadMock, home, answer } from './fixtures/r2.mjs';
import { NOW } from './fixtures/harness.mjs';
import { optOutSays } from '../skills/crm-triage/scripts/sources.mjs';
import { slotLabel } from '../skills/slot-finder/scripts/slots.mjs';
import { coworkerCounts, crmLayoutElsewhere, earlierLine, failCounts } from '../skills/flow/scripts/steps.mjs';
import { readCompanyBrief } from '../skills/attendee-research/scripts/companies.mjs';

const WORDS = 'Lifecycle is the status column. Customer means customer, Open Deal is warm, Prospect means hold, Closed Lost is lost. There\'s no opt-out column.';
// An event with the simulated tester's files and its CRM mapping confirmed in words that say nothing about opt-outs.
function confirmed(slug, home = null) {
  const H = setup({ home, event: { slug, name: slug === 'berlin' ? 'Retail Tech Forum Berlin' : 'Paris Shopfront Week' }, attendees: ATTENDEES, crm: CRM, settings: { own_company: 'Paylark', own_domains: ['paylark.example'], colleagues: ['Sam Okafor', 'Sofia Marin'], crm_user_name: 'Ines Moreau', crm_accounts: 'apply', coworker_contacts: 'leave' } });
  cli(H, 'crm-triage', ['propose-mapping', '--event', slug, '--kind', 'crm']);
  const w = join(H.HOME, `w-${slug}.txt`); writeFileSync(w, WORDS);
  const m = cli(H, 'crm-triage', ['confirm-mapping', '--event', slug, '--kind', 'crm', '--words-file', w]);
  assert.ok(!m.ERROR, m.ERROR);
  return H;
}

test('12: the opt-out line asks the user to say something only while the mapping is put to them', () => {
  const m = { columns: { Email: { field: 'email' } } };
  assert.match(optOutSays(m), /say "there's no opt-out column" if that's right/);
  assert.equal(optOutSays(m, { asking: false }), 'no column says who opted out: only stop notes and statuses hold anyone back.');
  // Shown while it's asked; once confirmed, the view says what is so and asks nothing (here and at the next event).
  const A = setup({ event: { slug: 'berlin', name: 'Retail Tech Forum Berlin' }, attendees: ATTENDEES, crm: CRM });
  cli(A, 'crm-triage', ['propose-mapping', '--event', 'berlin', '--kind', 'crm']);
  assert.match(readFileSync(join(A.dir, 'derived', 'mapping-crm.md'), 'utf8'), /if that's right/);
  const w = join(A.HOME, 'w.txt'); writeFileSync(w, WORDS);
  assert.ok(!cli(A, 'crm-triage', ['confirm-mapping', '--event', 'berlin', '--kind', 'crm', '--words-file', w]).ERROR);
  const md = readFileSync(join(A.dir, 'derived', 'mapping-crm.md'), 'utf8');
  assert.match(md, /Opt-outs: no opt-out column \(you said there is none\)/);
  assert.doesNotMatch(md, /if that's right/);
  const B = setup({ home: A.HOME, event: { slug: 'paris', name: 'Paris Shopfront Week' }, attendees: ATTENDEES, crm: CRM });
  const p = cli(B, 'crm-triage', ['propose-mapping', '--event', 'paris', '--kind', 'crm']);
  assert.equal(p.confirmed, true, JSON.stringify(p));
  assert.doesNotMatch(readFileSync(join(B.dir, 'derived', 'mapping-crm.md'), 'utf8'), /if that's right/);
});

test('13: Berlin and Amsterdam share the clock: the time is said once; London is said beside it', () => {
  const slot = { start: '2026-11-10T08:30:00Z' };
  assert.equal(slotLabel(slot, 'Europe/Berlin', 'Europe/Amsterdam', 'Berlin'), 'Tue 10 Nov, 09:30 Berlin time');
  assert.equal(slotLabel(slot, 'Europe/Berlin', 'Europe/London', 'Berlin'), 'Tue 10 Nov, 09:30 Berlin time (08:30 London time)');
});

test('14: the research heads-up has four options at most, the people asked in its second clause', { timeout: 300000 }, () => {
  const { H, persona } = ftu6Flow();
  const r = untilStep(H, persona, 'company_research');
  assert.equal(r.step, 'company_research', JSON.stringify(r.last).slice(0, 300));
  const q = r.last.ask;
  assert.ok(q.options.length <= 4, JSON.stringify(q.options));
  assert.deepEqual([q.options[0], q.options[2], q.options[3]], ['go', 'skip companies', 'skip all']);
  assert.match(q.options[1], /^skip some: /);
  assert.match(q.question, /Go, or skip some\? And the \d+ shortlisted people: research all \d+, the top \d+, or none\?$/);
  assert.match(q.answer_format, /for the people, add "people: /);
});

test('15: the coworker count says who is held through their accounts too', () => {
  const H = ftu6();
  const counts = coworkerCounts({ event: { inputs: { crm: join(H.dir, 'crm.csv'), attendees: join(H.dir, 'attendees.csv') }, paths: { dir: H.dir } }, cfg: { crm_user_name: 'Ines Moreau' } });
  assert.deepEqual(counts.find((x) => x.owner === 'Sam Okafor'), { owner: 'Sam Okafor', records: 2, on_list: 1, through_accounts: 2 });
});

test('16a: a second event knows the CRM layout from the first, so the export question doesn\'t ask for the opt-out field', () => {
  const A = confirmed('berlin');
  const B = setup({ home: A.HOME, event: { slug: 'paris', name: 'Paris Shopfront Week' }, attendees: ATTENDEES });
  assert.equal(crmLayoutElsewhere({ paths: { dir: B.dir }, event: { slug: 'paris' } }), 'Retail Tech Forum Berlin');
  assert.equal(crmLayoutElsewhere({ paths: { dir: A.dir }, event: { slug: 'berlin' } }), null);
});

test('16b: Kate\'s match (same person as CRM row 5) settled at the first event is not asked again at the second', () => {
  const A = ftu6({ event: { slug: 'berlin', name: 'Retail Tech Forum Berlin' } });
  const kate = idOf(A, 'Kate Lindqvist');
  const d = cli(A, 'crm-triage', ['decide-batch', '--event', 'berlin', '--text', `${kate} same-person crm:5 warm because we met at Tillcon in March`]);
  assert.ok(!d.ERROR, d.ERROR);
  const B = ftu6({ home: A.HOME, event: { slug: 'paris', name: 'Paris Shopfront Week' } });
  const r = JSON.parse(readFileSync(join(B.dir, 'derived', 'resolved.json'), 'utf8'))[idOf(B, 'Kate Lindqvist')];
  assert.notEqual(r.group, 'check', JSON.stringify(r));
  assert.match(r.says, /Prospect/, 'her CRM record counts as hers: "Prospect" means hold');
  // Only the match is carried: the warm was for the first event, and this one's answer is the user's to give.
  assert.notEqual(r.group, 'warm');
});

test('16c: a company researched for the first event a few days ago: said in the heads-up, and "skip" uses that research', () => {
  assert.equal(earlierLine([{ company: 'Cartwise', researched_earlier: { event: 'Retail Tech Forum Berlin', days_ago: 7 } }, { company: 'Basketry', researched_earlier: { event: 'Retail Tech Forum Berlin', days_ago: 7 } }, { company: 'Loopcart' }]),
    ' Cartwise, Basketry were researched 7 days ago for Retail Tech Forum Berlin: refresh, or skip (and use that research)?');
  assert.equal(earlierLine([{ company: 'Loopcart' }]), '');
  const A = ftu6({ event: { slug: 'berlin', name: 'Retail Tech Forum Berlin' } });
  cli(A, 'crm-triage', ['gate', '--event', 'berlin', '--answers', 'defaults']);
  const brief = { sells: 'checkout software for marketplaces', relation_to_us: 'prospect: they run their own payouts', existing_vendors: 'none found', what_they_would_want: 'faster seller payouts', do_not_tell_them: 'their own launch', industry_news_none: 'nothing recent in their market', sources: ['https://cartwise.example/about'] };
  const s = cli(A, 'attendee-research', ['save-company', '--event', 'berlin', '--company', 'Cartwise', '--json', JSON.stringify(brief)]);
  assert.ok(s.saved, JSON.stringify(s));
  const B = ftu6({ home: A.HOME, event: { slug: 'paris', name: 'Paris Shopfront Week' } });
  cli(B, 'crm-triage', ['gate', '--event', 'paris', '--answers', 'defaults']);
  const plan = cli(B, 'attendee-research', ['company-plan', '--event', 'paris']);
  const cw = plan.companies.find((x) => x.company === 'Cartwise');
  assert.deepEqual(cw?.researched_earlier, { event: 'Retail Tech Forum Berlin', days_ago: 0 }, JSON.stringify(plan.companies));
  const k = cli(B, 'attendee-research', ['skip-companies', '--event', 'paris']);
  assert.ok((k.reused_research || []).some((x) => x.company === 'Cartwise'), JSON.stringify(k));
  assert.match(readCompanyBrief(B.dir, 'Cartwise'), /\*\*Sells:\*\* checkout software for marketplaces/);
});

test('17: what the tries at a draft ran into, counted: "1 check fail and 1 critic fail"', () => {
  const E = [
    { type: 'drafted', id: 'c016', touch: 1, checks: ['too long'] }, { type: 'drafted', id: 'c016', touch: 1, checks: [] },
    { type: 'critic', id: 'c016', touch: 1, verdict: 'FAIL' }, { type: 'critic', id: 'c008', touch: 1, verdict: 'FAIL' },
  ];
  assert.equal(failCounts(E, 'c016', 1), '1 check fail and 1 critic fail');
  assert.equal(failCounts([...E, { type: 'critic', id: 'c016', touch: 1, verdict: 'FAIL' }], 'c016', 1), '1 check fail and 2 critic fails');
  assert.equal(failCounts([...E, { type: 'revise', id: 'c016', touch: 1 }], 'c016', 1), '', 'counted again from the user\'s last word');
});

test('18: "skip review c008, I know that\'s true, I was on that deal" keeps the reason on the skip and as a note', { timeout: 300000 }, () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const H = { HOME, now: NOW, env: envOf(HOME) };
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), voice_samples: 'skip', rate: 'skip' } });
  const at = untilStep(H, per, 'critic');
  const then = at.last.agents[0].then;
  const id = then[then.indexOf('--ids') + 1].split(',')[0].split(':')[0];
  const r = answer(HOME, 'skip_review', `skip review ${id}, I know that's true, I was on that deal`);
  assert.ok(!r.ERROR, r.ERROR);
  const led = readFileSync(join(HOME, 'events', MOCK, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(led.some((e) => e.type === 'review_skipped' && e.id === id && e.because === 'I know that\'s true, I was on that deal'), JSON.stringify(led.filter((e) => e.type === 'review_skipped')));
  assert.ok(led.some((e) => e.type === 'note' && e.id === id && e.who === 'user' && e.text === 'I know that\'s true, I was on that deal'));
  // "skip review all" names nobody: no note on anyone.
  run(HOME, 'flow', ['next', '--event', MOCK]);
});
