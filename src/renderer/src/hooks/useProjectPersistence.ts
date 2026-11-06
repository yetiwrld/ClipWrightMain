/** Autosave, save-on-quit hints and project loading. */
import { useCallback, useEffect, useRef } from 'react'
import { useEditor } from '../state/editor'
import { api, errorMessage } from '../lib/api'
import type { Project } from '@shared/types'

const AUTOSAVE_INTERVAL = 8000

export function useAutosave(): void {
  const { project, dirty, setSaving, markSaved, notify } = useEditor()
  const inflight = useRef(false)

  const save = useCallback(async () => {
    if (!project || inflight.current) return
    inflight.current = true
    setSaving(true)
    try {
      await api.projects.save(project)
      markSaved(Date.now())
    } catch (error) {
      notify({ kind: 'error', title: 'Autosave failed', body: errorMessage(error) })
    } finally {
      inflight.current = false
    }
  }, [project, setSaving, markSaved, notify])

  useEffect(() => {
    if (!dirty) return
    const timer = setInterval(save, AUTOSAVE_INTERVAL)
    return () => clearInterval(timer)
  }, [dirty, save])

  // Save immediately when the window is about to close.
  useEffect(() => {
    const handler = () => {
      if (useEditor.getState().dirty && useEditor.getState().project) {
        void api.projects.save(useEditor.getState().project!)
      }
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
