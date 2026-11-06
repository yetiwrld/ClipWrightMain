import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Menu, protocol, net, screen } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { IPC, type AppInfo } from '@shared/ipc'
import { APP_NAME, REPO_NAME, REPO_OWNER } from '@shared/defaults'
import { settingsStore } from './settings'
import { vault } from './vault'
import {
  workspaceInfo,
  workspaceRoot,
  setWorkspaceRoot,
  workspaceLayout,
  importsRoot,
  probeCapabilities
} from './handlers-support'
import { registerHandlers } from './handlers'
import { log } from './logger'
import { menuTemplate } from './menu'
import { killAll } from './ffmpeg/runner'
import { handlePackageArguments, type OpenedPackage } from './open-package'

// Single instance: focus the existing window instead of starting a second copy.
//
// But never *silently* do nothing: if another copy holds the lock and does not
// respond within a few seconds, take over. That is the difference between "it is
// already open" and "it opens once and then never again", which is what a
// half-dead process (renderer gone, no window) looks like to the user.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // The existing instance gets `second-instance` and raises its window. If it is
  // alive but windowless it will not do anything visible, so rather than leaving
  // the user with a program that "does not open", tell them exactly what happened
  // and what to do. (Taking over the lock is not possible: the old process keeps
  // it until it exits, and a second one would then fight over the same data.)
  log.warn('app', 'another instance holds the single-instance lock')
  setTimeout(() => {
    void dialog.showMessageBox({
      type: 'info',
      title: 'Clipwright Studio is already running',
      message: 'Another copy of Clipwright Studio is already open.',
      detail:
        'If you can see its window, use it. If you cannot, close “Clipwright Studio.exe” in Task Manager and start the app again — a previous copy is still running in the background.',
      buttons: ['OK']
    })
    app.quit()
  }, 2500)
  setTimeout(() => app.quit(), 6000)
}

let mainWindow: BrowserWindow | null = null

/**
 * A package passed on the command line (file association) is imported before the
 * renderer asks for it; the renderer drains it at boot via `project.pendingOpen`.
 * A package opened while the app is already running is pushed as an event.
 */
function forwardPackage(payload: OpenedPackage): void {
  mainWindow?.webContents.send(IPC.events.openPackage, payload)
}

// Serve local media to the renderer through a controlled protocol so file paths
// with spaces/unicode work and the renderer never needs node integration.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'clipwright-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
  }
])

/**
 * Height of the custom title bar, in CSS pixels.
 *
 * Must match `--titlebar-h` in styles/tokens.css: Electron draws the native
 * minimise/maximise/close strip at exactly this height, and the HTML top bar is
 * painted underneath it. When the two disagree the caption buttons look wrong
 * and the window controls do not line up with the tabs.
 */
const TITLEBAR_HEIGHT = 40

/** Fit the default window size to the display it will open on. */
function windowBoundsFor(width: number, height: number): { width: number; height: number } {
  try {
    const { workAreaSize } = screen.getPrimaryDisplay()
    return {
      width: Math.min(width, Math.max(900, workAreaSize.width - 80)),
      height: Math.min(height, Math.max(600, workAreaSize.height - 80))
    }
  } catch {
    return { width, height }
  }
}

function createWindow(): BrowserWindow {
  const settings = settingsStore().get()
  const win = new BrowserWindow({
    /* Bounds are clamped against the actual display, so the window can never
       open larger than the screen it appears on. */
    ...windowBoundsFor(1560, 980),
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: settings.appearance.theme === 'light' ? '#F4F5F7' : '#0B0B0D',
    title: APP_NAME,
    titleBarStyle: 'hidden',
    titleBarOverlay:
      process.platform === 'win32'
        ? {
            color: settings.appearance.theme === 'light' ? '#FFFFFF' : '#101013',
            symbolColor: settings.appearance.theme === 'light' ? '#26262B' : '#E6E6EA',
            height: TITLEBAR_HEIGHT
          }
        : undefined,
    frame: process.platform === 'darwin',
    icon: path.join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      /*
       * With the sandbox off, any renderer code-execution bug reaches a full Node
       * realm through the preload. The preload only uses contextBridge and
       * ipcRenderer, both of which work sandboxed, so there is nothing left that
       * needs the unsandboxed realm.
       */
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  // Always surface renderer problems in the log: a packaged app that shows a
  // blank window is impossible to diagnose from the outside otherwise.
  win.webContents.on('console-message', (_event, level, message, line, source) => {
    if (level >= 2) log.warn('renderer', `${message} (${source}:${line})`)
  })
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    log.error('preload', `${preloadPath}: ${error.message}`)
  })
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    log.error('renderer', `failed to load ${url}: ${code} ${description}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    log.error('renderer', `render process gone: ${details.reason} (exit ${details.exitCode})`)
    if (details.reason !== 'clean-exit') {
      // Without this the process can outlive its window and look like "nothing
      // opened" (a second launch would then also bail out on the instance lock).
      dialog.showErrorBox(
        'Clipwright Studio stopped',
        `The window closed unexpectedly (${details.reason}).\n\nDetails were written to:\n${log.path()}`
      )
      app.exit(1)
    }
  })

  // CI: `CLIPWRIGHT_SMOKE=1` makes the packaged app boot, verify the *UI actually
  // rendered* (not just that the document loaded) and exit with that status.
  // `did-finish-load` alone is not enough: a blocked or broken bundle still fires
  // it, which is exactly the failure mode that produces a blank window.
  if (process.env.CLIPWRIGHT_SMOKE === '1') {
    const finish = (code: number, message: string) => {
      if (code === 0) log.info('smoke', message)
      else log.error('smoke', message)
      clearTimeout(timer)
      app.exit(code)
    }
    const timer = setTimeout(() => finish(1, 'renderer never rendered the UI within 60s'), 60_000)

    win.webContents.once('did-fail-load', (_event, code, description) => {
      finish(1, `renderer failed to load: ${code} ${description}`)
    })
    win.webContents.once('render-process-gone', (_event, details) => {
      finish(1, `render process gone: ${details.reason}`)
    })

    win.webContents.once('did-finish-load', async () => {
      try {
        // Wait for React to commit something into #root, then confirm the window
        // is actually on screen — the two things a user would notice.
        const probe = await win.webContents.executeJavaScript(`
          new Promise((resolve) => {
            const started = Date.now()
            const check = () => {
              const root = document.getElementById('root')
              const text = (root && root.innerText) || ''
              if (text.trim().length > 20) { resolve({ ok: true, chars: text.trim().length }); return }
              if (Date.now() - started > 20000) { resolve({ ok: false, chars: text.trim().length }); return }
              setTimeout(check, 250)
            }
            check()
          })
        `)
        if (!probe.ok) return finish(1, `window is blank: #root has ${probe.chars} characters of text`)
        if (!win.isVisible()) return finish(1, 'window never became visible')
        finish(0, `UI rendered (${probe.chars} characters) and the window is visible`)
      } catch (error) {
        finish(1, `could not inspect the renderer: ${String(error)}`)
      }
    })
  }

  win.once('ready-to-show', () => {
    win.show()
    if (process.env.CLIPWRIGHT_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' })
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  /*
   * Top-level navigation is limited to the dev server during development.
   * `clipwright-media://` used to be allowed here, which let the window be
   * navigated to any local HTML file with the preload bridge still attached —
   * arbitrary local HTML with access to window.clipwright. The media scheme is
   * served through protocol.handle only; it is never a navigation target.
   */
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    const appUrl = pathToFileURL(path.join(__dirname, '../renderer/index.html')).toString()
    if (devUrl && url.startsWith(devUrl)) return
    if (!devUrl && url === appUrl) return
    event.preventDefault()
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  win.on('closed', () => {
    mainWindow = null
  })
  return win
}

app.whenReady().then(boot).catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  log.error('app', `startup failed: ${message}`)
  process.stderr.write(`Clipwright Studio failed to start: ${message}\n`)
  // A silent exit is indistinguishable from "the program is broken". Say what
  // happened and where the log is.
  dialog.showErrorBox(
    'Clipwright Studio could not start',
    `Something went wrong while starting up.\n\n${message}\n\nDetails: ${log.path()}`
  )
  app.exit(1)
})

async function boot(): Promise<void> {
  log.info('app', `starting ${APP_NAME} ${app.getVersion()} on ${process.platform}/${process.arch}`)

  /*
   * Media protocol. The comment here always said "only allow files inside the
   * workspace", but the code checked nothing except that the path existed — so
   * clipwright-media://<any local file>, including the app's own vault.json, was
   * a readable URL from the renderer. Paths are now resolved through realpath and
   * must sit inside the workspace (or an asset the project actually references).
   */
  protocol.handle('clipwright-media', async (request) => {
    try {
      const url = new URL(request.url)
      const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const resolved = await resolveMediaPath(filePath)
      if (!resolved) {
        log.warn('media', `refused to serve a path outside the workspace: ${filePath}`)
        return new Response('Forbidden', { status: 403 })
      }
      if (!fs.existsSync(resolved)) return new Response('Not found', { status: 404 })
      return net.fetch(pathToFileURL(resolved).toString())
    } catch (error) {
      log.warn('media', `protocol error: ${String(error)}`)
      return new Response('Bad request', { status: 400 })
    }
  })

  vault()
  /*
   * Folders under Projects/ with no project.json are debris: a crash between
   * mkdir and the first save, or the old remove() that deliberately kept media/
   * behind. Nothing can reach them, and they hold gigabytes.
   */
  try {
    const { sweepOrphanedProjects } = await import('./projects')
    const swept = sweepOrphanedProjects()
    if (swept.length) log.info('app', `removed ${swept.length} orphaned project folder(s) at startup`)
  } catch (error) {
    log.warn('app', `orphan sweep failed: ${String(error)}`)
  }
  registerHandlers(() => mainWindow)
  mainWindow = createWindow()

  const menu = Menu.buildFromTemplate(menuTemplate(() => mainWindow))
  Menu.setApplicationMenu(menu)

  app.on('second-instance', (_event, argv) => {
    if (!mainWindow) {
      // A previous window was closed but the process kept running (a stray
      // reference, a pending export…). Recreate it instead of doing nothing:
      // otherwise every subsequent launch looks like "the app will not open".
      log.warn('app', 'second launch arrived with no window; recreating it')
      mainWindow = createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    // "Open with Clipwright Studio" from Explorer while the app is running.
    void handlePackageArguments(argv, forwardPackage)
  })


  // Cold start via file association: import now; the renderer drains the result
  // when it finishes booting (see IPC.project.pendingOpen).
  void handlePackageArguments(process.argv, forwardPackage)

  // Automatic update check (silent: only reports when an update is available).
  const settings = settingsStore().get()
  if (settings.updates.autoCheck) {
    setTimeout(async () => {
      try {
        const { checkForUpdates } = await import('./updater')
        const info = await checkForUpdates(false)
        if (info.available && mainWindow) {
          mainWindow.webContents.send(IPC.events.updateProgress, {
            stage: 'available',
            percent: 0,
            receivedBytes: 0,
            totalBytes: 0,
            message: `Version ${info.latestVersion} is available`,
            info
          })
        }
      } catch (error) {
        log.warn('update', `auto check failed: ${String(error)}`)
      }
    }, 8000)
  }
}

app.on('window-all-closed', () => {
  killAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  killAll()
  settingsStore().saveNow()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
})

process.on('uncaughtException', (error) => {
  log.error('app', `uncaught exception: ${error.stack ?? error.message}`)
})
process.on('unhandledRejection', (reason) => {
  log.error('app', `unhandled rejection: ${String(reason)}`)
})

export { IPC, AppInfo }

/**
 * Confine `clipwright-media://` to files the app owns.
 *
 * Returns the canonical path when it is inside the workspace, or `undefined`
 * when it is not. `realpath` is used so `..` segments and symlinks cannot escape
 * the workspace root, and both paths are compared after normalising separators
 * and case — Windows paths are case-insensitive.
 */
export async function resolveMediaPath(raw: string): Promise<string | undefined> {
  if (!raw) return undefined
  let real: string
  try {
    real = await fs.promises.realpath(path.resolve(raw))
  } catch {
    // Missing files are still checked lexically so a 404 cannot be used as an
    // existence oracle for files outside the workspace.
    real = path.resolve(raw)
  }
  let root: string
  try {
    root = await fs.promises.realpath(workspaceRoot())
  } catch {
    root = path.resolve(workspaceRoot())
  }
  const normalise = (value: string) =>
    process.platform === 'win32' ? value.replace(/\\/g, '/').toLowerCase() : value.replace(/\\/g, '/')
  const target = normalise(real)
  const base = normalise(root)
  if (target === base) return real
  if (!target.startsWith(base.endsWith('/') ? base : `${base}/`)) return undefined
  return real
}
