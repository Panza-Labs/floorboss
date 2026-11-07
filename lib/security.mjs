// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// What the guard hook and the outbox need to know about browsers and web addresses: which MCP calls drive a
// browser, which of those run script in a page, how to read a URL however it is encoded, and which hosts
// floorboss has any reason to open (LinkedIn profiles, the event apps it knows, CRM web apps, the event's own
// site).
import { statSync } from 'node:fs';

// A browser server, by name. The name alone isn't enough: a call counts as a browser call only when its tool
// is one a browser exposes too (isBrowserCall), so "chrome-mail__send_email" is held to the rules for any
// other server, not the browser's.
const BROWSER_SERVER = /browser|chrome|chromium|playwright|puppeteer|webdriver|selenium|stagehand|computer[-_]?use/i;
// Tool names browsers expose (Claude in Chrome, the built-in browser, Playwright and Puppeteer servers),
// with any "browser_" prefix and "_mcp" suffix taken off.
const READ_TOOLS = [
  'navigate',
  'navigate_page',
  'navigate_to',
  'goto',
  'go_to',
  'open_url',
  'navigate_back',
  'go_back',
  'go_forward',
  'read_page',
  'get_page_text',
  'get_page',
  'page_text',
  'get_text',
  'find',
  'screenshot',
  'take_screenshot',
  'snapshot',
  'take_snapshot',
  'scroll',
  'tabs_list',
  'tabs_context',
  'tabs',
  'list_tabs',
  'list_pages',
  'select_page',
  'tabs_create',
  'tab_new',
  'new_page',
  'new_tab',
  'wait',
  'wait_for',
  'console_messages',
  'read_console_messages',
  'network_requests',
  'read_network_requests',
  'get_url',
  'get_title'
];
const ACT_TOOLS = [
  'computer',
  'form_input',
  'click',
  'double_click',
  'hover',
  'type',
  'fill',
  'fill_form',
  'press_key',
  'key',
  'select_option',
  'drag',
  'handle_dialog',
  'file_upload',
  'upload_image',
  'upload_file',
  'close',
  'close_page',
  'resize',
  'resize_window',
  'install',
  'pdf_save',
  'gif_creator',
  'shortcuts_list',
  'shortcuts_execute',
  'keyboard_type',
  'keyboard_press',
  'insert_text'
];
// Tools that run script in the page: never during a run or a send window.
const SCRIPT_TOOLS = [
  'javascript_tool',
  'javascript',
  'evaluate',
  'evaluate_script',
  'execute_script',
  'run_code',
  'run_script',
  'eval',
  'execute_javascript',
  'script'
];
const KNOWN = new Set([...READ_TOOLS, ...ACT_TOOLS, ...SCRIPT_TOOLS]);

// A tool can sit under a nested namespace (mcp__remote-devices__Claude_Browser__navigate): its last part names it.
export const bareBrowserTool = (tool) =>
  String(tool || '')
    .split('__')
    .pop()
    .toLowerCase()
    .replace(/_mcp$/, '')
    .replace(/^(browser|playwright|puppeteer|chrome|page)_/, '');
export const isBrowserServer = (server) => BROWSER_SERVER.test(String(server || ''));
export const isBrowserTool = (tool) => KNOWN.has(bareBrowserTool(tool));
// A browser call: a browser-named server with a browser tool, or a Playwright-style "browser_*" tool on any
// server (Playwright's server may be registered under any name).
// A nested browser server (remote-devices__Claude_Browser) counts as a browser server: its tools get every browser
// rule, the inbox gate and the window rules included.
export function isBrowserCall(server, tool) {
  const parts = String(tool || '').split('__');
  if (isBrowserServer(server) || parts.slice(0, -1).some((x) => isBrowserServer(x))) return isBrowserTool(tool);
  return /^browser_/i.test(parts[parts.length - 1]) && isBrowserTool(tool);
}
export const isScriptTool = (tool) => SCRIPT_TOOLS.includes(bareBrowserTool(tool)) || /javascript|evaluate|execute_?script|run_?code/i.test(String(tool || ''));
export const isBrowserReadTool = (tool) => READ_TOOLS.includes(bareBrowserTool(tool));
export const isNavigateTool = (tool) =>
  ['navigate', 'navigate_page', 'navigate_to', 'goto', 'go_to', 'open_url', 'tabs_create', 'tab_new', 'new_page', 'new_tab'].includes(bareBrowserTool(tool));

// A URL as the browser reads it. The host and scheme come from the raw text, parsed as the browser parses
// it (never from a decoded copy: "brella.io%2f@evil.test" goes to evil.test). The path is then decoded
// (a few times over, for double encoding), case folded and its doubled slashes taken out, so "/%6Dessaging"
// is "/messaging". An address with "@", "%" or a backslash before its host, or one whose decoded copy
// names another host, is marked odd and never allowed. So is one with a port of its own (":8443"), unless
// opts.ports names that host and port ("expo.example:8443", the saved list page's) or is true (reading a
// saved page itself). Returns { host, port, path, href, scheme, odd } or null when the text isn't a web
// address.
const decodeAll = (x) => {
  let s = x;
  for (let i = 0; i < 4; i++) {
    let d;
    try {
      d = decodeURIComponent(s);
    } catch {
      d = s.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }
    if (d === s) break;
    s = d;
  }
  return s;
};
// Control and invisible characters, and the ones that reorder text (bidi), are taken out before an address is read.
const INVISIBLE = /[\u0000-\u0020\u00AD\u061C\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF\u{E0000}-\u{E007F}]+/gu;
function parse(s) {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (!/^(\/\/)?[\w%-]+(\.[\w%-]+)+\.?(:\d+)?([/?#@%\\]|$)/i.test(s)) return null;
    s = `https://${s.replace(/^\/\//, '')}`;
  }
  try {
    return new URL(s);
  } catch {
    return null;
  }
}
export function readUrl(text, opts = {}) {
  const raw = String(text ?? '')
    .trim()
    .replace(INVISIBLE, '');
  if (!raw) return null;
  const u = parse(raw);
  if (!u) {
    // Not a URL as written; a decoded copy that is one (a fully encoded address) is odd, never allowed.
    const d = parse(decodeAll(raw).replace(INVISIBLE, ''));
    return d ? { host: d.hostname.toLowerCase(), path: '', href: d.href, scheme: d.protocol, odd: true } : null;
  }
  if (!['http:', 'https:'].includes(u.protocol)) return { host: '', path: '', href: u.href, scheme: u.protocol };
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');
  const authority = (/^[a-z][a-z0-9+.-]*:\/*([^/?#]*)/i.exec(raw.replace(/\\/g, '/')) || [])[1] ?? '';
  const d = parse(decodeAll(raw).replace(INVISIBLE, '').replace(/\\/g, '/'));
  const port = u.port;
  const portOk = !port || opts.ports === true || (Array.isArray(opts.ports) && opts.ports.includes(`${host}:${port}`));
  const odd =
    /[@%\\]/.test(authority) || /\\/.test(raw) || !!u.username || !!u.password || (d && d.hostname.toLowerCase().replace(/\.+$/, '') !== host) || !portOk;
  const path = decodeAll(u.pathname)
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
  return { host, port, path, href: u.href, scheme: u.protocol, odd };
}
// A page as the guard compares it: scheme, host, port (when it has one of its own) and path, no trailing slash.
export const pageKey = (u) => `${u.scheme}//${u.host}${u.port ? `:${u.port}` : ''}${u.path}`.replace(/\/+$/, '');
// Does any text in this call look like a web address (a scheme, or a host followed by a path)?
// A web address in a value: with a scheme, starting "//", or a dotted host followed by a path, a query or a
// fragment ("collect.evil.example?d=…" opens as a link in most tools).
export const looksLikeUrl = (v) => {
  const t = String(v ?? '');
  return /\b[a-z][a-z0-9+.-]*:\/\//i.test(t) || /(^|\s)\/\/[\w-]+\./.test(t) || /(^|[\s"'(<])(www\.)?[\w-]+(\.[\w-]+)+\.?(:\d+)?[/?#]\S*/i.test(t);
};
// What a web address or search may not carry during a floorboss run, whatever its host: more than WEB_CAP
// characters, a line break, or an email address (a link that holds one is carrying a person out). Null if none.
export const URL_CAP = 300;
const EMAIL_IN = /[^\s@/?#&=]+(@|%40)[^\s@/?#&=]+\.[a-z]{2,}/i;
export function carriesData(text, what = 'address') {
  const t = String(text ?? '');
  if (/[\r\n\u2028\u2029]/.test(t)) return `that ${what} has a line break in it`;
  if (t.length > URL_CAP) return `that ${what} is ${t.length} characters long (the limit is ${URL_CAP})`;
  if (EMAIL_IN.test(t)) return `that ${what} has an email address in it`;
  return null;
}
// CRM web apps where each customer has their own subdomain (acme.my.salesforce.com, acme.pipedrive.com): a
// subdomain there is anyone's, so the browser asks before opening one.
export const TENANT_CRM_ROOTS = ['my.salesforce.com', 'lightning.force.com', 'force.com', 'pipedrive.com', 'monday.com'];
export const tenantCrmHost = (host) => {
  const h = String(host || '').toLowerCase();
  return TENANT_CRM_ROOTS.some((r) => h.endsWith(`.${r}`));
};

const under = (host, root) => host === root || host.endsWith(`.${root}`);
// Event apps floorboss knows (meeting requests and attendee messages). meetwell.test is the fictional app of
// floorboss's own stand-ins (examples/standins/browser-app.mjs), known only under floorboss's own tests.
export const EVENT_APP_HOSTS = [
  'brella.io',
  'swapcard.com',
  'grip.events',
  'whova.com',
  'b2match.io',
  'b2match.com',
  'bizzabo.com',
  'hubilo.com',
  'eventmobi.com',
  'cvent.com',
  'cvent-assets.com',
  'meetmax.com',
  ...(process.env.FLOORBOSS_TEST === '1' ? ['meetwell.test'] : [])
];
// CRM web apps the browser may log activities in.
export const CRM_WEB_HOSTS = [
  'app.hubspot.com',
  'app-eu1.hubspot.com',
  'lightning.force.com',
  'my.salesforce.com',
  'pipedrive.com',
  'app.attio.com',
  'crm.zoho.com',
  'crm.zoho.eu',
  'app.close.com',
  'app.copper.com',
  'app.folk.app',
  'monday.com'
];
// Inside the CRM log window the browser opens only a CRM's contact, record, search and task pages (and its
// sign-in page): not its settings, integrations, imports, workflows or anything else a click there could change.
const CRM_PAGES = [
  ['hubspot.com', /^\/(contacts|tasks|search)(\/|$)/],
  ['force.com', /^\/lightning\/(r|o)\/(contact|lead|account|task|event)(\/|$)|^\/lightning\/search(\/|$)/],
  ['salesforce.com', /^\/lightning\/(r|o)\/(contact|lead|account|task|event)(\/|$)|^\/lightning\/search(\/|$)/],
  ['pipedrive.com', /^\/(person|persons|organization|organizations|activities|activity|search)(\/|$)/],
  ['attio.com', /^\/[^/]+\/(person|people|company|companies|tasks|objects\/(people|companies))(\/|$)/],
  ['zoho.com', /^\/crm\/([^/]+\/)?(tab\/(contacts|leads|accounts|tasks|activities)|search)(\/|$)/],
  ['zoho.eu', /^\/crm\/([^/]+\/)?(tab\/(contacts|leads|accounts|tasks|activities)|search)(\/|$)/],
  ['close.com', /^\/(lead|leads|contact|contacts|search|tasks)(\/|$)/],
  ['copper.com', /^\/companies\/\d+\/app(\/|$)/],
  ['folk.app', /^\/apps\/contacts(\/|$)/],
  ['monday.com', /^\/boards\/\d+(\/|$)/]
];
const SIGN_IN = /^\/((login|signin|sign-in|sign_in|auth|sso)(\/|$))?$/;
export function crmPageAllowed(url) {
  const u = typeof url === 'string' ? readUrl(url) : url;
  if (!u || !u.host || u.odd || u.scheme !== 'https:' || !CRM_WEB_HOSTS.some((r) => under(u.host, r))) return false;
  const rule = CRM_PAGES.find(([root]) => under(u.host, root));
  return SIGN_IN.test(u.path) || !!(rule && rule[1].test(u.path));
}
const LINKEDIN = ['linkedin.com'];
// The LinkedIn pages floorboss has a reason to open: profiles, company pages and (with the user's yes, which
// the guard's inbox rule checks) messaging.
const LINKEDIN_PATH = /^\/(in|pub|company|messaging)(\/|$)/;

// The event's own sites: any web address in its event.json (the list or site link) and the onboarding answers.
export function eventHosts(...sources) {
  const out = new Set();
  const walk = (v, depth = 0) => {
    if (depth > 6 || v == null) return;
    if (typeof v === 'string') {
      if (/url|link|site|web/i.test(walk.key || '')) {
        const u = readUrl(v);
        if (u?.host) out.add(u.host.replace(/^www\./, ''));
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, depth + 1));
      return;
    }
    if (typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        const prev = walk.key;
        walk.key = k;
        walk(x, depth + 1);
        walk.key = prev;
      }
  };
  for (const s of sources) walk(s);
  // A link aggregator or a social site is never an event's own site.
  for (const h of [...out]) if (/(^|\.)(linkedin|google|bit\.ly|facebook|twitter|x\.com|t\.co|instagram)\b/.test(h)) out.delete(h);
  return [...out];
}

// May the browser open this address during a floorboss run? Only LinkedIn profiles (and messaging, which the
// inbox rule also checks), the event apps floorboss knows, CRM web apps and the event's own sites.
// WebFetch passes { crm: false }: it can't use the browser's sign-in, so a CRM web app is no page it needs.
export function hostAllowed(url, extraHosts = [], { crm = true } = {}) {
  const u = typeof url === 'string' ? readUrl(url) : url;
  if (!u || !u.host || u.odd) return false;
  if (LINKEDIN.some((r) => under(u.host, r))) return LINKEDIN_PATH.test(u.path);
  return [...EVENT_APP_HOSTS, ...(crm ? CRM_WEB_HOSTS : []), ...extraHosts].some((r) =>
    under(
      u.host,
      String(r)
        .toLowerCase()
        .replace(/^www\./, '')
    )
  );
}

// A profile link the outbox may show and open: https only, LinkedIn or an event app floorboss knows, or the
// event's own site. Anything else (a link from a list or a CRM field pointing elsewhere) shows no link.
export function profileLinkAllowed(url, extraHosts = []) {
  const u = readUrl(url);
  if (!u || u.scheme !== 'https:' || !u.host || u.odd) return false;
  if (LINKEDIN.some((r) => under(u.host, r))) return /^\/(in|pub|company)\//.test(u.path);
  return [...EVENT_APP_HOSTS, ...extraHosts].some((r) =>
    under(
      u.host,
      String(r)
        .toLowerCase()
        .replace(/^www\./, '')
    )
  );
}
export const isLinkedInProfile = (url) => {
  const u = readUrl(url);
  return !!(u && u.scheme === 'https:' && !u.odd && under(u.host, 'linkedin.com') && /^\/in\//.test(u.path));
};

// Names of key and credential places. SECRET_NAME: folders and files never written by Claude's file tools.
// SECRET_SEARCH: a search by name for any of these (Glob's pattern, a file filter) is a search for keys and
// tokens; a list file given to floorboss whose path names one is refused too. ".env" counts with any ending
// after a dot (".env.local", ".env.production").
export const SECRET_NAME =
  /(^|\/)(\.ssh|\.aws|\.gnupg|\.gcloud|\.azure|\.kube|\.netrc|\.pgpass|\.vault-token|\.password-store|\.[\w-]*_history|Keychains|Cookies|Login Data)(\/|$|\*)/i;
export const SECRET_SEARCH =
  /(^|\/)(\.ssh|\.aws|\.gnupg|\.gcloud|\.azure|\.kube|\.docker|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.pgpass|\.vault-token|\.password-store|\.envrc|\.env(\.[^/]*)?|\.stripe|\.fly|\.pulumi|\.sentryclirc|\.config\/(gcloud|gh|doctl|configstore|stripe|op)|\.[\w-]*_history|Keychains|Cookies|Login Data|id_(rsa|dsa|ecdsa|ed25519)[\w.*]*|[^/]*\.(pem|p12|pfx|kdbx))(\/|$|\*)/i;

// A list file floorboss takes in (attendees, CRM export, do-not-contact, known contacts): a plain file (not a
// folder or a pipe, which would break every later load or hang the copy) of its own kind's file types only,
// never inside .git or node_modules or a key place, and at most 50 MB. It is copied where Claude's Read is
// pre-approved, so nothing else gets in that way. Only the lookups Claude wrote (crm-records, mail-history)
// are JSON; a do-not-contact list is a text or CSV file.
const TABLE = ['csv', 'tsv', 'txt', 'xlsx', 'xls'];
export const LIST_KINDS = {
  attendees: TABLE,
  crm: TABLE,
  accounts: TABLE,
  known: TABLE,
  dnc: ['txt', 'csv'],
  'crm-records': ['json'],
  'mail-history': ['json'],
  ics: ['ics']
};
export const LIST_EXTENSIONS = [...new Set(Object.values(LIST_KINDS).flat())];
export const LIST_MAX_BYTES = 50 * 1024 * 1024;
// path: as resolved (symlinks followed). size: used only when the file isn't there to look at.
export function listFileProblem(path, size, kind = null) {
  const p = String(path || '');
  const exts = LIST_KINDS[kind] || LIST_EXTENSIONS;
  const ext = (/\.([a-z0-9]+)$/i.exec(p) || [])[1];
  if (!ext || !exts.includes(ext.toLowerCase()))
    return `${p} isn't a kind of file floorboss takes ${kind ? `a ${kind === 'dnc' ? 'do-not-contact' : kind === 'known' ? 'contacts' : kind} list` : 'a list'} from (${exts.join(', ')}).`;
  if (p.split('/').some((s) => /^(\.git|node_modules)$/i.test(s)))
    return `${p} is inside a .git or node_modules folder, which never holds a list for floorboss.`;
  if (SECRET_NAME.test(p) || SECRET_SEARCH.test(p)) return `${p} is in a place that holds keys or credentials, and floorboss never reads there.`;
  let st = null;
  try {
    st = statSync(p);
  } catch {
    st = null;
  }
  if (st && !st.isFile()) return `${p} isn't a file (it is a folder, a pipe or a device), so floorboss can't take a list from it. Give the list file itself.`;
  if (Number(st ? st.size : size) > LIST_MAX_BYTES) return `${p} is over 50 MB, more than any list floorboss reads.`;
  return null;
}

// The recipe's own server, compared as written (case aside, and a space as the "_" Claude Code turns it into), with
// claude.ai's own prefix the only alias: "Hub_Spot" or "hub-spot" is another server, never the recipe's;
// "Google Drive" is claude.ai's "claude_ai_Google_Drive".
const bareServer = (s) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/^claude_ai_|^claude\.ai_/, '');
export const sameServer = (got, want) => !!bareServer(got) && bareServer(got) === bareServer(want);
