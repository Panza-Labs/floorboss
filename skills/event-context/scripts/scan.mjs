// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// What the user's Claude setup already has, found before onboarding asks anything: skills, agents, plugins
// and configured MCP servers, sorted into what floorboss cares about (outbound writing, voice and brand,
// company context, CRM, mailbox, calendar, enrichment, browser, research). Read-only. MCP servers are listed
// by name and kind only: their commands, environment and headers (where keys live) are never read out.
// Connectors that live in claude.ai rather than in a file are added by Claude from its own tool list.
import { existsSync, readFileSync, readdirSync, statSync, lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export const KINDS = {
  outbound:
    /\b(outbound|sdr|bdr|cold[- ]?(email|outreach)|prospect\w*|sequence\w*|outreach|copywrit\w*|sales[- ]?(email|writer|messag\w*)|linkedin[- ]?(message|outreach|dm)|follow[- ]?ups?|email writer|ae[- ]assistant)\b/i,
  voice:
    /\b(brand voice|tone of voice|(my|our|house|writing|sales|email) (voice|tone|style)|voice (guide|profile|skill)|style[- ]?guide|writing[- ]?style|humani[sz]er|copy ?guidelines)\b/i,
  company_context:
    /\b(icp|ideal customer|persona|positioning|messaging|case[- ]?stud\w*|pitch|value prop\w*|product context|company context|battlecard|competitor|one[- ]?pager)\b/i,
  crm: /\b(crm|hubspot|salesforce|pipedrive|attio|close\.?com|zoho|affinity|folk|copper|dynamics)\b/i,
  email: /\b(gmail|outlook|e-?mail|inbox|mailbox|superhuman)\b/i,
  calendar: /\b(calendar|gcal|cal\.com|calendly|schedul\w*)\b/i,
  enrichment: /\b(clay|apollo|zoominfo|clearbit|enrich\w*|people ?data|pdl|hunter|lusha|rocketreach|cognism|seamless|contactout|findymail|prospeo)\b/i,
  browser: /\b(browser|chrome|playwright|puppeteer|computer[- ]use)\b/i,
  chat: /\b(whatsapp|telegram|signal|imessage|sms|twilio|slack|teams|discord|messenger)\b/i,
  research: /\b(web ?search|exa|perplexity|tavily|serp|firecrawl|research)\b/i
};

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  const get = (k) => (m ? (new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(m[1]) || [])[1] : null);
  return { name: get('name')?.replace(/^["']|["']$/g, '') || null, description: get('description')?.replace(/^["']|["']$/g, '') || null };
}
// Read at most 20 KB of a regular file: a FIFO, a device, a directory or a symlink loop is skipped, never
// waited on or crashed over.
function readSmall(p) {
  try {
    const st = statSync(p);
    if (!st.isFile()) return null;
    const fd = openSync(p, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, 20000));
      readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
const kindsOf = (text) =>
  Object.entries(KINDS)
    .filter(([, re]) => re.test(text))
    .map(([k]) => k);
// A skill or agent counts as a CRM, mailbox, calendar or browser tool only by its name ("hubspot-sync"), not
// because its description mentions email ("emailing a deck"); writing kinds come from name and description.
const TOOL_KINDS = new Set(['crm', 'email', 'calendar', 'browser', 'chat']);
// A writer named for email ("cold-email-writer") writes email; it isn't a mailbox.
const WRITER_NAME = /\b(writer|writing|copy|outreach|outbound|sequence|template|cold)\b/i;
const kindsOfWorker = (name, desc) => [
  ...new Set([
    ...kindsOf(`${name} ${desc}`).filter((k) => !TOOL_KINDS.has(k)),
    ...kindsOf(String(name).replace(/[-_]/g, ' ')).filter((k) => TOOL_KINDS.has(k) && !(WRITER_NAME.test(String(name).replace(/[-_]/g, ' ')) && k === 'email'))
  ])
];
const safeDirs = (d) => {
  try {
    return existsSync(d)
      ? readdirSync(d).filter((x) => {
          try {
            return statSync(join(d, x)).isDirectory();
          } catch {
            return false;
          }
        })
      : [];
  } catch {
    return [];
  }
};
const safeFiles = (d, ext) => {
  try {
    return existsSync(d) ? readdirSync(d).filter((x) => x.endsWith(ext)) : [];
  } catch {
    return [];
  }
};

// What an agent's own tools let it do. No tools line means it gets every tool in the session.
export function toolsRisk(tools) {
  if (tools == null) return 'all tools';
  const list = String(tools)
    .replace(/[\[\]"']/g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean);
  if (!list.length) return 'none';
  const READ = /^(Read|Grep|Glob|WebSearch|WebFetch|LS|NotebookRead)$/;
  const mcpRead = (t) =>
    /^mcp__[^_]+(?:_[^_]+)*__(get|list|search|find|read|query|lookup|fetch|describe|show|view|count)[_-]/i.test(t) &&
    !/send|post|create|update|delete|write|add|enroll|sequence|draft|reply|dispatch|publish|submit|forward|share|invite|schedule|upload|merge|trigger|remove|notify|execute|import/i.test(
      t.split('__').pop()
    );
  return list.every((t) => READ.test(t) || mcpRead(t)) ? 'reads' : 'can send or write';
}

function skillsIn(dir, source) {
  return safeDirs(dir)
    .slice(0, 500)
    .flatMap((name) => {
      const p = join(dir, name, 'SKILL.md');
      const text = readSmall(p);
      if (text == null) return [];
      const fm = frontmatter(text);
      return [
        {
          type: 'skill',
          name: fm.name || name,
          description: (fm.description || '').slice(0, 300),
          path: p,
          source,
          kinds: kindsOfWorker(fm.name || name, fm.description || ''),
          size: text.length
        }
      ];
    });
}
function agentsIn(dir, source) {
  return safeFiles(dir, '.md')
    .slice(0, 500)
    .flatMap((f) => {
      const p = join(dir, f);
      const text = readSmall(p);
      if (text == null) return [];
      const fm = frontmatter(text);
      // tools: from the front matter only; a "tools: Read" line in the body says nothing about what the agent gets.
      const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || '';
      const tools = (/^tools:\s*(.+)$/m.exec(head) || [])[1] || null;
      return [
        {
          type: 'agent',
          name: fm.name || basename(f, '.md'),
          description: (fm.description || '').slice(0, 300),
          path: p,
          source,
          tools,
          tools_risk: toolsRisk(tools),
          kinds: kindsOfWorker(fm.name || f, fm.description || ''),
          size: text.length
        }
      ];
    });
}
// MCP servers from a config object: names and kind only.
function serversIn(obj, source) {
  return Object.entries(obj?.mcpServers || {})
    .slice(0, 200)
    .map(([name, v]) => {
      let host = '';
      try {
        host = v?.url ? new URL(v.url).hostname : '';
      } catch {
        host = '';
      }
      const args = Array.isArray(v?.args) ? v.args.map(String).join(' ') : '';
      return {
        type: 'mcp',
        name: String(name).slice(0, 80),
        transport: v?.type || (v?.url ? 'http' : 'stdio'),
        source,
        kinds: kindsOf(`${name} ${String(v?.command || '')} ${args} ${host}`)
      };
    });
}

// home: the user's home folder; cwd: the project folder Claude runs in.
// FLOORBOSS_SCAN_HOME / FLOORBOSS_SCAN_CWD point the scan somewhere else (tests, which must
// never read the user's own setup).
export function scan({ home = process.env.FLOORBOSS_SCAN_HOME || homedir(), cwd = process.env.FLOORBOSS_SCAN_CWD || process.cwd() } = {}) {
  const items = [];
  // Claude Code's own config folder: CLAUDE_CONFIG_DIR when set (as Claude Code reads it), else ~/.claude.
  const claude = !process.env.FLOORBOSS_SCAN_HOME && process.env.CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CONFIG_DIR : join(home, '.claude');
  items.push(...skillsIn(join(claude, 'skills'), 'user'), ...skillsIn(join(cwd, '.claude', 'skills'), 'project'));
  items.push(...agentsIn(join(claude, 'agents'), 'user'), ...agentsIn(join(cwd, '.claude', 'agents'), 'project'));
  // Installed plugins: their skills and agents (floorboss itself is left out).
  try {
    const inst = JSON.parse(readFileSync(join(claude, 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [id, versions] of Object.entries(inst.plugins || {})) {
      if (/^floorboss@/.test(id)) continue;
      const v = (versions || [])[0];
      if (!v?.installPath) continue;
      items.push(...skillsIn(join(v.installPath, 'skills'), `plugin ${id}`), ...agentsIn(join(v.installPath, 'agents'), `plugin ${id}`));
    }
  } catch {
    /* no plugins */
  }
  try {
    const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    items.push(...serversIn(cfg, 'user'));
    items.push(...serversIn(cfg.projects?.[cwd], 'project (user config)'));
  } catch {
    /* no user config */
  }
  try {
    items.push(...serversIn(JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8')), 'project .mcp.json'));
  } catch {
    /* none */
  }
  // The same file found twice (the project folder is the home folder) or the same server in two configs: once.
  const seen = new Set();
  return summarize(
    items.filter((x) => {
      const k = x.path || `${x.type}:${x.name}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
  );
}

// What a server's tools say it is: a mailbox reads threads, inboxes or messages; a CRM reads contacts, deals,
// companies or owners; a calendar reads events or free/busy. Judged on the read tools (a CRM's
// "send_marketing_email" doesn't make it a mailbox).
export function toolKinds(tools) {
  const words = (t) =>
    String(t)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean);
  // A read tool has a read verb in its name, first or after the app's own prefix ("notion-calendar-list-events").
  const reads = tools.map(words).filter((w) => w.some((x) => ['get', 'list', 'search', 'find', 'read', 'query', 'lookup', 'fetch'].includes(x)));
  const has = (re) => reads.some((w) => w.some((x) => re.test(x)));
  const k = [];
  // A mailbox reads threads or an inbox; a CRM that can send marketing email doesn't. Google Workspace-style
  // servers read both mail and contacts: they are a mailbox (and only a CRM if they also read deals or owners).
  if (
    has(/^(thread|threads|inbox|mailbox)$/) ||
    (has(/^(message|messages|mail|mails|emails?|conversation|conversations)$/) && !has(/^(deal|deals|lead|leads|pipeline|engagements)$/))
  )
    k.push('email');
  if (
    has(/^(deal|deals|company|companies|owner|owners|lead|leads|opportunit\w*|pipeline|activities|engagements)$/) ||
    (has(/^(contact|contacts|person|persons|people)$/) && !k.includes('email'))
  )
    k.push('crm');
  if (has(/^(event|events|calendar|calendars|freebusy|availability|schedule)$/)) k.push('calendar');
  if (tools.some((t) => /whatsapp|telegram|signal|sms|imessage/i.test(t))) k.push('chat');
  // Playwright's tools carry a browser_ prefix: one that navigates, so a stray browser_find alone never counts.
  if (tools.some((t) => /^(navigate|read_page|get_page_text|computer|screenshot|browser_navigate)$/.test(t))) k.push('browser');
  return k;
}

// session: names Claude sees in its own tool list ({mcp:[server names], skills:[...], agents:[...]}),
// for connectors and built-ins no file shows.
export function summarize(items, session = null) {
  // floorboss's own skills and agents aren't the user's tools.
  const own = (x) => /^floorboss[:@]/i.test(String(x?.name || x || ''));
  const all = items.filter((x) => !own(x));
  // A server can be given with its tool names ({"name":"claude_ai_Notion","tools":["notion-calendar-list-events"]}):
  // a calendar or CRM inside a general app shows in its tools, not its name.
  // The flow's scan step asks for the tool names as Claude sees them ("mcp__<server>__<tool>"): grouped by
  // server here, so a CRM or mailbox is recognised from its tools as well as its name.
  const grouped = {};
  for (const t of Array.isArray(session?.tools) ? session.tools.slice(0, 2000) : []) {
    const m = /^mcp__(.+?)__(.+)$/.exec(String(t));
    if (m) (grouped[m[1]] ||= []).push(m[2]);
  }
  const fromTools = Object.entries(grouped).map(([name, tools]) => ({ name, tools }));
  for (const m of [...(session?.mcp || []), ...fromTools]) {
    const name = typeof m === 'string' ? m : m?.name;
    if (!name) continue;
    const tools = typeof m === 'object' && Array.isArray(m.tools) ? m.tools.slice(0, 300).map(String) : [];
    // A CRM by name (Pipedrive, HubSpot) that reads the mail it logged is still a CRM, never the user's mailbox:
    // it has nothing to send from.
    const named = kindsOf(name.replace(/[-_]/g, ' '));
    const crmOnly = named.includes('crm') && !/mail|inbox|outlook|gmail/i.test(name);
    const kinds = [...new Set([...named, ...toolKinds(tools).filter((k) => !(k === 'email' && crmOnly))])];
    const prev = all.find((x) => x.type === 'mcp' && x.name === name);
    if (prev) prev.kinds = [...new Set([...prev.kinds, ...kinds])];
    else all.push({ type: 'mcp', name, transport: 'session', source: 'this session', kinds });
  }
  for (const s of (session?.skills || []).filter((x) => !own(x)))
    if (!all.some((x) => x.type === 'skill' && x.name === (s.name || s)))
      all.push({
        type: 'skill',
        name: s.name || s,
        description: s.description || '',
        source: 'this session',
        kinds: kindsOfWorker(s.name || s, s.description || '')
      });
  for (const s of (session?.agents || []).filter((x) => !own(x)))
    if (!all.some((x) => x.type === 'agent' && x.name === (s.name || s)))
      all.push({
        type: 'agent',
        name: s.name || s,
        description: s.description || '',
        source: 'this session',
        kinds: kindsOfWorker(s.name || s, s.description || '')
      });
  const by = (k) => all.filter((x) => x.kinds.includes(k));
  const writers = all.filter((x) => (x.type === 'skill' || x.type === 'agent') && x.kinds.includes('outbound'));
  const has = (k, type) => all.some((x) => x.kinds.includes(k) && (!type || x.type === type));
  // How much outbound tooling exists: none, partial (something, but no voice or no company context), or full.
  const outbound = !writers.length ? 'none' : writers.some((w) => w.kinds.includes('voice') && w.kinds.includes('company_context')) ? 'full' : 'partial';
  return {
    items: all,
    found: Object.fromEntries(Object.keys(KINDS).map((k) => [k, by(k).map((x) => `${x.type}:${x.name}`)])),
    outbound,
    writers: writers.map((w) => ({
      name: w.name,
      type: w.type,
      path: w.path || null,
      kinds: w.kinds,
      ...(w.type === 'agent' ? { tools: w.tools ?? null, tools_risk: w.tools_risk || toolsRisk(w.tools) } : {})
    })),
    counts: {
      skills: all.filter((x) => x.type === 'skill').length,
      agents: all.filter((x) => x.type === 'agent').length,
      mcp: all.filter((x) => x.type === 'mcp').length
    }
  };
}
