// The one-use record as floorboss's guard writes it (lib/autosend/guard-record.mjs writeRecord, the function
// hooks/guard.mjs calls), for a test that runs an auto-send command in Claude Code without the guard process. For
// draft-gone, the words are the ones the guard's own question shows (hooks/guard/autosend-gone.mjs draftGoneAsk), or,
// where it would refuse, the file's words as the command reads them.
import { readFileSync } from 'node:fs';
import { writeRecord } from '../../lib/autosend/guard-record.mjs';
import { draftGoneAsk } from '../../hooks/guard/autosend-gone.mjs';

const flag = (a, k) => (a.lastIndexOf(k) >= 0 ? a[a.lastIndexOf(k) + 1] : undefined);
export function seen(HOME, args, nowMs = Date.now()) {
  let said = null;
  if (args[0] === 'draft-gone') {
    const prev = process.env.FLOORBOSS_HOME;
    process.env.FLOORBOSS_HOME = HOME;
    try {
      said = draftGoneAsk(['node', 'cli.mjs', ...args].map((x) => `'${String(x).replace(/'/g, "'\\''")}'`).join(' '), nowMs).said ?? null;
    } finally {
      process.env.FLOORBOSS_HOME = prev;
    }
    if (said == null) said = flag(args, '--said') ?? (flag(args, '--said-file') ? readFileSync(flag(args, '--said-file'), 'utf8') : null);
  }
  return writeRecord(HOME, args, { said });
}

// The words, with the record written first: autosend(HOME, withSeen(HOME, [...]), { claude: true }).
export const withSeen = (HOME, args, nowMs) => (seen(HOME, args, nowMs), args);

// A state-changing call in Claude Code with no record (a form the guard didn't see), in a fresh routine event: what
// the CLI said, and whether the event's files are as they were.
export async function withoutRecord(verb) {
  const { world, autosend, said, EVENT, SLUG, OWN, PEOPLE } = await import('./autosend-world.mjs');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const w = world({ touches: 1, event: { ...EVENT, autosend: verb !== 'on', autosend_mode: 'routine' } });
  const snap = () => readFileSync(join(w.evDir, 'event.json'), 'utf8') + readFileSync(join(w.evDir, 'ledger.jsonl'), 'utf8');
  const before = snap();
  const args = {
    on: ['on', '--event', SLUG, '--said-file', said(w.HOME, 'yes turn it on'), '--own', OWN],
    approve: ['approve', '--event', SLUG, '--digest', '0'.repeat(64)],
    revoke: ['revoke', '--event', SLUG, '--ids', PEOPLE[0].id, '--said-file', said(w.HOME, 'stop auto-send for Ana')],
    'draft-gone': ['draft-gone', '--event', SLUG, '--id', PEOPLE[0].id, '--touch', '1', '--said-file', said(w.HOME, 'not in Sent or Drafts')],
    drafts: ['drafts', 'next', '--event', SLUG, '--run', 'new'],
    'routine-saved': ['routine-saved', '--event', SLUG, '--id', 'trig_01NORECORD00000001'],
    'routine-checked': ['routine-checked', '--run', 'rc-000000000000'],
    remote: ['remote', '--confirm', 'https://github.com/me/floorboss-data.git']
  }[verb];
  const r = autosend(w.HOME, args, { claude: true });
  return { error: String(r.ERROR || ''), unchanged: snap() === before };
}
