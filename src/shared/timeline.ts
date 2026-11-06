/**
 * Timeline operations. Every mutation returns a new project (immutable) so the
 * editor can keep a reliable undo/redo history and so exports are deterministic.
 */
import { sliceTrack, uid } from './keyframes'
import { clamp, snapToFrame } from './time'
import type { Clip, ClipKind, Project, Track, TrackKind } from './types'

export const DEFAULT_TRACK_HEIGHT = 64

/**
 * Shortest clip the timeline will produce, in milliseconds.
 *
 * The unit matters: 80 ms is shorter than a frame at any common rate, so every
 * clamp that used this constant let a clip collapse to something no renderer
 * could show. It is now two frames at 30 fps — the shortest span that still
 * survives rounding to a frame boundary during a trim.
 */
export const MIN_CLIP_DURATION = 66

/**
 * Shortest clip a manual retime may produce. Deliberately coarser than
 * MIN_CLIP_DURATION: a human typing a duration wants a usable clip, while the
 * trim/split math only needs to stay above a frame.
 */
export const MIN_AUTHORED_DURATION = 100

/**
 * Coerce an externally supplied duration into a legal clip length.
 *
 * Every writer went through no validation at all, so a negative or NaN duration
 * (typed into the Inspector, or arriving from an import) produced a clip with
 * `duration: -4000` — which breaks selection, ripple math and the renderer's
 * segment splitting while looking like a perfectly normal clip in the UI.
 */
export function legalDuration(value: number | undefined | null, minimum = MIN_CLIP_DURATION): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return minimum
  return Math.max(minimum, Math.round(value))
}

/**
 * Coerce a `Partial<Clip>` patch so it can never carry an illegal timing value.
 *
 * `start` and `sourceIn` are clamped at zero: a negative start is not "before
 * the timeline", it is a clip the renderer drops silently, and a negative
 * `sourceIn` reads before the first frame of the media file.
 */
export function legalPatch(patch: Partial<Clip>): Partial<Clip> {
  const out: Partial<Clip> = { ...patch }
  if (out.duration !== undefined) out.duration = legalDuration(out.duration)
  if (out.start !== undefined) out.start = Math.max(0, Number.isFinite(out.start) ? out.start : 0)
  if (out.sourceIn !== undefined) out.sourceIn = Math.max(0, Number.isFinite(out.sourceIn) ? out.sourceIn : 0)
  return out
}

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
  /*
   * Soloing used to be enforced only for audio and only inside buildScene's
   * inline copy of this logic, so hiding the eye icon on a soloed-but-muted
   * track had no effect on the canvas while muting it did.
   */
  const soloed = project.tracks.some((t) => t.solo)
  if (soloed && !track.solo) return false
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

/**
 * Overwrite a range on a track.
 *
 * This used to *delete* every clip the range touched, while `overwriteClip` —
 * the function that actually implements the user-facing overwrite edit — calls
 * `clearRange`, which trims instead. Two functions named "overwrite" with
 * opposite destructive behaviour is exactly the kind of thing that turns a
 * dropped clip into a lost take. There is now one behaviour: trim what the range
 * covers, never delete media the range does not reach.
 *
 * @deprecated use `clearRange`; kept so older callers keep compiling.
 */
export function overwriteRange(clips: Clip[], trackId: string, start: number, end: number, ignoreId?: string): Clip[] {
  return clearRange(clips, trackId, start, end, ignoreId)
}

/**
 * Trim clips that overlap a range so the range becomes empty (ripple/overwrite
 * without destroying neighbouring media). Used by insert edits.
 */
export function clearRange(clips: Clip[], trackId: string, start: number, end: number, ignoreId?: string): Clip[] {
  /*
   * An inverted or empty range used to fall through every branch and, in the
   * "range is in the middle" case, produce two clips that both covered the same
   * media. A range is half-open and always ordered; anything else is a caller
   * bug, and doing nothing is the only safe answer.
   */
  const from = Math.min(start, end)
  const to = Math.max(start, end)
  if (!(to > from)) return [...clips]

  const out: Clip[] = []
  for (const c of clips) {
    if (c.trackId !== trackId || c.id === ignoreId) {
      out.push(c)
      continue
    }
    const cStart = c.start
    const cEnd = c.start + c.duration
    if (cEnd <= from || cStart >= to) {
      out.push(c)
      continue
    }
    // Clip completely covered.
    if (cStart >= from && cEnd <= to) continue
    // Clip straddles the start of the range: keep the head.
    if (cStart < from && cEnd <= to) {
      const head = from - cStart
      // A head shorter than the minimum clip length is not a clip: drop it
      // rather than leaving a 3 ms sliver the user can neither see nor drag.
      if (head >= MIN_CLIP_DURATION) out.push({ ...c, duration: head })
      continue
    }
    // Clip straddles the end of the range: keep the tail.
    if (cStart >= from && cEnd > to) {
      const cut = to - cStart
      const tail = cEnd - to
      if (tail >= MIN_CLIP_DURATION) {
        out.push(splitTail(c, to, cut, tail))
      }
      continue
    }
    // Range is in the middle of the clip: split and keep both sides.
    const headDuration = from - cStart
    const cut = to - cStart
    const tailDuration = cEnd - to
    if (headDuration >= MIN_CLIP_DURATION) out.push({ ...c, duration: headDuration })
    if (tailDuration >= MIN_CLIP_DURATION) out.push(splitTail(c, to, cut, tailDuration))
  }
  return out.sort((a, b) => a.start - b.start)
}

/**
 * The right-hand part of a clip cut at a later point in time.
 *
 * Keyframes are clip-local, so the new half must shift them by the cut, exactly
 * as a head trim does — otherwise the animation restarts on the second half of
 * every split clip. (`words` are absolute timeline times, so they need no shift.)
 */
function splitTail(clip: Clip, newStart: number, cut: number, duration: number): Clip {
  const keyframes: Clip['keyframes'] = {}
  for (const key of Object.keys(clip.keyframes) as (keyof Clip['keyframes'])[]) {
    const sliced = sliceTrack(clip.keyframes[key], cut)
    if (sliced && sliced.length) keyframes[key] = sliced
  }
  return {
    ...clip,
    id: uid('clip'),
    start: newStart,
    duration,
    sourceIn: clip.sourceIn + cut,
    keyframes,
    transitionIn: undefined
  }
}

/* ------------------------------------------------------------------ */
/* Editing primitives                                                 */
/* ------------------------------------------------------------------ */

export function splitClip(project: Project, clipId: string, atTime: number): Project {
  const clip = findClip(project, clipId)
  if (!clip) return project
  const local = atTime - clip.start
  if (local < MIN_CLIP_DURATION || clip.duration - local < MIN_CLIP_DURATION) return project
  /*
   * The right half keeps its position on the timeline but starts its animation
   * from the cut, so its keyframes are shifted back by `local`. Splitting an
   * animated clip used to replay the whole motion on the second half.
   */
  const right: Clip = splitTail(clip, atTime, local, clip.duration - local)
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
  const from = clip.start
  const to = clip.start + clip.duration
  const clips = project.clips
    .filter((c) => c.id !== clipId)
    .map((c) =>
      c.trackId === clip.trackId && c.start >= to - 1 ? { ...c, start: Math.max(0, c.start - gap) } : c
    )
  const markers = (project.markers ?? []).flatMap((m) => {
    if (m.time >= to - 1) return [{ ...m, time: Math.max(0, m.time - gap) }]
    if (m.time >= from) return []
    return [m]
  })
  return { ...project, clips, markers }
}

/** Ripple delete an arbitrary time range across one track or all tracks. */
export function rippleDeleteRange(project: Project, start: number, end: number, trackId?: string): Project {
  const from = Math.min(start, end)
  const to = Math.max(start, end)
  const span = Math.max(0, to - from)
  let clips = project.clips
  for (const track of project.tracks) {
    if (trackId && track.id !== trackId) continue
    clips = clearRange(clips, track.id, from, to)
  }
  clips = clips.map((c) =>
    (!trackId || c.trackId === trackId) && c.start >= to - 1 ? { ...c, start: Math.max(0, c.start - span) } : c
  )
  /*
   * Rippling used to leave markers behind, pointing at a moment that had just
   * been removed, so every marker after the cut was off by the deleted span.
   */
  const markers = (project.markers ?? []).flatMap((m) => {
    if (m.time >= to - 1) return [{ ...m, time: Math.max(0, m.time - span) }]
    if (m.time >= from) return []
    return [m]
  })
  return { ...project, clips, markers }
}

/**
 * Insert edit: push everything on the track right before placing a clip.
 *
 * The push only moved clips that *began* at or after the insertion point. A clip
 * straddling that point (it starts before, ends after) was left alone, so the
 * new clip was then laid on top of it — an insert edit that silently produced an
 * overlap. The straddling clip is now cut at the insertion point and only its
 * tail moves right.
 */
export function insertClip(project: Project, clip: Clip, at: number): Project {
  const duration = legalDuration(clip.duration)
  const shifted = project.clips.flatMap((c) => {
    if (c.trackId !== clip.trackId) return [c]
    const end = c.start + c.duration
    if (c.start >= at - 1) return [{ ...c, start: c.start + duration }]
    if (end <= at + 1) return [c]
    // Straddles the insertion point: keep the head in place, move the tail.
    const headDuration = at - c.start
    const tailDuration = end - at
    const parts: Clip[] = []
    if (headDuration >= MIN_CLIP_DURATION) parts.push({ ...c, duration: headDuration, transitionOut: undefined })
    if (tailDuration >= MIN_CLIP_DURATION) {
      parts.push({ ...splitTail(c, at + duration, headDuration, tailDuration), transitionOut: c.transitionOut })
    }
    return parts
  })
  return { ...project, clips: [...shifted, { ...clip, start: at, duration }] }
}

/** Overwrite edit: place a clip, clearing anything underneath it. */
export function overwriteClip(project: Project, clip: Clip, at: number): Project {
  const placed = { ...clip, start: Math.max(0, at), duration: legalDuration(clip.duration) }
  const clips = project.clips.filter((c) => c.id !== placed.id)
  const cleared = clearRange(clips, placed.trackId, placed.start, placed.start + placed.duration, placed.id)
  // The overwritten range also removes any markers that were sitting on it,
  // which is what "overwrite" means for a marker: the moment it pointed at is
  // gone. Markers outside the range keep their time.
  const markers = (project.markers ?? []).filter(
    (m) => !(m.time >= placed.start && m.time < placed.start + placed.duration)
  )
  return { ...project, clips: [...cleared, placed], markers }
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

/**
 * Find the first track of a kind, or add one.
 *
 * Callers used to write `project.tracks.find(t => t.kind === 'caption')!` and
 * then dereference it. That assertion is a promise the project structure cannot
 * keep: any project saved before caption tracks existed, or one where the user
 * deleted the caption track, makes it undefined — and the crash lands in the
 * middle of clip generation, after the project has already been created.
 */
export function ensureTrack(
  project: Project,
  kind: TrackKind,
  name?: string
): { project: Project; track: Track; created: boolean } {
  const existing = project.tracks.find((t) => t.kind === kind)
  if (existing) return { project, track: existing, created: false }
  const added = addTrack(project, kind, name)
  return { project: added.project, track: added.track, created: true }
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
