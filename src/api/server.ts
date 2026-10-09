import chalk from 'chalk'
import { renderBanner } from '../cli/banner.js'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { serve, type ServerType } from '@hono/node-server'
import { config, applyStartupOverrides } from '../core/config.js'
import { getRuntimeBool } from '../core/runtime-config.js'
import { sleep } from '../utils/sleep.js'
import { metrics } from '../core/metrics.js'
import { cache } from '../cache/memory-cache.js'
import { Watchdog } from '../core/watchdog.js'
import { app as modelsApp } from './models.js'
import { chatCompletions, chatCompletionsStop } from '../routes/chat.js'
import { uploadFile } from '../routes/upload.js'
import { adminApp } from './admin.js'
import { getBaseAccountId, makeAccountLaneId } from '../core/account-lanes.js'
import { hasConfiguredApiKeys, resolveUserFromAuthHeader, getUserPrincipal } from '../core/user-manager.js'

const app = new Hono()

let watchdog: Watchdog
let server: ServerType | undefined

function randomDelay(minMs: number, maxMs: number): number {
  const min = Math.max(0, Math.min(minMs, maxMs))
  const max = Math.max(min, maxMs)
  return min + Math.floor(Math.random() * (max - min + 1))
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  const limit = Math.max(1, concurrency)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await worker(items[index], index)
    }
  })
  await Promise.all(runners)
}

app.use('*', async (c, next) => {
  metrics.increment('requests.total')
  const start = Date.now()
  await next()
  const duration = Date.now() - start
  metrics.histogram('latency.request', duration)
  c.header('X-Response-Time', `${duration}ms`)

  // Accurate error accounting by status: every 4xx/5xx response is an error.
  // (Previously only >=500 counted, so waves of 429/401 looked like "success".)
  const status = c.res.status
  if (status >= 500) {
    metrics.increment('requests.errors')
    metrics.increment('requests.5xx')
  } else if (status >= 400) {
    metrics.increment('requests.errors')
    metrics.increment('requests.4xx')
  }
})

app.use('/v1/*', async (c, next) => {
  const configured = hasConfiguredApiKeys()
  const authRequired = config.authRequired || configured
  if (authRequired) {
    if (!configured) {
      return c.json({ error: 'AUTH_REQUIRED=true but no API keys are configured' }, 500)
    }
    const auth = c.req.header('Authorization')
    if (!auth) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401)
    }
    const identity = resolveUserFromAuthHeader(auth)
    if (!identity) {
      return c.json({ error: 'Invalid API key' }, 401)
    }
    ;(c as any).set('user', identity)
    ;(c as any).set('principal', getUserPrincipal(identity))
  } else {
    if (c.req.header('Authorization')) return c.json({ error: 'Invalid API key' }, 401)
    ;(c as any).set('principal', getUserPrincipal())
  }
  await next()
})

app.route('', modelsApp)
app.post('/v1/chat/completions', bodyLimit({
  maxSize: 52 * 1024 * 1024,
  onError: (c: Context) => c.json({ error: { message: 'Request body too large' } }, 413),
}), chatCompletions)
app.post('/v1/chat/completions/stop', chatCompletionsStop)
app.post('/v1/upload', uploadFile)

// Admin dashboard (served at /admin).
app.route('/admin', adminApp)

app.get('/health', async (c) => {
  const status = await watchdog?.getStatus()
  return c.json({
    status: status?.overall || 'unknown',
    timestamp: Date.now(),
    metrics: {
      cache: await cache?.getStats(),
    },
  })
})

app.get('/metrics', (c) => {
  return c.text(metrics.formatPrometheus(), {
    headers: { 'Content-Type': 'text/plain; version=0.0.4' },
  })
})

app.onError((err, c) => {
  metrics.increment('requests.errors')
  metrics.increment('requests.5xx')
  console.error('API Error:', err)
  return c.json({ error: err.message }, 500)
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

export interface ServerOverrides {
  port?: number
  browser?: string
  quiet?: boolean
}

export let serverPort = 0
export let accountCount = 0

async function initializeServer(overrides?: ServerOverrides): Promise<void> {
  applyStartupOverrides(overrides)
  await cache.connect()

  const { loadAccounts } = await import('../core/accounts.js')
  const accounts = loadAccounts()
  accountCount = accounts.length
  let warmAccounts = accounts.slice(0, 0)
  const guestOnly = getRuntimeBool('QWEN_GUEST_MODE_ONLY', config.guestModeOnly)

  if (!overrides?.quiet) {
    console.log(renderBanner({
      port: config.server.port,
      browser: config.browser.type,
      accountCount,
    }))
  }

  const { initPlaywright, initPlaywrightForAccount } = await import('../services/playwright.js')

  if (accounts.length > 0 && !guestOnly) {
    const now = Date.now()
    let activeAccounts = accounts.filter(account => !account.cooldown_until || account.cooldown_until <= now)
    let cooldownAccounts = accounts.filter(account => account.cooldown_until && account.cooldown_until > now)

    if (config.accounts.singleAccountMode) {
      const selected = activeAccounts.find(account => {
        if (config.accounts.singleAccountId) return account.id === config.accounts.singleAccountId
        if (config.accounts.singleAccountEmail) return account.email === config.accounts.singleAccountEmail
        return true
      }) || activeAccounts[0]

      activeAccounts = selected
        ? Array.from({ length: config.accounts.lanes }, (_, index) => ({
          ...selected,
          id: makeAccountLaneId(selected.id, index + 1),
          email: `${selected.email}#lane-${index + 1}`,
        }))
        : []
      cooldownAccounts = selected ? [] : cooldownAccounts

      if (selected) {
        console.log(`[Server] Single account mode enabled: ${selected.email} with ${config.accounts.lanes} isolated lane(s).`)
      }
    }

    if (cooldownAccounts.length > 0) {
      console.log(`[Server] Skipping ${cooldownAccounts.length} account(s) on cooldown during startup.`)
    }

    console.log(`[Server] Initializing ${activeAccounts.length}/${accounts.length} configured account(s) with concurrency ${config.accounts.initConcurrency}...`)
    const { getAccountCredentials } = await import('../core/accounts.js')
    await runWithConcurrency(activeAccounts, config.accounts.initConcurrency, async (account, i) => {
      const creds = getAccountCredentials(getBaseAccountId(account.id))
      if (!creds) return
      const stagger = i === 0 ? 0 : randomDelay(config.accounts.initStaggerMinMs, config.accounts.initStaggerMaxMs)
      if (stagger > 0) await sleep(stagger)
      try {
        await initPlaywrightForAccount({ ...creds, id: account.id, email: account.email }, config.browser.headless, config.browser.type)
        if (!overrides?.quiet) console.log(`${chalk.green('●')} [Account] ${account.email} → ${chalk.green('Online')}`)
      } catch (err: any) {
        console.error(`${chalk.red('●')} [Account] ${account.email} → ${chalk.red('Offline')} (${err.message})`)
      }
    })
    warmAccounts = activeAccounts
  } else if (!guestOnly) {
    await initPlaywright(config.browser.headless, config.browser.type)
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server = serve({ fetch: app.fetch, port: config.server.port, hostname: config.server.host }, info => {
      server?.removeListener('error', onError)
      serverPort = info.port
      console.log(`Server listening on http://${info.address}:${info.port}`)
      resolve()
    })
    server.once('error', onError)
  })
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  const { startSessionKeeper } = await import('../services/session-keeper.js')
  startSessionKeeper()
  watchdog = new Watchdog()
  watchdog.start()
  metrics.startCollection()
  const { startTimeSeriesSampling } = await import('../core/time-series.js')
  startTimeSeriesSampling()
  if (warmAccounts.length) {
    if (config.precapture.headersStartup) {
      console.log(`[Server] Pre-capturing Qwen headers for ${warmAccounts.length} active account(s) with concurrency ${config.precapture.concurrency}...`)
      const { getQwenHeaders } = await import('../services/playwright.js')
      runWithConcurrency(warmAccounts, config.precapture.concurrency, async (account, i) => {
        const stagger = i === 0 ? 0 : randomDelay(config.precapture.staggerMinMs, config.precapture.staggerMaxMs)
        if (stagger > 0) await sleep(stagger)
        try {
          await getQwenHeaders(false, account.id)
        } catch (err: any) {
          console.warn(`[Server] Header pre-capture failed for ${account.email}:`, err.message)
        }
      }).catch(() => {})
    }
    if (config.warmPool.startup) {
      console.log(`[Server] Pre-fetching warm chats for ${warmAccounts.length} active account(s) in background...`)
      const { warmAllPools } = await import('../services/qwen.js')
      warmAllPools(warmAccounts.map(a => a.id)).catch(() => {})
    }
  }
}

async function disposeServer(): Promise<void> {
  process.removeListener('SIGINT', onSigint)
  process.removeListener('SIGTERM', onSigterm)
  const { stopSessionKeeper } = await import('../services/session-keeper.js')
  const { stopTimeSeriesSampling } = await import('../core/time-series.js')
  stopSessionKeeper()
  watchdog?.stop()
  metrics.stopCollection()
  stopTimeSeriesSampling()
  const current = server
  server = undefined
  if (current) {
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        if ('closeAllConnections' in current) current.closeAllConnections()
        resolve()
      }, 5000)
      timeout.unref()
      current.close(() => { clearTimeout(timeout); resolve() })
    })
  }
  try {
    const { closePlaywright } = await import('../services/playwright.js')
    await closePlaywright()
  } finally {
    try { await cache.close() } finally {
      try {
        const { closeDatabase } = await import('../core/database.js')
        closeDatabase()
      } finally { serverPort = 0 }
    }
  }
}

let starting: Promise<void> | undefined
let stopping: Promise<void> | undefined

export function startServer(overrides?: ServerOverrides): Promise<void> {
  return starting ??= initializeServer(overrides).catch(async error => {
    try { await disposeServer() } catch (cleanupError) {
      console.error('Startup cleanup failed:', cleanupError)
    } finally { starting = undefined }
    throw error
  })
}

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down gracefully...`)
  return stopping ??= disposeServer().then(() => process.exit(0), error => {
    console.error('Shutdown failed:', error)
    process.exit(1)
  })
}

function onSigint(): void { void shutdown('SIGINT') }
function onSigterm(): void { void shutdown('SIGTERM') }

export { app }
