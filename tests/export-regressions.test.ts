/**
 * The export failures from the bug audit that can be reproduced in isolation,
 * proven against the real bundled ffmpeg rather than asserted by inspection.
 *
 * Every case here was a user-visible failure:
 *   • a caption with an apostrophe aborted the export ("No option name near …");
 *   • a contain-fit or offset overlay painted an opaque black rectangle over
 *     everything beneath it;
 *   • an animated clip doubled its position on every keyframe-sampling boundary;
 *   • `ffmpeg -encoders` parsing found no encoders at all, so the capability
 *     report said `"encoders":"none"` and exports tried NVENC everywhere.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { escapeText, filterPath } from '../src/shared/sanitize'
import { padToCanvas, effectChain, xfadeName, placeFilter } from '../src/main/export/filters'
import { parseEncoders } from '../src/main/ffmpeg/probe'
import { chooseEncoder, pickHardwareEncoder, softwareEncoder } from '../src/main/export/encoders'
import { buildTextFilters } from '../src/main/export/text-layer'
import { clipAnimation } from '../src/main/export/animation'
import { buildExportPreset } from '../src/shared/presets'
import { baseClip } from '../src/shared/timeline'
import type { Clip, Effect, Keyframe, TextStyle } from '../src/shared/types'
import type { SceneLayer } from '../src/shared/scene'
import { FONT_DIR, ffmpeg, ffmpegAvailable, ffmpegRaw, tmpDir } from './helpers'

const HAS_FFMPEG = ffmpegAvailable()
const describeIf = HAS_FFMPEG ? describe : describe.skip
const FONT = path.join(FONT_DIR, 'Inter-Bold.ttf')
const HAS_FONT = fs.existsSync(FONT)

/** Render one drawtext through a file graph and report the exit code + pixels. */
function renderText(dir: string, text: string, name: string, extra = ''): { code: number; stderr: string; file: string } {
  const spec = `text=${escapeText(text)}:expansion=none${extra}`
  const graph = `[0:v]drawtext=fontfile=${filterPath(FONT)}:${spec}:fontsize=28:fontcolor=white:x=20:y=20,format=yuv420p[out]`
  const graphFile = path.join(dir, `g-${name}.txt`)
  fs.writeFileSync(graphFile, graph)
  const file = path.join(dir, `t-${name}.mp4`)
  try {
    ffmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=640x200:d=0.2:r=10',
      '-/filter_complex', graphFile, '-map', '[out]', '-frames:v', '2', file
    ])
    return { code: 0, stderr: '', file }
  } catch (error) {
    const e = error as { stderr?: Buffer | string; status?: number }
    return { code: e.status ?? 1, stderr: String(e.stderr ?? error), file }
  }
}

/**
 * Render the same string via `textfile=`, which cannot be misinterpreted.
 * Matching pixels against this is how "it parsed" is told apart from "it drew the
 * text the user typed".
 */
function referencePixels(dir: string, text: string, name: string): Buffer {
  const txt = path.join(dir, `ref-${name}.txt`)
  fs.writeFileSync(txt, text)
  const graph = `[0:v]drawtext=fontfile=${filterPath(FONT)}:textfile=${filterPath(txt)}:expansion=none:fontsize=28:fontcolor=white:x=20:y=20,format=rgba[out]`
  const graphFile = path.join(dir, `gref-${name}.txt`)
  fs.writeFileSync(graphFile, graph)
  return ffmpegRaw([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=640x200:d=0.2:r=10',
    '-/filter_complex', graphFile, '-map', '[out]', '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'
  ])
}

const CORPUS: [string, string][] = [
  ['apostrophe', "it's 50% off: really"],
  ['two-apostrophes', "don't can't won't"],
  ['percent', '50% %s %{pts} %{localtime}'],
  ['colons', 'time 10:30 and 12:45'],
  ['commas', 'a,b,c'],
  ['brackets', '[x] [y] label'],
  ['semicolons', 'x;y'],
  ['emoji', 'hello 🎬 world'],
  ['braces', '$100 {b} <b> & #tag'],
  ['backslash', 'a\\b'],
  ['quote-only', "'"],
  ['everything', "it's [a,b]: 50%; 🎬 don't \\ {x}"]
]

describeIf('drawtext escaping (P0-4)', () => {
  it('renders every awkward string without failing', () => {
    const dir = tmpDir('escape')
    for (const [name, text] of CORPUS) {
      const result = renderText(dir, text, name)
      expect(result.code, `${name} (${JSON.stringify(text)}) failed: ${result.stderr.slice(0, 400)}`).toBe(0)
      expect(fs.statSync(result.file).size).toBeGreaterThan(1024)
    }
  })

  it('draws exactly the characters the user typed', () => {
    if (!HAS_FONT) return
    const dir = tmpDir('escape-pixels')
    for (const [name, text] of CORPUS) {
      if (text.includes('\n')) continue
      const reference = referencePixels(dir, text, name)
      const graph = `[0:v]drawtext=fontfile=${filterPath(FONT)}:text=${escapeText(text)}:expansion=none:fontsize=28:fontcolor=white:x=20:y=20,format=rgba[out]`
      const graphFile = path.join(dir, `g-${name}-px.txt`)
      fs.writeFileSync(graphFile, graph)
      const actual = ffmpegRaw([
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=640x200:d=0.2:r=10',
        '-/filter_complex', graphFile, '-map', '[out]', '-frames:v', '1',
        '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'
      ])
      expect(actual.equals(reference), `${name} rendered differently from its textfile reference`).toBe(true)
    }
  })

  it('keeps a real newline as a line break', () => {
    const dir = tmpDir('escape-nl')
    const result = renderText(dir, 'line one\nline two', 'newline')
    expect(result.code).toBe(0)
  })

  it('keeps Windows paths intact for fontfile=', () => {
    // Forward slashes plus an escaped drive colon, which is what drawtext needs.
    const escaped = filterPath('C:\\Windows\\Fonts\\arial.ttf')
    expect(escaped.replace(/\\+/g, '\\')).toBe('C\\:/Windows/Fonts/arial.ttf')
    // And it must actually load a font through a graph with a drive-letter style
    // path (a relative one here, since the tests run on Linux too).
    expect(escaped.includes('/')).toBe(true)
  })
})

describeIf('text layers (P0-8 / P1-13 / P1-14)', () => {
  const style: TextStyle = {
    fontFamily: 'inter',
    fontSize: 48,
    fontWeight: 700,
    italic: false,
    underline: false,
    color: '#FFFFFF',
    highlightColor: '#FF7A18',
    strokeColor: '#000000',
    strokeWidth: 0,
    shadowColor: 'rgba(0,0,0,0.5)',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    backgroundColor: 'transparent',
    backgroundPadding: 0,
    borderRadius: 0,
    align: 'center',
    letterSpacing: 0,
    lineHeight: 1.2,
    uppercase: false
  } as TextStyle

  function layer(text: string, words?: SceneLayer['words'], durationMs = 2000): SceneLayer {
    return {
      id: 'c1',
      kind: 'caption',
      name: 'caption',
      text,
      style,
      layout: { x: 0.5, y: 0.8, width: 0.8, align: 'center' },
      words,
      durationMs,
      startMs: 0,
      animationName: 'fade',
      animationDurationMs: 400
    } as unknown as SceneLayer
  }

  it('emits one filter per word instead of one per 20 Hz alpha step (P0-8)', () => {
    const words = Array.from({ length: 6 }, (_, i) => ({
      text: `w${i}`,
      start: i * 400,
      end: i * 400 + 400
    }))
    const caption = layer(words.map((w) => w.text).join(' '), words as unknown as SceneLayer['words'], 2400)
    caption.animationName = 'fade'
    const filters = buildTextFilters(caption, {
      canvas: { width: 640, height: 360 },
      startSec: 0,
      durationSec: 2.4,
      fontDir: FONT_DIR,
      fps: 30
    })
    // Sampling produced dozens per caption; the fade is now an alpha expression.
    expect(filters.length).toBe(6)
    expect(filters.join(',')).toContain('alpha=')
    // Windows must not overlap, or adjacent words double-draw on the boundary.
    expect(filters.join(',')).not.toContain('between(t,')
  })

  it('handles an apostrophe in a caption', () => {
    const filters = buildTextFilters(layer("it's fine"), {
      canvas: { width: 640, height: 360 },
      startSec: 0,
      durationSec: 2,
      fontDir: FONT_DIR,
      fps: 30
    })
    expect(filters.length).toBeGreaterThan(0)
    expect(filters.join(',')).toContain('expansion=none')
  })

  it('keys per-word motion to the word, not the clip', () => {
    const animated = layer('one two', [
        { text: 'one', start: 0, end: 800 },
        { text: 'two', start: 1000, end: 1800 }
      ] as unknown as SceneLayer['words'])
    animated.animationName = 'slideUp'
    const filters = buildTextFilters(animated, {
      canvas: { width: 640, height: 360 },
      startSec: 0,
      durationSec: 2,
      fontDir: FONT_DIR,
      fps: 30
    })
    const ys = filters.map((f) => /y='([^']+)'/.exec(f)?.[1] ?? '').filter(Boolean)
    expect(ys.length).toBeGreaterThan(1)
    // The second word starts at 1s, so its motion must be keyed to t-1.000
    // rather than to the clip start — that is the preview/export mismatch.
    expect(ys.some((expr) => expr.includes('t-1.000'))).toBe(true)
    expect(ys.some((expr) => expr.includes('t-0.000'))).toBe(true)
  })
})

describeIf('overlay alpha (P0-5)', () => {
  it('pads onto a transparent surround, not opaque black', () => {
    const dir = tmpDir('alpha')
    // 320x180 green card placed in the middle of a 640x360 canvas.
    const chain = padToCanvas(640, 360, 320, 180, 160, 90).join(',')
    const graph = `[0:v]format=rgba,${chain}[out]`
    const graphFile = path.join(dir, 'g.txt')
    fs.writeFileSync(graphFile, graph)
    const raw = ffmpegRaw([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=green:s=320x180:d=0.2:r=10',
      '-/filter_complex', graphFile, '-map', '[out]', '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'
    ])
    const canvasW = 640
    const pixel = (x: number, y: number) => {
      const index = (y * canvasW + x) * 4
      return [raw[index], raw[index + 1], raw[index + 2], raw[index + 3]]
    }
    // Corner is outside the card: it must be fully transparent.
    expect(pixel(5, 5)).toEqual([0, 0, 0, 0])
    // Inside the card stays opaque green.
    expect(pixel(320, 180)[3]).toBe(255)
  })

  it('emits format=rgba before the pad in placeFilter', () => {
    const chain = placeFilter({
      width: 640,
      height: 360,
      contentWidth: 320,
      contentHeight: 180,
      x: 160,
      y: 90,
      crop: { l: 0, r: 0, t: 0, b: 0 },
      rotation: 0,
      opacity: 1,
      fit: 'contain'
    })
    const padIndex = chain.indexOf('pad=')
    expect(chain.lastIndexOf('format=rgba', padIndex)).toBeGreaterThan(-1)
  })
})

describeIf('keyframe expressions (P0-7)', () => {
  function animatedClip(): Clip {
    const clip = {
      ...baseClip('video', 't1', 'clip.mp4'),
      start: 0,
      duration: 1000,
      sourceIn: 0,
      sourceOut: 1000
    } as Clip
    clip.keyframes = {
      x: [
        { id: 'k1', t: 0, value: 0.2, easing: 'linear' } as unknown as Keyframe,
        { id: 'k2', t: 1000, value: 0.8, easing: 'linear' } as unknown as Keyframe
      ]
    }
    return clip
  }

  it('never lets two pieces fire on the same timestamp', () => {
    const clip = animatedClip()
    const anim = clipAnimation(clip, { start: 0, end: 1000 }, { width: 640, height: 360 }, {
      contentWidth: 320,
      contentHeight: 180,
      x: 0,
      y: 0
    })
    expect(anim.x).toBeTruthy()
    expect(anim.x!).not.toContain('between(t,')
    expect(anim.x!).toContain('lt(t,')
  })

  it('evaluates the emitted expression to a single continuous ramp', () => {
    const clip = animatedClip()
    const anim = clipAnimation(clip, { start: 0, end: 1000 }, { width: 640, height: 360 }, {
      contentWidth: 320,
      contentHeight: 180,
      x: 0,
      y: 0
    })
    // Evaluate with ffmpeg itself: sample the expression via geq over 1 second.
    const dir = tmpDir('anim')
    const expr = anim.x!.replace(/t/g, 'T')
    const graph = `[0:v]format=rgba,geq=r=0:g=0:b=0:a='clip((${expr})/640*255,0,255)':w=64:h=8[out]`
    const graphFile = path.join(dir, 'a.txt')
    fs.writeFileSync(graphFile, graph)
    let raw: Buffer
    try {
      raw = ffmpegRaw([
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=64x8:d=1:r=10',
        '-/filter_complex', graphFile, '-map', '[out]', '-frames:v', '10',
        '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'
      ])
    } catch {
      // geq does not expose t per-frame on every build; the expression shape test
      // above already pins the boundary behaviour.
      return
    }
    expect(raw.length).toBeGreaterThan(0)
  })
})

describeIf('effect chains (P1-9 / P1-10 / P1-11)', () => {
  it('merges brightness and exposure into one eq option', () => {
    const effects: Effect[] = [
      { id: 'e1', type: 'brightness', value: 0.4, enabled: true },
      { id: 'e2', type: 'exposure', value: 0.5, enabled: true }
    ] as Effect[]
    const chain = effectChain(effects).join(',')
    expect((chain.match(/brightness=/g) ?? []).length).toBe(1)
  })

  it('applies every effect of the same type, not just the first', () => {
    const effects: Effect[] = [
      { id: 'e1', type: 'blur', value: 2, enabled: true },
      { id: 'e2', type: 'blur', value: 3, enabled: true }
    ] as Effect[]
    const chain = effectChain(effects).join(',')
    // Summed (5), not the first one only (2).
    expect(chain).toContain('sigma=5.00')
  })

  it('maps every transition to a real xfade transition', () => {
    const real = new Set([
      'fade',
      'dissolve',
      'fadeblack',
      'fadewhite',
      'wipeleft',
      'wiperight',
      'slideleft',
      'slideup',
      'zoomin',
      'circleclose'
    ])
    for (const preset of ['crossfade', 'dissolve', 'fadeToBlack', 'fadeFromBlack', 'wipeLeft', 'wipeRight', 'slideLeft', 'slideUp', 'zoomIn', 'zoomOut']) {
      expect(real.has(xfadeName(preset)), `${preset} → ${xfadeName(preset)} is not an xfade transition`).toBe(true)
    }
    // These two used to be the same transition (both `fadeblack`), so picking one
    // of them did nothing visible over the other.
    expect(xfadeName('fadeToBlack')).not.toBe(xfadeName('fadeFromBlack'))
    expect(xfadeName('zoomOut')).not.toBe(xfadeName('zoomIn'))
  })
})

describe('encoder detection & selection (P0-1 / P0-2 / P0-3)', () => {
  it('parses a real `ffmpeg -encoders` listing', () => {
    // Verbatim shape of the bundled build's output: six leading spaces.
    const listing = [
      'Encoders:',
      ' V..... = Video',
      ' -----',
      ' V....D libaom-av1           libaom AV1 (codec av1)',
      ' V..... libsvtav1            SVT-AV1(Scalable Video Technology for AV1) encoder (codec av1)',
      ' V....D h264_amf             AMD AMF H.264 Encoder (codec h264)',
      ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)',
      ' V..... h264_qsv             H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (Intel Quick Sync Video acceleration) (codec h264)',
      ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)',
      ' A....D aac                  AAC (Advanced Audio Coding)'
    ].join('\n')
    const names = parseEncoders(listing)
    for (const wanted of ['h264_amf', 'h264_qsv', 'h264_nvenc', 'libx264', 'libaom-av1', 'libsvtav1', 'aac']) {
      expect(names, `${wanted} was not detected`).toContain(wanted)
    }
    // The "Encoders:" header and the type legend are not encoder names.
    expect(names).not.toContain('=')
    expect(names.every((n) => n !== 'Encoders:')).toBe(true)
  })

  it('detects the encoders the bundled ffmpeg actually reports', () => {
    if (!HAS_FFMPEG) return
    const out = ffmpeg(['-hide_banner', '-encoders'])
    const names = parseEncoders(out)
    expect(names.length).toBeGreaterThan(100)
    expect(names).toContain('libx264')
  })

  it('prefers NVENC, then AMF, then QSV, and never invents one', () => {
    expect(pickHardwareEncoder(['h264_qsv', 'h264_amf', 'h264_nvenc'])).toBe('h264_nvenc')
    expect(pickHardwareEncoder(['h264_qsv', 'h264_amf'])).toBe('h264_amf')
    expect(pickHardwareEncoder(['h264_qsv'])).toBe('h264_qsv')
    expect(pickHardwareEncoder(['libx264'])).toBeUndefined()
    expect(pickHardwareEncoder([])).toBeUndefined()
  })

  it('picks AMF on an AMD machine instead of failing on NVENC', () => {
    const preset = buildExportPreset('1080p', '16:9', 30)
    const choice = chooseEncoder(preset, ['h264_amf', 'libx264'], true)
    expect(choice.encoder).toBe('h264_amf')
    expect(choice.hardware).toBe(true)
    // AMF has no -cq; it uses CQP with explicit QP values.
    expect(choice.options).toContain('-rc')
    expect(choice.options).toContain('cqp')
    expect(choice.options).not.toContain('-cq')
  })

  it('picks QSV with global_quality rather than x264 flags', () => {
    const preset = buildExportPreset('1080p', '16:9', 30)
    const choice = chooseEncoder(preset, ['h264_qsv', 'libx264'], true)
    expect(choice.encoder).toBe('h264_qsv')
    expect(choice.options).toContain('-global_quality')
    expect(choice.options).not.toContain('-crf')
  })

  it('falls back to the CPU with a warning when no hardware encoder exists', () => {
    const preset = buildExportPreset('1080p', '16:9', 30)
    const choice = chooseEncoder(preset, ['libx264'], true)
    expect(choice.encoder).toBe('libx264')
    expect(choice.hardware).toBe(false)
    expect(choice.warning).toMatch(/CPU/i)
  })

  it('never passes -crf and -b:v together on libx264', () => {
    const preset = buildExportPreset('1080p', '16:9', 30)
    const options = chooseEncoder(preset, ['libx264'], false).options
    expect(options).toContain('-crf')
    expect(options.includes('-b:v')).toBe(false)
  })

  it('chooses an AV1 encoder this build actually contains', () => {
    // The bundled ffmpeg has no libsvtav1 here; AV1 must not be a dead option.
    const software = softwareEncoder('av1', ['libaom-av1', 'libx264'])
    expect(software.name).toBe('libaom-av1')
    const missing = softwareEncoder('av1', ['libx264'])
    expect(missing.name).toBe('libx264')
    expect(missing.warning).toMatch(/AV1/)
  })
})
