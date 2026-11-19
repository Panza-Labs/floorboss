// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Imported first by floorboss's own entry files that no model drives (hooks/guard.mjs, hooks/remind.mjs,
// scripts/scheduled.mjs, scripts/unattended.mjs), so they read settings as they always have (lib/harness.mjs,
// rule 2). Imported first, it runs before any other module of that file.
import { ownProcess } from './harness.mjs';

ownProcess();
