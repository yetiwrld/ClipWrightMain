import { applyEasing } from './easing'
import type { AnimatableProp, Clip, Keyframe, KeyframeTracks } from './types'

export function uid(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`
}

/** Sort keyframes by time (clips keep sorted arrays so sampling is O(log n) friendly). */
export function sortKeyframes(list: Keyframe[]): Keyframe[] {
  return [...list].sort((a, b) => a.t - b.t)
}

/**
 * Sample a keyframe track at `localTime` (ms from clip start).
 * Returns null when the track is empty so the caller can fall back to the
 * clip's static value.
 */
export function sampleTrack(track: Keyframe[] | undefined, localTime: number): number | null {
  if (!track || track.length === 0) return null
  const frames = track
  if (localTime <= frames[0].t) return frames[0].value
  const last = frames[frames.length - 1]
  if (localTime >= last.t) return last.value
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i]
    const b = frames[i + 1]
    if (localTime >= a.t && localTime <= b.t) {
      const span = b.t - a.t
      if (span <= 0) return b.value
      const raw = (localTime - a.t) / span
      // The easing defined on the *outgoing* keyframe controls the segment.
      const eased = applyEasing(a.easing, raw)
      return a.value + (b.value - a.value) * eased
    }
  }
  return last.value
}

/** Resolve every animatable property for a clip at a given local time. */
export function resolveClipProps(
  clip: Clip,
  localTime: number
): Record<AnimatableProp, number> {
  const t = clip.transform
  const a = clip.audio
  const base: Record<AnimatableProp, number> = {
    x: t.x,
    y: t.y,
    scale: t.scale,
    scaleX: t.scaleX,
    scaleY: t.scaleY,
    rotation: t.rotation,
    opacity: t.opacity,
    volume: a.muted ? 0 : a.volume,
    cropL: t.cropL,
    cropR: t.cropR,
    cropT: t.cropT,
    cropB: t.cropB
  }
  const out = { ...base }
  for (const key of Object.keys(clip.keyframes) as AnimatableProp[]) {
    const v = sampleTrack(clip.keyframes[key], localTime)
    if (v !== null) out[key] = v
  }
  return out
}

/** Convenience: clamp an opacity/volume sample to a legal range. */
export function clampProp(prop: AnimatableProp, value: number): number {
  if (prop === 'opacity' || prop === 'volume') return Math.min(1, Math.max(0, value))
  if (prop === 'cropL' || prop === 'cropR' || prop === 'cropT' || prop === 'cropB') {
    return Math.min(MAX_EDGE_CROP, Math.max(0, value))
  }
  return value
}

/**
 * Largest crop a single edge may take.
 *
 * Each edge is clamped on its own, so left+right could reach 1.9 of the frame;
 * the renderer then computed contentWidth * (1 - l - r) — a negative width that
 * Math.max(2, …) silently turned into a 2 px crop. Opposing edges are clamped as
 * a pair so at least a sliver of picture always survives.
 */
export const MAX_EDGE_CROP = 0.95

/** Clamp opposing crop edges so left+right (and top+bottom) stay below 100%. */
export function clampCropPair(a: number, b: number, max = 0.98): [number, number] {
  const left = Math.min(MAX_EDGE_CROP, Math.max(0, a))
  const right = Math.min(MAX_EDGE_CROP, Math.max(0, b))
  const total = left + right
  if (total <= max) return [left, right]
  const scale = max / total
  return [left * scale, right * scale]
}

/**
 * Re-anchor a keyframe track after a clip has been cut at `cut` ms.
 *
 * The kept tail starts at the cut, so its local time is `t - cut`. Simply
 * subtracting the cut and clamping at zero — which is what a head trim does —
 * keeps the *old* first keyframe's value at the new start, so an animation jumps
 * at the cut. Here the value at the cut is sampled from the original curve and
 * used as the tail's opening keyframe, so the motion continues exactly where it
 * left off.
 */
export function sliceTrack(track: Keyframe[] | undefined, cut: number): Keyframe[] | undefined {
  if (!track || track.length === 0) return track
  if (cut <= 0) return track.map((k) => ({ ...k }))
  const boundary = sampleTrack(track, cut)
  const kept = track.filter((k) => k.t > cut).map((k) => ({ ...k, t: k.t - cut }))
  if (boundary === null) return kept
  // Reuse the easing of the segment the cut landed in so the curve shape holds.
  const outgoing = [...track].reverse().find((k) => k.t <= cut)
  const head: Keyframe = {
    id: `kf_cut_${Math.round(cut)}`,
    t: 0,
    value: boundary,
    easing: outgoing?.easing ?? kept[0]?.easing ?? { kind: 'linear' }
  }
  return [head, ...kept]
}

export function addKeyframe(
  tracks: KeyframeTracks,
  prop: AnimatableProp,
  keyframe: Omit<Keyframe, 'id'>
): KeyframeTracks {
  const list = tracks[prop] ? [...tracks[prop]!] : []
  // Replace a keyframe that lands on the same frame rather than stacking.
  const existing = list.findIndex((k) => Math.abs(k.t - keyframe.t) < 1)
  const kf: Keyframe = { id: uid('kf'), ...keyframe, value: clampProp(prop, keyframe.value) }
  if (existing >= 0) list[existing] = { ...kf, id: list[existing].id }
  else list.push(kf)
  return { ...tracks, [prop]: sortKeyframes(list) }
}

export function removeKeyframe(
  tracks: KeyframeTracks,
  prop: AnimatableProp,
  id: string
): KeyframeTracks {
  const list = (tracks[prop] ?? []).filter((k) => k.id !== id)
  const next = { ...tracks }
  if (list.length === 0) delete next[prop]
  else next[prop] = list
  return next
}

export function updateKeyframe(
  tracks: KeyframeTracks,
  prop: AnimatableProp,
  id: string,
  patch: Partial<Keyframe>
): KeyframeTracks {
  const list = (tracks[prop] ?? []).map((k) =>
    k.id === id ? { ...k, ...patch, value: clampProp(prop, patch.value ?? k.value) } : k
  )
  return { ...tracks, [prop]: sortKeyframes(list) }
}

/** Shift every keyframe when a clip's in-point changes so animation stays anchored. */
export function shiftKeyframes(tracks: KeyframeTracks, deltaMs: number): KeyframeTracks {
  const out: KeyframeTracks = {}
  for (const key of Object.keys(tracks) as AnimatableProp[]) {
    out[key] = (tracks[key] ?? []).map((k) => ({ ...k, t: Math.max(0, k.t + deltaMs) }))
  }
  return out
}

/** Scale keyframe times when a clip is stretched (e.g. speed change or trim). */
export function scaleKeyframes(tracks: KeyframeTracks, factor: number): KeyframeTracks {
  if (!isFinite(factor) || factor <= 0) return tracks
  const out: KeyframeTracks = {}
  for (const key of Object.keys(tracks) as AnimatableProp[]) {
    out[key] = (tracks[key] ?? []).map((k) => ({ ...k, t: Math.round(k.t * factor) }))
  }
  return out
}

export function hasKeyframes(clip: Clip): boolean {
  return Object.values(clip.keyframes ?? {}).some((list) => (list?.length ?? 0) > 0)
}

export function keyframeCount(clip: Clip): number {
  return Object.values(clip.keyframes ?? {}).reduce((sum, list) => sum + (list?.length ?? 0), 0)
}
