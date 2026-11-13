'use client'

/**
 * The engine room: what the node is doing, what it has written down, and the
 * three maintenance verbs that are safe to run while it is on air.
 */
import { useCallback, useEffect, useState } from 'react'

import { owner } from '../lib/api.js'
import SecurityPanel from './SecurityPanel.js'

const levelClass = (level) => `log-level ${String(level ?? '').toLowerCase()}`

export default function OpsPanel({ say }) {
  const [logs, setLogs] = useState(null)
  const [store, setStore] = useState(null)
  const [overview, setOverview] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const [lines, db, node] = await Promise.all([owner('/logs?limit=120'), owner('/store'), owner('')])
      setLogs(lines)
      setStore(db)
      setOverview(node)
      setError(null)
    } catch (problem) {
      setError(problem.message)
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, 8000)
    return () => clearInterval(timer)
  }, [load])

  const maintain = async (verb) => {
    setBusy(verb)
    try {
      const result = await owner(`/store/${verb}`, { method: 'POST' })
      say?.(verb === 'backup' ? `Backup written: ${result.backup}` : `${verb} done`)
      await load()
    } catch (problem) {
      setError(problem.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="stack">
      <div className="hero-panel">
        <div className="eyebrow">Node</div>
        <div className="hero-title">{overview?.engine?.engine ?? 'engine'}</div>
        <div className="dim truncate">
          {overview?.store?.driver ?? store?.driver ?? 'persistence off'} · schema v{store?.schema ?? overview?.store?.schema ?? '—'}
        </div>
        <div className="metrics">
          <div className="metric">
            <span>stations</span>
            <strong>{overview?.stats?.stations ?? overview?.stations?.length ?? 0}</strong>
          </div>
          <div className="metric">
            <span>playing</span>
            <strong>{overview?.stats?.playing ?? '—'}</strong>
          </div>
          <div className="metric">
            <span>listeners</span>
            <strong>{overview?.stats?.listeners ?? '—'}</strong>
          </div>
          <div className="metric">
            <span>models</span>
            <strong>{store?.models ?? 0}</strong>
          </div>
        </div>
      </div>

      <div className="section-title">Store</div>
      <div className="card stack">
        <div className="kv">
          <span>file</span>
          <strong>{store?.file ?? '—'}</strong>
        </div>
        <div className="kv">
          <span>size</span>
          <strong>{store ? `${store.sizeKb} KB` : '—'}</strong>
        </div>
        <div className="kv">
          <span>seams learned</span>
          <strong>{store?.seams ?? 0}</strong>
        </div>
        <div className="kv">
          <span>training runs</span>
          <strong>{store?.trainingRuns ?? 0}</strong>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn small grow" disabled={Boolean(busy)} onClick={() => maintain('vacuum')}>
            Vacuum
          </button>
          <button className="btn small grow" disabled={Boolean(busy)} onClick={() => maintain('checkpoint')}>
            Checkpoint
          </button>
          <button className="btn small grow" disabled={Boolean(busy)} onClick={() => maintain('backup')}>
            Backup
          </button>
        </div>
      </div>

      <div className="section-title">Log</div>
      <div className="logbox">
        {(logs?.lines ?? []).slice().reverse().map((line, index) => (
          <div key={`${line.time}-${index}`} className="logline">
            <span className={levelClass(line.level)}>{line.level}</span>
            <span className="scope">{line.scope}</span>
            <span className="msg">{line.message ?? line.msg}</span>
          </div>
        ))}
        {!logs?.lines?.length ? <div className="empty">No lines buffered.</div> : null}
      </div>
      <SecurityPanel say={say} />
      {error ? <div className="error">{error}</div> : null}
    </div>
  )
}
