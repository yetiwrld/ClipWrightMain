/**
 * Timeline playback clock.
 *
 * Uses requestAnimationFrame with a wall-clock delta so playback is smooth even
 * when the preview drops frames, and stops at the end of the timeline.
 */
import { useEffect, useRef } from 'react'
import { useEditor } from '../state/editor'

export function usePlayback(enabled = true): void {
  const playing = useEditor((s) => s.playing)
  const setPlaying = useEditor((s) => s.setPlaying)
  const setPlayhead = useEditor((s) => s.setPlayhead)
  const rafRef = useRef<number>(0)
  const lastRef = useRef<number>(0)

  useEffect(() => {
    if (!playing || !enabled) return
    lastRef.current = performance.now()
    const tick = (now: number) => {
      const delta = now - lastRef.current
      lastRef.current = now
      const state = useEditor.getState()
      const project = state.project
      if (!project) {
        setPlaying(false)
        return
      }
      const end = project.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0)
      const next = state.playhead + delta
      if (next >= end) {
        setPlayhead(end)
        setPlaying(false)
        return
      }
      setPlayhead(next, { snap: false })
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing, enabled, setPlaying, setPlayhead])
}
