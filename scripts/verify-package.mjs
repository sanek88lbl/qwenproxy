import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  run(npm, ['run', 'prepack']);
  const packed = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary]));
  const archive = path.join(temporary, packed[0].filename);
  const files = packed[0].files.map(item => item.path);
  for (const required of ['dist/index.js', 'dist/cli/server-options.js', 'bin/qwenproxy.mjs', 'web/dist/index.html']) assert.ok(files.includes(required), `Missing ${required}`);
  assert.ok(files.some(file => file.startsWith('web/dist/assets/')));
  assert.ok(!files.some(file => /(^|\/)(data|qwen_profiles|\.local|node_modules|tests)(\/|$)|(^|\/)\.env($|\.)|accounts\.json|\.db($|-)|encryption_key|storage-state/.test(file)), 'Private or development files in tarball');
  const install = path.join(temporary, 'installation');
  fs.mkdirSync(install);
  fs.writeFileSync(path.join(install, 'package.json'), '{"private":true}');
  run(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', archive], { cwd: install });
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const installed = path.join(install, 'node_modules', ...pkg.name.split('/'));
  const bin = path.join(installed, 'bin/qwenproxy.mjs');
  assert.equal(run(process.execPath, [bin, '--version'], { cwd: install }).trim(), pkg.version);
  assert.match(run(process.execPath, [bin, '--help'], { cwd: install }), /--browser/);
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const smoke = run(process.execPath, ['--import', path.join(root, 'src/tests/helpers/startup-preload.mjs'), bin, '--port', String(port), '--browser', 'firefox', '--quiet'], {
    cwd: install, timeout: 10000,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), BROWSER: 'chromium', QWEN_EMAIL: '', QWEN_PASSWORD: '', API_KEY: '', USER_API_KEYS: '', AUTH_REQUIRED: 'false',
      QWEN_GUEST_MODE_ONLY: 'false', SESSION_KEEPER_ENABLED: 'false', WARM_POOL_STARTUP: 'false', PRECAPTURE_HEADERS_STARTUP: 'false', BROWSER_IDLE_HIBERNATE_MS: '0',
      QWEN_STARTUP_MODE: 'package', QWEN_STARTUP_VERIFY_ADMIN: 'true', QWEN_STARTUP_COMPILED_ROOT: pathToFileURL(installed + path.sep).href },
  });
  const report = JSON.parse(smoke.split('\n').find(line => line.startsWith('STARTUP_REPORT ')).slice('STARTUP_REPORT '.length));
  assert.equal(report.hung, false);
  assert.equal(report.health, 200);
  assert.equal(report.admin, 200);
  assert.equal(report.adminAsset, 200);
  assert.deepEqual(report.listens, [{ requestedPort: port, actualPort: port }]);
  assert.equal(report.browsers[0].type, 'firefox');
  assert.ok(fs.existsSync(path.join(install, 'data/qwenproxy.db')));
  console.log(JSON.stringify({ package: pkg.name, node: process.version, files: files.length, backend: true, admin: true, cli: true, startup: true, freshDatabase: true, productionDependenciesOnly: true }));
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
