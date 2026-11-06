import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Menu, protocol, net } from 'electron'
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
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
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

function createWindow(): BrowserWindow {
  const settings = settingsStore().get()
  const win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: settings.appearance.theme === 'light' ? '#F4F5F7' : '#0B0B0D',
    title: APP_NAME,
    titleBarStyle: 'hidden',
    titleBarOverlay:
      process.platform === 'win32'
        ? {
            color: settings.appearance.theme === 'light' ? '#FFFFFF' : '#101013',
            symbolColor: settings.appearance.theme === 'light' ? '#26262B' : '#E6E6EA',
            height: 40
          }
        : undefined,
    frame: process.platform === 'darwin',
    icon: path.join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => {
    win.show()
    if (process.env.CLIPWRIGHT_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' })
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL
    if (allowed && url.startsWith(allowed)) return
    if (url.startsWith('clipwright-media://')) return
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

app.whenReady().then(async () => {
  log.info('app', `starting ${APP_NAME} ${app.getVersion()} on ${process.platform}/${process.arch}`)

  // Media protocol: only allow files inside the workspace or explicitly opened paths.
  protocol.handle('clipwright-media', (request) => {
    try {
      const url = new URL(request.url)
      const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const normalised = path.normalize(filePath)
      if (!fs.existsSync(normalised)) {
        return new Response('Not found', { status: 404 })
      }
      return net.fetch(pathToFileURL(normalised).toString())
    } catch (error) {
      log.warn('media', `protocol error: ${String(error)}`)
      return new Response('Bad request', { status: 400 })
    }
  })

  vault()
  registerHandlers(() => mainWindow)
  mainWindow = createWindow()

  const menu = Menu.buildFromTemplate(menuTemplate(() => mainWindow))
  Menu.setApplicationMenu(menu)

  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
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
})

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
