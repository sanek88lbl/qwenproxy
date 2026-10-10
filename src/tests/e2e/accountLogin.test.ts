import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const cwd = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-browser-login-'));
process.chdir(directory);
const { getActivePage, setActivePage, loginToQwen, accountContexts, accountPages, accountHeaderCaches, cookieCaches, cachedUserAgents } = await import('../../services/browser-manager.js');
const { addAccount } = await import('../../core/accounts.js');
const { markAccountNotReady, isAccountReady } = await import('../../core/account-manager.js');
const { getQwenHeaders } = await import('../../services/header-interceptor.js');
const { config } = await import('../../core/config.js');
const { closeDatabase } = await import('../../core/database.js');
after(() => { closeDatabase(); process.chdir(cwd); fs.rmSync(directory, { recursive: true, force: true }); });

for (const { rotateOnSignIn, refreshHeaders } of [
  { rotateOnSignIn: false, refreshHeaders: false },
  { rotateOnSignIn: true, refreshHeaders: false },
  { rotateOnSignIn: false, refreshHeaders: true },
]) {
  test(`browser login recovers an expired refresh session and preserves neighboring accounts (signin rotation=${rotateOnSignIn}, header refresh=${refreshHeaders})`, { timeout: 15000 }, async t => {
    let settingsUpdated: (() => void) | undefined;
    const updateComplete = new Promise<void>(resolve => { settingsUpdated = resolve; });
    t.mock.method(globalThis, 'fetch', async (input: unknown) => {
      assert.equal(String(input), 'https://chat.qwen.ai/api/v2/users/user/settings/update');
      settingsUpdated!();
      return new Response('{}', { status: 200 });
    });
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const adjacent = await browser.newContext();
    const third = await browser.newContext();
    const previousPage = getActivePage();
    const previousTimeout = config.timeouts.page;
    config.timeouts.page = 1500;
    const email = 'browser-login@example.test';
    const account = refreshHeaders ? addAccount(email, 'fixture-password') : undefined;
    const accessToken = `fixture.${Buffer.from(JSON.stringify({ type: 'access_token', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
    let signIns = 0;
    let rejectedRefreshes = 0;
    const cookie = { name: 'refresh_token', value: 'revoked-refresh', domain: '.qwen.ai', path: '/', secure: true, httpOnly: true, sameSite: 'None' as const };
    await context.addCookies([cookie, { ...cookie, name: 'token', value: 'legacy-session' }, { ...cookie, domain: 'unrelated.example.test', value: 'unrelated-session' }]);
    await adjacent.addCookies([{ ...cookie, value: 'second-session' }]);
    await third.addCookies([{ ...cookie, value: 'third-session' }]);
    await context.addInitScript(() => { localStorage.setItem('fixture-preference', 'preserved'); });
    for (const other of [adjacent, third]) {
      await other.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<html>adjacent account</html>' }));
    }
    const adjacentPage = await adjacent.newPage();
    const thirdPage = await third.newPage();
    await adjacentPage.goto('https://chat.qwen.ai/');
    await thirdPage.goto('https://chat.qwen.ai/');
    const adjacentCookies = await adjacent.cookies();
    const thirdCookies = await third.cookies();
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const headers: Record<string, string> = {
        'access-control-allow-origin': 'https://chat.qwen.ai',
        'access-control-allow-credentials': 'true',
        'access-control-allow-headers': 'authorization,content-type',
      };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (url.pathname === '/api/v2/auths/signin') {
        signIns++;
        const credentials = request.postDataJSON();
        assert.equal(credentials.email, email);
        if (rotateOnSignIn) headers['set-cookie'] = 'refresh_token=fresh-refresh; Domain=.qwen.ai; Path=/; Secure; HttpOnly; SameSite=None';
        return route.fulfill({ headers, json: { success: true, data: { token: 'legacy-token', expires_at: Math.floor(Date.now() / 1000) + 2592000 } } });
      }
      if (url.hostname === 'auth.qwen.ai' && url.pathname === '/api/v2/auths/refresh') {
        const revoked = (await request.allHeaders()).cookie?.includes('refresh_token=revoked-refresh');
        if (revoked) rejectedRefreshes++;
        else headers['set-cookie'] = 'refresh_token=fresh-refresh; Domain=.qwen.ai; Path=/; Secure; HttpOnly; SameSite=None';
        return route.fulfill({ headers, json: revoked
          ? { success: false, data: { code: 'Unauthorized' } }
          : { success: true, data: { token: accessToken } } });
      }
      if (url.hostname === 'auth.qwen.ai' && url.pathname === '/api/v2/auths/') {
        const authenticated = (await request.allHeaders()).authorization === `Bearer ${accessToken}`;
        return route.fulfill({ headers, json: authenticated
          ? { success: true, data: { id: 'fixture-user', email } }
          : { success: false, data: { code: 'Unauthorized' } } });
      }
      if (url.hostname === 'chat.qwen.ai' && url.pathname === '/') {
        return route.fulfill({ contentType: 'text/html', body: `<html><script>
          (async () => {
            const response = await fetch('https://auth.qwen.ai/api/v2/auths/refresh', { credentials: 'include' });
            const payload = await response.json();
            if (payload.success) localStorage.setItem('token', payload.data.token);
            else localStorage.removeItem('token');
            await fetch('https://auth.qwen.ai/api/v2/auths/', {
              credentials: 'include', headers: { authorization: 'Bearer ' + localStorage.getItem('token') }
            });
            if (payload.success) {
              const input = document.createElement('textarea'); input.className = 'message-input-textarea'; document.body.append(input);
              const button = document.createElement('button'); button.className = 'send-button'; button.textContent = 'Send'; document.body.append(button);
              button.onclick = () => fetch('https://chat.qwen.ai/api/v2/chat/completions', {
                method: 'POST', headers: { 'content-type': 'application/json', 'bx-ua': 'fixture-bx-ua' },
                body: JSON.stringify({ chat_id: 'fixture-header-chat', parent_id: null })
              }).catch(() => {});
            }
          })();
        </script></html>` });
      }
      if (url.hostname === 'chat.qwen.ai' && url.pathname === '/auth') return route.fulfill({ contentType: 'text/html', body: '<html><input type="email"></html>' });
      return route.abort();
    });
    const page = await context.newPage();
    setActivePage(refreshHeaders ? adjacentPage : page);
    try {
      if (account) {
        await page.goto('https://chat.qwen.ai/auth');
        accountPages.set(account.id, page); accountContexts.set(account.id, context);
        const captured = await getQwenHeaders(true, account.id);
        assert.equal(captured.chatSessionId, 'fixture-header-chat');
        assert.equal(captured.headers['bx-ua'], 'fixture-bx-ua');
        assert.equal(isAccountReady(account.id), true);
        await updateComplete;
      } else {
        assert.equal(await loginToQwen(email, 'fixture-password'), true);
      }
      assert.equal(signIns, 1);
      assert.equal(rejectedRefreshes, 0);
      const saved = await context.cookies();
      assert.equal(saved.find(c => c.name === 'refresh_token' && c.domain === '.qwen.ai')?.value, 'fresh-refresh');
      assert.equal(saved.find(c => c.name === 'token')?.value, 'legacy-session');
      assert.equal(saved.find(c => c.domain === 'unrelated.example.test')?.value, 'unrelated-session');
      assert.equal(await page.evaluate(() => localStorage.getItem('fixture-preference')), 'preserved');
      assert.deepEqual(await adjacent.cookies(), adjacentCookies);
      assert.deepEqual(await third.cookies(), thirdCookies);
      assert.equal(adjacentPage.isClosed(), false);
      assert.equal(thirdPage.isClosed(), false);
      assert.equal(await adjacentPage.locator('body').innerText(), 'adjacent account');
      assert.equal(await thirdPage.locator('body').innerText(), 'adjacent account');
    } finally {
      if (account) {
        accountPages.delete(account.id); accountContexts.delete(account.id); accountHeaderCaches.delete(account.id);
        cookieCaches.delete(account.id); cachedUserAgents.delete(account.id); markAccountNotReady(account.id);
      }
      setActivePage(previousPage);
      config.timeouts.page = previousTimeout;
      await browser.close();
    }
  });
}
