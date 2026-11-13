'use client'

/**
 * Seams & Forever.
 *
 * The scout decodes the song on air a second behind the reader and says where
 * a track change belongs; the jukebox graph says which beats sound like which;
 * Forever loops the song through real MP3 seams instead of ending it; RL is the
 * small model that learns which of those seams listeners stay through.
 *
 * The console's job here is to make all of that legible: the candidates on a
 * time axis, the detectors that voted for each one, the graph's branching, and
 * the RL table.
 */
import Link from 'next/link'
import { Suspense, useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'

import { useRadio } from '../../components/RadioProvider.js'
import { Badge, Button, Empty, KeyGate, Panel, Stat, ago, clock, cx } from '../../components/ui.js'
import { owner } from '../../lib/api.js'

const DETECTORS = ['ending', 'energy', 'novelty', 'phrase', 'vocal', 'loop']

function Timeline({ analysis }) {
  const total = Math.max(1, analysis.ms ?? 1)
  return (
    <div>
      <div className="relative h-16 overflow-hidden rounded-xl border border-ink-700 bg-ink-900">
        {analysis.seams.map((seam, index) => (
          <div
            key={`${seam.atMs}-${index}`}
            className="group absolute top-0 h-full w-px bg-cyan/70"
            style={{ left: `${Math.min(99.6, (seam.atMs / total) * 100)}%` }}
            title={`${clock(seam.atMs)} · ${Math.round(seam.score * 100)}% · ${seam.why ?? seam.detectors?.join(', ')}`}
          >
            <span className="absolute top-1 left-1 hidden rounded bg-ink-950/90 px-1 py-0.5 text-[10px] text-cyan group-hover:block">
              {clock(seam.atMs)}
            </span>
          </div>
        ))}
        {analysis.seams.length === 0 && (
          <div className="grid h-full place-items-center text-xs text-ink-500">no candidates yet — the scout is still listening</div>
        )}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-ink-500">
        <span>0:00</span>
        <span>{clock(total)} analysed</span>
      </div>
    </div>
  )
}

function CandidateList({ analysis }) {
  const rows = [...analysis.seams].sort((a, b) => b.score - a.score).slice(0, 12)
  if (!rows.length) return <Empty>No seam candidates in this song yet.</Empty>
  return (
    <ul className="space-y-1">
      {rows.map((seam, index) => (
        <li key={`${seam.atMs}-${index}`} className="rounded-lg px-2 py-1.5 hover:bg-ink-800/60">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-ink-200">{clock(seam.atMs)}</span>
            <div className="h-1 w-16 overflow-hidden rounded-full bg-ink-700">
              <div className="h-full rounded-full bg-cyan" style={{ width: `${Math.round((seam.score ?? 0) * 100)}%` }} />
            </div>
            <span className="font-mono text-[11px] text-ink-300">{Math.round((seam.score ?? 0) * 100)}%</span>
            <span className="ml-auto flex flex-wrap gap-1">
              {(seam.detectors ?? []).map((detector) => (
                <span key={detector} className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-300">
                  {detector}
                </span>
              ))}
            </span>
          </div>
          {seam.why && <div className="mt-0.5 text-[11px] text-ink-300">{seam.why}</div>}
        </li>
      ))}
    </ul>
  )
}

function Jukebox({ graph, forever, stationId, onRefreshed }) {
  const [busy, setBusy] = useState(false)
  const toggle = async () => {
    setBusy(true)
    try {
      await owner(`/stations/${stationId}/forever`, { method: 'POST', body: { enabled: !forever?.enabled } })
      await onRefreshed()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Panel title="Forever" subtitle="The song does not end: the graph decides what plays next, through real seams.">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Armed" value={forever?.enabled ? 'yes' : 'no'} accent={forever?.enabled ? 'amber' : 'ink'} />
        <Stat label="Looping" value={forever?.active ? 'now' : '—'} hint={forever?.track ? String(forever.track).slice(0, 8) : 'nothing read yet'} />
        <Stat label="Jumps" value={forever?.jumps ?? 0} />
        <Stat label="Position" value={forever?.positionMs != null ? clock(forever.positionMs) : '—'} hint={forever?.lastJump ? `last ${clock(forever.lastJump.atMs ?? 0)}` : ''} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant={forever?.enabled ? 'default' : 'primary'} size="sm" onClick={toggle} disabled={busy}>
          {forever?.enabled ? 'Turn Forever off' : 'Turn Forever on'}
        </Button>
        <span className="text-[11px] text-ink-300">
          {forever?.enabled ? 'It stops on a skip, a request, an announcement, or this switch.' : 'Applies to the next song the station reads in full.'}
        </span>
      </div>
      {graph && (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-ink-300">
          <dt>branching</dt>
          <dd className="font-mono text-ink-200">{graph.branching}</dd>
          <dt>threshold</dt>
          <dd className="font-mono text-ink-200">{graph.threshold}</dd>
          <dt>last branch</dt>
          <dd className="font-mono text-ink-200">{graph.lastBranch}</dd>
          <dt>longest backward</dt>
          <dd className="font-mono text-ink-200">{Math.round((graph.longestBackward ?? 0) * 100)}%</dd>
          <dt>kernel</dt>
          <dd className="font-mono text-ink-200">{graph.engine ?? 'ts'}</dd>
        </dl>
      )}
    </Panel>
  )
}

function RLPanel({ rl }) {
  if (!rl) return null
  const kinds = Object.entries(rl.beats ?? {}).sort((a, b) => b[1] - a[1])
  const contexts = (rl.contexts ?? []).slice(0, 8)
  return (
    <Panel title="Learned chooser" subtitle={`Reinforcement learning on (kind → kind → transition); ${rl.seams ?? 0} observations since ${rl.trainedAt ? ago(rl.trainedAt) : 'never'}.`}>
      <div className="flex flex-wrap gap-1.5">
        {kinds.map(([kind, count]) => (
          <Badge key={kind} tone={count ? 'cyan' : 'ink'}>
            {kind} <span className="font-mono text-[10px] opacity-70">{count}</span>
          </Badge>
        ))}
      </div>
      {contexts.length > 0 ? (
        <table className="mt-3 w-full text-left text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-ink-500">
            <tr>
              <th className="py-1">exit → entry</th>
              <th className="py-1">transition</th>
              <th className="py-1 text-right">plays</th>
              <th className="py-1 text-right">reward</th>
            </tr>
          </thead>
          <tbody className="font-mono text-ink-200">
            {contexts.map((cell, index) => (
              <tr key={`${cell.exit ?? cell.from}-${cell.entry ?? cell.to}-${cell.action}-${index}`} className="border-t border-ink-700/60">
                <td className="py-1">{cell.exit ?? cell.from} → {cell.entry ?? cell.to}</td>
                <td className="py-1">{cell.action}</td>
                <td className="py-1 text-right">{cell.plays ?? cell.n ?? 0}</td>
                <td className="py-1 text-right">{Number(cell.reward ?? cell.mean ?? 0).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-2 text-xs text-ink-300">No context has enough evidence yet; the network and the heuristic are deciding.</p>
      )}
      <Link href="/models/" className="mt-3 inline-block text-xs text-ink-300 underline hover:text-ink-100">
        Train and inspect the models →
      </Link>
    </Panel>
  )
}

/**
 * The scoreboard: what each transition has actually done on this station.
 *
 * It is the automix's memory, and it is deliberately a small panel — the
 * numbers that matter are the rate (did listeners stay?) and whether the
 * effect has enough plays to be trusted at all.
 */
function Scoreboard({ outcomes }) {
  const rows = outcomes?.rows ?? []
  if (!rows.length) {
    return (
      <Panel title="Scoreboard" subtitle="What each transition does here, from the seams this station has played.">
        <Empty>No completed seams yet. The first few track changes start the record.</Empty>
      </Panel>
    )
  }
  return (
    <Panel
      title="Scoreboard"
      subtitle={`${outcomes.seams} seams · halves every ${outcomes.halfLifeDays} days · ${outcomes.minShows} plays before it counts`}
      actions={<Badge tone={outcomes.trusted.length ? 'lime' : 'ink'}>{outcomes.trusted.length} trusted</Badge>}
    >
      <table className="w-full text-left text-xs">
        <thead className="text-[10px] uppercase tracking-wider text-ink-500">
          <tr>
            <th className="py-1">transition</th>
            <th className="py-1 text-right">plays</th>
            <th className="py-1 text-right">stayed</th>
            <th className="py-1 text-right">skipped</th>
            <th className="py-1 text-right">rate</th>
          </tr>
        </thead>
        <tbody className="font-mono text-ink-200">
          {rows.map((row) => (
            <tr key={row.effect} className="border-t border-ink-700/60">
              <td className="py-1">
                {row.effect} {row.trusted ? <Badge tone="lime">counts</Badge> : <span className="text-ink-500">provisional</span>}
              </td>
              <td className="py-1 text-right">{row.plays}</td>
              <td className="py-1 text-right text-lime">{Math.round(row.completed)}</td>
              <td className="py-1 text-right text-rose">{Math.round(row.skipped)}</td>
              <td className="py-1 text-right">{Math.round(row.rate * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-ink-300">
        These numbers nudge the choice — at most ±6 % of a score — and are smoothed, so one bad night does not retire a transition.
      </p>
    </Panel>
  )
}

function SeamsBody() {
  const params = useSearchParams()
  const { stations, key } = useRadio()
  const [stationId, setStationId] = useState(params.get('id') ?? '')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!stationId && stations.length) setStationId(params.get('id') ?? stations[0].id)
  }, [stations, stationId, params])

  const load = useCallback(async () => {
    if (!stationId || !key) return
    try {
      setData(await owner(`/stations/${stationId}/seams`))
      setError(null)
    } catch (problem) {
      setError(problem.message)
    }
  }, [stationId, key])

  useEffect(() => {
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [load])

  if (!stations.length) {
    return (
      <Panel title="Seams">
        <Empty>No stations yet. <Link href="/stations/" className="underline">Create one</Link> and the scout starts listening.</Empty>
      </Panel>
    )
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Seams & Forever</h1>
          <p className="mt-1 text-sm text-ink-300">What the scout hears in the song on air, and what the jukebox graph can do with it.</p>
        </div>
        <select className={cx('rounded-lg border border-ink-600 bg-ink-900 px-2.5 py-1.5 text-sm')} value={stationId} onChange={(event) => setStationId(event.target.value)}>
          {stations.map((station) => (
            <option key={station.id} value={station.id}>{station.name}</option>
          ))}
        </select>
      </header>

      {!key ? (
        <KeyGate />
      ) : (
        <KeyGate>
          <div className="space-y-4">
            {error && <Panel title="Unavailable"><p className="text-sm text-rose">{error}</p></Panel>}
            <Panel
              title="Scout"
              subtitle={data?.track ? `listening to ${String(data.track).slice(0, 12)}` : 'waiting for a song to read'}
              actions={<Badge tone={data?.full ? 'lime' : data?.failed ? 'rose' : 'cyan'}>{data?.failed ? 'failed' : data?.full ? 'complete' : 'listening'}</Badge>}
            >
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Analysed" value={clock(data?.ms ?? 0)} />
                <Stat label="Beats" value={data?.beats ?? 0} />
                <Stat label="Candidates" value={data?.candidates ?? 0} accent="cyan" />
                <Stat label="Frames" value={data?.seenFrames ?? 0} hint={data?.frames != null ? `${data.frames} decoded` : ''} />
              </div>
              {data && <div className="mt-3"><Timeline analysis={data} /></div>}
            </Panel>

            <div className="grid gap-4 lg:grid-cols-2">
              <Panel title="Candidates" subtitle="Every place the detectors agree a track change belongs.">
                <CandidateList analysis={data ?? { seams: [] }} />
              </Panel>
              <div className="space-y-4">
                <Jukebox graph={data?.jukebox} forever={data?.forever} stationId={stationId} onRefreshed={load} />
                <RLPanel rl={data?.rl} />
                <Scoreboard outcomes={data?.outcomes} />
              </div>
            </div>
          </div>
        </KeyGate>
      )}
    </div>
  )
}

export default function SeamsPage() {
  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-ink-800/60" />}>
      <SeamsBody />
    </Suspense>
  )
}
