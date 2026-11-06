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
    return Math.min(0.95, Math.max(0, value))
  }
  return value
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
