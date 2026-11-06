/** Export dialog: presets, queue, progress, validation results. */
import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  CheckCircle2,
  CircleSlash,
  Cpu,
  Download,
  FolderOpen,
  HardDrive,
  Loader2,
  Play,
  RefreshCw,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import { useEditor } from '../state/editor'
import { useApp } from '../state/app'
import { Badge, Button, Field, Modal, ProgressBar, Segmented, Slider, Switch } from '../components/ui'
import { formatBytes, formatClock } from '@shared/time'
import { api, errorMessage } from '../lib/api'
import type { CapabilityReport, ExportJob, ExportRequest } from '@shared/types'

interface Props {
  open: boolean
  onClose: () => void
}

const RESOLUTIONS = [
  { id: '720p', label: '720p', note: '1280 × 720' },
  { id: '1080p', label: '1080p', note: '1920 × 1080 — recommended' },
  { id: '1440p', label: '1440p', note: '2560 × 1440' },
  { id: 'dci2k', label: 'DCI 2K', note: '2048 × 1080' },
  { id: '4k', label: '4K', note: '3840 × 2160' }
] as const

export function ExportPanel({ open, onClose }: Props): JSX.Element {
  const project = useEditor((s) => s.project)
  const notify = useEditor((s) => s.notify)
  const settings = useApp((s) => s.settings)
  const [jobs, setJobs] = useState<ExportJob[]>([])
  const [resolution, setResolution] = useState<'720p' | '1080p' | '1440p' | 'dci2k' | '4k'>(
    settings?.export.defaultResolution ?? '1080p'
  )
  const [fps, setFps] = useState(settings?.export.defaultFps ?? project?.fps ?? 30)
  const [useHardware, setUseHardware] = useState(settings?.export.hardwareEncoder ?? true)
  /* Ask the main process what this machine can actually do; the toggle is only
     offered when NVENC exists. */
  const [hasNvenc, setHasNvenc] = useState(true)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void api.app
      .capabilities()
      .then((caps: CapabilityReport) => {
        if (!cancelled) setHasNvenc(Boolean(caps.nvenc))
      })
      .catch(() => {
        /* keep the optimistic default; the renderer falls back anyway */
      })
    return () => {
      cancelled = true
    }
  }, [open])
  const [format, setFormat] = useState<'mp4' | 'mov'>('mp4')
  const [crf, setCrf] = useState(settings?.export.crf ?? 19)
  const [optimize, setOptimize] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [showQueue, setShowQueue] = useState(false)
  const [estimate, setEstimate] = useState<{ durationMs: number; frames: number; estimateMs: number } | null>(null)

  useEffect(() => {
    if (!open) return
    void refresh()
    const off = api.events.onExportUpdate(() => void refresh())
    return off
  }, [open])

  useEffect(() => {
    if (project) setFps(project.fps)
  }, [project?.fps])

  const refresh = async () => {
    const list = await api.exports.list()
    setJobs(list)
  }

  const portrait = project ? project.canvas.height >= project.canvas.width : true

  const outputSize = useMemo(() => {
    const map: Record<string, [number, number]> = {
      '720p': [1280, 720],
      '1080p': [1920, 1080],
      '1440p': [2560, 1440],
      dci2k: [2048, 1080],
      '4k': [3840, 2160]
    }
    const [long, short] = map[resolution]
    return portrait ? { width: short, height: long } : { width: long, height: short }
  }, [resolution, portrait])

  const duration = project?.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0) ?? 0

  const start = async () => {
    if (!project) return
    setSubmitting(true)
    try {
      const request: ExportRequest = {
        projectId: project.id,
        projectName: project.name,
        // `resolution` selects the pixel ladder; explicit width/height make the
        // chosen resolution authoritative even when the project aspect is odd.
        presetId: resolution,
        width: outputSize.width,
        height: outputSize.height,
        fps,
        aspect: project.canvas.aspect,
        hardware: useHardware,
        burnCaptions: true
      }
      const job = await api.exports.enqueue(request)
      notify({ kind: 'success', title: 'Export queued', body: `${outputSize.width} × ${outputSize.height} · ${fps} fps` })
      setShowQueue(true)
      await refresh()
      void job
    } catch (error) {
      notify({ kind: 'error', title: 'Could not start export', body: errorMessage(error) })
    } finally {
      setSubmitting(false)
    }
  }

  const BUSY: ExportJob['status'][] = ['queued', 'preparing', 'rendering', 'encoding', 'validating']
  const active = jobs.filter((j) => BUSY.includes(j.status))

  return (
    <Modal
      open={open}
      size="wide"
      title="Export video"
      subtitle="Rendered with ffmpeg from the project timeline — the preview window is never recorded."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button onClick={() => setShowQueue((v) => !v)} icon={<RefreshCw size={13} />}>
            {showQueue ? 'Export settings' : `Queue (${active.length} active)`}
          </Button>
          {!showQueue && (
            <Button variant="primary" icon={<Play size={13} />} loading={submitting} onClick={() => void start()}>
              Start export
            </Button>
          )}
        </>
      }
    >
      {!showQueue ? (
        <div className="export-grid">
          <div className="stack-md">
            <Field label="Resolution">
              <div className="res-list">
                {RESOLUTIONS.map((r) => (
                  <button
                    key={r.id}
                    className={clsx('res-option', resolution === r.id && 'res-option--active')}
                    onClick={() => setResolution(r.id)}
                  >
                    <span className="res-option__name">{r.label}</span>
                    <span className="res-option__note">{r.note}</span>
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Frame rate">
              <Segmented
                value={String(fps)}
                onChange={(v) => setFps(Number(v))}
                options={[
                  { id: '24', label: '24' },
                  { id: '30', label: '30' },
                  { id: '60', label: '60' }
                ]}
              />
            </Field>
            <Field label="Container">
              <Segmented
                value={format}
                onChange={setFormat}
                options={[
                  { id: 'mp4', label: 'MP4 (H.264)' },
                  { id: 'mov', label: 'MOV (H.264)' }
                ]}
              />
            </Field>
          </div>
          <div className="stack-md">
            <div className="export-summary card">
              <div className="label">Output</div>
              <div className="export-summary__size mono">
                {outputSize.width} × {outputSize.height}
              </div>
              <div className="export-summary__rows">
                <div>
                  <span>Duration</span>
                  <span className="mono">{formatClock(duration, true)}</span>
                </div>
                <div>
                  <span>Aspect</span>
                  <span className="mono">{project?.canvas.aspect}</span>
                </div>
                <div>
                  <span>Codec</span>
                  <span className="mono">{useHardware ? 'H.264 (NVENC → x264)' : 'H.264 (x264)'}</span>
                </div>
                <div>
                  <span>Quality</span>
                  <span className="mono">CRF {crf}</span>
                </div>
                <div>
                  <span>Audio</span>
                  <span className="mono">AAC 256 kbps 48 kHz</span>
                </div>
              </div>
            </div>
            <Field label={`Quality (CRF ${crf})`} hint="Lower is better quality and larger files. 19 is visually lossless for social media.">
              <Slider value={crf} min={14} max={30} onChange={setCrf} format={(v) => String(v)} />
            </Field>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12.5 }}>
                <Cpu size={12} style={{ verticalAlign: -2 }} /> Hardware encoding when available
              </span>
              <Switch
                label="Hardware encoding"
                checked={useHardware && hasNvenc}
                disabled={!hasNvenc}
                onChange={setUseHardware}
              />
            </div>
            {!hasNvenc && (
              <div className="hint">
                This PC has no NVIDIA NVENC encoder, so exports run on the CPU (libx264). That is
                normal and needs no setting — it is only slower.
              </div>
            )}
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12.5 }}>Web-optimised (fast start)</span>
              <Switch label="Fast start" checked={optimize} onChange={setOptimize} />
            </div>
            {!useHardware && (
              <div className="hint">Software encoding is slower but always available and more predictable.</div>
            )}
          </div>
        </div>
      ) : (
        <div className="export-queue">
          {jobs.length === 0 && <div className="hint">No exports yet.</div>}
          {jobs.map((job) => (
            <div key={job.id} className="export-job">
              <div className="export-job__head">
                <div className="row">
                  <StatusIcon status={job.status} />
                  <span style={{ fontWeight: 600, fontSize: 13 }} className="truncate">
                    {job.filename}
                  </span>
                  <Badge tone={job.status === 'done' ? 'success' : job.status === 'failed' ? 'danger' : 'info'}>
                    {job.status}
                  </Badge>
                </div>
                <div className="row">
                  {BUSY.includes(job.status) && job.status !== 'queued' && (
                    <Button size="sm" variant="ghost" onClick={() => void api.exports.cancel(job.id)}>
                      Cancel
                    </Button>
                  )}
                  {job.status === 'failed' && (
                    <Button size="sm" variant="ghost" onClick={() => void api.exports.retry(job.id).then(refresh)}>
                      Retry
                    </Button>
                  )}
                  {job.status === 'done' && (
                    <>
                      <Button size="sm" variant="ghost" icon={<FolderOpen size={11} />} onClick={() => void api.exports.openFolder(job.outputPath)}>
                        Show file
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void api.app.openPath(job.outputPath)}>
                        Play
                      </Button>
                    </>
                  )}
                  <Button size="sm" variant="ghost" icon={<Trash2 size={11} />} onClick={() => void api.exports.remove(job.id).then(refresh)}>
                    Remove
                  </Button>
                </div>
              </div>
              {(job.status === 'rendering' || job.status === 'encoding' || job.status === 'validating' || job.status === 'preparing') && (
                <div style={{ marginTop: 6 }}>
                  <ProgressBar percent={job.progress} />
                  <div className="row-between" style={{ marginTop: 4 }}>
                    <span className="hint">
                      {job.status}
                      {job.framesTotal ? ` — frame ${job.framesDone ?? 0} of ${job.framesTotal}` : ''}
                    </span>
                    <span className="mono muted" style={{ fontSize: 11 }}>
                      {Math.round(job.progress)}%
                    </span>
                  </div>
                </div>
              )}
              {job.status === 'done' && (
                <div className="export-job__result">
                  <span className="mono">{formatBytes(job.validation?.sizeBytes ?? 0)}</span>
                  {job.validation?.ok ? (
                    <span className="export-job__ok">
                      <CheckCircle2 size={12} /> verified output
                      <span className="muted">
                        {' '}
                        · {job.validation.width}×{job.validation.height} ·{' '}
                        {job.validation.durationMs ? formatClock(job.validation.durationMs, true) : ''} ·{' '}
                        {job.validation.fps ? `${job.validation.fps.toFixed(2)} fps` : ''}
                      </span>
                    </span>
                  ) : (
                    <span className="export-job__warn">
                      <TriangleAlert size={12} />{' '}
                      {job.validation
                        ? job.validation.problems.join(' ') || 'validation failed'
                        : 'not validated — dimensions/sync were not re-checked'}
                    </span>
                  )}
                </div>
              )}
              {job.status === 'failed' && <div className="export-job__error">{job.error}</div>}
              {job.warnings?.length ? (
                <div className="export-job__warning">
                  {job.warnings.map((warning) => (
                    <div key={warning}>{warning}</div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

function StatusIcon({ status }: { status: ExportJob['status'] }): JSX.Element {
  switch (status) {
    case 'done':
      return <CheckCircle2 size={14} style={{ color: 'var(--success)' }} />
    case 'failed':
      return <X size={14} style={{ color: 'var(--danger)' }} />
    case 'cancelled':
      return <CircleSlash size={14} className="muted" />
    case 'rendering':
    case 'encoding':
    case 'validating':
    case 'preparing':
      return <Loader2 size={14} className="spin" style={{ color: 'var(--brand)' }} />
    default:
      return <HardDrive size={14} className="muted" />
  }
}
