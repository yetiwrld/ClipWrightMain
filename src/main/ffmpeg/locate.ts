import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * FFmpeg / FFprobe discovery.
 *
 * 1. User-specified paths in settings (advanced).
 * 2. Bundled binaries shipped with the installer (resources/ffmpeg).
 * 3. System PATH.
 *
 * The Windows build bundles ffmpeg.exe + ffprobe.exe so clean machines work
 * without extra installs. ffprobe is optional: if it is missing we fall back to
 * `ffmpeg -i` output parsing, which still yields duration/streams/resolution.
 */
export interface FFTools {
  ffmpeg: string | null
  ffprobe: string | null
  version?: string
  source: 'bundled' | 'path' | 'custom' | 'none'
}

let cached: FFTools | null = null

function bundledDir(): string {
  // process.resourcesPath points at the app's resources folder in a packaged build.
  const base = app?.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources')
  return path.join(base, 'ffmpeg')
}

function existsExec(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

export function findFFmpeg(customPath?: string): FFTools {
  if (cached && !customPath) return cached
  const exe = process.platform === 'win32' ? '.exe' : ''
  const candidates: { ffmpeg: string; ffprobe: string; source: FFTools['source'] }[] = []

  if (customPath) {
    const probe = path.join(path.dirname(customPath), `ffprobe${exe}`)
    candidates.push({ ffmpeg: customPath, ffprobe: probe, source: 'custom' })
  }
  candidates.push({
    ffmpeg: path.join(bundledDir(), `ffmpeg${exe}`),
    ffprobe: path.join(bundledDir(), `ffprobe${exe}`),
    source: 'bundled'
  })
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of pathDirs) {
    candidates.push({
      ffmpeg: path.join(dir, `ffmpeg${exe}`),
      ffprobe: path.join(dir, `ffprobe${exe}`),
      source: 'path'
    })
  }

  for (const candidate of candidates) {
    if (existsExec(candidate.ffmpeg)) {
      cached = {
        ffmpeg: candidate.ffmpeg,
        ffprobe: existsExec(candidate.ffprobe) ? candidate.ffprobe : null,
        source: candidate.source
      }
      return cached
    }
  }
  cached = { ffmpeg: null, ffprobe: null, source: 'none' }
  return cached
}

/** Some distributables ship a single binary that answers to both names. */
export function ffprobeUsable(): boolean {
  const { ffprobe, ffmpeg } = findFFmpeg()
  return Boolean(ffprobe || ffmpeg)
}

export function ffmpegPath(): string {
  const tools = findFFmpeg()
  if (!tools.ffmpeg) {
    throw new Error(
      'FFmpeg was not found. Install FFmpeg or place ffmpeg.exe in the application resources folder to enable media processing.'
    )
  }
  return tools.ffmpeg
}

export function ffprobePath(): string | null {
  const tools = findFFmpeg()
  return tools.ffprobe ?? tools.ffmpeg
}
