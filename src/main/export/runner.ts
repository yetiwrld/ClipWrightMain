import fs from 'node:fs'
import path from 'node:path'
import { runProcess } from '../ffmpeg/runner'
import { ffmpegPath } from '../ffmpeg/locate'

/**
 * Thin wrapper around ffmpeg used by the renderer. Keeps a per-job log file so
 * failed exports can be diagnosed and so the UI can show real error detail.
 */
export interface RunnerOptions {
  signal?: AbortSignal
  hardware?: boolean
  logDir?: string
}

export class FFmpegRunner {
  readonly logPath: string
  private chunks: string[] = []

  constructor(private opts: RunnerOptions = {}) {
    const dir = opts.logDir ?? path.join(process.cwd(), 'Logs')
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* ignore */
    }
    this.logPath = path.join(dir, `render-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
  }

  get ffmpegPath(): string {
    return ffmpegPath()
  }

  log(message: string): void {
    const line = `${new Date().toISOString()} ${message}`
    this.chunks.push(line)
    if (this.chunks.length > 400) this.flush()
  }

  private flush(): void {
    try {
      fs.appendFileSync(this.logPath, `${this.chunks.join('\n')}\n`)
      this.chunks = []
    } catch {
      /* ignore */
    }
  }

  async encode(args: string[]): Promise<{ ok: boolean; error?: string }> {
    this.log(`ffmpeg ${args.join(' ')}`)
    const result = await runProcess(this.ffmpegPath, args, {
      timeoutMs: 120 * 60_000,
      signal: this.opts.signal
    })
    this.flush()
    if (result.code !== 0) {
      const lines = result.stderr.split('\n').filter((l) => l.trim())
      return { ok: false, error: lines.slice(-4).join(' | ').slice(0, 600) }
    }
    return { ok: true }
  }
}
