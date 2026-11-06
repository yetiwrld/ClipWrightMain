/**
 * Round 5 regression tests.
 *
 * Every case here failed against the 1.0.5 tree. They are written against the
 * shared modules (no Electron, no DOM) so they run in CI's plain Node job as
 * well as locally.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  MIN_CLIP_DURATION,
  MIN_AUTHORED_DURATION,
  baseClip,
  clearRange,
  ensureTrack,
  insertClip,
  isTrackVisible,
  legalDuration,
  legalPatch,
  overwriteClip,
  overwriteRange,
  removeTrack,
  rippleDelete,
  rippleDeleteRange,
  splitClip,
  trackIsAudible
} from '@shared/timeline'
import { buildScene } from '@shared/scene'
import {
  effectSpeed,
  isTrackAudible as helperAudible,
  trackIsAudible as helperTrackAudible
} from '@shared/timeline-helpers'
import { createProject } from '@shared/defaults'
import { applyEasing } from '@shared/easing'
import { sampleTrack } from '@shared/keyframes'
import type { Clip, Easing, Project, Track } from '@shared/types'

/** Keyframe easing is an object, not a string (a common source of test drift). */
const LINEAR: Easing = { kind: 'linear' }

/* ------------------------------- fixtures -------------------------------- */

function projectWithClips(): { project: Project; track: Track; clips: Clip[] } {
  const project = createProject('Test', '9:16', 30)
  const track = project.tracks.find((t) => t.kind === 'video')!
  const make = (start: number, duration: number): Clip => {
    const clip = baseClip('video', track.id, `clip-${start}`)
    clip.start = start
    clip.duration = duration
    clip.sourceIn = 0
    clip.sourceDuration = 60_000
    return clip
  }
  const clips = [make(0, 2000), make(2000, 2000)]
  return { project: { ...project, clips }, track, clips }
}

/* ------------------------- #1 / #2 duration units ------------------------ */

describe('clip duration is a real, enforced unit (#1 / #2)', () => {
  it('keeps the minimum below half a frame at 30 fps', () => {
    // 80 ms — the old value — is 2.4 frames; a clip could be clamped to a length
    // the renderer then rounded away. One frame at 30 fps is 33.3 ms.
    expect(MIN_CLIP_DURATION).toBeLessThanOrEqual(66.7)
    expect(MIN_CLIP_DURATION).toBeGreaterThan(1000 / 30 - 1)
  })

  it('rejects negative, zero, NaN and absurd durations', () => {
    expect(legalDuration(-4000)).toBe(MIN_CLIP_DURATION)
    expect(legalDuration(0)).toBe(MIN_CLIP_DURATION)
    expect(legalDuration(Number.NaN)).toBe(MIN_CLIP_DURATION)
    expect(legalDuration(Number.POSITIVE_INFINITY)).toBe(MIN_CLIP_DURATION)
    expect(legalDuration(undefined)).toBe(MIN_CLIP_DURATION)
    expect(legalDuration(2000)).toBe(2000)
  })

  it('never lets a patch carry a negative start or source in-point', () => {
    const patch = legalPatch({ start: -500, sourceIn: -120, duration: -10 })
    expect(patch.start).toBe(0)
    expect(patch.sourceIn).toBe(0)
    expect(patch.duration).toBe(MIN_CLIP_DURATION)
    // Unrelated fields are untouched.
    expect(legalPatch({ name: 'x' }).name).toBe('x')
  })

  it('lets a manual retime produce a usable clip but not a sliver', () => {
    expect(MIN_AUTHORED_DURATION).toBeGreaterThan(MIN_CLIP_DURATION)
  })
})

/* ------------------------------ #6 orphan clips -------------------------- */

describe('removing a track leaves no orphaned state (#6)', () => {
  it('drops every clip that was on the track', () => {
    const { project, track } = projectWithClips()
    const next = removeTrack(project, track.id)
    expect(next.tracks.some((t) => t.id === track.id)).toBe(false)
    expect(next.clips).toHaveLength(0)
  })

  it('reports ids that no longer exist so the caller can prune the selection', () => {
    const { project, track } = projectWithClips()
    const next = removeTrack(project, track.id)
    const alive = new Set(next.clips.map((c) => c.id))
    expect(project.clips.every((c) => !alive.has(c.id))).toBe(true)
  })
})

/* --------------------- #14 / #15 / #16 / #35 enforcement ----------------- */

describe('mute, solo, lock and visibility have exactly one definition (#14 / #15 / #16 / #35)', () => {
  it('the two trackIsAudible implementations agree (they used to disagree on captions)', () => {
    const project = createProject('Test', '9:16', 30)
    for (const track of project.tracks) {
      expect(helperTrackAudible(project, track), `${track.kind} audible`).toBe(trackIsAudible(project, track))
      expect(helperAudible(project, track)).toBe(trackIsAudible(project, track))
    }
  })

  it('treats a caption track as audible, so its clips are not silently dropped', () => {
    const project = createProject('Test', '9:16', 30)
    const caption = project.tracks.find((t) => t.kind === 'caption')!
    // The old helper in timeline-helpers.ts returned false for caption tracks
    // unconditionally, and the exporter imported that copy.
    expect(helperTrackAudible(project, caption)).toBe(true)
  })

  it('soloing one track silences every other track', () => {
    const project = createProject('Test', '9:16', 30)
    const [first, ...rest] = project.tracks
    const soloed = { ...project, tracks: project.tracks.map((t) => (t.id === first.id ? { ...t, solo: true } : t)) }
    expect(trackIsAudible(soloed, soloed.tracks[0])).toBe(true)
    for (const track of rest) {
      const current = soloed.tracks.find((t) => t.id === track.id)!
      expect(trackIsAudible(soloed, current), track.kind).toBe(false)
    }
  })

  it('hiding a soloed-off track removes it from the scene', () => {
    const { project, track } = projectWithClips()
    const captionTrack = project.tracks.find((t) => t.kind === 'caption')!
    const caption = baseClip('caption', captionTrack.id, 'hello')
    caption.text = 'hello'
    caption.start = 0
    caption.duration = 2000
    const withCaption: Project = { ...project, clips: [...project.clips, caption] }

    // Baseline: both visible, both drawn.
    expect(buildScene(withCaption, 500).layers.map((l) => l.id)).toContain(caption.id)

    // Hidden caption track: gone from the scene.
    const hidden: Project = {
      ...withCaption,
      tracks: withCaption.tracks.map((t) => (t.id === captionTrack.id ? { ...t, visible: false } : t))
    }
    expect(isTrackVisible(hidden, hidden.tracks.find((t) => t.id === captionTrack.id)!)).toBe(false)
    expect(buildScene(hidden, 500).layers.map((l) => l.id)).not.toContain(caption.id)

    // Soloing the video track excludes the caption track from the scene — the
    // old inline logic in buildScene only excluded tracks by kind.
    const soloed: Project = {
      ...withCaption,
      tracks: withCaption.tracks.map((t) => (t.id === track.id ? { ...t, solo: true } : t))
    }
    const scene = buildScene(soloed, 500)
    expect(scene.layers.map((l) => l.id)).not.toContain(caption.id)
    expect(scene.layers.length).toBeGreaterThan(0)
  })

  it('runs effects through the single effectSpeed helper', () => {
    const clip = baseClip('video', 't', 'c')
    clip.effects = [{ id: 'e', type: 'speed', value: 9, enabled: true } as Clip['effects'][number]]
    // Clamped, not passed through.
    expect(effectSpeed(clip)).toBe(4)
  })
})

/* -------------------- #13 / #30 range and overwrite meaning -------------- */

describe('range semantics are consistent (#13 / #30)', () => {
  let project: Project
  let trackId: string

  beforeEach(() => {
    const built = projectWithClips()
    project = built.project
    trackId = built.track.id
  })

  it('does nothing for an empty or inverted range', () => {
    expect(clearRange(project.clips, trackId, 1000, 1000)).toHaveLength(project.clips.length)
    const inverted = clearRange(project.clips, trackId, 2000, 1000)
    expect(inverted).toHaveLength(project.clips.length)
    // No duplicated clips (the old "middle" branch fired for inverted ranges).
    expect(new Set(inverted.map((c) => c.id)).size).toBe(inverted.length)
  })

  it('overwrite and overwriteRange now mean the same thing', () => {
    const byClip = overwriteClip(project, baseClip('video', trackId, 'new'), 1000)
    // overwriteRange used to delete the whole straddled clip instead of trimming.
    const ranged = overwriteRange(project.clips, trackId, 1000, 3000)
    const trimmedSpan = ranged.reduce((max, c) => Math.max(max, c.start + c.duration), 0)
    expect(trimmedSpan).toBeGreaterThanOrEqual(2000)
    expect(byClip.clips.some((c) => c.name === 'new')).toBe(true)
  })

  it('drops a sliver rather than leaving an unusable fragment', () => {
    const clips = clearRange(project.clips, trackId, 1990, 3000)
    // The first clip would keep a 10 ms head — below the minimum, so it is gone.
    expect(clips.every((c) => c.duration >= MIN_CLIP_DURATION)).toBe(true)
  })

  it('shifts keyframes on the kept tail so animation does not restart', () => {
    const animated = project.clips[0]
    const withKeyframes: Clip = {
      ...animated,
      keyframes: { opacity: [{ id: 'k1', t: 0, value: 0, easing: LINEAR }, { id: 'k2', t: 1800, value: 1, easing: LINEAR }] }
    }
    const next = clearRange([withKeyframes], trackId, 0, 1000)
    expect(next).toHaveLength(1)
    const track = next[0].keyframes.opacity!
    // The retained keyframe was at 1800 ms and the cut was 1000 ms, so it is now
    // at 800 ms local time.
    expect(track.map((k) => k.t)).toEqual([0, 800])
    /*
     * …and the synthetic opening keyframe carries the value the curve had at the
     * cut (1000/1800 ≈ 0.555), so the animation continues instead of jumping.
     * Clamping the pre-cut keyframe to zero — the old behaviour — would have put
     * 0 here and made opacity snap at the cut.
     */
    expect(track[0].value).toBeCloseTo(1000 / 1800, 3)
    expect(sampleTrack(track, 0)).toBeCloseTo(1000 / 1800, 3)
    // And it still reaches its end value.
    expect(sampleTrack(track, 800)).toBeCloseTo(1, 5)
  })

  it('splitting an animated clip keeps the motion continuous', () => {
    const animated: Clip = {
      ...project.clips[0],
      duration: 4000,
      keyframes: { opacity: [{ id: 'k1', t: 0, value: 0, easing: LINEAR }, { id: 'k2', t: 4000, value: 1, easing: LINEAR }] }
    }
    const single: Project = { ...project, clips: [animated] }
    const split = splitClip(single, animated.id, 2000)
    expect(split.clips).toHaveLength(2)
    const right = split.clips.find((c) => c.start === 2000)!
    // Both halves now animate over their own duration instead of replaying.
    expect(right.keyframes.opacity?.map((k) => k.t)).toEqual([0, 2000])
    const left = split.clips.find((c) => c.id === animated.id)!
    expect(left.keyframes.opacity?.map((k) => k.t)).toEqual([0, 4000])
  })

  it('an insert edit never leaves an overlap', () => {
    const inserted = baseClip('video', trackId, 'inserted')
    inserted.duration = 1000
    const next = insertClip(project, inserted, 1000)
    const onTrack = next.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start)
    for (let i = 0; i < onTrack.length - 1; i++) {
      expect(onTrack[i].start + onTrack[i].duration).toBeLessThanOrEqual(onTrack[i + 1].start + 1)
    }
    // The clip that straddled the insertion point was cut in two.
    expect(onTrack.length).toBe(4)
  })

  it('ripple delete moves markers with the media', () => {
    const withMarkers: Project = {
      ...project,
      markers: [
        { id: 'm1', time: 2500, label: 'after', color: '#ff0000' },
        { id: 'm2', time: 500, label: 'before', color: '#00ff00' }
      ]
    }
    const deleted = rippleDelete(withMarkers, project.clips[0].id)
    // 0–2000 was removed: the marker at 500 sat inside it (removed), the one at
    // 2500 moved back by 2000.
    expect(deleted.markers.map((m) => m.label)).toEqual(['after'])
    expect(deleted.markers[0].time).toBe(500)

    const ranged = rippleDeleteRange(withMarkers, 0, 2000)
    expect(ranged.markers.find((m) => m.label === 'after')?.time).toBe(500)
    expect(ranged.markers.find((m) => m.label === 'before')).toBeUndefined()
  })
})

/* ------------------------------ #9 track by kind ------------------------- */

describe('tracks are found by kind without assertions (#9)', () => {
  it('creates a caption track when the project has none', () => {
    const project = createProject('Test', '9:16', 30)
    const stripped: Project = { ...project, tracks: project.tracks.filter((t) => t.kind !== 'caption') }
    const ensured = ensureTrack(stripped, 'caption', 'Captions')
    expect(ensured.created).toBe(true)
    expect(ensured.project.tracks.filter((t) => t.kind === 'caption')).toHaveLength(1)
    expect(ensured.project.tracks.some((t) => t.id === ensured.track.id)).toBe(true)
  })

  it('reuses an existing track instead of adding a duplicate', () => {
    const project = createProject('Test', '9:16', 30)
    const ensured = ensureTrack(project, 'caption')
    expect(ensured.created).toBe(false)
    expect(ensured.project).toBe(project)
    expect(ensured.project.tracks.filter((t) => t.kind === 'caption')).toHaveLength(1)
  })

  it('the default project has the tracks clip generation assumes exist', () => {
    const project = createProject('Test', '9:16', 30)
    expect(project.tracks.some((t) => t.kind === 'video')).toBe(true)
    expect(project.tracks.some((t) => t.kind === 'caption')).toBe(true)
  })
})

/* --------------------------- easing sanity check ------------------------- */

describe('easing used by keyframes and animations', () => {
  it('is monotonic between 0 and 1', () => {
    for (const kind of ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const) {
      expect(applyEasing({ kind }, 0), kind).toBeCloseTo(0, 5)
      expect(applyEasing({ kind }, 1), kind).toBeCloseTo(1, 5)
    }
  })
})

/* ------------------- #46 / #47 preview and export parity ----------------- */

describe('export draws the same transition curve as the preview (#46 / #47)', () => {
  it('emits the preview curve, not a linear fade, for curved presets', async () => {
    const { alphaFadeStep } = await import('../src/main/export/renderer')
    const { transitionAlpha } = await import('@shared/scene')

    // A linear preset can use the cheap filter, and it must match transitionAlpha.
    const linear = alphaFadeStep('crossfade', 0, 1, 'in')
    expect(linear).toContain('fade=t=in')

    for (const preset of ['fadeToBlack', 'fadeFromBlack', 'dissolve']) {
      const step = alphaFadeStep(preset, 0, 1, 'in')
      expect(step, preset).toContain('geq=')
      expect(step, `${preset} must not fall back to a linear fade`).not.toContain('fade=t=in')
    }

    // The dissolve curve is a smoothstep in the preview; the expression must be
    // the same shape (3-2p), not a plain linear ramp.
    const dissolve = alphaFadeStep('dissolve', 0, 1, 'in')
    expect(dissolve).toContain('3-2*(')

    // fadeToBlack uses the 1.4 power in both directions.
    expect(alphaFadeStep('fadeToBlack', 0, 1, 'in')).toContain('pow(')
    expect(alphaFadeStep('fadeToBlack', 0, 1, 'out')).toContain('1.4')

    // Sanity: the preview really does curve these, so the export has to as well.
    expect(transitionAlpha('fadeToBlack', 0.5, 'in')).not.toBeCloseTo(0.5, 2)
    expect(transitionAlpha('dissolve', 0.25, 'in')).toBeLessThan(0.25)
  })

  it('renders the same alpha the preview computes (measured, not asserted)', async () => {
    const { alphaFadeStep } = await import('../src/main/export/renderer')
    const { transitionAlpha } = await import('@shared/scene')
    const { ffmpegAvailable, ffmpegRaw } = await import('./helpers')
    expect(ffmpegAvailable(), 'ffmpeg must be on PATH for this test').toBe(true)

    /** Alpha byte at `t` seconds for a fully opaque source. */
    const alphaAt = (step: string, t: number): number => {
      const raw = ffmpegRaw([
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=red@1.0:s=4x4:r=100:d=1,format=rgba',
        '-vf',
        `format=rgba,${step}`,
        '-ss',
        String(t),
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        '-'
      ])
      // RGBA: the alpha byte of the first pixel.
      return raw[3]
    }

    for (const preset of ['dissolve', 'fadeToBlack']) {
      const step = alphaFadeStep(preset, 0, 1, 'in')
      for (const t of [0.25, 0.5, 0.75]) {
        const expected = Math.round(transitionAlpha(preset, t, 'in') * 255)
        // ±4/255 allows for geq's integer rounding; a linear ramp would be off
        // by tens of levels here (0.25 → 64 instead of 40).
        expect(Math.abs(alphaAt(step, t) - expected), `${preset} @ ${t}s`).toBeLessThanOrEqual(4)
      }
    }

    // The regression that motivated this: a linear fade is visibly wrong at the
    // midpoint for fadeToBlack (0.5 → 128 vs the preview's 97).
    const linear = Math.round(0.5 * 255)
    const curved = Math.round(transitionAlpha('fadeToBlack', 0.5, 'in') * 255)
    expect(Math.abs(linear - curved)).toBeGreaterThan(20)
  })
})

/* --------------------- #10 whisper binary / model checks ---------------- */

describe('whisper inputs are validated before spawning (#10)', async () => {
  const { describeModelProblem, describeRuntimeProblem } = await import('../src/main/ai/transcribe')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')

  it('names a missing model file instead of crashing the child process', () => {
    expect(describeModelProblem('/definitely/not/here/ggml-base.en.bin')).toContain('does not exist')
  })

  it('rejects an empty file (the usual result of a cancelled download)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-model-'))
    const file = path.join(dir, 'ggml-base.en.bin')
    fs.writeFileSync(file, '')
    expect(describeModelProblem(file)).toContain('empty')
  })

  it('rejects a truncated file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-model-'))
    const file = path.join(dir, 'ggml-base.en.bin')
    fs.writeFileSync(file, Buffer.alloc(2048, 1))
    const problem = describeModelProblem(file)
    expect(problem).toContain('truncated')
  })

  it('explains the faster-whisper model.bin mix-up by name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-model-'))
    const file = path.join(dir, 'model.bin')
    // Big enough to pass the size check, but not a ggml container.
    fs.writeFileSync(file, Buffer.alloc(2_000_000, 0x50))
    const problem = describeModelProblem(file)
    expect(problem).toContain('faster-whisper')
    expect(problem).toContain('ggml')
  })

  it('accepts a plausible ggml file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-model-'))
    const file = path.join(dir, 'ggml-base.en.bin')
    const buf = Buffer.alloc(2_000_000, 0)
    buf.writeUInt32LE(0x67676d6c, 0) // "ggml"
    fs.writeFileSync(file, buf)
    expect(describeModelProblem(file)).toBeNull()
  })

  it('reports a stub binary rather than letting spawn fail obscurely', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rt-'))
    const file = path.join(dir, 'whisper-cli')
    fs.writeFileSync(file, 'not a binary')
    expect(describeRuntimeProblem(file)).toContain('stub')
    expect(describeRuntimeProblem(path.join(dir, 'missing'))).toBeTruthy()
  })
})

/* ------------------- #7 autosave gating (signature logic) ---------------- */

describe('autosave decides to write only when something changed (#7)', async () => {
  const { saveSignature } = await import('../src/renderer/src/hooks/useProjectPersistence')

  it('is stable for an unchanged project and changes on every real edit', () => {
    const project = createProject('sig', '9:16', 30)
    expect(saveSignature(project)).toBe(saveSignature({ ...project }))
    // The store stamps updatedAt on every edit.
    expect(saveSignature({ ...project, updatedAt: project.updatedAt + 1 })).not.toBe(saveSignature(project))
    // An edit that only adds a clip is also a different signature.
    const track = project.tracks.find((t) => t.kind === 'video')!
    const clip = baseClip('video', track.id, 'new.mp4')
    expect(saveSignature({ ...project, clips: [...project.clips, clip] })).not.toBe(saveSignature(project))
    // A no-op save request (same content) must not rewrite the file.
    expect(saveSignature({ ...project })).toBe(saveSignature(project))
  })
})
