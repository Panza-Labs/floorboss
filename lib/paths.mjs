// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Where floorboss keeps its data. Everything lives outside the user's project
// so personal data can't be committed by accident.
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname, basename, sep } from 'node:path';
import {
  mkdirSync,
  realpathSync,
  existsSync,
  chmodSync,
  readdirSync,
  writeFileSync,
  lstatSync,
  readlinkSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  constants as FS
} from 'node:fs';

export function home() {
  const h = process.env.FLOORBOSS_HOME;
  if (h) return resolve(h);
  return join(homedir(), '.floorboss');
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
function real(p) {
  let cur = resolve(p),
    tail = '';
  while (!existsSync(cur) && dirname(cur) !== cur) {
    // (basename, not a slice after dirname: under / that slice dropped the first letter, "/ETC" became "/TC".)
    tail = join(basename(cur), tail);
    cur = dirname(cur);
  }
  // The native call returns names as the disk stores them: on a case-insensitive disk (APFS by default)
  // "~/.AWS" comes back as "~/.aws", so a key folder or a record can't be reached under another spelling.
  return join(realpathSync.native(cur), tail);
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
const ENV_NAME = /^(.*?)\.env(rc)?((?:[-_.][\w-]*)*)$/;
const SOURCE_EXT = /\.(?:js|ts|mjs|cjs|jsx|tsx|json|ya?ml|md|graphql)$/;
function envFile(name) {
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
const SECRET = {
  test: (p) => {
    const parts = String(p).split('/');
    return SECRET_PLACES.test(p) || envFile(parts[parts.length - 1]) || parts.slice(0, -1).some((d) => /^\.env\.d$/i.test(d));
  }
};
// CONFIG: shell, app and Claude configuration, and system folders. Scripts never read there; Claude's own
// reads are refused there only while a floorboss run is under way (lib/runlock.mjs).
// Both are matched without regard to case: on a case-insensitive disk "~/.AWS/credentials" is the same file
// as "~/.aws/credentials".
const CONFIG =
  /(^|\/)(\.config|\.claude|\.zshrc|\.zshenv|\.bashrc|\.bash_profile|\.profile|\.zprofile|\.zlogin|\.inputrc|\.gitconfig)(\/|$)|^\/(etc|private\/etc|var|usr|System|bin|sbin)\//i;
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
  let cur = '/';
  const parts = resolve(String(p)).split(sep).filter(Boolean);
  for (let i = 0, hops = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    let st = null;
    try {
      st = lstatSync(cur);
    } catch {
      /* not there: the rest of the path is text */
    }
    if (!st?.isSymbolicLink()) continue;
    if (++hops > 40) throw new Error(`${p} goes through more than 40 links.`);
    links.push(cur);
    // The link's target, then whatever is left of the path, walked again (a target may hold links itself).
    const rest = parts.slice(i + 1);
    const to = resolve(dirname(cur), readlinkSync(cur));
    parts.splice(0, parts.length, ...to.split(sep).filter(Boolean), ...rest);
    i = -1;
    cur = '/';
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
  if (inData) return `${p} goes through a link (${inData}) inside floorboss's data folder, and floorboss doesn't write through links there.`;
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
    ? `${p} has another name on the disk (a hard link), and floorboss doesn't read or write such a file in its data or temp folder: its other name could be a key or a shell profile.`
    : null;
}
// Does the path as written (not followed through links) name a key place? The guard compares it with the real path's tier.
export const secretPlace = (p) => SECRET.test(resolve(String(p)));

// Data folders made before floorboss set private permissions on everything it writes: on each script run the
// data folder itself is made private (700), and once, every folder (700) and file (600) inside it.
export function secureHome() {
  const h = home();
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
export function recordFile(p) {
  const h = real(home());
  const rp = real(p);
  if (!(rp === h || rp.startsWith(h + sep))) return false;
  const rel = rp.slice(h.length + 1).split(sep);
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
export function allowedPath(p, { write = false, list = false, ext = null } = {}) {
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
        `${p} is outside the folders floorboss writes to (a work folder: ~/.floorboss/work/ or ~/.floorboss/events/<event>/work/); floorboss's own records are written only by the command that changes them.`
      );
    return rp;
  }
  const cwd = list && (ext || LIST_EXT).test(rp) ? [process.cwd()] : [];
  // /tmp too: on macOS os.tmpdir() is /var/folders/…, but Claude's scratchpad is under /tmp (/private/tmp).
  const roots = write ? [home()] : [home(), tmpdir(), '/tmp', ...cwd, ...(process.env.FLOORBOSS_HOME ? [dirname(resolve(process.env.FLOORBOSS_HOME))] : [])];
  if (!roots.some((r) => existsSync(r) && under(rp, r)) && !(write && rp.startsWith(resolve(home()) + sep))) {
    throw new Error(
      `${p} is outside the folders floorboss ${write ? 'writes to (its data folder)' : list ? 'reads lists from (its data folder, the temp folder, the working folder)' : 'reads from (its data folder and the temp folder): write it under ~/.floorboss/work/ first'}.`
    );
  }
  return rp;
}

// Reads a file a check already passed, without trusting the path a second time: no link at the end (O_NOFOLLOW), a
// regular file, still at the place that was checked, and, in a temp folder other accounts can write to, owned by
// this user. A file swapped for a link to a key after the check is refused, not read.
export function readChecked(p, maxBytes = 20 * 1024 * 1024, { raw = false } = {}) {
  let fd;
  try {
    fd = openSync(p, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
  } catch (e) {
    if (e.code === 'ELOOP' || e.code === 'EMLINK') throw new Error(`${p} is a link: floorboss reads plain files only.`);
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${p} isn't a plain file.`);
    if (st.size > maxBytes) throw new Error(`${p} is over ${Math.round(maxBytes / 1048576)} MB.`);
    // The file opened is still the one at that name now (a file swapped in after the open is caught; a swapped
    // parent folder is followed by both, and notSensitive below judges where it led).
    const at = lstatSync(realpathSync(p));
    if (at.ino !== st.ino || at.dev !== st.dev) throw new Error(`${p} changed while floorboss read it.`);
    const shared = [tmpdir(), '/tmp', '/private/tmp'].some((r) => existsSync(r) && under(real(p), real(r)));
    if (shared && typeof process.getuid === 'function' && st.uid !== process.getuid())
      throw new Error(`${p} is in a shared temp folder and isn't yours: floorboss doesn't read it.`);
    notSensitive(p);
    const b = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, b, off, st.size - off, off);
      if (!n) break;
      off += n;
    }
    return raw ? b.subarray(0, off) : b.subarray(0, off).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
