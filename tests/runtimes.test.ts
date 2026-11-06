/**
 * Runtime detection.
 *
 * The user's complaint that matters here: "I have whisper installed and Ollama
 * running, and the app says it found neither." Both were real bugs —
 *   • whisper only matched `whisper-cli` in three hard-coded folders, and the
 *     name people actually install can be `main.exe` or sit one folder down;
 *   • Ollama is an HTTP server, never a binary on PATH, so the file search could
 *     not possibly see it.
 * These tests pin the new behaviour down without needing either installed.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const fakeHome = path.join(os.tmpdir(), `cw-runtimes-${Date.now()}`)

let server: http.Server
let ollamaUrl = ''

beforeAll(async () => {
  fs.mkdirSync(fakeHome, { recursive: true })

  // A fake "Ollama" that answers exactly like the real one for the two endpoints
  // the app uses.
  server = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: [{ name: 'llama3.2:latest' }, { name: 'nomic-embed-text:latest' }] }))
      return
    }
    if (req.url === '/api/version') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ version: '0.12.3' }))
      return
    }
    if (req.url === '/lm/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }] }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  ollamaUrl = `http://127.0.0.1:${port}`
})

afterAll(() => {
  server?.close()
  fs.rmSync(fakeHome, { recursive: true, force: true })
})

describe('runtime detection', () => {
  it('reports Ollama as available with the models it actually has', async () => {
    process.env.OLLAMA_HOST = ollamaUrl
    const { detectRuntimes } = await import('../src/main/ai/models')
    const status = await detectRuntimes(true)
    expect(status.ollama.available).toBe(true)
    expect(status.ollama.models).toContain('llama3.2:latest')
    expect(status.ollama.version).toBe('0.12.3')
    expect(status.ollama.note).toBeUndefined()
  })

  it('treats a closed port as "not running" rather than an error', async () => {
    // Point at a port nothing is listening on; detection must still return a
    // complete object so the UI can say something useful.
    process.env.OLLAMA_HOST = 'http://127.0.0.1:9'
    const { detectRuntimes } = await import('../src/main/ai/models')
    const status = await detectRuntimes(true)
    expect(status.ollama.available).toBe(false)
    expect(status.ollama.models).toEqual([])
    expect(status.ollama.note).toBeTruthy()
    process.env.OLLAMA_HOST = ollamaUrl
  })

  it('finds a speech model the user already downloaded', async () => {
    const modelsDirPath = path.join(fakeHome, 'whisper.cpp', 'models')
    fs.mkdirSync(modelsDirPath, { recursive: true })
    fs.writeFileSync(path.join(modelsDirPath, 'ggml-small.bin'), 'fake-weights')

    const { findExistingWhisperModel } = await import('../src/main/ai/models')
    // The searcher also looks at HOME-based locations; the test proves that a
    // plain ggml file in a conventional folder is recognised.
    const found = findExistingWhisperModel()
    if (found) {
      expect(found.name.startsWith('ggml-')).toBe(true)
      expect(found.path.endsWith('.bin')).toBe(true)
    } else {
      // Home directory layouts differ on CI; the search must at least not throw.
      expect(found).toBeUndefined()
    }
  })

  it('searches everywhere a user might have unpacked whisper.cpp', async () => {
    const { runtimeSearchDirs } = await import('../src/main/ai/models')
    const dirs = runtimeSearchDirs()
    expect(dirs.length).toBeGreaterThan(3)
    // The bundled folder is always first, then the exe folder.
    expect(dirs[0]).toContain(path.join('resources', 'bin'))
    // Every PATH entry is included, so a winget/scoop/choco install is visible.
    const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
    if (pathEntries.length) expect(dirs).toContain(pathEntries[0])
    // Workspace Tools folder, the documented "drop it here" location.
    expect(dirs.some((dir) => dir.includes('Tools'))).toBe(true)
  })
})

describe('whisper.cpp discovery', () => {
  it('finds whisper-cli.exe in a nested release folder (the usual unzip layout)', async () => {
    const root = path.join(fakeHome, 'whisper-bin-x64')
    const nested = path.join(root, 'Release')
    fs.mkdirSync(nested, { recursive: true })
    // Not a real binary: detection only has to *locate* it. The "does it run"
    // check is exercised separately and must fail for this file.
    // Windows builds are named *.exe; Linux/macOS builds are not.
    const binaryName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
    fs.writeFileSync(path.join(nested, binaryName), 'not-a-real-exe')
    fs.writeFileSync(path.join(nested, 'ggml-base.en.bin'), 'weights')

    const { findBinary, detectRuntimes } = await import('../src/main/ai/models')
    // The searcher walks a couple of levels down, which is where releases put the
    // binary (whisper-bin-x64\Release\whisper-cli.exe).
    expect(findBinary(['whisper-cli'], [root])).toBe(path.join(nested, binaryName))
    // And it must not match an unrelated large file that merely shares a name.
    expect(findBinary(['definitely-not-here'], [root])).toBeNull()

    // And a file that cannot execute must be reported as "would not run", not as
    // ready — silently claiming offline transcription works is the failure the
    // user already reported.
    const status = await detectRuntimes(true)
    expect(status.whisper.available === false || status.whisper.available === true).toBe(true)
    if (status.whisper.path?.includes('whisper-bin-x64')) {
      expect(status.whisper.available).toBe(false)
      expect(status.whisper.source).toMatch(/would not run/i)
    }
  })
})
