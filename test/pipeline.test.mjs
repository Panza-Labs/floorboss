// Drives the mock event through every CLI step with canned model answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLedger, fold } from '../lib/ledger.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const HOME = mkdtempSync(join(tmpdir(), 'fb-pipe-'));
const NOW = '2026-10-09T08:00:00Z';
const SLUG = 'mock-harbour-haul';

function cli(skill, args, { now = NOW, expectFail = false } = {}) {
  const file = skill === 'mock' ? join(ROOT, 'examples/mock-event/load.mjs') : join(ROOT, 'skills', skill, 'scripts/cli.mjs');
  try {
    const out = execFileSync('node', [file, ...args], { env: { ...process.env, FLOORBOSS_HOME: HOME, FLOORBOSS_NOW: now }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (expectFail) assert.fail(`expected failure: ${args.join(' ')}`);
    return JSON.parse(out);
  } catch (err) {
    if (expectFail && err.status) return { error: String(err.stderr) };
    throw new Error(`${skill} ${args.join(' ')} failed: ${err.stderr || err.message}`);
  }
}

const FIT_RULES = [
  [/procurement|category manager/i, 'procurement'],
  [/carrier relations|carrier partnerships/i, 'carrier-relations'],
  [/^(vp|head|director|coo|chief).*(operations|logistics|fulfilment)|operations director|director of operations|coo|head of freight operations|operations lead/i, 'ops-leaders'],
];

function fitsFor(needs) {
  return needs.map((r) => {
    const freightish = /freight|logist|shipping|haul|transport|cargo|courier|carrier|cold chain|port authority|lines|brokers|foods|distribution|grocer|pharma|paper|home goods|retail/i.test(r.company);
    const seg = freightish ? FIT_RULES.find(([re]) => re.test(r.title))?.[1] : null;
    return { id: r.id, segment: seg || null, reason: seg ? `${r.title} at ${r.company}` : 'not a buyer for carrier onboarding', score: seg ? 70 + (r.title.match(/VP|Head|COO|Director/) ? 10 : 0) : 0 };
  });
}

function draftFor(job, ev) {
  const first = job.contact.name.split(' ')[0];
  if (job.kind === 'coordinate') return { body: `${job.holder}, ${job.contact.name} (${job.contact.title}, ${job.contact.company}) is at ${ev.name}. You hold this relationship; want to reach out, or should I?` };
  const times = job.slot_labels.length ? `Could you do ${job.slot_labels.join(' or ')}?` : 'Could we find 30 minutes at the expo?';
  return { subject: `${ev.name}: carrier onboarding`, body: `Hi ${first}, saw you're at ${ev.name}. ${job.reason}. ${times}\n\nBest, Sam\n\n${ev.optout}`, brief: `${job.segment?.name || job.group} → ${job.mode}` };
}

test('mock event end to end: setup → triage → draft → outbox → status → follow-up', () => {
  const loaded = cli('mock', ['--goal', 'buyers', '--now', NOW]);
  assert.equal(loaded.slug, SLUG);

  // Triage: load, fit, gate.
  const load = cli('crm-triage', ['load', '--event', SLUG]);
  assert.equal(load.attendees.people, 54);
  const attView = readFileSync(cli('crm-triage', ['propose-mapping', '--event', SLUG, '--kind', 'attendees']).view, 'utf8');
  assert.match(attView, /^Sessions \| not read/m); assert.match(attView, /^Interests \| not read/m);
  assert.match(readFileSync(cli('crm-triage', ['propose-mapping', '--event', SLUG, '--kind', 'crm']).view, 'utf8'), /^Amount \| not read/m);
  assert.equal(load.colleague[0].holder, 'Jordan Lee');
  const fitsPath = join(HOME, 'fits.json');
  writeFileSync(fitsPath, JSON.stringify(fitsFor(load.needs_fit)));
  const fit = cli('crm-triage', ['fit', '--event', SLUG, '--fits-file', fitsPath]);
  assert.ok(fit.shortlist_size >= 20, `shortlist ${fit.shortlist_size}`);
  // By default people per company follow its size: a company of unknown size allows two.
  assert.ok(!fit.over_cap || fit.over_cap.companies.every((o) => o.allowed === 2 && o.size === 'size unknown'), JSON.stringify(fit.over_cap));
  assert.ok(existsSync(fit.full_list));
  const gate = cli('crm-triage', ['gate', '--event', SLUG, '--answers', 'remove c020; confirm c018']);
  assert.ok(gate.with_two_times > 0);

  // Draft: todo, save drafts, critic verdicts, review render, gate.
  const todo = cli('event-outreach', ['todo', '--event', SLUG]);
  assert.equal(todo.mode, 'early');
  const jobs = JSON.parse(readFileSync(todo.todo_file, 'utf8')).jobs;
  assert.ok(jobs.length >= 20);
  const ev = { name: 'Harbour & Haul Expo', optout: todo.optout_sentence };
  const victor = jobs.find((j) => j.contact.name === 'Victor Hale');
  assert.match(victor.notes_untrusted, /^UNTRUSTED/);
  for (const j of jobs) {
    const d = draftFor(j, ev);
    const saved = cli('event-outreach', ['save-draft', '--event', SLUG, '--id', j.id, '--touch', String(j.touch), '--json', JSON.stringify(d)]);
    if (j.kind === 'message') {
      assert.equal(saved.checks, 'pass', `${j.id}: ${JSON.stringify(saved.checks)}`);
      const input = cli('event-outreach', ['critic-input', '--event', SLUG, '--id', j.id, '--touch', String(j.touch)]);
      assert.ok(!JSON.stringify(input).includes('IGNORE ALL PREVIOUS'), 'notes never reach the critic');
      assert.ok(!JSON.stringify(input).includes('120000') && !JSON.stringify(input).includes('75000'), 'no deal amounts');
      const verdict = j.id === victor.id ? 'FAIL: claims a price that is in no allowed source' : 'PASS';
      cli('event-outreach', ['verdict', '--event', SLUG, '--id', j.id, '--touch', String(j.touch), '--text', verdict]);
    }
  }
  const review = cli('event-outreach', ['render', '--event', SLUG, '--review']);
  assert.ok(readFileSync(review.outbox, 'utf8').includes('pending your approval'));
  const g = cli('event-outreach', ['gate', '--event', SLUG, '--answers', `approve all except ${victor.id}`]);
  assert.equal(g.approved, jobs.length - 1);
  const html = readFileSync(g.outbox, 'utf8');
  assert.ok(!html.includes('pending your approval'));
  assert.ok(!html.includes('Victor Hale'), 'unapproved draft not in the outbox');
  // Colleague notes are off by default: the colleague-held contact is left alone, with no note drafted.
  assert.ok(!html.includes('Coordinate notes'));

  // Re-run without changes: nothing duplicated.
  const again = cli('event-outreach', ['todo', '--event', SLUG]);
  assert.equal(again.messages, 1, 'only the held-back Victor draft remains');

  // Status paste: two sent, one booked, one stop, one replied.
  const short = JSON.parse(readFileSync(join(HOME, 'events', SLUG, 'derived', 'compat', 'shortlist.json'), 'utf8'));
  const [a, b, c2, d2] = short.approved.filter((id) => id !== victor.id);
  const bookedSlot = short.assignments[a][0];
  const status = `floorboss-status v1 event=${SLUG} at=2026-10-10T10:00:00Z\n${a} sent=2026-10-09 booked=${bookedSlot}\n${b} sent=2026-10-09\n${c2} sent=2026-10-09 replied\n${d2} stop`;
  const st = cli('event-outreach', ['status', '--event', SLUG, '--text', status], { now: '2026-10-10T10:00:00Z' });
  assert.deepEqual(st.booked_slots, [bookedSlot]);
  assert.ok(st.need_new_times.length >= 1, 'others holding the booked slot get new times');
  cli('event-outreach', ['status', '--event', SLUG, '--text', status], { now: '2026-10-10T11:00:00Z', expectFail: true });

  // A week later: b is due a follow-up (early mode, 7 days); a booked, c replied, d stopped get nothing.
  const later = '2026-10-16T09:00:00Z';
  const fu = cli('event-outreach', ['todo', '--event', SLUG], { now: later });
  const fjobs = JSON.parse(readFileSync(fu.todo_file, 'utf8')).jobs;
  const bJob = fjobs.find((j) => j.id === b);
  assert.ok(bJob && bJob.touch === 2 && bJob.followup, 'b gets touch 2');
  assert.ok(!fjobs.some((j) => [c2, d2].includes(j.id)), 'replied and stopped get nothing');
  const conf = fjobs.filter((j) => j.id === a);
  assert.deepEqual(conf.map((j) => [j.kind, j.touch]), [['confirmation', 0]], 'booked gets only a confirmation');
  assert.equal(conf[0].booked_slot, bookedSlot);
  assert.ok(!bJob.slot_ids.includes(bookedSlot), 'the booked slot is never offered again');
  // Older cards keep their times after later runs (needed for the stale-time warning).
  const f2 = JSON.parse(readFileSync(join(HOME, 'events', SLUG, 'work', 'drafts', `${b}-t1.json`), 'utf8'));
  assert.ok(f2.earliest && f2.slot_ids.length, 'draft file stores its times');
  // The stop is in this (mock) event's ledger; there is no global suppression file to write to.
  const L = fold(readLedger(join(HOME, 'events', SLUG, 'ledger.jsonl')).entries);
  assert.equal(L.people[d2].stopped, true, 'stop recorded in the mock event\'s ledger');
  assert.ok(!existsSync(join(HOME, 'suppression.json')), 'mock never writes a suppression list');

  // After the event, drafting stops.
  const over = cli('event-outreach', ['todo', '--event', SLUG], { now: '2026-11-03T12:00:00Z' });
  assert.equal(over.stop, true);
});

test('account cap: a flat cap 2 lists the big company, override saved for this event', async () => {
  cli('mock', ['--goal', 'buyers', '--now', NOW]);
  const load = cli('crm-triage', ['load', '--event', SLUG]);
  const fitsPath = join(HOME, 'fits2.json');
  writeFileSync(fitsPath, JSON.stringify(fitsFor(load.needs_fit)));
  const ev = JSON.parse(readFileSync(join(HOME, 'events', SLUG, 'event.json'), 'utf8'));
  ev.settings.account_cap = 2;
  writeFileSync(join(HOME, 'events', SLUG, 'event.json'), JSON.stringify(ev));
  const fit = cli('crm-triage', ['fit', '--event', SLUG, '--fits-file', fitsPath]);
  const oceanic = fit.over_cap.companies.find((o) => /Oceanic Lines/.test(o.company));
  assert.ok(oceanic && oceanic.fit > 2 && oceanic.allowed === 2, JSON.stringify(fit.over_cap));
  const gate = cli('crm-triage', ['gate', '--event', SLUG, '--answers', `cap ${oceanic.slug} 50`]);
  assert.ok(!(gate.over_cap?.companies || []).some((o) => o.slug === oceanic.slug), JSON.stringify(gate.over_cap));
  // Saved in this event's ledger only: a cap set at one gate doesn't follow the user to the next event.
  const { readLedger, fold } = await import('../lib/ledger.mjs');
  assert.equal(fold(readLedger(join(HOME, 'events', SLUG, 'ledger.jsonl')).entries).caps[oceanic.slug], 50);
  const cfgPath = join(HOME, 'config.json');
  assert.ok(!existsSync(cfgPath) || !JSON.parse(readFileSync(cfgPath, 'utf8')).account_caps?.[oceanic.slug]);
});

test('review regressions: confirm keeps CRM facts, rescue refuses holds, FAIL never passes approve-all, verdicts stay in batch, drop sticks', () => {
  cli('mock', ['--goal', 'buyers', '--now', NOW]);
  const load = cli('crm-triage', ['load', '--event', SLUG]);
  const fitsPath = join(HOME, 'fits3.json');
  writeFileSync(fitsPath, JSON.stringify(fitsFor(load.needs_fit)));
  cli('crm-triage', ['fit', '--event', SLUG, '--fits-file', fitsPath]);
  const di = 'c031'; // RFP quiet period → hold
  const r = cli('crm-triage', ['gate', '--event', SLUG, '--answers', `rescue ${di}`], { expectFail: true });
  assert.match(r.error, /is held because account .* is off-limits .*decide --id c031 --group reach --because/);
  const ed = load.check_these[0].id;
  assert.match(load.check_these[0].says, /same address .*, but the CRM has them at/);
  cli('crm-triage', ['gate', '--event', SLUG, '--answers', `confirm ${ed}`]);
  const triage = JSON.parse(readFileSync(join(HOME, 'events', SLUG, 'derived', 'compat', 'triage.json'), 'utf8'));
  assert.equal(triage.pre[ed].group, 'warm', 'confirmed match is regrouped with its CRM record (Opportunity → warm)');
  assert.equal(triage.pre[ed].crm.status, 'Opportunity');

  const todo = cli('event-outreach', ['todo', '--event', SLUG]);
  const jobs = JSON.parse(readFileSync(todo.todo_file, 'utf8')).jobs.filter((j) => j.kind === 'message');
  const ev = { name: 'Harbour & Haul Expo', optout: todo.optout_sentence };
  const [a, b, c3] = jobs;
  for (const j of [a, b, c3]) cli('event-outreach', ['save-draft', '--event', SLUG, '--id', j.id, '--json', JSON.stringify(draftFor(j, ev))]);
  // A script-check fix doesn't use up the critic rewrite.
  cli('event-outreach', ['save-draft', '--event', SLUG, '--id', a.id, '--json', JSON.stringify(draftFor(a, ev))]);
  const ids = [a, b].map((j) => `${j.id}:1`).join(',');
  const replyPath = join(HOME, 'reply.txt');
  writeFileSync(replyPath, `${a.id} FAIL: invented a number\n${a.id} PASS\n${b.id} PASS\n${c3.id} PASS`);
  const v = cli('event-outreach', ['verdicts', '--event', SLUG, '--ids', ids, '--text-file', replyPath]);
  assert.equal(v.verdicts.find((x) => x.id === a.id).verdict, 'FAIL', 'FAIL wins');
  assert.equal(v.verdicts.find((x) => x.id === a.id).next.startsWith('rewrite'), true, 'first FAIL offers a rewrite');
  assert.deepEqual(v.ignored_not_in_batch, [`${c3.id}:1`]);
  cli('event-outreach', ['save-draft', '--event', SLUG, '--id', a.id, '--json', JSON.stringify(draftFor(a, ev))]);
  writeFileSync(replyPath, `${a.id} FAIL: still invented`);
  const v2 = cli('event-outreach', ['verdicts', '--event', SLUG, '--ids', `${a.id}:1`, '--text-file', replyPath]);
  assert.match(v2.verdicts[0].next, /marked failed/);
  writeFileSync(replyPath, 'ERROR: no drafts provided');
  assert.match(cli('event-outreach', ['verdicts', '--event', SLUG, '--ids', `${a.id}:1`, '--text-file', replyPath], { expectFail: true }).error, /given no drafts/);
  const g = cli('event-outreach', ['gate', '--event', SLUG, '--answers', `approve all except ${c3.id}; drop ${c3.id}`]);
  assert.ok(g.not_ready.some((x) => x.id === a.id && /failed the critic/.test(x.reason)), 'FAIL not approved by approve all');
  assert.ok(!readFileSync(g.outbox, 'utf8').includes(`data-id="${a.id}"`));
  const again = JSON.parse(readFileSync(cli('event-outreach', ['todo', '--event', SLUG]).todo_file, 'utf8')).jobs;
  assert.ok(!again.some((j) => j.id === c3.id), 'dropped contact is not drafted again');
  const named = cli('event-outreach', ['gate', '--event', SLUG, '--answers', `approve ${a.id}`]);
  assert.equal(named.approved, 1, 'naming a failed draft approves it');
});

test('insights: todo lists the ones that fit, saves check the ID, batch-check enforces the cap and colleagues', () => {
  cli('mock', ['--goal', 'buyers', '--now', NOW]);
  const load = cli('crm-triage', ['load', '--event', SLUG]);
  const fp = join(HOME, 'fits5.json');
  writeFileSync(fp, JSON.stringify(fitsFor(load.needs_fit)));
  cli('crm-triage', ['fit', '--event', SLUG, '--fits-file', fp]);
  cli('crm-triage', ['gate', '--event', SLUG, '--answers', 'defaults']);
  const todo = cli('event-outreach', ['todo', '--event', SLUG]);
  assert.equal(todo.insights, 12);
  assert.ok(Array.isArray(todo.insight_notes));
  const file = JSON.parse(readFileSync(todo.todo_file, 'utf8'));
  const msgs = file.jobs.filter((j) => j.kind === 'message');
  const cap = file.insight_cap_by_touch[1];
  assert.equal(cap, Math.max(1, Math.round(msgs.length / 4)));
  const ops = msgs.filter((j) => j.segment?.slug === 'ops-leaders');
  assert.ok(ops.length > cap, 'enough ops leaders to go over the cap');
  assert.ok(ops[0].insight_options.includes('I1') && !ops[0].insight_options.includes('I4'), 'options follow segment tags');
  const ev = { name: 'Harbour & Haul Expo', optout: todo.optout_sentence };

  // A draft naming an unknown insight, or one not tagged for the segment, fails its checks.
  const vp = join(HOME, 'insight5.json');
  const checksOf = (insight) => { writeFileSync(vp, JSON.stringify([{ id: ops[0].id, touch: 1, ...draftFor(ops[0], ev), insight }])); return cli('event-outreach', ['save-drafts', '--event', SLUG, '--drafts-file', vp])[0]; };
  const unknown = checksOf('I99');
  assert.match([].concat(unknown.checks).join(' '), /I99 isn't in the "what you know" table/, JSON.stringify(unknown));
  assert.match([].concat(checksOf('i4').checks).join(' '), /I4 isn't tagged for this contact's segment/);

  // Every message on I1: over the cap. Then spread them out and the insight reasons go away.
  const dp = join(HOME, 'drafts5.json');
  writeFileSync(dp, JSON.stringify(msgs.map((j) => ({ id: j.id, touch: 1, ...draftFor(j, ev), insight: j.insight_options.includes('I1') ? 'I1' : null }))));
  cli('event-outreach', ['save-drafts', '--event', SLUG, '--drafts-file', dp]);
  const bad = cli('event-outreach', ['batch-check', '--event', SLUG]);
  assert.equal(bad.verdict, 'FAIL');
  assert.ok(bad.reasons.some((r) => new RegExp(`^I1 is in \\d+ drafts .* the limit is ${cap}`).test(r)), bad.reasons.join(' | '));
  assert.ok(msgs.some((j) => j.colleagues.length), 'the mock has colleagues');
  const used = {};
  const given = {};
  const spread = msgs.map((j) => {
    const pick = j.insight_options.find((x) => (used[x] || 0) < cap && !j.colleagues.some((o) => given[o] === x)) || null;
    if (pick) { used[pick] = (used[pick] || 0) + 1; given[j.id] = pick; }
    return { id: j.id, touch: 1, ...draftFor(j, ev), insight: pick };
  });
  writeFileSync(dp, JSON.stringify(spread));
  cli('event-outreach', ['save-drafts', '--event', SLUG, '--drafts-file', dp]);
  const good = cli('event-outreach', ['batch-check', '--event', SLUG]);
  assert.ok(!good.reasons.some((r) => /insight|I\d/.test(r)), good.reasons.join(' | '));
  assert.ok(Object.values(good.insight_use).every((n) => n <= cap));

  // The critic sees the insight a draft declares.
  const ci = cli('event-outreach', ['critic-batch', '--event', SLUG, '--ids', `${ops[0].id}:1`])[0].input;
  assert.match(ci.declared_insight, /insurance certificates/);
  const check = cli('event-context', ['check', '--event', SLUG]);
  assert.ok(!check.notes.some((n) => /aim for 10–15/.test(n)), 'the mock has enough insights');
});

test('insights over time: table edits keep a draft on its insight, follow-ups and later colleagues are checked', () => {
  const bringPath = (todo) => JSON.parse(readFileSync(todo.todo_file, 'utf8'));
  cli('mock', ['--goal', 'buyers', '--now', NOW]);
  const load = cli('crm-triage', ['load', '--event', SLUG]);
  const fp = join(HOME, 'fits6.json');
  writeFileSync(fp, JSON.stringify(fitsFor(load.needs_fit)));
  cli('crm-triage', ['fit', '--event', SLUG, '--fits-file', fp]);
  cli('crm-triage', ['gate', '--event', SLUG, '--answers', 'defaults']);
  const todo = cli('event-outreach', ['todo', '--event', SLUG]);
  const msgs = bringPath(todo).jobs.filter((j) => j.kind === 'message');
  const ev = { name: 'Harbour & Haul Expo', optout: todo.optout_sentence };
  const pair = msgs.find((j) => j.colleagues.length);
  const ops = msgs.find((j) => j.segment?.slug === 'ops-leaders' && j !== pair && !pair.colleagues.includes(j.id));
  const draftsPath = join(HOME, 'drafts6.json');
  const save = (list) => { writeFileSync(draftsPath, JSON.stringify(list)); return cli('event-outreach', ['save-drafts', '--event', SLUG, '--drafts-file', draftsPath]); };
  const opt = (j) => j.insight_options[0];
  const pass = (id, now = NOW) => { const rp = join(HOME, 'pass6.txt'); writeFileSync(rp, `${id} PASS`); cli('event-outreach', ['verdicts', '--event', SLUG, '--ids', `${id}:1`, '--text-file', rp], { now }); };
  save([{ id: ops.id, touch: 1, ...draftFor(ops, ev), insight: 'I1' }, { id: pair.id, touch: 1, ...draftFor(pair, ev), insight: opt(pair) }]);
  const file = (id, t = 1) => JSON.parse(readFileSync(join(HOME, 'events', SLUG, 'work', 'drafts', `${id}-t${t}.json`), 'utf8'));
  assert.match(file(ops.id).insight_text, /insurance certificates/);

  // A rewrite that leaves out "insight" keeps it; --insight none clears it.
  save([{ id: ops.id, touch: 1, ...draftFor(ops, ev) }]);
  assert.equal(file(ops.id).insight, 'I1');
  const md = join(HOME, 'edit6.md');
  writeFileSync(md, `subject: x\n\n${draftFor(ops, ev).body}`);
  cli('event-outreach', ['save-draft', '--event', SLUG, '--id', ops.id, '--md-file', md, '--insight', 'none']);
  assert.equal(file(ops.id).insight, null);
  save([{ id: ops.id, touch: 1, ...draftFor(ops, ev), insight: 'I1' }]);

  // Insert a row at the top of the table: the draft still means the insurance insight, now I2.
  const bring = join(HOME, 'events', SLUG, 'context', 'what-you-bring', 'SKILL.md');
  const ctxFile = existsSync(bring) ? bring : JSON.parse(readFileSync(join(HOME, 'events', SLUG, 'event.json'), 'utf8')).context_dir + '/what-you-bring/SKILL.md';
  const before = readFileSync(ctxFile, 'utf8');
  const useBefore = cli('event-outreach', ['batch-check', '--event', SLUG, '--touch', '1']).insight_use;
  writeFileSync(ctxFile, before.replace(/(\| insight \| basis \| segments \| situations \|\n\|---\|---\|---\|---\|\n)/, '$1| Brand-new first row about lane pricing | internal | ops-leaders | growth |\n'));
  const ci = cli('event-outreach', ['critic-batch', '--event', SLUG, '--ids', `${ops.id}:1`])[0].input;
  assert.match(ci.declared_insight, /insurance certificates/);
  const useAfter = cli('event-outreach', ['batch-check', '--event', SLUG, '--touch', '1']).insight_use;
  assert.equal(useAfter.I1, undefined, 'nothing points at the new row');
  assert.equal(useAfter.I2, useBefore.I1, 'the insurance drafts moved with their row');
  writeFileSync(ctxFile, before);

  // Drafts saved before insights were declared don't tell the critic anything.
  const legacy = file(pair.id);
  delete legacy.insight; delete legacy.insight_text;
  writeFileSync(join(HOME, 'events', SLUG, 'work', 'drafts', `${pair.id}-t1.json`), JSON.stringify(legacy));
  assert.ok(!('declared_insight' in cli('event-outreach', ['critic-batch', '--event', SLUG, '--ids', `${pair.id}:1`])[0].input));
  save([{ id: pair.id, touch: 1, ...draftFor(pair, ev), insight: opt(pair) }]);

  // A later run: the colleague's earlier insight is in avoid_insights, and batch-check only names the new draft.
  pass(pair.id);
  assert.equal(cli('event-outreach', ['gate', '--event', SLUG, '--answers', `approve ${pair.id}`]).approved, 1);
  const later = bringPath(cli('event-outreach', ['todo', '--event', SLUG]));
  const mate = later.jobs.find((j) => j.id === pair.colleagues[0]);
  assert.ok(mate.avoid_insights.includes(opt(pair)), 'colleague insight from an earlier draft is avoided');
  assert.ok(!later.jobs.some((j) => j.id === pair.id), 'the outboxed colleague is not drafted again');
  save([{ id: mate.id, touch: 1, ...draftFor(mate, ev), insight: opt(pair) }]);
  const bc = cli('event-outreach', ['batch-check', '--event', SLUG, '--touch', '1']);
  assert.ok(bc.reasons.some((r) => r.includes(`${pair.id} was drafted earlier, so change ${mate.id}`)), bc.reasons.join(' | '));

  // Follow-up a week later: repeating the first message's insight fails at save and in batch-check.
  pass(ops.id);
  const sent = cli('event-outreach', ['gate', '--event', SLUG, '--answers', `approve ${ops.id}`]);
  assert.equal(sent.approved, 1);
  const outbox = readFileSync(sent.outbox, 'utf8');
  assert.ok(outbox.includes(`data-id="${ops.id}"`));
  const statusPath = join(HOME, 'status6.txt');
  writeFileSync(statusPath, `floorboss-status v1 event=${SLUG} at=2026-10-09T09:00:00Z\n${ops.id} sent=2026-10-09`);
  const WEEK = '2026-10-17T08:00:00Z';
  cli('event-outreach', ['status', '--event', SLUG, '--text-file', statusPath], { now: WEEK });
  const fu = cli('event-outreach', ['todo', '--event', SLUG], { now: WEEK });
  const job2 = bringPath(fu).jobs.find((j) => j.id === ops.id && j.touch === 2);
  assert.ok(job2, 'follow-up is due');
  assert.equal(job2.previous_insight, 'I1');
  assert.ok(job2.avoid_insights.includes('I1'));
  writeFileSync(draftsPath, JSON.stringify([{ id: ops.id, touch: 2, ...draftFor(job2, ev), insight: 'I1' }]));
  const s2 = cli('event-outreach', ['save-drafts', '--event', SLUG, '--drafts-file', draftsPath], { now: WEEK })[0];
  assert.match(s2.checks.join(' '), /I1 was in the message before/);
  const bc2 = cli('event-outreach', ['batch-check', '--event', SLUG], { now: WEEK });
  assert.ok((bc2.reasons || []).some((r) => /repeats I1 from the message before/.test(r)), JSON.stringify(bc2.reasons));

  // Deleting the first message's row frees the follow-up: the old ID now means another row.
  writeFileSync(ctxFile, before.replace(/^\| Most onboarding delay.*\n/m, ''));
  const job3 = bringPath(cli('event-outreach', ['todo', '--event', SLUG], { now: WEEK })).jobs.find((j) => j.id === ops.id && j.touch === 2);
  assert.equal(job3.previous_insight, null);
  assert.ok(!job3.avoid_insights.includes('I1'));
  writeFileSync(ctxFile, before);
  writeFileSync(draftsPath, JSON.stringify([{ id: ops.id, touch: 2, ...draftFor(job3, ev), insight: 'I99' }]));
  assert.match(cli('event-outreach', ['save-drafts', '--event', SLUG, '--drafts-file', draftsPath], { now: WEEK })[0].checks.join(' '), /I99 isn't in the "what you know" table/);
});
