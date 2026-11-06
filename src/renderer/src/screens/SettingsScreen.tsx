/** Settings: AI providers, local models, processing, storage, export, appearance, updates, logs. */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  Boxes,
  Check,
  Cpu,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  HardDrive,
  KeyRound,
  Package,
  Palette,
  Plus,
  RefreshCw,
  Save,
  ScrollText,
  Server,
  Shield,
  Sliders,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import { useApp } from '../state/app'
import { useEditor } from '../state/editor'
import { Badge, Button, EmptyState, Field, Modal, ProgressBar, Segmented, Slider, Switch } from '../components/ui'
import { api, errorMessage } from '../lib/api'
import { formatBytes } from '@shared/time'
import type {
  CapabilityReport,
  LocalModel,
  ModelDownloadProgress,
  ProcessingMode,
  ProviderConfig,
  Settings,
  UpdateInfo,
  UpdateProgress,
  WorkspaceInfo
} from '@shared/types'
import type { AppInfo } from '@shared/ipc'

type Section =
  | 'ai'
  | 'models'
  | 'processing'
  | 'storage'
  | 'export'
  | 'appearance'
  | 'updates'
  | 'logs'
  | 'about'

interface ProviderTemplate {
  id: string
  name: string
  baseUrl: string
  models: string[]
  note?: string
}

export function SettingsScreen(): JSX.Element {
  const { settings, saveSettings, providers, models, info, capabilities, workspace, refreshProviders, refreshModels, refreshWorkspace } =
    useApp()
  const notify = useEditor((s) => s.notify)
  const [section, setSection] = useState<Section>('ai')
  const [draft, setDraft] = useState<Settings | null>(settings)
  const [saving, setSaving] = useState(false)

  useEffect(() => setDraft(settings), [settings])

  const patch = (next: Partial<Settings>) => setDraft((d) => (d ? { ...d, ...next } : d))

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      await saveSettings(draft)
      await refreshWorkspace()
      notify({ kind: 'success', title: 'Settings saved' })
    } catch (error) {
      notify({ kind: 'error', title: 'Could not save settings', body: errorMessage(error) })
    } finally {
      setSaving(false)
    }
  }

  const sections: { id: Section; label: string; icon: React.ReactNode }[] = [
    { id: 'ai', label: 'AI providers', icon: <KeyRound size={13} /> },
    { id: 'models', label: 'Local models', icon: <Boxes size={13} /> },
    { id: 'processing', label: 'Processing', icon: <Cpu size={13} /> },
    { id: 'storage', label: 'Storage', icon: <HardDrive size={13} /> },
    { id: 'export', label: 'Export', icon: <Sliders size={13} /> },
    { id: 'appearance', label: 'Appearance', icon: <Palette size={13} /> },
    { id: 'updates', label: 'Updates', icon: <Package size={13} /> },
    { id: 'logs', label: 'Logs', icon: <ScrollText size={13} /> },
    { id: 'about', label: 'About', icon: <Shield size={13} /> }
  ]

  if (!draft) return <div className="hint">Loading settings…</div>

  return (
    <div className="settings">
      <nav className="settings__nav">
        {sections.map((item) => (
          <button
            key={item.id}
            className={clsx('settings__nav-item', section === item.id && 'settings__nav-item--active')}
            onClick={() => setSection(item.id)}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </nav>
      <div className="settings__body">
        <header className="settings__header">
          <h2 className="screen-title">{sections.find((s) => s.id === section)?.label}</h2>
          <div className="row">
            <Button onClick={() => setDraft(settings)} disabled={!settings}>
              Revert
            </Button>
            <Button variant="primary" icon={<Save size={13} />} loading={saving} onClick={() => void save()}>
              Save changes
            </Button>
          </div>
        </header>

        {section === 'ai' && (
          <ProvidersSection
            providers={providers}
            draft={draft}
            patch={patch}
            onChanged={async () => {
              await refreshProviders()
              await refreshModels()
            }}
          />
        )}
        {section === 'models' && <ModelsSection models={models} onChanged={refreshModels} />}
        {section === 'processing' && <ProcessingSection draft={draft} patch={patch} capabilities={capabilities} />}
        {section === 'storage' && <StorageSection draft={draft} patch={patch} workspace={workspace} />}
        {section === 'export' && <ExportSection draft={draft} patch={patch} capabilities={capabilities} />}
        {section === 'appearance' && <AppearanceSection draft={draft} patch={patch} />}
        {section === 'updates' && <UpdatesSection />}
        {section === 'logs' && <LogsSection />}
        {section === 'about' && <AboutSection info={info} capabilities={capabilities} />}
      </div>
    </div>
  )
}

/* ------------------------------- providers ------------------------------- */

function ProvidersSection({
  providers,
  draft,
  patch,
  onChanged
}: {
  providers: ProviderConfig[]
  draft: Settings
  patch: (next: Partial<Settings>) => void
  onChanged: () => Promise<void>
}): JSX.Element {
  const notify = useEditor((s) => s.notify)
  const [adding, setAdding] = useState(false)
  const [templates, setTemplates] = useState<ProviderTemplate[]>([])
  const [testing, setTesting] = useState<string | null>(null)

  useEffect(() => {
    void api.ai.providerTemplates().then((list) => setTemplates(list as ProviderTemplate[]))
  }, [])

  const roleOf = (id: string): 'analysis' | 'transcription' | 'vision' | 'none' => {
    if (draft.ai.analysisProviderId === id) return 'analysis'
    if (draft.ai.transcriptionProviderId === id) return 'transcription'
    if (draft.ai.visionProviderId === id) return 'vision'
    return 'none'
  }

  const setRole = (id: string, role: 'analysis' | 'transcription' | 'vision' | 'none') => {
    const ai = { ...draft.ai }
    if (ai.analysisProviderId === id) ai.analysisProviderId = undefined
    if (ai.transcriptionProviderId === id) ai.transcriptionProviderId = undefined
    if (ai.visionProviderId === id) ai.visionProviderId = undefined
    if (role === 'analysis') ai.analysisProviderId = id
    if (role === 'transcription') ai.transcriptionProviderId = id
    if (role === 'vision') ai.visionProviderId = id
    patch({ ai })
  }

  return (
    <div className="stack-lg">
      <div className="settings-block">
        <div className="settings-block__head">
          <div>
            <h3>Connected providers</h3>
            <p className="hint">
              Clipwright ships no AI service of its own. You connect your own OpenAI-compatible endpoint; keys
              go to the Windows Credential Manager and never touch settings, projects or logs.
            </p>
          </div>
          <Button variant="primary" size="sm" icon={<Plus size={12} />} onClick={() => setAdding(true)}>
            Add provider
          </Button>
        </div>

        {providers.length === 0 ? (
          <EmptyState
            icon={<Server size={20} />}
            title="No providers connected"
            body="Offline analysis and local transcription work without one. Add a provider for hosted transcription or richer moment scoring."
            action={
              <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
                Add your first provider
              </Button>
            }
          />
        ) : (
          <div className="stack-sm">
            {providers.map((provider) => (
              <div key={provider.id} className="provider-row">
                <div className="provider-row__main">
                  <div className="row">
                    <span style={{ fontWeight: 600 }}>{provider.name}</span>
                    {provider.hasKey ? <Badge tone="success">key stored</Badge> : <Badge tone="warning">no key</Badge>}
                    {roleOf(provider.id) !== 'none' && <Badge tone="brand">{roleOf(provider.id)}</Badge>}
                    {!provider.enabled && <Badge tone="danger">disabled</Badge>}
                  </div>
                  <div className="hint mono truncate">{provider.baseUrl}</div>
                  <div className="hint">
                    {provider.model || 'no default model'}
                    {provider.lastTest
                      ? ` · last test ${provider.lastTest.ok ? 'passed' : 'failed'} ${new Date(provider.lastTest.at).toLocaleString()}`
                      : ''}
                  </div>
                </div>
                <div className="row">
                  <Button
                    size="sm"
                    loading={testing === provider.id}
                    onClick={async () => {
                      setTesting(provider.id)
                      try {
                        const result = await api.ai.testProvider(provider.id)
                        notify({
                          kind: result.ok ? 'success' : 'error',
                          title: result.ok ? `${provider.name} connected` : `${provider.name} failed`,
                          body: result.latencyMs ? `${result.message} (${result.latencyMs} ms)` : result.message
                        })
                        await onChanged()
                      } catch (error) {
                        notify({ kind: 'error', title: 'Test failed', body: errorMessage(error) })
                      } finally {
                        setTesting(null)
                      }
                    }}
                  >
                    Test
                  </Button>
                  <select
                    className="select"
                    style={{ width: 148 }}
                    value={roleOf(provider.id)}
                    onChange={(e) => setRole(provider.id, e.target.value as 'analysis' | 'transcription' | 'vision' | 'none')}
                    aria-label={`Task for ${provider.name}`}
                  >
                    <option value="none">Unassigned</option>
                    <option value="analysis">Moment analysis</option>
                    <option value="transcription">Transcription</option>
                    <option value="vision">Vision (frames)</option>
                  </select>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 size={11} />}
                    onClick={async () => {
                      if (!window.confirm(`Remove ${provider.name} and delete its stored key?`)) return
                      await api.ai.removeProvider(provider.id)
                      await onChanged()
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="settings-block">
        <h3>Disclosure controls</h3>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 12.5 }}>Send transcript text to the provider</div>
            <div className="hint">Required for hosted scoring. Only words and timings are sent — never media.</div>
          </div>
          <Switch
            label="Send transcript text"
            checked={draft.ai.allowTranscriptUpload}
            onChange={(v) => patch({ ai: { ...draft.ai, allowTranscriptUpload: v } })}
          />
        </div>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          <div>
            <div style={{ fontSize: 12.5 }}>Allow vision (sampled frames)</div>
            <div className="hint">Sends still frames for visual scoring. Off by default; you are told before anything leaves the machine.</div>
          </div>
          <Switch
            label="Allow vision"
            checked={draft.ai.allowVision}
            onChange={(v) => patch({ ai: { ...draft.ai, allowVision: v } })}
          />
        </div>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          <div>
            <div style={{ fontSize: 12.5 }}>Upload without asking</div>
            <div className="hint">When off, Clipwright asks before the first network request of each session.</div>
          </div>
          <Switch
            label="Upload without asking"
            checked={draft.ai.allowUploadWithoutConfirm}
            onChange={(v) => patch({ ai: { ...draft.ai, allowUploadWithoutConfirm: v } })}
          />
        </div>
      </div>

      <AddProviderModal
        open={adding}
        templates={templates}
        onClose={() => setAdding(false)}
        onAdded={async () => {
          setAdding(false)
          await onChanged()
        }}
      />
    </div>
  )
}

function AddProviderModal({
  open,
  templates,
  onClose,
  onAdded
}: {
  open: boolean
  templates: ProviderTemplate[]
  onClose: () => void
  onAdded: () => Promise<void>
}): JSX.Element | null {
  const notify = useEditor((s) => s.notify)
  const [templateId, setTemplateId] = useState('')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [modelsText, setModelsText] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const template = templates.find((t) => t.id === templateId)
    if (!template) return
    setName(template.name)
    setBaseUrl(template.baseUrl)
    setModelsText(template.models.join(', '))
    setModel(template.models[0] ?? '')
  }, [templateId, templates])

  if (!open) return null

  return (
    <Modal
      open
      title="Add AI provider"
      subtitle="Any OpenAI-compatible /v1 endpoint works. The key is written straight to the OS credential vault."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await api.ai.addProvider({
                  name: name || 'Provider',
                  kind: 'openai-compatible',
                  baseUrl,
                  model,
                  models: modelsText.split(',').map((m) => m.trim()).filter(Boolean),
                  tasks: ['transcription', 'analysis'],
                  enabled: true,
                  apiKey
                })
                notify({ kind: 'success', title: 'Provider added', body: 'Key stored in the Windows Credential Manager.' })
                setApiKey('')
                await onAdded()
              } catch (error) {
                notify({ kind: 'error', title: 'Could not add provider', body: errorMessage(error) })
              } finally {
                setBusy(false)
              }
            }}
          >
            Add provider
          </Button>
        </>
      }
    >
      <div className="stack-md">
        <Field label="Template">
          <select className="select" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">Custom endpoint</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Display name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My provider" />
        </Field>
        <Field label="Base URL" hint="Must expose an OpenAI-compatible API (chat/completions, audio/transcriptions).">
          <input className="input mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
        </Field>
        <Field label="API key" hint="Stored in Windows Credential Manager — never in settings.json, projects or logs.">
          <div className="row">
            <input
              className="input mono"
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-…"
              autoComplete="off"
            />
            <Button size="sm" variant="ghost" onClick={() => setShowKey((v) => !v)} aria-label="Show key">
              {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
            </Button>
          </div>
        </Field>
        <Field label="Default model">
          <input className="input mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o-mini" />
        </Field>
        <Field label="All models (comma separated)">
          <input
            className="input mono"
            value={modelsText}
            onChange={(e) => setModelsText(e.target.value)}
            placeholder="whisper-1, gpt-4o-mini"
          />
        </Field>
      </div>
    </Modal>
  )
}

/* --------------------------------- models -------------------------------- */

function ModelsSection({ models, onChanged }: { models: LocalModel[]; onChanged: () => Promise<void> }): JSX.Element {
  const notify = useEditor((s) => s.notify)
  const runtimes = useApp((s) => s.runtimes)
  const capabilities = useApp((s) => s.capabilities)
  const refreshRuntimes = useApp((s) => s.refreshRuntimes)
  const [checking, setChecking] = useState(false)

  /** Register the running Ollama server as an OpenAI-compatible provider. */
  const onAddOllamaProvider = async (status: NonNullable<typeof runtimes>): Promise<void> => {
    const model = status.ollama.models[0]
    if (!model) return
    try {
      await api.ai.addProvider({
        kind: 'openai-compatible',
        label: `Ollama · ${model}`,
        baseUrl: `${status.ollama.url}/v1`,
        models: [model],
        transcriptionModels: [],
        tasks: ['analysis'],
        enabled: true
      } as never)
      notify({ kind: 'success', title: 'Ollama added', body: `Analysis will use ${model} locally.` })
    } catch (error) {
      notify({ kind: 'error', title: 'Could not add Ollama', body: errorMessage(error) })
    }
  }
  const [progress, setProgress] = useState<Record<string, { percent: number; message?: string }>>({})

  useEffect(() => {
    const off = api.events.onModelProgress((payload: ModelDownloadProgress) => {
      if (payload.status === 'installed') {
        setProgress((prev) => {
          const next = { ...prev }
          delete next[payload.modelId]
          return next
        })
        void onChanged()
        return
      }
      if (payload.status === 'error') {
        setProgress((prev) => {
          const next = { ...prev }
          delete next[payload.modelId]
          return next
        })
        notify({ kind: 'error', title: 'Model download failed', body: payload.message })
        return
      }
      setProgress((prev) => ({
        ...prev,
        [payload.modelId]: { percent: payload.percent, message: payload.message }
      }))
    })
    return off
  }, [onChanged, notify])

  const groups: { task: LocalModel['task']; title: string; body: string }[] = [
    {
      task: 'transcription',
      title: 'Speech recognition (whisper.cpp)',
      body: 'ggml models. Offline transcription needs whisper-cli plus one of these files — nothing else is required for it to work.'
    },
    {
      task: 'analysis',
      title: 'Transcript analysis (GGUF)',
      body: 'Optional. Runs through a local llama.cpp-compatible runtime for richer scoring. The built-in scorer needs no model.'
    }
  ]

  return (
    <div className="stack-lg">
      <div className="callout callout--info">
        <Shield size={13} />
        <div>
          Local processing keeps media on this PC. Downloads are one-time and can be deleted here at any time.
        </div>
      </div>
      <div className="settings-block">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Runtime status</h3>
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw size={11} />}
            loading={checking}
            onClick={async () => {
              setChecking(true)
              try {
                await refreshRuntimes()
              } finally {
                setChecking(false)
              }
            }}
          >
            Re-scan this PC
          </Button>
        </div>
        <p className="hint">
          Detected on this PC. Anything you already installed is used as-is — nothing has to live inside the
          app folder. Installed something new? Press “Re-scan this PC”.
        </p>
        <div className="facts">
          <div className="fact">
            <span className="fact__label">whisper.cpp</span>
            <span className={clsx('fact__value mono', !runtimes?.whisper.available && 'fact__value--bad')}>
              {runtimes?.whisper.available ? `ready (${runtimes.whisper.source})` : (runtimes?.whisper.source ?? 'not found')}
            </span>
          </div>
          {runtimes?.whisper.path && (
            <div className="fact">
              <span className="fact__label">whisper binary</span>
              <span className="fact__value mono truncate" title={runtimes.whisper.path}>
                {runtimes.whisper.path}
              </span>
            </div>
          )}
          <div className="fact">
            <span className="fact__label">Speech model</span>
            <span className={clsx('fact__value mono', !capabilities?.whisperModelPath && 'fact__value--bad')}>
              {capabilities?.whisperModelPath
                ? capabilities.whisperModelPath.split(/[\\/]/).pop()
                : 'none found (ggml-*.bin)'}
            </span>
          </div>
          <div className="fact">
            <span className="fact__label">Ollama</span>
            <span className={clsx('fact__value mono', !runtimes?.ollama.available && 'fact__value--bad')}>
              {runtimes?.ollama.available
                ? `running${runtimes.ollama.version ? ` v${runtimes.ollama.version}` : ''} · ${runtimes.ollama.models.length} model(s)`
                : (runtimes?.ollama.note ?? 'not running')}
            </span>
          </div>
          {runtimes?.ollama.available && runtimes.ollama.models.length > 0 && (
            <div className="fact">
              <span className="fact__label">Ollama models</span>
              <span className="fact__value mono truncate" title={runtimes.ollama.models.join(', ')}>
                {runtimes.ollama.models.join(', ')}
              </span>
            </div>
          )}
          <div className="fact">
            <span className="fact__label">LM Studio server</span>
            <span className={clsx('fact__value mono', !runtimes?.lmstudio.available && 'fact__value--bad')}>
              {runtimes?.lmstudio.available
                ? `running · ${runtimes.lmstudio.models.length} model(s)`
                : (runtimes?.lmstudio.note ?? 'not running')}
            </span>
          </div>
          <div className="fact">
            <span className="fact__label">llama.cpp CLI</span>
            <span className={clsx('fact__value mono', !runtimes?.llama.available && 'fact__value--bad')}>
              {runtimes?.llama.available ? `found (${runtimes.llama.source})` : 'not found'}
            </span>
          </div>
        </div>

        {runtimes?.ollama.available && runtimes.ollama.models.length > 0 && (
          <div className="callout callout--info" style={{ marginTop: 10 }}>
            <Server size={13} />
            <div>
              <strong>Use Ollama for analysis:</strong> add a provider of type{' '}
              <span className="mono">OpenAI-compatible</span> with base URL{' '}
              <span className="mono">{runtimes.ollama.url}/v1</span> and model{' '}
              <span className="mono">{runtimes.ollama.models[0]}</span>. No API key is needed.
              <div style={{ marginTop: 6 }}>
                <Button size="sm" icon={<Plus size={11} />} onClick={() => onAddOllamaProvider(runtimes)}>
                  Add Ollama provider
                </Button>
              </div>
            </div>
          </div>
        )}

        {!runtimes?.whisper.available && (
          <div className="hint">
            Without a working whisper.cpp, offline transcription is unavailable. Put{' '}
            <span className="mono">whisper-cli.exe</span> (with its DLLs) next to the app, in
            <span className="mono"> Documents\Clipwright Studio\Tools</span>, or anywhere on your PATH — it is
            found automatically and re-checked when you press Refresh below. Online transcription still works
            with a provider key. Clipwright will never pretend offline speech recognition works without it.
          </div>
        )}
      </div>

      {groups.map((group) => (
        <div className="settings-block" key={group.task}>
          <h3>{group.title}</h3>
          <p className="hint">{group.body}</p>
          <div className="stack-sm" style={{ marginTop: 6 }}>
            {models.filter((m) => m.task === group.task).length === 0 && (
              <div className="hint">No model definitions available.</div>
            )}
            {models
              .filter((m) => m.task === group.task)
              .map((model) => (
                <div key={model.id} className="model-row">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row">
                      <span style={{ fontWeight: 600 }}>{model.name}</span>
                      <Badge>{formatBytes(model.sizeBytes)}</Badge>
                      {model.installed && <Badge tone="success">installed</Badge>}
                    </div>
                    <div className="hint">{model.note}</div>
                    <div className="hint">{model.licence}</div>
                    {progress[model.id] && (
                      <div style={{ marginTop: 6 }}>
                        <ProgressBar percent={progress[model.id].percent} />
                        <div className="hint" style={{ marginTop: 3 }}>
                          {progress[model.id].message ?? `${Math.round(progress[model.id].percent)}%`}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="row">
                    {model.installed ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Trash2 size={11} />}
                        onClick={async () => {
                          await api.ai.deleteModel(model.id)
                          await onChanged()
                        }}
                      >
                        Delete
                      </Button>
                    ) : progress[model.id] ? (
                      <Button size="sm" onClick={() => void api.ai.cancelModelDownload(model.id)}>
                        Cancel
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        icon={<Download size={11} />}
                        onClick={() => {
                          setProgress((prev) => ({ ...prev, [model.id]: { percent: 0, message: 'Connecting…' } }))
                          void api.ai.downloadModel(model.id).then((result) => {
                            if (!result.ok) {
                              notify({ kind: 'error', title: 'Download failed', body: result.error })
                              setProgress((prev) => {
                                const next = { ...prev }
                                delete next[model.id]
                                return next
                              })
                            }
                          })
                        }}
                      >
                        Download
                      </Button>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------- processing ------------------------------- */

function ProcessingSection({
  draft,
  patch,
  capabilities
}: {
  draft: Settings
  patch: (next: Partial<Settings>) => void
  capabilities: CapabilityReport | null
}): JSX.Element {
  return (
    <div className="stack-lg">
      <div className="settings-block">
        <h3>Processing location</h3>
        <Segmented
          value={draft.ai.mode}
          onChange={(v) => patch({ ai: { ...draft.ai, mode: v as ProcessingMode } })}
          options={[
            { id: 'auto', label: 'Auto' },
            { id: 'offline', label: 'Offline only' },
            { id: 'online', label: 'Online only' }
          ]}
        />
        <div className="hint">
          {draft.ai.mode === 'offline'
            ? 'Nothing leaves this computer. Transcription needs whisper.cpp and a downloaded model; scoring uses the built-in analyser.'
            : draft.ai.mode === 'online'
              ? 'Transcript text is sent to your configured provider. Media files are never uploaded.'
              : 'Prefers local processing and only contacts a provider when you have connected one and local options are unavailable.'}
        </div>
      </div>
      <div className="settings-block">
        <h3>Transcription</h3>
        <div className="grid-2">
          <Field label="Language">
            <select
              className="select"
              value={draft.transcription.language}
              onChange={(e) => patch({ transcription: { ...draft.transcription, language: e.target.value } })}
            >
              {['en', 'auto', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'ja', 'ko', 'zh', 'hi', 'ar', 'ru', 'tr', 'id'].map((l) => (
                <option key={l} value={l}>
                  {l === 'auto' ? 'Detect automatically' : l.toUpperCase()}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Threads">
            <input
              className="input mono"
              type="number"
              min={1}
              max={64}
              value={draft.transcription.threads}
              onChange={(e) => patch({ transcription: { ...draft.transcription, threads: Number(e.target.value) } })}
            />
          </Field>
        </div>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          <span style={{ fontSize: 12.5 }}>Identify speakers</span>
          <Switch
            label="Speaker labels"
            checked={draft.transcription.speakerLabels}
            onChange={(v) => patch({ transcription: { ...draft.transcription, speakerLabels: v } })}
          />
        </div>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          <span style={{ fontSize: 12.5 }}>Word-level timestamps (needed for karaoke captions)</span>
          <Switch
            label="Word timestamps"
            checked={draft.transcription.wordTimestamps}
            onChange={(v) => patch({ transcription: { ...draft.transcription, wordTimestamps: v } })}
          />
        </div>
      </div>
      <div className="settings-block">
        <h3>Performance</h3>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12.5 }}>Hardware-accelerated decode/encode</span>
          <Switch
            label="Hardware acceleration"
            checked={draft.performance.hardwareAcceleration}
            onChange={(v) => patch({ performance: { ...draft.performance, hardwareAcceleration: v } })}
          />
        </div>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          <span style={{ fontSize: 12.5 }}>Generate 720p proxies for big sources</span>
          <Switch
            label="Proxies"
            checked={draft.performance.proxyEnabled}
            onChange={(v) => patch({ performance: { ...draft.performance, proxyEnabled: v } })}
          />
        </div>
        <Field label={`Preview quality — ${draft.performance.previewQuality}`}>
          <Segmented
            value={draft.performance.previewQuality}
            onChange={(v) => patch({ performance: { ...draft.performance, previewQuality: v as 'full' | 'half' | 'quarter' } })}
            options={[
              { id: 'full', label: 'Full' },
              { id: 'half', label: 'Half' },
              { id: 'quarter', label: 'Quarter' }
            ]}
          />
        </Field>
        <Field label={`Concurrent export jobs — ${draft.performance.maxConcurrentJobs}`}>
          <Slider
            value={draft.performance.maxConcurrentJobs}
            min={1}
            max={4}
            onChange={(v) => patch({ performance: { ...draft.performance, maxConcurrentJobs: v } })}
          />
        </Field>
        <div className="hint">
          Proxies are 720p copies used only for scrubbing. Exports always use the full-quality originals.
        </div>
      </div>
      <div className="settings-block">
        <h3>Detected hardware</h3>
        <div className="facts">
          <Fact label="ffmpeg" value={capabilities?.ffmpegVersion ?? (capabilities?.ffmpeg ? 'available' : 'missing')} ok={capabilities?.ffmpeg} />
          <Fact label="ffprobe" value={capabilities?.ffprobe ? 'available' : 'missing'} ok={capabilities?.ffprobe} />
          <Fact label="Hardware encoder" value={capabilities?.hardwareEncoders.join(', ') || 'none — software x264'} ok={capabilities?.nvenc} />
          <Fact label="whisper.cpp" value={capabilities?.whisperAvailable ? 'ready' : 'not installed'} ok={capabilities?.whisperAvailable} />
          <Fact label="yt-dlp" value={capabilities?.ytdlp ? 'available' : 'not installed'} ok={capabilities?.ytdlp} />
          <Fact label="CPU threads" value={String(capabilities?.cpuThreads ?? navigator.hardwareConcurrency ?? 0)} ok />
        </div>
      </div>
    </div>
  )
}

/* --------------------------------- storage -------------------------------- */

function StorageSection({
  draft,
  patch,
  workspace
}: {
  draft: Settings
  patch: (next: Partial<Settings>) => void
  workspace: WorkspaceInfo | null
}): JSX.Element {
  const notify = useEditor((s) => s.notify)
  const saveSettings = useApp((s) => s.saveSettings)
  return (
    <div className="stack-lg">
      <div className="settings-block">
        <h3>Workspace folder</h3>
        <div className="card">
          <div className="mono truncate" style={{ fontSize: 12 }}>
            {workspace?.root ?? draft.storage.workspaceRoot ?? 'Not set'}
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            Projects, media copies, proxies, exports, presets and recovery points live here. Backing this
            folder up backs up your work.
            {workspace
              ? ` ${formatBytes(workspace.freeBytes)} free of ${formatBytes(workspace.totalBytes)}.`
              : ''}
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <Button
            icon={<FolderOpen size={13} />}
            onClick={async () => {
              const info = await api.workspace.choose()
              if (!info) return
              // The main process switches the active workspace immediately.
              await saveSettings({ storage: { ...draft.storage, workspaceRoot: info.root } })
              patch({ storage: { ...draft.storage, workspaceRoot: info.root } })
              notify({ kind: 'success', title: 'Workspace changed', body: info.root })
            }}
          >
            Change folder
          </Button>
          <Button variant="ghost" onClick={() => void api.workspace.open()}>
            Open in Explorer
          </Button>
        </div>
      </div>
      <div className="settings-block">
        <h3>Importing media</h3>
        <Field label="Default mode">
          <Segmented
            value={draft.storage.defaultImportMode}
            onChange={(v) => patch({ storage: { ...draft.storage, defaultImportMode: v as 'managed' | 'linked' } })}
            options={[
              { id: 'managed', label: 'Copy into project' },
              { id: 'linked', label: 'Link to file' }
            ]}
          />
        </Field>
        <div className="hint">
          Copying makes projects portable and immune to files being moved. Linking saves disk space but the
          project needs relinking if the original moves.
        </div>
      </div>
      <div className="settings-block">
        <h3>Autosave</h3>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12.5 }}>Autosave while editing</span>
          <Switch
            label="Autosave"
            checked={draft.general.restoreLastProject}
            onChange={(v) => patch({ general: { ...draft.general, restoreLastProject: v } })}
          />
        </div>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          <span style={{ fontSize: 12.5 }}>Confirm before deleting things</span>
          <Switch
            label="Confirm delete"
            checked={draft.general.confirmDelete}
            onChange={(v) => patch({ general: { ...draft.general, confirmDelete: v } })}
          />
        </div>
        <div className="hint">
          Autosave writes a recovery snapshot every few seconds; the recovery tab on the home screen restores
          any of them.
        </div>
      </div>
    </div>
  )
}

/* --------------------------------- export -------------------------------- */

function ExportSection({
  draft,
  patch,
  capabilities
}: {
  draft: Settings
  patch: (next: Partial<Settings>) => void
  capabilities: CapabilityReport | null
}): JSX.Element {
  return (
    <div className="stack-lg">
      <div className="settings-block">
        <h3>Defaults</h3>
        <div className="grid-2">
          <Field label="Resolution">
            <select
              className="select"
              value={draft.export.defaultResolution}
              onChange={(e) =>
                patch({
                  export: { ...draft.export, defaultResolution: e.target.value as Settings['export']['defaultResolution'] }
                })
              }
            >
              <option value="720p">720p</option>
              <option value="1080p">1080p</option>
              <option value="1440p">1440p</option>
              <option value="dci2k">DCI 2K</option>
              <option value="4k">4K UHD</option>
            </select>
          </Field>
          <Field label="Frame rate">
            <select
              className="select"
              value={String(draft.export.defaultFps)}
              onChange={(e) => patch({ export: { ...draft.export, defaultFps: Number(e.target.value) } })}
            >
              <option value="24">24 fps</option>
              <option value="30">30 fps</option>
              <option value="60">60 fps</option>
            </select>
          </Field>
        </div>
        <Field label={`Quality — CRF ${draft.export.crf}`} hint="Lower is better quality and larger files. 17–20 suits social platforms.">
          <Slider value={draft.export.crf} min={14} max={32} onChange={(v) => patch({ export: { ...draft.export, crf: v } })} />
        </Field>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12.5 }}>Hardware encoder (NVENC/QSV/AMF) when available</span>
          <Switch
            label="Hardware encoder"
            checked={draft.export.hardwareEncoder}
            onChange={(v) => patch({ export: { ...draft.export, hardwareEncoder: v } })}
          />
        </div>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          <span style={{ fontSize: 12.5 }}>Burn captions into the video</span>
          <Switch
            label="Burn captions"
            checked={draft.export.burnCaptions}
            onChange={(v) => patch({ export: { ...draft.export, burnCaptions: v } })}
          />
        </div>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          <span style={{ fontSize: 12.5 }}>Also write .srt / .vtt sidecars</span>
          <Switch
            label="Sidecar subtitles"
            checked={draft.export.writeSidecarSubtitles}
            onChange={(v) => patch({ export: { ...draft.export, writeSidecarSubtitles: v } })}
          />
        </div>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          <span style={{ fontSize: 12.5 }}>Validate every export</span>
          <Switch
            label="Validate exports"
            checked={draft.export.validateAfterExport}
            onChange={(v) => patch({ export: { ...draft.export, validateAfterExport: v } })}
          />
        </div>
        <div className="hint">
          Validation re-probes the finished file and checks dimensions, frame rate, duration, decodability and
          audio/video alignment. A failed check marks the export failed rather than claiming success.
        </div>
        {!capabilities?.nvenc && (
          <div className="callout" style={{ marginTop: 10 }}>
            <TriangleAlert size={13} />
            <div>No hardware encoder detected on this machine — exports use the x264 software encoder.</div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------- appearance ------------------------------- */

function AppearanceSection({ draft, patch }: { draft: Settings; patch: (next: Partial<Settings>) => void }): JSX.Element {
  return (
    <div className="stack-lg">
      <div className="settings-block">
        <h3>Theme</h3>
        <Segmented
          value={draft.appearance.theme}
          onChange={(v) => patch({ appearance: { ...draft.appearance, theme: v as 'dark' | 'light' | 'system' } })}
          options={[
            { id: 'dark', label: 'Dark' },
            { id: 'light', label: 'Light' },
            { id: 'system', label: 'Match Windows' }
          ]}
        />
        <Field label="Interface density">
          <Segmented
            value={draft.appearance.density}
            onChange={(v) => patch({ appearance: { ...draft.appearance, density: v as 'comfortable' | 'compact' } })}
            options={[
              { id: 'comfortable', label: 'Comfortable' },
              { id: 'compact', label: 'Compact' }
            ]}
          />
        </Field>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12.5 }}>Reduce motion</span>
          <Switch
            label="Reduce motion"
            checked={draft.appearance.reduceMotion}
            onChange={(v) => patch({ appearance: { ...draft.appearance, reduceMotion: v } })}
          />
        </div>
        <Field label={`Timeline clip height — ${draft.appearance.timelineClipHeight}px`}>
          <Slider
            value={draft.appearance.timelineClipHeight}
            min={40}
            max={110}
            step={2}
            onChange={(v) => patch({ appearance: { ...draft.appearance, timelineClipHeight: v } })}
          />
        </Field>
        <Field label="Accent">
          <div className="row">
            {['#ff7a18', '#ffb020', '#f2f2f2', '#4dabf7', '#51cf66', '#ff6b6b'].map((colour) => (
              <button
                key={colour}
                className={clsx('swatch', draft.appearance.accent.toLowerCase() === colour && 'swatch--active')}
                style={{ background: colour }}
                onClick={() => patch({ appearance: { ...draft.appearance, accent: colour } })}
                title={colour}
              />
            ))}
            <input
              type="color"
              value={draft.appearance.accent}
              onChange={(e) => patch({ appearance: { ...draft.appearance, accent: e.target.value } })}
              className="swatch-input"
              aria-label="Custom accent colour"
            />
          </div>
        </Field>
      </div>
    </div>
  )
}

/* --------------------------------- updates -------------------------------- */

function UpdatesSection(): JSX.Element {
  const notify = useEditor((s) => s.notify)
  const info = useApp((s) => s.info)
  const settings = useApp((s) => s.settings)
  const saveSettings = useApp((s) => s.saveSettings)
  const [state, setState] = useState<UpdateInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ percent: number; message?: string } | null>(null)
  const [downloaded, setDownloaded] = useState<{ installerPath?: string; needsManualInstall?: boolean } | null>(null)

  useEffect(() => {
    const off = api.events.onUpdateProgress((payload: UpdateProgress) => {
      if (payload.stage === 'ready') {
        setTimeout(() => setProgress(null), 900)
        return
      }
      if (payload.stage === 'error') {
        setProgress(null)
        notify({ kind: 'error', title: 'Update failed', body: payload.message })
        return
      }
      setProgress({ percent: payload.percent, message: payload.message })
    })
    return off
  }, [notify])

  return (
    <div className="stack-lg">
      <div className="settings-block">
        <h3>Version {info?.version ?? '—'}</h3>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12.5 }}>Check automatically at launch</span>
          <Switch
            label="Auto check"
            checked={settings?.updates.autoCheck ?? true}
            onChange={(v) => settings && void saveSettings({ updates: { ...settings.updates, autoCheck: v } })}
          />
        </div>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          <span style={{ fontSize: 12.5 }}>Include pre-releases</span>
          <Switch
            label="Pre-releases"
            checked={settings?.updates.channel === 'prerelease'}
            onChange={(v) =>
              settings && void saveSettings({ updates: { ...settings.updates, channel: v ? 'prerelease' : 'stable' } })
            }
          />
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <Button
            icon={<RefreshCw size={13} />}
            loading={busy}
            onClick={async () => {
              setBusy(true)
              try {
                setState(await api.updates.check())
              } catch (error) {
                notify({ kind: 'error', title: 'Update check failed', body: errorMessage(error) })
              } finally {
                setBusy(false)
              }
            }}
          >
            Check for updates
          </Button>
          <Button variant="ghost" onClick={() => void api.updates.openRelease('')}>
            Open releases page
          </Button>
        </div>
        {state && (
          <div className="card" style={{ marginTop: 12 }}>
            {state.available && state.latestVersion ? (
              <>
                <div className="row">
                  <Badge tone="brand">v{state.latestVersion}</Badge>
                  <span style={{ fontWeight: 600 }}>Update available</span>
                  {state.assetName && <span className="hint mono">{state.assetName}</span>}
                  {state.assetSize && <span className="hint">{formatBytes(state.assetSize)}</span>}
                </div>
                {state.notes && (
                  <div className="hint" style={{ marginTop: 6, whiteSpace: 'pre-wrap', maxHeight: 140, overflow: 'auto' }}>
                    {state.notes}
                  </div>
                )}
                {progress && (
                  <div style={{ marginTop: 8 }}>
                    <ProgressBar percent={progress.percent} />
                    <div className="hint" style={{ marginTop: 3 }}>
                      {progress.message ?? `${Math.round(progress.percent)}%`}
                    </div>
                  </div>
                )}
                <div className="row" style={{ marginTop: 10 }}>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Download size={12} />}
                    onClick={async () => {
                      try {
                        const result = await api.updates.download(state)
                        setDownloaded(result)
                        if (result.needsManualInstall) {
                          notify({
                            kind: 'warning',
                            title: 'Installer downloaded',
                            body: 'This release publishes no checksum, so Clipwright will not run it automatically. The release page has been opened so you can verify it yourself.'
                          })
                        } else {
                          notify({ kind: 'success', title: 'Installer verified', body: 'Checksum matched. Use “Install now” when you are ready.' })
                        }
                      } catch (error) {
                        notify({ kind: 'error', title: 'Download failed', body: errorMessage(error) })
                      }
                    }}
                  >
                    Download update
                  </Button>
                  <Button
                    size="sm"
                    onClick={async () => {
                      try {
                        const result = await api.updates.install(downloaded?.installerPath ?? '')
                        if (!result.launched) {
                          notify({ kind: 'error', title: 'Install blocked', body: result.error ?? 'Unknown error' })
                        }
                      } catch (error) {
                        notify({ kind: 'error', title: 'Install blocked', body: errorMessage(error) })
                      }
                    }}
                  >
                    Install now
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void api.updates.openRelease(state.releaseUrl ?? '')}>
                    Release notes
                  </Button>
                </div>
              </>
            ) : (
              <div className="row">
                <Check size={14} style={{ color: 'var(--success)' }} />
                <span style={{ fontSize: 12.5 }}>
                  {state.error ?? 'You are on the latest published version.'}
                </span>
              </div>
            )}
          </div>
        )}
        <div className="hint" style={{ marginTop: 10 }}>
          Updates come from GitHub Releases. Clipwright verifies the published SHA-256 before running anything,
          never installs silently, keeps your projects and settings, and tells you plainly when a release cannot
          be verified.
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------- logs --------------------------------- */

function LogsSection(): JSX.Element {
  const [state, setState] = useState<{ text: string; file: string; bytes: number } | null>(null)
  const [busy, setBusy] = useState(true)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setState(await api.app.readLogs(400))
    } catch {
      setState({ text: '', file: '', bytes: 0 })
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const empty = !state || !state.text.trim()

  return (
    <div className="stack-md">
      <div className="row">
        <Button icon={<RefreshCw size={12} />} onClick={() => void load()} loading={busy}>
          Reload
        </Button>
        <Button variant="ghost" icon={<FolderOpen size={12} />} onClick={() => void api.app.openLogs()}>
          Open log folder
        </Button>
        {state && state.file && (
          <span className="muted text-xs mono">
            {state.file.split(/[\\/]/).pop()} · {Math.max(1, Math.round(state.bytes / 1024))} KB
          </span>
        )}
      </div>
      <pre className="log-view mono">
        {empty
          ? busy
            ? 'Loading…'
            : 'No log entries yet. Diagnostics are written to the workspace “Logs” folder as soon as the app does something worth recording.'
          : state.text}
      </pre>
      <p className="muted text-xs">
        Logs never contain API keys. Last 400 lines are shown; open the folder for the full history and the rotated
        previous log.
      </p>
    </div>
  )
}

/* --------------------------------- about --------------------------------- */

function AboutSection({
  info,
  capabilities
}: {
  info: AppInfo | null
  capabilities: CapabilityReport | null
}): JSX.Element {
  return (
    <div className="stack-lg">
      <div className="settings-block">
        <h3>Clipwright Studio</h3>
        <p className="hint">
          A desktop editor for turning long recordings into finished clips. Everything runs on your machine;
          AI providers are optional and use your own credentials.
        </p>
        <div className="facts">
          <Fact label="Version" value={info?.version ?? '—'} ok />
          <Fact label="Electron" value={info?.electron ?? '—'} ok />
          <Fact label="Chromium" value={info?.chrome ?? '—'} ok />
          <Fact label="Node" value={info?.node ?? '—'} ok />
          <Fact label="Platform" value={`${info?.platform ?? ''} ${info?.arch ?? ''}`} ok />
          <Fact label="Packaged" value={info?.isPackaged ? 'yes' : 'development'} ok />
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <Button variant="ghost" onClick={() => void api.app.openLogs()}>
            Open logs
          </Button>
          <Button variant="ghost" onClick={() => void api.workspace.open()}>
            Open workspace
          </Button>
          <Button variant="ghost" onClick={() => void api.updates.openRelease('')}>
            Releases
          </Button>
        </div>
      </div>
      <div className="settings-block">
        <h3>Privacy</h3>
        <ul className="about-list">
          <li>No telemetry. Nothing is sent anywhere unless you configure a provider and start a hosted job.</li>
          <li>API keys live in the Windows Credential Manager, never in config or project files.</li>
          <li>Media files stay on disk. Hosted transcription sends audio only when you explicitly choose “online”.</li>
          <li>Local AI needs a downloaded runtime and model — Clipwright says so rather than pretending.</li>
        </ul>
      </div>
      <div className="settings-block">
        <h3>ffmpeg</h3>
        <div className="facts">
          <Fact label="Status" value={capabilities?.ffmpegVersion ?? 'not found'} ok={capabilities?.ffmpeg} />
          <Fact label="Path" value={capabilities?.ffmpegPath ?? '—'} ok={capabilities?.ffmpeg} />
        </div>
        <div className="hint">
          ffmpeg is used under the LGPL/GPL terms of the build shipped with the installer. Clipwright itself is
          MIT licensed.
        </div>
      </div>
    </div>
  )
}

function Fact({ label, value, ok }: { label: string; value: string; ok?: boolean }): JSX.Element {
  return (
    <div className="fact">
      <span className="fact__label">{label}</span>
      <span className={clsx('fact__value mono', ok === false && 'fact__value--bad')}>
        {ok === false ? <X size={11} /> : ok ? <Check size={11} /> : null} <span className="truncate">{value}</span>
      </span>
    </div>
  )
}
