/** Typed access to the preload bridge + browser fallback for UI development. */
import type { ClipwrightApi } from '../../../preload/index'

declare global {
  interface Window {
    clipwright: ClipwrightApi
  }
}

export const api: ClipwrightApi = window.clipwright

export function hasDesktopBridge(): boolean {
  return typeof window !== 'undefined' && Boolean(window.clipwright)
}

export function mediaUrl(filePath: string | undefined): string {
  if (!filePath) return ''
  if (/^(https?|data|blob|clipwright-media):/.test(filePath)) return filePath
  return api?.mediaUrl ? api.mediaUrl(filePath) : filePath
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  // IPC errors arrive as plain objects with a message field.
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message)
  return String(error)
}
