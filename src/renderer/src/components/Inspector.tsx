/**
 * Inspector: transform, crop, timing, transitions, effects, keyframes, audio,
 * typography and caption styling for the selected clip.
 */
import React, { useMemo, useState } from 'react'
import {
  AudioLines,
  Captions,
  Diamond,
  Plus,
  Sparkles,
  Trash2,
  Type,
  Wand2
} from 'lucide-react'
import { useEditor } from '../state/editor'
import { useApp } from '../state/app'
import { Accordion, Badge, Button, Field, IconButton, Segmented, Slider, Switch } from './ui'
import {
  BASE_TEXT_STYLE,
  EFFECT_DEFS,
  FONT_STACKS,
  ICON_LIBRARY,
  TEXT_ANIMATIONS,
  TRANSITIONS,
  makeEffect
} from '@shared/presets'
import { EASING_OPTIONS } from '@shared/easing'
import { addKeyframe, removeKeyframe, sampleTrack, updateKeyframe } from '@shared/keyframes'
import { formatClock } from '@shared/time'
import type { AnimatableProp, CaptionAnimation, Clip, EasingKind, TransitionType } from '@shared/types'

const ANIMATABLE: { prop: AnimatableProp; label: string }[] = [
  { prop: 'x', label: 'Position X' },
  { prop: 'y', label: 'Position Y' },
  { prop: 'scale', label: 'Scale' },
  { prop: 'rotation', label: 'Rotation' },
  { prop: 'opacity', label: 'Opacity' },
  { prop: 'volume', label: 'Volume' }
]

const TABS = [
  { id: 'properties' as const, label: 'Clip' },
  { id: 'effects' as const, label: 'Effects' },
  { id: 'animations' as const, label: 'Motion' },
  { id: 'audio' as const, label: 'Audio' },
  { id: 'text' as const, label: 'Text' },
  { id: 'caption' as const, label: 'Caption' }
]

export function Inspector(): JSX.Element {
  const { project, selectedClipIds, inspectorTab } = useEditor()
  const setInspectorTab = useEditor((s) => s.setInspectorTab)
  const clip = useMemo(
    () => project?.clips.find((c) => c.id === selectedClipIds[0]) ?? null,
    [project, selectedClipIds]
  )

  return (
    <div className="inspector panel">
      <div className="panel__header">
        <div className="panel__title">Inspector</div>
        {clip && <Badge tone="brand">{clip.kind}</Badge>}
      </div>
      <div className="inspector__tabs">
        <div className="tabs tabs--compact" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className="tab"
              role="tab"
              aria-selected={inspectorTab === tab.id}
              onClick={() => setInspectorTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <div className="panel__body">
        {!clip ? (
          <ProjectSettings />
        ) : (
          <>
            {inspectorTab === 'properties' && <PropertiesTab clip={clip} />}
            {inspectorTab === 'effects' && <EffectsTab clip={clip} />}
            {inspectorTab === 'animations' && <MotionTab clip={clip} />}
            {inspectorTab === 'audio' && <AudioTab clip={clip} />}
            {inspectorTab === 'text' && <TextTab clip={clip} />}
            {inspectorTab === 'caption' && <CaptionTab clip={clip} />}
          </>
        )}
      </div>
    </div>
  )
}

function useClipUpdater(clip: Clip) {
  const apply = useEditor((s) => s.apply)
  return {
    patch: (patch: Partial<Clip>, label = 'Edit clip') =>
      apply((p) => ({ ...p, clips: p.clips.map((c) => (c.id === clip.id ? { ...c, ...patch } : c)) }), label),
    live: (patch: Partial<Clip>) =>
      useEditor.getState().applyLive((p) => ({
        ...p,
        clips: p.clips.map((c) => (c.id === clip.id ? { ...c, ...patch } : c))
      })),
    transform: (patch: Partial<Clip['transform']>) =>
      useEditor.getState().setClipTransform(clip.id, patch),
    commit: () => useEditor.getState().finishTransformDrag(clip.id)
  }
}

function ProjectSettings(): JSX.Element {
  const project = useEditor((s) => s.project)
  const apply = useEditor((s) => s.apply)
  if (!project) return <div />
  return (
    <div className="inspector__empty">
      <div className="label">Project settings</div>
      <Field label="Aspect ratio">
        <select
          className="select"
          value={project.canvas.aspect}
          onChange={(e) => {
            const aspect = e.target.value
            const [w, h] = aspect.split(':').map(Number)
            if (!w || !h) return
            const longEdge = Math.max(project.canvas.width, project.canvas.height)
            const width = w >= h ? longEdge : Math.round((longEdge * w) / h / 2) * 2
            const height = h >= w ? longEdge : Math.round((longEdge * h) / w / 2) * 2
            apply((p) => ({ ...p, canvas: { ...p.canvas, aspect, width, height } }), 'Change aspect ratio')
          }}
        >
          {['9:16', '16:9', '1:1', '4:5', '4:3', '21:9'].map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Frame rate">
        <Segmented
          value={String(project.fps)}
          onChange={(v) => apply((p) => ({ ...p, fps: Number(v), canvas: { ...p.canvas, fps: Number(v) } }), 'Change frame rate')}
          options={[
            { id: '24', label: '24' },
            { id: '30', label: '30' },
            { id: '60', label: '60' }
          ]}
        />
      </Field>
      <Field label="Canvas size">
        <div className="mono secondary" style={{ fontSize: 12 }}>
          {project.canvas.width} × {project.canvas.height}
        </div>
      </Field>
      <Field label="Background">
        <div className="row">
          <div className="color-swatch" style={{ background: project.canvas.backgroundColor }}>
            <input
              type="color"
              value={project.canvas.backgroundColor}
              onChange={(e) => apply((p) => ({ ...p, canvas: { ...p.canvas, backgroundColor: e.target.value } }), 'Change background')}
            />
          </div>
          <span className="mono muted">{project.canvas.backgroundColor}</span>
        </div>
      </Field>
      <Field label="Project name">
        <input
          className="input"
          value={project.name}
          onChange={(e) => apply((p) => ({ ...p, name: e.target.value }), 'Rename project', { history: false })}
        />
      </Field>
      <div className="hint">Select a clip in the timeline or preview to edit its properties.</div>
    </div>
  )
}

function PropertiesTab({ clip }: { clip: Clip }): JSX.Element {
  const updater = useClipUpdater(clip)
  const playhead = useEditor((s) => s.playhead)
  const local = Math.max(0, playhead - clip.start)
  const t = clip.transform

  return (
    <div>
      <Accordion title="Transform">
        <div className="stack-md">
          <Field label="Position (0–1 of canvas)">
            <div className="row" style={{ gap: 6 }}>
              <input
                className="input mono"
                type="number"
                step={0.01}
                value={Number(t.x.toFixed(3))}
                onChange={(e) => updater.transform({ x: Number(e.target.value) })}
                onBlur={() => updater.commit()}
              />
              <input
                className="input mono"
                type="number"
                step={0.01}
                value={Number(t.y.toFixed(3))}
                onChange={(e) => updater.transform({ y: Number(e.target.value) })}
                onBlur={() => updater.commit()}
              />
            </div>
          </Field>
          <Field label="Scale">
            <Slider
              value={t.scaleX}
              min={0.05}
              max={3}
              step={0.01}
              onChange={(v) => updater.transform({ scaleX: v, scaleY: v, scale: 1 })}
              format={(v) => `${v.toFixed(2)}×`}
            />
          </Field>
          <div className="row">
            {[
              { label: 'Fill frame', v: 1.78 },
              { label: 'Original', v: 1 },
              { label: 'Shrink', v: 0.66 }
            ].map((preset) => (
              <Button
                key={preset.label}
                size="sm"
                onClick={() => {
                  updater.transform({ scaleX: preset.v, scaleY: preset.v, scale: 1 })
                  updater.commit()
                }}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <Field label="Rotation">
            <Slider
              value={t.rotation}
              min={-180}
              max={180}
              onChange={(v) => updater.transform({ rotation: v })}
              format={(v) => `${Math.round(v)}°`}
            />
          </Field>
          <Field label="Opacity">
            <Slider
              value={t.opacity}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => updater.transform({ opacity: v })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
          </Field>
          <Button size="sm" onClick={() => { updater.transform({ x: 0.5, y: 0.5, scaleX: 1, scaleY: 1, scale: 1, rotation: 0 }); updater.commit() }}>
            Reset transform
          </Button>
        </div>
      </Accordion>

      <Accordion title="Crop" defaultOpen={false}>
        <div className="stack-md">
          {(
            [
              ['cropL', 'Left'],
              ['cropR', 'Right'],
              ['cropT', 'Top'],
              ['cropB', 'Bottom']
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={label}>
              <Slider
                value={t[key]}
                min={0}
                max={0.9}
                step={0.005}
                onChange={(v) => updater.transform({ [key]: v } as Partial<Clip['transform']>)}
                format={(v) => `${Math.round(v * 100)}%`}
              />
            </Field>
          ))}
          <div className="hint">Crop is applied before scaling, so the remaining area fits the transform.</div>
        </div>
      </Accordion>

      <Accordion title="Timing">
        <div className="stack-md">
          <div className="row">
            <Field label="Start">
              <input
                className="input mono"
                defaultValue={formatClock(clip.start, true)}
                key={`start-${clip.start}`}
                onBlur={(e) => {
                  const ms = parseClock(e.target.value)
                  if (ms !== null) updater.patch({ start: ms }, 'Retime clip')
                }}
              />
            </Field>
            <Field label="Duration">
              <input
                className="input mono"
                defaultValue={formatClock(clip.duration, true)}
                key={`dur-${clip.duration}`}
                onBlur={(e) => {
                  const ms = parseClock(e.target.value)
                  if (ms !== null && ms > 80) updater.patch({ duration: ms }, 'Retime clip')
                }}
              />
            </Field>
          </div>
          {(clip.kind === 'video' || clip.kind === 'audio') && (
            <Field label="Source in-point" hint="Where playback starts inside the original media.">
              <input
                className="input mono"
                defaultValue={formatClock(clip.sourceIn, true)}
                key={`in-${clip.sourceIn}`}
                onBlur={(e) => {
                  const ms = parseClock(e.target.value)
                  if (ms !== null) updater.patch({ sourceIn: Math.max(0, ms) }, 'Set source in-point')
                }}
              />
            </Field>
          )}
          <div className="row">
            <Button
              size="sm"
              disabled={local < 120}
              title="Trim the clip so it ends at the playhead"
              onClick={() => updater.patch({ duration: local }, 'Trim to playhead')}
            >
              Trim to playhead
            </Button>
            <Button
              size="sm"
              disabled={local < 120 || local >= clip.duration - 100}
              title="Discard everything before the playhead"
              onClick={() =>
                updater.patch(
                  {
                    start: clip.start + local,
                    sourceIn: clip.sourceIn + local,
                    duration: clip.duration - local
                  },
                  'Cut head'
                )
              }
            >
              Cut head
            </Button>
          </div>
        </div>
      </Accordion>

      <Accordion title="Transitions" defaultOpen={false}>
        <div className="stack-md">
          <Field label="In">
            <select
              className="select"
              value={clip.transitionIn?.type ?? ''}
              onChange={(e) =>
                updater.patch(
                  {
                    transitionIn: e.target.value
                      ? {
                          id: clip.transitionIn?.id ?? 'tin',
                          type: e.target.value as TransitionType,
                          durationMs: clip.transitionIn?.durationMs ?? 400
                        }
                      : undefined
                  },
                  'Set transition in'
                )
              }
            >
              <option value="">None</option>
              {TRANSITIONS.map((tr) => (
                <option key={tr.type} value={tr.type}>
                  {tr.label}
                </option>
              ))}
            </select>
          </Field>
          {clip.transitionIn && (
            <Slider
              value={clip.transitionIn.durationMs}
              min={100}
              max={2500}
              step={20}
              onChange={(v) => updater.patch({ transitionIn: { ...clip.transitionIn!, durationMs: v } }, 'Transition duration')}
              format={(v) => `${(v / 1000).toFixed(2)}s`}
            />
          )}
          <Field label="Out">
            <select
              className="select"
              value={clip.transitionOut?.type ?? ''}
              onChange={(e) =>
                updater.patch(
                  {
                    transitionOut: e.target.value
                      ? {
                          id: clip.transitionOut?.id ?? 'tout',
                          type: e.target.value as TransitionType,
                          durationMs: clip.transitionOut?.durationMs ?? 400
                        }
                      : undefined
                  },
                  'Set transition out'
                )
              }
            >
              <option value="">None</option>
              {TRANSITIONS.map((tr) => (
                <option key={tr.type} value={tr.type}>
                  {tr.label}
                </option>
              ))}
            </select>
          </Field>
          {clip.transitionOut && (
            <Slider
              value={clip.transitionOut.durationMs}
              min={100}
              max={2500}
              step={20}
              onChange={(v) => updater.patch({ transitionOut: { ...clip.transitionOut!, durationMs: v } }, 'Transition duration')}
              format={(v) => `${(v / 1000).toFixed(2)}s`}
            />
          )}
          <div className="hint">
            Clips fade through transparency, revealing the track underneath. “Fade to black” dips to the
            canvas background colour instead.
          </div>
        </div>
      </Accordion>

      {(clip.kind === 'graphic' || clip.kind === 'image') && (
        <Accordion title="Graphic">
          <div className="icon-grid">
            {ICON_LIBRARY.slice(0, 60).map((item) => (
              <button
                key={item.id}
                className={`icon-grid__item ${clip.iconName === item.id ? 'icon-grid__item--active' : ''}`}
                title={item.name}
                onClick={() => updater.patch({ iconName: item.id, svg: item.svg }, 'Change graphic')}
                dangerouslySetInnerHTML={{
                  __html: `<svg viewBox="0 0 24 24" width="20" height="20" style="color:var(--text-secondary)">${item.svg}</svg>`
                }}
              />
            ))}
          </div>
        </Accordion>
      )}
    </div>
  )
}

function EffectsTab({ clip }: { clip: Clip }): JSX.Element {
  const updater = useClipUpdater(clip)
  const setEffects = (next: Clip['effects']) => updater.patch({ effects: next }, 'Edit effects')

  return (
    <div className="stack-md" style={{ padding: 12 }}>
      {EFFECT_DEFS.map((def) => {
        const effect = clip.effects.find((e) => e.type === def.type)
        return (
          <div key={def.type} className="effect-row">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12.5, fontWeight: 560 }}>{def.label}</span>
              <Switch
                label={def.label}
                checked={Boolean(effect)}
                onChange={(on) => {
                  if (on) setEffects([...clip.effects, makeEffect(def.type)])
                  else setEffects(clip.effects.filter((e) => e.type !== def.type))
                }}
              />
            </div>
            {effect && (
              <Slider
                value={effect.value}
                min={def.min}
                max={def.max}
                step={def.step}
                onChange={(v) => setEffects(clip.effects.map((e) => (e.id === effect.id ? { ...e, value: v } : e)))}
                format={(v) => `${v.toFixed(2)}${def.unit ?? ''}`}
              />
            )}
          </div>
        )
      })}
      <div className="hint">
        Effects are evaluated by the preview canvas and the ffmpeg renderer from the same clip data, so the
        export matches what you see.
      </div>
    </div>
  )
}

function MotionTab({ clip }: { clip: Clip }): JSX.Element {
  const playhead = useEditor((s) => s.playhead)
  const updater = useClipUpdater(clip)
  const local = Math.max(0, Math.min(clip.duration, playhead - clip.start))
  const [prop, setProp] = useState<AnimatableProp>('scale')
  const [easing, setEasing] = useState<EasingKind>('easeInOut')
  const track = clip.keyframes[prop] ?? []
  const sampled = sampleTrack(track, local)
  const currentValue = sampled ?? defaultValue(clip, prop)

  const mutate = (mutator: (clip: Clip) => Clip) =>
    useEditor.getState().apply(
      (p) => ({ ...p, clips: p.clips.map((c) => (c.id === clip.id ? mutator(c) : c)) }),
      'Edit keyframes'
    )

  return (
    <div className="stack-md" style={{ padding: 12 }}>
      <Field label="Property">
        <select className="select" value={prop} onChange={(e) => setProp(e.target.value as AnimatableProp)}>
          {ANIMATABLE.map((a) => (
            <option key={a.prop} value={a.prop}>
              {a.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="row">
        <Button
          size="sm"
          variant="primary"
          icon={<Plus size={12} />}
          onClick={() =>
            mutate((c) => ({
              ...c,
              keyframes: addKeyframe(c.keyframes, prop, { t: local, value: currentValue, easing: { kind: easing } })
            }))
          }
        >
          Add keyframe at {(local / 1000).toFixed(2)}s
        </Button>
        <Button size="sm" onClick={() => mutate((c) => ({ ...c, keyframes: {} }))}>
          Clear
        </Button>
      </div>
      <Field label="Easing for new keyframes">
        <select className="select" value={easing} onChange={(e) => setEasing(e.target.value as EasingKind)}>
          {EASING_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>

      <div className="label">{ANIMATABLE.find((a) => a.prop === prop)?.label} keyframes ({track.length})</div>
      {track.length === 0 ? (
        <div className="hint">No keyframes. Move the playhead, set a value and add one to start animating.</div>
      ) : (
        <div className="kf-list">
          {track.map((kf) => (
            <div className="kf-row" key={kf.id}>
              <Diamond size={11} style={{ color: 'var(--brand)', flex: 'none' }} />
              <input
                className="input mono kf-row__time"
                defaultValue={formatClock(kf.t, true)}
                key={`t-${kf.id}-${kf.t}`}
                onBlur={(e) => {
                  const ms = parseClock(e.target.value)
                  if (ms !== null)
                    mutate((c) => ({ ...c, keyframes: updateKeyframe(c.keyframes, prop, kf.id, { t: Math.max(0, ms) }) }))
                }}
              />
              <input
                className="input mono kf-row__value"
                type="number"
                step={0.01}
                value={Number(kf.value.toFixed(3))}
                onChange={(e) =>
                  mutate((c) => ({
                    ...c,
                    keyframes: updateKeyframe(c.keyframes, prop, kf.id, { value: Number(e.target.value) })
                  }))
                }
              />
              <select
                className="select kf-row__easing"
                value={kf.easing.kind}
                onChange={(e) =>
                  mutate((c) => ({
                    ...c,
                    keyframes: updateKeyframe(c.keyframes, prop, kf.id, { easing: { kind: e.target.value as EasingKind } })
                  }))
                }
              >
                {EASING_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              <IconButton
                label="Delete keyframe"
                onClick={() => mutate((c) => ({ ...c, keyframes: removeKeyframe(c.keyframes, prop, kf.id) }))}
              >
                <Trash2 size={12} />
              </IconButton>
            </div>
          ))}
        </div>
      )}

      {track.length > 1 && (
        <div className="kf-graph">
          <div className="label">Curve</div>
          <svg viewBox="0 0 100 40" preserveAspectRatio="none" style={{ width: '100%', height: 60 }}>
            <CurvePath clip={clip} prop={prop} />
          </svg>
        </div>
      )}

      <div className="hint">
        Values animate on the clip's own timeline. Move or trim the clip and keyframes follow it.
      </div>
    </div>
  )
}

function CurvePath({ clip, prop }: { clip: Clip; prop: AnimatableProp }): JSX.Element {
  const track = clip.keyframes[prop] ?? []
  const values = track.map((k) => k.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const points: string[] = []
  const steps = 60
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * clip.duration
    const v = sampleTrack(track, t) ?? min
    const x = (i / steps) * 100
    const y = 38 - ((v - min) / span) * 36
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`)
  }
  return (
    <>
      <polyline points={points.join(' ')} fill="none" stroke="var(--brand)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      {track.map((k) => {
        const x = (k.t / Math.max(1, clip.duration)) * 100
        const y = 38 - ((k.value - min) / span) * 36
        return <circle key={k.id} cx={x} cy={y} r="1.6" fill="var(--accent)" />
      })}
    </>
  )
}

function AudioTab({ clip }: { clip: Clip }): JSX.Element {
  const updater = useClipUpdater(clip)
  const setAudio = (patch: Partial<Clip['audio']>) =>
    updater.patch({ audio: { ...clip.audio, ...patch } }, 'Edit audio')
  return (
    <div className="stack-md" style={{ padding: 12 }}>
      <Field label="Volume">
        <Slider value={clip.audio.volume} min={0} max={1.5} step={0.01} onChange={(v) => setAudio({ volume: v })} format={(v) => `${Math.round(v * 100)}%`} />
      </Field>
      <Field label="Gain">
        <Slider value={clip.audio.gainDb} min={-24} max={24} step={0.5} onChange={(v) => setAudio({ gainDb: v })} format={(v) => `${v > 0 ? '+' : ''}${v} dB`} />
      </Field>
      <div className="row">
        <Field label="Fade in (ms)">
          <input className="input mono" type="number" min={0} max={10000} step={50} value={clip.audio.fadeInMs} onChange={(e) => setAudio({ fadeInMs: Number(e.target.value) })} />
        </Field>
        <Field label="Fade out (ms)">
          <input className="input mono" type="number" min={0} max={10000} step={50} value={clip.audio.fadeOutMs} onChange={(e) => setAudio({ fadeOutMs: Number(e.target.value) })} />
        </Field>
      </div>
      {(
        [
          ['muted', 'Mute clip'],
          ['normalize', 'Normalise loudness'],
          ['showWaveform', 'Show waveform'],
          ['ducking', 'Duck under speech']
        ] as const
      ).map(([key, label]) => (
        <div key={key} className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12.5 }}>{label}</span>
          <Switch label={label} checked={Boolean(clip.audio[key])} onChange={(v) => setAudio({ [key]: v })} />
        </div>
      ))}
      <Field label="Bass">
        <Slider value={clip.audio.bass} min={-15} max={15} step={0.5} onChange={(v) => setAudio({ bass: v })} format={(v) => `${v} dB`} />
      </Field>
      <Field label="Treble">
        <Slider value={clip.audio.treble} min={-15} max={15} step={0.5} onChange={(v) => setAudio({ treble: v })} format={(v) => `${v} dB`} />
      </Field>
      <Field label="Pan">
        <Slider
          value={clip.audio.pan}
          min={-1}
          max={1}
          step={0.05}
          onChange={(v) => setAudio({ pan: v })}
          format={(v) => (v === 0 ? 'centre' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`)}
        />
      </Field>
      <div className="hint">Fades and gain are applied by the audio graph during export.</div>
    </div>
  )
}

function StyleControls({ clip }: { clip: Clip }): JSX.Element {
  const updater = useClipUpdater(clip)
  const style = clip.style ?? BASE_TEXT_STYLE
  const setStyle = (patch: Partial<NonNullable<Clip['style']>>) =>
    updater.patch({ style: { ...style, ...patch } }, 'Edit text style')
  return (
    <div className="stack-md">
      <Field label="Font">
        <select className="select" value={style.fontFamily} onChange={(e) => setStyle({ fontFamily: e.target.value })}>
          {FONT_STACKS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="row">
        <Field label="Size (px @ canvas)">
          <input className="input mono" type="number" min={8} max={400} value={style.fontSize} onChange={(e) => setStyle({ fontSize: Number(e.target.value) })} />
        </Field>
        <Field label="Weight">
          <select className="select" value={style.fontWeight} onChange={(e) => setStyle({ fontWeight: Number(e.target.value) })}>
            {[300, 400, 500, 600, 700, 800, 900].map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <Field label="Fill">
          <div className="color-swatch" style={{ background: style.color }}>
            <input type="color" value={toHex(style.color)} onChange={(e) => setStyle({ color: e.target.value })} />
          </div>
        </Field>
        <Field label="Highlight">
          <div className="color-swatch" style={{ background: style.highlightColor }}>
            <input type="color" value={toHex(style.highlightColor)} onChange={(e) => setStyle({ highlightColor: e.target.value })} />
          </div>
        </Field>
        <Field label="Outline">
          <div className="color-swatch" style={{ background: style.strokeColor }}>
            <input type="color" value={toHex(style.strokeColor)} onChange={(e) => setStyle({ strokeColor: e.target.value })} />
          </div>
        </Field>
      </div>
      <Field label="Outline width">
        <Slider value={style.strokeWidth} min={0} max={24} step={0.5} onChange={(v) => setStyle({ strokeWidth: v })} format={(v) => `${v}px`} />
      </Field>
      <Field label="Shadow blur">
        <Slider value={style.shadowBlur} min={0} max={40} onChange={(v) => setStyle({ shadowBlur: v })} format={(v) => `${v}px`} />
      </Field>
      <Field label="Letter spacing">
        <Slider value={style.letterSpacing} min={-5} max={20} step={0.5} onChange={(v) => setStyle({ letterSpacing: v })} format={(v) => `${v}px`} />
      </Field>
      <Field label="Line height">
        <Slider value={style.lineHeight} min={0.8} max={2.4} step={0.05} onChange={(v) => setStyle({ lineHeight: v })} format={(v) => v.toFixed(2)} />
      </Field>
      <div className="row">
        <Segmented
          value={style.align}
          onChange={(v) => setStyle({ align: v as 'left' | 'center' | 'right' })}
          options={[
            { id: 'left', label: 'Left' },
            { id: 'center', label: 'Centre' },
            { id: 'right', label: 'Right' }
          ]}
        />
        <label className="checkbox">
          <input type="checkbox" checked={Boolean(style.uppercase)} onChange={(e) => setStyle({ uppercase: e.target.checked })} />
          Uppercase
        </label>
      </div>
      <Field label="Plate colour">
        <div className="row">
          <div className="color-swatch" style={{ background: style.backgroundColor === 'transparent' ? 'transparent' : style.backgroundColor }}>
            <input type="color" value={toHex(style.backgroundColor)} onChange={(e) => setStyle({ backgroundColor: e.target.value })} />
          </div>
          <Button size="sm" onClick={() => setStyle({ backgroundColor: 'transparent', backgroundPadding: 0 })}>
            None
          </Button>
        </div>
      </Field>
    </div>
  )
}

function TextTab({ clip }: { clip: Clip }): JSX.Element {
  const updater = useClipUpdater(clip)
  if (clip.kind !== 'text' && clip.kind !== 'caption') {
    return <div className="hint" style={{ padding: 12 }}>Select a text or caption clip to edit typography.</div>
  }
  return (
    <div className="stack-md" style={{ padding: 12 }}>
      <Field label="Content">
        <textarea
          className="textarea"
          rows={3}
          value={clip.text ?? ''}
          onChange={(e) => updater.live({ text: e.target.value })}
          onBlur={() => updater.commit()}
        />
      </Field>
      <StyleControls clip={clip} />
      <Field label="Animation">
        <select
          className="select"
          value={clip.animation ?? 'none'}
          onChange={(e) => updater.patch({ animation: e.target.value as CaptionAnimation }, 'Set text animation')}
        >
          {TEXT_ANIMATIONS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label} — {a.description}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Animation duration">
        <Slider
          value={clip.animationDurationMs ?? 180}
          min={0}
          max={2000}
          step={20}
          onChange={(v) => updater.patch({ animationDurationMs: v }, 'Animation duration')}
          format={(v) => `${v}ms`}
        />
      </Field>
    </div>
  )
}

function CaptionTab({ clip }: { clip: Clip }): JSX.Element {
  const updater = useClipUpdater(clip)
  const apply = useEditor((s) => s.apply)
  const { captionPresets } = useApp()
  if (clip.kind !== 'caption') {
    return <div className="hint" style={{ padding: 12 }}>Select a caption clip to edit its style and wording.</div>
  }
  return (
    <div className="stack-md" style={{ padding: 12 }}>
      <Field label="Caption text">
        <textarea
          className="textarea"
          rows={3}
          value={clip.text ?? ''}
          onChange={(e) => updater.live({ text: e.target.value })}
          onBlur={() => updater.commit()}
        />
      </Field>
      <Field label="Style preset">
        <select
          className="select"
          value={clip.captionPresetId ?? ''}
          onChange={(e) => {
            const preset = captionPresets.find((p) => p.id === e.target.value)
            if (!preset) return
            updater.patch(
              {
                captionPresetId: preset.id,
                style: { ...preset.style },
                layout: { ...preset.layout },
                animation: preset.animation,
                animationDurationMs: preset.animationDurationMs,
                highlightMode: preset.highlightMode
              },
              'Apply caption preset'
            )
          }}
        >
          <option value="">Custom</option>
          {captionPresets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Highlight mode">
        <Segmented
          value={clip.highlightMode ?? 'none'}
          onChange={(v) => updater.patch({ highlightMode: v as 'none' | 'keyword' | 'spoken' }, 'Highlight mode')}
          options={[
            { id: 'none', label: 'None' },
            { id: 'keyword', label: 'Keywords' },
            { id: 'spoken', label: 'Karaoke' }
          ]}
        />
      </Field>
      {clip.words && clip.words.length > 0 && (
        <>
          <div className="label">Word timing</div>
          <div className="word-timings">
            {clip.words.map((word, i) => (
              <span key={`${word.text}-${i}`} className="word-chip" title={`${formatClock(word.start, true)} → ${formatClock(word.end, true)}`}>
                {word.text}
              </span>
            ))}
          </div>
        </>
      )}
      <StyleControls clip={clip} />
      <Button
        size="sm"
        onClick={() => {
          const style = clip.style
          if (!style) return
          apply(
            (p) => ({
              ...p,
              clips: p.clips.map((c) =>
                c.kind !== 'caption'
                  ? c
                  : {
                      ...c,
                      captionPresetId: clip.captionPresetId,
                      style: { ...style },
                      layout: { ...clip.layout! },
                      animation: clip.animation,
                      highlightMode: clip.highlightMode
                    }
              )
            }),
            'Apply caption style to all'
          )
          useEditor.getState().notify({ kind: 'success', title: 'Style applied to every caption in this project' })
        }}
      >
        Apply this style to all captions
      </Button>
    </div>
  )
}

/* ------------------------------ helpers ------------------------------ */

function defaultValue(clip: Clip, prop: AnimatableProp): number {
  const t = clip.transform
  switch (prop) {
    case 'x':
      return t.x
    case 'y':
      return t.y
    case 'scale':
      return t.scale * t.scaleX
    case 'rotation':
      return t.rotation
    case 'opacity':
      return t.opacity
    case 'volume':
      return clip.audio.volume
    case 'scaleX':
      return t.scaleX
    case 'scaleY':
      return t.scaleY
    case 'cropL':
    case 'cropR':
    case 'cropT':
    case 'cropB':
      return t[prop]
    default:
      return 1
  }
}

function parseClock(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000)
  const parts = trimmed.split(':').map(Number)
  if (parts.some((part) => Number.isNaN(part))) return null
  if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000)
  if (parts.length === 3) return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000)
  return null
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
