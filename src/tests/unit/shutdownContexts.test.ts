import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext, Page } from 'playwright';
import { accountContexts, accountPages, closePlaywrightForAccount } from '../../services/browser-manager.js';

for (const connected of [false, true]) {
  test(`closing a context whose browser is ${connected ? 'still connected' : 'already disconnected'} preserves honest teardown state`, async () => {
    const id = `shutdown-context-${connected}`;
    const context = { browser: () => ({ isConnected: () => connected }), cookies: async () => [], close: async () => { throw new Error('Target page, context or browser has been closed'); } } as unknown as BrowserContext;
    accountContexts.set(id, context); accountPages.set(id, { context: () => context } as Page);
    try {
      if (connected) {
        await assert.rejects(closePlaywrightForAccount(id), /has been closed/);
        assert.equal(accountContexts.get(id), context);
      } else {
        await closePlaywrightForAccount(id);
        assert.equal(accountContexts.has(id), false);
        assert.equal(accountPages.has(id), false);
      }
    } finally { accountContexts.delete(id); accountPages.delete(id); }
  });
}

test('delayed context shutdown cannot unregister a newer replacement context', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const old = { cookies: async () => [], close: () => gate } as unknown as BrowserContext;
  const replacement = {} as BrowserContext;
  const page = {} as Page;
  const id = 'shutdown-context-replacement';
  accountContexts.set(id, old); accountPages.set(id, { context: () => old } as Page);
  const closing = closePlaywrightForAccount(id);
  await new Promise(resolve => setTimeout(resolve, 0));
  accountContexts.set(id, replacement); accountPages.set(id, page);
  release();
  try { await closing; assert.equal(accountContexts.get(id), replacement); assert.equal(accountPages.get(id), page); }
  finally { accountContexts.delete(id); accountPages.delete(id); }
});
