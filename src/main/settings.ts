import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { DEFAULT_SETTINGS, deepMerge } from '@shared/defaults'
import type { Settings } from '@shared/types'
import { configDir, defaultWorkspaceRoot } from './paths'

/**
 * Settings store: a single JSON file in the app-data folder. API keys are NOT
 * stored here (see vault.ts). Writes are atomic and debounced.
 */
export class SettingsStore extends EventEmitter {
  private file: string
  private data: Settings
  private timer: NodeJS.Timeout | null = null

  constructor() {
    super()
    this.file = path.join(configDir(), 'settings.json')
    this.data = this.load()
  }

  private load(): Settings {
    let parsed: Partial<Settings> = {}
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Settings>
    } catch {
      parsed = {}
    }
    const merged = deepMerge(structuredClone(DEFAULT_SETTINGS), parsed)
    if (!merged.storage.workspaceRoot) merged.storage.workspaceRoot = defaultWorkspaceRoot()
    if (!merged.export.outputDir) merged.export.outputDir = path.join(merged.storage.workspaceRoot, 'Exports')
    return merged
  }

  get(): Settings {
    return this.data
  }

  update(patch: Partial<Settings>): Settings {
    this.data = deepMerge(this.data, patch)
    this.scheduleSave()
    this.emit('changed', this.data)
    return this.data
  }

  reset(section?: keyof Settings): Settings {
    if (section) {
      this.data = { ...this.data, [section]: structuredClone(DEFAULT_SETTINGS[section]) }
    } else {
      this.data = structuredClone(DEFAULT_SETTINGS)
      this.data.storage.workspaceRoot = defaultWorkspaceRoot()
      this.data.export.outputDir = path.join(defaultWorkspaceRoot(), 'Exports')
    }
    this.saveNow()
    this.emit('changed', this.data)
    return this.data
  }

  private scheduleSave(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.saveNow(), 250)
  }

  saveNow(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
      fs.renameSync(tmp, this.file)
    } catch (error) {
      console.error('[settings] failed to save', error)
    }
  }
}

let instance: SettingsStore | null = null
export function settingsStore(): SettingsStore {
  if (!instance) instance = new SettingsStore()
  return instance
}
