/**
 * Opening `.clipwright` packages from outside the app.
 *
 * Windows hands the path to the app in three ways, and all three matter:
 *   • double-clicking a file  → argv on a cold start
 *   • "Open with" while running → the `second-instance` event's argv
 *   • dragging a file onto the window → the renderer's drop handler (handled there)
 *
 * The project is imported before the window is told about it, so the renderer
 * always receives a project id it can actually load.
 */
import fs from 'node:fs'
import path from 'node:path'
import { importPackage } from './projects'
import { log } from './logger'

export const PACKAGE_EXTENSION = '.clipwright'

/** First argument that looks like a project package (ignores Electron's own flags). */
export function packageArgument(argv: string[], cwd = process.cwd()): string | null {
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-')) continue
    const candidate = path.isAbsolute(arg) ? arg : path.resolve(cwd, arg)
    if (!candidate.toLowerCase().endsWith(PACKAGE_EXTENSION)) continue
    if (!fs.existsSync(candidate)) {
      log.warn('open', `argument looks like a package but is missing: ${candidate}`)
      continue
    }
    return candidate
  }
  return null
}

export interface OpenedPackage {
  projectId: string
  name: string
}

/**
 * Packages opened before the renderer asked for them (cold start via file
 * association). The renderer drains this at boot, which avoids a race where the
 * event is sent before the window has subscribed.
 */
let pending: OpenedPackage | null = null
let startupTask: Promise<void> | null = null

export function takePendingPackage(): OpenedPackage | null {
  const value = pending
  pending = null
  return value
}

/** Wait for an in-flight cold-start import, then drain it (at most once). */
export async function waitForPendingPackage(): Promise<OpenedPackage | null> {
  if (startupTask) {
    try {
      await startupTask
    } catch {
      /* handled inside the task */
    }
  }
  return takePendingPackage()
}

/**
 * Import a package and remember which project it became, so a second launch with
 * the same file does not silently create duplicates when the user only meant to
 * reopen it.
 */
export async function openPackageFile(filePath: string): Promise<OpenedPackage> {
  const project = await importPackage(filePath)
  log.info('open', `opened package ${path.basename(filePath)} → ${project.id}`)
  const opened = { projectId: project.id, name: project.name }
  pending = opened
  return opened
}

/**
 * Handle packages passed on the command line, at startup and for subsequent
 * launches. `send` forwards the result to the renderer once it is ready.
 */
export async function handlePackageArguments(
  argv: string[],
  send?: (payload: OpenedPackage) => void
): Promise<void> {
  const target = packageArgument(argv)
  if (!target) return
  const task = (async () => {
    try {
      const opened = await openPackageFile(target)
      send?.(opened)
    } catch (error) {
      log.error('open', `could not open package: ${String(error)}`)
    }
  })()
  startupTask = task
  await task
}

/** True when the app was started by a file association rather than by the user. */
export function launchedWithPackage(argv: string[] = process.argv): boolean {
  return packageArgument(argv) !== null
}
