/**
 * Editor store.
 *
 * Holds the open project plus all transient editor state (playhead, selection,
 * zoom, undo history). All timeline mutations go through `apply`, which keeps a
 * bounded undo stack and marks the project dirty so autosave can react.
 */
import { create } from 'zustand'
import {
  addTrack as addTrackOp,
  clampGroupMove,
  clearRange,
  deleteClips,
  duplicateClip,
  groupClips,
  insertClip,
  moveClip,
  moveTrack as moveTrackOp,
  overwriteClip,
  removeTrack as removeTrackOp,
  rippleDelete as rippleDeleteOp,
  rippleDeleteRange,
  splitClip,
  trimClip,
  ungroupClips
} from '@shared/timeline'
import { uid } from '@shared/keyframes'
import { clamp, snapToFrame } from '@shared/time'
import type { Clip, Marker, Project, Track, TrackKind } from '@shared/types'
import { errorMessage } from '../lib/api'

export interface EditorSnapshot {
  project: Project
  label: string
  at: number
}

export type WorkspaceTab = 'edit' | 'clips' | 'media' | 'captions' | 'export'

export interface InspectorTab {
  id: 'properties' | 'effects' | 'animations' | 'audio' | 'text' | 'caption'
}

export type Notification = {
  id: string
  kind: 'info' | 'success' | 'error' | 'warning'
  title: string
  body?: string
  action?: { label: string; run: () => void }
}

interface EditorState {
  project: Project | null
  /**
   * Scrub head, independent of the project's content duration.
   *
   * `playhead` is the frame-accurate position used for rendering and playback;
   * it is clamped to the end of the content because playing past the last clip
   * is meaningless. Dragging in the ruler must not be clamped, though — a scrub
   * that stops dead at 0 s on an empty project (or at the end of the content)
   * reads as a frozen, broken timeline. `scrubHeadMs` records where the user
   * actually dragged, and the ruler draws the playhead there until the next
   * playback or edit pulls the two back together.
   */
  scrubHeadMs: number | null
  loading: boolean
  dirty: boolean
  saving: boolean
  lastSavedAt: number | null
  error: string | null

  /* selection & playback */
  playhead: number
  playing: boolean
  selectedClipIds: string[]
  activeTrackId: string | null
  selectedTransition: { clipId: string; edge: 'in' | 'out' } | null
  zoom: number
  scrollLeft: number
  snapping: boolean
  showSafeAreas: boolean
  showTransformHandles: boolean
  autoFramePreview: boolean

  /* ui */
  workspaceTab: WorkspaceTab
  inspectorTab: InspectorTab['id']
  notifications: Notification[]
  exporting: boolean

  /* history */
  past: EditorSnapshot[]
  future: EditorSnapshot[]
  clipboard: Clip[]

  /* actions */
  setProject: (project: Project | null) => void
  apply: (mutator: (project: Project) => Project, label?: string, opts?: { history?: boolean }) => void
  undo: () => void
  redo: () => void
  setPlayhead: (ms: number, opts?: { snap?: boolean; scrub?: boolean }) => void
  setPlaying: (playing: boolean) => void
  selectClips: (ids: string[], opts?: { additive?: boolean }) => void
  toggleClipSelection: (id: string) => void
  selectAllClips: () => void
  clearSelection: () => void
  setActiveTrack: (trackId: string | null) => void
  setZoom: (zoom: number) => void
  zoomBy: (factor: number, anchorMs?: number) => void
  setScrollLeft: (value: number) => void
  setSnapping: (on: boolean) => void
  toggleSnapping: () => void
  setInspectorTab: (tab: InspectorTab['id']) => void
  setWorkspaceTab: (tab: WorkspaceTab) => void
  notify: (n: Omit<Notification, 'id'>) => void
  dismissNotification: (id: string) => void
  dismiss: (id: string) => void
  duration: () => number
  stepFrames: (frames: number) => void
  jumpCut: (direction: -1 | 1) => void
  finishTransformDrag: (clipId: string) => void
  setClipTransform: (clipId: string, patch: Partial<Clip['transform']>) => void
  /** Apply a project mutation without recording history (used for drag frames). */
  applyLive: (mutator: (project: Project) => Project) => void
  /** Push one history snapshot for a finished gesture. */
  commitHistory: (label: string) => void
  pushClipboard: (clips: Clip[]) => void
  pasteClipboard: () => void
  setSaving: (saving: boolean) => void
  markSaved: (at: number) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  setShowSafeAreas: (on: boolean) => void
  setShowTransformHandles: (on: boolean) => void
  setSelectedTransition: (value: { clipId: string; edge: 'in' | 'out' } | null) => void
  setAutoFramePreview: (on: boolean) => void
  setExporting: (on: boolean) => void
}

const MAX_HISTORY = 60
const DEFAULT_ZOOM = 48 // px per second

export const useEditor = create<EditorState>((set, get) => ({
  project: null,
  loading: false,
  dirty: false,
  saving: false,
  lastSavedAt: null,
  error: null,

  playhead: 0,
  scrubHeadMs: null,
  playing: false,
  selectedClipIds: [],
  activeTrackId: null,
  selectedTransition: null,
  zoom: DEFAULT_ZOOM,
  scrollLeft: 0,
  snapping: true,
  showSafeAreas: true,
  showTransformHandles: true,
  autoFramePreview: true,

  workspaceTab: 'edit',
  inspectorTab: 'properties',
  notifications: [],
  exporting: false,

  past: [],
  future: [],
  clipboard: [],

  setProject: (project) =>
    set({
      project,
      playhead: 0,
      scrubHeadMs: null,
      selectedClipIds: [],
      past: [],
      future: [],
      dirty: false,
      error: null,
      activeTrackId: project?.tracks.find((t) => t.kind === 'video')?.id ?? null
    }),

  apply: (mutator, label = 'Edit', opts) => {
    const state = get()
    if (!state.project) return
    let next: Project
    try {
      next = mutator(state.project)
    } catch (error) {
      set({ error: errorMessage(error) })
      return
    }
    if (next === state.project) return
    const history = opts?.history !== false
    set({
      project: { ...next, updatedAt: Date.now() },
      dirty: true,
      past: history
        ? [...state.past, { project: state.project, label, at: Date.now() }].slice(-MAX_HISTORY)
        : state.past,
      future: history ? [] : state.future
    })
  },

  undo: () => {
    const state = get()
    const previous = state.past[state.past.length - 1]
    if (!previous || !state.project) return
    set({
      project: previous.project,
      past: state.past.slice(0, -1),
      future: [{ project: state.project, label: previous.label, at: Date.now() }, ...state.future].slice(0, MAX_HISTORY),
      dirty: true
    })
    get().notify({ kind: 'info', title: `Undo: ${previous.label}` })
  },

  redo: () => {
    const state = get()
    const next = state.future[0]
    if (!next || !state.project) return
    set({
      project: next.project,
      past: [...state.past, { project: state.project, label: next.label, at: Date.now() }].slice(-MAX_HISTORY),
      future: state.future.slice(1),
      dirty: true
    })
    get().notify({ kind: 'info', title: `Redo: ${next.label}` })
  },

  setPlayhead: (ms, opts) => {
    const state = get()
    const fps = state.project?.fps ?? 30
    const duration = state.project
      ? state.project.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0)
      : 0
    const end = Math.max(0, duration)
    const value = opts?.snap === false ? Math.max(0, ms) : Math.max(0, snapToFrame(ms, fps))
    if (opts?.scrub) {
      // A scrub may land anywhere past the content; remember it so the ruler and
      // the readout follow the pointer instead of snapping back.
      const head = Math.max(0, value)
      set({ playhead: clamp(head, 0, Math.max(end, head)), scrubHeadMs: head })
      return
    }
    set({ playhead: clamp(value, 0, end), scrubHeadMs: null })
  },

  setPlaying: (playing) => set({ playing }),

  selectClips: (ids, opts) =>
    set((state) => ({
      selectedClipIds: opts?.additive ? [...new Set([...state.selectedClipIds, ...ids])] : ids,
      selectedTransition: null
    })),

  toggleClipSelection: (id) =>
    set((state) => ({
      selectedClipIds: state.selectedClipIds.includes(id)
        ? state.selectedClipIds.filter((c) => c !== id)
        : [...state.selectedClipIds, id]
    })),

  selectAllClips: () =>
    set((state) => ({ selectedClipIds: state.project?.clips.map((c) => c.id) ?? [] })),

  clearSelection: () => set({ selectedClipIds: [], selectedTransition: null }),

  setActiveTrack: (trackId) => set({ activeTrackId: trackId }),

  setZoom: (zoom) => set({ zoom: clamp(zoom, 6, 900) }),

  zoomBy: (factor, anchorMs) => {
    const { zoom, playhead } = get()
    const next = clamp(zoom * factor, 6, 900)
    set({ zoom: next })
    // Keep the anchor under the cursor by adjusting scroll externally.
    if (anchorMs !== undefined) {
      const state = get()
      // scrollLeft is in px; 1 second = zoom px.
      const anchorPx = (anchorMs / 1000) * next
      set({ scrollLeft: Math.max(0, anchorPx - 120), playhead: state.playhead })
    }
  },

  setScrollLeft: (value) => set({ scrollLeft: Math.max(0, value) }),
  setSnapping: (on) => set({ snapping: on }),
  toggleSnapping: () => set((s) => ({ snapping: !s.snapping })),
  setInspectorTab: (tab) => set({ inspectorTab: tab }),
  setWorkspaceTab: (tab) => set({ workspaceTab: tab }),

  notify: (n) => {
    const id = uid('toast')
    set((state) => ({ notifications: [...state.notifications, { ...n, id }] }))
    const timeout = n.kind === 'error' ? 9000 : 4200
    setTimeout(() => {
      set((state) => ({ notifications: state.notifications.filter((t) => t.id !== id) }))
    }, timeout)
  },

  dismissNotification: (id) => set((state) => ({ notifications: state.notifications.filter((t) => t.id !== id) })),
  dismiss: (id) => set((state) => ({ notifications: state.notifications.filter((t) => t.id !== id) })),

  duration: () => {
    const project = get().project
    if (!project) return 0
    return project.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0)
  },

  stepFrames: (frames) => {
    const state = get()
    const fps = state.project?.fps ?? 30
    state.setPlayhead(state.playhead + (frames * 1000) / fps, { snap: false })
  },

  /** Jump to the previous/next edit point (clip boundary or marker). */
  jumpCut: (direction) => {
    const state = get()
    const project = state.project
    if (!project) return
    const points = new Set<number>([0])
    for (const clip of project.clips) {
      points.add(clip.start)
      points.add(clip.start + clip.duration)
    }
    for (const marker of project.markers) points.add(marker.time)
    const sorted = [...points].sort((a, b) => a - b)
    const epsilon = 4
    const target =
      direction > 0
        ? sorted.find((p) => p > state.playhead + epsilon)
        : [...sorted].reverse().find((p) => p < state.playhead - epsilon)
    if (target !== undefined) state.setPlayhead(target, { snap: false })
  },

  /**
   * Direct-manipulation moves update the project without touching history on
   * every pointermove; this commits exactly one undo entry at drag end.
   */
  finishTransformDrag: (clipId) => {
    const state = get()
    if (!state.project) return
    const clip = state.project.clips.find((c) => c.id === clipId)
    if (!clip) return
    set({
      past: [...state.past, { project: state.project, label: 'Transform clip', at: Date.now() }].slice(-MAX_HISTORY),
      future: [],
      dirty: true
    })
  },

  setClipTransform: (clipId, patch) => {
    const state = get()
    if (!state.project) return
    set({
      project: {
        ...state.project,
        clips: state.project.clips.map((c) =>
          c.id === clipId ? { ...c, transform: { ...c.transform, ...patch } } : c
        )
      },
      dirty: true
    })
  },

  applyLive: (mutator) => {
    const state = get()
    if (!state.project) return
    let next: Project
    try {
      next = mutator(state.project)
    } catch (error) {
      set({ error: errorMessage(error) })
      return
    }
    if (next === state.project) return
    set({ project: { ...next, updatedAt: Date.now() }, dirty: true })
  },

  commitHistory: (label) => {
    const state = get()
    if (!state.project) return
    set({
      past: [...state.past, { project: state.project, label, at: Date.now() }].slice(-MAX_HISTORY),
      future: []
    })
  },

  pushClipboard: (clips) => set({ clipboard: clips.map((c) => structuredClone(c)) }),

  pasteClipboard: () => {
    const state = get()
    if (!state.project || !state.clipboard.length) return
    const base = Math.min(...state.clipboard.map((c) => c.start))
    const offset = state.playhead - base
    const pasted = state.clipboard.map((c) => ({
      ...structuredClone(c),
      id: uid('clip'),
      start: Math.max(0, c.start + offset)
    }))
    const ids = pasted.map((c) => c.id)
    set({
      project: { ...state.project, clips: [...state.project.clips, ...pasted], updatedAt: Date.now() },
      selectedClipIds: ids,
      past: [...state.past, { project: state.project, label: 'Paste clips', at: Date.now() }].slice(-MAX_HISTORY),
      future: [],
      dirty: true
    })
  },
  setSaving: (saving) => set({ saving }),
  markSaved: (at) => set({ dirty: false, lastSavedAt: at, saving: false }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setShowSafeAreas: (on) => set({ showSafeAreas: on }),
  setShowTransformHandles: (on) => set({ showTransformHandles: on }),
  setSelectedTransition: (value) => set({ selectedTransition: value, selectedClipIds: value ? [value.clipId] : [] }),
  setAutoFramePreview: (on) => set({ autoFramePreview: on }),
  setExporting: (on) => set({ exporting: on })
}))

/* ------------------------------------------------------------------ */
/* Timeline operations (wired to the store)                           */
/* ------------------------------------------------------------------ */

export function useTimelineActions() {
  const { apply, project, selectedClipIds, playhead, setPlayhead } = useEditor()

  return {
    split: () => {
      if (!project) return
      const targets = selectedClipIds.length
        ? project.clips.filter((c) => selectedClipIds.includes(c.id) && playhead > c.start && playhead < c.start + c.duration)
        : project.clips.filter((c) => playhead > c.start && playhead < c.start + c.duration)
      if (!targets.length) return false
      apply((p) => targets.reduce((acc, clip) => splitClip(acc, clip.id, playhead), p), 'Split clips')
      return true
    },
    deleteSelected: (ripple = false) => {
      if (!project || !selectedClipIds.length) return
      apply(
        (p) =>
          ripple
            ? selectedClipIds.reduce((acc, id) => rippleDeleteOp(acc, id), p)
            : deleteClips(p, selectedClipIds),
        ripple ? 'Ripple delete' : 'Delete clips'
      )
      useEditor.getState().clearSelection()
    },
    duplicateSelected: () => {
      if (!project || !selectedClipIds.length) return
      apply(
        (p) => {
          let next = p
          for (const id of selectedClipIds) next = duplicateClip(next, id).project
          return next
        },
        'Duplicate clips'
      )
    },
    rippleDeleteRange: (start: number, end: number, trackId?: string) => {
      apply((p) => rippleDeleteRange(p, start, end, trackId), 'Ripple delete range')
    },
    addTrack: (kind: TrackKind, name?: string) => {
      apply((p) => addTrackOp(p, kind, name).project, 'Add track')
    },
    removeTrack: (trackId: string) => {
      apply((p) => removeTrackOp(p, trackId), 'Remove track')
    },
    moveTrack: (trackId: string, direction: -1 | 1) => {
      apply((p) => moveTrackOp(p, trackId, direction), 'Reorder tracks')
    },
    updateTrack: (trackId: string, patch: Partial<Track>) => {
      apply(
        (p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)) }),
        'Update track',
        { history: false }
      )
    },
    updateClip: (clipId: string, patch: Partial<Clip>, opts?: { history?: boolean; label?: string }) => {
      apply(
        (p) => ({ ...p, clips: p.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)) }),
        opts?.label ?? 'Update clip',
        { history: opts?.history ?? false }
      )
    },
    updateClips: (ids: string[], patch: (clip: Clip) => Partial<Clip>, label = 'Update clips') => {
      apply(
        (p) => ({ ...p, clips: p.clips.map((c) => (ids.includes(c.id) ? { ...c, ...patch(c) } : c)) }),
        label
      )
    },
    copySelection: () => {
      if (!project) return
      const clips = project.clips.filter((c) => selectedClipIds.includes(c.id))
      if (clips.length) useEditor.getState().pushClipboard(clips)
    },
    paste: () => useEditor.getState().pasteClipboard(),
    moveSelected: (deltaMs: number, targetTrackId?: string, opts?: { history?: boolean }) => {
      if (!project) return
      const selected = project.clips.filter((c) => selectedClipIds.includes(c.id))
      if (!selected.length) return
      const allowed = clampGroupMove(selected, deltaMs)
      const lockedTracks = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id))
      if (selected.some((c) => lockedTracks.has(c.trackId))) return
      apply(
        (p) => ({
          ...p,
          clips: p.clips.map((c) =>
            selectedClipIds.includes(c.id)
              ? {
                  ...c,
                  start: Math.max(0, c.start + allowed),
                  trackId: targetTrackId && selected.length === 1 ? targetTrackId : c.trackId
                }
              : c
          )
        }),
        'Move clips',
        { history: opts?.history ?? true }
      )
    },
    /** Move clips during a drag without pushing a history entry per frame. */
    beginBatch: (label: string) => {
      const state = useEditor.getState()
      if (!state.project) return
      useEditor.setState({
        past: [...state.past, { project: state.project, label, at: Date.now() }].slice(-60),
        future: []
      })
    },
    trim: (clipId: string, edge: 'start' | 'end', time: number, ripple = false) => {
      apply((p) => trimClip(p, clipId, edge, time, { ripple }), ripple ? 'Ripple trim' : 'Trim clip')
    },
    placeClip: (clip: Clip, at: number, mode: 'overwrite' | 'insert' = 'overwrite') => {
      apply(
        (p) => (mode === 'insert' ? insertClip(p, clip, at) : overwriteClip(p, clip, at)),
        mode === 'insert' ? 'Insert clip' : 'Place clip'
      )
    },
    clearRange: (trackId: string, start: number, end: number) => {
      apply((p) => ({ ...p, clips: clearRange(p.clips, trackId, start, end) }), 'Clear range')
    },
    group: () => {
      if (selectedClipIds.length < 2) return
      apply((p) => groupClips(p, selectedClipIds).project, 'Group clips')
    },
    ungroup: () => {
      if (!project) return
      const groups = new Set(
        project.clips.filter((c) => selectedClipIds.includes(c.id) && c.groupId).map((c) => c.groupId!)
      )
      if (!groups.size) return
      apply((p) => [...groups].reduce((acc, g) => ungroupClips(acc, g), p), 'Ungroup clips')
    },
    addMarker: () => {
      apply(
        (p) => ({
          ...p,
          markers: [
            ...p.markers,
            { id: uid('mk'), time: snapToFrame(playhead, p.fps), label: `Marker ${p.markers.length + 1}`, color: '#FF7A18' } as Marker
          ]
        }),
        'Add marker'
      )
    },
    removeMarker: (id: string) => {
      apply((p) => ({ ...p, markers: p.markers.filter((m) => m.id !== id) }), 'Remove marker')
    },
    setCanvas: (patch: Partial<Project['canvas']>) => {
      apply((p) => ({ ...p, canvas: { ...p.canvas, ...patch }, fps: patch.fps ?? p.fps }), 'Change canvas')
    },
    seek: (ms: number) => setPlayhead(ms)
  }
}
