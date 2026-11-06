import fs from 'node:fs'
import { runProcess } from './runner'
import { findFFmpeg, ffmpegPath } from './locate'
import type { MediaKind, MediaProbe } from '@shared/types'

/** Parse a rational ffmpeg value like "30000/1001" into a number. */
function parseRational(value: string | undefined): number | undefined {
  if (!value) return undefined
  const [a, b] = value.split('/').map(Number)
  if (!b || !isFinite(a) || !isFinite(b)) return Number(value) || undefined
  return a / b
}

function parseDuration(value: string | undefined): number | undefined {
  if (!value) return undefined
  if (value.includes(':')) {
    const parts = value.split(':').map(Number)
    if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000
    return undefined
  }
  const n = Number(value)
  return isFinite(n) ? n * 1000 : undefined
}

interface FFProbeJson {
  streams?: Array<Record<string, unknown>>
  format?: Record<string, unknown>
}

/**
 * Probe a media file. Uses ffprobe when available, otherwise parses
 * `ffmpeg -i` banner output (which contains the same essential fields).
 */
export async function probeMedia(file: string): Promise<MediaProbe> {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`)
  const tools = findFFmpeg()
  if (!tools.ffmpeg) throw new Error('FFmpeg is not available, so this file cannot be analysed.')

  if (tools.ffprobe) {
    const result = await runProcess(tools.ffprobe, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      file
    ])
    if (result.code === 0 && result.stdout.trim().startsWith('{')) {
      try {
        return fromProbeJson(JSON.parse(result.stdout) as FFProbeJson)
      } catch {
        /* fall through to banner parsing */
      }
    }
  }
  return probeFromBanner(file)
}

export function fromProbeJson(json: FFProbeJson): MediaProbe {
  const streams = json.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')
  const format = json.format ?? {}
  const durationMs = Math.round(
    Number(format.duration ?? video?.duration ?? audio?.duration ?? 0) * 1000
  )
  const fps = parseRational(video?.avg_frame_rate as string | undefined) ??
    parseRational(video?.r_frame_rate as string | undefined)
  const rFps = parseRational(video?.r_frame_rate as string | undefined)
  const vfr = Boolean(fps && rFps && Math.abs(fps - rFps) > 0.01)

  let rotation = 0
  const sideData = (video?.side_data_list as Array<{ rotation?: number }> | undefined) ?? []
  if (sideData.length && typeof sideData[0].rotation === 'number') rotation = Math.abs(sideData[0].rotation)
  const tags = (video?.tags as Record<string, string> | undefined) ?? {}
  if (!rotation && tags.rotate) rotation = Math.abs(Number(tags.rotate)) || 0

  const width = Number(video?.width ?? 0) || undefined
  const height = Number(video?.height ?? 0) || undefined
  const formatName = String(format.format_name ?? '')
  const kind: MediaKind = video && video.codec_type === 'video'
    ? (tags['mimetype']?.startsWith('image') || formatName.includes('image') ? 'image' : 'video')
    : audio
      ? 'audio'
      : 'video'

  return {
    kind,
    durationMs: durationMs || 0,
    // Per-stream durations: the container duration is the longest stream, so
    // comparing audio to video needs the two on their own.
    audioDurationMs: audio?.duration ? Math.round(Number(audio.duration) * 1000) : undefined,
    videoDurationMs: video?.duration ? Math.round(Number(video.duration) * 1000) : undefined,
    width,
    height,
    fps: fps ? Math.round(fps * 1000) / 1000 : undefined,
    vfr,
    rotation,
    videoCodec: video?.codec_name as string | undefined,
    audioCodec: audio?.codec_name as string | undefined,
    hasAudio: Boolean(audio),
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : undefined,
    channels: audio?.channels ? Number(audio.channels) : undefined,
    bitrate: format.bit_rate ? Number(format.bit_rate) : undefined,
    container: format.format_name as string | undefined,
    displayAspect: video && width && height ? widestAspect(width, height) : undefined,
    pixFmt: video?.pix_fmt as string | undefined
  }
}

function widestAspect(w: number, h: number): string {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
  const d = gcd(w, h)
  return `${w / d}:${h / d}`
}

/** Parse the informational banner printed by `ffmpeg -i file`. */
async function probeFromBanner(file: string): Promise<MediaProbe> {
  const result = await runProcess(ffmpegPath(), ['-hide_banner', '-i', file], { timeoutMs: 60_000 })
  const banner = result.stderr
  if (/No such file|Invalid data found|Permission denied/i.test(banner) && !/Duration/.test(banner)) {
    throw new Error(`Unsupported or unreadable media: ${banner.split('\n').find((l) => /No such|Invalid|Permission/i.test(l)) ?? 'unknown error'}`)
  }
  const durationMatch = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(banner)
  const durationMs = durationMatch
    ? Math.round((Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])) * 1000)
    : 0
  const videoLine = banner.split('\n').find((l) => /Stream #.*Video:/.test(l))
  const audioLine = banner.split('\n').find((l) => /Stream #.*Audio:/.test(l))
  const sizeMatch = videoLine ? /,\s*(\d{2,5})x(\d{2,5})/.exec(videoLine) : null
  const fpsMatch = videoLine ? /,\s*([\d.]+)\s*fps/.exec(videoLine) : null
  const codecMatch = videoLine ? /Video:\s*([a-z0-9_]+)/i.exec(videoLine) : null
  const aCodecMatch = audioLine ? /Audio:\s*([a-z0-9_]+)/i.exec(audioLine) : null
  const width = sizeMatch ? Number(sizeMatch[1]) : undefined
  const height = sizeMatch ? Number(sizeMatch[2]) : undefined
  const rotateMatch = /rotate\s*:\s*(-?\d+)/.exec(banner)
  const kind: MediaKind = videoLine ? (durationMs === 0 && /png|jpeg|image/i.test(banner) ? 'image' : 'video') : 'audio'
  return {
    kind,
    durationMs,
    width,
    height,
    fps: fpsMatch ? Number(fpsMatch[1]) : undefined,
    rotation: rotateMatch ? Math.abs(Number(rotateMatch[1])) : 0,
    videoCodec: codecMatch?.[1],
    audioCodec: aCodecMatch?.[1],
    hasAudio: Boolean(audioLine),
    container: /Input #0, ([^,]+)/.exec(banner)?.[1]
  }
}

/**
 * Read the aspect ratio the *decoded* frames will be shown at, accounting for
 * rotation metadata (portrait phone footage is stored as 1920x1080 + rotate=90).
 */
export function displaySize(probe: MediaProbe): { width: number; height: number } {
  const w = probe.width ?? 1920
  const h = probe.height ?? 1080
  const rotated = probe.rotation === 90 || probe.rotation === 270
  return rotated ? { width: h, height: w } : { width: w, height: h }
}

export async function ffmpegVersion(): Promise<string | undefined> {
  const tools = findFFmpeg()
  if (!tools.ffmpeg) return undefined
  const result = await runProcess(tools.ffmpeg, ['-version'], { timeoutMs: 20_000 })
  return /ffmpeg version (\S+)/.exec(result.stdout)?.[1]
}

/**
 * Parse an `ffmpeg -encoders` listing into encoder names.
 *
 * ffmpeg indents every row by six characters (`" V....D libx264 ..."`), so an
 * unanchored or space-less pattern matches nothing. That single mistake made the
 * capability report say `"encoders":"none"` on every machine, which in turn left
 * the export guard seeing no NVENC and trying hardware encoding anyway.
 *
 * Exported so the parser can be tested against a captured listing instead of
 * whatever ffmpeg happens to be installed on the test machine.
 */
export function parseEncoders(listing: string): string[] {
  return listing
    .split('\n')
    .map((line) => /^\s*[VAS][.A-Z]{5}\s+(\S+)/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name) && name !== '=')
}

export async function availableEncoders(): Promise<string[]> {
  const tools = findFFmpeg()
  if (!tools.ffmpeg) return []
  const result = await runProcess(tools.ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 20_000 })
  return parseEncoders(result.stdout)
}
