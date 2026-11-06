import fs from 'node:fs'
import path from 'node:path'
import { logsDir } from './workspace'

/**
 * Simple rotating file logger. Never logs credentials or media contents.
 *
 * Lines are appended synchronously: log volume is low (a few lines per action,
 * not per frame) and a synchronous append means the last line before a crash is
 * actually on disk — which is the whole point of a diagnostic log. The file is
 * re-resolved on every write so changing the workspace in Settings moves logging
 * with it instead of leaving it pinned to the old folder.
 */
type Level = 'info' | 'warn' | 'error' | 'debug'

const MAX_BYTES = 4 * 1024 * 1024
const ROTATE_CHECK_EVERY = 64

class Logger {
  private dir = ''
  private file = ''
  private writes = 0

  /** Resolve the active log file, rotating it when it has grown too large. */
  private target(): string | null {
    try {
      const dir = logsDir()
      if (dir !== this.dir) {
        this.dir = dir
        this.file = path.join(dir, 'clipwright.log')
        this.writes = 0
      }
      this.writes += 1
      if (this.writes % ROTATE_CHECK_EVERY === 1 && fs.existsSync(this.file)) {
        if (fs.statSync(this.file).size > MAX_BYTES) {
          fs.renameSync(this.file, path.join(dir, 'clipwright.previous.log'))
        }
      }
      return this.file
    } catch {
      return null
    }
  }

  private write(level: Level, scope: string, message: string, extra?: unknown): void {
    const stamp = new Date().toISOString()
    let line = `${stamp} [${level.toUpperCase()}] ${scope}: ${message}`
    if (extra !== undefined) {
      try {
        line += ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`
      } catch {
        line += ' [unserialisable]'
      }
    }
    // eslint-disable-next-line no-console
    if (level === 'error') console.error(line)
    else console.log(line)
    /*
     * Buffered, flushed on a timer. This used to be an appendFileSync on the main
     * thread for every line — including every mirrored renderer console message,
     * hundreds of which arrived during export rendering. A write that fails is
     * dropped (logging must never break the operation that logged).
     */
    this.buffer.push(`${line}\n`)
    if (this.buffer.length >= 200) this.flush()
    else this.scheduleFlush()
  }

  private buffer: string[] = []
  private flushTimer: NodeJS.Timeout | null = null

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => this.flush(), 500)
    // Never hold the process open just for a log line.
    this.flushTimer.unref?.()
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.buffer.length) return
    const pending = this.buffer.join('')
    this.buffer = []
    try {
      const file = this.target()
      if (file) fs.appendFileSync(file, pending)
    } catch {
      /* ignore */
    }
  }

  info(scope: string, message: string, extra?: unknown): void {
    this.write('info', scope, message, extra)
  }
  warn(scope: string, message: string, extra?: unknown): void {
    this.write('warn', scope, message, extra)
  }
  error(scope: string, message: string, extra?: unknown): void {
    this.write('error', scope, message, extra)
  }
  debug(scope: string, message: string, extra?: unknown): void {
    if (process.env.CLIPWRIGHT_DEBUG) this.write('debug', scope, message, extra)
  }
  logPath(): string {
    return this.file || path.join(this.dir || '', 'clipwright.log')
  }
}

let instance: Logger | null = null

export function logger(): Logger {
  if (!instance) instance = new Logger()
  return instance
}

/** Convenience facade used across the main process. */
export const log = {
  info: (scope: string, message: string, extra?: unknown) => logger().info(scope, message, extra),
  warn: (scope: string, message: string, extra?: unknown) => logger().warn(scope, message, extra),
  error: (scope: string, message: string, extra?: unknown) => logger().error(scope, message, extra),
  debug: (scope: string, message: string, extra?: unknown) => logger().debug(scope, message, extra),
  /** Write any buffered lines immediately (log viewer, shutdown, crash report). */
  flush: () => logger().flush(),
  path: () => logger().logPath()
}
