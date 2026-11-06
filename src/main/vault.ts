import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { configDir } from './paths'

/**
 * Credential vault.
 *
 * API keys are encrypted with the OS keychain (DPAPI on Windows, Keychain on
 * macOS, libsecret on Linux) through Electron's safeStorage. The encrypted blob
 * is stored in a separate file from settings so it can be excluded from project
 * packages and logs. Keys are never written to plaintext, never sent to the
 * renderer (only a boolean `hasKey`), and never logged.
 */
interface VaultFile {
  version: number
  entries: Record<string, { cipher: string; updatedAt: number }>
}

export class Vault {
  private file: string
  private cache: VaultFile
  private available: boolean

  constructor() {
    this.file = path.join(configDir(), 'credentials.vault')
    this.available = safeStorage.isEncryptionAvailable()
    this.cache = this.load()
  }

  private load(): VaultFile {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as VaultFile
      if (parsed && parsed.entries) return parsed
    } catch {
      /* first run or corrupt file — start empty */
    }
    return { version: 1, entries: {} }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
    try {
      fs.chmodSync(this.file, 0o600)
    } catch {
      /* best effort on platforms that ignore modes */
    }
  }

  isAvailable(): boolean {
    return this.available
  }

  set(id: string, value: string): void {
    if (!value) {
      this.delete(id)
      return
    }
    if (!this.available) {
      // Refuse to persist rather than silently writing a plaintext key.
      throw new Error(
        'This system has no OS credential protection available, so API keys cannot be stored securely. Keys are kept in memory for this session only.'
      )
    }
    const cipher = safeStorage.encryptString(value).toString('base64')
    this.cache.entries[id] = { cipher, updatedAt: Date.now() }
    this.persist()
    memoryFallback.set(id, value)
  }

  get(id: string): string | undefined {
    if (memoryFallback.has(id)) return memoryFallback.get(id)
    const entry = this.cache.entries[id]
    if (!entry) return undefined
    try {
      const value = safeStorage.decryptString(Buffer.from(entry.cipher, 'base64'))
      memoryFallback.set(id, value)
      return value
    } catch {
      return undefined
    }
  }

  has(id: string): boolean {
    return Boolean(this.cache.entries[id]) || memoryFallback.has(id)
  }

  delete(id: string): void {
    delete this.cache.entries[id]
    memoryFallback.delete(id)
    this.persist()
  }

  clear(): void {
    this.cache = { version: 1, entries: {} }
    memoryFallback.clear()
    this.persist()
  }

  listIds(): string[] {
    return [...new Set([...Object.keys(this.cache.entries), ...memoryFallback.keys()])]
  }
}

const memoryFallback = new Map<string, string>()
let vaultInstance: Vault | null = null

export function vault(): Vault {
  if (!vaultInstance) vaultInstance = new Vault()
  return vaultInstance
}

/** Provider-scoped key id, e.g. `provider:prov_ab12`. */
export function keyIdFor(providerId: string): string {
  return `provider:${providerId}`
}

export function appDataDir(): string {
  return app.getPath('userData')
}
