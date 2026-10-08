import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { installAttachmentHttpFixture } from '../helpers/attachment-http.js';
const nativeHttpRequest = http.request;

const cwd = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-download-'));
process.chdir(directory);
process.env.ATTACHMENT_DOWNLOAD_MAX_BYTES = '64';
process.env.ATTACHMENT_DOWNLOAD_TIMEOUT_MS = '1000';
process.env.ATTACHMENT_DOWNLOAD_MAX_REDIRECTS = '2';
process.env.ATTACHMENT_MAX_FILES = '2';
const { downloadAttachment, isPublicAttachmentAddress, AttachmentDownloadError } = await import('../../services/attachment-download.js');
const { config } = await import('../../core/config.js');
const { closeDatabase } = await import('../../core/database.js');
after(() => { closeDatabase(); process.chdir(cwd); fs.rmSync(directory, { recursive: true, force: true }); });

test('address policy blocks non-public and transition ranges', () => {
  for (const address of ['0.0.0.0', '10.1.2.3', '100.100.100.200', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.168.1.2', '198.19.0.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1',
    '::ffff:8.8.8.8', '64:ff9b::a00:1', '64:ff9b:1::1', 'fc00::1', 'fd00::1', 'fe80::1', 'ff02::1',
    '2000::1', '2001::1', '2001:db8::1', '2002:a00:1::', '3ffe::1', '3fff::1', 'not-an-address']) {
    assert.equal(isPublicAttachmentAddress(address), false, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicAttachmentAddress(address), true, address);
  }
});

test('unsafe URLs are rejected before connecting', async t => {
  const calls = installAttachmentHttpFixture(t, () => ({}));
  for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f000001/',
    'http://[::1]/', 'http://[::ffff:7f00:1]/', 'http://169.254.169.254/', 'ftp://fixture.invalid/',
    'file:///etc/passwd', 'https://user:fixture@fixture.invalid/', 'http://[fe80::1%25eth0]/', 'not a URL']) {
    await assert.rejects(downloadAttachment(url), AttachmentDownloadError);
  }
  assert.equal(calls.length, 0);
});

test('every DNS result is checked and connections use the pinned result', async t => {
  let resolutions = 0;
  const calls = installAttachmentHttpFixture(t, () => ({ chunks: [Buffer.from('fixture')] }), async () => {
    resolutions++;
    return [{ address: resolutions === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
  });
  const downloaded = await downloadAttachment('https://fixture.invalid/a.txt');
  assert.equal(downloaded.buffer.toString(), 'fixture');
  assert.equal(resolutions, 1);
  assert.deepEqual(calls[0].pinned, [{ address: '8.8.8.8', family: 4 }]);
  calls[0].options.lookup!('fixture.invalid', { all: false }, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, '8.8.8.8');
    assert.equal(family, 4);
  });
  assert.equal(calls[0].url.hostname, 'fixture.invalid');
  const agentOptions = (calls[0].options.agent as unknown as { options: { proxyEnv: unknown; rejectUnauthorized?: boolean } }).options;
  assert.deepEqual(agentOptions.proxyEnv, {});
  assert.equal(agentOptions.rejectUnauthorized, true);
  assert.notEqual(calls[0].options.agent, http.globalAgent);
  assert.deepEqual(Object.keys(calls[0].options.headers || {}).map(key => key.toLowerCase()).sort(), ['accept', 'accept-encoding', 'connection']);
  assert.equal(calls[0].request.destroyed, true);
  for (const answers of [[], [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }],
    [{ address: '::1', family: 6 }], [{ address: '8.8.8.8', family: 6 }]]) {
    installAttachmentHttpFixture(t, () => ({}), async () => answers);
    await assert.rejects(downloadAttachment('http://fixture.invalid/file'), /non-public/);
  }
  assert.equal(calls.length, 1);
  const dualStack = installAttachmentHttpFixture(t, () => ({ chunks: [Buffer.from('dual-stack fixture')] }),
    async () => [{ address: '2606:4700::1111', family: 6 }, { address: '8.8.8.8', family: 4 }]);
  assert.equal((await downloadAttachment('http://fixture.invalid/file')).buffer.toString(), 'dual-stack fixture');
  assert.deepEqual(dualStack[0].pinned, [{ address: '2606:4700::1111', family: 6 }, { address: '8.8.8.8', family: 4 }]);
});

test('a changed socket address is rejected before a real HTTP request is sent', { timeout: 3000 }, async t => {
  assert.equal(http.request, nativeHttpRequest, 'The native connection check must start with an unmocked HTTP transport');
  let hits = 0;
  const server = http.createServer((_req, res) => { hits++; res.end('private fixture'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const nativeRequest = nativeHttpRequest;
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(http, 'request', (url: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) =>
    nativeRequest(url, { ...options, hostname: '127.0.0.1', port }, callback));
  try {
    await assert.rejects(downloadAttachment('http://fixture.invalid/private'), /connection address/);
    assert.equal(hits, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('redirects are checked individually and limited', async t => {
  const calls = installAttachmentHttpFixture(t, url => url.pathname === '/start'
    ? { status: 302, headers: { location: '/end' } }
    : { headers: { 'content-type': 'text/plain' }, chunks: [Buffer.from('redirect fixture')] });
  const result = await downloadAttachment('http://fixture.invalid/start');
  assert.equal(result.url.pathname, '/end');
  assert.equal(result.buffer.toString(), 'redirect fixture');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.request.destroyed));
  installAttachmentHttpFixture(t, () => ({ status: 302, headers: { location: 'http://127.0.0.1/private' } }));
  await assert.rejects(downloadAttachment('http://fixture.invalid/start'), /non-public/);
  installAttachmentHttpFixture(t, () => ({ status: 302, headers: { location: 'file:///private' } }));
  await assert.rejects(downloadAttachment('http://fixture.invalid/start'), /scheme/);
  const changedDns = installAttachmentHttpFixture(t, () => ({ status: 302, headers: { location: 'https://next.invalid/file' } }),
    async hostname => [{ address: hostname === 'next.invalid' ? '10.0.0.1' : '8.8.8.8', family: 4 }]);
  await assert.rejects(downloadAttachment('http://fixture.invalid/start'), /non-public/);
  assert.equal(changedDns.length, 1);
  const loop = installAttachmentHttpFixture(t, () => ({ status: 302, headers: { location: '/again' } }));
  await assert.rejects(downloadAttachment('http://fixture.invalid/start'), /redirect/);
  assert.equal(loop.length, 3);
});

test('wire bytes and decompressed bytes are bounded', async t => {
  for (const size of [0, 1, 64, 65]) {
    const calls = installAttachmentHttpFixture(t, () => ({ chunks: [Buffer.alloc(size, 0x61)] }));
    if (size <= 64) assert.equal((await downloadAttachment('http://fixture.invalid/file')).buffer.length, size);
    else await assert.rejects(downloadAttachment('http://fixture.invalid/file'), error => error instanceof AttachmentDownloadError && error.upstreamStatus === 413);
    assert.ok(calls.every(call => call.request.destroyed));
  }
  for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]] as const) {
    installAttachmentHttpFixture(t, () => ({ headers: { 'content-encoding': encoding }, chunks: [compress(Buffer.from('fixture'))] }));
    assert.equal((await downloadAttachment('http://fixture.invalid/file')).buffer.toString(), 'fixture');
    installAttachmentHttpFixture(t, () => ({ headers: { 'content-encoding': encoding }, chunks: [compress(Buffer.alloc(65, 0x61))] }));
    await assert.rejects(downloadAttachment('http://fixture.invalid/file'), error => error instanceof AttachmentDownloadError && error.upstreamStatus === 413);
  }
  installAttachmentHttpFixture(t, () => ({ headers: { 'content-length': '65' }, chunks: [] }));
  await assert.rejects(downloadAttachment('http://fixture.invalid/file'), /byte limit/);
  installAttachmentHttpFixture(t, () => ({ headers: { 'content-encoding': 'gzip' }, chunks: [Buffer.from('invalid gzip')] }));
  await assert.rejects(downloadAttachment('http://fixture.invalid/file'), AttachmentDownloadError);
});

test('timeouts and disconnect cancel pending body reads and ignore late DNS results', { timeout: 3000 }, async t => {
  const originalTimeout = config.attachmentDownload.timeoutMs;
  config.attachmentDownload.timeoutMs = 30;
  try {
    const stalled = installAttachmentHttpFixture(t, () => ({ stall: true }));
    await assert.rejects(downloadAttachment('http://fixture.invalid/file'), /timed out/);
    assert.equal(stalled[0].request.destroyed, true);
    config.attachmentDownload.timeoutMs = originalTimeout;
    const calls = installAttachmentHttpFixture(t, () => ({ stall: true }));
    const abort = new AbortController();
    const pending = downloadAttachment('http://fixture.invalid/file', { signal: abort.signal });
    await new Promise(resolve => setImmediate(resolve));
    abort.abort();
    await assert.rejects(pending, /cancelled/);
    assert.equal(calls[0].request.destroyed, true);
    config.attachmentDownload.timeoutMs = 30;
    let finishLookup!: (value: { address: string; family: number }[]) => void;
    const late = installAttachmentHttpFixture(t, () => ({}), () => new Promise(resolve => { finishLookup = resolve; }));
    await assert.rejects(downloadAttachment('http://fixture.invalid/file'), /timed out/);
    finishLookup([{ address: '8.8.8.8', family: 4 }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(late.length, 0);
  } finally {
    config.attachmentDownload.timeoutMs = originalTimeout;
  }
});
