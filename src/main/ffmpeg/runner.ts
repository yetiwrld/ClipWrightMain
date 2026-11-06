import { spawn, type ChildProcess } from 'node:child_process'

export interface RunOptions {
  timeoutMs?: number
  onStderr?: (chunk: string) => void
  onStdout?: (chunk: string) => void
  signal?: AbortSignal
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
}

const running = new Map<number, ChildProcess>()

export function killAll(): void {
  for (const child of running.values()) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
  running.clear()
}

export function runProcess(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      windowsHide: true,
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    if (child.pid) running.set(child.pid, child)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs ?? 120_000)

    const onAbort = () => {
      aborted = true
      child.kill('SIGKILL')
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (buf: Buffer) => {
      const text = buf.toString()
      stdout += text
      opts.onStdout?.(text)
    })
    child.stderr?.on('data', (buf: Buffer) => {
      const text = buf.toString()
      stderr += text
      opts.onStderr?.(text)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (child.pid) running.delete(child.pid)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (child.pid) running.delete(child.pid)
      const result: RunResult = { code: code ?? -1, stdout, stderr, timedOut, aborted }
      if (code === 0) resolve(result)
      else if (aborted || timedOut) resolve(result)
      else resolve(result)
    })
  })
}
