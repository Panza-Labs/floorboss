// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// RemoteTrigger in the session that ran floorboss (owner's approval 2026-11-22, rule b). Claude Code's RemoteTrigger
// makes a routine: a scheduled task in the user's Claude account that runs in the cloud. While floorboss's run holds a
// session, the catch-all hook refuses it, since its body could carry what the session read. Two narrow exceptions:
//   create / update   only with the body floorboss printed (autosend routine-body), compared by its hash, within 30
//                     minutes of printing it, and once; update only for the routine floorboss saved for that event,
//                     create only when it saved none.
//   get / list_runs / get_run_log   only for a routine floorboss saved.
// A routine floorboss saved is one whose id RemoteTrigger itself answered (afterRemoteTrigger, after the call ran),
// for the body floorboss printed: never an id the model gave.
// Each is let through with Claude Code's own permission prompt ("ask"), never "allow". Anything else stays refused.
import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bodySha, routinesDir, savedRoutine as savedFile, pendingRoutine, routineName, answeredIds, recordAnswer } from '../../lib/autosend/routine.mjs';
import { rawValue } from './witness.mjs';
import { promptLine } from './prompts.mjs';

export const PRINTED_FRESH_MS = 30 * 60 * 1000;
const READS = Object.freeze(['get', 'list_runs', 'get_run_log']);
const TRIG_RE = /^trig_[A-Za-z0-9]{8,64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// The routine floorboss saved, only while its id is one RemoteTrigger itself answered (afterRemoteTrigger): a saved id
// from anywhere else is no routine of floorboss's, so it is never read or updated.
const savedRoutine = (home, slug) => {
  const s = savedFile(home, slug);
  return s?.trigger_id && answeredIds(home, slug).includes(s.trigger_id) ? s : null;
};

// The events with a routine floorboss printed or saved.
function routineSlugs(home) {
  const d = routinesDir(home);
  if (!existsSync(d)) return [];
  return [...new Set(readdirSync(d).map((f) => /^([a-z0-9][a-z0-9-]{0,63})(?:\.pending)?\.json$/.exec(f)?.[1]).filter((s) => s && SLUG_RE.test(s)))].sort();
}

// { ask } to let the call through with the user's prompt, or { refuse }, for a RemoteTrigger call in a held session.
export function remoteTriggerCall(toolInput, home, nowMs) {
  const t = isObj(toolInput) ? toolInput : {};
  const action = String(t.action ?? '');
  const keys = Object.keys(t);
  const slugs = routineSlugs(home);
  if (READS.includes(action)) {
    const allowed = ['action', 'trigger_id', ...(action === 'get_run_log' ? ['run_id'] : [])];
    if (keys.some((k) => !allowed.includes(k))) return { refuse: `RemoteTrigger ${action} with anything but the routine's id isn't one floorboss checks.` };
    if (action === 'get_run_log' && t.run_id != null && !/^[\w-]{1,128}$/.test(String(t.run_id))) return { refuse: 'that run id is not a plain id.' };
    const slug = slugs.find((s) => savedRoutine(home, s)?.trigger_id === t.trigger_id && TRIG_RE.test(String(t.trigger_id)));
    if (!slug) return { refuse: `RemoteTrigger ${action} reads only the daily routine floorboss saved, and ${JSON.stringify(String(t.trigger_id ?? '').slice(0, 60))} isn't it.` };
    return { ask: `floorboss: read your daily routine ${promptLine(routineName(slug))} (${t.trigger_id}): RemoteTrigger ${action}. Nothing changes.\n\nAllow only if you want floorboss to look at it now.` };
  }
  if (action !== 'create' && action !== 'update') return { refuse: `RemoteTrigger ${promptLine(action.slice(0, 40))} isn't one floorboss uses.` };
  const allowed = action === 'create' ? ['action', 'body'] : ['action', 'trigger_id', 'body'];
  if (keys.some((k) => !allowed.includes(k)) || !isObj(t.body)) return { refuse: `RemoteTrigger ${action} is let through only exactly as floorboss printed it (its action${action === 'update' ? ', trigger_id' : ''} and body).` };
  const sha = bodySha(t.body);
  const slug = slugs.find((s) => pendingRoutine(home, s)?.body_sha === sha);
  if (!slug) return { refuse: `this RemoteTrigger body isn't the one floorboss printed (autosend routine-body), word for word: run routine-body again and pass its remote_trigger unchanged.` };
  const pending = pendingRoutine(home, slug);
  if (!(nowMs - Date.parse(pending.at) <= PRINTED_FRESH_MS)) return { refuse: 'floorboss printed this routine body more than 30 minutes ago: run routine-body again and pass the new one.' };
  const saved = savedRoutine(home, slug);
  // Any saved routine file, recorded id or not: never a second routine for the event.
  const raw = savedFile(home, slug);
  if (action === 'create' && raw) return { refuse: `floorboss already saved a routine for ${slug}${raw.trigger_id ? ` (${String(raw.trigger_id).slice(0, 80)})` : ''}: it is updated, never made twice.` };
  if (action === 'update' && (!saved?.trigger_id || t.trigger_id !== saved.trigger_id)) return { refuse: `RemoteTrigger update is let through only for the routine floorboss saved for ${slug}${saved?.trigger_id ? ` (${saved.trigger_id})` : ' (none is saved yet)'}.` };
  // Once: a second call with this body (a retry, or the same call twice at once) is refused.
  mkdirSync(routinesDir(home), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(routinesDir(home), `${slug}.called-${sha.slice(0, 16)}`), new Date(nowMs).toISOString(), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return { refuse: 'this routine body was already let through once: if the routine is there, run routine-saved with its id; if not, run routine-body again for a new one.' };
  }
  const when = `every day at ${pending.time} (${pending.zone})`;
  return {
    ask: `floorboss: ${action === 'create' ? 'create' : 'update'} the daily routine ${promptLine(routineName(slug))} in your Claude account${action === 'update' ? ` (${t.trigger_id})` : ''}, ${when}. A routine is a scheduled task that runs in the cloud, so your laptop can be off. Each day it sends the Gmail drafts that are due (${pending.queued} in its list now), unchanged, after checking Gmail for replies and bounces: anyone who replied or whose email bounced is skipped. A booking or a stop recorded in floorboss takes effect when floorboss has you delete their drafts. This is exactly the routine floorboss printed.\n\nAllow only if you chose to send automatically.`
  };
}

// After a RemoteTrigger call ran (PostToolUse, main conversation only): the routine id in RemoteTrigger's own answer,
// for a create or update that carried exactly the body floorboss printed last (pending), recorded so routine-saved
// takes that id only. An update's answer must name the routine it updated. True if recorded.
const TRIG_ALL = /trig_[A-Za-z0-9]{8,64}/g;
function answerId(resp) {
  if (isObj(resp) && (resp.isError === true || resp.is_error === true || 'error' in resp)) return null;
  const v = rawValue(resp);
  if (v.ok && isObj(v.value)) {
    if ('error' in v.value) return null;
    const x = v.value;
    const id = [x.id, x.trigger_id, x.trigger?.id, x.data?.id].find((y) => typeof y === 'string' && TRIG_RE.test(y));
    if (id) return id;
  }
  // Plain words: exactly one routine id in them.
  const text = typeof resp === 'string' ? resp : Array.isArray(resp?.content) ? resp.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join(' ') : Array.isArray(resp) ? resp.map((b) => (typeof b?.text === 'string' ? b.text : '')).join(' ') : '';
  if (/\b(error|failed|denied|not found)\b/i.test(text)) return null;
  const ids = [...new Set(text.match(TRIG_ALL) || [])];
  return ids.length === 1 && TRIG_RE.test(ids[0]) ? ids[0] : null;
}
export function afterRemoteTrigger(input, home, nowMs) {
  if (String(input?.tool_name || '') !== 'RemoteTrigger') return false;
  const t = isObj(input.tool_input) ? input.tool_input : {};
  const action = String(t.action ?? '');
  if ((action !== 'create' && action !== 'update') || !isObj(t.body)) return false;
  const sha = bodySha(t.body);
  const slug = routineSlugs(home).find((s) => pendingRoutine(home, s)?.body_sha === sha);
  if (!slug) return false;
  const id = answerId(input.tool_response);
  if (!id) return false;
  if (action === 'update') {
    const saved = savedRoutine(home, slug);
    if (!saved || t.trigger_id !== saved.trigger_id || id !== saved.trigger_id) return false;
  }
  recordAnswer(home, slug, { body_sha: sha, trigger_id: id, action, at: new Date(nowMs).toISOString() });
  return true;
}
