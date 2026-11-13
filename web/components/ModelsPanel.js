'use client'

/**
 * The learned automix policy, with every action in one place.
 *
 * Training is fast and on by default, so the panel is written for someone who
 * wants to *see* it happen: candidates, held-out accuracy, which one is on
 * air, and the private Hugging Face mirror. Audio never stops for any of it.
 */
import { useCallback, useEffect, useState } from 'react'

import { owner } from '../lib/api.js'

const fmtTime = (ms) => {
  if (!ms) return 'never'
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}

const pct = (value) => (value == null ? '—' : `${Math.round(value * 100)}%`)

function Switch({ on, onChange, label, hint }) {
  return (
    <button className="switch" onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <span className={`switch-track ${on ? 'on' : ''}`}>
        <span className="switch-knob" />
      </span>
      <span className="switch-text">
        <strong>{label}</strong>
        {hint ? <span className="dim">{hint}</span> : null}
      </span>
    </button>
  )
}

export default function ModelsPanel({ station = null, say }) {
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [repo, setRepo] = useState('')
  const [stationModel, setStationModel] = useState(true)

  const load = useCallback(async () => {
    try {
      const payload = await owner('/models')
      setState(payload)
      setRepo(payload.hf?.repo ?? payload.settings?.hf?.repo ?? '')
      setError(null)
    } catch (problem) {
      setError(problem.message)
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, 15_000)
    return () => clearInterval(timer)
  }, [load])

  useEffect(() => {
    if (!station) return
    owner(`/stations/${station}/dj-model`)
      .then((info) => setStationModel(info.enabled !== false))
      .catch(() => {})
  }, [station])

  const run = async (name, fn) => {
    setBusy(name)
    setError(null)
    try {
      await fn()
      await load()
    } catch (problem) {
      setError(problem.message)
      say?.(problem.message)
    } finally {
      setBusy(null)
    }
  }

  const train = (count) =>
    run('train', async () => {
      const report = await owner('/models/train', {
        method: 'POST',
        body: { count, fast: state?.settings?.fast !== false, station: station ?? undefined }
      })
      say?.(
        report.trained
          ? `${report.count} trained · ${pct(report.accuracyAfter)} held out${report.activated ? ' · on air' : ' · incumbent kept'}`
          : report.reason
      )
    })

  const patchSettings = (patch) => run('settings', () => owner('/models/settings', { method: 'PATCH', body: patch }))

  if (!state) {
    return (
      <div className="stack">
        <div className="skeleton" style={{ height: 90 }} />
        <div className="skeleton" style={{ height: 140 }} />
      </div>
    )
  }

  const auto = state.auto ?? {}
  const active = state.active?.model ?? null
  const settings = state.settings ?? {}
  const hf = state.hf ?? {}

  return (
    <div className="stack">
      <div className="hero-panel">
        <div className="row">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="eyebrow">Learned transitions</div>
            <div className="hero-title truncate">{active ? active.name : 'Heuristic only'}</div>
            <div className="dim">
              {active ? `${pct(active.steps ? state.runs?.[0]?.accuracy : null)} · ${active.parameters} params · ${active.source}` : 'No model on air — the heuristic is choosing'}
            </div>
          </div>
          <div className={`orb ${active ? 'live' : ''}`}>
            <span>{active ? 'AI' : '—'}</span>
          </div>
        </div>

        <div className="metrics">
          <div className="metric">
            <span>seams</span>
            <strong>{state.seams ?? 0}</strong>
          </div>
          <div className="metric">
            <span>candidates</span>
            <strong>{state.models?.length ?? 0}</strong>
          </div>
          <div className="metric">
            <span>runs</span>
            <strong>{state.runs?.length ?? 0}</strong>
          </div>
          <div className="metric">
            <span>last train</span>
            <strong>{fmtTime(auto.lastRunAt)}</strong>
          </div>
        </div>
      </div>

      <div className="card stack">
        <Switch
          on={settings.autoTrain !== false}
          onChange={(value) => run('auto', () => owner('/models/auto', { method: 'POST', body: { enabled: value } }))}
          label="Train while playing"
          hint="Watch new seams, multi-train in the background, swap at the next seam"
        />
        <Switch
          on={settings.fast !== false}
          onChange={(value) => patchSettings({ fast: value })}
          label="Fast trains"
          hint="Small net, warm start, a few candidates — seconds, not minutes"
        />
        {station ? (
          <Switch
            on={stationModel}
            onChange={(value) => {
              setStationModel(value)
              run('station', () =>
                owner(`/stations/${station}/dj-model`, { method: 'POST', body: { enabled: value } })
              )
            }}
            label="Use the model on this station"
            hint="Off pins the heuristic for this station only"
          />
        ) : null}

        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn primary grow" disabled={Boolean(busy)} onClick={() => train(1)}>
            {busy === 'train' ? <span className="spin" /> : 'Train now'}
          </button>
          <button className="btn grow" disabled={Boolean(busy)} onClick={() => train(3)}>
            Multi-train ×3
          </button>
        </div>
        {auto.running ? <div className="note live">training in the background…</div> : null}
        {auto.last ? (
          <div className="note">
            last run: {pct(auto.last.accuracyAfter)} held out · {auto.last.activated ? 'activated' : 'kept incumbent'} ·{' '}
            {auto.last.ms} ms
          </div>
        ) : null}
        {auto.error ? <div className="error">{auto.error}</div> : null}
      </div>

      <div className="section-title">Candidates</div>
      <div className="list">
        {(state.models ?? []).length === 0 ? <div className="empty">No models yet — train one above.</div> : null}
        {(state.models ?? []).map((model) => (
          <div key={model.name} className={`list-row ${model.active ? 'on' : ''}`}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="truncate" style={{ fontWeight: 600 }}>
                {model.name} {model.active ? <span className="pill live">on air</span> : null}
              </div>
              <div className="dim truncate">
                {pct(model.accuracy)} held out · {model.parameters ?? '—'} params · {model.backend ?? 'cpu'}
                {model.remote ? ` · HF` : ''}
              </div>
            </div>
            {!model.active ? (
              <button
                className="btn tiny"
                disabled={Boolean(busy)}
                onClick={() => run('activate', () => owner(`/models/${encodeURIComponent(model.name)}/activate`, { method: 'POST' }))}
              >
                Use
              </button>
            ) : null}
            <button
              className="icon-btn"
              title="Push to the private HF repo"
              disabled={Boolean(busy)}
              onClick={() => run('push', () => owner('/models/push', { method: 'POST', body: { names: [model.name] } }))}
            >
              ↑
            </button>
            <button
              className="icon-btn danger"
              title="Delete"
              disabled={Boolean(busy) || model.active}
              onClick={() => run('delete', () => owner(`/models/${encodeURIComponent(model.name)}`, { method: 'DELETE' }))}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="section-title">Private storage · Hugging Face</div>
      <div className="card stack">
        <div className="row">
          <span className={`pill ${hf.private ? 'live' : ''}`}>{hf.private ? 'private' : hf.configured ? 'check repo' : 'off'}</span>
          <span className="dim truncate">{hf.repo || 'no repo configured'}</span>
          <div className="grow" />
          <button className="btn tiny" disabled={Boolean(busy)} onClick={() => run('pull', () => owner('/models/pull', { method: 'POST' }))}>
            Pull
          </button>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input
            className="grow"
            placeholder="owner/livy-dj-models"
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
          />
          <button
            className="btn"
            disabled={Boolean(busy) || !repo.trim()}
            onClick={() => run('hf', () => owner('/models/hf', { method: 'POST', body: { repo: repo.trim(), enabled: true } }))}
          >
            Save
          </button>
        </div>
        <div className="note">
          The repo is created <strong>private</strong>; the token comes from <code>HF_TOKEN</code> on the node and is never stored here.
        </div>
        {hf.error ? <div className="error">{hf.error}</div> : null}
        {hf.remote?.length ? <div className="dim">{hf.remote.length} model(s) in the repo</div> : null}
      </div>

      {state.runs?.length ? (
        <>
          <div className="section-title">Recent runs</div>
          <div className="list">
            {state.runs.map((run) => (
              <div key={run.id} className="list-row">
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>
                    {run.mode ?? 'train'} ×{run.count} · {pct(run.accuracy)}
                  </div>
                  <div className="dim truncate">{run.best ?? run.report?.reason ?? 'no model activated'}</div>
                </div>
                <span className="dim">{fmtTime(run.created_at)}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {error ? <div className="error">{error}</div> : null}
    </div>
  )
}
