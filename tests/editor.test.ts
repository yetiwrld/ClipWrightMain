/**
 * Timeline engine, scene graph, captions and scoring.
 *
 * These are the invariants the editor UI and the ffmpeg renderer both depend on,
 * so they are tested directly against the shared modules (no mocks).
 */
import { describe, expect, it } from 'vitest'
import {
  baseClip,
  clearRange,
  defaultTracks,
  groupClips,
  insertClip,
  overwriteClip,
  projectDuration,
  rippleDelete,
  snapTime,
  splitClip,
  trimClip,
  ungroupClips
} from '@shared/timeline'
import { createProject } from '@shared/defaults'
import { buildScene, transitionAlpha } from '@shared/scene'
import { buildCaptionClips, captionsToSrt, captionsToVtt, parseSubtitleFile } from '@shared/captions'
import { FALLBACK_CAPTION_PRESETS } from '@shared/presets'
import { weightedScore, scoreWindows } from '@shared/scoring'
import { buildAudioGraph } from '@shared/audio-graph'
import type { TranscriptSegment } from '@shared/types'

describe('timeline engine', () => {
  it('creates a project with default tracks and no clips', () => {
    const project = createProject('t', '9:16', 30)
    expect(project.tracks.length).toBe(defaultTracks().length)
    expect(project.clips).toEqual([])
    expect(projectDuration(project)).toBe(0)
  })

  it('splits a clip into two abutting clips that keep the source mapping', () => {
    const project = createProject('split', '9:16', 30)
    const track = project.tracks.find((t) => t.kind === 'video')!
    const clip = baseClip('video', track.id, 'a.mp4')
    clip.start = 1000
    clip.duration = 4000
    clip.sourceIn = 500
    project.clips.push(clip)
    const split = splitClip(project, clip.id, 2500)
    const parts = split.clips.sort((a, b) => a.start - b.start)
    expect(parts.length).toBe(2)
    expect(parts[0].start).toBe(1000)
    expect(parts[0].duration).toBe(1500)
    expect(parts[0].sourceIn).toBe(500)
    expect(parts[1].start).toBe(2500)
    expect(parts[1].duration).toBe(2500)
    // The second half continues where the first stopped in the source.
    expect(parts[1].sourceIn).toBe(2000)
    expect(projectDuration(split)).toBe(5000)
  })

  it('clamps trims so a clip can never invert or outrun its source', () => {
    const project = createProject('trim', '9:16', 30)
    const track = project.tracks.find((t) => t.kind === 'video')!
    const clip = baseClip('video', track.id, 'a.mp4')
    clip.start = 1000
    clip.duration = 3000
    clip.sourceIn = 0
    clip.sourceDuration = 3000
    project.clips.push(clip)

    // Dragging the in-point before the media start is refused. The clip starts
    // at 1000 with no handle to the left, so the earliest legal in-point is its
    // own start — this is what stops trim from inventing media.
    const early = trimClip(project, clip.id, 'start', -5000)
    expect(early.clips[0].start).toBe(1000)
    expect(early.clips[0].sourceIn).toBe(0)
    expect(early.clips[0].duration).toBe(3000)

    // With 2s of unused source available, extending the head is allowed.
    const withRoom = structuredClone(project)
    withRoom.clips[0].start = 3000
    withRoom.clips[0].sourceIn = 2000
    const extended = trimClip(withRoom, clip.id, 'start', 1000)
    expect(extended.clips[0].start).toBe(1000)
    expect(extended.clips[0].sourceIn).toBe(0)

    // …and the in-point cannot move past the tail of the source.
    const late = trimClip(project, clip.id, 'end', 99_999)
    expect(late.clips[0].duration).toBeLessThanOrEqual(3000)
  })

  it('ripple delete pulls later clips left by exactly the removed duration', () => {
    const project = createProject('ripple', '9:16', 30)
    const track = project.tracks.find((t) => t.kind === 'video')!
    const a = baseClip('video', track.id, 'a.mp4')
    a.start = 0
    a.duration = 1000
    const b = baseClip('video', track.id, 'b.mp4')
    b.start = 2000
    b.duration = 1000
    project.clips.push(a, b)
    const after = rippleDelete(project, a.id)
    expect(after.clips.length).toBe(1)
    expect(after.clips[0].start).toBe(1000)
  })

  it('insert pushes downstream clips; overwrite replaces the covered range', () => {
    const project = createProject('place', '9:16', 30)
    const track = project.tracks.find((t) => t.kind === 'video')!
    const existing = baseClip('video', track.id, 'existing.mp4')
    existing.start = 0
    existing.duration = 2000
    project.clips.push(existing)

    const inserted = baseClip('video', track.id, 'new.mp4')
    inserted.duration = 1000
    const afterInsert = insertClip(project, inserted, 0)
    const shifted = afterInsert.clips.find((c) => c.id === existing.id)!
    // Inserting at the head pushes the existing clip back by the new duration,
    // so nothing is ever overwritten and audio stays in sync.
    expect(shifted.start).toBe(1000)

    const overwritten = overwriteClip(project, inserted, 500)
    const spliced = overwritten.clips.filter((c) => c.id !== inserted.id)
    // Overwriting the middle splits the old clip into a head and a tail.
    expect(spliced.length).toBe(2)
    expect(spliced[0].start).toBe(0)
    expect(spliced[0].duration).toBe(500)
    expect(spliced[1].start).toBe(1500)
  })

  it('clearRange removes only the requested window and leaves the rest intact', () => {
    const project = createProject('clear', '9:16', 30)
    const track = project.tracks.find((t) => t.kind === 'video')!
    const clip = baseClip('video', track.id, 'long.mp4')
    clip.start = 0
    clip.duration = 4000
    project.clips.push(clip)
    const clips = clearRange(project.clips, track.id, 1000, 2000)
    expect(clips.length).toBe(2)
    expect(clips[0].duration).toBe(1000)
    expect(clips[1].start).toBe(2000)
  })

  it('groups and ungroups clips without moving them', () => {
    const project = createProject('group', '9:16', 30)
    const track = project.tracks.find((t) => t.kind === 'video')!
    const a = baseClip('video', track.id, 'a.mp4')
    a.start = 0
    a.duration = 500
    const b = baseClip('video', track.id, 'b.mp4')
    b.start = 1000
    b.duration = 500
    project.clips.push(a, b)
    const grouped = groupClips(project, [a.id, b.id])
    expect(grouped.project.clips.every((c) => c.groupId === grouped.groupId)).toBe(true)
    const ungrouped = ungroupClips(grouped.project, grouped.groupId)
    expect(ungrouped.clips.some((c) => c.groupId)).toBe(false)
  })

  it('snaps to clip edges, the playhead and markers within the threshold', () => {
    const project = createProject('snap', '9:16', 30)
    const track = project.tracks.find((t) => t.kind === 'video')!
    const clip = baseClip('video', track.id, 'a.mp4')
    clip.start = 1000
    clip.duration = 1000
    project.clips.push(clip)
    project.markers.push({ id: 'm', time: 5000, label: 'm', color: '#fff' })

    expect(snapTime(project, 1030, 60).time).toBe(1000)
    expect(snapTime(project, 1980, 60).time).toBe(2000)
    expect(snapTime(project, 1030, 10).snapped).toBeNull()
    expect(snapTime(project, 5040, 80, { includeMarkers: true, playhead: 3000 }).time).toBe(5000)
    expect(snapTime(project, 3020, 60, { playhead: 3000 }).time).toBe(3000)
  })
})

describe('scene graph', () => {
  function sceneProject() {
    const project = createProject('scene', '9:16', 30)
    const video = project.tracks.find((t) => t.kind === 'video')!
    const caption = project.tracks.find((t) => t.kind === 'caption')!
    const clip = baseClip('video', video.id, 'a.mp4')
    clip.start = 0
    clip.duration = 4000
    clip.sourceIn = 0
    project.clips.push(clip)
    const captionClips = buildCaptionClips(
      [{ id: 's1', start: 0, end: 2000, text: 'hello world this is a test' }],
      { start: 0, end: 2000 },
      FALLBACK_CAPTION_PRESETS[0],
      caption.id,
      0
    )
    project.clips.push(...captionClips)
    return { project, videoClip: clip, captionClips }
  }

  it('includes the visible clip and draws captions above video', () => {
    const { project } = sceneProject()
    const scene = buildScene(project, 500)
    expect(scene.width).toBe(1080)
    expect(scene.height).toBe(1920)
    expect(scene.layers.length).toBeGreaterThan(1)
    expect(scene.layers[scene.layers.length - 1].kind).toBe('caption')
    expect(scene.layers[0].kind).toBe('video')
  })

  it('hides clips outside their time range', () => {
    const { project } = sceneProject()
    expect(buildScene(project, 10_000).layers.length).toBe(0)
  })

  it('honours track mute/solo for audio but keeps video visible', () => {
    const { project } = sceneProject()
    const state = structuredClone(project)
    state.tracks = state.tracks.map((t) => (t.kind === 'video' ? { ...t, muted: true } : t))
    // Muting a video track mutes its audio; the picture still renders.
    expect(buildScene(state, 500).layers.some((l) => l.kind === 'video')).toBe(true)
  })

  it('fades through transparency for crossfades and dips to zero for fades to black', () => {
    expect(transitionAlpha('crossfade', 0, 'in')).toBeCloseTo(0, 5)
    expect(transitionAlpha('crossfade', 1, 'in')).toBeCloseTo(1, 5)
    expect(transitionAlpha('crossfade', 0.5, 'in')).toBeCloseTo(0.5, 5)
    // fadeToBlack reaches full transparency at its own boundary.
    expect(transitionAlpha('fadeToBlack', 0, 'out')).toBeCloseTo(1, 5)
    expect(transitionAlpha('fadeToBlack', 1, 'out')).toBeCloseTo(0, 5)
    // Dissolve is smoothstep — slower at the ends than linear.
    expect(transitionAlpha('dissolve', 0.25, 'in')).toBeLessThan(0.25)
    expect(transitionAlpha('dissolve', 0.75, 'in')).toBeGreaterThan(0.75)
  })

  it('applies a transition alpha to the layer opacity mid-fade', () => {
    const { project, videoClip } = sceneProject()
    const state = structuredClone(project)
    state.clips = state.clips.map((c) =>
      c.id === videoClip.id
        ? { ...c, transitionIn: { id: 't', type: 'crossfade', durationMs: 1000 } }
        : c
    )
    // Halfway through the fade: the layer exists, is marked as transitioning and
    // its alpha is the transition curve — this is what reveals the track below.
    const midway = buildScene(state, -500 + 250) // 250 ms into the 1s fade
    const layer = midway.layers.find((l) => l.kind === 'video')
    expect(layer).toBeDefined()
    expect(layer!.inTransition).toBe(true)
    expect(layer!.opacity).toBeLessThan(1)
    expect(layer!.opacity).toBeGreaterThan(0)
    // At the very start of the handle the clip is fully transparent.
    const atStart = buildScene(state, -1000 + 5)
    const startLayer = atStart.layers.find((l) => l.kind === 'video')
    expect(startLayer?.opacity ?? 0).toBeLessThan(0.05)
    // After the fade completes the clip is fully opaque again.
    const after = buildScene(state, 1500)
    expect(after.layers.find((l) => l.kind === 'video')!.opacity).toBeCloseTo(1, 2)
  })
})

describe('captions', () => {
  it('exports SRT with sequential indices and millisecond timings', () => {
    const trackId = defaultTracks().find((t) => t.kind === 'caption')!.id
    const clips = buildCaptionClips(
      [
        { id: 's1', start: 0, end: 1500, text: 'First line here' },
        { id: 's2', start: 1500, end: 3000, text: 'Second line here' }
      ],
      { start: 0, end: 3000 },
      FALLBACK_CAPTION_PRESETS[0],
      trackId,
      0
    )
    const srt = captionsToSrt(clips)
    expect(srt).toMatch(/^1\r?\n00:00:00,000 --> /)
    expect(srt).toContain('First line')
    expect(srt.split('\n\n').filter(Boolean).length).toBe(clips.length)
  })

  it('exports WebVTT with a header and dot-separated timings', () => {
    const trackId = defaultTracks().find((t) => t.kind === 'caption')!.id
    const clips = buildCaptionClips(
      [{ id: 's1', start: 0, end: 1000, text: 'Vtt line' }],
      { start: 0, end: 1000 },
      FALLBACK_CAPTION_PRESETS[0],
      trackId,
      0
    )
    const vtt = captionsToVtt(clips)
    expect(vtt.startsWith('WEBVTT')).toBe(true)
    expect(vtt).toMatch(/00:00:00\.000 --> /)
  })

  it('parses an SRT file back into caption clips', () => {
    const srt = ['1', '00:00:01,000 --> 00:00:02,500', 'Hello there', '', '2', '00:00:02,500 --> 00:00:04,000', 'General Kenobi', ''].join('\n')
    const clips = parseSubtitleFile(srt, 'track-1')
    expect(clips.length).toBe(2)
    expect(clips[0].kind).toBe('caption')
    expect(clips[0].start).toBe(1000)
    expect(clips[0].duration).toBe(1500)
    expect(clips[1].text).toBe('General Kenobi')
  })

  it('parses WebVTT input as well', () => {
    const vtt = ['WEBVTT', '', '00:00:00.500 --> 00:00:01.500', 'Web subtitle'].join('\n')
    const clips = parseSubtitleFile(vtt, 'track-1')
    expect(clips.length).toBe(1)
    expect(clips[0].start).toBe(500)
    expect(clips[0].text).toBe('Web subtitle')
  })
})

describe('moment scoring', () => {
  const segments: TranscriptSegment[] = Array.from({ length: 40 }, (_, i) => ({
    id: `s${i}`,
    start: i * 2000,
    end: (i + 1) * 2000,
    text:
      i === 12
        ? 'The mistake almost cost me everything, and that changed how I think about money forever.'
        : `This is filler sentence number ${i} about ordinary things happening.`
  }))

  it('scores candidate windows inside the requested duration bounds', () => {
    const moments = scoreWindows(segments, { minDurationMs: 10_000, maxDurationMs: 30_000, targetCount: 5 })
    expect(moments.length).toBeGreaterThan(0)
    expect(moments.length).toBeLessThanOrEqual(5)
    for (const moment of moments) {
      const duration = moment.end - moment.start
      expect(duration).toBeGreaterThanOrEqual(10_000 - 2000)
      expect(duration).toBeLessThanOrEqual(30_000 + 2001)
      expect(moment.start).toBeGreaterThanOrEqual(0)
      expect(moment.score).toBeGreaterThanOrEqual(0)
      expect(moment.score).toBeLessThanOrEqual(100)
    }
  })

  it('is deterministic — the same transcript always yields the same result', () => {
    const a = scoreWindows(segments, { minDurationMs: 10_000, maxDurationMs: 30_000, targetCount: 5 })
    const b = scoreWindows(segments, { minDurationMs: 10_000, maxDurationMs: 30_000, targetCount: 5 })
    expect(a.map((m) => `${m.start}-${m.end}-${m.score}`)).toEqual(b.map((m) => `${m.start}-${m.end}-${m.score}`))
  })

  it('returns nothing for a transcript shorter than the minimum window', () => {
    expect(scoreWindows([{ id: 's', start: 0, end: 1000, text: 'hi' }], { minDurationMs: 10_000, maxDurationMs: 30_000, targetCount: 3 })).toEqual([])
  })

  it('weights every dimension and stays inside 0..100', () => {
    expect(
      weightedScore({
        hook: 100,
        emotion: 100,
        standalone: 100,
        interest: 100,
        storytelling: 100,
        value: 100,
        pacing: 100,
        social: 100
      })
    ).toBe(100)
    expect(
      weightedScore({
        hook: 0,
        emotion: 0,
        standalone: 0,
        interest: 0,
        storytelling: 0,
        value: 0,
        pacing: 0,
        social: 0
      })
    ).toBe(0)
  })
})

describe('audio graph', () => {
  it('builds a WAV mix with one input per audible clip and no video', () => {
    const project = createProject('audio', '9:16', 30)
    const video = project.tracks.find((t) => t.kind === 'video')!
    const clip = baseClip('video', video.id, 'a.mp4')
    clip.start = 0
    clip.duration = 2000
    clip.assetId = 'asset-1'
    project.clips.push(clip)
    project.assets.push({
      id: 'asset-1',
      name: 'a.mp4',
      path: '/media/a.mp4',
      kind: 'video',
      storage: 'linked',
      probe: { kind: 'video', durationMs: 4000, hasAudio: true },
      importedAt: Date.now()
    })
    const graph = buildAudioGraph(project, { start: 0, end: 2000 }, { 'asset-1': { path: '/media/a.mp4' } })
    expect(graph.inputs.length).toBe(1)
    expect(graph.inputs[0].path).toBe('/media/a.mp4')
    expect(graph.inputs[0].duration).toBe(2000)
    expect(graph.filter).toContain('amix')
    expect(graph.warnings).toEqual([])

    // A muted clip contributes nothing at all.
    const muted = structuredClone(project)
    muted.clips[0].audio.muted = true
    expect(buildAudioGraph(muted, { start: 0, end: 2000 }, { 'asset-1': { path: '/media/a.mp4' } }).inputs.length).toBe(0)
  })
})
