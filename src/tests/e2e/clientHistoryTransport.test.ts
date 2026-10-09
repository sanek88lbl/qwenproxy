import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { serve } from '@hono/node-server';

const cwd = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-history-transport-'));
process.chdir(dir);
delete process.env.TEST_MOCK_PLAYWRIGHT;
process.env.WARM_POOL_SIZE = '0';
process.env.HYBRID_SESSION_VERIFY = 'false';
process.env.BROWSER_IDLE_HIBERNATE_MS = '0';
process.env.AUTO_CONTINUE = 'false';
process.env.STREAM_DEGENERATE_GUARD = 'off';
const { app } = await import('../../api/server.js');
const { config } = await import('../../core/config.js');
const { addAccount } = await import('../../core/accounts.js');
const { closeDatabase } = await import('../../core/database.js');
const { accountPages, getAccountHeaderCache } = await import('../../services/browser-manager.js');
const { resetAllSessions } = await import('../../services/session-manager.js');
addAccount('transport-history@example.invalid', 'fixture', 'history-account');
after(() => { closeDatabase(); process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); });

test('native HTTP and actual browser transports reconcile the same confirmed client history', { timeout: 30000 }, async () => {
  let chats = 0;
  const calls: any[] = [];
  const provider = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    let body = '';
    req.on('data', data => { body += data; });
    req.on('end', () => {
      if (req.url?.includes('/chats/new')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, data: { id: `native-chat-${++chats}` } })); return; }
      if (!req.url?.includes('/completions')) { res.end('{}'); return; }
      calls.push(JSON.parse(body));
      res.setHeader('Content-Type', 'text/event-stream');
      const id = `native-parent-${calls.length}`;
      res.end(`data: ${JSON.stringify({ 'response.created': { response_id: id } })}\n\ndata: ${JSON.stringify({ response_id: id, choices: [{ delta: { content: 'Native fixture answer.', phase: 'answer' } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  await context.grantPermissions(['local-network-access'], { origin: 'https://chat.qwen.ai' });
  await context.addCookies([{ name: 'token', value: 'fixture', domain: 'chat.qwen.ai', path: '/' }]);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.pathname === '/' || url.pathname === '/c/new-chat') return route.fulfill({ contentType: 'text/html', body: '<html>fixture</html>' });
    return route.abort();
  });
  await context.addInitScript(`const native = window.fetch.bind(window); window.fetch = (input, init) => native(String(input).startsWith('https://chat.qwen.ai/api/') ? ${JSON.stringify(origin)} + new URL(String(input)).pathname : input, init);`);
  const page = await context.newPage();
  await page.goto('https://chat.qwen.ai/');
  accountPages.set('history-account', page);
  getAccountHeaderCache('history-account').currentHeaders = { cookie: 'token=fixture', 'bx-v': 'fixture', 'bx-ua': 'fixture', 'bx-umidtoken': 'fixture' };
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'chat.qwen.ai') return nativeFetch(origin + url.pathname + url.search, init);
    if (url.hostname !== '127.0.0.1') throw new Error('Unexpected external fixture request');
    return nativeFetch(input, init);
  };
  const proxy = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!proxy.listening) await new Promise<void>(resolve => proxy.once('listening', resolve));
  const proxyOrigin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  try {
    for (const direct of [true, false]) {
      config.directFetch.enabled = direct;
      resetAllSessions();
      calls.length = 0;
      const send = async (messages: any[], stream = false) => {
        const response = await nativeFetch(proxyOrigin + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'qwen3.7-plus', user: 'transport-fixture', messages, stream }) });
        const text = await response.text();
        assert.equal(response.status, 200, text);
        assert.ok(text.includes('Native fixture answer.'));
      };
      await send([{ role: 'user', content: 'Original question.' }], true);
      const history = [{ role: 'user', content: 'Original question.' }, { role: 'assistant', content: 'Native fixture answer.' }, { role: 'user', content: 'Follow up.' }];
      await send(history);
      assert.equal(calls[1].chat_id, calls[0].chat_id);
      assert.equal(calls[1].parent_id, 'native-parent-1');
      assert.equal(calls[1].messages[0].content, 'User: Follow up.');
      history[0].content = 'NATIVE_EDIT_SENTINEL';
      await send(history);
      assert.notEqual(calls[2].chat_id, calls[0].chat_id);
      assert.equal(calls[2].parent_id, null);
      assert.ok(calls[2].messages[0].content.includes('NATIVE_EDIT_SENTINEL'));
    }
  } finally {
    globalThis.fetch = nativeFetch;
    await browser.close();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
});
