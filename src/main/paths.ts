import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Workspace layout. Everything Clipwright Studio owns lives under one root so a
 * user can move it to another drive and so project packages are self-contained.
 */
export interface WorkspaceLayout {
  root: string
  projects: string
  media: string
  assets: string
  proxies: string
  generated: string
  exports: string
  cache: string
  models: string
  recovery: string
  logs: string
  presets: string
  templates: string
  fonts: string
  thumbnails: string
  waveforms: string
  temp: string
}

export function defaultWorkspaceRoot(): string {
  // Documents/Clipwright Studio — survives app reinstalls and is easy to find.
  const docs = app?.getPath?.('documents')
  return path.join(docs ?? app.getPath('userData'), 'Clipwright Studio')
}

export function layoutFor(root: string): WorkspaceLayout {
  return {
    root,
    projects: path.join(root, 'Projects'),
    media: path.join(root, 'Media'),
    assets: path.join(root, 'Assets'),
    proxies: path.join(root, 'Proxies'),
    generated: path.join(root, 'Generated Clips'),
    exports: path.join(root, 'Exports'),
    cache: path.join(root, 'Cache'),
    models: path.join(root, 'Models'),
    recovery: path.join(root, 'Recovery'),
    logs: path.join(root, 'Logs'),
    presets: path.join(root, 'Caption Presets'),
    templates: path.join(root, 'Templates'),
    fonts: path.join(root, 'Fonts'),
    thumbnails: path.join(root, 'Cache', 'thumbnails'),
    waveforms: path.join(root, 'Cache', 'waveforms'),
    temp: path.join(root, 'Cache', 'temp')
  }
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function ensureWorkspace(root: string): WorkspaceLayout {
  const layout = layoutFor(root)
  for (const value of Object.values(layout)) ensureDir(value)
  return layout
}

/** Config + credentials live in the OS app-data folder, never in the workspace. */
export function configDir(): string {
  const dir = path.join(app.getPath('userData'), 'config')
  ensureDir(dir)
  return dir
}

export function safeFilename(name: string, fallback = 'untitled'): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  return (cleaned || fallback).slice(0, 120)
}

export function uniquePath(dir: string, filename: string): string {
  const ext = path.extname(filename)
  const base = path.basename(filename, ext)
  let candidate = path.join(dir, filename)
  let i = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`)
    i++
  }
  return candidate
}

export function freeSpace(dir: string): { free: number; total: number } {
  try {
    const stats = fs.statfsSync(dir)
    return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize }
  } catch {
    return { free: 0, total: 0 }
  }
}
