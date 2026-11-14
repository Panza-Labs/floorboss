// What floorboss runs on its own is installed, loaded, changed and switched back on only from the user's own
// terminal. The guard, run as Claude Code runs it, refuses every way a session could do it (the shell, the file
// tools), in any session; turning it off and asking its status stay allowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scheduleRefusal, unattendedCall } from '../hooks/guard/shell.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const U = `${ROOT}/scripts/unattended.mjs`;
const V = '${CLAUDE_PLUGIN_ROOT}/scripts/unattended.mjs';

function world({ data = '.floorboss', home = 'home' } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'fb-guard-un-')));
  const HOME = join(base, home);
  const fb = join(HOME, data);
  mkdirSync(join(fb, 'unattended'), { recursive: true });
  mkdirSync(join(HOME, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(join(fb, 'unattended', 'off'), 'off\n');
  const env = { ...process.env, HOME, FLOORBOSS_HOME: fb, CLAUDE_PLUGIN_ROOT: ROOT };
  const guard = (tool_name, tool_input, extra = {}) => {
    const r = spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name, tool_input, ...extra }), env, encoding: 'utf8', cwd: base });
    return { code: r.status, err: r.stderr };
  };
  return { base, HOME, fb, guard, bash: (command, extra) => guard('Bash', { command }, extra), plist: join(HOME, 'Library', 'LaunchAgents', 'com.floorboss.brief.plist') };
}

test('guard: every way to install, load or switch on the scheduled job from the shell is refused, in a session that never ran floorboss', () => {
  const W = world();
  const refused = [
    // The install script, every form.
    `node "${V}" install-brief`,
    `node "${V}" install-brief --yes`,
    `node ${U} install-brief --yes`,
    `node "${U}" install-brief --yes`,
    `node '${U}' install-brief --yes`,
    `node scripts/unattended.mjs install-brief --yes`,
    `node ./scripts/unattended.mjs install-brief --yes`,
    `cd ${ROOT} && node scripts/unattended.mjs install-brief --yes`,
    `sh -c 'node ${U} install-brief --yes'`,
    `bash -lc "node ${U} install-brief --yes"`,
    `zsh -c "node ${U} on"`,
    `FLOORBOSS_HOME=/tmp/x node ${U} install-brief --yes`,
    `CLAUDECODE= node ${U} install-brief --yes`,
    `env -u CLAUDECODE node ${U} install-brief --yes`,
    `env -i node ${U} on`,
    `nohup node ${U} install-brief --yes &`,
    `echo yes | node ${U} install-brief`,
    `script -q /dev/null node ${U} install-brief`,
    `node ${U} install`,
    `node ${U} uninstall-brief`,
    `node --import /tmp/x.mjs ${U} status`,
    // Switching it back on.
    `node "${V}" on`,
    `node ${U} on`,
    `node ${U} off; node ${U} on`,
    `node ${U} off && node ${U} on`,
    `node ${U} off\nnode ${U} on`,
    `node ${U} status | node ${U} on`,
    `node ${U} off on`,
    `node ${U} off --yes`,
    `node ${U} $(echo on)`,
    `node ${U} "$X"`,
    `node ${U} o*`,
    `node ${U}`,
    // The name split by quotes or a backslash, a wildcard for it, a copy of it.
    `node ${ROOT}/scripts/unatt""ended.mjs on`,
    `node ${ROOT}/scripts/unattended.m\\js on`,
    `node ${ROOT}/scripts/unattended* on`,
    `node ${ROOT}/scripts/unattended?mjs on`,
    `cp ${U} /tmp/u.mjs && node /tmp/u.mjs on`,
    `cat ${U} | node - on`,
    `node -e "import('${U}')"`,
    // launchctl: loading, enabling or starting a job, however it is spelled.
    `launchctl bootstrap gui/501 /tmp/x.plist`,
    `launchctl load -w ~/Library/LaunchAgents/x.plist`,
    `launchctl enable gui/501/anything`,
    `launchctl kickstart -k gui/501/anything`,
    `launchctl start anything`,
    `launchctl submit -l x -- /bin/sh -c id`,
    `/bin/launchctl load /tmp/x.plist`,
    `sudo launchctl bootstrap system /tmp/x.plist`,
    `sh -c "launchctl load /tmp/x.plist"`,
    `launch""ctl load /tmp/x.plist`,
    `l\\aunchctl bootstrap gui/501 /tmp/x.plist`,
    `LAUNCHCTL LOAD /tmp/x.plist`,
    `launchctl \\\n  bootstrap gui/501 /tmp/x.plist`,
    // The job's name or its launchd file, by any tool.
    `launchctl bootout gui/501/com.floorboss.followups`,
    `launchctl bootout gui/501/com.floorboss.brief`,
    // A look at the job is allowed only as the exact read-only command: anything added to one is not.
    `launchctl print gui/501/com.floorboss.brief | sh`,
    `launchctl print gui/501/com.floorboss.brief; launchctl load /tmp/x.plist`,
    `cat ~/Library/LaunchAgents/com.floorboss.brief.plist > /tmp/copy.plist`,
    `cat ~/Library/LaunchAgents/com.floorboss.brief.plist && launchctl kickstart gui/501/x`,
    `cat "~/Library/LaunchAgents/com.floorboss.brief.plist"`,
    `plutil -convert xml1 ~/Library/LaunchAgents/com.floorboss.brief.plist`,
    `plutil -lint ~/Library/LaunchAgents/com.floorboss.brief.plist -o /tmp/x`,
    `ls ~/.floorboss/unattended/../..`,
    `cat ~/.floorboss/unattended/off; rm ~/.floorboss/unattended/off`,
    `cat ~/.floorboss/unattended/$(echo off)`,
    `tail -f ~/.floorboss/unattended/log.jsonl | sh`,
    `tee ~/.floorboss/unattended/log.jsonl`,
    // launchctl run by another command, or inside a substitution.
    `eval "launchctl load /tmp/x.plist"`,
    `echo "$(launchctl load /tmp/x.plist)"`,
    'echo `launchctl bootstrap gui/501 /tmp/x.plist`',
    `python3 -c "import os; os.system('launchctl load /tmp/x.plist')"`,
    `osascript -e 'do shell script "launchctl load /tmp/x.plist"'`,
    `xargs launchctl load < /tmp/list`,
    `true && launchctl load /tmp/x.plist`,
    `launchctl list; launchctl enable gui/501/x`,
    // Quoting the shell undoes, braces it expands, wrappers that run a command, a redirect in between.
    `launchctl $'load' /tmp/x.plist`,
    `$'launchctl' load /tmp/x.plist`,
    `launchctl $"load" /tmp/x.plist`,
    `launchctl {load,/tmp/x.plist}`,
    `launchctl lo{a,}d /tmp/x.plist`,
    `launchctl asuser 501 launchctl load /tmp/x.plist`,
    `launchctl asuser 501 open -a Terminal`,
    `launchctl bsexec 1 sh`,
    `launchctl 2>/dev/null load /tmp/x.plist`,
    `launchctl >|/tmp/o load /tmp/x.plist`,
    `sh -c'launchctl load /tmp/x.plist'`,
    `bash -ce 'launchctl load /tmp/x.plist'`,
    `eval launchctl\\ load\\ /tmp/x.plist`,
    `printf '#!/bin/sh\\nlaunchctl load /tmp/x.plist\\n' > /tmp/r.sh`,
    // The cost of reading the whole text and not the shell: launchctl, and one of those words anywhere after it,
    // is refused even where the word is not launchctl's own subcommand. Stated in SECURITY.md.
    'man launchctl | grep -A3 bootstrap',
    'launchctl list | head -5; npm run start',
    'echo "use launchctl to load the agent"',
    'git commit -m "notes on launchctl load and kickstart"',
    'grep -rn "launchctl load" docs',
    // The looks are exact: one more file, one more option, another file in the folder, and it is no longer one.
    `cat ~/Library/LaunchAgents/com.floorboss.brief.plist /etc/hosts`,
    `cat /etc/hosts ~/Library/LaunchAgents/com.floorboss.brief.plist`,
    `cat -n ~/.floorboss/unattended/log.jsonl`,
    `cat ~/.floorboss/unattended/other-file`,
    `cat ~/.floorboss/unattended/log.jsonl ~/.floorboss/config.json`,
    `cat ~/.floorboss/unattended`,
    `ls -R ~/.floorboss/unattended`,
    `tail -c 100 ~/.floorboss/unattended/log.jsonl`,
    // Writing, moving or removing today.html (reading it is fine).
    `echo hi > ~/.floorboss/today.html`,
    `rm ~/.floorboss/today.html`,
    `cp /tmp/page.html "${W.fb}/today.html"`,
    `echo x > ~/Library/LaunchAgents/com.floorboss.brief.plist`,
    `cat /tmp/p.plist >> ~/Library/LaunchAgents/com.floorboss.brief.plist`,
    `tee ~/Library/LaunchAgents/com.floorboss.brief.plist < /tmp/p.plist`,
    `cp /tmp/p.plist ~/Library/LaunchAgents/com.floorboss.brief.plist`,
    `mv /tmp/p.plist "${W.plist}"`,
    `ln -s /tmp/p.plist ~/Library/LaunchAgents/com.floorboss.brief.plist`,
    `ln -sf ~/Library/LaunchAgents/com.floorboss.brief.plist /tmp/innocent.txt`,
    `install -m 644 /tmp/p.plist ~/Library/LaunchAgents/com.floorboss.brief.plist`,
    `plutil -replace RunAtLoad -bool true ~/Library/LaunchAgents/com.floorboss.brief.plist`,
    `defaults write ~/Library/LaunchAgents/com.floorboss.brief RunAtLoad -bool true`,
    `sed -i '' s/7/8/ ~/Library/LaunchAgents/com.floorboss.brief.plist`,
    `python3 -c "open('${W.plist}','w').write(x)"`,
    `cd ~/Library/LaunchAgents && cp /tmp/p.plist com.floorboss.brief.plist`,
    `cp /tmp/p.plist ~/Library/LaunchAgents/COM.FLOORBOSS.BRIEF.plist`,
    `cp /tmp/p.plist ~/Library/LaunchAgents/com.floor""boss.brief.plist`,
    // The off switch and the unattended folder.
    `rm ~/.floorboss/unattended/off`,
    `rm -f "${W.fb}/unattended/off"`,
    `rm "$FLOORBOSS_HOME/unattended/off"`,
    `mv ~/.floorboss/unattended/off /tmp/gone`,
    `cd ~/.floorboss && rm -rf unattended`,
    `cd ~/.floorboss/unattended && rm off`,
    `rm -rf ${W.fb}/unattended`,
    `unlink ~/.floorboss/'unattended'/off`,
    `: > ~/.floorboss/unattended/off`,
    `echo '{}' > ~/.floorboss/unattended/brief-state.json`,
    `find ~/.floorboss -path '*unattended/off' -delete`
  ];
  for (const c of refused) {
    const r = W.bash(c);
    assert.equal(r.code, 2, `not refused: ${c}\n${r.err}`);
    assert.match(r.err, /^floorboss blocked this call: /, c);
  }
  assert.match(W.bash(`node ${U} on`).err, /from your own terminal, never from a Claude session\. Turning it off is always allowed/);
  assert.ok(existsSync(join(W.fb, 'unattended', 'off')), 'the guard only judges: the off file is still there');
  // Other tools that run shell commands.
  assert.equal(W.guard('Monitor', { command: 'launchctl load /tmp/x.plist' }).code, 2);
  assert.equal(W.guard('PowerShell', { command: `node ${U} install-brief --yes` }).code, 2);
  assert.equal(W.guard('Monitor', { command: 'tail -f /tmp/x.log' }).code, 0);
});

test('guard: turning unattended runs off, and asking their status, is allowed; so is everything unrelated', () => {
  const W = world();
  const allowed = [
    `node "${V}" off`,
    `node "${V}" status`,
    `node ${V} off`,
    `node ${U} off`,
    `node "${U}" status`,
    `node '${U}' off`,
    // Looking at floorboss's own job: these exact read-only commands.
    'launchctl print gui/501/com.floorboss.brief',
    'launchctl list | grep com.floorboss',
    'cat ~/Library/LaunchAgents/com.floorboss.brief.plist',
    'ls -l ~/Library/LaunchAgents/com.floorboss.brief.plist',
    'plutil -lint ~/Library/LaunchAgents/com.floorboss.brief.plist',
    `cat ${W.HOME}/Library/LaunchAgents/com.floorboss.brief.plist`,
    'ls ~/.floorboss/unattended',
    'ls -la ~/.floorboss/unattended/',
    'cat ~/.floorboss/unattended/log.jsonl',
    'tail -n 20 ~/.floorboss/unattended/log.jsonl',
    `cat ${W.fb}/unattended/brief-state.json`,
    // launchctl with no word that loads or starts a job anywhere after it.
    'launchctl list | grep postgres',
    'launchctl stop com.example.dev',
    'man launchctl',
    'launchctl list | head -5',
    'brew services start postgresql@16',
    'npm run start; launchctl list',
    './bootstrap.sh && npm start',
    // Everyday work.
    'git status', 'git add -A && git commit -m "fix: typo"', 'git checkout -b feature/unattended-brief', 'git commit -m "docs: unattended runs"',
    'npm install', 'npm test', 'npm run start', 'node server.js', 'node scripts/build.mjs', 'yarn start',
    'grep -rn "TODO" src', 'rg bootstrap -l', 'find . -name "*.plist"', 'make bootstrap', 'docker compose up -d',
    'brew services list', 'open index.html', 'ps aux | grep node', 'crontab -l', './setup.sh --unattended', 'ansible-playbook site.yml --tags unattended',
    'DEBIAN_FRONTEND=noninteractive apt-get -y upgrade', 'launchctl unload ~/Library/LaunchAgents/com.example.dev.plist', 'launchctl bootout gui/501/com.example.dev',
    'plutil -lint ~/Library/LaunchAgents/com.example.dev.plist', 'cat ~/Library/LaunchAgents/com.example.dev.plist', 'ls ~/.floorboss', 'ls ~/.floorboss/events', 'open ~/.floorboss/today.html',
    // Unrelated commands are none of this rule's business.
    'launchctl list',
    'launchctl print gui/501',
    'launchctl bootout gui/501/com.example.other',
    'ls ~/Library/LaunchAgents',
    'cp /tmp/p.plist ~/Library/LaunchAgents/com.example.other.plist',
    'sudo apt-get install unattended-upgrades',
    'ls /srv/ansible/unattended',
    'git log --oneline -5',
    'echo download the bootstrap script and start it',
    'node --test test/security-unattended.test.mjs'
  ];
  for (const c of allowed) {
    const r = W.bash(c);
    assert.equal(r.code, 0, `refused: ${c}\n${r.err}`);
  }
  assert.equal(unattendedCall(`node "${U}" off`), 'off');
  assert.equal(unattendedCall(`node "${U}" status`), 'status');
  assert.equal(unattendedCall(`node "${U}" on`), null);
  assert.equal(unattendedCall(`node /tmp/scripts/unattended.mjs off`), null, 'only the script under the plugin folder');
  assert.equal(scheduleRefusal('ls -la'), null);
});

test('guard: in the session that ran floorboss, off and status still pass, and on is still refused', () => {
  const W = world();
  const s = { session_id: 'sess-ran' };
  // A floorboss script call ties the run to this session (the guard doesn't run it).
  assert.equal(W.bash('node "${CLAUDE_PLUGIN_ROOT}/skills/flow/scripts/cli.mjs" next', s).code, 0);
  const held = W.bash('ls', s);
  assert.equal(held.code, 2);
  assert.match(held.err, /limited to floorboss's own scripts/);
  assert.equal(W.bash(`node "${V}" off`, s).code, 0, 'off: it only reduces what can happen');
  assert.equal(W.bash(`node "${V}" status`, s).code, 0);
  assert.equal(W.bash(`node "${V}" on`, s).code, 2);
  assert.equal(W.bash(`node "${V}" install-brief --yes`, s).code, 2);
  assert.equal(W.bash('launchctl list', s).code, 2, 'like any other command there');
  // A subagent while a run is live.
  assert.equal(W.bash(`node "${V}" off`, { session_id: 'x', agent_id: 'a1' }).code, 0);
  assert.equal(W.bash(`node "${V}" on`, { session_id: 'x', agent_id: 'a1' }).code, 2);
  // And the scheduled launcher isn't one of the scripts a session runs.
  assert.equal(W.bash('node "${CLAUDE_PLUGIN_ROOT}/scripts/scheduled.mjs" brief').code, 2);
});

test('guard: Claude\'s file tools can\'t write the launchd file or anything in the unattended folder', () => {
  const W = world();
  const plistText = '<plist><dict><key>Label</key><string>x</string></dict></plist>';
  const no = (tool, input, why) => {
    const r = W.guard(tool, input);
    assert.equal(r.code, 2, `${why}: ${JSON.stringify(input).slice(0, 120)}\n${r.err}`);
    return r.err;
  };
  // The launchd file itself.
  assert.match(no('Write', { file_path: W.plist, content: plistText }, 'Write'), /installed and changed only by you, the user, from your own terminal/);
  no('Edit', { file_path: W.plist, old_string: '<integer>7</integer>', new_string: '<integer>8</integer>' }, 'Edit');
  no('MultiEdit', { file_path: W.plist, edits: [{ old_string: 'a', new_string: 'b' }] }, 'MultiEdit');
  no('Write', { file_path: '~/Library/LaunchAgents/com.floorboss.brief.plist', content: plistText }, 'the ~ spelling');
  no('Write', { file_path: join(W.HOME, 'Library', 'LaunchAgents', 'COM.Floorboss.Followups.plist'), content: plistText }, 'any floorboss job, any case');
  // Through a link, existing or dangling.
  const link = join(W.base, 'innocent.txt');
  symlinkSync(W.plist, link);
  no('Write', { file_path: link, content: plistText }, 'a dangling link to it');
  const dirLink = join(W.base, 'agents');
  symlinkSync(join(W.HOME, 'Library', 'LaunchAgents'), dirLink);
  no('Write', { file_path: join(dirLink, 'com.floorboss.brief.plist'), content: plistText }, 'a linked folder');
  // Another name in a folder launchd loads from, with floorboss's job, launcher or install script in its text.
  const other = join(W.HOME, 'Library', 'LaunchAgents', 'com.example.helper.plist');
  no('Write', { file_path: other, content: `<string>${ROOT}/scripts/scheduled.mjs</string>` }, 'names the launcher');
  no('Write', { file_path: other, content: '<string>com.floorboss.brief</string>' }, 'names the job');
  no('Edit', { file_path: other, old_string: 'x', new_string: `${ROOT}/scripts/unattended.mjs` }, 'names the install script');
  no('MultiEdit', { file_path: other, edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'a', new_string: `node ${ROOT}/scripts/scheduled.mjs` }] }, 'in a later edit');
  no('MultiEdit', { file_path: other, edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'a', new_string: 'node /p/scheduled.mjs' }] }, 'a scheduled.mjs anywhere, in a later edit');
  // A launchd file that runs a scheduled.mjs or an unattended.mjs is refused however the way to it is written: the
  // plugin's own path need not be in it. (Another project's own script of that name is refused with it: a stated cost.)
  const RUNS = {
    'through ~, in a shell': '<array><string>/bin/sh</string><string>-c</string><string>node ~/.claude/plugins/cache/floorboss/scripts/scheduled.mjs brief</string></array>',
    'through the plugin variable': `<array><string>/bin/sh</string><string>-c</string><string>node "\${CLAUDE_PLUGIN_ROOT}/scripts/scheduled.mjs" brief</string></array>`,
    'after a cd to the folder above': `<array><string>/bin/sh</string><string>-c</string><string>cd ${ROOT.split('/').slice(0, -1).join('/')} &amp;&amp; node ${ROOT.split('/').pop()}/scripts/scheduled.mjs brief</string></array>`,
    'a working folder above the plugin and a relative path': `<key>WorkingDirectory</key><string>${ROOT.split('/').slice(0, -1).join('/')}</string><key>ProgramArguments</key><array><string>/usr/local/bin/node</string><string>${ROOT.split('/').pop()}/scripts/scheduled.mjs</string><string>brief</string></array>`,
    'through a dot folder': '<array><string>/usr/local/bin/node</string><string>/srv/u/.claude/../.claude/plugins/floorboss/scripts/scheduled.mjs</string><string>brief</string></array>',
    'the install script itself': '<array><string>/bin/sh</string><string>-c</string><string>node ~/.claude/plugins/cache/floorboss/scripts/unattended.mjs install-brief --yes</string></array>',
    'another project\'s own scheduled.mjs': '<array><string>/usr/local/bin/node</string><string>/srv/dev/myapp/scheduled.mjs</string></array>'
  };
  for (const [how, content] of Object.entries(RUNS)) {
    no('Write', { file_path: other, content }, `Write: ${how}`);
    no('Edit', { file_path: other, old_string: '<array/>', new_string: content }, `Edit: ${how}`);
    no('MultiEdit', { file_path: other, edits: [{ old_string: 'a', new_string: 'b' }, { old_string: '<array/>', new_string: content }] }, `MultiEdit: ${how}`);
    assert.equal(W.guard('mcp__filesystem__write_file', { path: other, content }).code, 2, `a connected tool's write: ${how}`);
  }
  // A "<!--" is a comment only where XML says so. Inside CDATA, a processing instruction, the XML declaration, the
  // DOCTYPE or an attribute it is text, and Apple's reader goes on to read the job's name or the script after it.
  const HEAD = '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>', TAIL = '</dict></plist>';
  const LAB = '<key>Label</key><string>com.floorboss.brief</string><key>ProgramArguments</key><array><string>/bin/true</string></array>';
  const sh = (cmd) => `<key>Label</key><string>com.example.x</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>${cmd}</string></array>`;
  const RUN = sh('node ~/.claude/plugins/cache/floorboss/scripts/scheduled.mjs brief');
  const INST = sh('node ~/.claude/plugins/cache/floorboss/scripts/unattended.mjs install-brief --yes');
  const HIDDEN = {
    'CDATA, then the label': `${HEAD}<key>k</key><string><![CDATA[<!--]]></string>${LAB}${TAIL}`,
    'CDATA, then the launcher': `${HEAD}<key>k</key><string><![CDATA[<!--]]></string>${RUN}${TAIL}`,
    'CDATA, then the install script': `${HEAD}<key>k</key><string><![CDATA[<!--]]></string>${INST}${TAIL}`,
    'a processing instruction, then the launcher': `${HEAD}<?x <!-- ?>${RUN}${TAIL}`,
    'a processing instruction, then the label': `${HEAD}<?x <!-- ?>${LAB}${TAIL}`,
    'the XML declaration, then the launcher': `<?xml version="1.0" x="<!--"?><plist version="1.0"><dict>${RUN}${TAIL}`,
    'the XML declaration, then the install script': `<?xml version="1.0" x="<!--"?><plist version="1.0"><dict>${INST}${TAIL}`,
    'the DOCTYPE, then the launcher': `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "<!--" "x"><plist version="1.0"><dict>${RUN}${TAIL}`,
    'the DOCTYPE, then the label': `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "<!--" "x"><plist version="1.0"><dict>${LAB}${TAIL}`,
    'an attribute, then the label': `<plist version="<!--"><dict>${LAB}${TAIL}`,
    'an attribute, then the install script': `<plist version="<!--"><dict>${INST}${TAIL}`,
    'CDATA, the launcher, and a "-->" in a later CDATA': `${HEAD}<key>k</key><string><![CDATA[<!--]]></string>${RUN}<key>z</key><string><![CDATA[-->]]></string>${TAIL}`,
    'CDATA, then the label in character references': `${HEAD}<key>k</key><string><![CDATA[<!--]]></string><key>Label</key><string>com.floor&#98;oss.brief</string>${TAIL}`,
    'CDATA, then the plugin folder by its path': `${HEAD}<key>k</key><string><![CDATA[<!--]]></string>${sh(`node ${ROOT}/skills/event-outreach/scripts/cli.mjs`)}${TAIL}`,
    'the script in &quot;': HEAD + sh('cd ~/.claude/plugins/cache/floorboss/scripts &amp;&amp; node &quot;scheduled.mjs&quot; brief') + TAIL,
    'the script in &apos;': HEAD + sh('cd ~/.claude/plugins/cache/floorboss/scripts; node &apos;unattended.mjs&apos; install-brief --yes') + TAIL,
    'the script after &lt; and &gt;': HEAD + sh('node &lt;scheduled.mjs&gt;') + TAIL,
    // Taking "x/../" out of a path must never take a name out with it.
    'a folder named with "<" before x/../': HEAD + sh('cd ~/.claude/plugins/cache/floorboss/scripts; node "a&#60;b/../scheduled.mjs" brief') + TAIL,
    'the label followed by /../': `${HEAD}<key>Label</key><string>com.floorboss.brief/../x</string>${TAIL}`,
    // The stated side effect: the job's name inside a real comment is refused as well.
    'the label inside a real comment': `${HEAD}<!-- not com.floorboss.brief --><key>Label</key><string>com.example.x</string>${TAIL}`
  };
  for (const [how, content] of Object.entries(HIDDEN)) {
    no('Write', { file_path: other, content }, `Write: ${how}`);
    no('Edit', { file_path: other, old_string: 'x', new_string: content }, `Edit: ${how}`);
    no('MultiEdit', { file_path: other, edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'x', new_string: content }] }, `MultiEdit: ${how}`);
    assert.equal(W.guard('mcp__filesystem__write_file', { path: other, content }).code, 2, `a connected tool's write: ${how}`);
  }
  // Ordinary files pass: another job with comments between its elements, and a file whose name only ends in the
  // same words (rescheduled.mjs, my-scheduled.mjs).
  for (const content of [
    `${HEAD}<!-- nightly --><key>Label</key><string>com.example.x</string><!-- runs at 2 --><key>ProgramArguments</key><array><string>/usr/local/bin/node</string><string>/srv/app/nightly.mjs</string></array>${TAIL}`,
    HEAD + sh('node /srv/app/rescheduled.mjs') + TAIL,
    HEAD + sh('node /srv/app/my-scheduled.mjs') + TAIL
  ]) {
    assert.equal(W.guard('Write', { file_path: other, content }).code, 0, content.slice(60, 160));
    assert.equal(W.guard('mcp__filesystem__write_file', { path: other, content }).code, 0, content.slice(60, 160));
  }
  // The plugin's folder is matched as a whole path: a folder beside it whose name starts the same way is another folder.
  assert.equal(W.guard('Write', { file_path: other, content: `<string>${ROOT}-backup/tool.sh</string>` }).code, 0);
  assert.equal(W.guard('Write', { file_path: other, content: `<string>/srv/mirror${ROOT}x/tool.sh</string>` }).code, 0);
  no('Write', { file_path: other, content: `<key>WorkingDirectory</key><string>${ROOT}</string>` }, 'the plugin folder itself, with nothing after it');
  no('Write', { file_path: other, content: `<string>cd "${ROOT}"; ./x.sh</string>` }, 'the plugin folder in quotes');
  // The same text written anywhere else is nobody's business.
  assert.equal(W.guard('Write', { file_path: join(W.base, 'notes', 'job.plist'), content: RUNS['through ~, in a shell'] }).code, 0);
  // A dot folder is a folder: its name is not cut after the dot when "x/../" is taken out of a path.
  no('Write', { file_path: other, content: `<string>${ROOT.split('/').slice(0, -1).join('/')}/.cache/../${ROOT.split('/').pop()}/package.json</string>` }, 'x/../ through a dot folder, into the plugin');
  no('Write', { file_path: other, content: `<string>${ROOT}/scripts/&#115;cheduled.mjs</string><string>brief</string>` }, 'the launcher, a letter written as an XML character reference');
  no('Write', { file_path: other, content: '<key>Label</key><string>com.floor&#x62;oss.brief</string>' }, 'the job, likewise');
  no('Write', { file_path: other, content: `<string>${ROOT.toUpperCase()}/SCRIPTS/SCHEDULED.MJS</string>` }, 'in capitals');
  no('Write', { file_path: join(W.HOME, 'library', 'launchagents', 'COM.FLOORBOSS.BRIEF.PLIST'), content: plistText }, 'the folder in another case');
  no('NotebookEdit', { notebook_path: W.plist, new_source: 'x' }, 'NotebookEdit');
  // The same names written the long way round, as launchd would still read them.
  no('Write', { file_path: other, content: '<key>Label</key><string>com.floor&#x0000062;oss.brief</string>' }, 'hex, leading zeros');
  no('Write', { file_path: other, content: '<key>Label</key><string>com.floor&#00000098;oss.brief</string>' }, 'decimal, leading zeros');
  no('Write', { file_path: other, content: '<key>Label</key><string>com.floor<![CDATA[boss]]>.brief</string>' }, 'a CDATA section');
  no('Write', { file_path: other, content: '<key>Label</key><string>com.floor<!-- c -->boss.brief</string>' }, 'a comment in the middle');
  no('Write', { file_path: other, content: `<string>${ROOT}/scripts/<![CDATA[scheduled]]>.mjs</string>` }, 'CDATA in the path');
  no('Write', { file_path: other, content: `<string>${ROOT}/scripts/../scripts/scheduled.mjs</string>` }, 'x/../ in the path');
  no('Write', { file_path: other, content: `<string>${ROOT}//scripts/./scheduled.mjs</string>` }, '// and /./ in the path');
  no('Write', { file_path: other, content: `<string>${ROOT.split('/').slice(0, -1).join('/')}/x/../${ROOT.split('/').pop()}/scripts/unattended.mjs</string>` }, 'x/../ above the plugin folder');
  no('Write', { file_path: other, content: `<key>WorkingDirectory</key><string>${ROOT}/scripts</string><key>ProgramArguments</key><array><string>/usr/local/bin/node</string><string>scheduled.mjs</string><string>brief</string></array>` }, 'the scripts folder as working folder, the script named bare');
  no('Write', { file_path: other, content: `<string>/bin/sh</string><string>-c</string><string>cd ${ROOT} && node scripts/sched*.mjs brief</string>` }, 'a wildcard inside the plugin folder');
  no('Write', { file_path: other, content: `<string>x</string>${' '.repeat(300 * 1024)}<string>${ROOT}/scripts/scheduled.mjs</string>` }, 'behind more text than a launchd file ever holds');
  // Character references that are no characters at all change nothing.
  assert.equal(W.guard('Write', { file_path: other, content: '<string>&#x;&#;&#xzz;&#99999999999;&#x110000;&#xD800;&#0;</string>' }).code, 0);
  // An unrelated job's file is the user's own business.
  assert.equal(W.guard('Write', { file_path: other, content: '<string>/usr/bin/true</string>' }).code, 0);
  assert.equal(W.guard('Write', { file_path: join(W.HOME, 'Library', 'LaunchAgents', 'com.example.cron.plist'), content: '<array><string>/usr/local/bin/node</string><string>/srv/myapp/nightly.mjs</string></array>' }).code, 0, 'another project\'s own script');
  assert.equal(W.guard('Edit', { file_path: other, old_string: '<integer>7</integer>', new_string: '<integer>8</integer>' }).code, 0);
  assert.equal(W.guard('Write', { file_path: join(W.base, 'proj-notes.md'), content: 'Run node scripts/unattended.mjs install-brief; the job is com.floorboss.brief' }).code, 0, 'a note elsewhere that names them');
  assert.equal(W.guard('Read', { file_path: W.plist }).code, 0, 'reading it is fine');

  // The unattended folder: the off switch, the log, the launcher's state. And today.html.
  for (const f of ['unattended/off', 'unattended/log.jsonl', 'unattended/brief-state.json', 'unattended/brief-installed.json', 'unattended/new-file', 'today.html']) {
    const p = join(W.fb, f);
    assert.match(no('Write', { file_path: p, content: '' }, f), /one of floorboss's own records/);
    no('Edit', { file_path: p, old_string: 'off', new_string: '' }, f);
  }
  no('Write', { file_path: '~/.floorboss/unattended/off', content: '' }, 'the ~ spelling');
  assert.ok(existsSync(join(W.fb, 'unattended', 'off')));
});

test('guard: a look at the job is refused when the home folder\'s own name could be read by the shell', () => {
  // The looks are allowed only as plain characters. With a home folder named like this, "cat <home>/Library/…"
  // unquoted would run the $(…) in it: no longer a look.
  const W = world({ home: 'ho$(touch pwned)me' });
  for (const c of [`cat ${W.HOME}/Library/LaunchAgents/com.floorboss.brief.plist`, `ls -l ${W.HOME}/Library/LaunchAgents/com.floorboss.brief.plist`, `cat ${W.fb}/unattended/log.jsonl`, `ls ${W.fb}/unattended`])
    assert.equal(W.bash(c).code, 2, c);
  // With ~ the shell never sees that name, and the look is a look.
  assert.equal(W.bash('cat ~/Library/LaunchAgents/com.floorboss.brief.plist').code, 0);
});

test('guard: a connected tool (MCP) that runs commands, types or writes files is held to the same names, in a session with no floorboss run', () => {
  const W = world();
  const no = (tool, input, why) => {
    const r = W.guard(tool, input);
    assert.equal(r.code, 2, `not refused (${why}): ${tool} ${JSON.stringify(input).slice(0, 140)}\n${r.err}`);
    assert.match(r.err, /^floorboss blocked this call: /);
    return r.err;
  };
  // The first review's eight.
  no('mcp__desktop-commander__start_process', { command: `node ${U} install-brief --yes` }, 'a terminal server: the install');
  no('mcp__desktop-commander__start_process', { command: 'launchctl load /tmp/x.plist' }, 'a terminal server: launchctl');
  no('mcp__desktop-commander__execute_command', { command: `node ${U} on` }, 'a terminal server: on');
  no('mcp__computer-use__type', { text: `node ${U} install-brief --yes\n` }, 'typed into a terminal on screen');
  no('mcp__filesystem__write_file', { path: W.plist, content: 'x' }, 'the launchd file');
  no('mcp__filesystem__write_file', { path: join(W.fb, 'unattended', 'off'), content: 'x' }, 'the off switch');
  no('mcp__filesystem__move_file', { source: join(W.fb, 'unattended', 'off'), destination: '/tmp/x' }, 'moving the off switch away');
  no('mcp__filesystem__write_file', { path: join(W.fb, 'today.html'), content: '<script>' }, 'today.html');
  // A command given in pieces, deeper in the input, under other names, behind a redirect.
  no('mcp__term__start_process', { command: 'launchctl', args: ['load', '/tmp/x.plist'] }, 'the program in one field, its arguments in the next');
  no('mcp__term__start_process', { argv: ['node', U, 'install-brief', '--yes'] }, 'an argument list');
  no('mcp__term__start_process', { argv: ['/bin/launchctl', 'bootstrap', 'gui/501', '/tmp/x.plist'] }, 'an argument list');
  no('mcp__shell__run', { steps: [{ name: 'a', args: { cmd: ['launchctl bootstrap gui/501 /tmp/x.plist'] } }] }, 'nested');
  no('mcp__shell__run', { script: 'sh -c "launchctl kickstart -k gui/501/x"' }, 'another field name');
  no('mcp__desktop-commander__start_process', { command: 'launchctl 2>/dev/null load /tmp/x.plist' }, 'a redirect in between');
  no('mcp__desktop-commander__start_process', { command: `node -e "require('child_process').execSync('launchctl load /tmp/x.plist')"` }, 'through an interpreter, written out');
  no('mcp__computer-use__type', { text: 'launchctl >/dev/null load /tmp/x.plist\n' }, 'typed');
  no('mcp__desktop-commander__start_process', { command: `cd ${W.fb} && rm -r unattended` }, 'the folder, from inside the data folder');
  no('mcp__desktop-commander__start_process', { command: 'cd ~/.floorboss; cd unattended; rm off' }, 'step by step');
  no('mcp__desktop-commander__start_process', { command: 'cd ~/.floorboss && mv unattended u2' }, 'moved aside');
  no('mcp__filesystem__write_file', { path: '~/Library/LaunchAgents/com.floorboss.brief.plist', content: 'x' }, 'the ~ spelling');
  no('mcp__filesystem__edit_file', { path: join(W.fb, 'unattended', 'brief-state.json'), edits: [] }, 'the launcher\'s state');
  no('mcp__filesystem__create_directory', { path: join(W.fb, 'unattended') }, 'the folder itself');
  // By where a path leads, not what it is called: a link to the launchd file, and to the unattended folder.
  const link = join(W.base, 'innocent.txt');
  symlinkSync(W.plist, link);
  no('mcp__filesystem__write_file', { path: link, content: 'x' }, 'a link to the launchd file');
  mkdirSync(join(W.base, 'proj'));
  symlinkSync(join(W.fb, 'unattended'), join(W.base, 'proj', 'un-link'));
  no('mcp__filesystem__write_file', { path: join(W.base, 'proj', 'un-link', 'off'), content: '' }, 'a linked folder');
  // floorboss's other records are not a connected tool's to write either (the page a saved agenda is kept by).
  no('mcp__filesystem__write_file', { path: join(W.fb, 'events', 'ev', 'agenda.html'), content: '<script>alert(1)</script>' }, 'an agenda page');
  no('mcp__filesystem__write_file', { path: join(W.fb, 'events', 'ev', 'derived', 'agenda-full.json'), content: '{}' }, 'a saved agenda\'s marker');
  no('mcp__filesystem__write_file', { path: join(W.fb, 'events', 'ev', 'ledger.jsonl'), content: '{}' }, 'a ledger');
  // Another job's launchd file whose text points into this plugin, and the folder launchd loads from.
  const other = join(W.HOME, 'Library', 'LaunchAgents', 'com.example.x.plist');
  no('mcp__filesystem__write_file', { path: other, content: `<string>${ROOT}/scripts/scheduled.mjs</string><string>brief</string>` }, 'another job running the launcher');
  no('mcp__filesystem__write_file', { path: other, content: `<string>/bin/sh</string><string>-c</string><string>node ${ROOT}/scripts/sched*.mjs brief</string>` }, 'by a wildcard');
  no('mcp__filesystem__write_file', { path: other, content: '<key>Label</key><string>com.floor&#00000098;oss.brief</string>' }, 'the job\'s name as a character reference');
  no('mcp__filesystem__move_file', { source: join(W.HOME, 'Library', 'LaunchAgents'), destination: '/tmp/la' }, 'the launchd folder itself');
  // A data folder whose name doesn't say floorboss: found by the folder's own path.
  const W2 = world({ data: 'data' });
  for (const [tool, input] of [['mcp__filesystem__write_file', { path: join(W2.fb, 'unattended', 'off'), content: '' }], ['mcp__filesystem__move_file', { source: join(W2.fb, 'unattended', 'off'), destination: '/tmp/x' }], ['mcp__filesystem__write_file', { path: join(W2.fb, 'today.html'), content: 'x' }], ['mcp__term__start_process', { command: `cd ${W2.fb} && rm -r unattended` }]])
    assert.equal(W2.guard(tool, input).code, 2, `${tool} ${JSON.stringify(input).slice(0, 100)}`);
  // Too large to check, for a tool that isn't plainly a read: refused, and said plainly.
  assert.match(no('mcp__filesystem__write_file', { path: '/tmp/x.txt', content: 'x'.repeat(2 * 1024 * 1024 + 1) }, 'over 2 MB'), /this call is too large for floorboss to check; send it in smaller parts\.\s*$/);
  // Found behind padding the earlier scan stopped at.
  no('mcp__term__start_process', { pad1: Array(2000).fill('a'), pad2: Array(2000).fill('a'), command: 'launchctl load /tmp/x.plist' }, 'after 4,000 other values');

  const ok = (tool, input, why) => {
    const r = W.guard(tool, input);
    assert.equal(r.code, 0, `refused (${why}): ${tool} ${JSON.stringify(input).slice(0, 140)}\n${r.err}`);
  };
  // Ordinary calls are none of this rule's business.
  ok('mcp__desktop-commander__start_process', { command: 'npm run start' }, 'an ordinary command');
  ok('mcp__desktop-commander__start_process', { command: 'launchctl list | head -5' }, 'a look at launchd');
  ok('mcp__desktop-commander__start_process', { command: `node ${U} off` }, 'turning it off');
  ok('mcp__desktop-commander__start_process', { command: `node "${U}" status` }, 'asking its status, the path quoted');
  ok('mcp__desktop-commander__start_process', { command: 'node', args: [U, 'off'] }, 'turning it off, as an argument list');
  ok('mcp__notion__notion-create-pages', { pages: [{ title: 'Notes', content: 'floorboss can now build its morning brief unattended; nothing is sent.' }] }, 'prose that says unattended');
  ok('mcp__mail__send_message', { to: 'ana@acme.test', subject: 'Hello', body: 'Our unattended floorboss runs start on Monday.' }, 'a message');
  ok('mcp__filesystem__write_file', { path: join(W.base, 'proj', 'unattended', 'notes.md'), content: 'x' }, 'another project\'s own unattended folder');
  ok('mcp__filesystem__write_file', { path: join(W.HOME, 'Library', 'LaunchAgents', 'com.example.dev.plist'), content: '<plist><dict><key>Label</key><string>com.example.dev</string></dict></plist>' }, 'another job\'s file');
  ok('mcp__filesystem__write_file', { path: join(W.HOME, 'Library', 'LaunchAgents', 'com.example.cron.plist'), content: '<string>/srv/myapp/nightly.mjs</string>' }, 'another project\'s own script');
  ok('mcp__filesystem__write_file', { path: join(W.fb, 'work', 'answers', 'x.txt'), content: 'yes' }, 'floorboss\'s work folder');
  ok('mcp__filesystem__write_file', { path: join(W.fb, 'events', 'ev', 'attendees.csv'), content: 'Name\n' }, 'an attendee list the user gives');
  ok('mcp__x__big', { items: Array.from({ length: 6000 }, (_, i) => `row ${i}`) }, 'many values');
  // A tool that plainly reads is not looked at: a search for these very words, a read of these very files.
  ok('mcp__notion__notion-search', { query: 'launchctl load com.floorboss.brief unattended.mjs install-brief' }, 'a search for the names');
  ok('mcp__github__get_file_contents', { owner: 'o', repo: 'r', path: 'scripts/unattended.mjs' }, 'reading the script on GitHub');
  ok('mcp__playwright__browser_navigate', { url: 'https://www.google.com/search?q=launchctl+load+vs+bootstrap' }, 'a web search');
  ok('mcp__filesystem__read_file', { path: join(W.fb, 'today.html') }, 'reading the brief');
  ok('mcp__filesystem__read_text_file', { path: W.plist }, 'reading the launchd file');
  ok('mcp__filesystem__list_directory', { path: '~/.floorboss/unattended' }, 'listing the folder');
  ok('mcp__filesystem__read_multiple_files', { paths: Array(3000).fill('/srv/x/' + 'a/'.repeat(500)) }, 'a very large read');
  // The stated cost for tools that write: text that only mentions the names is refused too.
  no('mcp__notion__notion-create-pages', { pages: [{ content: 'To install the morning brief, run node scripts/unattended.mjs install-brief in your own terminal.' }] }, 'a note that names the install');
  no('mcp__github__create_issue', { owner: 'o', repo: 'r', title: 'docs', body: 'README says `launchctl bootstrap gui/501 x.plist` but that fails' }, 'an issue that quotes launchctl');
  no('mcp__gmail__create_draft', { to: ['me@example.com'], body: 'The job is called com.floorboss.brief.' }, 'a draft that names the job');
  // A tool named as a read that is handed a command is not seen (a name is all the guard has): stated in SECURITY.md.
  ok('mcp__term__read_output', { command: 'launchctl load /tmp/x.plist' }, 'named as a read');
  // In a session that did run floorboss, a read still passes this rule; whatever else holds it is not this.
  assert.ok(existsSync(join(W.fb, 'unattended', 'off')));
});
