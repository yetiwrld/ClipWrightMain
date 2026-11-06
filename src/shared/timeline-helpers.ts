/**
 * Small helpers shared by timeline.ts, audio-graph.ts and scene.ts.
 *
 * This module used to carry its own copy of `trackIsAudible` — and it disagreed
 * with the one in timeline.ts: it returned false for every caption, text and
 * graphic track regardless of mute state. The export path imported *this* copy
 * while the editor imported the other, so the same project meant two different
 * things depending on which renderer asked. There is now one implementation and
 * this file re-exports it.
 */
import type { Clip, Project, Track } from './types'
import { trackIsAudible as audible, isTrackVisible as visible } from './timeline'

export { trackIsAudible } from './timeline'

export function isTrackVisible(project: Project, track: Track): boolean {
  return visible(project, track)
}

/** Kept for callers that only need the audible decision from a track id. */
export function isTrackAudible(project: Project, track: Track): boolean {
  return audible(project, track)
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
