import { useCallback, useEffect, useReducer } from 'react'
import type { UpdateEvent } from '@reborn/studio-core'
import { desktop } from '../platform/desktop'

// The app update prompt's state. Main sends each step as an UpdateEvent; the
// prompt folds them in here.

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'not-available' }
  | { kind: 'available'; version: string; releaseNotes: string }
  | { kind: 'downloading'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }

export const initialUpdateState: UpdateState = { kind: 'idle' }

/** Every UpdateEvent, plus closing the prompt with Later or Dismiss. */
export type UpdateAction = UpdateEvent | { type: 'dismiss' }

export function updateReducer(state: UpdateState, action: UpdateAction): UpdateState {
  switch (action.type) {
    case 'dismiss':
      return { kind: 'idle' }
    case 'checking':
      return { kind: 'checking' }
    case 'not-available':
      return { kind: 'not-available' }
    case 'available':
      return { kind: 'available', version: action.version, releaseNotes: action.releaseNotes }
    case 'downloading':
      // A late progress event must not undo a finished download.
      if (state.kind === 'downloaded') return state
      return { kind: 'downloading', percent: action.percent }
    case 'downloaded':
      return { kind: 'downloaded', version: action.version }
    case 'error':
      return { kind: 'error', message: action.message }
  }
}

/** Update events folded into prompt state, plus `dismiss` for Later. Idle in a browser. */
export function useUpdates(): { state: UpdateState; dismiss: () => void } {
  const [state, dispatch] = useReducer(updateReducer, initialUpdateState)
  useEffect(() => {
    if (!desktop) return
    // An event from the startup check may have arrived before this mounted.
    // Subscribe first, and use the cached event only if nothing newer came in.
    let live = false
    const off = desktop.onUpdateEvent((event) => {
      live = true
      dispatch(event)
    })
    void desktop.updateCurrent().then((event) => {
      if (event && !live) dispatch(event)
    })
    return off
  }, [])
  const dismiss = useCallback(() => dispatch({ type: 'dismiss' }), [])
  return { state, dismiss }
}
