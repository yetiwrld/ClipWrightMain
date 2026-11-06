/**
 * AI provider registry.
 *
 * API keys live in the OS credential vault (never in settings/projects/logs).
 * Each provider can serve transcription and/or moment analysis. Custom
 * OpenAI-compatible endpoints are first class, so users are not locked into any
 * single vendor — and no Clipwright-owned service is required.
 */
import fs from 'node:fs'
import path from 'node:path'
import { configDir } from '../paths'
import { vault, keyIdFor } from '../vault'
import type { AITask, ProviderConfig, ProviderKind } from '@shared/types'
import { log } from '../logger'

export interface ProviderTemplate {
  kind: ProviderKind
  label: string
  baseUrl: string
  models: string[]
  transcriptionModels: string[]
  tasks: AITask[]
  docs: string
}

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    kind: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini'],
    transcriptionModels: ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'],
    tasks: ['transcription', 'analysis'],
    docs: 'Create a key at platform.openai.com → API keys.'
  },
  {
    kind: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest', 'claude-sonnet-4-5'],
    transcriptionModels: [],
    tasks: ['analysis'],
    docs: 'Anthropic provides analysis only; pair it with a transcription provider.'
  },
  {
    kind: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
    transcriptionModels: [],
    tasks: ['analysis'],
    docs: 'Use a Google AI Studio API key. Transcription runs locally or via another provider.'
  },
  {
    kind: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    transcriptionModels: ['whisper-large-v3', 'whisper-large-v3-turbo'],
    tasks: ['transcription', 'analysis'],
    docs: 'Fast Whisper transcription. OpenAI-compatible chat endpoint.'
  },
  {
    kind: 'openai-compatible',
    label: 'OpenAI-compatible endpoint',
    baseUrl: 'https://',
    models: [],
    transcriptionModels: ['whisper-1'],
    tasks: ['transcription', 'analysis'],
    docs: 'Any server implementing /chat/completions and /audio/transcriptions (LM Studio, Ollama, OpenRouter, vLLM, your own host).'
  },
  {
    kind: 'local',
    label: 'Local models (offline)',
    baseUrl: '',
    models: [],
    transcriptionModels: [],
    tasks: ['transcription', 'analysis'],
    docs: 'Runs the models you downloaded in Settings → Local AI models. No key, no network.'
  }
]

interface ProvidersFile {
  version: number
  providers: ProviderConfig[]
}

export class ProviderStore {
  private file: string
  private data: ProvidersFile

  constructor() {
    this.file = path.join(configDir(), 'providers.json')
    this.data = this.load()
  }

  private load(): ProvidersFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ProvidersFile
      if (Array.isArray(parsed.providers)) return parsed
    } catch {
      /* first run */
    }
    return { version: 1, providers: [] }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    fs.renameSync(tmp, this.file)
  }

  list(): ProviderConfig[] {
    return this.data.providers.map((p) => ({ ...p, hasKey: vault().has(keyIdFor(p.id)) }))
  }

  get(id: string): ProviderConfig | undefined {
    const found = this.data.providers.find((p) => p.id === id)
    return found ? { ...found, hasKey: vault().has(keyIdFor(found.id)) } : undefined
  }

  apiKey(id: string): string | undefined {
    return vault().get(keyIdFor(id))
  }

  create(input: Omit<ProviderConfig, 'id' | 'createdAt' | 'hasKey'> & { id?: string; apiKey?: string }): ProviderConfig {
    const id = input.id ?? `prov_${Math.random().toString(36).slice(2, 10)}`
    const provider: ProviderConfig = {
      id,
      kind: input.kind,
      name: input.name,
      baseUrl: input.baseUrl,
      model: input.model,
      models: input.models ?? [],
      tasks: input.tasks,
      enabled: input.enabled ?? true,
      isDefault: input.isDefault ?? false,
      hasKey: false,
      createdAt: Date.now()
    }
    if (input.apiKey) {
      vault().set(keyIdFor(id), input.apiKey)
      provider.hasKey = true
    }
    if (provider.isDefault) {
      this.data.providers = this.data.providers.map((p) => ({ ...p, isDefault: false }))
    }
    this.data.providers.push(provider)
    this.persist()
    log.info('ai', `provider added: ${provider.name} (${provider.kind})`)
    return { ...provider, hasKey: vault().has(keyIdFor(id)) }
  }

  update(id: string, patch: Partial<ProviderConfig> & { apiKey?: string }): ProviderConfig {
    const index = this.data.providers.findIndex((p) => p.id === id)
    if (index < 0) throw new Error('Provider not found')
    if (patch.apiKey !== undefined) {
      if (patch.apiKey === '') vault().delete(keyIdFor(id))
      else vault().set(keyIdFor(id), patch.apiKey)
      delete (patch as { apiKey?: string }).apiKey
    }
    if (patch.isDefault) {
      this.data.providers = this.data.providers.map((p) => ({ ...p, isDefault: false }))
    }
    this.data.providers[index] = { ...this.data.providers[index], ...patch }
    this.persist()
    return { ...this.data.providers[index], hasKey: vault().has(keyIdFor(id)) }
  }

  remove(id: string): void {
    this.data.providers = this.data.providers.filter((p) => p.id !== id)
    vault().delete(keyIdFor(id))
    this.persist()
  }

  setLastTest(id: string, ok: boolean, message: string, latencyMs?: number): void {
    const provider = this.data.providers.find((p) => p.id === id)
    if (!provider) return
    provider.lastTest = { ok, at: Date.now(), message, latencyMs }
    this.persist()
  }

  /** Pick the best provider for a task given user settings. */
  resolve(task: AITask, preferredId?: string): ProviderConfig | undefined {
    const providers = this.list().filter((p) => p.enabled && p.tasks.includes(task))
    if (preferredId) {
      const preferred = providers.find((p) => p.id === preferredId)
      if (preferred) return preferred
    }
    const local = providers.find((p) => p.kind === 'local')
    const withKey = providers.filter((p) => p.kind === 'local' || p.hasKey)
    const def = withKey.find((p) => p.isDefault)
    if (def) return def
    if (task === 'transcription' && local) return local
    return withKey[0] ?? local
  }
}

let store: ProviderStore | null = null
export function providerStore(): ProviderStore {
  if (!store) store = new ProviderStore()
  return store
}

/* ------------------------------------------------------------------ */
/* HTTP client                                                        */
/* ------------------------------------------------------------------ */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatResult {
  text: string
  model: string
  usage?: { promptTokens?: number; completionTokens?: number }
}

/**
 * Send a chat completion to any supported provider. Implements the OpenAI,
 * Anthropic and Gemini request shapes so custom endpoints keep working.
 */
export async function chat(
  provider: ProviderConfig,
  apiKey: string | undefined,
  messages: ChatMessage[],
  opts: {
    json?: boolean
    maxTokens?: number
    temperature?: number
    signal?: AbortSignal
    /** Per-request timeout; defaults to two minutes. */
    timeoutMs?: number
  } = {}
): Promise<ChatResult> {
  const base = provider.baseUrl.replace(/\/$/, '')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  let url = ''
  let body: Record<string, unknown> = {}

  if (provider.kind === 'anthropic') {
    url = `${base}/messages`
    headers['x-api-key'] = apiKey ?? ''
    headers['anthropic-version'] = '2023-06-01'
    body = {
      model: provider.model,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0.2,
      system: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n'),
      messages: messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }))
    }
  } else if (provider.kind === 'gemini') {
    /*
     * The key goes in a header, not the query string. A URL-borne key leaks into
     * logs, proxies, crash reports and any error surface that prints the request.
     */
    url = `${base}/models/${encodeURIComponent(provider.model)}:generateContent`
    if (apiKey) headers['x-goog-api-key'] = apiKey
    body = {
      contents: messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
      generationConfig: {
        temperature: opts.temperature ?? 0.2,
        maxOutputTokens: opts.maxTokens ?? 4096,
        ...(opts.json ? { responseMimeType: 'application/json' } : {})
      }
    }
  } else {
    url = `${base}/chat/completions`
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`
    body = {
      model: provider.model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 4096,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {})
    }
  }

  /*
   * A provider that accepts the connection and then hangs used to hold the UI
   * spinner forever: the only signal was whatever the caller passed, and most
   * callers passed nothing. Every request now has a hard timeout, combined with
   * the caller's own cancellation signal when there is one.
   */
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 120_000)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal
    })
  } catch (error) {
    if (timeout.aborted) {
      throw new Error('The provider did not respond in time. Check the connection or try a smaller request.')
    }
    throw error
  }
  if (!response.ok) {
    const text = await response.text()
    throw new Error(describeHttpError(response.status, text))
  }
  const json = (await response.json()) as Record<string, any>
  if (provider.kind === 'anthropic') {
    return {
      text: (json.content as { text: string }[]).map((c) => c.text).join(''),
      model: provider.model,
      usage: { promptTokens: json.usage?.input_tokens, completionTokens: json.usage?.output_tokens }
    }
  }
  if (provider.kind === 'gemini') {
    const parts = json.candidates?.[0]?.content?.parts ?? []
    return {
      text: parts.map((p: { text?: string }) => p.text ?? '').join(''),
      model: provider.model,
      usage: {
        promptTokens: json.usageMetadata?.promptTokenCount,
        completionTokens: json.usageMetadata?.candidatesTokenCount
      }
    }
  }
  return {
    text: json.choices?.[0]?.message?.content ?? '',
    model: json.model ?? provider.model,
    usage: {
      promptTokens: json.usage?.prompt_tokens,
      completionTokens: json.usage?.completion_tokens
    }
  }
}

function describeHttpError(status: number, body: string): string {
  const snippet = body.slice(0, 300)
  if (status === 401 || status === 403) {
    return `Authentication failed (HTTP ${status}). Check that the API key is correct and has access to this model. ${snippet}`
  }
  if (status === 404) return `Model or endpoint not found (HTTP 404). Check the model name and base URL. ${snippet}`
  if (status === 429) return 'Rate limit reached (HTTP 429). Wait a moment and try again, or switch provider.'
  if (status >= 500) return `The provider reported a server error (HTTP ${status}). Try again later.`
  return `Provider request failed (HTTP ${status}). ${snippet}`
}

/** Test a provider configuration with a tiny request. */
export async function testProvider(
  provider: ProviderConfig,
  apiKey: string | undefined
): Promise<{ ok: boolean; message: string; latencyMs?: number; models?: string[] }> {
  const started = Date.now()
  try {
    if (provider.kind === 'local') {
      return { ok: false, message: 'Local models use the offline engine — see Settings → Local AI models.' }
    }
    if (!apiKey) return { ok: false, message: 'No API key saved for this provider.' }
    const result = await chat(provider, apiKey, [
      { role: 'user', content: 'Reply with the single word: ok' }
    ], { maxTokens: 16, temperature: 0 })
    const latencyMs = Date.now() - started
    const models = await listModels(provider, apiKey).catch(() => undefined)
    return {
      ok: result.text.toLowerCase().includes('ok') || result.text.length > 0,
      message: `Connected to ${provider.name} (${provider.model}).`,
      latencyMs,
      models
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Discover available models where the provider exposes a models endpoint. */
export async function listModels(provider: ProviderConfig, apiKey: string | undefined): Promise<string[]> {
  const base = provider.baseUrl.replace(/\/$/, '')
  if (provider.kind === 'anthropic') {
    const res = await fetch(`${base}/models`, {
      headers: { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as { data?: { id: string }[] }
    return (json.data ?? []).map((m) => m.id)
  }
  if (provider.kind === 'gemini') {
    const res = await fetch(`${base}/models`, {
      headers: apiKey ? { 'x-goog-api-key': apiKey } : {}
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as { models?: { name: string }[] }
    return (json.models ?? []).map((m) => m.name.replace(/^models\//, ''))
  }
  const headers: Record<string, string> = {}
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`
  const res = await fetch(`${base}/models`, { headers })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as { data?: { id: string }[] }
  return (json.data ?? []).map((m) => m.id)
}

/** Speech-to-text via an online provider (OpenAI-compatible endpoints). */
export async function transcribeRemote(
  provider: ProviderConfig,
  apiKey: string | undefined,
  audioFile: Buffer,
  filename: string,
  opts: { model: string; language?: string; prompt?: string; signal?: AbortSignal }
): Promise<{ text: string; segments?: { start: number; end: number; text: string }[]; words?: { word: string; start: number; end: number }[] }> {
  const base = provider.baseUrl.replace(/\/$/, '')
  const form = new FormData()
  form.append('file', new Blob([audioFile as unknown as BlobPart], { type: 'audio/wav' }), filename)
  form.append('model', opts.model)
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'word')
  form.append('timestamp_granularities[]', 'segment')
  if (opts.language) form.append('language', opts.language)
  if (opts.prompt) form.append('prompt', opts.prompt.slice(0, 900))
  const headers: Record<string, string> = {}
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`
  const response = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: form,
    signal: opts.signal
  })
  if (!response.ok) {
    throw new Error(describeHttpError(response.status, await response.text()))
  }
  const json = (await response.json()) as {
    text: string
    segments?: { start: number; end: number; text: string }[]
    words?: { word: string; start: number; end: number }[]
  }
  return json
}
