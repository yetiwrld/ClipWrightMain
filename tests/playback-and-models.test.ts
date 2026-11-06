/**
 * Regression tests for the 1.0.4 bug batch, one per user report.
 *
 *   • "Transcription failed — No speech model found for `base.en`": the model
 *     lookup compared the catalogue id (`ggml-base.en`) against whatever name
 *     the transcriber asked for (`base.en`, a filename, or a full path), so a
 *     model that was sitting on disk was never found.
 *   • "Played, paused, changed the aspect ratio, never played again": playing
 *     from a playhead parked exactly on the end of the timeline silently stopped
 *     on the clock's first frame.
 *   • Space did nothing unless the preview happened to have focus.
 */
// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProject } from '@shared/defaults'

// React only runs effects synchronously inside act() when this is set.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { baseClip, defaultTracks } from '@shared/timeline'

/* --------------------------- whisper model lookup -------------------------- */

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-models-'))

beforeEach(() => {
  process.env.CLIPWRIGHT_TEST_WORKSPACE = workspace
})

afterEach(() => {
  fs.rmSync(path.join(workspace, 'Models'), { recursive: true, force: true })
})

async function models() {
  const { settingsStore } = await import('../src/main/settings')
  const { setWorkspaceRoot } = await import('../src/main/workspace')
  setWorkspaceRoot(workspace)
  settingsStore().update({ storage: { ...settingsStore().get().storage, workspaceRoot: workspace } })
  return import('../src/main/ai/models')
}

describe('whisper model resolution', () => {
  it('finds a downloaded model whatever name the caller uses', async () => {
    const { modelPath, MODEL_CATALOGUE } = await models()
    const base = MODEL_CATALOGUE.find((m) => m.id === 'ggml-base.en')!
    const dir = path.join(workspace, 'Models')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, base.filename)
    fs.writeFileSync(file, 'x')

    // Every spelling the app or a transcript can produce must resolve.
    for (const id of ['base.en', 'ggml-base.en', 'ggml-base.en.bin', base.filename]) {
      expect(modelPath(id), `id: ${id}`).toBe(file)
    }
    expect(modelPath('small.en')).toBeNull()
  })

  it('accepts a hand-copied ggml file that is not in the catalogue', async () => {
    const { modelPath } = await models()
    const dir = path.join(workspace, 'Models')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'ggml-large-v3-turbo.bin')
    fs.writeFileSync(file, 'x')
    expect(modelPath('large-v3-turbo')).toBe(file)
    expect(modelPath('ggml-large-v3-turbo.bin')).toBe(file)
  })

  it('reports any local ggml model so transcription can fall back', async () => {
    const { findAnyLocalWhisperModel } = await models()
    const dir = path.join(workspace, 'Models')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'ggml-tiny.en.bin'), 'x')
    // A faster-whisper cache file is a different format and must be ignored.
    fs.writeFileSync(path.join(dir, 'model.bin'), 'x')
    expect(findAnyLocalWhisperModel()?.name).toBe('ggml-tiny.en.bin')
  })
})

/* -------------------------------- playback -------------------------------- */

async function editorWithClip() {
  const { useEditor } = await import('../src/renderer/src/state/editor')
  const { togglePlayback, timelineEnd } = await import('../src/renderer/src/state/playback')
  const project = createProject('play', '9:16', 30)
  const clip = {
    ...baseClip('video', project.tracks.find((t) => t.kind === 'video')!.id, 'clip.mp4'),
    assetId: 'a1',
    start: 0,
    duration: 5000,
    sourceIn: 0,
    sourceOut: 5000
  }
  useEditor.getState().setProject({ ...project, clips: [clip] })
  useEditor.getState().setPlaying(false)
  return { store: useEditor, togglePlayback, timelineEnd }
}

describe('playback toggle', () => {
  it('rewinds instead of dying when the playhead sits on the end', async () => {
    const { store, togglePlayback, timelineEnd } = await editorWithClip()
    expect(timelineEnd(store.getState().project)).toBe(5000)

    // This is exactly the state a finished playback leaves behind.
    store.getState().setPlayhead(5000, { snap: false })
    togglePlayback()
    expect(store.getState().playing).toBe(true)
    expect(store.getState().playhead).toBe(0)

    togglePlayback()
    expect(store.getState().playing).toBe(false)
  })

  it('resumes from the middle without rewinding', async () => {
    const { store, togglePlayback } = await editorWithClip()
    store.getState().setPlayhead(2000, { snap: false })
    togglePlayback()
    expect(store.getState().playing).toBe(true)
    expect(store.getState().playhead).toBe(2000)
  })

  it('does not flip a play flag on an empty timeline', async () => {
    const { useEditor } = await import('../src/renderer/src/state/editor')
    const { togglePlayback } = await import('../src/renderer/src/state/playback')
    useEditor.getState().setProject({ ...createProject('empty', '9:16', 30), clips: [] })
    useEditor.getState().setPlaying(false)
    togglePlayback()
    expect(useEditor.getState().playing).toBe(false)
  })

  it('survives an aspect-ratio change while paused', async () => {
    const { store, togglePlayback } = await editorWithClip()
    const project = store.getState().project!
    store.getState().apply((p) => ({ ...p, canvas: { ...p.canvas, width: 1080, height: 1920 } }), 'Canvas')
    expect(store.getState().project!.canvas.width).toBe(1080)
    // Playing and stopping repeatedly is what used to break after the resize.
    for (let i = 0; i < 3; i++) {
      store.getState().setPlayhead(5000, { snap: false })
      togglePlayback()
      expect(store.getState().playing).toBe(true)
      togglePlayback()
      expect(store.getState().playing).toBe(false)
    }
  })
})

/* -------------------------------- Spacebar -------------------------------- */

describe('global Space shortcut', () => {
  async function mount(onPlayPause: () => void) {
    const { useGlobalShortcuts } = await import('../src/renderer/src/hooks/useProjectPersistence')
    const React = (await import('react')).default
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react-dom/test-utils')
    const container = document.createElement('div')
    document.body.appendChild(container)
    function Harness() {
      useGlobalShortcuts(
        React.useMemo(
          () => ({
            playPause: onPlayPause,
            save: () => undefined,
            undo: () => undefined
          }),
          []
        )
      )
      return React.createElement(
        'div',
        null,
        React.createElement('button', { id: 'toolbar' }, 'Tool'),
        React.createElement('input', { id: 'text', type: 'text' }),
        React.createElement('input', { id: 'slider', type: 'range', min: 0, max: 10 }),
        React.createElement('select', { id: 'picker' }, React.createElement('option', null, 'a'))
      )
    }
    const root = createRoot(container)
    act(() => root.render(React.createElement(Harness)))
    // Let the keydown listener effect attach before anything is dispatched.
    await act(async () => {
      await Promise.resolve()
    })
    return { container, root, act }
  }

  function press(act: (cb: () => void) => void, target: EventTarget, key = ' ') {
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
  }

  it('fires from the body, a button, a select and a slider', async () => {
    let hits = 0
    const { container, act } = await mount(() => {
      hits += 1
    })
    press(act, document.body)
    press(act, container.querySelector('#toolbar')!)
    press(act, container.querySelector('#picker')!)
    press(act, container.querySelector('#slider')!)
    expect(hits).toBe(4)
    container.remove()
  })

  it('never steals Space from a text field', async () => {
    let hits = 0
    const { container, act } = await mount(() => {
      hits += 1
    })
    press(act, container.querySelector('#text')!)
    expect(hits).toBe(0)
    container.remove()
  })
})
