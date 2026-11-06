/**
 * Moment scoring engine.
 *
 * Two layers:
 *  1. `scoreWindows` — a deterministic, offline heuristic analyser over the
 *     transcript (hooks, emotion, completeness, pacing...). Runs with no model.
 *  2. `normaliseAiMoments` — validates/scores candidate windows returned by an AI
 *     provider so AI output can never produce broken or overlapping clips.
 *
 * Scores are editorial signals, not predictions of virality. The UI says so.
 */
import type { MomentScores, TranscriptSegment } from './types'

export const SCORE_WEIGHTS: Record<keyof MomentScores, number> = {
  hook: 0.2,
  emotion: 0.14,
  standalone: 0.16,
  interest: 0.13,
  storytelling: 0.1,
  value: 0.09,
  pacing: 0.08,
  social: 0.1
}

export const SCORE_LABELS: Record<keyof MomentScores, string> = {
  hook: 'Hook strength',
  emotion: 'Emotional impact',
  standalone: 'Standalone context',
  interest: 'Audience interest',
  storytelling: 'Storytelling',
  value: 'Educational value',
  pacing: 'Pacing',
  social: 'Social fit'
}

export const EMPTY_SCORES: MomentScores = {
  hook: 0,
  emotion: 0,
  standalone: 0,
  interest: 0,
  storytelling: 0,
  value: 0,
  pacing: 0,
  social: 0
}

export function weightedScore(scores: MomentScores): number {
  let total = 0
  for (const key of Object.keys(SCORE_WEIGHTS) as (keyof MomentScores)[]) {
    total += scores[key] * SCORE_WEIGHTS[key]
  }
  return Math.round(Math.min(100, Math.max(0, total)))
}

/* ------------------------------------------------------------------ */
/* Heuristic feature extraction                                       */
/* ------------------------------------------------------------------ */

const HOOK_MARKERS = [
  'here is', "here's", 'the truth', 'nobody', 'everyone', 'most people', 'what if',
  'the problem', 'the reason', 'listen', 'imagine', 'let me', "i'll tell you",
  'the biggest', 'the best', 'the worst', 'never', 'always', 'stop', 'you need',
  'this is why', 'that is why', "that's why", 'secret', 'mistake', 'warning',
  'surprising', 'crazy', 'unbelievable', 'actually'
]

const EMOTION_MARKERS = [
  'love', 'hate', 'afraid', 'scared', 'angry', 'furious', 'excited', 'amazing',
  'terrible', 'beautiful', 'incredible', 'shocked', 'devastating', 'proud', 'hurt',
  'cried', 'laughed', 'failed', 'won', 'lost', 'struggle', 'pain', 'dream', 'fear',
  'honestly', 'sad', 'happy', 'grateful', 'regret', 'obsessed'
]

const STORY_MARKERS = [
  'when i', 'one day', 'so i', 'then i', 'after that', 'eventually', 'suddenly',
  'years ago', 'last year', 'at first', 'in the end', 'the moment', 'story'
]

const EDUCATIONAL_MARKERS = [
  'because', 'the way', 'for example', 'for instance', 'means that', 'research',
  'study', 'data', 'step', 'first', 'second', 'third', 'basically', 'in other words',
  'here is how', "here's how", 'learn', 'understand', 'explains', 'principle'
]

const FILLERS = ['um', 'uh', 'like,', 'you know', 'sort of', 'kind of', 'i mean']

function countMatches(text: string, markers: string[]): number {
  const lower = text.toLowerCase()
  return markers.reduce((n, m) => (lower.includes(m) ? n + 1 : n), 0)
}

function wordsOf(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean)
}

function punctuationDensity(text: string): number {
  const len = Math.max(1, text.length)
  return ((text.match(/[.!?]/g)?.length ?? 0) / len) * 100
}

interface Window {
  start: number
  end: number
  segments: TranscriptSegment[]
  text: string
}

function buildWindows(
  segments: TranscriptSegment[],
  minDurationMs: number,
  maxDurationMs: number
): Window[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start)
  const windows: Window[] = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    let end = sorted[i].end
    while (j + 1 < sorted.length) {
      const nextEnd = sorted[j + 1].end
      if (nextEnd - sorted[i].start > maxDurationMs) break
      j++
      end = nextEnd
      const duration = end - sorted[i].start
      if (duration >= minDurationMs) {
        const slice = sorted.slice(i, j + 1)
        windows.push({ start: sorted[i].start, end, segments: slice, text: slice.map((s) => s.text).join(' ') })
      }
    }
    // Single-segment windows that are already long enough.
    const single = sorted[i].end - sorted[i].start
    if (single >= minDurationMs && single <= maxDurationMs) {
      windows.push({ start: sorted[i].start, end: sorted[i].end, segments: [sorted[i]], text: sorted[i].text })
    }
  }
  return windows
}

interface Features {
  hook: number
  emotion: number
  standalone: number
  interest: number
  storytelling: number
  value: number
  pacing: number
  social: number
  breakdown: string[]
}

function scoreWindow(w: Window): Features {
  const duration = w.end - w.start
  const words = wordsOf(w.text)
  const wc = Math.max(1, words.length)
  const seconds = Math.max(1, duration / 1000)
  const wps = wc / seconds
  const firstTwo = words.slice(0, 14).join(' ')
  const firstSentence = w.text.split(/[.!?]/)[0] ?? ''
  const breakdown: string[] = []

  // Hook: strong opening words, question opening, numbers, curiosity markers.
  let hook = 38
  const hookMarkers = countMatches(firstTwo, HOOK_MARKERS)
  hook += hookMarkers * 11
  if (/\?/.test(firstSentence)) hook += 9
  if (/^\s*(how|why|what|when|who|the|this|most|nobody|every)/i.test(firstSentence.trim())) hook += 6
  if (/\d/.test(firstTwo)) hook += 5
  if (wc < 12) hook -= 12
  hook = Math.min(98, hook)
  if (hookMarkers) breakdown.push(`opens with a recognised hook phrase`)

  // Emotion: emotional vocabulary and exclamations.
  const emo = countMatches(w.text, EMOTION_MARKERS)
  let emotion = 32 + Math.min(48, emo * 9)
  const exclamations = (w.text.match(/!/g)?.length ?? 0) * 4
  emotion = Math.min(97, emotion + exclamations)
  if (emo >= 2) breakdown.push('emotional language appears more than once')

  // Standalone context: does the window start at a sentence boundary and not
  // reference earlier material?
  let standalone = 62
  const opening = firstSentence.trim().toLowerCase()
  if (/^(and|but|so|because|which|then|also|plus|or)\b/.test(opening)) standalone -= 26
  if (/\b(this|that|it|they|he|she)\b/.test(words.slice(0, 3).join(' ').toLowerCase())) standalone -= 8
  if (/\b(as i said|like i said|earlier|before that|previously|as mentioned)\b/i.test(w.text)) standalone -= 18
  if (/[.!?]$/.test(w.segments[w.segments.length - 1]?.text.trim() ?? '')) standalone += 12
  const completeness = punctuationDensity(w.text)
  standalone += Math.min(14, completeness * 2)
  standalone = Math.max(10, Math.min(97, standalone))

  // Interest: questions, contrasts, specifics.
  let interest = 40
  interest += (w.text.match(/\?/g)?.length ?? 0) * 6
  interest += countMatches(w.text, ['but', 'however', 'instead', 'actually', 'turns out', 'surprisingly']) * 6
  interest += countMatches(w.text, ['percent', '%', 'million', 'billion', 'thousand', 'study']) * 5
  interest = Math.min(96, interest)

  // Storytelling: narrative sequencing words.
  const story = countMatches(w.text, STORY_MARKERS)
  let storytelling = 34 + Math.min(50, story * 12)
  storytelling = Math.min(95, storytelling)
  if (story >= 2) breakdown.push('has a narrative arc (setup → turn → payoff)')

  // Educational value.
  const edu = countMatches(w.text, EDUCATIONAL_MARKERS)
  let value = 30 + Math.min(52, edu * 8)
  value = Math.min(94, value)

  // Pacing: ideal speech rate for short form is ~2.4–3.6 words/sec.
  let pacing: number
  if (wps >= 2.2 && wps <= 4.1) pacing = 82 + (1 - Math.abs(wps - 3) / 1.6) * 12
  else if (wps < 2.2) pacing = 58 - Math.min(22, (2.2 - wps) * 18)
  else pacing = 66 - Math.min(24, (wps - 4.1) * 14)
  const fillers = countMatches(w.text, FILLERS)
  pacing -= Math.min(16, fillers * 2)
  pacing = Math.max(20, Math.min(97, pacing))
  if (wps < 1.4) breakdown.push('speech is slow for short-form pacing')

  // Social fit: sweet spot is 18–48 seconds, plus completeness.
  let social: number
  if (duration >= 15000 && duration <= 48000) social = 90
  else if (duration < 15000) social = 55 + (duration / 15000) * 30
  else social = Math.max(45, 90 - ((duration - 48000) / 60000) * 25)
  if (/\b(subscribe|like and|follow me|link in|sponsor|promo code)\b/i.test(w.text)) social -= 18
  social = Math.max(15, Math.min(97, social))

  if (duration < 10000) breakdown.push(`only ${Math.round(duration / 1000)}s long — may feel abrupt`)

  return {
    hook: Math.round(hook),
    emotion: Math.round(emotion),
    standalone: Math.round(standalone),
    interest: Math.round(interest),
    storytelling: Math.round(storytelling),
    value: Math.round(value),
    pacing: Math.round(pacing),
    social: Math.round(social),
    breakdown
  }
}

function reasonFor(f: Features, title: string, duration: number): string {
  const top = (Object.keys(SCORE_LABELS) as (keyof MomentScores)[])
    .map((k) => ({ k, v: f[k as keyof Features] as number }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 2)
    .map((x) => `${SCORE_LABELS[x.k].toLowerCase()} (${x.v})`)
  const base = `Strongest on ${top.join(' and ')}.`
  const extras = f.breakdown.length ? ` ${f.breakdown[0][0].toUpperCase()}${f.breakdown[0].slice(1)}.` : ''
  return `${base}${extras} Selected as a ${Math.round(duration / 1000)}s window that "${title}".`
}

export interface HeuristicMoment {
  start: number
  end: number
  scores: MomentScores
  score: number
  confidence: number
  title: string
  reason: string
  previewText: string
  tags: string[]
}

function titleFor(text: string): string {
  const first = text.split(/[.!?]/)[0]?.trim() ?? text.trim()
  const words = first.split(/\s+/).slice(0, 9).join(' ')
  const clean = words.replace(/^[^\p{L}\p{N}]+/u, '')
  return clean.length > 3 ? clean[0].toUpperCase() + clean.slice(1) : text.slice(0, 40)
}

function overlapRatio(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const start = Math.max(a.start, b.start)
  const end = Math.min(a.end, b.end)
  if (end <= start) return 0
  return (end - start) / Math.min(a.end - a.start, b.end - b.start)
}

/**
 * Score every candidate window and pick the best non-overlapping set.
 * Deterministic: same transcript in, same moments out.
 */
export function scoreWindows(
  segments: TranscriptSegment[],
  opts: { minDurationMs: number; maxDurationMs: number; targetCount: number }
): HeuristicMoment[] {
  const windows = buildWindows(segments, opts.minDurationMs, opts.maxDurationMs)
  if (windows.length === 0) return []
  const scored = windows.map((w) => {
    const f = scoreWindow(w)
    const scores: MomentScores = {
      hook: f.hook,
      emotion: f.emotion,
      standalone: f.standalone,
      interest: f.interest,
      storytelling: f.storytelling,
      value: f.value,
      pacing: f.pacing,
      social: f.social
    }
    const score = weightedScore(scores)
    return { w, scores, score, f }
  })
  scored.sort((a, b) => b.score - a.score)

  const selected: typeof scored = []
  for (const cand of scored) {
    if (selected.length >= opts.targetCount) break
    const conflict = selected.some((s) => overlapRatio(s.w, cand.w) > 0.35)
    if (conflict) continue
    selected.push(cand)
  }
  return selected.map((s) => {
    const duration = s.w.end - s.w.start
    const title = titleFor(s.w.text)
    // Confidence is lower for very short or borderline windows.
    const lengthConfidence = duration >= 15000 && duration <= 60000 ? 0.9 : 0.7
    const spread =
      Math.max(...Object.values(s.scores)) - Math.min(...Object.values(s.scores))
    const confidence = Math.min(0.96, Math.round((lengthConfidence - spread / 400) * 100) / 100)
    return {
      start: s.w.start,
      end: s.w.end,
      scores: s.scores,
      score: s.score,
      confidence,
      title,
      reason: reasonFor(s.f, title, duration),
      previewText: s.w.text.slice(0, 420),
      tags: topTags(s.f)
    }
  })
}

function topTags(f: Features): string[] {
  const tags: string[] = []
  if (f.hook >= 70) tags.push('strong hook')
  if (f.emotion >= 70) tags.push('emotional')
  if (f.storytelling >= 70) tags.push('story')
  if (f.value >= 70) tags.push('insight')
  if (f.social >= 80) tags.push('ideal length')
  if (f.standalone >= 80) tags.push('self-contained')
  return tags.length ? tags : ['candidate']
}

/* ------------------------------------------------------------------ */
/* AI response normalisation                                          */
/* ------------------------------------------------------------------ */

export interface AiMomentCandidate {
  title?: string
  start: number
  end: number
  scores?: Partial<MomentScores>
  reason?: string
  text?: string
}

/**
 * Validate AI-produced candidates against the transcript: clamp to real
 * boundaries, enforce duration limits, drop overlaps, and compute the final
 * score from the AI's dimension scores where present, heuristics otherwise.
 */
export function normaliseAiMoments(
  candidates: AiMomentCandidate[],
  segments: TranscriptSegment[],
  opts: { minDurationMs: number; maxDurationMs: number; textAt?: (start: number, end: number) => string }
): HeuristicMoment[] {
  const duration = segments.length ? Math.max(...segments.map((s) => s.end)) : 0
  const out: HeuristicMoment[] = []
  for (const cand of candidates) {
    if (!isFinite(cand.start) || !isFinite(cand.end)) continue
    let start = Math.max(0, Math.min(cand.start, cand.end))
    let end = Math.min(duration || cand.end, Math.max(cand.start, cand.end))
    if (end - start < opts.minDurationMs) {
      end = Math.min(duration || end, start + opts.minDurationMs)
      if (end - start < opts.minDurationMs) start = Math.max(0, end - opts.minDurationMs)
    }
    if (end - start > opts.maxDurationMs) end = start + opts.maxDurationMs
    if (end <= start) continue
    // Snap to the nearest segment boundaries so clips never start mid-sentence.
    const containing = segments.filter((s) => s.start < end && s.end > start)
    if (containing.length) {
      start = Math.min(start, containing[0].start)
      end = Math.max(end, containing[containing.length - 1].end)
      if (end - start > opts.maxDurationMs * 1.25) end = start + opts.maxDurationMs
    }
    const text =
      cand.text ??
      opts.textAt?.(start, end) ??
      containing.map((s) => s.text).join(' ')
    const heuristic = scoreWindow({
      start,
      end,
      segments: containing,
      text
    })
    const scores: MomentScores = {
      hook: clampScore(cand.scores?.hook ?? heuristic.hook),
      emotion: clampScore(cand.scores?.emotion ?? heuristic.emotion),
      standalone: clampScore(cand.scores?.standalone ?? heuristic.standalone),
      interest: clampScore(cand.scores?.interest ?? heuristic.interest),
      storytelling: clampScore(cand.scores?.storytelling ?? heuristic.storytelling),
      value: clampScore(cand.scores?.value ?? heuristic.value),
      pacing: clampScore(cand.scores?.pacing ?? heuristic.pacing),
      social: clampScore(cand.scores?.social ?? heuristic.social)
    }
    // Blend AI judgement with the deterministic scorer so scores stay comparable.
    for (const key of Object.keys(scores) as (keyof MomentScores)[]) {
      scores[key] = Math.round(scores[key] * 0.7 + heuristic[key] * 0.3)
    }
    const title = (cand.title ?? titleFor(text)).slice(0, 90)
    out.push({
      start,
      end,
      scores,
      score: weightedScore(scores),
      confidence: 0.85,
      title,
      reason: cand.reason ?? reasonFor(heuristic, title, end - start),
      previewText: text.slice(0, 420),
      tags: topTags(heuristic)
    })
  }
  // Drop near-duplicates, keeping the highest scoring.
  out.sort((a, b) => b.score - a.score)
  const deduped: HeuristicMoment[] = []
  for (const m of out) {
    if (deduped.some((d) => overlapRatio(d, m) > 0.4)) continue
    deduped.push(m)
  }
  return deduped
}

function clampScore(v: unknown): number {
  const n = typeof v === 'number' && isFinite(v) ? v : 50
  return Math.round(Math.min(100, Math.max(0, n > 0 && n <= 10 ? n * 10 : n)))
}
