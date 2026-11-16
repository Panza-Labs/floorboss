// The rules that keep a session from installing, loading or switching on what floorboss runs on its own, held
// against 1,563 cases from four independent reviews (test/fixtures/schedule-guard-cases.json). Each case carries
// what the first-reviewed guard decided ("old": 2 refused, 0 let through). The rule here: a form that guard refused
// is never let through, apart from a short list of exact read-only looks that were let through on purpose.
// Long runs in the fixture are written short ("@R30000|a@", {"@run":[2000,"a"]}); @ROOT, @HOME, @FB and @BASE are
// the plugin, a throwaway home, its floorboss folder and a folder beside it. @ROOTUP is the folder above the plugin,
// @ROOTBASE the plugin folder's own name, @ROOTBASEHALF that name split by a pair of quotes, @ROOTUPPER the plugin's
// path in capitals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, realpathSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const base = realpathSync(mkdtempSync(join(tmpdir(), 'fb-diff-')));
const HOME = join(base, 'home');
const fb = join(HOME, '.floorboss');
mkdirSync(join(fb, 'unattended'), { recursive: true });
mkdirSync(join(HOME, 'Library', 'LaunchAgents'), { recursive: true });
mkdirSync(join(base, 'proj'), { recursive: true });
writeFileSync(join(fb, 'unattended', 'off'), 'off\n');
symlinkSync(join(HOME, 'Library', 'LaunchAgents'), join(base, 'proj', 'la-link'));
symlinkSync(join(fb, 'unattended'), join(base, 'proj', 'un-link'));
symlinkSync(join(fb, 'today.html'), join(base, 'proj', 'today-link'));
// The guard's functions are asked in this process (fast), with the same home and working folder its own process
// is given below for a sample of the cases.
Object.assign(process.env, { HOME, USERPROFILE: HOME, FLOORBOSS_HOME: fb, CLAUDE_PLUGIN_ROOT: ROOT, FLOORBOSS_TEST: '1' });
process.chdir(join(base, 'proj'));
const g = await import('../hooks/guard.mjs');
const { schedulePathRefusal } = await import('../hooks/guard/files.mjs');

const str = (s) =>
  s
    .replace(/@R(\d+)\|([^@]*)@/g, (_, n, u) => u.repeat(Number(n)))
    // Longest first: @ROOT is the start of each of the others.
    .replaceAll('@ROOTBASEHALF', `${ROOT.split('/').pop().slice(0, 2)}''${ROOT.split('/').pop().slice(2)}`)
    .replaceAll('@ROOTUPPER', ROOT.toUpperCase())
    .replaceAll('@ROOTBASE', ROOT.split('/').pop())
    .replaceAll('@ROOTUP', ROOT.split('/').slice(0, -1).join('/'))
    .replaceAll('@ROOT', ROOT)
    .replaceAll('@HOME', HOME)
    .replaceAll('@FB', fb)
    .replaceAll('@BASE', base);
const expand = (v) =>
  typeof v === 'string'
    ? str(v)
    : Array.isArray(v)
      ? v.flatMap((x) => (x && typeof x === 'object' && x['@run'] ? Array(x['@run'][0]).fill(expand(x['@run'][1])) : [expand(x)]))
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]))
        : v;
const FILE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// The decision for one call, as hooks/guard.mjs makes it in a session with no floorboss run.
function refusal(t, i) {
  if (t === 'Bash') return g.bashRefusal(i.command) || g.scheduleRefusal(i.command);
  if (t === 'PowerShell' || t === 'Monitor') return g.scheduleRefusal(i.command);
  if (FILE_TOOLS.has(t)) return g.fileRefusal(t, i);
  if (/^mcp__/.test(t)) return g.mcpScheduleRefusal(t.replace(/^mcp__.+?__/, ''), i, schedulePathRefusal);
  return null;
}
const cases = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/schedule-guard-cases.json'), 'utf8')).map((c) => ({ ...c, input: expand(c.i) }));
const shown = (c) => (c.t === 'Bash' ? c.i.command : `${c.t} ${JSON.stringify(c.i)}`);
const now = new Map(cases.map((c) => [c, refusal(c.t, c.input) ? 2 : 0]));

// Let through on purpose, though the first-reviewed guard refused them: the exact read-only looks at floorboss's
// own job (hooks/guard/shell.mjs, readOnlyLook), and one harmless grep pattern that list admits. Nothing else.
const LOOKS = new Set([
  'cat ~/.floorboss/unattended/log.jsonl',
  'ls ~/.floorboss/unattended',
  'launchctl print gui/501/com.floorboss.brief',
  'cat ~/Library/LaunchAgents/com.floorboss.brief.plist',
  'ls -l ~/Library/LaunchAgents/com.floorboss.brief.plist',
  'plutil -lint ~/Library/LaunchAgents/com.floorboss.brief.plist',
  'Monitor {"command":"tail -f ~/.floorboss/unattended/log.jsonl"}',
  'launchctl print user/501/com.floorboss.brief',
  'launchctl list | grep com.floorboss.',
  'launchctl list | grep -i com.floorboss.brief',
  'launchctl list | grep com.floorboss.brief',
  'ls ~/Library/LaunchAgents/com.floorboss.brief.plist',
  'ls -la ~/Library/LaunchAgents/com.floorboss.brief.plist',
  'ls -al ~/Library/LaunchAgents/com.floorboss.brief.plist',
  'plutil -p ~/Library/LaunchAgents/com.floorboss.brief.plist',
  'cat @HOME/Library/LaunchAgents/com.floorboss.brief.plist',
  'ls ~/.floorboss/unattended/',
  'ls -la ~/.floorboss/unattended',
  'ls -l @FB/unattended',
  'head ~/.floorboss/unattended/log.jsonl',
  'tail ~/.floorboss/unattended/log.jsonl',
  'tail -f ~/.floorboss/unattended/log.jsonl',
  'tail -n 20 ~/.floorboss/unattended/log.jsonl',
  'head -n 5 @FB/unattended/log.jsonl',
  'wc -l ~/.floorboss/unattended/log.jsonl',
  'cat ~/.floorboss/unattended/brief-state.json',
  'cat ~/.floorboss/unattended/brief-installed.json',
  'cat ~/.floorboss/unattended/brief-told',
  'cat ~/.floorboss/unattended/off',
  ' cat ~/Library/LaunchAgents/com.floorboss.brief.plist ',
  'cat ~/Library/LaunchAgents/com.floorboss.brief.plist\n',
  'launchctl list | grep -i com.floorboss.-rf'
]);

test('refused forms never pass: all 858 the first-reviewed guard refused, but for the 32 exact read-only looks', () => {
  const refused = cases.filter((c) => c.old === 2);
  assert.equal(refused.length, 858);
  const pass = refused.filter((c) => now.get(c) === 0);
  const unexpected = pass.filter((c) => !LOOKS.has(shown(c)));
  assert.deepEqual(unexpected.map(shown), [], 'a form the first-reviewed guard refused is let through');
  assert.deepEqual([...new Set(pass.map(shown))].sort(), [...LOOKS].sort(), 'and every look on the list is still a look');
  // None of the looks can write, delete or run anything: one command each, of these programs, with no operator
  // but the one pipe into grep.
  for (const l of LOOKS) {
    const cmd = l.startsWith('Monitor ') ? JSON.parse(l.slice(8)).command : l.trim();
    assert.match(cmd, /^(cat|ls|head|tail|wc|plutil -lint|plutil -p|launchctl print|launchctl list \| grep)( |$)/, l);
    assert.doesNotMatch(cmd.replace('launchctl list | grep', ''), /[;&|<>`$(){}\\'"*?\n]/, l);
  }
});

test('the second review\'s forms: launchctl with a start word behind a redirect, a wrapper, an inner shell or odd quoting is refused', () => {
  for (const group of ['lc-sep', 'lc-prefix', 'lc-redir']) {
    const set = cases.filter((c) => c.g === group);
    assert.ok(set.length >= 16, group);
    assert.deepEqual(set.filter((c) => now.get(c) !== 2).map(shown), [], group);
  }
  // Written out in one text, these are all refused; what is left is a name built when the command runs.
  const limits = cases.filter((c) => ['lc-inner', 'lc-quote'].includes(c.g) && now.get(c) === 0).map(shown);
  assert.deepEqual(limits.sort(), [
    "V=load; launchctl $V /tmp/x.plist",
    "alias -g Z='load'; launchctl Z /tmp/x.plist",
    "launchctl $'\\154oad' /tmp/x.plist",
    "launchctl $'\\x6c\\x6f\\x61\\x64' /tmp/x.plist",
    "launchctl $'lo\\x61d' /tmp/x.plist",
    'launchctl lo?d /tmp/x.plist',
    'launchctl loa* /tmp/x.plist',
    'launchctl loa[d] /tmp/x.plist',
    'set -- load /tmp/x.plist; launchctl "$@"'
  ]);
  for (const c of ["launchctl $'load' /tmp/x.plist", '$"launchctl" load /tmp/x.plist', 'launchctl {load,/tmp/x.plist}', 'launchctl lo{a,}d /tmp/x.plist', 'launchctl asuser 501 open -a Terminal', 'launchctl bsexec 1 sh', 'launchctl 2>/dev/null load /tmp/x.plist', "sh -c'launchctl load /tmp/x.plist'", 'eval launchctl\\ load\\ /tmp/x.plist', "printf '#!/bin/sh\\nlaunchctl load /tmp/x.plist\\n' > /tmp/r.sh"])
    assert.ok(g.scheduleRefusal(c), c);
});

test('the whole table: how the 1,563 decisions moved from the first-reviewed guard, class by class', () => {
  const moved = {};
  for (const c of cases) {
    const k = `${c.old}->${now.get(c)}`;
    moved[k] = (moved[k] || 0) + 1;
  }
  // (Two more refused since the 2026-11-14 review, finding A6: launchctl setenv of FLOORBOSS_HOME and of NODE_OPTIONS.
  // One more since fix round 4 of 2026-11-15, R1-N4: "ln -s <plugin>/scripts/un*.mjs /tmp/u.mjs; node /tmp/u.mjs on",
  // a link of the plugin's folder.)
  assert.deepEqual(moved, { '2->2': 818, '2->0': 40, '0->2': 281, '0->0': 424 });
  // Newly refused: all of it is connected tools (the first-reviewed guard read none of their input), three brace
  // forms, a write to today.html, and the launchd-file rules made stricter.
  const newly = {};
  for (const c of cases) if (c.old === 0 && now.get(c) === 2) newly[c.g] = (newly[c.g] || 0) + 1;
  assert.deepEqual(newly, { 'r1-bash': 4, 'r1-files-mcp': 11, 'lc-inner': 3, 'mcp-8': 8, 'mcp-nest': 27, 'mcp-cap': 16, 'mcp-readname': 117, 'mcp-prose': 7, x: 11, x2: 7, c5: 41, h2: 29 });
  // Ordinary work the reviewers expected to pass: none of it newly refused. What is refused of it was refused by
  // the first-reviewed guard too: the stated cost of reading launchctl and a start word anywhere in one text.
  const ordinary = cases.filter((c) => c.e === 'A');
  assert.deepEqual(ordinary.filter((c) => c.old === 0 && now.get(c) === 2).map(shown), []);
  const cost = ordinary.filter((c) => now.get(c) === 2);
  assert.equal(cost.length, 33);
  assert.ok(cost.every((c) => c.old === 2 && /launchctl/.test(shown(c))));
  // Every ordinary connected-tool call passes.
  assert.deepEqual(cases.filter((c) => ['mcp-ord', 'mcp-odd'].includes(c.g) && now.get(c) !== 0).map(shown), []);
});

test('what stays a stated limit: the reviewers\' forms that still pass, each a name built at run time, a tool named as a read, or outside this rule', () => {
  const pass = cases.filter((c) => c.e === 'R' && now.get(c) === 0);
  const by = {};
  for (const c of pass) by[c.g] = (by[c.g] || 0) + 1;
  // wl-append and wl-near: "launchctl list | grep com.floorboss" (no dot after it: not the job's name) with more
  // after it; the first-reviewed guard let these through as well. mcp-readcmd: a tool named read_* or get_*.
  // mcp-nest: a name split across fields, base64, percent-encoding, a bare relative file name. x: shell writes into
  // floorboss's data folder that name nothing of the scheduled job.
  // c5: a launchd file in the old (OpenStep) format with the job's name written in octal escapes.
  assert.deepEqual(by, { 'lc-quote': 2, 'lc-inner': 7, 'wl-append': 19, 'wl-near': 3, 'mcp-nest': 6, 'mcp-readcmd': 4, x: 3, c5: 2 });
  assert.ok(pass.filter((c) => !['x', 'mcp-nest', 'mcp-readcmd', 'c5'].includes(c.g) && shown(c) !== 'launchctl list | grep -i com.floorboss.-rf').every((c) => c.old === 0), 'none of these was refused by the first-reviewed guard');
});

test('the guard\'s own process decides as these functions do (a sample of the table, and every look)', () => {
  const env = { PATH: process.env.PATH, HOME, USERPROFILE: HOME, FLOORBOSS_HOME: fb, CLAUDE_PLUGIN_ROOT: ROOT, FLOORBOSS_TEST: '1', CLAUDE_CONFIG_DIR: join(HOME, '.claude'), TMPDIR: process.env.TMPDIR };
  const sample = cases.filter((c, n) => n % 16 === 0 || (c.old === 2 && now.get(c) === 0) || ['mcp-8', 'mcp-cap', 'x2'].includes(c.g));
  assert.ok(sample.length > 130);
  for (const [n, c] of sample.entries()) {
    // Each case in a session of its own with no run under way: a case that is a floorboss script call starts one
    // (a run lock in the data folder), which would hold the cases after it to other rules than these.
    for (const f of readdirSync(fb)) if (f !== 'unattended') rmSync(join(fb, f), { recursive: true, force: true });
    const r = spawnSync(process.execPath, [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: c.t, tool_input: c.input, session_id: `s-${n}`, cwd: join(base, 'proj') }), env, encoding: 'utf8', cwd: join(base, 'proj'), maxBuffer: 1 << 26 });
    assert.equal(r.status, now.get(c), `${shown(c).slice(0, 200)}\n${r.stderr}`);
    if (r.status === 2) assert.match(r.stderr, /^floorboss blocked this call: /);
  }
});

test('the third review\'s launchd files: every one the first-reviewed guard refused for Claude\'s Write is refused again, and for a connected tool\'s write as well', () => {
  const set = cases.filter((c) => c.g === 'c5');
  assert.equal(set.length, 68);
  assert.deepEqual(set.filter((c) => c.old === 2 && now.get(c) !== 2).map((c) => `${c.t}: ${c.id}`), []);
  // The same file through a connected tool is decided as through Write.
  const byId = {};
  for (const c of set) (byId[c.id] ||= {})[c.t === 'Write' ? 'write' : 'mcp'] = now.get(c);
  assert.deepEqual(Object.entries(byId).filter(([, d]) => d.write !== d.mcp).map(([id]) => id), []);
  // The six ways to run the launcher or the install script without writing the plugin's own path out.
  for (const id of ['sh -c with ~', 'sh -c with $HOME', 'sh -c with the path split by quotes', 'WorkingDirectory = PARENT of the plugin + relative path', 'root reached through a DOT folder: .d/../', 'through a link elsewhere (/tmp/fb-link -> plugin)'])
    assert.deepEqual(byId[id], { write: 2, mcp: 2 }, id);
  // What passes: files that name nothing of floorboss's, a job's name written so that it isn't the name, and the
  // old-format octal escape (a stated limit).
  assert.deepEqual(Object.entries(byId).filter(([, d]) => d.write === 0).map(([id]) => id).sort(), [
    'OpenStep plist, label with octal escape',
    'control: another project, no mention',
    'internal DTD entity for the label',
    'label &#38;#98; (ampersand by ref)',
    'label &amp;#98; (double escaped: literal text, not the label)'
  ]);
});

test('no fixture case runs with a placeholder left in it', () => {
  for (const c of cases) assert.doesNotMatch(JSON.stringify(c.input), /@(ROOT|HOME|FB|BASE)[A-Z]*|@R\d+\|/, shown(c).slice(0, 120));
});

test('the fourth review\'s launchd files: a "<!--" that is no comment hides nothing, for Write, Edit, MultiEdit and a connected tool\'s write', () => {
  const set = cases.filter((c) => c.g === 'h2');
  assert.equal(set.length, 76);
  // Everything the first-reviewed guard refused is refused again.
  assert.deepEqual(set.filter((c) => c.old === 2 && now.get(c) !== 2).map((c) => `${c.t}: ${c.id}`), []);
  const byId = {};
  for (const c of set) (byId[c.id] ||= []).push(now.get(c));
  // The same decision whichever tool writes the file.
  assert.deepEqual(Object.entries(byId).filter(([, d]) => new Set(d).size !== 1).map(([id]) => id), []);
  // Refused: the label or either script behind a "<!--" in CDATA, a processing instruction, the XML declaration, the
  // DOCTYPE or an attribute; the scripts in &quot; or &apos;; a name next to an "x/../"; the plugin's folder.
  // Passing: another job with ordinary comments, and a file whose name only ends in "scheduled.mjs".
  assert.deepEqual(Object.entries(byId).filter(([, d]) => d[0] === 0).map(([id]) => id).sort(), ['D1 ordinary: another job, comments between elements', 'D2 ordinary: a job running rescheduled.mjs (another file name)']);
  assert.equal(Object.keys(byId).length, 19);
  // The stated side effect: the job's name inside a real comment is refused too.
  assert.deepEqual(byId['D3 harmless: the label only inside a real comment'], [2, 2, 2, 2]);
});

test('200 launchd files that Apple\'s reader reads as naming the job or a script, and that the rule let through before, are refused', () => {
  // Recorded from a review's run of 27,000 generated files against plutil (test/fixtures/launchd-files-plutil-reads.json);
  // plutil is not run here.
  const files = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/launchd-files-plutil-reads.json'), 'utf8'));
  assert.equal(files.length, 200);
  assert.ok(new Set(files.map((f) => f.k)).size >= 30, 'of many kinds');
  const file_path = join(HOME, 'Library', 'LaunchAgents', 'com.example.x.plist');
  const missed = [];
  for (const [n, f] of files.entries()) {
    const tools = [
      ['Write', { file_path, content: f.text }],
      ['Edit', { file_path, old_string: 'x', new_string: f.text }],
      ['MultiEdit', { file_path, edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'x', new_string: f.text }] }],
      ['mcp__filesystem__write_file', { path: file_path, content: f.text }]
    ];
    for (const [t, i] of tools) if (!refusal(t, i)) missed.push(`${n} ${t}: ${f.k}`);
  }
  assert.deepEqual(missed, []);
  // What the rule still lets through of that run: a different file whose name only ends in those words.
  for (const other of ['node ./-scheduled.mjs brief', 'node /srv/app/xscheduled.mjs', 'node /srv/app/myscheduled.mjs', 'node /srv/app/rescheduled.mjs', 'node /srv/app/not.unattended.mjs'])
    assert.equal(refusal('Write', { file_path, content: `<plist><dict><key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>${other}</string></array></dict></plist>` }), null, other);
});
