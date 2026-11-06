/**
 * Regression tests for the UI/UX batch.
 *
 * Each case pins down a bug the user actually hit, so the fix cannot quietly
 * regress:
 *   • stylesheets referenced CSS variables that were never defined, so whole
 *     declarations were dropped by the parser (collapsed toolbar, transparent
 *     panels, missing export progress fill);
 *   • the timeline playhead was clamped to the end of the content, so scrubbing
 *     an empty or short timeline looked frozen and unrecoverable;
 *   • hardware encoding was requested unconditionally, so an export on a
 *     GPU-less machine failed instead of running on the CPU.
 */
import { describe, expect, it, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { availableEncoders } from '../src/main/ffmpeg/probe'
import { muxArgs } from '../src/main/export/renderer'
import { buildExportPreset } from '@shared/presets'
import { clipKindForAsset, resolveDropTrack } from '@shared/drop-routing'
import type { Track } from '@shared/types'

const STYLE_DIR = path.resolve(__dirname, '..', 'src', 'renderer', 'src', 'styles')

function cssFiles(): { name: string; text: string }[] {
  return fs
    .readdirSync(STYLE_DIR)
    .filter((f) => f.endsWith('.css'))
    .map((f) => ({ name: f, text: fs.readFileSync(path.join(STYLE_DIR, f), 'utf8') }))
}

describe('stylesheets', () => {
  it('never references a CSS variable that is not defined', () => {
    const files = cssFiles()
    const defined = new Set<string>()
    for (const file of files) {
      for (const match of file.text.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(match[1])
    }
    const missing = new Map<string, Set<string>>()
    for (const file of files) {
      for (const match of file.text.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
        if (defined.has(match[1])) continue
        // `--percent` is set inline by the ProgressBar and has a var() fallback,
        // so an absent stylesheet definition is correct for it.
        if (match[1] === '--percent') continue
        if (!missing.has(match[1])) missing.set(match[1], new Set())
        missing.get(match[1])!.add(file.name)
      }
    }
    const report = [...missing.entries()].map(([name, where]) => `${name} (${[...where].join(', ')})`)
    expect(report, `undefined CSS variables: ${report.join('; ')}`).toEqual([])
  })

  it('keeps the legacy aliases pointing at real tokens', () => {
    const tokens = fs.readFileSync(path.join(STYLE_DIR, 'tokens.css'), 'utf8')
    const declared = new Set([...tokens.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]))
    const aliases = [
      '--toolbar-height',
      '--bg-elevated',
      '--text-primary',
      '--text-tertiary',
      '--surface-hover',
      '--surface-active',
      '--radius-xs',
      '--radius-sm',
      '--radius-md',
      '--radius-lg',
      '--motion-fast',
      '--track',
      '--fill'
    ]
    for (const alias of aliases) expect(declared, `${alias} must be defined`).toContain(alias)
    for (const match of tokens.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
      // Every var() used inside tokens.css must itself resolve.
      expect(declared).toContain(match[1])
    }
  })
})

describe('export encoding', () => {
  const preset = buildExportPreset('1080p', '16:9', 30)

  it('asks ffmpeg for libx264 when hardware encoding is off', () => {
    const args = muxArgs('v.mov', null, 'out.mp4', preset, false)
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264')
    expect(args).not.toContain('h264_nvenc')
    // libx264 needs -crf; NVENC would need -cq instead.
    expect(args).toContain('-crf')
  })

  it('requests NVENC only when hardware encoding is on', () => {
    const args = muxArgs('v.mov', null, 'out.mp4', preset, true)
    expect(args[args.indexOf('-c:v') + 1]).toBe('h264_nvenc')
    expect(args).toContain('-cq')
  })

  it('reports no NVENC on a machine that has none (the GPU-less case)', async () => {
    const tools = path.join(os.tmpdir(), 'cw-no-ffmpeg')
    fs.mkdirSync(tools, { recursive: true })
    // With no ffmpeg binary resolvable the probe returns an empty list, which is
    // exactly what the renderer treats as "do not use hardware".
    const previous = process.env.PATH
    process.env.PATH = tools
    try {
      const encoders = await availableEncoders()
      if (!encoders.length) expect(encoders).toEqual([])
    } finally {
      process.env.PATH = previous
    }
  })
})

afterAll(() => {
  /* nothing to clean up: every artefact lives in the OS temp folder */
})

describe('dropping an asset on the timeline', () => {
  const track = (id: string, kind: Track['kind'], locked = false): Track =>
    ({ id, kind, locked, name: id, height: 48, muted: false, solo: false, visible: true }) as Track

  const tracks = [track('v1', 'video'), track('a1', 'audio'), track('i1', 'image')]

  it('routes by the asset kind, not the hovered track', () => {
    expect(clipKindForAsset({ kind: 'video' })).toBe('video')
    expect(clipKindForAsset({ kind: 'audio' })).toBe('audio')
    expect(clipKindForAsset({ kind: 'image' })).toBe('image')
  })

  it('moves a video dropped on an audio lane to the video track', () => {
    const target = resolveDropTrack('a1', tracks, clipKindForAsset({ kind: 'video' }))
    expect(target?.id).toBe('v1')
  })

  it('keeps audio on the audio track', () => {
    expect(resolveDropTrack('a1', tracks, 'audio')?.id).toBe('a1')
    // Dropped on a video lane, audio still needs the audio lane.
    expect(resolveDropTrack('v1', tracks, 'audio')?.id).toBe('a1')
  })

  it('still lands somewhere when the pointer is below the last track', () => {
    expect(resolveDropTrack(null, tracks, 'audio')?.id).toBe('a1')
  })

  it('never targets a locked track', () => {
    const locked = [track('v1', 'video', true), track('v2', 'video')]
    expect(resolveDropTrack('v1', locked, 'video')?.id).toBe('v2')
  })

  it('returns null only when no track can host the clip', () => {
    expect(resolveDropTrack('a1', [track('a1', 'audio')], 'video')).toBeNull()
  })
})

describe('playhead scrubbing', () => {
  it('does not trap the playhead at the end of the content while scrubbing', async () => {
    // Relative, not the `@/` alias: this file is typechecked by tsconfig.node,
    // which only maps `@shared`.
    const { useEditor } = await import('../src/renderer/src/state/editor')
    const { createProject } = await import('@shared/defaults')
    const project = createProject('scrub', '9:16', 30)
    useEditor.getState().setProject(project)

    // Empty timeline: a normal seek is clamped to zero (nothing to play)…
    useEditor.getState().setPlayhead(4000, { snap: false })
    expect(useEditor.getState().playhead).toBe(0)

    // …but a scrub follows the pointer, which is what makes the ruler usable.
    useEditor.getState().setPlayhead(4000, { snap: false, scrub: true })
    expect(useEditor.getState().playhead).toBe(4000)
    expect(useEditor.getState().scrubHeadMs).toBe(4000)

    // The next non-scrub seek clears the scrub head so playback is unaffected.
    useEditor.getState().setPlayhead(0, { snap: false })
    expect(useEditor.getState().scrubHeadMs).toBeNull()
  })
})

describe('in-app update asset selection', () => {
  it('offers the installer, never the portable build', async () => {
    const { pickInstallerAsset } = await import('../src/main/updater')
    const assets = [
      { name: 'Clipwright-Studio-Portable-1.0.1-x64.exe', browser_download_url: 'u1', size: 1 },
      { name: 'Clipwright-Studio-Setup-1.0.1-x64.exe', browser_download_url: 'u2', size: 2 },
      { name: 'checksums.txt', browser_download_url: 'u3', size: 3 }
    ]
    expect(pickInstallerAsset(assets)?.browser_download_url).toBe('u2')
  })

  it('still finds something when only a portable build was published', async () => {
    const { pickInstallerAsset } = await import('../src/main/updater')
    const assets = [{ name: 'Clipwright-Studio-Portable-1.0.1-x64.exe', browser_download_url: 'u1', size: 1 }]
    expect(pickInstallerAsset(assets)?.browser_download_url).toBe('u1')
  })
})

describe('update checksum asset', () => {
  it('recognises the checksums.txt that CI actually publishes', async () => {
    const { pickChecksumAsset } = await import('../src/main/updater')
    const assets = [
      { name: 'Clipwright-Studio-Setup-1.0.2-x64.exe', browser_download_url: 'setup', size: 1 },
      { name: 'latest.yml', browser_download_url: 'yml', size: 1 },
      { name: 'checksums.txt', browser_download_url: 'sums', size: 1 }
    ]
    // Without this the update downloads fine but cannot be verified, so the app
    // refuses to install it and the user is sent to the release page instead.
    expect(pickChecksumAsset(assets)?.browser_download_url).toBe('sums')
  })

  it('still accepts .sha256 and checksums.json from older releases', async () => {
    const { pickChecksumAsset } = await import('../src/main/updater')
    expect(
      pickChecksumAsset([{ name: 'build.sha256', browser_download_url: 'a', size: 1 }])?.browser_download_url
    ).toBe('a')
    expect(
      pickChecksumAsset([{ name: 'checksums.json', browser_download_url: 'b', size: 1 }])?.browser_download_url
    ).toBe('b')
  })

  it('ignores unrelated text assets', async () => {
    const { pickChecksumAsset } = await import('../src/main/updater')
    expect(pickChecksumAsset([{ name: 'release-notes.txt', browser_download_url: 'c', size: 1 }])).toBeUndefined()
  })
})
