/**
 * Preview monitor: canvas render of the timeline plus direct manipulation
 * (drag to move, corner handles to scale, rotate handle), zoom, safe areas.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Crosshair,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Square,
  Volume2,
  VolumeX
} from 'lucide-react'
import { useEditor } from '../state/editor'
import { togglePlayback } from '../state/playback'
import { IconButton } from './ui'
import { formatTimecode } from '@shared/time'
import { drawScene, layerBounds } from '../lib/preview-canvas'
import { buildScene } from '@shared/scene'
import { useVideoPool } from '../hooks/useVideoPool'
import type { SceneLayer } from '@shared/scene'

type DragMode =
  | { kind: 'move'; startX: number; startY: number; originX: number; originY: number }
  | {
      kind: 'scale'
      corner: string
      startX: number
      startY: number
      originScaleX: number
      originScaleY: number
    }
  | { kind: 'rotate'; localX: number; localY: number; startAngle: number; originRotation: number }

export function PreviewMonitor(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { project, playhead, playing, selectedClipIds, showSafeAreas, showTransformHandles } = useEditor()
  const setPlaying = useEditor((s) => s.setPlaying)
  const setPlayhead = useEditor((s) => s.setPlayhead)
  const selectClips = useEditor((s) => s.selectClips)
  const setClipTransform = useEditor((s) => s.setClipTransform)
  const finishTransformDrag = useEditor((s) => s.finishTransformDrag)
  const setShowSafeAreas = useEditor((s) => s.setShowSafeAreas)
  const setShowTransformHandles = useEditor((s) => s.setShowTransformHandles)
  const snapping = useEditor((s) => s.snapping)
  const duration = useEditor((s) => (s.project ? s.project.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0) : 0))

  const [frame, setFrame] = useState(0)
  const [muted, setMuted] = useState(false)
  const [fit, setFit] = useState<'fit' | 'actual'>('fit')
  /* The stage is measured rather than trusted to CSS: whatever the window does,
     the frame is computed from the real pixel box so it can never overflow. */
  const [box, setBox] = useState({ width: 0, height: 0 })
  const stageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragMode | null>(null)
  const movedRef = useRef(false)
  const justDraggedRef = useRef(false)

  const requestDraw = useCallback(() => setFrame((f) => f + 1), [])
  const pool = useVideoPool(project, playhead, playing, requestDraw)

  const selectedClip = useMemo(
    () => project?.clips.find((c) => c.id === selectedClipIds[0]) ?? null,
    [project, selectedClipIds]
  )

  /** Track the stage box so the frame can be sized to fit it exactly. */
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = () =>
      setBox((prev) => {
        const width = stage.clientWidth
        const height = stage.clientHeight
        return prev.width === width && prev.height === height ? prev : { width, height }
      })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  /** Canvas backing size follows the project canvas; CSS size fits the panel. */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !project || !pool) return
    if (canvas.width !== project.canvas.width || canvas.height !== project.canvas.height) {
      canvas.width = project.canvas.width
      canvas.height = project.canvas.height
    }
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    drawScene({
      project,
      time: playhead,
      ctx,
      width: canvas.width,
      height: canvas.height,
      media: pool.lookup,
      showSafeAreas,
      selectedIds: showTransformHandles ? [] : selectedClipIds
    })
  }, [project, playhead, pool, showSafeAreas, selectedClipIds, showTransformHandles, frame])

  const aspect = project ? project.canvas.width / project.canvas.height : 9 / 16

  /* ------------------------- direct manipulation ------------------------- */

  const normalised = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height }
  }

  const onPointerDown = (event: React.PointerEvent) => {
    if (!project || !selectedClip) return
    const point = normalised(event.clientX, event.clientY)
    const handle = (event.target as HTMLElement).dataset.handle
    movedRef.current = false
    ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)

    if (handle && handle.startsWith('scale')) {
      dragRef.current = {
        kind: 'scale',
        corner: handle,
        startX: point.x,
        startY: point.y,
        originScaleX: selectedClip.transform.scaleX,
        originScaleY: selectedClip.transform.scaleY
      }
      return
    }
    if (handle === 'rotate') {
      const centreX = selectedClip.transform.x
      const centreY = selectedClip.transform.y
      dragRef.current = {
        kind: 'rotate',
        localX: centreX,
        localY: centreY,
        startAngle: Math.atan2(point.y - centreY, point.x - centreX),
        originRotation: selectedClip.transform.rotation
      }
      return
    }
    dragRef.current = {
      kind: 'move',
      startX: point.x,
      startY: point.y,
      originX: selectedClip.transform.x,
      originY: selectedClip.transform.y
    }
  }

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || !selectedClip || !project) return
    const point = normalised(event.clientX, event.clientY)
    const aspectRatio = project.canvas.width / project.canvas.height
    if (drag.kind === 'move') {
      const dx = point.x - drag.startX
      const dy = point.y - drag.startY
      if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) movedRef.current = true
      let nx = drag.originX + dx
      let ny = drag.originY + dy
      if (snapping) {
        const targets = [0.25, 1 / 3, 0.5, 2 / 3, 0.75]
        for (const t of targets) {
          if (Math.abs(nx - t) < 0.012) nx = t
          if (Math.abs(ny - t) < 0.012) ny = t
        }
      }
      setClipTransform(selectedClip.id, {
        x: Math.max(-0.5, Math.min(1.5, nx)),
        y: Math.max(-0.5, Math.min(1.5, ny))
      })
    } else if (drag.kind === 'scale') {
      const signX = drag.corner.includes('e') ? 1 : -1
      const signY = drag.corner.includes('s') ? 1 : -1
      const nextX = Math.max(0.02, drag.originScaleX + (point.x - drag.startX) * 2 * signX)
      const nextY = Math.max(0.02, drag.originScaleY + (point.y - drag.startY) * 2 * signY)
      movedRef.current = true
      setClipTransform(selectedClip.id, event.shiftKey ? { scaleX: nextX, scaleY: nextY } : { scaleX: nextX, scaleY: nextX })
    } else {
      const angle = Math.atan2(point.y - drag.localY, (point.x - drag.localX) * aspectRatio)
      const delta = ((angle - drag.startAngle) * 180) / Math.PI
      let rotation = drag.originRotation + delta
      if (event.shiftKey) rotation = Math.round(rotation / 15) * 15
      movedRef.current = true
      setClipTransform(selectedClip.id, { rotation })
    }
  }

  const endDrag = () => {
    const wasDragging = dragRef.current !== null
    dragRef.current = null
    justDraggedRef.current = wasDragging && movedRef.current
    if (wasDragging && movedRef.current && selectedClip) finishTransformDrag(selectedClip.id)
  }

  /** Click on the canvas selects the topmost layer under the pointer. */
  const onCanvasClick = (event: React.MouseEvent) => {
    if (!project || dragRef.current || movedRef.current) return
    // A click that dragged a handle is a transform edit, not a selection change.
    if (justDraggedRef.current) {
      justDraggedRef.current = false
      return
    }
    const point = normalised(event.clientX, event.clientY)
    const canvas = canvasRef.current
    if (!canvas) return
    const scene = buildScene(project, playhead)
    const hit = [...scene.layers]
      .reverse()
      .find((layer) => {
        if (layer.hidden || layer.opacity < 0.05) return false
        const rect = layerBounds(layer, canvas.width, canvas.height)
        const x = rect.x / canvas.width
        const y = rect.y / canvas.height
        const w = rect.w / canvas.width
        const h = rect.h / canvas.height
        return point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h
      })
    selectClips(hit ? [hit.id] : [])
  }

  const bounds = useMemo(() => {
    if (!project || !selectedClip) return null
    const scaleX = selectedClip.transform.scaleX * selectedClip.transform.scale
    const scaleY = selectedClip.transform.scaleY * selectedClip.transform.scale
    // Text and graphic layers are inset relative to the canvas, media fills it.
    const baseW = project.canvas.width * 0.5
    const baseH = project.canvas.height * 0.5
    return {
      x: selectedClip.transform.x * project.canvas.width - (baseW * scaleX) / 2,
      y: selectedClip.transform.y * project.canvas.height - (baseH * scaleY) / 2,
      w: baseW * scaleX,
      h: baseH * scaleY
    }
  }, [project, selectedClip])

  const resetTransform = () => {
    if (!selectedClip) return
    setClipTransform(selectedClip.id, {
      x: 0.5,
      y: 0.5,
      scale: 1,
      scaleX: 1,
      scaleY: 1,
      rotation: 0
    })
    finishTransformDrag(selectedClip.id)
  }

  /*
   * Frame size, in order of preference:
   *   • measured  — fit the largest box of the project's aspect ratio inside the
   *                 stage, so a 9:16 project and a 16:9 project both use the
   *                 whole panel instead of one of them being letterboxed badly;
   *   • fallback  — CSS aspect-ratio + max-* before the first measurement.
   * "Actual size" is a pixel-for-pixel 1:1 view that scrolls if it overflows.
   */
  const stageWidth = Math.max(0, box.width - 2)
  const stageHeight = Math.max(0, box.height - 2)
  const fitted =
    stageWidth > 0 && stageHeight > 0
      ? stageWidth / stageHeight > aspect
        ? { width: Math.floor(stageHeight * aspect), height: stageHeight }
        : { width: stageWidth, height: Math.floor(stageWidth / aspect) }
      : null
  const frameStyle: React.CSSProperties = {
    aspectRatio: String(aspect),
    ...(fit === 'actual'
      ? {
          width: project ? project.canvas.width : undefined,
          height: project ? project.canvas.height : undefined,
          maxWidth: 'none',
          maxHeight: 'none'
        }
      : fitted
        ? { width: fitted.width, height: fitted.height }
        : { maxWidth: '100%', maxHeight: '100%' })
  }

  const stepFrame = (dir: 1 | -1) => {
    const fps = project?.fps ?? 30
    setPlayhead(playhead + (dir * 1000) / fps, { snap: false })
  }

  return (
    <div className="preview">
        <div
        className={`preview__stage${fit === 'actual' ? ' preview__stage--scroll' : ''}`}
        ref={stageRef}
      >
        <div className="preview__frame" style={frameStyle}>
          <canvas
            ref={canvasRef}
            className="preview__canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onClick={onCanvasClick}
            style={{ cursor: selectedClip ? 'move' : 'default' }}
          />
          {showTransformHandles && bounds && selectedClip && project && (
            <div
              className="preview__handles"
              style={{
                left: `${(bounds.x / project.canvas.width) * 100}%`,
                top: `${(bounds.y / project.canvas.height) * 100}%`,
                width: `${(bounds.w / project.canvas.width) * 100}%`,
                height: `${(bounds.h / project.canvas.height) * 100}%`,
                transform: `rotate(${selectedClip.transform.rotation}deg)`
              }}
            >
              {['nw', 'ne', 'sw', 'se'].map((corner) => (
                <span
                  key={corner}
                  data-handle={`scale-${corner}`}
                  className={`preview__handle preview__handle--${corner}`}
                />
              ))}
              <span data-handle="rotate" className="preview__rotate" title="Drag to rotate (Shift snaps 15°)">
                <RotateCcw size={11} />
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="preview__transport">
        <div className="row" style={{ gap: 2 }}>
          <IconButton label="Jump to start" onClick={() => setPlayhead(0, { snap: false })}>
            <SkipBack size={15} />
          </IconButton>
          <IconButton label="Previous frame" onClick={() => stepFrame(-1)}>
            <RotateCcw size={13} style={{ transform: 'scaleX(-1)' }} />
          </IconButton>
          <IconButton label={playing ? 'Pause' : 'Play'} active={playing} onClick={() => togglePlayback()}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </IconButton>
          <IconButton label="Next frame" onClick={() => stepFrame(1)}>
            <RotateCcw size={13} />
          </IconButton>
          <IconButton label="Jump to end" onClick={() => setPlayhead(duration, { snap: false })}>
            <SkipForward size={15} />
          </IconButton>
        </div>

        <div className="mono preview__timecode">
          {formatTimecode(playhead, project?.fps ?? 30)}
          <span className="muted" style={{ marginLeft: 8, fontSize: 11 }}>
            {formatTimecode(duration, project?.fps ?? 30)}
          </span>
        </div>

        <div className="row" style={{ gap: 4 }}>
          <IconButton label={muted ? 'Unmute preview' : 'Mute preview'} onClick={() => setMuted(!muted)}>
            {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </IconButton>
          <IconButton
            label="Toggle safe areas and thirds"
            active={showSafeAreas}
            onClick={() => setShowSafeAreas(!showSafeAreas)}
          >
            <Square size={14} />
          </IconButton>
          <IconButton
            label="Transform handles"
            active={showTransformHandles}
            onClick={() => setShowTransformHandles(!showTransformHandles)}
          >
            <Crosshair size={14} />
          </IconButton>
          <IconButton label="Reset transform" disabled={!selectedClip} onClick={resetTransform}>
            <RotateCcw size={14} />
          </IconButton>
          <IconButton
            label={fit === 'fit' ? 'Actual size' : 'Fit to panel'}
            onClick={() => setFit(fit === 'fit' ? 'actual' : 'fit')}
          >
            {fit === 'fit' ? <Maximize2 size={13} /> : <Minimize2 size={13} />}
          </IconButton>
        </div>
      </div>
    </div>
  )
}
