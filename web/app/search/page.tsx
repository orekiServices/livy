'use client'

/**
 * Search, find a song, then put it somewhere.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react'

import { useRadio } from '../../components/RadioProvider'
import { Badge, Button, Empty, Field, PageHeading, Panel, clock, cx, inputClass } from '../../components/ui'
import { api, owner } from '../../lib/api'
import type { Track } from '../../lib/types'

interface SourceHealth {
  calls?: number
  failed?: number
  avgMs?: number | null
  healthy?: boolean | null
  lastError?: string | null
  lastAt?: number | null
}

interface SourceRow {
  name: string
  canSearch?: boolean
  metadataOnly?: boolean
  live?: boolean
  health?: SourceHealth
}

function Sources() {
  const [data, setData] = useState<{ sources?: SourceRow[]; searchTimeoutMs?: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await api<{ sources?: SourceRow[]; searchTimeoutMs?: number }>('/api/v1/sources'))
      setError(null)
    } catch (problem) {
      setError((problem as Error).message)
    }
  }, [])

  useEffect(() => {
    const initial = setTimeout(() => void load(), 0)
    const timer = setInterval(() => void load(), 15_000)
    return () => {
      clearTimeout(initial)
      clearInterval(timer)
    }
  }, [load])

  if (error) return <Panel title="Sources"><p className="text-sm text-rose">{error}</p></Panel>
  if (!data) return <Panel title="Sources"><div className="skeleton h-20 rounded-md" /></Panel>

  const rows = [...(data.sources ?? [])].sort((a, b) => {
    const tried = (entry: SourceRow) => (entry.health?.calls ?? 0) > 0
    return Number(tried(b)) - Number(tried(a)) || a.name.localeCompare(b.name)
  })
  const searched = rows.filter((row) => row.canSearch)
  const broken = rows.filter((row) => row.health?.healthy === false)

  return (
    <Panel
      title="Sources"
      subtitle={`${rows.length} providers · ${searched.length} can search · ${data.searchTimeoutMs ?? 4000} ms timeout per provider`}
      actions={<Badge tone={broken.length ? 'rose' : 'lime'}>{broken.length ? `${broken.length} unhealthy` : 'all answering'}</Badge>}
      padded={false}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-2xs uppercase tracking-wider text-ink-500">
            <tr className="border-b border-ink-700">
              <th className="px-4 py-2">Provider</th>
              <th className="px-2 py-2">Capabilities</th>
              <th className="px-2 py-2 text-right">Calls</th>
              <th className="px-2 py-2 text-right">Failed</th>
              <th className="px-2 py-2 text-right">Avg</th>
              <th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody className="font-mono text-ink-200">
            {rows.map((row) => {
              const health = row.health ?? {}
              const state =
                health.healthy === null || health.healthy === undefined
                  ? 'bg-ink-500'
                  : health.healthy
                    ? 'bg-lime'
                    : 'bg-rose'
              return (
                <tr key={row.name} className="border-b border-ink-700 last:border-0">
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center gap-2">
                      <span className={cx('tally-bar', state)} aria-hidden="true" />
                      <span>{row.name}</span>
                      {row.metadataOnly && <span className="text-2xs text-ink-500">metadata</span>}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-2xs text-ink-300">
                    {[row.canSearch ? 'search' : null, row.metadataOnly ? '' : 'play', row.live ? 'live' : null]
                      .filter(Boolean)
                      .join(' · ') || 'none'}
                  </td>
                  <td className="numeric px-2 py-2 text-right">{health.calls ?? 0}</td>
                  <td className={cx('numeric px-2 py-2 text-right', health.failed ? 'text-rose' : 'text-ink-500')}>
                    {health.failed ?? 0}
                  </td>
                  <td className="numeric px-2 py-2 text-right text-ink-300">
                    {health.avgMs == null ? 'n/a' : `${health.avgMs} ms`}
                  </td>
                  <td className="max-w-[220px] truncate px-4 py-2 text-2xs text-ink-500" title={health.lastError ?? ''}>
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
  const [results, setResults] = useState<Track[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [said, setSaid] = useState<string | null>(null)

  const station = stationId || stations[0]?.id || ''

  const search = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!query.trim()) return
    setBusy(true)
    setError(null)
    setSaid(null)
    try {
      const answer = await api<{ tracks?: Track[] }>(
        `/api/v1/search?q=${encodeURIComponent(query.trim())}&provider=${encodeURIComponent(provider)}&limit=25`
      )
      setResults(answer.tracks ?? [])
    } catch (problem) {
      setError((problem as Error).message)
      setResults([])
    } finally {
      setBusy(false)
    }
  }

  const queue = async (track: Track) => {
    if (!station) return
    setSaid(null)
    try {
      await owner(`/stations/${station}/queue`, { method: 'POST', body: { track, top: true } })
      setSaid(`Queued “${track.title}” next on ${stations.find((row) => row.id === station)?.name ?? station}.`)
    } catch (problem) {
      setSaid((problem as Error).message)
    }
  }

  const playNow = async (track: Track) => {
    if (!station) return
    try {
      await api(`/api/v1/stations/${encodeURIComponent(station)}/play`, { method: 'POST', body: { track } })
      setSaid(`Playing “${track.title}” now on ${station}.`)
    } catch (problem) {
      setSaid((problem as Error).message)
    }
  }

  const setupSources: Array<{ name: string }> = setup?.sources ?? []

  return (
    <div className="space-y-4">
      <PageHeading
        eyebrow="Library"
        title="Search"
        subtitle={
          setupSources.length ? `${setupSources.length} sources on this node.` : 'The node has not published its sources yet.'
        }
      />

      <Panel>
        <form onSubmit={search} className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
          <input
            className={inputClass}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="artist, title, or a provider prefix"
            aria-label="Search the library"
            autoFocus
          />
          <select
            aria-label="Source"
            className={cx(inputClass, 'sm:w-40')}
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
          >
            <option value="all">all sources</option>
            {setupSources.map((source) => (
              <option key={source.name} value={source.name}>
                {source.name}
              </option>
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
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
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
            <div className="p-4">
              <Empty>Nothing came back. Try a provider, or a plain title.</Empty>
            </div>
          ) : (
            <ul className="divide-y divide-ink-700/60">
              {results.map((track, idx) => (
                <li key={track.id ?? `${track.title}-${idx}`} className="flex items-center gap-3 px-4 py-2">
                  <div className="h-9 w-9 shrink-0 overflow-hidden rounded-md bg-ink-800">
                    {track.artwork ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={track.artwork} alt="" className="h-full w-full object-cover" />
                    ) : null}
                  </div>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink-100">{track.title}</span>
                    <span className="block truncate text-2xs text-ink-500">
                      {track.artist ?? 'Unknown artist'} {track.duration ? `· ${clock(track.duration)}` : ''}
                    </span>
                  </span>
                  <Badge tone="ink">{track.source ?? '?'}</Badge>
                  {info?.deployment?.limits?.streaming !== false && (
                    <Button size="sm" variant="ghost" onClick={() => void playNow(track)}>
                      Play now
                    </Button>
                  )}
                  <Button size="sm" onClick={() => void queue(track)} disabled={!key || !station}>
                    Queue
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </div>
  )
}
