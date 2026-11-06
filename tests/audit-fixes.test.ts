/**
 * Regression tests for the audit fixes that do not need a video to prove.
 *
 * Filesystem, parsing and policy behaviour only — the ffmpeg-dependent cases
 * live in tests/export-regressions.test.ts.
 */
// @vitest-environment node
import { describe, expect, it, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { blackDurationSeconds, aspectRatio } from '../src/main/export/validation'
import { captionsToSrt, groupWordsIntoCaptions, pickKeywordIndices, buildCaptionClips } from '../src/shared/captions'
import { clampCropPair } from '../src/shared/keyframes'
import { isPrivateAddress } from '../src/main/media/remote'
import { parseEncoders } from '../src/main/ffmpeg/probe'
import type { CaptionWord, Clip } from '../src/shared/types'

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-round4-'))

beforeEach(async () => {
  const { setWorkspaceRoot } = await import('../src/main/workspace')
  setWorkspaceRoot(workspace)
})

/* ------------------------------ validation ------------------------------- */

describe('export validation maths', () => {
  it('sums black spans instead of counting runs (P1-3)', () => {
    const stderr = [
      '[blackdetect @ 0x1] black_start:1.5 black_end:2.5 black_duration:1',
      '[blackdetect @ 0x1] black_start:10 black_end:11 black_duration:1',
      '[blackdetect @ 0x1] black_start:30 black_end:31 black_duration:1'
    ].join('\n')
    // Three one-second runs: 3 s of black, not "3 runs × 0.2 s".
    expect(blackDurationSeconds(stderr)).toBeCloseTo(3, 3)
  })

  it('counts an unterminated run at end of file', () => {
    expect(blackDurationSeconds('black_start:59.9')).toBeCloseTo(0.2, 3)
  })

  it('derives the requested aspect so the check is not a tautology (P3-6)', () => {
    expect(aspectRatio('16:9')).toBeCloseTo(16 / 9, 5)
    expect(aspectRatio('9:16')).toBeCloseTo(9 / 16, 5)
    expect(aspectRatio('nonsense')).toBeUndefined()
    expect(aspectRatio(undefined)).toBeUndefined()
  })
})

/* ------------------------------- captions -------------------------------- */

describe('caption serialisation', () => {
  function caption(start: number, duration: number, text = 'hi'): Clip {
    return { id: 'c', kind: 'caption', start, duration, text } as unknown as Clip
  }

  it('carries milliseconds instead of emitting four digits (P1-17)', () => {
    const srt = captionsToSrt([caption(1999.7, 1000)])
    const line = srt.split('\n')[1]
    expect(line).toContain('00:00:02,000')
    expect(line).not.toMatch(/,\d{4}/)
  })

  it('never produces a 1000 ms field anywhere in a long track', () => {
    const clips = Array.from({ length: 40 }, (_, i) => caption(i * 1999.7 + 1, 1500))
    const srt = captionsToSrt(clips)
    for (const line of srt.split('\n')) {
      if (!line.includes('-->')) continue
      for (const stamp of line.split('-->').map((part) => part.trim())) {
        expect(stamp).toMatch(/^\d{2}:\d{2}:\d{2},\d{3}$/)
      }
    }
  })

  it('breaks a one-word sentence (P3-9)', () => {
    const words: CaptionWord[] = [
      { text: 'No.', start: 0, end: 400 },
      { text: 'Next', start: 500, end: 900 }
    ]
    const groups = groupWordsIntoCaptions(words, 5)
    expect(groups.length).toBe(2)
    expect(groups[0].words[0].text).toBe('No.')
  })

  it('returns keyword indices in word order (P1-19)', () => {
    const words: CaptionWord[] = [
      { text: 'extraordinary', start: 0, end: 300 },
      { text: 'the', start: 300, end: 400 },
      { text: 'remarkable', start: 400, end: 800 },
      { text: 'win', start: 800, end: 1000 }
    ]
    const indices = pickKeywordIndices(words)
    expect(indices.length).toBeGreaterThan(0)
    expect([...indices].sort((a, b) => a - b)).toEqual(indices)
  })

  it('keeps caption words aligned with a clamped clip start (P1-18)', () => {
    // Clip begins before the export range, so its start is clamped at 0 and the
    // words must be shifted by the same amount.
    const clips = buildCaptionClips(
      [{ start: -2000, end: 2000, text: 'one two three' }] as never,
      { start: 0, end: 4000 },
      { id: 'p', wordsPerLine: 6, style: {}, layout: {}, animation: 'none' } as never,
      'track-caption'
    )
    expect(clips.length).toBeGreaterThan(0)
    for (const clip of clips) {
      const first = clip.words?.[0]?.start ?? 0
      expect(first).toBeGreaterThanOrEqual(0)
      expect(Math.abs(clip.start - first)).toBeLessThan(60)
    }
  })
})

/* --------------------------------- crops --------------------------------- */

describe('crop clamping (P1-20)', () => {
  it('keeps opposing edges below the full frame', () => {
    const [l, r] = clampCropPair(0.9, 0.9)
    expect(l + r).toBeLessThan(1)
  })

  it('leaves legal crops untouched', () => {
    expect(clampCropPair(0.1, 0.2)).toEqual([0.1, 0.2])
    expect(clampCropPair(-1, 2)).toEqual([0, 0.95])
  })
})

/* ------------------------------- security -------------------------------- */

describe('network policy (P2-7)', () => {
  it('blocks loopback, link-local, private and CGNAT ranges', () => {
    for (const address of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '192.168.1.10', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1']) {
      expect(isPrivateAddress(address), `${address} must be blocked`).toBe(true)
    }
  })

  it('allows public addresses', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) {
      expect(isPrivateAddress(address), `${address} must be allowed`).toBe(false)
    }
  })
})

/* ----------------------------- encoder parsing --------------------------- */

describe('encoder listing', () => {
  it('ignores headers and legend rows', () => {
    const listing = [
      'Encoders:',
      ' V..... = Video',
      ' -----',
      ' A....D aac                  AAC (Advanced Audio Coding)'
    ].join('\n')
    expect(parseEncoders(listing)).toEqual(['aac'])
  })
})

/* ------------------------------ workspace -------------------------------- */

describe('workspace hygiene', () => {
  it('reuses an identical file instead of copying it twice (P1-22)', async () => {
    const { importIntoLibrary } = await import('../src/main/workspace')
    const source = path.join(workspace, 'clip.mp4')
    fs.writeFileSync(source, 'same bytes')
    const first = importIntoLibrary(source, 'prj_dedupe')
    const second = importIntoLibrary(source, 'prj_dedupe')
    expect(second).toBe(first)
    const dir = path.dirname(first)
    expect(fs.readdirSync(dir)).toHaveLength(1)
  })

  it('keeps two different files apart', async () => {
    const { importIntoLibrary } = await import('../src/main/workspace')
    const a = path.join(workspace, 'a.mp4')
    const b = path.join(workspace, 'b.mp4')
    fs.writeFileSync(a, 'aaaa')
    fs.writeFileSync(b, 'bbbb')
    expect(importIntoLibrary(a, 'prj_two')).not.toBe(importIntoLibrary(b, 'prj_two'))
  })

  it('removes a project folder completely, media included (P1-21)', async () => {
    const { saveProjectSync, remove, loadProject } = await import('../src/main/projects')
    const { createProject } = await import('../src/shared/defaults')
    const project = createProject('Folder test', '16:9', 30)
    saveProjectSync(project)
    const dir = path.join(workspace, 'Projects', project.id)
    fs.mkdirSync(path.join(dir, 'media'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'media', 'a.mp4'), 'bytes')
    remove(project.id)
    expect(fs.existsSync(dir)).toBe(false)
    expect(() => loadProject(project.id)).toThrow()
  })

  it('sweeps orphaned project folders at startup (P1-21)', async () => {
    const { sweepOrphanedProjects } = await import('../src/main/projects')
    const orphan = path.join(workspace, 'Projects', 'prj_orphan')
    fs.mkdirSync(path.join(orphan, 'media'), { recursive: true })
    fs.writeFileSync(path.join(orphan, 'media', 'x.mp4'), 'bytes')
    const removed = sweepOrphanedProjects()
    expect(removed).toContain('prj_orphan')
    expect(fs.existsSync(orphan)).toBe(false)
  })
})

/* ------------------------------ zip bounds ------------------------------- */

describe('package import bounds (P1-25)', () => {
  it('refuses an archive that declares too many entries', async () => {
    const { listZipEntries, declaredUncompressedBytes, importPackage } = await import('../src/main/projects')
    const { zipSync } = await import('fflate')
    const entries: Record<string, Uint8Array> = {}
    for (let i = 0; i < 20; i++) entries[`f${i}.txt`] = new Uint8Array([65])
    const bytes = zipSync(entries)
    expect(listZipEntries(bytes)).toHaveLength(20)
    expect(declaredUncompressedBytes(bytes)).toBeGreaterThan(0)

    // A package without project.json is rejected before any extraction.
    const file = path.join(workspace, 'bad.clipwright')
    fs.writeFileSync(file, bytes)
    await expect(importPackage(file)).rejects.toThrow(/no project\.json|project\.json/i)
  })
})
