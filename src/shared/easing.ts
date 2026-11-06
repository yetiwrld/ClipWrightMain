import type { Easing, EasingKind } from './types'

/** Normalised easing functions: input and output are 0..1. */
export function easeWith(kind: EasingKind, t: number): number {
  const x = Math.min(1, Math.max(0, t))
  switch (kind) {
    case 'linear':
      return x
    case 'easeIn':
      return x * x * x
    case 'easeOut':
      return 1 - Math.pow(1 - x, 3)
    case 'easeInOut':
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
    case 'step':
      return x < 1 ? 0 : 1
    case 'bezier':
      return x
    default:
      return x
  }
}

/**
 * Cubic bezier solver (Newton-Raphson with bisection fallback), matching the
 * CSS `cubic-bezier(x1,y1,x2,y2)` definition so the renderer and the exporter
 * produce pixel-identical animation.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by

  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx

  return (t: number) => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    let guess = t
    for (let i = 0; i < 8; i++) {
      const x = sampleX(guess) - t
      if (Math.abs(x) < 1e-6) return sampleY(guess)
      const d = sampleDX(guess)
      if (Math.abs(d) < 1e-6) break
      guess -= x / d
    }
    let lo = 0
    let hi = 1
    guess = t
    for (let i = 0; i < 24; i++) {
      const x = sampleX(guess)
      if (Math.abs(x - t) < 1e-6) break
      if (x < t) lo = guess
      else hi = guess
      guess = (lo + hi) / 2
    }
    return sampleY(guess)
  }
}

export function applyEasing(easing: Easing | undefined, t: number): number {
  if (!easing) return easeWith('linear', t)
  if (easing.kind === 'bezier' && easing.cp) {
    const [x1, y1, x2, y2] = easing.cp
    return cubicBezier(x1, y1, x2, y2)(t)
  }
  return easeWith(easing.kind, t)
}

export const EASING_OPTIONS: { id: EasingKind; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'easeIn', label: 'Ease in' },
  { id: 'easeOut', label: 'Ease out' },
  { id: 'easeInOut', label: 'Ease in & out' },
  { id: 'step', label: 'Step (hold)' },
  { id: 'bezier', label: 'Custom curve' }
]
