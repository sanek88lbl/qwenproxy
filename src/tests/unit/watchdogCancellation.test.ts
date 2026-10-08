import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Watchdog } from '../../core/watchdog.js';
import { config } from '../../core/config.js';
import { registerStream, getStream, abortStream } from '../../core/stream-registry.js';
import { manageQwenStream } from '../../services/stream-lifecycle.js';

test('watchdog retains an unconfirmed teardown and can retry it before releasing ownership', async () => {
  const watchdog = new Watchdog();
  const controller = new AbortController();
  let aborts = 0;
  let releases = 0;
  const managed = manageQwenStream(new ReadableStream<Uint8Array>(), controller, 10000, 'watchdog fixture', async () => {
    if (++aborts === 1) throw new Error('fixture transport remains unconfirmed');
  }, () => { releases++; }, () => {});
  registerStream('watchdog-fixture', { abortController: controller, accountId: 'fixture', uiSessionId: 'fixture-chat',
    targetResponseId: '', headers: {}, stopToken: 'fixture', cancel: managed.cancel, cleanup: managed.cancel,
    createdAt: Date.now() - config.timeouts.streamIdle - 100 });
  const entry = getStream('watchdog-fixture');
  const recover = Reflect.get(watchdog, 'recoverStreams') as () => Promise<void>;
  try {
    await recover.call(watchdog);
    assert.equal(getStream('watchdog-fixture'), entry);
    assert.equal(releases, 0);
    await recover.call(watchdog);
    assert.equal(getStream('watchdog-fixture'), undefined);
    assert.equal(releases, 1);
    assert.equal(aborts, 2);
  } finally {
    await managed.cancel('fixture cleanup').catch(() => {});
    await abortStream('watchdog-fixture').catch(() => {});
  }
});
