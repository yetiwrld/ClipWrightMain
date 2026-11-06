/** Media library: import, search, filter, thumbnails, drag to timeline. */
import React, { useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Film,
  Image as ImageIcon,
  Music,
  Plus,
  Search,
  Link2,
  FolderOpen,
  Trash2,
  AlertTriangle,
  RefreshCw,
  MoreVertical,
  Grid,
  List
} from 'lucide-react'
import { useEditor } from '../state/editor'
import { useApp } from '../state/app'
import { Button, ContextMenu, EmptyState, Segmented, type MenuItem } from './ui'
import { formatBytes, formatClock } from '@shared/time'
import { baseClip } from '@shared/timeline'
import { api, errorMessage, mediaUrl } from '../lib/api'
import type { MediaAsset } from '@shared/types'

interface Props {
  onImportFiles: () => void
  onImportUrl: () => void
  onAddText: () => void
}

export function MediaLibrary({ onImportFiles, onImportUrl, onAddText }: Props): JSX.Element {
  const project = useEditor((s) => s.project)
  const apply = useEditor((s) => s.apply)
  const notify = useEditor((s) => s.notify)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'video' | 'audio' | 'image'>('all')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [menu, setMenu] = useState<{ x: number; y: number; asset: MediaAsset } | null>(null)
  const dragAsset = useRef<string | null>(null)

  const assets = useMemo(() => {
    if (!project) return []
    return project.assets
      .filter((a) => (filter === 'all' ? true : a.kind === filter))
      .filter((a) => (query ? a.name.toLowerCase().includes(query.toLowerCase()) : true))
      .sort((a, b) => b.importedAt - a.importedAt)
  }, [project, filter, query])

  const missingCount = project?.assets.filter((a) => a.missing).length ?? 0

  const addAsset = (asset: MediaAsset) => {
    apply(
      (p) => ({ ...p, assets: [...p.assets.filter((a) => a.id !== asset.id), asset] }),
      'Import media',
      { history: false }
    )
  }

  const removeAsset = (asset: MediaAsset) => {
    apply(
      (p) => ({
        ...p,
        assets: p.assets.filter((a) => a.id !== asset.id),
        clips: p.clips.filter((c) => c.assetId !== asset.id)
      }),
      'Remove media'
    )
    notify({ kind: 'info', title: `Removed ${asset.name} from the project`, body: 'The original file was not deleted.' })
  }

  const relink = async (asset: MediaAsset) => {
    if (!project) return
    try {
      const updated = await api.projects.relink(project.id, asset.id)
      if (updated) {
        useEditor.getState().setProject(updated)
        notify({ kind: 'success', title: 'Media relinked' })
      }
    } catch (error) {
      notify({ kind: 'error', title: 'Relink failed', body: errorMessage(error) })
    }
  }

  const openMenu = (event: React.MouseEvent, asset: MediaAsset) => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, asset })
  }

  const menuItems = (asset: MediaAsset): MenuItem[] => [
    {
      label: 'Add to timeline',
      onClick: () => {
        if (!project) return
        const track = project.tracks.find((t) => (asset.kind === 'audio' ? t.kind === 'audio' : t.kind === 'video'))
        if (!track) return notify({ kind: 'error', title: 'No suitable track — add one first.' })
        const kind = asset.kind === 'audio' ? 'audio' : asset.kind === 'image' ? 'image' : 'video'
        const clip = baseClip(kind, track.id, asset.name)
        clip.assetId = asset.id
        clip.duration = asset.kind === 'image' ? 4000 : Math.min(asset.probe.durationMs, 120000)
        clip.sourceDuration = asset.probe.durationMs
        const state = useEditor.getState()
        clip.start = state.playhead
        state.apply((p) => ({ ...p, clips: [...p.clips, clip] }), 'Add clip')
      }
    },
    { label: 'Reveal in Explorer', onClick: () => void api.app.revealPath(asset.path) },
    { label: 'Relink file…', onClick: () => void relink(asset) },
    asset.probe.hasAudio && asset.kind === 'video'
      ? { label: 'Create proxy', onClick: () => void createProxy(asset) }
      : { separator: true, label: 'sep' },
    { label: 'Remove from project', danger: true, onClick: () => removeAsset(asset) }
  ]

  const createProxy = async (asset: MediaAsset) => {
    try {
      notify({ kind: 'info', title: 'Building proxy…', body: 'This runs in the background.' })
      const path = await api.media.generateProxy(asset, 720)
      apply((p) => ({
        ...p,
        assets: p.assets.map((a) => (a.id === asset.id ? { ...a, proxy: path, proxyStatus: 'ready' } : a))
      }), 'Create proxy', { history: false })
      notify({ kind: 'success', title: 'Proxy ready', body: path })
    } catch (error) {
      notify({ kind: 'error', title: 'Proxy failed', body: errorMessage(error) })
    }
  }

  return (
    <div className="panel media-panel">
      <div className="panel__header">
        <div className="panel__title">
          <Film size={13} /> Media
          <span className="badge">{project?.assets.length ?? 0}</span>
        </div>
        <div className="row" style={{ gap: 2 }}>
          <button className="btn btn--ghost btn--icon btn--sm tip" data-tip="Import files" onClick={onImportFiles}>
            <Plus size={14} />
          </button>
          <button className="btn btn--ghost btn--icon btn--sm tip" data-tip="Import from URL" onClick={onImportUrl}>
            <Link2 size={13} />
          </button>
        </div>
      </div>

      <div className="media-panel__filters">
        <div className="search-field">
          <Search size={12} />
          <input className="input" placeholder="Search media" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { id: 'all', label: 'All' },
              { id: 'video', label: 'Video' },
              { id: 'audio', label: 'Audio' },
              { id: 'image', label: 'Image' }
            ]}
          />
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { id: 'grid', label: '▦' },
              { id: 'list', label: '☰' }
            ]}
          />
        </div>
      </div>

      {missingCount > 0 && (
        <div className="media-panel__warning">
          <AlertTriangle size={13} />
          <span>{missingCount} file(s) missing</span>
          <Button size="sm" variant="ghost" onClick={() => {
            const missing = project?.assets.find((a) => a.missing)
            if (missing) void relink(missing)
          }}>
            Relink
          </Button>
        </div>
      )}

      <div className={clsx('panel__body media-panel__body', view === 'grid' && 'media-panel__body--grid')}>
        {assets.length === 0 ? (
          <EmptyState
            icon={<FolderOpen size={20} />}
            title="No media yet"
            body="Import video, audio or images. Files are copied into the project by default so they stay available."
            action={
              <div className="row">
                <Button variant="primary" size="sm" icon={<Plus size={13} />} onClick={onImportFiles}>
                  Import files
                </Button>
                <Button size="sm" icon={<Link2 size={13} />} onClick={onImportUrl}>
                  From URL
                </Button>
              </div>
            }
          />
        ) : (
          assets.map((asset) => (
            <div
              key={asset.id}
              className={clsx('media-item', asset.missing && 'media-item--missing')}
              draggable
              onDragStart={(e) => {
                dragAsset.current = asset.id
                e.dataTransfer.setData('application/x-clipwright-asset', asset.id)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              onContextMenu={(e) => openMenu(e, asset)}
              onDoubleClick={() => menuItems(asset)[0].onClick?.()}
              title={`${asset.name}\n${asset.probe.width ?? ''}${asset.probe.width ? '×' : ''}${asset.probe.height ?? ''} ${
                asset.probe.fps ? `${asset.probe.fps}fps` : ''
              }\n${formatClock(asset.probe.durationMs, true)} · ${formatBytes(asset.sizeBytes)}`}
            >
              <div className="media-item__thumb">
                {asset.missing ? (
                  <AlertTriangle size={18} />
                ) : asset.thumbnail && asset.kind !== 'audio' ? (
                  <img src={mediaUrl(asset.thumbnail)} alt="" loading="lazy" />
                ) : asset.kind === 'audio' ? (
                  <Music size={18} />
                ) : (
                  <ImageIcon size={18} />
                )}
                <span className="media-item__kind">
                  {asset.kind === 'video' ? <Film size={10} /> : asset.kind === 'audio' ? <Music size={10} /> : <ImageIcon size={10} />}
                  {asset.probe.durationMs ? formatClock(asset.probe.durationMs) : asset.kind}
                </span>
              </div>
              <div className="media-item__meta">
                <span className="media-item__name truncate">{asset.name}</span>
                <span className="media-item__sub">
                  {asset.probe.width ? `${asset.probe.width}×${asset.probe.height}` : asset.kind}
                  {asset.storage === 'linked' ? ' · linked' : ''}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="panel__footer">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Button size="sm" variant="ghost" icon={<Grid size={12} />} onClick={onAddText}>
            Add text
          </Button>
          <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => {
            if (!project) return
            void (async () => {
              const availability = await api.media.checkAvailability(project.assets)
              apply((p) => ({
                ...p,
                assets: p.assets.map((a) => ({
                  ...a,
                  missing: !availability.find((x) => x.id === a.id)?.exists
                }))
              }), 'Recheck media', { history: false })
            })()
          }}>
            Recheck
          </Button>
        </div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.asset)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
