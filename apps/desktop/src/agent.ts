import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentActivity, AgentCompleteRequest, AgentCompleteResponse, AgentContent, AgentResultPart, AgentSettings } from '@reborn/studio-core'
import { writeAtomic } from './project-dir'

// Provider adapters for the in-app agent. The renderer runs the tool loop;
// main only makes the model calls, so API keys never reach the page.

export interface SecretBox {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(data: Buffer): string
}

type StoredSettings = Omit<AgentSettings, 'hasKey' | 'cliAvailable'>

const DEFAULTS: StoredSettings = {
  provider: 'claude-cli',
  model: '',
  baseUrl: 'http://127.0.0.1:11434/v1',
  directEdits: false,
  shareMeasurements: false,
  otherMcp: false,
}

export class AgentService {
  private readonly settingsFile: string
  private readonly keyFile: string
  private cliPath: string | null | undefined
  /** One Claude CLI run per agent role, so the Composer and the Director can work at the same time. */
  private readonly cliChildren = new Map<string, ChildProcess>()
  private readonly cliStopped = new Set<string>()

  constructor(
    private readonly directory: string,
    private readonly secrets: SecretBox,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.settingsFile = join(directory, 'agent.json')
    this.keyFile = join(directory, 'agent-key.bin')
  }

  private async stored(): Promise<StoredSettings> {
    try {
      return { ...DEFAULTS, ...(JSON.parse(await readFile(this.settingsFile, 'utf8')) as Partial<StoredSettings>) }
    } catch {
      return DEFAULTS
    }
  }

  findCli(): string | null {
    if (this.cliPath !== undefined) return this.cliPath
    const override = process.env.REBORN_CLAUDE_PATH
    if (override) return (this.cliPath = existsSync(override) ? override : null)
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' })
    const found = probe.status === 0 ? probe.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) : null
    this.cliPath = found ?? null
    return this.cliPath
  }

  async settings(): Promise<AgentSettings> {
    return { ...(await this.stored()), hasKey: existsSync(this.keyFile), cliAvailable: Boolean(this.findCli()) }
  }

  async update(patch: Partial<StoredSettings> & { apiKey?: string | null }): Promise<AgentSettings> {
    const { apiKey, ...rest } = patch
    const allowed: (keyof StoredSettings)[] = ['provider', 'model', 'baseUrl', 'directEdits', 'shareMeasurements', 'otherMcp']
    const clean = Object.fromEntries(Object.entries(rest).filter(([k]) => allowed.includes(k as keyof StoredSettings)))
    await writeAtomic(this.settingsFile, JSON.stringify({ ...(await this.stored()), ...clean }, null, 2))
    if (apiKey === null) await rm(this.keyFile, { force: true })
    else if (typeof apiKey === 'string' && apiKey.trim()) {
      if (!this.secrets.isEncryptionAvailable()) throw new Error('The OS credential store is unavailable, so the key cannot be stored safely.')
      await writeAtomic(this.keyFile, this.secrets.encryptString(apiKey.trim()))
    }
    return this.settings()
  }

  private async key(): Promise<string | null> {
    if (!existsSync(this.keyFile)) return null
    return this.secrets.decryptString(await readFile(this.keyFile))
  }

  async complete(request: AgentCompleteRequest): Promise<AgentCompleteResponse> {
    const settings = await this.stored()
    if (settings.provider === 'anthropic') return anthropicComplete(this.fetchImpl, (await this.key()) ?? '', settings.model || 'claude-sonnet-5-5', request)
    if (settings.provider === 'openai-compatible') return openAiComplete(this.fetchImpl, settings.baseUrl, (await this.key()) ?? '', settings.model, request)
    throw new Error('The Claude CLI provider runs through agentRunCli, not agentComplete.')
  }

  /**
   * Runs `claude -p` with the RE:BORN MCP server attached. Its stream of
   * events goes to `onActivity` as it arrives, so the panel can show each
   * step; the final answer is the result event's text.
   */
  async runCli(prompt: string, mcp: { command: string; args: string[]; env: Record<string, string> }, tempDir: string, options: { timeoutMs?: number; onActivity?: (activity: AgentActivity) => void; role?: string } = {}): Promise<{ text: string }> {
    const role = options.role ?? 'composer'
    const cli = this.findCli()
    if (!cli) throw new Error('The claude command was not found. Install Claude Code or choose another provider.')
    if (this.cliChildren.has(role)) throw new Error('This agent is already working. Stop it first.')
    // An empty working folder and no built-in tools: the CLI reaches only
    // RE:BORN, through its MCP server, and never other files or MCP servers.
    const workDir = join(tempDir, `reborn-agent-${role}`)
    await mkdir(workDir, { recursive: true })
    const timeoutMs = options.timeoutMs ?? 20 * 60_000
    const configFile = join(tempDir, `reborn-mcp-${process.pid}-${role}.json`)
    await writeFile(configFile, JSON.stringify({ mcpServers: { reborn: mcp } }))
    this.cliStopped.delete(role)
    // By default the CLI loads only RE:BORN's MCP server. With otherMcp on it
    // also loads the user's own servers and may call them without asking,
    // which -p mode needs; built-in tools stay off either way.
    const otherMcp = (await this.stored()).otherMcp
    const access = otherMcp ? ['--permission-mode', 'bypassPermissions'] : ['--strict-mcp-config', '--allowedTools', 'mcp__reborn']
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(cli, ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--tools', '', '--mcp-config', configFile, ...access], { cwd: workDir, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli), windowsHide: true })
        this.cliChildren.set(role, child)
        let stdout = ''
        let pending = ''
        let stderr = ''
        const timer = setTimeout(() => {
          this.cancelCli(role)
          reject(new Error(`The Claude CLI did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`))
        }, timeoutMs)
        child.stdout?.setEncoding('utf8')
        child.stdout?.on('data', (chunk: string) => {
          stdout += chunk
          pending += chunk
          let newline: number
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline)
            pending = pending.slice(newline + 1)
            for (const activity of streamActivity(line)) options.onActivity?.(activity)
          }
        })
        child.stderr?.on('data', (chunk) => (stderr += chunk))
        child.on('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (this.cliStopped.has(role)) reject(new Error('Stopped.'))
          else if (code === 0) resolve(stdout)
          else reject(new Error(`The Claude CLI exited with code ${code}: ${stderr.slice(0, 400)}`))
        })
      })
      return { text: parseCliOutput(streamToJson(output)) }
    } finally {
      this.cliChildren.delete(role)
      await rm(configFile, { force: true })
    }
  }

  /** Stops a running Claude CLI and the processes it started. */
  /** Stops one role's CLI run, or every run when no role is given. */
  cancelCli(role?: string): void {
    if (role === undefined) {
      for (const key of [...this.cliChildren.keys()]) this.cancelCli(key)
      return
    }
    const child = this.cliChildren.get(role)
    if (!child?.pid) return
    this.cliStopped.add(role)
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill())
    else child.kill()
  }
}

/** Turns stream-json output (one event per line) into a JSON array for parseCliOutput. */
export function streamToJson(output: string): string {
  const events = output.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      return [JSON.parse(line) as unknown]
    } catch {
      return []
    }
  })
  return events.length ? JSON.stringify(events) : output
}

/** The steps in one stream-json line: tool calls and text the model writes along the way. */
export function streamActivity(line: string): AgentActivity[] {
  let event: { type?: string; message?: { content?: { type?: string; text?: string; name?: string; input?: unknown }[] } }
  try {
    event = JSON.parse(line) as typeof event
  } catch {
    return []
  }
  if (event?.type !== 'assistant' || !Array.isArray(event.message?.content)) return []
  return event.message.content.flatMap((block): AgentActivity[] => {
    if (block.type === 'tool_use' && block.name) return [{ kind: 'tool', name: block.name, input: block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {} }]
    if (block.type === 'text' && block.text?.trim()) return [{ kind: 'text', text: block.text.trim() }]
    return []
  })
}

/**
 * Reads the answer from `claude -p --output-format json`. Older versions print
 * one result object; newer ones print an array of events that ends with it.
 * Output that isn't JSON is returned as text.
 */
export function parseCliOutput(output: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return output.trim()
  }
  const events = Array.isArray(parsed) ? parsed : [parsed]
  const isResult = (e: unknown): e is { type?: string; result?: unknown; is_error?: boolean } => Boolean(e) && typeof e === 'object' && ((e as { type?: string }).type === 'result' || 'result' in (e as object))
  const result = [...events].reverse().find(isResult)
  if (!result) throw new Error('The Claude CLI finished without an answer.')
  const text = typeof result.result === 'string' ? result.result : ''
  if (result.is_error) throw new Error(text || 'The Claude CLI reported an error.')
  return text
}

async function failed(response: Response, provider: string): Promise<Error> {
  let detail = ''
  try {
    const body = (await response.json()) as { error?: { message?: string } | string }
    detail = typeof body.error === 'string' ? body.error : (body.error?.message ?? '')
  } catch {
    // Non-JSON error bodies keep only the status.
  }
  if (response.status === 401 || response.status === 403) return new Error(`${provider} rejected the API key. Check it in the agent settings.`)
  return new Error(`${provider} returned ${response.status}${detail ? `: ${detail}` : ''}.`)
}

export async function anthropicComplete(fetchImpl: typeof fetch, apiKey: string, model: string, request: AgentCompleteRequest, baseUrl = 'https://api.anthropic.com'): Promise<AgentCompleteResponse> {
  if (!apiKey) throw new Error('Add your Anthropic API key in the agent settings.')
  const response = await fetchImpl(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: request.maxTokens ?? 2048, system: request.system, messages: toAnthropicMessages(request), tools: request.tools }),
  })
  if (!response.ok) throw await failed(response, 'The Claude API')
  const body = (await response.json()) as { content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[]; stop_reason: string }
  const content: AgentContent[] = []
  for (const block of body.content ?? []) {
    if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text })
    if (block.type === 'tool_use' && block.id && block.name) content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} })
  }
  return { content, stopReason: body.stop_reason }
}

/** Tool results with images become the Messages API's image blocks. */
export function toAnthropicMessages(request: AgentCompleteRequest): unknown[] {
  return request.messages.map((message) => ({
    role: message.role,
    content: message.content.map((block) => {
      if (block.type !== 'tool_result' || typeof block.content === 'string') return block
      return {
        ...block,
        content: block.content.map((part) => (part.type === 'text' ? part : { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } })),
      }
    }),
  }))
}

const resultText = (content: string | AgentResultPart[]) => (typeof content === 'string' ? content : content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n'))

type OpenAiPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAiPart[] | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

/** Converts provider-neutral messages to the OpenAI chat format. */
export function toOpenAiMessages(request: AgentCompleteRequest): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [{ role: 'system', content: request.system }]
  for (const message of request.messages) {
    if (message.role === 'assistant') {
      const text = message.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n')
      const calls = message.content.filter((c) => c.type === 'tool_use') as Extract<AgentContent, { type: 'tool_use' }>[]
      messages.push({ role: 'assistant', content: text || null, ...(calls.length && { tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input) } })) }) })
      continue
    }
    const text = message.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n')
    const images: OpenAiPart[] = []
    for (const result of message.content.filter((c) => c.type === 'tool_result') as Extract<AgentContent, { type: 'tool_result' }>[]) {
      const content = resultText(result.content)
      messages.push({ role: 'tool', tool_call_id: result.tool_use_id, content: result.is_error ? `Error: ${content}` : content })
      // Tool messages carry only text; images follow in a user message.
      if (typeof result.content !== 'string') for (const part of result.content) if (part.type === 'image') images.push({ type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } })
    }
    if (images.length) messages.push({ role: 'user', content: [{ type: 'text', text: 'Images from the tool results above.' }, ...images] })
    if (text) messages.push({ role: 'user', content: text })
  }
  return messages
}

export async function openAiComplete(fetchImpl: typeof fetch, baseUrl: string, apiKey: string, model: string, request: AgentCompleteRequest): Promise<AgentCompleteResponse> {
  if (!model) throw new Error('Choose a model name for the local server, for example llama3.1.')
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey && { authorization: `Bearer ${apiKey}` }) },
    body: JSON.stringify({
      model,
      max_tokens: request.maxTokens ?? 2048,
      messages: toOpenAiMessages(request),
      tools: request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    }),
  })
  if (!response.ok) throw await failed(response, 'The model server')
  const body = (await response.json()) as { choices: { message: OpenAiMessage; finish_reason: string }[] }
  const choice = body.choices?.[0]
  if (!choice) throw new Error('The model server returned no answer.')
  const content: AgentContent[] = []
  if (typeof choice.message.content === 'string' && choice.message.content) content.push({ type: 'text', text: choice.message.content })
  for (const call of choice.message.tool_calls ?? []) {
    let input: Record<string, unknown> = {}
    try {
      input = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
    } catch {
      input = {}
    }
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input })
  }
  return { content, stopReason: choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason }
}
