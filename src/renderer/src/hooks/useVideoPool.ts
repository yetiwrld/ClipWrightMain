/**
 * Video pool for the preview monitor.
 *
 * One hidden <video> element per asset is kept alive so scrubbing is instant and
 * playback can run continuously. Elements are only created for assets actually
 * used on the timeline, and are dropped when the project changes.
 */
import { useEffect, useRef } from 'react'
import type { MediaLookup } from '../lib/preview-canvas'
import { mediaUrl } from '../lib/api'
import type { Project } from '@shared/types'

interface PoolEntry {
  video: HTMLVideoElement
  ready: boolean
  lastSeek: number
}

export interface VideoPool {
  lookup: MediaLookup
  sync: (project: Project, timeMs: number, playing: boolean) => void
  pauseAll: () => void
  dispose: () => void
}

export function createVideoPool(onReady?: () => void): VideoPool {
  const videos = new Map<string, PoolEntry>()
  const images = new Map<string, HTMLImageElement>()
  const projectRef: { current: Project | null } = { current: null }

  function ensureVideo(assetId: string): PoolEntry | null {
    const project = projectRef.current
    const asset = project?.assets.find((a) => a.id === assetId)
    if (!asset || asset.kind !== 'video') return null
    const existing = videos.get(assetId)
    if (existing) return existing
    const video = document.createElement('video')
    video.src = mediaUrl(asset.path)
    video.preload = 'auto'
    video.muted = false
    video.playsInline = true
    video.crossOrigin = 'anonymous'
    video.style.position = 'absolute'
    video.style.width = '1px'
    video.style.height = '1px'
    video.style.opacity = '0'
    video.style.pointerEvents = 'none'
    video.addEventListener('loadeddata', () => {
      const entry = videos.get(assetId)
      if (entry) entry.ready = true
      onReady?.()
    })
    video.addEventListener('seeked', () => onReady?.())
    document.body.appendChild(video)
    const entry: PoolEntry = { video, ready: false, lastSeek: 0 }
    videos.set(assetId, entry)
    return entry
  }

  function ensureImage(assetId: string): HTMLImageElement | null {
    const project = projectRef.current
    const asset = project?.assets.find((a) => a.id === assetId)
    if (!asset || asset.kind !== 'image') return null
    const existing = images.get(assetId)
    if (existing) return existing
    const img = new Image()
    img.src = mediaUrl(asset.path)
    img.onload = () => onReady?.()
    images.set(assetId, img)
    return img
  }

  const lookup: MediaLookup = {
    video(assetId, sourceTimeMs) {
      const entry = ensureVideo(assetId)
      return entry?.ready ? entry.video : null
    },
    image(assetId) {
      const img = ensureImage(assetId)
      return img && img.complete && img.naturalWidth ? img : null
    }
  }

  /** Align each video element with the timeline position. */
  function sync(project: Project, timeMs: number, playing: boolean): void {
    projectRef.current = project
    const active = new Set<string>()
    for (const clip of project.clips) {
      if (!clip.assetId || clip.kind !== 'video') continue
      // Inclusive on both edges: a clip that starts exactly at the playhead, or
      // ends exactly at it, still needs its element alive.
      if (clip.start > timeMs || clip.start + clip.duration < timeMs) continue
      const asset = project.assets.find((a) => a.id === clip.assetId)
      if (!asset || asset.kind !== 'video') continue
      active.add(clip.assetId)
      const entry = ensureVideo(clip.assetId)
      if (!entry) continue
      const speed = Math.max(0.25, Math.min(4, clip.effects.find((e) => e.type === 'speed' && e.enabled)?.value ?? 1))
      const target = (clip.sourceIn + (timeMs - clip.start) * speed) / 1000
      entry.video.playbackRate = playing ? speed : 1
      const drift = Math.abs(entry.video.currentTime - target)
      if (playing) {
        entry.video.muted = clip.audio.muted
        entry.video.volume = Math.min(1, Math.max(0, clip.audio.volume))
        if (entry.video.paused) void entry.video.play().catch(() => undefined)
        // Only correct large drift so playback stays smooth.
        if (drift > 0.22) entry.video.currentTime = target
      } else {
        entry.video.pause()
        if (drift > 0.6 || (!entry.video.seeking && drift > 0.04)) {
          entry.video.currentTime = target
        }
      }
    }
    // Pause anything not on screen.
    for (const [assetId, entry] of videos) {
      if (active.has(assetId)) continue
      if (!entry.video.paused) entry.video.pause()
    }
  }

  function pauseAll(): void {
    for (const entry of videos.values()) entry.video.pause()
  }

  function dispose(): void {
    for (const entry of videos.values()) {
      entry.video.pause()
      entry.video.removeAttribute('src')
      entry.video.load()
      entry.video.remove()
    }
    videos.clear()
    images.clear()
  }

  return { lookup, sync, pauseAll, dispose }
}

/** React binding that keeps a pool in sync with the editor state. */
export function useVideoPool(
  project: Project | null,
  timeMs: number,
  playing: boolean,
  onFrame: () => void
) {
  const poolRef = useRef<VideoPool | null>(null)
  if (!poolRef.current) poolRef.current = createVideoPool(onFrame)

  useEffect(() => {
    const pool = poolRef.current!
    if (!project) {
      pool.pauseAll()
      return
    }
    pool.sync(project, timeMs, playing)
  }, [project, timeMs, playing])

  useEffect(() => {
    const pool = poolRef.current
    return () => {
      pool?.dispose()
      poolRef.current = null
    }
  }, [])

  return poolRef.current
}
