import { setTimeout as sleep } from 'node:timers/promises';

const mode = process.env.QWEN_STARTUP_MODE;
if (mode === 'import-only') {
  await import('../../index.js');
  await sleep(400);
} else if (mode === 'api') {
  const { startServer } = await import('../../api/server.js');
  if (process.env.QWEN_STARTUP_ACCOUNT === 'true') {
    const { addAccount } = await import('../../core/accounts.js');
    addAccount('startup@example.invalid', 'fixture-password', 'startup-account');
  }
  const overrides = { port: Number(process.env.QWEN_STARTUP_EXPECTED_PORT), browser: process.env.QWEN_STARTUP_EXPECTED_BROWSER, quiet: true };
  await startServer(overrides);
  if (process.env.QWEN_STARTUP_ACCOUNT === 'true') {
    const { loadAccounts } = await import('../../core/accounts.js');
    console.log('RETAINED_ACCOUNTS ' + loadAccounts().length);
  }
} else if (mode === 'api-double') {
  const { startServer } = await import('../../api/server.js');
  await Promise.all([startServer({ quiet: true }), startServer({ quiet: true })]);
}
