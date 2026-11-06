/**
 * Text layout engine.
 *
 * Both the preview monitor (canvas 2D) and the FFmpeg exporter (drawtext) use
 * this module to break lines and place words, using exact glyph advances parsed
 * from the bundled TTFs. That is what keeps exported captions identical to the
 * preview instead of "close enough".
 */
import metricsJson from './font-metrics.json'
import { FONT_STACKS, fontStack } from './presets'
import type { CaptionWord, TextStyle, TextBoxLayout } from './types'

export interface FontMetrics {
  unitsPerEm: number
  ascender: number
  descender: number
  lineGap: number
  defaultAdvance: number
  widths: Record<string, number>
  hasKerning?: boolean
}

const METRICS = metricsJson as unknown as Record<string, FontMetrics>

export interface FontFace {
  /** Bundled file id, e.g. Inter_800ExtraBold */
  id: string
  /** CSS family name */
  family: string
  /** Full CSS stack for the preview canvas */
  cssStack: string
  metrics: FontMetrics
}

const FAMILY_FILES: Record<string, { base: string; weights: Record<number, string> }> = {
  inter: {
    base: 'Inter',
    weights: { 400: 'Inter_400Regular', 500: 'Inter_600SemiBold', 600: 'Inter_600SemiBold', 700: 'Inter_700Bold', 800: 'Inter_800ExtraBold', 900: 'Inter_900Black' }
  },
  montserrat: {
    base: 'Montserrat',
    weights: { 400: 'Montserrat_400Regular', 500: 'Montserrat_400Regular', 600: 'Montserrat_700Bold', 700: 'Montserrat_700Bold', 800: 'Montserrat_900Black', 900: 'Montserrat_900Black' }
  },
  anton: { base: 'Anton', weights: { 400: 'Anton_400Regular', 500: 'Anton_400Regular', 600: 'Anton_400Regular', 700: 'Anton_400Regular', 800: 'Anton_400Regular', 900: 'Anton_400Regular' } },
  bebas: { base: 'Bebas Neue', weights: { 400: 'BebasNeue_400Regular', 500: 'BebasNeue_400Regular', 600: 'BebasNeue_400Regular', 700: 'BebasNeue_400Regular', 800: 'BebasNeue_400Regular', 900: 'BebasNeue_400Regular' } },
  oswald: { base: 'Oswald', weights: { 400: 'Oswald_400Regular', 500: 'Oswald_400Regular', 600: 'Oswald_700Bold', 700: 'Oswald_700Bold', 800: 'Oswald_700Bold', 900: 'Oswald_700Bold' } },
  poppins: { base: 'Poppins', weights: { 400: 'Poppins_400Regular', 500: 'Poppins_400Regular', 600: 'Poppins_700Bold', 700: 'Poppins_700Bold', 800: 'Poppins_700Bold', 900: 'Poppins_700Bold' } },
  playfair: { base: 'Playfair Display', weights: { 400: 'PlayfairDisplay_400Regular', 500: 'PlayfairDisplay_400Regular', 600: 'PlayfairDisplay_700Bold', 700: 'PlayfairDisplay_700Bold', 800: 'PlayfairDisplay_700Bold', 900: 'PlayfairDisplay_700Bold' } },
  jetbrains: { base: 'JetBrains Mono', weights: { 400: 'JetBrainsMono_400Regular', 500: 'JetBrainsMono_400Regular', 600: 'JetBrainsMono_700Bold', 700: 'JetBrainsMono_700Bold', 800: 'JetBrainsMono_700Bold', 900: 'JetBrainsMono_700Bold' } }
}

/**
 * Fonts that ship with Windows and are safe to reference by family name. They
 * are rendered through the same metrics engine using the closest bundled file
 * for measurement, so placement stays predictable.
 */
const SYSTEM_FONTS: Record<string, string> = {
  'Segoe UI': 'Inter',
  'Segoe UI Variable': 'Inter',
  Arial: 'Inter',
  Helvetica: 'Inter',
  Georgia: 'PlayfairDisplay',
  'Times New Roman': 'PlayfairDisplay',
  Impact: 'Anton',
  Consolas: 'JetBrainsMono',
  'Courier New': 'JetBrainsMono'
}

export function bundledFontIds(): string[] {
  return Object.keys(METRICS)
}

export function resolveFace(style: Pick<TextStyle, 'fontFamily' | 'fontWeight'>): FontFace {
  const spec = FAMILY_FILES[style.fontFamily]
  const stack = fontStack(style.fontFamily)
  if (spec) {
    const weightKey = closestWeight(spec.weights, style.fontWeight)
    const id = spec.weights[weightKey] ?? `${spec.base}_400Regular`
    return {
      id,
      family: spec.base,
      cssStack: stack,
      metrics: METRICS[id] ?? METRICS.Inter_400Regular
    }
  }
  // Unknown family (custom Windows font): measure with the nearest bundled face.
  const familyName = familyNameFromStack(stack)
  const measureBase = SYSTEM_FONTS[familyName] ?? 'Inter'
  const spec2 = FAMILY_FILES[measureBase.toLowerCase()] ?? FAMILY_FILES.inter
  const id = spec2.weights[closestWeight(spec2.weights, style.fontWeight)]
  return { id, family: familyName, cssStack: stack, metrics: METRICS[id] ?? METRICS.Inter_400Regular }
}

function closestWeight(weights: Record<number, string>, requested: number): number {
  const keys = Object.keys(weights).map(Number).sort((a, b) => a - b)
  let best = keys[0]
  let diff = Infinity
  for (const k of keys) {
    const d = Math.abs(k - requested)
    if (d < diff) {
      diff = d
      best = k
    }
  }
  return best
}

function familyNameFromStack(stack: string): string {
  const first = stack.split(',')[0]?.trim()
  return first ? first.replace(/^["']|["']$/g, '') : 'Inter'
}

export function cssStackFor(fontFamilyId: string): string {
  return fontStack(fontFamilyId)
}

export function availableFontList(): { id: string; label: string; stack: string }[] {
  return FONT_STACKS.map((f) => ({ id: f.id, label: f.label, stack: f.stack }))
}

/* ------------------------------------------------------------------ */
/* Measurement                                                        */
/* ------------------------------------------------------------------ */

export function textWidth(text: string, style: TextStyle, face = resolveFace(style)): number {
  const m = face.metrics
  const scale = style.fontSize / m.unitsPerEm
  let total = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const advance = m.widths[String(code)] ?? (ch === ' ' ? m.defaultAdvance : m.defaultAdvance)
    total += advance * scale + style.letterSpacing
  }
  return total
}

export interface LayoutWord {
  text: string
  /** x offset from the text box origin */
  x: number
  y: number
  width: number
  lineIndex: number
  /** original index across all words */
  index: number
  start?: number
  end?: number
}

export interface LayoutLine {
  words: LayoutWord[]
  width: number
  y: number
  text: string
}

export interface TextLayout {
  lines: LayoutLine[]
  words: LayoutWord[]
  /** block size in canvas px */
  width: number
  height: number
  lineHeightPx: number
  ascentPx: number
  descentPx: number
  fontSizePx: number
  face: FontFace
  /** top-left of the block inside the canvas */
  blockX: number
  blockY: number
}

export function layoutText(
  text: string,
  style: TextStyle,
  layout: TextBoxLayout | undefined,
  canvas: { width: number; height: number },
  words?: CaptionWord[]
): TextLayout {
  const face = resolveFace(style)
  const m = face.metrics
  const fontSize = style.fontSize
  const lineHeightPx = fontSize * (style.lineHeight || 1.2)
  const ascentPx = (m.ascender / m.unitsPerEm) * fontSize
  const descentPx = Math.abs(m.descender / m.unitsPerEm) * fontSize
  const maxWidthPct = layout?.maxWidthPct ?? 80
  const maxWidth = (canvas.width * maxWidthPct) / 100

  const raw = (style.uppercase ? text.toUpperCase() : text).replace(/\s+/g, ' ').trim()
  const tokens = raw.split(' ').filter(Boolean)
  const spaceWidth = textWidth(' ', style, face) + style.wordSpacing

  const lines: LayoutLine[] = []
  let current: LayoutWord[] = []
  let currentWidth = 0
  let wordIndex = 0
  const pushLine = () => {
    if (!current.length) return
    const lineIndex = lines.length
    const lineWidth = currentWidth
    // Horizontal alignment inside the box.
    let startX = 0
    if (style.align === 'center') startX = Math.max(0, (maxWidth - lineWidth) / 2)
    else if (style.align === 'right') startX = Math.max(0, maxWidth - lineWidth)
    const y = lines.length * lineHeightPx
    current.forEach((w) => {
      w.x += startX
      w.y = y
      w.lineIndex = lineIndex
    })
    lines.push({
      words: current,
      width: lineWidth,
      y,
      text: current.map((w) => w.text).join(' ')
    })
    current = []
    currentWidth = 0
  }

  for (const token of tokens) {
    const w = textWidth(token, style, face)
    const extra = current.length ? spaceWidth : 0
    if (current.length && currentWidth + extra + w > maxWidth) pushLine()
    const word: LayoutWord = {
      text: token,
      x: current.length ? currentWidth + spaceWidth : 0,
      y: 0,
      width: w,
      lineIndex: lines.length,
      index: wordIndex
    }
    const timing = words?.[wordIndex]
    if (timing) {
      word.start = timing.start
      word.end = timing.end
    }
    current.push(word)
    currentWidth = word.x + w
    wordIndex++
  }
  pushLine()

  const blockWidth = Math.max(1, ...lines.map((l) => l.width))
  const blockHeight = Math.max(lineHeightPx, lines.length * lineHeightPx)

  // Position inside the canvas using the anchor + normalised x/y.
  const anchor = layout?.anchor ?? 'bottom'
  const cx = (layout?.x ?? 0.5) * canvas.width
  const cy = (layout?.y ?? 0.86) * canvas.height
  let blockX = cx - blockWidth / 2
  let blockY = cy - blockHeight / 2
  if (anchor.startsWith('top')) blockY = cy
  if (anchor.startsWith('bottom')) blockY = cy - blockHeight
  if (anchor === 'left') {
    blockX = cx
    blockY = cy - blockHeight / 2
  }
  if (anchor === 'right') {
    blockX = cx - blockWidth
    blockY = cy - blockHeight / 2
  }
  if (anchor === 'topLeft') blockX = cx
  if (anchor === 'topRight') blockX = cx - blockWidth
  if (anchor === 'bottomLeft') blockX = cx
  if (anchor === 'bottomRight') blockX = cx - blockWidth

  return {
    lines,
    words: lines.flatMap((l) => l.words),
    width: blockWidth,
    height: blockHeight,
    lineHeightPx,
    ascentPx,
    descentPx,
    fontSizePx: fontSize,
    face,
    blockX,
    blockY
  }
}

/** Baseline y offset inside a line box, matching CSS half-leading. */
export function baselineInLine(layout: TextLayout, style: TextStyle): number {
  const leading = layout.lineHeightPx - (layout.ascentPx + layout.descentPx)
  return leading / 2 + layout.ascentPx
}

/* ------------------------------------------------------------------ */
/* Animation state                                                    */
/* ------------------------------------------------------------------ */

/**
 * Visual state of a text/caption clip.
 *
 * The model is intentionally limited to what BOTH renderers produce exactly:
 *  - a block-level alpha ramp (ffmpeg `fade=alpha`),
 *  - a vertical offset that is a pure function of time (ffmpeg `y=` expression),
 *  - hard per-word visibility windows (ffmpeg `enable=`),
 *  - a karaoke colour switch at each word's start (two drawtext passes).
 */
export interface TextAnimationState {
  /** whole-block opacity 0..1 */
  blockOpacity: number
  /** vertical offset in px (negative = up) */
  offsetY: number
  /** per-word visibility (hard) */
  wordVisible: boolean[]
  /** per-word highlighted (karaoke colour) */
  wordHighlight: boolean[]
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3)
}

export function easeOutBack(t: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  const x = Math.max(0, Math.min(1, t))
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2)
}

/** Normalised progress (0..1) of an animation at a clip-local time. */
export function animationProgress(durationMs: number, elapsedMs: number): number {
  if (durationMs <= 0) return 1
  return Math.max(0, Math.min(1, elapsedMs / durationMs))
}

/**
 * Vertical offset (px) for slide-type animations as a pure function of time.
 * The exporter evaluates the same curve and samples it into keyframes-of-sorts
 * on the drawtext `y=` expression, so motion matches frame for frame.
 */
export function offsetCurve(animation: string | undefined, durationMs: number, elapsedMs: number): number {
  const p = animationProgress(durationMs, elapsedMs)
  switch (animation) {
    case 'slideUp':
      return (1 - easeOutCubic(p)) * 44
    case 'pop':
      return (1 - easeOutBack(p)) * 14
    case 'bounce': {
      const eased = easeOutBack(p)
      return (1 - eased) * 40
    }
    case 'reveal':
      return (1 - easeOutCubic(p)) * 26
    default:
      return 0
  }
}

export function textAnimationState(
  layout: TextLayout,
  animation: string | undefined,
  durationMs: number,
  elapsed: number,
  totalDuration: number
): TextAnimationState {
  const count = layout.words.length
  const p = animationProgress(durationMs, elapsed)
  const spoken = layout.words.filter((w) => (w.start ?? 0) <= elapsed).length
  const wordVisible = new Array(count).fill(true)
  const wordHighlight = new Array(count).fill(false)

  switch (animation) {
    case 'fade':
      return { blockOpacity: easeOutCubic(p), offsetY: 0, wordVisible, wordHighlight }
    case 'slideUp':
    case 'pop':
    case 'bounce':
    case 'reveal':
      return { blockOpacity: Math.min(1, easeOutCubic(Math.min(1, p * 1.6))), offsetY: offsetCurve(animation, durationMs, elapsed), wordVisible, wordHighlight }
    case 'wipe':
    case 'typewriter':
    case 'letterByLetter':
    case 'wordByWord': {
      // One word at a time: reveal on word boundaries spread across the clip.
      const perWord = totalDuration / Math.max(1, count)
      const revealed = Math.min(count, Math.max(1, Math.floor(elapsed / Math.max(24, perWord)) + 1))
      for (let i = revealed; i < count; i++) wordVisible[i] = false
      if (animation === 'wordByWord') for (let i = 0; i < count; i++) wordVisible[i] = i === revealed - 1
      return { blockOpacity: 1, offsetY: 0, wordVisible, wordHighlight }
    }
    case 'karaoke':
      for (let i = 0; i < count; i++) wordHighlight[i] = i < spoken
      return { blockOpacity: 1, offsetY: 0, wordVisible, wordHighlight }
    case 'none':
    case undefined:
    default:
      return { blockOpacity: 1, offsetY: 0, wordVisible, wordHighlight }
  }
}

/** Words that should be drawn in the highlight colour. */
export function highlightedWordIndices(
  layout: TextLayout,
  mode: 'none' | 'keyword' | 'spoken',
  elapsed: number,
  keywordIndices: number[]
): Set<number> {
  if (mode === 'none') return new Set()
  if (mode === 'keyword') return new Set(keywordIndices)
  const spoken = new Set<number>()
  layout.words.forEach((w, i) => {
    if ((w.end ?? 0) <= elapsed) spoken.add(i)
    else if ((w.start ?? 0) <= elapsed && (w.end ?? Infinity) >= elapsed) spoken.add(i)
  })
  return spoken
}

