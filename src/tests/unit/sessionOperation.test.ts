import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.HYBRID_SESSION_VERIFY = 'false';
process.env.WARM_POOL_SIZE = '0';
process.env.AUTO_CONTINUE = 'false';
process.env.BROWSER_IDLE_HIBERNATE_MS = '0';
process.env.STREAM_DEGENERATE_GUARD = 'off';
const previousCwd = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-operation-'));
process.chdir(directory);
const { app } = await import('../../api/server.js');
const { addAccount } = await import('../../core/accounts.js');
const { closeDatabase } = await import('../../core/database.js');
const { resetAllSessions } = await import('../../services/session-manager.js');
addAccount('operation@example.invalid', 'fixture-password');
after(() => { closeDatabase(); process.chdir(previousCwd); fs.rmSync(directory, { recursive: true, force: true }); });

async function scenario(different: boolean, cancelWaiting = false, streaming = false) {
  resetAllSessions();
  const calls: any[] = [];
  const nativeFetch = globalThis.fetch;
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  globalThis.fetch = async (_url, init) => {
    const index = calls.push(JSON.parse(String(init?.body)));
    return new Response(new ReadableStream({ async start(controller) {
      if (index === 1) await gate;
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ 'response.created': { response_id: `parent-${index}` } })}\n\ndata: ${JSON.stringify({ response_id: `parent-${index}`, choices: [{ delta: { content: 'Completed fixture answer.', phase: 'answer' } }] })}\n\ndata: [DONE]\n\n`));
      controller.close();
    } }));
  };
  const send = async (key: string, signal?: AbortSignal) => { const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
    method: 'POST', signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3.7-plus', stream: streaming, user: key, messages: [{ role: 'user', content: 'Previous question.' }, { role: 'assistant', content: 'Completed fixture answer.' }, { role: 'user', content: 'Follow up.' }] }),
  })); await response.text(); return response; };
  try {
    process.env.TEST_SESSION_ID = 'operation-first';
    const first = send('same');
    for (let i = 0; i < 100 && !calls.length; i++) await sleep(5);
    assert.equal(calls.length, 1);
    process.env.TEST_SESSION_ID = 'operation-second';
    const controller = new AbortController();
    const second = send(different ? 'other' : 'same', controller.signal);
    await sleep(70);
    assert.equal(calls.length, different ? 2 : 1, 'one session must wait before selecting a chat or parent');
    if (cancelWaiting) controller.abort(new Error('fixture disconnect'));
    unblock();
    const responses = await Promise.all([first, second]);
    assert.equal(responses[0].status, 200);
    if (cancelWaiting) assert.notEqual(responses[1].status, 200);
    else {
      assert.equal(responses[1].status, 200);
      if (!different) {
        assert.equal(calls[1].chat_id, calls[0].chat_id);
        assert.equal(calls[1].parent_id, 'parent-1');
      }
    }
    if (cancelWaiting) {
      assert.equal(calls.length, 1);
      const third = await send('same');
      assert.equal(third.status, 200);
      assert.equal(calls.length, 2);
    }
  } finally { unblock(); globalThis.fetch = nativeFetch; }
}
test('concurrent requests to one session wait and observe the confirmed parent', () => scenario(false));
test('independent sessions can send while another session is waiting for a response', () => scenario(true));
test('disconnect removes a queued request without sending or stranding the session', () => scenario(false, true));

test('SSE requests hold the same session until response confirmation and cleanup', () => scenario(false, false, true));
