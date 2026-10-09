import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const preload = fileURLToPath(new URL('../helpers/startup-preload.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('../helpers/startup-entry.ts', import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx');
const compiledRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-startup-compiled-'));
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const build = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.build.json'), '--outDir', path.join(compiledRoot, 'dist')], { encoding: 'utf8' });
assert.equal(build.status, 0, build.stdout + build.stderr);
fs.cpSync(path.join(root, 'bin'), path.join(compiledRoot, 'bin'), { recursive: true });
fs.copyFileSync(path.join(root, 'package.json'), path.join(compiledRoot, 'package.json'));
fs.symlinkSync(path.join(root, 'node_modules'), path.join(compiledRoot, 'node_modules'), 'dir');
after(() => fs.rmSync(compiledRoot, { recursive: true, force: true }));

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function run(mode: string, envOverrides: Record<string, string> = {}, args: string[] = [], cli = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-startup-'));
  const envPort = await freePort();
  const expectedPort = envOverrides.QWEN_STARTUP_EXPECTED_PORT || String(envPort);
  try {
    const result = spawnSync(process.execPath, [...(cli ? [] : ['--import', tsx]), '--import', preload, cli ? path.join(compiledRoot, 'bin/qwenproxy.mjs') : mode === 'direct' ? path.join(root, 'src/index.ts') : fixture, ...args], {
      cwd: directory, encoding: 'utf8', timeout: 6000,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(envPort), BROWSER: 'chromium', TEST_MOCK_PLAYWRIGHT: 'true',
        API_KEY: '', USER_API_KEYS: '', AUTH_REQUIRED: 'false', QWEN_EMAIL: '', QWEN_PASSWORD: '', QWEN_GUEST_MODE_ONLY: 'false', QWEN_STARTUP_COMPILED_ROOT: pathToFileURL(compiledRoot + path.sep).href,
        SESSION_KEEPER_ENABLED: 'false', WARM_POOL_STARTUP: 'false', PRECAPTURE_HEADERS_STARTUP: 'false', BROWSER_IDLE_HIBERNATE_MS: '0',
        ACCOUNT_INIT_STAGGER_MIN_MS: '0', ACCOUNT_INIT_STAGGER_MAX_MS: '0', QWEN_STARTUP_MODE: mode,
        QWEN_STARTUP_EXPECTED_PORT: expectedPort, QWEN_STARTUP_EXPECTED_BROWSER: 'chromium', ...envOverrides },
    });
    assert.ifError(result.error);
    const line = result.stdout.split('\n').find(value => value.startsWith('STARTUP_REPORT '));
    assert.ok(line, result.stdout + result.stderr);
    return { ...result, report: JSON.parse(line.slice('STARTUP_REPORT '.length)), expectedPort: Number(expectedPort) };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('importing the application entry does not start HTTP, browser initialization or TUI', async () => {
  const result = await run('import-only');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report.listens, []);
  assert.deepEqual(result.report.browsers, []);
  assert.equal(result.report.tui, 0);
});

test('programmatic startup applies explicit port and browser to the real listener and initialization', async () => {
  const port = await freePort();
  const result = await run('api', { QWEN_STARTUP_EXPECTED_PORT: String(port), QWEN_STARTUP_EXPECTED_BROWSER: 'firefox' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.health, 200);
  assert.deepEqual(result.report.listens, [{ requestedPort: port, actualPort: port }]);
  assert.equal(result.report.browsers[0].type, 'firefox');
});

test('account initialization receives the selected browser type', async () => {
  const result = await run('api', { QWEN_STARTUP_ACCOUNT: 'true', QWEN_STARTUP_EXPECTED_BROWSER: 'webkit' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.browsers[0].kind, 'account');
  assert.equal(result.report.browsers[0].type, 'webkit');
});

test('concurrent startup callers create one listener', async () => {
  const result = await run('api-double');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.listens.length, 1);
});

test('the packaged CLI starts once and applies CLI precedence over environment settings', async () => {
  const port = await freePort();
  const result = await run('cli', { BROWSER: 'invalid-env-browser', QWEN_STARTUP_EXPECTED_PORT: String(port) }, ['--port', String(port), '--browser', 'firefox', '--quiet'], true);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report.listens, [{ requestedPort: port, actualPort: port }]);
  assert.equal(result.report.browsers[0].type, 'firefox');
  assert.equal(result.report.tui, 0);
});

test('startup failure exits nonzero without polling forever for a port', async () => {
  const result = await run('cli', { QWEN_STARTUP_FAIL_BROWSER: 'true' }, ['--quiet'], true);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /fixture browser initialization failure/);
  assert.equal(result.report.listens.length, 0);
});


test('the packaged CLI owns a single startup with ordinary environment defaults', async () => {
  const result = await run('cli', {}, ['--quiet'], true);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.report.listens.length, 1);
  assert.equal(result.report.tui, 0);
});

for (const port of ['70000', '0', '3000abc', '2.5']) {
  test(`CLI port ${port} is rejected before browser or HTTP side effects`, async () => {
    const result = await run('cli', {}, ['--port', port, '--quiet'], true);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.report.browsers.length, 0);
    assert.equal(result.report.listens.length, 0);
  });
}


test('the npm source entry parses browser and port arguments and starts once', async () => {
  const port = await freePort();
  const result = await run('direct', {}, ['--port', String(port), '--browser=firefox', '--quiet']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.report.listens, [{ requestedPort: port, actualPort: port }]);
  assert.equal(result.report.browsers[0].type, 'firefox');
});

test('guest-only startup preserves configured accounts and skips their initialization', async () => {
  const result = await run('api', { QWEN_STARTUP_ACCOUNT: 'true', QWEN_GUEST_MODE_ONLY: 'true' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.report.health, 200);
  assert.deepEqual(result.report.browsers, []);
  assert.match(result.stdout, /RETAINED_ACCOUNTS 1/);
});

test('a failed cleanup retains the original startup error and exits without hanging', async () => {
  const result = await run('cli', { QWEN_STARTUP_FAIL_BROWSER: 'true', QWEN_STARTUP_FAIL_CLOSE: 'true' }, ['--quiet'], true);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Failed to start:[\s\S]*fixture browser initialization failure/);
  assert.match(result.stderr, /Startup cleanup failed:[\s\S]*fixture browser cleanup failure/);
});

test('an invalid environment port is rejected before initialization', async () => {
  const result = await run('cli', { PORT: '70000' }, ['--quiet'], true);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(result.report.browsers, []);
  assert.deepEqual(result.report.listens, []);
});

test('the documented npm dev entry accepts --dev and starts its listener once', async () => {
  const port = await freePort();
  const result = await run('direct', { QWEN_WEB_DEV_URL: 'http://127.0.0.1:5173' }, ['--dev', '--port', String(port), '--quiet']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.report.health, 200);
  assert.equal(result.report.devRedirect, 'http://127.0.0.1:5173/admin/');
  assert.deepEqual(result.report.listens, [{ requestedPort: port, actualPort: port }]);
});
