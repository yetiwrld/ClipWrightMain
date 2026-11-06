/** Time helpers — all values are milliseconds unless stated. */

export const FPS_FALLBACK = 30

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function msToFrames(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps)
}

export function framesToMs(frames: number, fps: number): number {
  return (frames / fps) * 1000
}

/** Snap a time value to the nearest whole frame boundary. */
export function snapToFrame(ms: number, fps: number): number {
  return framesToMs(Math.round(msToFrames(ms, fps)), fps)
}

/** Snap to the nearest frame without losing sub-frame precision. */
export function ceilToFrame(ms: number, fps: number): number {
  return framesToMs(Math.ceil(msToFrames(ms, fps)), fps)
}

export function formatTimecode(ms: number, fps = 30): string {
  const safe = Math.max(0, ms)
  const totalFrames = Math.floor((safe / 1000) * fps + 1e-6)
  const frames = totalFrames % Math.round(fps)
  const totalSeconds = Math.floor(totalFrames / Math.round(fps))
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`
}

/** Short clock format used in lists: 1:23.4 or 1:02:03 */
export function formatClock(ms: number, withTenths = false): string {
  const safe = Math.max(0, ms)
  const totalSeconds = Math.floor(safe / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor(totalSeconds / 60) % 60
  const seconds = totalSeconds % 60
  const tenths = Math.floor((safe % 1000) / 100)
  const core =
    hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      : `${minutes}:${String(seconds).padStart(2, '0')}`
  return withTenths ? `${core}.${tenths}` : core
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest ? `${m}m ${rest}s` : `${m}m`
}

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}
