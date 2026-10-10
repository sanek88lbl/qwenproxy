import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';

process.env.BROWSER_IDLE_HIBERNATE_MS = '0';
const cwd = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-hibernation-'));
process.chdir(directory);
const manager = await import('../../services/browser-manager.js');
const accounts = await import('../../core/account-manager.js');
const { registerStream, removeStream } = await import('../../core/stream-registry.js');
const { closeDatabase } = await import('../../core/database.js');
after(() => { closeDatabase(); process.chdir(cwd); fs.rmSync(directory, { recursive: true, force: true }); });
let sequence = 0;
function fixture(cookies: () => Promise<any[]> = async () => []) {
  const id = 'hibernate-fixture-' + ++sequence;
  let closes = 0;
  let closed = false;
  const context = { cookies, close: async () => { closes++; closed = true; } } as unknown as BrowserContext;
  const page = { context: () => context, isClosed: () => closed } as unknown as Page;
  manager.accountContexts.set(id, context); manager.accountPages.set(id, page); manager.touchAccountActivity(id); accounts.markAccountReady(id);
  return { id, context, page, closes: () => closes, cleanup: () => { manager.accountContexts.delete(id); manager.accountPages.delete(id); accounts.markAccountNotReady(id); } };
}

test('hibernation skips active account slots, including a different lane of the same account', async () => {
  const item = fixture(); const slot = accounts.markAccountStreamStart(item.id + '::lane-2');
  try { assert.equal(await manager.hibernateAccountContext(item.id), false); assert.equal(item.closes(), 0); assert.equal(accounts.isAccountReady(item.id), true); }
  finally { accounts.markAccountStreamEnd(item.id, slot); item.cleanup(); }
});

test('hibernation skips an account selected for setup and a locked header capture', async () => {
  const item = fixture(); accounts.markAccountInUse(item.id);
  try {
    assert.equal(await manager.hibernateAccountContext(item.id), false);
    accounts.releaseAccountInUse(item.id);
    const release = await manager.getUiMutex(item.id).acquire();
    try { assert.equal(await manager.hibernateAccountContext(item.id), false); assert.equal(item.closes(), 0); }
    finally { release(); }
  } finally { accounts.releaseAccountInUse(item.id); item.cleanup(); }
});

test('hibernation rechecks ownership after awaiting cookie or storage reads', async () => {
  let resolve!: (value: any[]) => void;
  const cookies = new Promise<any[]>(done => { resolve = done; }); const item = fixture(() => cookies);
  const pending = manager.hibernateAccountContext(item.id); const slot = accounts.markAccountStreamStart(item.id);
  resolve([]);
  try { assert.equal(await pending, false); assert.equal(item.closes(), 0); }
  finally { accounts.markAccountStreamEnd(item.id, slot); item.cleanup(); }
});

test('hibernation preserves an unconfirmed registered transport even without a visible account slot', async () => {
  const item = fixture(); registerStream('hibernate-registry', { accountId: item.id, uiSessionId: 'fixture', headers: {}, stopToken: 'fixture', targetResponseId: '', abortController: new AbortController() });
  try { assert.equal(await manager.hibernateAccountContext(item.id), false); assert.equal(item.closes(), 0); }
  finally { await removeStream('hibernate-registry'); item.cleanup(); }
});

test('successful hibernation clears readiness and cannot remove a replacement context', async () => {
  const item = fixture(); let resolve!: () => void;
  const closing = new Promise<void>(done => { resolve = done; }); const original = item.context.close;
  item.context.close = async () => { await closing; await original(); };
  const pending = manager.hibernateAccountContext(item.id);
  await new Promise(done => setImmediate(done));
  const replacement = {} as BrowserContext;
  manager.accountContexts.set(item.id, replacement);
  resolve();
  try { assert.equal(await pending, true); assert.equal(manager.accountContexts.get(item.id), replacement); assert.equal(accounts.isAccountReady(item.id), false); }
  finally { item.cleanup(); }
});

test('a failed context close is not reported as successful hibernation', async () => {
  const item = fixture(); item.context.close = async () => { throw new Error('fixture close failed'); };
  try { assert.equal(await manager.hibernateAccountContext(item.id), false); assert.equal(manager.accountContexts.get(item.id), item.context); }
  finally { item.cleanup(); }
});


test('new activity during storage inspection cancels hibernation', async () => {
  let resolve!: (value: any[]) => void;
  const pendingCookies = new Promise<any[]>(done => { resolve = done; }); const item = fixture(() => pendingCookies);
  const pending = manager.hibernateAccountContext(item.id);
  const nativeNow = Date.now;
  Date.now = () => nativeNow() + 1;
  try { manager.touchAccountActivity(item.id); resolve([]); assert.equal(await pending, false); assert.equal(item.closes(), 0); }
  finally { Date.now = nativeNow; item.cleanup(); }
});

test('intentional idle hibernation is not immediately undone by background recovery', async () => {
  const { addAccount, loadAccounts } = await import('../../core/accounts.js');
  const { recoverUnreadyAccounts } = await import('../../services/session-keeper.js');
  const item = fixture(); addAccount('hibernate-recovery@example.invalid', 'fixture-password', item.id);
  for (const account of loadAccounts()) accounts.markAccountReady(account.id);
  try {
    assert.equal(await manager.hibernateAccountContext(item.id), true);
    let preparations = 0;
    await recoverUnreadyAccounts(async () => { preparations++; });
    assert.equal(preparations, 0, 'sleeping accounts must wait for an actual request or explicit refresh');
  } finally { item.cleanup(); }
});
