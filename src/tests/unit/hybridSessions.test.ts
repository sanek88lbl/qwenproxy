import test, { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.HYBRID_SESSION_VERIFY = 'false';

delete process.env.API_KEY;
delete process.env.USER_API_KEYS;
delete process.env.AUTH_REQUIRED;
process.env.WARM_POOL_SIZE = '0';
process.env.BROWSER_IDLE_HIBERNATE_MS = '0';
const originalCwd = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-hybrid-')) ;
process.chdir(directory);

const { app } = await import('../../api/server.js');
const { resetAllSessions } = await import('../../services/session-manager.js');
const { addAccount } = await import('../../core/accounts.js');
const { closeDatabase } = await import('../../core/database.js');
addAccount('hybrid@example.invalid', 'fixture-password');
after(() => { closeDatabase(); process.chdir(originalCwd); fs.rmSync(directory, { recursive: true, force: true }); });

function setupFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (urlStr.includes('chat.qwen.ai')) {
      if (urlStr.includes('/api/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
      }
      return handler(urlStr, init);
    }
    return originalFetch(input);
  };
  return () => { globalThis.fetch = originalFetch; };
}

function sseResponse(responseIds: string[]): Response {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const rid of responseIds) {
    parts.push(enc.encode(`data: {"response.created":{"response_id":"${rid}"}}\n\n`));
  }
  parts.push(enc.encode('data: {"response_id":' + JSON.stringify(responseIds[0]) + ',"choices":[{"delta":{"content":"Resposta completa para o teste.","phase":"answer"}}],"usage":{"output_tokens":12}}\n\n'));
  parts.push(enc.encode('data: [DONE]\n\n'));
  let idx = 0;
  return new Response(new ReadableStream({
    start(c) { c.enqueue(parts[idx++]); },
    pull(c) {
      if (idx >= parts.length) { c.close(); return; }
      c.enqueue(parts[idx++]);
    }
  }), { status: 200 });
}

test('hybrid-session: turn 2 sends only the new suffix and threads the confirmed parent', async () => {
  resetAllSessions();
  const capturedPayloads: any[] = [];

  const restore = setupFetchMock((_url, init) => {
    capturedPayloads.push(JSON.parse(init?.body as string || '{}'));
    return sseResponse(capturedPayloads.length === 1 ? ['qwen-hyb-1'] : ['qwen-hyb-2']);
  });

  try {
    process.env.TEST_SESSION_ID = 'hybrid-econ-chat';

    const req1 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        user: 'conv-hybrid-1',
        messages: [{ role: 'user', content: 'Turn 1' }]
      })
    });
    const res1 = await app.fetch(req1);
    assert.strictEqual(res1.status, 200);
    const body1 = await res1.json() as any;
    assert.ok(body1.session_id, 'non-streaming response must expose session_id');

    const req2 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        user: 'conv-hybrid-1',
        messages: [
          { role: 'user', content: 'Turn 1' },
          { role: 'assistant', content: 'Resposta completa para o teste.' },
          { role: 'user', content: 'Turn 2' }
        ]
      })
    });
    const res2 = await app.fetch(req2);
    assert.strictEqual(res2.status, 200);
    await res2.text();

    assert.strictEqual(capturedPayloads.length, 2);
    assert.strictEqual(capturedPayloads[0].parent_id, null);
    assert.ok(capturedPayloads[0].messages[0].content.includes('Turn 1'), 'Turn 1 must send the full conversation');
    assert.strictEqual(capturedPayloads[1].parent_id, 'qwen-hyb-1', 'Turn 2 must thread on the previous response id');
    assert.ok(capturedPayloads[1].messages[0].content.includes('Turn 2'), 'Turn 2 must include the last user message');
    assert.ok(!capturedPayloads[1].messages[0].content.includes('Turn 1'), 'Turn 2 must NOT resend the full history');
    assert.ok(!capturedPayloads[1].messages[0].content.includes('Resposta completa para o teste.'), 'Turn 2 must NOT resend prior assistant replies');
  } finally {
    restore();
    delete process.env.TEST_SESSION_ID;
  }
});

test('hybrid-session: without a session key every turn bootstraps the full conversation in a new chat', async () => {
  resetAllSessions();
  const capturedPayloads: any[] = [];

  const restore = setupFetchMock((_url, init) => {
    capturedPayloads.push(JSON.parse(init?.body as string || '{}'));
    return sseResponse(capturedPayloads.length === 1 ? ['qwen-full-1'] : ['qwen-full-2']);
  });

  try {
    process.env.TEST_SESSION_ID = 'hybrid-full-chat';

    const req1 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.6-plus', messages: [{ role: 'user', content: 'A' }] })
    });
    const res1 = await app.fetch(req1);
    assert.strictEqual(res1.status, 200);
    await res1.text();

    process.env.TEST_SESSION_ID = 'hybrid-full-chat-new';
    const req2 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [
          { role: 'user', content: 'A' },
          { role: 'assistant', content: 'B' },
          { role: 'user', content: 'C' }
        ]
      })
    });
    const res2 = await app.fetch(req2);
    assert.strictEqual(res2.status, 200);
    await res2.text();

    assert.strictEqual(capturedPayloads.length, 2);
    assert.strictEqual(capturedPayloads[0].parent_id, null);
    assert.ok(capturedPayloads[1].messages[0].content.includes('A'), 'No session key means full history is always sent');
    assert.ok(capturedPayloads[1].messages[0].content.includes('C'));
    assert.strictEqual(capturedPayloads[1].parent_id, null, 'A fresh stateless chat has no previous parent');
  } finally {
    restore();
    delete process.env.TEST_SESSION_ID;
  }
});

test('hybrid-session: tools preserve economical mode with a confirmed prefix', async () => {
  resetAllSessions();
  const capturedPayloads: any[] = [];

  const restore = setupFetchMock((_url, init) => {
    capturedPayloads.push(JSON.parse(init?.body as string || '{}'));
    return sseResponse(capturedPayloads.length === 1 ? ['qwen-tool-1'] : ['qwen-tool-2']);
  });

  try {
    process.env.TEST_SESSION_ID = 'hybrid-tool-chat';
    const toolDef = { type: 'function', function: { name: 'read_file', description: 'reads a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } };

    const req1 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        user: 'conv-hybrid-tool',
        tools: [toolDef],
        messages: [{ role: 'user', content: 'T1' }]
      })
    });
    const res1 = await app.fetch(req1);
    assert.strictEqual(res1.status, 200);
    await res1.text();

    const req2 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        user: 'conv-hybrid-tool',
        tools: [toolDef],
        messages: [
          { role: 'user', content: 'T1' },
          { role: 'assistant', content: 'Resposta completa para o teste.' },
          { role: 'assistant', content: 'R1', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: 'file content' },
          { role: 'user', content: 'T2' }
        ]
      })
    });
    const res2 = await app.fetch(req2);
    assert.strictEqual(res2.status, 200);
    await res2.text();

    assert.strictEqual(capturedPayloads.length, 2);
    assert.strictEqual(capturedPayloads[1].parent_id, 'qwen-tool-1', 'must thread onto the previous response');
    const content = capturedPayloads[1].messages[0].content;
    assert.ok(!content.includes('T1'), 'tool loops now economize: pre-cycle history stays server-side');
    assert.ok(content.includes('Tool Response (read_file):') && content.includes('file content') && content.includes('call_1'), 'tool responses preserved as a compact summary');
    assert.ok(content.includes('User: T2'), 'final user message must be included');
  } finally {
    restore();
    delete process.env.TEST_SESSION_ID;
  }
});

test('hybrid-session: a new tool cycle preserves confirmed history without the tools parameter', async () => {
  resetAllSessions();
  const capturedPayloads: any[] = [];

  const restore = setupFetchMock((_url, init) => {
    capturedPayloads.push(JSON.parse(init?.body as string || '{}'));
    return sseResponse(capturedPayloads.length === 1 ? ['noparam-tool-1'] : ['noparam-tool-2']);
  });

  try {
    process.env.TEST_SESSION_ID = 'hybrid-noparam-tool-chat';

    const r1 = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.6-plus', user: 'conv-np-tool', messages: [{ role: 'user', content: 'T0' }] })
    }));
    assert.strictEqual(r1.status, 200);
    await r1.text();

    const r2 = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        user: 'conv-np-tool',
        messages: [
          { role: 'user', content: 'T0' },
          { role: 'assistant', content: 'Resposta completa para o teste.' },
          { role: 'user', content: 'T1' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } }] },
          { role: 'tool', tool_call_id: 'call_9', name: 'read_file', content: 'file x' },
          { role: 'user', content: 'T2' }
        ]
      })
    }));
    assert.strictEqual(r2.status, 200);
    await r2.text();

    assert.strictEqual(capturedPayloads.length, 2);
    assert.strictEqual(capturedPayloads[1].parent_id, 'noparam-tool-1', 'must thread onto the previous response');
    const second = capturedPayloads[1].messages[0].content;
    assert.ok(!second.includes('T0'), 'the confirmed prefix must not be resent');
    assert.ok(second.includes('User: T1'), 'the new user turn is part of the suffix');
    assert.ok(second.includes('Tool Response (read_file):') && second.includes('file x') && second.includes('call_9'), 'tool responses preserved as a compact summary');
    assert.ok(second.includes('User: T2'), 'final user message must be included');
  } finally {
    restore();
    delete process.env.TEST_SESSION_ID;
  }
});

test('hybrid-session: tool cycle after a text reply is economical (sends only the trailing cycle)', async () => {
  resetAllSessions();
  const capturedPayloads: any[] = [];

  const restore = setupFetchMock((_url, init) => {
    capturedPayloads.push(JSON.parse(init?.body as string || '{}'));
    return sseResponse(capturedPayloads.length === 1 ? ['cyc-1'] : ['cyc-2']);
  });

  try {
    process.env.TEST_SESSION_ID = 'hybrid-cycle-chat';

    const r1 = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.6-plus', user: 'conv-cycle', messages: [{ role: 'user', content: 'T1' }] })
    }));
    assert.strictEqual(r1.status, 200);
    await r1.text();

    const r2 = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        user: 'conv-cycle',
        messages: [
          { role: 'user', content: 'T1' },
          { role: 'assistant', content: 'Resposta completa para o teste.' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } }] },
          { role: 'tool', tool_call_id: 'call_2', name: 'read_file', content: 'file x' },
          { role: 'user', content: 'T3' }
        ]
      })
    }));
    assert.strictEqual(r2.status, 200);
    await r2.text();

    assert.strictEqual(capturedPayloads.length, 2);
    const second = capturedPayloads[1].messages[0].content;
    assert.strictEqual(capturedPayloads[1].parent_id, 'cyc-1', 'must thread onto the previous response');
    assert.ok(!second.includes('T1'), 'must not resend pre-cycle history');
    assert.ok(second.includes('{"path":"x"}'), 'tool arguments must be complete');
    assert.ok(second.includes('Tool Response (read_file):') && second.includes('call_2'), 'tool responses of the cycle must be summarized');
    assert.ok(second.includes('User: T3'), 'final user message must be included');
  } finally {
    restore();
    delete process.env.TEST_SESSION_ID;
  }
});

test('hybrid-session: streaming responses expose session_id', async () => {
  const restore = setupFetchMock(() => sseResponse(['qwen-stream-1']));

  try {
    process.env.TEST_SESSION_ID = 'hybrid-stream-chat';

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true
      })
    });
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const text = await res.text();

    const chunk = text.split('\n').find(line => line.startsWith('data: ') && line !== 'data: [DONE]');
    assert.ok(chunk, 'should contain a data chunk');
    const parsed = JSON.parse(chunk!.slice(6));
    assert.strictEqual(parsed.session_id, 'hybrid-stream-chat');
  } finally {
    restore();
    delete process.env.TEST_SESSION_ID;
  }
});
