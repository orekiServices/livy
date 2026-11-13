'use client'

/**
 * Training.
 *
 * The policy is a small network over the seams a station has already played.
 * This page is the trainer's console: which backend will run (the in-process
 * JavaScript loop, or PyTorch through an interpreter when the node has one),
 * what a run is allowed to spend, the report it comes back with, and the
 * registry of candidates that survived.
 *
 * The backend is not a preference hidden in an env var. PyTorch is faster when
 * there is a GPU or a big log to batch, and slower than the JS loop on a small
 * CPU — so the page says which one ran, why, and how long it took.
 */
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'

import { useRadio } from '../../components/RadioProvider.js'
import { Badge, Button, Empty, Field, KeyGate, Panel, Slider, Stat, Switch, ago, cx, inputClass } from '../../components/ui.js'
import { owner } from '../../lib/api.js'

const percent = (value) => (value == null ? '—' : `${Math.round(value * 100)}%`)

function TorchCard({ torch, backend }) {
  const ready = torch?.available
  return (
    <Panel
      title="Training backend"
      subtitle="PyTorch when it pays for itself; the JavaScript trainer otherwise. Both train the same network."
      actions={<Badge tone={ready ? 'lime' : 'ink'}>{ready ? 'torch ready' : 'no torch'}</Badge>}
    >
      {ready ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Torch" value={torch.torch?.split('+')[0] ?? '—'} hint={torch.cuda ? 'CUDA wheel' : 'CPU'} accent="lime" />
          <Stat label="Device" value={torch.device ?? 'cpu'} hint={`${torch.threads ?? '—'} threads`} />
          <Stat label="Python" value={torch.python ?? '—'} />
          <Stat label="Default" value={backend ?? 'auto'} hint="per run below" />
        </div>
      ) : (
        <div className="space-y-2 text-sm text-ink-300">
          <p>
            This node trains in JavaScript. PyTorch is optional and is used only where it is faster — a GPU, a wide
            model, or a log big enough to batch.
          </p>
          <p className="text-xs text-ink-300">
            {torch?.reason ?? 'The node has not probed for an interpreter yet.'}
          </p>
          <pre className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-900 p-2 text-[11px] text-ink-200">
{`cd server
python3 -m venv .venv
.venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu`}
          </pre>
          <p className="text-xs text-ink-300">Then reload this page — the probe runs once per node, and the directory is watched for changes on the next training run.</p>
        </div>
      )}
    </Panel>
  )
}

function TrainForm({ stations, presets, torch, defaultStation, onTrained }) {
  const [form, setForm] = useState({ station: defaultStation ?? '', preset: 'auto', count: 2, fast: true, backend: 'auto', activate: true, epochs: 0, learningRate: 0.01 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (defaultStation) setForm((current) => ({ ...current, station: defaultStation }))
  }, [defaultStation])

  const train = async () => {
    setBusy(true)
    setError(null)
    try {
      const body = {
        station: form.station || undefined,
        preset: form.preset,
        count: Number(form.count),
        fast: form.fast,
        backend: form.backend,
        activate: form.activate,
        learningRate: Number(form.learningRate)
      }
      if (Number(form.epochs) > 0) body.epochs = Number(form.epochs)
      const report = await owner('/models/train', { method: 'POST', body })
      onTrained(report)
    } catch (problem) {
      // 409 carries the report too: "not enough seams" is an answer.
      if (problem.payload) onTrained(problem.payload)
      else setError(problem.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title="Train" subtitle="One run trains up to eight candidate networks and keeps the best on the held-out split.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Station">
          <select className={inputClass} value={form.station} onChange={(event) => setForm({ ...form, station: event.target.value })}>
            <option value="">whole node</option>
            {stations.map((station) => (
              <option key={station.id} value={station.id}>{station.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Preset">
          <select className={inputClass} value={form.preset} onChange={(event) => setForm({ ...form, preset: event.target.value })}>
            {(presets ?? [{ id: 'auto', label: 'Auto' }]).map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.label ?? preset.id}</option>
            ))}
          </select>
        </Field>
        <Field label="Backend" hint={torch?.available ? 'auto picks by workload' : 'PyTorch is not installed here'}>
          <select className={inputClass} value={form.backend} onChange={(event) => setForm({ ...form, backend: event.target.value })}>
            <option value="auto">auto</option>
            <option value="js">JavaScript</option>
            <option value="torch" disabled={!torch?.available}>PyTorch</option>
          </select>
        </Field>
        <Field label="Candidates">
          <div className="pt-1">
            <Slider label="count" min={1} max={8} step={1} value={form.count} onChange={(value) => setForm({ ...form, count: value })} />
          </div>
        </Field>
        <Field label="Epochs" hint="0 uses the preset's budget">
          <input className={inputClass} type="number" min="0" max="4000" value={form.epochs} onChange={(event) => setForm({ ...form, epochs: event.target.value })} />
        </Field>
        <Field label="Learning rate">
          <input className={inputClass} type="number" step="0.001" min="0.0001" max="0.5" value={form.learningRate} onChange={(event) => setForm({ ...form, learningRate: event.target.value })} />
        </Field>
      </div>
      <div className="mt-1 divide-y divide-ink-700/60">
        <Switch label="Fast" hint="smaller candidates, fewer epochs — the everyday choice" checked={form.fast} onChange={(value) => setForm({ ...form, fast: value })} />
        <Switch label="Activate" hint="replace the model on air only if it actually scores better" checked={form.activate} onChange={(value) => setForm({ ...form, activate: value })} />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" onClick={train} disabled={busy}>
          {busy ? 'Training…' : 'Train now'}
        </Button>
        {error && <span className="text-xs text-rose">{error}</span>}
      </div>
    </Panel>
  )
}

function Report({ report }) {
  if (!report) return null
  if (!report.trained) {
    return (
      <Panel title="Nothing trained" subtitle="The trainer needs labelled seams before it will guess.">
        <p className="text-sm text-ink-300">{report.reason ?? 'The run did not produce a model.'}</p>
        <p className="mt-1 text-xs text-ink-300">
          {report.seams ?? 0} seams logged, {report.labelled ?? 0} labelled, 12 needed.
        </p>
      </Panel>
    )
  }
  return (
    <Panel
      title="Last run"
      subtitle={`${report.mode} · ${report.count} candidate${report.count === 1 ? '' : 's'} · ${report.train}/${report.train + report.test} train/test`}
      actions={<Badge tone={report.activated ? 'lime' : 'ink'}>{report.activated ? 'activated' : 'kept incumbent'}</Badge>}
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Held-out" value={percent(report.accuracyAfter)} hint={`from ${percent(report.accuracyBefore)}`} accent="lime" />
        <Stat label="Loss" value={report.loss?.toFixed?.(4) ?? report.loss} />
        <Stat label="Backend" value={report.backend} hint={report.torch?.used ? `torch ${report.torch.version?.split('+')[0]}` : report.torch?.reason?.slice(0, 28) ?? ''} accent={report.backend === 'torch' ? 'cyan' : 'ink'} />
        <Stat label="Took" value={`${report.ms} ms`} hint={`${report.epochs} epochs · ${report.parameters} params`} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label="Skill"
          value={report.eval?.skill == null ? '—' : `${Math.round(report.eval.skill * 100)}%`}
          hint={report.eval ? `vs a uniform guess · Brier ${report.eval.brier}` : 'not scored'}
          accent={report.eval?.skill > 0.2 ? 'lime' : 'ink'}
        />
        <Stat label="Confidence" value={report.eval?.confidence == null ? '—' : `${Math.round(report.eval.confidence * 100)}%`} hint="on its own first choice" />
        <Stat
          label="Recency"
          value={`${report.recency?.halfLifeDays ?? '—'} d`}
          hint={report.recency ? `mean weight ${Math.round((report.recency.mean ?? 0) * 100)}% · ${report.recency.faded} faded` : 'unweighted'}
        />
        <Stat
          label="Answers"
          value={Object.entries(report.eval?.support ?? {}).filter(([, count]) => count > 0).length}
          hint="transitions the run saw"
        />
      </div>
      <table className="mt-3 w-full text-left text-xs">
        <thead className="text-[10px] uppercase tracking-wider text-ink-500">
          <tr>
            <th className="py-1">candidate</th>
            <th className="py-1">shape</th>
            <th className="py-1">backend</th>
            <th className="py-1 text-right">held-out</th>
            <th className="py-1 text-right">ms</th>
          </tr>
        </thead>
        <tbody className="font-mono text-ink-200">
          {(report.candidates ?? []).map((candidate, index) => (
            <tr key={candidate.name ?? index} className="border-t border-ink-700/60">
              <td className="py-1">{candidate.name ?? `#${index + 1}`}{candidate.activated ? ' ★' : ''}</td>
              <td className="py-1 text-ink-300">{(candidate.shape ?? []).join('·')}</td>
              <td className="py-1 text-ink-300">{candidate.backend}</td>
              <td className="py-1 text-right">{percent(candidate.accuracyAfter)}</td>
              <td className="py-1 text-right text-ink-300">{candidate.ms}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {report.reason && <p className="mt-2 text-xs text-ink-300">{report.reason}</p>}
      {report.rl && (
        <p className="mt-1 text-xs text-ink-300">
          RL refitted from {report.rl.seams ?? report.seams} seams
          {report.rl.trained === false ? ` (${report.rl.reason})` : ' — it learns from far less data than the network'}.
        </p>
      )}
    </Panel>
  )
}

function Registry({ models, onActivate, onForget }) {
  return (
    <Panel title="Registry" subtitle="Every candidate on this node, newest first." actions={<Badge>{models.length}</Badge>}>
      {models.length === 0 ? (
        <Empty>No models yet. Train one above; the first run sets the floor.</Empty>
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-ink-500">
            <tr>
              <th className="py-1">name</th>
              <th className="py-1">shape</th>
              <th className="py-1">backend</th>
              <th className="py-1 text-right">accuracy</th>
              <th className="py-1 text-right">trained</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {models.map((model) => (
              <tr key={model.name} className={cx('border-t border-ink-700/60', model.active && 'bg-amber/5')}>
                <td className="py-1.5 font-mono text-ink-100">
                  {model.name} {model.active && <Badge tone="amber">on air</Badge>}
                </td>
                <td className="py-1.5 font-mono text-ink-300">{(model.shape ?? []).join('·')}</td>
                <td className="py-1.5 font-mono text-ink-300">{model.backend ?? '—'}</td>
                <td className="py-1.5 text-right font-mono text-ink-200">{percent(model.accuracy)}</td>
                <td className="py-1.5 text-right text-ink-300">{model.createdAt ? ago(model.createdAt) : '—'}</td>
                <td className="py-1.5 text-right">
                  {!model.active && (
                    <button type="button" onClick={() => onActivate(model.name)} className="text-[11px] text-ink-300 hover:text-amber">
                      activate
                    </button>
                  )}
                  <button type="button" onClick={() => onForget(model.name)} className="ml-2 text-[11px] text-ink-500 hover:text-rose">
                    forget
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  )
}

export default function ModelsPage() {
  const { stations, key } = useRadio()
  const [models, setModels] = useState(null)
  const [settings, setSettings] = useState(null)
  const [report, setReport] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!key) return
    try {
      const answer = await owner('/models')
      setModels(answer)
      setSettings(answer.settings ?? null)
      setError(null)
    } catch (problem) {
      setError(problem.message)
    }
  }, [key])

  useEffect(() => {
    load()
  }, [load])

  const setSetting = async (patch) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    await owner('/models/settings', { method: 'POST', body: patch }).catch(() => {})
    await load()
  }

  const registry = models?.models ?? []
  const auto = models?.auto

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Training</h1>
          <p className="mt-1 text-sm text-ink-300">
            {models ? `${models.seams ?? 0} seams · ${registry.length} model${registry.length === 1 ? '' : 's'} on this node` : 'Loading the registry…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/seams/"><Button size="sm" variant="ghost">Seams & RL</Button></Link>
          <Button size="sm" onClick={load}>Refresh</Button>
        </div>
      </header>

      {!key ? (
        <KeyGate />
      ) : (
        <KeyGate>
          <div className="space-y-4">
            {error && <Panel title="Unavailable"><p className="text-sm text-rose">{error}</p></Panel>}
            <TorchCard torch={models?.torch} backend={models?.backend} />

            <div className="grid gap-4 lg:grid-cols-2">
              <TrainForm stations={stations} presets={models?.presets} torch={models?.torch} onTrained={(value) => { setReport(value); load() }} />
              <div className="space-y-4">
                <Report report={report} />
                <Panel title="Auto-train" subtitle="The node watches its own seam log and trains when there is enough new evidence.">
                  <div className="grid grid-cols-2 gap-2">
                    <Stat label="Enabled" value={auto?.enabled ? 'on' : 'off'} accent={auto?.enabled ? 'lime' : 'ink'} />
                    <Stat label="New seams" value={`${auto?.seams ?? 0}/${auto?.everySeams ?? 60}`} hint={`min ${auto?.minSeams ?? 40}`} />
                    <Stat label="Last run" value={auto?.lastRunAt ? ago(auto.lastRunAt) : 'never'} />
                    <Stat label="Last score" value={percent(auto?.last?.accuracy)} />
                  </div>
                  <div className="mt-2 divide-y divide-ink-700/60">
                    <Switch
                      label="Auto-train"
                      hint="a model changes under the owner only when it is better"
                      checked={auto?.enabled !== false}
                      onChange={(value) => setSetting({ autoTrain: value })}
                    />
                    <Switch label="Fast preset" hint="smaller candidates on every automatic run" checked={settings?.fast !== false} onChange={(value) => setSetting({ fast: value })} />
                  </div>
                  {auto?.error && <p className="mt-1 text-xs text-rose">{auto.error}</p>}
                </Panel>
              </div>
            </div>

            <Registry
              models={registry}
              onActivate={async (name) => {
                await owner(`/models/${encodeURIComponent(name)}/activate`, { method: 'POST' }).catch(() => {})
                await load()
              }}
              onForget={async (name) => {
                await owner(`/models/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {})
                await load()
              }}
            />
          </div>
        </KeyGate>
      )}
    </div>
  )
}
