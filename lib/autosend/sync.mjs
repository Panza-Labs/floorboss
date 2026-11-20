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
import { existsSync, readFileSync, unlinkSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeJson, writeText, appendLine } from '../jsonio.mjs';
import { DATA_FORMAT, autosendEvents } from './common.mjs';
import { harness } from '../harness.mjs';
import { home as defaultHome } from '../paths.mjs';

const GIT = 'git';
// Every call: no hooks or fsmonitor from the data repo, ssh as itself, no ext:: remotes, no signing prompt, floorboss
// as the author of its own commits.
const FIXED = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.sshCommand=ssh', '-c', 'protocol.ext.allow=never', '-c', 'commit.gpgsign=false', '-c', 'user.name=floorboss', '-c', 'user.email=autosend@floorboss.invalid'];
const GIT_TIMEOUT_MS = 120000;
// Never wait on a credential prompt (nobody is there in the cloud), and read git's messages in one language. No GIT_*
// variable from the environment reaches git (GIT_DIR, GIT_CONFIG_*, GIT_SSH_COMMAND and the like): only these.
const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k))), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' });
// Fetch and push name the programs at the other end themselves, so a remote.<r>.uploadpack/receivepack is never used.
const UPLOAD = '--upload-pack=git-upload-pack';
const RECEIVE = '--receive-pack=git-receive-pack';

// A credential in git's words never reaches a stop text, the run log or the repo: the user part of any URL
// ("https://user:token@", a helper-prefixed "x::https://…@") and an "x-access-token:…@" are replaced.
export const redact = (t) =>
  String(t ?? '')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/(x-access-token:)[^\s@]+@/gi, '$1***@');

function run(home, args) {
  const r = spawnSync(GIT, [...FIXED, ...args], { cwd: home, encoding: 'utf8', env: gitEnv(), timeout: GIT_TIMEOUT_MS });
  return { ok: r.status === 0, out: String(r.stdout || ''), err: redact(String(r.stderr || r.error?.message || '').trim()).slice(0, 300) };
}
// git in the data folder: refused, with nothing run, while the folder's own git settings could start a program.
function git(home, args) {
  const why = repoConfigWhy(home);
  return why ? { ok: false, out: '', err: why, refused: why } : run(home, args);
}

// Settings in a repo's own config that make git start a program, read another file of settings, or work on another
// folder: floorboss's setup never writes one (init, setup, a fresh clone), so a data repo that has one didn't come
// from floorboss. Names as git lists them (section and key in lower case).
const RISKY =
  /^(?:include|includeif)\.|^core\.(?:fsmonitor|sshcommand|askpass|gitproxy|worktree)$|^remote\..+\.(?:uploadpack|receivepack)$|^filter\.|\.textconv$|^diff\.external$|^merge\..+\.driver$|^credential\.|^gpg\.|^extensions\.worktreeconfig$/i;
const NOT_RUN =
  "floorboss never sets that up, so it won't run git in this folder: nothing was changed. If this floorboss folder came with a project you downloaded or copied, it isn't yours: delete it, or start Codex in another folder. If it is your own data repo, remove those settings (git config --unset)";
const shownName = (n) => n.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '?').slice(0, 80);
// Why git must not run in this data folder, in plain words, or null. Only the folder's own .git is read (a folder with
// none isn't a checkout of its own, and floorboss runs no git there but to ask). Read by git with --file, so an
// include is listed, never followed.
export function repoConfigWhy(home) {
  const dot = join(resolve(home), '.git');
  let st;
  try {
    st = lstatSync(dot);
  } catch {
    return null;
  }
  if (!st.isDirectory())
    return `the data folder's .git is ${st.isSymbolicLink() ? 'a link' : 'a file pointing somewhere else'}, so its git settings aren't its own: ${NOT_RUN}`;
  if (existsSync(join(dot, 'commondir'))) return `the data folder's .git takes its git settings from another folder: ${NOT_RUN}`;
  const names = [];
  for (const f of ['config', 'config.worktree']) {
    const path = join(dot, f);
    let fst;
    try {
      fst = lstatSync(path);
    } catch {
      continue;
    }
    if (!fst.isFile()) return `the data folder's git settings (.git/${f}) are ${fst.isSymbolicLink() ? 'a link' : 'not a file'}: ${NOT_RUN}`;
    const r = run(dot, ['config', '--file', path, '--no-includes', '--name-only', '--list', '-z']);
    if (!r.ok) return `git can't read the data folder's git settings (.git/${f}): ${NOT_RUN}`;
    for (const n of r.out.split('\0').filter(Boolean)) if (RISKY.test(n.trim())) names.push(n.trim());
  }
  if (!names.length) return null;
  const list = [...new Set(names)].map(shownName);
  return `the data folder's own git settings (.git/config) set ${list.slice(0, 4).join(', ')}${list.length > 4 ? `, and ${list.length - 4} more` : ''}, which can start a program or reach another place when git runs there: ${NOT_RUN}`;
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
export function stageData(home) {
  const st = statusOf(home);
  if (st === null) return { stop: "git can't read the data folder" };
  const paths = st.map((x) => x.path).filter((p) => DATA_RE.test(p));
  if (!paths.length) return { ok: true };
  const add = git(home, ['add', '-A', '-f', '--', ...paths.map((p) => `:(literal)${p}`)]);
  return add.ok ? { ok: true } : { stop: `git add failed: ${add.err}` };
}
// Why a commit's tree isn't one floorboss takes (a link, a submodule, a path that isn't its data), or null.
export function treeWhy(home, rev) {
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
function pullChecked(home) {
  const u = upstreamOf(home);
  if (!u) return { stop: NO_UPSTREAM };
  const f = git(home, ['fetch', '-q', UPLOAD, u.remote]);
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
export function isRepo(home) {
  const r = git(home, ['rev-parse', '--show-toplevel']);
  if (!r.ok) return false;
  try {
    return realpathSync(r.out.trim()) === realpathSync(resolve(home));
  } catch {
    return false;
  }
}
export function remoteUrl(home) {
  const r = git(home, ['remote', 'get-url', 'origin']);
  return r.ok ? r.out.trim() : null;
}
// Why a floorboss checkout can't be pinned (changes not committed: the pin wouldn't be the code that runs), or null.
export function pinWhy(dir) {
  const r = run(dir, ['status', '--porcelain']);
  if (!r.ok) return "git can't read the floorboss folder";
  const ch = r.out.split('\n').filter(Boolean);
  return ch.length ? `the floorboss folder has changes not committed (${ch.slice(0, 3).map((l) => l.slice(3)).join(', ')}${ch.length > 3 ? ', …' : ''}), so its commit isn't the code that would run` : null;
}
// The commit a clean checkout is at (the floorboss folder's, for the task prompt's pin), or null.
export function headOf(dir) {
  if (pinWhy(dir)) return null;
  const r = run(dir, ['rev-parse', 'HEAD']);
  return r.ok && /^[0-9a-f]{40}$/.test(r.out.trim()) ? r.out.trim() : null;
}
// floorboss's data paths changed here and not committed (anything else in the folder isn't the repo's).
const changes = (home) => {
  const st = statusOf(home);
  return st === null ? null : st.filter((x) => DATA_RE.test(x.path)).map((x) => `${x.xy} ${x.path}`);
};
// The branch's upstream: the remote and the branch there this checkout pulls from, or null (none set up). Pushes go
// there and nowhere else, so a laptop branch named otherwise can't put the lock on another branch.
export function upstreamOf(home) {
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
  return git(home, ['push', '--porcelain', RECEIVE, u.remote, `HEAD:${u.ref}`]);
}
// Whether everything committed here is in the remote: fetched again (a push killed part-way may have landed or not),
// then nothing between the upstream and HEAD. { ok: true } or { ok: false, why }.
export function pushedAll({ home }) {
  const u = upstreamOf(home);
  if (!u) return { ok: false, why: NO_UPSTREAM };
  const f = git(home, ['fetch', '-q', UPLOAD, u.remote]);
  if (!f.ok) return { ok: false, why: `the fetch failed: ${f.err}` };
  const n = git(home, ['rev-list', '--count', '@{upstream}..HEAD']);
  if (!n.ok) return { ok: false, why: `git can't compare with the remote: ${n.err}` };
  return n.out.trim() === '0' ? { ok: true } : { ok: false, why: 'a commit here is not in the remote' };
}

// Take the data folder for this run: { ok: true } or { stop: why }. Writes nothing unless it can take the lock.
export function start({ home, who, runId, nowMs }) {
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
export function checkpoint({ home, message }) {
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
export function discardUnpushed({ home }) {
  // The upstream as last fetched is checked as any pull is, before anything of it is checked out.
  const bad = treeWhy(home, '@{upstream}');
  if (bad) return { stop: bad };
  const r = git(home, ['reset', '-q', '--hard', '@{upstream}']);
  return r.ok ? { ok: true } : { stop: `the local changes couldn't be put back: ${r.err}` };
}

// The run's end: its lock dropped (only its own), everything committed and pushed.
export function end({ home, runId }) {
  const l = readLock(home);
  if (l && l.run !== runId) return { stop: `the lock isn't this run's (it is ${lockWords(l)}): left as it is` };
  if (l) unlinkSync(lockPath(home));
  return checkpoint({ home, message: l ? `unlock ${l.who} ${l.run}` : 'floorboss data' });
}

// On the laptop with auto-send on and the data folder a checkout of the user's repo: the commands that change drafts,
// approvals or the list outside laptopWrite (flow next, the outbox page) run only while this session holds the lock
// (sync start --who laptop), so nothing they write sits here unpushed while the cloud sends the old text. Why not, or
// null. Claude Code (no auto-send there) is as it was.
export function sessionWhy(home = defaultHome(), env = process.env) {
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
export function unlock({ home, who, said = null, nowMs = Date.now() }) {
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
export function laptopWrite({ home, nowMs = Date.now(), keep = false, what = 'floorboss' }, fn) {
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
export function repair({ home, who, nowMs = Date.now() }) {
  if (who === 'cloud') throw new Error('sync repair is for the user on the laptop, never in a cloud run');
  const unsafe = repoConfigWhy(home);
  if (unsafe) return { repaired: false, stop: unsafe };
  if (!isRepo(home)) return { repaired: false, stop: "the data folder isn't a git checkout of your data repo" };
  const u = upstreamOf(home);
  if (!u) return { repaired: false, stop: NO_UPSTREAM };
  const pre = commitAll(home, 'floorboss data');
  if (pre.stop) return { repaired: false, stop: pre.stop };
  const f = git(home, ['fetch', '-q', UPLOAD, u.remote]);
  if (!f.ok) return { repaired: false, stop: `the fetch failed: ${f.err}` };
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
export function initRepo({ home, remote }) {
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
  const r = run(dir, ['branch', '-r', '--contains', sha]);
  if (!r.ok) return "git can't say whether the pinned commit is published";
  return r.out.trim() ? null : 'the pinned commit is on no branch of a remote this copy knows of (it may exist only here): push it first, or pin one that is on GitHub, or the cloud task can\'t clone it';
}
