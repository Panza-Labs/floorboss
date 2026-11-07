// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Escaping for generated HTML pages. Every field shown in the outbox goes through these.

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\u2028/g, '&#x2028;')
    .replace(/\u2029/g, '&#x2029;');
}

// Only http(s) and mailto links survive; anything else (javascript:, data:, relative) becomes null.
export function safeUrl(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

// JSON that is safe to place inside a <script type="application/json"> element.
export function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
