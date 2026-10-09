import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-browser-startup-'));
process.chdir(directory);
process.env.BROWSER_IDLE_HIBERNATE_MS = '0';
const { config } = await import('../../core/config.js');
const { getOrLaunchBrowser, closePlaywright } = await import('../../services/browser-manager.js');
for (const type of ['chromium', 'firefox', 'webkit'] as const) {
  test(`configured ${type} launches and relaunches the actual selected engine`, async () => {
    config.browser.type = type;
    try {
      const browser = await getOrLaunchBrowser();
      assert.equal(browser.browserType().name(), type);
      await browser.close();
      const relaunched = await getOrLaunchBrowser();
      assert.equal(relaunched.browserType().name(), type);
      assert.notEqual(relaunched, browser);
    } finally { await closePlaywright(); }
  });
}
process.once('exit', () => fs.rmSync(directory, { recursive: true, force: true }));
