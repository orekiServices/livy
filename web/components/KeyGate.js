'use client'

import { useEffect, useState } from 'react'

import { api, owner, setOwnerKey } from '../lib/api.js'

/**
 * The owner credential prompt.
 *
 * Two shapes, one box: a node with an owner password asks for the password;
 * a node still using the generated key asks for that key. The secret is kept
 * in this tab's sessionStorage and nowhere else: not in a URL, not in
 * localStorage, not on the node's disk in any form the browser can read back.
 */
export default function KeyGate({ onUnlock }) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [passwordConfigured, setPasswordConfigured] = useState(false)

  useEffect(() => {
    api('/api/v1/setup')
      .then((payload) => setPasswordConfigured(Boolean(payload.password?.configured)))
      .catch(() => {})
  }, [])

  const unlock = async () => {
    if (!draft.trim()) return
    setBusy(true)
    setError(null)
    try {
      await owner('/whoami', { key: draft.trim() })
      setOwnerKey(draft.trim())
      onUnlock?.(draft.trim())
    } catch (problem) {
      setError(
        problem.status === 401
          ? passwordConfigured
            ? 'That password was not accepted.'
            : 'That key was not accepted.'
          : problem.message
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h3 style={{ margin: '0 0 6px' }}>Owner access</h3>
      <p className="dim" style={{ marginTop: 0 }}>
        {passwordConfigured
          ? 'Enter the owner password for this node. It stays in this tab.'
          : 'The key is generated on first boot and printed in the node’s log. It stays in this tab.'}
      </p>
      <input
        type="password"
        placeholder={passwordConfigured ? 'owner password' : 'owner key'}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && unlock()}
        autoComplete={passwordConfigured ? 'current-password' : 'off'}
        autoFocus
      />
      <button className="btn primary block" style={{ marginTop: 10 }} onClick={unlock} disabled={busy}>
        {busy ? <span className="spin" /> : 'Unlock'}
      </button>
      {error ? <p className="error">{error}</p> : null}
    </div>
  )
}
