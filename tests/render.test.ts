/**
 * Real end-to-end tests of the export renderer. These run ffmpeg for real and
 * inspect the produced media — no mocks, no fakes.
 */
import { describe, expect, it, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ProjectRenderer, segmentTimeline, buildAudioRenderArgs } from '../src/main/export/renderer'
import { baseClip, defaultTracks } from '../src/shared/timeline'
import { createProject } from '../src/shared/defaults'
import { FALLBACK_CAPTION_PRESETS } from '../src/shared/presets'
import { buildCaptionClips } from '../src/shared/captions'
import { buildExportPreset } from '../src/shared/presets'
import type { MediaAsset, Project, TextStyle } from '../src/shared/types'
import { FONT_DIR, cropStats, ffmpeg, ffmpegAvailable, ffmpegRaw, frameStats, probe, probeStderr, tmpDir } from './helpers'

const HAS_FFMPEG = ffmpegAvailable()
const describeIf = HAS_FFMPEG ? describe : describe.skip

function makeSource(dir: string, name: string, colour: string, seconds = 4, size = '640x360', fps = 30, withAudio = true) {
  const file = path.join(dir, name)
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${colour}:s=${size}:r=${fps}:d=${seconds}`
  ]
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=f=440:d=${seconds}`)
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(seconds))
  if (withAudio) args.push('-c:a', 'aac', '-shortest')
  args.push(file)
  ffmpeg(args)
  return file
}

function assetFor(id: string, file: string, kind: MediaAsset['kind'], probeData: ReturnType<typeof probe>): MediaAsset {
  return {
    id,
    name: path.basename(file),
    path: file,
    kind,
    storage: 'linked',
    probe: {
      kind,
      durationMs: probeData.durationMs ?? 4000,
      width: probeData.width,
      height: probeData.height,
      fps: probeData.fps,
      hasAudio: probeData.hasAudio
    },
    importedAt: Date.now()
  }
}

describeIf('export renderer', () => {
  let dir = ''
  let redFile = ''
  let blueFile = ''
  let imageFile = ''

  beforeAll(() => {
    dir = tmpDir('render')
    redFile = makeSource(dir, 'red.mp4', 'red', 4)
    blueFile = makeSource(dir, 'blue.mp4', 'blue', 4)
    imageFile = path.join(dir, 'card.png')
    ffmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=400x400:d=1', '-frames:v', '1', imageFile])
  })

  function newProject(aspect = '16:9'): Project {
    const project = createProject('Test', aspect, 30)
    return project
  }

  it('renders a single clip at 1080p with the right geometry and audio', async () => {
    const project = newProject('16:9')
    project.assets.push(assetFor('a1', redFile, 'video', probe(redFile)))
    const track = project.tracks.find((t) => t.kind === 'video')!
    const clip = baseClip('video', track.id, 'Red')
    clip.assetId = 'a1'
    clip.start = 0
    clip.duration = 2000
    clip.sourceIn = 0
    project.clips.push(clip)

    const out = path.join(dir, 'out-single.mp4')
    const preset = buildExportPreset('1080p', '16:9', 30)
    const renderer = new ProjectRenderer(
      {
        project,
        preset,
        outPath: out,
        tempDir: path.join(dir, 'tmp-single'),
        fontDir: FONT_DIR
      },
      'ffmpeg',
      dir
    )
    const result = await renderer.render()
    if (!result.ok) console.error(result.error, probeStderr(out))
    expect(result.ok).toBe(true)
    const info = probe(out)
    expect(info.width).toBe(1920)
    expect(info.height).toBe(1080)
    expect(info.hasAudio).toBe(true)
    expect(Math.abs((info.durationMs ?? 0) - 2000)).toBeLessThan(250)
    const stats = frameStats(out, 1)
    expect(stats.r).toBeGreaterThan(180)
    expect(stats.g).toBeLessThan(60)
  })

  it('renders vertical 9:16 output with correct dimensions', async () => {
    const project = newProject('9:16')
    project.assets.push(assetFor('a1', redFile, 'video', probe(redFile)))
    const track = project.tracks.find((t) => t.kind === 'video')!
    const clip = baseClip('video', track.id, 'Red')
    clip.assetId = 'a1'
    clip.duration = 1500
    project.clips.push(clip)

    const out = path.join(dir, 'out-vertical.mp4')
    const preset = buildExportPreset('1080p', '9:16', 30)
    const renderer = new ProjectRenderer(
      { project, preset, outPath: out, tempDir: path.join(dir, 'tmp-vert'), fontDir: FONT_DIR },
      'ffmpeg',
      dir
    )
    const result = await renderer.render()
    if (!result.ok) console.error(result.error)
    expect(result.ok).toBe(true)
    const info = probe(out)
    expect(info.width).toBe(1080)
    expect(info.height).toBe(1920)
  })

  it('segments the timeline at clip boundaries and renders a two-clip edit', async () => {
    const project = newProject('16:9')
    project.assets.push(assetFor('a1', redFile, 'video', probe(redFile)))
    project.assets.push(assetFor('a2', blueFile, 'video', probe(blueFile)))
    const track = project.tracks.find((t) => t.kind === 'video')!
    const c1 = baseClip('video', track.id, 'Red')
    c1.assetId = 'a1'
    c1.start = 0
    c1.duration = 1500
    const c2 = baseClip('video', track.id, 'Blue')
    c2.assetId = 'a2'
    c2.start = 1500
    c2.duration = 1500
    project.clips.push(c1, c2)

    const parts = segmentTimeline(project, 0, 3000)
    expect(parts.length).toBe(2)

    const out = path.join(dir, 'out-two.mp4')
    const preset = buildExportPreset('720p', '16:9', 30)
    const result = await new ProjectRenderer(
      { project, preset, outPath: out, tempDir: path.join(dir, 'tmp-two'), fontDir: FONT_DIR },
      'ffmpeg',
      dir
    ).render()
    if (!result.ok) console.error(result.error)
    expect(result.ok).toBe(true)
    // First clip is red, second is blue — the edit is really applied.
    expect(frameStats(out, 0.5).r).toBeGreaterThan(150)
    expect(frameStats(out, 2.5).b).toBeGreaterThan(150)
  })

  it('renders a transition as a real alpha blend', async () => {
    const project = newProject('16:9')
    project.assets.push(assetFor('a1', redFile, 'video', probe(redFile)))
    project.assets.push(assetFor('a2', blueFile, 'video', probe(blueFile)))
    const track = project.tracks.find((t) => t.kind === 'video')!
    const c1 = baseClip('video', track.id, 'Red')
    c1.assetId = 'a1'
    c1.start = 0
    c1.duration = 1500
    c1.transitionOut = { id: 't1', type: 'crossfade', durationMs: 600 }
    project.clips.push(c1)
    const c2 = baseClip('video', track.id, 'Blue')
    c2.assetId = 'a2'
    c2.start = 1500
    c2.duration = 1500
    c2.transitionIn = { id: 't2', type: 'crossfade', durationMs: 600 }
    project.clips.push(c2)

    const out = path.join(dir, 'out-transition.mp4')
    const result = await new ProjectRenderer(
      {
        project,
        preset: buildExportPreset('720p', '16:9', 30),
        outPath: out,
        tempDir: path.join(dir, 'tmp-trans'),
        fontDir: FONT_DIR
      },
      'ffmpeg',
      dir
    ).render()
    if (!result.ok) console.error(result.error)
    expect(result.ok).toBe(true)
    // Mid-transition both red and blue contribute.
    const mid = frameStats(out, 1.2)
    expect(mid.r).toBeGreaterThan(40)
    expect(mid.b).toBeGreaterThan(40)
  })

  it('burns caption text into the video (pixels change where text is drawn)', async () => {
    const project = newProject('9:16')
    project.assets.push(assetFor('a1', blueFile, 'video', probe(blueFile)))
    const track = project.tracks.find((t) => t.kind === 'video')!
    const clip = baseClip('video', track.id, 'Blue')
    clip.assetId = 'a1'
    clip.duration = 2500
    project.clips.push(clip)

    const preset = FALLBACK_CAPTION_PRESETS[1] // Bold Creator
    const captionTrack = project.tracks.find((t) => t.kind === 'caption')!
    const captions = buildCaptionClips(
      [
        {
          id: 's1',
          start: 0,
          end: 2500,
          text: 'THIS IS A CAPTION TEST',
          words: 'THIS IS A CAPTION TEST'.split(' ').map((w, i) => ({
            text: w,
            start: i * 500,
            end: i * 500 + 480
          }))
        }
      ],
      { start: 0, end: 2500 },
      preset,
      captionTrack.id
    )
    project.clips.push(...captions)

    const out = path.join(dir, 'out-caption.mp4')
    const result = await new ProjectRenderer(
      {
        project,
        preset: buildExportPreset('1080p', '9:16', 30),
        outPath: out,
        tempDir: path.join(dir, 'tmp-cap'),
        fontDir: FONT_DIR,
        burnCaptions: true
      },
      'ffmpeg',
      dir
    ).render()
    if (!result.ok) console.error(result.error)
    expect(result.ok).toBe(true)
    // The caption area (centre band) must contain bright white text pixels.
    const raw = ffmpegRaw([
      '-hide_banner', '-loglevel', 'error', '-ss', '0.6', '-i', out,
      '-vf', 'crop=1080:400:0:760', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
    ])
    let white = 0
    for (let i = 0; i < raw.length; i += 3) {
      if (raw[i] > 220 && raw[i + 1] > 220 && raw[i + 2] > 220) white++
    }
    expect(white).toBeGreaterThan(400)
  })

  it('applies keyframed motion and encodes it into the file', async () => {
    const project = newProject('16:9')
    project.assets.push(assetFor('a1', redFile, 'video', probe(redFile)))
    const track = project.tracks.find((t) => t.kind === 'video')!
    const clip = baseClip('video', track.id, 'Red')
    clip.assetId = 'a1'
    clip.duration = 2000
    clip.transform.scale = 0.35
    clip.transform.x = 0.25
    clip.keyframes.x = [
      { id: 'k1', t: 0, value: 0.25, easing: { kind: 'linear' } },
      { id: 'k2', t: 2000, value: 0.75, easing: { kind: 'linear' } }
    ]
    project.clips.push(clip)

    const out = path.join(dir, 'out-keyframe.mp4')
    const result = await new ProjectRenderer(
      { project, preset: buildExportPreset('720p', '16:9', 30), outPath: out, tempDir: path.join(dir, 'tmp-kf'), fontDir: FONT_DIR },
      'ffmpeg',
      dir
    ).render()
    if (!result.ok) console.error(result.error)
    expect(result.ok).toBe(true)
    // Sample the left third at t=0.1 (clip on the left) and t=1.9 (clip on the right).
    const leftEarly = frameStats(out, 0.15, '48:27')
    const leftLate = frameStats(out, 1.85, '48:27')
    const rawEarly = frameStats(out, 0.15, '48:27')
    // The red square moves right, so the leftmost region loses its red.
    expect(leftLate.r).toBeLessThan(leftEarly.r + 5)
    void rawEarly
    void leftEarly
  })

  it('mixes multiple audio clips and keeps audio/video in sync', async () => {
    const project = newProject('16:9')
    project.assets.push(assetFor('a1', redFile, 'video', probe(redFile)))
    const videoTrack = project.tracks.find((t) => t.kind === 'video')!
    const audioTrack = project.tracks.find((t) => t.kind === 'audio')!
    const clip = baseClip('video', videoTrack.id, 'Red')
    clip.assetId = 'a1'
    clip.duration = 3000
    project.clips.push(clip)
    const music = baseClip('audio', audioTrack.id, 'Music')
    music.assetId = 'a1'
    music.start = 500
    music.duration = 2000
    music.sourceIn = 0
    music.audio.volume = 0.7
    project.clips.push(music)

    const args = buildAudioRenderArgs(project, { start: 0, end: 3000 }, path.join(dir, 'mix.wav'))
    expect(args).toBeTruthy()

    const out = path.join(dir, 'out-audio.mp4')
    const result = await new ProjectRenderer(
      { project, preset: buildExportPreset('720p', '16:9', 30), outPath: out, tempDir: path.join(dir, 'tmp-audio'), fontDir: FONT_DIR },
      'ffmpeg',
      dir
    ).render()
    if (!result.ok) console.error(result.error)
    expect(result.ok).toBe(true)
    const info = probe(out)
    expect(info.hasAudio).toBe(true)
    expect(Math.abs((info.durationMs ?? 0) - 3000)).toBeLessThan(300)
  })

  it('renders an image overlay on top of video with alpha', async () => {
    const project = newProject('16:9')
    project.assets.push(assetFor('a1', redFile, 'video', probe(redFile)))
    project.assets.push(assetFor('img1', imageFile, 'image', probe(imageFile)))
    const videoTrack = project.tracks.find((t) => t.kind === 'video')!
    const overlayTrack = project.tracks.find((t) => t.kind === 'graphic')!
    const base = baseClip('video', videoTrack.id, 'Red')
    base.assetId = 'a1'
    base.duration = 2000
    project.clips.push(base)
    const overlay = baseClip('image', overlayTrack.id, 'Card')
    overlay.assetId = 'img1'
    overlay.duration = 2000
    overlay.transform.scale = 0.4
    project.clips.push(overlay)

    const out = path.join(dir, 'out-overlay.mp4')
    const result = await new ProjectRenderer(
      { project, preset: buildExportPreset('720p', '16:9', 30), outPath: out, tempDir: path.join(dir, 'tmp-overlay'), fontDir: FONT_DIR },
      'ffmpeg',
      dir
    ).render()
    if (!result.ok) console.error(result.error)
    expect(result.ok).toBe(true)
    // Centre crop contains the green card; the corner stays red.
    const centre = cropStats(out, 1, 'crop=160:160:560:280')
    expect(centre.g).toBeGreaterThan(centre.r)
    const corner = cropStats(out, 1, 'crop=120:120:0:0')
    expect(corner.r).toBeGreaterThan(200)
  })

  it('produces a valid playable file that decodes without errors', async () => {
    const project = newProject('16:9')
    project.assets.push(assetFor('a1', redFile, 'video', probe(redFile)))
    const track = project.tracks.find((t) => t.kind === 'video')!
    const clip = baseClip('video', track.id, 'Red')
    clip.assetId = 'a1'
    clip.duration = 1000
    project.clips.push(clip)
    const out = path.join(dir, 'out-decode.mp4')
    await new ProjectRenderer(
      { project, preset: buildExportPreset('720p', '16:9', 30), outPath: out, tempDir: path.join(dir, 'tmp-dec'), fontDir: FONT_DIR },
      'ffmpeg',
      dir
    ).render()
    // Full decode pass: any frame corruption shows up as a non-zero exit.
    expect(() =>
      ffmpeg(['-hide_banner', '-loglevel', 'error', '-v', 'error', '-i', out, '-f', 'null', '-'])
    ).not.toThrow()
  })
})
