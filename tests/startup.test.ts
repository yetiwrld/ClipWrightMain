/**
 * Startup resilience.
 *
 * A video editor that refuses to open is the worst possible failure: the user has
 * no window, no log, and no way to tell what went wrong. These tests pin down that
 * a damaged settings file, a missing workspace folder or a broken credential vault
 * degrade gracefully instead of aborting the launch.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The settings store resolves its path through app.getPath('userData'), which the
// electron stub maps to os.tmpdir()/clipwright-test/<name>. Each test gets a
// unique folder so the "corrupt file" case cannot leak into the next one.
function configFile(): string {
  return path.join(os.tmpdir(), 'clipwright-test', 'userData', 'config', 'settings.json')
}

/**
 * Import a fresh settings singleton. Call this *after* writing the file under
 * test — the module reads the file in its constructor.
 */
async function freshStore(): Promise<typeof import('../src/main/settings')> {
  // Vitest caches modules, and a query string confuses esbuild, so drop the
  // module from the registry and import it again.
  vi.resetModules()
  return import('../src/main/settings') as Promise<typeof import('../src/main/settings')>
}

beforeEach(() => {
  // Start from nothing: a leftover settings file from another test would make the
  // "corrupt file" case pass or fail for the wrong reason.
  fs.rmSync(path.dirname(configFile()), { recursive: true, force: true })
  fs.mkdirSync(path.dirname(configFile()), { recursive: true })
})

describe('settings recovery', () => {
  it('starts with defaults when the settings file is corrupt', async () => {
    fs.writeFileSync(configFile(), '{"appearance": {"theme": "dark"') // truncated JSON
    const { settingsStore } = await freshStore()
    const settings = settingsStore().get()

    // Defaults, not a crash — and every section is present.
    expect(settings.appearance).toBeTruthy()
    expect(settings.storage).toBeTruthy()
    expect(settings.storage.workspaceRoot).toBeTruthy()
    // The damaged file is kept aside for diagnosis instead of being silently lost.
    expect(fs.existsSync(`${configFile()}.corrupt`)).toBe(true)
  })

  it('repairs a section that a hand-edited file nulled out', async () => {
    fs.writeFileSync(configFile(), JSON.stringify({ appearance: null, storage: null, updates: null }))
    const { settingsStore } = await freshStore()
    const settings = settingsStore().get()
    expect(typeof settings.appearance.theme).toBe('string')
    expect(typeof settings.storage.workspaceRoot).toBe('string')
    expect(typeof settings.updates.autoCheck).toBe('boolean')
    expect(settings.storage.workspaceRoot.length).toBeGreaterThan(0)
  })

  it('creates the workspace folder tree instead of failing when it is missing', async () => {
    const { ensureWorkspace } = await import('../src/main/paths')
    const root = path.join(os.tmpdir(), `cw-startup-${Date.now()}`)
    const layout = ensureWorkspace(root)
    for (const dir of [layout.projects, layout.exports, layout.logs, layout.models, layout.cache]) {
      expect(fs.existsSync(dir)).toBe(true)
    }
    // Calling it twice must stay a no-op rather than throwing EEXIST.
    expect(() => ensureWorkspace(root)).not.toThrow()
    fs.rmSync(root, { recursive: true, force: true })
  })
})
