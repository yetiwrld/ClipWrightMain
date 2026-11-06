import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const FONT_DIR = path.resolve(__dirname, '..', 'resources', 'fonts')

export function tmpDir(prefix = 'cwtest'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

export function ffmpegAvailable(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function ffmpeg(args: string[], timeout = 240_000): string {
  return execFileSync('ffmpeg', args, {
    encoding: 'utf8',
    timeout,
    stdio: 'pipe',
    maxBuffer: 64 * 1024 * 1024
  })
}

/** Run ffmpeg and capture raw output bytes (for pixel assertions). */
export function ffmpegRaw(args: string[], timeout = 240_000): Buffer {
  return execFileSync('ffmpeg', args, {
    timeout,
    stdio: 'pipe',
    maxBuffer: 256 * 1024 * 1024
  }) as Buffer
}

/** Probe a file into a flat object using ffmpeg's banner (no ffprobe needed). */
export function probe(file: string): {
  width?: number
  height?: number
  fps?: number
  durationMs?: number
  hasAudio: boolean
  codec?: string
} {
  return parseBanner(probeStderr(file))
}

export function probeStderr(file: string): string {
  try {
    // ffmpeg writes the input banner to stderr and exits non-zero (no output file).
    return String(
      execFileSync('ffmpeg', ['-hide_banner', '-i', file], { encoding: 'utf8', stdio: 'pipe' })
    )
  } catch (error: any) {
    const stderr = String(error.stderr ?? '')
    const stdout = String(error.stdout ?? '')
    return stderr || stdout
  }
}

export function parseBanner(banner: string) {
  const dur = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(banner)
  const video = banner.split('\n').find((l) => /Stream #.*Video:/.test(l))
  const audio = banner.split('\n').find((l) => /Stream #.*Audio:/.test(l))
  const size = video ? /,\s*(\d{2,5})x(\d{2,5})/.exec(video) : null
  const fps = video ? /,\s*([\d.]+)\s*(?:fps|tbr)/.exec(video) : null
  const codec = video ? /Video:\s*([a-z0-9_]+)/i.exec(video) : null
  return {
    width: size ? Number(size[1]) : undefined,
    height: size ? Number(size[2]) : undefined,
    fps: fps ? Number(fps[1]) : undefined,
    durationMs: dur
      ? Math.round((Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])) * 1000)
      : undefined,
    hasAudio: Boolean(audio),
    codec: codec?.[1]
  }
}

/** Mean RGB of a frame region — used to assert that pixels really changed. */
export function frameStats(file: string, atSec: number, scale = '16:16'): { r: number; g: number; b: number; a?: number } {
  const raw = execFileSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-ss', String(atSec), '-i', file, '-vf', `scale=${scale}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { timeout: 120_000, maxBuffer: 1024 * 1024 * 8 }
  ) as Buffer
  let r = 0
  let g = 0
  let b = 0
  const n = raw.length / 3
  for (let i = 0; i < n; i++) {
    r += raw[i * 3]
    g += raw[i * 3 + 1]
    b += raw[i * 3 + 2]
  }
  return { r: r / n, g: g / n, b: b / n }
}

/** Mean RGB of an arbitrary crop filter region of one frame. */
export function cropStats(file: string, atSec: number, crop: string): { r: number; g: number; b: number } {
  const raw = execFileSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-ss', String(atSec), '-i', file, '-vf', `${crop},scale=16:16`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { timeout: 120_000, maxBuffer: 1024 * 1024 * 8 }
  ) as Buffer
  let r = 0
  let g = 0
  let b = 0
  const n = raw.length / 3
  for (let i = 0; i < n; i++) {
    r += raw[i * 3]
    g += raw[i * 3 + 1]
    b += raw[i * 3 + 2]
  }
  return { r: r / n, g: g / n, b: b / n }
}

export function fileSize(file: string): number {
  return fs.statSync(file).size
}
