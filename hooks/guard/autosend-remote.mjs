// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// autosend remote --confirm <url> in Claude Code: the user's yes that the data folder's repository is theirs. The
// model never gives it for them: the call asks the user, with the address (no token) and the owner's three answers,
// and only for the exact address the data folder's remote has now. A subagent, or any other argument, is refused.
import { shellWords } from './shell.mjs';
import { dataRemote, bareUrl, confirmQuestion, remoteUrlOk, repoConfigWhy } from '../../lib/autosend/sync.mjs';

export function remoteConfirmCall(command, { subagent, home }) {
  if (subagent) return { refuse: "a subagent doesn't confirm your data repository: only you do, in the main session." };
  const words = shellWords(command);
  const rest = words.slice(3);
  if (words[2] !== 'remote' || rest.length !== 2 || rest[0] !== '--confirm') return { refuse: 'autosend remote runs only as remote --confirm <the address floorboss asked about>.' };
  if (repoConfigWhy(home)) return { refuse: "the data folder's git settings aren't floorboss's, so there is nothing to confirm." };
  const d = dataRemote(home);
  if (!d || !remoteUrlOk(d.url) || bareUrl(d.url) !== bareUrl(rest[1])) return { refuse: "that isn't the address the data folder's repository has now, so floorboss won't record it." };
  return {
    ask: `floorboss: confirm the repository your auto-send data goes to?\n\n${confirmQuestion(d.url)}\n\nAllow only if the user answered 1: floorboss records this address and sends the copy there from now on. Deny if they answered 2 or 3, or you aren't sure: nothing is recorded and nothing is sent.`
  };
}
