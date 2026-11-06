/**
 * Single source of truth for "start playing".
 *
 * The transport button and the Space shortcut used to each roll their own
 * toggle, and both could be handed a playhead parked exactly on the end of the
 * timeline (which is where a finished playback leaves it). Playback then died on
 * its first animation frame and pressing play again did nothing — the "it played
 * once, then never again" report. Everything now goes through `togglePlayback`.
 */
import { useEditor } from './editor'
import type { Project } from '@shared/types'

/** End of the last clip on the timeline, in milliseconds (0 when empty). */
export function timelineEnd(project: Project | null | undefined): number {
  if (!project || !project.clips.length) return 0
  return project.clips.reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0)
}

/**
 * Toggle playback. Starting from (or past) the end rewinds to the beginning
 * first, so the same button both replays and resumes. Does nothing when there is
 * no clip to play, rather than flipping a flag that the clock immediately clears.
 */
export function togglePlayback(): void {
  const state = useEditor.getState()
  const project = state.project
  if (!project) return
  if (state.playing) {
    state.setPlaying(false)
    return
  }
  const end = timelineEnd(project)
  if (end <= 0) return
  if (state.playhead >= end - 1) state.setPlayhead(0, { snap: false })
  state.setPlaying(true)
}
