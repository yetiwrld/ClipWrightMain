/**
 * Where a dropped asset lands on the timeline.
 *
 * The user's complaint: "if I drag a video in it should go to the video track,
 * audio to the audio track, and so on by kind." The old code derived the clip
 * kind from the *hovered track*, so dropping a video on an audio lane silently
 * turned it into an audio clip, and dropping below the last lane did nothing at
 * all. Both rules now live here so they can be tested without a DOM.
 */
import type { ClipKind, MediaKind, Track } from './types'

/** A media asset's kind decides the clip it becomes — never the hovered track. */
export function clipKindForAsset(asset: { kind: MediaKind }): ClipKind {
  if (asset.kind === 'audio') return 'audio'
  if (asset.kind === 'image') return 'image'
  return 'video'
}

/** Can a clip of this kind live on this track? */
export function trackAcceptsClip(track: Track, kind: ClipKind): boolean {
  if (track.locked) return false
  if (kind === 'audio') return track.kind === 'audio'
  if (kind === 'image') return track.kind === 'image' || track.kind === 'video'
  if (kind === 'video') return track.kind === 'video' || track.kind === 'image'
  if (kind === 'caption') return track.kind === 'caption'
  if (kind === 'text') return track.kind === 'text' || track.kind === 'graphic'
  return track.kind === 'graphic' || track.kind === 'text' || track.kind === 'video'
}

/**
 * Pick the destination track for a dropped asset.
 *
 * Preference order: the hovered track when it fits, then the nearest compatible
 * track above it, then the first compatible track in the project. Returns null
 * only when there is genuinely nowhere to put the clip, so the caller can say so
 * instead of dropping the asset on the floor.
 */
export function resolveDropTrack(
  hoveredId: string | null,
  order: Track[],
  kind: ClipKind
): Track | null {
  const hoveredIndex = hoveredId ? order.findIndex((t) => t.id === hoveredId) : order.length - 1
  if (hoveredIndex >= 0) {
    const hovered = order[hoveredIndex]
    if (trackAcceptsClip(hovered, kind)) return hovered
    for (let i = hoveredIndex; i >= 0; i--) {
      if (trackAcceptsClip(order[i], kind)) return order[i]
    }
  }
  return order.find((t) => trackAcceptsClip(t, kind)) ?? null
}
