import { EventEmitter } from 'events'
import os from 'os'
import { config } from './config.js'
import { metrics } from './metrics.js'
import { getStreamRegistry, abortStream } from './stream-registry.js'

interface HealthStatus {
  ram: 'ok' | 'warning' | 'critical'
  streams: 'ok' | 'congested' | 'blocked'
  overall: 'healthy' | 'degraded' | 'unhealthy'
}

export class Watchdog extends EventEmitter {
  private checkInterval: NodeJS.Timeout | null = null
  private consecutiveFailures: number = 0
  private recoveryInProgress: boolean = false

  start(): void {
    if (this.checkInterval) return

    this.checkInterval = setInterval(() => {
      this.performHealthCheck().catch(error => {
        this.emit('check:error', error)
        this.consecutiveFailures++
      })
    }, config.watchdog.checkInterval)

    this.emit('started')
  }

  private async performHealthCheck(): Promise<void> {
    const status: HealthStatus = {
      ram: this.checkRAM(),
      streams: this.checkStreams(),
      overall: 'healthy',
    }

    status.overall = this.calculateOverall(status)

    if (status.overall === 'unhealthy') {
      this.consecutiveFailures++
      if (this.consecutiveFailures >= config.watchdog.consecutiveFailuresThreshold && !this.recoveryInProgress) {
        await this.triggerRecovery(status)
      }
    } else {
      this.consecutiveFailures = 0
    }

    this.emit('health:check', status)
    metrics.gauge('watchdog.ram.status', status.ram === 'ok' ? 0 : status.ram === 'warning' ? 1 : 2)
    metrics.gauge('watchdog.overall', status.overall === 'healthy' ? 0 : status.overall === 'degraded' ? 1 : 2)
  }

  private checkRAM(): 'ok' | 'warning' | 'critical' {
    const mem = process.memoryUsage()
    const systemTotal = os.totalmem()
    // Real memory footprint = RSS (heap alone is misleading). % of system RAM.
    const usagePercent = systemTotal > 0 ? (mem.rss / systemTotal) * 100 : 0

    if (usagePercent > config.watchdog.ram.criticalThreshold) return 'critical'
    if (usagePercent > config.watchdog.ram.warningThreshold) return 'warning'
    return 'ok'
  }

  private checkStreams(): 'ok' | 'congested' | 'blocked' {
    const activeStreams = metrics.get('streams.active')?.value || 0
    if (activeStreams > config.watchdog.streams.criticalThreshold) return 'blocked'
    if (activeStreams > config.watchdog.streams.warningThreshold) return 'congested'
    return 'ok'
  }

  private calculateOverall(status: HealthStatus): 'healthy' | 'degraded' | 'unhealthy' {
    const critical = ['critical', 'blocked']
    const warning = ['warning', 'congested']

    const values = Object.values(status).filter(v => typeof v === 'string') as string[]
    if (values.some(v => critical.includes(v))) return 'unhealthy'
    if (values.some(v => warning.includes(v))) return 'degraded'
    return 'healthy'
  }

  private async triggerRecovery(status: HealthStatus): Promise<void> {
    if (this.recoveryInProgress) return
    this.recoveryInProgress = true

    this.emit('recovery:start', status)
    metrics.increment('watchdog.recovery.triggered')

    try {
      if (status.ram === 'critical') {
        await this.recoverRAM()
      }
      if (status.streams === 'blocked') {
        await this.recoverStreams()
      }

      this.emit('recovery:complete')
      metrics.increment('watchdog.recovery.success')
    } catch (error: any) {
      this.emit('recovery:error', error)
      metrics.increment('watchdog.recovery.failed')
    } finally {
      this.recoveryInProgress = false
    }
  }

  private async recoverRAM(): Promise<void> {
    if (global.gc) {
      global.gc()
    } else {
      console.warn('[Watchdog] global.gc() unavailable — start with --expose-gc for effective RAM recovery')
    }
    await new Promise(resolve => setTimeout(resolve, 100))
    this.emit('recovery:ram:freed')
  }

  private async recoverStreams(): Promise<void> {
    const streams = getStreamRegistry()
    const now = Date.now()
    let aborted = 0
    for (const [id, entry] of streams.entries()) {
      if (entry.createdAt && now - entry.createdAt > config.timeouts.streamIdle) {
        try {
          if (await abortStream(id)) aborted++
        } catch {
          console.warn(`[Watchdog] Stream ${id} remains registered: transport teardown failed`)
        }
      }
    }
    if (aborted > 0) {
      console.warn(`[Watchdog] Aborted ${aborted} stale stream(s) during recovery`)
    }
    this.emit('recovery:streams:throttled')
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }
    this.emit('stopped')
  }

  getStatus(): Promise<HealthStatus> {
    const status: HealthStatus = {
      ram: this.checkRAM(),
      streams: this.checkStreams(),
      overall: 'healthy',
    }
    status.overall = this.calculateOverall(status)
    return Promise.resolve(status)
  }
}
