import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('../helpers/runtime-flags-scenario.ts', import.meta.url));
for (const scenario of ['hybrid-default', 'hybrid-disabled', 'creator-disabled', 'explicit-continuation', 'guest-env', 'guest-runtime']) {
  test(`effective runtime flags: ${scenario}`, { timeout: 15000 }, () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fixture, scenario], { encoding: 'utf8', timeout: 12000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
