/** Small helpers shared by timeline.ts, audio-graph.ts and scene.ts. */
import type { Clip, Project, Track } from './types'

export function trackIsAudible(project: Project, track: Track): boolean {
  if (track.kind === 'caption' || track.kind === 'text' || track.kind === 'graphic') return false
  const soloed = project.tracks.some((t) => t.solo)
  if (soloed) return track.solo && !track.muted
  return !track.muted
}

export function trackIsVisibleClass(track: Track): boolean {
  return track.visible
}

export function effectSpeed(clip: Clip): number {
  const effect = clip.effects?.find((e) => e.type === 'speed' && e.enabled)
  if (!effect) return 1
  return Math.min(4, Math.max(0.25, effect.value))
}

/** Source media duration after accounting for speed. */
export function sourceSpanMs(clip: Clip): number {
  const speed = effectSpeed(clip)
  return clip.kind === 'video' || clip.kind === 'audio' ? clip.duration * speed : clip.duration
}
