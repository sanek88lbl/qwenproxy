import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { solveBaxiaCaptcha } from '../../services/captcha-solver.js';

for (const scenario of ['closed-page', 'loading-indicator'] as const) {
  test(`captcha does not report successful verification for ${scenario}`, { timeout: 10000 }, async t => {
    const realTimer = setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback: (...args: any[]) => void, ms?: number, ...args: any[]) => realTimer(callback, ms && ms <= 2000 ? 0 : ms, ...args));
    let closed = false;
    const iframe = { first: () => iframe, isVisible: async () => { if (closed) throw new Error('Page closed'); return true; } };
    const frame = { locator: (selector: string) => ({
      waitFor: async () => {},
      boundingBox: async () => ({ x: 0, y: 0, width: selector.includes('nc_scale') ? 300 : 40, height: 40 }),
      isVisible: async () => selector.includes('nc-loading-circle'),
    }) };
    const page = {
      isClosed: () => closed, locator: () => iframe, frameLocator: () => frame,
      mouse: { move: async () => {}, down: async () => {}, up: async () => { if (scenario === 'closed-page') closed = true; } },
    } as unknown as Page;
    assert.equal(await solveBaxiaCaptcha(page), false);
  });
}
