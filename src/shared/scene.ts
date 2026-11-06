/**
 * Scene builder — the single source of truth for "what is on screen at time T".
 *
 * Both the preview monitor (canvas 2D) and the export renderer (FFmpeg filter
 * graph) consume this structure. That is why exported frames match the preview:
 * there is one description of the frame, two renderers.
 *
 * Transition semantics are deliberately renderer-agnostic: a clip with a
 * transitionIn/Out fades to/from *transparent* during the transition, revealing
 * whatever is beneath it on the timeline. Both renderers implement exactly that.
 */
import { resolveClipProps } from './keyframes'
import { effectSpeed, trackIsAudible } from './timeline-helpers'
import { clamp } from './time'
import type {
  AnimatableProp,
  CaptionWord,
  Clip,
  Effect,
  Project,
  TextStyle,
  TextBoxLayout
} from './types'

export interface SceneTransform {
  x: number
  y: number
  scaleX: number
  scaleY: number
  rotation: number
  opacity: number
  cropL: number
  cropR: number
  cropT: number
  cropB: number
}

export interface SceneLayer {
  id: string
  kind: Clip['kind']
  assetId?: string
  /** ms inside the source media to display */
  sourceTime: number
  name: string
  transform: SceneTransform
  effects: Effect[]
  /** clip + track opacity, already including transition alpha */
  opacity: number
  /** clip-local time in ms (may be negative during a transition handle) */
  localTime: number
  /** clip duration in ms */
  durationMs: number
  /** true when part of an in/out transition is active */
  inTransition: boolean
  outTransition: boolean
  /** text payload */
  text?: string
  style?: TextStyle
  layout?: TextBoxLayout
  /** clip-relative word timings */
  words?: CaptionWord[]
  animationName?: string
  animationDurationMs: number
  highlightMode?: 'none' | 'keyword' | 'spoken'
  keywordIndices?: number[]
  iconName?: string
  svg?: string
  speed: number
  sourceDuration?: number
  /** fully transparent at this instant (e.g. fade to black) — skip drawing */
  hidden?: boolean
}

export interface Scene {
  width: number
  height: number
  background: string
  time: number
  fps: number
  /** bottom-up draw order */
  layers: SceneLayer[]
}

function transformFrom(props: Record<AnimatableProp, number>): SceneTransform {
  return {
    x: props.x,
    y: props.y,
    scaleX: props.scaleX * props.scale,
    scaleY: props.scaleY * props.scale,
    rotation: props.rotation,
    opacity: clamp(props.opacity, 0, 1),
    cropL: props.cropL,
    cropR: props.cropR,
    cropT: props.cropT,
    cropB: props.cropB
  }
}

export function transitionDuration(clip: Clip, edge: 'in' | 'out'): number {
  const t = edge === 'in' ? clip.transitionIn : clip.transitionOut
  if (!t) return 0
  return Math.max(0, Math.min(t.durationMs, clip.duration))
}

/**
 * Alpha contribution of a transition at a given progress inside the transition.
 * `fadeToBlack` dips to zero at the midpoint so the canvas background shows
 * through in both the preview and the export.
 */
export function transitionAlpha(
  type: string,
  progress: number,
  direction: 'in' | 'out'
): number {
  const p = clamp(progress, 0, 1)
  switch (type) {
    case 'fadeToBlack':
    case 'fadeFromBlack': {
      // Applies to whichever side is active: incoming ramps 0→1, outgoing 1→0,
      // but both reach 0 at their respective boundary.
      return direction === 'in' ? Math.pow(p, 1.4) : Math.pow(1 - p, 1.4)
    }
    case 'dissolve':
      return p * p * (3 - 2 * p)
    default:
      return p
  }
}

function buildLayers(project: Project, track: Project['tracks'][number], time: number): SceneLayer[] {
  const clips = project.clips
    .filter((c) => c.trackId === track.id)
    .sort((a, b) => a.start - b.start)
  const layers: SceneLayer[] = []

  for (const clip of clips) {
    const inDur = transitionDuration(clip, 'in')
    const outDur = transitionDuration(clip, 'out')
    const visibleStart = clip.start - (clip.transitionIn ? inDur : 0)
    const visibleEnd = clip.start + clip.duration + (clip.transitionOut ? outDur : 0)
    if (time < visibleStart - 0.5 || time >= visibleEnd - 0.5) continue

    const localTime = time - clip.start
    const props = resolveClipProps(clip, clamp(localTime, 0, clip.duration))
    const transform = transformFrom(props)
    let opacity = transform.opacity * (track.opacity ?? 1)

    let inTransition = false
    let outTransition = false
    if (clip.transitionIn && localTime < 0) {
      inTransition = true
      const progress = 1 - Math.abs(localTime) / Math.max(1, inDur)
      opacity *= transitionAlpha(clip.transitionIn.type, progress, 'in')
    }
    if (clip.transitionOut && localTime > clip.duration) {
      outTransition = true
      const progress = clamp((localTime - clip.duration) / Math.max(1, outDur), 0, 1)
      opacity *= transitionAlpha(clip.transitionOut.type, progress, 'out')
    }
    if (opacity <= 0.002) {
      // Keep the layer so the renderer knows it exists (e.g. to stop decoding),
      // but mark it hidden.
      layers.push(makeLayer(clip, track, localTime, transform, 0, inTransition, outTransition))
      continue
    }
    layers.push(makeLayer(clip, track, localTime, transform, opacity, inTransition, outTransition))
  }
  return layers
}

function makeLayer(
  clip: Clip,
  track: Project['tracks'][number],
  localTime: number,
  transform: SceneTransform,
  opacity: number,
  inTransition: boolean,
  outTransition: boolean
): SceneLayer {
  const speed = effectSpeed(clip)
  const words = clip.words?.map((w) => ({ ...w, start: w.start - clip.start, end: w.end - clip.start }))
  return {
    id: clip.id,
    kind: clip.kind,
    assetId: clip.assetId,
    sourceTime: Math.max(0, clip.sourceIn + Math.max(0, localTime) * speed),
    name: clip.name,
    transform,
    effects: clip.effects.filter((e) => e.enabled),
    opacity,
    localTime,
    durationMs: clip.duration,
    inTransition,
    outTransition,
    text: clip.text,
    style: clip.style,
    layout: clip.layout,
    words,
    animationName: clip.animation,
    animationDurationMs: clip.animationDurationMs ?? 180,
    highlightMode: clip.highlightMode,
    keywordIndices: clip.keywordIndices,
    iconName: clip.iconName,
    svg: clip.svg,
    speed,
    sourceDuration: clip.sourceDuration,
    hidden: opacity <= 0.002
  }
}

/** Build the scene at a moment in time. Layers are ordered bottom-up. */
export function buildScene(project: Project, time: number): Scene {
  const layers: SceneLayer[] = []
  const soloed = project.tracks.some((t) => t.solo)
  // project.tracks is stored top-first for overlays; composite bottom-up.
  const ordered = [...project.tracks].reverse()
  for (const track of ordered) {
    if (!track.visible) continue
    if ((track.kind as string) === 'audio') continue
    if (soloed && !track.solo && (track.kind === 'video' || track.kind === 'audio')) continue
    layers.push(...buildLayers(project, track, time))
  }
  return {
    width: project.canvas.width,
    height: project.canvas.height,
    background: project.canvas.backgroundColor || '#000000',
    time,
    fps: project.fps,
    layers
  }
}

/** Which asset ids are needed to render a scene (used to pre-warm decoders). */
export function sceneAssetIds(scene: Scene): string[] {
  return [
    ...new Set(
      scene.layers.filter((l) => l.assetId && !l.hidden).map((l) => l.assetId as string)
    )
  ]
}

/** Is this track audible at all (respecting solo/mute)? */
export function isTrackAudible(project: Project, trackId: string): boolean {
  const track = project.tracks.find((t) => t.id === trackId)
  if (!track) return false
  return trackIsAudible(project, track)
}
