import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { getActivePage, loginToQwen, setActivePage } from '../../services/browser-manager.ts';

async function runLogin(payload: unknown, sessionConfirmed = true, options: { staleRefresh?: boolean; rotatedRefresh?: boolean } = {}) {
  const values = new Map<string, string>([['qwen_token_logged_out_marker', 'old']]);
  let cookies = [
    { name: 'refresh_token', domain: '.qwen.ai', path: '/', value: 'old-refresh' },
    { name: 'token', domain: '.qwen.ai', path: '/', value: 'legacy-session' },
    { name: 'refresh_token', domain: 'unrelated.example.test', path: '/', value: 'unrelated-refresh' },
    { name: 'refresh_token', domain: '.qwen.ai', path: '/unrelated', value: 'unrelated-path-refresh' },
  ];
  const clearCalls: Array<{ name?: string | RegExp; domain?: string | RegExp; path?: string | RegExp }> = [];
  let requests = 0;
  const context = {
    cookies: async (urls?: string[]) => cookies.filter(cookie => !urls || urls.some(url => {
      const parsed = new URL(url);
      const domain = cookie.domain.replace(/^\./, '');
      return (parsed.hostname === domain || parsed.hostname.endsWith('.' + domain)) && parsed.pathname.startsWith(cookie.path);
    })),
    clearCookies: async (filter: { name?: string | RegExp; domain?: string | RegExp; path?: string | RegExp } = {}) => {
      clearCalls.push(filter);
      cookies = cookies.filter(cookie => !Object.entries(filter).every(([key, value]) =>
        value instanceof RegExp ? value.test(cookie[key as keyof typeof cookie]) : cookie[key as keyof typeof cookie] === value));
    },
  };
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalPage = getActivePage();
  let currentUrl = 'about:blank';
  let beforeChat: Record<string, string> | undefined;
  const page = {
    context: () => context,
    goto: async (url: string) => {
      if (url === 'https://chat.qwen.ai/') beforeChat = Object.fromEntries(values);
      currentUrl = url;
    },
    url: () => currentUrl,
    evaluate: async (callback: (value: unknown) => unknown, value: unknown) => callback(value),
    waitForFunction: async () => {
      if (options.staleRefresh && cookies.some(cookie => cookie.name === 'refresh_token' && cookie.domain === '.qwen.ai' && cookie.path === '/' && cookie.value === 'old-refresh')) {
        throw new Error('The provider rejected the old refresh cookie');
      }
    },
    waitForResponse: async (predicate: (response: unknown) => Promise<boolean>) => {
      const response = {
        url: () => 'https://auth.qwen.ai/api/v2/auths/',
        ok: () => true,
        json: async () => ({ success: sessionConfirmed, data: { id: 'fixture-user', email: 'fixture@example.test' } }),
      };
      if (!await predicate(response)) throw new Error('Browser session was rejected');
      return response;
    },
    reload: async () => undefined,
  } as unknown as Page;
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    globalThis.fetch = async () => {
      requests++;
      if (options.rotatedRefresh) cookies[0] = { ...cookies[0], value: 'new-refresh' };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    setActivePage(page);
    const accepted = await loginToQwen('fixture@example.test', 'fixture-password');
    return { accepted, beforeChat, values, cookies, clearCalls, requests };
  } finally {
    setActivePage(originalPage);
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

test('successful login supplies browser authentication before opening the chat', async () => {
  const result = await runLogin({
    success: true,
    data: { id: 'fixture-user', token: 'fixture-access-token', expires_at: 1893456000 },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.beforeChat?.token, 'fixture-access-token');
  assert.equal(result.beforeChat?.at_expire_time, '1893456000000');
  assert.equal(result.beforeChat?.qwen_token_logged_out_marker, undefined);
  const state = JSON.parse(result.beforeChat?.qwen_access_token_state || '{}');
  assert.equal(state.token, 'fixture-access-token');
  assert.equal(state.expiresAt, 1893456000000);
});

test('HTTP 200 with a rejected login is not an authenticated account', async () => {
  const result = await runLogin({ success: false, data: { code: 'InvalidCredentials' } });
  assert.equal(result.accepted, false);
  assert.equal(result.beforeChat, undefined);
  assert.equal(result.values.get('token'), undefined);
});

test('a success envelope without an access token does not open an authenticated chat', async () => {
  const result = await runLogin({ success: true, data: { id: 'fixture-user' } });
  assert.equal(result.accepted, false);
  assert.equal(result.beforeChat, undefined);
});

test('a successful sign-in is rejected when the browser account session is not confirmed', async () => {
  const result = await runLogin({
    success: true,
    data: { id: 'fixture-user', token: 'fixture-access-token', expires_at: 1893456000 },
  }, false);
  assert.equal(result.accepted, false);
});

test('a successful sign-in recovers when the provider rejects the previous refresh session', async () => {
  const result = await runLogin({ success: true, data: { token: 'fixture-token', expires_at: 1893456000 } }, true, { staleRefresh: true });
  assert.equal(result.accepted, true);
  assert.equal(result.requests, 1);
  assert.deepEqual(result.cookies, [
    { name: 'token', domain: '.qwen.ai', path: '/', value: 'legacy-session' },
    { name: 'refresh_token', domain: 'unrelated.example.test', path: '/', value: 'unrelated-refresh' },
    { name: 'refresh_token', domain: '.qwen.ai', path: '/unrelated', value: 'unrelated-path-refresh' },
  ]);
});

test('a refresh cookie issued by the successful sign-in is preserved', async () => {
  const result = await runLogin({ success: true, data: { token: 'fixture-token' } }, true, { staleRefresh: true, rotatedRefresh: true });
  assert.equal(result.accepted, true);
  assert.equal(result.cookies[0].value, 'new-refresh');
  assert.deepEqual(result.clearCalls, []);
});

for (const payload of [
  { success: false, data: { code: 'InvalidCredentials' } },
  { success: true, data: { id: 'fixture-user' } },
]) {
  test(`a sign-in without authentication preserves every existing cookie (${JSON.stringify(payload)})`, async () => {
    const result = await runLogin(payload, true, { staleRefresh: true });
    assert.equal(result.accepted, false);
    assert.equal(result.cookies.length, 4);
    assert.equal(result.cookies[0].value, 'old-refresh');
    assert.deepEqual(result.clearCalls, []);
  });
}
