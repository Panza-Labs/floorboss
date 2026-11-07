// Wording a first-time user reads: reasons without a literal "…", caution notes that name the cell, "next"
// pointers that keep the user in the one loop, help links that land on a section, and the flow skill's step
// shapes as the code returns them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, ROOT } from './fixtures/harness.mjs';
import { helpFor } from '../skills/flow/scripts/steps.mjs';
import { NODES } from '../skills/event-context/scripts/onboarding-tree.mjs';

test('left-out reasons name no address and hold no literal ellipsis', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n', dnc: 'ana@acme.test\n' });
  triage(H);
  const view = cli(H, 'crm-triage', ['view', '--event', H.slug]);
  const why = view.left_out.map((x) => x.why);
  assert.ok(why.some((w) => /^left alone: on your do-not-contact list\b/.test(w)), why.join(" | "));
  for (const w of why) assert.doesNotMatch(w, /…|@/, w);
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  for (const k of Object.keys(load.skipped_because || {})) assert.doesNotMatch(k, /…|@/, k);
});

test('mapping caution notes name the cell: its line and what it says', () => {
  const H = setup({ crm: 'Name,Company,Email,Owner,Status,Opted Out,Misc\nAna Berg,Acme,ana@acme.test,Sam Rivera,Lead,no,\nBo Li,Globex,bo@globex.test,Sam Rivera,Lead,no,not interested this year\n', attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const p = cli(H, 'crm-triage', ['propose-mapping', '--event', H.slug, '--kind', 'crm']);
  const md = readFileSync(p.view, 'utf8');
  assert.match(md, /Misc: 0 stop, 1 caution: line 3 says "not interested this year" \("not interested" can mean a complaint or a dispute: check before writing\)/, md);
});

test('inside the start loop, every "next" says to run flow next, never another command', () => {
  const files = [join(ROOT, 'lib'), ...readdirSync(join(ROOT, 'skills')).map((s) => join(ROOT, 'skills', s, 'scripts'))].flatMap((d) => { try { return readdirSync(d).filter((f) => f.endsWith('.mjs')).map((f) => join(d, f)); } catch { return []; } });
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /\/floorboss:event-(triage|plan)\b/, f);
    // The outbox page (opened outside the loop) may point at the drafting command; nothing else does.
    if (!/outbox\.mjs$/.test(f)) assert.doesNotMatch(src, /\/floorboss:event-draft\b/, f);
    assert.doesNotMatch(src, /[^:]\/event-draft\b/, f);
  }
  const asking = readFileSync(join(ROOT, 'skills/flow/references/asking.md'), 'utf8');
  assert.doesNotMatch(asking, /\/floorboss:event-triage|step 3\.3/);
});

test('help links land on a section of asking.md, for every question', () => {
  const md = readFileSync(join(ROOT, 'skills/flow/references/asking.md'), 'utf8');
  // GitHub's heading anchors: lower case, punctuation dropped (underscores and hyphens kept), spaces to hyphens.
  const anchors = new Set(md.split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => l.replace(/^#+ /, '').toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s/g, '-')));
  for (const id of ['disclaimer', ...NODES.map((n) => n.id)]) {
    const [file, anchor] = helpFor(id).split('#');
    assert.equal(file, 'skills/flow/references/asking.md');
    assert.ok(anchors.has(anchor), `${id}: #${anchor} isn't a heading (${[...anchors].join(', ')})`);
  }
  assert.ok(helpFor('setup_level').endsWith('#reference-how-much-setup-setup_level'));
});

test('the flow skill documents the step shapes the code returns: agents, with input or input_file', () => {
  const skill = readFileSync(join(ROOT, 'skills/flow/SKILL.md'), 'utf8');
  const steps = readFileSync(join(ROOT, 'skills/flow/scripts/steps.mjs'), 'utf8');
  assert.match(steps, /\{\s*agents: /);
  assert.doesNotMatch(steps, /\{\s*agent: /,'the code returns agents (a list), never a single agent');
  assert.match(skill, /^- `agents`:/m);
  assert.match(skill, /`input`/);
  assert.match(skill, /`input_file`/);
  assert.doesNotMatch(skill, /^- `agent`:/m);
  for (const f of ['start', 'event-setup', 'event-draft', 'event-triage', 'event-plan']) assert.doesNotMatch(readFileSync(join(ROOT, 'commands', `${f}.md`), 'utf8'), /`judge`, `agent`, `call`/, f);
});
