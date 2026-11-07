// The browser window asks when a listed note is typed and refuses other long text; onboarding answer keys are
// checked against the tree; stage-list leaves out the emails sending covers; the mock event runs without
// questions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { setup, cli, triage, draftApprove, ROOT, NOW } from './fixtures/harness.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const post = (H, tool, input, now) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs'), 'post'], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, tool_response: {} }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
const guard = (H, tool, input, now) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: tool, tool_input: input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });

test('browser window: typing a listed note asks the user by name; typing other long text is refused; clicks pass', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\n', event: { app_name: 'Grip' }, settings: { sending: { channels: ['app'], followups: 'scheduled' }, app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false } });
  triage(H); draftApprove(H);
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug]);
  const [item] = JSON.parse(readFileSync(list.browser_file, 'utf8'));
  writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at: NOW }));
  cli(H, 'event-outreach', ['browser-send', '--event', H.slug, '--said', 'go ahead, send them in Grip']);
  // The window opened on words the session wrote: its first browser call asks the user, and until that call has
  // run (the PostToolUse hook marks it) every call asks again.
  const first = guard(H, 'mcp__claude-in-chrome__computer', { action: 'left_click', coordinate: [10, 10] }, NOW);
  assert.equal(first.status, 0); assert.match(first.stdout, /"permissionDecision":"ask"/); assert.match(first.stdout, /open a browser window until/);
  assert.match(guard(H, 'mcp__claude-in-chrome__computer', { action: 'left_click', coordinate: [10, 10] }, NOW).stdout, /open a browser window until/, 'still asks before the first call ran');
  assert.equal(post(H, 'mcp__claude-in-chrome__computer', { action: 'left_click', coordinate: [10, 10] }, NOW).status, 0);
  const click = guard(H, 'mcp__claude-in-chrome__computer', { action: 'left_click', coordinate: [10, 10] }, NOW);
  assert.equal(click.status, 0); assert.equal(click.stdout, '', 'once allowed, a click asks nothing');
  const typed = guard(H, 'mcp__claude-in-chrome__computer', { action: 'type', text: item.body }, NOW);
  assert.equal(typed.status, 0, typed.stderr);
  assert.match(typed.stdout, /"permissionDecision":"ask"/);
  assert.match(typed.stdout, /about to send the note to \\"Ana Berg\\" \(c\d+/);
  const other = guard(H, 'mcp__claude-in-chrome__computer', { action: 'type', text: 'Hi Ana, '.repeat(20) + 'this is a message nobody approved, written by the session into the page.' }, NOW);
  assert.equal(other.status, 2, 'unlisted long text is refused');
  assert.match(other.stderr, /listed notes only/);
  const url = guard(H, 'mcp__claude-in-chrome__navigate', { url: 'https://app.grip.events/profile/' + 'x'.repeat(150) }, NOW);
  assert.equal(url.status, 0, 'a long URL is not text');
});

test('onboarding answer file: a question id maps to its answer; a setting question or an unknown key is refused', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const ans = (o) => { const f = join(H.dir, `a${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify(o)); return cli(H, 'event-context', ['onboarding', '--answer-file', f]); };
  assert.equal(ans({ segments: true, must_meet: true, browser: 'now' }).ERROR, undefined);
  const st = JSON.parse(readFileSync(join(H.HOME, 'onboarding.json'), 'utf8'));
  assert.equal(st.answers.segments_confirmed, true);
  assert.equal(st.answers.must_meet_asked, true);
  assert.equal(st.answers.browser_choice, 'now');
  assert.equal(st.answers.segments, undefined, 'no dead key');
  assert.match(ans({ customers: { recent: 'hold' } }).ERROR, /is a setting.*config --set-file/);
  assert.match(ans({ favourite_colour: 'blue' }).ERROR, /isn't an answer id or a question id/);
});

test('stage-list and eml leave out the emails sending covers; confirmations still stage', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', settings: { sending: { channels: ['email'], followups: 'scheduled', linkedin_ack: false } } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H); draftApprove(H);
  const s = cli(H, 'event-outreach', ['stage-list', '--event', H.slug]);
  assert.equal(s.to_stage, 0, JSON.stringify(s).slice(0, 300));
  const e = cli(H, 'event-outreach', ['eml', '--event', H.slug]);
  assert.equal(e.written, 0, JSON.stringify(e).slice(0, 300));
});

test('the mock event runs hands-off: no contacts-file question, no incomplete-list warning, a drafting mode set', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nx,y,z,\n' });
  execFileSync('node', [join(ROOT, 'examples/mock-event/load.mjs'), 'buyers'], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW }, encoding: 'utf8' });
  const m = cli({ ...H, slug: 'mock-harbour-haul' }, 'connectors', ['missing', '--event', 'mock-harbour-haul']);
  assert.deepEqual(m.by_hand, [], JSON.stringify(m.by_hand));
  const load = cli(H, 'crm-triage', ['load', '--event', 'mock-harbour-haul']);
  assert.ok(!JSON.stringify(load).includes("can't tell whether this is the whole list"));
  assert.equal(load.accounts.crm_accounts, 'apply');
  const ev = JSON.parse(readFileSync(join(H.HOME, 'events/mock-harbour-haul/event.json'), 'utf8'));
  assert.equal(ev.settings.drafting_mode, 'floorboss');
});
