/**
 * FFmpeg filter primitives for the export renderer.
 *
 * Every visual property of a clip maps to an explicit filter, which is what makes
 * the export a true render of the timeline rather than a screen capture.
 */
import type { Effect } from '@shared/types'

/** Build the effect chain for a clip (colour + blur + vignette, in filter order). */
export function effectChain(effects: Effect[]): string[] {
  const chain: string[] = []
  const get = (type: string) => effects.find((e) => e.type === type && e.enabled)
  const eqParts: string[] = []
  const brightness = get('brightness')
  const contrast = get('contrast')
  const saturation = get('saturation')
  const exposure = get('exposure')
  if (brightness) eqParts.push(`brightness=${(brightness.value * 0.5).toFixed(3)}`)
  if (contrast) eqParts.push(`contrast=${contrast.value.toFixed(3)}`)
  if (saturation) eqParts.push(`saturation=${saturation.value.toFixed(3)}`)
  if (exposure) {
    // Exposure expressed in stops -> multiply by 2^stops.
    const factor = Math.pow(2, exposure.value)
    eqParts.push(`brightness=${((factor - 1) * 0.35).toFixed(3)}`)
  }
  if (eqParts.length) chain.push(`eq=${eqParts.join(':')}`)

  const temperature = get('temperature')
  const tint = get('tint')
  if (temperature || tint) {
    // Warm/cool shift via per-channel balance; tint shifts green/magenta.
    const warmth = temperature?.value ?? 0
    const tintValue = tint?.value ?? 0
    const r = 1 + warmth * 0.22 + tintValue * 0.06
    const g = 1 - Math.abs(warmth) * 0.04 - tintValue * 0.12
    const b = 1 - warmth * 0.2 + tintValue * 0.06
    chain.push(
      `colorbalance=rs=${((r - 1) * 0.5).toFixed(3)}:gs=${((g - 1) * 0.5).toFixed(3)}:bs=${((b - 1) * 0.5).toFixed(
        3
      )}:rm=${((r - 1) * 0.4).toFixed(3)}:gm=${((g - 1) * 0.4).toFixed(3)}:bm=${((b - 1) * 0.4).toFixed(
        3
      )}`
    )
  }

  const sharpen = get('sharpen')
  if (sharpen && sharpen.value > 0.01) {
    const amount = Math.min(1.5, sharpen.value * 0.75)
    chain.push(`unsharp=5:5:${amount.toFixed(2)}:5:5:0`)
  }

  const blur = get('blur')
  if (blur && blur.value > 0.05) {
    const sigma = Math.min(20, blur.value)
    // boxblur radius must be > 0 and scale with the requested sigma.
    const radius = Math.max(1, Math.round(sigma / 2))
    chain.push(`gblur=sigma=${sigma.toFixed(2)}:steps=${Math.min(6, Math.max(2, radius / 2)).toFixed(0)}`)
  }

  const vignette = get('vignette')
  if (vignette && vignette.value > 0.01) {
    chain.push(`vignette=angle=${(vignette.value * 1.2).toFixed(3)}`)
  }
  return chain
}

export interface PlaceSpec {
  /** canvas size */
  width: number
  height: number
  /** content size after scaling */
  contentWidth: number
  contentHeight: number
  /** top-left placement on the canvas */
  x: number
  y: number
  /** crop values 0..1 from the edges of the content */
  crop: { l: number; r: number; t: number; b: number }
  rotation: number
  opacity: number
  /** fit mode: contain (letterbox-free scale) or cover (fill the canvas) */
  fit: 'contain' | 'cover'
}

/**
 * Scale + crop + rotate + pad a decoded frame into a full-size transparent
 * layer ready for overlaying on the canvas.
 */
export function placeFilter(spec: PlaceSpec, rotationExpr?: string): string {
  const parts: string[] = []
  const cw = Math.max(2, Math.round(spec.contentWidth * (1 - spec.crop.l - spec.crop.r)))
  const ch = Math.max(2, Math.round(spec.contentHeight * (1 - spec.crop.t - spec.crop.b)))
  parts.push(`crop=${even(cw)}:${even(ch)}:${Math.round(spec.contentWidth * spec.crop.l)}:${Math.round(
    spec.contentHeight * spec.crop.t
  )}`)
  if (Math.abs(spec.rotation) > 0.01) {
    parts.push(`rotate=${rotationExpr ? `a=${rotationExpr}` : (spec.rotation * Math.PI) / 180}:c=none`)
  }
  parts.push(...padToCanvas(spec.width, spec.height, cw, ch, spec.x, spec.y))
  parts.push(`format=rgba`)
  if (spec.opacity < 0.999) parts.push(`colorchannelmixer=aa=${spec.opacity.toFixed(3)}`)
  return parts.join(',')
}

/**
 * Position a scaled layer on the canvas as a transparent full-canvas frame.
 *
 * The old implementation always emitted `pad=canvas:x:y`, which only works when
 * the content is *smaller* than the canvas and sits at a non-negative offset.
 * Auto-framing a 16:9 source into a 9:16 clip scales the picture to "cover", so
 * the content is wider than the canvas and x goes negative — `pad` cannot shrink
 * a frame, so ffmpeg rejected the graph ("Failed to configure input pad" /
 * "Could not open encoder before EOF") and the whole export failed. This is why
 * generating a clip from a landscape video could not render.
 *
 * The fix pads only on the sides that need room (never with a negative offset)
 * and then crops the canvas-sized window out of it, whether the layer is larger
 * or smaller than the canvas.
 */
export function padToCanvas(
  canvasW: number,
  canvasH: number,
  contentW: number,
  contentH: number,
  x: number,
  y: number
): string[] {
  const floorX = Math.floor(x)
  const floorY = Math.floor(y)
  // Space that has to be added before the content when it starts left of / above
  // the canvas (the "cover" case). Everything else keeps its own offset.
  const left = Math.max(0, -floorX)
  const top = Math.max(0, -floorY)
  const width = Math.max(canvasW, left + Math.ceil(contentW))
  const height = Math.max(canvasH, top + Math.ceil(contentH))
  // After padding, the content sits at (x + left, y + top) inside the padded
  // frame, and the padded frame's origin is the canvas origin.
  const offsetX = Math.max(0, floorX + left)
  const offsetY = Math.max(0, floorY + top)
  const parts = [
    `pad=${even(width)}:${even(height)}:${even(offsetX)}:${even(offsetY)}:color=black@0`,
    // Crop is a no-op when the content already fills the canvas exactly.
    `crop=${even(canvasW)}:${even(canvasH)}:0:0`
  ]
  return parts
}

export function even(n: number): number {
  const v = Math.round(n)
  return v % 2 === 0 ? v : v + 1
}

/** Compute content size + placement for a source frame on the canvas. */
export function computePlacement(
  sourceWidth: number,
  sourceHeight: number,
  transform: { x: number; y: number; scaleX: number; scaleY: number },
  canvas: { width: number; height: number },
  fit: 'contain' | 'cover' = 'contain'
): { contentWidth: number; contentHeight: number; x: number; y: number } {
  const scaleBase =
    fit === 'cover'
      ? Math.max(canvas.width / sourceWidth, canvas.height / sourceHeight)
      : Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight)
  const w = sourceWidth * scaleBase * transform.scaleX
  const h = sourceHeight * scaleBase * transform.scaleY
  const centreX = transform.x * canvas.width
  const centreY = transform.y * canvas.height
  return {
    contentWidth: w,
    contentHeight: h,
    x: centreX - w / 2,
    y: centreY - h / 2
  }
}

/** xfade transition name mapping. */
export function xfadeName(type: string): string {
  switch (type) {
    case 'crossfade':
      return 'fade'
    case 'dissolve':
      return 'dissolve'
    case 'fadeToBlack':
      return 'fadeblack'
    case 'fadeFromBlack':
      return 'fadeblack'
    case 'wipeLeft':
      return 'wipeleft'
    case 'wipeRight':
      return 'wiperight'
    case 'slideLeft':
      return 'slideleft'
    case 'slideUp':
      return 'slideup'
    case 'zoomIn':
      return 'zoomin'
    case 'zoomOut':
      return 'smoothleft'
    default:
      return 'fade'
  }
}

/** Validate that a filtergraph is syntactically plausible before running ffmpeg. */
export function validateGraph(graph: string): { ok: boolean; problems: string[] } {
  const problems: string[] = []
  const opens = (graph.match(/\[/g) ?? []).length
  const closes = (graph.match(/\]/g) ?? []).length
  if (opens !== closes) problems.push(`Unbalanced label brackets (${opens} vs ${closes})`)
  if (/;;/.test(graph)) problems.push('Empty filter step detected')
  /*** detect a filter token with no name */
  for (const step of graph.split(';')) {
    const cleaned = step.replace(/\[[^\]]*\]/g, '')
    if (!cleaned.trim()) continue
    for (const filter of splitFilters(cleaned)) {
      const name = filter.split('=')[0]
      if (!/^[a-z0-9_]+$/i.test(name)) problems.push(`Invalid filter token: ${filter.slice(0, 40)}`)
    }
  }
  return { ok: problems.length === 0, problems }
}

function splitFilters(chain: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of chain) {
    if (ch === "'") depth = depth === 0 ? 1 : 0
    if (ch === ',' && depth === 0) {
      out.push(current)
      current = ''
    } else current += ch
  }
  if (current) out.push(current)
  return out
}
