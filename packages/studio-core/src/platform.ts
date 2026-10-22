import type { ProjectState } from './model'
import type { StudioProject } from './studio/model'
import type { FootageProvider, LicenceKind, LicencePolicy } from './studio/video'
import type { LibraryItem } from './studio/video-library'
import type { ApiEvent } from './api'
import type { ProjectAssetKind, ProjectDocument } from './project-file'

// Contract between the desktop main process and the renderer. The preload
// script exposes exactly this surface as `window.reborn`; nothing else from
// Node or Electron reaches the page.

export interface DesktopAssetPayload {
  id: string
  kind: ProjectAssetKind
  name: string
  mimeType: string
  data: ArrayBuffer
}

export interface OpenedProject {
  path: string
  document: ProjectDocument
  assets: DesktopAssetPayload[]
  missing: string[]
}

export interface SaveProjectRequest {
  path: string | null
  saveAs: boolean
  /** v1 workstation project. */
  project?: ProjectState
  /** v2 studio project. */
  studio?: StudioProject
  assets: DesktopAssetPayload[]
}

export interface SaveProjectResult {
  path: string
  savedAt: string
  writtenAssets: number
  reusedAssets: number
}

export interface RecentProject {
  path: string
  name: string
  openedAt: string
}

/** The latest unsaved state of one project, kept until it's saved or deleted. */
export interface AutosaveEntry {
  /** The project's ID; one autosave per project. */
  id: string
  name: string
  /** Where the project was last saved, or null if it never was. */
  path: string | null
  savedAt: string
  tracks: number
  bars: number
}

export interface RecoveryState {
  project?: ProjectState
  studio?: StudioProject
  path: string | null
  savedAt: string
}

export type MenuCommand = 'new' | 'open-path' | 'save' | 'save-as' | 'pack' | 'export-wav' | 'undo' | 'redo' | 'recover'

export interface MenuEvent {
  command: MenuCommand
  /** Set for `open-path`: main already chose the project to open. */
  path?: string
  /** Set for `new`: the template to start from. */
  template?: string
}

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled'

export interface JobUpdate {
  id: string
  kind: 'pack' | 'analysis' | 'install'
  status: JobStatus
  completed: number
  total: number
  message?: string
  outputPath?: string
}

export type LogLevel = 'info' | 'warn' | 'error'

export interface FootageSearchRequest {
  query: string
  providers: FootageProvider[]
  /** Results with licences outside this policy are left out. */
  licences: LicencePolicy
  perProvider?: number
}

/** A clip a provider offers, in the shape video.footage.add takes. */
export interface FootageCandidate {
  provider: FootageProvider
  sourceId: string
  title: string
  page: string
  author: string
  licence: LicenceKind
  licenceName: string
  licenceUrl: string
  /** A small image data URL fetched through the main process, or empty. */
  thumbnail: string
  url: string
  width: number
  height: number
  duration: number
  query: string
}

export interface FootageSearchResult {
  candidates: FootageCandidate[]
  /** Providers that failed, for example without an API key. */
  errors: { provider: string; message: string }[]
}

/** Song grid passed to the sidecar so tempo-aware reports number bars like RE:BORN. */
export interface DeepTempo {
  bpm: number
  beatsPerBar: number
}

export interface IsmailStatus {
  installed: boolean
  /** PyTorch and Demucs are installed, so stems can be separated. */
  separation: boolean
  version: string | null
  installing: boolean
  message: string | null
}

export interface IsmailPresets {
  presets: { name: string; type: string }[]
  voices: { name: string; family: string; summary: string }[]
}

export interface IsmailGenerateRequest {
  name: string
  /** A preset name, or an Ismail instrument object such as `{ type: 'code', voice: 'growl' }`. */
  instrument: string | Record<string, unknown>
  /** Notes in Ismail's notes_write format: `beat pitch length [velocity]`, one per line or separated by `;`. */
  notes: string
  bpm: number
  tailSeconds?: number
}

export interface IsmailSound {
  name: string
  /** First line of Ismail's timbre report. */
  summary: string
  description: string
  wav: Uint8Array
}

export interface IsmailStem {
  name: string
  wav: Uint8Array
}

export type AgentProvider = 'claude-cli' | 'anthropic' | 'openai-compatible'

export interface AgentSettings {
  provider: AgentProvider
  model: string
  /** Base URL for OpenAI-compatible servers such as Ollama or LM Studio. */
  baseUrl: string
  /** True when an API key is stored in the OS credential store. */
  hasKey: boolean
  /** Agent edits apply directly instead of waiting for review. Off by default. */
  directEdits: boolean
  /** Allow compact measurements (never raw audio) in cloud requests. */
  shareMeasurements: boolean
  /** Claude CLI only: also load the MCP servers set up in Claude Code. Off by default; built-in tools stay off either way. */
  otherMcp: boolean
  /** Whether the `claude` executable was found on PATH. */
  cliAvailable: boolean
}

/** Part of a tool result: text, or an image the model looks at (a still or contact sheet). */
export type AgentResultPart = { type: 'text'; text: string } | { type: 'image'; mediaType: 'image/png' | 'image/jpeg'; data: string }

export type AgentContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | AgentResultPart[]; is_error?: boolean }

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: AgentContent[]
}

export interface AgentToolSpec {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface AgentCompleteRequest {
  system: string
  messages: AgentMessage[]
  tools: AgentToolSpec[]
  maxTokens?: number
}

export interface AgentCompleteResponse {
  content: AgentContent[]
  stopReason: string
}

/** A local-API request the main process forwards to the renderer, which owns the project. */
export interface ApiRpcRequest {
  id: string
  route: 'status' | 'execute' | 'runtime'
  body: unknown
}

export interface ApiRpcResponse {
  id: string
  status: number
  body: unknown
}

export interface DesktopBridge {
  platform: 'desktop'
  getVersion(): Promise<string>
  openProject(path?: string): Promise<OpenedProject | null>
  saveProject(request: SaveProjectRequest): Promise<SaveProjectResult | null>
  listRecent(): Promise<RecentProject[]>
  packProject(path: string): Promise<{ jobId: string } | null>
  cancelJob(id: string): Promise<void>
  saveWav(data: ArrayBuffer, suggestedName: string): Promise<string | null>
  /** Visual Library items saved in the app's user data. */
  libraryList(): Promise<LibraryItem[]>
  /** Saves a library item, bumping its version; footage items pass their clip bytes the first time. */
  librarySave(item: LibraryItem, footage?: ArrayBuffer): Promise<LibraryItem>
  libraryRemove(id: string): Promise<void>
  libraryReadFootage(id: string): Promise<ArrayBuffer | null>
  /** Which footage providers have an API key stored. */
  footageKeys(): Promise<{ pexels: boolean; pixabay: boolean }>
  /** Stores (string) or removes (null) footage API keys in the OS credential store. */
  footageSetKeys(patch: { pexels?: string | null; pixabay?: string | null }): Promise<{ pexels: boolean; pixabay: boolean }>
  footageSearch(request: FootageSearchRequest): Promise<FootageSearchResult>
  /** Downloads an approved clip from a footage provider, within a byte limit. */
  footageDownload(request: { url: string; maxBytes: number }): Promise<{ data: ArrayBuffer; mimeType: string }>
  /** Asks where to save an exported MP4 and opens it for streaming. Null when cancelled. */
  videoExportBegin(suggestedName: string): Promise<{ id: string; path: string } | null>
  /** Writes encoded bytes at a file position. */
  videoExportWrite(id: string, position: number, data: Uint8Array): Promise<void>
  /** Completes the file and writes text files (description, credits) beside it. Returns the path. */
  videoExportFinish(id: string, extras?: { name: string; text: string }[]): Promise<string>
  /** Deletes an unfinished export. */
  videoExportAbort(id: string): Promise<void>
  writeRecovery(state: { project?: ProjectState; studio?: StudioProject; path: string | null }): void
  takeRecovery(): Promise<RecoveryState | null>
  /** Keeps the latest unsaved state of a project on disk. */
  writeAutosave(state: { studio: StudioProject; path: string | null }): Promise<void>
  /** Drops a project's autosave, after it's saved or when the user deletes it. */
  deleteAutosave(id: string): Promise<void>
  listAutosaves(): Promise<AutosaveEntry[]>
  readAutosave(id: string): Promise<{ studio: StudioProject; path: string | null } | null>
  setDocumentState(state: { title: string; edited: boolean }): void
  log(level: LogLevel, message: string): void
  onMenuCommand(listener: (event: MenuEvent) => void): () => void
  onJobUpdate(listener: (update: JobUpdate) => void): () => void
  getAgentSettings(): Promise<AgentSettings>
  setAgentSettings(patch: Partial<Omit<AgentSettings, 'hasKey' | 'cliAvailable'>> & { apiKey?: string | null }): Promise<AgentSettings>
  agentComplete(request: AgentCompleteRequest): Promise<AgentCompleteResponse>
  /** Runs the Claude CLI with the RE:BORN MCP server attached, as the Composer or the Director, and returns its final answer. Steps arrive through `onAgentActivity`. */
  agentRunCli(prompt: string, role?: 'composer' | 'director'): Promise<{ text: string }>
  /** What the Claude CLI is doing while `agentRunCli` runs: each tool call and each note it writes. */
  onAgentActivity(listener: (activity: AgentActivity) => void): () => void
  /** Stops a running `agentRunCli`; it rejects with "Stopped." */
  /** Stops one agent's run, or every run without a role. */
  agentCancel(role?: 'composer' | 'director'): void
  onApiRequest(listener: (request: ApiRpcRequest) => void): () => void
  respondApi(response: ApiRpcResponse): void
  /** Publishes a local-API event (project revision, proposal status) to connected clients. */
  emitApiEvent(event: ApiEvent): void
  /** Number of local API clients seen recently, for the status bar. */
  apiClients(): Promise<number>
  /** Deep analysis through the optional Python sidecar. Progress arrives as `analysis` job updates. */
  deepAnalyze(request: { wav: ArrayBuffer; sections: { id: string; start: number; end: number }[]; tempo?: DeepTempo }): Promise<unknown>
  /** Asks for a reference file, then compares the render against it. Null when cancelled. */
  deepCompare(request: { wav: ArrayBuffer; tempo?: DeepTempo }): Promise<unknown | null>
  deepCancel(): void
  ismailStatus(): Promise<IsmailStatus>
  /** Installs Ismail (and with `separation`, PyTorch and Demucs) into the app's Python environment. Progress arrives as `install` job updates. */
  ismailInstall(request: { separation: boolean }): Promise<IsmailStatus>
  ismailPresets(): Promise<IsmailPresets>
  /** Synthesizes a sound with Ismail. Nothing is added to the project until the studio imports the WAV. */
  ismailGenerate(request: IsmailGenerateRequest): Promise<IsmailSound>
  /** Splits a WAV into drums, bass, other, and vocals with Demucs. Cancel with `deepCancel`. */
  ismailSeparate(request: { wav: ArrayBuffer }): Promise<IsmailStem[]>
  deepStatus(): Promise<{ status: string; backend: string | null; python: string | null; message: string | null }>
  /** Looks for a newer release. The result arrives through `onUpdateEvent`. */
  updateCheck(): Promise<void>
  /** Downloads the release that `available` announced. */
  updateDownload(): Promise<void>
  /** Quits and installs a downloaded update. */
  updateInstall(): Promise<void>
  /** The last update event, so a page that loads after the startup check still sees it. */
  updateCurrent(): Promise<UpdateEvent | null>
  onUpdateEvent(listener: (event: UpdateEvent) => void): () => void
  /** Development and test builds only: sends a fake update event to drive the UI. */
  updateSimulate(event: UpdateEvent): Promise<void>
}

/**
 * Where an app update stands. Main sends each step as it happens; checks the
 * app runs on its own report only `available`, never `checking`,
 * `not-available`, or `error`.
 */
export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'not-available' }
  | { type: 'available'; version: string; releaseNotes: string }
  | { type: 'downloading'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }

/** One step of a Claude CLI run, streamed to the agent panel. */
export type AgentActivity = ({ kind: 'tool'; name: string; input: Record<string, unknown> } | { kind: 'text'; text: string }) & {
  /** Which agent's run it comes from. */
  role?: 'composer' | 'director'
}

/** IPC channel names. Kept in one place so main and preload cannot drift. */
export const IPC = {
  openProject: 'project:open',
  saveProject: 'project:save',
  listRecent: 'recent:list',
  packProject: 'job:pack',
  cancelJob: 'job:cancel',
  jobUpdate: 'job:update',
  saveWav: 'wav:save',
  videoExportBegin: 'video-export:begin',
  videoExportWrite: 'video-export:write',
  videoExportFinish: 'video-export:finish',
  videoExportAbort: 'video-export:abort',
  libraryList: 'library:list',
  librarySave: 'library:save',
  libraryRemove: 'library:remove',
  libraryReadFootage: 'library:read-footage',
  footageKeys: 'footage:keys',
  footageSetKeys: 'footage:set-keys',
  footageSearch: 'footage:search',
  footageDownload: 'footage:download',
  writeRecovery: 'recovery:write',
  takeRecovery: 'recovery:take',
  writeAutosave: 'autosave:write',
  deleteAutosave: 'autosave:delete',
  listAutosaves: 'autosave:list',
  readAutosave: 'autosave:read',
  documentState: 'window:document-state',
  log: 'log:write',
  menu: 'menu:command',
  version: 'app:version',
  agentSettings: 'agent:settings',
  agentSetSettings: 'agent:set-settings',
  agentComplete: 'agent:complete',
  agentRunCli: 'agent:run-cli',
  agentActivity: 'agent:activity',
  agentCancel: 'agent:cancel',
  apiRequest: 'api:request',
  apiResponse: 'api:response',
  apiClients: 'api:clients',
  apiEvent: 'api:event',
  deepAnalyze: 'deep:analyze',
  deepCompare: 'deep:compare',
  deepCancel: 'deep:cancel',
  deepStatus: 'deep:status',
  ismailStatus: 'ismail:status',
  ismailInstall: 'ismail:install',
  ismailPresets: 'ismail:presets',
  ismailGenerate: 'ismail:generate',
  ismailSeparate: 'ismail:separate',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateEvent: 'update:event',
  updateCurrent: 'update:current',
  updateSimulate: 'update:simulate',
} as const
