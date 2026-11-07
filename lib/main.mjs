// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Whether a module is the script Node was started with. Compared by real path: through a symlink (a plugin
// cache entry linked to its source) or a path Node encodes in a URL (a space), comparing import.meta.url with
// argv[1] as strings fails, and a hook would then exit having checked nothing.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(url) {
  const started = process.argv[1];
  if (!started) return false;
  const self = fileURLToPath(url);
  try {
    return realpathSync(self) === realpathSync(started);
  } catch {
    return self === started;
  }
}
