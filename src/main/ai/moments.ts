/**
 * Viral moment detection and ranking.
 *
 * Offline path: deterministic transcript analysis (shared/scoring.ts) — no model
 * needed, works on any machine, fully reproducible.
 * Online/offline-LLM path: the transcript is chunked with timing anchors, the
 * model returns candidate windows plus dimension scores, and the response is
 * validated against the real transcript (clamped, de-duplicated, re-scored).
 *
 * Either way, scores are editorial signals, not predictions.
 */
import fs from 'node:fs'
import path from 'node:path'
import { normaliseAiMoments, scoreWindows, weightedScore, EMPTY_SCORES } from '@shared/scoring'
import type { HeuristicMoment } from '@shared/scoring'
import type { Transcript, Moment, ProcessingMode, TranscriptSegment } from '@shared/types'
import { providerStore, chat } from './providers'
import { llamaRuntimePath, modelPath } from './models'
import { spawn } from 'node:child_process'
import { workspaceLayout } from '../workspace'
import { log } from '../logger'
import { settingsStore } from '../settings'

export interface DetectOptions {
  projectId: string
  transcript: Transcript
  minDurationMs: number
  maxDurationMs: number
  targetCount: number
  mode: ProcessingMode
  providerId?: string
  onProgress?: (percent: number, detail: string) => void
  signal?: AbortSignal
}

export interface DetectResult {
  moments: Moment[]
  engine: string
  warnings: string[]
}

export async function detectMoments(opts: DetectOptions): Promise<DetectResult> {
  const warnings: string[] = []
  opts.onProgress?.(5, 'Preparing transcript')
  const chosen = decideEngine(opts.mode, opts.providerId)
  let candidates: HeuristicMoment[] = []
  let engine = 'heuristic:local'

  if (chosen === 'provider') {
    try {
      opts.onProgress?.(20, 'Asking the AI provider for candidate moments')
      candidates = await detectWithProvider(opts)
      engine = 'ai:provider'
    } catch (error) {
      warnings.push(
        `Online moment analysis failed: ${error instanceof Error ? error.message : String(error)}. Falling back to the built-in transcript analysis.`
      )
      candidates = []
    }
  } else if (chosen === 'local-llm') {
    try {
      opts.onProgress?.(20, 'Running the local analysis model')
      candidates = await detectWithLocalModel(opts)
      engine = 'ai:local'
    } catch (error) {
      warnings.push(
        `Local model analysis failed: ${error instanceof Error ? error.message : String(error)}. Falling back to the built-in transcript analysis.`
      )
      candidates = []
    }
  }

  if (candidates.length === 0) {
    opts.onProgress?.(60, 'Scoring candidate windows')
    candidates = scoreWindows(opts.transcript.segments, {
      minDurationMs: opts.minDurationMs,
      maxDurationMs: opts.maxDurationMs,
      targetCount: Math.max(opts.targetCount * 2, 8)
    })
    if (chosen !== 'heuristic') engine = `${engine}+heuristic`
    else engine = 'heuristic:local'
  }

  const clamped = candidates
    .filter((c) => c.end - c.start >= opts.minDurationMs * 0.6)
    .slice(0, Math.max(1, opts.targetCount))

  const now = Date.now()
  const moments: Moment[] = clamped.map((candidate, index) => ({
    id: `mom_${now.toString(36)}_${index}`,
    projectId: opts.projectId,
    title: candidate.title,
    start: Math.round(candidate.start),
    end: Math.round(candidate.end),
    score: candidate.score,
    scores: candidate.scores,
    confidence: candidate.confidence,
    reason: candidate.reason,
    previewText: candidate.previewText,
    tags: candidate.tags,
    status: 'new',
    engine,
    createdAt: now
  }))
  opts.onProgress?.(100, `${moments.length} moments found`)
  return { moments, engine, warnings }
}

function decideEngine(mode: ProcessingMode, providerId?: string): 'provider' | 'local-llm' | 'heuristic' {
  const settings = settingsStore().get().ai
  const provider = providerStore().resolve('analysis', providerId)
  const hasLocalLlm = Boolean(modelPath('qwen2.5-3b-instruct-q4') || modelPath('llama-3.2-3b-instruct-q4')) && Boolean(llamaRuntimePath())
  if (mode === 'offline') return hasLocalLlm ? 'local-llm' : 'heuristic'
  if (mode === 'online') {
    if (provider && provider.kind !== 'local' && (provider.hasKey || provider.kind === 'openai-compatible')) return 'provider'
    return 'heuristic'
  }
  // automatic
  if (provider && provider.kind !== 'local' && (provider.hasKey || provider.kind === 'openai-compatible')) {
    return 'provider'
  }
  if (hasLocalLlm) return 'local-llm'
  void settings
  return 'heuristic'
}

/* ------------------------------------------------------------------ */
/* Prompting                                                          */
/* ------------------------------------------------------------------ */

function buildTranscriptPrompt(
  segments: TranscriptSegment[],
  opts: { minDurationMs: number; maxDurationMs: number; targetCount: number }
): string {
  const lines = segments
    .map((s) => `[${(s.start / 1000).toFixed(1)}-${(s.end / 1000).toFixed(1)}] ${s.text}`)
    .join('\n')
  const minSec = Math.round(opts.minDurationMs / 1000)
  const maxSec = Math.round(opts.maxDurationMs / 1000)
  return `You are a senior short-form video editor. Find the ${opts.targetCount} strongest standalone moments in this transcript.

Rules:
- Each moment must be ${minSec}-${maxSec} seconds long and start/end at sentence boundaries.
- Prefer complete ideas with a strong opening hook and a natural ending; never start mid-explanation.
- Avoid overlapping or near-duplicate moments.
- Do not invent timestamps: use only the times shown in brackets.

Score each moment from 0-100 on: hook, emotion, standalone (does it make sense alone), interest, storytelling, value (educational/insight), pacing, social (short-form suitability).

Transcript:
${lines}

Return JSON only, in this shape:
{"moments":[{"title":"short editorial title","start":12.4,"end":41.0,"reason":"why this moment works","scores":{"hook":88,"emotion":70,"standalone":90,"interest":82,"storytelling":75,"value":68,"pacing":85,"social":92}}]}`
}

async function detectWithProvider(opts: DetectOptions): Promise<HeuristicMoment[]> {
  const provider = providerStore().resolve('analysis', opts.providerId)
  if (!provider) throw new Error('No analysis provider configured')
  const apiKey = providerStore().apiKey(provider.id)
  const chunkLimit = 90
  const chunks = chunkSegments(opts.transcript.segments, chunkLimit)
  const results: HeuristicMoment[] = []
  for (let i = 0; i < chunks.length; i++) {
    opts.onProgress?.(20 + (i / chunks.length) * 55, `Analysing part ${i + 1} of ${chunks.length}`)
    const prompt = buildTranscriptPrompt(chunks[i], {
      minDurationMs: opts.minDurationMs,
      maxDurationMs: opts.maxDurationMs,
      targetCount: Math.max(3, Math.ceil(opts.targetCount / chunks.length) + 1)
    })
    const reply = await chat(provider, apiKey, [
      { role: 'system', content: 'You analyse video transcripts and reply with strict JSON.' },
      { role: 'user', content: prompt }
    ], { json: true, maxTokens: 2500, temperature: 0.3, signal: opts.signal })
    const parsed = parseMomentJson(reply.text)
    const normalised = normaliseAiMoments(
      parsed.map((m) => ({
        title: m.title,
        start: m.start,
        end: m.end,
        scores: m.scores,
        reason: m.reason
      })),
      opts.transcript.segments,
      {
        minDurationMs: opts.minDurationMs,
        maxDurationMs: opts.maxDurationMs,
        textAt: (start, end) => textBetween(opts.transcript.segments, start, end)
      }
    )
    results.push(...normalised)
  }
  results.sort((a, b) => b.score - a.score)
  // Drop cross-chunk duplicates.
  const deduped: HeuristicMoment[] = []
  for (const m of results) {
    const overlaps = deduped.some((d) => {
      const overlap = Math.min(d.end, m.end) - Math.max(d.start, m.start)
      return overlap > Math.min(d.end - d.start, m.end - m.start) * 0.4
    })
    if (!overlaps) deduped.push(m)
  }
  return deduped.slice(0, opts.targetCount)
}

interface ParsedMoment {
  title?: string
  start: number
  end: number
  reason?: string
  scores?: Record<string, number>
}

export function parseMomentJson(text: string): ParsedMoment[] {
  const cleaned = text
    .replace(/^```(?:json)?/im, '')
    .replace(/```$/m, '')
    .trim()
  const tryParse = (candidate: string): ParsedMoment[] | null => {
    try {
      const json = JSON.parse(candidate) as { moments?: ParsedMoment[] } | ParsedMoment[]
      const list = Array.isArray(json) ? json : json.moments
      if (!Array.isArray(list)) return null
      return list
        .map((m) => ({ ...m, start: normaliseTime(m.start), end: normaliseTime(m.end) }))
        .filter((m) => isFinite(m.start) && isFinite(m.end) && m.end > m.start)
    } catch {
      return null
    }
  }
  const direct = tryParse(cleaned)
  if (direct) return direct
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const nested = tryParse(cleaned.slice(start, end + 1))
    if (nested) return nested
  }
  throw new Error('The AI response was not valid JSON, so no moments could be read from it.')
}

/** Accept seconds or milliseconds from model output. */
function normaliseTime(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!isFinite(n)) return NaN
  // Values below 10000 are treated as seconds (a 10,000 s transcript is unusual).
  return n < 10_000 ? n * 1000 : n
}

function chunkSegments(segments: TranscriptSegment[], maxSegments: number): TranscriptSegment[][] {
  const chunks: TranscriptSegment[][] = []
  for (let i = 0; i < segments.length; i += maxSegments) {
    chunks.push(segments.slice(i, i + maxSegments))
  }
  return chunks.length ? chunks : [segments]
}

function textBetween(segments: TranscriptSegment[], start: number, end: number): string {
  return segments
    .filter((s) => s.end > start && s.start < end)
    .map((s) => s.text)
    .join(' ')
}

/* ------------------------------------------------------------------ */
/* Local LLM (llama.cpp)                                              */
/* ------------------------------------------------------------------ */

async function detectWithLocalModel(opts: DetectOptions): Promise<HeuristicMoment[]> {
  const runtime = llamaRuntimePath()
  const model = modelPath('qwen2.5-3b-instruct-q4') ?? modelPath('llama-3.2-3b-instruct-q4')
  if (!runtime || !model) throw new Error('No local analysis model is installed')
  const chunks = chunkSegments(opts.transcript.segments, 70)
  const results: HeuristicMoment[] = []
  for (let i = 0; i < chunks.length; i++) {
    opts.onProgress?.(20 + (i / chunks.length) * 55, `Local analysis: part ${i + 1} of ${chunks.length}`)
    const prompt = buildTranscriptPrompt(chunks[i], {
      minDurationMs: opts.minDurationMs,
      maxDurationMs: opts.maxDurationMs,
      targetCount: Math.max(3, Math.ceil(opts.targetCount / chunks.length) + 1)
    })
    const output = await runLlama(runtime, model, prompt, opts.signal)
    const parsed = parseMomentJson(output)
    results.push(
      ...normaliseAiMoments(parsed, opts.transcript.segments, {
        minDurationMs: opts.minDurationMs,
        maxDurationMs: opts.maxDurationMs,
        textAt: (start, end) => textBetween(opts.transcript.segments, start, end)
      })
    )
  }
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, opts.targetCount)
}

function runLlama(runtime: string, model: string, prompt: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      runtime,
      ['-m', model, '-p', prompt, '-n', '1200', '--temp', '0.3', '-c', '8192', '--no-display-prompt', '-no-cnv'],
      { windowsHide: true }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (buf: Buffer) => (stdout += buf.toString()))
    child.stderr.on('data', (buf: Buffer) => (stderr += buf.toString()))
    signal?.addEventListener('abort', () => child.kill('SIGKILL'))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr.slice(-300) || `llama.cpp exited ${code}`))
      else resolve(stdout)
    })
  })
}

/* ------------------------------------------------------------------ */
/* Persistence                                                        */
/* ------------------------------------------------------------------ */

export function saveMoments(projectId: string, moments: Moment[]): string {
  const dir = path.join(workspaceLayout().projects, projectId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'moments.json')
  fs.writeFileSync(file, JSON.stringify({ moments, savedAt: Date.now() }, null, 2))
  return file
}

export function loadMoments(projectId: string): Moment[] {
  const file = path.join(workspaceLayout().projects, projectId, 'moments.json')
  if (!fs.existsSync(file)) return []
  try {
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { moments: Moment[] }).moments
  } catch {
    return []
  }
}

/** Recompute the weighted overall score for edited boundaries. */
export function rescoreMoment(moment: Moment, transcript: Transcript, minMs: number, maxMs: number): Moment {
  const text = textBetween(transcript.segments, moment.start, moment.end)
  const scored = scoreWindows(
    transcript.segments.filter((s) => s.end > moment.start && s.start < moment.end),
    { minDurationMs: minMs, maxDurationMs: maxMs, targetCount: 1 }
  )
  const fallback = scored[0]
  const scores = fallback && text.length ? fallback.scores : moment.scores
  return { ...moment, scores, score: weightedScore(scores), previewText: text.slice(0, 420) || moment.previewText }
}

export { EMPTY_SCORES }
export const momentsLogPath = (): string => path.join(workspaceLayout().logs, 'moments.log')
export function logMoments(message: string): void {
  log.info('moments', message)
}
