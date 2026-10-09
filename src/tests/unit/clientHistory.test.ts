import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.HYBRID_SESSION_VERIFY = 'false';
process.env.BROWSER_IDLE_HIBERNATE_MS = '0';
process.env.WARM_POOL_SIZE = '0';
process.env.AUTO_CONTINUE = 'false';
process.env.STREAM_DEGENERATE_GUARD = 'off';
const cwd = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-history-'));
process.chdir(dir);
const { app } = await import('../../api/server.js');
const { addAccount } = await import('../../core/accounts.js');
const { closeDatabase, listSessions } = await import('../../core/database.js');
const { resetAllSessions } = await import('../../services/session-manager.js');
const { config } = await import('../../core/config.js');
addAccount('history@example.invalid', 'fixture-password');
after(() => { closeDatabase(); process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); });

async function scenario(change: string, stream = false, verify = false) {
  resetAllSessions();
  config.hybridSessions.verify = verify;
  const nativeFetch = globalThis.fetch;
  const calls: any[] = [];
  globalThis.fetch = async (_url, init) => {
    if (!init?.body) return Response.json({ success: true, data: { chat: { messages: [{ id: 'parent-1', role: 'assistant', content: 'Confirmed answer.' }] } } });
    const index = calls.push(JSON.parse(String(init.body)));
    return new Response(`data: ${JSON.stringify({ 'response.created': { response_id: `parent-${index}` } })}\n\ndata: ${JSON.stringify({ response_id: `parent-${index}`, choices: [{ delta: { content: 'Confirmed answer.', phase: 'answer' } }] })}\n\ndata: [DONE]\n\n`);
  };
  const send = async (messages: any[], id: string) => {
    process.env.TEST_SESSION_ID = id;
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.7-plus', user: 'fixture', stream, messages: [{ role: 'system', content: 'Unchanged instructions.' }, ...messages] }) }));
    assert.equal(response.status, 200, await response.clone().text());
    await response.text();
  };
  try {
    await send([{ role: 'user', content: 'Original question.' }], 'history-old');
    const stored = listSessions()[0];
    let messages: any[] = [{ role: 'user', content: 'Original question.' }, { role: 'assistant', content: 'Confirmed answer.' }, { role: 'user', content: 'Follow up.' }];
    if (change === 'user') messages[0].content = 'EDITED_USER_SENTINEL';
    if (change === 'assistant') messages[1].content = 'EDITED_ASSISTANT_SENTINEL';
    if (change === 'delete') messages = messages.slice(1);
    if (change === 'reorder') messages = [messages[1], messages[0], messages[2]];
    if (change === 'legacy') {
      const { getSession, resolveOwnedSessionKey } = await import('../../services/session-manager.js');
      const entry = getSession(resolveOwnedSessionKey(JSON.stringify(['anonymous']), 'fixture'))!;
      entry.confirmedHistoryHash = undefined;
      entry.confirmedHistoryLength = 0;
    }
    await send(messages, 'history-new');
    const edited = change !== 'none';
    assert.equal(calls[1].chat_id, edited ? 'history-new' : 'history-old');
    assert.equal(calls[1].parent_id, edited ? null : 'parent-1');
    assert.equal(listSessions()[0].instructions_hash, stored.instructions_hash);
    if (change === 'user') assert.ok(calls[1].messages[0].content.includes('EDITED_USER_SENTINEL'));
    if (change === 'assistant') assert.ok(calls[1].messages[0].content.includes('EDITED_ASSISTANT_SENTINEL'));
    if (!edited) assert.equal(calls[1].messages[0].content, 'User: Follow up.');
  } finally { globalThis.fetch = nativeFetch; }
}
for (const change of ['none', 'user', 'assistant', 'delete', 'reorder', 'legacy']) {
  test(`JSON history reconciliation: ${change}`, () => scenario(change));
}
test('SSE reply establishes a reusable client prefix', () => scenario('none', true));
test('an edited client prefix bootstraps even when the remote parent still matches', () => scenario('user', false, true));

for (const streaming of [false, true]) {
  test(`confirmed tool calls are reused without replay; changed arguments bootstrap (${streaming ? 'SSE' : 'JSON'})`, async () => {
    resetAllSessions();
    config.hybridSessions.verify = false;
    const nativeFetch = globalThis.fetch;
    const calls: any[] = [];
    const { wrapToolCallPayload } = await import('../../tools/toolcall-tags.js');
    const tools = [{ type: 'function', function: { name: 'read', description: 'Read fixture', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
    globalThis.fetch = async (_url, init) => {
      const index = calls.push(JSON.parse(String(init?.body)));
      const text = index === 1 ? wrapToolCallPayload('{"name":"read","arguments":{"path":"ORIGINAL_ARGUMENT_SENTINEL"}}') : 'Confirmed answer.';
      return new Response(`data: ${JSON.stringify({ 'response.created': { response_id: `tool-parent-${index}` } })}\n\ndata: ${JSON.stringify({ response_id: `tool-parent-${index}`, choices: [{ delta: { content: text, phase: 'answer' } }] })}\n\ndata: [DONE]\n\n`);
    };
    const send = (messages: any[], stream: boolean) => app.fetch(new Request('http://localhost/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.7-plus', user: 'tool-fixture', stream, tools, messages }) }));
    try {
      process.env.TEST_SESSION_ID = 'tool-history-old';
      const initial = [{ role: 'user', content: 'Read the fixture.' }];
      const first = await send(initial, streaming);
      assert.equal(first.status, 200);
      let message: any;
      if (streaming) {
        message = { role: 'assistant', content: '', tool_calls: [] };
        for (const line of (await first.text()).split('\n')) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta;
          if (delta?.content) message.content += delta.content;
          if (delta?.tool_calls) message.tool_calls.push(...delta.tool_calls);
        }
      } else message = (await first.json()).choices[0].message;
      assert.equal(message.tool_calls.length, 1);
      const history = [...initial, message, { role: 'tool', tool_call_id: message.tool_calls[0].id, content: 'TOOL_RESULT_SENTINEL' }];
      process.env.TEST_SESSION_ID = 'tool-history-unused';
      assert.equal((await send(history, false)).status, 200);
      assert.equal(calls[1].chat_id, 'tool-history-old');
      assert.equal(calls[1].parent_id, 'tool-parent-1');
      assert.ok(calls[1].messages[0].content.includes('TOOL_RESULT_SENTINEL'));
      assert.ok(!calls[1].messages[0].content.includes('ORIGINAL_ARGUMENT_SENTINEL'));
      message.tool_calls[0].function.arguments = '{"path":"EDITED_ARGUMENT_SENTINEL"}';
      process.env.TEST_SESSION_ID = 'tool-history-new';
      assert.equal((await send(history, false)).status, 200);
      assert.equal(calls[2].chat_id, 'tool-history-new');
      assert.ok(calls[2].messages[0].content.includes('EDITED_ARGUMENT_SENTINEL'));
    } finally { globalThis.fetch = nativeFetch; }
  });
}

test('history normalization preserves media and argument bytes while ignoring service fields', async () => {
  const { historyFingerprint } = await import('../../services/client-history.js');
  const first: any[] = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/first.png' } }] }];
  const second = structuredClone(first);
  second[0].content[0].image_url.url = 'https://example.com/second.png';
  assert.notEqual(historyFingerprint(first), historyFingerprint(second));
  assert.equal(historyFingerprint([{ role: 'assistant', content: null }]), historyFingerprint([{ role: 'assistant', content: '', reasoning_content: 'service-only' } as any]));
  const tool = { role: 'assistant', content: '', tool_calls: [{ id: 'call', type: 'function', function: { name: 'read', arguments: '{"path": "a"}' } }] };
  const changed = structuredClone(tool);
  changed.tool_calls[0].function.arguments = '{"path":"a"}';
  assert.notEqual(historyFingerprint([tool]), historyFingerprint([changed]));
});

test('a durable invalidation failure prevents sending a new completion into the pinned chat', async () => {
  resetAllSessions();
  config.hybridSessions.verify = false;
  const { getDatabase } = await import('../../core/database.js');
  const nativeFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(`data: {"response.created":{"response_id":"durable-parent"}}\n\ndata: {"response_id":"durable-parent","choices":[{"delta":{"content":"Durable answer.","phase":"answer"}}]}\n\ndata: [DONE]\n\n`);
  };
  const send = (messages: any[]) => app.fetch(new Request('http://localhost/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3.7-plus', user: 'durable-fixture', messages }) }));
  try {
    assert.equal((await send([{ role: 'user', content: 'Initial durable question.' }])).status, 200);
    getDatabase().exec("CREATE TRIGGER block_invalidation BEFORE UPDATE ON sessions WHEN NEW.history_complete = 0 BEGIN SELECT RAISE(ABORT, 'fixture invalidation unavailable'); END;");
    const history = [{ role: 'user', content: 'Initial durable question.' }, { role: 'assistant', content: 'Durable answer.' }, { role: 'user', content: 'Next question.' }];
    const failed = await send(history);
    assert.equal(failed.status, 500);
    assert.equal(calls, 1, 'no completion may run before incomplete state is durable');
    getDatabase().exec('DROP TRIGGER block_invalidation');
    assert.equal((await send(history)).status, 200);
    assert.equal(calls, 2);
  } finally { getDatabase().exec('DROP TRIGGER IF EXISTS block_invalidation'); globalThis.fetch = nativeFetch; }
});

test('SSE reports a failed history commit before any successful terminal event', async () => {
  resetAllSessions();
  config.hybridSessions.verify = false;
  const { getDatabase } = await import('../../core/database.js');
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('data: {"response.created":{"response_id":"commit-parent"}}\n\ndata: {"response_id":"commit-parent","choices":[{"delta":{"content":"Confirmed fixture content.","phase":"answer"}}]}\n\ndata: [DONE]\n\n');
  const send = (stream: boolean) => app.fetch(new Request('http://localhost/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3.7-plus', user: 'commit-fixture', stream, messages: [{ role: 'user', content: 'A history commit fixture.' }] }) }));
  try {
    getDatabase().exec("CREATE TRIGGER block_confirmation BEFORE UPDATE ON sessions WHEN NEW.confirmed_history_hash IS NOT NULL AND NEW.history_complete = 1 BEGIN SELECT RAISE(ABORT, 'fixture confirmation unavailable'); END;");
    const response = await send(true);
    const body = await response.text();
    const events = body.split('\n\n').flatMap(event => event.startsWith('data: ') && event !== 'data: [DONE]' ? [JSON.parse(event.slice(6))] : []);
    assert.equal(events.filter(event => event.error?.code === 'SessionPersistenceFailed').length, 1);
    assert.equal(events.filter(event => event.choices?.some((choice: any) => choice.finish_reason === 'stop')).length, 0);
    assert.equal(body.split('data: [DONE]').length - 1, 1);
    assert.equal(listSessions()[0].history_complete, 0);
    assert.equal(listSessions()[0].confirmed_history_hash, null);
    getDatabase().exec('DROP TRIGGER block_confirmation');
    assert.equal((await send(false)).status, 200, 'the failed operation must release its session lease');
  } finally { getDatabase().exec('DROP TRIGGER IF EXISTS block_confirmation'); globalThis.fetch = nativeFetch; }
});
