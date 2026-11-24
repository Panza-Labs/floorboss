// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Where floorboss keeps its data. In Claude Code everything lives outside the user's project, so personal data
// can't be committed by accident. In Codex it lives in <project>/floorboss, with a .gitignore that keeps it all out
// of the project's git: Codex's sandbox lets commands write only inside the folder the session started in.
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname, sep, parse, basename } from 'node:path';
import {
  mkdirSync,
  realpathSync,
  existsSync,
  chmodSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
  lstatSync,
  readlinkSync,
  openSync,
  fstatSync,
  statSync,
  readSync,
  closeSync,
  constants as FS
} from 'node:fs';
import { harness } from './harness.mjs';

// The data folder: FLOORBOSS_HOME when set (tests, Claude Code, the cloud task, anyone who sets it); in Codex,
// <project>/floorboss (projectHome below); anywhere else, or when Codex's folder is refused, ~/.floorboss.
export function home() {
  const h = process.env.FLOORBOSS_HOME;
  if (h) return resolve(h);
  const p = codexHome();
  return p || join(homedir(), '.floorboss');
}

// The folder this process started in, read once at load: a cd later in the script doesn't move the data folder.
// Codex runs each command in the session's folder (its turn cwd) unless the model names another workdir, and names
// the project in no variable.
const START_CWD = (() => {
  try {
    return resolve(process.cwd());
  } catch {
    return null;
  }
})();
// What a data folder floorboss made holds (any one).
const DATA_MARKS = ['.private', 'config.json', 'active.json', 'events', 'work'];
// Folders that are never a project: system folders, the folders above every home and a drive's own top.
const SYSTEM_DIRS =
  /^\/(?:(?:private\/)?etc|usr|bin|sbin|System|Library|Applications|dev|proc|sys|boot|cores|lib|lib64|run|snap)(?:\/|$)|^\/(?:private|var|private\/var|tmp|private\/tmp|Volumes|home|Users)$|^\/Volumes\/[^/]+$|^[A-Za-z]:\/(?:Windows|Program Files(?: \(x86\))?|ProgramData)(?:\/|$)|^[A-Za-z]:\/Users\/?$/i;
const sameDir = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const insideDir = (p, d) => {
  const [x, y] = process.platform === 'win32' ? [p.toLowerCase(), d.toLowerCase()] : [p, d];
  return x.startsWith(y.endsWith(sep) ? y : y + sep);
};
// A folder directly under a shared temp folder (/tmp, /var/tmp, /private/tmp...): anyone on the machine can make one
// there, with a floorboss/ in it. Taken only when it is this account's own and nobody else can write to it.
const SHARED_TEMP = /^\/(?:private\/)?(?:tmp|var|var\/tmp)\/[^/]+$/;
function othersCould(d) {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return false;
  try {
    const st = lstatSync(d);
    return !st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o022) !== 0;
  } catch {
    return false;
  }
}
function refusedProject(d, userHome) {
  if (parse(d).root === d) return true;
  if (SHARED_TEMP.test(slashed(d)) && othersCould(d)) return true;
  const u = resolve(userHome);
  if (sameDir(d, u) || insideDir(u, d)) return true;
  // CONFIG's /var rule is left out: the temp folder is under /var on macOS.
  return SECRET.test(d) || SYSTEM_DIRS.test(slashed(d)) || CONFIG.test(slashed(d).replace(/^\/(?:private\/)?var(?=\/)/, ''));
}
// <dir>/floorboss as a data folder: a plain folder (never a link or a file), and not a checkout of floorboss's own
// code (the cloud task clones it to ./floorboss). marked: it must hold floorboss's data already.
function dataIn(dir, { marked }) {
  const f = join(dir, 'floorboss');
  let st;
  try {
    st = lstatSync(f);
  } catch {
    return marked ? null : f;
  }
  if (!st.isDirectory() || existsSync(join(f, 'package.json'))) return null;
  // A marker counts only as itself: a link named config.json (to anything) makes nothing a data folder.
  const isMark = (m) => {
    try {
      return !lstatSync(join(f, m)).isSymbolicLink();
    } catch {
      return false;
    }
  };
  return !marked || DATA_MARKS.some(isMark) ? f : null;
}
// Codex's data folder, from the folder the command started in (cwd): the nearest <folder>/floorboss holding
// floorboss's data, from cwd up to the top of its git checkout (and never above the home folder); with none, cwd's
// own. null (so ~/.floorboss) when cwd is the home folder, one above it, the filesystem root, a system or config
// folder, or its floorboss is a link, a file or floorboss's code.
export function projectHome({ cwd = START_CWD, userHome = homedir() } = {}) {
  if (!cwd) return null;
  const start = resolve(cwd);
  if (refusedProject(start, userHome)) return null;
  const own = dataIn(start, { marked: false });
  if (own && existsSync(own)) return own;
  for (let d = start; !existsSync(join(d, '.git')); ) {
    const up = dirname(d);
    if (up === d || refusedProject(up, userHome)) break;
    d = up;
    const f = dataIn(d, { marked: true });
    if (f) return f;
  }
  return own;
}
let codexCache = null;
function codexHome() {
  if (harness() !== 'codex') return null;
  const key = `${START_CWD}\0${homedir()}`;
  if (!codexCache || codexCache.key !== key) codexCache = { key, at: projectHome() };
  return codexCache.at;
}
// The project folder floorboss's data is in (Codex), or null: a list the user drops there is readable.
const projectOfHome = () => (process.env.FLOORBOSS_HOME ? null : codexHome() && dirname(codexHome()));
// The project folder itself (Codex, with no FLOORBOSS_HOME), for a file the user reads there: the review's all-messages.md.
export const projectFolder = () => projectOfHome() || null;
// The data folder as the user reads it in a message.
const shownHome = () => (home() === join(homedir(), '.floorboss') ? '~/.floorboss' : home());

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// The names floorboss gives an event (its folder name).
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new Error(`Event name "${slug}" isn't a valid slug: use lowercase letters, digits and hyphens.`);
  }
  return slug;
}

export function slugify(name) {
  return (
    String(name)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'event'
  );
}

export function eventDir(slug) {
  return join(home(), 'events', assertSlug(slug));
}

// A path the user typed: "~/Downloads/list.csv" is in their home folder, as a shell would read it.
export function expandHome(p) {
  if (typeof p !== 'string') return p;
  const t = p.trim();
  return t === '~' ? homedir() : /^~[/\\]/.test(t) ? join(homedir(), t.slice(2)) : t;
}

export const configPath = () => join(home(), 'config.json');
export const contextDir = (profile) => join(home(), 'context', assertSlug(profile));

// The real path, following symlinks as far as the path exists.
// The deepest folder that exists is found by halving (a folder exists if anything under it does), so a path of
// thousands of segments costs a dozen looks at the disk, not one per segment; the names after it are joined once.
function real(p) {
  const full = resolve(p);
  const root = parse(full).root;
  const names = full.slice(root.length).split(sep).filter(Boolean);
  const upTo = (k) => root + names.slice(0, k).join(sep);
  let lo = 0,
    hi = names.length;
  if (!existsSync(full))
    for (hi -= 1; lo < hi; ) {
      const mid = Math.ceil((lo + hi) / 2);
      if (existsSync(upTo(mid))) lo = mid;
      else hi = mid - 1;
    }
  else lo = hi;
  // The native call returns names as the disk stores them: on a case-insensitive disk (APFS by default)
  // "~/.AWS" comes back as "~/.aws", so a key folder or a record can't be reached under another spelling.
  return join(realpathSync.native(upTo(lo)), ...names.slice(lo));
}
const under = (p, root) => {
  const r = real(root);
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
};

// Files floorboss reads through --x-file flags or writes through --out live in its data folder or the temp
// folder (a list the user named may also be in the folder the session works in), never ~/.ssh or a shell
// profile. With FLOORBOSS_HOME set, its parent counts too (a run folder holding home/ and work/).
// Places floorboss never reads from, whatever the flag: keys, credentials, shell and app config.
// SECRET: keys, tokens, credentials, shell histories and browser profiles (cookies, saved passwords). The
// guard hook also refuses Claude's own Read, Grep and Glob there, always.
const SECRET_PLACES = new RegExp(
  '(^|/)(' +
    [
      '\\.ssh',
      '\\.aws',
      '\\.gnupg',
      '\\.gcloud',
      '\\.azure',
      '\\.kube',
      '\\.docker',
      '\\.netrc',
      '\\.npmrc',
      '\\.pypirc',
      '\\.git-credentials',
      '\\.pgpass',
      '\\.my\\.cnf',
      '\\.vault-token',
      '\\.s3cfg',
      '\\.boto',
      '\\.terraformrc',
      '\\.terraform\\.d',
      '\\.cargo/credentials(\\.toml)?',
      '\\.gem/credentials',
      '\\.m2/settings\\.xml',
      '\\.gradle/gradle\\.properties',
      '\\.password-store',
      '\\.local/share/keyrings',
      '\\.mozilla',
      '\\.claude\\.json',
      '\\.claude/\\.credentials\\.json',
      '\\.1password',
      '\\.op',
      '\\.oci',
      '\\.databrickscfg',
      '\\.dbt/profiles\\.yml',
      '\\.wrangler',
      '\\.netlify',
      '\\.vercel',
      // Cloud, deploy and developer tools that keep a token in a file of their own.
      '\\.config/(gcloud|gh|hub|doctl|configstore|stripe|op|rclone|netlify|vercel|wrangler|flyctl|railway|supabase|heroku|hcloud|linode-cli|ngrok|twilio-cli|sops|age)',
      '\\.stripe',
      '\\.fly',
      '\\.pulumi',
      '\\.sentryclirc',
      '\\.supabase',
      '\\.railway',
      '\\.ngrok2',
      '\\.composer/auth\\.json',
      '\\.yarnrc\\.yml',
      '\\.bundle/config',
      '\\.config/git/credentials',
      '\\.git-credential-cache',
      '\\.heroku',
      '\\.snowsql',
      '\\.passwd-s3fs',
      '\\.circleci/cli\\.yml',
      '\\.[\\w-]*_history',
      '\\.history',
      '\\.zsh_sessions',
      '\\.lesshst',
      '\\.viminfo',
      'Library/Keychains',
      'Library/Cookies',
      'Library/Safari',
      'Library/Containers/com\\.apple\\.Safari',
      'Library/Mail',
      'Library/Messages',
      'Library/Application Support/(Google/Chrome|Chromium|BraveSoftware|Firefox|Microsoft Edge|Arc|Vivaldi|com\\.operasoftware\\.Opera[\\w ]*|1Password|Bitwarden|Signal|Slack|discord|Code/User/globalStorage)',
      '[^/]*\\.(pem|p12|pfx|keychain-db|kdbx)',
      'id_(rsa|dsa|ecdsa|ed25519)'
    ].join('|') +
    ')(/|$)',
  'i'
);
// An env file: every .env name, with as many suffixes as it has (.env.production.local, .env-prod, .env_local,
// backend.env, .envrc.local), and its editor backups and copies (.env~, #.env#, ".env (1)", ".env copy", ".env 2",
// ".env .bak"). Only a whole .env.example, .env.sample, .env.template, .env.dist or .env.defaults is a template
// (.env.example.local isn't). A source or doc file named after one (my.env.js, docker-compose.env.yml,
// .env.d.ts) isn't an env file, and a folder named .env is a Python virtualenv; a .env.d folder holds env files.
const ENV_NAME = /^(.*?)\.env(rc)?((?:[-_.][\w.-]*)?)$/;
const SOURCE_EXT = /\.(?:js|ts|mjs|cjs|jsx|tsx|json|ya?ml|md|graphql)$/;
function envFile(name) {
  // No real env file has a name this long, and the clean-up below is slow on a crafted one.
  if (String(name).length > 1024) return false;
  const n = String(name)
    .toLowerCase()
    .replace(/^#(.*)#$/, '$1')
    .replace(/~+$/, '')
    .replace(/\s+(?:\(\d+\)|copy(?:\s+\d+)?|\d+)$/, '')
    .replace(/\s+(?=\.)/g, '');
  const m = ENV_NAME.exec(n);
  if (!m) return false;
  const [, stem, rc, tail] = m;
  if (!rc && /^\.(?:example|sample|template|dist|defaults)$/.test(tail)) return false;
  if (/^\.d\.ts$/.test(tail) || (stem && SOURCE_EXT.test(tail))) return false;
  return true;
}
// A path as the classifiers read it: a backslash as "/", so a Windows path (D:\Profiles\o\.ssh\id_rsa) is matched like a
// POSIX one. On macOS and Linux a backslash in a name is rare, and reading it as "/" only makes a match more likely.
const slashed = (p) => String(p).replace(/\\/g, '/');
const SECRET = {
  test: (p) => {
    const s = slashed(p);
    const parts = s.split('/');
    return SECRET_PLACES.test(s) || envFile(parts[parts.length - 1]) || parts.slice(0, -1).some((d) => /^\.env\.d$/i.test(d));
  }
};
// CONFIG: shell, app and Claude configuration, and system folders. Scripts never read there; Claude's own
// reads are refused there only while a floorboss run is under way (lib/runlock.mjs).
// Both are matched without regard to case: on a case-insensitive disk "~/.AWS/credentials" is the same file
// as "~/.aws/credentials".
const CONFIG_PLACES =
  /(^|\/)(\.config|\.claude|\.zshrc|\.zshenv|\.bashrc|\.bash_profile|\.profile|\.zprofile|\.zlogin|\.inputrc|\.gitconfig)(\/|$)|^\/(etc|private\/etc|var|usr|System|bin|sbin)\//i;
const CONFIG = { test: (p) => CONFIG_PLACES.test(slashed(p)) };
const SENSITIVE = { test: (p) => SECRET.test(p) || CONFIG.test(p) };
// Which tier a real path is in ('secret', 'config' or null). Paths inside floorboss's data folder are neither.
export function sensitiveKind(p) {
  const rp = real(p);
  if (rp === real(home()) || rp.startsWith(real(home()) + sep)) return null;
  return SECRET.test(rp) ? 'secret' : CONFIG.test(rp) ? 'config' : null;
}
// floorboss's own plugin folder (installed under ~/.claude/plugins): its examples and fixtures aren't config.
const PLUGIN_ROOT = resolve(new URL('..', import.meta.url).pathname);
const inPlugin = (rp) => {
  const r = real(PLUGIN_ROOT);
  return rp.startsWith(r + sep) && !SECRET.test(rp.slice(r.length));
};
export function notSensitive(p) {
  const rp = real(p);
  if (SENSITIVE.test(rp) && !rp.startsWith(real(home()) + sep) && !inPlugin(rp))
    throw new Error(`${p} is in a place floorboss never reads (keys, credentials, system or shell config).`);
  return rp;
}
export { real as realPath };
// The path a write lands at, every link on the way followed by its text (readlink), dangling or not: real()
// stops where the path stops existing, and a dangling link there (work/x.txt -> ~/.zshenv) is created by the
// write. links: each link passed, as the path it sat at.
export function followed(p) {
  const links = [];
  // From the path's own root: "/" on macOS and Linux, the drive (C:\) on Windows.
  const start = resolve(String(p));
  let root = parse(start).root;
  let cur = root;
  const parts = start.slice(root.length).split(sep).filter(Boolean);
  for (let i = 0, hops = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    let st = null;
    try {
      st = lstatSync(cur);
    } catch {
      // Not there: nothing under it is, so the rest of the path is text, joined on without a look at each name.
      cur = join(cur, ...parts.slice(i + 1));
      break;
    }
    if (!st.isSymbolicLink()) continue;
    if (++hops > 40) throw new Error(`${p} goes through more than 40 links.`);
    links.push(cur);
    // The link's target, then whatever is left of the path, walked again (a target may hold links itself).
    const rest = parts.slice(i + 1);
    const to = resolve(dirname(cur), readlinkSync(cur));
    root = parse(to).root;
    parts.splice(0, parts.length, ...to.slice(root.length).split(sep).filter(Boolean), ...rest);
    i = -1;
    cur = root;
  }
  return { to: cur, links };
}
// Why a write to p is refused for a link on the way, or null. A link inside floorboss's data folder, wherever
// it points and whether or not its target exists: everything there is floorboss's own, and the commands
// pre-approve writes there by the path as written. Anywhere else, a link that carries a write to keys,
// credentials or shell config when the path as written names none.
export function linkRefusal(p) {
  {
    const why = hardLinkRefusal(p);
    if (why) return why;
  }
  const { to, links } = followed(p);
  if (!links.length) return null;
  // Without regard to case: on a case-insensitive disk "~/.FLOORBOSS/work" is the data folder too.
  const h = [resolve(home()), real(home())].map((r) => r.toLowerCase());
  const inHome = (x) => h.some((r) => x.toLowerCase().startsWith(r + sep));
  const inData = links.find((l) => inHome(l));
  if (inData) return `${p} goes through a link (${inData}) inside floorboss's data folder, and floorboss doesn't write through links there. Put the folder itself there in place of the link.`;
  if (SENSITIVE.test(to) && !inHome(to) && !SENSITIVE.test(real(p)))
    return `${p} goes through a link that leads to ${to}, which holds keys, credentials or shell config.`;
  return null;
}
// A file with a second name (a hard link) in the data folder or the temp folder: every path check goes by name,
// and a hard link's other name may be ~/.ssh/id_rsa or ~/.zshrc. floorboss never makes one (it writes by rename),
// so one there is refused for reads and writes alike.
const tempRoots = () => [tmpdir(), '/tmp', '/private/tmp'].filter((r) => existsSync(r));
export function hardLinkRefusal(p) {
  let st = null;
  try {
    st = lstatSync(resolve(String(p)));
  } catch {
    return null;
  }
  if (!st.isFile() || st.nlink <= 1) return null;
  const rp = real(p);
  const where = [home(), ...tempRoots()].some((r) => existsSync(r) && under(rp, r)) || resolve(String(p)).startsWith(resolve(home()) + sep);
  return where
    ? `${p} has another name on the disk (a hard link), and floorboss doesn't read or write such a file in its data or temp folder: its other name could be a key or a shell profile. Copy it to a new file, then use the copy.`
    : null;
}
// Does the path as written (not followed through links) name a key place? The guard compares it with the real path's tier.
export const secretPlace = (p) => SECRET.test(resolve(String(p)));

// Data folders made before floorboss set private permissions on everything it writes: on each script run the
// data folder itself is made private (700), and once, every folder (700) and file (600) inside it.
// In Codex the data folder is made here, inside the project, with a .gitignore that keeps everything in it out of the
// project's git (the same rules as an auto-send data repo's: lib/autosend/sync.mjs GITIGNORE).
const PROJECT_GITIGNORE = '# floorboss: your data, kept out of this project\'s git.\n/*\n!/.gitignore\n';
export function secureHome() {
  const h = home();
  if (projectOfHome() && h === codexHome()) {
    mkdirSync(h, { recursive: true, mode: 0o700 });
    // Created new (wx): one already there (auto-send's own) is left as it is, and a link is never written through.
    try {
      writeFileSync(join(h, '.gitignore'), PROJECT_GITIGNORE, { mode: 0o600, flag: 'wx' });
    } catch {
      /* there already */
    }
  }
  if (!existsSync(h)) return;
  chmodSync(h, 0o700);
  const marker = join(h, '.private');
  if (existsSync(marker)) return;
  const stack = [h];
  let n = 0;
  while (stack.length && n < 50000) {
    const dir = stack.pop();
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      n++;
      const p = join(dir, d.name);
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        chmodSync(p, 0o700);
        stack.push(p);
      } else if (d.isFile()) chmodSync(p, 0o600);
    }
  }
  // Created new (wx): a link planted under the marker's name is never written through.
  try {
    writeFileSync(marker, 'floorboss set private permissions on this folder\n', { mode: 0o600, flag: 'wx' });
  } catch {
    /* there already, or a link: nothing written */
  }
}

// Files in floorboss's data folder that only its scripts write: its records (config, ledger, approvals,
// windows, lists). Claude's own Write and Edit may write only the work folders, the context skills and an
// event's typed or pasted attendee list (attendees.csv). The guard and allowedPath both use it.
// The cache folder beside the data folder (~/.floorboss-cache): floorboss's holds index lives there, never in the
// auto-send repo. It is floorboss's record too.
export const cacheDir = () => join(dirname(home()), `${basename(home())}-cache`);
export function recordFile(p) {
  const h = real(home());
  const rp = real(p);
  const cd = [resolve(cacheDir()), real(cacheDir())];
  if (cd.some((x) => rp === x || rp.startsWith(x + sep)) || cd.some((x) => resolve(String(p)) === x || resolve(String(p)).startsWith(x + sep))) return true;
  if (!(rp === h || rp.startsWith(h + sep))) return false;
  const rel = rp.slice(h.length + 1).split(sep);
  // What runs with nobody there keeps everything under unattended/ (the opt-in, the authorisations, the run tickets,
  // what the guard witnessed, the log and the off switch): written by floorboss's guard and scripts only, never by
  // Claude's own file tools. Named here so no rule below can ever let it through.
  if (rel[0] === 'unattended') return true;
  if (rel[0] === 'work' || rel[0] === 'context') return false;
  if (rel[0] === 'events' && rel.length >= 3) {
    if (rel[2] === 'work') return false;
    // At an event's top level only the attendee list the user typed or pasted (attendees.csv and its other
    // kinds): never dnc.txt, crm.csv or accounts.csv, which an older event reads as its do-not-contact list,
    // CRM export and off-limits companies. Everything else Claude writes goes in a work folder: the answer
    // files (work/answers/<id>.txt), free times (work/free-days.json) and each step's own files
    // (events/<slug>/work/...).
    if (rel.length === 3 && /^attendees\.(csv|tsv|txt|xlsx?)$/i.test(rel[2])) return false;
  }
  return true;
}
// Where a script's --out writes: a file in a work folder (work/ or events/<slug>/work/), by its real path. A
// --out anywhere else in the data folder replaced an event's ledger or config.json in one call.
function inWork(rp) {
  const h = real(home());
  if (!rp.startsWith(h + sep)) return false;
  const rel = rp.slice(h.length + 1).split(sep);
  return (rel[0] === 'work' && rel.length >= 2) || (rel[0] === 'events' && rel.length >= 4 && rel[2] === 'work');
}

// The kinds of file a list the user points floorboss at comes as (lib/security.mjs LIST_KINDS' tables).
const LIST_EXT = /\.(csv|tsv|txt|xlsx|xls)$/i;
// list: the file is one the user named (an attendee list, a CRM export, a contacts or do-not-contact list,
// their own emails), of a list's kind: the working folder counts for it. Every other read (a --*-file value, a
// step's JSON) comes from the data folder or the temp folder only, where the steps tell Claude to write it:
// a project file (config/secrets.yaml) can't be copied into the data folder by a pre-approved script call.
export function allowedPath(p, { write = false, list = false } = {}) {
  const rp = notSensitive(p);
  {
    const why = hardLinkRefusal(p);
    if (why) throw new Error(why);
  }
  if (write) {
    const why = linkRefusal(p);
    if (why) throw new Error(why);
    if (!inWork(rp) || recordFile(rp))
      throw new Error(
        `${p} is outside the folders floorboss writes to (a work folder: ${shownHome()}/work/ or ${shownHome()}/events/<event>/work/); floorboss's own records are written only by the command that changes them.`
      );
    return rp;
  }
  // In Codex the project folder too (the one the data folder is in), from wherever in it the command runs.
  const cwd = list && LIST_EXT.test(rp) ? [...(cwdLost ? [] : [process.cwd()]), ...(projectOfHome() ? [projectOfHome()] : [])] : [];
  // /tmp too: on macOS os.tmpdir() is /var/folders/…, but Claude's scratchpad is under /tmp (/private/tmp).
  const roots = write ? [home()] : [home(), tmpdir(), '/tmp', ...cwd, ...(process.env.FLOORBOSS_HOME ? [dirname(resolve(process.env.FLOORBOSS_HOME))] : [])];
  if (!roots.some((r) => existsSync(r) && under(rp, r)) && !(write && rp.startsWith(resolve(home()) + sep))) {
    throw new Error(
      `${p} is outside the folders floorboss ${write ? 'writes to (its data folder)' : list ? 'reads lists from (its data folder, the temp folder, the working folder)' : `reads from (its data folder and the temp folder): write it under ${shownHome()}/work/ first`}.`
    );
  }
  return rp;
}

// Reads a file a check already passed, without trusting the path a second time: no link at the end (O_NOFOLLOW), a
// regular file, still at the place that was checked, and, in a temp folder other accounts can write to, owned by
// this user. A file swapped for a link to a key after the check is refused, not read.
// A file another command replaced between the open and the check (floorboss writes every file as a new one renamed
// over the old, lib/jsonio.mjs writeText, so the name always holds a whole file) is opened and checked again, from the
// start, a few times over: commands run at once never fail at random on a read. Only one that keeps changing fails.
// It changes the process's working folder while it runs (walkTo stands in each folder on the way), and puts it back
// before it returns. Synchronous code never sees that. File work in flight on another thread would: an fs/promises or
// callback fs call given a relative name, while a read runs, would resolve it in one of the walk's folders. So floorboss
// makes no asynchronous file calls (scripts/self-check.mjs refuses them in lib, skills, scripts and hooks).
const SWAP_TRIES = 50;
export function readChecked(p, maxBytes = 20 * 1024 * 1024, opts = {}) {
  for (let i = 1; ; i++) {
    try {
      return readCheckedOnce(p, maxBytes, opts);
    } catch (e) {
      if (e?.swapped !== true || i >= SWAP_TRIES) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(i, 10));
    }
  }
}
// What a refusal of a link, or of a file with a second name, tells the user to do.
const LINK_FIX = 'Put the folder itself there in place of the link.';
const twoNames = (p) =>
  `${p} has another name on the disk (a hard link), and floorboss doesn't read such a file: its other name could be a key or a shell profile. Copy it to a new file, then use the copy.`;
const inDataLink = (p, l) => `${p} goes through a link (${l}) inside floorboss's data folder, and floorboss doesn't read through links there. ${LINK_FIX}`;
const swappedError = (p) => Object.assign(new Error(`${p} changed while floorboss read it.`), { swapped: true });
// A link inside floorboss's data folder on the way to a read, as for a write (linkRefusal), by the path as written:
// floorboss never makes one there. Without regard to case, as linkRefusal. (walkTo below finds the same by the folders
// themselves, however the path is spelled.)
function readLinkRefusal(p) {
  const { links } = followed(p);
  if (!links.length) return null;
  const h = [resolve(home()), real(home())].map((r) => r.toLowerCase());
  const inData = links.find((l) => h.some((r) => l.toLowerCase().startsWith(r + sep)));
  return inData ? inDataLink(p, inData) : null;
}
// Where p really is, found one folder at a time: from the root, each name looked at in the folder before it (the
// process stands in that folder, so no name above it is looked up again), a link followed by its text, and each folder
// entered checked to be the one just looked at. A folder flipped to a link and back while this runs can't pass for the
// other: the folder entered is the one looked at, or the walk is tried again. Returns the path walked (real), whether
// it ends inside the data folder (found by the data folder's own identity, not by its spelling: another case on a
// case-insensitive disk, or a link outside it, still counts), the first link met inside the data folder (dataLink), and
// the file opened from inside that folder (fd, never through a link at the end) with its stat. The working folder is
// put back before it returns.
const idOf = (s) => `${s.dev}:${s.ino}`;
// Set once a walk couldn't put the working folder back: every read after it is refused.
let cwdLost = false;
const CWD_LOST = (p) => `floorboss can't check ${p}: the folder this command runs in was removed while it read a file. Run the command again from a folder that exists.`;
function walkTo(p) {
  if (cwdLost) throw new Error(CWD_LOST(p));
  let saved;
  let savedId;
  try {
    saved = process.cwd();
    savedId = idOf(lstatSync('.'));
    // The folder of that name is still the one the process stands in, and can be entered again, before anything
    // moves: one it can't come back to (removed, or not open to it) is said now, with the process still where it was.
    // (Looked at by name first: on macOS a chdir from a removed folder takes the better part of a minute to fail.)
    if (idOf(lstatSync(saved)) !== savedId) throw new Error('moved');
    process.chdir(saved);
  } catch (e) {
    // A worker thread can't change folders (only the main thread reads checked files).
    if (e?.code === 'ERR_WORKER_UNSUPPORTED_OPERATION') throw new Error(`${p}: floorboss reads checked files on its main thread only.`);
    throw new Error(`floorboss can't check ${p}: it can't go back to the folder this command runs in (removed, or not open to you). Run it from a folder that exists and is yours.`);
  }
  let homeId = null;
  try {
    homeId = idOf(statSync(home()));
  } catch {
    /* no data folder: nothing is inside it */
  }
  const names = resolve(String(p)).split(sep).filter(Boolean);
  const leaf = names.pop();
  if (!leaf) throw new Error(`${p} isn't a plain file.`);
  let stack;
  const toRoot = () => {
    process.chdir(sep);
    const s = lstatSync('.');
    stack = [{ at: sep, id: idOf(s), inData: idOf(s) === homeId }];
  };
  let dataLink = null;
  let hops = 0;
  // The file opened at the end: closed here on any failure before it is handed back.
  let fd;
  try {
    toRoot();
    const queue = [...names];
    while (queue.length) {
      const name = queue.shift();
      const top = stack[stack.length - 1];
      if (name === '.') continue;
      if (name === '..') {
        if (stack.length > 1) {
          process.chdir('..');
          stack.pop();
          if (idOf(lstatSync('.')) !== stack[stack.length - 1].id) throw swappedError(p);
        }
        continue;
      }
      const st = lstatSync(name);
      if (st.isSymbolicLink()) {
        if (top.inData && !dataLink) dataLink = join(top.at, name);
        if (++hops > 40) throw new Error(`${p} goes through more than 40 links.`);
        const to = readlinkSync(name);
        if (to.startsWith(sep)) toRoot();
        queue.unshift(...to.split(sep).filter(Boolean));
        continue;
      }
      // The open went through a folder here: anything else now is a change.
      if (!st.isDirectory()) throw swappedError(p);
      process.chdir(name);
      const now = lstatSync('.');
      if (idOf(now) !== idOf(st)) throw swappedError(p);
      stack.push({ at: join(top.at, name), id: idOf(now), inData: top.inData || idOf(now) === homeId });
    }
    const top = stack[stack.length - 1];
    try {
      fd = openSync(leaf, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
    } catch (e) {
      if (e.code === 'ELOOP' || e.code === 'EMLINK') throw new Error(`${p} is a link: floorboss reads plain files only.`);
      throw e;
    }
    let st;
    try {
      st = fstatSync(fd);
    } catch (e) {
      closeSync(fd);
      fd = undefined;
      throw e;
    }
    return { real: join(top.at, leaf), inData: top.inData, dataLink, fd, st };
  } finally {
    // Back in the folder it started in: that very folder (its identity), not just one at that name. The check is made
    // twice before it counts as failed (a look that fails once, then shows the same folder, is that folder).
    const back = () => {
      process.chdir(saved);
      return idOf(lstatSync('.')) === savedId;
    };
    let home0 = false;
    for (let i = 0; i < 2 && !home0; i++) {
      try {
        home0 = back();
        if (!home0) break;
      } catch {
        /* tried again once */
      }
    }
    if (!home0) cwdLost = true;
    // Renamed or removed while this ran, or another folder put at its name: the process goes nowhere near the walk's
    // folders or that name, so nothing more is read, and the working folder no longer counts as a place lists come
    // from (allowedPath).
    if (cwdLost) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* closed already */
        }
      }
      toNowhere();
      throw new Error(CWD_LOST(p));
    }
  }
}
// An empty folder of floorboss's own in the temp folder, that nobody can put anything in (mode 500): where the process
// stands once it can't stand where it started, so a relative name reads nothing and writes nothing. Never "/" and never
// a folder the walk passed. If even that can't be made, the process stops.
function toNowhere() {
  try {
    const d = mkdtempSync(join(tmpdir(), 'floorboss-nowhere-'));
    chmodSync(d, 0o500);
    process.chdir(d);
  } catch (e) {
    process.stderr.write(`floorboss: the folder this command runs in was removed while it read a file, and floorboss couldn't step out of its own folders (${e?.code || e?.message}). Run the command again from a folder that exists.\n`);
    process.exit(70);
  }
}
function readCheckedOnce(p, maxBytes, { raw = false }) {
  {
    const why = readLinkRefusal(p);
    if (why) throw new Error(why);
  }
  let fd;
  try {
    fd = openSync(p, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
  } catch (e) {
    if (e.code === 'ELOOP' || e.code === 'EMLINK') throw new Error(`${p} is a link: floorboss reads plain files only.`);
    throw e;
  }
  let w = null;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${p} isn't a plain file.`);
    if (st.size > maxBytes) throw new Error(`${p} is over ${Math.round(maxBytes / 1048576)} MB.`);
    // A file with a second name (a hard link), judged by the open file itself (fstat), wherever it is: every path check
    // goes by name, and its other name could be a key. floorboss never makes one (it writes by rename), and no list or
    // file of the user's needs one.
    if (st.nlink > 1) throw new Error(twoNames(p));
    // The file opened is still the one at that name now (a file swapped in after the open is caught).
    const rp = realpathSync.native(p);
    const at = lstatSync(rp);
    if (at.ino !== st.ino || at.dev !== st.dev) throw swappedError(p);
    // And where it is, by the folders themselves (walkTo): the file is opened again from inside the folder walked to,
    // and that is the file read. With no other name, that folder is where it is, whatever any name on the way pointed
    // to at the first open or the checks above. Every judgement below is of that place and that file.
    w = walkTo(p);
    if (w.dataLink) throw new Error(inDataLink(p, w.dataLink));
    if (!w.st.isFile()) throw new Error(`${p} isn't a plain file.`);
    if (w.st.size > maxBytes) throw new Error(`${p} is over ${Math.round(maxBytes / 1048576)} MB.`);
    if (w.st.nlink > 1) throw new Error(twoNames(p));
    if (!w.inData && SENSITIVE.test(w.real) && !inPlugin(w.real))
      throw new Error(`${p} is in a place floorboss never reads (keys, credentials, system or shell config).`);
    if (SENSITIVE.test(rp) && !rp.startsWith(real(home()) + sep) && !inPlugin(rp))
      throw new Error(`${p} is in a place floorboss never reads (keys, credentials, system or shell config).`);
    const shared = [tmpdir(), '/tmp', '/private/tmp'].some((r) => existsSync(r) && (under(rp, real(r)) || under(w.real, real(r))));
    if (shared && typeof process.getuid === 'function' && (st.uid !== process.getuid() || w.st.uid !== process.getuid()))
      throw new Error(`${p} is in a shared temp folder and isn't yours: floorboss doesn't read it.`);
    notSensitive(p);
    const size = Number(w.st.size);
    const b = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = readSync(w.fd, b, off, size - off, off);
      if (!n) break;
      off += n;
    }
    return raw ? b.subarray(0, off) : b.subarray(0, off).toString('utf8');
  } finally {
    closeSync(fd);
    if (w?.fd !== undefined) closeSync(w.fd);
  }
}
