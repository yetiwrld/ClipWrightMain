import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { packageArgument, PACKAGE_EXTENSION } from '../src/main/open-package'
import { tmpDir } from './helpers'

const dir = tmpDir('cw-open')
const good = path.join(dir, 'Interview cut.clipwright')
fs.writeFileSync(good, 'placeholder')

describe('opening .clipwright from the shell', () => {
  it('ignores the executable path, switches and unrelated files', () => {
    expect(packageArgument(['C:/Apps/Clipwright Studio.exe'])).toBeNull()
    expect(packageArgument(['C:/Apps/Clipwright Studio.exe', '--inspect=9229'])).toBeNull()
    expect(packageArgument(['C:/Apps/Clipwright Studio.exe', 'C:/tmp/notes.txt'])).toBeNull()
    expect(packageArgument(['C:/Apps/Clipwright Studio.exe', '--enable-logging', 'C:/tmp/logo.png'])).toBeNull()
  })

  it('finds a package among Electron flags and resolves relative paths', () => {
    expect(packageArgument(['app.exe', '--no-sandbox', good])).toBe(good)
    expect(packageArgument(['app.exe', 'Interview cut.clipwright'], dir)).toBe(good)
    expect(PACKAGE_EXTENSION).toBe('.clipwright')
  })

  it('skips args that point at something that is not there', () => {
    // A stale shortcut target should not crash the launch; it is simply ignored.
    expect(packageArgument(['app.exe', path.join(dir, 'deleted.clipwright')])).toBeNull()
  })
})
