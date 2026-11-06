/**
 * Remote ingestion.
 *
 * Two strategies:
 *   1. Direct media URLs (mp4/webm/mp3/...) are streamed to disk and imported
 *      like a local file.
 *   2. Supported public page URLs are resolved through yt-dlp *when the user has
 *      it installed*. We never bundle or invoke anything that bypasses access
 *      controls, authentication or DRM; if a page cannot be resolved we say so.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { runProcess } from '../ffmpeg/runner'
import { importLocalFile } from './importer'
import { workspaceLayout } from '../workspace'
import { safeFilename } from '../paths'
import type { ImportAssetOptions } from './importer'
import type { MediaAsset } from '@shared/types'
import { log } from '../logger'

const DIRECT_EXT = /\.(mp4|mov|mkv|webm|m4v|mp3|wav|m4a|aac|flac|ogg|png|jpe?g|webp)(\?|$)/i

export interface RemoteProbe {
  url: string
  ok: boolean
  strategy: 'direct' | 'ytdlp' | 'none'
  title?: string
  durationMs?: number
  error?: string
  ytdlpAvailable: boolean
  note: string
}

function which(bin: string): boolean {
  const paths = (process.env.PATH ?? '').split(path.delimiter)
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of paths) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${bin}${ext}`)
      if (fs.existsSync(candidate)) return true
    }
  }
  return false
}

export function ytdlpPath(): string | null {
  const candidates = ['yt-dlp', 'yt-dlp.exe', 'youtube-dl']
  for (const bin of candidates) if (which(bin)) return bin
  return null
}

export function validateUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('That does not look like a valid URL. Include https:// at the start.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only http and https links are supported.')
  }
  return url
}

export async function inspectRemote(rawUrl: string): Promise<RemoteProbe> {
  const url = validateUrl(rawUrl)
  const ytdlp = ytdlpPath()
  if (DIRECT_EXT.test(url.pathname)) {
    return {
      url: rawUrl,
      ok: true,
      strategy: 'direct',
      title: path.basename(url.pathname),
      ytdlpAvailable: Boolean(ytdlp),
      note: 'Direct media link — it will be downloaded in full before editing.'
    }
  }
  if (!ytdlp) {
    return {
      url: rawUrl,
      ok: false,
      strategy: 'none',
      ytdlpAvailable: false,
      error:
        'This looks like a webpage, not a direct media file. Page links need yt-dlp installed on this computer (Settings → Import). Direct .mp4/.mp3 links work without it.',
      note: 'Install yt-dlp to resolve supported public pages.'
    }
  }
  const result = await runProcess(ytdlp, ['-J', '--no-playlist', '--no-warnings', rawUrl], {
    timeoutMs: 90_000
  })
  if (result.code !== 0) {
    return {
      url: rawUrl,
      ok: false,
      strategy: 'ytdlp',
      ytdlpAvailable: true,
      error: summariseYtdlpError(result.stderr),
      note: 'The page could not be read. Private, DRM-protected or sign-in-only pages are not supported.'
    }
  }
  try {
    const info = JSON.parse(result.stdout) as { title?: string; duration?: number; is_live?: boolean }
    if (info.is_live) {
      return {
        url: rawUrl,
        ok: false,
        strategy: 'ytdlp',
        title: info.title,
        ytdlpAvailable: true,
        error: 'Live streams cannot be imported. Use a recorded video.',
        note: ''
      }
    }
    return {
      url: rawUrl,
      ok: true,
      strategy: 'ytdlp',
      title: info.title,
      durationMs: info.duration ? info.duration * 1000 : undefined,
      ytdlpAvailable: true,
      note: 'Resolved with yt-dlp. Only download content you have the rights to use.'
    }
  } catch {
    return {
      url: rawUrl,
      ok: false,
      strategy: 'ytdlp',
      ytdlpAvailable: true,
      error: 'Could not read the video information returned for this link.',
      note: ''
    }
  }
}

function summariseYtdlpError(stderr: string): string {
  const text = stderr.toLowerCase()
  if (text.includes('private')) return 'This video is private, so it cannot be accessed.'
  if (text.includes('sign in') || text.includes('login')) return 'This video requires sign-in, which is not supported.'
  if (text.includes('drm')) return 'This video is DRM protected and cannot be imported.'
  if (text.includes('unsupported url')) return 'This site is not supported by the installed yt-dlp version.'
  const line = stderr.split('\n').find((l) => l.toLowerCase().includes('error'))
  return line?.slice(0, 240) ?? 'The link could not be resolved.'
}

export async function downloadRemote(
  rawUrl: string,
  opts: ImportAssetOptions,
  onProgress?: (percent: number, detail: string) => void
): Promise<MediaAsset> {
  const probe = await inspectRemote(rawUrl)
  if (!probe.ok) throw new Error(probe.error ?? 'This link cannot be imported.')
  const layout = workspaceLayout()
  const dir = path.join(layout.temp, 'downloads')
  fs.mkdirSync(dir, { recursive: true })
  const url = new URL(rawUrl)
  const base = safeFilename(probe.title ?? path.basename(url.pathname) ?? 'download')

  if (probe.strategy === 'direct') {
    const ext = (DIRECT_EXT.exec(url.pathname)?.[1] ?? 'mp4').toLowerCase()
    const target = path.join(dir, `${base}.${ext}`)
    await downloadHttp(rawUrl, target, onProgress)
    const asset = await importLocalFile(target, opts)
    asset.source = { type: 'url', url: rawUrl, title: probe.title }
    try {
      fs.unlinkSync(target)
    } catch {
      /* ignore */
    }
    return asset
  }

  const ytdlp = ytdlpPath()
  if (!ytdlp) throw new Error('yt-dlp is required for this link.')
  const targetTemplate = path.join(dir, `${base}.%(ext)s`)
  onProgress?.(2, 'Starting download')
  const args = [
    '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--newline',
    '--no-warnings',
    '-o', targetTemplate,
    rawUrl
  ]
  const file = await new Promise<string>((resolve, reject) => {
    const child = spawn(ytdlp, args, { windowsHide: true })
    let lastFile = ''
    let stderr = ''
    child.stdout.on('data', (buf: Buffer) => {
      const text = buf.toString()
      for (const line of text.split('\n')) {
        const pct = /\[download\]\s+([\d.]+)%/.exec(line)
        if (pct) onProgress?.(Math.min(95, Number(pct[1])), line.trim())
        const dest = /\[(?:download|Merger)\]\s+Destination:\s+(.+)$/.exec(line)
        if (dest) lastFile = dest[1].trim()
        const merged = /\[Merger\]\s+Merging formats into "(.+)"/.exec(line)
        if (merged) lastFile = merged[1]
      }
    })
    child.stderr.on('data', (buf: Buffer) => {
      stderr += buf.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(summariseYtdlpError(stderr)))
        return
      }
      if (lastFile && fs.existsSync(lastFile)) {
        resolve(lastFile)
        return
      }
      const found = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(base))
        .map((f) => path.join(dir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
      if (found) resolve(found)
      else reject(new Error('The download finished but no file was produced.'))
    })
  })
  onProgress?.(97, 'Importing downloaded file')
  const asset = await importLocalFile(file, opts)
  asset.source = { type: 'url', url: rawUrl, title: probe.title }
  try {
    fs.unlinkSync(file)
  } catch {
    /* ignore */
  }
  log.info('media', `downloaded remote media: ${asset.name}`)
  return asset
}

function downloadHttp(
  url: string,
  target: string,
  onProgress?: (percent: number, detail: string) => void
): Promise<void> {
  return new Promise(async (resolve, reject) => {
    try {
      const http = await import('node:https')
      const get = (u: string, redirects = 0) => {
        if (redirects > 6) {
          reject(new Error('Too many redirects while downloading.'))
          return
        }
        const req = http.get(u, { headers: { 'user-agent': 'ClipwrightStudio/1.0' } }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume()
            get(new URL(res.headers.location, u).toString(), redirects + 1)
            return
          }
          if (res.statusCode !== 200) {
            reject(new Error(`The server returned HTTP ${res.statusCode}.`))
            res.resume()
            return
          }
          const total = Number(res.headers['content-length'] ?? 0)
          let received = 0
          const file = fs.createWriteStream(target)
          res.on('data', (chunk: Buffer) => {
            received += chunk.length
            if (total) onProgress?.(Math.min(95, (received / total) * 95), `${Math.round((received / total) * 100)}%`)
          })
          res.pipe(file)
          file.on('finish', () => file.close(() => resolve()))
          file.on('error', reject)
        })
        req.on('error', (error) => reject(new Error(`Download failed: ${error.message}`)))
        req.setTimeout(60_000, () => {
          req.destroy(new Error('The download timed out.'))
        })
      }
      get(url)
    } catch (error) {
      reject(error)
    }
  })
}
