/**
 * Local AI model manager.
 *
 * Models are downloaded once (when online) into the Clipwright workspace and
 * then used offline. Nothing is advertised as offline-capable unless the binary
 * is actually present on disk — `capabilities()` reports the truth.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { modelsDir } from '../workspace'
import { log } from '../logger'
import { settingsStore } from '../settings'
import type { LocalModel, RuntimeStatus } from '@shared/types'

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

export type { RuntimeStatus }

let cachedRuntimes: RuntimeStatus | null = null

/** Read per call: users change OLLAMA_HOST and expect a re-scan to notice. */
function ollamaUrl(): string {
  const configured = process.env.OLLAMA_HOST
  if (!configured) return 'http://127.0.0.1:11434'
  // `OLLAMA_HOST` is documented as host:port by Ollama itself.
  return configured.startsWith('http') ? configured : `http://${configured}`
}
const LMSTUDIO_URL = 'http://127.0.0.1:1234'

/**
 * Binary names whisper.cpp has shipped under.
 *
 * Besides the official `whisper-cli`, this includes the widely used community
 * builds the user may already have: SYSTRAN/faster-whisper converts models to
 * `model.bin` (a Python package, not a CLI), while Porter and Buzz ship their own
 * engines. Only whisper.cpp-compatible CLIs are listed here — we execute the
 * binary and parse whisper.cpp's JSON, so anything else would fail later.
 */
const WHISPER_BINARY_NAMES = ['whisper-cli', 'whisper', 'whisper-cpp', 'whisper_cpp', 'main']
/** Names only trusted inside a whisper-ish folder, because they are too generic. */
const LEGACY_WHISPER_NAMES = ['main']

function exts(): string[] {
  return process.platform === 'win32' ? ['.exe', ''] : ['']
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * Directories worth searching for a user-installed runtime.
 *
 * People install whisper.cpp in whatever way the README told them to: a folder
 * with `whisper-cli.exe` next to the DLLs, a `whisper.cpp` checkout, a winget or
 * Chocolatey package, or a Python/scoop shim. All of those are checked, plus the
 * workspace, so "I have whisper installed" is not answered with "not found".
 */
export function runtimeSearchDirs(): string[] {
  const dirs: string[] = []
  const push = (dir: string | undefined) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir)
  }

  // Bundled with the app (the installer ships resources/bin).
  const resources = process.resourcesPath ?? path.join(process.cwd(), 'resources')
  push(path.join(resources, 'bin'))

  // Next to the executable and one level down (portable installs).
  const exeDir = path.dirname(process.execPath)
  push(exeDir)
  push(path.join(exeDir, 'bin'))
  push(path.join(exeDir, 'whisper'))
  push(path.join(exeDir, 'whisper.cpp'))

  // Workspace + app data.
  try {
    const root = settingsStore().get().storage.workspaceRoot
    if (root) {
      push(path.join(root, 'Tools'))
      push(path.join(root, 'bin'))
    }
  } catch {
    /* settings unavailable during very early startup */
  }

  // Everywhere a user typically unpacks a release on Windows.
  const home = os.homedir()
  const localAppData = process.env.LOCALAPPDATA
  const appData = process.env.APPDATA
  const candidates = [
    path.join(home, 'whisper.cpp'),
    path.join(home, 'whisper'),
    path.join(home, 'Downloads', 'whisper.cpp'),
    path.join(home, 'Downloads', 'whisper-bin-x64'),
    path.join(home, 'scoop', 'apps', 'whisper-cpp', 'current'),
    path.join(home, 'scoop', 'shims'),
    localAppData ? path.join(localAppData, 'Programs', 'whisper.cpp') : undefined,
    appData ? path.join(appData, 'whisper.cpp') : undefined,
    'C:\\Program Files\\whisper.cpp',
    'C:\\Program Files (x86)\\whisper.cpp',
    'C:\\whisper.cpp',
    'C:\\tools\\whisper.cpp',
    'C:\\ProgramData\\chocolatey\\bin',
    'C:\\ProgramData\\chocolatey\\lib'
  ]
  for (const candidate of candidates) push(candidate)

  // Anything already on PATH.
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir) push(dir)
  }
  return dirs
}

export function findBinary(names: string[], dirs: string[], depth = 0): string | null {
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of exts()) {
        const candidate = path.join(dir, `${name}${ext}`)
        if (isFile(candidate)) return candidate
      }
    }
  }
  // One level of nesting covers the usual "unzip created a subfolder" case
  // (whisper-bin-x64/Release/whisper-cli.exe) without walking a whole drive.
  if (depth < 2) {
    for (const dir of dirs) {
      let entries: fs.Dirent[] = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      const subdirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name))
      const found = findBinary(names, subdirs, depth + 1)
      if (found) return found
    }
  }
  return null
}

/** `whisper-cli --help` on a working install exits 0 quickly; use it to prove the binary runs. */
async function binaryResponds(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: boolean) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    try {
      const child = spawn(bin, args, { windowsHide: true })
      const timer = setTimeout(() => {
        child.kill()
        done(false)
      }, 4000)
      child.on('error', () => {
        clearTimeout(timer)
        done(false)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        // Exits 0 normally; some builds exit non-zero after printing usage.
        done(code === 0 || code === 1)
      })
    } catch {
      done(false)
    }
  })
}

interface OllamaTag {
  name?: string
  model?: string
}

/** Ask a local server what it has. A closed port means "not running", not an error. */
async function probeHttpModels(baseUrl: string, pathname: string): Promise<{ ok: boolean; models: string[] }> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1200)
    const response = await fetch(`${baseUrl}${pathname}`, { signal: controller.signal })
    clearTimeout(timer)
    if (!response.ok) return { ok: false, models: [] }
    const payload = (await response.json()) as { models?: OllamaTag[]; data?: OllamaTag[] }
    const list = payload.models ?? payload.data ?? []
    const models = list
      .map((entry) => entry.name ?? entry.model ?? '')
      .filter((name): name is string => Boolean(name))
    return { ok: true, models }
  } catch {
    return { ok: false, models: [] }
  }
}

/** Search the usual model folders for a `ggml-*.bin` the user already has. */
export function findExistingWhisperModel(): { path: string; name: string } | undefined {
  const dirs: string[] = []
  const push = (dir: string | undefined) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir)
  }
  const resources = process.resourcesPath ?? path.join(process.cwd(), 'resources')
  push(path.join(resources, 'models'))
  try {
    const root = settingsStore().get().storage.workspaceRoot
    if (root) {
      push(path.join(root, 'Models'))
      push(path.join(root, 'models'))
    }
  } catch {
    /* ignore */
  }
  const home = os.homedir()
  push(path.join(home, '.cache', 'whisper'))
  push(path.join(process.env.LOCALAPPDATA ?? home, 'whisper'))
  push(path.join(home, 'whisper.cpp', 'models'))
  push(path.join(home, 'whisper', 'models'))
  push(path.join(home, 'Downloads', 'whisper.cpp', 'models'))
  push('C:\\whisper.cpp\\models')

  for (const dir of dirs) {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const lower = entry.name.toLowerCase()
      if (entry.isFile() && lower.startsWith('ggml-') && lower.endsWith('.bin')) {
        return { path: path.join(dir, entry.name), name: entry.name }
      }
    }
  }
  return undefined
}

/**
 * Resolve a path the user picked in Settings to an executable.
 *
 * Accepts the executable itself, its folder, or a folder one level up (the
 * shape of most whisper.cpp Windows zips), and returns null when nothing usable
 * is there so detection can report honestly instead of guessing.
 */
export function expandToolPath(picked: string, names: string[]): string | null {
  try {
    if (!picked || !fs.existsSync(picked)) return null
    const stat = fs.statSync(picked)
    if (stat.isFile()) return picked
    const direct = names
      .map((name) => path.join(picked, name))
      .find((candidate) => fs.existsSync(candidate))
    if (direct) return direct
    for (const entry of fs.readdirSync(picked, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const nested = names
        .map((name) => path.join(picked, entry.name, name))
        .find((candidate) => fs.existsSync(candidate))
      if (nested) return nested
    }
  } catch {
    /* unreadable path: simply not usable */
  }
  return null
}

export async function detectRuntimes(force = false): Promise<RuntimeStatus> {
  if (cachedRuntimes && !force) return cachedRuntimes
  const dirs = runtimeSearchDirs()

  // whisper.cpp: an explicit path chosen in Settings always wins, then the usual
  // search, then the legacy `main.exe` inside a whisper-ish folder.
  //
  // A dropped folder is also accepted: if the user points at a directory we look
  // inside it (and one level down), which is what people actually select when
  // they downloaded a zip and extracted it.
  let whisperPath: string | null = null
  const explicit = settingsStore().get().tools?.whisperPath?.trim()
  if (explicit) {
    const resolved = expandToolPath(explicit, WHISPER_BINARY_NAMES)
    if (resolved) whisperPath = resolved
  }
  if (!whisperPath) whisperPath = findBinary(WHISPER_BINARY_NAMES, dirs)
  if (!whisperPath) {
    // `main.exe` is only trusted when it sits in a whisper-ish folder, since the
    // name is far too generic to match blindly.
    const legacy = findBinary(LEGACY_WHISPER_NAMES, dirs.filter((d) => /whisper/i.test(d)))
    if (legacy) whisperPath = legacy
  }
  let whisperWorks = whisperPath ? await binaryResponds(whisperPath, ['--help']) : false

  /*
   * A binary that exists but will not run is almost always the bundled
   * `resources/bin/whisper-cli.exe` next to a machine that has its own whisper
   * somewhere else: our copy is missing a DLL, the user's copy is fine. Rather
   * than showing a red "would not run" line with no way forward, prefer any
   * other working candidate we can find, then repair the bundled folder from it
   * the next time the app starts.
   */
  if (whisperPath && !whisperWorks) {
    const alternatives = dirs
      .map((dir) =>
        [...WHISPER_BINARY_NAMES].flatMap((name) =>
          [path.join(dir, `${name}.exe`), path.join(dir, name)]
        )
      )
      .flat()
      .filter((candidate) => candidate !== whisperPath && isFile(candidate))
    for (const candidate of alternatives) {
      if (await binaryResponds(candidate, ['--help'])) {
        log.info('ai', `bundled whisper would not run; using ${candidate} instead`)
        whisperPath = candidate
        whisperWorks = true
        break
      }
    }
  }

  const llamaPath = findBinary(['llama-cli', 'main-llama', 'llama'], dirs)

  const base = ollamaUrl()
  const [ollamaModels, lmstudioModels] = await Promise.all([
    probeHttpModels(base, '/api/tags'),
    probeHttpModels(LMSTUDIO_URL, '/v1/models')
  ])
  let ollamaVersion: string | undefined
  if (ollamaModels.ok) {
    try {
      const response = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(1200) })
      if (response.ok) ollamaVersion = ((await response.json()) as { version?: string }).version
    } catch {
      /* version is a nicety */
    }
  }

  const bundledDirs = [path.join(process.resourcesPath ?? '', 'bin')]
  const sourceOf = (bin: string) =>
    bundledDirs.some((dir) => dir && bin.startsWith(dir)) ? 'bundled' : 'found on this PC'

  cachedRuntimes = {
    whisper: {
      available: Boolean(whisperPath) && whisperWorks,
      path: whisperPath ?? undefined,
      source: whisperPath
        ? whisperWorks
          ? sourceOf(whisperPath)
          : `${sourceOf(whisperPath)} but it would not run (missing DLLs?)`
        : 'not found',
      version: whisperPath && whisperWorks ? path.basename(path.dirname(whisperPath)) : undefined
    },
    llama: {
      available: Boolean(llamaPath),
      path: llamaPath ?? undefined,
      source: llamaPath ? sourceOf(llamaPath) : 'not found'
    },
    ollama: {
      available: ollamaModels.ok,
      url: base,
      models: ollamaModels.models,
      version: ollamaVersion,
      note: ollamaModels.ok
        ? ollamaModels.models.length
          ? undefined
          : 'Ollama is running but has no models pulled yet — try `ollama pull llama3.2`.'
        : 'No Ollama server answered at this address.'
    },
    lmstudio: {
      available: lmstudioModels.ok,
      url: LMSTUDIO_URL,
      models: lmstudioModels.models,
      note: lmstudioModels.ok ? undefined : 'LM Studio is not running its local server.'
    },
    whisperModel: findExistingWhisperModel(),
    checkedAt: Date.now()
  }
  log.info(
    'ai',
    `runtimes: whisper=${cachedRuntimes.whisper.available ? cachedRuntimes.whisper.path : 'no'} ` +
      `ollama=${ollamaModels.ok ? `${ollamaModels.models.length} model(s)` : 'no'} ` +
      `lmstudio=${lmstudioModels.ok ? 'yes' : 'no'}`
  )
  return cachedRuntimes
}

export function whisperRuntimePath(): string | null {
  return cachedRuntimes?.whisper.path ?? findBinary(WHISPER_BINARY_NAMES, runtimeSearchDirs())
}

export function llamaRuntimePath(): string | null {
  return cachedRuntimes?.llama.path ?? findBinary(['llama-cli', 'main-llama', 'llama'], runtimeSearchDirs())
}

/** Exposed for diagnostics / the About screen. */
export function runtimeSummary(status: RuntimeStatus): string {
  const parts: string[] = []
  parts.push(status.whisper.available ? `whisper.cpp: ready (${status.whisper.source})` : 'whisper.cpp: not installed')
  parts.push(status.llama.available ? `llama.cpp: ready (${status.llama.source})` : 'llama.cpp: not installed')
  parts.push(
    status.ollama.available
      ? `Ollama: ${status.ollama.models.length} model(s) at ${status.ollama.url}`
      : 'Ollama: not running'
  )
  return parts.join(' · ')
}

export { spawn }
