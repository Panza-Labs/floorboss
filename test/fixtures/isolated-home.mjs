// Loaded before every test file (package.json: node --test --import). Each test process runs with HOME, the
// Claude config folder and floorboss's folders pointed at a fresh temp folder, so no test can read or write the
// real home (keys, ~/.claude, shell files), whatever a test forgets to set. A test that needs its own home still
// sets one.
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = mkdtempSync(join(tmpdir(), 'fb-test-home-'));
mkdirSync(join(h, 'scan-home'), { recursive: true });
Object.assign(process.env, {
  FLOORBOSS_ISOLATED_HOME: h, HOME: h, USERPROFILE: h, CLAUDE_CONFIG_DIR: join(h, '.claude'), FLOORBOSS_TEST: '1', FLOORBOSS_OUT_OF_TURN: '1',
  FLOORBOSS_HOME: join(h, '.floorboss'), FLOORBOSS_SCAN_HOME: join(h, 'scan-home'), FLOORBOSS_SCAN_CWD: join(h, 'scan-home'),
});
