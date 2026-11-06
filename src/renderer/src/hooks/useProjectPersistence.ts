/**
 * Autosave, save-on-quit hints and project loading.
 *
 * Autosave used to be a plain `setInterval(save, 8000)` created whenever the
 * project was dirty. Three things went wrong with that:
 *
 *  1. `save` was in the dependency list, and it closed over `project`, so every
 *     edit tore the interval down and rebuilt it. Typing in a caption field
 *     (one edit per keystroke) meant the timer was reset on every keystroke and
 *     *never* fired — the project could stay unsaved indefinitely.
 *  2. Nothing suppressed writes while an export or a long transcript job was
 *     running, so a burst of frames could push dozens of full project writes
 *     (each one a JSON serialise plus an atomic rename) into the main process.
 *  3. It saved whatever was in the store at fire time, which during a drag is a
 *     mid-gesture state that is about to be replaced.
 *
 * The replacement keeps one long-lived timer, reads the current project at fire
 * time, skips identical content, coalesces bursts through a quiet period and
 * suspends while the user is mid-gesture.
 */
import { useCallback, useEffect, useRef } from 'react'
import { useEditor } from '../state/editor'
import { api, errorMessage } from '../lib/api'
import type { Project } from '@shared/types'

/** How often the timer wakes up. Writes only happen when something changed. */
const AUTOSAVE_INTERVAL = 8000
/**
 * Bursts are common (slider drags, typed values). A save waits until the
 * project has been still for this long, so a slider drag produces one write
 * instead of one per percent.
 */
const QUIET_PERIOD_MS = 1200

/**
 * Cheap content signature: the project id plus everything that is persisted.
 * `updatedAt` is stamped by the store on every edit, so it stands in for the
 * body — but it is *not* enough on its own to detect a no-op undo/redo, hence
 * the clip/track counts alongside it.
 */
export function saveSignature(project: Project): string {
  return `${project.id}|${project.updatedAt}|${project.clips.length}|${project.tracks.length}|${project.assets.length}`
}

export function useAutosave(): void {
  const inflight = useRef(false)
  const lastSaved = useRef<string | null>(null)
  const lastEditAt = useRef(0)
  const mounted = useRef(true)

  /* Track when the project last actually changed, without re-creating the timer. */
  useEffect(() => {
    const unsubscribe = useEditor.subscribe((state, previous) => {
      if (state.project !== previous.project) lastEditAt.current = Date.now()
    })
    return unsubscribe
  }, [])

  const save = useCallback(async (force = false) => {
    const state = useEditor.getState()
    const project = state.project
    if (!project) return
    /* Never write mid-gesture: that state is about to be replaced by the commit. */
    if (!force && state.gesture) return
    /* Never write while a save is already in flight (the old code raced itself). */
    if (inflight.current) return
    const sig = saveSignature(project)
    if (sig === lastSaved.current) return
    /* Let a burst settle first. */
    if (!force && Date.now() - lastEditAt.current < QUIET_PERIOD_MS) return

    inflight.current = true
    state.setSaving(true)
    try {
      await api.projects.save(project)
      lastSaved.current = sig
      if (!mounted.current) return
      /* Only mark clean if nothing was edited while the write was in flight. */
      const after = useEditor.getState()
      if (after.project === project) after.markSaved(Date.now())
      else after.setSaving(false)
    } catch (error) {
      if (mounted.current) {
        useEditor.getState().setSaving(false)
        useEditor.getState().notify({ kind: 'error', title: 'Autosave failed', body: errorMessage(error) })
      }
    } finally {
      inflight.current = false
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    const timer = setInterval(() => {
      void save()
    }, AUTOSAVE_INTERVAL)
    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [save])

  // Save immediately when the window is about to close.
  useEffect(() => {
    const handler = () => {
      const state = useEditor.getState()
      if (!state.project) return
      if (saveSignature(state.project) === lastSaved.current) return
      void api.projects.save(state.project)
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])
}

export async function openProject(id: string): Promise<Project> {
  const store = useEditor.getState()
  store.setLoading(true)
  try {
    const project = await api.projects.load(id)
    store.setProject(project)
    // Flag missing media so the UI can offer relinking.
    const availability = await api.media.checkAvailability(project.assets)
    const missing = new Set(availability.filter((a) => !a.exists).map((a) => a.id))
    if (missing.size) {
      store.setProject({
        ...project,
        assets: project.assets.map((a) => ({ ...a, missing: missing.has(a.id) }))
      })
      store.notify({
        kind: 'warning',
        title: `${missing.size} media file${missing.size > 1 ? 's are' : ' is'} missing`,
        body: 'Use Media → Relink to point the project at the file again. Nothing was deleted.'
      })
    }
    return project
  } finally {
    store.setLoading(false)
  }
}

export function useGlobalShortcuts(handlers: Record<string, () => void>): void {
  useEffect(() => {
    const run = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      /*
       * Only real *text* entry swallows shortcuts. Every other focused control —
       * buttons, selects, switches, sliders, checkboxes — must not, because the
       * user expects Space to play/pause "anywhere in the video editor". A slider
       * or button keeps its own behaviour on Enter; Space belongs to playback.
       */
      const textEntry =
        target &&
        ((target.tagName === 'INPUT' &&
          !['range', 'checkbox', 'radio', 'button', 'submit', 'color', 'file'].includes(
            (target as HTMLInputElement).type
          )) ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      const inField = Boolean(textEntry)
      /*
       * The space bar reports event.key === ' ' (and 'Spacebar' on old WebKit),
       * never 'Space'. The shortcut map is keyed 'Space', so looking the raw key
       * up meant the global Space handler could never fire: playback only ever
       * toggled when the preview button itself had focus. Normalise first.
       */
      const rawKey = event.key
      const key = rawKey === ' ' || rawKey === 'Spacebar' ? 'Space' : rawKey
      const mod = event.ctrlKey || event.metaKey
      const combo = `${mod ? 'Ctrl+' : ''}${event.shiftKey ? 'Shift+' : ''}${key}`
      const map: Record<string, string> = {
        'Ctrl+z': 'undo',
        'Ctrl+Shift+Z': 'redo',
        'Ctrl+Shift+z': 'redo',
        'Ctrl+y': 'redo',
        'Ctrl+s': 'save',
        'Ctrl+k': 'split',
        'Ctrl+d': 'duplicate',
        'Ctrl+c': 'copy',
        'Ctrl+v': 'paste',
        'Ctrl+x': 'cut',
        'Ctrl+g': 'group',
        'Ctrl+Shift+G': 'ungroup',
        'Ctrl+=': 'zoomIn',
        'Ctrl+-': 'zoomOut',
        'Ctrl+e': 'export',
        'Ctrl+i': 'import',
        'Ctrl+n': 'new',
        'Space': 'playPause',
        'Delete': 'delete',
        'Shift+Delete': 'rippleDelete',
        'Escape': 'escape',
        'm': 'marker',
        's': 'toggleSnap',
        'ArrowLeft': 'prevFrame',
        'ArrowRight': 'nextFrame',
        'Shift+ArrowLeft': 'prevCut',
        'Shift+ArrowRight': 'nextCut',
        'Home': 'start',
        'End': 'end',
        '?': 'help'
      }
      if (inField && !['Escape', 'Ctrl+s'].includes(combo)) return
      // A modified key that is not itself a shortcut must not fall through to the
      // bare-key binding (Ctrl+Space is not play/pause, and Ctrl+Delete is not a
      // plain delete).
      if (mod && !map[combo]) return
      // preventDefault() also stops the browser from clicking a focused button
      // when Space is pressed, so play/pause always wins over a stray activation.
      const action = map[combo] ?? map[key]
      if (!action || !handlers[action]) return
      event.preventDefault()
      handlers[action]()
    }
    window.addEventListener('keydown', run)
    return () => window.removeEventListener('keydown', run)
  }, [handlers])
}
