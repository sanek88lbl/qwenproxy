import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';

process.env.BROWSER_IDLE_HIBERNATE_MS = '0';
process.env.ADMIN_PASSWORD = 'readiness-fixture-password';
const cwd = process.cwd(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-readiness-')); process.chdir(dir);
const { app } = await import('../../api/server.js');
const { addAccount } = await import('../../core/accounts.js');
const { closeDatabase } = await import('../../core/database.js');
const manager = await import('../../services/browser-manager.js');
const { markAccountReady } = await import('../../core/account-manager.js');
after(() => { closeDatabase(); process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); });

test('sleeping accounts are distinguished from warming accounts by both administrative endpoints', async () => {
  const account = addAccount('sleep-status@example.invalid', 'fixture-password', 'sleep-status-fixture');
  let closed = false;
  const context = { cookies: async () => [], close: async () => { closed = true; } } as unknown as BrowserContext;
  const page = { context: () => context, isClosed: () => closed } as unknown as Page;
  manager.accountContexts.set(account.id, context); manager.accountPages.set(account.id, page); manager.touchAccountActivity(account.id); markAccountReady(account.id);
  assert.equal(await manager.hibernateAccountContext(account.id), true);
  const login = await app.request('/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  for (const route of ['/admin/api/accounts', '/admin/api/overview']) {
    const response = await app.request(route, { headers: { cookie } });
    assert.equal(response.status, 200);
    const body = await response.json(); const entry = body.accounts.find((row: any) => row.id === account.id);
    assert.equal(entry.ready, false);
    assert.equal(entry.sleeping, true, 'intentional sleep must not masquerade as endless warming');
  }
});

test('the default configuration keeps accounts resident instead of sleeping after five minutes', async () => {
  const { spawnSync } = await import('node:child_process');
  const { createRequire } = await import('node:module');
  const tsx = createRequire(import.meta.url).resolve('tsx');
  const configUrl = new URL('../../core/config.ts', import.meta.url).href;
  const managerUrl = new URL('../../services/browser-manager.ts', import.meta.url).href;
  const accountUrl = new URL('../../core/account-manager.ts', import.meta.url).href;
  const env = { ...process.env }; delete env.BROWSER_IDLE_HIBERNATE_MS;
  const result = spawnSync(process.execPath, ['--import', tsx, '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const {config}=await import(${JSON.stringify(configUrl)});
    assert.equal(config.browser.idleHibernateMs,0);
    const manager=await import(${JSON.stringify(managerUrl)});
    const accounts=await import(${JSON.stringify(accountUrl)});
    const context={close:async()=>{throw new Error('default policy closed a resident context')}};
    manager.accountContexts.set('resident-fixture',context);
    manager.touchAccountActivity('resident-fixture');accounts.markAccountReady('resident-fixture');
    const now=Date.now;Date.now=()=>now()+360000;
    assert.equal(await manager.hibernateIdleAccountContexts(),0);
    assert.equal(manager.accountContexts.get('resident-fixture'),context);
    assert.equal(accounts.isAccountReady('resident-fixture'),true);
    Date.now=now;
  `], { cwd: dir, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? ''));
});
