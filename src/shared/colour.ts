/** Colour helpers shared by the preview renderer and the ffmpeg filter builder. */

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const NAMED: Record<string, Rgba> = {
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  orange: { r: 255, g: 165, b: 0, a: 1 }
}

/**
 * Parse CSS-ish colours: #rgb, #rrggbb, #rrggbbaa, rgb(), rgba(), and a few
 * names. Returns null when the value cannot be understood.
 */
export function parseColour(input: string | undefined): Rgba | null {
  if (!input) return null
  const value = input.trim().toLowerCase()
  if (NAMED[value]) return { ...NAMED[value] }
  if (value === 'none') return { r: 0, g: 0, b: 0, a: 0 }

  if (value.startsWith('#')) {
    const hex = value.slice(1)
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16)
      const g = parseInt(hex[1] + hex[1], 16)
      const b = parseInt(hex[2] + hex[2], 16)
      const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1
      return isNaN(r + g + b) ? null : { r, g, b, a }
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16)
      const g = parseInt(hex.slice(2, 4), 16)
      const b = parseInt(hex.slice(4, 6), 16)
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
      return isNaN(r + g + b) ? null : { r, g, b, a }
    }
    return null
  }

  const rgbMatch = /^rgba?\(([^)]+)\)$/.exec(value)
  if (rgbMatch) {
    const parts = rgbMatch[1].split(/[,/\s]+/).filter(Boolean).map(Number)
    if (parts.length >= 3) {
      return {
        r: clamp255(parts[0]),
        g: clamp255(parts[1]),
        b: clamp255(parts[2]),
        a: parts.length > 3 ? Math.max(0, Math.min(1, parts[3])) : 1
      }
    }
  }
  return null
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

/** ffmpeg colour syntax: 0xRRGGBB or 0xRRGGBB@alpha */
export function toFfmpegColour(input: string | undefined, fallback = '0x000000'): string {
  const rgba = parseColour(input)
  if (!rgba) return fallback
  const hex = `0x${hex2(rgba.r)}${hex2(rgba.g)}${hex2(rgba.b)}`
  if (rgba.a >= 0.999) return hex
  return `${hex}@${rgba.a.toFixed(3)}`
}

export function toFfmpegColourWithAlpha(input: string | undefined, alpha: number, fallback = '0x000000'): string {
  const rgba = parseColour(input) ?? { r: 0, g: 0, b: 0, a: 1 }
  const a = Math.max(0, Math.min(1, rgba.a * alpha))
  return `${toFfmpegColour(input, fallback)}@${a.toFixed(3)}`
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0').toUpperCase()
}

export function toCssColour(input: string | undefined, fallback = '#000000'): string {
  const rgba = parseColour(input)
  if (!rgba) return fallback
  if (rgba.a >= 0.999) return `#${hex2(rgba.r)}${hex2(rgba.g)}${hex2(rgba.b)}`
  return `rgba(${rgba.r},${rgba.g},${rgba.b},${rgba.a.toFixed(3)})`
}

export function withAlpha(input: string, alpha: number): string {
  const rgba = parseColour(input)
  if (!rgba) return input
  return `rgba(${rgba.r},${rgba.g},${rgba.b},${(rgba.a * alpha).toFixed(3)})`
}

/** Blend two colours (t=0 -> a, t=1 -> b). */
export function mix(a: string, b: string, t: number): string {
  const ca = parseColour(a)
  const cb = parseColour(b)
  if (!ca || !cb) return a
  const lerp = (x: number, y: number) => Math.round(x + (y - x) * t)
  return `rgba(${lerp(ca.r, cb.r)},${lerp(ca.g, cb.g)},${lerp(ca.b, cb.b)},${(ca.a + (cb.a - ca.a) * t).toFixed(3)})`
}
