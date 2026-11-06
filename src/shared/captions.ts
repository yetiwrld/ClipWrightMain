/**
 * Caption engine: turns transcript words into caption clips, and captions into
 * subtitle files. Shared by the editor, the clip generator and the exporter.
 */
import { uid } from './keyframes'
import { FALLBACK_CAPTION_PRESETS } from './presets'
import { baseClip } from './timeline'
import type {
  CaptionPreset,
  CaptionWord,
  Clip,
  Project,
  TranscriptSegment,
  TranscriptWord
} from './types'

export interface CaptionGroup {
  words: CaptionWord[]
  start: number
  end: number
}

/** Approximate word timings when a transcript only has segment-level timings. */
export function estimateWordTimings(segment: TranscriptSegment): TranscriptWord[] {
  if (segment.words && segment.words.length) return segment.words
  const tokens = segment.text.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  const span = Math.max(1, segment.end - segment.start)
  // Weight longer words slightly more, as speech naturally does.
  const weights = tokens.map((t) => Math.max(2, t.replace(/[^\p{L}\p{N}]/gu, '').length))
  const total = weights.reduce((a, b) => a + b, 0)
  let cursor = segment.start
  return tokens.map((text, i) => {
    const dur = (weights[i] / total) * span
    const word = { text, start: Math.round(cursor), end: Math.round(cursor + dur) }
    cursor += dur
    return word
  })
}

/** Group words into caption lines using sentence punctuation and a max word count. */
export function groupWordsIntoCaptions(
  words: CaptionWord[],
  wordsPerLine: number,
  maxDurationMs = 6000
): CaptionGroup[] {
  const groups: CaptionGroup[] = []
  let current: CaptionWord[] = []

  const flush = () => {
    if (current.length === 0) return
    groups.push({ words: current, start: current[0].start, end: current[current.length - 1].end })
    current = []
  }

  for (const word of words) {
    const projectedDuration =
      current.length > 0 ? word.end - current[0].start : word.end - word.start
    if (current.length > 0 && (current.length >= wordsPerLine || projectedDuration > maxDurationMs)) {
      flush()
    }
    current.push(word)
    // Break after strong sentence punctuation. A one-word sentence ("No.")
    // used to merge into the following line because the break required
    // current.length >= 2.
    if (/[.!?…]$/.test(word.text)) flush()
  }
  flush()
  return groups.filter((g) => g.words.length > 0)
}

export function buildCaptionWords(
  segments: TranscriptSegment[],
  range: { start: number; end: number }
): CaptionWord[] {
  const words: CaptionWord[] = []
  for (const seg of segments) {
    if (seg.end <= range.start || seg.start >= range.end) continue
    const segWords = estimateWordTimings(seg)
    for (const w of segWords) {
      if (w.end <= range.start || w.start >= range.end) continue
      words.push({
        text: w.text,
        start: Math.max(range.start, w.start),
        end: Math.min(range.end, w.end)
      })
    }
  }
  return words.sort((a, b) => a.start - b.start)
}

/**
 * Build caption clips (one clip per caption line) positioned on the timeline.
 * `timeOffset` maps absolute transcript time -> timeline time (clip start at 0).
 */
export function buildCaptionClips(
  segments: TranscriptSegment[],
  range: { start: number; end: number },
  preset: CaptionPreset,
  trackId: string,
  timeOffset = -range.start
): Clip[] {
  const words = buildCaptionWords(segments, range)
  const groups = groupWordsIntoCaptions(words, preset.wordsPerLine)
  return groups.map((group) => {
    const clip = baseClip('caption', trackId, group.words.map((w) => w.text).join(' '))
    /*
     * A group that starts before the range was clamped at 0 for the clip but its
     * words kept their raw offset, so word timings drifted out of the clip and
     * every later word highlighted at the wrong moment. Clamping the group start
     * once and shifting the words by the same amount keeps them aligned.
     */
    const shift = Math.max(timeOffset, -group.start)
    clip.start = Math.max(0, group.start + shift)
    clip.duration = Math.max(400, group.end - group.start)
    clip.sourceIn = 0
    clip.text = group.words.map((w) => w.text).join(' ')
    clip.words = group.words.map((w) => ({
      ...w,
      start: Math.max(0, w.start + shift),
      end: Math.max(0, w.end + shift)
    }))
    clip.style = { ...preset.style }
    clip.layout = { ...preset.layout }
    clip.animation = preset.animation
    clip.animationDurationMs = preset.animationDurationMs
    clip.captionPresetId = preset.id
    return clip
  })
}

/** Pick up to N emphasis words for keyword highlighting styles. */
export function pickKeywordIndices(words: CaptionWord[]): number[] {
  const stop = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'so', 'to', 'of', 'in', 'on', 'at', 'for', 'is',
    'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'these', 'those', 'i', 'you', 'we',
    'they', 'he', 'she', 'my', 'your', 'our', 'their', 'as', 'with', 'from', 'by', 'not', 'do',
    'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'just', 'really'
  ])
  const scored = words
    .map((w, i) => {
      const clean = w.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
      const emphasis =
        (/[!?]$/.test(w.text) ? 3 : 0) +
        (clean.length >= 7 ? 2 : clean.length >= 5 ? 1 : 0) +
        (stop.has(clean) ? -3 : 0) +
        (/^[A-Z]/.test(w.text) ? 1 : 0)
      return { i, score: emphasis }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
  /*
   * Sorted by relevance to *choose*, then returned in word order: consumers
   * treat these as positions, and a descending-relevance list highlighted the
   * wrong words.
   */
  return scored
    .slice(0, Math.max(1, Math.ceil(words.length / 4)))
    .map((s) => s.i)
    .sort((a, b) => a - b)
}

export function presetById(id: string | undefined, presets: CaptionPreset[]): CaptionPreset {
  return (
    presets.find((p) => p.id === id) ??
    FALLBACK_CAPTION_PRESETS.find((p) => p.id === id) ??
    FALLBACK_CAPTION_PRESETS[0]
  )
}

/* ------------------------------------------------------------------ */
/* Subtitle serialisation                                             */
/* ------------------------------------------------------------------ */

function srtTime(ms: number): string {
  /*
   * Round first, then split. Rounding only the millisecond remainder produced
   * four-digit fields like "00:00:01,1000" for 1999.7 ms — and the carry into
   * seconds never happened, so players rejected or mis-timed the cue.
   */
  const total = Math.max(0, Math.round(ms))
  const h = Math.floor(total / 3600000)
  const m = Math.floor(total / 60000) % 60
  const s = Math.floor(total / 1000) % 60
  const msec = total % 1000
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(s)},${p(msec, 3)}`
}

function vttTime(ms: number): string {
  return srtTime(ms).replace(',', '.')
}

export function captionsToSrt(clips: Clip[], offsetMs = 0): string {
  const captions = clips
    .filter((c) => c.kind === 'caption' && c.text)
    .sort((a, b) => a.start - b.start)
  return captions
    .map((c, i) => {
      const start = srtTime(Math.max(0, c.start + offsetMs))
      const end = srtTime(Math.max(0, c.start + c.duration + offsetMs))
      return `${i + 1}\n${start} --> ${end}\n${c.text!.trim()}\n`
    })
    .join('\n')
}

export function captionsToVtt(clips: Clip[], offsetMs = 0): string {
  const captions = clips
    .filter((c) => c.kind === 'caption' && c.text)
    .sort((a, b) => a.start - b.start)
  const body = captions
    .map((c) => {
      const start = vttTime(Math.max(0, c.start + offsetMs))
      const end = vttTime(Math.max(0, c.start + c.duration + offsetMs))
      return `${start} --> ${end}\n${c.text!.trim()}\n`
    })
    .join('\n')
  return `WEBVTT\n\n${body}`
}

/** Parse an SRT/VTT file into caption clips so users can import subtitles. */
export function parseSubtitleFile(content: string, trackId: string): Clip[] {
  const normalised = content.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '')
  const blocks = normalised.split(/\n{2,}/)
  const clips: Clip[] = []
  const timeRe =
    /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '')
    if (!lines.length || /^WEBVTT/i.test(lines[0])) continue
    const timeLineIndex = lines.findIndex((l) => timeRe.test(l))
    if (timeLineIndex < 0) continue
    const m = timeRe.exec(lines[timeLineIndex])!
    const toMs = (h: string, mi: string, s: string, ms: string) =>
      Number(h) * 3600000 + Number(mi) * 60000 + Number(s) * 1000 + Number(ms.padEnd(3, '0'))
    const start = toMs(m[1], m[2], m[3], m[4])
    const end = toMs(m[5], m[6], m[7], m[8])
    const text = lines.slice(timeLineIndex + 1).join('\n').trim()
    if (!text) continue
    const clip = baseClip('caption', trackId, text)
    clip.start = start
    clip.duration = Math.max(300, end - start)
    clip.text = text
    clips.push(clip)
  }
  return clips
}

/** Split a caption clip into two at an absolute timeline time. */
export function splitCaption(clip: Clip, at: number): [Clip, Clip] | null {
  const local = at - clip.start
  if (local < 100 || local > clip.duration - 100) return null
  const leftWords = (clip.words ?? []).filter((w) => w.start < at)
  const rightWords = (clip.words ?? []).filter((w) => w.start >= at)
  const left: Clip = {
    ...clip,
    id: uid('clip'),
    duration: local,
    text: leftWords.length ? leftWords.map((w) => w.text).join(' ') : clip.text,
    words: leftWords.length ? leftWords : undefined
  }
  const right: Clip = {
    ...clip,
    id: uid('clip'),
    start: at,
    duration: clip.duration - local,
    text: rightWords.length ? rightWords.map((w) => w.text).join(' ') : clip.text,
    words: rightWords.length ? rightWords : undefined
  }
  return [left, right]
}

/** Merge two adjacent captions into one. */
export function mergeCaptions(a: Clip, b: Clip): Clip {
  const [first, second] = a.start <= b.start ? [a, b] : [b, a]
  const end = Math.max(first.start + first.duration, second.start + second.duration)
  return {
    ...first,
    duration: end - first.start,
    text: [first.text, second.text].filter(Boolean).join(' '),
    words: [...(first.words ?? []), ...(second.words ?? [])].sort((x, y) => x.start - y.start)
  }
}

/** Re-flow caption clip word timings after transcript edits. */
export function retimeCaptionWords(clip: Clip, words: CaptionWord[]): Clip {
  if (!words.length) return { ...clip, words: [] }
  const start = Math.min(...words.map((w) => w.start))
  const end = Math.max(...words.map((w) => w.end))
  return { ...clip, words, start, duration: Math.max(300, end - start), text: words.map((w) => w.text).join(' ') }
}

export function captionStats(project: Project): { count: number; words: number } {
  const captions = project.clips.filter((c) => c.kind === 'caption')
  const words = captions.reduce(
    (sum, c) => sum + (c.words?.length ?? (c.text ? c.text.trim().split(/\s+/).length : 0)),
    0
  )
  return { count: captions.length, words }
}
