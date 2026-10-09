import { InvalidArgumentError, Option, type Command } from 'commander';

export interface StartupOverrides { port?: number; browser?: string; quiet?: boolean }

export function addServerOptions(program: Command): Command {
  return program.option('--port <port>', 'Port to run the server on', value => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InvalidArgumentError('Port must be an integer between 1 and 65535');
    return port;
  }).addOption(new Option('--browser <browser>', 'Browser to use').choices(['chromium', 'firefox', 'webkit', 'chrome', 'edge']))
    .option('--quiet', 'Suppress startup banner');
}

export function serverOverridesFromOptions(options: Record<string, unknown>): StartupOverrides {
  return { ...(options.port !== undefined ? { port: Number(options.port) } : {}),
    ...(options.browser !== undefined ? { browser: String(options.browser) } : {}),
    ...(options.quiet === true ? { quiet: true } : {}) };
}

export function primeStartupEnvironment(overrides?: StartupOverrides): void {
  if (overrides?.port !== undefined) process.env.PORT = String(overrides.port);
  if (overrides?.browser !== undefined) process.env.BROWSER = overrides.browser;
}
