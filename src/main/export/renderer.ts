/**
 * Export renderer — deterministic, frame-accurate rendering of a project.
 *
 * Nothing here captures the UI. The timeline is translated into FFmpeg filter
 * graphs that decode every source, apply transform / crop / effects / keyframe
 * animation / transitions, composite the layers with real alpha, draw captions
 * and titles word by word, mix the audio, and encode the deliverable.
 *
 * Pipeline
 *   1. split the timeline into segments at clip and transition boundaries,
 *   2. render each segment to a lossless ARGB intermediate (qtrle),
 *   3. concat the segments (stream copy),
 *   4. mix all audio into 48 kHz stereo WAV,
 *   5. mux + encode with H.264/AAC (hardware encoder when available).
 */
import fs from 'node:fs'
import path from 'node:path'
import { buildScene, type SceneLayer } from '@shared/scene'
import { effectSpeed, trackIsAudible } from '@shared/timeline-helpers'
import { clampCropPair, sampleTrack } from '@shared/keyframes'
import type { Clip, ExportPreset, Project } from '@shared/types'
import { toFfmpegColour } from '@shared/colour'
import { runProcess } from '../ffmpeg/runner'
import { availableEncoders } from '../ffmpeg/probe'
import { chooseEncoder, codecName, hardwareLabel } from './encoders'
import { freeSpace } from '../paths'
import { buildTextFilters } from './text-layer'
import { computePlacement, effectChain, even, padToCanvas } from './filters'
import { clipAnimation, hasTrack } from './animation'

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i
/*
 * The intermediate must be lossless and must carry alpha (layers composite over
 * a transparent canvas). qtrle ARGB does both but costs ~1.29 MB per 1080p frame
 * (37 MB/s, 4.3 GB for two minutes). ffv1 in yuva420p keeps alpha for half the
 * bytes and encodes roughly twice as fast, so it is used when available and
 * qtrle remains the fallback.
 */
const INTERMEDIATE_QTRLE = ['-c:v', 'qtrle', '-pix_fmt', 'argb']
const INTERMEDIATE_FFV1 = ['-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'yuva420p', '-g', '1']

export interface RenderRequest {
  project: Project
  preset: ExportPreset
  outPath: string
  range?: { start: number; end: number }
  tempDir: string
  fontDir: string
  hardware?: boolean
  burnCaptions?: boolean
  signal?: AbortSignal
  onProgress?: (progress: { stage: string; percent: number; detail?: string }) => void
}

export interface RenderResult {
  ok: boolean
  outPath?: string
  error?: string
  warnings: string[]
  logPath: string
}

interface Part {
  start: number
  end: number
  label: string
}

export function segmentTimeline(project: Project, start: number, end: number): Part[] {
  const points = new Set<number>([start, end])
  for (const clip of project.clips) {
    const inDur = clip.transitionIn ? Math.min(clip.transitionIn.durationMs, clip.duration) : 0
    const outDur = clip.transitionOut ? Math.min(clip.transitionOut.durationMs, clip.duration) : 0
    const from = clip.start - inDur
    const to = clip.start + clip.duration + outDur
    if (to <= start || from >= end) continue
    if (from > start && from < end) points.add(from)
    if (to > start && to < end) points.add(to)
    // Keyframed clips are re-rendered as one segment so motion is continuous.
    const animated = Object.values(clip.keyframes ?? {}).some((list) => (list?.length ?? 0) > 0)
    if (animated) {
      // No extra split needed; motion is expressed in t.
    }
  }
  const sorted = [...points].sort((a, b) => a - b)
  const parts: Part[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = Math.max(start, Math.min(end, sorted[i]))
    const b = Math.max(start, Math.min(end, sorted[i + 1]))
    if (b - a < 1) continue
    parts.push({ start: Math.round(a), end: Math.round(b), label: `seg${parts.length}` })
  }
  return parts.length ? parts : [{ start, end, label: 'seg0' }]
}

export class ProjectRenderer {
  private warnings: string[] = []
  private logLines: string[] = []
  readonly logPath: string
  private ffmpeg: string

  /** Cached result of `ffmpeg -encoders`; the probe runs at most once per render. */
  private encoderCache: string[] | null = null
  /** Lossless intermediate codec arguments, decided once per render. */
  private intermediate: string[] | null = null

  private async intermediateArgs(): Promise<string[]> {
    if (this.intermediate) return this.intermediate
    const encoders = await this.encoders()
    this.intermediate = encoders.includes('ffv1') ? INTERMEDIATE_FFV1 : INTERMEDIATE_QTRLE
    this.log(`intermediate: ${this.intermediate[1]}`)
    return this.intermediate
  }

  private async encoders(): Promise<string[]> {
    if (!this.encoderCache) {
      this.encoderCache = await availableEncoders()
      if (!this.encoderCache.length) this.encoderCache = null
    }
    return this.encoderCache ?? []
  }

  constructor(private opts: RenderRequest, ffmpegBin: string, logDir: string) {
    this.ffmpeg = ffmpegBin
    fs.mkdirSync(logDir, { recursive: true })
    this.logPath = path.join(logDir, `render-${Date.now()}.log`)
  }

  private log(message: string): void {
    this.logLines.push(`${new Date().toISOString()} ${message}`)
  }

  private flushLog(): void {
    try {
      fs.writeFileSync(this.logPath, `${this.logLines.join('\n')}\n`)
    } catch {
      /* ignore */
    }
  }

  async render(): Promise<RenderResult> {
    const { project, preset, range, tempDir, onProgress } = this.opts
    const start = range?.start ?? 0
    const end =
      range?.end ?? project.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0)
    if (end - start < 40) {
      return {
        ok: false,
        error: 'The timeline is empty, so there is nothing to export.',
        warnings: [],
        logPath: this.logPath
      }
    }
    fs.mkdirSync(tempDir, { recursive: true })
    onProgress?.({ stage: 'preparing', percent: 2, detail: 'Planning render' })
    /*
     * Disk-space preflight. The intermediate is lossless ARGB at canvas size
     * (~1.29 MB per 1080p frame, 36.9 MB/s at 30 fps), so a ten-minute export
     * wants ~22 GB before the deliverable is even encoded. Filling the drive
     * mid-render used to surface as a confusing encoder error and left the
     * segments behind; refuse up front with a number the user can act on.
     */
    const estimate = intermediateBytes(preset, end - start)
    const free = freeSpace(tempDir)
    this.log(
      `space: need ~${(estimate / 1_073_741_824).toFixed(2)} GiB, ${(free.free / 1_073_741_824).toFixed(2)} GiB free`
    )
    if (free.free > 0 && free.free < estimate) {
      return {
        ok: false,
        error:
          `Not enough free disk space to render this export. It needs about ` +
          `${(estimate / 1_073_741_824).toFixed(1)} GB for the intermediate frames but only ` +
          `${(free.free / 1_073_741_824).toFixed(1)} GB is free where the workspace lives. ` +
          `Export a shorter range, or free up space and try again.`,
        warnings: this.warnings,
        logPath: this.logPath
      }
    }
    const parts = segmentTimeline(project, start, end)
    this.log(`plan: ${parts.length} segments, ${((end - start) / 1000).toFixed(2)}s`)

    const files: string[] = []
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const file = path.join(tempDir, `${part.label}.mov`)
      const mid = part.start + Math.max(1, (part.end - part.start) / 2)
      const scene = buildScene(project, mid)
      const visual = scene.layers.some((l) => !l.hidden)
      onProgress?.({
        stage: 'rendering',
        percent: 3 + (i / parts.length) * 62,
        detail: `Rendering ${i + 1} / ${parts.length}`
      })
      if (!visual) await this.renderBlank(part, file)
      else await this.renderSegment(project, part, file)
      files.push(file)
    }

    onProgress?.({ stage: 'rendering', percent: 68, detail: 'Joining segments' })
    const videoOnly = path.join(tempDir, 'video.mov')
    const joined = await this.concat(files, videoOnly)
    if (!joined.ok) {
      this.flushLog()
      return { ok: false, error: joined.error, warnings: this.warnings, logPath: this.logPath }
    }

    onProgress?.({ stage: 'encoding', percent: 74, detail: 'Mixing audio' })
    const audio = await this.renderAudio(project, { start, end }, tempDir)

    onProgress?.({ stage: 'encoding', percent: 84, detail: 'Encoding final file' })

    /*
     * Hardware encoding is an optimisation, never a requirement. The preset
     * default asks for it, but a machine without an NVIDIA GPU (or without a
     * driver that exposes NVENC) has no `h264_nvenc`, and ffmpeg then fails the
     * whole export. Probe the encoder list and fall back to libx264 instead —
     * slower, always available, and the export still succeeds.
     */
    /*
     * Encoder choice comes from the probe: NVENC → AMF → QSV → libx264. The old
     * code had a single hardware code path hardcoded to NVENC, so every export on
     * an AMD or Intel machine failed and fell back to the CPU (or failed the
     * fallback too when the probe itself was broken).
     */
    let hardware = Boolean(this.opts.hardware)
    const encoders = await this.encoders()
    let choice = chooseEncoder(preset, encoders, hardware)
    if (choice.warning) this.warnings.push(choice.warning)
    this.log(
      `encoder: ${choice.encoder}${choice.hardware ? ` (hardware, ${hardwareLabel(choice.encoder as never)})` : ''}` +
        ` from ${encoders.length} available`
    )
    if (!choice.hardware) hardware = false

    const attempt = async (useHardware: boolean) => {
      const next = useHardware ? choice : chooseEncoder(preset, encoders, false)
      const args = muxArgs(videoOnly, audio, this.opts.outPath, preset, {
        encoder: next.encoder,
        options: next.options
      })
      this.log(`mux: ffmpeg ${args.join(' ')}`)
      return runProcess(this.ffmpeg, args, {
        timeoutMs: 180 * 60_000,
        signal: this.opts.signal
      })
    }

    let encoded = await attempt(hardware)
    if (encoded.code !== 0 && hardware) {
      // The probe can be wrong (driver present but unusable, GPU busy). Retry
      // once on the CPU rather than failing the user's export.
      hardware = false
      choice = chooseEncoder(preset, encoders, false)
      this.warnings.push('Hardware encoding failed — retried with the CPU encoder.')
      this.log(`hardware encode failed: ${lastLines(encoded.stderr)}; retrying with ${choice.encoder}`)
      onProgress?.({ stage: 'encoding', percent: 86, detail: 'Retrying with the CPU encoder' })
      encoded = await attempt(false)
    }
    this.flushLog()
    if (encoded.code !== 0) {
      return {
        ok: false,
        error: `Encoding failed: ${lastLines(encoded.stderr)}`,
        warnings: this.warnings,
        logPath: this.logPath
      }
    }
    for (const file of [...files, videoOnly, ...(audio ? [audio] : [])]) {
      try {
        fs.unlinkSync(file)
      } catch {
        /* ignore */
      }
    }
    onProgress?.({ stage: 'validating', percent: 97 })
    return { ok: true, outPath: this.opts.outPath, warnings: this.warnings, logPath: this.logPath }
  }

  /* ---------------------------------------------------------------- */

  private async renderBlank(part: Part, out: string): Promise<void> {
    const { preset, project } = this.opts
    const dur = (part.end - part.start) / 1000
    const colour = toFfmpegColour(project.canvas.backgroundColor || '#000000')
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', `color=c=${colour}:s=${even(preset.width)}x${even(preset.height)}:r=${preset.fps}:d=${dur.toFixed(3)}`,
      ...(await this.intermediateArgs()), out
    ]
    const result = await runProcess(this.ffmpeg, args, { timeoutMs: 20 * 60_000, signal: this.opts.signal })
    if (result.code !== 0) throw new Error(`Blank segment failed: ${lastLines(result.stderr)}`)
  }

  private async renderSegment(project: Project, part: Part, out: string): Promise<void> {
    const { preset, fontDir, burnCaptions } = this.opts
    const canvasW = even(preset.width)
    const canvasH = even(preset.height)
    const segDur = Math.max(0.04, (part.end - part.start) / 1000)
    const mid = part.start + Math.max(1, (part.end - part.start) / 2)
    const scene = buildScene(project, mid)

    const args: string[] = ['-y', '-hide_banner', '-loglevel', 'warning', '-nostdin']
    const graph: string[] = []
    const canvasInput = 0
    args.push('-f', 'lavfi', '-t', segDur.toFixed(3), '-i', `color=c=black@0:s=${canvasW}x${canvasH}:r=${preset.fps}`)
    graph.push(`[${canvasInput}:v]format=rgba,settb=AVTB,setpts=PTS-STARTPTS[canvas]`)
    let base = 'canvas'
    let inputIndex = 1
    let layerCount = 0
    const visualLayers = scene.layers.filter(
      (l) => !l.hidden && l.kind !== 'text' && l.kind !== 'caption' && l.kind !== 'graphic'
    )

    for (const layer of visualLayers) {
      const asset = project.assets.find((a) => a.id === layer.assetId)
      if (!asset) {
        this.warnings.push(`A clip references missing media and was skipped: ${layer.name}`)
        continue
      }
      if (!fs.existsSync(asset.path)) {
        this.warnings.push(`Media file not found and was skipped: ${asset.path}`)
        continue
      }
      const clip = project.clips.find((c) => c.id === layer.id)!
      const isImage = asset.kind === 'image' || IMAGE_EXT.test(asset.path)
      const speed = effectSpeed(clip)
      const segStartInClip = part.start - clip.start
      const ssSec = isImage ? 0 : Math.max(0, (clip.sourceIn + Math.max(0, segStartInClip) * speed) / 1000)
      const readDur = isImage ? segDur : segDur * speed + 0.4

      if (isImage) {
        args.push('-loop', '1', '-framerate', String(preset.fps), '-t', segDur.toFixed(3), '-i', asset.path)
      } else {
        if (ssSec > 0.001) args.push('-ss', ssSec.toFixed(3))
        args.push('-t', readDur.toFixed(3), '-i', asset.path)
      }

      const rotated = asset.probe.rotation === 90 || asset.probe.rotation === 270
      const sourceW = rotated ? asset.probe.height ?? canvasW : asset.probe.width ?? canvasW
      const sourceH = rotated ? asset.probe.width ?? canvasH : asset.probe.height ?? canvasH
      this.log(`layer ${layer.name}: src=${sourceW}x${sourceH} transform=${JSON.stringify(layer.transform)}`)
      const placement = computePlacement(
        sourceW,
        sourceH,
        layer.transform,
        { width: canvasW, height: canvasH },
        'contain'
      )
      const chain: string[] = ['format=rgba']
      if (!isImage) {
        if (rotated) chain.push('transpose=1')
        if (Math.abs(speed - 1) > 0.001) {
          chain.push(`setpts=${(1 / speed).toFixed(4)}*PTS`)
          chain.push(`fps=${preset.fps}`)
        }
        chain.push(`fps=${preset.fps}`, 'setsar=1', 'settb=AVTB')
      }
      chain.push(
        `scale=${even(placement.contentWidth)}:${even(placement.contentHeight)}:flags=${isImage ? 'lanczos' : 'bicubic'}`
      )
      chain.push(...effectChain(layer.effects))
      // Opposing edges are clamped as a pair: clamping each edge to 0.95 on its
      // own allowed 190% of the frame to be cropped, which produced a negative
      // width that Math.max(2, …) turned into a silent 2 px crop.
      const [cropL, cropR] = clampCropPair(layer.transform.cropL, layer.transform.cropR)
      const [cropT, cropB] = clampCropPair(layer.transform.cropT, layer.transform.cropB)
      chain.push(
        `crop=${even(placement.contentWidth * (1 - cropL - cropR))}:${even(
          placement.contentHeight * (1 - cropT - cropB)
        )}:${Math.round(placement.contentWidth * cropL)}:${Math.round(placement.contentHeight * cropT)}`
      )

      // --- animated transform expressions ---
      const anim = clipAnimation(clip, part, { width: canvasW, height: canvasH }, placement)
      const rotationDeg = anim.rotationDeg
      const rotateFilter = rotationDeg
        ? `rotate=a='(${rotationDeg})*PI/180':c=none:ow=${canvasW}:oh=${canvasH}`
        : Math.abs(layer.transform.rotation) > 0.01
          ? `rotate=a=${((layer.transform.rotation * Math.PI) / 180).toFixed(5)}:c=none:ow=${canvasW}:oh=${canvasH}`
          : null

      // Compose: card → effects → crop → rotate (canvas size) → overlay at position
      // Cropped content is first padded into a "card" of content size so the
      // rotation pivot and overlay position stay predictable.
      const cardChain: string[] = [...chain]
      const croppedWidth = placement.contentWidth * (1 - cropL - cropR)
      const croppedHeight = placement.contentHeight * (1 - cropT - cropB)
      if (rotateFilter) {
        // Pad to canvas-size transparent canvas centred on the content, then rotate.
        cardChain.push(
          ...padToCanvas(
            canvasW,
            canvasH,
            croppedWidth,
            croppedHeight,
            placement.x + (placement.contentWidth - croppedWidth) / 2,
            placement.y + (placement.contentHeight - croppedHeight) / 2
          )
        )
        cardChain.push(rotateFilter)
      } else {
        /*
         * Auto-framing a landscape source into a portrait clip scales it to
         * *cover*, so the picture is wider than the canvas and sits at a
         * negative x. `pad=canvas:-778:438` cannot express that (pad only grows
         * a frame and offsets must be >= 0) and ffmpeg aborts the whole export.
         * padToCanvas pads into the positive quadrant and crops the canvas
         * window back out, which works either way.
         */
        cardChain.push(...padToCanvas(canvasW, canvasH, croppedWidth, croppedHeight, placement.x, placement.y))
      }
      cardChain.push('format=rgba')

      // Alpha: static opacity + track opacity + keyframes + transitions.
      const track = project.tracks.find((t) => t.id === clip.trackId)
      const staticAlpha = Math.min(1, Math.max(0, layer.transform.opacity * (track?.opacity ?? 1)))
      const keyedOpacity = anim.opacity
      const transitions = transitionSteps(project, clip, part, segDur)
      if (Math.abs(staticAlpha - 1) > 0.001 || keyedOpacity) {
        const alphaExpr = keyedOpacity
          ? `(${keyedOpacity})*${(track?.opacity ?? 1).toFixed(3)}`
          : staticAlpha.toFixed(3)
        // geq multiplies the existing alpha channel by a time-varying factor.
        cardChain.push(
          `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${alphaExpr}'`
        )
      }
      for (const step of transitions) cardChain.push(step)

      const label = `L${layerCount}`
      graph.push(`[${inputIndex}:v]${cardChain.join(',')}[${label}]`)
      // Overlay position: 0,0 because each card is already canvas sized, except
      // for animated x/y which move the card within the canvas.
      const overlayX = anim.x ? `'${anim.x}'` : '0'
      const overlayY = anim.y ? `'${anim.y}'` : '0'
      const next = `b${layerCount}`
      graph.push(
        `[${base}][${label}]overlay=x=${overlayX}:y=${overlayY}:eval=frame:format=auto:repeatlast=1:shortest=0[${next}]`
      )
      base = next
      layerCount++
      inputIndex++
    }

    // --- text and captions ---
    const textFilters: string[] = []
    if (burnCaptions) {
      const seen = new Set<string>()
      const addLayer = (layer: SceneLayer, startSec: number, durSec: number) => {
        if (seen.has(layer.id) && startSec === 0) return
        seen.add(layer.id)
        textFilters.push(
          ...buildTextFilters(layer, {
            canvas: { width: canvasW, height: canvasH },
            startSec,
            durationSec: durSec,
            fontDir,
            fps: preset.fps
          })
        )
      }
      for (const layer of scene.layers) {
        if (!layer.hidden && (layer.kind === 'text' || layer.kind === 'caption')) {
          const clip = project.clips.find((c) => c.id === layer.id)
          if (!clip) continue
          const from = Math.max(0, (clip.start - part.start) / 1000)
          const to = Math.min(segDur, (clip.start + clip.duration - part.start) / 1000)
          if (to - from < 0.01) continue
          textFilters.push(
            ...buildTextFilters(layer, {
              canvas: { width: canvasW, height: canvasH },
              startSec: from,
              durationSec: to - from,
              fontDir,
              fps: preset.fps
            })
          )
        }
      }
      // Text clips that begin inside this segment are not in the mid-scene: add them.
      for (const clip of project.clips) {
        if (clip.kind !== 'text' && clip.kind !== 'caption') continue
        if (scene.layers.some((l) => l.id === clip.id)) continue
        if (!(clip.start < part.end && clip.start + clip.duration > part.start)) continue
        const probeTime = Math.max(clip.start + 1, part.start + 1)
        const localScene = buildScene(project, probeTime)
        const layer = localScene.layers.find((l) => l.id === clip.id)
        if (!layer || layer.hidden) continue
        const from = Math.max(0, (clip.start - part.start) / 1000)
        const to = Math.min(segDur, (clip.start + clip.duration - part.start) / 1000)
        if (to - from < 0.01) continue
        textFilters.push(
          ...buildTextFilters(layer, {
            canvas: { width: canvasW, height: canvasH },
            startSec: from,
            durationSec: to - from,
            fontDir,
            fps: preset.fps
          })
        )
      }
      void addLayer
    }

    if (textFilters.length) {
      graph.push(`[${base}]${textFilters.join(',')}[withtext]`)
      base = 'withtext'
    }
    graph.push(`[${base}]format=argb[out]`)
    /*
     * The graph goes to a file. A caption-dense timeline emits hundreds of
     * drawtext filters; passing that as one argv string hits the Windows
     * command-line limit (~32k characters) and the spawn itself fails with
     * "The filename or extension is too long" — the export never even starts.
     * `-/filter_complex <file>` makes ffmpeg read the graph from disk.
     */
    const graphFile = path.join(path.dirname(out), `${part.label}.filter`)
    fs.writeFileSync(graphFile, graph.join(';'))
    const full = [
      ...args,
      '-/filter_complex', graphFile,
      '-map', '[out]',
      '-frames:v', String(Math.max(1, Math.round(segDur * preset.fps))),
      ...(await this.intermediateArgs()),
      out
    ]
    this.log(`segment ${part.label}: ${visualLayers.length} layers, ${textFilters.length} text filters`)
    this.log(`cmd: ffmpeg ${full.join(' ')}`)
    this.log(`graph: ${graphFile} (${graph.join(';').length} chars)`)
    this.flushLog()
    const result = await runProcess(this.ffmpeg, full, {
      timeoutMs: 90 * 60_000,
      signal: this.opts.signal
    })
    if (result.code !== 0) {
      this.log(`segment ${part.label} FAILED: ${result.stderr.slice(-3000)}`)
      throw new Error(`Rendering failed for segment ${part.label}: ${lastLines(result.stderr)}`)
    }
  }

  private async concat(files: string[], out: string): Promise<{ ok: boolean; error?: string }> {
    const listFile = path.join(path.dirname(out), 'segments.txt')
    fs.writeFileSync(
      listFile,
      files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n')
    )
    const result = await runProcess(
      this.ffmpeg,
      ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out],
      { timeoutMs: 30 * 60_000, signal: this.opts.signal }
    )
    if (result.code !== 0) return { ok: false, error: `Joining segments failed: ${lastLines(result.stderr)}` }
    return { ok: true }
  }

  private async renderAudio(
    project: Project,
    range: { start: number; end: number },
    tempDir: string
  ): Promise<string | null> {
    const wav = path.join(tempDir, 'mix.wav')
    const dur = ((range.end - range.start) / 1000).toFixed(3)
    const missingAudio: string[] = []
    const args = buildAudioRenderArgs(project, range, wav, missingAudio)
    if (missingAudio.length) {
      const unique = [...new Set(missingAudio)]
      this.warnings.push(
        `Audio was skipped for ${unique.length} missing media file${unique.length > 1 ? 's' : ''}: ${unique
          .slice(0, 3)
          .join(', ')}. Relink ${unique.length > 1 ? 'them' : 'it'} and export again.`
      )
    }
    if (!args) {
      const silent = await runProcess(
        this.ffmpeg,
        ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', dur, '-c:a', 'pcm_s16le', wav],
        { timeoutMs: 10 * 60_000, signal: this.opts.signal }
      )
      return silent.code === 0 ? wav : null
    }
    const result = await runProcess(this.ffmpeg, args, {
      timeoutMs: 60 * 60_000,
      signal: this.opts.signal
    })
    if (result.code !== 0) {
      this.warnings.push(`Audio mixing failed: ${lastLines(result.stderr)}`)
      return null
    }
    return wav
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function lastLines(text: string): string {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .slice(-3)
    .join(' | ')
    .slice(0, 600)
}

/** Alpha fade steps for transition-in and transition-out parts. */
function transitionSteps(project: Project, clip: Clip, part: Part, segDur: number): string[] {
  const steps: string[] = []
  const inDur = clip.transitionIn ? Math.min(clip.transitionIn.durationMs, clip.duration) : 0
  const outDur = clip.transitionOut ? Math.min(clip.transitionOut.durationMs, clip.duration) : 0
  if (inDur > 0 && part.start < clip.start) {
    const fadeDur = Math.min(segDur, (clip.start - part.start) / 1000)
    if (fadeDur > 0.005) steps.push(`fade=t=in:st=0:d=${fadeDur.toFixed(3)}:alpha=1`)
  }
  if (outDur > 0 && part.end > clip.start + clip.duration) {
    const fadeStart = Math.max(0, (clip.start + clip.duration - part.start) / 1000)
    const fadeDur = Math.max(0, Math.min(segDur - fadeStart, (part.end - (clip.start + clip.duration)) / 1000))
    if (fadeDur > 0.005) steps.push(`fade=t=out:st=${fadeStart.toFixed(3)}:d=${fadeDur.toFixed(3)}:alpha=1`)
  }
  return steps
}

/** Audio mix graph: every audible clip trimmed, faded, delayed and summed. */
export function buildAudioRenderArgs(
  project: Project,
  range: { start: number; end: number },
  outWav: string,
  /** Filled with the names of assets that are gone, so the caller can warn. */
  missing: string[] = []
): string[] | null {
  const picks: { clip: Clip; path: string }[] = []
  for (const clip of project.clips) {
    if (clip.kind === 'text' || clip.kind === 'caption' || clip.kind === 'graphic') continue
    const track = project.tracks.find((t) => t.id === clip.trackId)
    if (!track || !trackIsAudible(project, track)) continue
    if (clip.audio.muted || clip.audio.volume <= 0) continue
    if (clip.start + clip.duration <= range.start || clip.start >= range.end) continue
    const asset = project.assets.find((a) => a.id === clip.assetId)
    if (!asset) continue
    if (!fs.existsSync(asset.path)) {
      // Silence used to be the only symptom: the export "succeeded" with no
      // audio and no hint which file was gone.
      missing.push(asset.name)
      continue
    }
    if (asset.kind === 'image') continue
    const hasAudio = asset.probe.hasAudio || asset.kind === 'audio'
    if (!hasAudio) continue
    picks.push({ clip, path: asset.path })
  }
  if (!picks.length) return null

  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'warning', '-nostdin']
  const chains: string[] = []
  const labels: string[] = []
  const rangeSec = (range.end - range.start) / 1000
  picks.forEach((pick, index) => {
    const { clip } = pick
    const speed = effectSpeed(clip)
    const overlapStart = Math.max(clip.start, range.start)
    const overlapEnd = Math.min(clip.start + clip.duration, range.end)
    const skip = overlapStart - clip.start
    const ssSec = (clip.sourceIn + skip * speed) / 1000
    const durSec = (overlapEnd - overlapStart) / 1000
    args.push('-ss', ssSec.toFixed(3), '-t', durSec.toFixed(3), '-i', pick.path)
    const chain: string[] = ['asetpts=PTS-STARTPTS', 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo']
    let remaining = speed
    while (remaining > 2) {
      chain.push('atempo=2')
      remaining /= 2
    }
    while (remaining < 0.5) {
      chain.push('atempo=0.5')
      remaining /= 0.5
    }
    if (Math.abs(remaining - 1) > 0.001) chain.push(`atempo=${remaining.toFixed(4)}`)
    /*
     * `volume` is an animatable property and the preview samples its keyframe
     * track, but the export read only the static value — so volume animation
     * played in the preview and vanished from the file. Sample the track at the
     * ends of the overlap and bake a linear `volume` expression (ffmpeg's volume
     * filter evaluates `t` per frame) when the two differ.
     */
    const baseGain = clip.audio.volume * Math.pow(10, clip.audio.gainDb / 20)
    const volumeTrack = clip.keyframes?.volume ?? []
    const localStart = clip.sourceIn / speed + skip
    const localEnd = localStart + (overlapEnd - overlapStart)
    const startLevel = volumeTrack.length ? sampleTrack(volumeTrack, localStart) : null
    const endLevel = volumeTrack.length ? sampleTrack(volumeTrack, localEnd) : null
    if (
      volumeTrack.length > 1 &&
      startLevel !== null &&
      endLevel !== null &&
      Math.abs(startLevel - endLevel) > 0.005
    ) {
      const from = startLevel * Math.pow(10, clip.audio.gainDb / 20)
      const to = endLevel * Math.pow(10, clip.audio.gainDb / 20)
      const duration = Math.max(0.001, durSec)
      const slope = (to - from) / duration
      chain.push(`volume='${Math.max(0, from).toFixed(4)}+${slope.toFixed(5)}*t':eval=frame`)
    } else {
      const gain = baseGain
      if (Math.abs(gain - 1) > 0.001) chain.push(`volume=${gain.toFixed(4)}`)
    }
    if (clip.audio.normalize) chain.push('dynaudnorm=f=250:g=15')
    if (clip.audio.bass) chain.push(`bass=g=${clip.audio.bass.toFixed(1)}`)
    if (clip.audio.treble) chain.push(`treble=g=${clip.audio.treble.toFixed(1)}`)
    const fadeInSec = Math.min(clip.audio.fadeInMs, durSec * 1000) / 1000
    if (fadeInSec > 0.01) chain.push(`afade=t=in:st=0:d=${fadeInSec.toFixed(3)}`)
    const fadeOutSec = Math.min(clip.audio.fadeOutMs, durSec * 1000) / 1000
    if (fadeOutSec > 0.01) {
      chain.push(`afade=t=out:st=${Math.max(0, durSec - fadeOutSec).toFixed(3)}:d=${fadeOutSec.toFixed(3)}`)
    }
    const delayMs = Math.round(overlapStart - range.start)
    if (delayMs > 0) chain.push(`adelay=${delayMs}|${delayMs}`)
    chain.push('apad')
    chains.push(`[${index}:a]${chain.join(',')}[a${index}]`)
    labels.push(`[a${index}]`)
  })
  chains.push(
    `${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0,atrim=0:${rangeSec.toFixed(
      3
    )},alimiter=limit=0.98[aout]`
  )
  args.push(
    '-filter_complex', chains.join(';'),
    '-map', '[aout]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2',
    outWav
  )
  return args
}

/** Final encode arguments for the deliverable. */
export function muxArgs(
  videoFile: string,
  audioFile: string | null,
  outPath: string,
  preset: ExportPreset,
  encoding?: boolean | { encoder: string; options: string[] }
): string[] {
  /*
   * `true`/`false` is the legacy shape (hardware on/off, NVENC assumed); the
   * object form carries the encoder the probe selected plus its own option set.
   * Keeping both means old callers and tests still mean what they said.
   */
  const explicit = typeof encoding === 'object' ? encoding : undefined
  const encoder = explicit?.encoder ?? (encoding === true ? 'h264_nvenc' : codecName(preset.videoCodec))
  const options =
    explicit?.options ??
    (encoding === true
      ? ['-preset', 'p5', '-rc', 'vbr', '-cq', '21', '-b:v', `${preset.videoBitrateKbps}k`]
      : ['-preset', preset.speed, '-crf', '19', '-b:v', `${preset.videoBitrateKbps}k`])
  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'warning', '-nostdin', '-i', videoFile]
  if (audioFile) args.push('-i', audioFile)
  args.push('-map', '0:v:0')
  if (audioFile) args.push('-map', '1:a:0')
  /*
   * No `scale=trunc(iw/2)*2:...` here: the intermediate is already rendered at
   * the export size (even-rounded at segment time), so rescaling it on the mux
   * was a full extra resample and a slight softening for nothing.
   */
  args.push('-vf', 'format=yuv420p', '-r', String(preset.fps), '-c:v', encoder)
  args.push(...options)
  args.push('-pix_fmt', 'yuv420p')
  if (audioFile) {
    args.push(
      '-c:a', preset.audioCodec === 'opus' ? 'libopus' : 'aac',
      '-b:a', `${preset.audioBitrateKbps}k`,
      '-ar', '48000', '-ac', '2'
    )
  } else args.push('-an')
  args.push('-movflags', '+faststart', outPath)
  return args
}

/**
 * Bytes the lossless intermediate will occupy: ARGB at canvas size for every
 * frame of the range, plus the joined copy. Deliberately generous — running out
 * of space mid-render is far worse than refusing a little early.
 */
export function intermediateBytes(
  preset: { width: number; height: number; fps: number },
  durationMs: number
): number {
  const frames = Math.max(1, Math.ceil((durationMs / 1000) * preset.fps))
  const perFrame = preset.width * preset.height * 4
  // Segments + the concatenated copy, plus a little slack for the WAV and log.
  return Math.round(frames * perFrame * 1.15 + 64 * 1024 * 1024)
}
export { hasTrack, sampleTrack }
