import { KeyRound, MessageSquareX, Send, ShieldCheck, Sparkles, Square, X } from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import type { AgentProvider } from '@reborn/studio-core'
import { type AgentRole, ask, clearConversation, loadAgentSettings, setAgentRole, stopAgent, updateAgentSettings, useAgent } from '../agent/agent'
import { type Inline, parseMarkdown } from '../agent/markdown'
import { desktop } from '../platform/desktop'
import { setState } from '../state/store'

const PROVIDERS: { id: AgentProvider; label: string; note: string }[] = [
  { id: 'claude-cli', label: 'Claude CLI', note: 'Uses your installed Claude Code login; it reaches RE:BORN through MCP.' },
  { id: 'anthropic', label: 'Claude API', note: 'Uses your Anthropic API key, stored in the OS credential store.' },
  { id: 'openai-compatible', label: 'Local or compatible', note: 'Ollama, LM Studio, or any OpenAI-compatible server.' },
]

function Settings() {
  const settings = useAgent((s) => s.settings)
  const [key, setKey] = useState('')
  if (!settings) return null
  const provider = PROVIDERS.find((p) => p.id === settings.provider)!
  const cloud = settings.provider !== 'openai-compatible' || !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(settings.baseUrl)
  return (
    <div className="agent-settings">
      <div className="seg sm" role="radiogroup" aria-label="Agent provider">
        {PROVIDERS.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={settings.provider === p.id} className={settings.provider === p.id ? 'is-on' : ''} onClick={() => void updateAgentSettings({ provider: p.id, model: p.id === 'anthropic' ? 'claude-sonnet-5-5' : p.id === 'openai-compatible' ? 'llama3.1' : '' })}>
            {p.label}
          </button>
        ))}
      </div>
      <p className="muted small">{provider.note}</p>
      {settings.provider === 'claude-cli' && !settings.cliAvailable && <p className="warn small">The claude command was not found on this computer.</p>}
      {settings.provider !== 'claude-cli' && (
        <label className="field">
          <span className="field-label">Model</span>
          <input type="text" defaultValue={settings.model} key={settings.provider} onKeyDown={(event) => event.stopPropagation()} onBlur={(event) => void updateAgentSettings({ model: event.target.value.trim() })} />
        </label>
      )}
      {settings.provider === 'openai-compatible' && (
        <label className="field">
          <span className="field-label">Server URL</span>
          <input type="text" defaultValue={settings.baseUrl} onKeyDown={(event) => event.stopPropagation()} onBlur={(event) => void updateAgentSettings({ baseUrl: event.target.value.trim() })} />
        </label>
      )}
      {settings.provider !== 'claude-cli' && (
        <div className="key-row">
          <KeyRound size={13} />
          <input type="password" placeholder={settings.hasKey ? 'Key stored — type to replace' : 'API key'} value={key} onChange={(event) => setKey(event.target.value)} onKeyDown={(event) => event.stopPropagation()} aria-label="API key" />
          <button type="button" className="chip-btn" disabled={!key} onClick={() => void updateAgentSettings({ apiKey: key }).then(() => setKey(''))}>
            Save key
          </button>
          {settings.hasKey && (
            <button type="button" className="chip-btn" onClick={() => void updateAgentSettings({ apiKey: null })}>
              Forget
            </button>
          )}
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={settings.shareMeasurements} onChange={(event) => void updateAgentSettings({ shareMeasurements: event.target.checked })} />
        Share measurements (loudness, band energy, warnings) with {cloud ? 'this cloud provider' : 'this local server'}
      </label>
      {settings.provider === 'claude-cli' && (
        <label className="check">
          <input type="checkbox" checked={settings.otherMcp} onChange={(event) => void updateAgentSettings({ otherMcp: event.target.checked })} />
          Let the agent use my other Claude Code MCP servers too, without asking each time. Off: it reaches only RE:BORN. Shell and file tools stay off either way, and your Claude Code settings aren't changed.
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={settings.directEdits} onChange={(event) => void updateAgentSettings({ directEdits: event.target.checked })} />
        Let the agent edit directly instead of proposing (each edit is still one undo step)
      </label>
      <p className="disclosure">
        <ShieldCheck size={12} />
        {cloud ? 'Sent to the provider: track names, patterns, mixer settings' : 'Stays on this computer'}
        {cloud && settings.shareMeasurements ? ', and measurement numbers' : ''}. Raw audio never leaves this computer.
      </p>
    </div>
  )
}

function InlineText({ runs }: { runs: Inline[] }) {
  return (
    <>
      {runs.map((run, i) => (run.kind === 'bold' ? <strong key={i}>{run.text}</strong> : run.kind === 'code' ? <code key={i}>{run.text}</code> : <Fragment key={i}>{run.text}</Fragment>))}
    </>
  )
}

/** An agent reply, with its Markdown headings, lists, bold, and code rendered. */
function AgentText({ text }: { text: string }) {
  return (
    <div className="agent-text">
      {parseMarkdown(text).map((block, i) =>
        block.kind === 'heading' ? (
          <h4 key={i}>
            <InlineText runs={block.inline} />
          </h4>
        ) : block.kind === 'paragraph' ? (
          <p key={i}>
            <InlineText runs={block.inline} />
          </p>
        ) : (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j} style={{ marginLeft: item.depth * 14 }}>
                <b aria-hidden="true">{item.marker}</b>
                <span>
                  <InlineText runs={item.inline} />
                </span>
              </li>
            ))}
          </ul>
        ),
      )}
    </div>
  )
}

/** "Working… 1:05" while the agent runs. */
function Working() {
  const startedAt = useAgent((s) => s.startedAt)
  const working = useAgent((s) => s.working)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0
  return (
    <p className="agent thinking">
      <span>{working === 'director' ? 'Director' : 'Composer'}</span>Working… {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </p>
  )
}

const INTROS: Record<AgentRole, { text: string; examples: string[] }> = {
  composer: {
    text: 'Ask for help with the song, or ask for a whole song. The Composer reads the project, makes sounds with Ismail, measures the mix before judging it, and proposes changes you review on the timeline and mixer. Each step it takes shows here as it works.',
    examples: ['Why is there echo in the drop?', 'Make the drop hit harder without clipping', 'Write a 16-step acid line in A minor on Acid 1', 'Add an 8-bar breakdown before the last section', 'Make a 32-bar acid house track at 126 BPM'],
  },
  director: {
    text: 'The Director makes a music video for this song in the Video view. It plans scenes from the song’s sections and drums, checks them with stills, finds stock footage you approve, and renders drafts. It changes only the video, and stops for your approval at each stage. Leave comments in the Video view at any time; it answers them on its next turn.',
    examples: ['Plan a dark, heavy video for this track', 'Make the drops hit harder and keep the intro calm', 'Add a title slam on the first drop and words on the snares', 'Find lightning footage for the breakdown'],
  },
}

export function AgentPanel() {
  const role = useAgent((s) => s.role)
  const lines = useAgent((s) => s.conversations[s.role])
  const busy = useAgent((s) => s.busy)
  const working = useAgent((s) => s.working)
  const [draft, setDraft] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const log = useRef<HTMLDivElement>(null)
  useEffect(() => {
    void loadAgentSettings()
  }, [])
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight })
  }, [lines.length, busy])
  return (
    <aside className="agent-panel" aria-label="Agent">
      <header>
        <Sparkles size={15} />
        <div className="seg sm" role="radiogroup" aria-label="Agent role">
          {(['composer', 'director'] as const).map((r) => (
            <button key={r} type="button" role="radio" aria-checked={role === r} className={role === r ? 'is-on' : ''} onClick={() => setAgentRole(r)}>
              {r === 'composer' ? 'Composer' : 'Director'}
              {working === r && ' ●'}
            </button>
          ))}
        </div>
        <button type="button" className="icon-btn" aria-label="Clear conversation" title="Clear conversation" disabled={busy || !lines.length} onClick={clearConversation}>
          <MessageSquareX size={15} />
        </button>
        {desktop && (
          <button type="button" className={`chip-btn${showSettings ? ' is-on' : ''}`} onClick={() => setShowSettings(!showSettings)}>
            Settings
          </button>
        )}
        <button type="button" className="icon-btn" aria-label="Close agent" onClick={() => setState({ agentOpen: false })}>
          <X size={16} />
        </button>
      </header>
      {showSettings && <Settings />}
      <div className="agent-log" ref={log} aria-live="polite">
        {!lines.length && (
          <div className="agent-empty">
            <p>{INTROS[role].text}</p>
            {INTROS[role].examples.map((example) => (
              <button key={example} type="button" className="chip-btn" onClick={() => void ask(example)}>
                {example}
              </button>
            ))}
          </div>
        )}
        {lines.map((line, i) =>
          line.role === 'agent' ? (
            <div key={i} className="agent-line agent">
              <span>{role === 'director' ? 'Director' : 'Composer'}</span>
              <AgentText text={line.text} />
            </div>
          ) : (
            <p key={i} className={line.role}>
              <span>{line.role === 'user' ? 'You' : '·'}</span>
              {line.text}
            </p>
          ),
        )}
        {busy && <Working />}
      </div>
      <form
        className="agent-input"
        onSubmit={(event) => {
          event.preventDefault()
          void ask(draft)
          setDraft('')
        }}
      >
        <textarea value={draft} rows={2} placeholder={role === 'director' ? 'Ask the Director…' : 'Ask the Composer…'} aria-label="Message the agent" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            void ask(draft)
            setDraft('')
          }
        }} />
        {busy ? (
          <button type="button" className="icon-btn" onClick={stopAgent} aria-label="Stop the agent" title="Stop the agent">
            <Square size={14} />
          </button>
        ) : (
          <button type="submit" className="icon-btn" disabled={!draft.trim()} aria-label="Send">
            <Send size={16} />
          </button>
        )}
      </form>
    </aside>
  )
}
