'use client'

/**
 * Search — across every source the node has, in one ranked list.
 *
 * The node does the hard part (`SourceRegistry.search` fans out to a dozen
 * providers, scores each result on how well it matches what you typed,
 * collapses the same song from different services and returns one list).
 * This screen does the phone part: a field, source chips, and rows you can
 * queue or play with one tap.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import TopBar from '../../components/TopBar.js'
import Sheet from '../../components/Sheet.js'
import { useRadio } from '../../components/RadioProvider.js'
import { api, owner, ownerKey } from '../../lib/api.js'
import { SearchOn, Note, Add, Play, Check } from '../../components/icons.js'

/** A few things worth typing, so an empty screen is not a dead end. */
const SUGGESTIONS = [
  { label: 'Lo-fi beats', query: 'lofi hip hop' },
  { label: 'Ambient', query: 'ambient instrumental' },
  { label: 'Jazz', query: 'jazz quartet' },
  { label: 'Electronic', query: 'electronic' },
  { label: 'Vietnamese', query: 'nhạc trẻ' },
  { label: 'Classical', query: 'piano sonata' }
]

export default function SearchPage() {
  const { stations, tuned, say } = useRadio()
  const [term, setTerm] = useState('')
  const [source, setSource] = useState('all')
  const [sources, setSources] = useState([])
  const [results, setResults] = useState([])
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState(null)
  const [queued, setQueued] = useState(new Set())
  const inputRef = useRef(null)

  useEffect(() => {
    api('/api/v1/info')
      .then((info) => setSources(info.sources ?? []))
      .catch(() => {})
  }, [])

  const run = useCallback(
    async (query, provider = source) => {
      const text = String(query ?? '').trim()
      if (!text) return
      setBusy(true)
      try {
        const payload = await api(
          `/api/v1/search?q=${encodeURIComponent(text)}&limit=25${provider !== 'all' ? `&provider=${provider}` : ''}`
        )
        setResults(payload.tracks ?? [])
      } catch (error) {
        say?.(error.message)
      } finally {
        setBusy(false)
      }
    },
    [source, say]
  )

  const submit = (event) => {
    event.preventDefault()
    inputRef.current?.blur()
    run(term)
  }

  const queue = async (track, stationId) => {
    try {
      if (ownerKey()) await owner(`/stations/${stationId}/queue`, { method: 'POST', body: { track } })
      else await api(`/api/v1/stations/${stationId}/request`, { method: 'POST', body: { track } })
      setQueued((current) => new Set(current).add(track.id))
      say?.(`Queued “${track.title}”`)
      setPicked(null)
    } catch (error) {
      say?.(error.message)
    }
  }

  return (
    <>
      <TopBar title="Search" subtitle={`${sources.length} sources`} />
      <main className="page">
        <form onSubmit={submit} className="row" style={{ gap: 8 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <span style={{ position: 'absolute', left: 12, top: 13, pointerEvents: 'none' }}>
              <SearchOn size={19} color="#717171" />
            </span>
            <input
              ref={inputRef}
              type="search"
              value={term}
              placeholder="Songs, artists, links"
              onChange={(event) => setTerm(event.target.value)}
              style={{ paddingLeft: 40 }}
            />
          </div>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? <span className="spin" /> : 'Go'}
          </button>
        </form>

        <div className="chips" style={{ marginTop: 10 }}>
          <button className={`chip ${source === 'all' ? 'on' : ''}`} onClick={() => { setSource('all'); if (term) run(term, 'all') }}>
            Everywhere
          </button>
          {sources
            .filter((name) => !['tts', 'http', 'mirror'].includes(name))
            .map((name) => (
              <button
                key={name}
                className={`chip ${source === name ? 'on' : ''}`}
                onClick={() => {
                  setSource(name)
                  if (term) run(term, name)
                }}
              >
                {name}
              </button>
            ))}
        </div>

        {results.length === 0 && !busy ? (
          <>
            <div className="shelf-head">
              <h2>Try</h2>
            </div>
            <div className="chips" style={{ flexWrap: 'wrap' }}>
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion.query}
                  className="chip quiet"
                  onClick={() => {
                    setTerm(suggestion.query)
                    run(suggestion.query)
                  }}
                >
                  {suggestion.label}
                </button>
              ))}
            </div>
          </>
        ) : null}

        <div className="stack" style={{ marginTop: 12 }}>
          {results.map((track) => (
            <button key={`${track.source}:${track.id}`} className="row-item" onClick={() => setPicked(track)}>
              {track.artwork ? (
                <img className="art" src={track.artwork} alt="" />
              ) : (
                <div className="art">
                  <Note size={20} color="#717171" />
                </div>
              )}
              <div className="body">
                <div className="t truncate">{track.title}</div>
                <div className="s truncate">
                  {track.artist} · {track.source}
                  {track.bitrate >= 192 ? ' · hi-res' : ''}
                </div>
              </div>
              {queued.has(track.id) ? <Check size={20} color="#2ba640" /> : <Add size={20} color="#717171" />}
            </button>
          ))}
        </div>
      </main>

      <Sheet open={Boolean(picked)} title={picked?.title} onClose={() => setPicked(null)}>
        {picked ? (
          <>
            <div className="row" style={{ marginBottom: 14 }}>
              {picked.artwork ? <img className="art lg" src={picked.artwork} alt="" /> : <div className="art lg">🎵</div>}
              <div style={{ minWidth: 0 }}>
                <div className="truncate" style={{ fontWeight: 600 }}>
                  {picked.title}
                </div>
                <div className="dim truncate">
                  {picked.artist} · {picked.source}
                </div>
              </div>
            </div>

            <div className="section-title">Add to</div>
            <div className="stack">
              {stations.map((station) => (
                <button key={station.id} className="row-item" onClick={() => queue(picked, station.id)}>
                  <div className="art">
                    <Play size={18} color="#717171" />
                  </div>
                  <div className="body">
                    <div className="t">{station.name}</div>
                    <div className="s">
                      {station.id === tuned ? 'playing now · ' : ''}
                      {station.queueLength ?? 0} queued
                    </div>
                  </div>
                </button>
              ))}
              {stations.length === 0 ? <p className="dim">No stations yet.</p> : null}
            </div>
          </>
        ) : null}
      </Sheet>
    </>
  )
}
