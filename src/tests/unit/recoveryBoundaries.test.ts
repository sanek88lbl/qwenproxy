import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page, BrowserContext } from 'playwright';

const cwd = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-recovery-boundaries-'));
process.chdir(dir);
const { Metrics } = await import('../../core/metrics.js');
const { config } = await import('../../core/config.js');
const { getUiMutex, accountPages, accountContexts, getAccountHeaderCache } = await import('../../services/browser-manager.js');
const { getQwenHeaders } = await import('../../services/header-interceptor.js');
const { browserStreamFetch } = await import('../../services/stream-bridge.js');
const { closeDatabase } = await import('../../core/database.js');
after(() => { closeDatabase(); process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); });

test('histograms export cumulative buckets exactly once, including the infinite bucket', () => {
  const metrics = new Metrics();
  for (const value of [1, 7, 20000]) metrics.histogram('latency.request', value);
  const text = metrics.formatPrometheus();
  assert.match(text, /latency.request_bucket\{le="5"\} 1\n/);
  assert.match(text, /latency.request_bucket\{le="10"\} 2\n/);
  assert.match(text, /latency.request_bucket\{le="5000"\} 2\n/);
  assert.match(text, /latency.request_bucket\{le="\+Inf"\} 3\n/);
  assert.match(text, /latency.request_count 3\n/);
});

test('an aborted header waiter leaves the UI queue without replacing the current owner', { timeout: 1000 }, async () => {
  const id = 'aborted-header-waiter';
  const mutex = getUiMutex(id);
  const release = await mutex.acquire();
  const abort = new AbortController();
  const pending = (getQwenHeaders as (force: boolean, id: string, signal?: AbortSignal) => ReturnType<typeof getQwenHeaders>)(true, id, abort.signal);
  const outcome = pending.then(() => false, error => error.message === 'fixture cancelled');
  abort.abort(new Error('fixture cancelled'));
  try {
    assert.equal(await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('still waiting'), 50))]), true);
    assert.equal(mutex.isLocked(), true);
  } finally { release(); await outcome; }
});

test('header timeout settles despite a pending screenshot and preserves the account context', { timeout: 1000 }, async t => {
  const id = 'pending-screenshot';
  const oldTimeout = config.timeouts.headers;
  config.timeouts.headers = 20;
  let closes = 0;
  let screenshots = 0;
  let screenshotStarted!: () => void;
  const screenshotStart = new Promise<void>(resolve => { screenshotStarted = resolve; });
  const context = { close: async () => { closes++; }, clearCookies: async () => {}, clearPermissions: async () => {} } as unknown as BrowserContext;
  const page = {
    isClosed: () => true, context: () => context,
    url: () => 'https://chat.qwen.ai/c/new-chat', $: async () => null,
    locator: () => ({ count: async () => 0 }), route: async () => {}, unroute: async () => {},
    waitForSelector: () => new Promise(() => {}),
    screenshot: async () => { screenshots++; screenshotStarted(); await new Promise(() => {}); },
  } as unknown as Page;
  accountPages.set(id, page); accountContexts.set(id, context);
  getAccountHeaderCache(id);
  try {
    const capture = getQwenHeaders(true, id).then(() => 'success', error => error.message);
    const result = await Promise.race([capture, new Promise(resolve => setTimeout(() => resolve('hung'), 200))]);
    assert.match(String(result), /Timeout waiting for Qwen headers/);
    assert.equal(closes, 0);
    assert.equal(accountContexts.get(id), context);
    await Promise.race([screenshotStart, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Screenshot was not started')), 200))]);
    assert.equal(screenshots, 1);
  } finally { config.timeouts.headers = oldTimeout; accountPages.delete(id); accountContexts.delete(id); t.mock.restoreAll(); }
});

test('cancellation during relay installation settles before metadata and never sends a request', { timeout: 1000 }, async () => {
  let evaluated = 0;
  const page = { exposeFunction: () => new Promise(() => {}), evaluate: async () => { evaluated++; } } as unknown as Page;
  const abort = new AbortController();
  const result = browserStreamFetch(page, 'https://chat.qwen.ai/fixture', { signal: abort.signal, timeoutMs: 100 }).then(() => 'success', error => error.message);
  abort.abort(new Error('fixture cancelled'));
  assert.equal(await Promise.race([result, new Promise(resolve => setTimeout(() => resolve('hung'), 200))]), 'fixture cancelled');
  assert.equal(evaluated, 0);
});

test('provider retry hints remain distinct from fallback cooldowns', async () => {
  const { handleErrorBody, QwenUpstreamError } = await import('../../services/error-handler.js');
  const body = '{"success":false,"data":{"code":"RateLimited","details":"Retry later"}}';
  for (const [hint, expected] of [['120', 120000], ['invalid', undefined], [undefined, undefined]] as const) {
    assert.throws(() => handleErrorBody(body, 429, hint), error => error instanceof QwenUpstreamError && error.upstreamStatus === 429 && error.retryAfterMs === expected);
  }
});

test('a successful header interception cannot hang forever in route cleanup or mark unconfirmed headers ready', { timeout: 1000 }, async () => {
  const id = 'stalled-header-cleanup';
  const oldHttp = config.timeouts.http;
  config.timeouts.http = 20;
  let handlerTask: Promise<void> | undefined;
  const page = {
    isClosed: () => true, url: () => 'https://chat.qwen.ai/c/new-chat', $: async () => null,
    locator: () => ({ count: async () => 0 }), waitForSelector: () => new Promise(() => {}),
    route: async (_pattern: string, handler: any) => {
      handlerTask = handler({ continue: async () => {}, abort: () => new Promise(() => {}) }, {
        allHeaders: async () => ({ cookie: 'fixture', 'bx-ua': 'fixture-bx', 'bx-umidtoken': 'fixture-umid' }), postData: () => '{"chat_id":"fixture"}',
      });
    }, unroute: async () => {},
  } as unknown as Page;
  accountPages.set(id, page); const cache = getAccountHeaderCache(id);
  try {
    const result = getQwenHeaders(true, id).then(() => 'success', error => error.upstreamCode);
    assert.equal(await Promise.race([result, new Promise(resolve => setTimeout(() => resolve('hung'), 200))]), 'HeaderCaptureCleanupFailed');
    assert.equal(cache.cachedQwenHeaders, null);
    assert.equal(getUiMutex(id).isLocked(), false);
    await handlerTask;
  } finally { config.timeouts.http = oldHttp; accountPages.delete(id); }
});
