import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { readLogTail } from '../src/main/handlers-support'
import { setWorkspaceRoot } from '../src/main/workspace'
import { log } from '../src/main/logger'
import { tmpDir } from './helpers'

describe('log viewer', () => {
  it('returns an empty result instead of throwing when nothing was logged', () => {
    setWorkspaceRoot(tmpDir('cw-logs-empty'))
    const tail = readLogTail(50)
    expect(tail.text).toBe('')
    expect(tail.bytes).toBe(0)
    expect(tail.file.endsWith('clipwright.log')).toBe(true)
  })

  it('returns only the requested number of trailing lines', () => {
    const root = tmpDir('cw-logs')
    setWorkspaceRoot(root)
    const file = path.join(root, 'Logs', 'clipwright.log')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`)
    fs.writeFileSync(file, `${lines.join('\n')}\n`)

    const tail = readLogTail(10)
    const returned = tail.text.split('\n')
    expect(returned.length).toBe(10)
    // The file ends with a newline, so the empty tail segment is dropped and the
    // window is the last ten *lines*: 492..500 would be nine, so 491..500.
    expect(returned[0]).toBe('line 491')
    expect(returned[9]).toBe('line 500')
    expect(tail.bytes).toBeGreaterThan(0)
  })

  it('shows what the app actually writes', () => {
    setWorkspaceRoot(tmpDir('cw-logs-live'))
    log.info('test', 'diagnostic entry for the log viewer')
    const tail = readLogTail(20)
    expect(tail.text).toContain('diagnostic entry for the log viewer')
    expect(tail.text).toContain('[INFO] test:')
  })
})
