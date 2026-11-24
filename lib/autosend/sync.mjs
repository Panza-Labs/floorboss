// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// U5. The data folder as a git checkout of the user's own private repo: pull at the start, push at every checkpoint,
// one writer at a time by a lock file pushed before anything else. A send is marked in the remote before it goes, so a
// run that dies after a send can never send that step again. Nothing is merged and no lock is ever broken on its own:
// anything that isn't a clean fast-forward or an accepted push stops the run.
//
// This is the one file in floorboss that starts git (scripts/self-check.mjs holds it to that): git with fixed
// arguments, no shell, in the data folder, with prompts, hooks, fsmonitor, a custom ssh and signing off, and no GIT_*
// variable but its own. A data repo whose own settings could start a program (or reach another place) is refused
// before git runs there (repoConfigWhy): in Codex the data folder is <project>/floorboss, and a project can come with
// that folder and a .git of its own. Its only network use is the user's own remote, through git.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, realpathSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { writeJson, writeText, appendLine } from '../jsonio.mjs';
import { DATA_FORMAT, autosendEvents } from './common.mjs';
import { harness } from '../harness.mjs';
import { home as defaultHome } from '../paths.mjs';

const GIT = 'git';
// Every call: no hooks or fsmonitor from the data repo, ssh as itself, no protocol but https and ssh (a local folder
// as the remote only in the test suite), no signing prompt, floorboss as the author of its own commits.
const FIXED = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.sshCommand=ssh', '-c', 'protocol.ext.allow=never', '-c', 'commit.gpgsign=false', '-c', 'user.name=floorboss', '-c', 'user.email=autosend@floorboss.invalid'];
// And no protocol but https and ssh (a local folder as the remote only in the test suite), on every call too.
const PROTOCOLS = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', `protocol.file.allow=${process.env.FLOORBOSS_TEST === '1' ? 'always' : 'never'}`];
const GIT_TIMEOUT_MS = 120000;
// Never wait on a credential prompt (nobody is there in the cloud), and read git's messages in one language. No GIT_*
// variable from the environment reaches git (GIT_DIR, GIT_CONFIG_*, GIT_SSH_COMMAND and the like): only these.
const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k))), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' });
// Fetch and push name the programs at the other end themselves, so a remote.<r>.uploadpack/receivepack is never used.
const UPLOAD = '--upload-pack=git-upload-pack';
const RECEIVE = '--receive-pack=git-receive-pack';

// A credential in git's words never reaches a stop text, the run log or the repo: the user part of any URL
// ("https://user:token@", a helper-prefixed "x::https://…@") and an "x-access-token:…@" are replaced, up to the last
// '@' before the host (a password may hold '@' itself).
export const redact = (t) =>
  String(t ?? '')
    .replace(/(https?:\/\/)[^\s/]+@/gi, '$1***@')
    .replace(/(x-access-token:)[^\s/]+@/gi, '$1***@');

// The one place git starts (scripts/self-check.mjs reads this line as it is): FIXED first, then what the caller adds.
function gitAt(home, args) {
  const r = spawnSync(GIT, [...FIXED, ...args], { cwd: home, encoding: 'utf8', env: gitEnv(), timeout: GIT_TIMEOUT_MS });
  return { ok: r.status === 0, out: String(r.stdout || ''), err: redact(String(r.stderr || r.error?.message || '').trim()).slice(0, 300) };
}
// git on the data folder's own repository and nothing else: its .git named and the folder as the work tree, so git
// never looks above it (a data folder with no .git of its own would otherwise find a project's .git and its
// settings). A folder with no .git of its own isn't a checkout: nothing runs there but git init.
function run(home, args) {
  const h = resolve(home);
  if (args[0] !== 'init' && !existsSync(join(h, '.git'))) return { ok: false, out: '', err: 'the data folder is not a git checkout of its own' };
  return gitAt(h, [...PROTOCOLS, '--git-dir', join(h, '.git'), '--work-tree', h, ...args]);
}
// git in another folder floorboss reads (its own checkout, for a pin), found as git finds it.
const runIn = (dir, args) => gitAt(dir, [...PROTOCOLS, ...args]);
// git in the data folder: refused, with nothing run, while the folder's own git settings could start a program. A
// folder with no .git of its own isn't a checkout: nothing runs there but git init.
function git(home, args) {
  const why = repoConfigWhy(home);
  return why ? { ok: false, out: '', err: why, refused: why } : run(home, args);
}

// The only settings a data repo's own config may hold: what `git init` and `git clone` write (on any system), what
// floorboss's init and a `git push -u` add, a name and email of the user's (FIXED sets floorboss's own anyway),
// settings that only shape how git reads, pulls or shows (pull.rebase, core.autocrlf and the like), and
// core.hooksPath, which FIXED overrides on every call (core.fsmonitor, overridden too, stays refused by name). Any other setting is refused, whatever it
// is: git keeps adding settings that start a program (core.alternateRefsCommand was one a list of risky names
// missed), so the list is of the safe ones. Names as git lists them (section and key in lower case, the middle part
// as written). A remote's url and pushurl are checked for their value too (remoteUrlOk).
const ALLOWED =
  /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|untrackedcache|hookspath)|extensions\.(?:objectformat|refstorage)|remote\.[\w][\w.-]*\.(?:url|pushurl|fetch|prune|tagopt)|branch\.[\w][\w./-]*\.(?:remote|merge|rebase|description|vscode-merge-base)|user\.(?:name|email)|pull\.(?:rebase|ff)|fetch\.prune|lfs\.repositoryformatversion)$/;
// A partial clone fetches what it lacks later, from a promisor remote: refused, with its own words.
const PARTIAL = /^(?:remote\..+\.(?:promisor|partialclonefilter)|extensions\.partialclone)$/;
// A remote floorboss pushes to: https://<host>/<path> or ssh as git@ (ssh://git@<host>/<path>, git@<host>:<path>),
// (a user and token in an https one are taken: test/autosend-audit9.test.mjs holds status to working with one, and
// floorboss never shows it), no "x::" helper and nothing git could read as an option. A local folder only in
// the test suite (FLOORBOSS_TEST), where the remote is a bare repo in a temp folder.
// A host is labels with dots between them, never a trailing dot; at most one user:token part in an https url (the
// name without dots, so "https://github.com@evil.example" isn't one); no backslash, no "%40" or "%2f", no second '@'.
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})';
const HOSTNAME = `${LABEL}(?:\\.${LABEL})*`;
const HOST = `${HOSTNAME}(?::\\d{1,5})?`;
const PATH = '[^\\s@:\\\\%]+';
const URL_OK = new RegExp(`^(?:https://(?:[A-Za-z0-9_-]+(?::[^\\s/@\\\\%:]+)?@)?${HOST}/${PATH}|ssh://git@${HOST}/${PATH}|git@${HOSTNAME}:[A-Za-z0-9_]${PATH.replace('+', '*')})$`);
export const remoteUrlOk = (u) => URL_OK.test(String(u || '')) || (process.env.FLOORBOSS_TEST === '1' && /^\/[^\s:]*$/.test(String(u || '')));
// An address as the user confirms it, shows it and floorboss records it: the https user:token part left out (the
// user confirms the host and the path; the token never leaves git's own config).
export const bareUrl = (u) => String(u || '').replace(/^(https:\/\/)[^/]*@/i, '$1');
const NOT_RUN =
  "floorboss never sets that up, so it won't run git in this folder: nothing was changed. If this floorboss folder came with a project you downloaded or copied, it isn't yours: delete it, or start Codex in another folder";
const shownName = (n) => n.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '?').slice(0, 80);
const shownUrl = (u) => shownName(redact(bareUrl(u))).slice(0, 160);
// A link anywhere under .git sends git's reads and writes out of the data folder: every entry is looked at (lstat,
// never followed), up to a bound on how many and how deep; a .git past the bound is refused, not half-checked.
const WALK_MAX = 200000;
const WALK_DEPTH = 24;
// Walked once per process (one floorboss command) for each data folder: a sync makes dozens of git calls.
const walked = new Map();
let walks = 0;
export const walkCount = () => walks;
// For a test that counts the walks of one command in a process that has run others.
export const forgetWalks = () => walked.clear();
// Each call from outside this file is one step of a command: the walk is made fresh at its start and reused by
// every git call inside it (a .git changed between two steps is walked again).
let depth = 0;
const scoped = (fn) =>
  function (...a) {
    if (depth === 0) walked.clear();
    depth++;
    try {
      return fn(...a);
    } finally {
      depth--;
    }
  };
function linkUnder(dot) {
  if (walked.has(dot)) return walked.get(dot);
  walks++;
  const r = walkOnce(dot);
  walked.set(dot, r);
  return r;
}
function walkOnce(dot) {
  let seen = 0;
  const stack = [['', 0]];
  while (stack.length) {
    const [rel, depth] = stack.pop();
    let names;
    try {
      names = readdirSync(join(dot, rel));
    } catch {
      return { why: `floorboss can't read the data folder's .git/${rel}` };
    }
    for (const n of names) {
      if (++seen > WALK_MAX) return { why: `the data folder's .git holds too many files for floorboss to check (over ${WALK_MAX})` };
      const r = rel ? `${rel}/${n}` : n;
      let st;
      try {
        st = lstatSync(join(dot, r));
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) return { why: `the data folder's .git/${shownName(r)} is a link to somewhere else, so git would read and write outside the data folder` };
      if (st.isDirectory()) {
        if (depth + 1 >= WALK_DEPTH) return { why: `the data folder's .git has folders too deep for floorboss to check (.git/${shownName(r).slice(0, 60)}…)` };
        stack.push([r, depth + 1]);
      }
    }
  }
  return null;
}
// Why git must not run in this data folder, in plain words, or null. Only the folder's own .git is read (a folder with
// none isn't a checkout of its own, and floorboss runs no git there but git init). Read by git with --file, so an
// include is listed, never followed.
function repoConfigWhy_(home) {
  const dot = join(resolve(home), '.git');
  let st;
  try {
    st = lstatSync(dot);
  } catch {
    return null;
  }
  if (!st.isDirectory())
    return `the data folder's .git is ${st.isSymbolicLink() ? 'a link' : 'a file pointing somewhere else'}, so its git settings aren't its own: ${NOT_RUN}. If it is your own data repo, clone it again from GitHub`;
  if (existsSync(join(dot, 'commondir'))) return `the data folder's .git takes its git settings from another folder: ${NOT_RUN}. If it is your own data repo, clone it again from GitHub`;
  const link = linkUnder(dot);
  if (link) return `${link.why}: ${NOT_RUN}. If it is your own data repo, clone it again from GitHub`;
  const names = [];
  const partial = [];
  const urls = [];
  for (const f of ['config', 'config.worktree']) {
    const path = join(dot, f);
    let fst;
    try {
      fst = lstatSync(path);
    } catch {
      continue;
    }
    if (!fst.isFile()) return `the data folder's git settings (.git/${f}) are not a file: ${NOT_RUN}`;
    const r = gitAt(dot, [...PROTOCOLS, '--git-dir', dot, 'config', '--file', path, '--no-includes', '--list', '-z']);
    if (!r.ok) return `git can't read the data folder's git settings (.git/${f}): ${NOT_RUN}`;
    for (const ent of r.out.split('\0').filter(Boolean)) {
      const nl = ent.indexOf('\n');
      const n = (nl < 0 ? ent : ent.slice(0, nl)).trim();
      const v = nl < 0 ? '' : ent.slice(nl + 1);
      if (PARTIAL.test(n)) partial.push(n);
      else if (!ALLOWED.test(n)) names.push(n);
      else if (/^remote\..+\.(?:url|pushurl)$/.test(n) && !remoteUrlOk(v)) urls.push([n, v]);
    }
  }
  // Objects borrowed from another repository: git reads that one too (and its core.alternateRefsCommand runs).
  const alt = ['alternates', 'http-alternates'].filter((f) => existsSync(join(dot, 'objects', 'info', f)));
  if (!names.length && !alt.length && !partial.length && !urls.length) return null;
  const list = [...new Set(names)].map(shownName);
  const unset = (l) => l.slice(0, 6).map((n) => `git config --unset ${n}`).join('; ') + (l.length > 6 ? `; and ${l.length - 6} more` : '');
  const found = [
    list.length ? `its .git/config sets ${list.slice(0, 6).join(', ')}${list.length > 6 ? `, and ${list.length - 6} more` : ''}, which floorboss doesn't take (a setting there can start a program or reach another place when git runs). If it is your own data repo, remove ${list.length > 1 ? 'them' : 'it'} in a terminal in the data folder: ${unset(list)}` : '',
    urls.length
      ? urls
          .slice(0, 3)
          .map(([n, v]) => {
            const r = shownName(n.split('.').slice(1, -1).join('.'));
            return `its ${shownName(n)} is "${shownUrl(v)}", which isn't a plain https or ssh address of a repo. If it is your own data repo, set it to your repo's address: git remote set-url${n.endsWith('pushurl') ? ' --push' : ''} ${r} https://github.com/<you>/<repo>.git`;
          })
          .join('; and ')
      : '',
    partial.length ? `it is a partial clone (${[...new Set(partial)].map(shownName).join(', ')}), which fetches more later on its own. If it is your own data repo, clone it again without --filter` : '',
    alt.length ? `its .git reads objects from another repository (.git/objects/info/${alt.join(', .git/objects/info/')}). If it is your own data repo, clone it again from GitHub` : ''
  ].filter(Boolean);
  return `the data folder's git settings aren't floorboss's: ${found.join('; and ')}. ${NOT_RUN}`;
}

// The repo the user confirmed for each data folder, kept outside every data folder (a project can ship a data folder,
// never this file): ~/.config/floorboss/remotes.json, { "<data folder's real path>": "<url>" }.
export const remotesFile = () => join(homedir(), '.config', 'floorboss', 'remotes.json');
const homeKey = (home) => {
  try {
    return realpathSync(resolve(home));
  } catch {
    return resolve(home);
  }
};
function readRemotes() {
  let o;
  try {
    o = JSON.parse(readFileSync(remotesFile(), 'utf8'));
  } catch {
    return {};
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  // A record written before addresses were kept without their user:token part: written back without it.
  const clean = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, bareUrl(v)]));
  if (Object.keys(o).some((k) => o[k] !== clean[k]))
    try {
      writeJson(remotesFile(), clean);
    } catch {
      /* read as clean either way; the next confirm writes it */
    }
  return clean;
}
// Record the user's yes to this data folder's repo (setup, init, remote --confirm), without any user:token part.
export function confirmRemote({ home, url }) {
  if (!remoteUrlOk(url)) return { stop: `"${shownUrl(url)}" isn't a plain https or ssh address of a repo` };
  const file = remotesFile();
  try {
    writeJson(file, { ...readRemotes(), [homeKey(home)]: bareUrl(url) });
  } catch (e) {
    return {
      stop: `floorboss couldn't save your answer in ${file} (${e?.code || 'it could not write there'}). Nothing was sent. Make sure the folder ${dirname(file)} exists and your user can write to it (in a terminal: mkdir -p "${dirname(file)}" && chmod u+w "${dirname(file)}"), then answer again. In Codex, run that command in a terminal of your own: Codex may not let floorboss write outside the project`
    };
  }
  return { ok: true };
}
const CLI = fileURLToPath(new URL('../../skills/autosend/scripts/cli.mjs', import.meta.url));
const CONFIRM_CMD = (url) => `node "${CLI}" remote --confirm '${shownUrl(url)}'`;
// The question to the user, in the owner's words: three numbered answers. A GitHub repository only on github.com.
export function confirmQuestion(url) {
  const shown = shownUrl(url);
  const host = (/^(?:https:\/\/|ssh:\/\/git@|git@)([^/:]+)/i.exec(bareUrl(url)) || [])[1] || '';
  const gh = /^github\.com$/i.test(host);
  const where = gh ? 'a private GitHub repository' : `a private repository at ${shownName(host)}`;
  const look = gh ? 'GitHub shows the word "Private" near the name of the repository.' : `The site at ${shownName(host)} shows whether the repository is private.`;
  return [
    `floorboss keeps a copy of your contacts and messages in ${where}. The cloud task reads that copy to send your follow-ups.`,
    `This folder sends the copy to: ${shown}`,
    'Did you make this repository yourself, and is it private?',
    '1. Yes, it is mine and it is private. (floorboss continues.)',
    "2. No. (floorboss sends nothing to that address and stops.) This folder came from someone else or points at the wrong place: don't use it for auto-send, and ask floorboss to set up your own.",
    `3. I am not sure. (Open the address in your browser. ${look} If you cannot open it, or it is not yours, answer "No".)`
  ].join('\n');
}
// Why floorboss won't fetch from or push to this data folder's remote: its address (host and path) isn't the one the
// user confirmed (both shown), or none was confirmed yet (the question to the user, with the command for answer 1).
// null when it is. In Codex the question to the user is the only control on that command (Claude Code's guard holds
// it; auto-send's git runs in Codex only). The cloud task's clone is the repo its task prompt names, so the cloud
// isn't asked; a local folder in the test suite isn't either.
function remoteBindWhy_(home) {
  if (process.env.FLOORBOSS_AUTOSEND === 'cloud') return null;
  const d = dataRemote(home);
  if (!d) return null;
  const name = shownName(d.name);
  // A local folder is a remote only in the test suite, and isn't asked about there.
  const addrs = [d.url, d.pushurl].filter((x) => x && !(process.env.FLOORBOSS_TEST === '1' && x.startsWith('/')));
  if (!addrs.length) return null;
  if (addrs.length === 2 && bareUrl(addrs[0]) !== bareUrl(addrs[1]))
    return `this folder's repository has a separate push address (remote.${name}.pushurl ${shownUrl(d.pushurl)}) besides its address (${shownUrl(d.url)}), so floorboss won't fetch or push: nothing was sent. floorboss uses one address for both. If you set that push address yourself and don't need it, remove it: git config --unset remote.${name}.pushurl. If you didn't, this folder isn't yours: delete it`;
  const addr = addrs[addrs.length - 1];
  const rec = readRemotes()[homeKey(home)];
  const known = rec ? bareUrl(rec) : null;
  if (known === bareUrl(addr)) return null;
  if (!known)
    return `floorboss needs your answer before it sends anything to this folder's repository. Ask the user, word for word:\n${confirmQuestion(addr)}\nIf they answer 1, run: ${CONFIRM_CMD(addr)}\nIf they answer 2 or 3, stop: nothing was sent`;
  return `This folder's repository address changed since you confirmed it. Either you moved your data yourself, and you confirm the new address; or you didn't, and you set it back. Nothing was sent. It is now ${shownUrl(addr)}; you confirmed ${shownUrl(known)}. To confirm the new one (only if you moved it yourself), run: ${CONFIRM_CMD(addr)}. To set it back: git remote set-url ${name} ${shownUrl(known)}`;
}
// The remote the branch's upstream names (origin when none is set up), with its address and push address.
function dataRemote_(home) {
  const name = upstreamOf(home)?.remote || 'origin';
  const url = git(home, ['config', '--get', `remote.${name}.url`]);
  if (!url.ok) return null;
  const push = git(home, ['config', '--get', `remote.${name}.pushurl`]);
  return { name, url: url.out.trim(), pushurl: push.ok ? push.out.trim() : null };
}

// What the data repo holds, and nothing else: config.json, each event's event.json, ledger.jsonl, slots.json (the times
// its messages offer: the planner holds one whose time is past) and approved drafts,
// and auto-send's own files (the lock, the data format, the run files and the run logs), plus a .gitignore. Everything
// else in the data folder (said-files and uploads in work/, the guard's markers in released/, the pages, the views,
// the laptop's windows and tickets) stays on the laptop: only these paths are staged, and a repo whose tree holds
// anything else, a link or a submodule, is refused before it is checked out (a writer of the repo could plant a file
// floorboss reads as control data, or a link that a write follows out of the folder).
const SLUG_PART = '[a-z0-9][a-z0-9-]{0,63}';
export const DATA_RE = new RegExp(
  `^(?:config\\.json|\\.gitignore|events/${SLUG_PART}/(?:event\\.json|ledger\\.jsonl|slots\\.json|drafts/[0-9a-f]{24}\\.json)|autosend/(?:lock\\.json|format\\.json|runs/[\\w-]{1,64}\\.json|log-\\d{4}-\\d{2}-\\d{2}\\.md))$`
);
export const DATA_WORDS = "config.json, each event's event.json, ledger.jsonl, slots.json and drafts, and auto-send's files in autosend/";
// The paths git reports changed here (tracked or not), as written: [{ xy, path }], or null when git can't say.
function statusOf(home) {
  // Ignored files too (the data repo's .gitignore ignores everything: floorboss picks its own by DATA_RE).
  const r = git(home, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignored=traditional', '--no-renames']);
  if (!r.ok) return null;
  return r.out
    .split('\0')
    .filter(Boolean)
    .map((l) => ({ xy: l.slice(0, 2), path: l.slice(3) }));
}
// Stage floorboss's data paths that changed, and nothing else: { ok } or { stop }.
function stageData_(home) {
  const st = statusOf(home);
  if (st === null) return { stop: "git can't read the data folder" };
  const paths = st.map((x) => x.path).filter((p) => DATA_RE.test(p));
  if (!paths.length) return { ok: true };
  const add = git(home, ['add', '-A', '-f', '--', ...paths.map((p) => `:(literal)${p}`)]);
  return add.ok ? { ok: true } : { stop: `git add failed: ${add.err}` };
}
// Why a commit's tree isn't one floorboss takes (a link, a submodule, a path that isn't its data), or null.
function treeWhy_(home, rev) {
  const r = git(home, ['ls-tree', '-r', '-z', '--full-tree', rev]);
  if (!r.ok) return `git can't read ${rev}: ${r.err}`;
  for (const ent of r.out.split('\0').filter(Boolean)) {
    const tab = ent.indexOf('\t');
    const [mode] = ent.slice(0, tab).split(' ');
    const path = ent.slice(tab + 1);
    if (mode === '120000') return `your repo holds a link (${path.slice(0, 120)}), which floorboss never follows: nothing was changed. Remove it from the repo`;
    if (mode === '160000') return `your repo holds a submodule (${path.slice(0, 120)}), which isn't floorboss's data: nothing was changed. Remove it from the repo`;
    if (!DATA_RE.test(path)) return `your repo holds ${path.slice(0, 120)}, which isn't floorboss's data (only ${DATA_WORDS}): nothing was changed. Remove it from the repo`;
  }
  return null;
}
// The remote fetched, its tree checked, then a fast-forward to it: { ok } or { stop, apart? }.
// What a laptop with no connection to the data repo is told: auto-send events can't be worked on without it.
export const OFFLINE = "you're offline: auto-send events need the connection; connect and try again (or your repo can't be reached from here)";
// A fetch from the upstream remote, only when its address is the one the user confirmed (each fetch call is written
// out at its place, so test/autosend-audit10-gitconfig.test.mjs can see it names upload-pack).
const unbound = (home) => {
  const bind = remoteBindWhy(home);
  return bind ? { ok: false, out: '', err: bind, bind: true } : null;
};
function pullChecked(home) {
  const u = upstreamOf(home);
  if (!u) return { stop: NO_UPSTREAM };
  const f = unbound(home) || git(home, ['fetch', '-q', UPLOAD, u.remote]);
  if (f.bind) return { stop: f.err };
  if (!f.ok) return { stop: `${OFFLINE} (the fetch failed: ${f.err})`, offline: true };
  const bad = treeWhy(home, '@{upstream}');
  if (bad) return { stop: bad };
  const m = git(home, ['merge', '-q', '--ff-only', '@{upstream}']);
  if (!m.ok) return { stop: `the data folder and your repo have moved apart (not a fast-forward)`, apart: true };
  return { ok: true };
}

// The data format this floorboss writes (lib/autosend/common.mjs DATA_FORMAT), stamped in autosend/format.json; a repo
// stamped by a newer floorboss is refused, so a pinned cloud task never reads records it doesn't know.
const formatPath = (home) => join(home, 'autosend', 'format.json');
function formatIn(home) {
  if (!existsSync(formatPath(home))) return 0;
  try {
    const n = Number(JSON.parse(readFileSync(formatPath(home), 'utf8')).format);
    return Number.isInteger(n) && n >= 0 ? n : Infinity;
  } catch {
    return Infinity;
  }
}
export function formatWhy(home) {
  const n = formatIn(home);
  return n > DATA_FORMAT
    ? `your data repo was written by a newer floorboss (data format ${Number.isFinite(n) ? n : 'unreadable'}) than this one (${DATA_FORMAT}): nothing was changed. On the laptop run autosend setup and paste its new task prompt, so the cloud task runs the newer floorboss`
    : null;
}
const stampFormat = (home) => {
  if (formatIn(home) < DATA_FORMAT) writeJson(formatPath(home), { format: DATA_FORMAT });
};

export const LOCK = join('autosend', 'lock.json');
const lockPath = (home) => join(home, LOCK);
export function readLock(home) {
  if (!existsSync(lockPath(home))) return null;
  try {
    return JSON.parse(readFileSync(lockPath(home), 'utf8'));
  } catch {
    return { who: 'unknown', run: 'unreadable', at: null };
  }
}
const lockWords = (l) => `held by the ${l.who === 'cloud' ? 'cloud' : l.who === 'laptop' ? 'laptop' : 'an unknown writer'} (run ${l.run})${l.at ? ` since ${String(l.at).slice(0, 16).replace('T', ' ')} UTC` : ''}`;

// Whether this folder is the top of a git checkout.
function isRepo_(home) {
  const r = git(home, ['rev-parse', '--show-toplevel']);
  if (!r.ok) return false;
  try {
    return realpathSync(r.out.trim()) === realpathSync(resolve(home));
  } catch {
    return false;
  }
}
function remoteUrl_(home) {
  const r = git(home, ['remote', 'get-url', 'origin']);
  return r.ok ? r.out.trim() : null;
}
// Why a floorboss checkout can't be pinned (changes not committed: the pin wouldn't be the code that runs), or null.
export function pinWhy(dir) {
  const r = runIn(dir, ['status', '--porcelain']);
  if (!r.ok) return "git can't read the floorboss folder";
  const ch = r.out.split('\n').filter(Boolean);
  return ch.length ? `the floorboss folder has changes not committed (${ch.slice(0, 3).map((l) => l.slice(3)).join(', ')}${ch.length > 3 ? ', …' : ''}), so its commit isn't the code that would run` : null;
}
// The commit a clean checkout is at (the floorboss folder's, for the task prompt's pin), or null.
export function headOf(dir) {
  if (pinWhy(dir)) return null;
  const r = runIn(dir, ['rev-parse', 'HEAD']);
  return r.ok && /^[0-9a-f]{40}$/.test(r.out.trim()) ? r.out.trim() : null;
}
// floorboss's data paths changed here and not committed (anything else in the folder isn't the repo's).
const changes = (home) => {
  const st = statusOf(home);
  return st === null ? null : st.filter((x) => DATA_RE.test(x.path)).map((x) => `${x.xy} ${x.path}`);
};
// The branch's upstream: the remote and the branch there this checkout pulls from, or null (none set up). Pushes go
// there and nowhere else, so a laptop branch named otherwise can't put the lock on another branch.
function upstreamOf_(home) {
  const b = git(home, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (!b.ok) return null;
  const branch = b.out.trim();
  const remote = git(home, ['config', '--get', `branch.${branch}.remote`]);
  const merge = git(home, ['config', '--get', `branch.${branch}.merge`]);
  if (!remote.ok || !merge.ok) return null;
  const r = remote.out.trim();
  const m = merge.out.trim();
  if (!/^\w[\w.-]*$/.test(r) || !/^refs\/heads\/[\w][\w./-]*$/.test(m)) return null;
  return { remote: r, ref: m };
}
const NO_UPSTREAM = "this branch has no upstream to push to (README: auto-send, setup step 1, git push -u)";
function push(home) {
  const u = upstreamOf(home);
  if (!u) return { ok: false, out: '', err: NO_UPSTREAM };
  const bind = remoteBindWhy(home);
  if (bind) return { ok: false, out: '', err: bind, refused: bind };
  return git(home, ['push', '--porcelain', RECEIVE, u.remote, `HEAD:${u.ref}`]);
}
// Whether everything floorboss wrote here is in the remote: no data path changed and not committed (a run killed
// between a write and its commit), fetched again (a push killed part-way may have landed or not), nothing between the
// upstream and HEAD, and, with release ({ slug, id, touch, run }), that step's release line in the upstream's ledger.
// { ok: true } or { ok: false, why }.
function pushedAll_({ home, release = null }) {
  const u = upstreamOf(home);
  if (!u) return { ok: false, why: NO_UPSTREAM };
  const dirty = changes(home);
  if (dirty === null) return { ok: false, why: "git can't read the data folder" };
  if (dirty.length) return { ok: false, why: `floorboss data here is not committed (${dirty.slice(0, 3).map((l) => l.slice(3)).join(', ')})` };
  const f = unbound(home) || git(home, ['fetch', '-q', UPLOAD, u.remote]);
  if (!f.ok) return { ok: false, why: f.bind ? f.err : `the fetch failed: ${f.err}` };
  const n = git(home, ['rev-list', '--count', '@{upstream}..HEAD']);
  if (!n.ok) return { ok: false, why: `git can't compare with the remote: ${n.err}` };
  if (n.out.trim() !== '0') return { ok: false, why: 'a commit here is not in the remote' };
  if (release) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(release.slug || ''))) return { ok: false, why: 'the release names no event' };
    const text = showAt(home, '@{upstream}', `events/${release.slug}/ledger.jsonl`) || '';
    const has = text.split('\n').some((l) => {
      try {
        const e = JSON.parse(l);
        return e?.type === 'autosend_released' && e.id === release.id && (e.touch ?? 1) === release.touch && e.run === release.run;
      } catch {
        return false;
      }
    });
    if (!has) return { ok: false, why: 'the release mark is not in the remote' };
  }
  return { ok: true };
}

// Take the data folder for this run: { ok: true } or { stop: why }. Writes nothing unless it can take the lock.
function start_({ home, who, runId, nowMs }) {
  if (!['cloud', 'laptop'].includes(who)) return { stop: 'who is cloud or laptop' };
  if (!/^[\w-]{1,64}$/.test(String(runId || ''))) return { stop: 'a run id is letters, digits, "-" and "_"' };
  const unsafe = repoConfigWhy(home);
  if (unsafe) return { stop: unsafe };
  if (!isRepo(home)) return { stop: "the data folder isn't a git checkout of your data repo (README: auto-send, setup)" };
  const dirty = changes(home);
  if (dirty === null) return { stop: "git can't read the data folder" };
  if (dirty.length) return { stop: `the data folder has changes not pushed (${dirty.slice(0, 3).map((l) => l.slice(3)).join(', ')}${dirty.length > 3 ? ', …' : ''}): on the laptop, run sync end first` };
  // The checkout as it is (a fresh clone was checked out before floorboss ran), then the remote, before it is checked out.
  const here = treeWhy(home, 'HEAD');
  if (here) return { stop: here };
  const pull = pullChecked(home);
  if (pull.stop) return { stop: pull.apart ? `${pull.stop}. On the laptop, run sync repair` : pull.stop };
  const newer = formatWhy(home);
  if (newer) return { stop: newer };
  const held = readLock(home);
  // The laptop's own earlier session lock (a session that ended without sync end): the laptop takes it over. The
  // laptop never sends, so nothing went under it; the flow's lock check (sessionWhy) accepts any laptop lock too.
  const takeOver = held && who === 'laptop' && held.who === 'laptop' ? held : null;
  if (held && !takeOver) return { stop: `the data folder is ${lockWords(held)}: nothing was changed. If that run is over, check Sent mail, then unlock it on the laptop` };
  const before = git(home, ['rev-parse', 'HEAD']).out.trim();
  writeJson(lockPath(home), { who, run: runId, at: new Date(nowMs).toISOString() });
  const add = git(home, ['add', '-f', '--', LOCK]);
  const commit = add.ok ? git(home, ['commit', '-q', '-m', `lock ${who} ${runId}`, '--', LOCK]) : add;
  const pushed = commit.ok ? push(home) : commit;
  if (!pushed.ok) {
    // Someone pushed first (or the push failed): this lock was never taken. The local commit is undone.
    if (/^[0-9a-f]{40}$/.test(before)) git(home, ['reset', '-q', '--hard', before]);
    if (readLock(home)?.run === runId) unlinkSync(lockPath(home));
    return { stop: `the lock push was rejected (someone else pushed first, or the push failed): ${pushed.err}` };
  }
  return { ok: true, ...(takeOver ? { took_over: takeOver.run } : {}) };
}

// Commit everything and push it: { ok: true } or { stop } (a failed push stops the run; it never throws).
function checkpoint_({ home, message }) {
  stampFormat(home);
  const add = stageData(home);
  if (add.stop) return add;
  const staged = git(home, ['diff', '--cached', '--quiet']);
  if (!staged.ok) {
    const c = git(home, ['commit', '-q', '-m', String(message).slice(0, 200)]);
    if (!c.ok) return { stop: `the commit failed: ${c.err}` };
  }
  const p = push(home);
  if (!p.ok) return { stop: `the push failed: ${p.err}` };
  return { ok: true };
}

// What this run committed and never pushed is thrown away (a release mark whose push failed: nothing was sent, and
// the step stays due).
function discardUnpushed_({ home }) {
  // The upstream as last fetched is checked as any pull is, before anything of it is checked out.
  const bad = treeWhy(home, '@{upstream}');
  if (bad) return { stop: bad };
  const r = git(home, ['reset', '-q', '--hard', '@{upstream}']);
  return r.ok ? { ok: true } : { stop: `the local changes couldn't be put back: ${r.err}` };
}

// The run's end: its lock dropped (only its own), everything committed and pushed.
function end_({ home, runId }) {
  const l = readLock(home);
  if (l && l.run !== runId) return { stop: `the lock isn't this run's (it is ${lockWords(l)}): left as it is` };
  if (l) unlinkSync(lockPath(home));
  return checkpoint({ home, message: l ? `unlock ${l.who} ${l.run}` : 'floorboss data' });
}

// On the laptop with auto-send on and the data folder a checkout of the user's repo: the commands that change drafts,
// approvals or the list outside laptopWrite (flow next, the outbox page) run only while this session holds the lock
// (sync start --who laptop), so nothing they write sits here unpushed while the cloud sends the old text. Why not, or
// null. Claude Code (no auto-send there) is as it was.
function sessionWhy_(home = defaultHome(), env = process.env) {
  if (harness(env) === 'claude-code' || env.FLOORBOSS_AUTOSEND === 'cloud') return null;
  if (!autosendEvents(home).length) return null;
  const unsafe = repoConfigWhy(home);
  if (unsafe) return `Auto-send is on, and ${unsafe}.`;
  if (!isRepo(home) || !git(home, ['remote']).out.trim()) return null;
  const l = readLock(home);
  if (l?.who === 'laptop') return null;
  return `Auto-send is on and your data folder is a checkout of your repo: run \`node "FLOORBOSS/skills/autosend/scripts/cli.mjs" sync start --who laptop --run laptop-<YYYYMMDD-HHMM>\` first (it takes the data folder for this session, so the cloud task can't send a message while you change it), and sync end when you're done${l ? `. Right now it is ${lockWords(l)}` : ''}. If you're offline: auto-send events need the connection; connect and try again.`;
}

// The user's unlock, on the laptop only: shows the lock; with the user's words, removes it and pushes.
// A lock younger than this may belong to a run still going (a cloud run of floorboss takes minutes): not unlocked.
export const LOCK_LIVE_MS = 30 * 60 * 1000;
function unlock_({ home, who, said = null, nowMs = Date.now() }) {
  if (who === 'cloud') throw new Error('unlock is for the user on the laptop, never in a cloud run');
  const pull = pullChecked(home);
  if (pull.stop) return { stop: pull.apart ? `${pull.stop}: run sync repair first` : pull.stop };
  const l = readLock(home);
  if (!l) return { lock: null, unlocked: false, say: 'Nothing holds the data folder.' };
  const age = nowMs - Date.parse(l.at || '');
  if (Number.isFinite(age) && age < LOCK_LIVE_MS)
    return { lock: l, unlocked: false, say: `The data folder is ${lockWords(l)}, and that run may still be going. Try again after ${new Date(Date.parse(l.at) + LOCK_LIVE_MS).toISOString().slice(11, 16)} UTC, then check Sent mail first.` };
  if (!said || String(said).trim().length < 2)
    return { lock: l, unlocked: false, say: `The data folder is ${lockWords(l)}. Before unlocking, check Gmail's Sent folder for anything that run may have sent, and settle it (autosend status).` };
  unlinkSync(lockPath(home));
  const r = checkpoint({ home, message: `unlock ${l.who} ${l.run} (the user: ${String(said).slice(0, 80)})` });
  return r.ok ? { lock: l, unlocked: true } : { lock: l, unlocked: false, ...r };
}

// What the user does when a laptop change can't reach the cloud: pause the scheduled task, so nothing more goes.
export const PAUSE_STEPS =
  'Pause the cloud task now so nothing more goes: in ChatGPT on the web, open Scheduled, open the floorboss auto-send task, and pause it (or delete it). Once your repo can be reached again, run sync repair here, then unpause the task if you want it back on';

// Commit whatever floorboss wrote here and hasn't committed (another command's lines): { ok } or { stop }.
function commitAll(home, message) {
  const add = stageData(home);
  if (add.stop) return add;
  if (git(home, ['diff', '--cached', '--quiet']).ok) return { ok: true };
  const c = git(home, ['commit', '-q', '-m', String(message).slice(0, 200)]);
  return c.ok ? { ok: true } : { stop: `the commit failed: ${c.err}` };
}
const headSha = (home) => {
  const r = git(home, ['rev-parse', 'HEAD']);
  return r.ok && /^[0-9a-f]{40}$/.test(r.out.trim()) ? r.out.trim() : null;
};
const resetTo = (home, sha) => (sha ? git(home, ['reset', '-q', '--hard', sha]).ok : false);

// A laptop command that changes auto-send state (on, approve, revoke, settle, a reply or stop recorded) runs through
// the sync: what floorboss wrote before is committed, the remote pulled (fast-forward only), the lock taken (or the
// laptop's own session lock used), fn() writes, and it is pushed with the lock dropped. Anything that fails before the
// write refuses and changes nothing; a push that fails after it puts the folder back as it was. With keep (a revoke,
// a stop: those must win), fn() still writes here and it is committed, and the answer says it hasn't reached the
// cloud and how to pause the scheduled task. A data folder that isn't a checkout with a remote has no cloud to reach:
// fn() just writes. Returns { result, pushed: true | false | null, say? }.
function laptopWrite_({ home, nowMs = Date.now(), keep = false, keepUnbound = keep, what = 'floorboss' }, fn) {
  const unsafe = repoConfigWhy(home);
  if (unsafe) throw new Error(`${String(what).slice(0, 80)} refused: ${unsafe}.`);
  if (!isRepo(home) || !git(home, ['remote']).out.trim()) return { result: fn(), pushed: null };
  const label = String(what).slice(0, 80);
  const refuse = (why) => {
    if (!keep) throw new Error(`${why}. Nothing was changed.`);
    const result = fn();
    const c = commitAll(home, `${label} (laptop, not pushed)`);
    return { result, pushed: false, say: `Saved here, but not in your repo yet, so the cloud task doesn't know: ${why}${c.stop ? ` (and ${c.stop})` : ''}. ${PAUSE_STEPS}.` };
  };
  if (!upstreamOf(home)) return refuse(NO_UPSTREAM);
  // The repository not confirmed (or changed): a stop (a revoke, a stop recorded, a draft found gone) is saved here all
  // the same and never waits on the answer; anything else is refused with the question.
  const bind = remoteBindWhy(home);
  if (bind) {
    if (!keepUnbound) throw new Error(`${label} refused: ${bind}`);
    const result = fn();
    const c = commitAll(home, `${label} (laptop, not pushed)`);
    return { result, pushed: false, say: `Saved here on this computer. The cloud task doesn't know yet, so it could still send under what was approved before. Do this now: ${PAUSE_STEPS}. Then, so floorboss can send this change to your repository: ${bind}${c.stop ? ` (and ${c.stop})` : ''}` };
  }
  // The pull first (git refuses it, changing nothing, if it would touch a file floorboss changed here and hasn't
  // committed); then what floorboss wrote before is committed, to go with this change.
  const pull = pullChecked(home);
  if (pull.stop) return refuse(pull.apart ? `${pull.stop}: run sync repair` : pull.stop);
  const pre = commitAll(home, 'floorboss data');
  if (pre.stop) return refuse(pre.stop);
  const held = readLock(home);
  if (held && held.who !== 'laptop') return refuse(`the data folder is ${lockWords(held)}`);
  const runId = `laptop-${new Date(nowMs).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}-${randomBytes(3).toString('hex')}`;
  if (!held) {
    const s = start({ home, who: 'laptop', runId, nowMs });
    if (s.stop) return refuse(s.stop);
  }
  const base = headSha(home);
  let result;
  try {
    result = fn();
  } catch (e) {
    resetTo(home, base);
    if (!held) end({ home, runId });
    throw e;
  }
  if (!held && readLock(home)?.run === runId) unlinkSync(lockPath(home));
  const c = checkpoint({ home, message: `${label} (laptop)${held ? '' : `; unlock laptop ${runId}`}` });
  if (c.ok) return { result, pushed: true };
  const lockNote = ' Your laptop\'s lock is in your repo, so cloud runs stop on it until this is pushed.';
  if (keep) return { result, pushed: false, say: `Saved here, but not in your repo yet: ${c.stop}.${lockNote} ${PAUSE_STEPS}.` };
  resetTo(home, base);
  if (!held) end({ home, runId });
  throw new Error(`${label} couldn't be pushed (${c.stop}). Nothing was changed.`);
}

// The paths a repair can carry over from the laptop: an event's ledger (lines added at its end), a saved draft added,
// and the pages floorboss rebuilds (left to the remote's copy). The lock is the remote's.
const LEDGER_RE = /^events\/[a-z0-9][a-z0-9-]{0,63}\/ledger\.jsonl$/;
const DRAFT_RE = /^events\/[a-z0-9][a-z0-9-]{0,63}\/drafts\/[0-9a-f]{24}\.json$/;
const PAGE_RE = /^events\/[a-z0-9][a-z0-9-]{0,63}\/[\w.-]+\.html$/;
const showAt = (home, rev, path) => {
  const r = git(home, ['show', `${rev}:${path}`]);
  return r.ok ? r.out : null;
};

// sync repair, laptop only: a data folder that moved apart from the repo (a laptop change committed while the cloud
// pushed) is brought back in line. The remote is fetched; when only one side moved it is a fast-forward or a push;
// when both did, the laptop's own lines (added at the end of an event's ledger) are put after the remote's, with its
// saved drafts, and pushed. A second yes made apart is left out (the readback it was given for is gone: approve again).
// Never drops a revoke or a stop. Anything else changed on the laptop, a ledger not only added to on either side, a
// cloud run that may still be going, or a push that fails: refused, and the laptop is left exactly as it was.
function repair_({ home, who, nowMs = Date.now() }) {
  if (who === 'cloud') throw new Error('sync repair is for the user on the laptop, never in a cloud run');
  const unsafe = repoConfigWhy(home);
  if (unsafe) return { repaired: false, stop: unsafe };
  if (!isRepo(home)) return { repaired: false, stop: "the data folder isn't a git checkout of your data repo" };
  const u = upstreamOf(home);
  if (!u) return { repaired: false, stop: NO_UPSTREAM };
  const pre = commitAll(home, 'floorboss data');
  if (pre.stop) return { repaired: false, stop: pre.stop };
  const f = unbound(home) || git(home, ['fetch', '-q', UPLOAD, u.remote]);
  if (!f.ok) return { repaired: false, stop: f.bind ? f.err : `the fetch failed: ${f.err}` };
  const head = headSha(home);
  const upR = git(home, ['rev-parse', '@{upstream}']);
  const up = upR.ok ? upR.out.trim() : null;
  const baseR = git(home, ['merge-base', 'HEAD', '@{upstream}']);
  const base = baseR.ok ? baseR.out.trim() : null;
  if (!head || !up || !base) return { repaired: false, stop: "git can't compare the data folder with your repo" };
  const done = (say, extra = {}) => ({ repaired: true, replayed: 0, dropped: [], say, ...extra });
  const bad = treeWhy(home, up);
  if (bad) return { repaired: false, stop: bad };
  if (head === up) return done('Nothing to repair: the data folder and your repo agree.');
  if (base === head) {
    const m = git(home, ['merge', '-q', '--ff-only', '@{upstream}']);
    return m.ok ? done('Brought up to date from your repo (nothing here was apart).') : { repaired: false, stop: `the fast-forward failed: ${m.err}` };
  }
  // A cloud run that may still be going holds the remote: no write lands under it.
  const lockText = showAt(home, up, 'autosend/lock.json');
  if (lockText) {
    let l = null;
    try {
      l = JSON.parse(lockText);
    } catch {
      l = { who: 'unknown', run: 'unreadable', at: null };
    }
    const age = nowMs - Date.parse(l.at || '');
    if (l.who !== 'laptop' && !(Number.isFinite(age) && age >= LOCK_LIVE_MS))
      return { repaired: false, stop: `your repo is ${lockWords(l)}, and that run may still be going: try again in 30 minutes. Nothing was changed` };
  }
  if (base === up) {
    const p = push(home);
    return p.ok ? done('Pushed what the laptop had that your repo didn\'t.') : { repaired: false, stop: `the push failed: ${p.err}. Nothing was changed` };
  }
  // Both moved: what the laptop changed since they parted, path by path.
  const d = git(home, ['diff', '--name-status', '--no-renames', '-z', base, head]);
  if (!d.ok) return { repaired: false, stop: `git can't list the laptop's changes: ${d.err}` };
  const parts = d.out.split('\0').filter(Boolean);
  const ledgers = [];
  const drafts = [];
  const cant = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [st, path] = [parts[i], parts[i + 1]];
    if (path === 'autosend/lock.json' || PAGE_RE.test(path)) continue;
    if (LEDGER_RE.test(path) && (st === 'M' || st === 'A')) {
      const was = showAt(home, base, path) ?? '';
      const now = showAt(home, head, path) ?? '';
      const theirs = showAt(home, up, path);
      if (!now.startsWith(was) || (was && !was.endsWith('\n')) || (theirs != null && !theirs.startsWith(was))) {
        cant.push(`${path} (not only added to)`);
        continue;
      }
      ledgers.push({ path, added: now.slice(was.length).split('\n').filter((l) => l.trim()) });
    } else if (DRAFT_RE.test(path) && st === 'A') {
      const text = showAt(home, head, path);
      const theirs = showAt(home, up, path);
      if (text == null || (theirs != null && theirs !== text)) cant.push(path);
      else drafts.push({ path, text });
    } else cant.push(path);
  }
  if (cant.length) return { repaired: false, stop: `the laptop changed what a repair can't carry over safely: ${cant.slice(0, 5).join(', ')}${cant.length > 5 ? ', …' : ''}. Nothing was changed` };
  const replay = [];
  const dropped = [];
  for (const l of ledgers) {
    for (const text of l.added) {
      let e = null;
      try {
        e = JSON.parse(text);
      } catch {
        return { repaired: false, stop: `a line the laptop added to ${l.path} can't be read. Nothing was changed` };
      }
      if (e?.type === 'autosend_approved') dropped.push(`${l.path.split('/')[1]} ${e.id} message ${e.touch ?? 1}`);
      else replay.push({ path: l.path, text });
    }
  }
  // Put the laptop's lines after the remote's, on the remote's commit; the laptop's old commit is kept under a ref.
  git(home, ['update-ref', 'refs/floorboss/before-repair', head]);
  if (!resetTo(home, up)) return { repaired: false, stop: "the data folder couldn't be moved to your repo's commit. Nothing was changed" };
  try {
    // Never through a link (lib/jsonio.mjs): the folders on the way and the file itself.
    for (const x of drafts) writeText(join(home, x.path), x.text);
    for (const x of replay) appendLine(join(home, x.path), x.text);
  } catch (e) {
    resetTo(home, head);
    return { repaired: false, stop: `the laptop's lines couldn't be written (${String(e.message).slice(0, 120)}). Nothing was changed` };
  }
  const c = checkpoint({ home, message: `repair: ${replay.length} laptop line(s) put after the repo's` });
  if (!c.ok) {
    resetTo(home, head);
    return { repaired: false, stop: `${c.stop}. Nothing was changed: the laptop is as it was` };
  }
  return done(`Your repo and the laptop agree again: ${replay.length} line(s) from the laptop are now in your repo, after the cloud's.${dropped.length ? ` ${dropped.length} auto-send yes line(s) made while apart were left out (the readback they answered is gone): run readback and approve again.` : ''}`, { replayed: replay.length, dropped, before: head });
}

// What a data repo ignores (written by init, so a copy made by hand with git add -A sends only floorboss's data too).
export const GITIGNORE = [
  "# floorboss: nothing here goes to your repo by itself. floorboss stages its own data (lib/autosend/sync.mjs DATA_RE),",
  '# and a hand-made git add -A adds nothing new.',
  '/*',
  '!/.gitignore',
  ''
].join('\n');

// README setup step 1, done by floorboss (one command, the same in every shell): the data folder made a checkout of
// the user's new, empty private repo, with floorboss's data only, committed by floorboss (no git name or email of
// the user's needed) and pushed. A push that can't sign in (git never asks here) leaves one command for the user to
// type. { ok, pushed, say } or { stop }.
function initRepo_({ home, remote }) {
  const unsafe = repoConfigWhy(home);
  if (unsafe) return { stop: unsafe };
  if (isRepo(home)) return { stop: 'the data folder is a git checkout already: run setup' };
  if (!/^[^\s-][^\s]*$/.test(String(remote || ''))) return { stop: 'the remote is one URL' };
  const steps = [
    ['init', '-q'],
    ['remote', 'add', 'origin', remote]
  ];
  for (const a of steps) {
    const r = git(home, a);
    if (!r.ok) return { stop: `git ${a[0]} failed: ${r.err}` };
  }
  writeText(join(home, '.gitignore'), GITIGNORE);
  const st = stageData(home);
  if (st.stop) return st;
  const c = git(home, ['commit', '-q', '-m', 'floorboss data']);
  if (!c.ok) return { stop: `the first commit failed: ${c.err}` };
  const b = git(home, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const branch = b.ok ? b.out.trim() : null;
  if (!branch || !/^[\w][\w./-]*$/.test(branch)) return { stop: "git can't name this branch" };
  // The user named this repo (init --remote): it is the one floorboss pushes to from now on.
  const rec = confirmRemote({ home, url: remote });
  if (rec.stop) return { stop: rec.stop };
  const p = git(home, ['push', '-q', RECEIVE, '-u', 'origin', `HEAD:refs/heads/${branch}`]);
  if (p.ok) {
    git(home, ['branch', '-q', `--set-upstream-to=origin/${branch}`]);
    return { ok: true, pushed: true, branch };
  }
  return {
    ok: true,
    pushed: false,
    branch,
    say: `The data folder is ready, but git couldn't sign in to GitHub from here (${p.err}). Push it once yourself: open a terminal in the data folder and type: git push -u origin ${branch}`
  };
}

// Whether a commit is on a branch of a remote as this copy last saw it (no network): null, or why not.
export function publishedWhy(dir, sha) {
  if (!/^[0-9a-f]{40}$/.test(String(sha || ''))) return 'there is no commit to pin';
  const r = runIn(dir, ['branch', '-r', '--contains', sha]);
  if (!r.ok) return "git can't say whether the pinned commit is published";
  return r.out.trim() ? null : 'the pinned commit is on no branch of a remote this copy knows of (it may exist only here): push it first, or pin one that is on GitHub, or the cloud task can\'t clone it';
}
export const repoConfigWhy = scoped(repoConfigWhy_);
export const remoteBindWhy = scoped(remoteBindWhy_);
export const dataRemote = scoped(dataRemote_);
export const stageData = scoped(stageData_);
export const treeWhy = scoped(treeWhy_);
export const isRepo = scoped(isRepo_);
export const remoteUrl = scoped(remoteUrl_);
export const upstreamOf = scoped(upstreamOf_);
export const pushedAll = scoped(pushedAll_);
export const start = scoped(start_);
export const checkpoint = scoped(checkpoint_);
export const discardUnpushed = scoped(discardUnpushed_);
export const end = scoped(end_);
export const sessionWhy = scoped(sessionWhy_);
export const unlock = scoped(unlock_);
export const laptopWrite = scoped(laptopWrite_);
export const repair = scoped(repair_);
export const initRepo = scoped(initRepo_);
