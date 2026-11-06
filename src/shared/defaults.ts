import { baseClip, defaultTracks } from './timeline'
import { canvasSizeFor } from './presets'
import type { Project, Settings } from './types'

export const SCHEMA_VERSION = 1
export const APP_NAME = 'Clipwright Studio'
export const APP_ID = 'studio.clipwright.app'
export const REPO_OWNER = 'yetiwrld'
export const REPO_NAME = 'ClipWrightMain'

export const DEFAULT_SETTINGS: Settings = {
  version: SCHEMA_VERSION,
  general: {
    language: 'en',
    restoreLastProject: true,
    confirmDelete: true,
    showTips: true
  },
  appearance: {
    theme: 'dark',
    accent: '#FF7A18',
    density: 'comfortable',
    timelineClipHeight: 64,
    reduceMotion: false
  },
  storage: {
    workspaceRoot: '',
    defaultImportMode: 'managed',
    keepProxies: true
  },
  ai: {
    mode: 'auto',
    allowVision: false,
    allowTranscriptUpload: false,
    allowUploadWithoutConfirm: false
  },
  transcription: {
    language: 'en',
    autoDetect: true,
    speakerLabels: false,
    wordTimestamps: true,
    threads: 4,
    defaultModel: 'base.en'
  },
  performance: {
    proxyEnabled: false,
    proxyHeight: 720,
    hardwareAcceleration: true,
    previewQuality: 'half',
    maxConcurrentJobs: 2
  },
  export: {
    presetId: '1080p',
    outputDir: '',
    defaultResolution: '1080p',
    defaultFps: 30,
    crf: 19,
    hardwareEncoder: true,
    burnCaptions: true,
    writeSidecarSubtitles: false,
    validateAfterExport: true
  },
  updates: {
    autoCheck: true,
    intervalHours: 24,
    channel: 'stable'
  },
  shortcuts: {},
  privacy: {
    telemetry: false,
    keepLocalHistory: true
  },
  setup: {
    firstRunCompleted: false
  }
}

export function createProject(name: string, aspect = '9:16', fps = 30, id?: string): Project {
  const { width, height } = canvasSizeFor(aspect, 1920)
  const now = Date.now()
  return {
    schemaVersion: SCHEMA_VERSION,
    id: id ?? `prj_${Math.random().toString(36).slice(2, 10)}${now.toString(36)}`,
    name,
    createdAt: now,
    updatedAt: now,
    canvas: { aspect, width, height, fps, backgroundColor: '#000000' },
    fps,
    tracks: defaultTracks(),
    clips: [],
    assets: [],
    markers: []
  }
}

/** Convenience for the clip generator / tests: a project with one video clip. */
export function createClipProject(opts: {
  name: string
  aspect: string
  fps: number
  assetId?: string
  start: number
  duration: number
}): Project {
  const project = createProject(opts.name, opts.aspect, opts.fps)
  const videoTrack = project.tracks.find((t) => t.kind === 'video')!
  if (opts.assetId) {
    const clip = baseClip('video', videoTrack.id, opts.name)
    clip.assetId = opts.assetId
    clip.start = 0
    clip.duration = opts.duration
    clip.sourceIn = opts.start
    project.clips.push(clip)
  }
  return project
}

export function deepMerge<T>(base: T, patch: Partial<T> | undefined): T {
  if (!patch) return base
  if (Array.isArray(base) || typeof base !== 'object' || base === null) {
    return (patch as T) ?? base
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = (base as Record<string, unknown>)[key]
    if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object') {
      out[key] = deepMerge(current, value as Record<string, unknown>)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out as T
}
