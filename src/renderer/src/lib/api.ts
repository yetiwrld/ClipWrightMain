/** Typed access to the preload bridge + browser fallback for UI development. */
import type { ClipwrightApi } from '../../../preload/index'

declare global {
  interface Window {
    clipwright: ClipwrightApi
  }
}

const bridge = (): ClipwrightApi => window.clipwright

/**
 * The bridge is read lazily on every call. Preload injects `clipwright` before
 * the renderer bundle runs, but resolving at call time keeps the module safe in
 * tests and in the plain-browser shell without changing behaviour in Electron.
 */
export const api: ClipwrightApi = new Proxy({} as ClipwrightApi, {
  get(_target, namespace: string) {
    const target = bridge()
    if (!target) throw new Error('Clipwright desktop bridge is unavailable. Start the app through Electron.')
    const value = (target as unknown as Record<string, unknown>)[namespace]
    return value
  }
})

export function hasDesktopBridge(): boolean {
  return typeof window !== 'undefined' && Boolean(window.clipwright)
}

export function mediaUrl(filePath: string | undefined): string {
  if (!filePath) return ''
  if (/^(https?|data|blob|clipwright-media):/.test(filePath)) return filePath
  const target = bridge()
  return target?.mediaUrl ? target.mediaUrl(filePath) : filePath
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  // IPC errors arrive as plain objects with a message field.
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message)
  return String(error)
}
