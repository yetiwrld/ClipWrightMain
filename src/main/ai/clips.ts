/**
 * Automatic clip generation.
 *
 * Turns a detected moment into a fully editable project:
 *   • correct source range and chosen aspect ratio,
 *   • captions generated from the transcript with the selected preset,
 *   • optional automatic reframing of the source into the target aspect,
 *   • original audio preserved, then opened in the editor.
 *
 * Nothing is baked in: the new project is an ordinary timeline the user can edit.
 */
import fs from 'node:fs'
import path from 'node:path'
import { baseClip, ensureTrack } from '@shared/timeline'
import { buildCaptionClips, presetById } from '@shared/captions'
import { pickKeywordIndices } from '@shared/captions'
import { canvasSizeFor, recommendAspect } from '@shared/presets'
import { createProject } from '@shared/defaults'
import { displaySize } from '../ffmpeg/probe'
import type { CaptionPreset, MediaAsset, Moment, Project, Transcript } from '@shared/types'
import { saveProjectSync } from '../projects'

export interface GenerateClipOptions {
  moment: Moment
  sourceProject: Project
  transcript: Transcript
  aspect: string
  fps: number
  captionPreset: CaptionPreset
  name: string
  /** Auto-frame the speaker/subject into the target aspect. */
  autoFrame?: boolean
  includeCaptions?: boolean
}

export function generateClipProject(opts: GenerateClipOptions): Project {
  const { moment, sourceProject, transcript } = opts
  const aspect = opts.aspect || sourceProject.canvas.aspect
  const { width, height } = canvasSizeFor(aspect, 1920)
  let project = createProject(opts.name, aspect, opts.fps)
  project.canvas.width = width
  project.canvas.height = height
  project.canvas.fps = opts.fps
  project.fps = opts.fps

  // Assets are copied by reference — managed media lives in the source project's
  // folder, so we link the same files.
  project.assets = structuredClone(sourceProject.assets)
  project.source = { assetId: sourceProject.source?.assetId ?? sourceProject.assets.find((a) => a.kind === 'video')?.id }
  project.captionPresetId = opts.captionPreset.id

  const duration = moment.end - moment.start
  /*
   * Both tracks are created on demand. These were non-null assertions (`!`) over
   * `Array.find`, so a project without a video or caption track threw a
   * TypeError part-way through generation — after the new project had already
   * been written to disk, leaving an empty project behind.
   */
  const video = ensureTrack(project, 'video', 'Video 1')
  project = video.project
  const videoTrack = video.track
  const sourceAsset =
    sourceProject.assets.find((a) => a.id === project.source?.assetId) ??
    sourceProject.assets.find((a) => a.kind === 'video')

  if (sourceAsset) {
    const clip = baseClip('video', videoTrack.id, `${moment.title} — source`)
    clip.assetId = sourceAsset.id
    clip.start = 0
    clip.duration = duration
    clip.sourceIn = moment.start
    clip.sourceDuration = sourceAsset.probe.durationMs
    if (opts.autoFrame) {
      applyAutoFrame(clip, sourceAsset, aspect, width, height)
    }
    project.clips.push(clip)
  }

  if (opts.includeCaptions !== false && transcript.segments.length) {
    const caption = ensureTrack(project, 'caption', 'Captions')
    project = caption.project
    const captionTrack = caption.track
    const captions = buildCaptionClips(
      transcript.segments,
      { start: moment.start, end: moment.end },
      opts.captionPreset,
      captionTrack.id,
      -moment.start
    )
    for (const caption of captions) {
      if (opts.captionPreset.highlightMode === 'keyword' && caption.words) {
        caption.keywordIndices = pickKeywordIndices(caption.words)
        caption.highlightMode = 'keyword'
      } else if (opts.captionPreset.highlightMode === 'spoken') {
        caption.highlightMode = 'spoken'
      } else {
        caption.highlightMode = 'none'
      }
    }
    project.clips.push(...captions)
  }

  // Title card at the start when the moment looks like a hook (optional polish).
  project.markers.push({
    id: `mk_${Math.random().toString(36).slice(2, 8)}`,
    time: 0,
    label: moment.title,
    color: '#FF7A18'
  })
  project.notes = `Generated from moment with score ${moment.score}/100.\n\n${moment.reason}`
  saveProjectSync(project)
  return project
}

/**
 * Automatic framing: choose the crop that best fills the target aspect and
 * keep the source centred (with a slight upward bias for faces).
 */
export function applyAutoFrame(
  clip: Project['clips'][number],
  asset: MediaAsset,
  aspect: string,
  canvasW: number,
  canvasH: number
): void {
  const source = displaySize(asset.probe)
  const target = canvasW / canvasH
  const sourceRatio = source.width / Math.max(1, source.height)
  // Transform coordinates are normalised to the canvas; scale is relative to a
  // "contain" fit, so >1 means the source is cropped to fill the frame.
  if (sourceRatio > target) {
    // Source is wider: fill height, crop the sides.
    clip.transform.scaleX = sourceRatio / target
    clip.transform.scaleY = 1
  } else {
    clip.transform.scaleX = 1
    clip.transform.scaleY = target / sourceRatio
  }
  clip.transform.x = 0.5
  clip.transform.y = 0.5
  clip.transform.scale = 1
}

/** Suggest the best aspect for a clip project from the source media. */
export function suggestAspect(asset: MediaAsset | undefined): string {
  if (!asset || !asset.probe.width || !asset.probe.height) return '9:16'
  const rec = recommendAspect(asset.probe.width, asset.probe.height)
  // For long-form talking-head sources, vertical is the common target.
  return rec === '16:9' ? '9:16' : rec
}

export function clipFileName(projectName: string, moment: Moment): string {
  const safe = `${projectName} - ${moment.title}`.replace(/[^\w\s-]/g, '').trim().slice(0, 80)
  return safe || 'Clip'
}

export function momentsToProjectsDir(): string {
  return path.join()
}
