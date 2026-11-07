// Drafting stays in floorboss (revise, invented-claims check, app-note settings) and contact details come
// from the CRM first, then an enrichment tool (enrich-list, enrich-import).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, idOf, draftApprove, todoJobs } from './fixtures/harness.mjs';
import { checkDraft, ownClaims } from '../skills/event-outreach/scripts/checks.mjs';

test('check: a line that puts an experience or view in the sender\'s mouth fails unless the profile says it', () => {
  const ctx = { contact: { name: 'Ana Sofia Ruiz' }, slotLabels: [], eventName: 'Test Expo', optout: null, pasteLimit: 600, ownFacts: '- Runs ops tooling at Lanecraft\n- Keeps my quotes under human review before anything reaches a client' };
  const p = checkDraft({ channel: 'paste', body: 'Hey Ana Sofia, I run ops tooling and honestly I don\'t know what stays manual vs what to automate. Would love to meet at Test Expo.' }, ctx);
  assert.ok(p.some((x) => /says something about you that your profile doesn't back/.test(x)), p.join(' | '));
  assert.deepEqual(checkDraft({ channel: 'paste', body: 'Hey Ana Sofia, I keep my quotes under human review. Would love to meet at Test Expo.' }, ctx), [], 'backed by the profile');
  assert.deepEqual(ownClaims('Where are you based these days? I run a lot of ops tooling for my team.', ''), []);
});

test('app notes: with times in the app and no event name or opt-out line, a casual note passes the checks', () => {
  const ATT = 'Name,Title,Company,Email\nAna Berg,COO,Acme,\n';
  const casual = setup({ attendees: ATT, event: { app_name: 'Grip' }, settings: { app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false } });
  triage(casual);
  const { jobs } = todoJobs(casual);
  const j = jobs.find((x) => x.id === idOf(casual, 'Ana Berg'));
  assert.equal(j.channel, 'paste');
  assert.deepEqual(j.app_note, { times_in_note: false, event_name_in_note: false, optout_in_note: false });
  const body = 'Hey Ana, I run ops tooling at Lanecraft. Would love to meet up and hear how Acme handles dock scheduling.\n\nSam';
  const saved = cli(casual, 'event-outreach', ['save-draft', '--event', casual.slug, '--id', j.id, '--touch', '1', '--json', JSON.stringify({ body, brief: 'x' })]);
  assert.equal(saved.checks, 'pass', JSON.stringify(saved));
  // The same note under the default settings misses the times, the event and the opt-out line.
  const strict = setup({ attendees: ATT, event: { app_name: 'Grip' } });
  triage(strict);
  const js = todoJobs(strict).jobs.find((x) => x.id === idOf(strict, 'Ana Berg'));
  const s2 = cli(strict, 'event-outreach', ['save-draft', '--event', strict.slug, '--id', js.id, '--touch', '1', '--json', JSON.stringify({ body, brief: 'x' })]);
  assert.ok(Array.isArray(s2.checks) && s2.checks.some((x) => /opt-out/.test(x)) && s2.checks.some((x) => /doesn't name the event/.test(x)), JSON.stringify(s2));
  assert.match(cli(strict, 'event-context', ['config', '--set', JSON.stringify({ app_note_times: 'sometimes' })]).ERROR, /in_text" or "in_app/);
});

test('revise: feedback sends drafts back through floorboss, and --rule saves it to the voice file for the critic', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n' });
  triage(H);
  draftApprove(H);
  // Approved drafts that haven't gone out yet can still be revised.
  const ana = idOf(H, 'Ana Berg');
  const fb = join(H.dir, 'fb.txt');
  writeFileSync(fb, 'Plain over clever: one true line about me, one plain reason to meet. No quoting their own words back.');
  const r = cli(H, 'event-outreach', ['revise', '--event', H.slug, '--ids', ana, '--feedback-file', fb, '--rule']);
  assert.deepEqual(r.revise, [`${ana}:1`], JSON.stringify(r));
  const voice = readFileSync(r.rule_saved_to, 'utf8');
  assert.match(voice, /## Rules from your feedback\n- Plain over clever/);
  const draft = JSON.parse(readFileSync(join(H.dir, 'work', 'drafts', `${ana}-t1.json`), 'utf8'));
  assert.equal(draft.verdict, null, 'the critic reads it again');
  assert.match(draft.revise.previous_body, /Hi Ana/);
  const ci = cli(H, 'event-outreach', ['critic-input', '--event', H.slug, '--id', ana]);
  assert.match(ci.voice_rules, /Plain over clever/);
  const g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all']);
  assert.ok(JSON.stringify(g).includes('the critic hasn\'t read it'), 'an unreviewed revision can\'t be approved');
  // Sent messages can't be revised.
  cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', (() => { const f = join(H.dir, 'rep.json'); writeFileSync(f, JSON.stringify({ items: [{ who: 'Bo Li', what: 'sent' }] })); return f; })()]);
  assert.match(cli(H, 'event-outreach', ['revise', '--event', H.slug, '--ids', idOf(H, 'Bo Li'), '--feedback-file', fb]).ERROR, /already sent/);
});

test('enrich: the CRM is checked first (no lookup for what it has); only the rest go to the CSV; the import fills the list', async () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\nBo Li,VP Ops,Globex,\nCy Ng,VP Ops,Initech,cy@initech.test\n', settings: { channels: ['email', 'paste'], linkedin_messages: true } });
  const crm = join(H.dir, 'crm-export.csv');
  writeFileSync(crm, 'Name,Email,Company,Owner,Status,Last Contact,Unsubscribed,LinkedIn URL\nBo Li,bo.li@globex.test,Globex,Sam Rivera,,,false,https://www.linkedin.com/in/boli-example\n');
  const t = triage(H, ['--crm', crm]);
  assert.ok(!t.load.ERROR, t.load.ERROR);
  const ana = idOf(H, 'Ana Berg'), bo = idOf(H, 'Bo Li'), cy = idOf(H, 'Cy Ng');
  const el = cli(H, 'crm-triage', ['enrich-list', '--event', H.slug, '--ids', [ana, bo, cy].join(',')]);
  assert.equal(el.filled_from_crm, 1, JSON.stringify(el));
  assert.deepEqual([el.checked, el.already_complete, el.to_enrich], [3, 2, 1], 'Bo is complete from the CRM, Cy has an address: no credits on them');
  const { readCsv } = await import('../lib/csv.mjs');
  const rows = readCsv(el.file).records;
  assert.deepEqual(rows.map((r) => [r.floorboss_id, r.needs]), [[ana, 'email']]);
  assert.match(readFileSync(el.file, 'utf8').split('\n')[0], /^floorboss_id,first_name,last_name/);
  // The tool's export: Ana's email and link, a bad link for Cy.
  const out = join(H.dir, 'clay-export.csv');
  writeFileSync(out, `floorboss_id,Full Name,Work Email,LinkedIn URL\n${ana},Ana Berg,ana@acme.test,https://www.linkedin.com/in/anaberg-example\n${cy},Cy Ng,,https://example.com/cy\n`);
  assert.match(JSON.stringify(cli(H, 'crm-triage', ['enrich-import', '--event', H.slug, '--file', out])), /isn't a LinkedIn profile link/);
  writeFileSync(out, `floorboss_id,Full Name,Work Email,LinkedIn URL\n${ana},Ana Berg,ana@acme.test,https://www.linkedin.com/in/anaberg-example\n${cy},Cy Ng,,\n`);
  const imp = cli(H, 'crm-triage', ['enrich-import', '--event', H.slug, '--file', out, '--source', 'clay']);
  assert.deepEqual([imp.saved, imp.emails, imp.linkedin, imp.nothing_found], [true, 1, 1, 1]);
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug, '--crm', crm]);
  assert.ok(!load.ERROR, load.ERROR);
  const contacts = JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'contacts.json'), 'utf8')).contacts;
  const by = Object.fromEntries(contacts.map((c) => [c.name, c]));
  assert.equal(by['Ana Berg'].email, 'ana@acme.test');
  assert.equal(by['Bo Li'].email, 'bo.li@globex.test', 'from the CRM');
  assert.equal(by['Ana Berg'].id, ana, 'ids stay the same across loads');
  // A second enrich-list asks for nothing it already has.
  const again = cli(H, 'crm-triage', ['enrich-list', '--event', H.slug, '--ids', [ana, bo].join(',')]);
  assert.equal(again.to_enrich, 0, JSON.stringify(again));
  assert.ok(existsSync(join(H.dir, 'enriched.json')));
});
