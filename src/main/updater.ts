/**
 * GitHub release updater.
 *
 * • Checks the repository's GitHub Releases API for the newest compatible
 *   release (stable or prerelease channel).
 * • Downloads the Windows installer asset with a progress callback.
 * • Verifies authenticity before anything is executed:
 *     1. if a `.sha256` asset is published the digest must match,
 *     2. otherwise the release must carry a `checksums.json` listing the digest,
 *     3. otherwise the download is *not* installed — the user is shown the release
 *        page and must install manually. We never silently run an unverified file.
 * • Installation is always user-initiated. Projects, settings, media and API
 *   provider configuration live outside the install directory and survive updates.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { shell, app } from 'electron'
import { REPO_NAME, REPO_OWNER } from '@shared/defaults'
import { settingsStore } from './settings'
import { workspaceLayout } from './workspace'
import { log } from './logger'
import type { UpdateInfo, UpdateProgress } from '@shared/types'

interface GithubRelease {
  tag_name: string
  name?: string
  body?: string
  prerelease: boolean
  draft: boolean
  published_at: string
  html_url: string
  assets: { name: string; browser_download_url: string; size: number }[]
}

const API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases`

export function currentVersion(): string {
  return app.getVersion()
}

export function compareVersions(a: string, b: string): number {
  const clean = (v: string) => v.replace(/^v/i, '').split('-')[0].split('.').map((n) => Number(n) || 0)
  const pa = clean(a)
  const pb = clean(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

async function fetchReleases(): Promise<GithubRelease[]> {
  const response = await fetch(API, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'ClipwrightStudio'
    }
  })
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? 'The release repository could not be found.'
        : `GitHub returned HTTP ${response.status}. Try again later.`
    )
  }
  return (await response.json()) as GithubRelease[]
}

/**
 * Choose the asset an installed copy should download.
 *
 * Exported for tests and for the Update screen: the portable build must never be
 * picked, because launching it would not upgrade the installed copy.
 */
export function pickInstallerAsset<T extends { name: string }>(assets: T[]): T | undefined {
  return (
    assets.find((a) => /\.exe$/i.test(a.name) && /setup/i.test(a.name)) ??
    assets.find((a) => /\.exe$/i.test(a.name) && !/portable/i.test(a.name)) ??
    assets.find((a) => /\.exe$/i.test(a.name))
  )
}

export async function checkForUpdates(manual = false): Promise<UpdateInfo> {
  const channel = settingsStore().get().updates.channel
  const current = currentVersion()
  try {
    const releases = await fetchReleases()
    const usable = releases.filter((r) => !r.draft && (channel === 'prerelease' || !r.prerelease))
    if (!usable.length) {
      return {
        currentVersion: current,
        available: false,
        checkedAt: Date.now(),
        notes: 'No published releases yet. Build the workflow will create one when a version tag is pushed.'
      }
    }
    const sorted = usable.sort((a, b) => compareVersions(b.tag_name, a.tag_name))
    const latest = sorted[0]
    /*
     * Prefer the installer, never the portable single-file build: running the
     * portable executable would not upgrade the installed copy, it would just
     * launch a second one. Fall back to any other asset only if no Setup file
     * exists at all, so the user is never offered nothing.
     */
    const installer = pickInstallerAsset(latest.assets)
    const checksumAsset = latest.assets.find((a) => /\.sha256$|checksums\.json$/i.test(a.name))
    const available = compareVersions(latest.tag_name, current) > 0
    const info: UpdateInfo = {
      currentVersion: current,
      latestVersion: latest.tag_name.replace(/^v/i, ''),
      available,
      releaseUrl: latest.html_url,
      notes: latest.body ?? '',
      publishedAt: latest.published_at,
      assetName: installer?.name,
      assetUrl: installer?.browser_download_url,
      assetSize: installer?.size,
      checksumUrl: checksumAsset?.browser_download_url,
      prerelease: latest.prerelease,
      checkedAt: Date.now()
    }
    settingsStore().update({
      updates: { ...settingsStore().get().updates, lastCheckedAt: Date.now() } as never
    })
    log.info('update', `checked (manual=${manual}); current=${current} latest=${info.latestVersion} available=${available}`)
    return info
  } catch (error) {
    log.warn('update', `check failed: ${String(error)}`)
    return {
      currentVersion: current,
      available: false,
      checkedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

let activeDownload: AbortController | null = null

export function cancelUpdateDownload(): void {
  activeDownload?.abort()
  activeDownload = null
}

export async function downloadUpdate(
  info: UpdateInfo,
  onProgress: (progress: UpdateProgress) => void
): Promise<{ ok: boolean; installerPath?: string; error?: string; needsManualInstall?: boolean }> {
  if (!info.assetUrl || !info.assetName) {
    return { ok: false, error: 'This release does not publish a Windows installer asset.' }
  }
  const dir = path.join(workspaceLayout().cache, 'updates')
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, info.assetName)
  const partial = `${target}.part`
  const controller = new AbortController()
  activeDownload = controller
  try {
    const response = await fetch(info.assetUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'ClipwrightStudio' }
    })
    if (!response.ok || !response.body) return { ok: false, error: `Download failed (HTTP ${response.status}).` }
    const total = Number(response.headers.get('content-length') ?? info.assetSize ?? 0)
    const hash = createHash('sha256')
    let received = 0
    const stream = fs.createWriteStream(partial)
    const reader = response.body.getReader()
    let last = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        const buf = Buffer.from(value)
        stream.write(buf)
        hash.update(buf)
        received += buf.length
        const now = Date.now()
        if (now - last > 200) {
          last = now
          onProgress({
            stage: 'downloading',
            percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0,
            receivedBytes: received,
            totalBytes: total
          })
        }
      }
    }
    await new Promise<void>((resolve) => stream.end(resolve))
    const digest = hash.digest('hex')

    // --- authenticity verification ---
    onProgress({ stage: 'verifying', percent: 99, receivedBytes: received, totalBytes: total })
    const expected = await fetchExpectedDigest(info)
    if (expected) {
      if (expected.toLowerCase() !== digest) {
        fs.unlinkSync(partial)
        return {
          ok: false,
          error: `The downloaded file failed verification (expected ${expected.slice(0, 12)}…, got ${digest.slice(0, 12)}…). It was deleted.`
        }
      }
      log.info('update', 'download verified against published checksum')
    } else {
      // No published digest: do not execute an unverified binary.
      fs.renameSync(partial, target)
      return {
        ok: false,
        needsManualInstall: true,
        installerPath: target,
        error:
          'This release does not publish a checksum, so Clipwright will not run the installer automatically. The download is saved and the release page will open so you can install it yourself.'
      }
    }
    fs.renameSync(partial, target)
    onProgress({ stage: 'ready', percent: 100, receivedBytes: received, totalBytes: total, installerPath: target })
    return { ok: true, installerPath: target }
  } catch (error) {
    try {
      if (fs.existsSync(partial)) fs.unlinkSync(partial)
    } catch {
      /* ignore */
    }
    if (controller.signal.aborted) return { ok: false, error: 'Download cancelled.' }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    activeDownload = null
  }
}

async function fetchExpectedDigest(info: UpdateInfo): Promise<string | null> {
  if (!info.checksumUrl || !info.assetName) return null
  try {
    const response = await fetch(info.checksumUrl, { headers: { 'user-agent': 'ClipwrightStudio' } })
    if (!response.ok) return null
    const text = await response.text()
    if (info.checksumUrl.endsWith('.json')) {
      const json = JSON.parse(text) as Record<string, string> | { files?: Record<string, string> }
      const map = ('files' in json && json.files ? json.files : json) as Record<string, string>
      return map[info.assetName] ?? null
    }
    // Standard `<digest>  <filename>` format.
    for (const line of text.split('\n')) {
      const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim())
      if (match && match[2].trim() === info.assetName) return match[1]
      if (match && !match[2].includes(info.assetName)) continue
    }
    const single = /^([a-f0-9]{64})\b/i.exec(text.trim())
    return single ? single[1] : null
  } catch {
    return null
  }
}

/** Launch the verified installer. The app quits so files can be replaced. */
export function installUpdate(installerPath: string): { launched: boolean; error?: string } {
  if (!fs.existsSync(installerPath)) return { launched: false, error: 'The installer file is missing.' }
  try {
    const child = shell.openPath(installerPath)
    void child
    log.info('update', 'installer launched; quitting for update')
    setTimeout(() => app.quit(), 1200)
    return { launched: true }
  } catch (error) {
    return { launched: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function openReleasePage(url: string): void {
  if (/^https:\/\/github\.com\//.test(url)) void shell.openExternal(url)
}

export function openDownloadedFile(filePath: string): void {
  shell.showItemInFolder(filePath)
}
