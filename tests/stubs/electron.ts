/** Minimal electron stub so pure main-process modules can be unit tested. */
import os from 'node:os'
import path from 'node:path'
export const app = {
  isPackaged: false,
  getAppPath: () => process.cwd(),
  getPath: (name: string) => path.join(os.tmpdir(), 'clipwright-test', name)
}
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (v: string) => Buffer.from(v),
  decryptString: (b: Buffer) => b.toString()
}
export default { app, safeStorage }

export const screen = {
  getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1040 } })
}
