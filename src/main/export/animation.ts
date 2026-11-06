/**
 * Converts keyframe tracks into FFmpeg expressions.
 *
 * The preview evaluates keyframes with the exact easing curve; the export
 * evaluates them through these expressions. Curves are sampled at 15 Hz and
 * emitted as piecewise-linear between() terms, which is visually identical at
 * the frame rates we export (the error is bounded by one sample interval).
 */
import { sampleTrack } from '@shared/keyframes'
import type { AnimatableProp, Clip, Keyframe } from '@shared/types'

const SAMPLE_HZ = 15

export interface ClipAnimation {
  x?: string
  y?: string
  rotationDeg?: string
  opacity?: string
  scale?: string
  animated: boolean
}

function piecewise(
  clip: Clip,
  track: Keyframe[],
  offsetSec: number,
  transform: (v: number) => number
): string {
  const totalMs = Math.max(1, clip.duration)
  const step = 1000 / SAMPLE_HZ
  const points: { t: number; v: number }[] = []
  for (let t = 0; t <= totalMs; t += step) {
    const v = sampleTrack(track, t)
    if (v === null) continue
    points.push({ t: (clip.start + t) / 1000 + offsetSec, v: transform(v) })
  }
  const last = sampleTrack(track, totalMs)
  if (last !== null) points.push({ t: (clip.start + totalMs) / 1000 + offsetSec, v: transform(last) })
  if (points.length === 0) return '0'
  if (points.length === 1) return points[0].v.toFixed(4)
  const first = points[0]
  const tail = points[points.length - 1]
  const pieces: string[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (b.t <= a.t) continue
    const slope = (b.v - a.v) / (b.t - a.t)
    const intercept = a.v - slope * a.t
    pieces.push(`between(t,${a.t.toFixed(3)},${b.t.toFixed(3)})*(${slope.toFixed(5)}*t+${intercept.toFixed(5)})`)
  }
  return `if(lt(t,${first.t.toFixed(3)}),${first.v.toFixed(4)},if(gt(t,${tail.t.toFixed(3)}),${tail.v.toFixed(4)},${pieces.join('+')}))`
}

export function hasTrack(clip: Clip, prop: AnimatableProp): boolean {
  return Boolean(clip.keyframes?.[prop]?.length)
}

/**
 * Build ffmpeg expressions for one clip within a segment.
 * `offsetSec` shifts absolute clip time into segment time.
 */
export function clipAnimation(
  clip: Clip,
  part: { start: number; end: number },
  canvas: { width: number; height: number },
  contentSize: { contentWidth: number; contentHeight: number; x: number; y: number }
): ClipAnimation {
  const offsetSec = -part.start / 1000
  const out: ClipAnimation = { animated: false }
  const t = clip.transform
  if (hasTrack(clip, 'rotation')) {
    out.rotationDeg = piecewise(clip, clip.keyframes.rotation!, offsetSec, (v) => v)
    out.animated = true
  }
  if (hasTrack(clip, 'opacity')) {
    out.opacity = piecewise(clip, clip.keyframes.opacity!, offsetSec, (v) => Math.max(0, Math.min(1, v)))
    out.animated = true
  }
  const centreX = piecewise(clip, clip.keyframes.x ?? [], offsetSec, (v) => v * canvas.width)
  const centreY = piecewise(clip, clip.keyframes.y ?? [], offsetSec, (v) => v * canvas.height)
  if (hasTrack(clip, 'x')) {
    out.x = `${centreX}-${(contentSize.contentWidth / 2).toFixed(2)}`
    out.animated = true
  }
  if (hasTrack(clip, 'y')) {
    out.y = `${centreY}-${(contentSize.contentHeight / 2).toFixed(2)}`
    out.animated = true
  }
  if (hasTrack(clip, 'scale') || hasTrack(clip, 'scaleX') || hasTrack(clip, 'scaleY')) {
    const track = clip.keyframes.scale ?? []
    if (track.length) out.scale = piecewise(clip, track, offsetSec, (v) => Math.max(0.02, v))
    out.animated = true
  }
  void t
  return out
}

/** Static (non-animated) values are emitted as plain numbers. */
export function staticExpr(value: number): string {
  return value.toFixed(3)
}
