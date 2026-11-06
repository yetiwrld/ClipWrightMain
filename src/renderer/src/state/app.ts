/** App-level state: settings, capabilities, providers, presets, workspace. */
import { create } from 'zustand'
import type {
  CapabilityReport,
  CaptionPreset,
  LocalModel,
  ProviderConfig,
  RuntimeStatus,
  Settings,
  WorkspaceInfo
} from '@shared/types'
import type { AppInfo } from '../../../shared/ipc'
import { api, errorMessage } from '../lib/api'

interface AppState {
  ready: boolean
  info: AppInfo | null
  settings: Settings | null
  capabilities: CapabilityReport | null
  workspace: WorkspaceInfo | null
  providers: ProviderConfig[]
  models: LocalModel[]
  /** Re-probe installed runtimes (whisper.cpp, Ollama, LM Studio) after the user installs one. */
  refreshRuntimes: () => Promise<void>
  runtimes: RuntimeStatus | null
  captionPresets: CaptionPreset[]
  online: boolean
  bootError: string | null

  /** First-run setup finished (persisted locally; the setup screens never nag twice). */
  firstRunDone: boolean
  completeFirstRun: () => void

  boot: () => Promise<void>
  refreshAll: () => Promise<void>
  refreshWorkspace: () => Promise<void>
  refreshCaptionPresets: () => Promise<void>
  refreshSettings: () => Promise<void>
  saveSettings: (patch: Partial<Settings>) => Promise<void>
  refreshProviders: () => Promise<void>
  refreshModels: () => Promise<void>
  refreshCapabilities: (force?: boolean) => Promise<void>
  refreshPresets: () => Promise<void>
  setOnline: (online: boolean) => void
}

const FIRST_RUN_KEY = 'clipwright.firstRunDone'

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  info: null,
  settings: null,
  capabilities: null,
  workspace: null,
  providers: [],
  models: [],
  runtimes: null,
  captionPresets: [],
  online: true,
  bootError: null,
  firstRunDone: localStorage.getItem(FIRST_RUN_KEY) === '1',

  boot: async () => {
    try {
      const [info, settings, workspace] = await Promise.all([
        api.app.info(),
        api.settings.get(),
        api.workspace.info()
      ])
      set({ info, settings, workspace })
      applyTheme(settings)
      const capabilities = await api.app.capabilities().catch(() => null)
      set({ capabilities, online: capabilities?.online ?? true })
      await Promise.all([get().refreshProviders(), get().refreshModels(), get().refreshPresets()])
      set({ ready: true })
    } catch (error) {
      set({ bootError: errorMessage(error), ready: true })
    }
  },

  refreshAll: async () => {
    await get().boot()
    await Promise.all([get().refreshCapabilities(true), get().refreshProviders(), get().refreshModels(), get().refreshPresets()])
  },

  refreshWorkspace: async () => {
    try {
      set({ workspace: await api.workspace.info() })
    } catch {
      set({ workspace: null })
    }
  },

  refreshCaptionPresets: async () => {
    await get().refreshPresets()
  },

  completeFirstRun: () => {
    localStorage.setItem(FIRST_RUN_KEY, '1')
    set({ firstRunDone: true })
  },

  refreshSettings: async () => {
    const settings = await api.settings.get()
    set({ settings })
    applyTheme(settings)
  },

  saveSettings: async (patch) => {
    const settings = await api.settings.update(patch)
    set({ settings })
    applyTheme(settings)
  },

  refreshProviders: async () => {
    try {
      set({ providers: await api.ai.providers() })
    } catch {
      set({ providers: [] })
    }
  },

  refreshModels: async () => {
    try {
      const result = await api.ai.models()
      set({ models: result.models, runtimes: result.runtimes as RuntimeStatus })
    } catch {
      set({ models: [] })
    }
  },

  refreshRuntimes: async () => {
    // `ai.models()` forces a re-detection in the main process, which is what makes
    // "I just installed whisper / started Ollama" show up without a restart.
    try {
      const result = await api.ai.models()
      set({ models: result.models, runtimes: result.runtimes as RuntimeStatus })
      await get().refreshCapabilities(true)
    } catch (error) {
      set({ bootError: errorMessage(error) })
    }
  },

  refreshCapabilities: async (force = false) => {
    const capabilities = await api.app.capabilities(force)
    set({ capabilities, online: capabilities.online })
  },

  refreshPresets: async () => {
    try {
      set({ captionPresets: await api.ai.captionPresets() })
    } catch {
      set({ captionPresets: [] })
    }
  },

  setOnline: (online) => set({ online })
}))

export function applyTheme(settings: Settings): void {
  const root = document.documentElement
  const theme =
    settings.appearance.theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : settings.appearance.theme
  root.dataset.theme = theme
  root.dataset.density = settings.appearance.density
  root.dataset.reduceMotion = settings.appearance.reduceMotion ? 'true' : 'false'
  root.style.setProperty('--brand', settings.appearance.accent)
  root.style.setProperty('--brand-hover', lighten(settings.appearance.accent, 10))
  root.style.setProperty('--brand-pressed', lighten(settings.appearance.accent, -8))
}

function lighten(hex: string, amount: number): string {
  const clean = hex.replace('#', '')
  if (clean.length !== 6) return hex
  const num = parseInt(clean, 16)
  const r = Math.min(255, Math.max(0, ((num >> 16) & 255) + amount))
  const g = Math.min(255, Math.max(0, ((num >> 8) & 255) + amount))
  const b = Math.min(255, Math.max(0, (num & 255) + amount))
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}
