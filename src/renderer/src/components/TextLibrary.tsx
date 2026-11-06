/**
 * Text & graphics library.
 *
 * Titles, lower-thirds and icons are real timeline clips: text clips carry a
 * TextStyle, graphic clips carry inline SVG. Both render through the same scene
 * graph as the exporter.
 */
import React, { useMemo, useState } from 'react'
import { AlignLeft, Shapes, Type } from 'lucide-react'
import { useEditor } from '../state/editor'
import { Badge, Button, Segmented } from './ui'
import { BASE_TEXT_STYLE, FALLBACK_CAPTION_PRESETS, ICON_LIBRARY, TEXT_ANIMATIONS } from '@shared/presets'
import { baseClip } from '@shared/timeline'
import { makeTrack } from '@shared/timeline'
import type { CaptionAnimation, Clip, TextStyle, Track } from '@shared/types'

interface TextTemplate {
  id: string
  name: string
  description: string
  text: string
  style: Partial<TextStyle>
  animation: CaptionAnimation
  y: number
}

const TEMPLATES: TextTemplate[] = [
  {
    id: 'title',
    name: 'Big title',
    description: 'Centred headline, punch-in pop',
    text: 'Your headline',
    style: { fontSize: 84, fontWeight: 900, uppercase: true, strokeWidth: 0, shadowBlur: 18 },
    animation: 'pop',
    y: 0.44
  },
  {
    id: 'lower-third',
    name: 'Lower third',
    description: 'Name + role plate at the bottom',
    text: 'Ada Lovelace\nAnalyst',
    style: {
      fontSize: 44,
      fontWeight: 700,
      align: 'left',
      uppercase: false,
      backgroundColor: 'rgba(12,12,14,0.82)',
      backgroundPadding: 18,
      borderRadius: 6
    },
    animation: 'slideUp',
    y: 0.78
  },
  {
    id: 'quote',
    name: 'Pull quote',
    description: 'Editorial serif with generous line height',
    text: '“The edit is where the story happens.”',
    style: { fontFamily: 'serif', fontSize: 56, fontWeight: 500, lineHeight: 1.35, italic: true, shadowBlur: 6 },
    animation: 'fade',
    y: 0.5
  },
  {
    id: 'caption-box',
    name: 'Caption box',
    description: 'SOLID plate, high contrast',
    text: 'IMPORTANT POINT',
    style: {
      fontSize: 52,
      fontWeight: 900,
      uppercase: true,
      color: '#0E0F11',
      backgroundColor: '#FF7A18',
      backgroundPadding: 20,
      shadowBlur: 0
    },
    animation: 'typewriter',
    y: 0.5
  },
  {
    id: 'cta',
    name: 'Call to action',
    description: 'Bottom-centre prompt',
    text: 'Follow for part two',
    style: { fontSize: 46, fontWeight: 700, uppercase: false, shadowBlur: 14 },
    animation: 'wordByWord',
    y: 0.86
  },
  {
    id: 'stats',
    name: 'Big number',
    description: 'Huge figure with a small label',
    text: '3.4M\nviews in a week',
    style: { fontSize: 96, fontWeight: 900, lineHeight: 0.98, strokeWidth: 0 },
    animation: 'scale' as unknown as CaptionAnimation,
    y: 0.46
  }
]

export function TextLibrary(): JSX.Element {
  const project = useEditor((s) => s.project)
  const playhead = useEditor((s) => s.playhead)
  const apply = useEditor((s) => s.apply)
  const notify = useEditor((s) => s.notify)
  const selectClips = useEditor((s) => s.selectClips)
  const setInspectorTab = useEditor((s) => s.setInspectorTab)
  const [tab, setTab] = useState<'text' | 'graphics'>('text')
  const [query, setQuery] = useState('')

  const graphics = useMemo(
    () => ICON_LIBRARY.filter((g) => (query ? g.name.toLowerCase().includes(query.toLowerCase()) : true)),
    [query]
  )

  const ensureTrack = (kind: Track['kind']): Track | null => {
    if (!project) return null
    const existing = project.tracks.find((t) => t.kind === kind)
    if (existing) return existing
    return makeTrack(kind, kind === 'graphic' ? 'Graphics' : 'Text', project.tracks.length)
  }

  const addText = (template: TextTemplate) => {
    if (!project) return
    const track = ensureTrack('text')
    if (!track) return
    const clip = baseClip('text', track.id, template.name)
    clip.start = playhead
    clip.duration = 3000
    clip.text = template.text
    clip.style = { ...BASE_TEXT_STYLE, ...template.style }
    clip.layout = {
      x: 0.5,
      y: template.y,
      width: 0.8,
      height: 0.24,
      anchor: template.y > 0.7 ? 'bottom' : 'center',
      maxWidthPct: 84
    }
    clip.transform = { ...clip.transform, x: 0.5, y: template.y }
    clip.animation = template.animation
    clip.animationDurationMs = 220
    insert(clip, track)
  }

  const addGraphic = (icon: { id: string; name: string; svg: string }) => {
    if (!project) return
    const track = ensureTrack('graphic')
    if (!track) return
    const clip = baseClip('graphic', track.id, icon.name)
    clip.start = playhead
    clip.duration = 2500
    clip.iconName = icon.id
    clip.svg = icon.svg
    clip.transform = { ...clip.transform, x: 0.5, y: 0.5, scaleX: 0.2, scaleY: 0.2 }
    insert(clip, track)
  }

  const insert = (clip: Clip, track: Track) => {
    apply(
      (p) => ({
        ...p,
        tracks: p.tracks.some((t) => t.id === track.id) ? p.tracks : [...p.tracks, track],
        clips: [...p.clips, clip]
      }),
      clip.kind === 'graphic' ? 'Add graphic' : 'Add text'
    )
    selectClips([clip.id])
    setInspectorTab(clip.kind === 'graphic' ? 'properties' : 'text')
    notify({
      kind: 'success',
      title: `${clip.kind === 'graphic' ? 'Graphic' : 'Text'} added at ${(playhead / 1000).toFixed(1)}s`,
      body: 'Drag the clip in the timeline to reposition it in time.'
    })
  }

  if (!project) {
    return <div className="panel"><div className="panel__body hint">Open a project to add text and graphics.</div></div>
  }

  return (
    <div className="panel text-library">
      <div className="text-library__tabs">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { id: 'text', label: 'Text' },
            { id: 'graphics', label: 'Icons' }
          ]}
        />
      </div>

      {tab === 'text' ? (
        <div className="panel__body stack-sm">
          {TEMPLATES.map((template) => (
            <button key={template.id} className="text-template" onClick={() => addText(template)}>
              <span
                className="text-template__preview"
                style={{
                  fontWeight: template.style.fontWeight,
                  fontSize: Math.min(15, (template.style.fontSize ?? 48) / 4),
                  textTransform: template.style.uppercase ? 'uppercase' : 'none',
                  fontStyle: template.style.italic ? 'italic' : 'normal',
                  background: template.style.backgroundColor,
                  color: template.style.color ?? 'var(--text)',
                  padding: template.style.backgroundPadding ? 3 : 0,
                  borderRadius: template.style.borderRadius
                }}
              >
                {template.text.split('\n')[0]}
              </span>
              <span className="text-template__meta">
                <span style={{ fontWeight: 560 }}>{template.name}</span>
                <span className="hint">{template.description}</span>
              </span>
            </button>
          ))}
          <div className="divider" />
          <div className="label">Caption presets</div>
          {FALLBACK_CAPTION_PRESETS.slice(0, 4).map((preset) => (
            <button
              key={preset.id}
              className="text-template"
              onClick={() => {
                const track = ensureTrack('caption')
                if (!track) return
                const clip = baseClip('caption', track.id, preset.name)
                clip.start = playhead
                clip.duration = 2500
                clip.text = 'Your caption line'
                clip.style = { ...preset.style }
                clip.layout = { ...preset.layout }
                clip.animation = preset.animation
                clip.animationDurationMs = preset.animationDurationMs
                clip.captionPresetId = preset.id
                insert(clip, track)
              }}
            >
              <span className="text-template__preview" style={{ fontWeight: preset.style.fontWeight }}>
                {preset.name}
              </span>
              <span className="text-template__meta">
                <span style={{ fontWeight: 560 }}>{preset.name}</span>
                <span className="hint">{preset.description}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="panel__body">
          <div className="search-field" style={{ marginBottom: 8 }}>
            <Shapes size={12} />
            <input className="input" placeholder="Search icons" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="icon-grid">
            {graphics.map((icon) => (
              <button
                key={icon.id}
                className="icon-grid__item"
                title={icon.name}
                onClick={() => addGraphic(icon)}
                dangerouslySetInnerHTML={{
                  __html: `<svg viewBox="0 0 24 24" width="20" height="20" style="color:var(--text-secondary)">${icon.svg}</svg>`
                }}
              />
            ))}
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            Icons are bundled SVG — they stay crisp at any size and need no internet connection.
          </div>
        </div>
      )}

      <div className="panel__footer">
        <div className="row" style={{ gap: 6 }}>
          <Button size="sm" variant="ghost" icon={<Type size={11} />} onClick={() => addText(TEMPLATES[0])}>
            Quick title
          </Button>
          <Button size="sm" variant="ghost" icon={<AlignLeft size={11} />} onClick={() => addText(TEMPLATES[1])}>
            Lower third
          </Button>
        </div>
      </div>
    </div>
  )
}

export const TEXT_ANIMATION_LIST = TEXT_ANIMATIONS
