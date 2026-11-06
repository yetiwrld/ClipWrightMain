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
  let probed: Awaited<ReturnType<typeof probeMedia>> | undefined
  try {
    const probe = await probeMedia(file)
    probed = probe
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
  /*
   * Compare the output to the *requested aspect*, not to the requested
   * width/height — those are the same numbers the output was rendered at, which
   * made this check a tautology that could only fire after the width check had
   * already failed.
   */
  const wanted = aspectRatio(opts.expected.aspect) ?? opts.expected.width / opts.expected.height
  const aspectOk = Boolean(width && height) && Math.abs(width! / height! - wanted) < 0.03
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
  const blackSeconds = blackDurationSeconds(black.stderr)
  if (durationMs && durationMs > 0) {
    /*
     * blackdetect reports one `black_start` per continuous black *run*, not one
     * per 0.2 s, so multiplying the count by 0.2 produced a number with no unit
     * meaning: three one-second runs in a 60 s export computed 1%, and the
     * ">60% black" alarm could never fire. Sum the spans instead.
     */
    blackFrameRatio = Math.min(1, blackSeconds / (durationMs / 1000))
    if (blackFrameRatio > 0.6) {
      problems.push('More than 60% of the output is black — check that the timeline has visible clips.')
    }
  }

  /*
   * Audio/video duration consistency comes from the probe that already ran.
   * `streamDuration()` used to decode the whole file twice more (once per
   * stream) purely to read two durations — two extra realtime-cost passes on
   * every export.
   */
  let audioVideoDeltaMs: number | undefined
  if (hasAudio && probed) {
    const audioDur = probed.audioDurationMs
    const videoDur = probed.videoDurationMs
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

/** Sum every blackdetect run, in seconds. */
export function blackDurationSeconds(stderr: string): number {
  let total = 0
  const starts = [...stderr.matchAll(/black_start:\s*([0-9.]+)/g)].map((m) => Number(m[1]))
  const ends = [...stderr.matchAll(/black_end:\s*([0-9.]+)/g)].map((m) => Number(m[1]))
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]
    const end = ends[i]
    if (end !== undefined && end > start) total += end - start
    else if (end === undefined) total += 0.2 // run still open at EOF
  }
  return total
}

/** "16:9" → 16/9. Returns undefined for anything that is not w:h. */
export function aspectRatio(aspect: string | undefined): number | undefined {
  if (!aspect) return undefined
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect.trim())
  if (!match) return undefined
  const w = Number(match[1])
  const h = Number(match[2])
  if (!w || !h) return undefined
  return w / h
}
