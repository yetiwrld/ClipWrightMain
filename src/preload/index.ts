/**
 * Preload bridge. The renderer gets a typed, minimal API — no node, no fs, no
 * direct ipcRenderer. Every channel is explicitly allow-listed here.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  CaptionPreset,
  ExportJob,
  ExportRequest,
  LocalModel,
  MediaAsset,
  ModelDownloadProgress,
  Moment,
  Project,
  ProviderConfig,
  Settings,
  Transcript,
  UpdateInfo,
  UpdateProgress,
  WorkspaceInfo,
  CapabilityReport
} from '@shared/types'
import type { AppInfo, MenuCommand } from '@shared/ipc'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export interface ClipwrightApi {
  app: {
    info(): Promise<AppInfo>
    capabilities(force?: boolean): Promise<CapabilityReport>
    openLogs(): Promise<void>
    openPath(target: string): Promise<{ ok: boolean; error?: string }>
    revealPath(target: string): Promise<{ ok: boolean }>
    setZoom(factor: number): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    update(patch: Partial<Settings>): Promise<Settings>
    reset(section?: keyof Settings): Promise<Settings>
  }
  workspace: {
    info(): Promise<WorkspaceInfo>
    choose(): Promise<WorkspaceInfo | null>
    set(dir: string): Promise<WorkspaceInfo>
    open(): Promise<void>
  }
  dialog: {
    openMedia(): Promise<string[]>
    openFile(options?: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string[]>
    saveFile(options?: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>
    chooseDirectory(title?: string): Promise<string | null>
  }
  projects: {
    list(): Promise<unknown[]>
    create(input: { name: string; aspect: string; fps: number; templateId?: string }): Promise<Project>
    load(id: string): Promise<Project>
    save(project: Project): Promise<Project>
    duplicate(id: string, name?: string): Promise<Project>
    rename(id: string, name: string): Promise<Project>
    remove(id: string, deleteMedia: boolean): Promise<void>
    archive(id: string): Promise<string>
    exportPackage(id: string, includeMedia: boolean): Promise<string>
    importPackage(dir?: string): Promise<Project | null>
    missingAssets(project: Project): Promise<{ id: string; name: string; path: string }[]>
    relink(projectId: string, assetId: string): Promise<Project | null>
    recovery(): Promise<unknown[]>
    restore(id: string): Promise<Project>
    storagePath(id: string): Promise<string>
  }
  media: {
    importFiles(input: { paths: string[]; projectId: string; mode?: 'managed' | 'linked' }): Promise<{ assets: MediaAsset[]; errors: { path: string; error: string }[] }>
    inspectUrl(url: string): Promise<{ ok: boolean; title?: string; durationMs?: number; error?: string; strategy: string; note: string; ytdlpAvailable: boolean }>
    importUrl(input: { url: string; projectId: string; mode?: 'managed' | 'linked' }): Promise<MediaAsset>
    thumbnail(asset: MediaAsset): Promise<string | undefined>
    waveform(asset: MediaAsset): Promise<string | undefined>
    checkAvailability(assets: MediaAsset[]): Promise<{ id: string; exists: boolean }[]>
    generateProxy(asset: MediaAsset, height: number): Promise<string>
  }
  ai: {
    providers(): Promise<ProviderConfig[]>
    providerTemplates(): Promise<unknown[]>
    addProvider(input: Omit<ProviderConfig, 'id' | 'createdAt' | 'hasKey'> & { apiKey?: string }): Promise<ProviderConfig>
    updateProvider(id: string, patch: Partial<ProviderConfig> & { apiKey?: string }): Promise<ProviderConfig>
    removeProvider(id: string): Promise<void>
    testProvider(id: string): Promise<{ ok: boolean; message: string; latencyMs?: number }>
    listProviderModels(id: string): Promise<string[]>
    models(): Promise<{ models: LocalModel[]; runtimes: unknown }>
    downloadModel(id: string): Promise<{ ok: boolean; error?: string }>
    cancelModelDownload(id: string): Promise<void>
    deleteModel(id: string): Promise<boolean>
    transcribe(input: { projectId: string; assetId: string; mode: 'local' | 'online'; language?: string; model?: string; providerId?: string; speakerLabels?: boolean }): Promise<Transcript>
    cancelTranscribe(): Promise<void>
    transcript(projectId: string): Promise<Transcript | null>
    saveTranscript(projectId: string, transcript: Transcript): Promise<string>
    detectMoments(input: { projectId: string; transcriptId: string; minDurationMs: number; maxDurationMs: number; targetCount: number; mode: 'offline' | 'online' | 'auto'; providerId?: string }): Promise<{ moments: Moment[]; engine: string; warnings: string[] }>
    moments(projectId: string): Promise<Moment[]>
    saveMoments(projectId: string, moments: Moment[]): Promise<boolean>
    generateClip(input: { sourceProjectId: string; moment: Moment; aspect: string; fps: number; captionPresetId: string; name: string; autoFrame?: boolean; includeCaptions?: boolean }): Promise<Project>
    captionPresets(): Promise<CaptionPreset[]>
    saveCaptionPreset(preset: CaptionPreset): Promise<CaptionPreset[]>
    deleteCaptionPreset(id: string): Promise<CaptionPreset[]>
    importCaptionPreset(): Promise<CaptionPreset[] | null>
    exportCaptionPreset(preset: CaptionPreset): Promise<string | null>
    exportSubtitles(input: { clips: Project['clips']; format: 'srt' | 'vtt'; name: string }): Promise<string | null>
    importSubtitles(trackId: string): Promise<Project['clips'] | null>
    fonts(): Promise<{ id: string; file: string }[]>
    importFont(): Promise<string | null>
  }
  exports: {
    presets(): Promise<unknown[]>
    enqueue(request: ExportRequest): Promise<ExportJob>
    list(): Promise<ExportJob[]>
    cancel(id: string): Promise<void>
    retry(id: string): Promise<ExportJob | null>
    remove(id: string): Promise<void>
    clear(): Promise<void>
    validate(file: string, width: number, height: number, fps: number, durationMs: number): Promise<unknown>
    openFolder(filePath?: string): Promise<void>
    estimate(project: Project, fps: number): Promise<{ durationMs: number; frames: number; estimateMs: number }>
  }
  updates: {
    check(): Promise<UpdateInfo>
    download(info: UpdateInfo): Promise<{ ok: boolean; installerPath?: string; error?: string; needsManualInstall?: boolean }>
    install(installerPath: string): Promise<{ launched: boolean; error?: string }>
    openRelease(url: string): Promise<void>
    cancel(): Promise<void>
    version(): Promise<string>
  }
  events: {
    onProgress(handler: (payload: { label: string; percent: number; detail?: string; status: string }) => void): () => void
    onExportUpdate(handler: (job: ExportJob) => void): () => void
    onUpdateProgress(handler: (payload: UpdateProgress & { info?: UpdateInfo }) => void): () => void
    onSettingsChanged(handler: (settings: Settings) => void): () => void
    onMenu(handler: (command: MenuCommand) => void): () => void
    onModelProgress(handler: (payload: ModelDownloadProgress) => void): () => void
  }
  /** Media files are served through a privileged protocol, not file:// */
  mediaUrl(filePath: string): string
}

const api: ClipwrightApi = {
  app: {
    info: () => invoke<AppInfo>(IPC.app.info),
    capabilities: (force) => invoke<CapabilityReport>(IPC.app.capabilities, force),
    openLogs: () => invoke(IPC.app.openLogs),
    openPath: (target) => invoke(IPC.app.openPath, target),
    revealPath: (target) => invoke(IPC.app.revealPath, target),
    setZoom: (factor) => invoke(IPC.app.setZoom, factor)
  },
  settings: {
    get: () => invoke<Settings>(IPC.settings.get),
    update: (patch) => invoke<Settings>(IPC.settings.update, patch),
    reset: (section) => invoke<Settings>(IPC.settings.reset, section)
  },
  workspace: {
    info: () => invoke<WorkspaceInfo>(IPC.workspace.info),
    choose: () => invoke<WorkspaceInfo | null>(IPC.workspace.choose),
    set: (dir) => invoke<WorkspaceInfo>(IPC.workspace.set, dir),
    open: () => invoke(IPC.workspace.open)
  },
  dialog: {
    openMedia: () => invoke<string[]>(IPC.dialog.openMedia),
    openFile: (options) => invoke<string[]>(IPC.dialog.openFile, options),
    saveFile: (options) => invoke<string | null>(IPC.dialog.saveFile, options),
    chooseDirectory: (title) => invoke<string | null>(IPC.dialog.chooseDirectory, title)
  },
  projects: {
    list: () => invoke(IPC.project.list),
    create: (input) => invoke<Project>(IPC.project.create, input),
    load: (id) => invoke<Project>(IPC.project.load, id),
    save: (project) => invoke<Project>(IPC.project.save, project),
    duplicate: (id, name) => invoke<Project>(IPC.project.duplicate, id, name),
    rename: (id, name) => invoke<Project>(IPC.project.rename, id, name),
    remove: (id, deleteMedia) => invoke(IPC.project.remove, id, deleteMedia),
    archive: (id) => invoke<string>(IPC.project.archive, id),
    exportPackage: (id, includeMedia) => invoke<string>(IPC.project.exportPackage, id, includeMedia),
    importPackage: (dir) => invoke<Project | null>(IPC.project.importPackage, dir),
    missingAssets: (project) => invoke(IPC.project.missingAssets, project),
    relink: (projectId, assetId) => invoke<Project | null>(IPC.project.relink, projectId, assetId),
    recovery: () => invoke(IPC.project.recovery),
    restore: (id) => invoke<Project>(IPC.project.restore, id),
    storagePath: (id) => invoke<string>(IPC.project.storagePath, id)
  },
  media: {
    importFiles: (input) => invoke(IPC.media.importFiles, input),
    inspectUrl: (url) => invoke(IPC.media.inspectUrl, url),
    importUrl: (input) => invoke<MediaAsset>(IPC.media.importUrl, input),
    thumbnail: (asset) => invoke(IPC.media.thumbnail, asset),
    waveform: (asset) => invoke(IPC.media.waveform, asset),
    checkAvailability: (assets) => invoke(IPC.media.checkAvailability, assets),
    generateProxy: (asset, height) => invoke<string>(IPC.media.generateProxy, asset, height)
  },
  ai: {
    providers: () => invoke<ProviderConfig[]>(IPC.ai.providers),
    providerTemplates: () => invoke(IPC.ai.providerTemplates),
    addProvider: (input) => invoke<ProviderConfig>(IPC.ai.addProvider, input),
    updateProvider: (id, patch) => invoke<ProviderConfig>(IPC.ai.updateProvider, id, patch),
    removeProvider: (id) => invoke(IPC.ai.removeProvider, id),
    testProvider: (id) => invoke(IPC.ai.testProvider, id),
    listProviderModels: (id) => invoke<string[]>(IPC.ai.listProviderModels, id),
    models: () => invoke(IPC.ai.models),
    downloadModel: (id) => invoke(IPC.ai.downloadModel, id),
    cancelModelDownload: (id) => invoke(IPC.ai.cancelModelDownload, id),
    deleteModel: (id) => invoke<boolean>(IPC.ai.deleteModel, id),
    transcribe: (input) => invoke<Transcript>(IPC.ai.transcribe, input),
    cancelTranscribe: () => invoke(IPC.ai.cancelTranscribe),
    transcript: (projectId) => invoke<Transcript | null>(IPC.ai.transcript, projectId),
    saveTranscript: (projectId, transcript) => invoke<string>(IPC.ai.saveTranscript, projectId, transcript),
    detectMoments: (input) => invoke(IPC.ai.detectMoments, input),
    moments: (projectId) => invoke<Moment[]>(IPC.ai.moments, projectId),
    saveMoments: (projectId, moments) => invoke<boolean>(IPC.ai.saveMoments, projectId, moments),
    generateClip: (input) => invoke<Project>(IPC.ai.generateClip, input),
    captionPresets: () => invoke<CaptionPreset[]>(IPC.ai.captionPresets),
    saveCaptionPreset: (preset) => invoke<CaptionPreset[]>(IPC.ai.saveCaptionPreset, preset),
    deleteCaptionPreset: (id) => invoke<CaptionPreset[]>(IPC.ai.deleteCaptionPreset, id),
    importCaptionPreset: () => invoke<CaptionPreset[] | null>(IPC.ai.importCaptionPreset),
    exportCaptionPreset: (preset) => invoke<string | null>(IPC.ai.exportCaptionPreset, preset),
    exportSubtitles: (input) => invoke<string | null>(IPC.ai.exportSubtitles, input),
    importSubtitles: (trackId) => invoke(IPC.ai.importSubtitles, trackId),
    fonts: () => invoke(IPC.ai.fonts),
    importFont: () => invoke<string | null>(IPC.ai.importFont)
  },
  exports: {
    presets: () => invoke(IPC.export.presets),
    enqueue: (request) => invoke<ExportJob>(IPC.export.enqueue, request),
    list: () => invoke<ExportJob[]>(IPC.export.list),
    cancel: (id) => invoke(IPC.export.cancel, id),
    retry: (id) => invoke<ExportJob | null>(IPC.export.retry, id),
    remove: (id) => invoke(IPC.export.remove, id),
    clear: () => invoke(IPC.export.clear),
    validate: (file, width, height, fps, durationMs) => invoke(IPC.export.validate, file, width, height, fps, durationMs),
    openFolder: (filePath) => invoke(IPC.export.openFolder, filePath),
    estimate: (project, fps) => invoke(IPC.export.estimate, project, fps)
  },
  updates: {
    check: () => invoke<UpdateInfo>(IPC.updates.check),
    download: (info) => invoke(IPC.updates.download, info),
    install: (installerPath) => invoke(IPC.updates.install, installerPath),
    openRelease: (url) => invoke(IPC.updates.openRelease, url),
    cancel: () => invoke(IPC.updates.cancel),
    version: () => invoke<string>(IPC.updates.version)
  },
  events: {
    onProgress: (handler) => subscribe(IPC.events.progress, handler),
    onExportUpdate: (handler) => subscribe(IPC.events.exportUpdate, handler),
    onUpdateProgress: (handler) => subscribe(IPC.events.updateProgress, handler),
    onSettingsChanged: (handler) => subscribe(IPC.events.settingsChanged, handler),
    onMenu: (handler) => subscribe(IPC.events.menu, handler),
    onModelProgress: (handler) => subscribe(IPC.events.modelProgress, handler)
  },
  mediaUrl: (filePath: string) => {
    // Encode so spaces, #, ?, unicode and Windows drive letters survive.
    const normalised = filePath.replace(/\\/g, '/')
    return `clipwright-media://local/${normalised.split('/').map(encodeURIComponent).join('/')}`
  }
}

contextBridge.exposeInMainWorld('clipwright', api)
