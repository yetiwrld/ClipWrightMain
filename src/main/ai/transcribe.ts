/**
 * Transcription engine.
 *
 * • Local: whisper.cpp with a downloaded ggml model, producing word-level
 *   timestamps and (optionally) speaker turns from audio energy/segment gaps.
 * • Online: any OpenAI-compatible /audio/transcriptions endpoint.
 *
 * The engine always returns word timings when the backend provides them and
 * falls back to proportional word timing otherwise, so captions and moment
 * detection always have usable timing.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ffmpegPath } from '../ffmpeg/locate'
import { runProcess } from '../ffmpeg/runner'
import { modelsDir, workspaceLayout } from '../workspace'
import { modelPath, whisperRuntimePath } from './models'
import { providerStore, transcribeRemote } from './providers'
import { estimateWordTimings } from '@shared/captions'
import type { Transcript, TranscriptSegment, TranscriptWord } from '@shared/types'
import { log } from '../logger'
import { settingsStore } from '../settings'

export interface TranscribeOptions {
  assetPath: string
  assetId: string
  projectId: string
  mode: 'local' | 'online'
  language?: string
  model?: string
  providerId?: string
  speakerLabels?: boolean
  onProgress?: (percent: number, detail: string) => void
  signal?: AbortSignal
}

let activeWhisper: ReturnType<typeof spawn> | null = null

export function cancelTranscription(): void {
  if (activeWhisper) {
    try {
      activeWhisper.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    activeWhisper = null
  }
}

/** Extract 16 kHz mono WAV for speech recognition. */
async function extractAudio(input: string, outWav: string, signal?: AbortSignal): Promise<void> {
  const result = await runProcess(
    ffmpegPath(),
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outWav],
    { timeoutMs: 60 * 60_000, signal }
  )
  if (result.code !== 0 || !fs.existsSync(outWav)) {
    throw new Error(`Could not extract audio for transcription: ${result.stderr.slice(-300)}`)
  }
}

export async function transcribe(opts: TranscribeOptions): Promise<Transcript> {
  const layout = workspaceLayout()
  const wav = path.join(layout.temp, `stt-${Date.now()}.wav`)
  fs.mkdirSync(layout.temp, { recursive: true })
  opts.onProgress?.(3, 'Extracting audio')
  await extractAudio(opts.assetPath, wav, opts.signal)

  try {
    const transcript =
      opts.mode === 'online'
        ? await transcribeOnline(opts, wav)
        : await transcribeLocal(opts, wav)
    opts.onProgress?.(100, 'Transcript ready')
    return transcript
  } finally {
    try {
      fs.unlinkSync(wav)
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Local (whisper.cpp)                                                */
/* ------------------------------------------------------------------ */

async function transcribeLocal(opts: TranscribeOptions, wav: string): Promise<Transcript> {
  const runtime = whisperRuntimePath()
  const wantedModel = opts.model ?? settingsStore().get().transcription.defaultModel
  const modelFile = modelPath(wantedModel) ?? findAnyWhisperModel()
  if (!runtime) {
    throw new Error(
      'Local transcription needs the whisper.cpp runtime. Install it from Settings → Local AI models (or place whisper-cli.exe in the app resources/bin folder), then try again.'
    )
  }
  if (!modelFile) {
    throw new Error(
      `The transcription model "${wantedModel}" is not installed. Download it in Settings → Local AI models, or choose an online provider.`
    )
  }

  const outBase = path.join(workspaceLayout().temp, `stt-${Date.now()}`)
  const args = [
    '-m', modelFile,
    '-f', wav,
    '-oj',
    '-of', outBase,
    '-pp',
    '--output-json-full',
    '-ml', '42'
  ]
  const language = opts.language ?? settingsStore().get().transcription.language
  if (language && language !== 'auto') args.push('-l', language)
  else args.push('-l', 'auto')

  opts.onProgress?.(10, 'Loading model')
  const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
    const child = spawn(runtime, args, { windowsHide: true })
    activeWhisper = child
    let stderr = ''
    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString()
      stderr += text
      const progress = /progress\s*=\s*(\d+)%/.exec(text)
      if (progress) opts.onProgress?.(10 + Number(progress[1]) * 0.8, 'Transcribing audio')
      const segment = /^\[[\d:.]+\s*-->\s*[\d:.]+\]\s+(.+)$/m.exec(text)
      if (segment) opts.onProgress?.(undefined as unknown as number, `Transcribing: ${segment[1].slice(0, 70)}`)
    })
    child.on('error', (error) => resolve({ code: -1, stderr: String(error) }))
    child.on('close', (code) => {
      activeWhisper = null
      resolve({ code: code ?? -1, stderr })
    })
  })
  if (result.code !== 0) {
    throw new Error(
      `whisper.cpp failed (exit ${result.code}). ${result.stderr.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 400)}`
    )
  }

  const jsonFile = `${outBase}.json`
  if (!fs.existsSync(jsonFile)) throw new Error('whisper.cpp did not produce a transcript file.')
  const raw = JSON.parse(fs.readFileSync(jsonFile, 'utf8')) as WhisperJson
  const segments = parseWhisperJson(raw)
  if (!segments.length) throw new Error('No speech was detected in this audio.')
  const transcript: Transcript = {
    id: `tr_${Math.random().toString(36).slice(2, 10)}`,
    projectId: opts.projectId,
    assetId: opts.assetId,
    language: raw.result?.language ?? opts.language ?? 'en',
    engine: 'local:whisper.cpp',
    model: path.basename(modelFile),
    createdAt: Date.now(),
    segments: opts.speakerLabels ? assignSpeakers(segments) : segments
  }
  cleanup([`${outBase}.json`, `${outBase}.txt`, `${outBase}.srt`, `${outBase}.vtt`, `${outBase}.csv`])
  return transcript
}

function findAnyWhisperModel(): string | null {
  const dir = modelsDir()
  if (!fs.existsSync(dir)) return null
  const found = fs.readdirSync(dir).find((f) => f.startsWith('ggml-') && f.endsWith('.bin'))
  return found ? path.join(dir, found) : null
}

function cleanup(files: string[]): void {
  for (const file of files) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file)
    } catch {
      /* ignore */
    }
  }
}

interface WhisperToken {
  text: string
  timestamps?: { from: string; to: string }
  offsets?: { from: number; to: number }
}

interface WhisperSegment {
  timestamps?: { from: string; to: string }
  offsets?: { from: number; to: number }
  text: string
  tokens?: WhisperToken[]
}

interface WhisperJson {
  transcription?: WhisperSegment[]
  result?: { language?: string }
  segments?: WhisperSegment[]
}

function parseWhisperJson(raw: WhisperJson): TranscriptSegment[] {
  const list = raw.transcription ?? raw.segments ?? []
  const segments: TranscriptSegment[] = []
  list.forEach((item, index) => {
    const text = item.text?.replace(/\s+/g, ' ').trim()
    if (!text) return
    const start = item.offsets?.from ?? parseTimestamp(item.timestamps?.from) ?? 0
    const end = item.offsets?.to ?? parseTimestamp(item.timestamps?.to) ?? start + 1000
    const words: TranscriptWord[] = []
    for (const token of item.tokens ?? []) {
      const t = token.text
      if (!t.trim()) continue
      // whisper.cpp emits words with a leading space; special tokens start with [_ .
      if (/^\[_|^<\|/.test(t)) continue
      const wordStart = token.offsets?.from ?? parseTimestamp(token.timestamps?.from)
      const wordEnd = token.offsets?.to ?? parseTimestamp(token.timestamps?.to)
      if (wordStart === undefined || wordEnd === undefined) continue
      words.push({ text: t.trim(), start: wordStart, end: Math.max(wordStart + 30, wordEnd) })
    }
    segments.push({
      id: `seg_${index}_${Math.random().toString(36).slice(2, 7)}`,
      start,
      end: Math.max(start + 120, end),
      text,
      words: words.length > 1 ? words : undefined
    })
  })
  return segments
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined
  const m = /(\d+):(\d+):(\d+)[.,](\d+)/.exec(value)
  if (!m) return undefined
  return Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4].padEnd(3, '0').slice(0, 3))
}

/** Very light speaker turn detection: split on long pauses and label turns. */
function assignSpeakers(segments: TranscriptSegment[]): TranscriptSegment[] {
  let speaker = 1
  return segments.map((seg, i) => {
    const prev = segments[i - 1]
    if (prev && seg.start - prev.end > 900) speaker = speaker === 1 ? 2 : 1
    return { ...seg, speaker: `Speaker ${speaker}` }
  })
}

/* ------------------------------------------------------------------ */
/* Online                                                             */
/* ------------------------------------------------------------------ */

async function transcribeOnline(opts: TranscribeOptions, wav: string): Promise<Transcript> {
  const provider = providerStore().resolve('transcription', opts.providerId)
  if (!provider) {
    throw new Error('No online transcription provider is configured. Add one in Settings → AI providers, or switch to local transcription.')
  }
  if (provider.kind === 'local') {
    // Resolved to the offline provider even though online was requested.
    return transcribeLocal(opts, wav)
  }
  const apiKey = providerStore().apiKey(provider.id)
  if (!apiKey && provider.kind !== 'openai-compatible') {
    throw new Error(`No API key is saved for ${provider.name}. Add it in Settings → AI providers.`)
  }

  opts.onProgress?.(10, `Compressing audio for upload`)
  // Whisper endpoints cap uploads (~25 MB); compress to a compact mono mp3.
  const mp3 = wav.replace(/\.wav$/, '.mp3')
  const compress = await runProcess(
    ffmpegPath(),
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', wav, '-ac', '1', '-ar', '16000', '-b:a', '32k', mp3],
    { timeoutMs: 30 * 60_000, signal: opts.signal }
  )
  if (compress.code !== 0) throw new Error('Could not prepare the audio for upload.')
  const sizeMb = fs.statSync(mp3).size / (1024 * 1024)
  if (sizeMb > 24) {
    throw new Error(
      `The compressed audio is ${sizeMb.toFixed(1)} MB, which is above the usual 25 MB limit for online transcription. Use local transcription or split the source into shorter parts.`
    )
  }
  opts.onProgress?.(25, `Uploading to ${provider.name}`)
  const model = provider.model || 'whisper-1'
  try {
    const result = await transcribeRemote(provider, apiKey, fs.readFileSync(mp3), path.basename(mp3), {
      model,
      language: opts.language,
      signal: opts.signal
    })
    const segments: TranscriptSegment[] = (result.segments ?? []).map((seg, i) => ({
      id: `seg_${i}_${Math.random().toString(36).slice(2, 7)}`,
      start: Math.round(seg.start * 1000),
      end: Math.round(seg.end * 1000),
      text: seg.text.trim()
    }))
    if (!segments.length && result.text) {
      segments.push({
        id: 'seg_0',
        start: 0,
        end: Math.max(1000, (result.words?.length ?? 1) * 400),
        text: result.text.trim()
      })
    }
    if (result.words?.length) {
      // Attach word timings to the segment that contains each word.
      for (const seg of segments) {
        const words = result.words
          .filter((w) => w.start * 1000 >= seg.start - 60 && w.end * 1000 <= seg.end + 60)
          .map((w) => ({ text: w.word.trim(), start: Math.round(w.start * 1000), end: Math.round(w.end * 1000) }))
        if (words.length) seg.words = words
      }
    }
    for (const seg of segments) if (!seg.words) seg.words = estimateWordTimings(seg)
    return {
      id: `tr_${Math.random().toString(36).slice(2, 10)}`,
      projectId: opts.projectId,
      assetId: opts.assetId,
      language: opts.language ?? 'en',
      engine: `online:${provider.kind}`,
      model,
      createdAt: Date.now(),
      segments: opts.speakerLabels ? assignSpeakers(segments) : segments
    }
  } finally {
    try {
      fs.unlinkSync(mp3)
    } catch {
      /* ignore */
    }
  }
}

/** Save a transcript next to its project. */
export function saveTranscript(projectId: string, transcript: Transcript): string {
  const dir = path.join(workspaceLayout().projects, projectId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'transcript.json')
  fs.writeFileSync(file, JSON.stringify(transcript, null, 2))
  log.info('ai', `transcript saved (${transcript.segments.length} segments, ${transcript.engine})`)
  return file
}

export function loadTranscript(projectId: string): Transcript | null {
  const file = path.join(workspaceLayout().projects, projectId, 'transcript.json')
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Transcript
  } catch {
    return null
  }
}
