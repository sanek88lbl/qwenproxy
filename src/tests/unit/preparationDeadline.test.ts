import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.HYBRID_SESSION_VERIFY = 'false';
process.env.WARM_POOL_SIZE = '0';
process.env.AUTO_CONTINUE = 'false';
process.env.STREAM_DEGENERATE_GUARD = 'off';
const cwd = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-preparation-deadline-'));
process.chdir(dir);
const { app } = await import('../../api/server.js');
const { config } = await import('../../core/config.js');
const { addAccount } = await import('../../core/accounts.js');
const { getAccountActiveLoad } = await import('../../core/account-manager.js');
const { getStreamRegistry, getRequestPreparationStats } = await import('../../core/stream-registry.js');
const { closeDatabase } = await import('../../core/database.js');
const account = addAccount('preparation@example.test', 'fixture-password');
after(() => { closeDatabase(); process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); });

for (const disconnect of [false, true]) {
test(`a real HTTP ${disconnect ? 'disconnect' : 'deadline'} before upstream metadata frees the session for the next turn`, { timeout: 6000 }, async t => {
  const original = (config.timeouts as any).preparation;
  (config.timeouts as any).preparation = 250;
  const nativeFetch = globalThis.fetch;
  let stalled = true;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const upstreamStarted = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async (url: any, init: any) => {
    if (String(url).startsWith('http://127.0.0.1:')) return nativeFetch(url, init);
    calls++;
    started();
    if (stalled) await Promise.race([gate, new Promise((_resolve, reject) => {
      const abort = () => reject(init.signal.reason);
      init.signal.addEventListener('abort', abort, { once: true });
      if (init.signal.aborted) abort();
    })]);
    return new Response('data: {"response.created":{"response_id":"fixture-parent"}}\n\ndata: {"response_id":"fixture-parent","choices":[{"delta":{"content":"Recovered.","phase":"answer"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
  const send = (signal?: AbortSignal) => nativeFetch(url, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3.8-max', user: 'preparation-session', messages: [{ role: 'user', content: 'Fixture' }] }) });
  try {
    const abort = new AbortController();
    const pending = send(abort.signal);
    await upstreamStarted;
    if (disconnect) {
      abort.abort();
      await assert.rejects(pending);
      const deadline = Date.now() + 1000;
      while (getRequestPreparationStats().active && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    } else {
      const first = await Promise.race([pending, new Promise<undefined>(resolve => setTimeout(resolve, 1500))]);
      assert.ok(first, 'preparation must not wait indefinitely for response metadata');
      assert.equal(first.status, 504);
      assert.equal((await first.json() as any).error.code, 'RequestPreparationTimeout');
    }
    assert.equal(getAccountActiveLoad(account.id), 0);
    assert.equal(getStreamRegistry().size, 0);
    assert.equal(getRequestPreparationStats().active, 0);
    stalled = false;
    const second = await send();
    assert.equal(second.status, 200);
    assert.equal((await second.json() as any).choices[0].message.content, 'Recovered.');
    assert.equal(calls, 2);
  } finally {
    release();
    (config.timeouts as any).preparation = original;
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
}

test('a preparation deadline does not cancel an established stream during continued reasoning', { timeout: 6000 }, async t => {
  const original = config.timeouts.preparation;
  config.timeouts.preparation = 100;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let upstreamSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    upstreamSignal = init.signal;
    return new Response(new ReadableStream({ async start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('data: {"response.created":{"response_id":"reasoning-parent"}}\n\ndata: {"response_id":"reasoning-parent","choices":[{"delta":{"content":"The fixture is reasoning through the supplied problem without reaching its final answer yet.","phase":"think"}}]}\n\n'));
      await gate;
      controller.enqueue(encoder.encode('data: {"response_id":"reasoning-parent","choices":[{"delta":{"content":"Finished reasoning.","phase":"answer"}}]}\n\ndata: [DONE]\n\n'));controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', stream: true, user: 'long-reasoning-fixture', messages: [{ role: 'user', content: 'Reason before answering.' }] }) }));
    const body = response.text();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(upstreamSignal?.aborted, false);
    assert.equal(getRequestPreparationStats().active, 0);
    release();
    const text = await body;
    assert.match(text, /Finished reasoning/);
    assert.equal(text.split('data: [DONE]').length - 1, 1);
  } finally { release(); config.timeouts.preparation = original; }
});
