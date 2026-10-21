import { describe, expect, it } from 'vitest'
import { type UpdateAction, type UpdateState, initialUpdateState, updateReducer } from './updates'

const run = (actions: UpdateAction[], from: UpdateState = initialUpdateState) => actions.reduce(updateReducer, from)

describe('updateReducer', () => {
  it('follows a check through download to install', () => {
    expect(run([{ type: 'checking' }])).toEqual({ kind: 'checking' })
    expect(run([{ type: 'checking' }, { type: 'available', version: '2.0.1', releaseNotes: '• Fixes' }])).toEqual({ kind: 'available', version: '2.0.1', releaseNotes: '• Fixes' })
    expect(run([{ type: 'downloading', percent: 42 }])).toEqual({ kind: 'downloading', percent: 42 })
    expect(run([{ type: 'downloading', percent: 42 }, { type: 'downloaded', version: '2.0.1' }])).toEqual({ kind: 'downloaded', version: '2.0.1' })
  })

  it('keeps a finished download when a late progress event arrives', () => {
    expect(run([{ type: 'downloaded', version: '2.0.1' }, { type: 'downloading', percent: 99 }])).toEqual({ kind: 'downloaded', version: '2.0.1' })
  })

  it('reports up to date and errors, and dismisses to idle', () => {
    expect(run([{ type: 'checking' }, { type: 'not-available' }])).toEqual({ kind: 'not-available' })
    expect(run([{ type: 'error', message: 'offline' }])).toEqual({ kind: 'error', message: 'offline' })
    expect(run([{ type: 'available', version: '2.0.1', releaseNotes: '' }, { type: 'dismiss' }])).toEqual({ kind: 'idle' })
  })
})
