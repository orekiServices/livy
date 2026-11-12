'use client'

import { useState } from 'react'

import { owner, setOwnerKey } from '../lib/api.js'

/**
 * The owner key prompt. The key is kept in this tab's sessionStorage and
 * nowhere else: not in a URL, not in localStorage, not on the node's disk in
 * any form the browser can read back.
 */
export default function KeyGate({ onUnlock }) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const unlock = async () => {
    if (!draft.trim()) return
    setBusy(true)
    setError(null)
    try {
      await owner('/whoami', { key: draft.trim() })
      setOwnerKey(draft.trim())
      onUnlock?.(draft.trim())
    } catch (problem) {
      setError(problem.status === 401 ? 'That key was not accepted.' : problem.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h3 style={{ margin: '0 0 6px' }}>Owner access</h3>
      <p className="dim" style={{ marginTop: 0 }}>
        The key is generated on first boot and printed in the node&apos;s log. It stays in this tab.
      </p>
      <input
        type="password"
        placeholder="owner key"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && unlock()}
        autoComplete="off"
      />
      <button className="btn primary block" style={{ marginTop: 10 }} onClick={unlock} disabled={busy}>
        {busy ? <span className="spin" /> : 'Unlock'}
      </button>
      {error ? <p className="error">{error}</p> : null}
    </div>
  )
}
