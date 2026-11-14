// The guard runs before every tool call in every session, so its checks have to be cheap whatever they are handed,
// and what it can't check it refuses. Measured on the real entry point (hooks/guard.mjs as a process) with the
// inputs an independent review found slow: nothing may cost more than 400 ms over an empty call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpScheduleRefusal, plainlyReads, TOO_LARGE } from '../hooks/guard/shell.mjs';
import { schedulePathRefusal, plainXml } from '../hooks/guard/files.mjs';
import { realPath } from '../lib/paths.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const base = realpathSync(mkdtempSync(join(tmpdir(), 'fb-speed-')));
const HOME = join(base, 'home');
const fb = join(HOME, '.floorboss');
mkdirSync(join(fb, 'unattended'), { recursive: true });
mkdirSync(join(HOME, 'Library', 'LaunchAgents'), { recursive: true });
mkdirSync(join(base, 'proj'), { recursive: true });
const env = { PATH: process.env.PATH, HOME, USERPROFILE: HOME, FLOORBOSS_HOME: fb, CLAUDE_PLUGIN_ROOT: ROOT, FLOORBOSS_TEST: '1', CLAUDE_CONFIG_DIR: join(HOME, '.claude') };
function guard(tool, input, extraEnv = {}) {
  const body = JSON.stringify({ tool_name: tool, tool_input: input, session_id: 's-t', cwd: join(base, 'proj') });
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [join(ROOT, 'hooks/guard.mjs')], { input: body, env: { ...env, ...extraEnv }, encoding: 'utf8', cwd: join(base, 'proj'), timeout: 60000, maxBuffer: 1 << 26 });
  return { ms: performance.now() - t0, code: r.status, sig: r.signal, err: (r.stderr || '').trim(), bytes: body.length };
}
const deepPath = '/' + 'a/'.repeat(2047); // 4,095 characters, 2,047 folders that don't exist
const midPath = '/tmp/' + 'a/'.repeat(100);
const WORST = {
  '5 MB one string (prose), write tool': ['mcp__notion__notion-create-pages', { content: 'lorem ipsum dolor sit amet. '.repeat(190000) }, 2],
  '5 MB one string (shell-ish), terminal tool': ['mcp__term__start_process', { command: 'echo "a b $(c d)" | grep \'e f\' && launchctl print x; '.repeat(96000) }, 2],
  '5 MB: 1,900 strings of prose, write tool': ['mcp__notion__notion-create-pages', { pages: Array(1900).fill('lorem ipsum dolor sit amet. '.repeat(95)) }, 2],
  '5 MB: 100,000 short strings, write tool': ['mcp__sheets__update_values', { values: Array(1000).fill(Array(100).fill('lorem ipsum dolor sit amet lorem ipsum dolor sit')) }, 2],
  '5 MB of numbers, write tool': ['mcp__sheets__update_values', { values: Array(1000).fill(Array(1000).fill(1234)) }, 2],
  '1.9 MB of prose, write tool': ['mcp__notion__notion-create-pages', { pages: Array(700).fill('lorem ipsum dolor sit amet. '.repeat(95)) }, 0],
  '10 deep paths, write tool': ['mcp__filesystem__write_files', { paths: Array(10).fill(deepPath) }, 0],
  '200 deep paths (820 KB), write tool': ['mcp__filesystem__write_files', { paths: Array(200).fill(deepPath) }, 0],
  '200 deep paths (820 KB), read tool': ['mcp__filesystem__read_multiple_files', { paths: Array(200).fill(deepPath) }, 0],
  '1,200 deep paths (4.9 MB), write tool': ['mcp__filesystem__write_files', { paths: Array(1200).fill(deepPath) }, 2],
  '1,200 deep paths (4.9 MB), read tool': ['mcp__filesystem__read_multiple_files', { paths: Array(1200).fill(deepPath) }, 0],
  '2,000 mid paths (410 KB), write tool': ['mcp__filesystem__write_files', { paths: Array(2000).fill(midPath) }, 0],
  '2,000 ordinary paths, read tool': ['mcp__filesystem__read_multiple_files', { paths: Array(2000).fill('/srv/x/proj/src/components/file.ts') }, 0],
  '2,000 ordinary paths, write tool': ['mcp__filesystem__write_files', { paths: Array(2000).fill('/srv/x/proj/src/components/file.ts') }, 0],
  'prose with slashes, one 300 KB string': ['mcp__notion__notion-create-pages', { content: 'and/or see a/b/c '.repeat(17600) }, 0],
  'prose with slashes, 200 strings of 4,000 characters': ['mcp__notion__notion-create-pages', { pages: Array(200).fill('a/b/c and/or '.repeat(307)) }, 0],
  '500 long URLs': ['mcp__sheets__update_values', { values: Array(500).fill('https://example.com/' + 'seg/'.repeat(60)) }, 0],
  '5,000 levels of nesting, tool of no known kind': ['mcp__x__y', JSON.parse('['.repeat(5000) + '"x"' + ']'.repeat(5000)), 2],
  '5,000 levels of nesting, read tool': ['mcp__x__get_y', JSON.parse('['.repeat(5000) + '"x"' + ']'.repeat(5000)), 0],
  '40,000 mentions of launchctl and no start word (1.2 MB)': ['mcp__term__start_process', { command: 'launchctl print x; launchctl list; '.repeat(34000) }, 0],
  '60 short paths that name the unattended folder, write tool': ['mcp__filesystem__write_files', { paths: Array.from({ length: 60 }, (_, i) => `/srv/proj/unattended/${i}.md`) }, 2],
  // Into a folder launchd loads from, where the text written is read by the launchd-file rule.
  '160,000 plain letters into a launchd folder, Write': ['Write', { file_path: join(HOME, 'Library', 'LaunchAgents', 'com.example.big.plist'), content: 'a'.repeat(160000) }, 0],
  '250,000 plain letters into a launchd folder, Write': ['Write', { file_path: join(HOME, 'Library', 'LaunchAgents', 'com.example.big.plist'), content: 'a'.repeat(250000) }, 0],
  '250 KB of character references into a launchd folder, Write': ['Write', { file_path: join(HOME, 'Library', 'LaunchAgents', 'com.example.big.plist'), content: '&#x63;'.repeat(41666) }, 0],
  '160,000 plain letters into a launchd folder, a connected tool': ['mcp__filesystem__write_file', { path: join(HOME, 'Library', 'LaunchAgents', 'com.example.big.plist'), content: 'a'.repeat(160000) }, 0],
  '250,000 plain letters into a launchd folder, a connected tool': ['mcp__filesystem__write_file', { path: join(HOME, 'Library', 'LaunchAgents', 'com.example.big.plist'), content: 'a'.repeat(250000) }, 0],
  '250 KB of character references into a launchd folder, a connected tool': ['mcp__filesystem__write_file', { path: join(HOME, 'Library', 'LaunchAgents', 'com.example.big.plist'), content: '&#x63;'.repeat(41666) }, 0],
  '250 KB of "x/../" into a launchd folder, Write': ['Write', { file_path: join(HOME, 'Library', 'LaunchAgents', 'com.example.big.plist'), content: 'seg/../'.repeat(35000) }, 0],
  '250 KB of slashes and dots into a launchd folder, Write': ['Write', { file_path: join(HOME, 'Library', 'LaunchAgents', 'com.example.big.plist'), content: '/./..//'.repeat(35000) }, 0]
};

test('the guard answers within 400 ms of an empty call on the slowest inputs found, and says so plainly when a call is too large to check', { timeout: 300000 }, () => {
  // The cost of starting the process at all, on this machine, right now: the quickest of five.
  const baseline = Math.min(...[1, 2, 3, 4, 5].map(() => guard('mcp__notion__notion-search', { query: 'x' }).ms));
  for (const [label, [tool, input, want]] of Object.entries(WORST)) {
    // The quickest of up to three tries: other work on the machine may slow one or two of them. (What grows with
    // the input is held by the scaling test below, which doesn't lean on the clock on the wall.)
    let r = guard(tool, input);
    for (let n = 0; n < 2 && r.ms - baseline > 400; n++) {
      const again = guard(tool, input);
      if (again.ms < r.ms) r = again;
    }
    assert.equal(r.sig, null, label);
    assert.equal(r.code, want, `${label}: ${r.err.slice(0, 160)}`);
    assert.ok(r.ms - baseline <= 400, `${label}: ${Math.round(r.ms)} ms against a baseline of ${Math.round(baseline)} ms`);
    if (want === 2) assert.match(r.err, /^floorboss blocked this call: /, label);
    assert.doesNotMatch(r.err, /couldn't check|took too long|Error|at \w+ \(/, `${label}: a plain refusal, never a failure of the guard`);
  }
  assert.equal(guard(...WORST['5 MB one string (prose), write tool']).err, `floorboss blocked this call: ${TOO_LARGE}`);
});

test('what the guard can\'t check, it refuses for any tool that isn\'t plainly a read, and lets a plain read through', () => {
  const big = { content: 'x'.repeat(2 * 1024 * 1024 + 10) };
  const under = { content: 'x'.repeat(2 * 1024 * 1024 - 100) };
  let deep = 'x';
  for (let i = 0; i < 600; i++) deep = { a: deep };
  let fine = 'x';
  for (let i = 0; i < 500; i++) fine = [fine];
  const many = { paths: Array.from({ length: 51 }, (_, i) => `/srv/p/unattended/${i}`) };
  const fifty = { paths: Array.from({ length: 50 }, (_, i) => `/srv/p/unattended/${i}`) };
  const longPath = { path: `/srv/${'d/'.repeat(600)}Library/LaunchAgents/x.plist` };
  for (const tool of ['write_file', 'start_process', 'type', 'do_thing', 'notion-create-pages']) {
    assert.equal(mcpScheduleRefusal(tool, big, schedulePathRefusal), TOO_LARGE, `${tool}: over 2 MB`);
    assert.equal(mcpScheduleRefusal(tool, deep, schedulePathRefusal), TOO_LARGE, `${tool}: nested deeper than is read`);
    assert.equal(mcpScheduleRefusal(tool, many, schedulePathRefusal), TOO_LARGE, `${tool}: more paths naming floorboss's places than are resolved`);
    assert.equal(mcpScheduleRefusal(tool, longPath, schedulePathRefusal), TOO_LARGE, `${tool}: a path too long to resolve that names a launchd folder`);
    assert.equal(mcpScheduleRefusal(tool, under, schedulePathRefusal), null, `${tool}: just under 2 MB is read and passes`);
    assert.equal(mcpScheduleRefusal(tool, fine, schedulePathRefusal), null, `${tool}: 500 levels are read`);
    assert.equal(mcpScheduleRefusal(tool, fifty, schedulePathRefusal), null, `${tool}: 50 such paths are resolved`);
    // Past the cap is never "nothing found": the name is there, behind 2 MB of padding, and the call is refused.
    assert.ok(mcpScheduleRefusal(tool, { pad: 'x'.repeat(2 * 1024 * 1024), command: 'launchctl load /tmp/x.plist' }, schedulePathRefusal));
    assert.ok(mcpScheduleRefusal(tool, { command: 'launchctl load /tmp/x.plist', pad: Array(5000).fill('a') }, schedulePathRefusal), 'found among 5,000 other values');
    assert.ok(mcpScheduleRefusal(tool, { pad: Array(5000).fill('a'), command: 'launchctl load /tmp/x.plist' }, schedulePathRefusal), 'and after them');
  }
  // Anything going wrong on the way is a refusal too, never a pass.
  const throwing = { get command() { throw new Error('boom'); } };
  assert.match(mcpScheduleRefusal('write_file', throwing, schedulePathRefusal), /couldn't be checked by floorboss's guard, so it isn't let through/);
  assert.match(mcpScheduleRefusal('write_file', { path: '/srv/x/Library/LaunchAgents/y.plist' }, () => { throw new Error('boom'); }), /couldn't be checked/);
  // A plain read is not looked at at all: large, deep, or naming every one of these words.
  for (const tool of ['read_file', 'search', 'notion-fetch', 'get_file_contents', 'list_directory', 'browser_navigate'])
    for (const input of [big, deep, many, longPath, throwing, { query: 'launchctl load com.floorboss.brief unattended.mjs install-brief' }])
      assert.equal(mcpScheduleRefusal(tool, input, () => { throw new Error('never asked'); }), null, tool);
});

test('whether a connected tool is plainly a read is decided by every word of its name', () => {
  for (const t of ['read_file', 'read_text_file', 'read_multiple_files', 'list_directory', 'list_allowed_directories', 'get_file_contents', 'search_files', 'notion-search', 'notion-fetch', 'search_threads', 'get_thread', 'list_events', 'browser_navigate', 'browser_snapshot', 'getFileInfo', 'query', 'describe_table', 'whoami'])
    assert.equal(plainlyReads(t), true, t);
  // The reviewer's list: a read word, and a word that writes beside it.
  for (const t of ['check_and_fix', 'view_edit', 'show_and_overwrite', 'read_file_then_truncate', 'fetch_to_path', 'list_append', 'lookup_upsert', 'retrieve_and_store', 'find_and_rename', 'list_and_touch'])
    assert.equal(plainlyReads(t), false, t);
  for (const t of ['write_file', 'move_file', 'create_directory', 'start_process', 'execute_command', 'type', 'send_message', 'notion-create-pages', 'update_values', 'get_and_delete', 'readAndWrite', 'search_and_replace', 'fetch_and_run', 'list_then_send', 'get_or_create', 'read_into_file', 'show_and_click', 'directory_tree', 'do_thing', '', 'x', 'get_' + 'a_'.repeat(20)])
    assert.equal(plainlyReads(t), false, JSON.stringify(t));
});

test('a path of thousands of segments is resolved in milliseconds', () => {
  const p = '/' + 'a/'.repeat(4000) + 'x';
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) realPath(p);
  const each = (performance.now() - t0) / 50;
  assert.ok(each < 20, `${each.toFixed(1)} ms each`);
  assert.equal(realPath(p), realpathSync('/') + 'a/'.repeat(4000) + 'x');
  // The same answers as before, on paths that exist in part.
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'fb-real-')));
  mkdirSync(join(d, 'one', 'two'), { recursive: true });
  assert.equal(realPath(join(d, 'one', 'two')), join(d, 'one', 'two'));
  assert.equal(realPath(join(d, 'one', 'two', 'three', 'four.txt')), join(d, 'one', 'two', 'three', 'four.txt'));
  assert.equal(realPath(join(d, 'ONE', 'x')), process.platform === 'darwin' ? join(d, 'one', 'x') : join(d, 'ONE', 'x'), 'as the disk spells it');
  assert.equal(realPath('/'), realpathSync('/'));
  assert.equal(realPath(join(d, 'one', '..', 'one', 'two', '.', 'x')), join(d, 'one', 'two', 'x'));
});

test('a call the guard finishes checking after its deadline is refused, whatever the check would have said', () => {
  // The deadline is shortened here (a test-only setting): every call is then "late".
  const late = { FLOORBOSS_GUARD_DEADLINE_MS: '0' };
  for (const [tool, input] of [['Bash', { command: 'ls' }], ['Read', { file_path: join(base, 'proj', 'x.txt') }], ['mcp__notion__notion-search', { query: 'x' }], ['Write', { file_path: join(base, 'proj', 'x.txt'), content: 'x' }]]) {
    const r = guard(tool, input, late);
    assert.equal(r.code, 2, tool);
    assert.match(r.err, /floorboss blocked this call: its guard took too long to check it/, tool);
    assert.equal(guard(tool, input).code, 0, `${tool}: in time, it passes`);
  }
  // The setting does nothing outside floorboss's own tests.
  assert.equal(guard('Bash', { command: 'ls' }, { ...late, FLOORBOSS_TEST: '' }).code, 0);
  // What is recorded after a call ran is never "blocked": there is nothing left to block.
  const post = spawnSync(process.execPath, [join(ROOT, 'hooks/guard.mjs'), 'post'], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'mcp__x__y', tool_input: {}, tool_response: {} }), env: { ...env, ...late }, encoding: 'utf8' });
  assert.equal(post.status, 0);
});

test('ordinary large or repetitive calls are not "too large": the caps count what they say they count', () => {
  const pass = (tool, input, why) => assert.equal(mcpScheduleRefusal(tool, input, schedulePathRefusal), null, why);
  const cells = (r, c, f) => Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_, j) => f(i, j)));
  // Sixty rows of a sheet that say "unattended-upgrades", a hundred inserts with mode "unattended": words, not paths.
  pass('update_values', { spreadsheetId: 's', range: 'A1', values: cells(60, 3, (i, j) => (j === 2 ? 'unattended-upgrades enabled' : `host${i}`)) }, 'a 60-row server inventory');
  pass('execute_batch', { rows: Array.from({ length: 100 }, (_, i) => ({ id: i, mode: 'unattended', site: `s${i}` })) }, '100 rows with mode "unattended"');
  pass('update_values', { values: Array(500).fill('today.html is the landing page') }, '500 cells that mention a today.html');
  // 200,000 one-digit numbers are 400 KB of values, not 4.8 MB; true and false count as their own length too.
  pass('update_values', { spreadsheetId: 's', range: 'A1', values: cells(2000, 100, (i, j) => (i * j) % 10) }, '200,000 numbers');
  pass('update_values', { values: Array(300000).fill(true) }, '300,000 booleans');
  // A Notion block tree 25 levels deep (each level is several levels of JSON).
  let block = { type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'leaf' } }] } };
  for (let i = 0; i < 25; i++) block = { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: `level ${i}` } }], children: [block] } };
  pass('API-patch-block-children', { block_id: 'x', children: [block] }, 'a block tree 25 levels deep');
  for (let i = 0; i < 60; i++) block = { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [], children: [block] } };
  pass('API-patch-block-children', { block_id: 'x', children: [block] }, 'and 85 levels deep');
  // The real caps still refuse: 2 MB of values, more than 50 slashed strings that name one of the places, a long
  // slashed one, 600 levels; and the names are still found among all of that.
  const no = (tool, input, why) => assert.equal(mcpScheduleRefusal(tool, input, schedulePathRefusal), TOO_LARGE, why);
  no('update_values', { values: Array(700000).fill(123) }, '700,000 three-digit numbers are over 2 MB');
  no('update_values', { values: Array(1100000).fill(1) }, 'so are 1,100,000 one-digit ones');
  no('update_values', { values: Array(2200000).fill([]) }, 'and two million empty lists');
  // null counts too: ten million of them are refused at once, not passed after a long walk.
  {
    const nulls = { values: Array(10000000).fill(null) };
    const t0 = performance.now();
    no('update_values', nulls, 'ten million nulls');
    assert.ok(performance.now() - t0 < 1000, `refused in ${Math.round(performance.now() - t0)} ms`);
    pass('update_values', { values: Array(100000).fill(null) }, '100,000 nulls are an ordinary sparse sheet');
  }
  no('write_files', { paths: Array.from({ length: 51 }, (_, i) => `/srv/p/unattended/${i}`) }, '51 paths into an unattended folder');
  no('write_files', { paths: Array.from({ length: 51 }, (_, i) => `C:\\srv\\LaunchAgents\\${i}.plist`) }, '51 with backslashes');
  no('write_file', { path: `/srv/${'d/'.repeat(600)}today.html` }, 'a slashed string too long to resolve');
  assert.ok(mcpScheduleRefusal('execute_batch', { rows: Array.from({ length: 100 }, (_, i) => ({ id: i, mode: 'unattended' })), then: 'launchctl load /tmp/x.plist' }, schedulePathRefusal));
  assert.ok(mcpScheduleRefusal('update_values', { values: [...Array(200000).fill(7), 'node /p/scripts/unattended.mjs install-brief --yes'] }, schedulePathRefusal));
});

test('the checks grow in step with their input: four times the text costs under six times the time', () => {
  // Measured so that a busy machine doesn't decide it: the time counted is this process's own processor time, not
  // the clock on the wall (which also counts the time spent waiting for a turn); each size is run enough times in a
  // row to take a couple of milliseconds; the quickest of five such rounds counts; and a step that looks too steep
  // is measured again (five times in all) before it fails. Work that grows with the square of its input is sixteen
  // times slower at four times the size, every time.
  const best = (fn, reps) => {
    let b = Infinity;
    const cpuMs = () => {
      const u = process.cpuUsage();
      return (u.user + u.system) / 1000;
    };
    for (let i = 0; i < 5; i++) {
      const t0 = cpuMs();
      for (let k = 0; k < reps; k++) fn();
      b = Math.min(b, Math.max(cpuMs() - t0, 0.001) / reps);
      // Nothing here should take seconds: one run that does is the answer, without the other rounds.
      assert.ok(b * reps < 3000 || reps > 1, `one run took ${Math.round(b)} ms`);
    }
    return b;
  };
  const scales = (label, make, run, sizes = [15000, 60000, 240000], bound = 6) => {
    const inputs = sizes.map(make);
    // How many runs of the smallest size make about two milliseconds.
    const once = best(() => run(inputs[0]), 1);
    const reps = Math.max(1, Math.min(400, Math.ceil(4 / Math.max(once, 0.01))));
    for (let i = 1; i < sizes.length; i++) {
      let ratio = Infinity,
        last = '';
      for (let attempt = 0; attempt < 5 && ratio >= bound; attempt++) {
        const a = best(() => run(inputs[i - 1]), Math.max(1, Math.round(reps / 4 ** (i - 1))));
        const b = best(() => run(inputs[i]), Math.max(1, Math.round(reps / 4 ** i)));
        if (b / a < ratio) {
          ratio = b / a;
          last = `${a.toFixed(3)} -> ${b.toFixed(3)} ms`;
        }
      }
      assert.ok(ratio < bound, `${label}: ${sizes[i - 1]} -> ${sizes[i]} characters took ${last}`);
    }
    assert.ok(best(() => run(inputs[inputs.length - 1]), 1) < 400, `${label}: too slow at ${sizes[sizes.length - 1]} characters`);
  };
  // The launchd-file rule's reading of what would be written.
  const rep = (unit) => (n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  for (const [label, unit] of [['plain letters', 'a'], ['character references', '&#x63;'], ['x/../ runs', 'seg/../'], ['slashes and dots', '/./..//'], ['dot folders', '/.d/../'], ['comments', '<!-- c -->x'], ['unclosed comments', '<!--'], ['CDATA markers', '<![CDATA[x]]>'], ['words and spaces', 'node /srv/x '], ['ampersands', '&#;&#x;&'], ['nested ups', 'a/b/c/../../../']])
    scales(`plainXml, ${label}`, rep(unit), (t) => plainXml(t));
  // One pass over a connected tool's input: one long string, many short ones, and many mentions with no start word.
  // At these sizes (up to 1.6 MB, read five ways) memory adds a little to each step, so the bound is under eight
  // times for four times the text; work that grew with the square of the input would be sixteen.
  scales('a connected tool, one string of prose', rep('lorem ipsum dolor sit amet. '), (t) => mcpScheduleRefusal('write_file', { content: t }, schedulePathRefusal), [100000, 400000, 1600000], 8);
  scales('a connected tool, shell-like text', rep('echo "a b $(c d)" | grep \'e f\' && launchctl print x; '), (t) => mcpScheduleRefusal('start_process', { command: t }, schedulePathRefusal), [100000, 400000, 1600000], 8);
  scales('a connected tool, many short strings', (n) => Array(Math.ceil(n / 10)).fill('lorem ips'), (v) => mcpScheduleRefusal('update_values', { values: v }, schedulePathRefusal), [100000, 400000, 1600000], 8);
  scales('a connected tool, mentions of unattended', rep('unattended and floorboss, '), (t) => mcpScheduleRefusal('create_page', { content: t }, schedulePathRefusal), [100000, 400000, 1600000], 8);
  scales('a connected tool, quotes and braces', rep('{"a",\'b\',`c`,$\'d\'} \\ '), (t) => mcpScheduleRefusal('create_page', { content: t }, schedulePathRefusal), [100000, 400000, 1600000], 8);
  // A path: resolving it, at 1,000, 4,000 and 16,000 segments.
  scales('realPath', (n) => '/' + 'a/'.repeat(n), (p) => realPath(p), [1000, 4000, 16000], 8);
});

test('the launchd-file rule reads a dot folder as a folder, and takes x/../ out whole', () => {
  assert.equal(plainXml('/srv/u/.claude/../.claude/plugins/floorboss/scripts/scheduled.mjs'), '/srv/u/.claude/plugins/floorboss/scripts/scheduled.mjs');
  assert.equal(plainXml('/a/b/../c'), '/a/c');
  assert.equal(plainXml('/a/b/c/../../d'), '/a/d');
  assert.equal(plainXml('/a/.hidden/../b'), '/a/b');
  assert.equal(plainXml('/a/..x/../b'), '/a/b', 'a name that starts with two dots is a name');
  assert.equal(plainXml('/a/../../b'), '/../b', 'what is left when there is nothing more to go up from');
  assert.equal(plainXml('../../x'), '../../x');
  assert.equal(plainXml('/A//B/./C'), '/a/b/c');
  assert.equal(plainXml('<string>/p/x/../q</string> <string>y/../z</string>'), '<string>/p/q</string> <string>z</string>');
});

test('following paths is given one second: past it a tool that writes is refused as too large, and a read is not looked at', () => {
  // A stand-in for the path check that takes 400 ms a path (a tree planted hundreds of folders deep, a chain of links).
  let asked = 0;
  const slow = () => {
    asked++;
    const end = Date.now() + 400;
    while (Date.now() < end);
    return null;
  };
  const input = { paths: Array.from({ length: 20 }, (_, i) => `/srv/deep/${i}/file.txt`) };
  const t0 = Date.now();
  assert.equal(mcpScheduleRefusal('write_files', input, slow), TOO_LARGE);
  assert.ok(asked >= 3 && asked <= 4, `stopped after ${asked} paths, not all 20`);
  assert.ok(Date.now() - t0 < 2500);
  // Within the second, every path is asked about and the call passes.
  asked = 0;
  assert.equal(mcpScheduleRefusal('write_files', { paths: ['/srv/deep/1/file.txt', '/srv/deep/2/file.txt'] }, slow), null);
  assert.equal(asked, 2);
  // A tool that plainly reads: no path is followed at all.
  asked = 0;
  assert.equal(mcpScheduleRefusal('read_multiple_files', input, slow), null);
  assert.equal(asked, 0);
});
