import { ensureWorkspace, freeSpace, layoutFor, uniquePath, safeFilename } from './paths'
import type { WorkspaceInfo } from '@shared/types'
import { settingsStore } from './settings'
import fs from 'node:fs'
import path from 'node:path'

let currentRoot = ''

export function workspaceRoot(): string {
  if (currentRoot) return currentRoot
  currentRoot = settingsStore().get().storage.workspaceRoot
  ensureWorkspace(currentRoot)
  return currentRoot
}

export function setWorkspaceRoot(root: string): WorkspaceInfo {
  const layout = ensureWorkspace(root)
  currentRoot = layout.root
  settingsStore().update({ storage: { ...settingsStore().get().storage, workspaceRoot: root } })
  return workspaceInfo()
}

export function workspaceLayout() {
  return layoutFor(workspaceRoot())
}

export function logsDir(): string {
  const dir = path.join(workspaceRoot(), 'Logs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function exportsDir(): string {
  const dir = path.join(workspaceRoot(), 'Exports')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function modelsDir(): string {
  const dir = path.join(workspaceRoot(), 'Models')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function workspaceInfo(): WorkspaceInfo {
  const layout = workspaceLayout()
  const space = freeSpace(layout.root)
  return {
    root: layout.root,
    projectsDir: layout.projects,
    modelsDir: layout.models,
    exportsDir: layout.exports,
    logsDir: layout.logs,
    freeBytes: space.free,
    totalBytes: space.total
  }
}

/** Copy an external asset into the managed media library, keeping a readable name. */
export function importIntoLibrary(sourcePath: string, projectId: string, useProjectFolder = true): string {
  const layout = workspaceLayout()
  const targetDir = useProjectFolder
    ? path.join(layout.projects, safeFilename(projectId), 'media')
    : layout.media
  fs.mkdirSync(targetDir, { recursive: true })
  const filename = safeFilename(path.basename(sourcePath), 'asset')
  const target = uniquePath(targetDir, filename)
  fs.copyFileSync(sourcePath, target)
  return target
}

export function assetFolder(projectId: string): string {
  const dir = path.join(workspaceLayout().projects, safeFilename(projectId), 'media')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
