// Six findings from a simulated Codex run of the mock event (gpt-run, 2026-11-19), each with its test:
// 1. the critic step's batches keep their numbers between calls, so a `then` given earlier still matches;
// 2. the critic's own instructions agree with the Codex skill about a handed-over batch file;
// 3. hand-send step texts carry no Claude Code wording, and Claude Code's are as they were;
// 4. the outbox's "N of M sent" counts recorded sends instead of dropping them from the total;
// 5. the shortlist's `to` for a reach person with no email is their LinkedIn link, as in todo.json;
// 6. `verdicts --ids ""` says the ids are empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { NOW, ROOT } from './fixtures/harness.mjs';
import { drive, simplePersona, makeHome } from './sims/lib/driver.mjs';
import { MOCK, envOf, home } from './fixtures/r2.mjs';
import { untilStep } from './fixtures/flow-until.mjs';

const CODEX = { CODEX_SESSION_ID: 'codex-sess', CODEX_THREAD_ID: 'codex-thread' };
const envFor = (HOME, codex) => {
  const env = envOf(HOME, codex ? CODEX : {});
  if (codex) delete env.CLAUDECODE;
  return env;
};
const runIn = (H, skill, args) => {
  try {
    return JSON.parse(execFileSync('node', [join(ROOT, 'skills', skill, 'scripts/cli.mjs'), ...args], { env: H.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) {
    return { ERROR: String(e.stderr || e.message).slice(0, 800) };
  }
};
// The mock event, run as Claude Code (codex false) or as Codex (codex true).
function mock(codex) {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  const env = envFor(HOME, codex);
  execFileSync('node', [join(ROOT, 'examples/mock-event/load.mjs'), '--goal', 'buyers', '--now', NOW], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  return { HOME, now: NOW, env };
}
const mockPersona = (over = {}) =>
  simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), voice_samples: 'skip', replies_since: 'none', ...over } });
const idsOf = (ag) => ag.then[ag.then.indexOf('--ids') + 1].split(',');
const thenOf = (H, ag) => runIn(H, 'event-outreach', ag.then.slice(2));

test('1. critic batches keep their numbers: verdicts for one batch, then next, leaves every other batch as it was', { timeout: 300000 }, () => {
  const H = mock(true);
  // One persona throughout: its writer counts its tries, so a rewrite is new text.
  const per = mockPersona();
  const s1 = untilStep(H, per, 'critic').last;
  assert.equal(s1.step, 'critic');
  assert.ok(s1.agents.length >= 3, `three batches or more: ${s1.agents.length}`);
  const before = s1.agents.map((a) => ({ ...a, text: readFileSync(a.input_file, 'utf8') }));
  // The critic for batch 2 answers, its verdicts are saved, and then `next` runs before the other replies are in.
  writeFileSync(before[1].write, idsOf(before[1]).map((k) => `${k} PASS`).join('\n'));
  assert.ok(!thenOf(H, before[1]).ERROR);
  const s2 = runIn(H, 'flow', ['next', '--event', MOCK]);
  assert.equal(s2.step, 'critic', JSON.stringify(s2).slice(0, 300));
  assert.equal(s2.agents.length, before.length - 1);
  for (const a of [before[0], ...before.slice(2)]) {
    const b = s2.agents.find((x) => x.write === a.write);
    assert.ok(b, `${a.write} is still a batch`);
    assert.deepEqual(b.then, a.then, 'the same command, the same ids');
    assert.equal(b.input_file, a.input_file);
    assert.equal(readFileSync(b.input_file, 'utf8'), a.text, 'its batch file holds the same drafts');
  }
  // The command given before `next` still records its own batch: the reply written for it, its ids.
  const third = before[2];
  writeFileSync(third.write, idsOf(third).map((k) => `${k} PASS`).join('\n'));
  const v = thenOf(H, third);
  assert.ok(!v.ERROR, v.ERROR);
  assert.deepEqual(v.verdicts.map((x) => `${x.id}:${x.touch}`).sort(), idsOf(third).sort());
  assert.equal(v.ignored_not_in_batch, undefined);
  // A reply that leaves one draft out: that draft stays in its own batch, under the same number.
  const first = before[0];
  const [left, ...answered] = idsOf(first).reverse();
  writeFileSync(first.write, answered.map((k) => `${k} PASS`).join('\n'));
  assert.deepEqual(thenOf(H, first).missing_from_reply, [left]);
  const s3 = runIn(H, 'flow', ['next', '--event', MOCK]);
  assert.equal(s3.step, 'critic');
  const still = s3.agents.find((x) => x.write === first.write);
  assert.ok(still, 'batch 1 keeps its number');
  assert.deepEqual(idsOf(still), [left]);
  for (const a of before.slice(3)) assert.deepEqual(s3.agents.find((x) => x.write === a.write)?.then, a.then, a.write);
  // A draft that comes back for the critic as new text (here: failed, rewritten) gets a number no batch used before.
  const failed = idsOf(before[3])[0];
  writeFileSync(before[3].write, idsOf(before[3]).map((k) => (k === failed ? `${k} FAIL: says something no source gives` : `${k} PASS`)).join('\n'));
  assert.ok(!thenOf(H, before[3]).ERROR);
  const s4 = untilStep(H, per, 'critic').last;
  assert.equal(s4.step, 'critic');
  const mine = s4.agents.find((x) => idsOf(x).includes(failed));
  assert.ok(mine, `the rewritten draft is in a batch: ${failed} ${JSON.stringify(s4.agents.map(idsOf))}`);
  assert.ok(!before.some((a) => a.write === mine.write), `a new number for new text: ${mine.write}`);
});

test('2. the critic\'s instructions and the Codex skill agree about a handed-over batch file; Claude Code\'s critic still reads no file', () => {
  const critic = readFileSync(join(ROOT, 'agents/outreach-critic.md'), 'utf8');
  const skill = readFileSync(join(ROOT, '.agents/skills/floorboss/SKILL.md'), 'utf8');
  const [, front, body] = critic.split(/^---$/m);
  // Claude Code: still one listed tool that only shows file names (an empty list would hand it every tool).
  assert.match(front, /^tools: Glob$/m);
  // The whole batch file, handed over by whoever runs the step (Codex: its own reading of input_file), counts as the
  // drafts; a path alone, or a summary, still gets the ERROR line, and the critic opens no file itself.
  assert.match(body, /the whole of a critic-batch file/);
  assert.match(body, /Never open, list or look for a file yourself/);
  assert.match(body, /If all you have is a file path, a summary, or anything other than the drafts themselves[\s\S]{0,120}`ERROR: no drafts provided`/);
  assert.doesNotMatch(body, /If you're given a file path,/);
  // The Codex skill: read the one input_file whole, then judge only it; nothing says "use no tool" for the critic.
  assert.match(skill, /For the critic \(`outreach-critic`\) and the\s+writer \(`outreach-writer`\), open no file but the step's own `input_file`/);
  assert.doesNotMatch(skill, /use no tool and open no other file/);
});

// Claude Code wording that has no place in a hand-send step: agents in parallel, a send floorboss makes, Claude by
// name, a slash command, a bare "Show <file>".
const CLAUDE_WORDS = /in parallel|one message\)|all at once|every researcher at once|With sending on|\/floorboss:|\bClaude\b|^Show \//;
const textsOf = (s) => [s.why, s.ask?.question, s.judge?.how, s.tell_user].filter((t) => typeof t === 'string');

function threePeople(codex) {
  const H = makeHome({
    context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' },
    attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.example\nBo Li,VP Ops,Globex,bo@globex.example\nCy Ng,Head of Ops,Initech,cy@initech.example\n'
  });
  if (codex) {
    Object.assign(H.env, CODEX);
    delete H.env.CLAUDECODE;
  }
  const steps = {};
  const persona = simplePersona({
    asks: { setup_level: 'standard', attendee_list: join(H.HOME, 'inputs', 'attendees.csv'), research_scale: 'all 3' },
    judge: {
      research: (x) => ({ identity_confirmed: true, role_seen: x.title, person_claims: 0, complete: true, claims: [{ text: `${x.company} runs regional warehouses.`, url: `https://${String(x.company).toLowerCase()}.example/about` }] })
    }
  });
  const r = drive(H, persona, { maxSteps: 200, onStep: (s) => { (steps[s.step] ||= []).push(s); } });
  assert.ok(r.last.done, r.trail.join(' '));
  return steps;
}

test('3. hand-send step texts: no Claude Code wording (research, critic, approve; no rating step)', { timeout: 300000 }, () => {
  const steps = threePeople(true);
  // (No scan step in hand-send: there is nothing connected to look at.)
  assert.equal(steps.scan, undefined);
  for (const id of ['company_briefs', 'research_batch', 'critic', 'approve']) assert.ok(steps[id], `${id} came up: ${Object.keys(steps).join(' ')}`);
  for (const [id, list] of Object.entries(steps)) for (const s of list) for (const t of textsOf(s)) assert.doesNotMatch(t, CLAUDE_WORDS, `${id}: ${t}`);
  assert.equal(steps.critic[0].why, '3 drafts for the critic: 1 batch. Give each batch its whole file, exactly as written, one batch after another; never summarise it.');
  assert.match(steps.approve[0].why, /^3 messages are ready for the user's yes\. Each is shown in full; once approved, the user sends each one from their own mail app or copies it\.$/);
  // Codex has no 1-to-10 rating step: the chat review at approval is how the drafts are judged.
  assert.equal(steps.rate, undefined, 'Codex is never asked to rate drafts 1 to 10');
  assert.match(steps.approve[0].run_first.join(' '), /flow\b.*review/);
  assert.match(steps.approve[0].ask.question, /candid feedback/);
  assert.match(steps.research_batch[0].why, /^Research 3 people on the web, one after another: public sources only, a URL on every claim\. Then save each\.$/);
  assert.match(steps.company_briefs[0].why, /Run each researcher in turn, then save each\./);
});

test('3. Claude Code step texts are exactly as they were', { timeout: 300000 }, () => {
  const steps = threePeople(false);
  assert.equal(steps.critic[0].why, '3 drafts for the separate critic: 1 critic at once (in parallel, one message). Paste each critic its whole batch file, exactly as written; never summarise it.');
  assert.equal(steps.approve[0].why, "3 messages are ready for the user's yes. With sending on, each person's whole sequence and its planned days are shown.");
  assert.match(steps.rate[0].ask.question, /^Show \/.+rate-set\.md\. For each, how likely is that reader to reply, 1 to 10\? A few words if something stands out\. Or skip\.$/);
  assert.equal(steps.research_batch[0].why, 'Research 3 people on the web, all at once (in parallel, one message): public sources only, a URL on every claim. Then save each.');
  assert.match(steps.company_briefs[0].why, /Run every researcher at once \(in parallel, one message\), then save each\./);
  assert.equal(steps.scan[0].why, "floorboss hasn't looked at what this Claude setup already has (skills, agents, connected tools). The scan decides which questions are worth asking.");
});

test('3. an event whose dates can\'t be read: "/floorboss:start" in Claude Code, plain words in hand-send', () => {
  for (const codex of [false, true]) {
    const H = mock(codex);
    const f = join(H.HOME, 'events', MOCK, 'event.json');
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), start_date: 'soon' }));
    const s = runIn(H, 'flow', ['next', '--event', MOCK]);
    assert.equal(s.dates_unreadable, true, JSON.stringify(s).slice(0, 300));
    if (codex) {
      assert.doesNotMatch(s.why, CLAUDE_WORDS);
      assert.match(s.why, /once the file is fixed, run floorboss again\.$/);
    } else assert.match(s.why, /once the file is fixed, run \/floorboss:start again\.$/);
  }
});

const barOf = (H) => {
  const m = /<b id="sentCount"[^>]*>(\d+)<\/b> of <b>(\d+)<\/b> sent/.exec(readFileSync(join(H.HOME, 'events', MOCK, 'outbox.html'), 'utf8'));
  assert.ok(m, 'the bar is on the page');
  return { sent: Number(m[1]), of: Number(m[2]) };
};

test('4. the outbox counter: recorded sends count as sent, and stay in the total', { timeout: 300000 }, () => {
  const H = mock(true);
  const r = drive(H, mockPersona(), { maxSteps: 200 });
  assert.ok(r.last.done, r.trail.join(' '));
  runIn(H, 'event-outreach', ['open', '--event', MOCK, '--no-open']);
  const start = barOf(H);
  assert.equal(start.sent, 0);
  assert.ok(start.of >= 10, JSON.stringify(start));
  const html = readFileSync(join(H.HOME, 'events', MOCK, 'outbox.html'), 'utf8');
  const two = [...html.matchAll(/<article class="card[^"]*" data-id="([^"]+)" data-touch="1"[\s\S]*?<\/article>/g)].filter((m) => /href="mailto:/.test(m[0])).slice(0, 2).map((m) => m[1]);
  assert.equal(two.length, 2);
  const f = join(H.HOME, 'work', 'rec-sent.json');
  writeFileSync(f, JSON.stringify({ items: two.map((who) => ({ who, what: 'sent', date: '2026-10-12', channel: 'email' })) }));
  const rec = runIn(H, 'event-outreach', ['record', '--event', MOCK, '--file', f]);
  assert.equal(rec.applied, true, JSON.stringify(rec));
  runIn(H, 'event-outreach', ['open', '--event', MOCK, '--no-open']);
  assert.deepEqual(barOf(H), { sent: 2, of: start.of }, 'two of the same total sent, not 0 of two fewer');
});

test('5. the shortlist: a reach person with no email has their LinkedIn link as `to`, as todo.json has it', { timeout: 300000 }, () => {
  const H = mock(true);
  untilStep(H, mockPersona(), 'critic');
  const v = runIn(H, 'crm-triage', ['view', '--event', MOCK]);
  assert.ok(!v.ERROR, v.ERROR);
  for (const row of v.top) assert.notEqual(row.to, '', `${row.id}: an empty "to"`);
  const tom = v.top.find((x) => x.name === 'Tom Fischer');
  assert.ok(tom, 'Tom Fischer (LinkedIn only) is on the shortlist');
  assert.match(tom.to, /^https:\/\/[^/]+\/in\/tom-fischer\/?$/, 'his profile link (the mock\'s own host)');
  const todo = JSON.parse(readFileSync(join(H.HOME, 'events', MOCK, 'derived', 'todo.json'), 'utf8'));
  const job = todo.jobs.find((j) => j.id === tom.id && j.touch === 1);
  assert.ok(job, 'a drafting job for him');
  assert.equal(tom.to, job.to);
});

test('6. verdicts with empty ids says the ids are empty', () => {
  const H = mock(false);
  const f = join(H.HOME, 'work', 'reply.txt');
  writeFileSync(f, 'c001 PASS\n');
  for (const ids of ['', ' ', ',']) {
    const r = runIn(H, 'event-outreach', ['verdicts', '--event', MOCK, '--ids', ids, '--text-file', f]);
    assert.match(r.ERROR || '', /--ids is empty/, ids);
    assert.doesNotMatch(r.ERROR, /No verdict lines/);
  }
});

// Codex asks nothing about research, in every setup level: a quick setup still looks the people up, so a draft has a
// researched fact to open with (a quick setup in Codex used to skip the people and every draft came out generic).
test('3. Codex researches the people even on a quick setup', { timeout: 300000 }, () => {
  const H = makeHome({
    context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' },
    attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.example\nBo Li,VP Ops,Globex,bo@globex.example\nCy Ng,Head of Ops,Initech,cy@initech.example\n'
  });
  Object.assign(H.env, CODEX);
  delete H.env.CLAUDECODE;
  const persona = simplePersona({ asks: { setup_level: 'quick', attendee_list: join(H.HOME, 'inputs', 'attendees.csv') } });
  const hit = untilStep(H, persona, 'research_batch', { maxSteps: 120 });
  assert.equal(hit.step, 'research_batch', hit.trail.join(' '));
});

// Codex is asked whether floorboss sends from Gmail at every setup level (quick used to default it away, so
// auto-send was never offered); a yes turns auto-send on in drafts mode before the approval; a no keeps hand-send.
function quickSending(answer) {
  const H = makeHome({
    context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' },
    attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.example\nBo Li,VP Ops,Globex,bo@globex.example\nCy Ng,Head of Ops,Initech,cy@initech.example\n'
  });
  Object.assign(H.env, CODEX);
  delete H.env.CLAUDECODE;
  const asked = [];
  const persona = simplePersona({
    asks: { setup_level: 'quick', attendee_list: join(H.HOME, 'inputs', 'attendees.csv'), sending: answer, send_setup: 'sam@gmail.example', touches: '4', voice_samples: 'skip' },
    judge: { research: (x) => ({ identity_confirmed: true, role_seen: x.title, person_claims: 0, complete: true, claims: [{ text: `${x.company} runs regional warehouses.`, url: `https://${String(x.company).toLowerCase()}.example/about` }] }) }
  });
  const hit = untilStep(H, persona, (s) => {
    if (s.ask?.id) asked.push(s.ask.id);
    return s.step === 'approve' || s.step === 'autosend_on';
  }, { maxSteps: 250 });
  return { H, asked, hit };
}
const eventJson = (H) => {
  const d = join(H.HOME, 'events');
  return execFileSync('sh', ['-c', `cat ${d}/*/event.json`], { encoding: 'utf8' });
};

test('3. Codex quick setup asks whether floorboss sends from Gmail; yes turns on drafts mode before approval', { timeout: 300000 }, () => {
  const { H, asked, hit } = quickSending('yes, send them from my Gmail');
  assert.ok(asked.includes('sending'), `the sending question was asked: ${asked.join(' ')}`);
  assert.equal(hit.step, 'autosend_on', hit.trail.join(' '));
  assert.match(hit.last.run.join(' '), /autosend.*cli\.mjs on .*--mode drafts/);
  assert.match(hit.last.run.join(' '), /--own sam@gmail\.example/);
  // Run it: the event is then in drafts mode.
  const out = JSON.parse(execFileSync(hit.last.run[0], hit.last.run.slice(1), { env: H.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(out.autosend, true);
  assert.equal(out.mode, 'drafts');
  assert.match(eventJson(H), /"autosend_mode":\s*"drafts"/);
});

test('3. Codex quick setup: a no keeps hand-send (no auto-send step)', { timeout: 300000 }, () => {
  const { asked, hit } = quickSending("no, I'll send them myself");
  assert.ok(asked.includes('sending'));
  assert.equal(hit.step, 'approve');
});
