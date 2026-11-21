// Replays a persona through the flow: `next` says the step, the driver answers from the persona's canned
// answers and judgements, runs the commands, feeds the stand-in for sends, and stops at `done` (or when the
// persona has no answer, which fails the test with the question). Everything the real run would ask Claude
// to judge comes from files, so a run is the same every time.
// Loaded first, so even a bare node --test can't reach the real home.
import '../../fixtures/isolated-home.mjs';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, cpSync, statSync } from 'node:fs';
import { readCsv } from '../../../lib/csv.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');

export function makeHome({ now = '2026-10-12T08:00:00Z', context = null, attendees = null } = {}) {
  const HOME = mkdtempSync(join(tmpdir(), 'fb-sim-'));
  mkdirSync(join(HOME, 'work'), { recursive: true });
  mkdirSync(join(HOME, 'inputs'), { recursive: true });
  if (context) cpSync(context.from, join(HOME, 'context', context.name), { recursive: true });
  if (attendees) writeFileSync(join(HOME, 'inputs', 'attendees.csv'), attendees);
  // The scan looks at this empty folder, never the user's own ~/.claude.
  mkdirSync(join(HOME, 'scan-home'), { recursive: true });
  return { HOME, now, env: { ...process.env, FLOORBOSS_TEST: '1', FLOORBOSS_HOME: HOME, FLOORBOSS_NOW: now, FLOORBOSS_SCAN_HOME: join(HOME, 'scan-home'), FLOORBOSS_SCAN_CWD: join(HOME, 'scan-home') } };
}

export function cli(H, skill, args) {
  try { return JSON.parse(execFileSync('node', [join(ROOT, 'skills', skill, 'scripts/cli.mjs'), ...args], { env: { ...H.env, FLOORBOSS_NOW: H.now }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch (e) { return { ERROR: String(e.stderr || e.message).slice(0, 400) }; }
}
const skillOf = (argv) => argv[1].split('/skills/')[1].split('/')[0];
export const file = (H, name, data) => { const f = join(H.HOME, 'work', name); writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data)); return f; };

// The tool's arguments from the recipe's template ({to}, {subject}, {body}, {thread_id}), as Claude fills them.
function argsFor(call) {
  const it = call.item;
  const tpl = call.recipe?.args || { to: '{to}', subject: '{subject}', body: '{body}', threadId: '{thread_id}' };
  // Placeholders anywhere in the template (task recipes nest them under properties and associations).
  const fill = (v) => { if (Array.isArray(v)) return v.map(fill); if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) { const y = fill(x); if (y !== undefined) o[k] = y; } return o; } const m = /^\{(\w+)\}$/.exec(String(v)); return m ? (it[m[1]] != null ? it[m[1]] : undefined) : v; };
  const out = fill(tpl);
  return out;
}

// A tool call failed. The step must say what to do then (on_error: a command that takes the error text); a
// step that doesn't is a gap, and the run stops there.
function toolFailed(H, s, action, out) {
  (H.toolErrors ||= []).push({ step: s.step, task: out.task, error: out.__tool_error });
  if (!action.on_error) throw new Error(`${s.step}: the ${out.task || 'tool'} call failed ("${String(out.__tool_error).slice(0, 120)}") and the step says nothing about what to do`);
  const argv = action.on_error.map((a) => (a === '{error}' ? String(out.__tool_error).slice(0, 300) : a));
  const r = cli(H, skillOf(argv), argv.slice(2));
  if (r.ERROR) throw new Error(`${s.step} on_error: ${r.ERROR}`);
}

// persona: { asks: {id: value | [values in order]}, judge: {fit(rows), draft(todo, ids), critic(batch), scan()}, call(item) → receipt }
export function drive(H, persona, { maxSteps = 120, onStep = null } = {}) {
  const trail = [];
  const used = {};
  const answerFor = (id) => { const v = persona.asks[id]; if (Array.isArray(v)) { const i = used[id] || 0; used[id] = i + 1; return v[Math.min(i, v.length - 1)]; } return v; };
  let slug = persona.slug || null;
  for (let i = 0; i < maxSteps; i++) {
    const s = cli(H, 'flow', ['next', ...(slug ? ['--event', slug] : [])]);
    if (s.ERROR) throw new Error(`next failed: ${s.ERROR}`);
    trail.push(s.step);
    if (onStep) onStep(s);
    // Done, or waiting for a later day (follow-ups not due, or only people who replied): the run ends here.
    if (s.done || s.step === 'waiting') return { trail, slug, last: s };
    if (s.run_first) { const r = cli(H, skillOf(s.run_first), s.run_first.slice(2)); if (r.ERROR) throw new Error(`${s.step} run_first: ${r.ERROR}`); }
    if (s.ask) {
      let v = s.ask.id === 'event' && persona.event ? persona.event : answerFor(s.ask.id);
      if (typeof v === 'function') v = v(s, H, slug);
      if (v === undefined && persona.fallback) v = persona.fallback(s);
      // An event already on this device: the run is for the first one offered, unless the persona says otherwise.
      if (v === undefined && s.ask.id === 'which_event') v = s.ask.options[0];
      if (v === undefined && s.ask.id === 'rate_notes') v = 'only the ones I rated';
      // The heads-up before company research (standard and full setup): go.
      if (v === undefined && s.ask.id === 'company_research') v = 'go';
      if (v === undefined && s.ask.id === 'agenda_news') v = 'go';
      if (v === undefined && s.ask.id === 'message_route') v = 'email, email (no other channels)';
      if (v === undefined && s.ask.id === 'touches') v = '3';
      if (v === undefined && s.ask.id === 'sending') v = "no, I'll send them myself";
      if (v === undefined && s.ask.id === 'followup_gap') v = 'the default: set by how far off the event is (recommended)';
      if (v === undefined) throw new Error(`The persona has no answer for "${s.ask.id}": ${s.ask.question}`);
      // A simulated run answers only what the flow asks: never out of turn (FLOORBOSS_OUT_OF_TURN is for unit tests).
      const r = cli({ ...H, env: Object.fromEntries(Object.entries(H.env).filter(([k]) => k !== 'FLOORBOSS_OUT_OF_TURN')) }, 'flow', ['answer', ...(slug ? ['--event', slug] : []), '--ask', s.ask.id, '--value-file', file(H, `a-${s.ask.id}.json`, v)]);
      if (r.ERROR) throw new Error(`answer ${s.ask.id}: ${r.ERROR}`);
      if (s.ask.id === 'event') slug = r.result?.slug || slug;
      continue;
    }
    if (s.run) { const r = cli(H, skillOf(s.run), s.run.slice(2)); if (r.ERROR) throw new Error(`${s.step}: ${r.ERROR}`); continue; }
    // Connecting a tool the persona chose: its own answer (a fallback in its words), saved the way the step says.
    if (s.step === 'connect' && persona.connect) {
      const v = persona.connect(s);
      if (v == null) throw new Error(`The persona can't connect ${s.task}`);
      const r = cli(H, 'flow', ['answer', ...(slug ? ['--event', slug] : []), '--ask', 'connect_fallback', '--value-file', file(H, 'a-connect.json', v)]);
      if (r.ERROR) throw new Error(`connect ${s.task}: ${r.ERROR}`);
      continue;
    }
    if (s.judge) {
      const read = s.judge.read && existsSync(s.judge.read) && !statSync(s.judge.read).isDirectory() ? (/\.csv$/.test(s.judge.read) ? readCsv(s.judge.read).records : JSON.parse(readFileSync(s.judge.read, 'utf8'))) : null;
      const out = s.step === 'scan' ? (persona.judge.scan?.() ?? { tools: [] })
        : s.step === 'fit' ? persona.judge.fit(read)
        : s.step === 'draft' ? persona.judge.draft(read, s.judge.ids, s.judge.batch_reasons || [])
        : s.step === 'prefilter' ? persona.judge.prefilter(read)
        : persona.judge[s.step] ? persona.judge[s.step](read, s)
        // The agenda, as Claude would write it: two points from the facts each meeting has, one question.
        : s.step === 'agenda' ? { meetings: (read.meetings || []).map((m) => ({ id: m.id, points: [{ text: `Where ${m.person.company} is taking ${m.person.title || 'this'} next year`, from: 'list' }, { text: `How this fits what you're there for: ${read.goal || 'the event'}`, from: 'goal' }], ask: `What would make this year's ${m.person.company} plan a success?`, avoid: null })) } : null;
      if (out == null) throw new Error(`The persona can't judge "${s.step}"`);
      if (out.__tool_error) { toolFailed(H, s, s.judge, out); continue; }
      writeFileSync(s.judge.write, JSON.stringify(out));
      const r = cli(H, skillOf(s.judge.then), s.judge.then.slice(2)); if (r.ERROR) throw new Error(`${s.step} then: ${r.ERROR}`);
      continue;
    }
    // Several agents in one step (research, company briefs): Claude runs them in parallel, then each "then".
    if (s.agents) {
      for (const ag of s.agents) {
        if (ag.input_file && /critic/.test(ag.name)) { const inp = JSON.parse(readFileSync(ag.input_file, 'utf8')); writeFileSync(ag.write, persona.judge.critic(inp)); const r = cli(H, skillOf(ag.then), ag.then.slice(2)); if (r.ERROR) throw new Error(`${s.step} then: ${r.ERROR}`); continue; }
        const reply = ag.input?.mode === 'briefing' ? (persona.judge.briefing ? persona.judge.briefing(ag.input) : { news: [], searched: [`${ag.input.company} news`] }) : ag.input?.mode === 'company' ? (persona.judge.company ? persona.judge.company(ag.input) : { sells: `${ag.input.company} (simulated)`, relation_to_us: 'prospect: simulated persona, no public tie', existing_vendors: 'none found', what_they_would_want: 'what the sender offers', do_not_tell_them: 'their own product', industry_news_none: 'simulated persona: no market to search', sources: [`https://${String(ag.input.company).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.example/about`] }) : persona.judge.research ? persona.judge.research(ag.input) : defaultResearch(ag.input);
        if (reply == null) throw new Error(`The persona can't play "${ag.name}"`);
        writeFileSync(ag.write, typeof reply === 'string' ? reply : JSON.stringify(reply));
        const r = cli(H, skillOf(ag.then), ag.then.slice(2)); if (r.ERROR) throw new Error(`${s.step} then: ${r.ERROR}`);
      }
      continue;
    }
    if (s.agent) {
      const input = s.agent.input_file ? JSON.parse(readFileSync(s.agent.input_file, 'utf8')) : s.agent.input;
      // A company brief: the persona's own, or a plain stand-in (a prospect wanting what the sender offers).
      const companyBrief = (x) => (persona.judge.company ? persona.judge.company(x) : { sells: `${x.company} (simulated)`, relation_to_us: 'prospect: simulated persona, no public tie', existing_vendors: 'none found', what_they_would_want: 'what the sender offers', do_not_tell_them: 'their own product', industry_news_none: 'simulated persona: no market to search', sources: [`https://${String(x.company).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.example/about`] });
      const reply = input?.mode === 'company' ? companyBrief(input) : persona.judge.critic && /critic/.test(s.agent.name) ? persona.judge.critic(input) : persona.judge.research ? persona.judge.research(input) : defaultResearch(input);
      if (reply == null) throw new Error(`The persona can't play "${s.agent.name}"`);
      writeFileSync(s.agent.write, typeof reply === 'string' ? reply : JSON.stringify(reply));
      const r = cli(H, skillOf(s.agent.then), s.agent.then.slice(2)); if (r.ERROR) throw new Error(`${s.step} then: ${r.ERROR}`);
      continue;
    }
    if (s.call) {
      // The guard first, as Claude Code would run it; then the stand-in, then the receipt.
      const callTool = persona.sendTool || s.call.recipe?.mcp_name || 'mcp__gmail__send_email';
      const callId = `toolu_sim_${s.call.item.id}_${s.call.item.touch}_${Math.random().toString(36).slice(2, 10)}`;
      const g = spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: callTool, tool_input: argsFor(s.call), tool_use_id: callId }), env: { ...H.env, FLOORBOSS_NOW: H.now }, encoding: 'utf8' });
      (persona.guardCalls ||= []).push({ step: s.step, item: s.call.item, status: g.status, stdout: g.stdout, stderr: g.stderr });
      if (g.status !== 0) throw new Error(`the guard refused ${s.call.item.id}:${s.call.item.touch}: ${g.stderr}`);
      // Sends and CRM tasks ask the user every time.
      if (!/"permissionDecision":"ask"/.test(g.stdout)) throw new Error(`a ${s.call.task === 'crm.create_task' ? 'CRM task' : 'send'} went without the prompt: ${s.call.item.id}:${s.call.item.touch}`);
      const receipt = persona.call ? persona.call(s.call.item, s.call) : { sends: [{ id: s.call.item.id, touch: s.call.item.touch, message_id: `m-${s.call.item.id}-${s.call.item.touch}`, thread_id: s.call.item.thread_id || `t-${s.call.item.id}` }] };
      if (receipt.__tool_error) { toolFailed(H, s, s.call, receipt); continue; }
      // The tool's own answer, as Claude Code hands it to the guard's post hook: the ids a follow-up threads by come
      // only from it (audit run 7, finding 1). The stand-in answers the ids its receipt names.
      const sent = (receipt.sends || []).find((x) => x.id === s.call.item.id && x.touch === s.call.item.touch);
      if (sent && s.call.task !== 'crm.create_task')
        spawnSync('node', [join(ROOT, 'hooks/guard.mjs'), 'post'], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: callTool, tool_input: argsFor(s.call), tool_use_id: callId, tool_response: { content: [{ type: 'text', text: JSON.stringify({ id: sent.message_id, ...(sent.thread_id ? { threadId: sent.thread_id } : {}) }) }] } }), env: { ...H.env, FLOORBOSS_NOW: H.now }, encoding: 'utf8' });
      writeFileSync(join(H.HOME, 'events', slug, 'work', 'receipt.json'), JSON.stringify(receipt));
      const r = cli(H, skillOf(s.call.then), s.call.then.slice(2)); if (r.ERROR) throw new Error(`${s.step} then: ${r.ERROR}`);
      continue;
    }
    throw new Error(`unhandled step ${JSON.stringify(s).slice(0, 200)}`);
  }
  throw new Error(`the flow didn't finish in ${maxSteps} steps: ${trail.slice(-8).join(' → ')}`);
}

// Rates every draft in the blind set 7, with a word, so the rating path runs.
export function rateAll(s, H, slug) {
  const key = JSON.parse(readFileSync(join(H.HOME, 'events', slug, 'derived', 'rate-key.json'), 'utf8'));
  return key.map((k) => `${k.n}: 7 fine`).join('\n');
}

// One canned draft, written to the structure the job was given. Openings are picked from word banks by a
// hash of the person, touch and attempt, so a batch varies the way real drafts would, and a redraft after a
// failed batch check really is different.
const BANK = {
  'question-first': [
    ['How do you', 'Where does your team', 'What happens when you', 'Who on your side has to', 'When did you last', 'How often do you', 'Why would a team like yours', 'What would it take to'],
    ['clear a backlog of disputed payments', 'spot a mule account before the second transfer', 'explain a false positive to an angry customer', 'tune alert rules without a data team', 'prove a control works to an examiner', 'handle a spike in card-not-present fraud', 'decide which alerts nobody reads', 'keep case notes consistent across shifts'],
  ],
  // Insight-first and peer notes lead with an insight from the profile (the only thing they may claim).
  'insight-first': [['Something you may not have seen:', 'Worth knowing before the event:', 'In case it is useful:', 'A pattern worth a look:', 'One thing that stood out:', 'A quick data point:'], null],
  // The plain form opens with the reader's side, never the sender ("I sell…" fails floorboss's checks).
  'plain-request': [
    ['Your work in', 'Teams like yours in', 'People who run', 'Leaders in', 'Whoever owns', 'Your side of'],
    ['fraud operations', 'financial-crimes teams', 'case management', 'alert triage', 'payments risk', 'investigations'],
  ],
  'peer-note': [['Comparing notes:', 'From one ops person to another:', 'You may see this too:', 'A note from my side:', 'Curious if this matches yours:', 'Quick one between peers:'], null],
};
const pickN = (key, n) => parseInt(createHash('sha256').update(key).digest('hex').slice(0, 8), 16) % n;
const CLOSING_LINES = [
  (days) => `One last question: cross paths ${days}?`,
  (days) => `Final check for ${days}: up for a chat?`,
  (days) => `Would a quick chat ${days} work? Last note.`,
  (days) => `Last call before the show: meet ${days}?`,
  (days) => `Can we compare notes ${days}? Final ask.`,
  (days) => `Last note on this: any interest ${days}?`,
  (days) => `Worth a brief conversation ${days}? Final note.`,
  (days) => `Final invitation for ${days}: want to talk?`,
  (days) => `Would you meet ${days}? My last message.`,
  (days) => `Interested in talking ${days}? Last check from me.`,
  (days) => `Final nudge for the show: say hello ${days}?`,
  (days) => `Any appetite to meet ${days}? Last question.`
];
const CLOSING_SUBJECTS = ['A quick chat', 'At the show', 'Comparing notes', 'A closing note', 'Meeting at the show', 'One more thought'];

// A person researched by a persona that brought no research: one sourced claim about their company.
const defaultResearch = (x) => (x?.id ? { identity_confirmed: true, role_seen: x.title, person_claims: 0, complete: true, claims: [{ text: `${x.company} runs its own counters and a regional team.`, url: `https://${String(x.company).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.example/about` }] } : null);
export function draftFor(todo, j, attempt = 0) {
  const first = j.contact.name.split(' ')[0];
  const sign = `\n\nBest, Sam\n\n${todo.optout_sentence || "If this isn't relevant, say so and I won't follow up."}`;
  if (j.kind === 'coordinate') return { id: j.id, touch: j.touch, body: `${j.holder}, ${j.contact.name} is at the event. Want to reach out?`, brief: 'x, no research profile' };
  if (j.kind === 'confirmation') return { id: j.id, touch: j.touch, subject: 'See you there', body: `Hi ${first}, confirming ${j.slot_labels.join('')}. See you at our stand.\n\nBest, Sam`, brief: 'x, no research profile' };
  const structure = j.structure || 'plain-request';
  const fs = j.fact_sources || ['list'];
  // A researched person is written to from the research (the check requires it).
  const fact = fs.includes('research') ? 'research' : fs[0];
  // Times the way a person types them ("Tue 10th at 10:00"), not the label.
  const times = j.slot_labels.map((l) => { const m = /^(\w{3}) (\d{1,2}) \w{3}, (\d{2}:\d{2})/.exec(l); return m ? `${m[1]} ${m[2]}th at ${m[3]}` : l; }).join(' or ');
  const ev = todo.event_name || todo.event?.name || 'the event';
  const key = `${j.id}:${j.touch}:${attempt}`;
  const [stems, ends] = BANK[structure];
  const insightId = (j.insight_options || [])[pickN(`i${key}`, Math.max(1, (j.insight_options || []).length))] || null;
  const insightText = (Array.isArray(todo.insights) ? todo.insights : []).find((x) => x.id === insightId)?.insight || 'the slow step is rarely the one people measure';
  const a = stems[pickN(`a${key}`, stems.length)], b = ends ? ends[pickN(`b${key}`, ends.length)] : insightText.replace(/\.$/, '').replace(/^./, (ch) => ch.toLowerCase());
  const open = {
    'question-first': `${a} ${b}?`,
    'insight-first': `${a} ${b}.`,
    'plain-request': `${a} ${b} is what my software is for.`,
    'peer-note': `${a} ${b}.`,
  }[structure];
  const ask = times ? `Would 20 minutes at ${ev} work, ${times}?` : `Could we find 20 minutes at ${ev}?`;
  // A capped note (a LinkedIn invitation): the drafter keeps to it, as the skill says.
  let body = `Hi ${first},\n\n${open} ${ask}${sign}`;
  let subject = j.touch > 1 ? 'One more thought' : 'At the summit';
  // A follow-up is shorter than the message before it; the last one is a closing note: it says it's the last, names
  // the days at the show and asks only yes or no.
  if (j.followup && j.last_touch) {
    const d = /^(\w{3})\b.* to (\w{3})\b/.exec(todo.event?.dates || '');
    const days = d ? `${d[1]} to ${d[2]}` : todo.event?.dates || 'all week';
    body = CLOSING_LINES[pickN(`closing:${key}`, CLOSING_LINES.length)](days) + sign;
    subject = CLOSING_SUBJECTS[pickN(`closing-subject:${key}`, CLOSING_SUBJECTS.length)];
  }
  else if (j.followup) {
    // Short openings, so it is always shorter than the first message (which also says "Would 20 minutes at … work").
    const few = (n) => b.split(' ').slice(0, n).join(' ');
    const short = structure === 'question-first' ? `${a} ${few(2)}?` : structure === 'plain-request' ? `${a} ${b}.` : `${a} ${few(3)}.`;
    // Times the way a person types them ("Tue 10th at 10:00"), not the label.
    const typed = j.slot_labels.map((l) => { const m = /^(\w{3}) (\d{1,2}) \w{3}, (\d{2}:\d{2})/.exec(l); return m ? `${m[1]} ${m[2]}th at ${m[3]}` : l; }).join(' or ');
    body = `Hi ${first},\n\n${short} ${typed ? `${typed}?` : `Meet at ${ev}?`}${sign}`;
  }
  if (j.char_limit && body.length > j.char_limit) body = `Hi ${first},\n\n${ask}${sign}`.slice(0, j.char_limit);
  return { id: j.id, touch: j.touch, subject, body, brief: 'x, no research profile', insight: ['insight-first', 'peer-note'].includes(structure) ? insightId : null, structure, fact_source: structure === 'plain-request' && fact === 'none' ? 'none' : fact };
}

// A plain persona that says yes to everything and writes one template per message.
export function simplePersona(over = {}) {
  const tries = {};
  const { asks: _a, judge: _j, ...rest } = over;
  return {
    event: { name: 'Test Expo', city: 'Rotterdam', start: '2026-11-10', end: '2026-11-12', zone: 'Europe/Amsterdam' },
    asks: { disclaimer: 'ok', setup_level: 'full', colleague_notes: 'no, just leave them to my coworker', stuck_drafts: 'leave them for now', inventory: 'yes', goal_type: 'selling', goal: 'ops leaders at 3PLs', meetings_wanted: 'about 10', company_caps: 'by company size: 1 at a small firm, 2 at a mid-size one, up to 5 at a very large one (recommended)', must_meet: 'none', home_tz: 'Europe/Amsterdam', about_you: { sign_off: 'Best, Sam', sender_name: 'Sam Rivera, Lanecraft', city: 'Amsterdam' }, app: 'none', company: { own_company: 'Lanecraft', own_domains: ['lanecraft.example'] }, team: 'just me', accounts: 'none', dnc: 'none', crm_where: 'a spreadsheet', crm_use: 'I\'ll give you an export instead', tools: { crm: 'export', mailbox: false, calendar: false }, crm_export: 'skip', crm_name: 'Sam Rivera', customers: 'recommended', lost_deals: '12 months', optout_known: 'yes, on every email', known_contacts: 'skip', mailbox_use: 'no', calendar_use: 'no', free_time: { free: 'Tue 10 Nov 10-12, Wed 11 Nov 14-16', zone: 'Europe/Amsterdam' }, list_source: 'an export from the organiser', drafting_mode: 'floorboss writes everything', import_context: 'no', posture: 'a seller with a clear offer', seller_framing: 'no', profile: { name: 'buyers' }, segments: 'ok', material: 'ok', insights: 'none', about: 'the founder, I run sales myself', offer: 'ok', true_claims: 'ok', samples: 'ok', drafter_sample: 'ok', voice_samples: 'skip', rate: rateAll, languages: 'English only', app_notes: 'ok', basics: 'ok', sending: 'none', coworker_contacts: 'leave them alone (recommended)', crm_log: 'make a CRM task for each', crm_create_contacts: 'no, just list them for me', crm_fill_blanks: 'no, don\'t change existing contacts', crm_log_window: 'yes, log them now', crm_create_ok: (st) => ({ answer: 'no', ids: st.ask.ids }), map_columns_attendees: 'ok', map_columns_crm: 'ok', gate: 'ok', research_scale: 'none', approve: 'approve all', replies_since: 'none', ...(over.asks || {}) },
    judge: {
      scan: () => ({ tools: [] }),
      // Hand-send's sign-off step: the first name the agent knows (here, the account's).
      'onboarding:about_you': () => ({ first_name: 'Sam', from: 'account' }),
      fit: (rows) => rows.map((r) => ({ id: r.id, segment: 'ops-leaders', reason: `${r.title} at ${r.company}`, score: 80 })),
      draft: (todo, ids) => todo.jobs.filter((j) => ids.includes(`${j.id}:${j.touch}`)).map((j) => { const k = `${j.id}:${j.touch}`; tries[k] = (tries[k] ?? -1) + 1; return draftFor(todo, j, tries[k]); }),
      critic: (batch) => (batch.drafts || batch).map((d) => `${d.id}:${d.touch} PASS`).join('\n'),
      ...(over.judge || {}),
    },
    ...rest,
  };
}
