/**
 * Helpers shared by the IPC handlers: workspace access, capability probing and
 * safe file dialogs. Kept separate so handlers.ts stays readable.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { workspaceInfo, workspaceRoot, setWorkspaceRoot, workspaceLayout } from './workspace'
import { findFFmpeg, ffmpegPath } from './ffmpeg/locate'
import { ffmpegVersion, availableEncoders } from './ffmpeg/probe'
import { installedModels, detectRuntimes } from './ai/models'
import { vault } from './vault'
import { modelPath } from './ai/models'
import type { CapabilityReport } from '@shared/types'
import { log } from './logger'

export { workspaceInfo, workspaceRoot, setWorkspaceRoot, workspaceLayout }

/** Look for an optional external tool on PATH or next to the app. */
function findExecutable(name: string): boolean {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const candidates = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const local = [path.join(process.cwd(), exe), path.join(path.dirname(process.execPath), exe)]
  return [...local, ...candidates.map((dir) => path.join(dir, exe))].some((candidate) => {
    try {
      return fs.statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}

export function importsRoot(): string {
  const dir = path.join(workspaceRoot(), 'Imports')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

let cachedCapabilities: CapabilityReport | null = null

export async function probeCapabilities(force = false): Promise<CapabilityReport> {
  if (cachedCapabilities && !force) return cachedCapabilities
  const tools = findFFmpeg()
  const encoders = tools.ffmpeg ? await availableEncoders() : []
  const runtimes = await detectRuntimes(force)
  const whisperModel = modelPath('ggml-base.en') ?? modelPath('ggml-tiny.en')
  const report: CapabilityReport = {
    ffmpegPath: tools.ffmpeg,
    ffmpegVersion: tools.ffmpeg ? await ffmpegVersion() : undefined,
    ffprobePath: tools.ffprobe,
    hardwareEncoders: encoders.filter((e) => /nvenc|qsv|amf|vaapi|videotoolbox/.test(e)),
    hardwareDecode: encoders.filter((e) => /cuvid|qsv|d3d11/.test(e)),
    whisperAvailable: runtimes.whisper.available && Boolean(whisperModel),
    whisperNote: !runtimes.whisper.available
      ? 'The offline speech engine (whisper.cpp) is not installed. Online transcription still works with your own API key.'
      : !whisperModel
        ? 'whisper.cpp is installed but no speech model has been downloaded yet.'
        : `Ready — ${path.basename(whisperModel)} via ${runtimes.whisper.source}`,
    online: await isOnline(),
    platform: process.platform,
    arch: process.arch,
    ffmpeg: Boolean(tools.ffmpeg),
    ffprobe: Boolean(tools.ffprobe),
    nvenc: encoders.some((e) => /nvenc/.test(e)),
    ytdlp: findExecutable('yt-dlp'),
    cpuThreads: os.cpus().length,
    totalMemoryBytes: os.totalmem()
  }
  cachedCapabilities = report
  log.info('app', 'capabilities', {
    ffmpeg: tools.source,
    encoders: report.hardwareEncoders.join(',') || 'none',
    whisper: report.whisperAvailable
  })
  return report
}

export async function isOnline(): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2500)
    const response = await fetch('https://api.github.com/zen', {
      signal: controller.signal,
      headers: { 'user-agent': 'ClipwrightStudio' }
    })
    clearTimeout(timer)
    return response.ok
  } catch {
    return false
  }
}

export function invalidateCapabilities(): void {
  cachedCapabilities = null
}

export function assertWritableDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, '.clipwright-write-test')
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
  } catch {
    throw new Error(`This folder cannot be written to: ${dir}`)
  }
}

export function safeJsonRead<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

export function fontDir(): string {
  const bundled = app_resources_dir()
  const candidate = path.join(bundled, 'fonts')
  if (fs.existsSync(candidate)) return candidate
  return path.join(app_resources_dir(), 'fonts')
}

function app_resources_dir(): string {
  const base = process.resourcesPath ?? path.join(process.cwd(), 'resources')
  return base
}

export { ffmpegPath, installedModels, vault }

/**
 * Read the tail of the active log file for the Settings → Logs viewer.
 *
 * Reads a bounded slice from the end instead of loading the whole file, so a
 * multi-megabyte log cannot stall the UI thread or blow up IPC.
 */
export function readLogTail(lines = 400): { text: string; file: string; bytes: number } {
  const dir = workspaceLayout().logs
  const file = path.join(dir, 'clipwright.log')
  if (!fs.existsSync(file)) return { text: '', file, bytes: 0 }
  const size = fs.statSync(file).size
  const chunk = Math.min(size, 512 * 1024)
  const handle = fs.openSync(file, 'r')
  const buffer = Buffer.alloc(chunk)
  try {
    fs.readSync(handle, buffer, 0, chunk, size - chunk)
  } finally {
    fs.closeSync(handle)
  }
  const text = buffer.toString('utf8')
  const split = text.split('\n')
  // The first line of a mid-file slice is usually partial; drop it.
  if (chunk < size) split.shift()
  return { text: split.slice(-lines).join('\n'), file, bytes: size }
}
