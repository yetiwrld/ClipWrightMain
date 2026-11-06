/**
 * IPC handlers. Every capability of the app is reachable from here and nothing
 * is a placeholder: each channel maps to real engine code.
 */
import { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '@shared/ipc'
import type { AppInfo } from '@shared/ipc'
import type {
  CaptionPreset,
  ExportRequest,
  ImportResult,
  LocalModel,
  MediaAsset,
  Moment,
  Project,
  ProviderConfig,
  Settings,
  Transcript,
  UpdateInfo
} from '@shared/types'
import { APP_NAME, REPO_NAME, REPO_OWNER } from '@shared/defaults'
import { buildExportPreset, FALLBACK_CAPTION_PRESETS, RESOLUTION_PRESETS } from '@shared/presets'
import { settingsStore } from './settings'
import {
  probeCapabilities,
  workspaceInfo,
  setWorkspaceRoot,
  workspaceLayout,
  invalidateCapabilities,
  fontDir,
  writeJsonAtomic,
  safeJsonRead,
  importsRoot,
  isOnline,
  readLogTail
} from './handlers-support'
import * as projects from './projects'
import { waitForPendingPackage } from './open-package'
import { importLocalFile, generateThumbnail, genWaveform } from './media/importer'
import { inspectRemote, downloadRemote } from './media/remote'
import { providerStore, PROVIDER_TEMPLATES, testProvider, listModels } from './ai/providers'
import {
  downloadModel,
  cancelDownload,
  installedModels,
  deleteModel,
  detectRuntimes,
  MODEL_CATALOGUE
} from './ai/models'
import { transcribe, saveTranscript, loadTranscript, cancelTranscription } from './ai/transcribe'
import { detectMoments, saveMoments, loadMoments, rescoreMoment } from './ai/moments'
import { generateClipProject, suggestAspect } from './ai/clips'
import { ExportQueue } from './export/queue'
import { validateExport } from './export/validation'
import { checkForUpdates, downloadUpdate, installUpdate, openReleasePage, currentVersion } from './updater'
import { captionsToSrt, captionsToVtt, parseSubtitleFile } from '@shared/captions'
import { log } from './logger'
import { probeMedia } from './ffmpeg/probe'
import { ffmpegPath } from './ffmpeg/locate'
import { runProcess } from './ffmpeg/runner'

let queue: ExportQueue | null = null
let getWindow: () => BrowserWindow | null = () => null

function send(channel: string, payload: unknown): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function progress(label: string, percent: number, detail?: string, status: 'running' | 'done' | 'error' = 'running'): void {
  send(IPC.events.progress, { label, percent, detail, status, jobId: label })
}

export function registerHandlers(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
  queue = new ExportQueue({
    loadProject: (id) => projects.loadProject(id),
    fontDir: fontDir(),
    projectFilePath: (id) => projects.projectStoragePath(id)
  })
  queue.on('update', (job) => send(IPC.events.exportUpdate, job))

  /* ---------------------------- app ---------------------------- */
  ipcMain.handle(IPC.app.info, (): AppInfo => ({
    name: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData'),
    isPackaged: app.isPackaged,
    repoUrl: `https://github.com/${REPO_OWNER}/${REPO_NAME}`
  }))
  ipcMain.handle(IPC.app.capabilities, (_e, force?: boolean) => probeCapabilities(force))
  ipcMain.handle(IPC.app.openLogs, async () => {
    await shell.openPath(workspaceLayout().logs)
  })
  ipcMain.handle(IPC.app.readLogs, (_e, lines?: number) => readLogTail(lines ?? 400))
  ipcMain.handle(IPC.app.openPath, async (_e, target: string) => {
    const error = await shell.openPath(target)
    return { ok: !error, error: error || undefined }
  })
  ipcMain.handle(IPC.app.revealPath, (_e, target: string) => {
    shell.showItemInFolder(target)
    return { ok: true }
  })
  ipcMain.handle(IPC.app.setZoom, (_e, factor: number) => {
    const win = getWindow()
    win?.webContents.setZoomFactor(Math.min(1.6, Math.max(0.7, factor)))
  })

  /* -------------------------- settings ------------------------- */
  ipcMain.handle(IPC.settings.get, () => settingsStore().get())
  ipcMain.handle(IPC.settings.update, (_e, patch: Partial<Settings>) => {
    const next = settingsStore().update(patch)
    if (patch.storage?.workspaceRoot) {
      setWorkspaceRoot(patch.storage.workspaceRoot)
      invalidateCapabilities()
    }
    nativeTheme.themeSource =
      next.appearance.theme === 'system' ? 'system' : next.appearance.theme === 'light' ? 'light' : 'dark'
    send(IPC.events.settingsChanged, next)
    return next
  })
  ipcMain.handle(IPC.settings.reset, (_e, section?: keyof Settings) => settingsStore().reset(section))

  /* ------------------------- workspace ------------------------- */
  ipcMain.handle(IPC.workspace.info, () => workspaceInfo())
  ipcMain.handle(IPC.workspace.choose, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a Clipwright Studio workspace folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return setWorkspaceRoot(result.filePaths[0])
  })
  ipcMain.handle(IPC.workspace.set, async (_e, dir: string) => {
    if (!dir) throw new Error('Choose a folder first.')
    return setWorkspaceRoot(dir)
  })
  ipcMain.handle(IPC.workspace.open, async () => {
    await shell.openPath(workspaceLayout().root)
  })

  /* -------------------------- dialogs -------------------------- */
  ipcMain.handle(IPC.dialog.openMedia, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import media',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'All supported media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv', 'mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg', 'png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'] },
        { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv'] },
        { name: 'Audio', extensions: ['mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'] }
      ]
    })
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle(IPC.dialog.openFile, async (_e, options: { title?: string; filters?: { name: string; extensions: string[] }[] }) => {
    const result = await dialog.showOpenDialog({
      title: options?.title ?? 'Open file',
      properties: ['openFile'],
      filters: options?.filters
    })
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle(IPC.dialog.saveFile, async (_e, options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => {
    const result = await dialog.showSaveDialog({
      title: options?.title ?? 'Save file',
      defaultPath: options?.defaultPath,
      filters: options?.filters
    })
    return result.canceled ? null : result.filePath
  })
  ipcMain.handle(IPC.dialog.chooseDirectory, async (_e, title?: string) => {
    const result = await dialog.showOpenDialog({
      title: title ?? 'Choose folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  /* -------------------------- projects ------------------------- */
  ipcMain.handle(IPC.project.list, () => projects.listProjects())
  ipcMain.handle(IPC.project.create, (_e, input: { name: string; aspect: string; fps: number; templateId?: string }) =>
    projects.create(input.name, input.aspect, input.fps, input.templateId)
  )
  ipcMain.handle(IPC.project.load, (_e, id: string) => projects.loadProject(id))
  ipcMain.handle(IPC.project.save, async (_e, project: Project) => projects.saveProject(project))
  ipcMain.handle(IPC.project.duplicate, (_e, id: string, name?: string) => projects.duplicate(id, name))
  ipcMain.handle(IPC.project.rename, (_e, id: string, name: string) => projects.rename(id, name))
  ipcMain.handle(IPC.project.remove, (_e, id: string, deleteMedia: boolean) => projects.remove(id, deleteMedia))
  ipcMain.handle(IPC.project.archive, (_e, id: string) => projects.archive(id))
  ipcMain.handle(IPC.project.exportPackage, async (_e, id: string, includeMedia: boolean) =>
    projects.exportPackage(id, includeMedia)
  )
  ipcMain.handle(IPC.project.pendingOpen, () => waitForPendingPackage())
  ipcMain.handle(IPC.project.importPackagePath, async (_e, filePath: string) => {
    // Used by the .clipwright file association and "Open package…" — validates
    // the path before handing it to the importer.
    if (!fs.existsSync(filePath)) throw new Error('That file could not be found.')
    const project = await projects.importPackage(filePath)
    return project
  })
  ipcMain.handle(IPC.project.importPackage, async (_e, dir?: string) => {
    let target = dir
    if (!target) {
      const result = await dialog.showOpenDialog({ title: 'Import Clipwright project package', properties: ['openDirectory'] })
      if (result.canceled || !result.filePaths[0]) return null
      target = result.filePaths[0]
    }
    return projects.importPackage(target)
  })
  ipcMain.handle(IPC.project.missingAssets, (_e, project: Project) => projects.missingAssets(project))
  ipcMain.handle(IPC.project.relink, async (_e, projectId: string, assetId: string) => {
    const result = await dialog.showOpenDialog({ title: 'Relink missing media', properties: ['openFile'] })
    if (result.canceled || !result.filePaths[0]) return null
    const chosen = result.filePaths[0]
    const probe = await probeMedia(chosen)
    const project = projects.loadProject(projectId)
    const updated: Project = {
      ...project,
      assets: project.assets.map((asset) =>
        asset.id === assetId
          ? { ...asset, path: chosen, probe, missing: false, name: path.basename(chosen) }
          : asset
      )
    }
    await projects.saveProject(updated)
    return updated
  })
  ipcMain.handle(IPC.project.recovery, () => projects.listRecovery())
  ipcMain.handle(IPC.project.restore, (_e, id: string) => projects.restoreRecovery(id))
  ipcMain.handle(IPC.project.storagePath, (_e, id: string) => projects.projectStoragePath(id))

  /* --------------------------- media --------------------------- */
  ipcMain.handle(IPC.media.importFiles, async (_e, input: { paths: string[]; projectId: string; mode?: 'managed' | 'linked' }): Promise<{ assets: MediaAsset[]; errors: { path: string; error: string }[] }> => {
    const mode = input.mode ?? settingsStore().get().storage.defaultImportMode
    const assets: MediaAsset[] = []
    const errors: { path: string; error: string }[] = []
    for (let i = 0; i < input.paths.length; i++) {
      const file = input.paths[i]
      progress('Importing media', Math.round((i / input.paths.length) * 100), path.basename(file))
      try {
        assets.push(await importLocalFile(file, { projectId: input.projectId, mode }))
      } catch (error) {
        errors.push({ path: file, error: error instanceof Error ? error.message : String(error) })
      }
    }
    progress('Importing media', 100, `${assets.length} file(s) imported`, 'done')
    return { assets, errors }
  })
  ipcMain.handle(IPC.media.inspectUrl, async (_e, url: string) => inspectRemote(url))
  ipcMain.handle(IPC.media.importUrl, async (_e, input: { url: string; projectId: string; mode?: 'managed' | 'linked' }) => {
    const mode = input.mode ?? settingsStore().get().storage.defaultImportMode
    return downloadRemote(input.url, { projectId: input.projectId, mode }, (percent, detail) =>
      progress('Downloading video', percent, detail)
    )
  })
  ipcMain.handle(IPC.media.thumbnail, async (_e, asset: MediaAsset) => generateThumbnail(asset))
  ipcMain.handle(IPC.media.waveform, async (_e, asset: MediaAsset) => genWaveform(asset))
  ipcMain.handle(IPC.media.checkAvailability, (_e, assets: MediaAsset[]) =>
    assets.map((a) => ({ id: a.id, exists: fs.existsSync(a.path) }))
  )
  ipcMain.handle(IPC.media.generateProxy, async (_e, asset: MediaAsset, height: number) => {
    if (asset.kind !== 'video') throw new Error('Proxies are only generated for video files.')
    const dir = workspaceLayout().proxies
    fs.mkdirSync(dir, { recursive: true })
    const out = path.join(dir, `${path.basename(asset.path, path.extname(asset.path))}-${height}p.mp4`)
    if (fs.existsSync(out)) return out
    progress('Creating proxy', 5, asset.name)
    const result = await runProcess(ffmpegPath(), [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', asset.path,
      '-vf', `scale=-2:${height}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-c:a', 'aac', '-b:a', '128k',
      out
    ], {
      timeoutMs: 6 * 60 * 60_000,
      onStderr: () => undefined
    })
    if (result.code !== 0) throw new Error('Proxy generation failed.')
    progress('Creating proxy', 100, asset.name, 'done')
    return out
  })

  /* ----------------------------- AI ---------------------------- */
  ipcMain.handle(IPC.ai.providers, () => providerStore().list())
  ipcMain.handle(IPC.ai.providerTemplates, () => PROVIDER_TEMPLATES)
  ipcMain.handle(IPC.ai.addProvider, (_e, input: Omit<ProviderConfig, 'id' | 'createdAt' | 'hasKey'> & { apiKey?: string }) =>
    providerStore().create(input)
  )
  ipcMain.handle(IPC.ai.updateProvider, (_e, id: string, patch: Partial<ProviderConfig> & { apiKey?: string }) =>
    providerStore().update(id, patch)
  )
  ipcMain.handle(IPC.ai.removeProvider, (_e, id: string) => providerStore().remove(id))
  ipcMain.handle(IPC.ai.testProvider, async (_e, id: string) => {
    const provider = providerStore().get(id)
    if (!provider) throw new Error('Provider not found')
    const result = await testProvider(provider, providerStore().apiKey(id))
    providerStore().setLastTest(id, result.ok, result.message, result.latencyMs)
    return result
  })
  ipcMain.handle(IPC.ai.listProviderModels, async (_e, id: string) => {
    const provider = providerStore().get(id)
    if (!provider) throw new Error('Provider not found')
    return listModels(provider, providerStore().apiKey(id))
  })
  ipcMain.handle(IPC.ai.models, async (): Promise<{ models: LocalModel[]; runtimes: Awaited<ReturnType<typeof detectRuntimes>> }> => ({
    models: installedModels(),
    runtimes: await detectRuntimes(true)
  }))
  ipcMain.handle(IPC.ai.downloadModel, async (_e, id: string) => {
    const result = await downloadModel(id, (payload) => send(IPC.events.modelProgress, payload))
    invalidateCapabilities()
    return result
  })
  ipcMain.handle(IPC.ai.cancelModelDownload, (_e, id: string) => cancelDownload(id))
  ipcMain.handle(IPC.ai.deleteModel, (_e, id: string) => deleteModel(id))

  ipcMain.handle(IPC.ai.transcribe, async (_e, input: { projectId: string; assetId: string; mode: 'local' | 'online'; language?: string; model?: string; providerId?: string; speakerLabels?: boolean }) => {
    const project = projects.loadProject(input.projectId)
    const asset = project.assets.find((a) => a.id === input.assetId)
    if (!asset) throw new Error('The media for this project could not be found.')
    const transcript = await transcribe({
      assetPath: asset.path,
      assetId: asset.id,
      projectId: input.projectId,
      mode: input.mode,
      language: input.language,
      model: input.model,
      providerId: input.providerId,
      speakerLabels: input.speakerLabels ?? settingsStore().get().transcription.speakerLabels,
      onProgress: (percent, detail) => progress('Transcribing', percent ?? 0, detail)
    })
    saveTranscript(input.projectId, transcript)
    progress('Transcribing', 100, 'Transcript ready', 'done')
    return transcript
  })
  ipcMain.handle(IPC.ai.cancelTranscribe, () => cancelTranscription())
  ipcMain.handle(IPC.ai.transcript, (_e, projectId: string) => loadTranscript(projectId))
  ipcMain.handle(IPC.ai.saveTranscript, (_e, projectId: string, transcript: Transcript) => saveTranscript(projectId, transcript))

  ipcMain.handle(IPC.ai.detectMoments, async (_e, input: { projectId: string; transcriptId: string; minDurationMs: number; maxDurationMs: number; targetCount: number; mode: 'offline' | 'online' | 'auto'; providerId?: string }) => {
    const transcript = loadTranscript(input.projectId)
    if (!transcript) throw new Error('Generate a transcript first — moment detection reads the spoken words and their timings.')
    const result = await detectMoments({
      projectId: input.projectId,
      transcript,
      minDurationMs: input.minDurationMs,
      maxDurationMs: input.maxDurationMs,
      targetCount: input.targetCount,
      mode: input.mode,
      providerId: input.providerId,
      onProgress: (percent, detail) => progress('Finding moments', percent, detail)
    })
    saveMoments(input.projectId, result.moments)
    progress('Finding moments', 100, `${result.moments.length} moments`, 'done')
    return result
  })
  ipcMain.handle(IPC.ai.moments, (_e, projectId: string) => loadMoments(projectId))
  ipcMain.handle(IPC.ai.saveMoments, (_e, projectId: string, moments: Moment[]) => {
    saveMoments(projectId, moments)
    return true
  })
  ipcMain.handle(IPC.ai.generateClip, async (_e, input: {
    sourceProjectId: string
    moment: Moment
    aspect: string
    fps: number
    captionPresetId: string
    name: string
    autoFrame?: boolean
    includeCaptions?: boolean
  }) => {
    const sourceProject = projects.loadProject(input.sourceProjectId)
    const transcript = loadTranscript(input.sourceProjectId)
    if (!transcript) throw new Error('A transcript is required to generate captions for the clip.')
    const presets = captionPresets()
    const preset = presets.find((p) => p.id === input.captionPresetId) ?? presets[0]
    const project = generateClipProject({
      moment: input.moment,
      sourceProject,
      transcript,
      aspect: input.aspect,
      fps: input.fps,
      captionPreset: preset,
      name: input.name,
      autoFrame: input.autoFrame,
      includeCaptions: input.includeCaptions
    })
    return project
  })
  ipcMain.handle(IPC.ai.captionPresets, () => captionPresets())
  ipcMain.handle(IPC.ai.saveCaptionPreset, (_e, preset: CaptionPreset) => {
    const dir = workspaceLayout().presets
    fs.mkdirSync(dir, { recursive: true })
    writeJsonAtomic(path.join(dir, `${preset.id}.json`), preset)
    return captionPresets()
  })
  ipcMain.handle(IPC.ai.deleteCaptionPreset, (_e, id: string) => {
    const file = path.join(workspaceLayout().presets, `${id}.json`)
    if (fs.existsSync(file)) fs.unlinkSync(file)
    return captionPresets()
  })
  ipcMain.handle(IPC.ai.importCaptionPreset, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import caption style',
      properties: ['openFile'],
      filters: [{ name: 'Clipwright caption style', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const preset = safeJsonRead<CaptionPreset | null>(result.filePaths[0], null)
    if (!preset || !preset.style) throw new Error('That file is not a Clipwright caption style.')
    const imported: CaptionPreset = {
      ...preset,
      id: preset.id?.startsWith('custom') ? preset.id : `custom-${Date.now().toString(36)}`,
      category: 'custom',
      builtIn: false
    }
    const dir = workspaceLayout().presets
    fs.mkdirSync(dir, { recursive: true })
    writeJsonAtomic(path.join(dir, `${imported.id}.json`), imported)
    return captionPresets()
  })
  ipcMain.handle(IPC.ai.exportCaptionPreset, async (_e, preset: CaptionPreset) => {
    const target = await dialog.showSaveDialog({
      title: 'Export caption style',
      defaultPath: `${preset.name.replace(/[^\w -]/g, '')}.captionstyle.json`,
      filters: [{ name: 'Clipwright caption style', extensions: ['json'] }]
    })
    if (target.canceled || !target.filePath) return null
    fs.writeFileSync(target.filePath, JSON.stringify(preset, null, 2))
    return target.filePath
  })
  ipcMain.handle(IPC.ai.exportSubtitles, async (_e, input: { clips: Project['clips']; format: 'srt' | 'vtt'; name: string }) => {
    const target = await dialog.showSaveDialog({
      title: 'Export subtitles',
      defaultPath: `${input.name.replace(/[^\w -]/g, '')}.${input.format}`,
      filters: [{ name: input.format.toUpperCase(), extensions: [input.format] }]
    })
    if (target.canceled || !target.filePath) return null
    const content = input.format === 'srt' ? captionsToSrt(input.clips) : captionsToVtt(input.clips)
    fs.writeFileSync(target.filePath, content, 'utf8')
    return target.filePath
  })
  ipcMain.handle(IPC.ai.importSubtitles, async (_e, trackId: string) => {
    const result = await dialog.showOpenDialog({
      title: 'Import subtitles',
      properties: ['openFile'],
      filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const content = fs.readFileSync(result.filePaths[0], 'utf8')
    return parseSubtitleFile(content, trackId)
  })
  ipcMain.handle(IPC.ai.fonts, () => {
    const dir = fontDir()
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.ttf')) : []
    return files.map((f) => ({ id: path.basename(f, '.ttf'), file: path.join(dir, f) }))
  })
  ipcMain.handle(IPC.ai.importFont, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import a font for captions',
      properties: ['openFile'],
      filters: [{ name: 'Fonts', extensions: ['ttf', 'otf'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const target = path.join(workspaceLayout().fonts, path.basename(result.filePaths[0]))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(result.filePaths[0], target)
    return target
  })

  /* --------------------------- export -------------------------- */
  ipcMain.handle(IPC.export.presets, () => RESOLUTION_PRESETS)
  ipcMain.handle(IPC.export.enqueue, (_e, request: ExportRequest) => queue!.enqueue(request))
  ipcMain.handle(IPC.export.list, () => queue!.list())
  ipcMain.handle(IPC.export.cancel, (_e, id: string) => queue!.cancel(id))
  ipcMain.handle(IPC.export.retry, (_e, id: string) => queue!.retry(id))
  ipcMain.handle(IPC.export.remove, (_e, id: string) => queue!.remove(id))
  ipcMain.handle(IPC.export.clear, () => queue!.clearFinished())
  ipcMain.handle(IPC.export.validate, async (_e, file: string, width: number, height: number, fps: number, durationMs: number) =>
    validateExport(file, buildExportPreset('1080p', '16:9', fps), {
      expected: { width, height, fps, durationMs, aspect: '16:9' }
    })
  )
  ipcMain.handle(IPC.export.openFolder, async (_e, filePath?: string) => {
    if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath)
    else await shell.openPath(workspaceLayout().exports)
  })
  ipcMain.handle(IPC.export.estimate, (_e, project: Project, fps: number) => {
    const duration = project.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0) / 1000
    const frames = duration * fps
    // Rough throughput measured from the renderer tests, conservative on CPU.
    const perFrameMs = 12
    return { durationMs: duration * 1000, frames: Math.round(frames), estimateMs: Math.round(frames * perFrameMs) }
  })

  /* --------------------------- updates ------------------------- */
  ipcMain.handle(IPC.updates.check, () => checkForUpdates(true))
  ipcMain.handle(IPC.updates.download, async (_e, info: UpdateInfo) =>
    downloadUpdate(info, (payload) => send(IPC.events.updateProgress, payload))
  )
  ipcMain.handle(IPC.updates.install, (_e, installerPath: string) => installUpdate(installerPath))
  ipcMain.handle(IPC.updates.openRelease, (_e, url: string) => openReleasePage(url))
  ipcMain.handle(IPC.updates.cancel, async () => {
    const { cancelUpdateDownload } = await import('./updater')
    cancelUpdateDownload()
  })
  ipcMain.handle(IPC.updates.version, () => currentVersion())

  log.info('ipc', 'handlers registered')
}

/** Built-in presets plus user presets from the workspace. */
function captionPresets(): CaptionPreset[] {
  const dir = workspaceLayout().presets
  const custom: CaptionPreset[] = []
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      const preset = safeJsonRead<CaptionPreset | null>(path.join(dir, file), null)
      if (preset && preset.style && preset.id) custom.push({ ...preset, builtIn: false })
    }
  }
  return [...FALLBACK_CAPTION_PRESETS.map((p) => ({ ...p, builtIn: true })), ...custom]
}

export { MODEL_CATALOGUE, isOnline, importsRoot, rescoreMoment, suggestAspect, openReleasePage }
