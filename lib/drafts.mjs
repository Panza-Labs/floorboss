// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Draft text lives in drafts/<hash>.json, named by a hash of exactly what would be sent: the channel, the
// recipient, the subject and the body. Approvals, critic verdicts and releases in the ledger point at the
// hash, so an edited text is a new draft, and "did the critic read this exact text" is a comparison of hashes.
// Files are written once and never changed.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { linkRefusal } from './paths.mjs';

export function draftHash(d) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        d?.channel || '',
        String(d?.to || '')
          .trim()
          .toLowerCase(),
        d?.subject || '',
        d?.body || ''
      ])
    )
    .digest('hex')
    .slice(0, 24);
}

export function draftPath(evDir, hash) {
  if (!/^[0-9a-f]{24}$/.test(String(hash))) throw new Error(`"${hash}" isn't a draft hash`);
  return join(evDir, 'drafts', `${hash}.json`);
}

// Saves { channel, to, subject, body, language?, insight?, kind? } and returns its hash. The same text saves to
// the same file; a different text can never land under an existing hash.
export function saveDraft(evDir, d) {
  const draft = {
    channel: d.channel || 'email',
    to: String(d.to || '')
      .trim()
      .toLowerCase(),
    subject: d.subject || '',
    body: String(d.body || ''),
    language: d.language || null,
    insight: d.insight ?? null,
    kind: d.kind || 'message'
  };
  const hash = draftHash(draft);
  const path = draftPath(evDir, hash);
  const text = JSON.stringify({ hash, ...draft });
  if (existsSync(path)) {
    const have = readFileSync(path, 'utf8');
    if (have !== text) {
      const old = JSON.parse(have);
      if (draftHash(old) !== hash || old.body !== draft.body || old.subject !== draft.subject || old.to !== draft.to)
        throw new Error(`drafts/${hash}.json already holds a different text; refusing to overwrite it`);
    }
    return hash;
  }
  mkdirSync(join(evDir, 'drafts'), { recursive: true, mode: 0o700 });
  // Created new (wx), and never through a link on the way (a drafts folder that is a link).
  {
    const why = linkRefusal(path);
    if (why) throw new Error(why);
  }
  writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
  return hash;
}

// Reads a draft and checks it still matches its name. A file whose text no longer hashes to its name was
// edited by hand: refused.
export function readDraft(evDir, hash) {
  const path = draftPath(evDir, hash);
  if (!existsSync(path)) return null;
  const d = JSON.parse(readFileSync(path, 'utf8'));
  if (draftHash(d) !== hash) throw new Error(`drafts/${hash}.json was changed after it was written (its text no longer matches its name)`);
  return d;
}
