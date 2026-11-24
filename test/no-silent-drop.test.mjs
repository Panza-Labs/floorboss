// Nobody leaves a run without a word. A fresh attempt asked for on a draft that passed the critic is drafted again and
// read by the critic, so the line that says the critic will read it is true. Two verdicts on one save are one critic
// fail, for the redraft as for the hold, so a draft is redrafted or held, never dropped in silence. At every approval,
// each person with a message to approve is offered, or named in a held line. A failed approval check tells the user
// the same thing the agent is told: say to try again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, rmSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, NOW } from './fixtures/harness.mjs';
import { drive, simplePersona } from './sims/lib/driver.mjs';
import { MOCK, envOf, loadMock, home } from './fixtures/r2.mjs';

const SEND = { server: 'gmail', tool: 'send_message', args: { to: '{to}', subject: '{subject}', body: '{body}', threadId: '{thread_id}' }, reading: 'the id and threadId it returns', tool_hash: 'b'.repeat(64), test_draft: { draft_id: 'm-test', user_confirmed: true } };
const persona = () => simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), voice_samples: 'skip', rate: 'skip' } });
let STATE = null;
// The mock event with whole sequences and LinkedIn notes, at its first approval, unanswered.
function state() {
  if (STATE) return STATE;
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true, sending: { channels: ['email'], followups: 'scheduled' }, connectors: { 'email.send': SEND } }));
  loadMock(HOME);
  // The mock's profile links, as LinkedIn ones: the people with no address get one LinkedIn note each.
  const list = join(HOME, 'events', MOCK, 'attendees.csv');
  writeFileSync(list, readFileSync(list, 'utf8').replaceAll('https://example.com/in/', 'https://www.linkedin.com/in/'));
  try {
    drive({ HOME, now: NOW, env: envOf(HOME) }, persona(), { maxSteps: 200, onStep: (s) => { if (s.step === 'approve') throw Object.assign(new Error('at the approval'), { stop: true }); } });
  } catch (e) {
    if (!e.stop) throw e;
  }
  STATE = HOME;
  return HOME;
}
const copy = () => {
  const H = mkdtempSync(join(tmpdir(), 'fb-drop-'));
  cpSync(state(), H, { recursive: true });
  return H;
};
const run = (H, skill, args, extra = {}) => {
  const env = envOf(H, extra);
  delete env.FLOORBOSS_OUT_OF_TURN;
  return JSON.parse(execFileSync('node', [join(ROOT, `skills/${skill}/scripts/cli.mjs`), ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
};
const L = (H) => join(H, 'events', MOCK, 'ledger.jsonl');
const lastHash = (H, id, t) => readFileSync(L(H), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.type === 'drafted' && x.id === id && (x.touch ?? 1) === t).pop().hash;

test('a fresh attempt on a draft that passed the critic is drafted again, then read by the critic', { timeout: 600000 }, () => {
  const H = copy();
  try {
    const r = run(H, 'event-outreach', ['redraft', '--event', MOCK, '--ids', 'c002:1']);
    assert.deepEqual(r.fresh_attempt, ['c002:1']);
    const s = run(H, 'flow', ['next', '--event', MOCK]);
    assert.equal(s.step, 'draft', JSON.stringify(s).slice(0, 300));
    assert.ok(s.judge.ids.includes('c002:1'), s.judge.ids.join(','));
    // Written again, then read by the critic before the approval offers it.
    const read = [], trailX = [];
    // The drafter's fresh attempt is new text (one line more).
    const per = persona();
    const draft = per.judge.draft;
    per.judge.draft = (todo, ids, reasons) => draft(todo, ids, reasons).map((d) => (d.id === 'c002' && d.touch === 1 ? { ...d, body: d.body.replace(/\n\nBest,/, ' A fresh angle on the same ask.\n\nBest,') } : d));
    try {
      drive({ HOME: H, now: NOW, env: envOf(H) }, per, { maxSteps: 60, onStep: (x) => {
        trailX.push(x.step);
        if (x.step === 'critic') for (const a of x.agents || []) read.push(...String(a.then[a.then.indexOf('--ids') + 1] || '').split(','));
        if (x.step === 'approve') throw Object.assign(new Error('at the approval'), { stop: true });
      } });
    } catch (e) {
      if (!e.stop) throw e;
    }
    assert.ok(read.includes('c002:1'), `the critic read: ${read.join(',')} ${trailX.join(' | ')}`);
  } finally {
    rmSync(H, { recursive: true, force: true });
  }
});

test('two critic verdicts on one save are one fail: the draft is written again, not dropped', { timeout: 600000 }, () => {
  const H = copy();
  try {
    const hash = lastHash(H, 'c008', 1);
    for (let i = 0; i < 2; i++) appendFileSync(L(H), JSON.stringify({ at: NOW, type: 'critic', who: 'floorboss', id: 'c008', touch: 1, hash, verdict: 'FAIL', reasons: ['reads like a template'] }) + '\n');
    const s = run(H, 'flow', ['next', '--event', MOCK]);
    assert.equal(s.step, 'draft', JSON.stringify(s).slice(0, 300));
    assert.ok(s.judge.ids.includes('c008:1'), s.judge.ids.join(','));
  } finally {
    rmSync(H, { recursive: true, force: true });
  }
});

test('at every approval, each person with a message to approve is offered or named in a held line', { timeout: 900000 }, () => {
  const H = copy();
  try {
    // A draft failed twice on one save; another first message edited by hand after the critic read it.
    const hash = lastHash(H, 'c008', 1);
    for (let i = 0; i < 2; i++) appendFileSync(L(H), JSON.stringify({ at: NOW, type: 'critic', who: 'floorboss', id: 'c008', touch: 1, hash, verdict: 'FAIL', reasons: ['reads like a template'] }) + '\n');
    const f = join(H, 'events', MOCK, 'work', 'drafts', 'c005-t1.json');
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), body: `${JSON.parse(readFileSync(f, 'utf8')).body}\nP.S. by hand` }));
    let approvals = 0;
    const silent = [];
    try {
      drive({ HOME: H, now: NOW, env: envOf(H) }, persona(), { maxSteps: 120, onStep: (s) => {
        if (s.call) throw Object.assign(new Error('past the approval'), { reached: true });
        if (s.step !== 'approve') return;
        approvals++;
        const offered = new Set(s.run_first[s.run_first.indexOf('--ids') + 1].split(',').map((k) => k.split(':')[0]));
        const todo = JSON.parse(readFileSync(join(H, 'events', MOCK, 'derived', 'todo.json'), 'utf8'));
        const said = String(s.tell_user || '');
        for (const id of new Set(todo.jobs.filter((j) => j.kind === 'message').map((j) => j.id)))
          if (!offered.has(id) && !said.includes(`(${id})`) && !said.includes(`(${id}:`)) silent.push(id);
      } });
    } catch (e) {
      if (!e.reached) throw e;
    }
    assert.ok(approvals >= 1, 'an approval came');
    assert.deepEqual([...new Set(silent)], [], 'people neither offered nor named');
  } finally {
    rmSync(H, { recursive: true, force: true });
  }
});

test('a failed approval check: the user and the agent are told the same thing, to try again when asked', { timeout: 600000 }, () => {
  const H = copy();
  try {
    const s = run(H, 'flow', ['next', '--event', MOCK], { FLOORBOSS_FAIL_APPROVABLE: 'error' });
    assert.equal(s.step, 'waiting');
    assert.match(s.tell_user, /Say "try again" to have floorboss check again/);
    assert.doesNotMatch(s.tell_user, /Run floorboss again/);
    assert.match(s.loop, /they ask to try again/);
  } finally {
    rmSync(H, { recursive: true, force: true });
  }
});

// A fresh attempt keeps what a sent message's approval marks: the address it went to stays busy for the day (one message
// per address per day, a shared inbox included), and redraft refuses a message already sent, as revise does.
test('a fresh attempt never clears a sent message\'s approval, and redraft refuses a sent message', { timeout: 600000 }, async () => {
  const H = copy();
  const before = process.env.FLOORBOSS_HOME;
  try {
    const EV = join(H, 'events', MOCK);
    // A real event (the mock's sends are never counted against the user's other events), and c002's approval going to
    // the address c003 has: an inbox they share.
    const evFile = join(EV, 'event.json');
    const ev = JSON.parse(readFileSync(evFile, 'utf8'));
    delete ev.mock;
    writeFileSync(evFile, JSON.stringify(ev));
    const hash = lastHash(H, 'c002', 1);
    const shared = JSON.parse(readFileSync(join(EV, 'derived', 'compat', 'contacts.json'), 'utf8')).contacts.find((x) => x.id === 'c003').email;
    appendFileSync(L(H), JSON.stringify({ at: NOW, type: 'approved', who: 'user', id: 'c002', touch: 1, hash, to: shared, via: 'you', said: 'approve c002' }) + '\n');
    appendFileSync(L(H), JSON.stringify({ at: NOW, type: 'sent', who: 'floorboss', id: 'c002', touch: 1, date: '2026-10-12', hash, via: 'email' }) + '\n');
    process.env.FLOORBOSS_HOME = H;
    const { addressBusyToday } = await import('../lib/sendcheck.mjs');
    const busy = () => addressBusyToday(EV, shared, Date.parse(NOW) + 3600e3, 'c003');
    assert.ok(busy(), 'busy after the send');
    let refused = null;
    try {
      run(H, 'event-outreach', ['redraft', '--event', MOCK, '--ids', 'c002:1']);
    } catch (e) {
      refused = String(e.stderr || e.message);
    }
    assert.match(refused || '', /already sent/);
    // A fresh attempt line written anyway (by hand, or an older copy): the address stays busy.
    appendFileSync(L(H), JSON.stringify({ at: NOW, type: 'fresh_attempt', who: 'floorboss', id: 'c002', touch: 1, said: 'a fresh attempt' }) + '\n');
    assert.ok(busy(), 'still busy after a fresh attempt line');
  } finally {
    if (before === undefined) delete process.env.FLOORBOSS_HOME;
    else process.env.FLOORBOSS_HOME = before;
    rmSync(H, { recursive: true, force: true });
  }
});

// After a fresh attempt, the new text failing the critic once is written again, as any draft is; and at the end of the
// run nobody with a message is left out without a word.
test('after a fresh attempt, one critic fail on the new text: written again, and the end of the run names everyone it leaves', { timeout: 900000 }, () => {
  const H = copy();
  try {
    run(H, 'event-outreach', ['redraft', '--event', MOCK, '--ids', 'c008:1']);
    const per = persona();
    const draft0 = per.judge.draft,
      critic0 = per.judge.critic;
    let drafted = 0,
      read = 0;
    per.judge.draft = (todo, ids, r) => draft0(todo, ids, r).map((d) => (d.id === 'c008' && d.touch === 1 ? (drafted++, { ...d, body: `${d.body}\n\nA fresh line ${drafted}.` }) : d));
    per.judge.critic = (b) => {
      const t = critic0(b);
      if (!JSON.stringify(b).includes('"c008"')) return t;
      read++;
      return read === 1 ? t.replace('c008:1 PASS', 'c008:1 FAIL too stiff') : t;
    };
    const said = [];
    let end = null;
    try {
      drive({ HOME: H, now: NOW, env: envOf(H) }, per, { maxSteps: 150, onStep: (s) => {
        if (s.tell_user) said.push(String(s.tell_user));
        if (s.call || s.stop || s.done || s.step === 'waiting' || s.step === 'second_yes') {
          end = s;
          throw Object.assign(new Error('the end'), { end: true });
        }
      } });
    } catch (e) {
      if (!e.end) throw e;
    }
    assert.ok(end, 'the run ended');
    assert.ok(drafted >= 2, `c008:1 written ${drafted} times`);
    // The end: everyone with a message in the list is approved, or named somewhere the user was told.
    const todo = JSON.parse(readFileSync(join(H, 'events', MOCK, 'derived', 'todo.json'), 'utf8'));
    const approved = new Set(readFileSync(L(H), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.type === 'approved').map((x) => x.id));
    const all = said.join(' ');
    const silent = [...new Set(todo.jobs.filter((j) => j.kind === 'message').map((j) => j.id))].filter((id) => !approved.has(id) && !all.includes(`(${id})`) && !all.includes(`(${id}:`));
    assert.deepEqual(silent, [], `left without a word at ${end.step}`);
  } finally {
    rmSync(H, { recursive: true, force: true });
  }
});

// A revise line on a message already sent (written by hand: the revise command refuses one) keeps that message's
// approval, as a fresh attempt and a withdrawn approval do: the address it went to stays busy for the day.
test('a revise line on a sent message keeps its approval: the address stays busy for the day', { timeout: 600000 }, async () => {
  const H = copy();
  const before = process.env.FLOORBOSS_HOME;
  try {
    const EV = join(H, 'events', MOCK);
    const evFile = join(EV, 'event.json');
    const ev = JSON.parse(readFileSync(evFile, 'utf8'));
    delete ev.mock;
    writeFileSync(evFile, JSON.stringify(ev));
    const hash = lastHash(H, 'c002', 1);
    const shared = JSON.parse(readFileSync(join(EV, 'derived', 'compat', 'contacts.json'), 'utf8')).contacts.find((x) => x.id === 'c003').email;
    appendFileSync(L(H), JSON.stringify({ at: NOW, type: 'approved', who: 'user', id: 'c002', touch: 1, hash, to: shared, via: 'you', said: 'approve c002' }) + '\n');
    appendFileSync(L(H), JSON.stringify({ at: NOW, type: 'sent', who: 'floorboss', id: 'c002', touch: 1, date: '2026-10-12', hash, via: 'email' }) + '\n');
    appendFileSync(L(H), JSON.stringify({ at: NOW, type: 'revise', who: 'user', id: 'c002', touch: 1, feedback: 'shorter', said: 'shorter' }) + '\n');
    process.env.FLOORBOSS_HOME = H;
    const { addressBusyToday } = await import('../lib/sendcheck.mjs');
    const { readLedger, fold } = await import('../lib/ledger.mjs');
    assert.ok(addressBusyToday(EV, shared, Date.parse(NOW) + 3600e3, 'c003'), 'still busy after the revise line');
    const x = fold(readLedger(L(H)).entries).people.c002.touches[1];
    assert.equal(x.approved?.to, shared, 'the approval stays');
    assert.ok(!x.revising, 'a sent message is not drafted again');
  } finally {
    if (before === undefined) delete process.env.FLOORBOSS_HOME;
    else process.env.FLOORBOSS_HOME = before;
    rmSync(H, { recursive: true, force: true });
  }
});

// The send recorded after the fresh attempt or the revise (the user sent it from their own mail and ticked it later, or
// the mailbox check found it later): the address it went to is still busy for the day.
for (const kind of ['fresh_attempt', 'revise', 'approval_withdrawn'])
  test(`a ${kind} line, then the send recorded: the address stays busy for the day`, { timeout: 600000 }, async () => {
    const H = copy();
    const before = process.env.FLOORBOSS_HOME;
    try {
      const EV = join(H, 'events', MOCK);
      const evFile = join(EV, 'event.json');
      const ev = JSON.parse(readFileSync(evFile, 'utf8'));
      delete ev.mock;
      writeFileSync(evFile, JSON.stringify(ev));
      const hash = lastHash(H, 'c002', 1);
      const shared = JSON.parse(readFileSync(join(EV, 'derived', 'compat', 'contacts.json'), 'utf8')).contacts.find((x) => x.id === 'c003').email;
      appendFileSync(L(H), JSON.stringify({ at: NOW, type: 'approved', who: 'user', id: 'c002', touch: 1, hash, to: shared, via: 'you', said: 'approve c002' }) + '\n');
      appendFileSync(L(H), JSON.stringify({ at: NOW, type: kind, who: 'user', id: 'c002', touch: 1, ...(kind === 'revise' ? { feedback: 'shorter' } : {}), ...(kind === 'approval_withdrawn' ? { reason: 'not yet' } : {}), said: 'again' }) + '\n');
      appendFileSync(L(H), JSON.stringify({ at: NOW, type: 'sent', who: 'user', id: 'c002', touch: 1, date: '2026-10-12', hash, via: 'you', source: 'user' }) + '\n');
      process.env.FLOORBOSS_HOME = H;
      const { addressBusyToday } = await import('../lib/sendcheck.mjs');
      assert.ok(addressBusyToday(EV, shared, Date.parse(NOW) + 3600e3, 'c003'), 'busy after the send recorded late');
    } finally {
      if (before === undefined) delete process.env.FLOORBOSS_HOME;
      else process.env.FLOORBOSS_HOME = before;
      rmSync(H, { recursive: true, force: true });
    }
  });

// To the real end of the run. With hand sending (the user sends each approved message and floorboss records it), so the
// run reaches its own final step, done or a wait or a stop: there, each person with a message was approved, sent, or
// named to the user.
let SINGLE = null;
function singleState() {
  if (SINGLE) return SINGLE;
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const list = join(HOME, 'events', MOCK, 'attendees.csv');
  writeFileSync(list, readFileSync(list, 'utf8').replaceAll('https://example.com/in/', 'https://www.linkedin.com/in/'));
  try {
    drive({ HOME, now: NOW, env: envOf(HOME) }, persona(), { maxSteps: 200, onStep: (s) => { if (s.step === 'approve') throw Object.assign(new Error('at the approval'), { stop: true }); } });
  } catch (e) {
    if (!e.stop) throw e;
  }
  SINGLE = HOME;
  return HOME;
}
test('to the real end of the run: each person with a message is approved, sent, or named', { timeout: 1200000 }, async () => {
  const H = mkdtempSync(join(tmpdir(), 'fb-end-'));
  cpSync(singleState(), H, { recursive: true });
  try {
    run(H, 'event-outreach', ['redraft', '--event', MOCK, '--ids', 'c008:1']);
    const per = persona();
    const draft0 = per.judge.draft,
      critic0 = per.judge.critic;
    let read = 0;
    per.judge.draft = (todo, ids, r) => draft0(todo, ids, r).map((d) => (d.id === 'c008' && d.touch === 1 ? { ...d, body: `${d.body}\n\nA fresh line ${read}.` } : d));
    per.judge.critic = (b) => {
      const t = critic0(b);
      if (!JSON.stringify(b).includes('"c008"')) return t;
      read++;
      return read === 1 ? t.replace('c008:1 PASS', 'c008:1 FAIL too stiff') : t;
    };
    const said = [];
    let last = null;
    const go = () => {
      try {
        return drive({ HOME: H, now: NOW, env: envOf(H) }, per, { maxSteps: 300, onStep: (s) => {
          last = s;
          if (s.tell_user) said.push(String(s.tell_user));
          if (s.stop) throw Object.assign(new Error('stopped'), { end: true });
        } }).last;
      } catch (e) {
        if (!e.end) throw e;
        return last;
      }
    };
    go();
    // The user sends every approved first message and says so; floorboss records it; the run goes on to its end.
    const led0 = readFileSync(L(H), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const names = JSON.parse(readFileSync(join(H, 'events', MOCK, 'derived', 'compat', 'contacts.json'), 'utf8')).contacts;
    const items = [...new Set(led0.filter((x) => x.type === 'approved' && (x.touch ?? 1) === 1).map((x) => x.id))].map((id) => ({ who: names.find((c) => c.id === id).name, what: 'sent', date: '2026-10-12' }));
    assert.ok(items.length, 'something was approved');
    const f = join(H, 'work', 'sent.json');
    writeFileSync(f, JSON.stringify({ items }));
    const rec = run(H, 'event-outreach', ['record', '--event', MOCK, '--file', f]);
    assert.equal(rec.applied, true, JSON.stringify(rec).slice(0, 300));
    const end = go();
    assert.ok(end && (end.done || ['waiting', 'second_yes'].includes(end.step) || end.stop), `the run ended: ${end?.step}`);
    const todo = JSON.parse(readFileSync(join(H, 'events', MOCK, 'derived', 'todo.json'), 'utf8'));
    const led = readFileSync(L(H), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    // As the record stands at the end: a message sent, or approved for the text it has now (not withdrawn since).
    const { fold } = await import('../lib/ledger.mjs');
    const people = fold(led).people;
    const ok = (id) => Object.values(people[id]?.touches || {}).some((x) => x?.sent || (x?.approved && x.approved.hash === x.hash));
    // Named in the final step itself: its tell_user, or its held lines.
    const finalSays = `${end.tell_user || ''} ${JSON.stringify(end.held || [])}`;
    const ids = new Set([...todo.jobs.filter((j) => j.kind === 'message').map((j) => j.id), ...led.filter((x) => x.type === 'drafted').map((x) => x.id)]);
    const silent = [...ids].filter((id) => !ok(id) && !finalSays.includes(`(${id})`) && !finalSays.includes(`(${id}:`) && !finalSays.includes(`"id":"${id}"`));
    assert.deepEqual(silent, [], `left without a word at ${end.step}`);
    void said;
  } finally {
    rmSync(H, { recursive: true, force: true });
  }
});

// An approval taken away (withdrawn, a fresh attempt with or without a new save, a revise), then the message reported
// sent and the report taken back ("unsent"): nothing of the old approval comes back as an approval. The address the
// send went to is kept apart (sent_under) for the day mark, and goes with the send when it is taken back.
for (const mode of ['withdraw', 'fresh', 'fresh-same', 'revise'])
  test(`approval taken away (${mode}), then sent and unsent: not listed to send, and the send check refuses it`, { timeout: 600000 }, async () => {
    const H = copy();
    const before = process.env.FLOORBOSS_HOME;
    try {
      const EV = join(H, 'events', MOCK);
      const at = '2026-10-12T10:00:00.000Z';
      const eo = (args) => {
        const env = envOf(H, { FLOORBOSS_NOW: at });
        delete env.FLOORBOSS_OUT_OF_TURN;
        try {
          return JSON.parse(execFileSync('node', [join(ROOT, 'skills/event-outreach/scripts/cli.mjs'), ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
        } catch (e) {
          return { ERROR: String(e.stderr || e.message).slice(0, 300) };
        }
      };
      let g = eo(['gate', '--event', MOCK, '--answers', 'approve c002']);
      if (g.pending) g = eo(['gate', '--event', MOCK, '--answers', 'yes']);
      assert.ok(!g.ERROR, g.ERROR);
      const listed = () => {
        const sl = eo(['send-list', '--event', MOCK]);
        assert.ok(!sl.ERROR, sl.ERROR);
        const raw = JSON.parse(readFileSync(sl.file, 'utf8'));
        return [].concat(raw.items || raw);
      };
      const item = listed().find((x) => x.id === 'c002' && x.touch === 1);
      assert.ok(item, 'listed once approved');
      const d = JSON.parse(readFileSync(join(EV, 'work', 'drafts', 'c002-t1.json'), 'utf8'));
      if (mode.startsWith('fresh')) assert.ok(!eo(['redraft', '--event', MOCK, '--ids', 'c002:1']).ERROR);
      if (mode === 'fresh-same') assert.ok(!eo(['save-draft', '--event', MOCK, '--id', 'c002', '--touch', '1', '--json', JSON.stringify({ subject: d.subject, body: d.body })]).ERROR);
      if (mode === 'revise') {
        const f = join(H, 'work', 'fb.txt');
        writeFileSync(f, 'warmer');
        assert.ok(!eo(['revise', '--event', MOCK, '--ids', 'c002:1', '--feedback-file', f]).ERROR);
      }
      if (mode === 'withdraw') appendFileSync(L(H), JSON.stringify({ at, type: 'approval_withdrawn', who: 'floorboss', id: 'c002', touch: 1, reason: 'the channels changed' }) + '\n');
      const rep = (what) => {
        const f = join(H, 'work', `rep-${what}.json`);
        writeFileSync(f, JSON.stringify({ items: [{ who: 'c002', what, touch: 1, date: '2026-10-12' }] }));
        const r = eo(['record', '--event', MOCK, '--file', f]);
        assert.ok(!r.ERROR && !(r.errors || []).length, JSON.stringify(r).slice(0, 300));
      };
      rep('sent');
      rep('unsent');
      assert.ok(!listed().some((x) => x.id === 'c002' && x.touch === 1), 'c002:1 listed to send again');
      process.env.FLOORBOSS_HOME = H;
      const { verifySend, eventRecord } = await import('../lib/sendcheck.mjs');
      const r = verifySend(item, { evDir: EV, settings: { sending: { channels: ['email'], followups: 'scheduled' } }, ...eventRecord(EV), nowMs: Date.parse(at), replyCheck: false, lent: false });
      assert.equal(r.ok, false, JSON.stringify(r));
    } finally {
      if (before === undefined) delete process.env.FLOORBOSS_HOME;
      else process.env.FLOORBOSS_HOME = before;
      rmSync(H, { recursive: true, force: true });
    }
  });
