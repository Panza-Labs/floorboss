// The CI workflows are part of what could change the repository, so they're held to rules a test can check:
// every action pinned to a full commit (a tag can be moved), no write access by default, checkout keeps no
// token, no workflow that runs on a fork's code with the repository's secrets, and no event text pasted into a
// shell command, where a crafted branch name or title would run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = new URL('../.github/workflows/', import.meta.url).pathname;
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));

test('every workflow pins its actions to a full commit and starts with no write access', () => {
  assert.ok(files.length >= 2, files.join(', '));
  for (const f of files) {
    const y = readFileSync(join(DIR, f), 'utf8');
    for (const m of y.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)) {
      assert.match(m[1], /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${f}: ${m[1]} isn't pinned to a commit`);
      assert.match(m[2], /#\s*v\d/, `${f}: ${m[1]} has no version comment for the reviewer`);
    }
    assert.match(y, /^permissions:\s*(\{\}|\n\s+contents:\s*read\s*$)/m, `${f}: top-level permissions must be {} or contents: read`);
    assert.doesNotMatch(y, /pull_request_target|workflow_run/, `${f}: runs a fork's code with the repository's rights`);
    for (const run of y.matchAll(/^\s*-?\s*run:\s*(.*)$/gm)) assert.doesNotMatch(run[1], /\$\{\{\s*github\.(event|head_ref)/, `${f}: event text in a shell command`);
    const checkouts = [...y.matchAll(/uses:\s*actions\/checkout@[^\n]*\n\s+with:\s*\n\s+persist-credentials:\s*false/g)].length;
    assert.equal(checkouts, (y.match(/uses:\s*actions\/checkout@/g) || []).length, `${f}: a checkout keeps the token on disk`);
  }
});

test('write permissions appear only where a job needs them, and never to the code', () => {
  for (const f of files) {
    const y = readFileSync(join(DIR, f), 'utf8');
    assert.doesNotMatch(y, /contents:\s*write|packages:\s*write|actions:\s*write|pull-requests:\s*write|write-all/, f);
  }
});
