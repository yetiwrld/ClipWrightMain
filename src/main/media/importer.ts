import fs from 'node:fs'
import path from 'node:path'
import { probeMedia } from '../ffmpeg/probe'
import { ffmpegPath } from '../ffmpeg/locate'
import { runProcess } from '../ffmpeg/runner'
import { workspaceLayout, importIntoLibrary } from '../workspace'
import { safeFilename } from '../paths'
import type { MediaAsset, MediaKind } from '@shared/types'
import { log } from '../logger'

const VIDEO_EXT = /\.(mp4|mov|mkv|webm|avi|m4v|wmv|flv|mpg|mpeg|ts|m2ts|3gp|ogv)$/i
const AUDIO_EXT = /\.(mp3|wav|aac|flac|m4a|ogg|opus|aiff?|wma)$/i
const IMAGE_EXT = /\.(png|jpe?g|webp|svg|bmp|gif|tiff?|avif)$/i

export function kindFromExtension(file: string): MediaKind | null {
  if (VIDEO_EXT.test(file)) return 'video'
  if (AUDIO_EXT.test(file)) return 'audio'
  if (IMAGE_EXT.test(file)) return 'image'
  return null
}

export interface ImportAssetOptions {
  projectId: string
  mode: 'managed' | 'linked'
}

/** Thumbnail + waveform generation for previews, the media library and the timeline. */
export async function generateThumbnail(asset: MediaAsset): Promise<string | undefined> {
  if (asset.kind === 'audio') return genWaveform(asset)
  if (asset.kind === 'image') return asset.path
  const layout = workspaceLayout()
  const out = path.join(layout.thumbnails, `${safeFilename(asset.id)}.jpg`)
  const duration = Math.max(0.1, (asset.probe.durationMs || 1000) / 1000)
  const at = Math.min(duration * 0.12, 3)
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', at.toFixed(3), '-i', asset.path,
    '-frames:v', '1',
    '-vf', 'scale=420:-2:flags=bicubic',
    '-q:v', '4',
    out
  ]
  const result = await runProcess(ffmpegPath(), args, { timeoutMs: 30_000 })
  if (result.code !== 0 || !fs.existsSync(out)) {
    log.warn('media', `thumbnail failed for ${asset.name}`)
    return undefined
  }
  return out
}

/** Normalised peak file (256 samples per second) drawn by the waveform component. */
export async function genWaveform(asset: MediaAsset): Promise<string | undefined> {
  const layout = workspaceLayout()
  const out = path.join(layout.waveforms, `${safeFilename(asset.id)}.peaks.json`)
  if (fs.existsSync(out)) return out
  const durationSec = Math.max(0.2, (asset.probe.durationMs || 1000) / 1000)
  const samplesPerSecond = 100
  const totalSamples = Math.min(400_000, Math.round(durationSec * samplesPerSecond))
  const raw = path.join(layout.temp, `${safeFilename(asset.id)}.f32`)
  fs.mkdirSync(layout.temp, { recursive: true })
  const result = await runProcess(
    ffmpegPath(),
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', asset.path, '-vn', '-ac', '1', '-ar', String(samplesPerSecond), '-f', 'f32le', raw],
    { timeoutMs: 120_000 }
  )
  if (result.code !== 0 || !fs.existsSync(raw)) return undefined
  try {
    const buffer = fs.readFileSync(raw)
    const floats = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 4))
    const peaks: number[] = []
    for (let i = 0; i < totalSamples && i < floats.length; i++) {
      peaks.push(Math.min(1, Math.abs(floats[i])))
    }
    fs.writeFileSync(out, JSON.stringify({ samplesPerSecond, durationMs: asset.probe.durationMs, peaks }))
    return out
  } finally {
    try {
      fs.unlinkSync(raw)
    } catch {
      /* ignore */
    }
  }
}

/**
 * Import a local file into a project. Copies into the managed library by
 * default (recommended) or references the original location.
 */
export async function importLocalFile(
  filePath: string,
  opts: ImportAssetOptions
): Promise<MediaAsset> {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
  const stats = fs.statSync(filePath)
  if (stats.isDirectory()) throw new Error('Folders cannot be imported. Choose media files.')
  const declaredKind = kindFromExtension(filePath)
  if (!declaredKind) {
    throw new Error(
      `Unsupported file type: ${path.extname(filePath) || 'unknown'}. Supported: MP4, MOV, MKV, WebM, MP3, WAV, AAC, FLAC, M4A, PNG, JPG, WebP, SVG.`
    )
  }
  const probe = await probeMedia(filePath)
  // Trust ffmpeg over the extension when they disagree (e.g. .mp3 containing video).
  const kind: MediaKind = probe.kind === 'image' || declaredKind === 'image' ? 'image' : probe.kind
  let storedPath = filePath
  let storage: MediaAsset['storage'] = 'linked'
  let relativePath: string | undefined
  if (opts.mode === 'managed') {
    storedPath = importIntoLibrary(filePath, opts.projectId)
    storage = 'managed'
    relativePath = path.relative(path.join(workspaceLayout().root, 'Projects', safeFilename(opts.projectId)), storedPath)
  }
  const asset: MediaAsset = {
    id: `ast_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`,
    name: path.basename(filePath),
    path: storedPath,
    relativePath,
    kind,
    storage,
    probe,
    importedAt: Date.now(),
    sizeBytes: stats.size,
    source: { type: 'file' }
  }
  try {
    asset.thumbnail = await generateThumbnail(asset)
    if (kind === 'audio' || probe.hasAudio) asset.waveform = await genWaveform(asset)
  } catch (error) {
    log.warn('media', `poster generation failed: ${String(error)}`)
  }
  return asset
}

/** Re-link a missing asset to a new file location. */
export function relinkAsset(asset: MediaAsset, newPath: string): MediaAsset {
  if (!fs.existsSync(newPath)) throw new Error('That file could not be found.')
  return { ...asset, path: newPath, missing: false }
}

export function checkAssetAvailability(asset: MediaAsset): boolean {
  return fs.existsSync(asset.path)
}
