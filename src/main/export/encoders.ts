/**
 * Encoder selection and rate-control arguments for the final encode.
 *
 * The export used to branch on a single boolean: `useNvenc ? 'h264_nvenc' :
 * libx264`. On an AMD or Intel machine that is a guaranteed failure per export —
 * the bundled ffmpeg ships working `h264_amf` and `h264_qsv` and they were never
 * selected. The choice is now made from the probed encoder list, in preference
 * order, and each encoder gets the option set it actually understands:
 *
 *   NVENC  -preset p5 -rc vbr -cq N -b:v / -maxrate / -bufsize
 *   AMF    -quality … -rc cqp -qp_i/-qp_p  (AMF has no -cq)
 *   QSV    -preset … -global_quality N     (QSV has no -crf)
 *   x264   -preset … -crf N                (capped-CRF; -crf and -b:v together
 *                                           made ffmpeg ignore one of them)
 */
import type { ExportPreset } from '@shared/types'

export type HardwareEncoder = 'h264_nvenc' | 'h264_amf' | 'h264_qsv'

/** Preference order: NVENC first, then AMF, then QSV. */
const HARDWARE_ORDER: HardwareEncoder[] = ['h264_nvenc', 'h264_amf', 'h264_qsv']

const LABEL: Record<HardwareEncoder, string> = {
  h264_nvenc: 'NVIDIA NVENC',
  h264_amf: 'AMD AMF',
  h264_qsv: 'Intel Quick Sync'
}

/**
 * Pick a usable H.264 hardware encoder from `ffmpeg -encoders`.
 *
 * `undefined` means "encode on the CPU with libx264". An empty encoder list
 * (probe failed / ffmpeg missing) is also treated as "no hardware", which is the
 * safe direction: a CPU encode always works.
 */
export function pickHardwareEncoder(encoders: string[]): HardwareEncoder | undefined {
  return HARDWARE_ORDER.find((name) => encoders.includes(name))
}

export function hardwareLabel(encoder: HardwareEncoder): string {
  return LABEL[encoder]
}

/**
 * Software encoder for a codec, chosen from what this ffmpeg actually has.
 *
 * `libsvtav1` is not in the bundled build, so AV1 used to fail with "Unknown
 * encoder" before a single frame was encoded. AV1 now falls back to the AAC-era
 * AV1 encoder that *is* bundled (libaom-av1) and reports the compromise.
 */
export function softwareEncoder(
  codec: ExportPreset['videoCodec'],
  encoders: string[]
): { name: string; warning?: string } {
  switch (codec) {
    case 'hevc':
      return encoders.includes('libx265')
        ? { name: 'libx265' }
        : { name: 'libx264', warning: 'This build has no HEVC encoder — exported as H.264 instead.' }
    case 'vp9':
      return encoders.includes('libvpx-vp9')
        ? { name: 'libvpx-vp9' }
        : { name: 'libx264', warning: 'This build has no VP9 encoder — exported as H.264 instead.' }
    case 'av1': {
      const known = ['libsvtav1', 'libaom-av1', 'librav1e']
      const found = known.find((name) => encoders.includes(name))
      if (found) return { name: found }
      return { name: 'libx264', warning: 'This build has no AV1 encoder — exported as H.264 instead.' }
    }
    default:
      return encoders.includes('libx264') || !encoders.length
        ? { name: 'libx264' }
        : { name: 'libx264', warning: 'libx264 was not reported by ffmpeg; trying it anyway.' }
  }
}

/** Codec → encoder name without consulting the probe (kept for callers/tests). */
export function codecName(codec: ExportPreset['videoCodec']): string {
  switch (codec) {
    case 'hevc':
      return 'libx265'
    case 'vp9':
      return 'libvpx-vp9'
    case 'av1':
      return 'libsvtav1'
    default:
      return 'libx264'
  }
}

export interface EncodeChoice {
  encoder: string
  /** Rate-control / quality arguments for this encoder. */
  options: string[]
  hardware: boolean
  warning?: string
}

/**
 * Work out the encoder and its arguments for one export.
 *
 * `hardware` is only honoured for H.264 (the container presets are H.264); every
 * other codec always encodes in software, which is what the UI implies.
 */
export function chooseEncoder(
  preset: ExportPreset,
  encoders: string[],
  hardware: boolean
): EncodeChoice {
  if (hardware && preset.videoCodec === 'h264') {
    const pick = pickHardwareEncoder(encoders)
    if (pick) {
      return { encoder: pick, options: rateControl(pick, preset), hardware: true }
    }
    return {
      encoder: softwareEncoder('h264', encoders).name,
      options: rateControl('libx264', preset),
      hardware: false,
      warning:
        encoders.length === 0
          ? undefined
          : `No NVENC, AMF or Quick Sync encoder on this machine — exported with the CPU (libx264) instead.`
    }
  }
  const soft = softwareEncoder(preset.videoCodec, encoders)
  return {
    encoder: soft.name,
    options: rateControl(soft.name, preset),
    hardware: false,
    warning: soft.warning
  }
}

/**
 * Per-encoder rate control. Exactly one mode per encoder: passing `-crf` and
 * `-b:v` together (as the old code did) means one of them is silently ignored.
 */
export function rateControl(encoder: string, preset: ExportPreset): string[] {
  const kbps = preset.videoBitrateKbps
  const maxrate = `${Math.round(kbps * 1.5)}k`
  const bufsize = `${kbps * 2}k`
  // -preset values are encoder specific; NVENC prefers p1..p7, x264/x265 names.
  const speed = preset.speed
  switch (encoder) {
    case 'h264_nvenc':
      return ['-preset', 'p5', '-rc', 'vbr', '-cq', '21', '-b:v', `${kbps}k`, '-maxrate', maxrate, '-bufsize', bufsize]
    case 'h264_amf':
      // AMF uses -quality (speed|balanced|quality) and constant QP; it has no -cq.
      return [
        '-quality',
        speed === 'ultrafast' || speed === 'superfast' ? 'speed' : speed === 'medium' ? 'balanced' : 'quality',
        '-rc',
        'cqp',
        '-qp_i',
        '21',
        '-qp_p',
        '21',
        '-b:v',
        `${kbps}k`,
        '-maxrate',
        maxrate,
        '-bufsize',
        bufsize
      ]
    case 'h264_qsv':
      return ['-preset', 'medium', '-global_quality', '21', '-b:v', `${kbps}k`, '-maxrate', maxrate, '-bufsize', bufsize]
    case 'libx265':
      return ['-preset', speed, '-crf', '20', '-maxrate', maxrate, '-bufsize', bufsize]
    case 'libvpx-vp9':
      // VP9 needs an explicit rate target; -crf alone means constant quality.
      return ['-crf', '32', '-b:v', `${kbps}k`, '-maxrate', maxrate, '-bufsize', bufsize, '-row-mt', '1']
    case 'libsvtav1':
      return ['-preset', '8', '-crf', '30', '-b:v', `${kbps}k`]
    case 'libaom-av1':
      return ['-cpu-used', '6', '-crf', '30', '-b:v', `${kbps}k`, '-row-mt', '1']
    default:
      // libx264: capped CRF. -crf sets the quality, maxrate/bufsize cap the peak.
      return ['-preset', speed, '-crf', '19', '-maxrate', maxrate, '-bufsize', bufsize]
  }
}
