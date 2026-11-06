import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { IPC } from '@shared/ipc'
import { REPO_NAME, REPO_OWNER } from '@shared/defaults'
import { workspaceLayout } from './workspace'
import { APP_NAME } from '@shared/defaults'

/** Native menu — real actions, forwarded to the renderer as commands. */
export function menuTemplate(getWindow: () => BrowserWindow | null): MenuItemConstructorOptions[] {
  const send = (command: string, payload?: unknown) => {
    const win = getWindow()
    win?.webContents.send(IPC.events.menu, { command, payload })
  }
  const appMenu: MenuItemConstructorOptions = {
    label: APP_NAME,
    submenu: [
      { label: 'New project…', accelerator: 'CmdOrCtrl+N', click: () => send('new-project') },
      { label: 'Open project…', accelerator: 'CmdOrCtrl+O', click: () => send('open-project') },
      { type: 'separator' },
      { label: 'Import media…', accelerator: 'CmdOrCtrl+I', click: () => send('import-media') },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('open-settings') },
      { type: 'separator' },
      { label: 'Check for updates…', click: () => send('check-updates') },
      { type: 'separator' },
      { role: 'quit', label: 'Exit' }
    ]
  }
  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
      { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => send('redo') },
      { type: 'separator' },
      { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: () => send('cut') },
      { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => send('copy') },
      { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => send('paste') },
      { label: 'Duplicate', accelerator: 'CmdOrCtrl+D', click: () => send('duplicate') },
      { label: 'Delete', role: 'delete', click: () => send('delete') },
      { type: 'separator' },
      { label: 'Split at playhead', accelerator: 'CmdOrCtrl+K', click: () => send('split') },
      { label: 'Ripple delete', accelerator: 'Shift+Delete', click: () => send('ripple-delete') },
      { type: 'separator' },
      { label: 'Group clips', accelerator: 'CmdOrCtrl+G', click: () => send('group') },
      { label: 'Ungroup clips', accelerator: 'CmdOrCtrl+Shift+G', click: () => send('ungroup') }
    ]
  }
  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  }
  const timelineMenu: MenuItemConstructorOptions = {
    label: 'Timeline',
    submenu: [
      { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: () => send('zoom-in') },
      { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => send('zoom-out') },
      { label: 'Fit project in view', accelerator: 'Shift+Z', click: () => send('fit-timeline') },
      { type: 'separator' },
      { label: 'Add marker', accelerator: 'M', click: () => send('add-marker') },
      { label: 'Toggle snapping', accelerator: 'S', click: () => send('toggle-snap') }
    ]
  }
  const aiMenu: MenuItemConstructorOptions = {
    label: 'AI',
    submenu: [
      { label: 'Transcribe project', accelerator: 'CmdOrCtrl+T', click: () => send('transcribe') },
      { label: 'Find viral moments', accelerator: 'CmdOrCtrl+M', click: () => send('detect-moments') },
      { type: 'separator' },
      { label: 'AI providers…', click: () => send('open-ai-settings') },
      { label: 'Local models…', click: () => send('open-model-settings') }
    ]
  }
  const helpMenu: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      { label: 'Documentation', click: () => void shell.openExternal(`https://github.com/${REPO_OWNER}/${REPO_NAME}#readme`) },
      { label: 'Open log folder', click: () => void shell.openPath(workspaceLayout().logs) },
      { label: 'Open project folder', click: () => void shell.openPath(workspaceLayout().projects) },
      { type: 'separator' },
      { label: `Version ${app.getVersion()}`, enabled: false }
    ]
  }
  return [appMenu, editMenu, viewMenu, timelineMenu, aiMenu, helpMenu]
}

export function installMenu(getWindow: () => BrowserWindow | null): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(getWindow)))
}
