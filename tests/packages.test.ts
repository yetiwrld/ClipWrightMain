/**
 * Project packages: a `.clipwright` file is a real ZIP that round-trips the
 * project document, managed media, transcript and moments.
 *
 * These run against the real main-process modules with a temporary workspace, so
 * they cover the exact code path the File → Export package menu uses.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { tmpDir } from './helpers'
import * as projects from '../src/main/projects'
import { setWorkspaceRoot } from '../src/main/workspace'

const workspace = tmpDir('cw-packages')
const mediaSource = path.join(workspace, 'source-clip.mp4')

function seedProject(): { id: string; mediaFile: string } {
  setWorkspaceRoot(workspace)
  fs.writeFileSync(mediaSource, Buffer.from('not-really-a-video-but-bytes'))
  const project = projects.create('Package test', '9:16', 30)
  const mediaDir = path.join(workspace, 'Projects', project.id, 'media')
  fs.mkdirSync(mediaDir, { recursive: true })
  const managed = path.join(mediaDir, 'source-clip.mp4')
  fs.copyFileSync(mediaSource, managed)
  const updated = {
    ...project,
    assets: [
      {
        ...project.assets[0],
        id: 'asset_1',
        name: 'source-clip.mp4',
        path: managed,
        relativePath: 'media/source-clip.mp4',
        storage: 'managed' as const,
        kind: 'video' as const,
        missing: false
      }
    ]
  }
  // Keep only the seeded asset so the assertions are unambiguous.
  projects.saveProjectSync({ ...project })
  projects.saveProjectSync(updated)
  return { id: project.id, mediaFile: managed }
}

describe('project packages (.clipwright)', () => {
  it('round-trips a project with media through a single zip file', async () => {
    const { id, mediaFile } = seedProject()
    const file = await projects.exportPackage(id, true)

    expect(fs.existsSync(file)).toBe(true)
    expect(file.endsWith('.clipwright')).toBe(true)
    expect(fs.statSync(file).isFile()).toBe(true)

    // The container is an ordinary zip that any tool can open.
    const entries = unzipSync(new Uint8Array(fs.readFileSync(file)))
    expect(Object.keys(entries)).toContain('project.json')
    expect(Object.keys(entries)).toContain('media/source-clip.mp4')
    const manifest = JSON.parse(Buffer.from(entries['project.json']).toString('utf8'))
    expect(manifest.kind).toBe('clipwright-package')
    expect(manifest.project.assets[0].path).toBe('media/source-clip.mp4')
    // Manifest never leaks the exporting machine's absolute path.
    expect(JSON.stringify(manifest)).not.toContain(mediaFile.replace(/\\/g, '\\\\'))

    const imported = await projects.importPackage(file)
    expect(imported.id).not.toBe(id)
    expect(imported.name).toBe('Package test')
    const asset = imported.assets.find((a) => a.name === 'source-clip.mp4')!
    expect(asset.missing).toBe(false)
    expect(fs.existsSync(asset.path)).toBe(true)
    expect(fs.readFileSync(asset.path, 'utf8')).toBe('not-really-a-video-but-bytes')
    // Imported media is copied into the new project folder, not shared.
    expect(asset.path).toContain(imported.id)
  })

  it('omits media when the package is created without it, and marks it missing on import', async () => {
    const { id } = seedProject()
    const file = await projects.exportPackage(id, false)
    const entries = unzipSync(new Uint8Array(fs.readFileSync(file)))
    expect(Object.keys(entries).some((name) => name.startsWith('media/'))).toBe(false)

    const imported = await projects.importPackage(file)
    expect(imported.assets.find((a) => a.name === 'source-clip.mp4')!.missing).toBe(true)
  })

  it('still accepts a legacy folder package', async () => {
    const folder = path.join(tmpDir('cw-folder-pkg'), 'Legacy.clipwright')
    fs.mkdirSync(path.join(folder, 'media'), { recursive: true })
    const source = projects.create('Legacy project', '1:1', 30)
    fs.writeFileSync(path.join(folder, 'media', 'b-roll.mp4'), 'legacy-bytes')
    fs.writeFileSync(
      path.join(folder, 'project.json'),
      JSON.stringify({
        kind: 'clipwright-package',
        version: 1,
        project: {
          ...source,
          assets: [
            {
              ...source.assets[0],
              id: 'asset_legacy',
              name: 'b-roll.mp4',
              path: 'media/b-roll.mp4',
              relativePath: 'media/b-roll.mp4',
              storage: 'managed',
              kind: 'video',
              missing: false
            }
          ]
        }
      })
    )

    const imported = await projects.importPackage(folder)
    const asset = imported.assets.find((a) => a.name === 'b-roll.mp4')!
    expect(asset.missing).toBe(false)
    expect(fs.readFileSync(asset.path, 'utf8')).toBe('legacy-bytes')
  })

  it('rejects junk instead of half-importing it', async () => {
    const bogus = path.join(tmpDir('cw-junk'), 'broken.clipwright')
    fs.writeFileSync(bogus, 'this is not a zip')
    await expect(projects.importPackage(bogus)).rejects.toThrow(/damaged|could not|not a Clipwright/i)

    const empty = path.join(tmpDir('cw-junk2'), 'empty.clipwright')
    fs.writeFileSync(empty, '')
    await expect(projects.importPackage(empty)).rejects.toThrow(/damaged|no project/i)

    await expect(projects.importPackage(path.join(tmpDir('cw-junk3'), 'nope.clipwright'))).rejects.toThrow(
      /not be found/i
    )
  })
})
