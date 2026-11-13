'use client'

/**
 * Search — find a song, then put it somewhere.
 *
 * Results come from the node's own sources, so a local folder, SoundCloud,
 * Audius and the rest are one list. "Play now" goes through the listener route
 * (which the station can switch off); "Queue" is the owner's.
 */
import { useState } from 'react'

import { useRadio } from '../../components/RadioProvider.js'
import { Badge, Button, Empty, Field, Panel, clock, cx, inputClass } from '../../components/ui.js'
import { api, owner } from '../../lib/api.js'

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
