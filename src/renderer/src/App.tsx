/** Application shell: routing, layout, menu commands, shortcuts, toasts. */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  Captions,
  Download,
  Film,
  FolderOpen,
  Home,
  Keyboard,
  LayoutGrid,
  Loader2,
  Captions as CaptionsIcon,
  Plus,
  Redo2,
  Save,
  Settings,
  Sparkles,
  Type,
  Undo2,
  Wand2,
  X
} from 'lucide-react'
import { useEditor, useTimelineActions } from './state/editor'
import { useApp } from './state/app'
import { openProject, useAutosave, useGlobalShortcuts } from './hooks/useProjectPersistence'
import { usePlayback } from './hooks/usePlayback'
import { Button, IconButton, Modal, Tabs } from './components/ui'
import { PreviewMonitor } from './components/PreviewMonitor'
import { Timeline } from './components/Timeline'
import { MediaLibrary } from './components/MediaLibrary'
import { Inspector } from './components/Inspector'
import { TextLibrary } from './components/TextLibrary'
import { HomeScreen } from './screens/HomeScreen'
import { ClipsWorkspace } from './screens/ClipsWorkspace'
import { CaptionsStudio } from './screens/CaptionsStudio'
import { ExportPanel } from './screens/ExportPanel'
import { SettingsScreen } from './screens/SettingsScreen'
import { Onboarding } from './screens/Onboarding'
import { ImportWizard } from './screens/ImportWizard'
import { api, errorMessage } from './lib/api'
import { formatClock } from '@shared/time'
import { baseClip, overwriteClip } from '@shared/timeline'
import { DEFAULT_SHORTCUTS } from '@shared/presets'
import brandMark from './assets/brand/icon-64.png'

type Screen = 'home' | 'editor' | 'clips' | 'captions' | 'settings'
type LibraryTab = 'media' | 'text' | 'audio'

const SHORTCUT_GROUPS: { group: string; items: { label: string; keys: string }[] }[] = [
  {
    group: 'Playback',
    items: [
      { label: 'Play / pause', keys: DEFAULT_SHORTCUTS.playPause },
      { label: 'Previous frame', keys: DEFAULT_SHORTCUTS.prevFrame },
      { label: 'Next frame', keys: DEFAULT_SHORTCUTS.nextFrame },
      { label: 'Previous cut', keys: DEFAULT_SHORTCUTS.prevCut },
      { label: 'Next cut', keys: DEFAULT_SHORTCUTS.nextCut }
    ]
  },
  {
    group: 'Editing',
    items: [
      { label: 'Split at playhead', keys: DEFAULT_SHORTCUTS.split },
      { label: 'Delete clip', keys: DEFAULT_SHORTCUTS.deleteClip },
      { label: 'Ripple delete', keys: DEFAULT_SHORTCUTS.rippleDelete },
      { label: 'Duplicate', keys: DEFAULT_SHORTCUTS.duplicate },
      { label: 'Group / ungroup', keys: `${DEFAULT_SHORTCUTS.group} / ${DEFAULT_SHORTCUTS.ungroup}` }
    ]
  },
  {
    group: 'Timeline',
    items: [
      { label: 'Zoom in / out', keys: 'Ctrl + / Ctrl -' },
      { label: 'Fit project', keys: DEFAULT_SHORTCUTS.fitTimeline },
      { label: 'Toggle snapping', keys: DEFAULT_SHORTCUTS.toggleSnap },
      { label: 'Add marker', keys: DEFAULT_SHORTCUTS.marker },
      { label: 'Scrub with wheel', keys: 'Shift + wheel' },
      { label: 'Zoom at cursor', keys: 'Ctrl + wheel' }
    ]
  },
  {
    group: 'File',
    items: [
      { label: 'Save project', keys: DEFAULT_SHORTCUTS.save },
      { label: 'Import media', keys: DEFAULT_SHORTCUTS.importMedia },
      { label: 'Export video', keys: DEFAULT_SHORTCUTS.export },
      { label: 'Undo / redo', keys: `${DEFAULT_SHORTCUTS.undo} / ${DEFAULT_SHORTCUTS.redo}` },
      { label: 'Deselect', keys: DEFAULT_SHORTCUTS.deselect }
    ]
  }
]

export default function App(): JSX.Element {
  const [screen, setScreen] = useState<Screen>('home')
  const [booting, setBooting] = useState(true)
  const [importOpen, setImportOpen] = useState(false)
  const [importUrlMode, setImportUrlMode] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [libraryTab, setLibraryTab] = useState<LibraryTab>('media')
  const [updateBanner, setUpdateBanner] = useState<{ version: string; notes: string } | null>(null)

  const { settings, bootError, firstRunDone, completeFirstRun, boot } = useApp()
  const project = useEditor((s) => s.project)
  const dirty = useEditor((s) => s.dirty)
  const notifications = useEditor((s) => s.notifications)
  const notify = useEditor((s) => s.notify)
  const dismiss = useEditor((s) => s.dismiss)
  const actions = useTimelineActions()

  /* ------------------------------- bootstrap ------------------------------- */
  useEffect(() => {
    void (async () => {
      try {
        await boot()
        const current = useApp.getState()
        if (current.settings?.updates.autoCheck) {
          const result = await api.updates.check().catch(() => null)
          if (result?.available && result.latestVersion) {
            setUpdateBanner({ version: result.latestVersion, notes: result.notes ?? '' })
          }
        }
        // A .clipwright file opened from Explorer (double-click) is imported by
        // the main process before boot finishes; show it instead of the home screen.
        const opened = await api.projects.pendingOpen().catch(() => null)
        if (opened) {
          await openProject(opened.projectId)
          localStorage.setItem('clipwright.lastProject', opened.projectId)
          setScreen('editor')
          useEditor.getState().notify({ kind: 'success', title: 'Project package imported', body: opened.name })
          return
        }
        // Reopen the last project when the setting is on and one exists.
        if (current.settings?.general.restoreLastProject) {
          const lastId = localStorage.getItem('clipwright.lastProject')
          if (lastId) {
            const exists = (await api.projects.list().catch(() => [])) as { id: string }[]
            if (exists.some((p) => p.id === lastId)) {
              await openProject(lastId)
              setScreen('editor')
            }
          }
        }
      } finally {
        setBooting(false)
      }
    })()
  }, [boot])

  useAutosave()
  usePlayback(screen === 'editor')

  const saveNow = useCallback(async () => {
    const state = useEditor.getState()
    if (!state.project) return
    try {
      await api.projects.save(state.project)
      state.markSaved(Date.now())
      state.notify({ kind: 'success', title: 'Project saved' })
    } catch (error) {
      state.notify({ kind: 'error', title: 'Save failed', body: errorMessage(error) })
    }
  }, [])

  const open = useCallback(async (id: string) => {
    try {
      await openProject(id)
      localStorage.setItem('clipwright.lastProject', id)
      setScreen('editor')
    } catch (error) {
      notify({ kind: 'error', title: 'Could not open project', body: errorMessage(error) })
    }
  }, [notify])

  /* ----------------------- opened from Explorer ----------------------- */
  useEffect(() => {
    // "Open with Clipwright Studio" while the app is already running.
    return api.events.onOpenPackage(async ({ projectId, name }) => {
      try {
        await openProject(projectId)
        localStorage.setItem('clipwright.lastProject', projectId)
        setScreen('editor')
        useEditor.getState().notify({ kind: 'success', title: 'Project package imported', body: name })
      } catch (error) {
        useEditor.getState().notify({ kind: 'error', title: 'Could not open the package', body: errorMessage(error) })
      }
    })
  }, [])

  /* --------------------------- native menu events --------------------------- */
  useEffect(() => {
    const off = api.events.onMenu((payload) => {
      const state = useEditor.getState()
      switch (payload?.command) {
        case 'new-project':
        case 'open-project':
          setScreen('home')
          break
        case 'import-media':
          setImportUrlMode(false)
          setImportOpen(true)
          break
        case 'import-package': {
          void (async () => {
            try {
              const opened = await api.projects.importPackage()
              if (!opened) return
              await open(opened.id)
              notify({ kind: 'success', title: 'Project package imported', body: opened.name })
            } catch (error) {
              notify({ kind: 'error', title: 'Import failed', body: errorMessage(error) })
            }
          })()
          break
        }
        case 'export-package': {
          const current = useEditor.getState().project
          if (!current) {
            notify({ kind: 'info', title: 'Nothing to package', body: 'Open a project first.' })
            break
          }
          void (async () => {
            try {
              const file = await api.projects.exportPackage(current.id, true)
              notify({ kind: 'success', title: 'Project package exported', body: file })
              void api.app.revealPath(file)
            } catch (error) {
              notify({ kind: 'error', title: 'Export failed', body: errorMessage(error) })
            }
          })()
          break
        }
        case 'open-settings':
          setScreen('settings')
          break
        case 'open-ai-settings':
          setScreen('settings')
          break
        case 'open-model-settings':
          setScreen('settings')
          break
        case 'check-updates':
          setScreen('settings')
          break
        case 'export':
          setExportOpen(true)
          break
        case 'undo':
          state.undo()
          break
        case 'redo':
          state.redo()
          break
        case 'split':
          actions.split()
          break
        case 'delete':
          actions.deleteSelected(false)
          break
        case 'ripple-delete':
          actions.deleteSelected(true)
          break
        case 'duplicate':
          actions.duplicateSelected()
          break
        case 'copy':
          actions.copySelection()
          break
        case 'paste':
          actions.paste()
          break
        case 'cut':
          actions.copySelection()
          actions.deleteSelected(false)
          break
        case 'group':
          actions.group()
          break
        case 'ungroup':
          actions.ungroup()
          break
        case 'fit-timeline': {
          // Mirror of the timeline toolbar's "Fit project" button.
          const duration = Math.max(1000, state.duration())
          window.dispatchEvent(new CustomEvent('clipwright:fit-timeline', { detail: duration }))
          break
        }
        case 'zoom-in':
          state.setZoom(state.zoom * 1.3)
          break
        case 'zoom-out':
          state.setZoom(state.zoom / 1.3)
          break
        case 'toggle-snap':
          state.toggleSnapping()
          break
        case 'add-marker':
          actions.addMarker()
          break
        case 'transcribe':
        case 'detect-moments':
          setScreen('clips')
          break
        default:
          break
      }
    })
    return off
  }, [actions])

  const shortcuts = useMemo(
    () => ({
      undo: () => useEditor.getState().undo(),
      redo: () => useEditor.getState().redo(),
      save: () => void saveNow(),
      split: () => actions.split(),
      duplicate: () => actions.duplicateSelected(),
      delete: () => actions.deleteSelected(false),
      rippleDelete: () => actions.deleteSelected(true),
      playPause: () => {
        const state = useEditor.getState()
        state.setPlaying(!state.playing)
      },
      escape: () => {
        useEditor.getState().clearSelection()
        setHelpOpen(false)
        setExportOpen(false)
        setImportOpen(false)
      },
      marker: () => actions.addMarker(),
      toggleSnap: () => useEditor.getState().toggleSnapping(),
      zoomIn: () => useEditor.getState().zoomBy(1.3),
      zoomOut: () => useEditor.getState().zoomBy(1 / 1.3),
      prevFrame: () => useEditor.getState().stepFrames(-1),
      nextFrame: () => useEditor.getState().stepFrames(1),
      prevCut: () => useEditor.getState().jumpCut(-1),
      nextCut: () => useEditor.getState().jumpCut(1),
      start: () => useEditor.getState().setPlayhead(0, { snap: false }),
      end: () => useEditor.getState().setPlayhead(useEditor.getState().duration(), { snap: false }),
      group: () => actions.group(),
      ungroup: () => actions.ungroup(),
      copy: () => actions.copySelection(),
      paste: () => actions.paste(),
      cut: () => {
        actions.copySelection()
        actions.deleteSelected(false)
      },
      export: () => setExportOpen(true),
      import: () => setImportOpen(true),
      new: () => setScreen('home'),
      help: () => setHelpOpen(true)
    }),
    [actions, saveNow]
  )
  useGlobalShortcuts(shortcuts)

  /* ------------------------------- render ------------------------------- */

  if (booting) {
    return (
      <div className="boot">
        <img className="boot__mark" src={brandMark} alt="" width={52} height={52} />
        <div className="boot__name">Clipwright Studio</div>
        <div className="boot__hint">
          <Loader2 size={13} className="spin" /> Preparing workspace…
        </div>
      </div>
    )
  }

  if (bootError) {
    return (
      <div className="boot">
        <div className="boot__name">Clipwright could not start</div>
        <div className="callout callout--danger" style={{ maxWidth: 560 }}>
          {bootError}
        </div>
        <div className="row">
          <Button onClick={() => void boot()}>Try again</Button>
          <Button variant="ghost" onClick={() => void api.app.openLogs()}>
            Open logs
          </Button>
        </div>
      </div>
    )
  }

  if (settings && !firstRunDone) {
    return (
      <Onboarding
        onDone={() => {
          completeFirstRun()
          setScreen('home')
        }}
      />
    )
  }

  return (
    <div className={clsx('app', `app--${screen}`)}>
      <TopBar
        screen={screen}
        onScreen={(next) => {
          if (next === 'editor' && !project) {
            setScreen('home')
            return
          }
          setScreen(next)
        }}
        onHome={() => setScreen('home')}
        onImport={() => {
          setImportUrlMode(false)
          setImportOpen(true)
        }}
        onExport={() => setExportOpen(true)}
        canExport={Boolean(project && project.clips.length)}
        dirty={dirty}
        projectName={project?.name}
        onSave={() => void saveNow()}
      />

      {updateBanner && (
        <div className="update-banner">
          <Sparkles size={13} />
          <span>
            Clipwright <strong>v{updateBanner.version}</strong> is available.
          </span>
          <div className="grow" />
          <button className="btn btn--ghost btn--sm" onClick={() => setScreen('settings')}>
            Release notes
          </button>
          <button className="btn btn--ghost btn--icon btn--sm" onClick={() => setUpdateBanner(null)} title="Dismiss">
            <X size={12} />
          </button>
        </div>
      )}

      <main className="app__main">
        {screen === 'home' && <HomeScreen onOpen={(id) => void open(id)} />}

        {screen === 'clips' && (
          <div className="screen-wrap">
            {project ? (
              <ClipsWorkspace
                onOpenProject={(id) => void open(id)}
                onAddMedia={() => {
                  setScreen('editor')
                  setImportOpen(true)
                }}
              />
            ) : (
              <NoProject onOpen={() => setScreen('home')} />
            )}
          </div>
        )}

        {screen === 'captions' && (
          <div className="screen-wrap">
            {project ? <CaptionsStudio /> : <NoProject onOpen={() => setScreen('home')} />}
          </div>
        )}

        {screen === 'settings' && (
          <div className="screen-wrap">
            <SettingsScreen />
          </div>
        )}

        {screen === 'editor' && project && (
          <div className="editor">
            <aside className="editor__left">
              <Tabs
                value={libraryTab}
                onChange={setLibraryTab}
                options={[
                  { id: 'media', label: 'Media' },
                  { id: 'text', label: 'Text' },
                  { id: 'audio', label: 'Audio' }
                ]}
                compact
              />
              {libraryTab === 'media' && (
                <MediaLibrary
                  onImportFiles={() => {
                    setImportUrlMode(false)
                    setImportOpen(true)
                  }}
                  onImportUrl={() => {
                    setImportUrlMode(true)
                    setImportOpen(true)
                  }}
                  onAddText={() => setLibraryTab('text')}
                />
              )}
              {libraryTab === 'text' && <TextLibrary />}
              {libraryTab === 'audio' && <AudioLibrary />}
            </aside>

            <section className="editor__centre">
              <PreviewMonitor />
              <Timeline />
            </section>

            <aside className="editor__right">
              <Inspector />
            </aside>
          </div>
        )}
      </main>

      <StatusBar
        screen={screen}
        clipCount={project?.clips.length ?? 0}
        onHelp={() => setHelpOpen(true)}
        onQuickClips={() => setScreen('clips')}
        onCaptions={() => setScreen('captions')}
      />

      <ImportWizard
        open={importOpen}
        urlMode={importUrlMode}
        onClose={() => setImportOpen(false)}
        onImported={(assets) => {
          const state = useEditor.getState()
          state.apply((p) => ({ ...p, assets: [...p.assets, ...assets] }), 'Import media')
          if (state.project && state.project.clips.length === 0) setScreen('editor')
        }}
      />

      <ExportPanel open={exportOpen} onClose={() => setExportOpen(false)} />

      <Modal open={helpOpen} onClose={() => setHelpOpen(false)} title="Keyboard shortcuts" size="wide">
        <div className="shortcut-grid">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.group}>
              <div className="label" style={{ marginBottom: 6 }}>
                {group.group}
              </div>
              {group.items.map((item) => (
                <div key={item.label} className="shortcut-row">
                  <span>{item.label}</span>
                  <kbd className="kbd">{item.keys}</kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Modal>

      <div className="toasts">
        {notifications.slice(-4).map((n) => (
          <div key={n.id} className={clsx('toast', `toast--${n.kind}`)}>
            <div className="toast__body">
              <div className="toast__title">{n.title}</div>
              {n.body && <div className="toast__text">{n.body}</div>}
            </div>
            <button className="toast__close" onClick={() => dismiss(n.id)} aria-label="Dismiss">
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function TopBar({
  screen,
  onScreen,
  onHome,
  onImport,
  onExport,
  canExport,
  dirty,
  projectName,
  onSave
}: {
  screen: Screen
  onScreen: (screen: Screen) => void
  onHome: () => void
  onImport: () => void
  onExport: () => void
  canExport: boolean
  dirty: boolean
  projectName?: string
  onSave: () => void
}): JSX.Element {
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)
  return (
    <header className="topbar">
      <button className="topbar__brand" onClick={onHome} title="Projects">
        {/* The supplied logo, scaled only — never redrawn. */}
        <img className="topbar__logo" src={brandMark} alt="" width={20} height={20} draggable={false} />
        <span>Clipwright</span>
      </button>

      <div className="topbar__divider" />

      <nav className="topbar__nav">
        <button className={clsx('topbar__tab', screen === 'home' && 'topbar__tab--active')} onClick={() => onScreen('home')}>
          <Home size={13} /> Projects
        </button>
        <button className={clsx('topbar__tab', screen === 'editor' && 'topbar__tab--active')} onClick={() => onScreen('editor')}>
          <Film size={13} /> Editor
        </button>
        <button className={clsx('topbar__tab', screen === 'clips' && 'topbar__tab--active')} onClick={() => onScreen('clips')}>
          <Wand2 size={13} /> Clips
        </button>
        <button className={clsx('topbar__tab', screen === 'captions' && 'topbar__tab--active')} onClick={() => onScreen('captions')}>
          <Captions size={13} /> Captions
        </button>
        <button className={clsx('topbar__tab', screen === 'settings' && 'topbar__tab--active')} onClick={() => onScreen('settings')}>
          <Settings size={13} /> Settings
        </button>
      </nav>

      <div className="grow" />

      {projectName && (
        <div className="topbar__project truncate" title={projectName}>
          {projectName}
          {dirty && <span className="topbar__dot" title="Unsaved changes" />}
        </div>
      )}

      {screen === 'editor' && (
        <div className="row" style={{ gap: 2 }}>
          <IconButton label="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => useEditor.getState().undo()}>
            <Undo2 size={14} />
          </IconButton>
          <IconButton label="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => useEditor.getState().redo()}>
            <Redo2 size={14} />
          </IconButton>
          <IconButton label="Save (Ctrl+S)" onClick={onSave}>
            <Save size={14} />
          </IconButton>
          <div className="topbar__divider" />
        </div>
      )}

      <div className="row">
        <Button size="sm" icon={<Plus size={13} />} onClick={onImport}>
          Import
        </Button>
        <Button size="sm" variant="primary" icon={<Download size={13} />} disabled={!canExport} onClick={onExport}>
          Export
        </Button>
      </div>
    </header>
  )
}

function StatusBar({
  screen,
  clipCount,
  onHelp,
  onQuickClips,
  onCaptions
}: {
  screen: Screen
  clipCount: number
  onHelp: () => void
  onQuickClips: () => void
  onCaptions: () => void
}): JSX.Element {
  const { playhead, zoom, snapping, selectedClipIds, project } = useEditor()
  return (
    <footer className="statusbar">
      <span className="statusbar__item">
        {screen === 'editor' ? formatClock(playhead, true) : `${clipCount} clips`}
      </span>
      {screen === 'editor' && (
        <>
          <span className="statusbar__item">{Math.round(zoom)} px/s</span>
          <span className="statusbar__item">{snapping ? 'snapping on' : 'snapping off'}</span>
          <span className="statusbar__item">
            {selectedClipIds.length ? `${selectedClipIds.length} selected` : 'nothing selected'}
          </span>
        </>
      )}
      <div className="grow" />
      <button className="statusbar__item statusbar__button" onClick={onQuickClips}>
        <Wand2 size={11} /> Find clips
      </button>
      <button className="statusbar__item statusbar__button" onClick={onCaptions}>
        <CaptionsIcon size={11} /> Captions
      </button>
      <button className="statusbar__item statusbar__button" onClick={onHelp}>
        <Keyboard size={11} /> Shortcuts
      </button>
      <span className="statusbar__item mono">{project?.canvas.aspect ?? '—'}</span>
    </footer>
  )
}

/** Audio-only library view: music/sfx assets plus quick audio actions. */
function AudioLibrary(): JSX.Element {
  const project = useEditor((s) => s.project)
  const playhead = useEditor((s) => s.playhead)
  const apply = useEditor((s) => s.apply)
  const [ducking, setDucking] = useState(true)
  const audioAssets = project?.assets.filter((a) => a.kind === 'audio' || a.probe.hasAudio) ?? []

  return (
    <div className="panel" style={{ flex: 1, minHeight: 0 }}>
      <div className="panel__header">
        <div className="panel__title">
          <LayoutGrid size={13} /> Audio
        </div>
      </div>
      <div className="panel__body stack-sm">
        {audioAssets.length === 0 ? (
          <div className="hint">Import audio or a video with sound to see it here.</div>
        ) : (
          audioAssets.map((asset) => (
            <div key={asset.id} className="list-row">
              <div className="grow truncate">
                <div style={{ fontSize: 12, fontWeight: 540 }} className="truncate">
                  {asset.name}
                </div>
                <div className="list-row__meta">
                  {asset.probe.sampleRate ? `${asset.probe.sampleRate / 1000} kHz` : ''}
                  {asset.probe.channels ? ` · ${asset.probe.channels} ch` : ''}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (!project) return
                  // Place the asset on the first audio track at the playhead.
                  const track = project.tracks.find((t) => t.kind === 'audio')
                  if (!track) return
                  const sourceDuration = asset.probe.durationMs ?? 30_000
                  const clip = {
                    ...baseClip('audio', track.id, asset.name),
                    assetId: asset.id,
                    start: playhead,
                    sourceIn: 0,
                    duration: Math.max(500, Math.min(sourceDuration, 60_000)),
                    sourceDuration
                  }
                  apply((p) => overwriteClip(p, clip, playhead), 'Add audio clip')
                  useEditor.getState().selectClips([clip.id])
                }}
                title="Add to the audio track at the playhead"
              >
                <Plus size={12} />
              </Button>
            </div>
          ))
        )}
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          <span style={{ fontSize: 12 }}>Auto-duck music under speech</span>
          <input
            type="checkbox"
            checked={ducking}
            onChange={(e) => {
              setDucking(e.target.checked)
              if (!project) return
              apply(
                (p) => ({
                  ...p,
                  clips: p.clips.map((c) => (c.kind === 'audio' ? { ...c, audio: { ...c.audio, ducking: e.target.checked } } : c))
                }),
                'Toggle audio ducking'
              )
            }}
          />
        </div>
        <div className="hint">
          Ducking lowers music volume automatically during speech, using the transcript timings. It is
          applied when exporting.
        </div>
      </div>
    </div>
  )
}

function NoProject({ onOpen }: { onOpen: () => void }): JSX.Element {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">
        <FolderOpen size={20} />
      </div>
      <div className="empty-state__title">No project open</div>
      <div className="empty-state__body">Open or create a project first.</div>
      <Button variant="primary" onClick={onOpen}>
        Go to projects
      </Button>
    </div>
  )
}
