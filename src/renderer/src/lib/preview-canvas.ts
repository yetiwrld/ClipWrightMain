/**
 * Preview renderer (canvas 2D).
 *
 * Draws the same scene description the exporter consumes, using the same layout
 * engine — so what you see is what is rendered. Text is laid out with exact
 * metrics and the animation state comes from the shared engine.
 */
import { buildScene, type Scene, type SceneLayer } from '@shared/scene'
import { parseColour, toCssColour, withAlpha } from '@shared/colour'
import {
  baselineInLine,
  layoutText,
  textAnimationState,
  cssStackFor
} from '@shared/text-layout'
import type { Project } from '@shared/types'

export interface DrawOptions {
  project: Project
  time: number
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  media: MediaLookup
  showSafeAreas: boolean
  selectedIds: string[]
}

export interface MediaLookup {
  /** Returns the drawable element for an asset, or null while loading. */
  video(assetId: string, sourceTimeMs: number): HTMLVideoElement | null
  image(assetId: string): HTMLImageElement | null
}

const FONT_CSS_CACHE = new Map<string, string>()

function cssFont(style: { fontFamily: string; fontSize: number; fontWeight: number; italic?: boolean }): string {
  const key = `${style.fontFamily}|${style.fontWeight}|${style.italic}`
  let stack = FONT_CSS_CACHE.get(key)
  if (!stack) {
    stack = cssStackFor(style.fontFamily)
    FONT_CSS_CACHE.set(key, stack)
  }
  return `${style.italic ? 'italic ' : ''}${style.fontWeight} ${style.fontSize}px ${stack}`
}

export function drawScene(opts: DrawOptions): Scene {
  const { project, time, ctx, width, height, media, showSafeAreas, selectedIds } = opts
  const scene = buildScene(project, time)
  const sx = width / project.canvas.width
  const sy = height / project.canvas.height

  ctx.save()
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = toCssColour(project.canvas.backgroundColor, '#000000')
  ctx.fillRect(0, 0, width, height)
  ctx.scale(sx, sy)

  for (const layer of scene.layers) {
    if (layer.hidden || layer.opacity <= 0.003) continue
    if (layer.kind === 'text' || layer.kind === 'caption') {
      drawTextLayer(ctx, layer, project, sx)
      continue
    }
    drawMediaLayer(ctx, layer, project, media, width / sx, height / sy)
  }

  if (showSafeAreas) drawSafeAreas(ctx, project.canvas.width, project.canvas.height)
  if (selectedIds.length) drawSelectionOutlines(ctx, scene, project, selectedIds)

  ctx.restore()
  return scene
}

function drawMediaLayer(
  ctx: CanvasRenderingContext2D,
  layer: SceneLayer,
  project: Project,
  media: MediaLookup,
  canvasW: number,
  canvasH: number
): void {
  if (!layer.assetId) return
  const asset = project.assets.find((a) => a.id === layer.assetId)
  let source: HTMLVideoElement | HTMLImageElement | null = null
  if (asset?.kind === 'image') {
    source = media.image(layer.assetId)
  } else {
    source = media.video(layer.assetId, layer.sourceTime)
  }
  if (!source) return
  const sw = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth
  const sh = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight
  if (!sw || !sh) return

  ctx.save()
  ctx.globalAlpha = Math.min(1, Math.max(0, layer.opacity))
  applyColourEffects(ctx, layer)

  const t = layer.transform
  const centreX = t.x * canvasW
  const centreY = t.y * canvasH
  ctx.translate(centreX, centreY)
  if (t.rotation) ctx.rotate((t.rotation * Math.PI) / 180)

  // "contain" fit then user scale (matches computePlacement in the exporter).
  const base = Math.min(canvasW / sw, canvasH / sh)
  const dw = sw * base * t.scaleX
  const dh = sh * base * t.scaleY

  const cropL = t.cropL * dw
  const cropR = t.cropR * dw
  const cropT = t.cropT * dh
  const cropB = t.cropB * dh
  const visibleW = Math.max(1, dw - cropL - cropR)
  const visibleH = Math.max(1, dh - cropT - cropB)

  ctx.drawImage(
    source,
    (cropL / dw) * sw,
    (cropT / dh) * sh,
    (visibleW / dw) * sw,
    (visibleH / dh) * sh,
    -dw / 2 + cropL,
    -dh / 2 + cropT,
    visibleW,
    visibleH
  )
  ctx.restore()
}

function applyColourEffects(ctx: CanvasRenderingContext2D, layer: SceneLayer): void {
  const filters: string[] = []
  for (const effect of layer.effects) {
    switch (effect.type) {
      case 'brightness':
        filters.push(`brightness(${1 + effect.value * 0.5})`)
        break
      case 'contrast':
        filters.push(`contrast(${effect.value})`)
        break
      case 'saturation':
        filters.push(`saturate(${effect.value})`)
        break
      case 'exposure':
        filters.push(`brightness(${Math.pow(2, effect.value * 0.6)})`)
        break
      case 'blur':
        filters.push(`blur(${effect.value}px)`)
        break
      case 'temperature':
        filters.push(effect.value >= 0 ? `sepia(${effect.value * 0.35})` : `hue-rotate(${effect.value * -18}deg)`)
        break
      case 'tint':
        filters.push(`hue-rotate(${effect.value * 30}deg)`)
        break
      case 'sharpen':
      case 'vignette':
        break
      default:
        break
    }
  }
  ctx.filter = filters.length ? filters.join(' ') : 'none'
}

function drawTextLayer(
  ctx: CanvasRenderingContext2D,
  layer: SceneLayer,
  project: Project,
  sx: number
): void {
  const style = layer.style
  if (!style || !layer.text) return
  const canvas = { width: project.canvas.width, height: project.canvas.height }
  const layout = layoutText(layer.text, style, layer.layout, canvas, layer.words)
  const anim = textAnimationState(
    layout,
    layer.animationName,
    layer.animationDurationMs,
    Math.max(0, layer.localTime),
    layer.durationMs
  )
  const blockY = layout.blockY - anim.offsetY
  const baseline = baselineInLine(layout, style)

  ctx.save()
  // Text layers can also be moved/scaled by the clip transform.
  const t = layer.transform
  ctx.translate(t.x * canvas.width, t.y * canvas.height)
  ctx.rotate((t.rotation * Math.PI) / 180)
  ctx.scale(t.scaleX, t.scaleY)
  ctx.translate(-t.x * canvas.width, -t.y * canvas.height)
  ctx.globalAlpha = Math.min(1, Math.max(0, layer.opacity * anim.blockOpacity))

  // Background plate.
  const bg = parseColour(style.backgroundColor)
  if (bg && bg.a > 0.01) {
    const pad = style.backgroundPadding
    roundRect(
      ctx,
      layout.blockX - pad,
      blockY - pad,
      layout.width + pad * 2,
      layout.height + pad * 2,
      style.borderRadius
    )
    ctx.fillStyle = toCssColour(style.backgroundColor)
    ctx.fill()
  }

  layout.words.forEach((word, index) => {
    if (!anim.wordVisible[index]) return
    const highlighted = anim.wordHighlight[index]
    const colour = highlighted ? style.highlightColor : style.color
    ctx.font = cssFont(style)
    ctx.fillStyle = toCssColour(colour)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    if (style.shadowBlur > 0 || style.shadowOffsetY) {
      ctx.shadowColor = withAlpha(style.shadowColor, 0.85)
      ctx.shadowBlur = style.shadowBlur * (1 / Math.max(0.1, sx))
      ctx.shadowOffsetX = style.shadowOffsetX
      ctx.shadowOffsetY = style.shadowOffsetY
    } else {
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.shadowOffsetX = 0
      ctx.shadowOffsetY = 0
    }
    const x = layout.blockX + word.x
    const y = blockY + word.y + baseline
    if (style.strokeWidth > 0) {
      ctx.strokeStyle = toCssColour(style.strokeColor)
      ctx.lineWidth = style.strokeWidth * 2
      ctx.lineJoin = 'round'
      drawSpaced(ctx, word.text, x, y, style.letterSpacing, (text, cx) => ctx.strokeText(text, cx, y))
    }
    drawSpaced(ctx, word.text, x, y, style.letterSpacing, (text, cx) => ctx.fillText(text, cx, y))
  })
  ctx.restore()
}

/** Draw text honouring letter spacing (canvas has no native tracking). */
function drawSpaced(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  spacing: number,
  draw: (text: string, x: number, y: number) => void
): void {
  if (!spacing) {
    draw(text, x, y)
    return
  }
  let cursor = x
  for (const ch of text) {
    draw(ch, cursor, y)
    cursor += ctx.measureText(ch).width + spacing
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function drawSafeAreas(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.save()
  ctx.strokeStyle = 'rgba(255,255,255,0.16)'
  ctx.lineWidth = 1.5
  ctx.setLineDash([8, 8])
  const inset = Math.min(w, h) * 0.05
  ctx.strokeRect(inset, inset, w - inset * 2, h - inset * 2)
  ctx.setLineDash([])
  ctx.strokeStyle = 'rgba(255,122,24,0.22)'
  ctx.strokeRect(w / 2 - w * 0.05, h / 2 - h * 0.05, w * 0.1, h * 0.1)
  // Title-safe thirds.
  ctx.strokeStyle = 'rgba(255,255,255,0.07)'
  ctx.beginPath()
  for (let i = 1; i < 3; i++) {
    ctx.moveTo((w / 3) * i, 0)
    ctx.lineTo((w / 3) * i, h)
    ctx.moveTo(0, (h / 3) * i)
    ctx.lineTo(w, (h / 3) * i)
  }
  ctx.stroke()
  ctx.restore()
}

function drawSelectionOutlines(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  project: Project,
  selectedIds: string[]
): void {
  const selected = scene.layers.filter((l) => selectedIds.includes(l.id))
  if (!selected.length) return
  ctx.save()
  ctx.strokeStyle = '#FF7A18'
  ctx.lineWidth = 2
  ctx.setLineDash([6, 4])
  for (const layer of selected) {
    const t = layer.transform
    const cx = t.x * project.canvas.width
    const cy = t.y * project.canvas.height
    const w = project.canvas.width * 0.5 * t.scaleX
    const h = project.canvas.height * 0.5 * t.scaleY
    ctx.strokeRect(cx - w / 2, cy - h / 2, w, h)
  }
  ctx.setLineDash([])
  ctx.restore()
}

/** Transform handles drawn as DOM overlays (see PreviewMonitor). */
export function layerBounds(
  layer: SceneLayer,
  canvasW: number,
  canvasH: number
): { x: number; y: number; w: number; h: number } {
  const t = layer.transform
  const w = canvasW * 0.5 * t.scaleX
  const h = canvasH * 0.5 * t.scaleY
  return { x: t.x * canvasW - w / 2, y: t.y * canvasH - h / 2, w, h }
}
