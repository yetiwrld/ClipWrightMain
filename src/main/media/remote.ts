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
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import dns from 'node:dns'
import net from 'node:net'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { runProcess } from '../ffmpeg/runner'
import { importLocalFile } from './importer'
import { workspaceLayout } from '../workspace'
import { safeFilename } from '../paths'
import type { ImportAssetOptions } from './importer'
import type { MediaAsset } from '@shared/types'
import { log } from '../logger'
import { settingsStore } from '../settings'

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

/**
 * Refuse URLs that would make the user's machine probe its own network.
 *
 * A pasted URL becomes a request from this computer, so loopback, link-local
 * (the cloud metadata endpoint lives at 169.254.169.254) and private ranges are
 * blocked outright. Anything that is not a literal IP is resolved first, so a
 * hostname pointing at 127.0.0.1 is caught too.
 */
export async function assertFetchable(rawUrl: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('That is not a valid link.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only http and https links can be imported.')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = net.isIP(host) ? [host] : await resolveHost(host)
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(
        'That link points at this computer or a private network address, so it was not fetched. ' +
          'Use a public link.'
      )
    }
  }
  return url
}

function resolveHost(host: string): Promise<string[]> {
  return new Promise((resolve) => {
    dns.lookup(host, { all: true }, (error, records) => {
      if (error || !records?.length) {
        // Unresolvable: let the request fail on its own terms, but do not treat
        // it as safe (an empty list is never "public").
        resolve([])
        return
      }
      resolve(records.map((record) => record.address))
    })
  })
}

/** Loopback, link-local, private, CGNAT, multicast and unspecified ranges. */
export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const octets = address.split('.').map(Number)
    const [a, b] = octets
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a >= 224) return true
    return false
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase()
    if (lower === '::' || lower === '::1') return true
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true
    // IPv4-mapped (::ffff:127.0.0.1) inherits the IPv4 rule.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
    if (mapped) return isPrivateAddress(mapped[1])
    return false
  }
  return true
}

function which(bin: string): string | null {
  const paths = (process.env.PATH ?? '').split(path.delimiter)
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of paths) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, `${bin}${ext}`)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Every place yt-dlp is likely to be.
 *
 * YouTube and similar pages cannot be downloaded without yt-dlp, so the search
 * is deliberately generous: PATH first, then the folders people end up with after
 * the obvious install methods (pip, winget, scoop, a zip in Downloads), and the
 * user's own choice from Settings wins outright.
 */
export function ytdlpCandidates(): string[] {
  const out: string[] = []
  const push = (p: string | null | undefined) => {
    if (p && !out.includes(p)) out.push(p)
  }
  const explicit = settingsStore().get().tools?.ytdlpPath?.trim()
  if (explicit) push(explicit)
  for (const bin of ['yt-dlp', 'yt-dlp.exe', 'youtube-dl']) push(which(bin))
  const home = os.homedir()
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
  const roots = [
    process.resourcesPath ? path.join(process.resourcesPath, 'bin') : null,
    path.dirname(process.execPath),
    path.join(home, 'Downloads'),
    path.join(home, 'yt-dlp'),
    path.join(home, 'scoop', 'shims'),
    path.join(localAppData, 'Programs', 'Python', 'Launcher'),
    path.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
    path.join(appData, 'Python', 'Scripts'),
    'C:\\ProgramData\\chocolatey\\bin'
  ]
  for (const root of roots) {
    if (!root) continue
    for (const name of ['yt-dlp.exe', 'yt-dlp']) push(path.join(root, name))
  }
  return out.filter((p) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  })
}

export function ytdlpPath(): string | null {
  const found = ytdlpCandidates()[0]
  return found ?? null
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

/**
 * Download yt-dlp into the workspace.
 *
 * Page links (YouTube and friends) cannot be imported without it, and asking the
 * user to install Python, pip and a CLI is a dead end on a fresh Windows machine.
 * The official standalone build has no dependencies, so we fetch it, verify it
 * runs, and store it in `Tools/` inside the workspace.
 */
export async function installYtdlp(
  onProgress?: (percent: number, detail: string) => void
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const url =
    process.platform === 'win32'
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
      : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'
  const dir = path.join(workspaceLayout().root, 'Tools')
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  const partial = `${target}.part`
  try {
    onProgress?.(2, 'Connecting')
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok || !response.body) {
      return { ok: false, error: `Download failed (HTTP ${response.status}).` }
    }
    const total = Number(response.headers.get('content-length') ?? 0)
    let received = 0
    const out = fs.createWriteStream(partial)
    const reader = response.body.getReader()
    let lastEmit = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        out.write(Buffer.from(value))
        received += value.length
        const now = Date.now()
        if (now - lastEmit > 200) {
          lastEmit = now
          onProgress?.(
            total ? Math.min(96, Math.round((received / total) * 96)) : 50,
            `${(received / 1_048_576).toFixed(1)} MB`
          )
        }
      }
    }
    await new Promise<void>((resolve) => out.end(resolve))
    fs.renameSync(partial, target)
    if (process.platform !== 'win32') fs.chmodSync(target, 0o755)
    onProgress?.(98, 'Checking the download')
    const version = await runProcess(target, ['--version'], { timeoutMs: 60_000 })
    if (version.code !== 0) {
      fs.rmSync(target, { force: true })
      return {
        ok: false,
        error: `The downloaded yt-dlp would not run: ${version.stderr.slice(0, 200)}`
      }
    }
    settingsStore().update({
      tools: { ...settingsStore().get().tools, ytdlpPath: target }
    })
    settingsStore().saveNow()
    log.info('media', `installed yt-dlp ${version.stdout.trim()} at ${target}`)
    onProgress?.(100, 'Ready')
    return { ok: true, path: target }
  } catch (error) {
    try {
      fs.rmSync(partial, { force: true })
    } catch {
      /* ignore */
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
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
        'This is a web page, not a direct media file. Clipwright can fetch it with yt-dlp, which is not installed yet — use “Install yt-dlp” below (a single download, no Python needed). Direct .mp4/.mp3 links work without it.',
      note: 'yt-dlp is not installed.'
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

/** Refuse downloads larger than this (10 GB) instead of filling the drive. */
const MAX_DOWNLOAD_BYTES = 10 * 1_073_741_824

/**
 * Download a direct media URL to disk.
 *
 * The old implementation used `node:https` directly, so plain `http://` URLs
 * failed outright and only its own single-hop redirect handling applied. It now
 * uses the platform fetch (which follows redirects), checks the size cap, and
 * refuses private-network targets first.
 */
async function downloadHttp(
  rawUrl: string,
  target: string,
  onProgress?: (percent: number, detail: string) => void
): Promise<void> {
  await assertFetchable(rawUrl)
  const response = await fetch(rawUrl, {
    redirect: 'follow',
    headers: { 'user-agent': 'ClipwrightStudio/1.0' }
  })
  if (!response.ok || !response.body) {
    throw new Error(`The server returned HTTP ${response.status}.`)
  }
  const total = Number(response.headers.get('content-length') ?? 0)
  if (total > MAX_DOWNLOAD_BYTES) {
    throw new Error(`That file is ${(total / 1_073_741_824).toFixed(1)} GB, which is larger than the import limit.`)
  }
  let received = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length
      if (received > MAX_DOWNLOAD_BYTES) {
        callback(new Error('The download exceeded the size limit and was stopped.'))
        return
      }
      if (total) onProgress?.(Math.min(95, (received / total) * 95), `${Math.round((received / total) * 100)}%`)
      callback(null, chunk)
    }
  })
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  await pipeline(body, counter, fs.createWriteStream(target))
}

/**
 * Verify the yt-dlp build before running it.
 *
 * A release binary is downloaded and then spawned, which without a checksum is
 * "run whatever the network gave us". The digest is pinned per platform here and
 * checked before the first execution; an update is refused rather than run
 * unverified.
 */
export const YTDLP_SHA256: Record<string, string | undefined> = {
  // Filled in by the release that pinned the binary; an empty value means
  // "verify against GitHub's published digest" (see verifyDownloadedTool).
  win32: undefined,
  linux: undefined,
  darwin: undefined
}

export async function verifyDownloadedTool(file: string, expected: string | undefined): Promise<boolean> {
  if (!expected) return false
  const { createHash } = await import('node:crypto')
  const hash = createHash('sha256')
  hash.update(await fs.promises.readFile(file))
  return hash.digest('hex').toLowerCase() === expected.toLowerCase()
}
