// In Codex, floorboss's data folder is <project>/floorboss: Codex's sandbox lets commands write only inside the folder
// the session started in, and ~/.floorboss is outside it (and missing on a new machine). FLOORBOSS_HOME, when set,
// wins everywhere; Claude Code and unknown programs keep ~/.floorboss. Every folder here is a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { projectHome } from '../lib/paths.mjs';
import { CODEX_MARKERS } from '../lib/harness.mjs';
import { world } from './fixtures/autosend-world.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));

// A user's home folder and a project in it, both temp folders.
function place() {
  const userHome = tmp('fb-ph-user-');
  const project = join(userHome, 'work', 'acme');
  mkdirSync(project, { recursive: true });
  return { userHome, project };
}
// The environment a command gets: Codex (a marker, no CLAUDECODE), Claude Code, or nothing known. No FLOORBOSS_HOME
// unless given.
function envOf(userHome, kind, extra = {}) {
  const env = { ...process.env, HOME: userHome, USERPROFILE: userHome, FLOORBOSS_TEST: '1', ...extra };
  delete env.FLOORBOSS_HOME;
  delete env.CLAUDECODE;
  for (const k of CODEX_MARKERS) delete env[k];
  if (kind === 'codex') Object.assign(env, { CODEX_THREAD_ID: 'codex-thread', CODEX_SANDBOX: 'seatbelt' });
  if (kind === 'claude') env.CLAUDECODE = '1';
  if (extra.FLOORBOSS_HOME) env.FLOORBOSS_HOME = extra.FLOORBOSS_HOME;
  return env;
}
// home() as a floorboss script sees it, run from cwd. before: code run first (a cd, for one).
function homeFrom(cwd, env, before = '') {
  const code = `const m = await import(${JSON.stringify(join(ROOT, 'lib/paths.mjs'))}); ${before}; process.stdout.write(m.home());`;
  const r = spawnSync('node', ['--input-type=module', '-e', code], { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('the rule: FLOORBOSS_HOME wins; Codex uses <project>/floorboss; Claude Code and unknown programs keep ~/.floorboss', () => {
  const { userHome, project } = place();
  assert.equal(homeFrom(project, envOf(userHome, 'codex')), join(project, 'floorboss'));
  assert.equal(homeFrom(project, envOf(userHome, 'claude')), join(userHome, '.floorboss'));
  assert.equal(homeFrom(project, envOf(userHome, 'none')), join(userHome, '.floorboss'));
  const set = join(tmp('fb-ph-set-'), 'data');
  for (const kind of ['codex', 'claude', 'none']) assert.equal(homeFrom(project, envOf(userHome, kind, { FLOORBOSS_HOME: set })), set, kind);
  // A Claude Code started from a Codex shell carries both: the Codex marker wins (lib/harness.mjs), so does the folder.
  assert.equal(homeFrom(project, { ...envOf(userHome, 'codex'), CLAUDECODE: '1' }), join(project, 'floorboss'));
});

test('never the home folder itself, one above it, the filesystem root or a system or config folder: ~/.floorboss then', () => {
  const { userHome } = place();
  for (const cwd of [userHome, dirname(userHome), '/', '/usr', '/usr/local/bin', '/etc', '/private/etc', '/System', '/Library', '/bin', join(userHome, '.ssh'), join(userHome, '.config', 'gh'), join(userHome, '.claude')])
    assert.equal(projectHome({ cwd, userHome }), null, cwd);
  for (const cwd of ['/', '/usr', '/etc']) if (existsSync(cwd)) assert.equal(homeFrom(cwd, envOf(userHome, 'codex')), join(userHome, '.floorboss'), cwd);
  assert.equal(homeFrom(userHome, envOf(userHome, 'codex')), join(userHome, '.floorboss'));
});

test('a "floorboss" that is a link, a file or a checkout of floorboss\'s own code is never the data folder', () => {
  const { userHome, project } = place();
  const elsewhere = tmp('fb-ph-else-');
  symlinkSync(elsewhere, join(project, 'floorboss'));
  assert.equal(projectHome({ cwd: project, userHome }), null, 'a link');
  assert.equal(homeFrom(project, envOf(userHome, 'codex')), join(userHome, '.floorboss'));
  const p2 = place();
  writeFileSync(join(p2.project, 'floorboss'), 'not a folder');
  assert.equal(projectHome({ cwd: p2.project, userHome: p2.userHome }), null, 'a file');
  // The cloud task clones floorboss into ./floorboss next to its ./data: without FLOORBOSS_HOME that is no data folder.
  const p3 = place();
  mkdirSync(join(p3.project, 'floorboss', 'skills'), { recursive: true });
  writeFileSync(join(p3.project, 'floorboss', 'package.json'), '{"name":"floorboss"}');
  assert.equal(projectHome({ cwd: p3.project, userHome: p3.userHome }), null, 'the plugin checkout');
});

test('stable for the session: a cd in the script, or a command run in a subfolder, finds the same data folder', () => {
  const { userHome, project } = place();
  const env = envOf(userHome, 'codex');
  // A cd inside the process doesn't move it.
  assert.equal(homeFrom(project, env, `process.chdir(${JSON.stringify(tmpdir())})`), join(project, 'floorboss'));
  // Once it holds floorboss's data, a command started in a subfolder walks up to it.
  execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'next', '--new-run'], { cwd: project, env, encoding: 'utf8' });
  const sub = join(project, 'src', 'deep');
  mkdirSync(sub, { recursive: true });
  assert.equal(homeFrom(sub, env), join(project, 'floorboss'));
  // Not past the top of a git checkout: a project inside another one keeps its own.
  const inner = join(project, 'inner');
  mkdirSync(join(inner, '.git'), { recursive: true });
  assert.equal(homeFrom(join(inner), env), join(inner, 'floorboss'));
  assert.equal(projectHome({ cwd: join(inner, 'lib'), userHome }), join(inner, 'lib', 'floorboss'));
});

test('first run in Codex: the data folder is made in the project, kept out of the project\'s git, and nothing in ~', () => {
  const { userHome, project } = place();
  execFileSync('git', ['init', '-q', project], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  const out = JSON.parse(execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'next', '--new-run'], { cwd: project, env: envOf(userHome, 'codex'), encoding: 'utf8' }));
  assert.equal(out.step, 'disclaimer');
  const data = join(project, 'floorboss');
  assert.ok(existsSync(join(data, 'work')), 'made in the project');
  assert.ok(!existsSync(join(userHome, '.floorboss')), 'nothing in the home folder');
  // The project's own git sees no personal data: the folder's .gitignore keeps all of it out.
  const st = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: project, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.deepEqual(st.split('\n').filter(Boolean), ['?? floorboss/.gitignore'], st);
});

test('lists: one dropped in the project folder or its floorboss/work folder is read, from the project or a subfolder', () => {
  const { userHome, project } = place();
  mkdirSync(join(project, 'floorboss', 'work'), { recursive: true });
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'attendees.csv'), 'Name,Company,Email\nAna Ito,North,ana@north.example\n');
  writeFileSync(join(project, 'floorboss', 'work', 'crm.csv'), 'Name,Company,Email\nBo Li,East,bo@east.example\n');
  writeFileSync(join(project, 'secrets.yaml'), 'token: x\n');
  const otherTmp = tmp('fb-ph-tmp-');
  const check = (cwd, file, list) => {
    const code = `const m = await import(${JSON.stringify(join(ROOT, 'lib/paths.mjs'))}); try { m.allowedPath(${JSON.stringify(file)}, { list: ${list} }); process.stdout.write('ok'); } catch (e) { process.stdout.write('no: ' + e.message); }`;
    // Another temp folder for the script, so the project isn't readable just for being in the temp folder.
    return spawnSync('node', ['--input-type=module', '-e', code], { cwd, env: envOf(userHome, 'codex', { TMPDIR: otherTmp }), encoding: 'utf8' }).stdout;
  };
  for (const cwd of [project, join(project, 'src')]) {
    assert.equal(check(cwd, join(project, 'attendees.csv'), true), 'ok', cwd);
    assert.equal(check(cwd, join(project, 'floorboss', 'work', 'crm.csv'), true), 'ok', cwd);
    // Only a list: any other project file stays out of reach of a --*-file flag.
    assert.match(check(cwd, join(project, 'secrets.yaml'), false), /^no: /, cwd);
  }
});

test('auto-send on the laptop in Codex: init and sync start/end work with the data repo at <project>/floorboss', () => {
  const { userHome, project } = place();
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  // The project is a git checkout of its own; the data repo sits inside it.
  execFileSync('git', ['init', '-q', project], { env: gitEnv });
  const data = join(project, 'floorboss');
  world({ touches: 1, home: data });
  const base = tmp('fb-ph-remote-');
  const bare = join(base, 'data.git');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare], { env: gitEnv });
  const env = { ...envOf(userHome, 'codex'), GIT_CONFIG_NOSYSTEM: '1', FLOORBOSS_NOW: '2026-10-12T08:00:00Z' };
  const cli = (args) => {
    const r = spawnSync('node', [join(ROOT, 'skills/autosend/scripts/cli.mjs'), ...args], { cwd: project, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return JSON.parse(r.stdout);
  };
  const init = cli(['init', '--remote', bare]);
  assert.equal(init.pushed, true, JSON.stringify(init));
  assert.ok(existsSync(join(data, '.git')), 'the data repo is its own checkout');
  assert.equal(cli(['sync', 'start', '--who', 'laptop', '--run', 'laptop-1']).started, true);
  assert.deepEqual(cli(['sync', 'end', '--run', 'laptop-1']), { ok: true });
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', init.branch], { cwd: bare, encoding: 'utf8', env: gitEnv }).split('\n').filter(Boolean);
  assert.ok(tree.includes('events/harbor-expo/ledger.jsonl') && tree.includes('config.json'), tree.join(' '));
  assert.ok(!existsSync(join(userHome, '.floorboss')));
  // The gitignore init writes is the data repo's own (lib/autosend/sync.mjs GITIGNORE).
  assert.match(readFileSync(join(data, '.gitignore'), 'utf8'), /^\/\*$/m);
});

test('the cloud driver names FLOORBOSS_HOME on every command it gives, so the new rule never reaches it', () => {
  const driver = readFileSync(join(ROOT, 'skills/autosend/scripts/driver.mjs'), 'utf8');
  assert.match(driver, /const then = \(home, sub, run, file\) => \['env', `FLOORBOSS_HOME=\$\{home\}`/);
  const task = readFileSync(join(ROOT, 'codex/autosend-task.md'), 'utf8');
  assert.match(task, /env FLOORBOSS_HOME="RUN\/data" FLOORBOSS_AUTOSEND=cloud node/);
});

test('the words: README, the Codex skill and AGENTS.md say where the data lives in Codex', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const codex = readme.slice(readme.indexOf('## Run it in Codex'), readme.indexOf('### First run'));
  assert.match(codex, /`floorboss` folder inside the folder you start\s+Codex in/);
  assert.ok(!/--add-dir ~\/\.floorboss|mkdir -p ~\/\.floorboss/.test(codex), 'no ~/.floorboss setup step left in Codex install');
  const skill = readFileSync(join(ROOT, '.agents/skills/floorboss/SKILL.md'), 'utf8');
  assert.match(skill, /<project>\/floorboss/);
  assert.match(skill, /floorboss\/work/);
  assert.ok(!/~\/\.floorboss/.test(skill), 'the Codex skill names the data folder by its Codex place');
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  assert.ok(!/~\/\.floorboss/.test(agents));
});

test('Codex started in the floorboss checkout (the README\'s way): its data folder there is ignored, so setup can still pin the commit', () => {
  // git check-ignore --no-index reads the rules only: nothing is made in the checkout.
  for (const f of ['floorboss/config.json', 'floorboss/.gitignore', 'floorboss/.git/HEAD']) {
    const r = spawnSync('git', ['check-ignore', '--no-index', '-q', f], { cwd: ROOT, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(r.status, 0, `${f} in the checkout is ignored`);
  }
});
