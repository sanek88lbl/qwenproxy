let roots;
export function initialize(data) { roots = data.roots; }
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (!roots.some(root => result.url.startsWith(root)) || (context.parentURL?.startsWith('data:') && context.parentURL.includes('__qwenStartupState'))) return result;
  if (/\/(src|dist)\/services\/playwright\.(ts|js)$/.test(result.url)) {
    const original = result.url;
    const code = `export * from ${JSON.stringify(original)};
      export async function initPlaywright(headless, type = 'chromium') {
        globalThis.__qwenStartupState.browsers.push({kind:'default', headless, type});
        if (process.env.QWEN_STARTUP_FAIL_BROWSER === 'true') throw new Error('fixture browser initialization failure');
      }
      export async function initPlaywrightForAccount(account, headless, type = 'chromium') {
        globalThis.__qwenStartupState.browsers.push({kind:'account', headless, type, account:account.id});
        if (process.env.QWEN_STARTUP_FAIL_BROWSER === 'true') throw new Error('fixture browser initialization failure');
      }
      export async function closePlaywright() { globalThis.__qwenStartupState.browserCloses++; if (process.env.QWEN_STARTUP_FAIL_CLOSE === "true") throw new Error("fixture browser cleanup failure"); }`;
    return { url: 'data:text/javascript,' + encodeURIComponent(code), shortCircuit: true };
  }
  if (/\/(src|dist)\/cli\/commands\/tui\.(ts|js)$/.test(result.url)) {
    return { url: 'data:text/javascript,' + encodeURIComponent('export async function tuiCommand() { globalThis.__qwenStartupState.tui++; }'), shortCircuit: true };
  }
  return result;
}
