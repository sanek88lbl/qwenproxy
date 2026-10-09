import { register } from 'node:module';
import http from 'node:http';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';

const state = { listens: [], browsers: [], browserCloses: 0, tui: 0, health: null, hung: false };
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
      process.kill(process.pid, 'SIGTERM');
    }, 200);
  });
  return nativeListen.apply(this, args);
};
process.once('exit', () => process.stdout.write('STARTUP_REPORT ' + JSON.stringify(state) + '\n'));
setTimeout(() => {
  if (process.env.QWEN_STARTUP_MODE === 'import-only') process.exit(0);
  state.hung = true;
  process.exit(88);
}, 2000).unref();
