import { ensureWorkspace, freeSpace, layoutFor, uniquePath, safeFilename } from './paths'
import type { WorkspaceInfo } from '@shared/types'
import { settingsStore } from './settings'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

let currentRoot = ''

export function workspaceRoot(): string {
  if (currentRoot) return currentRoot
  currentRoot = settingsStore().get().storage.workspaceRoot
  ensureWorkspace(currentRoot)
  return currentRoot
}

/**
 * Point the cached workspace root at `root` without touching settings.
 *
 * The SettingsStore calls this from reset(); keeping the cache update here means
 * there is exactly one place that knows the root is cached in module scope.
 */
export function applyWorkspaceRoot(root: string): void {
  ensureWorkspace(root)
  currentRoot = root
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

/**
 * Copy an external asset into the managed media library, keeping a readable name.
 *
 * The same file imported twice used to be copied twice: `uniquePath` always makes
 * a new name, so a live workspace ended up with 97 MB across three files where
 * one was referenced, including two byte-identical videos. The source is hashed
 * once; if the library already holds that content the existing copy is reused.
 */
export function importIntoLibrary(sourcePath: string, projectId: string, useProjectFolder = true): string {
  const layout = workspaceLayout()
  const targetDir = useProjectFolder
    ? path.join(layout.projects, safeFilename(projectId), 'media')
    : layout.media
  fs.mkdirSync(targetDir, { recursive: true })
  const filename = safeFilename(path.basename(sourcePath), 'asset')
  const digest = fileDigest(sourcePath)
  if (digest) {
    const existing = findByDigest(targetDir, digest)
    if (existing) return existing
  }
  const target = uniquePath(targetDir, filename)
  fs.copyFileSync(sourcePath, target)
  return target
}

/** SHA-256 of a file, or undefined when it cannot be read. */
export function fileDigest(file: string, maxBytes = 4 * 1_073_741_824): string | undefined {
  try {
    const stats = fs.statSync(file)
    if (!stats.isFile() || stats.size > maxBytes || stats.size === 0) return undefined
    // Size is mixed into the digest so two different files of the same content
    // prefix never collide on a partial read.
    const hash = createHash('sha256')
    hash.update(String(stats.size))
    hash.update(fs.readFileSync(file))
    return hash.digest('hex')
  } catch {
    return undefined
  }
}

/** Look for a file in `dir` whose content matches `digest`. */
function findByDigest(dir: string, digest: string): string | undefined {
  let entries: string[] = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return undefined
  }
  for (const name of entries) {
    const candidate = path.join(dir, name)
    try {
      if (!fs.statSync(candidate).isFile()) continue
    } catch {
      continue
    }
    if (fileDigest(candidate) === digest) return candidate
  }
  return undefined
}

export function assetFolder(projectId: string): string {
  const dir = path.join(workspaceLayout().projects, safeFilename(projectId), 'media')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
