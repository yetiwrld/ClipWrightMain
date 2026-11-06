/**
 * Export validation.
 *
 * A progress bar reaching 100% proves nothing. After every export we re-open the
 * produced file with ffmpeg and check the real stream properties, decode the
 * whole file, look for black frames and compare audio/video durations.
 */
import fs from 'node:fs'
import { probeMedia } from '../ffmpeg/probe'
import { ffmpegPath } from '../ffmpeg/locate'
import { runProcess } from '../ffmpeg/runner'
import type { ExportPreset, ExportValidation } from '@shared/types'

export interface ValidateOptions {
  expected: { width: number; height: number; fps: number; durationMs: number; aspect: string }
  requireAudio?: boolean
}

export async function validateExport(file: string, preset: ExportPreset, opts: ValidateOptions): Promise<ExportValidation> {
  const problems: string[] = []
  const exists = fs.existsSync(file)
  if (!exists) {
    return {
      ok: false,
      exists: false,
      sizeBytes: 0,
      hasAudio: false,
      aspectOk: false,
      decodeOk: false,
      problems: ['The export file was not created.'],
      checkedAt: Date.now()
    }
  }
  const sizeBytes = fs.statSync(file).size
  if (sizeBytes < 2048) problems.push('The output file is suspiciously small.')

  let width: number | undefined
  let height: number | undefined
  let fps: number | undefined
  let durationMs: number | undefined
  let hasAudio = false
  try {
    const probe = await probeMedia(file)
    width = probe.width
    height = probe.height
    fps = probe.fps
    durationMs = probe.durationMs
    hasAudio = probe.hasAudio
  } catch (error) {
    problems.push(`The file could not be analysed: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (width && opts.expected.width && Math.abs(width - opts.expected.width) > 2) {
    problems.push(`Width is ${width}px but ${opts.expected.width}px was requested.`)
  }
  if (height && opts.expected.height && Math.abs(height - opts.expected.height) > 2) {
    problems.push(`Height is ${height}px but ${opts.expected.height}px was requested.`)
  }
  if (fps && Math.abs(fps - opts.expected.fps) > 0.6) {
    problems.push(`Frame rate is ${fps} but ${opts.expected.fps} was requested.`)
  }
  const aspectOk =
    Boolean(width && height) &&
    Math.abs(width! / height! - opts.expected.width / opts.expected.height) < 0.02
  if (!aspectOk) problems.push('The output aspect ratio does not match the project.')
  if (opts.requireAudio && !hasAudio) problems.push('The output has no audio stream.')

  const expectedDuration = opts.expected.durationMs
  if (durationMs !== undefined && expectedDuration > 0) {
    const delta = Math.abs(durationMs - expectedDuration)
    if (delta > Math.max(400, expectedDuration * 0.04)) {
      problems.push(
        `Duration is ${(durationMs / 1000).toFixed(2)}s but ${(expectedDuration / 1000).toFixed(2)}s was expected — the export may be truncated.`
      )
    }
  }

  // Full decode pass — catches corrupt frames, broken indexes, truncated moov.
  const decode = await runProcess(
    ffmpegPath(),
    ['-hide_banner', '-loglevel', 'error', '-v', 'error', '-i', file, '-f', 'null', '-'],
    { timeoutMs: 30 * 60_000 }
  )
  const decodeOk = decode.code === 0 && !/error|invalid|corrupt/i.test(decode.stderr)
  if (!decodeOk) problems.push(`Decoding the output produced errors: ${decode.stderr.slice(-200)}`)

  // Black-frame scan: catches an empty or badly composited timeline.
  let blackFrameRatio: number | undefined
  const black = await runProcess(
    ffmpegPath(),
    ['-hide_banner', '-loglevel', 'info', '-i', file, '-vf', 'blackdetect=d=0.2:pix_th=0.08', '-an', '-f', 'null', '-'],
    { timeoutMs: 30 * 60_000 }
  )
  const blackLines = (black.stderr.match(/black_start/g) ?? []).length
  if (durationMs) {
    // Each detection spans at least 0.2s.
    blackFrameRatio = Math.min(1, (blackLines * 0.2) / (durationMs / 1000))
    if (blackLines > 0 && blackFrameRatio > 0.6) {
      problems.push('More than 60% of the output is black — check that the timeline has visible clips.')
    }
  }

  // Audio/video duration consistency (sync sanity check).
  let audioVideoDeltaMs: number | undefined
  if (hasAudio) {
    const audioDur = await streamDuration(file, 'a')
    const videoDur = await streamDuration(file, 'v')
    if (audioDur && videoDur) audioVideoDeltaMs = Math.abs(audioDur - videoDur)
    if (audioVideoDeltaMs !== undefined && audioVideoDeltaMs > 1200) {
      problems.push(
        `Audio and video are ${(audioVideoDeltaMs / 1000).toFixed(2)}s apart, which suggests a sync problem.`
      )
    }
  }

  void preset
  return {
    ok: problems.length === 0,
    exists,
    sizeBytes,
    width,
    height,
    fps,
    durationMs,
    hasAudio,
    aspectOk,
    audioVideoDeltaMs,
    blackFrameRatio,
    decodeOk,
    problems,
    checkedAt: Date.now()
  }
}

/** Decode a single stream to null and read its reported duration. */
async function streamDuration(file: string, kind: 'a' | 'v'): Promise<number | undefined> {
  const result = await runProcess(
    ffmpegPath(),
    ['-hide_banner', '-i', file, '-map', `0:${kind}:0`, '-f', 'null', '-'],
    { timeoutMs: 20 * 60_000 }
  )
  const match = /time=(\d+):(\d+):(\d+\.?\d*)/g
  let last: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = match.exec(result.stderr)) !== null) last = m
  if (!last) return undefined
  return (
    (Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])) * 1000
  )
}
