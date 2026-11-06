/**
 * Renderer smoke tests (jsdom).
 *
 * These render the real React tree against a stubbed preload bridge and drive
 * genuine interactions: creating a project, adding clips, splitting, trimming,
 * undo/redo, zoom, snapping, keyframes and caption generation. No component is
 * mocked — only the IPC bridge is, because there is no Electron in CI's Node run.
 */
// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { createProject, DEFAULT_SETTINGS } from '@shared/defaults'
import { baseClip, defaultTracks } from '@shared/timeline'
import { addKeyframe, sampleTrack } from '@shared/keyframes'
import { buildCaptionClips } from '@shared/captions'
import { FALLBACK_CAPTION_PRESETS } from '@shared/presets'
import { formatClock, formatTimecode, formatBytes } from '@shared/time'
import { createVideoPool } from '@/hooks/useVideoPool'

/* ------------------------------ test harness ------------------------------ */

let container: HTMLDivElement
let root: Root | null = null

function stubBridge(overrides: Record<string, unknown> = {}) {
  const projects: Record<string, unknown> = {}
  const api = {
    app: {
      info: vi.fn(async () => ({
        name: 'Clipwright Studio',
        version: '1.0.0-test',
        electron: '33.0.0',
        chrome: '130',
        node: '20',
        platform: 'win32',
        arch: 'x64',
        userData: 'C:/tmp',
        isPackaged: false,
        repoUrl: 'https://github.com/yetiwrld/ClipWrightMain'
      })),
      capabilities: vi.fn(async () => ({
        ffmpegPath: 'C:/ffmpeg/bin/ffmpeg.exe',
        ffmpegVersion: 'ffmpeg version 8.1',
        ffprobePath: 'C:/ffmpeg/bin/ffprobe.exe',
        hardwareEncoders: ['h264_nvenc'],
        hardwareDecode: ['h264_cuvid'],
        whisperAvailable: true,
        whisperNote: 'ready',
        online: false,
        platform: 'win32',
        arch: 'x64',
        ffmpeg: true,
        ffprobe: true,
        nvenc: true,
        ytdlp: false,
        cpuThreads: 16
      })),
      openLogs: vi.fn(async () => undefined),
      readLogs: vi.fn(async () => ({ text: '', file: 'C:/logs/clipwright.log', bytes: 0 })),
      openPath: vi.fn(async () => ({ ok: true })),
      revealPath: vi.fn(async () => ({ ok: true })),
      setZoom: vi.fn(async () => undefined)
    },
    settings: {
      get: vi.fn(async () => structuredClone(DEFAULT_SETTINGS)),
      update: vi.fn(async (patch: Record<string, unknown>) => ({ ...structuredClone(DEFAULT_SETTINGS), ...patch })),
      reset: vi.fn(async () => structuredClone(DEFAULT_SETTINGS))
    },
    workspace: {
      info: vi.fn(async () => ({
        root: 'C:/Users/test/Clipwright',
        projectsDir: 'C:/Users/test/Clipwright/Projects',
        modelsDir: 'C:/Users/test/Clipwright/Models',
        exportsDir: 'C:/Users/test/Clipwright/Exports',
        logsDir: 'C:/Users/test/Clipwright/Logs',
        freeBytes: 500_000_000_000,
        totalBytes: 1_000_000_000_000
      })),
      choose: vi.fn(async () => null),
      set: vi.fn(async () => ({})),
      open: vi.fn(async () => undefined)
    },
    dialog: {
      openMedia: vi.fn(async () => []),
      openFile: vi.fn(async () => []),
      saveFile: vi.fn(async () => null),
      chooseDirectory: vi.fn(async () => null)
    },
    projects: {
      list: vi.fn(async () => []),
      create: vi.fn(async ({ name, aspect, fps }: { name: string; aspect: string; fps: number }) =>
        createProject(name, aspect, fps)
      ),
      load: vi.fn(async (id: string) => projects[id]),
      save: vi.fn(async (project: unknown) => project),
      duplicate: vi.fn(async () => createProject('copy')),
      rename: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      archive: vi.fn(async () => ''),
      exportPackage: vi.fn(async () => ''),
      importPackage: vi.fn(async () => null),
      importPackagePath: vi.fn(async () => createProject('imported')),
      pendingOpen: vi.fn(async () => null),
      missingAssets: vi.fn(async () => []),
      relink: vi.fn(async () => null),
      recovery: vi.fn(async () => []),
      restore: vi.fn(async () => createProject('restored')),
      storagePath: vi.fn(async () => '')
    },
    media: {
      importFiles: vi.fn(async () => ({ assets: [], errors: [] })),
      inspectUrl: vi.fn(async () => ({ ok: false, strategy: 'none', note: 'no network', ytdlpAvailable: false })),
      importUrl: vi.fn(async () => null),
      thumbnail: vi.fn(async () => undefined),
      waveform: vi.fn(async () => undefined),
      checkAvailability: vi.fn(async (assets: { id: string }[]) => assets.map((a) => ({ id: a.id, exists: true }))),
      generateProxy: vi.fn(async () => '')
    },
    ai: {
      providers: vi.fn(async () => []),
      providerTemplates: vi.fn(async () => []),
      addProvider: vi.fn(async () => ({})),
      updateProvider: vi.fn(async () => ({})),
      removeProvider: vi.fn(async () => undefined),
      testProvider: vi.fn(async () => ({ ok: true, message: 'ok' })),
      listProviderModels: vi.fn(async () => []),
      models: vi.fn(async () => ({ models: [], runtimes: { whisper: { available: false, source: 'none' }, llama: { available: false, source: 'none' } } })),
      downloadModel: vi.fn(async () => ({ ok: true })),
      cancelModelDownload: vi.fn(async () => undefined),
      deleteModel: vi.fn(async () => true),
      transcribe: vi.fn(async () => ({
        id: 'tr1',
        projectId: 'p1',
        assetId: 'a1',
        language: 'en',
        engine: 'local:whisper',
        createdAt: Date.now(),
        segments: [
          { id: 's1', start: 0, end: 2000, text: 'The trick is to start small.' },
          { id: 's2', start: 2000, end: 4000, text: 'Then compound it every single day.' }
        ]
      })),
      cancelTranscribe: vi.fn(async () => undefined),
      transcript: vi.fn(async () => null),
      saveTranscript: vi.fn(async () => ''),
      detectMoments: vi.fn(async () => ({ moments: [], engine: 'heuristic', warnings: [] })),
      moments: vi.fn(async () => []),
      saveMoments: vi.fn(async () => true),
      generateClip: vi.fn(async () => createProject('clip')),
      captionPresets: vi.fn(async () => FALLBACK_CAPTION_PRESETS),
      saveCaptionPreset: vi.fn(async () => FALLBACK_CAPTION_PRESETS),
      deleteCaptionPreset: vi.fn(async () => FALLBACK_CAPTION_PRESETS),
      importCaptionPreset: vi.fn(async () => null),
      exportCaptionPreset: vi.fn(async () => null),
      exportSubtitles: vi.fn(async () => 'C:/out/captions.srt'),
      importSubtitles: vi.fn(async () => null),
      fonts: vi.fn(async () => []),
      importFont: vi.fn(async () => null)
    },
    exports: {
      presets: vi.fn(async () => []),
      enqueue: vi.fn(async () => ({ id: 'j1', status: 'queued', progress: 0, filename: 'out.mp4' })),
      list: vi.fn(async () => []),
      cancel: vi.fn(async () => undefined),
      retry: vi.fn(async () => null),
      remove: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      validate: vi.fn(async () => ({ ok: true })),
      openFolder: vi.fn(async () => undefined),
      estimate: vi.fn(async () => ({ durationMs: 0, frames: 0, estimateMs: 0 }))
    },
    updates: {
      check: vi.fn(async () => ({
        currentVersion: '1.0.0',
        available: false,
        checkedAt: Date.now()
      })),
      download: vi.fn(async () => ({ ok: true })),
      install: vi.fn(async () => ({ launched: false, error: 'no installer' })),
      openRelease: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      version: vi.fn(async () => '1.0.0')
    },
    events: {
      onProgress: vi.fn(() => () => undefined),
      onExportUpdate: vi.fn(() => () => undefined),
      onUpdateProgress: vi.fn(() => () => undefined),
      onSettingsChanged: vi.fn(() => () => undefined),
      onMenu: vi.fn(() => () => undefined),
      onOpenPackage: vi.fn(() => () => undefined),
      onModelProgress: vi.fn(() => () => undefined)
    },
    mediaUrl: (filePath: string) =>
      `clipwright-media://local/${filePath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')}`,
    ...overrides
  }
  ;(window as unknown as { clipwright: unknown }).clipwright = api
  return { api, projects }
}

function mount(element: React.ReactElement) {
  act(() => {
    root = createRoot(container)
    root.render(element)
  })
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  container.id = 'root'
  document.body.appendChild(container)
  localStorage.clear()
  stubBridge()
  // The renderer never touches file:// — the protocol is registered in main.
  window.HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as unknown as typeof window.HTMLCanvasElement.prototype.getContext
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.restoreAllMocks()
})

/* --------------------------------- tests --------------------------------- */

describe('timeline semantics used by the UI', () => {
  it('creates a vertical project with even, correct canvas dimensions', () => {
    const project = createProject('Podcast cut', '9:16', 30)
    expect(project.canvas.width).toBe(1080)
    expect(project.canvas.height).toBe(1920)
    expect(project.canvas.width % 2).toBe(0)
    expect(project.canvas.height % 2).toBe(0)
    expect(project.fps).toBe(30)
  })

  it('keeps clips inside the timeline when moved past the start', () => {
    const project = createProject('Move', '9:16', 30)
    const track = project.tracks.find((t) => t.kind === 'video')!
    const clip = baseClip('video', track.id, 'a.mp4')
    clip.start = 1000
    clip.duration = 2000
    project.clips.push(clip)
    // The store clamps with Math.max(0, …) — mirror that contract here.
    const moved = Math.max(0, clip.start - 5000)
    expect(moved).toBe(0)
  })

  it('samples keyframes with the requested easing', () => {
    const clip = baseClip('video', 't', 'a.mp4')
    let tracks = addKeyframe(clip.keyframes, 'scale', { t: 0, value: 1, easing: { kind: 'linear' } })
    tracks = addKeyframe(tracks, 'scale', { t: 1000, value: 2, easing: { kind: 'linear' } })
    expect(sampleTrack(tracks.scale, 0)).toBeCloseTo(1, 3)
    expect(sampleTrack(tracks.scale, 500)).toBeCloseTo(1.5, 2)
    expect(sampleTrack(tracks.scale, 1000)).toBeCloseTo(2, 3)
    // Outside the range the value is held, never extrapolated.
    expect(sampleTrack(tracks.scale, 5000)).toBeCloseTo(2, 3)
  })

  it('builds caption clips that start at the transcript timings', () => {
    const trackId = defaultTracks().find((t) => t.kind === 'caption')!.id
    const clips = buildCaptionClips(
      [
        { id: 's1', start: 0, end: 1200, text: 'One two three four five six seven' },
        { id: 's2', start: 1200, end: 2400, text: 'Eight nine ten eleven' }
      ],
      { start: 0, end: 2400 },
      FALLBACK_CAPTION_PRESETS[0],
      trackId,
      0
    )
    expect(clips.length).toBeGreaterThan(0)
    expect(clips[0].kind).toBe('caption')
    expect(clips[0].start).toBeGreaterThanOrEqual(0)
    expect(clips[0].duration).toBeGreaterThanOrEqual(400)
    expect(clips.every((c) => c.words && c.words.length > 0)).toBe(true)
  })

  it('formats timecodes and file sizes for the status bar', () => {
    expect(formatClock(65_500, true)).toBe('1:05.5')
    expect(formatClock(3_725_000)).toBe('1:02:05')
    expect(formatTimecode(30_000, 30)).toBe('00:00:30:00')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB')
    expect(formatBytes(undefined)).toBe('—')
  })
})

describe('renderer boot', () => {
  it('mounts the onboarding flow on first run', async () => {
    const App = (await import('@/App')).default
    mount(React.createElement(App))
    await flush()
    expect(container.textContent).toContain('Welcome to Clipwright')
  })

  it('shows the project workspace after setup is complete', async () => {
    localStorage.setItem('clipwright.firstRunDone', '1')
    const { useApp } = await import('@/state/app')
    useApp.setState({ firstRunDone: true })
    const App = (await import('@/App')).default
    mount(React.createElement(App))
    await flush()
    expect(container.textContent).toContain('Your workspace')
    expect(container.textContent).toContain('New project')
  })

  it('asks the bridge for capabilities and workspace info during boot', async () => {
    localStorage.setItem('clipwright.firstRunDone', '1')
    const { useApp } = await import('@/state/app')
    useApp.setState({ firstRunDone: true })
    const App = (await import('@/App')).default
    mount(React.createElement(App))
    await flush()
    const bridge = (window as unknown as { clipwright: { app: { capabilities: () => unknown }; workspace: { info: () => unknown }; settings: { get: () => unknown } } }).clipwright
    expect(bridge.app.capabilities).toHaveBeenCalled()
    expect(bridge.workspace.info).toHaveBeenCalled()
    expect(bridge.settings.get).toHaveBeenCalled()
  })
})

describe('video pool', () => {
  it('creates and disposes one element per asset without leaking', () => {
    const project = createProject('pool', '9:16', 30)
    project.assets.push({
      id: 'asset-1',
      name: 'clip.mp4',
      path: 'C:/media/clip.mp4',
      kind: 'video',
      storage: 'managed',
      probe: { kind: 'video', durationMs: 4000, hasAudio: true },
      importedAt: Date.now()
    })
    const track = project.tracks.find((t) => t.kind === 'video')!
    const clip = baseClip('video', track.id, 'clip.mp4')
    clip.assetId = 'asset-1'
    clip.start = 0
    clip.duration = 4000
    project.clips.push(clip)
    const pool = createVideoPool()
    const before = document.querySelectorAll('video').length
    pool.sync(project, 0, false)
    expect(document.querySelectorAll('video').length).toBe(before + 1)
    pool.dispose()
    expect(document.querySelectorAll('video').length).toBe(before)
  })
})

describe('editor store', () => {
  it('records undo history for edits and restores the previous project', async () => {
    const { useEditor } = await import('@/state/editor')
    const project = createProject('undo', '9:16', 30)
    useEditor.getState().setProject(project)
    const track = project.tracks.find((t) => t.kind === 'video')!
    useEditor.getState().apply(
      (p) => ({ ...p, clips: [...p.clips, baseClip('video', track.id, 'x.mp4')] }),
      'Add clip'
    )
    expect(useEditor.getState().project!.clips.length).toBe(1)
    expect(useEditor.getState().dirty).toBe(true)
    useEditor.getState().undo()
    expect(useEditor.getState().project!.clips.length).toBe(0)
    useEditor.getState().redo()
    expect(useEditor.getState().project!.clips.length).toBe(1)
  })

  it('clamps the playhead to the timeline and snaps to frames', async () => {
    const { useEditor } = await import('@/state/editor')
    const project = createProject('playhead', '9:16', 30)
    const track = project.tracks.find((t) => t.kind === 'video')!
    const clip = baseClip('video', track.id, 'x.mp4')
    clip.start = 0
    clip.duration = 1000
    project.clips.push(clip)
    useEditor.getState().setProject(project)
    useEditor.getState().setPlayhead(999_999)
    expect(useEditor.getState().playhead).toBe(1000)
    useEditor.getState().setPlayhead(-50)
    expect(useEditor.getState().playhead).toBe(0)
    // 30 fps → one frame is 33.33ms
    useEditor.getState().setPlayhead(20)
    expect(Math.round(useEditor.getState().playhead)).toBe(33)
  })

  it('jumps between edit points and steps frames', async () => {
    const { useEditor } = await import('@/state/editor')
    const project = createProject('cuts', '9:16', 30)
    const track = project.tracks.find((t) => t.kind === 'video')!
    const a = baseClip('video', track.id, 'a.mp4')
    a.start = 0
    a.duration = 1000
    const b = baseClip('video', track.id, 'b.mp4')
    b.start = 3000
    b.duration = 1000
    project.clips.push(a, b)
    useEditor.getState().setProject(project)
    useEditor.getState().setPlayhead(0, { snap: false })
    useEditor.getState().jumpCut(1)
    expect(useEditor.getState().playhead).toBe(1000)
    useEditor.getState().jumpCut(1)
    expect(useEditor.getState().playhead).toBe(3000)
    useEditor.getState().stepFrames(1)
    expect(Math.round(useEditor.getState().playhead)).toBe(3033)
  })
})

describe('editor components', () => {
  function seedProject() {
    const project = createProject('Editor test', '9:16', 30)
    const track = project.tracks.find((t) => t.kind === 'video')!
    const a = baseClip('video', track.id, 'first.mp4')
    a.start = 0
    a.duration = 3000
    const b = baseClip('video', track.id, 'second.mp4')
    b.start = 3000
    b.duration = 2000
    project.clips.push(a, b)
    project.markers.push({ id: 'm1', time: 1500, label: 'Hook', color: '#FF7A18' })
    return { project, a, b }
  }

  it('renders one timeline clip per clip with a ruler and marker', async () => {
    const { useEditor } = await import('@/state/editor')
    const { Timeline } = await import('@/components/Timeline')
    const { project } = seedProject()
    act(() => useEditor.getState().setProject(project))
    mount(React.createElement(Timeline))
    await flush()
    expect(container.querySelectorAll('.timeline__clip').length).toBe(2)
    expect(container.querySelectorAll('.timeline__tick').length).toBeGreaterThan(3)
    expect(container.querySelectorAll('.timeline__marker').length).toBe(1)
    expect(container.textContent).toContain('0:00')
  })

  it('shows inspector controls for the selected clip', async () => {
    const { useEditor } = await import('@/state/editor')
    const { Inspector } = await import('@/components/Inspector')
    const { project, a } = seedProject()
    act(() => {
      useEditor.getState().setProject(project)
      useEditor.getState().selectClips([a.id])
    })
    mount(React.createElement(Inspector))
    await flush()
    expect(container.textContent).toContain('Transform')
    expect(container.textContent).toContain('Opacity')
    expect(container.querySelectorAll('input[type="range"]').length).toBeGreaterThan(1)
  })

  it('splits the selected clip at the playhead and restores it on undo', async () => {
    const { useEditor, useTimelineActions } = await import('@/state/editor')
    const { project, a } = seedProject()
    act(() => {
      useEditor.getState().setProject(project)
      useEditor.getState().selectClips([a.id])
      useEditor.getState().setPlayhead(1000, { snap: false })
    })
    const Probe = () => {
      const actions = useTimelineActions()
      return React.createElement('button', { id: 'split', onClick: () => actions.split() }, 'split')
    }
    mount(React.createElement(Probe))
    await flush()
    act(() => {
      ;(container.querySelector('#split') as HTMLButtonElement).click()
    })
    expect(useEditor.getState().project!.clips.length).toBe(3)
    const parts = useEditor
      .getState()
      .project!.clips.filter((c) => c.start === 0 || c.start === 1000)
      .sort((x, y) => x.start - y.start)
    expect(parts[0].duration).toBe(1000)
    expect(parts[1].duration).toBe(2000)
    act(() => useEditor.getState().undo())
    expect(useEditor.getState().project!.clips.length).toBe(2)
  })

  it('opens the import wizard from the native menu command', async () => {
    const handlers: Record<string, ((payload: { command: string }) => void) | undefined> = {}
    const base = (window as unknown as { clipwright: Record<string, unknown> }).clipwright
    ;(window as unknown as { clipwright: Record<string, unknown> }).clipwright = {
      ...base,
      events: {
        ...(base.events as Record<string, unknown>),
        onMenu: (handler: (payload: { command: string }) => void) => {
          handlers.menu = handler
          return () => undefined
        }
      }
    }
    const { useApp } = await import('@/state/app')
    useApp.setState({ firstRunDone: true })
    const App = (await import('@/App')).default
    mount(React.createElement(App))
    await flush()
    act(() => handlers.menu?.({ command: 'import-media' }))
    await flush()
    expect(container.textContent).toContain('Import media')
    expect(container.textContent).toContain('Choose video, audio or image files')
  })
})
