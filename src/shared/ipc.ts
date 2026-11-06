/** Channel names shared by main, preload and renderer. Compile-time checked. */
export const IPC = {
  app: {
    info: 'app:info',
    capabilities: 'app:capabilities',
    openLogs: 'app:open-logs',
    readLogs: 'app:read-logs',
    openPath: 'app:open-path',
    revealPath: 'app:reveal-path',
    quit: 'app:quit',
    setZoom: 'app:set-zoom'
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
    reset: 'settings:reset'
  },
  workspace: {
    info: 'workspace:info',
    choose: 'workspace:choose',
    set: 'workspace:set',
    open: 'workspace:open'
  },
  dialog: {
    openMedia: 'dialog:open-media',
    openFile: 'dialog:open-file',
    saveFile: 'dialog:save-file',
    chooseDirectory: 'dialog:choose-directory'
  },
  project: {
    list: 'project:list',
    create: 'project:create',
    load: 'project:load',
    save: 'project:save',
    duplicate: 'project:duplicate',
    rename: 'project:rename',
    remove: 'project:remove',
    archive: 'project:archive',
    exportPackage: 'project:export-package',
    importPackage: 'project:import-package',
    importPackagePath: 'project:import-package-path',
    pendingOpen: 'project:pending-open',
    missingAssets: 'project:missing-assets',
    relink: 'project:relink',
    recovery: 'project:recovery',
    restore: 'project:restore',
    storagePath: 'project:storage-path'
  },
  media: {
    importFiles: 'media:import-files',
    inspectUrl: 'media:inspect-url',
    importUrl: 'media:import-url',
    thumbnail: 'media:thumbnail',
    waveform: 'media:waveform',
    generateProxy: 'media:proxy',
    checkAvailability: 'media:check-availability',
    installYtdlp: 'media:install-ytdlp'
  },
  ai: {
    providers: 'ai:providers',
    providerTemplates: 'ai:provider-templates',
    addProvider: 'ai:add-provider',
    updateProvider: 'ai:update-provider',
    removeProvider: 'ai:remove-provider',
    testProvider: 'ai:test-provider',
    listProviderModels: 'ai:list-models',
    models: 'ai:models',
    downloadModel: 'ai:download-model',
    cancelModelDownload: 'ai:cancel-model-download',
    deleteModel: 'ai:delete-model',
    transcribe: 'ai:transcribe',
    cancelTranscribe: 'ai:cancel-transcribe',
    transcript: 'ai:transcript',
    saveTranscript: 'ai:save-transcript',
    detectMoments: 'ai:detect-moments',
    moments: 'ai:moments',
    saveMoments: 'ai:save-moments',
    generateClip: 'ai:generate-clip',
    captionPresets: 'ai:caption-presets',
    saveCaptionPreset: 'ai:save-caption-preset',
    deleteCaptionPreset: 'ai:delete-caption-preset',
    importCaptionPreset: 'ai:import-caption-preset',
    exportCaptionPreset: 'ai:export-caption-preset',
    exportSubtitles: 'ai:export-subtitles',
    importSubtitles: 'ai:import-subtitles',
    fonts: 'ai:fonts',
    importFont: 'ai:import-font'
  },
  export: {
    presets: 'export:presets',
    enqueue: 'export:enqueue',
    list: 'export:list',
    cancel: 'export:cancel',
    retry: 'export:retry',
    remove: 'export:remove',
    clear: 'export:clear',
    validate: 'export:validate',
    openFolder: 'export:open-folder',
    estimate: 'export:estimate'
  },
  updates: {
    check: 'updates:check',
    download: 'updates:download',
    install: 'updates:install',
    openRelease: 'updates:open-release',
    cancel: 'updates:cancel',
    version: 'updates:version'
  },
  events: {
    progress: 'event:progress',
    exportUpdate: 'event:export-update',
    updateProgress: 'event:update-progress',
    settingsChanged: 'event:settings-changed',
    menu: 'event:menu',
    openPackage: 'event:open-package',
    modelProgress: 'event:model-progress',
    ytdlpProgress: 'event:ytdlp-progress'
  }
} as const

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  userData: string
  isPackaged: boolean
  repoUrl: string
}

export interface MenuCommand {
  command: string
  payload?: unknown
}

export type { ImportRequest, ImportResult, JobProgress, WorkspaceInfo, CapabilityReport } from './types'
