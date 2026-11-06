/**
 * Timeline playback clock.
 *
 * Uses requestAnimationFrame with a wall-clock delta so playback is smooth even
 * when the preview drops frames, and stops at the end of the timeline.
 */
import { useEffect, useRef } from 'react'
import { useEditor } from '../state/editor'
import { timelineEnd } from '../state/playback'

export function usePlayback(enabled = true): void {
  const playing = useEditor((s) => s.playing)
  const setPlaying = useEditor((s) => s.setPlaying)
  const setPlayhead = useEditor((s) => s.setPlayhead)
  const rafRef = useRef<number>(0)
  const lastRef = useRef<number>(0)

  /*
   * A background window throttles requestAnimationFrame to a crawl, so a long
   * stall used to be replayed as one huge delta the moment the window came back
   * — the playhead jumped and the app felt like it had frozen. Pausing on blur
   * (and on tab hide) keeps the clock honest: you come back to where you left.
   */
  useEffect(() => {
    if (!playing) return
    const pause = () => {
      if (useEditor.getState().playing) setPlaying(false)
    }
    const onVisibility = () => {
      if (document.hidden) pause()
    }
    window.addEventListener('blur', pause)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', pause)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [playing, setPlaying])

  useEffect(() => {
    if (!playing || !enabled) return
    lastRef.current = performance.now()

    /*
     * Pressing play while parked at (or past) the end used to do nothing: the
     * clock computed `playhead + delta >= end` on its first frame and turned
     * playback straight back off. The playhead is usually left exactly at the
     * end after any finished playback, so every later play attempt silently
     * failed — which is what "it played once, then it would not play again"
     * looks like. Playing from the end now restarts from the beginning.
     */
    {
      const state = useEditor.getState()
      const end = timelineEnd(state.project)
      if (end > 0 && state.playhead >= end - 1) setPlayhead(0, { snap: false })
    }

    const tick = (now: number) => {
      // Clamp the delta: a long frame (window drag, GC pause, hidden tab) must
      // not turn into a visible jump of the playhead.
      const delta = Math.min(now - lastRef.current, 250)
      lastRef.current = now
      const state = useEditor.getState()
      const project = state.project
      if (!project) {
        setPlaying(false)
        return
      }
      const end = timelineEnd(project)
      // Nothing to play: stop rather than looping on a zero-length timeline.
      if (end <= 0) {
        setPlaying(false)
        return
      }
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
