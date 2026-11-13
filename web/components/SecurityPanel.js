'use client'

/**
 * The owner's own credential.
 *
 * A node can start with a key printed in its log, then add a password here
 * once the owner is in. Changing it keeps this tab signed in; the key remains
 * valid only when it was set explicitly (OWNER_KEY), which is the recovery
 * path. An OWNER_PASSWORD cannot be changed from the browser — the
 * environment would overwrite it on the next boot.
 */
import { useCallback, useEffect, useState } from 'react'

import { owner, setOwnerKey } from '../lib/api.js'

export default function SecurityPanel({ say }) {
  const [state, setState] = useState(null)
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const load = useCallback(async () => {
    try {
      setState(await owner('/password'))
      setError(null)
    } catch (problem) {
      setError(problem.message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const save = async () => {
    setError(null)
    setNotice(null)
    if (password.length < (state?.minLength ?? 8)) {
      setError(`Use at least ${state?.minLength ?? 8} characters.`)
      return
    }
    if (password !== confirmation) {
      setError('The two passwords do not match.')
      return
    }
    setBusy(true)
    try {
      const result = await owner('/password', { method: 'POST', body: { password } })
      setOwnerKey(password)
      setPassword('')
      setConfirmation('')
      setState(result)
      setNotice(result.persisted ? 'Password saved. This tab stays signed in.' : 'Password set for this process only — the data folder is not writable.')
      say?.('Owner password changed')
    } catch (problem) {
      setError(problem.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="section-title">Owner password</div>
      <div className="card stack">
        {state?.fromEnv ? (
          <p className="dim" style={{ margin: 0 }}>
            The password comes from <code>OWNER_PASSWORD</code>. Change the environment and restart the node.
          </p>
        ) : (
          <>
            <p className="dim" style={{ margin: 0 }}>
              {state?.configured
                ? 'A password is set. Changing it signs out nobody else; this tab keeps working.'
                : 'Add a password so you do not need the key from the server log. It is stored as a scrypt hash next to the database.'}
            </p>
            <input
              type="password"
              placeholder={state?.configured ? 'new password' : 'password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
            />
            <input
              type="password"
              placeholder="confirm password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && save()}
              autoComplete="new-password"
            />
            <button className="btn primary" onClick={save} disabled={busy}>
              {busy ? <span className="spin" /> : state?.configured ? 'Change password' : 'Set password'}
            </button>
          </>
        )}
        {notice ? <p className="dim small" style={{ margin: 0 }}>{notice}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </div>
    </>
  )
}
