import { studio } from '@reborn/studio-core'
import { type Proposal, type ProposalChange, dispatch, getState, setState, toast, useStudio } from './store'

type StudioProject = studio.StudioProject

// Agent proposals are batches of commands the user reviews. Each command can
// be picked on its own; a change's checkbox picks all of its commands.
// Previewing runs the picked commands on a copy of the project: the audio
// engine plays that copy and the UI draws ghost values from it. Applying runs
// them through `dispatch` as one undoable agent step.

export function addProposal(proposal: Omit<Proposal, 'status' | 'createdAt' | 'revision'>): Proposal {
  const full: Proposal = { ...proposal, status: 'pending', createdAt: Date.now(), revision: getState().project.revision }
  setState((s) => ({
    proposals: [...s.proposals.filter((p) => p.status === 'pending' || Date.now() - p.createdAt < 600_000).slice(-19), full],
  }))
  return full
}

const key = (proposalId: string, changeId: string, index: number) => `${proposalId}:${changeId}:${index}`

/** Commands start picked; only the ones the user turns off are stored. */
export const isCommandPicked = (proposalId: string, changeId: string, index: number) => getState().proposalPicks[key(proposalId, changeId, index)] !== false

export function changePick(proposalId: string, change: ProposalChange): 'all' | 'some' | 'none' {
  const picked = change.commands.filter((_, i) => isCommandPicked(proposalId, change.id, i)).length
  return picked === change.commands.length ? 'all' : picked ? 'some' : 'none'
}

/** Turns a whole change on, or off when all of it is on. */
export function toggleChange(proposalId: string, change: ProposalChange): void {
  const on = changePick(proposalId, change) !== 'all'
  setState((s) => ({ proposalPicks: { ...s.proposalPicks, ...Object.fromEntries(change.commands.map((_, i) => [key(proposalId, change.id, i), on])) } }))
}

export function toggleCommand(proposalId: string, changeId: string, index: number): void {
  const k = key(proposalId, changeId, index)
  setState((s) => ({ proposalPicks: { ...s.proposalPicks, [k]: s.proposalPicks[k] === false } }))
}

export function pickedCommands(proposal: Proposal): studio.Command[] {
  return proposal.changes.flatMap((change) => change.commands.filter((_, i) => isCommandPicked(proposal.id, change.id, i)))
}

export const totalCommands = (proposal: Proposal) => proposal.changes.reduce((sum, change) => sum + change.commands.length, 0)

export interface ProposalCheck {
  /** The project with the picked commands, or null when nothing is picked or they fail. */
  project: StudioProject | null
  /** Why the picked commands can't run together, for example a clip whose new pattern isn't picked. */
  error: string | null
}

const checks = new Map<string, { project: StudioProject; proposal: Proposal; picks: Record<string, boolean>; result: ProposalCheck }>()

/** Dry-runs the picked commands of a proposal against the current project. */
export function checkProposal(proposal: Proposal): ProposalCheck {
  const s = getState()
  const cached = checks.get(proposal.id)
  if (cached && cached.project === s.project && cached.proposal === proposal && cached.picks === s.proposalPicks) return cached.result
  let result: ProposalCheck
  const commands = pickedCommands(proposal)
  if (!commands.length) result = { project: null, error: null }
  else {
    try {
      result = { project: studio.executeBatch(s.project, commands, { origin: 'agent' }).project, error: null }
    } catch (error) {
      result = { project: null, error: error instanceof Error ? error.message : String(error) }
    }
  }
  checks.set(proposal.id, { project: s.project, proposal, picks: s.proposalPicks, result })
  return result
}

/** The project as it would be with the previewed proposal's picked changes. */
export function previewProject(): StudioProject | null {
  const s = getState()
  const proposal = s.proposals.find((p) => p.id === s.previewProposal && p.status === 'pending')
  return proposal ? checkProposal(proposal).project : null
}

export function usePreview(): StudioProject | null {
  useStudio((s) => s.previewProposal)
  useStudio((s) => s.proposalPicks)
  useStudio((s) => s.project)
  useStudio((s) => s.proposals)
  return previewProject()
}

export function applyProposal(id: string): void {
  const s = getState()
  const proposal = s.proposals.find((p) => p.id === id)
  if (!proposal || proposal.status !== 'pending') return
  const commands = pickedCommands(proposal)
  if (!commands.length) return
  const results = dispatch(commands, { origin: 'agent', label: `Agent: ${proposal.intent}` })
  if (!results) return
  const total = totalCommands(proposal)
  const status = commands.length === total ? 'applied' : 'partial'
  finish(id, status)
  toast(`Applied ${commands.length} of ${total} edits as one undo step`, 'success')
}

export function rejectProposal(id: string): void {
  finish(id, 'rejected')
}

function finish(id: string, status: Proposal['status']) {
  checks.delete(id)
  setState((st) => ({ proposals: st.proposals.map((p) => (p.id === id ? { ...p, status } : p)), previewProposal: st.previewProposal === id ? null : st.previewProposal }))
  for (const listener of resolvedListeners) listener(id, status)
}

const resolvedListeners = new Set<(id: string, status: Proposal['status']) => void>()
export function onResolved(listener: (id: string, status: Proposal['status']) => void) {
  resolvedListeners.add(listener)
  return () => {
    resolvedListeners.delete(listener)
  }
}
