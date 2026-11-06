/**
 * Local AI model manager.
 *
 * Models are downloaded once (when online) into the Clipwright workspace and
 * then used offline. Nothing is advertised as offline-capable unless the binary
 * is actually present on disk — `capabilities()` reports the truth.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { modelsDir } from '../workspace'
import { log } from '../logger'
import type { LocalModel } from '@shared/types'

export interface ModelDefinition extends Omit<LocalModel, 'installed' | 'installedAt'> {
  /** Minimum RAM in GB recommended for comfortable use. */
  minRamGb: number
  /** Strategy used to run it. */
  runtime: 'whisper.cpp' | 'llama.cpp'
  /** Optional sha256 of the download for integrity verification. */
  sha256?: string
}

/** Curated, permissively licensed models hosted on Hugging Face. */
export const MODEL_CATALOGUE: ModelDefinition[] = [
  {
    id: 'ggml-tiny.en',
    name: 'Whisper Tiny (English)',
    task: 'transcription',
    sizeBytes: 77_700_000,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
    filename: 'ggml-tiny.en.bin',
    licence: 'MIT',
    note: 'Fastest transcription. Good for quick drafts on modest machines.',
    language: 'en',
    minRamGb: 2,
    runtime: 'whisper.cpp'
  },
  {
    id: 'ggml-base.en',
    name: 'Whisper Base (English)',
    task: 'transcription',
    sizeBytes: 148_000_000,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
    filename: 'ggml-base.en.bin',
    licence: 'MIT',
    note: 'Balanced accuracy and speed. Recommended default for English.',
    language: 'en',
    minRamGb: 3,
    runtime: 'whisper.cpp'
  },
  {
    id: 'ggml-small.en',
    name: 'Whisper Small (English)',
    task: 'transcription',
    sizeBytes: 488_000_000,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
    filename: 'ggml-small.en.bin',
    licence: 'MIT',
    note: 'More accurate for accented speech and noisy audio.',
    language: 'en',
    minRamGb: 4,
    runtime: 'whisper.cpp'
  },
  {
    id: 'ggml-base',
    name: 'Whisper Base (multilingual)',
    task: 'transcription',
    sizeBytes: 148_000_000,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    filename: 'ggml-base.bin',
    licence: 'MIT',
    note: 'Automatic language detection for non-English audio.',
    minRamGb: 3,
    runtime: 'whisper.cpp'
  },
  {
    id: 'ggml-small',
    name: 'Whisper Small (multilingual)',
    task: 'transcription',
    sizeBytes: 488_000_000,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    filename: 'ggml-small.bin',
    licence: 'MIT',
    note: 'Better multilingual accuracy.',
    minRamGb: 4,
    runtime: 'whisper.cpp'
  },
  {
    id: 'qwen2.5-3b-instruct-q4',
    name: 'Qwen2.5 3B Instruct (Q4)',
    task: 'analysis',
    sizeBytes: 1_930_000_000,
    url: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
    filename: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    licence: 'Apache-2.0',
    note: 'Offline moment analysis. Runs on CPU; ~4 GB RAM.',
    minRamGb: 8,
    runtime: 'llama.cpp'
  },
  {
    id: 'llama-3.2-3b-instruct-q4',
    name: 'Llama 3.2 3B Instruct (Q4)',
    task: 'analysis',
    sizeBytes: 2_020_000_000,
    url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    filename: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    licence: 'Llama 3.2 Community Licence',
    note: 'Alternative offline analysis model with strong instruction following.',
    minRamGb: 8,
    runtime: 'llama.cpp'
  }
]

export function installedModels(): LocalModel[] {
  return MODEL_CATALOGUE.map((def) => {
    const file = path.join(modelsDir(), def.filename)
    const installed = fs.existsSync(file)
    return {
      id: def.id,
      name: def.name,
      task: def.task,
      sizeBytes: def.sizeBytes,
      url: def.url,
      filename: def.filename,
      licence: def.licence,
      note: def.note,
      language: def.language,
      installed,
      installedAt: installed ? fs.statSync(file).mtimeMs : undefined
    }
  })
}

export function modelPath(id: string): string | null {
  const def = MODEL_CATALOGUE.find((m) => m.id === id)
  if (!def) return null
  const file = path.join(modelsDir(), def.filename)
  return fs.existsSync(file) ? file : null
}

export function deleteModel(id: string): boolean {
  const def = MODEL_CATALOGUE.find((m) => m.id === id)
  if (!def) return false
  const file = path.join(modelsDir(), def.filename)
  if (fs.existsSync(file)) {
    fs.unlinkSync(file)
    return true
  }
  return false
}

const downloads = new Map<string, AbortController>()

export function cancelDownload(id: string): void {
  downloads.get(id)?.abort()
  downloads.delete(id)
}

/** Download a model with progress reporting and integrity verification. */
export async function downloadModel(
  id: string,
  onProgress: (payload: { modelId: string; receivedBytes: number; totalBytes: number; percent: number; status: string; message?: string }) => void
): Promise<{ ok: boolean; error?: string }> {
  const def = MODEL_CATALOGUE.find((m) => m.id === id)
  if (!def) return { ok: false, error: 'Unknown model.' }
  const dir = modelsDir()
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, def.filename)
  const partial = `${target}.part`
  const controller = new AbortController()
  downloads.set(id, controller)
  try {
    const response = await fetch(def.url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok || !response.body) {
      return { ok: false, error: `Download failed: HTTP ${response.status}. Check your connection and try again.` }
    }
    const total = Number(response.headers.get('content-length') ?? def.sizeBytes)
    const hash = createHash('sha256')
    let received = 0
    const stream = fs.createWriteStream(partial)
    const reader = response.body.getReader()
    let lastEmit = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        stream.write(Buffer.from(value))
        hash.update(Buffer.from(value))
        received += value.length
        const now = Date.now()
        if (now - lastEmit > 250) {
          lastEmit = now
          onProgress({
            modelId: id,
            receivedBytes: received,
            totalBytes: total,
            percent: Math.min(99, Math.round((received / total) * 100)),
            status: 'downloading'
          })
        }
      }
    }
    await new Promise<void>((resolve) => stream.end(resolve))
    onProgress({ modelId: id, receivedBytes: received, totalBytes: total, percent: 99, status: 'verifying' })
    if (def.sha256) {
      const digest = hash.digest('hex')
      if (digest !== def.sha256) {
        fs.unlinkSync(partial)
        return { ok: false, error: 'The downloaded file failed its checksum check and was discarded.' }
      }
    }
    fs.renameSync(partial, target)
    onProgress({ modelId: id, receivedBytes: received, totalBytes: total, percent: 100, status: 'installed' })
    log.info('ai', `model installed: ${def.name} (${received} bytes)`)
    return { ok: true }
  } catch (error) {
    try {
      if (fs.existsSync(partial)) fs.unlinkSync(partial)
    } catch {
      /* ignore */
    }
    if (controller.signal.aborted) return { ok: false, error: 'Download cancelled.' }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    downloads.delete(id)
  }
}

/* ------------------------------------------------------------------ */
/* Runtimes                                                           */
/* ------------------------------------------------------------------ */

export interface RuntimeStatus {
  whisper: { available: boolean; path?: string; version?: string; source: string }
  llama: { available: boolean; path?: string; version?: string; source: string }
}

let cachedRuntimes: RuntimeStatus | null = null

function findBinary(names: string[], extraDirs: string[]): string | null {
  const exts = process.platform === 'win32' ? ['.exe', ''] : ['']
  for (const dir of extraDirs) {
    for (const name of names) {
      for (const ext of exts) {
        const candidate = path.join(dir, `${name}${ext}`)
        if (fs.existsSync(candidate)) return candidate
      }
    }
  }
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of pathDirs) {
    for (const name of names) {
      for (const ext of exts) {
        const candidate = path.join(dir, `${name}${ext}`)
        if (fs.existsSync(candidate)) return candidate
      }
    }
  }
  return null
}

function binaryDirs(): string[] {
  const dirs: string[] = []
  // Bundled binaries ship next to the app (resources/bin) when packaged.
  const resources = process.resourcesPath ?? path.join(process.cwd(), 'resources')
  dirs.push(path.join(resources, 'bin'))
  dirs.push(path.join(process.cwd(), 'resources', 'bin'))
  dirs.push(path.join(path.dirname(process.execPath), 'bin'))
  return dirs
}

export async function detectRuntimes(force = false): Promise<RuntimeStatus> {
  if (cachedRuntimes && !force) return cachedRuntimes
  const whisperPath = findBinary(['whisper-cli', 'main', 'whisper'], binaryDirs())
  const llamaPath = findBinary(['llama-cli', 'main-llama', 'llama'], binaryDirs())
  cachedRuntimes = {
    whisper: {
      available: Boolean(whisperPath),
      path: whisperPath ?? undefined,
      source: whisperPath ? (binaryDirs().some((d) => whisperPath.startsWith(d)) ? 'bundled' : 'system PATH') : 'not found'
    },
    llama: {
      available: Boolean(llamaPath),
      path: llamaPath ?? undefined,
      source: llamaPath ? (binaryDirs().some((d) => llamaPath.startsWith(d)) ? 'bundled' : 'system PATH') : 'not found'
    }
  }
  return cachedRuntimes
}

export function whisperRuntimePath(): string | null {
  return cachedRuntimes?.whisper.path ?? findBinary(['whisper-cli', 'main', 'whisper'], binaryDirs())
}

export function llamaRuntimePath(): string | null {
  return cachedRuntimes?.llama.path ?? findBinary(['llama-cli', 'main-llama', 'llama'], binaryDirs())
}

/** Exposed for diagnostics / the About screen. */
export function runtimeSummary(status: RuntimeStatus): string {
  const parts: string[] = []
  parts.push(status.whisper.available ? `whisper.cpp: ready (${status.whisper.source})` : 'whisper.cpp: not installed')
  parts.push(status.llama.available ? `llama.cpp: ready (${status.llama.source})` : 'llama.cpp: not installed')
  return parts.join(' · ')
}

export { spawn }
