import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { serve } from '@hono/node-server';

process.env.BROWSER_IDLE_HIBERNATE_MS = '0';
process.env.ADMIN_PASSWORD = 'readiness-ui-fixture';
const cwd = process.cwd(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-readiness-ui-')); process.chdir(dir);
const { app } = await import('../../api/server.js');
const { addAccount } = await import('../../core/accounts.js');
const { closeDatabase } = await import('../../core/database.js');
const { accountContexts, accountPages, touchAccountActivity, hibernateAccountContext } = await import('../../services/browser-manager.js');
const { markAccountReady } = await import('../../core/account-manager.js');
after(() => { closeDatabase(); process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); });

test('the built panel shows ready accounts and distinguishes sleep from warming', { timeout: 20000 }, async () => {
  const account = addAccount('readiness-ui@example.invalid', 'fixture-password', 'readiness-ui-fixture');
  let closed = false;
  const fakeContext = { cookies: async () => [], close: async () => { closed = true; } } as unknown as BrowserContext;
  const fakePage = { context: () => fakeContext, isClosed: () => closed } as unknown as Page;
  accountContexts.set(account.id, fakeContext); accountPages.set(account.id, fakePage); touchAccountActivity(account.id); markAccountReady(account.id);
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  try {
    const response = await context.request.post(origin + '/admin/api/login', { data: { password: process.env.ADMIN_PASSWORD } });
    assert.equal(response.status(), 200);
    await page.goto(origin + '/admin/accounts');
    const row = page.getByRole('row').filter({ hasText: account.email });
    await row.getByText('ready', { exact: true }).waitFor();
    assert.equal(await hibernateAccountContext(account.id), true);
    await page.reload();
    await row.getByText('sleeping', { exact: true }).waitFor();
    assert.equal(await row.getByText('warming up', { exact: true }).count(), 0);
    await page.goto(origin + '/admin/overview');
    await page.getByRole('row').filter({ hasText: account.email }).getByText('sleeping', { exact: true }).waitFor();
    await page.goto(origin + '/admin/accounts');
    assert.equal(await row.getByText('warming up', { exact: true }).count(), 0);
  } finally {
    await browser.close(); if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    accountContexts.delete(account.id); accountPages.delete(account.id);
  }
});
