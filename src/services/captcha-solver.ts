import type { Page } from 'playwright';
import { humanDrag } from './human-behavior.js';
import { acquireMouseLock, releaseMouseLock } from './mouse-lock.js';
import { sleep, abortable } from '../utils/sleep.js';
import { config } from '../core/config.js';

export const BAXIA_IFRAME_SELECTOR = 'iframe#baxia-dialog-content, iframe[src*="_____tmd_____/punish"]';

/**
 * Solves the Baxia slidein captcha inside an iframe on the page.
 */
export async function solveBaxiaCaptcha(page: Page, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (page.isClosed?.()) return false;
  const deadline = Date.now() + Math.min(15000, config.timeouts.headers);
  const iframeLocator = page.locator(BAXIA_IFRAME_SELECTOR).first();

  if (!(await iframeLocator.isVisible().catch(() => false))) {
    return false;
  }

  while (!acquireMouseLock('captcha-solver')) {
    signal?.throwIfAborted();
    if (page.isClosed?.() || Date.now() >= deadline) return false;
    console.log('[Captcha] Waiting for mouse lock to be released before solving...');
    await (signal ? abortable(sleep(200), signal) : sleep(200));
  }

  console.log('[Captcha] Baxia captcha iframe detected. Attempting to solve...');

  try {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      signal?.throwIfAborted();
      if (page.isClosed?.() || Date.now() >= deadline) return false;
      const frame = page.frameLocator(BAXIA_IFRAME_SELECTOR);
      const slider = frame.locator('#nc_1_n1z, .btn_slide');

      // Wait for the slider element to be visible inside the frame
      await slider.waitFor({ state: 'visible', timeout: Math.max(1, Math.min(5000, deadline - Date.now())) });

      const sliderBox = await slider.boundingBox();
      if (!sliderBox) {
        console.warn(`[Captcha] Attempt ${attempt}: Slider bounding box not found.`);
        await sleep(1000);
        continue;
      }

      const track = frame.locator('#nc_1_n1t, .nc_scale');
      const trackBox = await track.boundingBox();
      const dragDistance = trackBox ? (trackBox.width - sliderBox.width) : 260;

      const startX = sliderBox.x + sliderBox.width / 2;
      const startY = sliderBox.y + sliderBox.height / 2;

      console.log(`[Captcha] Attempt ${attempt}: Dragging slider from x=${startX}, y=${startY} by ${dragDistance}px`);
      
      const endX = startX + dragDistance;
      const endY = startY;
      
      await humanDrag(page, startX, startY, endX, endY);
      signal?.throwIfAborted();
      if (page.isClosed?.()) return false;

      // Wait a moment for the page to register success and close the dialog
      await sleep(2000);

      // Verify if the captcha is solved: the iframe should be hidden/gone, or we see a success element
      const isGone = !(await iframeLocator.isVisible());
      if (isGone) {
        console.log('[Captcha] Challenge dialog closed; upstream confirmation is still required.');
        return true;
      }

      const okElement = frame.locator('.btn_ok, .nc_ok');
      const isOkVisible = await okElement.isVisible().catch(() => false);
      if (isOkVisible) {
        console.log('[Captcha] Verification UI reports OK; upstream confirmation is still required.');
        await sleep(1500); // Wait for transition
        return true;
      }

      console.warn(`[Captcha] Attempt ${attempt} did not solve the captcha. Retrying...`);
      await sleep(1000);
    } catch (err: any) {
      signal?.throwIfAborted();
      if (page.isClosed?.()) return false;
      console.error(`[Captcha] Error during attempt ${attempt}:`, err.message);
      await sleep(1000);
    }
  }

  console.error('[Captcha] Failed to solve Baxia captcha after 3 attempts.');
  return false;
  } finally {
    releaseMouseLock('captcha-solver');
  }
}

/**
 * Starts a background loop to watch for and solve Baxia captchas on the page.
 * Returns an object with a stop() method to stop the loop.
 */
export function startCaptchaWatcher(page: Page, timeoutMs: number, signal?: AbortSignal) {
  let finished = false;
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const promise = (async () => {
    const start = Date.now();
    while (!finished && !combined.aborted && (Date.now() - start < timeoutMs)) {
      try {
        if (page.isClosed()) break;
        const hasCaptcha = await page.locator(BAXIA_IFRAME_SELECTOR).first().isVisible().catch(() => false);
        if (hasCaptcha) {
          console.log('[Captcha] Baxia captcha detected on page. Solving...');
          await solveBaxiaCaptcha(page, combined);
        }
      } catch {
        // ignore
      }
      await sleep(1000);
    }
  })();

  return {
    stop: () => {
      finished = true;
      controller.abort();
    },
    promise
  };
}
