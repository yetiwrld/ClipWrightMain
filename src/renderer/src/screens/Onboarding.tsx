/** First-run setup: workspace, hardware check, optional AI. */
import React, { useState } from 'react'
import { ArrowRight, Check, Cpu, FolderOpen, HardDrive, KeyRound, Sparkles, TriangleAlert } from 'lucide-react'
import { useApp } from '../state/app'
import { useEditor } from '../state/editor'
import { Button, Field, Segmented } from '../components/ui'
import { api, errorMessage } from '../lib/api'

export function Onboarding({ onDone }: { onDone: () => void }): JSX.Element {
  const { capabilities, settings, saveSettings, refreshWorkspace } = useApp()
  const notify = useEditor((s) => s.notify)
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'auto' | 'offline' | 'online'>('auto')
  const [importMode, setImportMode] = useState<'managed' | 'linked'>('managed')

  const finish = async () => {
    if (!settings) return
    setBusy(true)
    try {
      await saveSettings({
        ...settings,
        ai: { ...settings.ai, mode },
        storage: { ...settings.storage, defaultImportMode: importMode },
        setup: { firstRunCompleted: true }
      })
      onDone()
    } catch (error) {
      notify({ kind: 'error', title: 'Setup failed', body: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  const steps = [
    {
      title: 'Welcome to Clipwright',
      body: (
        <div className="onboarding__body">
          <p className="onboarding__lead">
            Cut long recordings into finished vertical clips — transcription, moment discovery, a real
            multitrack editor and frame-accurate ffmpeg exports, all on this PC.
          </p>
          <ul className="onboarding__list">
            <li>
              <Check size={14} /> No account, no upload. Your media stays in a folder you choose.
            </li>
            <li>
              <Check size={14} /> Works without any AI service; hosted AI is optional with your own key.
            </li>
            <li>
              <Check size={14} /> Exports are rendered from the timeline, never a screen recording.
            </li>
          </ul>
        </div>
      )
    },
    {
      title: 'Hardware check',
      body: (
        <div className="onboarding__body">
          <div className="check-list">
            <CheckRow ok={capabilities?.ffmpeg} label="ffmpeg" detail={capabilities?.ffmpegVersion ?? 'Required for import and export'} />
            <CheckRow ok={capabilities?.ffprobe} label="ffprobe" detail="Reads media metadata" />
            <CheckRow ok={capabilities?.nvenc} label="NVIDIA encoder" detail="Optional — falls back to software x264" optional />
            <CheckRow ok={capabilities?.whisperAvailable} label="whisper.cpp runtime" detail="Needed for offline transcription" optional />
            <CheckRow ok={capabilities?.ytdlp} label="yt-dlp" detail="Needed to import from video pages" optional />
          </div>
          {!capabilities?.ffmpeg && (
            <div className="callout callout--danger">
              <TriangleAlert size={13} />
              <div>
                ffmpeg was not found. Install it or place ffmpeg.exe where Clipwright can find it, then reopen
                the app. Editing and exporting need it.
              </div>
            </div>
          )}
          <div className="hint">You can review this any time in Settings → Processing.</div>
        </div>
      )
    },
    {
      title: 'How should AI work?',
      body: (
        <div className="onboarding__body">
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { id: 'auto', label: 'Auto' },
              { id: 'offline', label: 'Offline' },
              { id: 'online', label: 'Online' }
            ]}
          />
          <div className="callout">
            <Sparkles size={13} />
            <div>
              {mode === 'offline' && 'Everything runs locally. Transcription needs whisper.cpp plus a downloaded model; moment scoring uses the built-in transcript analyser.'}
              {mode === 'online' && 'Sends transcript text to an OpenAI-compatible provider you configure with your own key. Media files are never uploaded.'}
              {mode === 'auto' && 'Prefers local processing and only uses a provider when you have connected one and local options are unavailable.'}
            </div>
          </div>
          <div className="hint">You can change this at any time. No keys are bundled with Clipwright.</div>
        </div>
      )
    },
    {
      title: 'Where should projects live?',
      body: (
        <div className="onboarding__body">
          <div className="card">
            <div className="row">
              <HardDrive size={15} />
              <span className="mono" style={{ fontSize: 12 }}>
                {useApp.getState().workspace?.root ?? 'Default app data folder'}
              </span>
            </div>
          </div>
          <div className="row">
            <Button
              icon={<FolderOpen size={13} />}
              onClick={async () => {
                const root = await api.workspace.choose()
                if (root && settings) {
                  await api.workspace.set(root.root)
                  await saveSettings({ ...settings, storage: { ...settings.storage, workspaceRoot: root.root } })
                  await refreshWorkspace()
                }
              }}
            >
              Choose folder
            </Button>
          </div>
          <Field label="Importing media">
            <Segmented
              value={importMode}
              onChange={setImportMode}
              options={[
                { id: 'managed', label: 'Copy into project' },
                { id: 'linked', label: 'Link to original' }
              ]}
            />
          </Field>
          <div className="hint">
            Copying keeps projects self-contained and safe from moved files. Linking avoids duplicating large
            recordings.
          </div>
        </div>
      )
    }
  ]

  const current = steps[step]
  return (
    <div className="onboarding">
      <div className="onboarding__card">
        <div className="onboarding__progress">
          {steps.map((_, i) => (
            <span key={i} className={i <= step ? 'onboarding__dot onboarding__dot--on' : 'onboarding__dot'} />
          ))}
        </div>
        <h1 className="onboarding__title">{current.title}</h1>
        {current.body}
        <div className="onboarding__footer">
          <div className="hint">{step + 1} of {steps.length}</div>
          <div className="row">
            {step > 0 && <Button onClick={() => setStep(step - 1)}>Back</Button>}
            {step < steps.length - 1 ? (
              <Button variant="primary" icon={<ArrowRight size={13} />} onClick={() => setStep(step + 1)}>
                Continue
              </Button>
            ) : (
              <Button variant="primary" loading={busy} onClick={() => void finish()} icon={<Check size={13} />}>
                Start using Clipwright
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function CheckRow({
  ok,
  label,
  detail,
  optional
}: {
  ok?: boolean
  label: string
  detail: string
  optional?: boolean
}): JSX.Element {
  return (
    <div className="check-row">
      <span className={ok ? 'check-row__icon check-row__icon--ok' : optional ? 'check-row__icon' : 'check-row__icon check-row__icon--bad'}>
        {ok ? <Check size={12} /> : <Cpu size={12} />}
      </span>
      <div className="grow">
        <div className="row">
          <span style={{ fontWeight: 560, fontSize: 13 }}>{label}</span>
          {optional && <span className="badge">optional</span>}
        </div>
        <div className="hint">{detail}</div>
      </div>
      <span className="hint">{ok ? 'ready' : optional ? 'not installed' : 'missing'}</span>
    </div>
  )
}
