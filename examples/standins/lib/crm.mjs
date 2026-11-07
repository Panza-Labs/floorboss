// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// CRM helpers shared by crm-a and crm-b: matching and owner derivation.

// Exact email, or a case-insensitive substring of the full name or company.
export function matchRecords(records, query) {
  const q = query.trim().toLowerCase();
  return records
    .map((r, index) => ({ ...r, index }))
    .filter(
      (r) =>
        (r.email || '').toLowerCase() === q ||
        `${r.first_name || ''} ${r.last_name || ''}`.toLowerCase().includes(q) ||
        (r.company || '').toLowerCase().includes(q)
    );
}

// Owners in order of first appearance, so ids stay stable for the same data.
export function owners(records) {
  const seen = [];
  for (const r of records) if (r.owner && !seen.includes(r.owner)) seen.push(r.owner);
  return seen.map((name, i) => {
    const [first, ...rest] = name.split(' ');
    const last = rest.join(' ');
    const handle = [first, last]
      .filter(Boolean)
      .join('.')
      .toLowerCase()
      .replace(/[^a-z.]/g, '');
    return { id: String(9001 + i), name, first, last, email: `${handle}@crm-owner.example` };
  });
}

// Tasks the stand-in CRMs hold, kept next to the data file so a test (or the simulated user) can mark one
// done and write an outcome, the way someone would in the real CRM.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const tasksPath = () => (process.env.STANDIN_DATA ? `${process.env.STANDIN_DATA}.tasks.json` : null);
export function loadTasks() {
  const p = tasksPath();
  return p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
}
export function saveTask(task) {
  const p = tasksPath();
  if (!p) return;
  const all = loadTasks().filter((t) => t.id !== task.id);
  all.push(task);
  writeFileSync(p, JSON.stringify(all, null, 2) + '\n');
}

// People added through a stand-in's create tool, kept next to the data file like tasks: later searches and
// mail reads find them, as in a real CRM.
const contactsPath = () => (process.env.STANDIN_DATA ? `${process.env.STANDIN_DATA}.contacts.json` : null);
export function withCreated(records) {
  const p = contactsPath();
  return [...records, ...(p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [])];
}
export function saveContact(record) {
  const p = contactsPath();
  if (!p) return;
  const all = p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
  all.push(record);
  writeFileSync(p, JSON.stringify(all, null, 2) + '\n');
}
