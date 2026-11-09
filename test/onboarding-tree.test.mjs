// Onboarding as a decision tree: the scan decides which questions apply, and every answer steers the next.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan, summarize } from '../skills/event-context/scripts/scan.mjs';
import { planQuestions, defaultsFor } from '../skills/event-context/scripts/onboarding-tree.mjs';

const skill = (home, name, description) => { const d = join(home, '.claude', 'skills', name); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`); };
const EV = { slug: 'ev', name: 'Expo', start_date: '2026-11-10', app_name: null, no_app: true };
// Most walks below are the full setup; the levels have their own tests.
const ask = (s) => planQuestions({ ...s, ans: { setup_level: 'full', ...s.ans } }).questions.map((q) => q.id);
// Walk the tree as the flow does: silent defaults first, then one question at a time, phase by phase, with a
// fixed set of answers. Returns every question asked, as "phase:id", in order.
function walk(s, answer) {
  const asked = [];
  for (let i = 0; i < 80; i++) {
    const d = defaultsFor(s);
    if (d) { Object.assign(s.cfg, d.config); Object.assign(s.ans, d.answers); if (s.cfg.goal && !s.cfg.context_profile) s.cfg.context_profile = 'p'; continue; }
    if (s.cfg.goal && !s.cfg.context_profile) { s.cfg.context_profile = 'p'; continue; }
    const p = ['first', 'triage', 'later'].map((phase) => planQuestions(s, { batch: 1, phase })).find((x) => !x.done);
    if (!p) return asked;
    const q = p.questions[0];
    if (q.id === 'setup_level') { s.ans.setup_level = s.level || 'full'; continue; }
    asked.push(`${p.phase}:${q.id}`);
    answer(q.id, s);
  }
  throw new Error(`the tree didn't end: ${asked.join(' ')}`);
}
const ids = (asked) => asked.map((x) => x.split(':')[1]);

test('scan: finds writers, voice, context and tools; never reads MCP secrets', () => {
  const home = mkdtempSync(join(tmpdir(), 'fb-scan-'));
  skill(home, 'acme-sdr', 'Writes cold email and LinkedIn outreach for Acme in our brand voice, using our ICP and case studies.');
  skill(home, 'algorithmic-art', 'Creating algorithmic art. Useful for CRM dashboards? no.');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { hubspot: { command: 'npx', args: ['hubspot-mcp'], env: { HUBSPOT_TOKEN: 'secret-123' } }, clay: { type: 'http', url: 'https://api.clay.com/v3/mcp', headers: { Authorization: 'Bearer zzz' } } } }));
  const inv = scan({ home, cwd: home });
  assert.equal(inv.outbound, 'full');
  assert.deepEqual(inv.writers.map((w) => w.name), ['acme-sdr']);
  assert.ok(inv.found.crm.includes('mcp:hubspot'));
  assert.ok(inv.found.enrichment.includes('mcp:clay'));
  assert.ok(!inv.found.crm.includes('skill:algorithmic-art'), 'a skill is a CRM only by its name');
  assert.doesNotMatch(JSON.stringify(inv), /secret-123|Bearer zzz/);
});

// Answers for everything the tree may ask; a question nobody expected fails the walk.
const ANSWER = (st, own = {}) => ({
  inventory: () => { st.ans.inventory_confirmed = true; }, goal: () => { st.cfg.goal = 'x'; st.ans.goal_type = own.goal_type || 'selling'; },
  goal_type: () => { st.ans.goal_type = 'selling'; }, segments: () => { st.ans.segments_confirmed = true; }, list_source: () => { st.ans.list_source = 'export'; st.list = { rows: 300, with_email: 280 }; },
  tools: () => { st.ans.tools_confirmed = true; st.ans.crm_choice = 'connector'; st.ans.mailbox_choice = 'yes'; st.ans.calendar_choice = 'yes'; },
  crm_where: () => { st.ans.crm_choice = own.crm_choice || 'none'; }, crm_export: () => { st.ans.crm_export_skipped = true; },
  company: () => { st.cfg.own_company = 'Lanecraft'; }, team: () => { st.ans.works_alone = own.alone ?? true; st.ans.colleagues_asked = true; }, dnc: () => { st.ans.dnc_asked = true; },
  app: () => { st.ev.no_app = true; }, crm_name: () => { st.cfg.crm_user_name = 'Sam'; }, coworker_contacts: () => { st.cfg.coworker_contacts = 'leave'; }, customers: () => { st.cfg.customer_rule = {}; }, lost_deals: () => { st.ans.lost_deals_asked = true; }, optout_known: () => { st.cfg.optout_known = true; },
  known_contacts: () => { st.ans.known_asked = true; }, contact_details: () => { st.ans.contact_details = 'csv'; }, free_time: () => { st.slots = 8; }, home_tz: () => { st.cfg.home_tz = st.ev.time_zone || 'America/Chicago'; }, about_you: () => { st.ans.about_you_asked = true; st.cfg.home_tz = own.home_tz || st.ev.time_zone || 'America/Chicago'; },
  // Handing drafting to their own writer is asked, never taken from the scan: the persona picks their tools.
  drafting_mode: () => { st.cfg.drafting_mode = own.drafting_mode || 'delegate'; },
  drafter: () => { st.cfg.drafter = { name: 'acme-sdr', gaps: [] }; }, drafter_sample: () => { st.ans.drafter_sample_ok = true; }, seller_framing: () => { st.ans.seller_framing = 'no'; },
  offer: () => { st.ans.offer_asked = true; }, true_claims: () => { st.ans.claims_confirmed = true; }, samples: () => { st.ans.samples_ok = true; }, languages: () => { st.cfg.languages = ['German', 'English']; }, basics: () => { st.ans.basics_asked = true; },
  sending: () => { st.ans.sending_asked = true; st.ans.sending_channels = own.channels || []; }, send_setup: () => { st.ans.send_setup_done = true; }, followups_mode: () => { st.cfg.sending = { followups: 'scheduled' }; },
  message_route: () => { st.ans.message_route_asked = true; }, crm_log: () => { st.cfg.crm_log = 'tasks'; }, colleague_notes: () => { st.ans.colleague_notes_asked = true; st.cfg.colleague_notes = false; },
  about: () => { st.ans.about_asked = true; }, insights: () => { st.ans.insights_asked = true; },
});
const run = (st, own) => walk(st, (id) => { const f = ANSWER(st, own)[id]; if (!f) throw new Error(`unexpected question ${id}`); f(); });

test('tree: nothing set up — the list is asked for straight after the goal, and the first look comes within a handful of questions', () => {
  const s = { inv: summarize([]), cfg: {}, ev: { ...EV, time_zone: 'Europe/Berlin' }, ans: {}, slots: 0, list: null };
  const asked = run(s, { crm_choice: 'none' });
  const first = asked.filter((x) => x.startsWith('first:'));
  assert.ok(first.length <= 7, `first look after ${first.length} questions: ${first.join(' ')}`);
  assert.deepEqual(ids(first).slice(0, 3), ['goal', 'segments', 'list_source'], 'the goal, its groups, then the list');
  // Inferred or defaulted, never asked: each one is a question people give up on.
  for (const id of ['company_caps', 'must_meet', 'meetings_wanted', 'posture', 'drafting_mode', 'material', 'insights', 'app_notes', 'accounts', 'tools', 'crm_use', 'mailbox_use', 'calendar_use', 'inventory', 'profile']) assert.ok(!ids(asked).includes(id), `${id} was asked: ${asked.join(' ')}`);
  assert.equal(new Set(ids(asked)).size, asked.length, 'nothing is asked twice');
  assert.equal(s.cfg.company_caps.mode, 'scale');
  assert.ok(ids(asked).includes('about_you') && !ids(asked).includes('home_tz'), 'where they live is asked once with the sign-off, after the shortlist, not taken from the event');
  assert.ok(ids(asked).includes('languages'), 'a Berlin event asks which languages; an English-speaking one doesn\'t');
  assert.ok(ids(asked).indexOf('free_time') > ids(asked).indexOf('dnc'), 'free time comes after the first look');
});

test('tree: a job seeker gets no company, team, CRM or seller questions, and one person per company', () => {
  const s = { inv: summarize([]), cfg: {}, ev: { ...EV }, ans: {}, slots: 0, list: null };
  const asked = ids(run(s, { goal_type: 'job' }));
  for (const id of ['company', 'team', 'crm_where', 'known_contacts', 'seller_framing', 'customers']) assert.ok(!asked.includes(id), `${id} asked of a job seeker`);
  assert.equal(s.cfg.company_caps.mode, 'one');
  assert.equal(s.ans.posture, 'someone looking for their next role');
  assert.equal(s.cfg.optout_sentence, '', 'no opt-out line for someone who isn\'t selling');
  assert.ok(!asked.includes('offer'));
});

test('tree: a seller with tools confirms them once; CRM questions wait until the CRM is read; their own writer drafts', () => {
  const inv = summarize([
    { type: 'skill', name: 'acme-sdr', kinds: ['outbound', 'voice', 'company_context'] }, { type: 'mcp', name: 'hubspot', kinds: ['crm'] },
    { type: 'mcp', name: 'claude_ai_Gmail', kinds: ['email'] }, { type: 'mcp', name: 'gcal', kinds: ['calendar'] },
  ]);
  const s = { inv, cfg: {}, ev: { ...EV, app_name: 'Brella', no_app: false, time_zone: 'America/Chicago' }, ans: {}, slots: 0, list: null };
  const asked = run(s, { alone: false, channels: ['email'] });
  const phase = (p) => asked.filter((x) => x.startsWith(`${p}:`)).map((x) => x.split(':')[1]);
  assert.ok(phase('first').includes('tools') && !phase('first').some((x) => ['crm_use', 'mailbox_use', 'calendar_use'].includes(x)), 'one confirm for every connected tool');
  assert.deepEqual(phase('triage').filter((x) => ['crm_name', 'coworker_contacts', 'customers', 'lost_deals'].includes(x)), ['crm_name', 'coworker_contacts', 'customers', 'lost_deals'], 'asked with the CRM read, not before');
  assert.equal(phase('first').filter((x) => x === 'colleague_notes').length, 1, 'with a team, colleague notes are asked once, with the team');
  assert.ok(ids(asked).includes('drafting_mode'), 'who writes is asked, not taken from the scan');
  assert.equal(s.cfg.drafting_mode, 'delegate', 'their own writer, as they chose');
  assert.equal(s.ans.import_context, 'yes');
  assert.ok(phase('later').includes('drafter') && phase('later').includes('drafter_sample'));
  for (const id of ['samples', 'posture', 'import_context', 'app_request_limit']) assert.ok(!ids(asked).includes(id), `${id} asked`);
  assert.deepEqual(s.cfg.languages, ['English'], 'English, from a Chicago event and home');
});

test('tree: a home-made CRM gets its own export instructions; partial tooling means a mix', () => {
  const inv = summarize([{ type: 'agent', name: 'cold-email-writer', kinds: ['outbound'] }]);
  assert.equal(inv.outbound, 'partial');
  const s = { inv, cfg: { goal: 'x' }, ev: { ...EV }, ans: { setup_level: 'full', goal_type: 'selling', segments_confirmed: true, list_source: 'export', inventory_confirmed: true, crm_choice: 'home-made' }, slots: 0, list: null };
  const d = defaultsFor(s);
  assert.equal(d.config.drafting_mode, undefined, 'a mix is the user\'s choice, asked, never a default from the scan');
  const exp = planQuestions({ ...s, cfg: { ...s.cfg, context_profile: 'p' } }, { phase: 'first' }).questions.find((q) => q.id === 'crm_export');
  assert.match(exp.ask, /"target" and "messaged" to not-warm and "spoke" to warm/);
});

test('tree: setup levels — quick asks the fewest and reads nothing connected, standard reads the tools, full adds sending', () => {
  const inv = () => summarize([{ type: 'mcp', name: 'hubspot', kinds: ['crm'] }, { type: 'mcp', name: 'claude_ai_Gmail', kinds: ['email'] }, { type: 'mcp', name: 'gcal', kinds: ['calendar'] }]);
  const first = planQuestions({ inv: inv(), cfg: {}, ev: null, ans: {}, slots: 0, list: null }, { batch: 1 }).questions[0];
  assert.equal(first.id, 'setup_level', 'how much setup comes first');
  assert.match(first.options[0], /^quick: .*hubspot isn't checked/, 'quick says plainly the CRM is not checked');
  assert.match(first.options[1], /^standard \(recommended\)/);
  // A first-time user's what-you-bring has no "About me" and no insights yet: both are asked (quick setup goes without them).
  const walkAt = (level) => { const s = { inv: inv(), cfg: {}, ev: { ...EV, time_zone: 'America/Chicago' }, ans: {}, slots: 0, list: null, level, bring: {} }; return { asked: run(s, { alone: true, channels: ['email'] }), s }; };
  const q = walkAt('quick'), st = walkAt('standard'), f = walkAt('full');
  for (const id of ['tools', 'crm_name', 'customers', 'lost_deals', 'team', 'samples', 'basics', 'sending', 'home_tz']) assert.ok(!ids(q.asked).includes(id), `quick asked ${id}`);
  assert.equal(q.s.ans.crm_choice, 'none');
  assert.deepEqual(q.s.ans.sending_channels, []);
  assert.ok(ids(st.asked).includes('tools') && !ids(st.asked).includes('sending'), st.asked.join(' '));
  assert.ok(ids(f.asked).includes('sending'));
  assert.ok(q.asked.length < st.asked.length && st.asked.length < f.asked.length, `${q.asked.length} ${st.asked.length} ${f.asked.length}`);
  assert.ok(q.asked.length <= 8, `quick: ${q.asked.join(' ')}`);
  if (process.env.SHOW_LEVELS) console.log(JSON.stringify({ quick: q.asked, standard: st.asked, full: f.asked }));
  // The README's counts are this walk's (a seller working alone with a CRM, mailbox and calendar connected).
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const [name, walk] of [['Quick', q], ['Standard', st], ['Full', f]]) assert.match(readme, new RegExp(`\\| \\*\\*${name}\\*\\* \\| about ${walk.asked.length} \\|`), `${name}: ${walk.asked.length}`);
});
