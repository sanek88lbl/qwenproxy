import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import OSS from 'ali-oss';
import { Hono } from 'hono';
import { installAttachmentHttpFixture } from '../helpers/attachment-http.js';

const cwd = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-url-policy-'));
process.chdir(directory);
delete process.env.TEST_MOCK_PLAYWRIGHT;
const { processImagesForQwen } = await import('../../routes/upload.js');
const { closeDatabase } = await import('../../core/database.js');
const { config } = await import('../../core/config.js');
after(() => { closeDatabase(); process.chdir(cwd); fs.rmSync(directory, { recursive: true, force: true }); });

test('HTTP attachments cannot fetch or inline loopback services', { timeout: 3000 }, async t => {
  let hits = 0;
  let uploads = 0;
  const server = http.createServer((_req, res) => { hits++; res.end('PRIVATE_FIXTURE_SENTINEL'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/getstsToken')) return Response.json({ success: true, data: {
      access_key_id: 'fixture', access_key_secret: 'fixture', security_token: 'fixture',
      file_url: 'https://fixture.invalid/file', file_path: 'fixture', file_id: 'fixture',
      bucketname: 'fixture', region: 'oss-cn-hangzhou', endpoint: 'oss-cn-hangzhou.aliyuncs.com',
    } });
    return nativeFetch(input, init);
  });
  t.mock.method(OSS.prototype, 'put', async () => { uploads++; return { url: 'https://fixture.invalid/file' }; });
  try {
    await assert.rejects(processImagesForQwen([{ type: 'file_url', file_url: { url: `http://127.0.0.1:${port}/private.txt` } }],
      { cookie: 'fixture', 'user-agent': 'fixture', 'bx-ua': 'fixture' }), /non-public|blocked/i);
    assert.equal(hits, 0);
    assert.equal(uploads, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
});

test('attachment failures are explicit and file and byte limits apply before further uploads', async t => {
  const originalBytes = config.attachmentDownload.maxBytes;
  const originalFiles = config.attachmentDownload.maxFiles;
  config.attachmentDownload.maxBytes = 64;
  config.attachmentDownload.maxFiles = 2;
  let uploads = 0;
  const calls = installAttachmentHttpFixture(t, () => ({ status: 404 }));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ success: true, data: {
    access_key_id: 'fixture', access_key_secret: 'fixture', security_token: 'fixture',
    file_url: 'https://fixture.invalid/file', file_path: 'fixture', file_id: 'fixture',
    bucketname: 'fixture', region: 'oss-cn-hangzhou', endpoint: 'oss-cn-hangzhou.aliyuncs.com',
  } }));
  t.mock.method(OSS.prototype, 'put', async () => { uploads++; return { url: 'https://fixture.invalid/file' }; });
  const headers = { cookie: 'fixture', 'user-agent': 'fixture', 'bx-ua': 'fixture' };
  const attachment = { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.alloc(40, 0x61).toString('base64')}` } };
  try {
    await assert.rejects(processImagesForQwen([attachment, attachment, attachment], headers), /Too many/);
    assert.equal(uploads, 0);
    await assert.rejects(processImagesForQwen([attachment, attachment], headers), /byte limit/);
    assert.equal(uploads, 1);
    await assert.rejects(processImagesForQwen([{ type: 'file_url', file_url: { url: 'http://fixture.invalid/file' } }], headers), /HTTP 404/);
    assert.equal(uploads, 1);
    assert.equal(calls.length, 1);
    for (const url of ['ftp://fixture.invalid/file', 'data:image/png;base64,%%%', 'data:image/png;base64,A', 'data:image/png',
      'data:image/png;base64,AAAA=', 'data:image/png;base64,AA=', 'data:image/png;base64,AB==']) {
      await assert.rejects(processImagesForQwen([{ type: 'image_url', image_url: { url } }], headers));
    }
    await assert.rejects(processImagesForQwen([{ type: 'image_url' }], headers), /URL is required/);
    assert.equal(uploads, 1);
  } finally {
    config.attachmentDownload.maxBytes = originalBytes;
    config.attachmentDownload.maxFiles = originalFiles;
  }
});

test('disconnect during an upload prevents accepting the attachment', async t => {
  const abort = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ success: true, data: {
    access_key_id: 'fixture', access_key_secret: 'fixture', security_token: 'fixture',
    file_url: 'https://fixture.invalid/file', file_path: 'fixture', file_id: 'fixture',
    bucketname: 'fixture', region: 'oss-cn-hangzhou', endpoint: 'oss-cn-hangzhou.aliyuncs.com',
  } }));
  t.mock.method(OSS.prototype, 'put', async () => { abort.abort(); return { url: 'https://fixture.invalid/file' }; });
  await assert.rejects(processImagesForQwen([{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }],
    { cookie: 'fixture', 'user-agent': 'fixture', 'bx-ua': 'fixture' }, { signal: abort.signal }), /cancelled/);
});

test('HTTP chat rejects unsafe and oversized attachments without rotating or cooling accounts', { timeout: 15000 }, async t => {
  const { chatCompletions } = await import('../../routes/chat.js');
  const { addAccount } = await import('../../core/accounts.js');
  const { getAccountActiveLoad, getAccountCooldownInfo } = await import('../../core/account-manager.js');
  const { setSession, getSession } = await import('../../services/session-manager.js');
  addAccount('url-a@example.invalid', 'fixture', 'url-account-a');
  addAccount('url-b@example.invalid', 'fixture', 'url-account-b');
  setSession('url-private', { accountId: 'url-account-a', chatId: 'existing-fixture-chat', parentId: 'existing-fixture-parent',
    headers: {}, historyComplete: true, updatedAt: Date.now(),
  });
  process.env.TEST_MOCK_PLAYWRIGHT = 'true';
  const originalBytes = config.attachmentDownload.maxBytes;
  config.attachmentDownload.maxBytes = 64;
  const app = new Hono();
  app.post('/chat', chatCompletions);
  let completions = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    if (String(input).includes('/completions?')) completions++;
    return Response.json({ success: true, data: { file_url: 'https://fixture.invalid/file', file_id: 'fixture' } });
  });
  try {
    const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.alloc(40).toString('base64')}` } };
    for (const [key, messages, status] of [
      ['private', [{ role: 'user', content: [{ type: 'file_url', file_url: { url: 'http://127.0.0.1/private' } }] }], 400],
      ['budget', [{ role: 'user', content: [image] }, { role: 'user', content: [image] }], 413],
    ] as const) {
      const response = await app.request('/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'qwen3.7-plus', user: `url-${key}`, messages }),
      });
      assert.equal(response.status, status);
      assert.ok((await response.json()).error.message);
      if (key === 'private') {
        assert.equal(getSession('url-private')?.chatId, 'existing-fixture-chat');
        assert.equal(getSession('url-private')?.historyComplete, true);
      }
    }
    const calls = installAttachmentHttpFixture(t, () => ({ stall: true }));
    const abort = new AbortController();
    const pending = app.request('/chat', { method: 'POST', signal: abort.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.7-plus', user: 'url-cancel', messages: [{ role: 'user', content: [
        { type: 'file_url', file_url: { url: 'http://fixture.invalid/file' } },
      ] }] }),
    });
    try {
      const deadline = Date.now() + 5000;
      while (!calls.length) {
        if (Date.now() > deadline) throw new Error('Download was not started');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      abort.abort();
      assert.equal((await pending).status, 400);
      assert.equal(calls[0].request.destroyed, true);
    } finally {
      abort.abort();
      await pending;
    }
    assert.equal(completions, 0);
    for (const account of ['url-account-a', 'url-account-b']) {
      assert.equal(getAccountActiveLoad(account), 0);
      assert.equal(getAccountCooldownInfo(account), null);
    }
  } finally {
    delete process.env.TEST_MOCK_PLAYWRIGHT;
    config.attachmentDownload.maxBytes = originalBytes;
  }
});
