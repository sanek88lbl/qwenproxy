import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
Object.assign(process.env, { TEST_MOCK_PLAYWRIGHT: 'true', HYBRID_SESSION_VERIFY: 'false', WARM_POOL_SIZE: '0', AUTO_CONTINUE: 'false', BROWSER_IDLE_HIBERNATE_MS: '0' });
for (const key of ['API_KEY', 'AUTH_REQUIRED', 'USER_API_KEYS']) delete process.env[key];
const cwd = process.cwd(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-malformed-tools-')); process.chdir(dir);
const { app } = await import('../../api/server.js');
const { config } = await import('../../core/config.js');
const { addAccount } = await import('../../core/accounts.js');
const { closeDatabase } = await import('../../core/database.js');
const { resetAllSessions, getSession, ownedSessionKey } = await import('../../services/session-manager.js');
const { getAccountActiveLoad } = await import('../../core/account-manager.js');
const { getStreamRegistry } = await import('../../core/stream-registry.js');
const account = addAccount('malformed@example.invalid', 'fixture-password');
after(() => { closeDatabase(); process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); });
const tools = [{ type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command', 'description'] } } }];
const fixtureCommand = `python3 - <<'EOF'
import sqlite3, os
base=os.path.expanduser('~/fixtureStorage')
for d in ['fixture-a','fixture-b']:
    p=os.path.join(base,d,'fixture.db')
    if not os.path.exists(p): print(d,'MISSING'); continue
    c=sqlite3.connect('file:'+p+'?mode=ro',uri=True)
    kv={k:v for k,v in c.execute('select key,value from FixtureTable')}
    print('===',d)
    for k in sorted(kv):
        if ('hidden' in k or 'size' in k) and k.startswith('fixture'):
            print('  ',k,'=',kv[k][:60])
EOF`;
const broken = `<qpx_call>{"name":"bash","arguments":{"command":${JSON.stringify(fixtureCommand)},"description": Compare fixture keys in synthetic stores"}}</qpx_call>`;
const valid = '<qpx_call>{"name":"bash","arguments":{"command":"printf fixture","description":"Fixture command"}}</qpx_call>';

async function run(stream: boolean, answer: string, thinking = '', guard: 'always' | 'off' = 'always', includeDefinitions = true) {
  resetAllSessions(); config.streamDegenerateGuard = guard;
  let posts = 0; const nativeFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    posts++; const id = 'malformed-parent-' + posts;
    const rows: any[] = [{ 'response.created': { response_id: id } }];
    if (thinking) rows.push({ response_id: id, choices: [{ delta: { phase: 'thinking', content: thinking } }] });
    for (let i = 0; i < answer.length; i += 13) rows.push({ response_id: id, choices: [{ delta: { phase: 'answer', content: answer.slice(i, i + 13) } }] });
    return new Response(rows.map(row => 'data: ' + JSON.stringify(row) + '\n\n').join('') + 'data: [DONE]\n\n');
  };
  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3.8-max', user: 'malformed-fixture', messages: includeDefinitions ? [{ role: 'user', content: 'Use a fixture tool.' }] : [
      { role: 'assistant', content: '', tool_calls: [{ id: 'prior-fixture-call', type: 'function', function: { name: 'bash', arguments: '{"command":"fixture"}' } }] },
      { role: 'tool', tool_call_id: 'prior-fixture-call', content: 'Prior fixture result.' }, { role: 'user', content: 'Use a fixture tool.' },
    ], ...(includeDefinitions ? { tools } : {}), stream }) }));
    const raw = await response.text();
    const rows = stream ? raw.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6))) : [JSON.parse(raw)];
    return { response, raw, rows, posts, session: getSession(ownedSessionKey(JSON.stringify(['anonymous']), 'malformed-fixture')) };
  } finally { globalThis.fetch = nativeFetch; }
}
for (const stream of [true, false]) {
  for (const kind of ['closed', 'unclosed', 'mixed', 'invalid-array'] as const) {
    test(`${stream ? 'SSE' : 'JSON'} returns an explicit malformed-tool error for ${kind} output after long reasoning`, async () => {
      const result = await run(stream, kind === 'closed' ? broken : kind === 'unclosed' ? broken.replace('</qpx_call>', '') : kind === 'mixed' ? valid + broken : '<qpx_call>[{"name":"bash","arguments":{"command":"printf fixture","description":"Fixture command"}},null]</qpx_call>', 'Thinking fixture. '.repeat(200));
      assert.equal(result.rows.filter(row => row.error?.code === 'MalformedToolCall').length, 1);
      assert.equal(result.response.status, stream ? 200 : 502);
      assert.equal(result.posts, 1, 'partially delivered output must not be replayed');
      assert.ok(!result.raw.includes('Compare fixture keys'));
      assert.equal(result.session?.historyComplete, false);
      assert.equal(getAccountActiveLoad(account.id), 0); assert.equal(getStreamRegistry().size, 0);
      if (stream) {
        assert.equal(result.raw.split('data: [DONE]').length - 1, 1);
        assert.ok(!result.rows.some(row => row.choices?.some((choice: any) => ['stop', 'tool_calls'].includes(choice.finish_reason))));
      }
    });
  }
  test(`${stream ? 'SSE' : 'JSON'} preserves valid tools and ordinary assistant answers`, async () => {
    for (const answer of [valid, valid.replace('}}</qpx_call>', '}</qpx_call>'), valid.replace('</qpx_call>', ''), 'Ordinary fixture answer.']) {
      const result = await run(stream, answer);
      assert.equal(result.response.status, 200); assert.ok(!result.rows.some(row => row.error)); assert.equal(result.session?.historyComplete, true);
      if (answer.startsWith('<qpx_call>')) {
        const calls = result.rows.flatMap(row => row.choices?.[0]?.[stream ? 'delta' : 'message']?.tool_calls ?? []);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].function.name, 'bash');
        assert.deepEqual(JSON.parse(calls[0].function.arguments), { command: 'printf fixture', description: 'Fixture command' });
      }
      else assert.equal(stream ? result.rows.map(row => row.choices?.[0]?.delta?.content ?? '').join('') : result.rows[0].choices[0].message.content, answer);
    }
  });
}
test('malformed tool output remains an error with the streaming guard disabled', async () => {
  const result = await run(true, broken, '', 'off');
  assert.ok(result.rows.some(row => row.error?.code === 'MalformedToolCall')); assert.equal(result.posts, 1);
});


for (const streaming of [false, true]) {
  test(`${streaming ? 'SSE' : 'JSON'} rejects a malformed tool response in a tool conversation without repeated definitions`, async () => {
    const result = await run(streaming, broken, '', 'off', false);
    assert.ok(result.rows.some(row => row.error?.code === 'MalformedToolCall'));
    assert.equal(result.posts, 1);
    assert.equal(result.session?.historyComplete, false);
  });
}
