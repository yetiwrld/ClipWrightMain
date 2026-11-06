/**
 * Text / caption rendering for the FFmpeg export pipeline.
 *
 * Layout comes from the shared layout engine (exact TTF advances), so word
 * positions match the preview. Animations map onto filter features that are
 * exactly equivalent:
 *    • vertical motion  → drawtext `y=` expression (same cubic curve),
 *    • block fading     → short drawtext windows with sampled alpha,
 *    • word reveals     → `enable=` windows,
 *    • karaoke          → colour switch at each word start.
 */
import fs from 'node:fs'
import { layoutText, textAnimationState, baselineInLine } from '@shared/text-layout'
import type { TextLayout } from '@shared/text-layout'
import { parseColour, toFfmpegColour } from '@shared/colour'
import { escapeText, filterPath } from '@shared/sanitize'
import type { SceneLayer } from '@shared/scene'
import type { TextStyle } from '@shared/types'

export interface TextLayerOptions {
  canvas: { width: number; height: number }
  /** absolute timeline start of this layer, seconds */
  startSec: number
  /** seconds visible */
  durationSec: number
  fontDir: string
  fps: number
}

const SAMPLE_HZ = 20
const ALPHA_STEP = 0.07
const C1 = 1.70158
const C3 = C1 + 1

interface Window {
  from: number
  to: number
  alpha: number
  highlight: boolean
}

export function buildTextFilters(layer: SceneLayer, opts: TextLayerOptions): string[] {
  const style = layer.style
  if (!style || !layer.text) return []
  const totalMs = Math.max(1, layer.durationMs ?? Math.round(opts.durationSec * 1000))
  const animation = layer.animationName ?? 'none'
  const animMs = layer.animationDurationMs ?? 180
  const layout = layoutText(layer.text, style, layer.layout, opts.canvas, layer.words)
  if (layout.words.length === 0) return []

  const fontFile = filterPath(resolveFontFile(opts.fontDir, layout.face.id))
  const baseline = baselineInLine(layout, style)
  const filters: string[] = []
  const clipStart = opts.startSec
  /*
   * Which animations reveal words one at a time (hard cut) and which fade the
   * block in. This mirrors textAnimationState() in shared/text-layout.ts.
   */
  const revealPerWord =
    animation === 'wipe' ||
    animation === 'typewriter' ||
    animation === 'letterByLetter' ||
    animation === 'wordByWord'
  const blockAlphaExpr: string | number =
    animation === 'fade' || animation === 'slideUp' || animation === 'pop' || animation === 'bounce' || animation === 'reveal'
      ? fadeExpr(clipStart, clipStart + Math.min(0.4, animMs / 1000))
      : 1
  const clipEnd = opts.startSec + Math.max(0.04, opts.durationSec)
  /*
   * Motion used to be keyed to the *clip* start, so slideUp/pop/bounce played
   * once at the head of the caption and the preview (which animates per word)
   * disagreed with the export on every word after the first. Each word now gets
   * its own start time, falling back to the clip start for words without timing.
   */
  const clipExpr = yExpression(animation, animMs, clipStart, totalMs)
  const wordExpression = (wordStartMs?: number) =>
    wordStartMs && wordStartMs > 0
      ? yExpression(animation, animMs, clipStart + wordStartMs / 1000, totalMs)
      : clipExpr

  // Background plate.
  const bg = parseColour(style.backgroundColor)
  if (bg && bg.a > 0.01) {
    const pad = style.backgroundPadding
    const plateY = Math.round(layout.blockY - pad)
    filters.push(
      `drawbox=x=${Math.round(layout.blockX - pad)}:y='${plateY}+${clipExpr}':w=${Math.round(
        layout.width + pad * 2
      )}:h=${Math.round(layout.height + pad * 2)}:color=${toFfmpegColour(
        style.backgroundColor
      )}:t=fill:enable='between(t,${clipStart.toFixed(3)},${clipEnd.toFixed(3)})'`
    )
  }

  /*
   * One drawtext per word per *colour state*, with the whole life of the word in
   * `enable=` and the fade in `alpha=`. This replaces a 20 Hz sampling loop that
   * emitted a separate filter for every alpha step: a three-second six-word
   * caption produced dozens of filters, and a 60-second track produced thousands
   * (~500 ms just to parse 30 frames of 1080p). The letterSpacing branch below
   * still draws per character, but also only once.
   */
  const keywordSet = keywordIndices(style, layout)
  layout.words.forEach((word, index) => {
    const hasTiming = Boolean(word.start || word.end)
    const from = hasTiming ? Math.max(0, word.start!) : 0
    const to = hasTiming ? Math.min(totalMs, word.end!) : totalMs
    if (to <= from) return
    const absFrom = Math.max(clipStart, clipStart + from / 1000)
    const absTo = Math.min(clipEnd, clipStart + to / 1000)
    if (absTo - absFrom < 0.001) return
    const enable = rangeExpr(absFrom, absTo)
    /*
     * Block animations fade the whole caption once, starting when the clip
     * starts — exactly what textAnimationState() does in the preview. Keying the
     * ramp to each word would fade every word separately, which no other part of
     * the app does. The reveal animations cut per word instead of fading.
     */
    const alphaExpr = revealPerWord ? 1 : blockAlphaExpr
    const highlighted = keywordSet.has(index)
    const colour = toFfmpegColour(highlighted ? style.highlightColor : style.color)
    const x = Math.round(layout.blockX + word.x)
    const y = Math.round(layout.blockY + word.y + baseline - layout.ascentPx)
    const yExpr = wordExpression(hasTiming ? word.start : undefined)
    if (Math.abs(style.letterSpacing) >= 0.5 && word.text.length > 1) {
      let cursor = x
      for (const ch of word.text) {
        filters.push(
          makeDrawText({
            text: ch,
            fontFile,
            style,
            x: `${Math.round(cursor)}`,
            y: `'${y}+${yExpr}'`,
            colour,
            alpha: alphaExpr,
            enable
          })
        )
        cursor += advanceOf(layout, ch, style) + style.letterSpacing
      }
    } else {
      filters.push(
        makeDrawText({
          text: word.text,
          fontFile,
          style,
          x: `${x}`,
          y: `'${y}+${yExpr}'`,
          colour,
          alpha: alphaExpr,
          enable
        })
      )
    }
  })
  return filters
}

/**
 * Which words carry the highlight colour.
 *
 * The export used to compute a `keywordMode` constant that was always false and
 * then `void` it, so keyword highlighting never happened in the exported file.
 */
function keywordIndices(style: TextStyle, layout: TextLayout): Set<number> {
  const mode = (style as unknown as { highlightMode?: string }).highlightMode
  if (mode !== 'keyword' || !style.highlightColor) return new Set()
  const stop = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'so', 'to', 'of', 'in', 'on', 'at', 'for', 'is',
    'are', 'was', 'were', 'be', 'it', 'this', 'that', 'i', 'you', 'we', 'they', 'my', 'your'
  ])
  const scored = layout.words
    .map((w, i) => {
      const clean = w.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
      const score =
        (/[!?]$/.test(w.text) ? 3 : 0) +
        (clean.length >= 7 ? 2 : clean.length >= 5 ? 1 : 0) +
        (stop.has(clean) ? -3 : 0)
      return { i, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
  return new Set(
    scored
      .slice(0, Math.max(1, Math.ceil(layout.words.length / 4)))
      .map((entry) => entry.i)
      .sort((a, b) => a - b)
  )
}

/** Enable window for a word: gte/lt so adjacent windows never overlap. */
function rangeExpr(fromSec: number, toSec: number): string {
  return `gte(t,${fromSec.toFixed(3)})*lt(t,${toSec.toFixed(3)})`
}

/**
 * Fade-in alpha as an ffmpeg expression: 0 before the word, ramping to 1 over the
 * animation duration, 1 afterwards. `alpha` is evaluated per frame, so the ramp is
 * continuous instead of stepping at 20 Hz.
 */
function fadeExpr(fromSec: number, rampEndSec: number): string {
  const ramp = Math.max(0.001, rampEndSec - fromSec)
  return `if(lt(t,${fromSec.toFixed(3)}),0,if(lt(t,${rampEndSec.toFixed(3)}),(t-${fromSec.toFixed(
    3
  )})/${ramp.toFixed(4)},1))`
}

/**
 * Drawtext fontfile for a face id. The extension used to be hardcoded to `.ttf`,
 * so an OTF/TTC face dropped into the font folder was unresolvable and the whole
 * filter graph could not be built.
 */
export function resolveFontFile(fontDir: string, faceId: string): string {
  const base = `${fontDir}/${faceId}`
  for (const ext of ['.ttf', '.otf', '.ttc', '.woff2', '.woff', '.TTF', '.OTF']) {
    try {
      if (fs.existsSync(base + ext)) return base + ext
    } catch {
      /* fall through to the default */
    }
  }
  return `${base}.ttf`
}

/**
 * Vertical motion as an ffmpeg expression in `t`.
 * Matches offsetCurve() in text-layout.ts exactly.
 */
export function yExpression(animation: string, animMs: number, clipStartSec: number, totalMs: number): string {
  const d = Math.max(0.001, animMs / 1000)
  const p = `clip((t-${clipStartSec.toFixed(3)})/${d.toFixed(4)},0,1)`
  switch (animation) {
    case 'slideUp':
    case 'reveal': {
      const amp = animation === 'slideUp' ? 44 : 26
      return `${amp}*pow(1-${p},3)`
    }
    case 'pop': {
      // 1 - easeOutBack(p) with c1 = 1.70158
      return `-14*(${C3}*pow(${p}-1,3)+${C1}*pow(${p}-1,2))`
    }
    case 'bounce': {
      return `-42*(${C3}*pow(${p}-1,3)+${C1}*pow(${p}-1,2))`
    }
    default:
      return '0'
  }
}

function advanceOf(layout: TextLayout, ch: string, style: TextStyle): number {
  const code = ch.codePointAt(0) ?? 0
  const advance = layout.face.metrics.widths[String(code)] ?? layout.face.metrics.defaultAdvance
  return (advance / layout.face.metrics.unitsPerEm) * style.fontSize
}

function makeDrawText(spec: {
  text: string
  fontFile: string
  style: TextStyle
  x: string
  y: string
  colour: string
  /** Alpha as a number (1) or an ffmpeg expression in t. */
  alpha: number | string
  enable: string
}): string {
  const { style } = spec
  /*
   * No single quotes around the values. Wrapping them (as this used to) put the
   * text through an extra layer of quoting that ffmpeg handles inconsistently —
   * an apostrophe ended the value and the rest of the chain was parsed as option
   * names. The values are escaped for both layers instead, and
   * `expansion=none` stops drawtext from expanding `%`/`{…}`, which also
   * silences the "Stray %" warnings that polluted every export log.
   */
  const parts: string[] = [
    `fontfile=${spec.fontFile}`,
    `text=${escapeText(spec.text)}`,
    `expansion=none`,
    `fontsize=${Math.round(style.fontSize)}`,
    typeof spec.alpha === 'number'
      ? `fontcolor=${spec.colour}@${Math.max(0, Math.min(1, spec.alpha)).toFixed(3)}`
      : `fontcolor=${spec.colour}:alpha='${spec.alpha}'`,
    `x=${spec.x}`,
    `y=${spec.y}`
  ]
  if (style.strokeWidth > 0) {
    parts.push(`borderw=${Math.round(style.strokeWidth)}`)
    parts.push(`bordercolor=${toFfmpegColour(style.strokeColor)}@1`)
  }
  if (style.shadowBlur > 0 || style.shadowOffsetX || style.shadowOffsetY) {
    parts.push(`shadowcolor=${toFfmpegColour(style.shadowColor)}`)
    parts.push(`shadowx=${Math.round(style.shadowOffsetX)}`)
    parts.push(`shadowy=${Math.round(style.shadowOffsetY || Math.max(2, (style.shadowBlur || 0) / 4))}`)
  }
  parts.push(`enable='${spec.enable}'`)
  return `drawtext=${parts.join(':')}`
}
