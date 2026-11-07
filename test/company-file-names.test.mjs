// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Two companies written in a non-Latin script never share a brief file, so one company's research can't stand in
// for another's; accented Latin names keep the plain file name they always had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyBriefPath } from '../skills/attendee-research/scripts/companies.mjs';
import { fileSlug } from '../lib/normalize.mjs';

test('companies in Japanese script get their own brief files; Latin names are unchanged', () => {
  const a = companyBriefPath('/x', '桜木ロボティクス株式会社'), b = companyBriefPath('/x', '日向オートメーション'), c = companyBriefPath('/x', '東雲ロボット工業');
  assert.equal(new Set([a, b, c]).size, 3, `${a} ${b} ${c}`);
  assert.equal(companyBriefPath('/x', '桜木ロボティクス株式会社'), a, 'the same name gives the same file every time');
  assert.equal(companyBriefPath('/x', 'Acme Ltd'), '/x/companies/acme.md');
  assert.equal(fileSlug('Müller Logistik'), 'muller-logistik');
  assert.notEqual(fileSlug('Яндекс'), fileSlug('Сбербанк'));
});
