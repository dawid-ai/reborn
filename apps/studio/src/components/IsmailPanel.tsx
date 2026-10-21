import { Download, Sparkles, WandSparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { loadAgentSettings, useAgent } from '../agent/agent'
import { agentProblem, draftSound } from '../agent/sound'
import { generateSound, installIsmail, refreshIsmail, useIsmail } from '../audio/ismail'
import { desktop } from '../platform/desktop'
import { getState, selectedTrackId, setState, toast } from '../state/store'

/** Note starters for writing by hand. Beats run 0 to 4 per bar. */
const STARTERS: { label: string; notes: string }[] = [
  { label: 'Single note', notes: '0 C2 0.5 110' },
  { label: 'Drum hit', notes: '0 C1 0.25 120' },
  { label: 'Bassline, 1 bar', notes: '0 C2 0.5 110; 0.75 C2 0.25 90; 1.5 D#2 0.5 100; 2 C2 0.5 110; 2.75 G1 0.25 90; 3 A#1 0.5 100; 3.5 C2 0.5 110' },
  { label: 'Arpeggio, 1 bar', notes: '0 C3 0.25; 0.25 D#3 0.25; 0.5 G3 0.25; 0.75 A#3 0.25; 1 C4 0.25; 1.25 A#3 0.25; 1.5 G3 0.25; 1.75 D#3 0.25; 2 C3 0.25; 2.25 D#3 0.25; 2.5 G3 0.25; 2.75 A#3 0.25; 3 C4 0.25; 3.25 A#3 0.25; 3.5 G3 0.25; 3.75 D#3 0.25' },
  { label: 'Chord stab', notes: '0 C3,D#3,G3 0.5 110' },
  { label: 'Pad chord, 2 bars', notes: '0 C3,D#3,G3,A#3 8 90' },
]

const ISMAIL_URL = 'https://github.com/newsbubbles/ismail'
const DEMUCS_URL = 'https://github.com/adefossez/demucs'

/** Credit for the open-source projects this tab runs. */
function IsmailCredit({ version, separation }: { version?: string | null; separation?: boolean }) {
  return (
    <p className="browser-note ismail-credit">
      Powered by <a href={ISMAIL_URL} target="_blank" rel="noreferrer">Ismail</a>{version ? ` ${version}` : ''} by Nate Codes (newsbubbles), MIT license.
      {separation !== false && <> Stem separation uses <a href={DEMUCS_URL} target="_blank" rel="noreferrer">Demucs</a> by Meta, MIT license.</>}
    </p>
  )
}

const DRUMS = new Set(['kick', 'snare', 'clap', 'hat', 'kit'])

/** Browser tab: synthesize sounds with Ismail's instruments and voices. */
export function IsmailPanel() {
  const status = useIsmail((s) => s.status)
  const presets = useIsmail((s) => s.presets)
  const busy = useIsmail((s) => s.busy)
  const last = useIsmail((s) => s.lastSound)
  const [instrument, setInstrument] = useState('preset:acid_bass')
  const [notes, setNotes] = useState('0 C2 0.5 110')
  const [name, setName] = useState('')
  const [tail, setTail] = useState(1)
  const [description, setDescription] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [draftNote, setDraftNote] = useState('')
  const agentSettings = useAgent((s) => s.settings)

  useEffect(() => {
    if (!desktop) return
    void refreshIsmail()
    void loadAgentSettings()
  }, [])

  if (!desktop) {
    return (
      <div className="browser-list">
        <p className="browser-note">Sound generation and stem separation use Ismail, which runs in the RE:BORN desktop app.</p>
      </div>
    )
  }
  if (!status) return <div className="browser-list"><p className="browser-note">Checking for Ismail…</p></div>

  if (!status.installed) {
    return (
      <div className="browser-list ismail">
        <p className="browser-note">
          Ismail is an open-source audio toolkit: synths, modeled instruments, and analysis that reads audio back as text. RE:BORN uses it to make sounds and split recordings into stems.
        </p>
        <p className="browser-note">Installing downloads it from GitHub and its libraries from PyPI into RE:BORN's own Python environment. It needs Python 3.10 or later and about 650 MB of disk space.</p>
        <button type="button" className="chip-btn" disabled={busy !== null} onClick={() => void installIsmail(false)}>
          <Download size={13} />
          {busy === 'install' ? 'Installing Ismail…' : 'Install Ismail'}
        </button>
        {status.message && <p className="browser-note is-error">{status.message}</p>}
        <IsmailCredit separation={false} />
      </div>
    )
  }

  const [kind, value] = instrument.split(':') as ['preset' | 'voice', string]
  const preset = presets?.presets.find((p) => p.name === value)
  const label = name.trim() || value.replace(/_/g, ' ')
  const generate = () => void generateSound({ name: label, instrument: kind === 'voice' ? { type: 'code', voice: value } : value, notes, tailSeconds: tail })
  const agentBlocked = agentProblem(agentSettings)
  // The agent picks the instrument and writes the notes into the fields, then
  // generates; the fields stay editable for another try.
  const writeAndGenerate = async () => {
    if (!presets || !agentSettings) return
    setDrafting(true)
    setDraftNote('')
    try {
      const s = getState()
      const selected = s.project.tracks.find((t) => t.id === selectedTrackId(s))
      const draft = await draftSound(description.trim(), presets, { tempo: s.project.tempo, destination: selected?.kind === 'sampler' ? 'sampler' : 'audio', current: { instrument, notes } }, agentSettings)
      setInstrument(draft.instrument)
      setNotes(draft.notes)
      setName(draft.name)
      setTail(draft.tailSeconds)
      setDraftNote(draft.summary)
      const [draftKind, draftValue] = draft.instrument.split(':')
      await generateSound({ name: draft.name, instrument: draftKind === 'voice' ? { type: 'code', voice: draftValue } : draftValue, notes: draft.notes, tailSeconds: draft.tailSeconds })
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setDrafting(false)
    }
  }
  const pick = (next: string) => {
    setInstrument(next)
    const [nextKind, nextValue] = next.split(':')
    const type = nextKind === 'preset' ? presets?.presets.find((p) => p.name === nextValue)?.type : 'code'
    // Drum voices ignore pitch; a short hit is the useful default.
    if (type && DRUMS.has(type)) setNotes('0 C1 0.25 120')
  }

  return (
    <div className="browser-list ismail">
      <p className="browser-note">Make a sound with Ismail. It loads into the selected Sampler, lands on the selected Audio track at the playhead, or gets a new audio track.</p>
      <label className="field">
        <span className="field-label">Describe it</span>
        <textarea rows={2} value={description} placeholder="Rubbery acid bassline, one bar, in A minor" onKeyDown={(event) => event.stopPropagation()} onChange={(event) => setDescription(event.target.value)} aria-describedby="ismail-describe-help" />
      </label>
      {agentBlocked ? (
        <p className="browser-note" id="ismail-describe-help">
          {agentBlocked}{' '}
          <button type="button" className="link-btn" onClick={() => setState({ agentOpen: true })}>
            Open Agent
          </button>
        </p>
      ) : (
        <p className="browser-note" id="ismail-describe-help">The agent picks an instrument and writes the notes below, then generates. Edit them and click Generate to try again.</p>
      )}
      <button type="button" className="chip-btn primary" disabled={drafting || busy !== null || !presets || !description.trim() || Boolean(agentBlocked)} onClick={() => void writeAndGenerate()}>
        <WandSparkles size={13} />
        {drafting ? 'Writing notes…' : 'Write and generate'}
      </button>
      {draftNote && <p className="browser-note ismail-draft">Agent: {draftNote}</p>}
      <label className="field">
        <span className="field-label">Instrument</span>
        <select value={presets ? instrument : ''} disabled={!presets} onChange={(event) => pick(event.target.value)} aria-label="Ismail instrument">
          {!presets && <option value="">Loading instruments…</option>}
          <optgroup label="Presets">
            {(presets?.presets ?? []).map((p) => (
              <option key={p.name} value={`preset:${p.name}`}>
                {p.name.replace(/_/g, ' ')} · {p.type}
              </option>
            ))}
          </optgroup>
          {presets && presets.voices.length > 0 && (
            <optgroup label="Voices">
              {presets.voices.map((v) => (
                <option key={v.name} value={`voice:${v.name}`} title={v.summary}>
                  {v.name} · {v.family.replace(/^built-in\//, '')}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {kind === 'voice' && <p className="browser-note">{presets?.voices.find((v) => v.name === value)?.summary}</p>}
      <div className="ismail-notes-head">
        <span className="field-label" id="ismail-notes-label">Notes</span>
        <select value="" aria-label="Note starter" onChange={(event) => event.target.value && setNotes(event.target.value)}>
          <option value="">Starters…</option>
          {STARTERS.map((starter) => (
            <option key={starter.label} value={starter.notes}>
              {starter.label}
            </option>
          ))}
        </select>
      </div>
      <label className="field">
        <textarea rows={3} value={notes} spellCheck={false} aria-labelledby="ismail-notes-label" onKeyDown={(event) => event.stopPropagation()} onChange={(event) => setNotes(event.target.value)} aria-describedby="ismail-notes-help" />
      </label>
      <p className="browser-note" id="ismail-notes-help">
        One note per line or separated by <code>;</code>: start beat, pitch, length in beats, velocity. <code>0 C3 1; 1 G3 0.5 90</code> plays two notes; <code>0 C3,E3,G3 2</code> is a chord. Beats follow the project tempo.
      </p>
      <div className="ismail-row">
        <label className="field">
          <span className="field-label">Name</span>
          <input type="text" value={name} placeholder={value.replace(/_/g, ' ')} onKeyDown={(event) => event.stopPropagation()} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Max tail (s)</span>
          <input type="number" min={0} max={10} step={0.5} value={tail} onKeyDown={(event) => event.stopPropagation()} onChange={(event) => setTail(Math.max(0, Math.min(10, Number(event.target.value) || 0)))} />
        </label>
      </div>
      <p className="browser-note">Ismail trims silence, so the tail is a maximum. On the timeline the sound loops: drag the clip's right edge to repeat it.</p>
      <button type="button" className="chip-btn primary" disabled={busy !== null || !presets || !notes.trim()} onClick={generate} title={preset ? `Ismail ${preset.type} preset` : undefined}>
        <Sparkles size={13} />
        {busy === 'generate' ? 'Generating…' : `Generate ${label}`}
      </button>
      {last && (
        <details className="ismail-report">
          <summary>
            {last.name}: {last.summary.replace(/^sound '[^']*': /, '')}
          </summary>
          <pre>{last.description}</pre>
        </details>
      )}
      <h4>Stem separation</h4>
      {status.separation ? (
        <p className="browser-note">Select an audio clip, a deck, or a Sampler's source and click Separate stems in the inspector.</p>
      ) : (
        <>
          <p className="browser-note">Split a recording into drums, bass, other, and vocals with Demucs. This adds PyTorch and Demucs (about 700 MB more); the model weights download the first time you separate.</p>
          <button type="button" className="chip-btn" disabled={busy !== null} onClick={() => void installIsmail(true)}>
            <Download size={13} />
            {busy === 'install' ? 'Installing…' : 'Add stem separation'}
          </button>
        </>
      )}
      <IsmailCredit version={status.version} />
    </div>
  )
}
