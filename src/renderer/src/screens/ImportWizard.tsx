/**
 * Import wizard: inspect source, choose crop/aspect, then import.
 * Handles local files and URLs, shows real probe data, and reports clear errors.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, FileVideo, Info, Link2, Loader2, Upload, Wand2 } from 'lucide-react'
import { useEditor } from '../state/editor'
import { useApp } from '../state/app'
import { Badge, Button, Field, Modal, Segmented } from '../components/ui'
import { ASPECT_PRESETS, canvasSizeFor, recommendAspect } from '@shared/presets'
import { formatBytes, formatClock } from '@shared/time'
import { api, errorMessage } from '../lib/api'
import type { MediaAsset, MediaProbe } from '@shared/types'

interface Props {
  open: boolean
  onClose: () => void
  onImported: (assets: MediaAsset[]) => void
  urlMode?: boolean
}

interface InspectedSource {
  path?: string
  url?: string
  name: string
  probe?: MediaProbe
  sizeBytes?: number
  error?: string
  meta?: { strategy: string; note: string; ytdlpAvailable: boolean; durationMs?: number }
}

export function ImportWizard({ open, onClose, onImported, urlMode }: Props): JSX.Element {
  const project = useEditor((s) => s.project)
  const notify = useEditor((s) => s.notify)
  const settings = useApp((s) => s.settings)
  const [sources, setSources] = useState<InspectedSource[]>([])
  const [url, setUrl] = useState('')
  const [inspecting, setInspecting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [aspect, setAspect] = useState('9:16')
  const [mode, setMode] = useState<'managed' | 'linked'>(settings?.storage.defaultImportMode ?? 'managed')
  const [step, setStep] = useState<'source' | 'confirm'>('source')
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (!open) {
      setSources([])
      setUrl('')
      setStep('source')
    }
  }, [open])

  useEffect(() => {
    const probe = sources[0]?.probe
    if (!probe?.width || !probe.height) return
    // Wide sources default to a vertical project: that is the whole point of the app.
    const sourceAspect = recommendAspect(probe.width, probe.height)
    setAspect(sourceAspect === '16:9' || sourceAspect === '21:9' ? '9:16' : sourceAspect)
  }, [sources])

  const pickFiles = async () => {
    const paths = await api.dialog.openMedia()
    if (!paths.length) return
    setInspecting(true)
    try {
      const inspected: InspectedSource[] = []
      for (const file of paths) {
        try {
          // Probe through the import handler without copying yet.
          const result = await api.media.importFiles({ paths: [file], projectId: project?.id ?? 'preview', mode: 'linked' })
          if (result.errors.length) {
            inspected.push({ path: file, name: file.split(/[\\/]/).pop() ?? file, error: result.errors[0].error })
          } else {
            const asset = result.assets[0]
            inspected.push({ path: file, name: asset.name, probe: asset.probe, sizeBytes: asset.sizeBytes })
          }
        } catch (error) {
          inspected.push({ path: file, name: file.split(/[\\/]/).pop() ?? file, error: errorMessage(error) })
        }
      }
      setSources(inspected)
      if (inspected.some((s) => s.probe)) setStep('confirm')
    } finally {
      setInspecting(false)
    }
  }

  const inspectUrl = async () => {
    if (!url.trim()) return
    setInspecting(true)
    try {
      const info = await api.media.inspectUrl(url.trim())
      if (!info.ok) {
        setSources([{ url: url.trim(), name: url.trim(), error: info.error, meta: { strategy: info.strategy, note: info.note, ytdlpAvailable: info.ytdlpAvailable } }])
        return
      }
      setSources([
        {
          url: url.trim(),
          name: info.title ?? url.trim(),
          meta: { strategy: info.strategy, note: info.note, ytdlpAvailable: info.ytdlpAvailable },
          probe: info.durationMs
            ? { kind: 'video', durationMs: info.durationMs, hasAudio: true }
            : undefined
        }
      ])
      setStep('confirm')
    } catch (error) {
      setSources([{ url: url.trim(), name: url.trim(), error: errorMessage(error) }])
    } finally {
      setInspecting(false)
    }
  }

  const first = sources[0]
  const probe = first?.probe
  const cropSize = useMemo(() => canvasSizeFor(aspect, 1080), [aspect])
  const validSources = sources.filter((s) => !s.error)

  const doImport = async () => {
    if (!project) return
    setImporting(true)
    try {
      const imported: MediaAsset[] = []
      for (const source of validSources) {
        if (source.url) {
          const asset = await api.media.importUrl({ url: source.url, projectId: project.id, mode })
          imported.push(asset)
        } else if (source.path) {
          const result = await api.media.importFiles({ paths: [source.path], projectId: project.id, mode })
          if (result.errors.length) throw new Error(result.errors[0].error)
          imported.push(...result.assets)
        }
      }
      // Apply the chosen canvas aspect to the project.
      if (/^\d+:\d+$/.test(aspect)) {
        const size = canvasSizeFor(aspect, Math.max(project.canvas.width, project.canvas.height))
        useEditor.getState().apply(
          (p) => ({ ...p, canvas: { ...p.canvas, aspect, width: size.width, height: size.height } }),
          'Set project aspect'
        )
      }
      onImported(imported)
      notify({ kind: 'success', title: `${imported.length} file(s) imported`, body: `Project canvas is ${aspect}` })
      onClose()
    } catch (error) {
      notify({ kind: 'error', title: 'Import failed', body: errorMessage(error) })
    } finally {
      setImporting(false)
    }
  }

  return (
    <Modal
      open={open}
      size="wide"
      title="Import media"
      subtitle="Inspect the source, then choose the frame your project will use."
      onClose={onClose}
      footer={
        step === 'confirm' ? (
          <>
            <Button onClick={() => setStep('source')}>Back</Button>
            <Button variant="primary" onClick={() => void doImport()} loading={importing} icon={<ArrowRight size={13} />}>
              Import {validSources.length > 1 ? `${validSources.length} files` : 'and continue'}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Cancel</Button>
        )
      }
    >
      {step === 'source' && (
        <div className="stack-lg">
          <div className="import-drop" onClick={() => void pickFiles()}>
            <Upload size={22} />
            <div>
              <div style={{ fontWeight: 600 }}>Choose video, audio or image files</div>
              <div className="hint">MP4 · MOV · MKV · WebM · MP3 · WAV · FLAC · PNG · JPG · WebP · SVG</div>
            </div>
          </div>
          <div className="row" style={{ gap: 12 }}>
            <div className="divider grow" />
            <span className="muted" style={{ fontSize: 11 }}>
              or
            </span>
            <div className="divider grow" />
          </div>
          <Field label="Video URL" hint="Direct media links download immediately. Page links need yt-dlp installed; only download content you have rights to use.">
            <div className="row">
              <input
                className="input"
                placeholder="https://example.com/video.mp4"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void inspectUrl()}
              />
              <Button onClick={() => void inspectUrl()} loading={inspecting} icon={<Link2 size={13} />}>
                Check
              </Button>
            </div>
          </Field>
          {inspecting && (
            <div className="row muted" style={{ fontSize: 12 }}>
              <Loader2 size={13} className="spin" /> Inspecting…
            </div>
          )}
          {sources.length > 0 && sources.every((s) => s.error) && (
            <div className="callout callout--danger">
              {sources.map((s, i) => (
                <div key={i}>
                  <strong>{s.name}</strong>
                  <div className="hint" style={{ color: 'inherit' }}>{s.error}</div>
                </div>
              ))}
            </div>
          )}
          {urlMode && <div className="hint">Paste a link from a source you are allowed to download.</div>}
        </div>
      )}

      {step === 'confirm' && first && (
        <div className="import-confirm">
          <div className="import-confirm__preview">
            {first.path && (probe?.kind === 'video' || !probe) ? (
              <video
                ref={videoRef}
                src={api.mediaUrl(first.path)}
                muted
                controls
                playsInline
                style={{ width: '100%', borderRadius: 8, background: '#000' }}
              />
            ) : (
              <div className="import-confirm__placeholder">
                <FileVideo size={26} />
                <span>{first.name}</span>
              </div>
            )}
            <div className="import-confirm__cropinfo">
              <div className="label">Crop preview — {aspect}</div>
              <div
                className="crop-frame"
                style={{ aspectRatio: aspect.replace(':', '/') }}
              >
                <div className="crop-frame__inner">
                  {first.path && probe?.kind === 'video' && (
                    <video src={api.mediaUrl(first.path)} muted autoPlay loop playsInline />
                  )}
                </div>
              </div>
              <div className="hint">
                Output canvas {cropSize.width} × {cropSize.height}. You can reframe and change the aspect at
                any time inside the editor.
              </div>
            </div>
          </div>

          <div className="import-confirm__details stack-md">
            <div className="label">Source</div>
            <div className="card">
              <div style={{ fontWeight: 600, marginBottom: 6 }} className="truncate">
                {first.name}
              </div>
              <div className="import-facts">
                <Fact label="Resolution" value={probe?.width ? `${probe.width} × ${probe.height}` : '—'} />
                <Fact label="Frame rate" value={probe?.fps ? `${probe.fps} fps${probe.vfr ? ' (variable)' : ''}` : '—'} />
                <Fact label="Duration" value={probe?.durationMs ? formatClock(probe.durationMs, true) : '—'} />
                <Fact label="Rotation" value={probe?.rotation ? `${probe.rotation}°` : 'none'} />
                <Fact label="Audio" value={probe?.hasAudio ? probe.audioCodec ?? 'yes' : 'none'} />
                <Fact label="Codec" value={probe?.videoCodec ?? '—'} />
                <Fact label="Size" value={formatBytes(first.sizeBytes)} />
                <Fact label="Aspect" value={probe?.width && probe.height ? recommendAspect(probe.width, probe.height) : '—'} />
              </div>
              {first.meta && (
                <div className="hint" style={{ marginTop: 8 }}>
                  <Info size={11} style={{ verticalAlign: -1 }} /> {first.meta.note}
                </div>
              )}
            </div>

            <Field label="Project crop / aspect ratio">
              <div className="aspect-grid aspect-grid--compact">
                {ASPECT_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    className={`aspect-option ${aspect === preset.id ? 'aspect-option--active' : ''}`}
                    onClick={() => setAspect(preset.id)}
                  >
                    <div className="aspect-option__label">{preset.id === 'original' ? 'Original' : preset.id}</div>
                    <div className="aspect-option__note">{preset.note}</div>
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Store media">
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  { id: 'managed', label: 'Copy into project (recommended)' },
                  { id: 'linked', label: 'Link to original' }
                ]}
              />
            </Field>

            {sources.length > 1 && (
              <div className="hint">{sources.length} files will be imported and added to the library.</div>
            )}
            <div className="callout">
              <Wand2 size={13} />
              <div>
                <strong>Next:</strong> generate a transcript, then let Clipwright find the strongest
                moments. You can also skip straight to manual editing.
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

function Fact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="fact">
      <span className="fact__label">{label}</span>
      <span className="fact__value mono">{value}</span>
    </div>
  )
}
