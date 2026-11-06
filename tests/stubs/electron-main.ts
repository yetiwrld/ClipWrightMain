/**
 * Stand-in for the `electron` module when main-process code is executed under
 * plain Node (packaging smoke renders, scripts). Only the pieces that are safe
 * outside a running Electron app are provided; anything that would need the real
 * runtime is absent on purpose, so the smoke test cannot accidentally depend on
 * Electron behaviour that is not there.
 *
 * The real path-to-ffmpeg is passed in by the caller via CLIPWRIGHT_FFMPEG.
 */
export const app = {
  isPackaged: false,
  getAppPath: () => process.env.CLIPWRIGHT_RESOURCES ?? process.cwd(),
  getPath: (name: string) => process.env.CLIPWRIGHT_APP_DATA ?? `/tmp/clipwright-smoke-${name}`,
  getVersion: () => '0.0.0-smoke',
  quit: () => undefined,
  on: () => undefined,
  whenReady: () => Promise.resolve(),
  requestSingleInstanceLock: () => true
}

export const BrowserWindow = class {
  static getAllWindows(): unknown[] {
    return []
  }
}

export const ipcMain = { handle: () => undefined, on: () => undefined }
export const dialog = {}
export const shell = { openPath: async () => '', showItemInFolder: () => undefined, openExternal: async () => undefined }
export const nativeTheme = { shouldUseDarkColors: true, on: () => undefined }
export const protocol = { registerSchemesAsPrivileged: () => undefined, handle: () => undefined }
export const net = { fetch: async () => new Response('', { status: 501 }) }
export const Menu = { buildFromTemplate: () => ({}), setApplicationMenu: () => undefined }
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString()
}

export default { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, protocol, net, Menu, safeStorage }

export const screen = {
  getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1040 } })
}
