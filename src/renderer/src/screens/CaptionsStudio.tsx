/**
 * Captions studio: generate captions from the transcript, restyle them with
 * presets, edit individual lines, and import/export SRT or WebVTT.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Captions, Download, Plus, Trash2, Upload, Wand2, X } from 'lucide-react'
import { useEditor } from '../state/editor'
import { useApp } from '../state/app'
import { Badge, Button, EmptyState, Field, Modal, Segmented, Slider, Switch } from '../components/ui'
import { buildCaptionClips } from '@shared/captions'
import { BASE_TEXT_STYLE, FONT_STACKS } from '@shared/presets'
import { makeTrack } from '@shared/timeline'
import { formatClock } from '@shared/time'
import { api, errorMessage } from '../lib/api'
import type { CaptionPreset, Clip, TextStyle } from '@shared/types'

export function CaptionsStudio(): JSX.Element {
  const { project, playhead } = useEditor()
  const notify = useEditor((s) => s.notify)
  const apply = useEditor((s) => s.apply)
  const selectClips = useEditor((s) => s.selectClips)
  const { captionPresets, refreshCaptionPresets } = useApp()
  const [editing, setEditing] = useState<CaptionPreset | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [presetId, setPresetId] = useState('')

  useEffect(() => {
    if (!presetId && captionPresets.length) setPresetId(captionPresets[0].id)
  }, [captionPresets, presetId])

  const captions = useMemo(
    () => (project ? project.clips.filter((c) => c.kind === 'caption').sort((a, b) => a.start - b.start) : []),
    [project]
  )

  const savePreset = async (preset: CaptionPreset) => {
    try {
      await api.ai.saveCaptionPreset(preset)
      await refreshCaptionPresets()
      setEditing(null)
      notify({ kind: 'success', title: 'Preset saved' })
    } catch (error) {
      notify({ kind: 'error', title: 'Could not save preset', body: errorMessage(error) })
    }
  }

  const applyToAll = (preset: CaptionPreset) => {
    apply(
      (p) => ({
        ...p,
        clips: p.clips.map((c) =>
          c.kind === 'caption'
            ? {
                ...c,
                captionPresetId: preset.id,
                style: { ...preset.style },
                layout: { ...preset.layout },
                animation: preset.animation,
                animationDurationMs: preset.animationDurationMs,
                highlightMode: preset.highlightMode
              }
            : c
        )
      }),
      'Apply caption preset'
    )
    notify({
      kind: 'success',
      title: `${preset.name} applied to ${captions.length} caption${captions.length === 1 ? '' : 's'}`
    })
  }

  const generateFromTranscript = async () => {
    if (!project) return
    setBusy('generate')
    try {
      const transcript = await api.ai.transcript(project.id)
      if (!transcript) {
        notify({
          kind: 'warning',
          title: 'No transcript yet',
          body: 'Open Clips → Transcript and transcribe the source first.'
        })
        return
      }
      const preset = captionPresets.find((p) => p.id === presetId) ?? captionPresets[0]
      const end = transcript.segments.length
        ? transcript.segments[transcript.segments.length - 1].end
        : 0
      apply(
        (p) => {
          const existing = p.tracks.find((t) => t.kind === 'caption')
          const track = existing ?? makeTrack('caption', 'Captions', p.tracks.length)
          const clips = buildCaptionClips(transcript.segments, { start: 0, end }, preset, track.id, 0)
          return {
            ...p,
            tracks: existing ? p.tracks : [...p.tracks, track],
            clips: [...p.clips.filter((c) => c.kind !== 'caption'), ...clips]
          }
        },
        'Generate captions'
      )
      notify({ kind: 'success', title: 'Captions generated from the transcript' })
    } catch (error) {
      notify({ kind: 'error', title: 'Caption generation failed', body: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const importSubtitles = async () => {
    if (!project) return
    try {
      const existing = project.tracks.find((t) => t.kind === 'caption')
      const trackId = existing?.id ?? makeTrack('caption', 'Captions', project.tracks.length).id
      const clips = await api.ai.importSubtitles(trackId)
      if (!clips?.length) return
      apply(
        (p) => {
          const hasTrack = p.tracks.some((t) => t.id === trackId)
          const track = hasTrack ? p.tracks : [...p.tracks, makeTrack('caption', 'Captions', p.tracks.length)]
          const preset = captionPresets.find((x) => x.id === presetId) ?? captionPresets[0]
          return {
            ...p,
            tracks: track,
            clips: [
              ...p.clips,
              ...clips.map((clip) =>
                preset
                  ? {
                      ...clip,
                      trackId,
                      style: { ...preset.style },
                      layout: { ...preset.layout },
                      captionPresetId: preset.id,
                      animation: preset.animation
                    }
                  : { ...clip, trackId }
              )
            ]
          }
        },
        'Import subtitles'
      )
      notify({ kind: 'success', title: `${clips.length} subtitles imported` })
    } catch (error) {
      notify({ kind: 'error', title: 'Import failed', body: errorMessage(error) })
    }
  }

  const exportSubtitles = async (format: 'srt' | 'vtt') => {
    if (!project || !captions.length) return
    try {
      const path = await api.ai.exportSubtitles({ clips: captions, format, name: project.name })
      if (path) notify({ kind: 'success', title: 'Subtitles exported', body: path })
    } catch (error) {
      notify({ kind: 'error', title: 'Export failed', body: errorMessage(error) })
    }
  }

  if (!project) return <div />

  return (
    <div className="captions-studio">
      <header className="captions-studio__header">
        <div>
          <h2 className="screen-title">
            <Captions size={16} /> Captions
          </h2>
          <p className="screen-subtitle">
            Captions are ordinary timeline clips: they render in the preview and burn into exports from the
            same style data. {captions.length} caption{captions.length === 1 ? '' : 's'} in this project.
          </p>
        </div>
        <div className="row">
          <Button icon={<Upload size={13} />} onClick={() => void importSubtitles()}>
            Import SRT/VTT
          </Button>
          <Button icon={<Download size={13} />} disabled={!captions.length} onClick={() => void exportSubtitles('srt')}>
            Export SRT
          </Button>
          <Button
            icon={<Download size={13} />}
            disabled={!captions.length}
            onClick={() => void exportSubtitles('vtt')}
          >
            Export VTT
          </Button>
          <Button variant="primary" icon={<Wand2 size={13} />} loading={busy === 'generate'} onClick={() => void generateFromTranscript()}>
            Generate from transcript
          </Button>
        </div>
      </header>

      {!captions.length && (
        <div className="callout">
          <Wand2 size={13} />
          <div>
            No captions yet. Generate them from the transcript for word-accurate timing, or import an SRT/VTT
            file you already have. Choose a preset below to define the look before generating.
          </div>
        </div>
      )}

      <section className="captions-studio__section">
        <div className="row-between" style={{ marginBottom: 10 }}>
          <div className="label">Style presets</div>
          <div className="row">
            <Field label="Preset for new captions">
              <select className="select" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
                {captionPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
        <div className="preset-grid">
          {captionPresets.map((preset) => (
            <div key={preset.id} className="preset-card">
              <div
                className="preset-card__sample"
                style={{
                  background: preset.style.backgroundColor === 'transparent' ? '#101013' : preset.style.backgroundColor,
                  color: preset.style.color,
                  fontWeight: preset.style.fontWeight,
                  fontFamily: FONT_STACKS.find((f) => f.id === preset.style.fontFamily)?.stack,
                  WebkitTextStroke: preset.style.strokeWidth
                    ? `${Math.min(2, preset.style.strokeWidth / 3)}px ${preset.style.strokeColor}`
                    : undefined,
                  textTransform: preset.style.uppercase ? 'uppercase' : 'none',
                  letterSpacing: preset.style.letterSpacing,
                  textShadow: preset.style.shadowBlur ? `0 2px ${preset.style.shadowBlur / 2}px rgba(0,0,0,.6)` : undefined
                }}
              >
                MAKE IT{' '}
                <span data-spoken style={{ color: preset.style.highlightColor }}>
                  LAND
                </span>
              </div>
              <div className="preset-card__meta">
                <span style={{ fontWeight: 600 }}>{preset.name}</span>
                {preset.builtIn && <Badge>built-in</Badge>}
                <Badge tone="info">{preset.category}</Badge>
              </div>
              <div className="preset-card__desc">{preset.description}</div>
              <div className="row" style={{ marginTop: 8 }}>
                <Button size="sm" onClick={() => setEditing(preset)}>
                  Edit
                </Button>
                <Button size="sm" variant="primary" disabled={!captions.length} onClick={() => applyToAll(preset)}>
                  Apply
                </Button>
                <div className="grow" />
                {!preset.builtIn && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 size={11} />}
                    onClick={async () => {
                      await api.ai.deleteCaptionPreset(preset.id)
                      await refreshCaptionPresets()
                    }}
                  >
                    Delete
                  </Button>
                )}
              </div>
            </div>
          ))}
          <button
            className="preset-card preset-card--new"
            onClick={() => {
              const base = captionPresets[0]
              setEditing({
                id: `preset-${Date.now().toString(36)}`,
                name: 'My preset',
                description: 'Custom style',
                category: 'custom',
                style: { ...(base?.style ?? BASE_TEXT_STYLE) },
                layout: { ...(base?.layout ?? { x: 0.5, y: 0.84, width: 0.8, height: 0.16, anchor: 'bottom', maxWidthPct: 82 }) },
                animation: 'pop',
                animationDurationMs: 160,
                wordsPerLine: 4,
                uppercase: true,
                highlightMode: 'keyword',
                builtIn: false
              })
            }}
          >
            <Plus size={18} />
            <span>New preset</span>
          </button>
        </div>
      </section>

      <section className="captions-studio__section">
        <div className="label" style={{ marginBottom: 8 }}>
          Caption lines
        </div>
        {captions.length === 0 ? (
          <EmptyState
            icon={<Captions size={20} />}
            title="No caption clips"
            body="Generate from the transcript or import a subtitle file."
            action={
              <Button variant="primary" onClick={() => void generateFromTranscript()} loading={busy === 'generate'}>
                Generate captions
              </Button>
            }
          />
        ) : (
          <div className="caption-list">
            {captions.map((clip) => (
              <CaptionRow
                key={clip.id}
                clip={clip}
                active={playhead >= clip.start && playhead < clip.start + clip.duration}
                onSeek={() => selectClips([clip.id])}
                onText={(text) =>
                  apply(
                    (p) => ({ ...p, clips: p.clips.map((c) => (c.id === clip.id ? { ...c, text } : c)) }),
                    'Edit caption text',
                    { history: false }
                  )
                }
                onDelete={() =>
                  apply((p) => ({ ...p, clips: p.clips.filter((c) => c.id !== clip.id) }), 'Delete caption')
                }
              />
            ))}
          </div>
        )}
      </section>

      <PresetEditor preset={editing} onClose={() => setEditing(null)} onSave={savePreset} />
    </div>
  )
}

function CaptionRow({
  clip,
  active,
  onSeek,
  onText,
  onDelete
}: {
  clip: Clip
  active: boolean
  onSeek: () => void
  onText: (text: string) => void
  onDelete: () => void
}): JSX.Element {
  const [draft, setDraft] = useState(clip.text ?? '')
  useEffect(() => setDraft(clip.text ?? ''), [clip.text])
  return (
    <div className={`caption-row ${active ? 'caption-row--active' : ''}`}>
      <button className="mono caption-row__time" onClick={onSeek} title="Select this caption">
        {formatClock(clip.start, true)}
      </button>
      <input
        className="input caption-row__input"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          onText(e.target.value)
        }}
      />
      <span className="caption-row__duration mono muted">{(clip.duration / 1000).toFixed(2)}s</span>
      <button className="btn btn--ghost btn--icon btn--sm" onClick={onDelete} title="Delete caption">
        <X size={12} />
      </button>
    </div>
  )
}

function PresetEditor({
  preset,
  onClose,
  onSave
}: {
  preset: CaptionPreset | null
  onClose: () => void
  onSave: (preset: CaptionPreset) => void
}): JSX.Element {
  const [draft, setDraft] = useState<CaptionPreset | null>(preset)
  useEffect(() => setDraft(preset), [preset])
  if (!preset || !draft) return <div />
  const setStyle = (patch: Partial<TextStyle>) => setDraft({ ...draft, style: { ...draft.style, ...patch } })
  return (
    <Modal
      open
      title={`Edit “${draft.name}”`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => onSave(draft)}>
            Save preset
          </Button>
        </>
      }
    >
      <div className="stack-md">
        <Field label="Name">
          <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <Field label="Description">
          <input
            className="input"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </Field>
        <div className="row">
          <Field label="Text colour">
            <div className="color-swatch" style={{ background: draft.style.color }}>
              <input type="color" value={toHex(draft.style.color)} onChange={(e) => setStyle({ color: e.target.value })} />
            </div>
          </Field>
          <Field label="Highlight">
            <div className="color-swatch" style={{ background: draft.style.highlightColor }}>
              <input type="color" value={toHex(draft.style.highlightColor)} onChange={(e) => setStyle({ highlightColor: e.target.value })} />
            </div>
          </Field>
          <Field label="Outline">
            <div className="color-swatch" style={{ background: draft.style.strokeColor }}>
              <input type="color" value={toHex(draft.style.strokeColor)} onChange={(e) => setStyle({ strokeColor: e.target.value })} />
            </div>
          </Field>
        </div>
        <Field label="Font">
          <select className="select" value={draft.style.fontFamily} onChange={(e) => setStyle({ fontFamily: e.target.value })}>
            {FONT_STACKS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Font size">
          <input
            className="input mono"
            type="number"
            value={draft.style.fontSize}
            onChange={(e) => setStyle({ fontSize: Number(e.target.value) })}
          />
        </Field>
        <Field label="Vertical position">
          <Slider
            value={draft.layout.y}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setDraft({ ...draft, layout: { ...draft.layout, y: v } })}
            format={(v) => `${Math.round(v * 100)}%`}
          />
        </Field>
        <Field label="Words per line">
          <Slider
            value={draft.wordsPerLine}
            min={1}
            max={12}
            onChange={(v) => setDraft({ ...draft, wordsPerLine: v })}
          />
        </Field>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12.5 }}>Uppercase</span>
          <Switch label="Uppercase" checked={Boolean(draft.style.uppercase)} onChange={(v) => setStyle({ uppercase: v })} />
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12.5 }}>Background plate</span>
          <Switch
            label="Plate"
            checked={draft.style.backgroundColor !== 'transparent'}
            onChange={(v) => setStyle({ backgroundColor: v ? 'rgba(0,0,0,0.75)' : 'transparent', backgroundPadding: v ? 14 : 0 })}
          />
        </div>
        <Field label="Highlight mode">
          <Segmented
            value={draft.highlightMode}
            onChange={(v) => setDraft({ ...draft, highlightMode: v as CaptionPreset['highlightMode'] })}
            options={[
              { id: 'none', label: 'None' },
              { id: 'keyword', label: 'Keywords' },
              { id: 'spoken', label: 'Karaoke' }
            ]}
          />
        </Field>
        <Field label="Animation">
          <select
            className="select"
            value={draft.animation}
            onChange={(e) => setDraft({ ...draft, animation: e.target.value as CaptionPreset['animation'] })}
          >
            {['none', 'fade', 'pop', 'slideUp', 'karaoke', 'wordByWord', 'typewriter', 'bounce'].map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  )
}

function toHex(colour: string): string {
  if (!colour || colour === 'transparent') return '#000000'
  if (colour.startsWith('#') && (colour.length === 7 || colour.length === 9)) return colour.slice(0, 7)
  const match = /rgba?\(([^)]+)\)/.exec(colour)
  if (match) {
    const [r, g, b] = match[1].split(',').map((p) => Number(p.trim()))
    return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v || 0))).toString(16).padStart(2, '0')).join('')}`
  }
  return '#ffffff'
}
