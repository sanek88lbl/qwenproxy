import { register } from 'node:module';
import http from 'node:http';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';

const state = { listens: [], browsers: [], browserCloses: 0, tui: 0, health: null, admin: null, adminAsset: null };
globalThis.__qwenStartupState = state;
register('./startup-loader.mjs', import.meta.url, { data: { roots: [new URL('../../../', import.meta.url).href, ...(process.env.QWEN_STARTUP_COMPILED_ROOT ? [process.env.QWEN_STARTUP_COMPILED_ROOT] : [])] } });
const nativeFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Unexpected external fetch in startup fixture'); };
const nativeListen = http.Server.prototype.listen;
let finishing = false;
http.Server.prototype.listen = function (...args) {
  const requestedPort = typeof args[0] === 'object' ? args[0]?.port : args[0];
  const row = { requestedPort: Number(requestedPort), actualPort: null };
  state.listens.push(row);
  this.once('listening', () => {
    row.actualPort = this.address().port;
    if (finishing) return;
    finishing = true;
    setTimeout(async () => {
      const response = await nativeFetch(`http://127.0.0.1:${row.actualPort}/health`);
      state.health = response.status;
      if (process.env.QWEN_STARTUP_VERIFY_ADMIN === 'true') {
        const admin = await nativeFetch(`http://127.0.0.1:${row.actualPort}/admin/`);
        const html = await admin.text();
        const assetPath = html.match(/<script[^>]+src=["']([^"']+)["']/)?.[1];
        state.admin = admin.status === 200 && assetPath ? 200 : admin.status === 200 ? 500 : admin.status;
        if (assetPath) {
          const asset = await nativeFetch(new URL(assetPath, `http://127.0.0.1:${row.actualPort}/admin/`));
          state.adminAsset = asset.status === 200 && asset.headers.get('content-type')?.includes('javascript') ? 200 : 500;
        }
      }
      process.kill(process.pid, 'SIGTERM');
    }, 200);
  });
  return nativeListen.apply(this, args);
};
process.once('exit', () => process.stdout.write('STARTUP_REPORT ' + JSON.stringify(state) + '\n'));
