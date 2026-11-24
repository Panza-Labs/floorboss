// The findings of the 11 Nov security audit (security-audit skill, run-6), each as the case that went wrong then and
// must not now, with the near variants of each tried beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, cli, triage, todoJobs, draftApprove, idOf, ROOT, NOW } from './fixtures/harness.mjs';
import { check } from '../hooks/guard.mjs';
import { sentKind } from '../lib/route.mjs';
import { lastReplyCheck } from '../lib/sendcheck.mjs';
import { namesToIds, namedCompanies } from '../lib/names.mjs';
import { readLedger, append, fold, legacyState } from '../lib/ledger.mjs';
import { draftFor, makeHome, drive, simplePersona, cli as simCli } from './sims/lib/driver.mjs';
import { throughHeadsUp, say } from './fixtures/heads-up.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const NOTES = { app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false };
const guard = (H, tool, input, now = NOW) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: tool, tool_input: input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
const post = (H, tool, input, now = NOW) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs'), 'post'], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, tool_response: {} }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
const later = (d, min = 0) => new Date(Date.parse(NOW) + d * 864e5 + min * 6e4).toISOString();
const log = (H) => join(H.dir, 'ledger.jsonl');
const add = (H, e, now = NOW) => append(log(H), { who: 'user', said: 'noted', ...e }, new Date(now));
const entries = (H) => readLedger(log(H)).entries;
const state = (H) => legacyState(fold(entries(H)));
const approvedIds = (H) => entries(H).filter((e) => e.type === 'approved').map((e) => e.id);
const put = (H, name, data) => { const f = join(H.HOME, 'work', name); mkdirSync(join(H.HOME, 'work'), { recursive: true }); writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data)); return f; };
const record = (H, items, now = NOW) => cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', put(H, 'rec.json', { items })], now);
const listAt = (H, now, extra = []) => cli(H, 'event-outreach', ['send-list', '--event', H.slug, ...extra], now);
const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []);
const browserList = (H) => read(join(H.dir, 'derived', 'browser-send-list.json'));
const emailList = (H) => read(join(H.dir, 'derived', 'send-list.json'));
const sentMark = (H, id, touch, extra = {}, now = NOW) => add(H, { type: 'sent', id, touch, date: now.slice(0, 10), via: 'floorboss', who: 'floorboss', ...extra }, now);
const gate = (H, answers, now = NOW) => cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', answers], now);
const type = (H, text, now = NOW) => guard(H, 'mcp__claude-in-chrome__computer', { action: 'type', text }, now);
function openWin(H, now) {
  writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at: now }));
  cli(H, 'event-outreach', ['browser-send', '--event', H.slug, '--said', 'go ahead, send them in Grip'], now);
  guard(H, 'mcp__claude-in-chrome__computer', { action: 'left_click', coordinate: [1, 1] }, now);
  post(H, 'mcp__claude-in-chrome__computer', { action: 'left_click', coordinate: [1, 1] }, now);
}
// Drafts saved and passed for everyone on the list, none approved yet.
function readyList(rows) {
  const H = setup({ attendees: `Name,Title,Company,Email\n${rows}` });
  triage(H);
  draftApprove(H, NOW, 'edit c001');
  assert.equal(approvedIds(H).length, 0);
  return H;
}

// 1. lib/gate.mjs:parseGate:approve-all-unresolved-name-read-as-comment. Round 2 (independent review): no list of
// hold-back words can be complete, so beside "approve all" only an except list, an "also" list or a remark made wholly of
// harmless words passes. The wordings below are the reviewer's, none of them taken from the code's own lists.
const THREE = 'Ana Berg,COO,Acme,ana@acme.test\nJohn Lind,VP,Globex,john@globex.test\nCy Ek,CTO,Initech,cy@initech.test\n';
const HOLDING = [
  'approve all, not Jon', 'approve all but the last one', 'approve all apart from the Globe-x guy', 'approve all, not सुनील कुमार',
  'approve all, Jon waits', "approve all, Jon isn't ready", 'approve all aside from Jon', 'approve all, pause Jon', 'approve all, park the last one',
  'approve all, omit Jon', 'approve all, sans Jon', 'approve all, forget Jon', 'approve all, ignore the last one', 'approve all, stop Jon',
  'approve all, cancel Jon', 'approve all, delay Jon', 'approve all, Jon tomorrow', 'approve all, Jon needs a rewrite', "approve all, I'll do Jon myself",
  'approve all, pass on Jon', 'approve all w/o Jon', 'approve all -Jon', 'approve all, menos Jon', 'approve all, sauf Jon', 'approve all, excl. Jon',
  "approve all, Jon shouldn't go", "approve all, can't send Jon's", 'approve all, Jon is on pause', 'approve all, the last one needs work', 'approve all, redo the third',
  'approve all, Jon stays', 'approve all, hold-off Jon', 'approve all ex Jon', 'approve all, everyone bar Jon', 'approve all, Jon is a maybe', 'approve all, the CTO one is wrong',
  'approve all, withhold Jon', 'approve all, exclude\u200b Jon', 'approve all (Jon excluded)', 'approve all, Jon excepted', 'approve all, holding Jon', 'approve all, skipping Jon', 'approve all, leaving Jon',
  'approve all, nоt Jon', 'approve all, NOT Jon', 'approve all; not Jon', 'approve all\nnot Jon', 'approve all. Not Jon', 'approve all: not Jon', 'approve all — not Jon', 'approve all... but Jon',
  'approve all expect Jon', 'approve all exept Jon', 'approve all excepting Jon', 'approve all excepto Jon', 'approve all salvo Jon', 'approve all sin Jon', 'approve all, espera con Jon', 'approve all exc Jon', 'approve all aside from the Globex one'
];
const ORDINARY = [
  'approve all, no changes', 'approve all, no edits', 'approve all, send them out', 'approve all, looks good', 'approve all, not bad at all', 'approve all, keep going',
  'approve all, great work', 'approve all, nothing to change', 'approve all please', 'approve all, thanks', 'approve all of them', 'approve all.', 'approve all!', 'approve all, go ahead',
  'approve all, I have no notes', "approve all, let's get these out today", 'approve all, send later today', 'approve all, they only need to go by Friday', "approve all, don't change anything",
  'approve all, but good job on these', 'approve all, save me some time', 'approve all and send', 'approve all, ship it', 'approve all - no changes', 'Approve all, yes', 'approve all, and no need to wait', 'approve all, rather good', 'approve all the drafts', 'approve all three',
  'approve all, gracias', 'approve all, perfecto, sin cambios'
];
// Round 3 (owner's decision): such an answer is never saved at once. It is asked again, or read back by ID and name
// and saved only on the user's yes. The ordinary ways of saying "approve all" all give a reading; none is refused.
const pendingOrAsked = (r) => !!(r.ERROR || r.pending);
test('beside approve all, no hold-back wording or remark is saved at once; ordinary phrasings all give a reading', () => {
  const H = readyList(THREE);
  for (const a of [...HOLDING, ...ORDINARY.filter((x) => !/^approve all[.!]?$/i.test(x))]) {
    const r = gate(H, a);
    assert.ok(pendingOrAsked(r), `${JSON.stringify(a)}: ${JSON.stringify(r).slice(0, 200)}`);
    assert.equal(approvedIds(H).length, 0, `${JSON.stringify(a)}: nothing approved`);
  }
  for (const a of ['yes approve all', 'approve everything', 'approve all except for Cy', 'looks good', 'drop Cy', 'drop John Lind please', 'approve all, no changes', 'approve all, thanks']) {
    const r = gate(H, a);
    assert.ok(!r.ERROR, `${a}: a reading, not a refusal: ${r.ERROR}`);
    assert.equal(r.pending, true, a);
    // Round 7: each new answer replaces the reading before it, and says so; "looks good" is read back like the rest.
    assert.match(r.say_to_user, /^(?:The earlier reading was dropped\. )?This answer reads as: .* Reply yes to save, or answer again\.$/, a);
  }
  // With nothing waiting, "looks good" is read back like any other answer that isn't the gate's own words.
  const L = readyList(THREE);
  assert.match(gate(L, 'looks good').say_to_user || '', /^This answer reads as: .* Reply yes to save, or answer again\.$/);
  // A retraction or a contradiction beside "approve all" never saves directly.
  for (const a of ['approve all, no', 'approve all, send nothing', 'approve all, i have changes', 'approve all, no enviar', 'approve all except John\napprove all', 'approve all\nno', 'approve all, edit John'])
    assert.ok(pendingOrAsked(gate(H, a)), a);
  assert.equal(approvedIds(H).length, 0);
  // "drop John Lind" drops John Lind only, never another John.
  const J = readyList('Ana Berg,COO,Acme,ana@acme.test\nJohn Lind,VP,Globex,john@globex.test\nJohn Smith,CTO,Initech,js@initech.test\n');
  const dj = gate(J, 'drop John Lind please');
  assert.match(dj.say_to_user, new RegExp(`drop ${idOf(J, 'John Lind')} "John Lind"\\.`));
  assert.doesNotMatch(dj.say_to_user, /John Smith/);
  const yes = gate(J, 'yes');
  assert.deepEqual(entries(J).filter((e) => e.type === 'dropped').map((e) => e.id), [idOf(J, 'John Lind')], JSON.stringify(yes).slice(0, 300));
  const ex = gate(readyList(THREE), 'approve all except c002');
  assert.equal(ex.approved, 2, JSON.stringify(ex).slice(0, 300));
  assert.match(ex.say_to_user, /Held back c002 "John Lind"/, 'who was held back is said by ID and name');
});

test('an except list is never followed by an approval: "approve all except John, Cy too" holds Cy back as well', () => {
  for (const a of ['approve all except John, Cy too', 'approve all except John, Cy as well', 'approve all except John, and Cy also', 'approve all except John, Cy anyway']) {
    const H = readyList(THREE);
    const r = gate(H, a);
    assert.equal(r.pending, true, `${a}: first names are read back: ${JSON.stringify(r).slice(0, 300)}`);
    assert.match(r.say_to_user, /hold back c002 "John Lind", c003 "Cy Ek"/, a);
    gate(H, 'yes');
    assert.deepEqual(approvedIds(H), [idOf(H, 'Ana Berg')], a);
  }
});

test('beside approve all, a name in a script with combining signs counts as a listed word too', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nसुनील कुमार,VP,Globex,sunil@globex.test\nCy Ek,CTO,Initech,cy@initech.test\n' });
  triage(H);
  draftApprove(H, NOW, 'edit c001');
  for (const a of ['approve all, सुनील कुमार waits', 'approve all, सुनील', 'approve all, not सुनील कुमार']) {
    const r = gate(H, a);
    assert.match(r.ERROR || '', /can't be read|Nothing was approved/, `${a}: ${JSON.stringify(r).slice(0, 200)}`);
  }
  assert.equal(approvedIds(H).length, 0);
});

// 2. lib/names.mjs:namesToIds:first-name-key-shadows-another-listed-persons-surname
test('a first name that is a word of another listed name is left as written, so the gate asks', () => {
  const H = readyList('Ana Berg,COO,Acme,ana@acme.test\nJames Taylor,VP,Globex,james@globex.test\nTaylor Smith,CTO,Initech,taylor@initech.test\n');
  for (const a of ['approve all except Taylor', 'approve Taylor', 'approve all\ndrop Taylor']) {
    const r = gate(H, a);
    assert.ok(r.ERROR || !(r.approved > 0), `${a}: ${JSON.stringify(r).slice(0, 200)}`);
    assert.equal(approvedIds(H).length, 0, `${a}: nothing approved`);
  }
  for (const third of ['Taylor', 'Dr. Taylor']) {
    const M = readyList(`James Taylor,COO,Acme,james@acme.test\nBo Li,VP,Globex,bo@globex.test\n${third},CTO,Initech,t@initech.test\n`);
    assert.ok(gate(M, 'approve all except Taylor').ERROR, `${third}: a name of one word is no whole name of its own`);
    assert.equal(approvedIds(M).length, 0, third);
  }
  const full = gate(H, 'approve all except Taylor Smith');
  assert.equal(full.approved, 2, JSON.stringify(full).slice(0, 300));
  assert.ok(!approvedIds(H).includes(idOf(H, 'Taylor Smith')));
  const P = (more) => [{ id: 'c001', name: 'Ana Berg' }, { id: 'c002', name: 'Taylor Smith' }, ...more];
  for (const other of ['James Taylor', 'Ana Taylor Berg', 'Jo Reed-Taylor', 'Jo Taylor Jr.', 'Dr. Jo Taylor', 'Jo de Taylor']) {
    assert.equal(namesToIds('skip taylor because he left', P([{ id: 'c003', name: other }])), 'skip taylor because he left', other);
    assert.equal(namesToIds('taylor is mine', P([{ id: 'c003', name: other }])), 'taylor is mine', other);
  }
  assert.equal(namesToIds('approve taylor smith', P([{ id: 'c003', name: 'James Taylor' }])), 'approve c002', 'the full name still fits one');
  assert.equal(namesToIds('approve taylor smith', P([{ id: 'c003', name: 'Jo Taylor Smith' }])), 'approve taylor smith', 'another row holding all of its words makes it a question');
  assert.equal(namesToIds('approve ana', P([{ id: 'c003', name: 'Bo Li' }])), 'approve c001', 'a first name nobody else has still fits');
});

// 3. lib/names.mjs:namesToIds:shared-first-name-check-skips-rows-without-a-plain-name
const COWORKER_CRM = 'Name,Email,Company,Owner,Status,Opted Out\nDiane Woo,diane.woo@meridianreit.test,Meridian Office REIT,Jordan Fisk,Lead,no\n';
test('a first name another listed row shares, however that row is written, is left as written at the shortlist gate: the coworker hold stays', () => {
  for (const [second, answer] of [
    ['Paul R. Stone', 'Paul is mine'], ['Paul R. Stone', 'reach Paul anyway'], ['Paul Stone Jr.', 'skip Paul'], ['Paul Or', 'Paul is mine'], ['Dr. Paul Stone', 'reach Paul anyway'],
    // The reviewer's rows: one word, a title before one word, an initial, odd characters.
    ['Paul', 'Paul is mine'], ['Dr. Paul', 'reach Paul anyway'], ['Paul', 'skip Paul'], ['Sr Paul', 'Paul is mine'], ['Paul F', 'Paul F is mine'], ['Paul F.', 'reach Paul F anyway'],
    ['PAUL FENWICK', 'Paul Fenwick is mine'], ['Paul\u200b Stone', 'Paul is mine'], ['Paúl Stone', 'Paul is mine'], ['Paul, Stone', 'Paul is mine'], ['Stone (Paul)', 'reach Paul anyway'],
    ['Paul c002', 'Paul is mine'], ['\u202ePaul Stone', 'Paul is mine'], ['Ｐａｕｌ Stone', 'Paul is mine']
  ]) {
    const H = setup({
      attendees: `Name,Title,Company,Email\nDiane Woo,Chief Sustainability Officer,Meridian Office REIT,diane.woo@meridianreit.test\nPaul Fenwick,VP Engineering,Meridian Office REIT,paul.fenwick@meridianreit.test\n"${second}",COO,Acme,paul.stone@acme.test\n`,
      crm: COWORKER_CRM,
      settings: { crm_accounts: 'apply', coworker_contacts: 'leave', colleagues: ['Jordan Fisk'], colleague_notes: true }
    });
    triage(H);
    const paul = idOf(H, 'Paul Fenwick');
    const res = () => JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'))[paul];
    assert.equal(res().group, 'colleague');
    const before = entries(H).length;
    const r = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', answer]);
    assert.ok(r.ERROR, `${second} / ${answer}: ${JSON.stringify(r).slice(0, 300)}`);
    if (!/FENWICK|c002/.test(second)) assert.match(r.ERROR, /Which "paul": .*c\d+ "Paul Fenwick"/, `${second} / ${answer}: ${r.ERROR.slice(0, 300)}`);
    assert.doesNotMatch(r.ERROR, /[\u202e\u200b]/, 'names shown back carry no control or format characters');
    assert.equal(res().group, 'colleague', `${second} / ${answer}: the hold stays`);
    assert.ok(!entries(H).slice(before).some((e) => e.id === paul), `${second} / ${answer}: nothing recorded for Paul Fenwick`);
  }
  const people = (second) => [{ id: 'c001', name: 'Diane Woo' }, { id: 'c002', name: 'Paul Fenwick' }, { id: 'c003', name: second }];
  for (const second of ['Paul R. Stone', 'Paul Stone Jr.', 'Paul Stone (Acme)', 'Paul Stone, CFA', 'Paul Stone 2', 'Paul Or', 'Dr. Paul Stone', 'PAUL-Stone', 'Stone, Paul', 'c9 Paul'])
    assert.equal(namesToIds('reach paul anyway', people(second)), 'reach paul anyway', second);
  assert.equal(namesToIds('reach paul fenwick anyway', people('Paul R. Stone')), 'reach c002 anyway', 'the whole name still says which Paul');
  // The draft gate decides over everyone it lists, those it gives no key to as well.
  const H = readyList('Ana Berg,COO,Acme,ana@acme.test\nAna B. Cole Jr.,VP,Globex,anab@globex.test\nBo Li,CTO,Initech,bo@initech.test\n');
  const r = gate(H, 'approve Ana');
  assert.match(r.ERROR || '', /Which "ana": c\d+ "Ana Berg" or c\d+ "Ana B Cole Jr"\? Answer with the ID, for example "approve c\d+"\./, JSON.stringify(r).slice(0, 300));
  const v = gate(H, 'approve all except Ana');
  assert.ok(v.ERROR, JSON.stringify(v).slice(0, 200));
  assert.equal(approvedIds(H).length, 0);
  const D = readyList('Ana Berg,COO,Acme,ana@acme.test\nDrop Ana,VP,Globex,da@globex.test\nBo Li,CTO,Initech,bo@initech.test\n');
  assert.ok(gate(D, 'approve all except Ana').ERROR, 'a row the gate addresses by id only still makes the name shared');
  assert.equal(approvedIds(D).length, 0);
});

// From the user simulations (coordinator, 12 Nov): a regression from the run-5 names fix. A whole name typed as listed
// is that person even beside another Ana; a word that could be two people is asked about by name and id; a row named
// like a remark goes by id.
test('a whole name typed as listed resolves, with or without a title; a shared word is asked about by ID and name, at both gates', () => {
  const H = readyList('Ana Costa,COO,Acme,ana@acme.test\nAna Berg,VP,Globex,anab@globex.test\nBo Li,CTO,Initech,bo@initech.test\n');
  const [costa, berg] = [idOf(H, 'Ana Costa'), idOf(H, 'Ana Berg')];
  const which = gate(H, 'approve Ana');
  assert.match(which.ERROR || '', new RegExp(`Which "ana": ${costa} "Ana Costa" or ${berg} "Ana Berg"\\? Answer with the ID, for example "approve ${costa}"\\.`), JSON.stringify(which).slice(0, 300));
  assert.match(gate(H, 'approve all except Ana').ERROR || '', /Which "ana":/, 'beside approve all too');
  // Another Ana listed: the whole name is read, and shown back before it is saved.
  const one = gate(H, 'approve Ana Costa');
  assert.equal(one.pending, true, JSON.stringify(one).slice(0, 300));
  assert.match(one.say_to_user, new RegExp(`approve ${costa} "Ana Costa"\\.`));
  assert.equal(approvedIds(H).length, 0);
  assert.equal(gate(H, 'yes').approved, 1);
  assert.deepEqual(approvedIds(H), [costa]);
  const K = readyList('Ana Costa,COO,Acme,ana@acme.test\nAna Berg,VP,Globex,anab@globex.test\nBo Li,CTO,Initech,bo@initech.test\n');
  assert.equal(gate(K, 'approve Ana Costa, drop Ana Berg').pending, true);
  const two = gate(K, 'yes');
  assert.ok(!two.ERROR && two.approved === 1 && two.dropped === 1, JSON.stringify(two).slice(0, 300));
  assert.match(two.say_to_user, new RegExp(`^Approved ${idOf(K, 'Ana Costa')} "Ana Costa"\\. Dropped ${idOf(K, 'Ana Berg')} "Ana Berg"\\.`), two.say_to_user);
  // The shortlist gate: a title before the name, typed or listed, read back and saved on yes.
  for (const [row, said] of [['Roberto Salgado Pineda', 'reach Ing. Roberto Salgado Pineda anyway'], ['Ing. Roberto Salgado Pineda', 'reach Roberto Salgado Pineda anyway'], ['Dra. Rosa Peña', 'Rosa Peña is mine']]) {
    const T = setup({ attendees: `Name,Title,Company,Email\nRoberto Diaz,COO,Acme,rd@acme.test\n${row},VP,Globex,rsp@globex.test\nRosa Lima,CFO,Initech,rl@initech.test\n` });
    triage(T);
    const id = idOf(T, row);
    const r = cli(T, 'crm-triage', ['gate', '--event', T.slug, '--answers', said]);
    assert.ok(!r.ERROR && r.pending, `${said}: ${r.ERROR || JSON.stringify(r).slice(0, 200)}`);
    assert.ok(!entries(T).some((e) => e.type === 'decide' && e.id === id), `${said}: nothing saved before the yes`);
    const y = cli(T, 'crm-triage', ['gate', '--event', T.slug, '--answers', 'yes']);
    assert.ok(entries(T).some((e) => e.type === 'decide' && e.id === id), `${said}: decided for ${row} on yes: ${JSON.stringify(y).slice(0, 200)}`);
  }
  const T = setup({ attendees: 'Name,Title,Company,Email\nRoberto Diaz,COO,Acme,rd@acme.test\nRoberto Salgado Pineda,VP,Globex,rsp@globex.test\n' });
  triage(T);
  assert.match(cli(T, 'crm-triage', ['gate', '--event', T.slug, '--answers', 'skip Roberto']).ERROR || '', /Which "roberto": c\d+ "Roberto Diaz" or c\d+ "Roberto Salgado Pineda"\? Answer with the ID, for example "skip c\d+"\./);
  // A whole name another row holds every word of ("Maria Lopez" and "Ana Maria Lopez") is asked about, both directions.
  const M = readyList('Maria Lopez,COO,Acme,m@acme.test\nAna Maria Lopez,VP,Globex,am@globex.test\nBo Li,CTO,Initech,bo@initech.test\n');
  for (const a of ['approve all except Maria Lopez', 'approve Maria Lopez', 'drop Maria Lopez']) assert.match(gate(M, a).ERROR || '', /Which "maria": .*"Maria Lopez".*"Ana Maria Lopez"/, a);
});

// Round 3: a row named like a remark, or holding a command word, is never taken by its name at once. Whatever answer
// names it, or a first name it shares, is asked about or read back by ID and name; on yes, exactly what was read back is
// saved. What this guarantees: nothing is saved before the user has seen who it means. What it doesn't: that a user
// who says yes to "approve c003 "Ana Kindly"" meant someone else.
test('a row named like a remark or a command: never saved by name at once; on yes, exactly the reading shown is saved', () => {
  for (const row of ['Ana Please', 'Ana Thank You', 'Ana For Now', 'Ana Only', 'Ana Por Favor', 'Ana Kindly', 'Ana Looks Good', 'Ana B', 'Ana', 'Ana Edit', 'Ana All', 'Ana Ok', 'Ana As Well', 'Jo Cut', 'Bo Thanks']) {
    const rows = `Ana Berg,COO,Acme,ana@acme.test\nBo Li,VP,Globex,bo@globex.test\n"${row}",CFO,Initech,odd@initech.test\n`;
    for (const said of [`approve ${row}`, `approve all except ${row}`, `drop ${row}`]) {
      const H = readyList(rows);
      const r = gate(H, said);
      assert.ok(pendingOrAsked(r), `${row} / ${said}: ${JSON.stringify(r).slice(0, 200)}`);
      assert.equal(approvedIds(H).length + entries(H).filter((e) => e.type === 'dropped').length, 0, `${row} / ${said}: nothing saved`);
      if (!r.pending) continue;
      const shownIds = [...r.say_to_user.matchAll(/(?<![\p{L}\d])(c\d{3,}) "/gu)].map((m) => m[1]);
      gate(H, 'yes');
      const saved = [...entries(H).filter((e) => e.type === 'approved' || e.type === 'dropped').map((e) => e.id)];
      for (const id of saved) assert.ok(shownIds.includes(id), `${row} / ${said}: ${id} saved but not shown`);
    }
  }
});

// 4. lib/route.mjs:sentKind:missing-channel-label-read-as-email
function routed(step) {
  const S = { sending: { channels: ['email', 'linkedin', 'app'], followups: 'scheduled', linkedin_ack: true }, route: ['email', step, 'email'], ...NOTES };
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: S });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  sentMark(H, ana, 1, { channel: 'email', via: 'email.send' }, later(1));
  return { H, ana };
}
test('a LinkedIn or app message counts as that inbox whatever ordinary label it was recorded under; send-outcome never settles a browser release', () => {
  // Through record and send-list: the email after it waits for that inbox to be checked.
  for (const [step, label] of [
    ['linkedin', 'LinkedIn chat'], ['linkedin', 'LinkedIn, not email'], ['linkedin', 'LinkedIn (email bounced)'], ['linkedin', 'LI msg instead of e-mail'], ['app', 'the event app, not email'], ['app', 'in-app chat'],
    // Review 2: a label that only mentions email ("not email") stays with the step.
    ['linkedin', 'not email'], ['linkedin', 'DM, not email'], ['linkedin', 'DM (email bounced)'], ['linkedin', 'no email, messaged her'], ['linkedin', 'messaged her since the email bounced'], ['app', 'Swapcard, not email'], ['app', 'the platform (email bounced)']
  ]) {
    const { H, ana } = routed(step);
    assert.equal(record(H, [{ who: 'Ana Berg', what: 'sent', touch: 2, channel: label, said: 'I sent it myself' }], later(9)).applied, true, label);
    const L = later(22);
    add(H, { type: 'reply_checked', id: ana, source: 'mailbox', who: 'mailbox' }, L);
    const list = listAt(H, L);
    assert.ok(!emailList(H).some((x) => x.touch === 3), `${label}: ${JSON.stringify(list).slice(0, 300)}`);
    assert.deepEqual(list.waiting.find((w) => w.touch === 3)?.check, [step], label);
  }
  for (const [label, step, kind] of [['LinkedIn chat', 'linkedin', 'linkedin'], ['in-app chat', 'app', 'app'], ['chat', 'linkedin', 'linkedin'], ['DM', 'linkedin', 'linkedin'], ['WhatsApp chat', 'app', 'app'], ['Linked In', 'linkedin', 'linkedin'], ['InMail', 'linkedin', 'linkedin'], ['mail', 'linkedin', 'linkedin'], ['Grip (emailed before)', 'app', 'app']])
    assert.equal(sentKind({ channel: label, via: 'floorboss' }, { step, appName: 'Grip' }), kind, `${label} on a ${step} step`);
  assert.equal(sentKind({ channel: 'Grip chat' }, { step: 'linkedin', appName: 'Grip' }), 'app', 'a label naming the other browser inbox alone moves it');
  for (const l of ['email', 'by email', 'emailed', 'e-mail.']) assert.equal(sentKind({ channel: l }, { step: 'app', appName: 'Grip' }), 'email', `${l}: nothing but email moves it to email`);
  assert.equal(sentKind({ channel: 'Wizzlechat', via: 'floorboss' }), null, 'with no step a chat label stays a chat');
  const A = routed('app');
  add(A.H, { type: 'send_released', who: 'guard', id: A.ana, touch: 2, hash: state(A.H)[A.ana].touches[2].hash, via: 'browser', to: 'Ana Berg', where: 'Grip' }, later(9));
  const out = cli(A.H, 'event-outreach', ['send-outcome', '--event', A.H.slug, '--id', A.ana, '--touch', '2', '--went', 'yes', '--said', 'it is there in Grip'], later(9));
  assert.match(out.ERROR || '', /app-result/, JSON.stringify(out).slice(0, 200));
  assert.ok(!state(A.H)[A.ana].sent?.[2], 'nothing is recorded as an email');
});

// G. The send prompt says how fresh the oldest check it needs is, not only the mailbox's.
test('a follow-up prompt reports the oldest of the reply checks it needs', () => {
  const { H, ana } = routed('linkedin');
  record(H, [{ who: 'Ana Berg', what: 'sent', touch: 2, channel: 'LinkedIn', said: 'sent it myself' }], later(9));
  const L = later(22);
  add(H, { type: 'no_reply_said', ids: [ana], channel: 'linkedin', said: 'nothing on LinkedIn' }, L);
  add(H, { type: 'reply_checked', id: ana, source: 'mailbox', who: 'mailbox' }, L);
  listAt(H, L);
  const it = emailList(H).find((x) => x.touch === 3);
  assert.ok(it, 'listed');
  add(H, { type: 'reply_checked', id: ana, source: 'mailbox', who: 'mailbox' }, later(22, 2));
  writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at: later(22, 2) }));
  const g = guard(H, 'mcp__gmail__send_email', { to: it.to, subject: it.subject, body: it.body }, later(22, 2));
  assert.match(g.stdout, /replies were checked 120 seconds ago/, g.stdout.slice(0, 400) || g.stderr);
});

// 5. lib/sendcheck.mjs:lastReplyCheck:status_pasted-counts-as-no-reply-word-for-every-channel
function writtenOnLinkedIn() {
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: ['email', 'app', 'linkedin', 'email'], ...NOTES } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  sentMark(H, ana, 1, { channel: 'email' }, later(1));
  add(H, { type: 'step_skipped', id: ana, touch: 2, said: 'skip the app' }, later(2));
  add(H, { type: 'sent', id: ana, touch: 3, date: later(18).slice(0, 10), channel: 'LinkedIn' }, later(18));
  return { H, ana, now: later(22, 5) };
}
test('a "nothing changed" word or an outbox paste does not answer for the LinkedIn or app inbox', () => {
  for (const word of [(H, now) => cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nothing changed'], now), (H, now) => cli(H, 'event-outreach', ['status', '--event', H.slug, '--text', `floorboss-status v1 event=${H.slug} at=${now.replace(/\.\d+Z$/, 'Z')}`], now)]) {
    const { H, ana, now } = writtenOnLinkedIn();
    listAt(H, now, ['--no-reply-check', 'nobody replied by email']);
    add(H, { type: 'no_reply_said', ids: [ana], channel: 'app', said: 'nothing in the app' }, now);
    const r = word(H, now);
    assert.ok(!r.ERROR, r.ERROR);
    assert.ok(entries(H).some((e) => e.type === 'status_pasted'));
    const list = listAt(H, now);
    assert.ok(!emailList(H).some((x) => x.touch === 4), JSON.stringify(list).slice(0, 300));
    assert.deepEqual(list.waiting.find((w) => w.touch === 4)?.check, ['linkedin']);
  }
  const paste = [{ type: 'status_pasted', at: later(0, -1), nothing_changed: true }];
  for (const kind of ['linkedin', 'app']) assert.equal(lastReplyCheck(paste, 'c001', 'browser', {}, 0, kind), null, kind);
  assert.ok(lastReplyCheck(paste, 'c001', 'email.send', { email: false, crm: false }, 0) > 0, 'for email, where no reader can look, it still counts');
});

// 6. skills/event-context/scripts/scan.mjs:serversIn:browser-kind-from-config-file-name
const RUN = { active: true, session: true, until: '2026-10-30T12:00:00.000Z' };
function scanWith(mcpServers, tools) {
  const base = mkdtempSync(join(tmpdir(), 'fb-scan6-'));
  const fb = join(base, 'home'), proj = join(base, 'proj'), sh = join(base, 'scanhome');
  for (const d of [fb, proj, sh, join(fb, 'work')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(proj, '.mcp.json'), JSON.stringify({ mcpServers }));
  writeFileSync(join(sh, '.claude.json'), JSON.stringify({ mcpServers: { 'notes-browser': { command: 'node', args: ['n.js'] } }, projects: { [proj]: { mcpServers: { 'puppeteer-notes': { command: 'node' } } } } }));
  const f = join(fb, 'work', 'session.json');
  writeFileSync(f, JSON.stringify({ tools }));
  const r = spawnSync('node', [join(ROOT, 'skills/event-context/scripts/cli.mjs'), 'scan', '--session-file', f], { env: { ...process.env, FLOORBOSS_HOME: fb, FLOORBOSS_NOW: NOW, FLOORBOSS_SCAN_HOME: sh, FLOORBOSS_SCAN_CWD: proj }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return fb;
}
function inHome(fb, fn) {
  const prev = process.env.FLOORBOSS_HOME;
  process.env.FLOORBOSS_HOME = fb;
  try { return fn(); } finally { if (prev === undefined) delete process.env.FLOORBOSS_HOME; else process.env.FLOORBOSS_HOME = prev; }
}
test('a server named in a config file is a browser only by its exact known name or its tools, never by a browser word', () => {
  const fb = scanWith(
    { 'file-browser': { command: 'node', args: ['x.js'] }, 'chrome-history': { command: 'node', args: ['y.js'] }, notes: { command: 'npx', args: ['playwright-notes'] }, playwright: { command: 'npx', args: ['@playwright/mcp'] }, 'my-browser': { command: 'npx', args: ['@playwright/mcp@latest'] } },
    ['mcp__file-browser__get_text', 'mcp__file-browser__list_files']
  );
  const inv = JSON.parse(readFileSync(join(fb, 'inventory.json'), 'utf8'));
  assert.deepEqual([...inv.setup_found.browser].sort(), ['mcp:my-browser', 'mcp:playwright'], 'a server started from a browser package is one, whatever its name');
  inHome(fb, () => {
    for (const [tool, input] of [['mcp__file-browser__get_text', { path: '~/.ssh/id_rsa' }], ['mcp__chrome-history__read_page', { path: '~/.aws/credentials' }], ['mcp__notes-browser__get_text', { path: '~/.ssh/id_rsa' }], ['mcp__puppeteer-notes__read_page', { path: '~/.ssh/id_rsa' }]])
      assert.ok(check({ tool_name: tool, tool_input: input }, { config: {}, active: RUN }), tool);
    assert.equal(check({ tool_name: 'mcp__playwright__browser_snapshot', tool_input: {} }, { config: {}, active: RUN }), null, 'a browser by its known name still reads');
    assert.equal(check({ tool_name: 'mcp__my-browser__browser_snapshot', tool_input: {} }, { config: {}, active: RUN }), null, 'and one by its package');
  });
  // A browser found by its tools at the first scan, under a name the guard doesn't know, still reads.
  const byTools = scanWith({}, ['mcp__hyperbrowser__navigate', 'mcp__hyperbrowser__get_page_text']);
  inHome(byTools, () => assert.equal(check({ tool_name: 'mcp__hyperbrowser__get_page_text', tool_input: {} }, { config: {}, active: RUN }), null));
});

test('an inventory saved before the fix keeps no browser named only by a word, read as it is or carried by a rescan', () => {
  const fb = mkdtempSync(join(tmpdir(), 'fb-oldinv-'));
  // As the scan before the fix wrote it: file-browser read from .mcp.json by its name, hyperbrowser from the session's tools.
  writeFileSync(join(fb, 'inventory.json'), JSON.stringify({ setup_servers: ['file-browser', 'playwright', 'hyperbrowser'], setup_found: { browser: ['mcp:file-browser', 'mcp:playwright', 'mcp:hyperbrowser'] }, found: { browser: ['mcp:file-browser'] }, items: [{ type: 'mcp', name: 'file-browser', source: 'project .mcp.json', kinds: ['browser'] }, { type: 'mcp', name: 'hyperbrowser', source: 'this session', kinds: ['browser'] }] }));
  const call = () => check({ tool_name: 'mcp__file-browser__get_text', tool_input: { path: '~/.ssh/id_rsa' } }, { config: {}, active: RUN });
  inHome(fb, () => {
    assert.ok(call(), 'read as it is');
    assert.equal(check({ tool_name: 'mcp__playwright__browser_snapshot', tool_input: {} }, { config: {}, active: RUN }), null, 'a known browser in it still reads');
    assert.equal(check({ tool_name: 'mcp__hyperbrowser__get_page_text', tool_input: {} }, { config: {}, active: RUN }), null, 'and one it found by its tools');
  });
  const proj = join(fb, 'proj'), sh = join(fb, 'sh');
  for (const d of [proj, sh, join(fb, 'work')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { 'file-browser': { command: 'node' } } }));
  writeFileSync(join(fb, 'work', 's.json'), JSON.stringify({ tools: ['mcp__file-browser__navigate', 'mcp__file-browser__get_page_text'] }));
  const r = spawnSync('node', [join(ROOT, 'skills/event-context/scripts/cli.mjs'), 'scan', '--session-file', join(fb, 'work', 's.json')], { env: { ...process.env, FLOORBOSS_HOME: fb, FLOORBOSS_NOW: NOW, FLOORBOSS_SCAN_HOME: sh, FLOORBOSS_SCAN_CWD: proj }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([...JSON.parse(readFileSync(join(fb, 'inventory.json'), 'utf8')).setup_found.browser].sort(), ['mcp:hyperbrowser', 'mcp:playwright'], 'a rescan carries only what may be trusted, and adds nothing');
  inHome(fb, () => assert.ok(call(), 'after the rescan too'));
});

// 7. skills/event-outreach/scripts/cli.mjs:appLimitReached:route-app-requests-counted-only-after-sent
// Round 2: a place in the app is kept once a note was let through, whatever the commands the session can run say about
// it since (a resend, "it did not go", a page that said too long or logged out).
function appLimitOne() {
  const S = { sending: { channels: ['email', 'app'], followups: 'scheduled' }, app_request_limit: null, route: ['email', 'app'], ...NOTES };
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP,Globex,bo@globex.test\n', event: { app_name: 'Grip' }, settings: S });
  triage(H);
  draftApprove(H);
  // The limit set after both were approved: send-list is the last place it can be kept.
  const ev = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  ev.settings.app_request_limit = 1;
  writeFileSync(join(H.dir, 'event.json'), JSON.stringify(ev));
  const [ana, bo] = [idOf(H, 'Ana Berg'), idOf(H, 'Bo Li')];
  for (const id of [ana, bo]) sentMark(H, id, 1, { channel: 'email', via: 'email.send' }, later(-1));
  add(H, { type: 'no_reply_said', ids: [ana, bo], channel: 'email', said: 'nothing by email' }, later(8));
  return { H, ana, bo };
}
const NR = ['--no-reply-check', 'nobody replied'];
test('the app limit counts a note already let through, and later-step app notes on every path', () => {
  for (const [name, clear] of [
    ['nothing said', () => ({})],
    ['send-list --resend', (H, id, now) => listAt(H, now, [...NR, '--resend', `${id}:2`, '--said', 'it never went'])],
    ['send-outcome --went no', (H, id, now) => cli(H, 'event-outreach', ['send-outcome', '--event', H.slug, '--id', id, '--touch', '2', '--went', 'no', '--said', 'it is not there'], now)],
    ['app-result too_long', (H, id, now) => cli(H, 'event-outreach', ['app-result', '--event', H.slug, '--id', id, '--touch', '2', '--result', 'too_long', '--page-says', 'too long'], now)],
    ['app-result logged_out', (H, id, now) => cli(H, 'event-outreach', ['app-result', '--event', H.slug, '--id', id, '--touch', '2', '--result', 'logged_out', '--page-says', 'log in'], now)],
    // Review 2: none of these frees a place either.
    ['app-result not_found', (H, id, now) => cli(H, 'event-outreach', ['app-result', '--event', H.slug, '--id', id, '--touch', '2', '--result', 'not_found', '--page-says', 'no such person'], now)],
    ['app-result messages_off', (H, id, now) => cli(H, 'event-outreach', ['app-result', '--event', H.slug, '--id', id, '--touch', '2', '--result', 'messages_off', '--page-says', 'off'], now)],
    ['gate drop id:2', (H, id, now) => gate(H, `drop ${id}:2`, now)],
    ['went no, then record skipped', (H, id, now) => [cli(H, 'event-outreach', ['send-outcome', '--event', H.slug, '--id', id, '--touch', '2', '--went', 'no', '--said', 'it is not there'], now), record(H, [{ who: id, what: 'skipped', touch: 2, said: 'skip that one' }], now)]]
  ]) {
    const { H, ana, bo } = appLimitOne();
    const L = later(8);
    assert.equal(listAt(H, L, NR).in_browser, 1, name);
    openWin(H, L);
    const [first] = browserList(H);
    const other = first.id === ana ? bo : ana;
    assert.equal(type(H, first.body, L).status, 0, name);
    clear(H, first.id, later(8, 1));
    const again = listAt(H, later(8, 2), [...NR, '--ids', other]);
    assert.equal(again.in_browser, 0, `${name}: ${JSON.stringify(again).slice(0, 400)}`);
    assert.match(again.waiting.find((w) => w.id === other)?.why || '', /request limit/, name);
    if (name === 'send-list --resend') {
      const same = listAt(H, later(8, 3), NR);
      assert.ok(browserList(H).some((x) => x.id === first.id) && !browserList(H).some((x) => x.id === other), `a resend to the same person needs no new place: ${JSON.stringify(same).slice(0, 300)}`);
    }
  }
  // App sending off: the follow-ups become CRM tasks. todo hands out one later-step app note, and task-list writes one.
  const T = { sending: { channels: ['chat'], followups: 'scheduled', linkedin_ack: true }, app_request_limit: 1, route: ['email', 'app'], crm_log: 'tasks', ...NOTES };
  const K = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP,Globex,bo@globex.test\n', event: { app_name: 'Grip' }, settings: T });
  triage(K);
  const d = draftApprove(K);
  assert.equal(d.jobs.filter((j) => j.touch === 2).length, 1, JSON.stringify(d.jobs.map((j) => `${j.id}:${j.touch}`)));
  const backup = JSON.parse(readFileSync(todoJobs(K).t.todo_file, 'utf8')).skipped || [];
  assert.ok(!JSON.stringify(backup).includes('ranked above'), 'the backup reason says only what is true');
  for (const n of ['Ana Berg', 'Bo Li']) sentMark(K, idOf(K, n), 1, { channel: 'email', via: 'email.send' }, later(-3));
  assert.equal(cli(K, 'event-outreach', ['task-list', '--event', K.slug], later(14)).by_kind?.send || 0, 1);
  // The same, with both follow-ups approved before the limit was set.
  const M = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP,Globex,bo@globex.test\n', event: { app_name: 'Grip' }, settings: { ...T, app_request_limit: null } });
  triage(M);
  assert.equal(draftApprove(M).jobs.filter((j) => j.touch === 2).length, 2);
  const me = JSON.parse(readFileSync(join(M.dir, 'event.json'), 'utf8'));
  me.settings.app_request_limit = 1;
  writeFileSync(join(M.dir, 'event.json'), JSON.stringify(me));
  for (const n of ['Ana Berg', 'Bo Li']) sentMark(M, idOf(M, n), 1, { channel: 'email', via: 'email.send' }, later(-3));
  const t = cli(M, 'event-outreach', ['task-list', '--event', M.slug], later(14));
  assert.equal(t.by_kind?.send || 0, 1, JSON.stringify(t).slice(0, 300));
});

// 8. skills/event-outreach/scripts/commands/saved-drafts.mjs:staleFor:no-baseline-when-follow-up-saved-before-its-predecessor
test('a follow-up saved before the message before it had any text goes back once that message is rewritten', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: ['email', 'email'] } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H);
  const ana = idOf(H, 'Ana Berg');
  const save = (touch, suffix = '') => {
    const { jobs, t } = todoJobs(H);
    const j = jobs.find((x) => x.id === ana && x.touch === touch);
    assert.ok(j, `job ${touch}: ${JSON.stringify(jobs.map((x) => x.touch))}`);
    const d = draftFor({ ...t, insights: [] }, { ...j, slot_labels: j.slot_labels || [] });
    const s = cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', ana, '--touch', String(touch), '--json', JSON.stringify({ subject: 'Test Expo', body: d.body + suffix, brief: 'x, no research profile', structure: d.structure, fact_source: d.fact_source, ...(d.insight ? { insight: d.insight } : {}) })]);
    assert.ok(!s.ERROR, s.ERROR);
    cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', ana, '--touch', String(touch), '--text', 'PASS']);
  };
  save(2);
  save(1);
  // Written before message 1 had any text, the follow-up was written for no version of it: back to be written again.
  assert.deepEqual(todoJobs(H).jobs.map((j) => j.touch).sort(), [1, 2], 'the follow-up comes back to be written again');
  const g = gate(H, 'approve all');
  assert.equal(g.approved, 0, JSON.stringify(g).slice(0, 400));
  assert.ok(g.not_ready.some((x) => x.touch === 2 && /saved before the message ahead of it had any text/.test(x.reason)), JSON.stringify(g).slice(0, 400));
  save(2);
  assert.equal(gate(H, 'approve all').approved, 2, 'written again after message 1, both go');
  const fb = put(H, 'fb.txt', 'shorter please');
  cli(H, 'event-outreach', ['revise', '--event', H.slug, '--ids', `${ana}:1`, '--feedback-file', fb]);
  save(1, '\n\nRewritten.');
  assert.ok(todoJobs(H).jobs.some((j) => j.touch === 2), 'and goes back when message 1 is rewritten');
  sentMark(H, ana, 1, { channel: 'email', via: 'email.send' });
  const l = listAt(H, later(8), ['--no-reply-check', 'nobody replied']);
  assert.ok(!emailList(H).some((x) => x.touch === 2), JSON.stringify(l).slice(0, 300));
  assert.match(l.waiting.find((w) => w.touch === 2)?.why || '', /needs a new draft/);
});

// 9. skills/flow/scripts/cli.mjs:company_research-substring-company-name-flips-skip-answer. Through the flow: every
// unclear answer is asked again, a plain one skips them all, and a list of the companies as listed, with ordinary words
// after each, skips only those.
const COS = 'Name,Title,Company,Email\nAna Berg,COO,Step,ana@step.test\nBo Li,VP Ops,Later,bo@later.test\nCy Oh,COO,Acme,cy@acme.test\nDi Fox,CFO,Globex,di@globex.test\n';
// (Said at the research heads-up, company_briefs, since 2026-11-21: the company_research ask is gone.)
function atCompanyResearch(final, check) {
  const H = makeHome({ context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' }, attendees: COS });
  const persona = simplePersona({ asks: { setup_level: 'standard', attendee_list: join(H.HOME, 'inputs', 'attendees.csv') } });
  const run = throughHeadsUp(H, persona, (up) => {
    check(H, up);
    const r = say(H, up, final);
    assert.ok(!r.ERROR, r.ERROR);
  });
  return { H, ...run };
}
test('through the flow: a company named like a word of a refusal never narrows "skip"', { timeout: 600000 }, () => {
  const plain = atCompanyResearch('skip companies', (H, s) => {
    assert.ok(['Step', 'Later', 'Acme', 'Globex'].every((x) => s.companies.includes(x)), s.companies.join(' '));
    for (const said of ['skip Acme as well as Globex', 'skip Acme (and Globex)', 'skip Acme because they are a customer and Globex', 'skip Acme and the rest', 'skip step', 'skip Globex, the rest is fine', 'skip this step', 'skip the step', 'skip Step research', 'skip step by step', 'skip step, not needed', "skip step, I don't want any web research", 'skip, later', 'skip for now, later', 'skip. Later'])
      assert.match(say(H, s, said).ERROR || '', /Name the companies/, said);
  });
  assert.ok(!plain.trail.includes('company_briefs'), `no web research: ${plain.trail.join(' ')}`);
  assert.match(readFileSync(join(plain.H.HOME, 'events', plain.slug, 'ledger.jsonl'), 'utf8'), /"ask":"company_research","value":"skip"/);
  const some = atCompanyResearch('please skip both Acme and Globex', () => {});
  const led = readFileSync(join(some.H.HOME, 'events', some.slug, 'ledger.jsonl'), 'utf8');
  assert.match(led, /"ask":"company_research","value":"yes","said":"skip both Acme and Globex"/);
  assert.ok(some.trail.includes('company_briefs'), 'the other two are looked up');
  for (const t of ['skip only Acme', 'skip just Acme', 'skip only Acme please', 'skip just the Acme one'])
    assert.deepEqual(namedCompanies(t, ['Step', 'Later', 'Acme', 'Globex']), ['Acme'], t);
  // A lone company without "only" or "just" is read back, however it is put (audit run 7, round 4).
  for (const t of ['skip Acme please', 'skip Acme for now', 'skip Acme too', 'skip Acme because they are a customer', 'skip the Acme one', 'skip Acme (customer)', 'leave out Acme', 'not Acme'])
    assert.deepEqual(namedCompanies(t, ['Step', 'Later', 'Acme', 'Globex']), [], t);
});

// 10. skills/slot-finder/scripts/cli.mjs:create:existing-event-json-replaced-dropping-mock-flag
test('create never replaces an event file, and the fixed mock events stay mock to the guard', () => {
  const S = { sending: { channels: ['email'], followups: 'scheduled' }, route: ['email'] };
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', event: { slug: 'mock-harbour-haul', mock: true }, settings: S });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE }, sending: S.sending }));
  triage(H);
  draftApprove(H);
  cli(H, 'event-outreach', ['send-list', '--event', H.slug]);
  const [it] = emailList(H);
  assert.ok(it, 'listed in the mock');
  const send = () => guard(H, 'mcp__gmail__send_email', { to: it.to, subject: it.subject, body: it.body });
  assert.equal(send().status, 2);
  const args = ['--name', 'Harbour', '--city', 'Rotterdam', '--start', '2026-11-10', '--end', '2026-11-12', '--zone', 'Europe/Amsterdam'];
  const r = cli(H, 'slot-finder', ['create', '--slug', 'mock-harbour-haul', ...args]);
  assert.match(r.ERROR || '', /already/, JSON.stringify(r).slice(0, 200));
  assert.equal(JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8')).mock, true);
  assert.equal(send().status, 2);
  // Even with its file changed by hand, the mock's fixed name keeps it away from real connectors.
  const ev = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  delete ev.mock;
  writeFileSync(join(H.dir, 'event.json'), JSON.stringify(ev));
  assert.equal(send().status, 2);
  // A new event with the name of one already there gets a slug of its own; the older file is untouched.
  const R = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', event: { slug: 'test-expo', dnc_path: '/x/dnc.txt' } });
  const n = cli(R, 'slot-finder', ['create', '--name', 'Test Expo', ...args.slice(2)]);
  assert.equal(n.slug, 'test-expo-2', JSON.stringify(n).slice(0, 200));
  assert.equal(JSON.parse(readFileSync(join(R.dir, 'event.json'), 'utf8')).dnc_path, '/x/dnc.txt');
  assert.match(cli(R, 'slot-finder', ['create', '--slug', 'test-expo', ...args]).ERROR || '', /already/);
});

// The deferred unit: the outbox card and the CRM task name the platform the step was approved for.
test('a LinkedIn step whose link the outbox will not show is still labelled LinkedIn, on the card and the task', () => {
  const S = { sending: { channels: ['app'], followups: 'scheduled' }, route: ['email', 'linkedin'], crm_log: 'tasks', ...NOTES };
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,http://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: S });
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  assert.equal(state(H)[ana].touches[2].approved?.where, 'LinkedIn');
  sentMark(H, ana, 1, { channel: 'email', via: 'email.send' }, later(-1));
  cli(H, 'event-outreach', ['open', '--event', H.slug, '--no-open'], later(8));
  const html = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
  const card = html.slice(html.indexOf('class="card'), html.indexOf('</article>'));
  assert.match(card, /Paste message \(LinkedIn\)/);
  assert.doesNotMatch(card, /Grip/);
  cli(H, 'event-outreach', ['task-list', '--event', H.slug], later(8));
  assert.ok(read(join(H.dir, 'task-list.json')).some((x) => x.kind === 'send' && / in LinkedIn$/.test(x.title)));
});

// H1. A name in a script with combining signs is greeted by its whole first name, and the draft passes its checks.
test('a greeting to a name in Devanagari, Thai, Bengali, Tamil, Arabic or Hebrew passes the draft checks', () => {
  const names = ['सुनील कुमार', 'สมชาย ใจดี', 'সুমন দাস', 'கார்த்திக் ராஜா', 'مُحَمَّد علي', 'יוֹסִי כהן'];
  const H = setup({ attendees: `Name,Title,Company,Email\n${names.map((n, i) => `${n},COO,Co${i},p${i}@co${i}.test`).join('\n')}\n` });
  triage(H);
  const { gate: g } = draftApprove(H);
  assert.ok(!(g.not_ready || []).some((x) => /greets/.test(x.reason)), JSON.stringify(g.not_ready).slice(0, 600));
  assert.equal(g.approved, names.length, JSON.stringify(g).slice(0, 400));
});

// H2. The agenda command doesn't offer a schedule that can't run.
test('the agenda command offers no scheduled task', () => {
  const md = readFileSync(join(ROOT, 'commands/agenda.md'), 'utf8');
  assert.doesNotMatch(md, /offer once to schedule|07:00|scheduled task in Claude Code/);
  assert.match(md, /day before a meeting day or that morning/);
});
