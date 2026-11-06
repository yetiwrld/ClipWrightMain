/** Home: projects, recovery, quick start. */
import React, { useEffect, useState } from 'react'
import {
  Boxes,
  Clock,
  FileVideo,
  FolderOpen,
  Plus,
  RefreshCw,
  AlertTriangle,
  Package,
  Trash2,
  Copy,
  Pencil
} from 'lucide-react'
import { useEditor } from '../state/editor'
import { useApp } from '../state/app'
import { Badge, Button, EmptyState, Field, Modal, SearchInput, Segmented } from '../components/ui'
import { api, errorMessage } from '../lib/api'
import { formatClock, formatDuration } from '@shared/time'
import { ASPECT_PRESETS } from '@shared/presets'
import type { ProjectSummary, RecoveryEntry } from '../../../main/projects'

export function HomeScreen({ onOpen }: { onOpen: (id: string) => void }): JSX.Element {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [recovery, setRecovery] = useState<RecoveryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [aspect, setAspect] = useState('9:16')
  const [fps, setFps] = useState(30)
  const [busy, setBusy] = useState(false)
  const notify = useEditor((s) => s.notify)
  const info = useApp((s) => s.info)

  const refresh = async () => {
    setLoading(true)
    try {
      const [list, points] = await Promise.all([
        api.projects.list() as Promise<ProjectSummary[]>,
        api.projects.recovery() as Promise<RecoveryEntry[]>
      ])
      setProjects(list)
      setRecovery(points.slice(0, 4))
    } catch (error) {
      notify({ kind: 'error', title: 'Could not read projects', body: errorMessage(error) })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const create = async () => {
    setBusy(true)
    try {
      const project = await api.projects.create({ name: name || 'Untitled project', aspect, fps })
      onOpen(project.id)
      setCreating(false)
      setName('')
    } catch (error) {
      notify({ kind: 'error', title: 'Could not create project', body: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  const filtered = projects.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))

  return (
    <div className="home">
      <header className="home__header">
        <div>
          <div className="home__eyebrow">Clipwright Studio {info?.version ? `v${info.version}` : ''}</div>
          <h1 className="home__title">Your workspace</h1>
          <p className="home__subtitle">
            Start from a long video and finish with ready-to-publish clips — or open the editor and cut
            something by hand.
          </p>
        </div>
        <div className="row">
          <Button icon={<RefreshCw size={13} />} onClick={() => void refresh()} loading={loading}>
            Refresh
          </Button>
          <Button
            variant="ghost"
            icon={<Package size={13} />}
            onClick={async () => {
              try {
                const project = await api.projects.importPackage()
                if (project) {
                  await refresh()
                  onOpen(project.id)
                }
              } catch (error) {
                notify({ kind: 'error', title: 'Import failed', body: errorMessage(error) })
              }
            }}
          >
            Import package
          </Button>
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
            New project
          </Button>
        </div>
      </header>

      {recovery.length > 0 && (
        <section className="home__section">
          <div className="home__section-title">
            <Clock size={14} /> Recovery points
          </div>
          <div className="home__recovery">
            {recovery.map((point) => (
              <div key={point.id} className="card card--interactive" onClick={async () => {
                try {
                  const project = await api.projects.restore(point.id)
                  await refresh()
                  onOpen(project.id)
                } catch (error) {
                  notify({ kind: 'error', title: 'Restore failed', body: errorMessage(error) })
                }
              }}>
                <div className="row-between">
                  <span className="truncate" style={{ fontWeight: 600 }}>{point.projectName}</span>
                  <Badge tone="warning">recovery</Badge>
                </div>
                <div className="list-row__meta" style={{ marginTop: 4 }}>
                  {point.clipCount} clips · {new Date(point.savedAt).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="home__section grow">
        <div className="row-between" style={{ marginBottom: 12 }}>
          <div className="home__section-title">
            <Boxes size={14} /> Projects <span className="badge">{projects.length}</span>
          </div>
          <div style={{ width: 240 }}>
            <SearchInput value={query} onChange={setQuery} placeholder="Search projects" />
          </div>
        </div>

        {loading ? (
          <div className="home__grid">
            {[0, 1, 2].map((i) => (
              <div key={i} className="project-card">
                <div className="skeleton" style={{ height: 118 }} />
                <div className="skeleton" style={{ height: 12, width: '60%', marginTop: 10 }} />
                <div className="skeleton" style={{ height: 10, width: '40%', marginTop: 6 }} />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<FileVideo size={22} />}
            title={projects.length ? 'No projects match that search' : 'No projects yet'}
            body={
              projects.length
                ? 'Try a different name.'
                : 'Create a project, import a long video, transcribe it and let Clipwright find the strongest moments — or edit manually.'
            }
            action={
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
                Create your first project
              </Button>
            }
          />
        ) : (
          <div className="home__grid">
            {filtered.map((project) => (
              <div key={project.id} className="project-card" onClick={() => onOpen(project.id)}>
                <div className="project-card__thumb">
                  {project.thumbnail ? (
                    <img src={api.mediaUrl(project.thumbnail)} alt="" />
                  ) : (
                    <div className="project-card__placeholder">
                      <span>{project.aspect}</span>
                    </div>
                  )}
                  <span className="project-card__badge mono">{formatClock(project.durationMs)}</span>
                </div>
                <div className="project-card__meta">
                  <div className="row-between">
                    <span className="project-card__name truncate">{project.name}</span>
                  </div>
                  <div className="project-card__sub">
                    {project.clipCount} clips · {project.aspect} ·{' '}
                    {new Date(project.updatedAt).toLocaleDateString()}
                    {project.hasTranscript && <Badge tone="info">transcript</Badge>}
                  </div>
                </div>
                <div className="project-card__actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Pencil size={11} />}
                    onClick={async (e) => {
                      e.stopPropagation()
                      const next = window.prompt('Rename project', project.name)
                      if (next && next.trim()) {
                        await api.projects.rename(project.id, next.trim())
                        void refresh()
                      }
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Copy size={11} />}
                    onClick={async (e) => {
                      e.stopPropagation()
                      await api.projects.duplicate(project.id)
                      void refresh()
                    }}
                  >
                    Duplicate
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Package size={11} />}
                    onClick={async (e) => {
                      e.stopPropagation()
                      const path = await api.projects.exportPackage(project.id, true)
                      notify({ kind: 'success', title: 'Project package exported', body: path })
                    }}
                  >
                    Package
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 size={11} />}
                    onClick={async (e) => {
                      e.stopPropagation()
                      if (!window.confirm(`Delete "${project.name}"? Media stays in the workspace folder.`)) return
                      await api.projects.remove(project.id, false)
                      void refresh()
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <Modal
        open={creating}
        title="New project"
        subtitle="Choose the frame your clips will be published in. You can change it later."
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void create()} loading={busy}>
              Create project
            </Button>
          </>
        }
      >
        <div className="stack-md">
          <Field label="Project name">
            <input className="input" autoFocus value={name} placeholder="Untitled project" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Aspect ratio">
            <div className="aspect-grid">
              {ASPECT_PRESETS.filter((a) => a.id !== 'original' && a.id !== 'custom').map((preset) => (
                <button
                  key={preset.id}
                  className={`aspect-option ${aspect === preset.id ? 'aspect-option--active' : ''}`}
                  onClick={() => setAspect(preset.id)}
                >
                  <div className={`aspect-option__shape aspect-option__shape--${preset.id.replace(':', '-')}`} />
                  <div className="aspect-option__label">{preset.id}</div>
                  <div className="aspect-option__note">{preset.label}</div>
                </button>
              ))}
            </div>
          </Field>
          <Field label="Frame rate">
            <Segmented
              value={String(fps)}
              onChange={(v) => setFps(Number(v))}
              options={[
                { id: '24', label: '24 fps' },
                { id: '30', label: '30 fps' },
                { id: '60', label: '60 fps' }
              ]}
            />
          </Field>
        </div>
      </Modal>
    </div>
  )
}
