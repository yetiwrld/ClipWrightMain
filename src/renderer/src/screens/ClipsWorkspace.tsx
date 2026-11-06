/**
 * AI clips workspace: transcription, transcript editing, moment discovery,
 * scoring review and clip generation.
 */
import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  CheckCircle2,
  Copy,
  Download,
  Filter,
  Heart,
  ListChecks,
  Loader2,
  Play,
  RefreshCw,
  Scissors,
  Search,
  Star,
  Wand2,
  X,
  FileAudio,
  Captions,
  TriangleAlert
} from 'lucide-react'
import { useEditor } from '../state/editor'
import { useApp } from '../state/app'
import { Badge, Button, EmptyState, Field, Modal, ProgressBar, Segmented, Slider } from '../components/ui'
import { SCORE_LABELS, SCORE_WEIGHTS } from '@shared/scoring'
import { formatClock } from '@shared/time'
import { api, errorMessage } from '../lib/api'
import type { CaptionPreset, Moment, MomentScores, ProcessingMode, Transcript } from '@shared/types'

interface Props {
  onOpenProject: (id: string) => void
}

export function ClipsWorkspace({ onOpenProject }: Props): JSX.Element {
  const { project, playhead } = useEditor()
  const setPlayhead = useEditor((s) => s.setPlayhead)
  const setPlaying = useEditor((s) => s.setPlaying)
  const notify = useEditor((s) => s.notify)
  const { settings, providers, models, capabilities } = useApp()
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [moments, setMoments] = useState<Moment[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ label: string; percent: number; detail?: string } | null>(null)
  const [tab, setTab] = useState<'moments' | 'transcript'>('moments')
  const [query, setQuery] = useState('')
  const [minScore, setMinScore] = useState(0)
  const [durationFilter, setDurationFilter] = useState<'all' | 'short' | 'medium' | 'long'>('all')
  const [sort, setSort] = useState<'score' | 'time' | 'duration'>('score')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [targetCount, setTargetCount] = useState(8)
  const [minDuration, setMinDuration] = useState(15)
  const [maxDuration, setMaxDuration] = useState(60)
  const [mode, setMode] = useState<ProcessingMode>(settings?.ai.mode ?? 'auto')
  const [generating, setGenerating] = useState<Moment | null>(null)
  const [genAspect, setGenAspect] = useState('9:16')
  const [genPreset, setGenPreset] = useState('bold-creator')
  const [presets, setPresets] = useState<CaptionPreset[]>([])
  const [editing, setEditing] = useState<Moment | null>(null)
  const [engineNote, setEngineNote] = useState<string>('')

  const sourceAsset = useMemo(
    () => project?.assets.find((a) => a.kind === 'video') ?? null,
    [project]
  )

  useEffect(() => {
    if (!project) return
    void (async () => {
      const [existing, savedMoments, loadedPresets] = await Promise.all([
        api.ai.transcript(project.id),
        api.ai.moments(project.id),
        api.ai.captionPresets()
      ])
      setTranscript(existing)
      setMoments(savedMoments)
      setPresets(loadedPresets)
      if (loadedPresets.length && !loadedPresets.some((p) => p.id === genPreset)) setGenPreset(loadedPresets[1]?.id ?? loadedPresets[0].id)
    })()
    const unsubscribe = api.events.onProgress((payload) => {
      if (payload.status === 'done') {
        setTimeout(() => setProgress(null), 900)
        return
      }
      if (payload.status === 'error') {
        setProgress(null)
        return
      }
      setProgress({ label: payload.label, percent: payload.percent ?? 0, detail: payload.detail })
    })
    return unsubscribe
  }, [project?.id])

  const runTranscription = async (useLocal: boolean) => {
    if (!project || !sourceAsset) return
    setBusy('transcribe')
    try {
      const result = await api.ai.transcribe({
        projectId: project.id,
        assetId: sourceAsset.id,
        mode: useLocal ? 'local' : 'online',
        language: settings?.transcription.language,
        speakerLabels: settings?.transcription.speakerLabels
      })
      setTranscript(result)
      notify({
        kind: 'success',
        title: 'Transcript ready',
        body: `${result.segments.length} segments · ${result.engine}`
      })
    } catch (error) {
      notify({ kind: 'error', title: 'Transcription failed', body: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const detect = async () => {
    if (!project || !transcript) return
    setBusy('detect')
    try {
      const result = await api.ai.detectMoments({
        projectId: project.id,
        transcriptId: transcript.id,
        minDurationMs: minDuration * 1000,
        maxDurationMs: maxDuration * 1000,
        targetCount,
        mode
      })
      setMoments(result.moments)
      setEngineNote(
        result.engine.startsWith('heuristic')
          ? 'Scored with the built-in transcript analyser (offline, no model needed).'
          : `Analysed with ${result.engine}.`
      )
      if (result.warnings.length) {
        notify({ kind: 'warning', title: 'Fell back to local analysis', body: result.warnings.join(' ') })
      }
      notify({ kind: 'success', title: `${result.moments.length} moments found` })
    } catch (error) {
      notify({ kind: 'error', title: 'Moment detection failed', body: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const generateClip = async () => {
    if (!project || !generating) return
    setBusy('generate')
    try {
      const clipProject = await api.ai.generateClip({
        sourceProjectId: project.id,
        moment: generating,
        aspect: genAspect,
        fps: project.fps,
        captionPresetId: genPreset,
        name: generating.title,
        autoFrame: true,
        includeCaptions: true
      })
      const next: Moment[] = moments.map((m) =>
        m.id === generating.id ? { ...m, status: 'used' as const } : m
      )
      setMoments(next)
      await api.ai.saveMoments(project.id, next)
      setGenerating(null)
      notify({ kind: 'success', title: 'Clip created', body: 'Opening it in the editor.' })
      onOpenProject(clipProject.id)
    } catch (error) {
      notify({ kind: 'error', title: 'Could not generate clip', body: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const filtered = useMemo(() => {
    let list = moments.filter((m) => m.status !== 'rejected')
    if (query) {
      const q = query.toLowerCase()
      list = list.filter((m) => m.title.toLowerCase().includes(q) || m.previewText.toLowerCase().includes(q))
    }
    list = list.filter((m) => m.score >= minScore)
    if (durationFilter !== 'all') {
      list = list.filter((m) => {
        const d = (m.end - m.start) / 1000
        if (durationFilter === 'short') return d < 20
        if (durationFilter === 'medium') return d >= 20 && d <= 45
        return d > 45
      })
    }
    return [...list].sort((a, b) => {
      if (sort === 'score') return b.score - a.score
      if (sort === 'time') return a.start - b.start
      return b.end - b.start - (a.end - a.start)
    })
  }, [moments, query, minScore, durationFilter, sort])

  if (!project) return <div />

  return (
    <div className="clips-workspace">
      <div className="clips-workspace__bar">
        <div className="row">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { id: 'moments', label: `Moments (${moments.length})` },
              { id: 'transcript', label: 'Transcript' }
            ]}
          />
          {transcript && <Badge tone="info">{transcript.engine}</Badge>}
          {!capabilities?.whisperAvailable && !providers.some((p) => p.hasKey) && (
            <Badge tone="warning">offline transcription needs a model</Badge>
          )}
        </div>
        <div className="row">
          {transcript ? (
            <Button
              variant="primary"
              icon={<Wand2 size={13} />}
              loading={busy === 'detect'}
              onClick={() => void detect()}
            >
              Find viral moments
            </Button>
          ) : (
            <>
              <Button
                icon={<FileAudio size={13} />}
                loading={busy === 'transcribe'}
                onClick={() => void runTranscription(true)}
                title="Runs whisper.cpp locally with a downloaded model"
              >
                Transcribe offline
              </Button>
              <Button
                variant="primary"
                icon={<FileAudio size={13} />}
                loading={busy === 'transcribe'}
                onClick={() => void runTranscription(false)}
                title="Uses your configured online provider"
              >
                Transcribe online
              </Button>
            </>
          )}
        </div>
      </div>

      {progress && (
        <div className="clips-workspace__progress">
          <div className="row-between" style={{ marginBottom: 6 }}>
            <span style={{ fontSize: 12 }}>{progress.label}{progress.detail ? ` — ${progress.detail}` : ''}</span>
            <span className="mono muted">{Math.round(progress.percent)}%</span>
          </div>
          <ProgressBar percent={progress.percent} />
        </div>
      )}

      {tab === 'transcript' ? (
        <TranscriptView
          transcript={transcript}
          onSeek={(ms) => {
            setPlayhead(ms)
            setPlaying(false)
          }}
          onSave={async (next) => {
            setTranscript(next)
            await api.ai.saveTranscript(project.id, next)
            notify({ kind: 'success', title: 'Transcript saved' })
          }}
          onTranscribe={() => void runTranscription(true)}
          busy={busy === 'transcribe'}
        />
      ) : (
        <div className="clips-workspace__body">
          <aside className="clips-workspace__filters">
            <div className="label">Detection</div>
            <Field label="Moments to find">
              <Slider value={targetCount} min={3} max={30} onChange={setTargetCount} />
            </Field>
            <Field label="Shortest clip">
              <Slider value={minDuration} min={5} max={60} onChange={setMinDuration} format={(v) => `${v}s`} />
            </Field>
            <Field label="Longest clip">
              <Slider value={maxDuration} min={20} max={180} onChange={setMaxDuration} format={(v) => `${v}s`} />
            </Field>
            <Field label="Processing mode">
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  { id: 'auto', label: 'Auto' },
                  { id: 'offline', label: 'Offline' },
                  { id: 'online', label: 'Online' }
                ]}
              />
            </Field>
            <div className="hint">
              {mode === 'offline'
                ? 'Analyses on this computer. Uses the built-in scorer unless a local model is installed.'
                : mode === 'online'
                  ? 'Sends the transcript (not the video) to your configured AI provider.'
                  : 'Picks the best available method based on your settings and connection.'}
            </div>
            <div className="divider" />
            <div className="label">Filter</div>
            <Field label="Minimum score">
              <Slider value={minScore} min={0} max={95} onChange={setMinScore} />
            </Field>
            <Field label="Duration">
              <Segmented
                value={durationFilter}
                onChange={setDurationFilter}
                options={[
                  { id: 'all', label: 'All' },
                  { id: 'short', label: '<20s' },
                  { id: 'medium', label: '20-45' },
                  { id: 'long', label: '>45s' }
                ]}
              />
            </Field>
            <Field label="Sort">
              <select className="select" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
                <option value="score">Highest score</option>
                <option value="time">Timeline order</option>
                <option value="duration">Longest first</option>
              </select>
            </Field>
            {engineNote && <div className="hint">{engineNote}</div>}
          </aside>

          <div className="clips-workspace__list">
            <div className="row-between" style={{ marginBottom: 10 }}>
              <div className="search-field" style={{ maxWidth: 280 }}>
                <Search size={12} />
                <input className="input" placeholder="Search moments" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <div className="row">
                <Badge>{filtered.length} shown</Badge>
                <Button
                  size="sm"
                  icon={<ListChecks size={12} />}
                  disabled={selectedIds.length === 0}
                  onClick={async () => {
                    for (const id of selectedIds) {
                      const moment = moments.find((m) => m.id === id)
                      if (!moment) continue
                      await api.ai.generateClip({
                        sourceProjectId: project.id,
                        moment,
                        aspect: genAspect,
                        fps: project.fps,
                        captionPresetId: genPreset,
                        name: moment.title,
                        autoFrame: true,
                        includeCaptions: true
                      })
                    }
                    notify({ kind: 'success', title: `${selectedIds.length} clips generated` })
                    setSelectedIds([])
                  }}
                >
                  Generate selected
                </Button>
              </div>
            </div>

            {filtered.length === 0 ? (
              <EmptyState
                icon={<Wand2 size={20} />}
                title={transcript ? 'No moments yet' : 'Transcribe first'}
                body={
                  transcript
                    ? 'Run detection to score candidate windows from your transcript. Nothing is random — every moment is a complete idea.'
                    : 'Clipwright needs the spoken words and their timings. Transcribe offline with a downloaded model, or use your own online provider key.'
                }
                action={
                  transcript ? (
                    <Button variant="primary" onClick={() => void detect()} loading={busy === 'detect'}>
                      Find viral moments
                    </Button>
                  ) : (
                    <Button variant="primary" onClick={() => void runTranscription(true)} loading={busy === 'transcribe'}>
                      Transcribe this project
                    </Button>
                  )
                }
              />
            ) : (
              <div className="moment-grid">
                {filtered.map((moment) => (
                  <MomentCard
                    key={moment.id}
                    moment={moment}
                    selected={selectedIds.includes(moment.id)}
                    onToggleSelect={() =>
                      setSelectedIds((prev) =>
                        prev.includes(moment.id) ? prev.filter((id) => id !== moment.id) : [...prev, moment.id]
                      )
                    }
                    onPreview={() => {
                      setPlayhead(moment.start)
                      setPlaying(true)
                    }}
                    onEdit={() => setEditing(moment)}
                    onGenerate={() => setGenerating(moment)}
                    onFavourite={async () => {
                      const next: Moment[] = moments.map((m) =>
                        m.id === moment.id
                          ? { ...m, status: m.status === 'favourite' ? ('new' as const) : ('favourite' as const) }
                          : m
                      )
                      setMoments(next)
                      await api.ai.saveMoments(project.id, next)
                    }}
                    onReject={async () => {
                      const next: Moment[] = moments.map((m) =>
                        m.id === moment.id ? { ...m, status: 'rejected' as const } : m
                      )
                      setMoments(next)
                      await api.ai.saveMoments(project.id, next)
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <Modal
        open={Boolean(generating)}
        title="Generate clip"
        subtitle={generating ? `${generating.title} · ${formatClock(generating.start)} → ${formatClock(generating.end)}` : ''}
        onClose={() => setGenerating(null)}
        footer={
          <>
            <Button onClick={() => setGenerating(null)}>Cancel</Button>
            <Button variant="primary" loading={busy === 'generate'} onClick={() => void generateClip()} icon={<Scissors size={13} />}>
              Create editable clip
            </Button>
          </>
        }
      >
        {generating && (
          <div className="stack-md">
            <Field label="Aspect ratio">
              <Segmented
                value={genAspect}
                onChange={setGenAspect}
                options={[
                  { id: '9:16', label: '9:16' },
                  { id: '1:1', label: '1:1' },
                  { id: '4:5', label: '4:5' },
                  { id: '16:9', label: '16:9' }
                ]}
              />
            </Field>
            <Field label="Caption style">
              <select className="select" value={genPreset} onChange={(e) => setGenPreset(e.target.value)}>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.description}
                  </option>
                ))}
              </select>
            </Field>
            <div className="callout">
              <Captions size={13} />
              <div>
                The clip opens in the full editor with captions, audio and framing already applied. Every
                choice stays editable, and the original project is untouched.
              </div>
            </div>
            <div className="label">Why this moment</div>
            <div className="hint">{generating.reason}</div>
          </div>
        )}
      </Modal>

      <MomentEditor
        moment={editing}
        onClose={() => setEditing(null)}
        onSave={async (updated) => {
          const next = moments.map((m) => (m.id === updated.id ? updated : m))
          setMoments(next)
          await api.ai.saveMoments(project.id, next)
          setEditing(null)
          notify({ kind: 'success', title: 'Moment boundaries updated' })
        }}
      />
    </div>
  )
}

function MomentCard({
  moment,
  selected,
  onToggleSelect,
  onPreview,
  onEdit,
  onGenerate,
  onFavourite,
  onReject
}: {
  moment: Moment
  selected: boolean
  onToggleSelect: () => void
  onPreview: () => void
  onEdit: () => void
  onGenerate: () => void
  onFavourite: () => void
  onReject: () => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const duration = (moment.end - moment.start) / 1000
  return (
    <article className={clsx('moment-card', selected && 'moment-card--selected', moment.status === 'used' && 'moment-card--used')}>
      <header className="moment-card__header">
        <div className="moment-card__score" title="Editorial score out of 100">
          <span>{moment.score}</span>
          <small>/100</small>
        </div>
        <div className="grow">
          <h3 className="moment-card__title">{moment.title}</h3>
          <div className="moment-card__meta">
            <span className="mono">
              {formatClock(moment.start, true)} → {formatClock(moment.end, true)}
            </span>
            <span>{duration.toFixed(1)}s</span>
            <span className="moment-card__confidence">confidence {Math.round(moment.confidence * 100)}%</span>
          </div>
        </div>
        <label className="checkbox" title="Select for batch generation">
          <input type="checkbox" checked={selected} onChange={onToggleSelect} />
        </label>
      </header>

      <p className={clsx('moment-card__text', !expanded && 'moment-card__text--clamped')}>{moment.previewText}</p>
      {moment.previewText.length > 220 && (
        <button className="moment-card__more" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}

      <div className="moment-card__tags">
        {moment.tags.map((tag) => (
          <Badge key={tag} tone="brand">
            {tag}
          </Badge>
        ))}
        {moment.status === 'used' && <Badge tone="success">clip created</Badge>}
      </div>

      <div className="moment-card__scores">
        {(Object.keys(SCORE_LABELS) as (keyof MomentScores)[]).map((key) => (
          <div key={key} className="score-bar" title={`${SCORE_LABELS[key]} — weight ${Math.round(SCORE_WEIGHTS[key] * 100)}%`}>
            <span className="score-bar__label">{SCORE_LABELS[key]}</span>
            <span className="score-bar__track">
              <span className="score-bar__fill" style={{ width: `${moment.scores[key]}%` }} />
            </span>
            <span className="score-bar__value mono">{moment.scores[key]}</span>
          </div>
        ))}
      </div>

      <div className="moment-card__reason">
        <TriangleAlert size={12} /> {moment.reason}
      </div>

      <footer className="moment-card__actions">
        <Button size="sm" icon={<Play size={11} />} onClick={onPreview}>
          Preview
        </Button>
        <Button size="sm" icon={<Scissors size={11} />} onClick={onEdit}>
          Boundaries
        </Button>
        <Button size="sm" variant="ghost" icon={<Heart size={11} />} onClick={onFavourite}>
          {moment.status === 'favourite' ? 'Favourited' : 'Favourite'}
        </Button>
        <Button size="sm" variant="ghost" icon={<X size={11} />} onClick={onReject}>
          Reject
        </Button>
        <div className="grow" />
        <Button size="sm" variant="primary" icon={<Scissors size={11} />} onClick={onGenerate}>
          Generate clip
        </Button>
      </footer>
    </article>
  )
}

function MomentEditor({
  moment,
  onClose,
  onSave
}: {
  moment: Moment | null
  onClose: () => void
  onSave: (moment: Moment) => void
}): JSX.Element {
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(0)
  const [title, setTitle] = useState('')
  useEffect(() => {
    if (moment) {
      setStart(moment.start)
      setEnd(moment.end)
      setTitle(moment.title)
    }
  }, [moment])
  return (
    <Modal
      open={Boolean(moment)}
      title="Edit moment boundaries"
      subtitle="Clips should start at a sentence boundary and end on a complete thought."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => moment && onSave({ ...moment, start, end, title, score: moment.score })}
          >
            Save boundaries
          </Button>
        </>
      }
    >
      {moment && (
        <div className="stack-md">
          <Field label="Title">
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Start">
            <input
              className="input mono"
              value={formatClock(start, true)}
              onChange={(e) => {
                const ms = parseClock(e.target.value)
                if (ms !== null) setStart(ms)
              }}
            />
          </Field>
          <Field label="End">
            <input
              className="input mono"
              value={formatClock(end, true)}
              onChange={(e) => {
                const ms = parseClock(e.target.value)
                if (ms !== null) setEnd(ms)
              }}
            />
          </Field>
          <div className="hint">Duration: {((end - start) / 1000).toFixed(1)}s</div>
          <div className="label">Transcript in range</div>
          <div className="hint">{moment.previewText}</div>
        </div>
      )}
    </Modal>
  )
}

function TranscriptView({
  transcript,
  onSeek,
  onSave,
  onTranscribe,
  busy
}: {
  transcript: Transcript | null
  onSeek: (ms: number) => void
  onSave: (transcript: Transcript) => void
  onTranscribe: () => void
  busy: boolean
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  if (!transcript) {
    return (
      <EmptyState
        icon={<FileAudio size={20} />}
        title="No transcript yet"
        body="Transcribe the source to unlock moment detection, captions and transcript-driven editing. Offline transcription needs a downloaded model; online uses your own API key."
        action={
          <Button variant="primary" onClick={onTranscribe} loading={busy}>
            Transcribe now
          </Button>
        }
      />
    )
  }

  const segments = transcript.segments.filter((s) =>
    query ? s.text.toLowerCase().includes(query.toLowerCase()) : true
  )

  return (
    <div className="transcript-view">
      <div className="transcript-view__bar">
        <div className="search-field" style={{ maxWidth: 320 }}>
          <Search size={12} />
          <input className="input" placeholder="Search transcript" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="row">
          <Badge>{transcript.segments.length} segments</Badge>
          <Badge tone="info">{transcript.language}</Badge>
          <Button
            size="sm"
            icon={<Download size={12} />}
            onClick={async () => {
              const clips = transcript.segments.map((seg, i) => ({
                id: `t${i}`,
                kind: 'caption' as const,
                trackId: 'export',
                name: seg.text,
                start: seg.start,
                duration: seg.end - seg.start,
                sourceIn: 0,
                playing: true,
                text: seg.text,
                transform: { x: 0.5, y: 0.9, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, cropL: 0, cropR: 0, cropT: 0, cropB: 0 },
                keyframes: {},
                effects: [],
                audio: { volume: 1, gainDb: 0, fadeInMs: 0, fadeOutMs: 0, muted: false, showWaveform: false, bass: 0, treble: 0, pan: 0, normalize: false, ducking: false }
              }))
              await api.ai.exportSubtitles({ clips, format: 'srt', name: 'transcript' })
            }}
          >
            Export SRT
          </Button>
        </div>
      </div>

      <div className="transcript-view__segments">
        {segments.map((segment) => (
          <div key={segment.id} className="transcript-segment">
            <button className="transcript-segment__time mono" onClick={() => onSeek(segment.start)} title="Jump to this point">
              {formatClock(segment.start, true)}
            </button>
            {segment.speaker && <span className="badge">{segment.speaker}</span>}
            {editing === segment.id ? (
              <div className="grow">
                <textarea
                  className="textarea"
                  value={draft}
                  rows={2}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => {
                    const next: Transcript = {
                      ...transcript,
                      segments: transcript.segments.map((s) =>
                        s.id === segment.id ? { ...s, text: draft, edited: true, words: undefined } : s
                      )
                    }
                    onSave(next)
                    setEditing(null)
                  }}
                />
              </div>
            ) : (
              <p
                className="transcript-segment__text selectable"
                onDoubleClick={() => {
                  setEditing(segment.id)
                  setDraft(segment.text)
                }}
              >
                {segment.text}
              </p>
            )}
            <button
              className="btn btn--ghost btn--icon btn--sm"
              title="Copy"
              onClick={() => void navigator.clipboard.writeText(segment.text)}
            >
              <Copy size={11} />
            </button>
          </div>
        ))}
      </div>
      <div className="transcript-view__footer hint">
        Double-click a line to correct it. Edited lines keep their timing so captions stay in sync.
      </div>
    </div>
  )
}

function parseClock(value: string): number | null {
  const parts = value.split(':').map(Number)
  if (parts.some((p) => isNaN(p))) return null
  if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000)
  if (parts.length === 3) return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000)
  return null
}
