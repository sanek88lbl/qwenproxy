import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

process.env.QWEN_DIRECT_FETCH = 'false';
process.env.BROWSER_IDLE_HIBERNATE_MS = '0';
const cwd = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-recovery-browser-'));
process.chdir(directory);
const { createQwenStream } = await import('../../services/stream-creator.js');
const { accountPages, accountContexts } = await import('../../services/browser-manager.js');
const { getAccountActiveLoad } = await import('../../core/account-manager.js');
const { closeDatabase } = await import('../../core/database.js');
after(() => { closeDatabase(); process.chdir(cwd); fs.rmSync(directory, { recursive: true, force: true }); });
const headers = { cookie: 'fixture-cookie', 'user-agent': 'fixture-agent', 'bx-ua': 'fixture-bx', 'bx-umidtoken': 'fixture-umid', 'bx-v': 'fixture-version' };

for (const localFailure of [false, true]) {
test(`TMD recovery ${localFailure ? 'preserves a local error as HTTP 502' : 'uses the replacement context'} and preserves another account`, { timeout: 25000 }, async t => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const old = await browser.newContext();
  const replacement = await browser.newContext();
  const adjacent = await browser.newContext();
  let posts = 0;
  for (const context of [old, replacement, adjacent]) {
    await context.route('**/*', route => {
      const request = route.request();
      if (request.method() === 'POST' && request.url().includes('/api/v2/chat/completions')) {
        posts++;
        return route.fulfill(posts === 1
          ? { contentType: 'application/json', body: '{"ret":["FAIL_SYS_USER_VALIDATE"]}' }
          : { contentType: 'text/event-stream', body: 'data: recovered\n\n' });
      }
      return route.fulfill({ contentType: 'text/html', body: '<html>fixture</html>' });
    });
  }
  const base = await old.newPage();
  const newBase = await replacement.newPage();
  const neighbor = await adjacent.newPage();
  await base.goto('https://chat.qwen.ai/c/new-chat');
  await newBase.goto('https://chat.qwen.ai/c/new-chat');
  await neighbor.goto('https://chat.qwen.ai/');
  accountPages.set('recovery-browser', base); accountContexts.set('recovery-browser', old);
  t.mock.method(base, 'unroute', async () => {
    if (localFailure) return;
    accountPages.set('recovery-browser', newBase); accountContexts.set('recovery-browser', replacement);
    await old.close();
  });
  t.mock.method(base, 'route', async (_pattern: any, handler: any) => {
    await handler({ abort: async () => {}, continue: async () => {} }, { allHeaders: async () => { if (localFailure) throw new Error('Fixture header transport failed'); return headers; }, postData: () => '{"chat_id":"headers-fixture"}' });
  });
  try {
    const pending = createQwenStream('fixture', false, 'qwen3.8-max', null, 'recovery-browser', undefined, undefined,
      { chatId: 'recovery-chat', chatHeaders: headers });
    if (localFailure) {
      await assert.rejects(pending, (error: any) => error.upstreamStatus === 502 && error.upstreamCode === 'BrowserRecoveryFailed');
      assert.equal(posts, 1);
    } else {
      const result = await pending;
      const reader = result.stream.getReader();
      let body = '';
      while (true) { const next = await reader.read(); if (next.done) break; body += new TextDecoder().decode(next.value); }
      assert.match(body, /recovered/);
      assert.equal(posts, 2);
    }
    assert.equal(neighbor.isClosed(), false);
    assert.equal(await neighbor.locator('body').innerText(), 'fixture');
    assert.equal(getAccountActiveLoad('recovery-browser'), 0);
  } finally {
    accountPages.delete('recovery-browser'); accountContexts.delete('recovery-browser');
    await browser.close();
  }
});
}
