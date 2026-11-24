// "added" after the user's own skip: a hold under that skip (do-not-contact, opt-out, a lost deal in its wait, a
// status that means leave alone) keeps the person off the list and out of todo; a plain skip with nothing under it
// is added back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, idOf, triage } from './fixtures/harness.mjs';

const LIST = 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana-berg-test\nBo Free,COO,Freeco,bo@freeco.test,https://www.linkedin.com/in/bo-free-test\n';
const HEAD = 'Name,Email,Company,Owner,Status,Last Contacted,Deal Stage,Unsubscribed\n';
const HOLDS = {
  'do-not-contact': { dnc: 'ana@acme.test\n', crm: HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Lead,,,false\n', status_map: { Lead: 'ignore' } },
  'opt-out': { crm: HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Lead,,,true\n', status_map: { Lead: 'ignore' } },
  'lost deal in its wait': { crm: HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Closed Lost,2026-08-10,,false\n', status_map: { 'Closed Lost': 'lost' }, rejected_months: 6 },
  'leave-alone status': { crm: HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Paused,,,false\n', status_map: { Paused: 'hold' } },
  'no hold': { crm: HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Lead,,,false\n', status_map: { Lead: 'ignore' }, free: true }
};
const world = (h) => {
  const H = setup({ attendees: LIST, crm: h.crm, dnc: h.dnc, settings: { status_map: h.status_map, ...(h.rejected_months != null ? { rejected_months: h.rejected_months } : {}) } });
  const t = triage(H);
  assert.ok(!t.load.ERROR, t.load.ERROR);
  return H;
};

for (const [hold, h] of Object.entries(HOLDS))
  test(`"added" after the user's skip, ${hold}: ${h.free ? 'added back' : 'stays held, and todo has nothing for her'}`, () => {
    const H = world(h);
    const ana = idOf(H, 'Ana Berg');
    const d = cli(H, 'crm-triage', ['decide', '--event', H.slug, '--id', ana, '--group', 'skip', '--because', 'not now']);
    assert.ok(!d.ERROR, d.ERROR);
    const f = join(H.dir, 'rep.json');
    writeFileSync(f, JSON.stringify({ items: [{ who: 'Ana Berg', what: 'added' }] }));
    const r = cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', f]);
    assert.ok(!r.ERROR, r.ERROR);
    if (h.free) {
      assert.ok((r.recorded || []).some((l) => /added/.test(l)), JSON.stringify(r));
      return;
    }
    assert.ok(!(r.recorded || []).some((l) => /added/.test(l)), JSON.stringify(r));
    assert.match(JSON.stringify(r.notes || []), /Ana Berg \(Acme\) is held \(/);
    const t = cli(H, 'event-outreach', ['todo', '--event', H.slug]);
    assert.ok(!t.ERROR, t.ERROR);
    assert.deepEqual(JSON.parse(readFileSync(t.todo_file, 'utf8')).jobs.filter((j) => j.id === ana && j.kind === 'message'), []);
  });
