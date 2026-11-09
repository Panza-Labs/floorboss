// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The outbox: one self-contained offline page with every message, Copy buttons and status ticks.
import { createHash } from 'node:crypto';
import { escapeHtml as e, safeUrl, jsonForScript } from '../../../lib/escape.mjs';
import { profileLinkAllowed, isLinkedInProfile, eventHosts } from '../../../lib/security.mjs';

const csp = () => `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'; img-src 'none'; base-uri 'none'; form-action 'none'`;

function verdictChip(v) {
  if (!v) return '<span class="chip">not checked</span>';
  if (v.verdict === 'SKIPPED') return `<span class="chip warn" title="${e(v.said || '')}">not reviewed: you skipped review</span>`;
  return v.verdict === 'PASS' ? '<span class="chip ok">critic: pass</span>' : `<span class="chip bad" title="${e(v.reasons.join('; '))}">critic: failed</span>`;
}

function field(label, id, value) {
  return (
    `<div class="field"><div class="k"><span>${e(label)}</span><button type="button" class="copy" data-copy="${e(id)}">Copy</button></div>` +
    `<pre id="${e(id)}">${e(value)}</pre></div>`
  );
}

// A profile link is shown (and opened by "Go") only when it points at LinkedIn, an event app floorboss knows,
// or the event's own site: a link from a list or a CRM field pointing anywhere else shows no link.
// app: the event's own app, when one is set up (null: none, so no card points at an app).
function card(c, hosts = [], app = null) {
  const raw = safeUrl(c.profile_url);
  const url = raw && profileLinkAllowed(raw, hosts) ? raw : null;
  // A coordinate note goes to the colleague, not to the person: there is nothing to paste in an app.
  const addr =
    c.kind === 'coordinate'
      ? `send it to ${e(c.holder || 'the colleague')} yourself (chat or email)`
      : c.channel === 'email'
        ? e(c.address || '')
        : url
          ? `<a href="${e(url)}" rel="noopener noreferrer">${e(url)}</a>`
          : app
            ? `no address: paste it in ${e(app)}`
            : 'no address: paste it wherever you reach them';
  const channel =
    c.kind === 'coordinate'
      ? `note for ${e(c.holder || 'the relationship holder')}`
      : c.channel === 'email'
        ? 'Email'
        : app
          ? `Paste message (${e(app)} or a DM)`
          : 'Paste message (a DM)';
  const slotOpts = (c.slots || []).map((s) => `<option value="${e(s.id)}">${e(s.label)}</option>`).join('');
  const failed =
    c.verdict && c.verdict.verdict === 'FAIL'
      ? `<p class="failnote">Failed the critic after one rewrite: ${e(c.verdict.reasons.join('; '))}. Edit before sending, or drop it.</p>`
      : '';
  const li = c.kind !== 'coordinate' && c.channel !== 'email' && url && isLinkedInProfile(url);
  return `<article class="card${c.kind === 'coordinate' ? ' coord' : ''}" data-id="${e(c.id)}" data-touch="${e(c.touch ?? 1)}" data-earliest="${e(c.earliest || '')}"${li ? ` data-li="1" data-url="${e(url)}" data-name="${e(c.name)}" data-who="${e(`${c.title || ''}${c.title && c.company ? ', ' : ''}${c.company || ''}`)}" data-company="${e(c.company || '')}"` : ''}>
  <header><div>${c.pending ? '<span class="chip warn">pending your approval</span> ' : ''}<b>${e(c.name)}</b> · ${e(c.title)}, ${e(c.company)} <span class="id">${e(c.id)}${c.touch > 1 ? ` · touch ${c.touch}` : ''}</span>${c.kind === 'confirmation' ? ' <span class="chip ok">booked: confirmation</span>' : ''}${c.staged ? ' <span class="chip">in your mailbox drafts</span>' : ''}</div>${c.kind === 'coordinate' ? '' : verdictChip(c.verdict)}</header>
  <p class="meta">${channel} · ${addr}${c.mode ? ` · ${e(c.mode)}` : ''}</p>
  ${c.identity_unconfirmed ? '<p class="failnote">Research couldn\'t confirm they\'re at this company: check their profile before sending.</p>' : ''}
  ${c.instruction_like ? '<p class="failnote">Their entry on the list reads like an instruction to an AI. The scripts didn\'t act on it. Check this person yourself.</p>' : ''}
  ${c.pick_in_app?.length ? `<p class="follow">In the app's meeting request, pick ${e(c.pick_in_app.join(' or '))}.</p>` : c.pick_in_app ? '<p class="follow">In the app\'s meeting request, pick any open time.</p>' : ''}
  ${c.brief ? `<p class="brief">${e(c.brief)}</p>` : ''}
  ${c.followup_note ? `<p class="follow">${e(c.followup_note)}</p>` : ''}
  ${failed}
  ${c.checks_stuck?.length ? `<p class="failnote">Still fails floorboss's checks after three rewrites: ${e(c.checks_stuck.join('; '))}. Edit it or drop it; it isn't offered for approval as it is.</p>` : ''}
  ${c.subject ? field('Subject', `${c.id}-t${c.touch}-subject`, c.subject) : ''}
  ${field(c.kind === 'coordinate' ? 'Note' : 'Message', `${c.id}-t${c.touch}-body`, c.body)}
  <p class="stale" hidden>The earliest time offered here has passed. Run /floorboss:event-draft again for new times before sending.</p>
  ${
    c.kind === 'coordinate'
      ? ''
      : `<div class="ticks">
    <label><input type="checkbox" data-tick="sent"> Sent</label>
    <label><input type="checkbox" data-tick="replied"> Replied</label>
    <label>Booked <select data-tick="booked"><option value="">no</option>${slotOpts}</select></label>
    <label><input type="checkbox" data-tick="stop"> Stop (don't contact again)</label>
  </div>`
  }
</article>`;
}

export function renderOutbox(data) {
  const msgs = data.cards.filter((c) => c.kind !== 'coordinate');
  const coords = data.cards.filter((c) => c.kind === 'coordinate');
  const hosts = eventHosts({
    list_url: data.event?.list_url,
    url: data.event?.url,
    website: data.event?.website,
    site_url: data.event?.site_url,
    app_url: data.event?.app_url
  });
  const slotRows = (data.slots || []).map((s) => `<tr><td>${e(s.label)}</td><td>${e((s.holders || []).join(', ') || '—')}</td></tr>`).join('');
  const counts = data.counts || {};
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp()}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(data.event.name)} · floorboss outbox</title>
<style>
:root{--bg:#f4f5f7;--card:#fff;--ink:#16202a;--muted:#5c6774;--line:#dde1e6;--accent:#2347d6;--ok:#17703d;--okbg:#e3f3e9;--bad:#a3212b;--badbg:#fbe6e8;--warn:#8a5a00;--warnbg:#fbf0dc;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#11161c;--card:#182029;--ink:#e6eaef;--muted:#9aa5b2;--line:#2a3441;--accent:#8ea3ff;--ok:#7fd4a0;--okbg:#18301f;--bad:#ff98a0;--badbg:#3a1b1f;--warn:#f0b45a;--warnbg:#3a2a12;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:0 16px 48px}
.wrap{max-width:860px;margin:0 auto}
.banner{background:var(--warnbg);color:var(--warn);border-radius:10px;padding:12px 16px;margin:20px 0 8px}
h1{font-size:26px;margin:16px 0 2px}h2{font-size:18px;margin:28px 0 10px}
.sub{color:var(--muted);margin:0 0 12px}
.bar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;position:sticky;top:0;z-index:2}
.bar b{font-variant-numeric:tabular-nums}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:7px;padding:4px 10px;cursor:pointer}
button:hover{border-color:var(--accent)}button:disabled{opacity:.45;cursor:not-allowed}
button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:12px 0;display:grid;gap:8px}
.card.coord{border-style:dashed}.card.done{opacity:.6}
.card header{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.id{color:var(--muted);font:12px ui-monospace,Menlo,monospace;margin-left:6px}
.meta,.brief,.follow{margin:0;color:var(--muted);font-size:14px}.brief{color:var(--ink)}
.follow{color:var(--warn)}.failnote{margin:0;color:var(--bad)}.stale{margin:0;color:var(--bad)}
.chip{font:12px ui-monospace,Menlo,monospace;border-radius:999px;padding:2px 9px;background:var(--bg);color:var(--muted)}
.chip.warn{background:var(--warnbg);color:var(--warn)}.chip.ok{background:var(--okbg);color:var(--ok)}.chip.bad{background:var(--badbg);color:var(--bad)}
.field{border:1px solid var(--line);border-radius:9px;overflow:hidden}
.field .k{display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:var(--bg);font:11px ui-monospace,Menlo,monospace;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
pre{margin:0;padding:10px 12px;white-space:pre-wrap;word-wrap:break-word;font:inherit}
.ticks{display:flex;flex-wrap:wrap;gap:14px;font-size:14px}
.queue{background:var(--card);border:2px solid var(--accent);border-radius:12px;padding:14px 16px;margin:16px 0;display:grid;gap:10px}
.queue .who{font-size:17px}.queue .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.queue kbd{font:11px ui-monospace,Menlo,monospace;border:1px solid var(--line);border-radius:4px;padding:0 4px;margin-left:4px;color:var(--muted)}
.queue button.primary kbd{color:#fff;border-color:rgba(255,255,255,.6)}
.queue pre{max-height:180px;overflow:auto;border:1px solid var(--line);border-radius:9px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
td,th{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);font-size:14px}th{color:var(--muted);font-weight:500}
a{color:var(--accent)}textarea{width:100%;min-height:90px;font:12px ui-monospace,Menlo,monospace;margin-top:8px}
</style></head>
<body><div class="wrap">
<p class="banner">You're sending these yourself. Check the rules that apply to you and your recipients before you send. floorboss never sends anything.</p>
<h1>${e(data.event.name)}</h1>
<p class="sub">${e(data.event.city || '')} · ${e(data.event.start_date)} to ${e(data.event.end_date)} · times in ${e(data.event.time_zone)} · generated ${e(data.generatedAt)}</p>
<div class="bar"><span><b id="sentCount">0</b> of <b>${msgs.length}</b> sent</span>
<span>${counts.coordinate || 0} held for a colleague · ${counts.suppressed || 0} left alone (do-not-contact, opted out, a lost deal) · ${counts.not_drafted || 0} not drafted (they don't fit, have no address, or wait on your call)</span>
<button type="button" class="primary" id="copyStatus">Copy status</button></div>
<textarea id="statusOut" readonly hidden aria-label="Status to paste into the next run"></textarea>
<section class="queue" id="liQueue" hidden aria-label="LinkedIn queue">
  <div class="row"><b>LinkedIn queue</b><span class="sub" id="qPos"></span></div>
  <div class="who" id="qWho"></div>
  <pre id="qBody"></pre>
  <div class="row">
    <button type="button" class="primary" id="qGo">Copy message + open profile<kbd>Enter</kbd></button>
    <button type="button" id="qLink">Copy profile link</button>
    <button type="button" id="qSent">Sent ✓ → next<kbd>S</kbd></button>
    <button type="button" id="qSkip">Skip<kbd>N</kbd></button>
    <button type="button" id="qLog">Copy CRM log (CSV)</button>
  </div>
  <p class="sub" id="qDone" hidden>All LinkedIn messages here are marked sent. Use "Copy status" so floorboss records them, and "Copy CRM log" for HubSpot or a sheet.</p>
</section>
<h2>Messages (${msgs.length})</h2>
${msgs.map((c) => card(c, hosts, data.event?.app_name || null)).join('\n') || '<p class="sub">Nothing to send yet.</p>'}
${coords.length ? `<h2>Coordinate notes (${coords.length})</h2><p class="sub">These people's relationship is held by someone else. Pass the note on instead of reaching out yourself.</p>${coords.map((c) => card(c, hosts)).join('\n')}` : ''}
${slotRows ? `<h2>Who was offered each time</h2><table><thead><tr><th>Time</th><th>Offered to</th></tr></thead><tbody>${slotRows}</tbody></table>` : ''}
${(data.visit || []).length ? `<h2>Visit list (${data.visit.length})</h2><table><thead><tr><th>Company</th><th>Booth</th></tr></thead><tbody>${data.visit.map((v) => `<tr><td>${e(v.company)}</td><td>${e(v.booth || '—')}</td></tr>`).join('')}</tbody></table>` : ''}
</div>
<script type="application/json" id="fb-data">${jsonForScript({ slug: data.event.slug })}</script>
<script>${OUTBOX_SCRIPT}</script>
</body></html>
`;
}

// The page's one script, allowed by its hash (no 'unsafe-inline' for scripts): an escaping slip that let
// markup into the page still couldn't run script of its own.
const OUTBOX_SCRIPT = `
(function(){
  var data = JSON.parse(document.getElementById('fb-data').textContent);
  var key = 'floorboss:' + data.slug;
  var state = {};
  try { state = JSON.parse(localStorage.getItem(key) || '{}'); } catch (err) { state = {}; }
  function save(){ try { localStorage.setItem(key, JSON.stringify(state)); } catch (err) {} }
  function today(){ var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card[data-id]'));
  function keyOf(c){ return c.dataset.id + ':' + (c.dataset.touch || '1'); }
  function refresh(){
    var sent = 0;
    cards.forEach(function(c){
      var s = state[keyOf(c)] || {};
      if (s.sent) sent++;
      c.classList.toggle('done', !!(s.replied || s.booked || s.stop));
      c.querySelectorAll('[data-tick]').forEach(function(el){
        var t = el.dataset.tick;
        if (el.type === 'checkbox') el.checked = !!s[t]; else el.value = s[t] || '';
      });
      var earliest = c.dataset.earliest;
      var stale = earliest && Date.now() > Date.parse(earliest) && !s.sent;
      c.querySelectorAll('button.copy').forEach(function(b){ b.disabled = !!stale; });
      var p = c.querySelector('.stale'); if (p) p.hidden = !stale;
    });
    document.getElementById('sentCount').textContent = sent;
  }
  cards.forEach(function(c){
    c.querySelectorAll('[data-tick]').forEach(function(el){
      el.addEventListener('change', function(){
        var s = state[keyOf(c)] || (state[keyOf(c)] = {});
        var t = el.dataset.tick;
        if (t === 'sent') s.sent = el.checked ? (s.sent || today()) : null;
        else if (t === 'booked') s.booked = el.value || null;
        else s[t] = el.checked;
        save(); refresh();
      });
    });
  });
  function copyText(text, btn){
    function done(){ var o = btn.textContent; btn.textContent = 'Copied'; setTimeout(function(){ btn.textContent = o; }, 1200); }
    function fallback(){ var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (err) {} document.body.removeChild(ta); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }
  document.querySelectorAll('button.copy').forEach(function(b){
    b.addEventListener('click', function(){ copyText(document.getElementById(b.dataset.copy).textContent, b); });
  });
  document.getElementById('copyStatus').addEventListener('click', function(ev){
    var lines = ['floorboss-status v1 event=' + data.slug + ' at=' + new Date().toISOString().replace(/\\.\\d+Z$/, 'Z')];
    Object.keys(state).sort().forEach(function(k){
      var s = state[k], parts = k.split(':'), t = [parts[1] && parts[1] !== '1' ? parts[0] + ':' + parts[1] : parts[0]];
      if (s.sent) t.push('sent=' + s.sent);
      if (s.booked) t.push('booked=' + s.booked);
      if (s.replied) t.push('replied');
      if (s.stop) t.push('stop');
      if (t.length > 1) lines.push(t.join(' '));
    });
    var text = lines.join('\\n');
    var out = document.getElementById('statusOut'); out.hidden = false; out.value = text;
    copyText(text, ev.currentTarget);
  });
  // The LinkedIn queue: one person at a time, using the same Sent ticks as the cards (so "Copy status" carries them).
  var q = cards.filter(function(c){ return c.dataset.li === '1'; });
  var qi = 0, panel = document.getElementById('liQueue');
  function bodyOf(c){ var el = document.getElementById(c.dataset.id + '-t' + (c.dataset.touch || '1') + '-body'); return el ? el.textContent : ''; }
  function pending(){ return q.filter(function(c){ var s = state[keyOf(c)] || {}; return !s.sent && !s.stop && !s.replied && !s.booked; }); }
  function show(){
    var left = pending();
    if (!q.length) { panel.hidden = true; return; }
    panel.hidden = false;
    var done = !left.length;
    document.getElementById('qDone').hidden = !done;
    ['qGo','qLink','qSent','qSkip'].forEach(function(id){ document.getElementById(id).disabled = done; });
    if (done) { document.getElementById('qWho').textContent = ''; document.getElementById('qBody').textContent = ''; document.getElementById('qPos').textContent = q.length + ' of ' + q.length + ' sent'; return; }
    if (qi >= left.length) qi = 0;
    var c = left[qi];
    document.getElementById('qWho').textContent = c.dataset.name + ' · ' + c.dataset.who;
    document.getElementById('qBody').textContent = bodyOf(c);
    document.getElementById('qPos').textContent = (q.length - left.length) + ' of ' + q.length + ' sent · ' + left.length + ' to go';
  }
  function cur(){ var left = pending(); return left[qi % Math.max(1, left.length)]; }
  document.getElementById('qGo').addEventListener('click', function(ev){ var c = cur(); if (!c) return; copyText(bodyOf(c), ev.currentTarget); window.open(c.dataset.url, '_blank', 'noopener'); });
  document.getElementById('qLink').addEventListener('click', function(ev){ var c = cur(); if (c) copyText(c.dataset.url, ev.currentTarget); });
  document.getElementById('qSent').addEventListener('click', function(){ var c = cur(); if (!c) return; var s = state[keyOf(c)] || (state[keyOf(c)] = {}); s.sent = s.sent || today(); save(); refresh(); show(); });
  document.getElementById('qSkip').addEventListener('click', function(){ qi++; show(); });
  document.getElementById('qLog').addEventListener('click', function(ev){
    // As lib/csv.mjs toCsv: a cell a spreadsheet would run as a formula (=, +, -, @, tab) is kept as text.
    var esc = function(v){ v = String(v == null ? '' : v); if (/^[=+\\-@\\t\\r]/.test(v)) v = "'" + v; return /[",;\\t\\n\\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var rows = [['name','company','profile_url','message','sent_on']];
    q.forEach(function(c){ var s = state[keyOf(c)] || {}; if (s.sent) rows.push([c.dataset.name, c.dataset.company, c.dataset.url, bodyOf(c), s.sent]); });
    copyText(rows.map(function(r){ return r.map(esc).join(','); }).join('\\n'), ev.currentTarget);
  });
  document.addEventListener('keydown', function(ev){
    if (panel.hidden || /input|textarea|select/i.test((ev.target && ev.target.tagName) || '')) return;
    if (ev.key === 'Enter') { ev.preventDefault(); document.getElementById('qGo').click(); }
    else if (ev.key === 's' || ev.key === 'S') document.getElementById('qSent').click();
    else if (ev.key === 'n' || ev.key === 'N') document.getElementById('qSkip').click();
  });
  refresh();
  show();
})();
`;
const SCRIPT_HASH = createHash('sha256').update(OUTBOX_SCRIPT, 'utf8').digest('base64');
