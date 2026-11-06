#!/usr/bin/env node
/**
 * Packaging smoke test: render a real video through the real compositor.
 *
 * Run in CI *after* packaging, with CLIPWRIGHT_RESOURCES pointing at the
 * resources directory that electron-builder produced (win-unpacked/resources).
 * That means this exercises the exact bundled ffmpeg.exe the installer ships,
 * the exact fonts and the exact filter graph the app uses — not a mock and not
 * the developer's PATH.
 *
 * Usage:
 *   node scripts/smoke-render.mjs [--resources <dir>] [--out <file.mp4>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const resources = path.resolve(
  root,
  arg('resources', process.env.CLIPWRIGHT_RESOURCES ?? path.join('release', 'win-unpacked', 'resources'))
)
const outFile = path.resolve(root, arg('out', path.join(os.tmpdir(), 'clipwright-smoke.mp4')))
const ffmpegExe = path.join(resources, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const ffprobeExe = path.join(resources, 'ffmpeg', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
const fontsDir = path.join(resources, 'fonts')

function fail(message) {
  process.stderr.write(`[smoke] FAILED: ${message}\n`)
  process.exit(1)
}

function ok(message) {
  process.stdout.write(`[smoke] ${message}\n`)
}

function mustExist(file, what) {
  if (!fs.existsSync(file)) fail(`${what} is missing: ${file}`)
  ok(`${what} found (${(fs.statSync(file).size / 1_048_576).toFixed(1)} MB)`)
}

/* ------------------------------- preflight ------------------------------- */

mustExist(ffmpegExe, 'bundled ffmpeg')
mustExist(ffprobeExe, 'bundled ffprobe')
mustExist(fontsDir, 'bundled fonts')

const version = execFileSync(ffmpegExe, ['-hide_banner', '-version'], { encoding: 'utf8' }).split('\n')[0]
ok(version)

const source = path.join(os.tmpdir(), 'clipwright-smoke-source.mp4')
execFileSync(
  ffmpegExe,
  [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x1b1b1e:s=640x360:r=30:d=3',
    '-f', 'lavfi', '-i', 'sine=f=440:d=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source
  ],
  { stdio: 'inherit' }
)
ok(`synthetic source rendered (${(fs.statSync(source).size / 1024).toFixed(0)} KB)`)

/* ------------------------ render through the compositor ------------------------ */

// Import the compiled TypeScript sources through vite-node style bundling:
// electron-vite already produced out/main/index.js, but that is a whole app.
// Instead we compile the pure modules on the fly with esbuild (a vite dependency).
const { build } = await import('esbuild')
const entry = path.join(root, '.smoke-entry.ts')
fs.writeFileSync(
  entry,
  `import fs from 'node:fs'
import path from 'node:path'
import { ProjectRenderer } from './src/main/export/renderer'
import { createProject } from './src/shared/defaults'
import { baseClip } from './src/shared/timeline'
import { buildCaptionClips } from './src/shared/captions'
import { buildExportPreset, FALLBACK_CAPTION_PRESETS } from './src/shared/presets'
import { probeMedia } from './src/main/ffmpeg/probe'

export async function run({ ffmpeg, fonts, source, out, temp }) {
  const project = createProject('Smoke test', '16:9', 30)
  const probed = await probeMedia(source)
  project.assets.push({
    id: 'asset_smoke', name: path.basename(source), path: source, kind: 'video',
    storage: 'linked', probe: probed, importedAt: Date.now()
  })
  const video = project.tracks.find((t) => t.kind === 'video')
  const clip = baseClip('video', video.id, 'Smoke clip')
  clip.assetId = 'asset_smoke'
  clip.start = 0
  clip.duration = 2000
  clip.sourceIn = 0
  clip.sourceDuration = probed.durationMs
  project.clips.push(clip)

  // Burn a caption so drawtext + the bundled font are exercised too.
  const captionTrack = project.tracks.find((t) => t.kind === 'caption')
  if (captionTrack) {
    const preset = FALLBACK_CAPTION_PRESETS[0]
    const captions = buildCaptionClips(
      [{ id: 's1', start: 0, end: 2000, text: 'Rendered by Clipwright Studio', words: [] }],
      { start: 0, end: 2000 }, preset, captionTrack.id)
    project.clips.push(...captions)
  }

  const preset = buildExportPreset('1080p', '16:9', 30)
  const renderer = new ProjectRenderer(
    { project, preset, outPath: out, tempDir: temp, fontDir: fonts, burnCaptions: true },
    ffmpeg,
    temp
  )
  const result = await renderer.render()
  return { result, durationMs: probed.durationMs }
}
`
)

const bundle = path.join(root, '.smoke-bundle.mjs')
await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundle,
  // Outside a running Electron app there is no `electron` module; the stub
  // provides the read-only pieces the compositor touches.
  alias: {
    '@shared': path.join(root, 'src/shared'),
    electron: path.join(root, 'tests/stubs/electron-main.ts')
  },
  logLevel: 'error'
})
fs.rmSync(entry, { force: true })

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwright-smoke-'))

// Main-process modules resolve binaries/fonts through the packaged resources
// directory and store the workspace under the app-data path; point both at the
// temp area so the smoke run never touches a real user profile.
process.env.CLIPWRIGHT_RESOURCES = resources
process.env.CLIPWRIGHT_APP_DATA = path.join(temp, 'appdata')
const { run } = await import(pathToFileURL(bundle).href)
const { result } = await run({ ffmpeg: ffmpegExe, fonts: fontsDir, source, out: outFile, temp })
fs.rmSync(bundle, { force: true })

if (!result.ok) fail(`render failed: ${result.error ?? 'unknown error'} (log: ${result.logPath})`)
for (const warning of result.warnings ?? []) ok(`warning: ${warning}`)

/* ---------------------------- verify the output ---------------------------- */

function probeWithFfprobe(file) {
  const json = execFileSync(
    ffprobeExe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { encoding: 'utf8' }
  )
  const parsed = JSON.parse(json)
  return {
    video: parsed.streams.find((stream) => stream.codec_type === 'video'),
    audio: parsed.streams.find((stream) => stream.codec_type === 'audio'),
    duration: Number(parsed.format?.duration ?? 0)
  }
}

/** Fallback: read the same facts out of ffmpeg's input banner. */
function probeWithFfmpeg(file) {
  let banner = ''
  try {
    banner = execFileSync(ffmpegExe, ['-hide_banner', '-i', file], { encoding: 'utf8', stdio: 'pipe' })
  } catch (error) {
    banner = `${error.stderr ?? ''}${error.stdout ?? ''}`
  }
  const videoLine = /Stream #\S+.*?: Video: (\w+).*?, (\w+)(?:\(\w+\))?, (\d+)x(\d+)/.exec(banner)
  const audioLine = /Stream #\S+.*?: Audio: (\w+)/.exec(banner)
  const durationMatch = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(banner)
  const duration = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : 0
  return {
    video: videoLine
      ? { codec_name: videoLine[1], pix_fmt: videoLine[2], width: videoLine[3], height: videoLine[4] }
      : undefined,
    audio: audioLine ? { codec_name: audioLine[1] } : undefined,
    duration
  }
}

/* ------------------------------- verify output ------------------------------- */

mustExist(outFile, 'exported video')
const size = fs.statSync(outFile).size
if (size < 50_000) fail(`exported video is only ${size} bytes — the encoder produced nothing usable`)

let probed
try {
  probed = probeWithFfprobe(outFile)
} catch (error) {
  ok(`ffprobe could not verify this file (${String(error.message).split('\n')[0]}); reading the ffmpeg banner instead`)
  probed = probeWithFfmpeg(outFile)
}

const { video, audio } = probed
if (!video) fail('no video stream in the export')
if (!audio) fail('no audio stream in the export')
if (video.codec_name !== 'h264') fail(`expected h264, got ${video.codec_name}`)
if (video.pix_fmt !== 'yuv420p') fail(`expected yuv420p (player compatibility), got ${video.pix_fmt}`)
if (Number(video.width) !== 1920 || Number(video.height) !== 1080) {
  fail(`expected 1920x1080, got ${video.width}x${video.height}`)
}
if (!(probed.duration > 1.5 && probed.duration < 3.5)) fail(`expected ~2s of video, got ${probed.duration}s`)

ok(`export: ${path.basename(outFile)} ${(size / 1024).toFixed(0)} KB, ${video.width}x${video.height} ${video.codec_name}/${video.pix_fmt}, audio ${audio.codec_name}, ${probed.duration.toFixed(2)}s`)
ok('PASS — the packaged app can import, composite, burn captions and encode')
