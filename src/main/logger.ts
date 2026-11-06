import fs from 'node:fs'
import path from 'node:path'
import { logsDir } from './workspace'

/** Simple rotating file logger. Never logs credentials or media contents. */
type Level = 'info' | 'warn' | 'error' | 'debug'

class Logger {
  private stream: fs.WriteStream | null = null
  private file = ''
  private maxBytes = 4 * 1024 * 1024

  private ensure(): void {
    if (this.stream) return
    try {
      const dir = logsDir()
      this.file = path.join(dir, 'clipwright.log')
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > this.maxBytes) {
        fs.renameSync(this.file, path.join(dir, 'clipwright.previous.log'))
      }
      this.stream = fs.createWriteStream(this.file, { flags: 'a' })
    } catch {
      /* logging must never crash the app */
    }
  }

  private write(level: Level, scope: string, message: string, extra?: unknown): void {
    this.ensure()
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
    this.stream?.write(`${line}\n`)
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
    return this.file
  }
}

export const log = new Logger()
