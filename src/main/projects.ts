/**
 * Project persistence.
 *
 * Layout per project:
 *   <workspace>/Projects/<id>/project.json      — the timeline document
 *   <workspace>/Projects/<id>/transcript.json   — transcript (if transcribed)
 *   <workspace>/Projects/<id>/moments.json      — AI moments (if analysed)
 *   <workspace>/Projects/<id>/media/            — managed media copies
 *
 * Autosave writes atomically (tmp + rename) off the UI path, and every save also
 * drops a recovery snapshot so an unexpected shutdown never loses work.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { workspaceLayout } from './workspace'
import { safeFilename, uniquePath } from './paths'
import { SCHEMA_VERSION, createProject } from '@shared/defaults'
import { baseClip } from '@shared/timeline'
import type { Project, ProjectMeta } from '@shared/types'
import { log } from './logger'
import { Zip, ZipPassThrough, unzipSync } from 'fflate'

const strToBytes = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'utf8'))

const MAX_RECOVERY_SNAPSHOTS = 5
/** Refuse absurd packages before inflating them (zip-bomb guard). */
const MAX_PACKAGE_ENTRIES = 5_000
const MAX_PACKAGE_BYTES = 8 * 1_073_741_824
/**
 * Minimum gap between recovery snapshots of the same project.
 *
 * Autosave runs every few seconds; snapshotting on every save filled the
 * recovery list with near-identical cards. The point of a recovery point is to
 * survive a crash, so one every few minutes is plenty — and the previous
 * snapshot is kept untouched, so "the last good state" is still there.
 */
const RECOVERY_INTERVAL_MS = 2 * 60_000

export interface ProjectSummary extends ProjectMeta {
  durationMs: number
  clipCount: number
  assetCount: number
  thumbnail?: string
  aspect: string
  hasTranscript: boolean
  sizeBytes: number
}

function projectDir(id: string): string {
  return path.join(workspaceLayout().projects, safeFilename(id))
}

function projectFile(id: string): string {
  return path.join(projectDir(id), 'project.json')
}

export function listProjects(): ProjectSummary[] {
  const dir = workspaceLayout().projects
  if (!fs.existsSync(dir)) return []
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
  const out: ProjectSummary[] = []
  for (const entry of entries) {
    const file = path.join(dir, entry.name, 'project.json')
    if (!fs.existsSync(file)) continue
    try {
      const project = JSON.parse(fs.readFileSync(file, 'utf8')) as Project
      const stats = fs.statSync(file)
      out.push({
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        dir: projectDir(project.id),
        file,
        durationMs: project.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0),
        clipCount: project.clips.length,
        assetCount: project.assets.length,
        aspect: project.canvas.aspect,
        hasTranscript: fs.existsSync(path.join(dir, entry.name, 'transcript.json')),
        sizeBytes: stats.size,
        thumbnail: project.assets.find((a) => a.thumbnail)?.thumbnail
      })
    } catch (error) {
      log.warn('projects', `could not read ${file}: ${String(error)}`)
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function loadProject(id: string): Project {
  const file = projectFile(id)
  if (!fs.existsSync(file)) throw new Error(`Project "${id}" was not found on disk.`)
  const project = JSON.parse(fs.readFileSync(file, 'utf8')) as Project
  return migrate(project)
}

function migrate(project: Project): Project {
  let next = project
  const from = next.schemaVersion ?? 0
  if (from < SCHEMA_VERSION) {
    /*
     * Bumping the version without transforming anything relabelled an old
     * document as current, so its missing fields surfaced later as undefined
     * crashes. Each step below is the actual transform for that version; an
     * unknown (older) document is filled in from the defaults rather than
     * trusted.
     */
    log.info('projects', `migrating ${project.id} from schema ${from || 'pre-1'} to ${SCHEMA_VERSION}`)
    if (from < 1) {
      const fresh = createProject(next.name, next.canvas?.aspect ?? '16:9', next.fps ?? 30)
      next = {
        ...fresh,
        ...next,
        canvas: { ...fresh.canvas, ...(next.canvas ?? {}) },
        tracks: next.tracks?.length ? next.tracks : fresh.tracks,
        clips: next.clips ?? [],
        assets: next.assets ?? [],
        markers: next.markers ?? []
      }
    }
    next = { ...next, schemaVersion: SCHEMA_VERSION }
  }
  // Fill in fields added by later versions without touching user data.
  next.clips = next.clips.map((clip) => ({
    ...clip,
    effects: clip.effects ?? [],
    keyframes: clip.keyframes ?? {},
    audio: {
      ...{
        volume: 1,
        gainDb: 0,
        fadeInMs: 0,
        fadeOutMs: 0,
        muted: false,
        showWaveform: true,
        bass: 0,
        treble: 0,
        pan: 0,
        normalize: false,
        ducking: false
      },
      ...(clip.audio ?? {})
    }
  }))
  next.markers = next.markers ?? []
  next.assets = next.assets ?? []
  return next
}

export async function saveProject(project: Project, opts: { snapshot?: boolean } = {}): Promise<Project> {
  const dir = projectDir(project.id)
  fs.mkdirSync(dir, { recursive: true })
  const updated: Project = { ...project, updatedAt: Date.now() }
  const file = projectFile(project.id)
  const tmp = `${file}.tmp`
  const payload = JSON.stringify(updated, null, 2)
  await fsp.writeFile(tmp, payload)
  await fsp.rename(tmp, file)
  if (opts.snapshot !== false) writeRecoverySnapshot(updated)
  return updated
}

export function saveProjectSync(project: Project): Project {
  const dir = projectDir(project.id)
  fs.mkdirSync(dir, { recursive: true })
  const updated = { ...project, updatedAt: Date.now() }
  const file = projectFile(project.id)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(updated, null, 2))
  fs.renameSync(tmp, file)
  writeRecoverySnapshot(updated)
  return updated
}

/* ------------------------------------------------------------------ */
/* Recovery                                                           */
/* ------------------------------------------------------------------ */

function writeRecoverySnapshot(project: Project): void {
  try {
    // An empty project has nothing to recover: a crash on the first screen must
    // not litter the workspace with zero-clip recovery cards.
    if (!project.clips.length && !project.assets.length) return
    const dir = workspaceLayout().recovery
    fs.mkdirSync(dir, { recursive: true })
    const prefix = `${safeFilename(project.id)}-`
    const newest = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
      .map((f) => fs.statSync(path.join(dir, f)).mtimeMs)
      .sort((a, b) => b - a)[0]
    if (newest && Date.now() - newest < RECOVERY_INTERVAL_MS) return
    const file = path.join(dir, `${prefix}${project.updatedAt ?? Date.now()}.json`)
    fs.writeFileSync(file, JSON.stringify(project))
    const snapshots = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .map((f) => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const old of snapshots.slice(MAX_RECOVERY_SNAPSHOTS)) {
      try {
        fs.unlinkSync(old.file)
      } catch {
        /* ignore */
      }
    }
  } catch (error) {
    log.warn('projects', `recovery snapshot failed: ${String(error)}`)
  }
}

export interface RecoveryEntry {
  id: string
  projectId: string
  projectName: string
  savedAt: number
  file: string
  clipCount: number
}

/**
 * Recovery points, newest first — at most one per project.
 *
 * Showing every snapshot of every project turned this list into noise (a dozen
 * near-identical cards, most of them empty). Only the newest snapshot of each
 * project is offered, and projects with no content are skipped.
 */
export function listRecovery(): RecoveryEntry[] {
  const dir = workspaceLayout().recovery
  if (!fs.existsSync(dir)) return []
  const newestPerProject = new Map<string, RecoveryEntry>()
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const full = path.join(dir, file)
    try {
      const project = JSON.parse(fs.readFileSync(full, 'utf8')) as Project
      if (!project.clips.length && !project.assets.length) continue
      const entry: RecoveryEntry = {
        id: file.replace(/\.json$/, ''),
        projectId: project.id,
        projectName: project.name,
        savedAt: fs.statSync(full).mtimeMs,
        file: full,
        clipCount: project.clips.length
      }
      const existing = newestPerProject.get(entry.projectId)
      if (!existing || existing.savedAt < entry.savedAt) newestPerProject.set(entry.projectId, entry)
    } catch {
      /* skip unreadable snapshot */
    }
  }
  return [...newestPerProject.values()].sort((a, b) => b.savedAt - a.savedAt)
}

export function restoreRecovery(id: string): Project {
  const entry = listRecovery().find((e) => e.id === id)
  if (!entry) throw new Error('That recovery point could not be found.')
  const project = JSON.parse(fs.readFileSync(entry.file, 'utf8')) as Project
  saveProjectSync(project)
  return project
}

/* ------------------------------------------------------------------ */
/* Project lifecycle                                                  */
/* ------------------------------------------------------------------ */

export function create(name: string, aspect: string, fps: number, templateId?: string): Project {
  const project = createProject(name || 'Untitled project', aspect, fps)
  if (templateId === 'vertical-clip') {
    project.canvas.aspect = '9:16'
    const { width, height } = { width: 1080, height: 1920 }
    project.canvas.width = width
    project.canvas.height = height
  }
  saveProjectSync(project)
  return project
}

export function duplicate(id: string, newName?: string): Project {
  const project = loadProject(id)
  const copy: Project = {
    ...structuredClone(project),
    id: `prj_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`,
    name: newName ?? `${project.name} copy`,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  // Copy managed media so the two projects are independent.
  const sourceDir = path.join(projectDir(id), 'media')
  const targetDir = path.join(projectDir(copy.id), 'media')
  fs.mkdirSync(targetDir, { recursive: true })
  if (fs.existsSync(sourceDir)) {
    for (const asset of copy.assets) {
      if (asset.storage !== 'managed') continue
      if (!fs.existsSync(asset.path)) continue
      const target = path.join(targetDir, path.basename(asset.path))
      try {
        fs.copyFileSync(asset.path, target)
        asset.path = target
      } catch (error) {
        log.warn('projects', `could not copy media for duplicate: ${String(error)}`)
      }
    }
  }
  saveProjectSync(copy)
  return copy
}

export function rename(id: string, name: string): Project {
  const project = loadProject(id)
  const updated = { ...project, name }
  saveProjectSync(updated)
  return updated
}

export function remove(id: string, deleteMedia = false): void {
  removeRecoveryFor(id)
  const dir = projectDir(id)
  if (!fs.existsSync(dir)) return
  /*
   * Remove the directory itself. This used to leave `media/` behind when
   * deleteMedia was false ("referenced files may be used by other projects"),
   * but media copies live inside their own project folder, so the only thing it
   * achieved was orphaned folders full of megabytes that nothing could reach.
   */
  fs.rmSync(dir, { recursive: true, force: true })
  void deleteMedia
}

/**
 * Delete project folders that have no project.json.
 *
 * A crash between `mkdir` and the first save, or the old `remove()` above, leaves
 * these: gigabytes of media in a folder no screen will ever show. Runs once at
 * startup; returns how many folders were removed.
 */
export function sweepOrphanedProjects(dryRun = false): string[] {
  const root = workspaceLayout().projects
  if (!fs.existsSync(root)) return []
  const removed: string[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    if (fs.existsSync(path.join(dir, 'project.json'))) continue
    removed.push(entry.name)
    if (dryRun) continue
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      log.info('projects', `removed orphaned project folder ${entry.name}`)
    } catch (error) {
      log.warn('projects', `could not remove orphaned folder ${entry.name}: ${String(error)}`)
    }
  }
  return removed
}

/** Delete every recovery point belonging to a project. */
function removeRecoveryFor(projectId: string): void {
  try {
    const dir = workspaceLayout().recovery
    if (!fs.existsSync(dir)) return
    const prefix = `${safeFilename(projectId)}-`
    for (const file of fs.readdirSync(dir)) {
      if (!file.startsWith(prefix)) continue
      try {
        fs.unlinkSync(path.join(dir, file))
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

export function archive(id: string): string {
  const project = loadProject(id)
  const dir = workspaceLayout().exports
  fs.mkdirSync(dir, { recursive: true })
  const target = uniquePath(dir, `${safeFilename(project.name)}.clipwright-project.json`)
  fs.writeFileSync(target, JSON.stringify({ kind: 'clipwright-project', project, archivedAt: Date.now() }, null, 2))
  return target
}

/**
 * Export a portable project package as a single `.clipwright` file.
 *
 * The file is an ordinary ZIP (so it can be inspected with any unzip tool) whose
 * root contains `project.json`, optional `transcript.json` / `moments.json` and,
 * when `includeMedia` is set, the managed media under `media/`.
 *
 *   project.json  { kind: 'clipwright-package', version, project, ... }
 *
 * Asset paths inside the manifest are relative (`media/<file>`), so the package
 * survives being moved between machines.
 */
export async function exportPackage(id: string, includeMedia = true): Promise<string> {
  const project = loadProject(id)
  const dir = workspaceLayout().exports
  fs.mkdirSync(dir, { recursive: true })
  const target = uniquePath(dir, `${safeFilename(project.name)}.clipwright`)

  const packaged: Project = {
    ...project,
    assets: project.assets.map((asset) => {
      if (asset.storage !== 'managed') return { ...asset }
      // Rewrite to a package-relative path so the manifest is machine-independent.
      const relative = path.join('media', path.basename(asset.path)).replace(/\\/g, '/')
      return { ...asset, path: relative, relativePath: relative }
    })
  }

  /*
   * Media is streamed straight into the zip (stored, not deflated — it is already
   * compressed). It used to be read into memory and zipped with `zipSync`, so a
   * project with a few GB of managed media exhausted the main process heap.
   */
  enum EntryKind {
    File,
    Text
  }
  const plan: { name: string; kind: EntryKind; source: string }[] = []
  let totalBytes = 0
  const mediaFiles: string[] = []

  if (includeMedia) {
    for (const asset of project.assets) {
      if (asset.storage !== 'managed') continue
      if (!fs.existsSync(asset.path)) continue
      const name = path.basename(asset.path)
      plan.push({ name: `media/${name}`, kind: EntryKind.File, source: asset.path })
      mediaFiles.push(`media/${name}`)
      totalBytes += fs.statSync(asset.path).size
    }
  }

  const manifestText = JSON.stringify(
    {
      kind: 'clipwright-package',
      version: 1,
      app: 'Clipwright Studio',
      exportedAt: Date.now(),
      includeMedia,
      totalBytes,
      mediaFiles,
      project: packaged
    },
    null,
    2
  )
  for (const extra of ['transcript.json', 'moments.json']) {
    const source = path.join(projectDir(id), extra)
    if (fs.existsSync(source)) plan.push({ name: extra, kind: EntryKind.File, source })
  }

  // Stream: one entry at a time, stored (level 0), nothing held in memory.
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(target)
    output.on('error', reject)
    output.on('finish', () => resolve())
    const archive = new Zip((error, chunk) => {
      if (error) {
        output.destroy(error)
        return
      }
      if (chunk) output.write(Buffer.from(chunk))
    })
    const queue: { name: string; file?: string; text?: string }[] = [
      ...plan.map((entry) => ({ name: entry.name, file: entry.source })),
      { name: 'project.json', text: manifestText }
    ]
    let index = 0
    const next = () => {
      const entry = queue[index++]
      if (!entry) {
        archive.end()
        output.end()
        return
      }
      // ZipPassThrough stores the bytes as-is: media is already compressed.
      const stream = new ZipPassThrough(entry.name)
      archive.add(stream)
      if (entry.text !== undefined) {
        stream.push(strToBytes(entry.text), true)
        next()
        return
      }
      const input = fs.createReadStream(entry.file!)
      input.on('data', (chunk) => stream.push(new Uint8Array(chunk as Buffer)))
      input.on('end', () => {
        stream.push(new Uint8Array(0), true)
        next()
      })
      input.on('error', (error) => reject(error))
    }
    next()
  })
  const size = fs.statSync(target).size
  log.info(
    'projects',
    `exported package ${path.basename(target)} (${(size / 1_048_576).toFixed(1)} MB, ` +
      `${plan.length + 1} entries, media=${includeMedia ? mediaFiles.length : 0})`
  )
  return target
}

/**
 * Import a package previously produced by {@link exportPackage}.
 *
 * Accepts either the `.clipwright` archive or a legacy folder package. The
 * project always gets a fresh id, so importing the same package twice creates two
 * projects instead of overwriting one.
 */
export async function importPackage(packagePath: string): Promise<Project> {
  if (!fs.existsSync(packagePath)) throw new Error('That file could not be found.')

  let manifestFile = path.join(packagePath, 'project.json')
  let extractDir: string | null = null
  let manifestBytes: Uint8Array | null = null
  let archive: Record<string, Uint8Array> | null = null

  if (fs.statSync(packagePath).isFile()) {
    if (!packagePath.toLowerCase().endsWith('.clipwright')) {
      throw new Error('That is not a Clipwright package — expected a .clipwright file.')
    }
    try {
      const raw = new Uint8Array(await fsp.readFile(packagePath))
      const names = listZipEntries(raw)
      /*
       * Cap the entry count and the declared uncompressed total before inflating
       * anything. A malicious .clipwright that expands to terabytes used to be
       * read entirely into memory.
       */
      if (names.length > MAX_PACKAGE_ENTRIES) {
        throw new Error(`That package contains ${names.length} files, which is more than a project can have.`)
      }
      const declared = declaredUncompressedBytes(raw)
      if (declared > MAX_PACKAGE_BYTES) {
        throw new Error(
          `That package declares ${(declared / 1_073_741_824).toFixed(1)} GB of contents, which is too large to import.`
        )
      }
      archive = unzipSync(raw)
      const expanded = Object.values(archive).reduce((total, bytes) => total + bytes.byteLength, 0)
      if (expanded > MAX_PACKAGE_BYTES) {
        throw new Error('That package expands to more data than a project import can hold.')
      }
    } catch (error) {
      throw new Error(
        error instanceof Error && /package (contains|expands|declares)/.test(error.message)
          ? error.message
          : 'That .clipwright file is damaged or is not a Clipwright package.'
      )
    }
    const manifest = Object.keys(archive).find((name) => name === 'project.json' || name.endsWith('/project.json'))
    if (!manifest) throw new Error('That package has no project.json — it may be corrupt.')
    manifestBytes = archive[manifest]
    manifestFile = manifest
  } else if (!fs.existsSync(manifestFile)) {
    throw new Error('This folder is not a Clipwright project package (project.json is missing).')
  }

  const raw = manifestBytes ?? new Uint8Array(await fsp.readFile(manifestFile))
  if (raw.byteLength > MAX_PACKAGE_BYTES / 100) throw new Error('That project manifest is implausibly large.')
  const manifest = JSON.parse(Buffer.from(raw).toString('utf8')) as {
    kind?: string
    project?: Project
    mediaFiles?: string[]
  }
  if (manifest.kind !== 'clipwright-package' || !manifest.project) {
    throw new Error('That file is not a Clipwright project package.')
  }

  const project = manifest.project
  project.id = `prj_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`
  project.createdAt = Date.now()
  project.updatedAt = Date.now()
  const targetDir = projectDir(project.id)
  const mediaDir = path.join(targetDir, 'media')
  fs.mkdirSync(mediaDir, { recursive: true })

  let missingMedia = 0
  for (const asset of project.assets) {
    const inside = (asset.path ?? '').replace(/\\/g, '/')
    if (!inside.startsWith('media/')) continue
    const name = path.basename(inside)
    const bytes = archive?.[inside] ?? archive?.[`media/${name}`]
    if (bytes) {
      const dest = path.join(mediaDir, name)
      await fsp.writeFile(dest, bytes)
      asset.path = dest
      asset.relativePath = path.join('media', name)
      continue
    }
    const folderSource = path.join(packagePath, inside)
    if (!archive && fs.existsSync(folderSource)) {
      const dest = path.join(mediaDir, name)
      await fsp.copyFile(folderSource, dest)
      asset.path = dest
      asset.relativePath = path.join('media', name)
      continue
    }
    asset.missing = true
    missingMedia += 1
  }

  if (missingMedia > 0) {
    log.warn('projects', `package imported with ${missingMedia} missing media file(s)`)
  }

  for (const extra of ['transcript.json', 'moments.json']) {
    const bytes = archive?.[extra]
    const source = path.join(packagePath, extra)
    if (bytes) await fsp.writeFile(path.join(targetDir, extra), bytes)
    else if (fs.existsSync(source) && fs.statSync(source).isFile()) {
      await fsp.copyFile(source, path.join(targetDir, extra))
    }
  }

  await saveProject(project)
  log.info('projects', `imported package ${project.name} → ${project.id}`)
  return project
}

/** Detect project assets that no longer exist on disk. */
export function missingAssets(project: Project): { id: string; name: string; path: string }[] {
  return project.assets
    .filter((a) => !fs.existsSync(a.path))
    .map((a) => ({ id: a.id, name: a.name, path: a.path }))
}

export function projectStoragePath(id: string): string {
  return projectDir(id)
}

/** A blank project used as a fallback when recovery fails. */
export function blankProject(): Project {
  const project: Project = {
    schemaVersion: SCHEMA_VERSION,
    id: `prj_${Date.now().toString(36)}`,
    name: 'Recovered project',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    canvas: { aspect: '16:9', width: 1920, height: 1080, fps: 30, backgroundColor: '#000000' },
    fps: 30,
    tracks: [],
    clips: [],
    assets: [],
    markers: []
  }
  void baseClip
  return project
}

/* ------------------------------------------------------------------ */
/* Zip inspection                                                     */
/* ------------------------------------------------------------------ */

/**
 * Read the central directory of a zip and return the entry names.
 *
 * Enough to bound a package without inflating it: a name count and the declared
 * uncompressed sizes come straight out of the directory.
 */
export function listZipEntries(data: Uint8Array): string[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const eocd = findEndOfCentralDirectory(view)
  if (eocd < 0) throw new Error('not a zip')
  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const names: string[] = []
  for (let i = 0; i < count && offset + 46 <= data.byteLength; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const name = Buffer.from(data.subarray(offset + 46, offset + 46 + nameLength)).toString('utf8')
    names.push(name)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return names
}

/** Total uncompressed size declared by the central directory. */
export function declaredUncompressedBytes(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const eocd = findEndOfCentralDirectory(view)
  if (eocd < 0) return 0
  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  let total = 0
  for (let i = 0; i < count && offset + 46 <= data.byteLength; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break
    total += view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return total
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 66_000)
  for (let i = view.byteLength - 22; i >= minimum; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i
  }
  return -1
}
