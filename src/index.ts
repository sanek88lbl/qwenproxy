import 'dotenv/config'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Command } from 'commander'
import { addServerOptions, primeStartupEnvironment, serverOverridesFromOptions, type StartupOverrides } from './cli/server-options.js'

let running: Promise<void> | undefined

export function run(overrides?: StartupOverrides): Promise<void> {
  return running ??= (async () => {
    primeStartupEnvironment(overrides)
    const server = await import('./api/server.js')
    await server.startServer({ ...overrides, quiet: overrides?.quiet ?? Boolean(process.stdin.isTTY && process.stdout.isTTY) })
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const { tuiCommand } = await import('./cli/commands/tui.js')
      await tuiCommand({ port: server.serverPort }).catch(console.error)
    }
  })().catch(error => { running = undefined; throw error })
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const program = addServerOptions(new Command().name('qwenproxy'))
  program.action(async () => { await run(serverOverridesFromOptions(program.opts())) })
  program.parseAsync().catch(error => { console.error('Failed to start:', error); process.exit(1) })
}
