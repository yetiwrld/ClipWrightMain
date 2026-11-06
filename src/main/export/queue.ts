/**
 * Export queue.
 *
 * Exports run in the main process (never on the UI thread) with live progress,
 * cancellation, retry, error surfacing and post-export validation.
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { ProjectRenderer } from './renderer'
import { validateExport } from './validation'
import { buildExportPreset } from '@shared/presets'
import { canvasSizeFor } from '@shared/presets'
import { captionsToSrt, captionsToVtt } from '@shared/captions'
import { ffmpegPath } from '../ffmpeg/locate'
import { exportsDir, workspaceLayout } from '../workspace'
import { safeFilename } from '../paths'
import { settingsStore } from '../settings'
import { log } from '../logger'
import type { ExportJob, ExportRequest, Project } from '@shared/types'

export type { ExportJob }

export interface QueueDeps {
  loadProject: (id: string) => Project
  fontDir: string
  projectFilePath: (id: string) => string
}

interface InternalJob extends ExportJob {
  request: ExportRequest
  abort?: AbortController
}

export class ExportQueue extends EventEmitter {
  private jobs: InternalJob[] = []
  private running: InternalJob | null = null
  private maxConcurrent = 1
  private deps: QueueDeps

  constructor(deps: QueueDeps) {
    super()
    this.deps = deps
    this.maxConcurrent = Math.max(1, settingsStore().get().performance.maxConcurrentJobs)
  }

  list(): ExportJob[] {
    return this.jobs.map((job) => this.publicJob(job))
  }

  private publicJob(job: InternalJob): ExportJob {
    const { request, abort, ...rest } = job
    void request
    void abort
    return rest
  }

  enqueue(request: ExportRequest): ExportJob {
    const project = this.deps.loadProject(request.projectId)
    const aspect = request.aspect ?? project.canvas.aspect
    const presetBase = buildExportPreset(
      request.presetId,
      aspect,
      request.fps ?? project.fps
    )
    const preset = {
      ...presetBase,
      ...(request.width && request.height
        ? { width: request.width, height: request.height }
        : {})
    }
    if (request.width && request.height) {
      preset.width = request.width
      preset.height = request.height
    }
    const outputDir = request.outputDir || settingsStore().get().export.outputDir || exportsDir()
    fs.mkdirSync(outputDir, { recursive: true })
    const baseName = safeFilename(
      request.filename?.replace(/\.(mp4|webm|mov)$/i, '') ?? `${project.name} ${preset.label}`,
      'export'
    )
    const ext = preset.container
    let filename = `${baseName}.${ext}`
    let counter = 1
    while (fs.existsSync(path.join(outputDir, filename))) {
      filename = `${baseName} (${counter}).${ext}`
      counter++
    }
    const job: InternalJob = {
      id: `exp_${Math.random().toString(36).slice(2, 10)}`,
      projectId: project.id,
      projectName: request.projectName ?? project.name,
      filename,
      outputPath: path.join(outputDir, filename),
      presetId: request.presetId,
      status: 'queued',
      progress: 0,
      width: preset.width,
      height: preset.height,
      fps: preset.fps,
      request: { ...request, outputDir },
      abort: new AbortController()
    }
    this.jobs.unshift(job)
    this.emit('update', this.publicJob(job))
    this.pump()
    return this.publicJob(job)
  }

  cancel(jobId: string): void {
    const job = this.jobs.find((j) => j.id === jobId)
    if (!job) return
    job.abort?.abort()
    if (job.status !== 'done') {
      job.status = 'cancelled'
      this.emit('update', this.publicJob(job))
    }
  }

  retry(jobId: string): ExportJob | null {
    const job = this.jobs.find((j) => j.id === jobId)
    if (!job || (job.status !== 'failed' && job.status !== 'cancelled')) return null
    const removed = this.jobs.findIndex((j) => j.id === jobId)
    if (removed >= 0) this.jobs.splice(removed, 1)
    return this.enqueue(job.request)
  }

  remove(jobId: string): void {
    const job = this.jobs.find((j) => j.id === jobId)
    if (job?.status === 'rendering' || job?.status === 'encoding' || job?.status === 'preparing') return
    this.jobs = this.jobs.filter((j) => j.id !== jobId)
    this.emit('removed', jobId)
  }

  clearFinished(): void {
    this.jobs = this.jobs.filter((j) => j.status === 'rendering' || j.status === 'encoding' || j.status === 'queued' || j.status === 'preparing' || j.status === 'validating')
    this.emit('cleared')
  }

  private pump(): void {
    if (this.running) return
    const next = this.jobs.filter((j) => j.status === 'queued').sort((a, b) => a.id.localeCompare(b.id))[0]
    if (!next) return
    this.running = next
    void this.run(next).finally(() => {
      this.running = null
      setImmediate(() => this.pump())
    })
  }

  private async run(job: InternalJob): Promise<void> {
    const started = Date.now()
    job.status = 'preparing'
    job.startedAt = started
    job.progress = 1
    this.emit('update', this.publicJob(job))
    try {
      const project = this.deps.loadProject(job.request.projectId)
      // Batch export of specific clips: rebuild a project containing only them.
      const renderProject = job.request.clipIds?.length
        ? subsetProject(project, job.request.clipIds)
        : project
      const range =
        job.request.range ??
        (job.request.clipIds?.length
          ? undefined
          : { start: 0, end: renderProject.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0) })
      const aspect = job.request.aspect ?? project.canvas.aspect
      const size =
        job.request.width && job.request.height
          ? { width: job.request.width, height: job.request.height }
          : canvasSizeFor(aspect, Math.max(job.width, job.height))
      const preset = {
        ...buildExportPreset(job.request.presetId, aspect, job.fps),
        width: size.width,
        height: size.height
      }
      job.width = preset.width
      job.height = preset.height
      job.status = 'rendering'
      this.emit('update', this.publicJob(job))

      const tempDir = path.join(workspaceLayout().temp, job.id)
      const renderer = new ProjectRenderer(
        {
          project: renderProject,
          preset,
          outPath: job.outputPath,
          range: range ? { start: range.start, end: range.end } : undefined,
          tempDir,
          fontDir: this.deps.fontDir,
          hardware: settingsStore().get().export.hardwareEncoder,
          burnCaptions: job.request.burnCaptions ?? settingsStore().get().export.burnCaptions,
          signal: job.abort?.signal,
          onProgress: (progress) => {
            job.progress = Math.round(progress.percent)
            job.status = progress.stage === 'encoding' ? 'encoding' : progress.stage === 'validating' ? 'validating' : 'rendering'
            this.emit('update', this.publicJob(job))
            this.emit('progress', { jobId: job.id, percent: job.progress, detail: progress.detail, stage: progress.stage })
          }
        },
        ffmpegPath(),
        workspaceLayout().logs
      )
      const result = await renderer.render()
      job.logPath = result.logPath
      if (!result.ok) {
        job.status = 'failed'
        job.error = result.error ?? 'Rendering failed.'
        job.finishedAt = Date.now()
        this.emit('update', this.publicJob(job))
        log.error('export', `job ${job.id} failed: ${job.error}`)
        return
      }
      // Subtitle sidecar files.
      if (job.request.sidecarSubtitles) {
        const base = job.outputPath.replace(/\.[^.]+$/, '')
        const captions = project.clips.filter((c) => c.kind === 'caption')
        if (captions.length) {
          const offset = range ? -range.start : 0
          fs.writeFileSync(`${base}.srt`, captionsToSrt(captions, offset))
          fs.writeFileSync(`${base}.vtt`, captionsToVtt(captions, offset))
        }
      }
      job.status = 'validating'
      this.emit('update', this.publicJob(job))
      const validation = await validateExport(job.outputPath, preset, {
        expected: {
          width: preset.width,
          height: preset.height,
          fps: preset.fps,
          durationMs: range ? range.end - range.start : project.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0),
          aspect
        },
        requireAudio: project.assets.some((a) => a.probe.hasAudio)
      })
      job.validation = validation
      if (!validation.ok) {
        job.status = 'failed'
        job.error = validation.problems.join(' ')
      } else {
        job.status = 'done'
        job.progress = 100
      }
      job.finishedAt = Date.now()
      this.emit('update', this.publicJob(job))
      log.info('export', `job ${job.id} ${job.status} → ${job.outputPath}`)
      // Clean up the render temp folder.
      try {
        fs.rmSync(tempDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    } catch (error) {
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
      job.finishedAt = Date.now()
      this.emit('update', this.publicJob(job))
      log.error('export', `job ${job.id} threw: ${job.error}`)
    }
  }
}

function subsetProject(project: Project, clipIds: string[]): Project {
  const clips = project.clips.filter((c) => clipIds.includes(c.id))
  const minStart = clips.length ? Math.min(...clips.map((c) => c.start)) : 0
  return {
    ...project,
    clips: clips.map((c) => ({ ...c, start: c.start - minStart }))
  }
}
