// Round 2 of the gpt-run fixes (2026-11-19/20), each with its test:
// 1. a rescheduled meeting drops the outcome of its old time (both ways a move reaches the report);
// 2. the mock event's settings save keeps connection and CRM-write keys out in hand-send, like the setup's own save;
// 3. a subject that holds an RFC 2047 encoded word is B-encoded whole in the .eml, and the checks flag it;
// 4. a critic verdict counts only for the text the critic read, and a stale reply file is never reused;
// 5. the report's CSV can't run as a formula (a leading space or line feed, a full-width "＝" too);
// 6. command output names no Claude Code feature in hand-send, and Claude Code's words are as they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { CODEX_MARKERS } from '../lib/harness.mjs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { NOW, ROOT, setup, triage, cli as hcli } from './fixtures/harness.mjs';
import { drive, simplePersona } from './sims/lib/driver.mjs';
import { MOCK, envOf, home } from './fixtures/r2.mjs';
import { untilStep } from './fixtures/flow-until.mjs';
import { buildReport, reportCsvRows, CSV_HEADERS } from '../skills/event-outreach/scripts/report.mjs';
import { toCsv, parse } from '../lib/csv.mjs';
import { emlText } from '../skills/event-outreach/scripts/mailto.mjs';
import { controlProblems } from '../skills/event-outreach/scripts/checks.mjs';
import { readLedger } from '../lib/ledger.mjs';

const CODEX = { CODEX_SESSION_ID: 'codex-sess', CODEX_THREAD_ID: 'codex-thread' };
const envFor = (HOME, codex) => {
  const env = envOf(HOME, codex ? CODEX : {});
  if (codex) delete env.CLAUDECODE;
  return env;
};
const runIn = (H, skill, args, now = null) => {
  try {
    return JSON.parse(
      execFileSync('node', [join(ROOT, 'skills', skill, 'scripts/cli.mjs'), ...args], { env: { ...H.env, ...(now ? { FLOORBOSS_NOW: now } : {}) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    );
  } catch (e) {
    return { ERROR: String(e.stderr || e.message).slice(0, 800) };
  }
};
function mock(codex) {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  const env = envFor(HOME, codex);
  execFileSync('node', [join(ROOT, 'examples/mock-event/load.mjs'), '--goal', 'buyers', '--now', NOW], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  return { HOME, now: NOW, env };
}
const mockPersona = () =>
  simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), voice_samples: 'skip', replies_since: 'none' } });
const idsOf = (ag) => ag.then[ag.then.indexOf('--ids') + 1].split(',');
const thenOf = (H, ag) => runIn(H, 'event-outreach', ag.then.slice(2));
// Runs fn with this process read as Codex (hand-send) or as Claude Code.
const asMode = (codex, fn) => {
  const before = { CLAUDECODE: process.env.CLAUDECODE, CODEX_SESSION_ID: process.env.CODEX_SESSION_ID };
  if (codex) {
    delete process.env.CLAUDECODE;
    process.env.CODEX_SESSION_ID = 'codex-sess';
  } else {
    process.env.CLAUDECODE = '1';
    delete process.env.CODEX_SESSION_ID;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};

// 1 ---------------------------------------------------------------------------------------------------------------
const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.example\nBo Li,VP Ops,Globex,bo@globex.example\nCy Ruiz,Head of Ops,Initech,cy@initech.example\n';
const DAY1_NOON = '2026-11-10T11:30:00Z';

test('1. no-show, then rescheduled: the meeting at its new time has no outcome yet (record, then the report)', () => {
  const H = setup({ attendees: LIST });
  triage(H);
  const rec = (items, now) => {
    const f = join(H.dir, `rec-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, JSON.stringify({ items }));
    return hcli(H, 'event-outreach', ['record', '--event', H.slug, '--file', f], now);
  };
  assert.equal(rec([{ who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00', said: 'Tue 10' }], NOW).applied, true);
  assert.equal(rec([{ who: 'Ana Berg', what: 'no_show', said: "she didn't come" }], DAY1_NOON).applied, true);
  const mv = rec([{ who: 'Ana Berg', what: 'rescheduled', time: '2026-11-11 11:00', said: 'moved to Wed 11:00' }], DAY1_NOON);
  assert.equal(mv.applied, true, JSON.stringify(mv));
  const out = hcli(H, 'event-outreach', ['report', '--event', H.slug], DAY1_NOON);
  assert.equal(out.counts.no_show, 0, JSON.stringify(out.counts));
  assert.equal(out.counts.upcoming, 1);
  assert.equal(out.counts.rescheduled, 1);
});

test('1. a booking moved with no unbook between (an older log): the old time\'s outcome goes too; the same time keeps it', () => {
  const at = (s) => `2026-11-${s}`;
  const entries = [
    { at: at('01T08:00:00Z'), type: 'booked', id: 'c001', slot: 's1', start: '2026-11-10T09:00:00.000Z' },
    { at: at('10T12:00:00Z'), type: 'meeting_outcome', id: 'c001', outcome: 'no_show', start: '2026-11-10T09:00:00.000Z' },
    { at: at('10T13:00:00Z'), type: 'booked', id: 'c001', slot: 's2', start: '2026-11-11T10:00:00.000Z' }
  ];
  const r = buildReport(entries, { now: new Date('2026-11-10T14:00:00Z') });
  assert.equal(r.meetings[0].outcome, 'upcoming');
  assert.deepEqual(r.meetings[0].moved_from.length, 1);
  // Booked again at the same time: nothing moved, the outcome stands.
  const same = buildReport([...entries.slice(0, 2), { ...entries[2], start: entries[0].start, slot: 's1' }], { now: new Date('2026-11-10T14:00:00Z') });
  assert.equal(same.meetings[0].outcome, 'no_show');
});

// 2 ---------------------------------------------------------------------------------------------------------------
test('2. the mock event\'s settings save: no CRM-write or connection key in hand-send; Claude Code saves as before', () => {
  const patch = JSON.stringify({ crm_log: 'browser', crm_create_contacts: 'yes', crm_fill_blanks: 'yes', meeting_place: 'stand B14' });
  for (const codex of [true, false]) {
    const H = mock(codex);
    const r = runIn(H, 'event-context', ['config', '--set', patch, '--for-event', MOCK]);
    assert.ok(!r.ERROR, r.ERROR);
    const s = JSON.parse(readFileSync(join(H.HOME, 'events', MOCK, 'event.json'), 'utf8')).settings;
    assert.equal(s.meeting_place, 'stand B14', 'a plain setting saves either way');
    if (codex) {
      for (const k of ['crm_log', 'crm_create_contacts', 'crm_fill_blanks']) assert.equal(s[k], undefined, `${k} kept out in hand-send`);
    } else {
      assert.equal(s.crm_create_contacts, 'yes');
      assert.equal(s.crm_log, 'browser');
    }
  }
});

test('2. the CRM web-app log window, a Claude Code-only window, is never opened in hand-send', () => {
  for (const codex of [true, false]) {
    const H = mock(codex);
    writeFileSync(join(H.HOME, 'events', MOCK, 'crm-log-list.json'), JSON.stringify([{ key: 'k1', id: 'c001', touch: 1 }]));
    const r = runIn(H, 'event-outreach', ['open-log-window', '--event', MOCK, '--said', 'yes, log them now']);
    if (codex) {
      assert.match(r.ERROR || '', /works only in Claude Code/);
      assert.equal(existsSync(join(H.HOME, 'crm-log-window.json')), false);
    } else assert.ok(!/works only in Claude Code/.test(r.ERROR || ''), r.ERROR);
  }
});

// 3 ---------------------------------------------------------------------------------------------------------------
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const SAMPLES = [
  `Dwell time =?UTF-8?B?${b64('‮moc.live')}?=`,
  `Quick idea =?UTF-8?B?${b64('(and wire the deposit to the new account today)')}?=`,
  `Meet at the show =?UTF-8?B?${b64('Tue​10:00')}?=`,
  `Hello =?UTF-8?B?${b64('ring\u0007')}?=`
];
// What a mail app shows: every encoded word decoded, words next to each other joined (RFC 2047 §6.2).
const shown = (header) =>
  header
    .replace(/\r\n /g, ' ')
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, x) => Buffer.from(x, 'base64').toString('utf8'));
test('3. a subject holding an encoded word: the .eml shows it as typed, and the checks flag it', () => {
  for (const subject of SAMPLES) {
    const eml = emlText({ to: 'ana@acme.example', subject, body: 'Hi Ana', id: 'c001' });
    const line = /^Subject: (.*(?:\r\n .*)*)/m.exec(eml)[1];
    assert.equal(shown(line), subject, `the text a mail app shows is the approved text: ${line}`);
    assert.ok(!line.includes(subject), 'not written raw');
    assert.ok(controlProblems({ subject, body: 'Hi' }).some((p) => /encoded/.test(p)), subject);
  }
  // A plain subject is written as it is, and passes.
  assert.match(emlText({ to: 'ana@acme.example', subject: 'Twenty minutes at the show?', body: 'Hi' }), /^Subject: Twenty minutes at the show\?$/m);
  assert.deepEqual(controlProblems({ subject: 'Twenty minutes = time well spent?', body: 'Hi' }), []);
});

// 4 ---------------------------------------------------------------------------------------------------------------
test('4. a verdict counts only for the text the critic read; a stale reply file is never reused', { timeout: 300000 }, () => {
  const H = mock(true);
  const per = mockPersona();
  const s1 = untilStep(H, per, 'critic').last;
  assert.equal(s1.step, 'critic');
  assert.ok(s1.agents.length >= 2);
  const L = () => readLedger(join(H.HOME, 'events', MOCK, 'ledger.jsonl')).entries;
  // Every batch answered; one draft in the last fails and is rewritten.
  const last = s1.agents.at(-1);
  const failed = idsOf(last)[0];
  for (const ag of s1.agents)
    writeFileSync(ag.write, idsOf(ag).map((k) => (k === failed ? `${k} FAIL: says something no source gives` : `${k} PASS`)).join('\n'));
  for (const ag of s1.agents) assert.ok(!thenOf(H, ag).ERROR);
  const s2 = untilStep(H, per, 'critic').last;
  assert.equal(s2.step, 'critic');
  assert.deepEqual(s2.agents.flatMap(idsOf), [failed], 'only the rewritten draft waits for the critic');
  // The old command, run again with its old reply: the rewritten text was never read by that critic, so nothing counts.
  const n = L().filter((x) => x.type === 'critic').length;
  const again = thenOf(H, last);
  assert.ok(again.ERROR || again.changed_since_read?.includes(failed), JSON.stringify(again).slice(0, 300));
  const newCritic = L().filter((x) => x.type === 'critic').slice(n);
  assert.ok(!newCritic.some((x) => `${x.id}:${x.touch}` === failed), 'no verdict saved for the new text');
  // A PASS for text the critic never read is refused the same way (not only a FAIL): the old command, its reply now
  // passing the rewritten draft.
  writeFileSync(last.write, idsOf(last).map((k) => `${k} PASS`).join('\n'));
  const m = L().filter((x) => x.type === 'critic').length;
  const pass = thenOf(H, last);
  assert.ok(pass.ERROR || pass.changed_since_read?.includes(failed), JSON.stringify(pass).slice(0, 300));
  assert.ok(!(pass.verdicts || []).some((v) => `${v.id}:${v.touch}` === failed), 'no PASS returned for it');
  assert.ok(!L().filter((x) => x.type === 'critic').slice(m).some((x) => `${x.id}:${x.touch}` === failed), 'no PASS saved for the new text');
  assert.equal(untilStep(H, per, 'critic').last.agents.flatMap(idsOf).join(), failed, 'it still waits for the critic');
  // The numbers started again (no batch was left), and batch 1's old reply file is gone, not read for the new batch.
  const b = s2.agents[0];
  assert.match(b.write, /critic-reply-1\.txt$/);
  assert.equal(existsSync(b.write), false, 'the old critic-reply-1.txt was removed when batch 1 was written again');
  // The command now carries the text's fingerprint, and the new batch's verdict saves.
  assert.ok(b.then.includes('--hashes'));
  writeFileSync(b.write, `${failed} PASS`);
  const ok = thenOf(H, b);
  assert.ok(!ok.ERROR, ok.ERROR);
  assert.equal(ok.verdicts[0].verdict, 'PASS');
  // The single-draft verdict refuses a fingerprint that isn't the saved text's.
  const [id, t] = failed.split(':');
  const one = runIn(H, 'event-outreach', ['verdict', '--event', MOCK, '--id', id, '--touch', t, '--text', 'PASS', '--hash', '0123456789abcdef01234567']);
  assert.match(one.ERROR || '', /changed since the critic read it/);
});

// 5 ---------------------------------------------------------------------------------------------------------------
test('5. the report\'s CSV: no cell starts a formula, a leading space, line feed or full-width sign included', () => {
  const byId = {
    c001: { name: '=HYPERLINK("http://x.example")', company: ' =1+1' },
    c002: { name: '\n=1+1', company: '＝SUM(A1)' },
    c003: { name: '\t@cmd', company: '＋1' }
  };
  const entries = [
    { at: 'a', type: 'booked', id: 'c001', slot: 's1', start: '2026-11-10T09:00:00.000Z' },
    { at: 'b', type: 'booked', id: 'c002', slot: 's2', start: '2026-11-10T10:00:00.000Z' },
    { at: 'c', type: 'booked', id: 'c003', slot: 's3', start: '2026-11-10T11:00:00.000Z' },
    { at: 'd', type: 'walkup', name: ' -2+3', company: '\r=x', date: '2026-11-10' }
  ];
  const csv = toCsv(CSV_HEADERS, reportCsvRows(buildReport(entries, { byId, now: new Date('2026-11-12T00:00:00Z') })));
  const rows = parse(csv, ',').slice(1);
  assert.equal(rows.length, 4);
  for (const v of rows.flat()) assert.doesNotMatch(v, /^[\s\u3000]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/, `a formula cell: ${JSON.stringify(v)}`);
  for (const want of ["' =1+1", "'\n=1+1", "'＝SUM(A1)", "'\t@cmd", "'＋1", "' -2+3", "'\r=x", `'=HYPERLINK(""http://x.example"")`]) assert.ok(csv.includes(want), want);
  // Ordinary text is left as it is.
  assert.equal(toCsv(['a'], [{ a: 'Acme Freight' }, { a: '2026-11-10' }]), 'a\nAcme Freight\n2026-11-10\n');
});

// 6 ---------------------------------------------------------------------------------------------------------------
const SLASH = /\/floorboss:|\bSkill tool\b|\bAgent tool\b/;
test('6. command output: no slash command or Claude Code tool in hand-send; Claude Code\'s words as they were', async () => {
  const { stalePointsNote } = await import('../skills/event-outreach/scripts/commands/calendar.mjs');
  const { briefsNext } = await import('../skills/event-outreach/scripts/commands/drafting.mjs');
  assert.equal(asMode(false, stalePointsNote), 'Talking points were built before these facts changed: run /floorboss:agenda to rebuild them.');
  assert.doesNotMatch(asMode(true, stalePointsNote), SLASH);
  assert.match(asMode(true, stalePointsNote), /next --agenda/);
  assert.equal(
    asMode(false, briefsNext),
    'Give each brief to its drafter (the Skill tool for a skill, the Agent tool for an agent), then save each answer with save-draft --json, adding "drafted_by": "<drafter>". The checks and the critic read it like any draft.'
  );
  assert.doesNotMatch(asMode(true, briefsNext), SLASH);
  for (const codex of [false, true]) {
    // An event that isn't there, and one with no list yet.
    const H = setup({});
    H.env = envFor(H.HOME, codex);
    const none = runIn(H, 'event-outreach', ['todo', '--event', 'nothing-here']);
    const empty = runIn(H, 'event-outreach', ['todo', '--event', H.slug]);
    if (codex) {
      assert.doesNotMatch(none.ERROR, SLASH);
      assert.match(none.ERROR, /No event "nothing-here" yet\. Start floorboss first/);
      assert.doesNotMatch(empty.ERROR, SLASH);
      assert.match(empty.ERROR, /has no loaded list yet\. Start floorboss first\./);
    } else {
      assert.match(none.ERROR, /Run \/floorboss:start \(or \/floorboss:event-setup mock buyers for the mock event\) first\./);
      assert.match(empty.ERROR, /has no loaded list yet\. Run \/floorboss:start first\./);
    }
  }
});

test('6. the summary\'s note about the next follow-up: "/floorboss:start" in Claude Code only', { timeout: 300000 }, () => {
  for (const codex of [false, true]) {
    const H = mock(codex);
    const r = drive(H, mockPersona(), { maxSteps: 200 });
    assert.ok(r.last.done, r.trail.join(' '));
    runIn(H, 'event-outreach', ['open', '--event', MOCK, '--no-open']);
    const html = readFileSync(join(H.HOME, 'events', MOCK, 'outbox.html'), 'utf8');
    const two = [...html.matchAll(/<article class="card[^"]*" data-id="([^"]+)" data-touch="1"[\s\S]*?<\/article>/g)].filter((m) => /href="mailto:/.test(m[0])).slice(0, 2).map((m) => m[1]);
    assert.equal(two.length, 2);
    const f = join(H.HOME, 'work', 'rec-sent.json');
    writeFileSync(f, JSON.stringify({ items: two.map((who) => ({ who, what: 'sent', date: '2026-10-12', channel: 'email' })) }));
    const rc = runIn(H, 'event-outreach', ['record', '--event', MOCK, '--file', f]);
    assert.equal(rc.applied, true, JSON.stringify(rc).slice(0, 600) + JSON.stringify(two));
    const s = runIn(H, 'event-outreach', ['summary', '--event', MOCK]);
    assert.ok(s.follow_ups_due?.length, JSON.stringify(s).slice(0, 300));
    if (codex) assert.match(s.note, /^Run floorboss again on or after \d{4}-\d{2}-\d{2}\.$/);
    else assert.match(s.note, /^Run \/floorboss:start again on or after \d{4}-\d{2}-\d{2}\.$/);
  }
});

// 7 ---------------------------------------------------------------------------------------------------------------
test('7. installing, removing or switching on the unattended job: refused from a Codex shell, even with a terminal', () => {
  const base = mkdtempSync(join(tmpdir(), 'fb-inst7-'));
  const HOME = join(base, 'home');
  mkdirSync(HOME);
  const calls = join(base, 'launchctl.log');
  const fake = join(base, 'launchctl');
  writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${calls}'\nexit 0\n`);
  chmodSync(fake, 0o755);
  const bin = join(base, 'bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  // FLOORBOSS_TTY: the test stand-in for a real terminal on both ends (it does nothing without FLOORBOSS_TEST=1).
  const env = { ...process.env, PATH: bin, HOME, FLOORBOSS_HOME: join(HOME, '.floorboss'), FLOORBOSS_TEST: '1', FLOORBOSS_PLATFORM: 'darwin', FLOORBOSS_LAUNCHCTL: fake, FLOORBOSS_TTY: '1' };
  delete env.CLAUDECODE;
  for (const k of CODEX_MARKERS) delete env[k];
  const run = (args, extra) => spawnSync(process.execPath, [join(ROOT, 'scripts/unattended.mjs'), ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  for (const k of CODEX_MARKERS)
    for (const v of ['x', '']) {
      for (const sub of [['install-brief', '--yes'], ['uninstall-brief'], ['on']]) {
        const r = run(sub, { [k]: v });
        assert.equal(r.status, 1, `${k}=${JSON.stringify(v)} ${sub[0]}: ${r.stdout}`);
        assert.match(r.stdout, /in your own terminal window, not from a Codex session/, `${k} ${sub[0]}`);
      }
    }
  assert.equal(existsSync(join(HOME, 'Library')), false, 'nothing installed');
  assert.equal(existsSync(calls), false, 'launchctl never started');
  // Claude Code's own refusal keeps its words; and with neither, in a terminal, it installs as before.
  assert.match(run(['install-brief', '--yes'], { CLAUDECODE: '1' }).stdout, /not from a Claude Code session/);
  assert.equal(run(['install-brief', '--yes'], {}).status, 0);
});
