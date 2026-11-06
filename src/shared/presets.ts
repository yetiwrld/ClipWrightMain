/** Aspect ratios, resolutions, caption presets, text animations, effects, transitions, icons. */
import type {
  CaptionAnimation,
  CaptionPreset,
  Effect,
  EffectType,
  ExportPreset,
  TextStyle,
  TextBoxLayout,
  TransitionType
} from './types'

export interface AspectPreset {
  id: string
  label: string
  ratio: number
  aspect: string
  note: string
}

export const ASPECT_PRESETS: AspectPreset[] = [
  { id: '9:16', label: 'Vertical', ratio: 9 / 16, aspect: '9:16', note: 'Reels · Shorts · TikTok' },
  { id: '16:9', label: 'Landscape', ratio: 16 / 9, aspect: '16:9', note: 'YouTube · Web' },
  { id: '1:1', label: 'Square', ratio: 1, aspect: '1:1', note: 'Feed posts' },
  { id: '4:5', label: 'Portrait', ratio: 4 / 5, aspect: '4:5', note: 'Instagram portrait' },
  { id: '4:3', label: 'Classic', ratio: 4 / 3, aspect: '4:3', note: 'Classic TV' },
  { id: '21:9', label: 'Cinema', ratio: 21 / 9, aspect: '21:9', note: 'Ultra-wide' },
  { id: 'original', label: 'Original', ratio: 16 / 9, aspect: 'original', note: 'Match the source' },
  { id: 'custom', label: 'Custom', ratio: 16 / 9, aspect: 'custom', note: 'Set your own ratio' }
]

export function aspectToNumber(aspect: string): number {
  if (aspect === 'original' || aspect === 'custom') return 16 / 9
  const [w, h] = aspect.split(':').map(Number)
  if (!w || !h) return 16 / 9
  return w / h
}

/** Compute canvas dimensions that keep the aspect and stay even (required by H.264). */
export function canvasSizeFor(aspect: string, longEdge = 1920): { width: number; height: number } {
  const ratio = aspectToNumber(aspect)
  let width: number
  let height: number
  if (ratio >= 1) {
    width = longEdge
    height = Math.round(longEdge / ratio)
  } else {
    height = longEdge
    width = Math.round(longEdge * ratio)
  }
  width -= width % 2
  height -= height % 2
  return { width, height }
}

/** Recommend the closest aspect preset for a source file. */
export function recommendAspect(width: number, height: number): string {
  if (!width || !height) return '16:9'
  const r = width / height
  const candidates: [string, number][] = [
    ['9:16', 9 / 16],
    ['16:9', 16 / 9],
    ['1:1', 1],
    ['4:5', 4 / 5],
    ['4:3', 4 / 3],
    ['21:9', 21 / 9]
  ]
  let best = '16:9'
  let bestDiff = Infinity
  for (const [id, ratio] of candidates) {
    const diff = Math.abs(ratio - r)
    if (diff < bestDiff) {
      bestDiff = diff
      best = id
    }
  }
  return bestDiff < 0.02 ? best : 'original'
}

/* ------------------------------------------------------------------ */
/* Export presets                                                     */
/* ------------------------------------------------------------------ */

interface ResPreset {
  id: string
  label: string
  longEdge: number
  note: string
}

export const RESOLUTION_PRESETS: ResPreset[] = [
  { id: '720p', label: 'HD 720p', longEdge: 1280, note: 'Fast uploads' },
  { id: '1080p', label: 'Full HD 1080p', longEdge: 1920, note: 'Recommended' },
  { id: 'dci2k', label: 'DCI 2K', longEdge: 2048, note: 'Cinema 2K' },
  { id: '1440p', label: 'QHD 1440p', longEdge: 2560, note: 'High detail' },
  { id: '2160p', label: '4K UHD', longEdge: 3840, note: 'Maximum quality' }
]

export function resolveExportDimensions(
  resolutionId: string,
  aspect: string
): { width: number; height: number } {
  const preset = RESOLUTION_PRESETS.find((r) => r.id === resolutionId) ?? RESOLUTION_PRESETS[1]
  return canvasSizeFor(aspect, preset.longEdge)
}

export function bitrateFor(width: number, height: number, fps: number): number {
  // Sensible H.264 bitrate ladder based on pixel throughput.
  const pixels = width * height * fps
  const perPixel = 0.085 // kbps per pixel/sec — tuned for good quality at reasonable size
  const mbps = (pixels * perPixel) / 1000
  return Math.round(Math.min(60000, Math.max(1200, mbps)))
}

export function buildExportPreset(
  resolutionId: string,
  aspect: string,
  fps: number,
  opts: Partial<ExportPreset> = {}
): ExportPreset {
  const { width, height } = resolveExportDimensions(resolutionId, aspect)
  return {
    id: `${resolutionId}-${aspect.replace(':', 'x')}-${fps}`,
    label: `${RESOLUTION_PRESETS.find((r) => r.id === resolutionId)?.label ?? resolutionId} · ${aspect} · ${fps}fps`,
    width,
    height,
    fps,
    aspect,
    videoBitrateKbps: bitrateFor(width, height, fps),
    audioBitrateKbps: 192,
    videoCodec: 'h264',
    audioCodec: 'aac',
    container: 'mp4',
    speed: 'medium',
    ...opts
  }
}

export const CONTAINER_OPTIONS = [
  {
    id: 'mp4',
    label: 'MP4',
    video: 'h264' as const,
    audio: 'aac' as const,
    note: 'Most compatible · H.264 / AAC'
  },
  {
    id: 'mp4-hevc',
    label: 'MP4 (HEVC)',
    video: 'hevc' as const,
    audio: 'aac' as const,
    note: 'Smaller files · needs HEVC support'
  },
  {
    id: 'webm',
    label: 'WebM',
    video: 'vp9' as const,
    audio: 'opus' as const,
    note: 'Open format · web friendly'
  },
  {
    id: 'mov',
    label: 'MOV',
    video: 'h264' as const,
    audio: 'aac' as const,
    note: 'Pro workflows'
  }
]

/* ------------------------------------------------------------------ */
/* Text styles & caption presets                                      */
/* ------------------------------------------------------------------ */

export const FONT_STACKS: { id: string; label: string; stack: string }[] = [
  { id: 'inter', label: 'Inter', stack: '"Inter", "Segoe UI Variable", "Segoe UI", sans-serif' },
  { id: 'system', label: 'Segoe UI', stack: '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif' },
  { id: 'montserrat', label: 'Montserrat', stack: '"Montserrat", "Segoe UI", sans-serif' },
  { id: 'poppins', label: 'Poppins', stack: '"Poppins", "Segoe UI", sans-serif' },
  { id: 'bebas', label: 'Bebas Neue', stack: '"Bebas Neue", "Impact", sans-serif' },
  { id: 'anton', label: 'Anton', stack: '"Anton", "Impact", sans-serif' },
  { id: 'georgia', label: 'Georgia', stack: 'Georgia, "Times New Roman", serif' },
  { id: 'playfair', label: 'Playfair', stack: '"Playfair Display", Georgia, serif' },
  { id: 'jetbrains', label: 'JetBrains Mono', stack: '"JetBrains Mono", Consolas, monospace' },
  { id: 'oswald', label: 'Oswald', stack: '"Oswald", "Segoe UI", sans-serif' }
]

export function fontStack(id: string): string {
  return FONT_STACKS.find((f) => f.id === id)?.stack ?? FONT_STACKS[0].stack
}

export const BASE_TEXT_STYLE: TextStyle = {
  fontFamily: 'inter',
  fontSize: 56,
  fontWeight: 800,
  italic: false,
  underline: false,
  color: '#FFFFFF',
  highlightColor: '#FF7A18',
  strokeColor: '#0A0A0B',
  strokeWidth: 0,
  shadowColor: 'rgba(0,0,0,0.55)',
  shadowBlur: 12,
  shadowOffsetX: 0,
  shadowOffsetY: 4,
  backgroundColor: 'transparent',
  backgroundPadding: 0,
  borderRadius: 8,
  align: 'center',
  letterSpacing: 0,
  lineHeight: 1.18,
  wordSpacing: 0,
  uppercase: false
}

export const FALLBACK_CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: 'clean-minimal',
    name: 'Clean Minimal',
    description: 'Quiet white subtitles with a soft shadow. One line at a time.',
    category: 'minimal',
    style: { ...BASE_TEXT_STYLE, fontSize: 46, fontWeight: 600, color: '#FFFFFF', shadowBlur: 10 },
    layout: { x: 0.5, y: 0.86, width: 0.8, height: 0.16, anchor: 'bottom', maxWidthPct: 80 },
    animation: 'fade',
    animationDurationMs: 180,
    wordsPerLine: 7,
    uppercase: false,
    highlightMode: 'none'
  },
  {
    id: 'bold-creator',
    name: 'Bold Creator',
    description: 'Heavy uppercase words with a punchy pop-in. Built for short form.',
    category: 'creator',
    style: {
      ...BASE_TEXT_STYLE,
      fontSize: 62,
      fontWeight: 900,
      color: '#FFFFFF',
      strokeColor: '#0A0A0B',
      strokeWidth: 6,
      shadowBlur: 14,
      uppercase: true
    },
    layout: { x: 0.5, y: 0.5, width: 0.84, height: 0.3, anchor: 'center', maxWidthPct: 84 },
    animation: 'pop',
    animationDurationMs: 140,
    wordsPerLine: 3,
    uppercase: true,
    highlightMode: 'none'
  },
  {
    id: 'keyword-highlight',
    name: 'Keyword Highlight',
    description: 'Neutral base text with the emphasis word picked out in brand orange.',
    category: 'creator',
    style: {
      ...BASE_TEXT_STYLE,
      fontSize: 60,
      fontWeight: 800,
      color: '#FFFFFF',
      highlightColor: '#FF7A18',
      strokeColor: '#0A0A0B',
      strokeWidth: 5,
      uppercase: true
    },
    layout: { x: 0.5, y: 0.5, width: 0.86, height: 0.3, anchor: 'center', maxWidthPct: 86 },
    animation: 'pop',
    animationDurationMs: 130,
    wordsPerLine: 3,
    uppercase: true,
    highlightMode: 'keyword'
  },
  {
    id: 'karaoke',
    name: 'Karaoke',
    description: 'Each word fills with colour as it is spoken.',
    category: 'animated',
    style: {
      ...BASE_TEXT_STYLE,
      fontSize: 54,
      fontWeight: 800,
      color: '#FFFFFF',
      highlightColor: '#FFC24B',
      strokeColor: '#0A0A0B',
      strokeWidth: 5,
      uppercase: true
    },
    layout: { x: 0.5, y: 0.8, width: 0.86, height: 0.2, anchor: 'bottom', maxWidthPct: 86 },
    animation: 'karaoke',
    animationDurationMs: 0,
    wordsPerLine: 5,
    uppercase: true,
    highlightMode: 'spoken'
  },
  {
    id: 'word-by-word',
    name: 'Word by Word',
    description: 'A single word at a time, snapping in on the beat of speech.',
    category: 'animated',
    style: {
      ...BASE_TEXT_STYLE,
      fontSize: 78,
      fontWeight: 900,
      color: '#FFFFFF',
      highlightColor: '#FF7A18',
      strokeColor: '#0A0A0B',
      strokeWidth: 7,
      uppercase: true
    },
    layout: { x: 0.5, y: 0.5, width: 0.8, height: 0.24, anchor: 'center', maxWidthPct: 80 },
    animation: 'wordByWord',
    animationDurationMs: 110,
    wordsPerLine: 1,
    uppercase: true,
    highlightMode: 'none'
  },
  {
    id: 'multiline',
    name: 'Multi-line Subtitles',
    description: 'Two relaxed lines with a translucent plate for readability.',
    category: 'minimal',
    style: {
      ...BASE_TEXT_STYLE,
      fontSize: 40,
      fontWeight: 500,
      color: '#F5F5F7',
      backgroundColor: 'rgba(10,10,12,0.62)',
      backgroundPadding: 18,
      borderRadius: 10,
      shadowBlur: 0,
      lineHeight: 1.3
    },
    layout: { x: 0.5, y: 0.88, width: 0.78, height: 0.2, anchor: 'bottom', maxWidthPct: 78 },
    animation: 'fade',
    animationDurationMs: 160,
    wordsPerLine: 10,
    uppercase: false,
    highlightMode: 'none'
  },
  {
    id: 'editorial',
    name: 'Editorial',
    description: 'Serif subtitles with generous spacing for documentary work.',
    category: 'editorial',
    style: {
      ...BASE_TEXT_STYLE,
      fontFamily: 'georgia',
      fontSize: 42,
      fontWeight: 600,
      color: '#FFFFFF',
      letterSpacing: 0.4,
      shadowBlur: 8,
      lineHeight: 1.35
    },
    layout: { x: 0.5, y: 0.87, width: 0.76, height: 0.2, anchor: 'bottom', maxWidthPct: 76 },
    animation: 'fade',
    animationDurationMs: 220,
    wordsPerLine: 9,
    uppercase: false,
    highlightMode: 'none'
  },
  {
    id: 'podcast',
    name: 'Podcast',
    description: 'Speaker name plate plus two calm lines of text.',
    category: 'social',
    style: {
      ...BASE_TEXT_STYLE,
      fontSize: 40,
      fontWeight: 600,
      color: '#FFFFFF',
      highlightColor: '#FF7A18',
      backgroundColor: 'rgba(20,20,24,0.7)',
      backgroundPadding: 22,
      borderRadius: 14,
      shadowBlur: 0,
      align: 'left'
    },
    layout: { x: 0.5, y: 0.84, width: 0.8, height: 0.22, anchor: 'bottom', maxWidthPct: 80 },
    animation: 'slideUp',
    animationDurationMs: 200,
    wordsPerLine: 9,
    uppercase: false,
    highlightMode: 'none'
  },
  {
    id: 'social-pop',
    name: 'Social Pop',
    description: 'Tight uppercase blocks with an orange keyline and bounce.',
    category: 'social',
    style: {
      ...BASE_TEXT_STYLE,
      fontSize: 58,
      fontWeight: 900,
      color: '#0A0A0B',
      backgroundColor: '#FF7A18',
      backgroundPadding: 16,
      borderRadius: 10,
      uppercase: true,
      shadowBlur: 18,
      shadowColor: 'rgba(255,122,24,0.35)'
    },
    layout: { x: 0.5, y: 0.5, width: 0.84, height: 0.26, anchor: 'center', maxWidthPct: 84 },
    animation: 'bounce',
    animationDurationMs: 180,
    wordsPerLine: 3,
    uppercase: true,
    highlightMode: 'none'
  },
  {
    id: 'typewriter',
    name: 'Typewriter',
    description: 'Characters reveal in sequence — good for quotes and hooks.',
    category: 'animated',
    style: { ...BASE_TEXT_STYLE, fontSize: 48, fontWeight: 700, color: '#FFFFFF', align: 'left' },
    layout: { x: 0.5, y: 0.5, width: 0.78, height: 0.3, anchor: 'center', maxWidthPct: 78 },
    animation: 'typewriter',
    animationDurationMs: 600,
    wordsPerLine: 6,
    uppercase: false,
    highlightMode: 'none'
  }
]

/* ------------------------------------------------------------------ */
/* Text animation presets                                             */
/* ------------------------------------------------------------------ */

export const TEXT_ANIMATIONS = [
  { id: 'none', label: 'None', description: 'Static text' },
  { id: 'fade', label: 'Fade', description: 'Opacity ramp in' },
  { id: 'slideUp', label: 'Slide up', description: 'Slides in from below' },
  { id: 'pop', label: 'Pop', description: 'Scales in with overshoot' },
  { id: 'bounce', label: 'Bounce', description: 'Ease-out bounce' },
  { id: 'typewriter', label: 'Typewriter', description: 'Characters reveal' },
  { id: 'scale', label: 'Scale', description: 'Grows from small' },
  { id: 'wipe', label: 'Wipe', description: 'Left-to-right reveal' },
  { id: 'reveal', label: 'Reveal', description: 'Masked slide reveal' },
  { id: 'wordByWord', label: 'Word by word', description: 'One word at a time' },
  { id: 'letterByLetter', label: 'Letter by letter', description: 'Characters in sequence' }
] as const

/* ------------------------------------------------------------------ */
/* Effects                                                            */
/* ------------------------------------------------------------------ */

export const EFFECT_DEFS: {
  type: EffectType
  label: string
  min: number
  max: number
  neutral: number
  step: number
  unit?: string
}[] = [
  { type: 'brightness', label: 'Brightness', min: -1, max: 1, neutral: 0, step: 0.01 },
  { type: 'contrast', label: 'Contrast', min: 0, max: 2, neutral: 1, step: 0.01 },
  { type: 'saturation', label: 'Saturation', min: 0, max: 2, neutral: 1, step: 0.01 },
  { type: 'temperature', label: 'Temperature', min: -1, max: 1, neutral: 0, step: 0.01 },
  { type: 'tint', label: 'Tint', min: -1, max: 1, neutral: 0, step: 0.01 },
  { type: 'exposure', label: 'Exposure', min: -2, max: 2, neutral: 0, step: 0.01 },
  { type: 'sharpen', label: 'Sharpen', min: 0, max: 2, neutral: 0, step: 0.01 },
  { type: 'blur', label: 'Blur', min: 0, max: 20, neutral: 0, step: 0.5, unit: 'px' },
  { type: 'vignette', label: 'Vignette', min: 0, max: 1, neutral: 0, step: 0.01 },
  { type: 'speed', label: 'Speed', min: 0.25, max: 4, neutral: 1, step: 0.05, unit: '×' }
]

export function makeEffect(type: EffectType): Effect {
  const def = EFFECT_DEFS.find((d) => d.type === type)!
  return { id: `fx_${Math.random().toString(36).slice(2, 9)}`, type, enabled: true, value: def.neutral }
}

/* ------------------------------------------------------------------ */
/* Transitions                                                        */
/* ------------------------------------------------------------------ */

export const TRANSITIONS: { type: TransitionType; label: string; description: string }[] = [
  { type: 'crossfade', label: 'Crossfade', description: 'Blend between clips' },
  { type: 'dissolve', label: 'Dissolve', description: 'Soft grain dissolve' },
  { type: 'fadeToBlack', label: 'Fade to black', description: 'Fade out to black' },
  { type: 'fadeFromBlack', label: 'Fade from black', description: 'Fade in from black' },
  { type: 'wipeLeft', label: 'Wipe left', description: 'Horizontal wipe' },
  { type: 'wipeRight', label: 'Wipe right', description: 'Reverse horizontal wipe' },
  { type: 'slideLeft', label: 'Slide left', description: 'Slide out to the left' },
  { type: 'slideUp', label: 'Slide up', description: 'Slide up into frame' },
  { type: 'zoomIn', label: 'Zoom in', description: 'Push into the next clip' },
  { type: 'zoomOut', label: 'Zoom out', description: 'Pull back from the previous clip' }
]

/* ------------------------------------------------------------------ */
/* Built-in graphics library (offline, bundle-safe)                   */
/* ------------------------------------------------------------------ */

export const ICON_LIBRARY: { id: string; name: string; category: string; svg: string }[] = [
  {
    id: 'arrow-right',
    name: 'Arrow right',
    category: 'arrows',
    svg: '<path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
  },
  {
    id: 'arrow-up',
    name: 'Arrow up',
    category: 'arrows',
    svg: '<path d="M12 19V5M6 11l6-6 6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
  },
  {
    id: 'arrow-curved',
    name: 'Curved arrow',
    category: 'arrows',
    svg: '<path d="M4 18c0-7 5-11 12-11h4M17 3l4 4-4 4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
  },
  {
    id: 'circle-outline',
    name: 'Circle',
    category: 'shapes',
    svg: '<circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="2.2" fill="none"/>'
  },
  {
    id: 'circle-solid',
    name: 'Dot',
    category: 'shapes',
    svg: '<circle cx="12" cy="12" r="8.5" fill="currentColor"/>'
  },
  {
    id: 'square',
    name: 'Square',
    category: 'shapes',
    svg: '<rect x="4" y="4" width="16" height="16" rx="3" stroke="currentColor" stroke-width="2.2" fill="none"/>'
  },
  {
    id: 'triangle',
    name: 'Triangle',
    category: 'shapes',
    svg: '<path d="M12 4l8 16H4z" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linejoin="round"/>'
  },
  {
    id: 'star',
    name: 'Star',
    category: 'shapes',
    svg: '<path d="M12 3.5l2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.9l6.1-.8z" fill="currentColor"/>'
  },
  {
    id: 'line',
    name: 'Line',
    category: 'lines',
    svg: '<path d="M3 12h18" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>'
  },
  {
    id: 'underline',
    name: 'Accent bar',
    category: 'lines',
    svg: '<rect x="3" y="10" width="18" height="4" rx="2" fill="currentColor"/>'
  },
  {
    id: 'check',
    name: 'Check',
    category: 'icons',
    svg: '<path d="M4 12.5l5 5L20 6.5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
  },
  {
    id: 'cross',
    name: 'Cross',
    category: 'icons',
    svg: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'
  },
  {
    id: 'bolt',
    name: 'Bolt',
    category: 'icons',
    svg: '<path d="M13 2L4 14h6l-1 8 9-12h-6z" fill="currentColor"/>'
  },
  {
    id: 'flame',
    name: 'Flame',
    category: 'icons',
    svg: '<path d="M12 2s5 5.5 5 10a5 5 0 01-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3s1.5-1 1.5-2.5S12 2 12 2z" fill="currentColor"/>'
  },
  {
    id: 'play',
    name: 'Play',
    category: 'icons',
    svg: '<path d="M7 4.5l12 7.5-12 7.5z" fill="currentColor"/>'
  },
  {
    id: 'quote',
    name: 'Quote',
    category: 'icons',
    svg: '<path d="M9 6H4v6h4v3H4v3h8V6H9zm11 0h-5v6h4v3h-4v3h8V6h-3z" fill="currentColor"/>'
  },
  {
    id: 'mic',
    name: 'Microphone',
    category: 'icons',
    svg: '<rect x="9" y="2.5" width="6" height="11" rx="3" stroke="currentColor" stroke-width="2.2" fill="none"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>'
  },
  {
    id: 'waveform',
    name: 'Waveform',
    category: 'icons',
    svg: '<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'
  },
  {
    id: 'badge',
    name: 'Badge',
    category: 'shapes',
    svg: '<path d="M12 2l2.6 2 3.2-.4 1 3.2L21.6 9l-1.4 2.9L21.6 15l-2.8 2.2-1 3.2-3.2-.4L12 22l-2.6-2-3.2.4-1-3.2L2.4 15l1.4-2.9L2.4 9l2.8-2.2 1-3.2 3.2.4z" stroke="currentColor" stroke-width="1.6" fill="none"/>'
  },
  {
    id: 'frame',
    name: 'Frame',
    category: 'shapes',
    svg: '<rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M8 3v18M16 3v18M3 8h18M3 16h18" stroke="currentColor" stroke-width="1" opacity="0.5"/>'
  }
]

/* ------------------------------------------------------------------ */
/* Misc                                                              */
/* ------------------------------------------------------------------ */

export const DEFAULT_SHORTCUTS: Record<string, string> = {
  playPause: 'Space',
  save: 'Ctrl+S',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Shift+Z',
  split: 'Ctrl+K',
  deleteClip: 'Delete',
  duplicate: 'Ctrl+D',
  copy: 'Ctrl+C',
  paste: 'Ctrl+V',
  cut: 'Ctrl+X',
  zoomIn: 'Ctrl+=',
  zoomOut: 'Ctrl+-',
  fitTimeline: 'Shift+Z',
  prevFrame: 'ArrowLeft',
  nextFrame: 'ArrowRight',
  prevCut: 'Shift+ArrowLeft',
  nextCut: 'Shift+ArrowRight',
  marker: 'M',
  export: 'Ctrl+E',
  importMedia: 'Ctrl+I',
  newProject: 'Ctrl+N',
  group: 'Ctrl+G',
  ungroup: 'Ctrl+Shift+G',
  rippleDelete: 'Shift+Delete',
  toggleSnap: 'S',
  deselect: 'Escape'
}
