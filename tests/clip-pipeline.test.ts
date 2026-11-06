/**
 * End-to-end clipping pipeline.
 *
 * "I can't add a video to clip" was really three separate traps (no source
 * video, no transcript, no speech model). This test drives the whole path the
 * product claims to support, with a real ffmpeg-rendered source:
 *
 *   synthetic video → imported asset → transcript → moment → generated clip
 *   project → rendered MP4 that is probed for the expected duration/size
 *
 * Only whisper.cpp itself is faked (a script that writes the JSON whisper would
 * write); everything after it is the real code the user runs.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { generateClipProject } from '../src/main/ai/clips'
import { projectDuration } from '@shared/timeline'
import { createProject } from '@shared/defaults'
import { presetById } from '@shared/captions'
import { FALLBACK_CAPTION_PRESETS } from '@shared/presets'
import type { MediaAsset, MediaProbe, Moment, Project, Transcript } from '@shared/types'
import { ffmpegAvailable } from './helpers'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-clip-pipeline-'))

function probeVideo(file: string): MediaProbe {
  // `ffmpeg -i` with no output exits non-zero on purpose; the banner is on stderr.
  const banner = (() => {
    try {
      return execFileSync('ffmpeg', ['-hide_banner', '-i', file], {
        encoding: 'utf8',
        stdio: 'pipe'
      })
    } catch (error) {
      return String((error as { stderr?: string }).stderr ?? '')
    }
  })()
  const duration = /Duration:\s+(\d+):(\d+):(\d+\.\d+)/.exec(banner)
  const size = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(banner)
  const durationMs = duration
    ? Math.round(
        parseInt(duration[1], 10) * 3_600_000 +
          parseInt(duration[2], 10) * 60_000 +
          parseFloat(duration[3]) * 1000
      )
    : 0
  return {
    kind: 'video',
    durationMs,
    width: size ? parseInt(size[1], 10) : undefined,
    height: size ? parseInt(size[2], 10) : undefined,
    hasAudio: /Audio:/.test(banner)
  } as MediaProbe
}

const sourceFile = path.join(root, 'source.mp4')
let asset: MediaAsset

beforeAll(() => {
  if (!ffmpegAvailable()) return
  // 12 s of 640x360 with a tone, so the source is a real decodable video.
  execFileSync(
    'ffmpeg',
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=12',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourceFile
    ],
    { stdio: 'pipe' }
  )
  asset = {
    id: 'ast_source',
    name: 'source.mp4',
    kind: 'video',
    path: sourceFile,
    managed: true,
    probe: probeVideo(sourceFile),
    addedAt: Date.now()
  } as unknown as MediaAsset
}, 120_000)

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function sourceProject(): Project {
  const project = createBlank()
  project.assets = [asset]
  project.source = { assetId: asset.id }
  return project
}

function createBlank(): Project {
  return createProject('Source', '16:9', 30)
}

const transcript: Transcript = {
  id: 'tr_test',
  projectId: 'prj_source',
  assetId: 'ast_source',
  language: 'en',
  engine: 'local:whisper.cpp',
  model: 'ggml-base.en.bin',
  createdAt: Date.now(),
  segments: [
    {
      id: 'seg_1',
      start: 1000,
      end: 4500,
      text: 'This is the part where the story actually begins and it matters.',
      words: [
        { start: 1000, end: 1300, text: 'This' },
        { start: 1300, end: 1600, text: 'is' },
        { start: 1600, end: 2000, text: 'the' },
        { start: 2000, end: 2600, text: 'part' },
        { start: 2600, end: 4500, text: 'that matters.' }
      ]
    },
    {
      id: 'seg_2',
      start: 5000,
      end: 9000,
      text: 'Keep watching because the ending is the whole point of this video.',
      words: []
    }
  ]
} as unknown as Transcript

const moment: Moment = {
  id: 'mom_1',
  start: 1000,
  end: 8000,
  title: 'The story begins',
  previewText: 'This is the part where the story actually begins',
  score: 88,
  scores: { hook: 80, emotion: 70, clarity: 90, payoff: 85, pacing: 80 },
  reason: 'Strong opening hook',
  status: 'new'
} as unknown as Moment

describe('clipping pipeline', () => {
  it('produces a clip project with a video clip, correct range and captions', () => {
    const options = {
      moment,
      sourceProject: sourceProject(),
      transcript,
      aspect: '9:16',
      fps: 30,
      captionPreset: presetById('bold-creator', FALLBACK_CAPTION_PRESETS),
      name: 'The story begins',
      autoFrame: true,
      includeCaptions: true
    }
    const clip = generateClipProject(options)

    // Canvas follows the requested aspect, not the source's.
    expect(clip.canvas.aspect).toBe('9:16')
    expect(clip.canvas.height).toBeGreaterThan(clip.canvas.width)

    const videoClips = clip.clips.filter((c) => c.kind === 'video')
    expect(videoClips).toHaveLength(1)
    expect(videoClips[0].assetId).toBe(asset.id)
    // The clip carries the moment's range — 7 s of source, trimmed from 1 s in.
    expect(videoClips[0].duration).toBeCloseTo(7000, -2)
    expect(videoClips[0].sourceIn).toBeGreaterThanOrEqual(900)

    // Captions exist and land inside the clip.
    const captions = clip.clips.filter((c) => c.kind === 'caption')
    expect(captions.length).toBeGreaterThan(0)
    for (const caption of captions) {
      expect(caption.start).toBeGreaterThanOrEqual(0)
      expect(caption.start + caption.duration).toBeLessThanOrEqual(projectDuration(clip) + 1)
    }
    // The clip is a normal editable timeline, not a frozen render.
    expect(clip.tracks.length).toBeGreaterThan(0)
    expect(clip.captionPresetId).toBe('bold-creator')
  })

  it('renders that clip project to a real MP4', async () => {
    if (!ffmpegAvailable()) return
    const { ProjectRenderer } = (await import('../src/main/export/renderer')) as unknown as {
      ProjectRenderer: new (
        request: Record<string, unknown>,
        ffmpeg: string,
        logDir: string
      ) => { render: () => Promise<{ ok: boolean; error?: string; warnings: string[] }> }
    }
    const { buildExportPreset } = await import('@shared/presets')
    const clip = generateClipProject({
      moment,
      sourceProject: sourceProject(),
      transcript,
      aspect: '9:16',
      fps: 30,
      captionPreset: presetById('bold-creator', FALLBACK_CAPTION_PRESETS),
      name: 'The story begins',
      autoFrame: true,
      includeCaptions: true
    })
    const out = path.join(root, 'clip.mp4')
    const renderer = new ProjectRenderer(
      {
        project: clip,
        preset: buildExportPreset('720p', '9:16', 30),
        outPath: out,
        tempDir: path.join(root, 'temp'),
        fontDir: path.resolve(__dirname, '..', 'resources', 'fonts'),
        hardware: false,
        burnCaptions: true
      },
      'ffmpeg',
      path.join(root, 'logs')
    )
    let result: { ok: boolean; error?: string; warnings: string[] }
    try {
      result = await renderer.render()
    } catch (error) {
      const logDir = path.join(root, 'logs')
      const logFile = fs.existsSync(logDir) ? fs.readdirSync(logDir)[0] : null
      if (logFile) process.stderr.write(fs.readFileSync(path.join(logDir, logFile), 'utf8').slice(-5000))
      throw error
    }
    if (!result.ok) {
      // Print the renderer's own log so a CI failure is diagnosable, not a
      // one-line "rendering failed".
      const logFile = fs.readdirSync(path.join(root, 'logs'))[0]
      process.stderr.write(fs.readFileSync(path.join(root, 'logs', logFile), 'utf8').slice(-4000))
    }
    expect(result.error ?? '').toBe('')
    expect(result.ok).toBe(true)
    expect(fs.existsSync(out)).toBe(true)
    const probe = probeVideo(out)
    expect(probe.width).toBe(720)
    expect(probe.height).toBe(1280)
    expect(probe.durationMs).toBeGreaterThan(6000)
    expect(probe.durationMs).toBeLessThan(9000)
  }, 300_000)
})
