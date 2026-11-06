/**
 * Audio graph builder — turns timeline audio clips into an ffmpeg filter graph.
 * Pure functions (no ffmpeg calls) so they can be unit tested.
 */
import { trackIsAudible } from './timeline'
import type { Clip, Project } from './types'

export interface AudioInput {
  assetId: string
  path: string
  /** source offset in ms */
  sourceIn: number
  /** duration to read in ms */
  duration: number
  volume: number
  gainDb: number
  fadeInMs: number
  fadeOutMs: number
  /** timeline placement in ms */
  timelineStart: number
  /** clip playback speed factor (affects atempo) */
  speed: number
  muted: boolean
  ducking?: boolean
  normalize?: boolean
  bass?: number
  treble?: number
  pan?: number
  label: string
}

export interface BuiltAudioGraph {
  inputs: AudioInput[]
  filter: string
  durationMs: number
  warnings: string[]
}

/**
 * Collect all audible clips that contribute audio between `range.start` and
 * `range.end` (timeline ms) and build an ffmpeg filter_complex that mixes them.
 *
 * Each input is trimmed, gain-adjusted, faded and delayed to its timeline
 * position, then everything is amixed to a single stereo track.
 */
export function buildAudioGraph(
  project: Project,
  range: { start: number; end: number },
  assetsById: Record<string, { path: string }>
): BuiltAudioGraph {
  const warnings: string[] = []
  const inputs: AudioInput[] = []

  for (const track of project.tracks) {
    if (track.kind === 'caption' || track.kind === 'text' || track.kind === 'graphic') continue
    if (!trackIsAudible(project, track)) continue
    for (const clip of project.clips) {
      if (clip.trackId !== track.id) continue
      if (clip.kind === 'text' || clip.kind === 'caption' || clip.kind === 'graphic') continue
      const asset = clip.assetId ? assetsById[clip.assetId] : undefined
      if (!asset) continue
      const clipEnd = clip.start + clip.duration
      if (clipEnd <= range.start || clip.start >= range.end) continue
      const overlapStart = Math.max(clip.start, range.start)
      const overlapEnd = Math.min(clipEnd, range.end)
      if (overlapEnd <= overlapStart) continue

      const skipMs = overlapStart - clip.start
      const speed = effectSpeed(clip)
      const duration = (overlapEnd - overlapStart) / 1000
      const sourceIn = (clip.sourceIn + skipMs * speed) / 1000
      const volume = clip.audio.muted ? 0 : clip.audio.volume
      if (volume <= 0) continue
      inputs.push({
        assetId: clip.assetId!,
        path: asset.path,
        sourceIn: sourceIn * 1000,
        duration: duration * 1000,
        volume,
        gainDb: clip.audio.gainDb,
        fadeInMs: Math.max(0, Math.min(clip.audio.fadeInMs - skipMs, duration * 1000)),
        fadeOutMs: Math.max(0, Math.min(clip.audio.fadeOutMs, clipEnd - overlapEnd === 0 ? clip.audio.fadeOutMs : 0)),
        timelineStart: overlapStart - range.start,
        speed,
        muted: false,
        ducking: clip.audio.ducking,
        normalize: clip.audio.normalize,
        bass: clip.audio.bass,
        treble: clip.audio.treble,
        pan: clip.audio.pan,
        label: clip.id
      })
    }
  }

  if (inputs.length === 0) {
    return { inputs, filter: '', durationMs: range.end - range.start, warnings }
  }

  const parts: string[] = []
  const mixLabels: string[] = []
  inputs.forEach((input, index) => {
    const tag = `a${index}`
    const chain: string[] = [
      `atrim=start=${input.sourceIn.toFixed(3)}:duration=${(input.duration / 1000).toFixed(3)}`,
      'asetpts=PTS-STARTPTS',
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'
    ]
    if (Math.abs(input.speed - 1) > 0.001) {
      chain.push(`atempo=${clampTempo(input.speed).toFixed(4)}`)
    }
    if (input.normalize) chain.push('dynaudnorm=f=250:g=15')
    if (input.gainDb !== 0 || input.volume !== 1) {
      const factor = input.volume * Math.pow(10, input.gainDb / 20)
      chain.push(`volume=${factor.toFixed(4)}`)
    }
    if (input.fadeInMs > 0) chain.push(`afade=t=in:st=0:d=${(input.fadeInMs / 1000).toFixed(3)}`)
    if (input.fadeOutMs > 0) {
      const fadeStart = Math.max(0, input.duration / 1000 - input.fadeOutMs / 1000)
      chain.push(`afade=t=out:st=${fadeStart.toFixed(3)}:d=${(input.fadeOutMs / 1000).toFixed(3)}`)
    }
    if (input.bass) chain.push(`bass=g=${input.bass.toFixed(1)}`)
    if (input.treble) chain.push(`treble=g=${input.treble.toFixed(1)}`)
    if (input.pan) {
      const left = input.pan > 0 ? 1 - input.pan : 1
      const right = input.pan < 0 ? 1 + input.pan : 1
      chain.push(`pan=stereo|c0=${left.toFixed(2)}*c0|c1=${right.toFixed(2)}*c1`)
    }
    const delay = Math.round(input.timelineStart)
    if (delay > 0) chain.push(`adelay=${delay}|${delay}`)
    chain.push(`apad`)
    parts.push(`[${index}:a]${chain.join(',')}[${tag}]`)
    mixLabels.push(`[${tag}]`)
  })

  const useDuck = inputs.some((i) => i.ducking)
  if (useDuck) warnings.push('Audio ducking applies a static -9 dB reduction to clips marked as ducking.')

  parts.push(
    `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:normalize=0,` +
      `atrim=0:${((range.end - range.start) / 1000).toFixed(3)},alimiter=limit=0.98[aout]`
  )
  return { inputs, filter: parts.join(';'), durationMs: range.end - range.start, warnings }
}

function clampTempo(speed: number): number {
  // atempo accepts 0.5 – 100 in modern ffmpeg; keep a sane range.
  return Math.min(4, Math.max(0.5, speed))
}

export function effectSpeed(clip: Clip): number {
  const speed = clip.effects.find((e) => e.type === 'speed' && e.enabled)
  return speed ? Math.max(0.25, Math.min(4, speed.value)) : 1
}

/** Arguments for the audio pass. Inputs are passed as separate `-i` args. */
export function audioArgs(graph: BuiltAudioGraph, outPath: string): string[] {
  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error']
  for (const input of graph.inputs) args.push('-i', input.path)
  args.push('-filter_complex', graph.filter, '-map', '[aout]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', outPath)
  return args
}
