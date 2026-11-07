// Shared by the second first-time-user review's tests: a temp home, the mock event, a real event's ledger.
// Loaded first, so even a bare node --test can't reach the real home.
import './isolated-home.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, NOW } from './harness.mjs';
import { ATTENDEES } from '../../examples/mock-event/mock-data.mjs';

export const MOCK = 'mock-harbour-haul';
export const envOf = (HOME, extra = {}) => ({ ...process.env, FLOORBOSS_TEST: '1', FLOORBOSS_HOME: HOME, FLOORBOSS_NOW: NOW, FLOORBOSS_SCAN_HOME: join(HOME, 'scan-home'), FLOORBOSS_SCAN_CWD: join(HOME, 'scan-home'), ...extra });
export const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
export const node = (HOME, file, args) => JSON.parse(execFileSync('node', [join(ROOT, file), ...args], { env: envOf(HOME), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
export const run = (HOME, skill, args) => { try { return node(HOME, `skills/${skill}/scripts/cli.mjs`, args); } catch (e) { return { ERROR: String(e.stderr || e.message).slice(0, 800) }; } };
export const loadMock = (HOME) => node(HOME, 'examples/mock-event/load.mjs', ['--goal', 'buyers', '--now', NOW]);
export const answer = (HOME, ask, value, event = MOCK) => { const f = join(HOME, 'work', `${ask}-answer.json`); writeFileSync(f, typeof value === 'string' ? value : JSON.stringify(value)); return run(HOME, 'flow', ['answer', '--event', event, '--ask', ask, '--value-file', f]); };
export function home() {
  const HOME = mkdtempSync(join(tmpdir(), 'fb-r2-'));
  mkdirSync(join(HOME, 'work'), { recursive: true });
  mkdirSync(join(HOME, 'scan-home'), { recursive: true });
  return HOME;
}
// A real event on this device with one ledger entry per person: sent a first message, or said stop.
export function realEvent(HOME, slug, people) {
  const dir = join(HOME, 'events', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'event.json'), JSON.stringify({ slug, name: 'Northgate Summit', city: 'Porto', time_zone: 'Europe/Lisbon', start_date: '2026-09-01', end_date: '2026-09-02', settings: {} }));
  const lines = people.flatMap((p, i) => {
    const id = `c${String(i + 1).padStart(3, '0')}`;
    const base = [{ at: '2026-09-01T08:00:00Z', type: 'person', who: 'floorboss', id, name: p.name, email: p.email, company: p.company, keys: [`e:${p.email}`] }];
    return p.stop ? [...base, { at: '2026-09-01T09:00:00Z', type: 'stop', who: 'user', id, said: 'asked to stop' }] : [...base, { at: '2026-09-01T09:00:00Z', type: 'sent', who: 'floorboss', id, touch: 1, date: '2026-09-01' }];
  });
  writeFileSync(join(dir, 'ledger.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return dir;
}
export const mockPerson = (i) => { const [first, last, , company, email] = ATTENDEES[i]; return { name: `${first} ${last}`, company, email }; };
export const PEOPLE = 'Name,Title,Company,Email\nOla Ops,COO,Acme,ola@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n';
export const CRM = 'Name,Email,Company,Owner,Status,Opted Out\nOla Ops,ola@acme.test,Acme,Pat Teammate,Lead,no\n';
