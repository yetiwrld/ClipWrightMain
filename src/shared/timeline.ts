/**
 * Timeline operations. Every mutation returns a new project (immutable) so the
 * editor can keep a reliable undo/redo history and so exports are deterministic.
 */
import { uid } from './keyframes'
import { clamp, snapToFrame } from './time'
import type { Clip, ClipKind, Project, Track, TrackKind } from './types'

export const DEFAULT_TRACK_HEIGHT = 64
export const MIN_CLIP_DURATION = 80

export function projectDuration(project: Project): number {
  return project.clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0)
}

export function clipsOnTrack(project: Project, trackId: string): Clip[] {
  return project.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start)
}

export function findClip(project: Project, clipId: string): Clip | undefined {
  return project.clips.find((c) => c.id === clipId)
}

export function findTrack(project: Project, trackId: string): Track | undefined {
  return project.tracks.find((t) => t.id === trackId)
}

/**
 * The "main" video track is the first video track; overlays above it composite
 * on top. We keep an explicit ordering in project.tracks (index 0 = topmost for
 * text/captions, video tracks below).
 */
export function isTrackVisible(project: Project, track: Track): boolean {
  if (!track.visible) return false
  if (track.kind === 'audio') return !track.muted
  return true
}

export function trackIsAudible(project: Project, track: Track): boolean {
  const soloed = project.tracks.some((t) => t.solo)
  if (soloed) return track.solo && !track.muted
  return !track.muted
}

/* ------------------------------------------------------------------ */
/* Creation                                                           */
/* ------------------------------------------------------------------ */

export function makeTrack(kind: TrackKind, name: string, index: number): Track {
  const heights: Record<TrackKind, number> = {
    video: DEFAULT_TRACK_HEIGHT,
    image: DEFAULT_TRACK_HEIGHT,
    graphic: DEFAULT_TRACK_HEIGHT,
    text: 52,
    caption: 52,
    audio: 58
  }
  return {
    id: uid('track'),
    kind,
    name,
    height: heights[kind],
    visible: true,
    locked: false,
    muted: false,
    solo: false,
    opacity: 1
  }
}

export function defaultTracks(): Track[] {
  return [
    makeTrack('caption', 'Captions', 0),
    makeTrack('text', 'Text & Titles', 1),
    makeTrack('graphic', 'Graphics', 2),
    makeTrack('video', 'Video 2', 3),
    makeTrack('video', 'Video 1', 4),
    makeTrack('audio', 'Music', 5),
    makeTrack('audio', 'Audio 1', 6),
    makeTrack('audio', 'Audio 2', 7)
  ]
}

export function baseClip(kind: ClipKind, trackId: string, name: string): Clip {
  return {
    id: uid('clip'),
    kind,
    trackId,
    name,
    start: 0,
    duration: 4000,
    sourceIn: 0,
    playing: true,
    transform: {
      x: 0.5,
      y: 0.5,
      scale: 1,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      opacity: 1,
      cropL: 0,
      cropR: 0,
      cropT: 0,
      cropB: 0
    },
    keyframes: {},
    effects: [],
    audio: {
      volume: 1,
      gainDb: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
      muted: false,
      showWaveform: true,
      bass: 0,
      treble: 0,
      pan: 0,
      normalize: false,
      ducking: false
    }
  }
}

/* ------------------------------------------------------------------ */
/* Overlap / collision handling                                       */
/* ------------------------------------------------------------------ */

export function isEmptyRange(
  clips: Clip[],
  trackId: string,
  start: number,
  duration: number,
  ignoreId?: string
): boolean {
  const end = start + duration
  return !clips.some(
    (c) =>
      c.trackId === trackId &&
      c.id !== ignoreId &&
      start < c.start + c.duration - 1 &&
      end > c.start + 1
  )
}

/** First free start position at or after `desired` on a track (used by overwrite=false drops). */
export function findFreeSlot(
  clips: Clip[],
  trackId: string,
  desired: number,
  duration: number,
  ignoreId?: string
): number {
  let pos = Math.max(0, desired)
  const sorted = clips
    .filter((c) => c.trackId === trackId && c.id !== ignoreId)
    .sort((a, b) => a.start - b.start)
  let moved = true
  while (moved) {
    moved = false
    for (const c of sorted) {
      if (pos < c.start + c.duration && pos + duration > c.start) {
        pos = c.start + c.duration
        moved = true
      }
    }
  }
  return pos
}

/** Remove overlapping clips entirely (overwrite edit). */
export function overwriteRange(clips: Clip[], trackId: string, start: number, end: number, ignoreId?: string): Clip[] {
  return clips.filter(
    (c) => !(c.trackId === trackId && c.id !== ignoreId && start < c.start + c.duration && end > c.start)
  )
}

/**
 * Trim clips that overlap a range so the range becomes empty (ripple/overwrite
 * without destroying neighbouring media). Used by insert edits.
 */
export function clearRange(clips: Clip[], trackId: string, start: number, end: number, ignoreId?: string): Clip[] {
  const out: Clip[] = []
  for (const c of clips) {
    if (c.trackId !== trackId || c.id === ignoreId) {
      out.push(c)
      continue
    }
    const cStart = c.start
    const cEnd = c.start + c.duration
    if (cEnd <= start || cStart >= end) {
      out.push(c)
      continue
    }
    // Clip completely covered.
    if (cStart >= start && cEnd <= end) continue
    // Clip straddles the start of the range: keep the head.
    if (cStart < start && cEnd <= end) {
      out.push({ ...c, duration: start - cStart })
      continue
    }
    // Clip straddles the end of the range: keep the tail.
    if (cStart >= start && cEnd > end) {
      const cut = end - cStart
      out.push({ ...c, start: end, duration: cEnd - end, sourceIn: c.sourceIn + cut })
      continue
    }
    // Range is in the middle of the clip: split and keep both sides.
    const headDuration = start - cStart
    const tailOffset = end - cStart
    out.push({ ...c, duration: headDuration })
    out.push({
      ...c,
      id: uid('clip'),
      start: end,
      duration: cEnd - end,
      sourceIn: c.sourceIn + tailOffset
    })
  }
  return out.sort((a, b) => a.start - b.start)
}

/* ------------------------------------------------------------------ */
/* Editing primitives                                                 */
/* ------------------------------------------------------------------ */

export function splitClip(project: Project, clipId: string, atTime: number): Project {
  const clip = findClip(project, clipId)
  if (!clip) return project
  const local = atTime - clip.start
  if (local <= MIN_CLIP_DURATION || local >= clip.duration - MIN_CLIP_DURATION) return project
  const right: Clip = {
    ...clip,
    id: uid('clip'),
    start: atTime,
    duration: clip.duration - local,
    sourceIn: clip.sourceIn + local,
    transitionIn: undefined
  }
  const left: Clip = { ...clip, duration: local, transitionOut: undefined }
  return {
    ...project,
    clips: project.clips.flatMap((c) => (c.id === clipId ? [left, right] : [c]))
  }
}

export function moveClip(
  project: Project,
  clipId: string,
  newStart: number,
  newTrackId?: string
): Project {
  return {
    ...project,
    clips: project.clips.map((c) =>
      c.id === clipId
        ? { ...c, start: Math.max(0, newStart), trackId: newTrackId ?? c.trackId }
        : c
    )
  }
}

/** Trim the head or tail of a clip, clamped by source bounds and neighbours. */
export function trimClip(
  project: Project,
  clipId: string,
  edge: 'start' | 'end',
  newEdgeTime: number,
  opts: { ripple?: boolean; snap?: boolean } = {}
): Project {
  const clip = findClip(project, clipId)
  if (!clip) return project
  const fps = project.fps
  let time = opts.snap === false ? newEdgeTime : snapToFrame(newEdgeTime, fps)
  const track = findTrack(project, clip.trackId)
  if (track?.locked) return project

  const neighbours = project.clips.filter((c) => c.trackId === clip.trackId && c.id !== clip.id)
  if (edge === 'start') {
    const minStart = Math.max(
      0,
      clip.start - clip.sourceIn, // cannot trim before the source in-point
      ...neighbours.filter((c) => c.start + c.duration <= clip.start).map((c) => c.start + c.duration)
    )
    const maxStart = clip.start + clip.duration - MIN_CLIP_DURATION
    time = clamp(time, minStart, maxStart)
    const delta = time - clip.start
    const updated: Clip = {
      ...clip,
      start: time,
      duration: clip.duration - delta,
      sourceIn: clip.sourceIn + delta,
      // Keyframes are anchored to clip start: shift so animations stay in place.
      keyframes: shiftTrackKeyframes(clip, -delta)
    }
    let clips = project.clips.map((c) => (c.id === clip.id ? updated : c))
    if (opts.ripple) clips = rippleAfter(clips, clip.trackId, clip.start, delta, clip.id, 'shiftBy')
    return { ...project, clips }
  }

  const minEnd = clip.start + MIN_CLIP_DURATION
  const sourceLimit =
    clip.sourceDuration !== undefined && clip.kind !== 'text' && clip.kind !== 'caption'
      ? clip.start + (clip.sourceDuration - clip.sourceIn)
      : Number.POSITIVE_INFINITY
  const nextBoundary = neighbours
    .filter((c) => c.start >= clip.start + clip.duration)
    .reduce((min, c) => Math.min(min, c.start), Number.POSITIVE_INFINITY)
  const maxEnd = Math.min(sourceLimit, nextBoundary)
  time = clamp(time, minEnd, Math.max(minEnd, maxEnd))
  const delta = time - (clip.start + clip.duration)
  const updated: Clip = { ...clip, duration: time - clip.start }
  let clips = project.clips.map((c) => (c.id === clip.id ? updated : c))
  if (opts.ripple) clips = rippleAfter(clips, clip.trackId, clip.start + clip.duration, delta, clip.id, 'shiftBy')
  return { ...project, clips }
}

function shiftTrackKeyframes(clip: Clip, deltaMs: number): Clip['keyframes'] {
  const out: Clip['keyframes'] = {}
  for (const key of Object.keys(clip.keyframes) as (keyof Clip['keyframes'])[]) {
    const list = clip.keyframes[key]
    if (!list) continue
    out[key] = list.map((k) => ({ ...k, t: Math.max(0, k.t + deltaMs) }))
  }
  return out
}

function rippleAfter(
  clips: Clip[],
  trackId: string,
  boundary: number,
  delta: number,
  ignoreId: string,
  mode: 'shiftBy' | 'shiftTo'
): Clip[] {
  if (Math.abs(delta) < 0.5) return clips
  return clips.map((c) => {
    if (c.trackId !== trackId || c.id === ignoreId) return c
    if (mode === 'shiftBy') {
      return c.start >= boundary - 1 ? { ...c, start: Math.max(0, c.start + delta) } : c
    }
    return c
  })
}

/** Ripple delete: remove a clip and pull later clips on the same track left. */
export function rippleDelete(project: Project, clipId: string): Project {
  const clip = findClip(project, clipId)
  if (!clip) return project
  const gap = clip.duration
  const clips = project.clips
    .filter((c) => c.id !== clipId)
    .map((c) =>
      c.trackId === clip.trackId && c.start >= clip.start + clip.duration - 1
        ? { ...c, start: Math.max(0, c.start - gap) }
        : c
    )
  return { ...project, clips }
}

/** Ripple delete an arbitrary time range across one track or all tracks. */
export function rippleDeleteRange(project: Project, start: number, end: number, trackId?: string): Project {
  const span = Math.max(0, end - start)
  let clips = project.clips
  for (const track of project.tracks) {
    if (trackId && track.id !== trackId) continue
    clips = clearRange(clips, track.id, start, end)
  }
  clips = clips.map((c) =>
    (!trackId || c.trackId === trackId) && c.start >= end - 1 ? { ...c, start: Math.max(0, c.start - span) } : c
  )
  return { ...project, clips }
}

/** Insert edit: push everything on the track right before placing a clip. */
export function insertClip(project: Project, clip: Clip, at: number): Project {
  const clips = project.clips.map((c) =>
    c.trackId === clip.trackId && c.start >= at - 1
      ? { ...c, start: c.start + clip.duration }
      : c
  )
  clips.push({ ...clip, start: at })
  return { ...project, clips }
}

/** Overwrite edit: place a clip, clearing anything underneath it. */
export function overwriteClip(project: Project, clip: Clip, at: number): Project {
  const placed = { ...clip, start: at }
  const clips = project.clips.filter((c) => c.id !== placed.id)
  const cleared = clearRange(clips, placed.trackId, at, at + placed.duration, placed.id)
  return { ...project, clips: [...cleared, placed] }
}

export function duplicateClip(project: Project, clipId: string): { project: Project; newId?: string } {
  const clip = findClip(project, clipId)
  if (!clip) return { project }
  const copy: Clip = {
    ...structuredClone(clip),
    id: uid('clip'),
    start: clip.start + clip.duration
  }
  // Clone keyframe ids so the two clips are independent.
  for (const key of Object.keys(copy.keyframes) as (keyof Clip['keyframes'])[]) {
    copy.keyframes[key] = (copy.keyframes[key] ?? []).map((k) => ({ ...k, id: uid('kf') }))
  }
  return { project: { ...project, clips: [...project.clips, copy] }, newId: copy.id }
}

export function deleteClips(project: Project, clipIds: string[]): Project {
  const ids = new Set(clipIds)
  return { ...project, clips: project.clips.filter((c) => !ids.has(c.id)) }
}

export function groupClips(project: Project, clipIds: string[]): { project: Project; groupId: string } {
  const groupId = uid('group')
  return {
    project: {
      ...project,
      clips: project.clips.map((c) => (clipIds.includes(c.id) ? { ...c, groupId } : c))
    },
    groupId
  }
}

export function ungroupClips(project: Project, groupId: string): Project {
  return {
    ...project,
    clips: project.clips.map((c) => (c.groupId === groupId ? { ...c, groupId: undefined } : c))
  }
}

/**
 * Clamp a proposed move for a group of clips so none of them cross zero, and
 * optionally auto-create space on the target track.
 */
export function clampGroupMove(clips: Clip[], deltaTime: number): number {
  const minStart = Math.min(...clips.map((c) => c.start))
  return Math.max(deltaTime, -minStart)
}

/** Total time covered by a set of clips (used for "fit selection"). */
export function selectionRange(clips: Clip[]): { start: number; end: number } | null {
  if (clips.length === 0) return null
  return {
    start: Math.min(...clips.map((c) => c.start)),
    end: Math.max(...clips.map((c) => c.start + c.duration))
  }
}

/** Add a track next to tracks of the same kind, keeping a stable visual order. */
export function addTrack(project: Project, kind: TrackKind, name?: string): { project: Project; track: Track } {
  const order: TrackKind[] = ['caption', 'text', 'graphic', 'video', 'audio']
  const existing = project.tracks.filter((t) => t.kind === kind).length
  const track = makeTrack(kind, name ?? `${labelFor(kind)} ${existing + 1}`, project.tracks.length)
  // Insert after the last track of the same kind, else before kinds that come later.
  let insertAt = project.tracks.length
  const kindIndex = order.indexOf(kind)
  for (let i = 0; i < project.tracks.length; i++) {
    if (order.indexOf(project.tracks[i].kind) > kindIndex) {
      insertAt = i
      break
    }
  }
  if (insertAt === project.tracks.length) {
    const lastSame = project.tracks.map((t) => t.kind).lastIndexOf(kind)
    if (lastSame >= 0) insertAt = lastSame + 1
  }
  const tracks = [...project.tracks]
  tracks.splice(insertAt, 0, track)
  return { project: { ...project, tracks }, track }
}

function labelFor(kind: TrackKind): string {
  switch (kind) {
    case 'video':
      return 'Video'
    case 'audio':
      return 'Audio'
    case 'text':
      return 'Text'
    case 'caption':
      return 'Captions'
    case 'graphic':
      return 'Graphics'
    case 'image':
      return 'Images'
  }
}

export function removeTrack(project: Project, trackId: string): Project {
  return {
    ...project,
    tracks: project.tracks.filter((t) => t.id !== trackId),
    clips: project.clips.filter((c) => c.trackId !== trackId)
  }
}

export function moveTrack(project: Project, trackId: string, direction: -1 | 1): Project {
  const index = project.tracks.findIndex((t) => t.id === trackId)
  const target = index + direction
  if (index < 0 || target < 0 || target >= project.tracks.length) return project
  const tracks = [...project.tracks]
  const [t] = tracks.splice(index, 1)
  tracks.splice(target, 0, t)
  return { ...project, tracks }
}

/** Snap helper: find the closest magnetic point among clip edges, playhead and markers. */
export function snapTime(
  project: Project,
  time: number,
  thresholdMs: number,
  opts: { ignoreClipIds?: string[]; playhead?: number; includeMarkers?: boolean } = {}
): { time: number; snapped: number | null } {
  const ignore = new Set(opts.ignoreClipIds ?? [])
  const points: number[] = [0]
  for (const c of project.clips) {
    if (ignore.has(c.id)) continue
    points.push(c.start, c.start + c.duration)
  }
  if (opts.playhead !== undefined) points.push(opts.playhead)
  if (opts.includeMarkers) for (const m of project.markers) points.push(m.time)
  let best: number | null = null
  let bestDist = thresholdMs
  for (const p of points) {
    const d = Math.abs(p - time)
    if (d < bestDist) {
      bestDist = d
      best = p
    }
  }
  return best === null ? { time, snapped: null } : { time: best, snapped: best }
}

/** Order tracks for compositing: video/graphics bottom-up, text/captions last. */
export function compositingOrder(project: Project): Track[] {
  // project.tracks is visual order top-first for overlays. Export composites the
  // last visual track first, so we reverse it.
  return [...project.tracks].reverse()
}
