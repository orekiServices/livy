'use client'

/**
 * Search — find a song, then put it somewhere.
 *
 * Results come from the node's own sources, so a local folder, SoundCloud,
 * Audius and the rest are one list. "Play now" goes through the listener route
 * (which the station can switch off); "Queue" is the owner's.
 */
import { useCallback, useEffect, useState } from 'react'

import { useRadio } from '../../components/RadioProvider.js'
import { Badge, Button, Empty, Field, Panel, clock, cx, inputClass } from '../../components/ui.js'
import { api, owner } from '../../lib/api.js'

/** What each provider has done lately — the registry keeps the numbers. */
function Sources() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      setData(await api('/api/v1/sources'))
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

  if (error) return <Panel title="Sources"><p className="text-sm text-rose">{error}</p></Panel>
  if (!data) return <Panel title="Sources"><div className="h-20 animate-pulse rounded-xl bg-ink-800/60" /></Panel>

  const rows = [...(data.sources ?? [])].sort((a, b) => {
    const tried = (entry) => (entry.health?.calls ?? 0) > 0
    return Number(tried(b)) - Number(tried(a)) || a.name.localeCompare(b.name)
  })
  const searched = rows.filter((row) => row.canSearch)
  const broken = rows.filter((row) => row.health?.healthy === false)

  return (
    <Panel
      title="Sources"
      subtitle={`${rows.length} providers · ${searched.length} can search · ${data.searchTimeoutMs ?? 4000} ms each before a search answers without them`}
      actions={<Badge tone={broken.length ? 'rose' : 'lime'}>{broken.length ? `${broken.length} unhealthy` : 'all answering'}</Badge>}
      padded={false}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-ink-500">
            <tr className="border-b border-ink-700/60">
              <th className="px-4 py-2">provider</th>
              <th className="px-2 py-2">can</th>
              <th className="px-2 py-2 text-right">calls</th>
              <th className="px-2 py-2 text-right">failed</th>
              <th className="px-2 py-2 text-right">avg</th>
              <th className="px-4 py-2">last</th>
            </tr>
          </thead>
          <tbody className="font-mono text-ink-200">
            {rows.map((row) => {
              const health = row.health ?? {}
              const state = health.healthy === null || health.healthy === undefined ? 'text-ink-500' : health.healthy ? 'text-lime' : 'text-rose'
              return (
                <tr key={row.name} className="border-b border-ink-700/40 last:border-0">
                  <td className="px-4 py-1.5">
                    <span className={state}>●</span> {row.name}
                    {row.metadataOnly && <span className="ml-1 text-[10px] text-ink-500">metadata</span>}
                  </td>
                  <td className="px-2 py-1.5 text-[11px] text-ink-400">
                    {[row.canSearch ? 'search' : null, row.metadataOnly ? '' : 'play', row.live ? 'live' : null].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right">{health.calls ?? 0}</td>
                  <td className={cx('px-2 py-1.5 text-right', health.failed ? 'text-rose' : 'text-ink-500')}>{health.failed ?? 0}</td>
                  <td className="px-2 py-1.5 text-right text-ink-300">{health.avgMs == null ? '—' : `${health.avgMs} ms`}</td>
                  <td className="max-w-[220px] truncate px-4 py-1.5 text-[11px] text-ink-500" title={health.lastError ?? ''}>
                    {health.lastError ?? (health.lastAt ? 'ok' : 'not tried yet')}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

export default function SearchPage() {
  const { stations, setup, key, info } = useRadio()
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState('all')
  const [stationId, setStationId] = useState('')
  const [results, setResults] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [said, setSaid] = useState(null)

  const station = stationId || stations[0]?.id || ''

  const search = async (event) => {
    event.preventDefault()
    if (!query.trim()) return
    setBusy(true)
    setError(null)
    setSaid(null)
    try {
      const answer = await api(`/api/v1/search?q=${encodeURIComponent(query.trim())}&provider=${encodeURIComponent(provider)}&limit=25`)
      setResults(answer.tracks ?? [])
    } catch (problem) {
      setError(problem.message)
      setResults([])
    } finally {
      setBusy(false)
    }
  }

  const queue = async (track) => {
    if (!station) return
    setSaid(null)
    try {
      await owner(`/stations/${station}/queue`, { method: 'POST', body: { track, top: true } })
      setSaid(`Queued “${track.title}” next on ${stations.find((row) => row.id === station)?.name ?? station}.`)
    } catch (problem) {
      setSaid(problem.message)
    }
  }

  const playNow = async (track) => {
    if (!station) return
    try {
      await api(`/api/v1/stations/${encodeURIComponent(station)}/play`, { method: 'POST', body: { track } })
      setSaid(`Playing “${track.title}” now on ${station}.`)
    } catch (problem) {
      setSaid(problem.message)
    }
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
        <p className="mt-1 text-sm text-ink-300">
          {setup?.sources?.length ? `${setup.sources.length} sources on this node.` : 'The node has not published its sources yet.'}
        </p>
      </header>

      <Panel>
        <form onSubmit={search} className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
          <input className={inputClass} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="artist, title, or a provider prefix" autoFocus />
          <select className={cx(inputClass, 'sm:w-40')} value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="all">all sources</option>
            {(setup?.sources ?? []).map((source) => (
              <option key={source.name} value={source.name}>{source.name}</option>
            ))}
          </select>
          <Button type="submit" variant="primary" disabled={busy || !query.trim()}>
            {busy ? 'Searching…' : 'Search'}
          </Button>
        </form>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[200px]">
            <Field label="Send to station">
              <select className={inputClass} value={station} onChange={(event) => setStationId(event.target.value)}>
                {stations.map((row) => (
                  <option key={row.id} value={row.id}>{row.name}</option>
                ))}
              </select>
            </Field>
          </div>
          {!key && <span className="text-[11px] text-ink-300">Queue needs the owner key; play-now is a listener action.</span>}
        </div>
        {error && <p className="mt-2 text-xs text-rose">{error}</p>}
        {said && <p className="mt-2 text-xs text-lime">{said}</p>}
      </Panel>

      <Sources />

      {results && (
        <Panel title={`Results · ${results.length}`} padded={false}>
          {results.length === 0 ? (
            <div className="p-4"><Empty>Nothing came back. Try a provider, or a plain title.</Empty></div>
          ) : (
            <ul className="divide-y divide-ink-700/60">
              {results.map((track) => (
                <li key={track.id} className="flex items-center gap-3 px-4 py-2">
                  <div className="h-9 w-9 shrink-0 overflow-hidden rounded-md bg-ink-800">
                    {track.artwork ? <img src={track.artwork} alt="" className="h-full w-full object-cover" /> : null}
                  </div>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink-100">{track.title}</span>
                    <span className="block truncate text-[11px] text-ink-300">
                      {track.artist ?? '—'} {track.duration ? `· ${clock(track.duration * 1000)}` : ''}
                    </span>
                  </span>
                  <Badge tone="ink">{track.source ?? '?'}</Badge>
                  {info?.deployment?.limits?.streaming !== false && (
                    <Button size="sm" variant="ghost" onClick={() => playNow(track)}>Play now</Button>
                  )}
                  <Button size="sm" onClick={() => queue(track)} disabled={!key || !station}>Queue</Button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </div>
  )
}
