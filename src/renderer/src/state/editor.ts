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
  legalPatch,
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
  /**
   * Snapshot of the project as it was when the current gesture began, and the
   * gesture's own id.
   *
   * A drag lasts hundreds of frames. Each frame used to be either a history
   * write (undo flooded with one entry per frame) or no history at all (the
   * gesture silently folded into whatever edit came before it, so undo skipped
   * back past the drag). Neither is right: one gesture must produce exactly one
   * undo entry, built from the state *before* the first frame moved.
   */
  gesture: { id: string; label: string; before: Project } | null

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
  /**
   * Drop selected clip ids that are no longer in the project, and clear the
   * active track when it has been removed. Every destructive operation calls
   * this: a selection pointing at a deleted clip made the Inspector show a ghost
   * and turned the next Delete into a no-op that pushed an empty undo entry.
   */
  pruneSelection: () => void
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
  applyLive: (mutator: (project: Project) => Project, label?: string) => void
  /**
   * Start (or continue) a named gesture. Repeating the call with the id of the
   * gesture already in progress is a no-op, so a per-frame caller can pass the
   * same id every frame without losing the original snapshot.
   */
  beginGesture: (id: string, label: string) => void
  /** Push one history snapshot for a finished gesture. */
  commitHistory: (label: string, id?: string) => void
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
/** Monotonic id source for drag/typing gestures (never reused across a session). */
let gestureCounter = 0
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
  gesture: null,

  setProject: (project) =>
    set({
      project,
      playhead: 0,
      scrubHeadMs: null,
      selectedClipIds: [],
      past: [],
      future: [],
      clipboard: [],
      gesture: null,
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
      /*
       * A discrete edit (a menu command, a typed value) ends any gesture that
       * was still open — otherwise the next drag would silently adopt the stale
       * snapshot and undo would jump to a state from minutes ago.
       */
      gesture: null,
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
      dirty: true,
      gesture: null
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
      dirty: true,
      gesture: null
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
    const next = clamp(value, 0, end)
    /*
     * The playback clock calls this every animation frame. Two rules keep that
     * cheap and keep the timeline from thrashing:
     *
     *  • a tick that does not move the playhead writes nothing — at 60 fps with
     *    a project that has finished, "nothing changed" was still a store update
     *    and a full re-render;
     *  • `scrubHeadMs` is only cleared when it is actually set. Writing
     *    `scrubHeadMs: null` on every frame replaced the object each time, so
     *    every selector reading it saw a change 60 times a second even though
     *    its value never changed.
     */
    if (next === state.playhead && state.scrubHeadMs === null) return
    set(state.scrubHeadMs === null ? { playhead: next } : { playhead: next, scrubHeadMs: null })
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

  pruneSelection: () => {
    const state = get()
    if (!state.project) return
    const alive = new Set(state.project.clips.map((c) => c.id))
    const kept = state.selectedClipIds.filter((id) => alive.has(id))
    const activeGone = state.activeTrackId !== null && !state.project.tracks.some((t) => t.id === state.activeTrackId)
    if (kept.length === state.selectedClipIds.length && !activeGone) return
    set({
      selectedClipIds: kept,
      activeTrackId: activeGone
        ? (state.project.tracks.find((t) => t.kind === 'video')?.id ?? state.project.tracks[0]?.id ?? null)
        : state.activeTrackId
    })
  },

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
    /*
     * This used to append the *current* project to the history stack, which
     * means "undo" restored the state the drag had just created — a no-op that
     * also threw away the redo stack. It now closes the gesture, whose snapshot
     * is the project as it was before the handle moved.
     */
    get().commitHistory('Transform clip')
  },

  setClipTransform: (clipId, patch) => {
    const state = get()
    if (!state.project) return
    const gesture = state.gesture ?? { id: `g${++gestureCounter}`, label: 'Transform clip', before: state.project }
    set({
      project: {
        ...state.project,
        clips: state.project.clips.map((c) =>
          c.id === clipId ? { ...c, transform: { ...c.transform, ...patch } } : c
        )
      },
      dirty: true,
      gesture
    })
  },

  applyLive: (mutator, label) => {
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
    /*
     * Record the pre-gesture project the first time a live frame actually
     * changes something. Doing it here (rather than at pointerdown) means a
     * click that selects a clip but never moves it leaves no undo entry.
     */
    const gesture = state.gesture ?? (label ? { id: `g${++gestureCounter}`, label, before: state.project } : null)
    set({ project: { ...next, updatedAt: Date.now() }, dirty: true, gesture })
  },

  beginGesture: (id, label) => {
    const state = get()
    if (!state.project || state.gesture?.id === id) return
    set({ gesture: { id, label, before: state.project } })
  },

  commitHistory: (label, id) => {
    const state = get()
    if (!state.project) return
    const gesture = state.gesture
    /*
     * With a gesture in flight, the history entry must contain the project as it
     * was *before* the gesture, not the mid-drag state that is in the store now.
     * That is what made undo land in the middle of a drag rather than before it.
     */
    if (gesture) {
      if (id !== undefined && gesture.id !== id) return
      const moved = gesture.before !== state.project
      set({
        past: moved
          ? [...state.past, { project: gesture.before, label: label || gesture.label, at: Date.now() }].slice(-MAX_HISTORY)
          : state.past,
        future: moved ? [] : state.future,
        gesture: null
      })
      return
    }
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

  /** Track ids that may be edited (everything not locked). */
  const editableSet = () => {
    const state = useEditor.getState()
    return new Set((state.project?.tracks ?? []).filter((t) => !t.locked).map((t) => t.id))
  }

  /** Selected clip ids that live on an unlocked track. */
  const deletableIds = () => {
    const state = useEditor.getState()
    const allowed = editableSet()
    return state.project
      ? state.project.clips.filter((c) => state.selectedClipIds.includes(c.id) && allowed.has(c.trackId)).map((c) => c.id)
      : []
  }

  /** Drop selected ids that no longer exist after an operation that deletes. */
  const pruneSelection = () => useEditor.getState().pruneSelection()

  return {
    split: () => {
      if (!project) return
      const unlocked = editableSet()
      const splittable = (c: Clip) =>
        unlocked.has(c.trackId) && playhead > c.start && playhead < c.start + c.duration
      const targets = selectedClipIds.length
        ? project.clips.filter((c) => selectedClipIds.includes(c.id) && splittable(c))
        : project.clips.filter(splittable)
      if (!targets.length) return false
      apply((p) => targets.reduce((acc, clip) => splitClip(acc, clip.id, playhead), p), 'Split clips')
      return true
    },
    deleteSelected: (ripple = false) => {
      if (!project || !selectedClipIds.length) return
      /*
       * Locking a track only stopped drags in the lane. Delete, ripple delete,
       * split and retime all went straight through, so a locked track was still
       * editable from the keyboard — the lock was decorative. The lock is
       * enforced here, at the one place every destructive command passes.
       */
      const editable = deletableIds()
      if (!editable.length) {
        if (selectedClipIds.length) {
          useEditor.getState().notify({
            kind: 'warning',
            title: 'That track is locked',
            body: 'Unlock it in the track header to delete clips on it.'
          })
        }
        return
      }
      apply(
        (p) =>
          ripple
            ? editable.reduce((acc, id) => rippleDeleteOp(acc, id), p)
            : deleteClips(p, editable),
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
      pruneSelection()
    },
    addTrack: (kind: TrackKind, name?: string) => {
      apply((p) => addTrackOp(p, kind, name).project, 'Add track')
    },
    removeTrack: (trackId: string) => {
      /*
       * Removing a track deletes the clips on it, but the selection kept their
       * ids. The Inspector then showed a clip that no longer existed, and the
       * next Delete/transform command operated on ghost ids (a no-op that also
       * pushed a useless history entry). Selection and active track are pruned
       * together with the track.
       */
      apply((p) => removeTrackOp(p, trackId), 'Remove track')
      useEditor.getState().pruneSelection()
    },
    moveTrack: (trackId: string, direction: -1 | 1) => {
      apply((p) => moveTrackOp(p, trackId, direction), 'Reorder tracks')
    },
    updateTrack: (trackId: string, patch: Partial<Track>, opts?: { history?: boolean; label?: string }) => {
      /*
       * Track changes were recorded with `history: false`, which made mute, solo,
       * lock, the eye toggle and renaming permanently un-undoable — a locked-out
       * track or a hidden overlay could not be brought back with Ctrl+Z.
       *
       * The reason it was excluded is real, though: the name field and the
       * height handle fire on every keystroke and every pointer frame. Those two
       * now go through a gesture (see Timeline), so a discrete toggle can record
       * history normally while a continuous control still produces one entry.
       */
      apply(
        (p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)) }),
        opts?.label ?? 'Update track',
        { history: opts?.history ?? true }
      )
    },
    updateClip: (clipId: string, patch: Partial<Clip>, opts?: { history?: boolean; label?: string }) => {
      /*
       * Timing is normalised here rather than at each call site: this is the one
       * sink every programmatic clip write goes through, and it used to accept
       * whatever it was handed — including `duration: -4000` from a typed value,
       * which produced a clip that existed but could never be drawn.
       */
      const safe = legalPatch(patch)
      apply(
        (p) => ({ ...p, clips: p.clips.map((c) => (c.id === clipId ? { ...c, ...safe } : c)) }),
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
    trim: (clipId: string, edge: 'start' | 'end', time: number, ripple = false, live = false) => {
      /*
       * A trim drag calls this on every pointermove. Each call used to be a full
       * `apply`, so one drag wrote ~60 undo entries and the redo stack was
       * cleared 60 times. `live` routes the frame through the gesture instead:
       * one snapshot for the whole drag, committed on pointerup.
       */
      const mutator = (p: Project) => trimClip(p, clipId, edge, time, { ripple })
      if (live) useEditor.getState().applyLive(mutator, ripple ? 'Ripple trim' : 'Trim clip')
      else apply(mutator, ripple ? 'Ripple trim' : 'Trim clip')
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
