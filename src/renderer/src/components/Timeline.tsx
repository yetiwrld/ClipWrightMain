/**
 * Multitrack timeline.
 *
 * • drag clips horizontally and between tracks (snapping with guides)
 * • drag clip edges to trim (Alt = ripple)
 * • marquee selection, multi-select, context menu
 * • per-track header: mute / solo / lock / visibility / height
 * • zoom (wheel / buttons), scroll, playhead, markers, real waveforms
 *
 * Drags mutate live without spamming undo: one history entry is committed when
 * the gesture ends.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Captions,
  Copy,
  Eye,
  EyeOff,
  Film,
  Image as ImageIcon,
  Layers,
  Lock,
  LockOpen,
  Magnet,
  Maximize,
  Music,
  Plus,
  Scissors,
  Shapes,
  Trash2,
  Type,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { useEditor, useTimelineActions } from '../state/editor'
import { ContextMenu, IconButton, type MenuItem } from './ui'
import { clamp, formatClock } from '@shared/time'
import { baseClip, compositingOrder, snapTime, trackIsAudible } from '@shared/timeline'
import type { Clip, Track, TrackKind } from '@shared/types'
import { api } from '../lib/api'

const RULER_H = 30
const HEADER_W = 168

interface DragState {
  kind: 'move' | 'trim-start' | 'trim-end' | 'marquee' | 'playhead'
  clipIds: string[]
  startClientX: number
  startClientY: number
  originStarts: Record<string, number>
  originDurations: Record<string, number>
  originTracks: Record<string, string>
  marqueeStart?: { x: number; y: number }
  changed?: boolean
}

const TRACK_ICON: Record<TrackKind, React.ReactNode> = {
  video: <Film size={12} />,
  audio: <Music size={12} />,
  image: <ImageIcon size={12} />,
  text: <Type size={12} />,
  caption: <Captions size={12} />,
  graphic: <Shapes size={12} />
}

export function Timeline(): JSX.Element {
  const {
    project,
    playhead,
    selectedClipIds,
    zoom,
    scrollLeft,
    snapping,
    activeTrackId
  } = useEditor()
  const selectClips = useEditor((s) => s.selectClips)
  const toggleClipSelection = useEditor((s) => s.toggleClipSelection)
  const setPlayhead = useEditor((s) => s.setPlayhead)
  const setZoom = useEditor((s) => s.setZoom)
  const setActiveTrack = useEditor((s) => s.setActiveTrack)
  const applyLive = useEditor((s) => s.applyLive)
  const commitHistory = useEditor((s) => s.commitHistory)
  const toggleSnapping = useEditor((s) => s.toggleSnapping)
  const actions = useTimelineActions()
  const { updateTrack, trim, placeClip, removeMarker, addMarker } = actions

  const scrollRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [guide, setGuide] = useState<number | null>(null)
  const [dropTrack, setDropTrack] = useState<string | null>(null)
  const [waveforms, setWaveforms] = useState<Record<string, { peaks: number[]; samplesPerSecond: number }>>({})

  const duration = useMemo(
    () => (project ? project.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0) : 0),
    [project]
  )
  const timelineWidth = Math.max(760, Math.ceil(((duration + 15000) / 1000) * zoom))
  const pxPerMs = zoom / 1000

  /* Waveform peaks come from the main process cache; missing ones are ignored. */
  useEffect(() => {
    if (!project) return
    let cancelled = false
    const load = async () => {
      for (const asset of project.assets) {
        if (!asset.waveform || waveforms[asset.id]) continue
        try {
          const response = await fetch(api.mediaUrl(asset.waveform))
          if (!response.ok) continue
          const json = (await response.json()) as { peaks: number[]; samplesPerSecond: number }
          if (!cancelled) setWaveforms((prev) => ({ ...prev, [asset.id]: json }))
        } catch {
          /* waveforms are decorative — never block the editor on them */
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [project, waveforms])

  const trackList = useMemo(() => (project ? compositingOrder(project) : []), [project])

  /* ------------------------------ pointer math ------------------------------ */

  const contentX = (clientX: number) => {
    const scroller = scrollRef.current
    if (!scroller) return 0
    const rect = scroller.getBoundingClientRect()
    return clientX - rect.left - HEADER_W + scroller.scrollLeft
  }
  const timeAt = (clientX: number) => Math.max(0, contentX(clientX) / pxPerMs)

  const trackAt = (clientY: number): string | null => {
    const scroller = scrollRef.current
    if (!scroller) return null
    const rect = scroller.getBoundingClientRect()
    let y = clientY - rect.top + scroller.scrollTop - RULER_H
    for (const track of trackList) {
      if (y <= track.height + 1) return track.id
      y -= track.height + 1
    }
    return null
  }

  const startMove = (event: React.PointerEvent, clip: Clip) => {
    if (event.button !== 0) return
    const track = project?.tracks.find((t) => t.id === clip.trackId)
    if (track?.locked) return
    event.stopPropagation()
    const additive = event.shiftKey || event.ctrlKey
    if (additive) toggleClipSelection(clip.id)
    else if (!selectedClipIds.includes(clip.id)) selectClips([clip.id])
    const ids = additive
      ? [...new Set([...selectedClipIds, clip.id])]
      : selectedClipIds.includes(clip.id)
        ? selectedClipIds
        : [clip.id]
    const selected = project!.clips.filter((c) => ids.includes(c.id))
    dragRef.current = {
      kind: 'move',
      clipIds: selected.map((c) => c.id),
      startClientX: event.clientX,
      startClientY: event.clientY,
      originStarts: Object.fromEntries(selected.map((c) => [c.id, c.start])),
      originDurations: Object.fromEntries(selected.map((c) => [c.id, c.duration])),
      originTracks: Object.fromEntries(selected.map((c) => [c.id, c.trackId]))
    }
    ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  }

  const startTrim = (event: React.PointerEvent, clip: Clip, edge: 'start' | 'end') => {
    const track = project?.tracks.find((t) => t.id === clip.trackId)
    if (track?.locked) return
    event.stopPropagation()
    selectClips([clip.id])
    dragRef.current = {
      kind: edge === 'start' ? 'trim-start' : 'trim-end',
      clipIds: [clip.id],
      startClientX: event.clientX,
      startClientY: event.clientY,
      originStarts: { [clip.id]: clip.start },
      originDurations: { [clip.id]: clip.duration },
      originTracks: { [clip.id]: clip.trackId }
    }
    ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current
      if (!drag || !project) return

      if (drag.kind === 'move') {
        const deltaPx = event.clientX - drag.startClientX
        const minStart = Math.min(...Object.values(drag.originStarts))
        let deltaMs = Math.max(deltaPx / pxPerMs, -minStart)
        const anchorId = drag.clipIds[0]
        let target = drag.originStarts[anchorId] + deltaMs
        let snapped: number | null = null
        if (snapping && !event.ctrlKey) {
          const result = snapTime(project, target, 8 / pxPerMs, {
            ignoreClipIds: drag.clipIds,
            playhead,
            includeMarkers: true
          })
          target = result.time
          snapped = result.snapped
        }
        const appliedDelta = target - drag.originStarts[anchorId]
        // Allow moving a single clip to another track of the same kind.
        const hoveredId = trackAt(event.clientY)
        let targetTrackId: string | undefined
        if (drag.clipIds.length === 1 && hoveredId) {
          const hovered = project.tracks.find((t) => t.id === hoveredId)
          const original = project.tracks.find((t) => t.id === drag.originTracks[anchorId])
          if (hovered && original && hovered.kind === original.kind && !hovered.locked && hovered.id !== original.id) {
            targetTrackId = hovered.id
          }
        }
        setDropTrack(targetTrackId ?? null)
        setGuide(snapped)
        drag.changed = true
        applyLive((p) => ({
          ...p,
          clips: p.clips.map((c) =>
            drag.clipIds.includes(c.id)
              ? {
                  ...c,
                  start: Math.max(0, drag.originStarts[c.id] + appliedDelta),
                  trackId: c.id === anchorId && targetTrackId ? targetTrackId : drag.originTracks[c.id]
                }
              : c
          )
        }))
        return
      }

      if (drag.kind === 'trim-start' || drag.kind === 'trim-end') {
        const id = drag.clipIds[0]
        const time = timeAt(event.clientX)
        drag.changed = true
        trim(id, drag.kind === 'trim-start' ? 'start' : 'end', time, event.altKey)
        return
      }

      if (drag.kind === 'marquee' && drag.marqueeStart) {
        const rect = scrollRef.current!.getBoundingClientRect()
        const x = event.clientX - rect.left
        const y = event.clientY - rect.top
        setMarquee({
          x: Math.min(x, drag.marqueeStart.x),
          y: Math.min(y, drag.marqueeStart.y),
          w: Math.abs(x - drag.marqueeStart.x),
          h: Math.abs(y - drag.marqueeStart.y)
        })
        return
      }

      if (drag.kind === 'playhead') {
        setPlayhead(timeAt(event.clientX), { snap: false })
      }
    },
    [project, pxPerMs, snapping, playhead, applyLive, setPlayhead, trim]
  )

  const onPointerUp = useCallback(() => {
    const drag = dragRef.current
    dragRef.current = null
    setGuide(null)
    setDropTrack(null)

    if (drag?.kind === 'marquee' && marquee && project) {
      const ids: string[] = []
      let y = 0
      for (const track of trackList) {
        const top = y
        y += track.height + 1
        if (top + track.height < marquee.y - RULER_H || top > marquee.y + marquee.h - RULER_H) continue
        for (const clip of project.clips.filter((c) => c.trackId === track.id)) {
          const left = (clip.start / 1000) * zoom - scrollLeft + HEADER_W
          const right = left + (clip.duration / 1000) * zoom
          if (right >= marquee.x && left <= marquee.x + marquee.w) ids.push(clip.id)
        }
      }
      selectClips(ids)
      setMarquee(null)
      return
    }
    setMarquee(null)
    if (drag?.changed) {
      commitHistory(drag.kind === 'move' ? 'Move clips' : 'Trim clip')
    }
  }, [marquee, project, trackList, zoom, scrollLeft, selectClips, commitHistory])

  /* ctrl+wheel zooms at the cursor, shift+wheel scrolls horizontally */
  const onWheel = (event: React.WheelEvent) => {
    const scroller = scrollRef.current
    if (!scroller) return
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      const anchor = timeAt(event.clientX)
      const nextZoom = clamp(zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), 6, 900)
      const localX = event.clientX - scroller.getBoundingClientRect().left - HEADER_W
      setZoom(nextZoom)
      requestAnimationFrame(() => {
        scroller.scrollLeft = Math.max(0, (anchor / 1000) * nextZoom - localX)
      })
      return
    }
    if (event.shiftKey) {
      scroller.scrollLeft += event.deltaY
      event.preventDefault()
    }
  }

  const updateClipAudio = (id: string, patch: Partial<Clip['audio']>) => {
    useEditor.getState().apply(
      (p) => ({ ...p, clips: p.clips.map((c) => (c.id === id ? { ...c, audio: { ...c.audio, ...patch } } : c)) }),
      'Update clip audio'
    )
  }

  const openClipMenu = (event: React.MouseEvent, clip: Clip) => {
    event.preventDefault()
    event.stopPropagation()
    if (!selectedClipIds.includes(clip.id)) selectClips([clip.id])
    const hasGroup = Boolean(clip.groupId)
    const items: MenuItem[] = [
      { label: 'Split at playhead', shortcut: 'Ctrl+K', onClick: () => actions.split() },
      { label: 'Duplicate', shortcut: 'Ctrl+D', onClick: () => actions.duplicateSelected() },
      { label: 'Copy', shortcut: 'Ctrl+C', onClick: () => actions.copySelection() },
      { label: 'Paste at playhead', shortcut: 'Ctrl+V', onClick: () => actions.paste() },
      { separator: true, label: 'sep1' },
      { label: 'Ripple delete', shortcut: 'Shift+Del', onClick: () => actions.deleteSelected(true) },
      { label: 'Delete', shortcut: 'Del', danger: true, onClick: () => actions.deleteSelected(false) },
      { separator: true, label: 'sep2' },
      { label: 'Group', shortcut: 'Ctrl+G', disabled: selectedClipIds.length < 2, onClick: () => actions.group() },
      { label: 'Ungroup', shortcut: 'Ctrl+Shift+G', disabled: !hasGroup, onClick: () => actions.ungroup() },
      { separator: true, label: 'sep3' },
      {
        label: clip.audio.muted ? 'Unmute clip audio' : 'Mute clip audio',
        onClick: () => updateClipAudio(clip.id, { muted: !clip.audio.muted })
      },
      { label: 'Add 0.4s fades', onClick: () => updateClipAudio(clip.id, { fadeInMs: 400, fadeOutMs: 400 }) },
      {
        label: 'Add marker here',
        onClick: () => addMarker()
      }
    ]
    setMenu({ x: event.clientX, y: event.clientY, items })
  }

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault()
    if (!project) return
    const trackId = trackAt(event.clientY)
    const time = timeAt(event.clientX)
    if (!trackId) return
    const track = project.tracks.find((t) => t.id === trackId)
    if (!track || track.locked) return

    const internalId = event.dataTransfer.getData('application/x-clipwright-clip')
    if (internalId) {
      applyLive((p) => ({
        ...p,
        clips: p.clips.map((c) => (c.id === internalId ? { ...c, start: Math.max(0, time) } : c))
      }))
      commitHistory('Move clip')
      return
    }

    const assetId = event.dataTransfer.getData('application/x-clipwright-asset')
    if (!assetId) return
    const asset = project.assets.find((a) => a.id === assetId)
    if (!asset) return

    const kind: Clip['kind'] =
      asset.kind === 'audio' ? 'audio' : asset.kind === 'image' ? 'image' : track.kind === 'audio' ? 'audio' : 'video'
    const clip = baseClip(kind, trackId, asset.name)
    clip.assetId = asset.id
    clip.start = Math.max(0, Math.round(time))
    clip.duration =
      asset.kind === 'image'
        ? 4000
        : Math.min(asset.probe.durationMs || 4000, 120000)
    clip.sourceDuration = asset.probe.durationMs
    placeClip(clip, clip.start, event.shiftKey ? 'insert' : 'overwrite')
    selectClips([clip.id])
  }

  /* ruler ticks adapt to zoom so labels never collide */
  const ticks = useMemo(() => {
    const candidates = [100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000]
    const step = candidates.find((c) => (c / 1000) * zoom >= 64) ?? 600000
    const out: { time: number; major: boolean }[] = []
    const end = duration + 15000
    for (let t = 0; t <= end; t += step / 2) {
      out.push({ time: t, major: t % step === 0 })
    }
    return out
  }, [zoom, duration])

  if (!project) return <div className="timeline timeline--empty" />

  const secondsDuration = Math.max(1, duration)

  return (
    <div className="timeline">
      <div className="timeline__toolbar">
        <div className="row" style={{ gap: 2 }}>
          <IconButton label="Zoom out" onClick={() => setZoom(zoom / 1.3)}>
            <ZoomOut size={14} />
          </IconButton>
          <IconButton label="Zoom in" onClick={() => setZoom(zoom * 1.3)}>
            <ZoomIn size={14} />
          </IconButton>
          <IconButton
            label="Fit project"
            onClick={() => {
              const scroller = scrollRef.current
              if (!scroller) return
              const available = scroller.clientWidth - HEADER_W - 40
              setZoom(clamp((available / secondsDuration) * 1, 6, 900))
              scroller.scrollLeft = 0
            }}
          >
            <Maximize size={14} />
          </IconButton>
          <div className="divider-v" />
          <IconButton label="Split at playhead" onClick={() => actions.split()}>
            <Scissors size={14} />
          </IconButton>
          <IconButton label="Delete selected" onClick={() => actions.deleteSelected(false)}>
            <Trash2 size={14} />
          </IconButton>
          <IconButton label="Toggle snapping" active={snapping} onClick={() => toggleSnapping()}>
            <Magnet size={14} />
          </IconButton>
          <div className="divider-v" />
          <button className="btn btn--ghost btn--sm" onClick={() => actions.addTrack('video')} title="Add video track">
            <Plus size={12} /> Video
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => actions.addTrack('audio')} title="Add audio track">
            <Plus size={12} /> Audio
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => actions.addTrack('caption')} title="Add caption track">
            <Plus size={12} /> Captions
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => actions.addTrack('text')} title="Add text track">
            <Plus size={12} /> Text
          </button>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <span className="mono muted" style={{ fontSize: 11 }}>
            {formatClock(playhead, true)} / {formatClock(duration, true)}
          </span>
          <span className="badge">{Math.round(zoom)} px/s</span>
        </div>
      </div>

      <div className="timeline__scroll" ref={scrollRef} onWheel={onWheel} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <div className="timeline__inner" style={{ width: HEADER_W + timelineWidth }}>
          <div className="timeline__ruler" style={{ paddingLeft: HEADER_W }}>
            <div className="timeline__ruler-inner" style={{ width: timelineWidth }}>
              {ticks.map((tick, i) => (
                <div
                  key={i}
                  className={clsx('timeline__tick', tick.major && 'timeline__tick--major')}
                  style={{ left: (tick.time / 1000) * zoom }}
                >
                  {tick.major && <span>{formatClock(tick.time)}</span>}
                </div>
              ))}
              {project.markers.map((marker) => (
                <div
                  key={marker.id}
                  className="timeline__marker"
                  style={{ left: (marker.time / 1000) * zoom }}
                  title={`${marker.label} — double-click to delete`}
                  onDoubleClick={() => removeMarker(marker.id)}
                >
                  <span />
                </div>
              ))}
              <div
                className="timeline__playhead-hit"
                onPointerDown={(e) => {
                  dragRef.current = {
                    kind: 'playhead',
                    clipIds: [],
                    startClientX: e.clientX,
                    startClientY: e.clientY,
                    originStarts: {},
                    originDurations: {},
                    originTracks: {}
                  }
                  setPlayhead(timeAt(e.clientX), { snap: false })
                }}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              />
            </div>
          </div>

          <div className="timeline__body" style={{ paddingLeft: HEADER_W }}>
            {trackList.map((track) => {
              const clips = project.clips.filter((c) => c.trackId === track.id)
              const audible = trackIsAudible(project, track)
              return (
                <div
                  key={track.id}
                  className={clsx(
                    'timeline__track',
                    track.locked && 'timeline__track--locked',
                    dropTrack === track.id && 'timeline__track--drop'
                  )}
                  style={{ height: track.height }}
                  onPointerDown={() => setActiveTrack(track.id)}
                >
                  <div
                    className={clsx(
                      'timeline__header',
                      activeTrackId === track.id && 'timeline__header--active'
                    )}
                    style={{ height: track.height, width: HEADER_W }}
                  >
                    <div className="timeline__header-main">
                      <span className="timeline__track-icon">{TRACK_ICON[track.kind]}</span>
                      <input
                        className="timeline__track-name"
                        value={track.name}
                        onChange={(e) => updateTrack(track.id, { name: e.target.value })}
                        spellCheck={false}
                        aria-label={`Track name: ${track.name}`}
                      />
                    </div>
                    <div className="timeline__header-actions">
                      <button
                        className={clsx('tl-toggle', track.muted && 'tl-toggle--on')}
                        title={track.muted ? 'Unmute track' : 'Mute track'}
                        onClick={() => updateTrack(track.id, { muted: !track.muted })}
                      >
                        {track.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
                      </button>
                      <button
                        className={clsx('tl-toggle', track.solo && 'tl-toggle--on-brand')}
                        title="Solo track"
                        onClick={() => updateTrack(track.id, { solo: !track.solo })}
                      >
                        S
                      </button>
                      <button
                        className={clsx('tl-toggle', !track.visible && 'tl-toggle--on')}
                        title={track.visible ? 'Hide track' : 'Show track'}
                        onClick={() => updateTrack(track.id, { visible: !track.visible })}
                      >
                        {track.visible ? <Eye size={11} /> : <EyeOff size={11} />}
                      </button>
                      <button
                        className={clsx('tl-toggle', track.locked && 'tl-toggle--on-brand')}
                        title={track.locked ? 'Unlock track' : 'Lock track'}
                        onClick={() => updateTrack(track.id, { locked: !track.locked })}
                      >
                        {track.locked ? <Lock size={11} /> : <LockOpen size={11} />}
                      </button>
                      <button className="tl-toggle" title="Remove track" onClick={() => actions.removeTrack(track.id)}>
                        ×
                      </button>
                    </div>
                    <div
                      className="timeline__resize"
                      title="Drag to resize track"
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        const startY = e.clientY
                        const startH = track.height
                        const move = (ev: PointerEvent) =>
                          updateTrack(track.id, { height: clamp(startH + (ev.clientY - startY), 34, 220) })
                        const up = () => {
                          window.removeEventListener('pointermove', move)
                          window.removeEventListener('pointerup', up)
                        }
                        window.addEventListener('pointermove', move)
                        window.addEventListener('pointerup', up)
                      }}
                    />
                  </div>

                  <div
                    className="timeline__lane"
                    style={{ width: timelineWidth }}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return
                      if ((e.target as HTMLElement).closest('.timeline__clip')) return
                      if (track.locked) return
                      selectClips([])
                      setActiveTrack(track.id)
                      const rect = scrollRef.current!.getBoundingClientRect()
                      dragRef.current = {
                        kind: 'marquee',
                        clipIds: [],
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                        originStarts: {},
                        originDurations: {},
                        originTracks: {},
                        marqueeStart: { x: e.clientX - rect.left, y: e.clientY - rect.top }
                      }
                    }}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                  >
                    {clips.map((clip) => {
                      const left = (clip.start / 1000) * zoom
                      const width = Math.max(6, (clip.duration / 1000) * zoom)
                      const selected = selectedClipIds.includes(clip.id)
                      const asset = clip.assetId ? project.assets.find((a) => a.id === clip.assetId) : undefined
                      const peaks = asset ? waveforms[asset.id] : undefined
                      return (
                        <div
                          key={clip.id}
                          className={clsx(
                            'timeline__clip',
                            `timeline__clip--${clip.kind}`,
                            selected && 'timeline__clip--selected',
                            !audible && 'timeline__clip--muted'
                          )}
                          style={{ left, width }}
                          onPointerDown={(e) => startMove(e, clip)}
                          onPointerMove={onPointerMove}
                          onPointerUp={onPointerUp}
                          onDoubleClick={() => {
                            selectClips([clip.id])
                            useEditor
                              .getState()
                              .setInspectorTab(
                                clip.kind === 'caption' ? 'caption' : clip.kind === 'text' ? 'text' : 'properties'
                              )
                          }}
                          onContextMenu={(e) => openClipMenu(e, clip)}
                          title={`${clip.name}\n${formatClock(clip.start, true)} → ${formatClock(
                            clip.start + clip.duration,
                            true
                          )}`}
                        >
                          <span
                            className="timeline__clip-edge timeline__clip-edge--left"
                            onPointerDown={(e) => startTrim(e, clip, 'start')}
                          />
                          <div className="timeline__clip-body">
                            <span className="timeline__clip-label truncate">
                              {clip.kind === 'caption' || clip.kind === 'text' ? clip.text ?? clip.name : clip.name}
                            </span>
                            {peaks && (clip.kind === 'audio' || track.kind === 'audio') && asset && (
                              <Waveform
                                peaks={peaks.peaks}
                                samplesPerSecond={peaks.samplesPerSecond}
                                startMs={clip.sourceIn}
                                durationMs={clip.duration}
                              />
                            )}
                            {clip.keyframes && Object.keys(clip.keyframes).length > 0 && (
                              <div className="timeline__clip-kf">
                                {Object.entries(clip.keyframes).flatMap(([prop, list]) =>
                                  (list ?? []).map((kf) => (
                                    <span
                                      key={`${prop}-${kf.id}`}
                                      className="timeline__kf-dot"
                                      style={{ left: `${(kf.t / Math.max(1, clip.duration)) * 100}%` }}
                                      title={`${prop} @ ${formatClock(kf.t, true)}`}
                                    />
                                  ))
                                )}
                              </div>
                            )}
                          </div>
                          <span
                            className="timeline__clip-edge timeline__clip-edge--right"
                            onPointerDown={(e) => startTrim(e, clip, 'end')}
                          />
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
            {guide !== null && <div className="timeline__snap-guide" style={{ left: HEADER_W + (guide / 1000) * zoom }} />}
            <div className="timeline__playhead" style={{ left: HEADER_W + (playhead / 1000) * zoom }} />
          </div>
        </div>
        {marquee && (
          <div
            className="timeline__marquee"
            style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
          />
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}

function Waveform({
  peaks,
  samplesPerSecond,
  startMs,
  durationMs
}: {
  peaks: number[]
  samplesPerSecond: number
  startMs: number
  durationMs: number
}): JSX.Element | null {
  const points = useMemo(() => {
    if (!peaks.length) return ''
    const from = Math.max(0, Math.floor((startMs / 1000) * samplesPerSecond))
    const to = Math.min(peaks.length, Math.ceil(((startMs + durationMs) / 1000) * samplesPerSecond))
    const slice = peaks.slice(from, to)
    if (!slice.length) return ''
    const step = Math.max(1, Math.floor(slice.length / 140))
    const top: string[] = []
    const bottom: string[] = []
    for (let i = 0; i < slice.length; i += step) {
      const x = (i / Math.max(1, slice.length - 1)) * 100
      const amp = Math.max(3, Math.min(1, slice[i]) * 92)
      top.push(`${x.toFixed(2)},${(50 - amp / 2).toFixed(1)}`)
      bottom.unshift(`${x.toFixed(2)},${(50 + amp / 2).toFixed(1)}`)
    }
    return [...top, ...bottom].join(' ')
  }, [peaks, samplesPerSecond, startMs, durationMs])

  if (!points) return null
  return (
    <svg className="timeline__waveform" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      <polygon points={points} />
    </svg>
  )
}
