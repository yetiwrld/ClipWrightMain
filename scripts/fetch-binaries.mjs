#!/usr/bin/env node
/**
 * Downloads the Windows binaries the installer ships:
 *
 *   resources/ffmpeg/ffmpeg.exe, ffprobe.exe   (gyan.dev essentials build)
 *   resources/bin/whisper-cli.exe              (whisper.cpp Windows release, optional)
 *
 * Run in CI before electron-builder. Every download is checked against the
 * published SHA-256 when one is available, and the script fails loudly rather
 * than producing an app that claims to have a tool it does not.
 *
 * Usage: node scripts/fetch-binaries.mjs [--skip-whisper]
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ffmpegDir = path.join(root, 'resources', 'ffmpeg')
const binDir = path.join(root, 'resources', 'bin')

const FFMPEG_URL =
  process.env.FFMPEG_URL ?? 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
const WHISPER_URL =
  process.env.WHISPER_URL ??
  'https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip'

function log(message) {
  process.stdout.write(`[binaries] ${message}\n`)
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

async function download(url, destination) {
  log(`GET ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, buffer)
  const digest = crypto.createHash('sha256').update(buffer).digest('hex')
  log(`  ${(buffer.length / 1_048_576).toFixed(1)} MB  sha256=${digest}`)
  return digest
}

function unzip(zipPath, destination) {
  fs.mkdirSync(destination, { recursive: true })
  // PowerShell is available on every Windows runner; bsdtar cannot read all zips.
  if (process.platform === 'win32') {
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destination}' -Force`],
      { stdio: 'inherit' }
    )
    return
  }
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', destination], { stdio: 'inherit' })
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = findFile(full, name)
      if (nested) return nested
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full
    }
  }
  return null
}

/**
 * Last resort: use a real ffmpeg already installed on the machine (CI runners
 * have one). Never resolves a package-manager *shim* — those are a few hundred
 * KB and only work from their original location, which is exactly the trap that
 * makes a "bundled binary" useless on a clean machine.
 */
function localBinary(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const roots = [
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
    'C:\\ProgramData\\chocolatey\\lib'
  ]
  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue
    const stack = [dir]
    while (stack.length) {
      const current = stack.pop()
      let entries = []
      try {
        entries = fs.readdirSync(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          if (stack.length < 4000) stack.push(full)
        } else if (entry.name.toLowerCase() === exe.toLowerCase()) {
          const size = fs.statSync(full).size
          if (size > 5 * 1_048_576) return full
        }
      }
    }
  }
  return null
}

async function installFromLocal() {
  log('falling back to an ffmpeg already installed on this machine')
  for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) {
    const found = localBinary(exe.replace(/\.exe$/i, ''))
    if (!found) throw new Error(`no real ${exe} found locally either — cannot build a working app`)
    fs.copyFileSync(found, path.join(ffmpegDir, exe))
    log(`installed resources/ffmpeg/${exe} from ${found} (${(fs.statSync(found).size / 1_048_576).toFixed(1)} MB)`)
  }
  fs.writeFileSync(
    path.join(ffmpegDir, 'BUILD.txt'),
    `source: locally installed ffmpeg on the build machine\nfetched: ${new Date().toISOString()}\n` +
      `note: upstream download was unavailable; this build bundles the builder's ffmpeg.\n`
  )
}

async function main() {
  const skipWhisper = process.argv.includes('--skip-whisper')
  const work = path.join(root, '.downloads')
  fs.mkdirSync(work, { recursive: true })
  fs.mkdirSync(ffmpegDir, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })

  /* ------------------------------- ffmpeg ------------------------------- */
  let ffmpegDigest = ''
  try {
    const ffmpegZip = path.join(work, 'ffmpeg.zip')
    ffmpegDigest = await download(FFMPEG_URL, ffmpegZip)
    const expectedFfmpeg = process.env.FFMPEG_SHA256
    if (expectedFfmpeg && expectedFfmpeg.toLowerCase() !== ffmpegDigest) {
      throw new Error(`ffmpeg checksum mismatch: expected ${expectedFfmpeg}, got ${ffmpegDigest}`)
    }
    const ffmpegExtract = path.join(work, 'ffmpeg')
    unzip(ffmpegZip, ffmpegExtract)
    for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) {
      const found = findFile(ffmpegExtract, exe)
      if (!found) throw new Error(`${exe} not found inside the ffmpeg archive`)
      fs.copyFileSync(found, path.join(ffmpegDir, exe))
      log(`installed resources/ffmpeg/${exe} (${(fs.statSync(found).size / 1_048_576).toFixed(1)} MB)`)
    }
  } catch (error) {
    log(`WARNING: could not download ffmpeg (${error.message})`)
    await installFromLocal()
  }
  // Record what we shipped so the app can report the exact build.
  if (ffmpegDigest) {
    fs.writeFileSync(
      path.join(ffmpegDir, 'BUILD.txt'),
      `source: ${FFMPEG_URL}\nsha256(zip): ${ffmpegDigest}\nfetched: ${new Date().toISOString()}\n` +
        `note: Gyan "essentials" build — LGPL/GPL components as per upstream licence.\n`
    )
  }

  /* ------------------------------ whisper.cpp ------------------------------ */
  if (!skipWhisper) {
    try {
      const whisperZip = path.join(work, 'whisper.zip')
      await download(WHISPER_URL, whisperZip)
      const extract = path.join(work, 'whisper')
      unzip(whisperZip, extract)
      const cli = findFile(extract, 'whisper-cli.exe') ?? findFile(extract, 'main.exe')
      if (cli) {
        fs.mkdirSync(binDir, { recursive: true })
        fs.copyFileSync(cli, path.join(binDir, 'whisper-cli.exe'))
        // Runtime DLLs sit next to the CLI in the release archive.
        for (const dll of fs.readdirSync(path.dirname(cli))) {
          if (dll.toLowerCase().endsWith('.dll')) {
            fs.copyFileSync(path.join(path.dirname(cli), dll), path.join(binDir, dll))
          }
        }
        log('installed resources/bin/whisper-cli.exe (+ runtime DLLs)')
      } else {
        log('WARNING: whisper-cli.exe not found in the release archive — offline transcription will report itself unavailable')
      }
    } catch (error) {
      // Offline transcription is optional; the app reports the truth at runtime.
      log(`WARNING: whisper.cpp download failed (${error.message}). Offline transcription will be unavailable in this build.`)
    }
  }

  const manifest = {
    ffmpeg: fs.existsSync(path.join(ffmpegDir, 'ffmpeg.exe')),
    ffprobe: fs.existsSync(path.join(ffmpegDir, 'ffprobe.exe')),
    whisper: fs.existsSync(path.join(binDir, 'whisper-cli.exe')),
    fetchedAt: new Date().toISOString()
  }
  fs.writeFileSync(path.join(root, 'resources', 'binaries.json'), JSON.stringify(manifest, null, 2))
  log(`manifest: ${JSON.stringify(manifest)}`)
  if (!manifest.ffmpeg || !manifest.ffprobe) {
    throw new Error('ffmpeg/ffprobe are mandatory — the build would not be able to import or export media')
  }
}

main().catch((error) => {
  process.stderr.write(`[binaries] FAILED: ${error.stack ?? error.message}\n`)
  process.exit(1)
})
