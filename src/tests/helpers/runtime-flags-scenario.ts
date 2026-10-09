import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';

const scenario = process.argv[2];
const cwd = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-runtime-flags-'));
process.chdir(directory);
Object.assign(process.env, { API_KEY: '', AUTH_REQUIRED: 'false', USER_API_KEYS: '', TEST_MOCK_PLAYWRIGHT: 'true', QWEN_DIRECT_FETCH: 'false',
  HYBRID_SESSION_VERIFY: 'false', AUTO_CONTINUE: 'false', WARM_POOL_SIZE: '0', SESSION_KEEPER_ENABLED: 'false', BROWSER_IDLE_HIBERNATE_MS: '0',
  QWEN_EMAIL: '', QWEN_PASSWORD: '', QWEN_GUEST_MODE_ONLY: scenario.startsWith('guest') ? 'true' : 'false' });
if (scenario === 'hybrid-default') delete process.env.HYBRID_SESSIONS_ENABLED;
else process.env.HYBRID_SESSIONS_ENABLED = 'false';
const { app } = await import('../../api/server.js');
const { addAccount } = await import('../../core/accounts.js');
const { closeDatabase } = await import('../../core/database.js');
const { setSession, resetAllSessions } = await import('../../services/session-manager.js');
const { createQwenStream } = await import('../../services/stream-creator.js');
const { applyRuntimeSetting } = await import('../../core/runtime-config.js');
const { setGuestHeadersCache } = await import('../../services/browser-manager.js');
const headers = { cookie: 'fixture', 'user-agent': 'fixture', 'bx-ua': 'fixture', 'bx-umidtoken': 'fixture', 'bx-v': 'fixture' };
setGuestHeadersCache({ headers, timestamp: Date.now() });
addAccount('flags@example.invalid', 'fixture-password', 'flags-account');
const nativeFetch = globalThis.fetch;
const payloads: any[] = [];
let guestChats = 0;
const answer = 'The controlled fixture response is complete.';
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  assert.equal(new URL(url).hostname, 'chat.qwen.ai');
  if (url.endsWith('/chats/new')) return Response.json({ success: true, data: { id: `guest-fixture-${++guestChats}` } });
  assert.ok(url.includes('/completions?'));
  payloads.push(JSON.parse(String(init?.body)));
  const id = `flags-response-${payloads.length}`;
  return new Response(`data: ${JSON.stringify({ 'response.created': { response_id: id } })}\n\n`
    + `data: ${JSON.stringify({ response_id: id, choices: [{ delta: { content: answer, phase: 'answer' }, finish_reason: 'stop' }] })}\n\n`
    + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function request(second = false) {
  const messages = second ? [{ role: 'user', content: 'First fixture question.' }, { role: 'assistant', content: answer }, { role: 'user', content: 'Second fixture question.' }]
    : [{ role: 'user', content: 'First fixture question.' }];
  const response = await nativeFetch(origin + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3.7-plus', user: 'flags-session', stream: false, reasoning_effort: 'none', messages }) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).choices[0].message.content, answer);
}
try {
  if (scenario === 'hybrid-default' || scenario === 'hybrid-disabled') {
    await request(); await request(true);
    assert.equal(payloads.length, 2);
    if (scenario === 'hybrid-default') {
      assert.equal(payloads[1].chat_id, payloads[0].chat_id);
      assert.ok(!payloads[1].messages[0].content.includes('First fixture question.'));
    } else {
      assert.notEqual(payloads[1].chat_id, payloads[0].chat_id);
      assert.equal(payloads[1].parent_id, null);
      assert.ok(payloads[1].messages[0].content.includes('First fixture question.'));
    }
  } else if (scenario === 'creator-disabled') {
    setSession('flags-direct', { chatId: 'pinned-flags-chat', accountId: 'flags-account', headers, parentId: 'old-parent', historyComplete: true, updatedAt: Date.now() });
    const result = await createQwenStream('FULL_BOOTSTRAP_SENTINEL', false, 'qwen3.7-plus', null, 'flags-account', undefined, undefined,
      { sessionKey: 'flags-direct', economicalPrompt: 'User: economical data that must not be used' });
    await new Response(result.stream).text();
    assert.notEqual(payloads[0].chat_id, 'pinned-flags-chat');
    assert.ok(payloads[0].messages[0].content.includes('FULL_BOOTSTRAP_SENTINEL'));
  } else if (scenario === 'explicit-continuation') {
    const result = await createQwenStream('Continue the current response.', false, 'qwen3.7-plus', 'explicit-parent', 'flags-account', undefined, undefined,
      { chatId: 'explicit-current-chat', chatHeaders: headers, forceBootstrap: false });
    await new Response(result.stream).text();
    assert.equal(payloads[0].chat_id, 'explicit-current-chat');
    assert.equal(payloads[0].parent_id, 'explicit-parent');
  } else if (scenario === 'guest-env') {
    await request();
    assert.equal(payloads[0].chat_mode, 'guest');
    assert.equal(guestChats, 1);
  } else if (scenario === 'guest-runtime') {
    await request(); assert.equal(payloads.at(-1).chat_mode, 'guest');
    applyRuntimeSetting('QWEN_GUEST_MODE_ONLY', 'false');
    resetAllSessions(); await request(); assert.equal(payloads.at(-1).chat_mode, 'normal');
    applyRuntimeSetting('QWEN_GUEST_MODE_ONLY', null);
    resetAllSessions(); await request(); assert.equal(payloads.at(-1).chat_mode, 'guest');
  }
  console.log(JSON.stringify({ scenario, status: 'pass', posts: payloads.length, guest_chats: guestChats }));
} finally {
  globalThis.fetch = nativeFetch;
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  closeDatabase(); process.chdir(cwd); fs.rmSync(directory, { recursive: true, force: true });
}
