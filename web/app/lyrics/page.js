'use client'

/**
 * Words, the lyrics for whatever the station is playing, in time.
 *
 * The node does the fetching (see `core/lyrics.js`): this page asks
 * `/api/v1/lyrics?station=…` and gets lines, a sync anchor and the provider's
 * answer. Nothing here talks to a lyrics service, and nothing is cached in the
 * browser beyond the track on air.
 *
 * The clock is the interesting part. The server says "line 14 was at 1:32.400,
 * and it is now 12:04:01.220"; the page keeps its own position from that
 * anchor, ticks it locally, and re-anchors on every poll, so the highlight
 * moves smoothly instead of jumping once every four seconds, and it never
 * drifts more than one poll away from the station.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useRadio } from '../../components/RadioProvider.js'
import { Badge, Button, Empty, Panel, cx } from '../../components/ui.js'
import { api } from '../../lib/api.js'

const POLL_MS = 4000

/** Which line is playing at `positionMs`, and how far through it we are. */
function lineAt(lines, positionMs) {
  let index = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].at <= positionMs) index = i
    else break
  }
  return index
}

const clock = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export default function LyricsPage() {
  const { stations, tuned, playing } = useRadio()
  const [stationId, setStationId] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [offset, setOffset] = useState(0)
  const [position, setPosition] = useState(0)
  const [follow, setFollow] = useState(true)
  const anchor = useRef(null)
  const activeRef = useRef(null)
  const scroller = useRef(null)

  const station = stationId || stations[0]?.id || ''

  const load = useCallback(async () => {
    if (!station) return
    try {
      const payload = await api(`/api/v1/lyrics?station=${encodeURIComponent(station)}`)
      setData(payload)
      anchor.current = { positionMs: payload.positionMs ?? 0, at: Date.now() }
      setPosition(payload.positionMs ?? 0)
      setError(null)
    } catch (problem) {
      setError(problem.message)
    }
  }, [station])

  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  // The local clock: advance from the last anchor, four times a second, which
  // is enough for a line highlight and cheap enough to leave running.
  useEffect(() => {
    const tick = setInterval(() => {
      const base = anchor.current
      if (!base) return
      const live = data?.station ? playing || tuned === data.station : true
      setPosition(base.positionMs + (live ? Date.now() - base.at : 0) + offset)
    }, 250)
    return () => clearInterval(tick)
  }, [data, playing, tuned, offset])

  const lines = data?.lines ?? []
  const index = useMemo(() => lineAt(lines, position), [lines, position])

  // Keep the sung line in the middle of the panel, unless the reader has
  // scrolled away to look at something else.
  useEffect(() => {
    if (!follow) return
    const node = activeRef.current
    const box = scroller.current
    if (!node || !box) return
    const target = node.offsetTop - box.clientHeight / 2 + node.clientHeight / 2
    box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
  }, [index, follow, lines.length])

  const plain = !data?.synced && Array.isArray(data?.plain) ? data.plain : null
  const plainLines = plain ?? (data?.plain ? String(data.plain).split('\n') : [])

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Words</h1>
          <p className="mt-1 text-sm text-ink-300">
            What is on air, in time. The node fetches it once and caches it; this page only follows along.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select className={cx('rounded-lg border border-ink-600 bg-ink-900 px-2.5 py-1.5 text-sm')} value={station} onChange={(event) => setStationId(event.target.value)}>
            {stations.map((row) => (
              <option key={row.id} value={row.id}>{row.name}</option>
            ))}
          </select>
          <Button size="sm" onClick={load}>Refresh</Button>
        </div>
      </header>

      {!stations.length && (
        <Panel title="Words">
          <Empty>No stations yet, so nothing to sing along with.</Empty>
        </Panel>
      )}

      {error && (
        <Panel title="Unavailable">
          <p className="text-sm text-rose">{error}</p>
        </Panel>
      )}

      {station && data && (
        <Panel
          title={data.track?.title ?? 'Nothing on air'}
          subtitle={[data.track?.artist, data.track?.album].filter(Boolean).join(' · ') || (data.reason ?? 'silence')}
          actions={
            <>
              {data.provider && <Badge tone="ink">{data.provider}</Badge>}
              {data.cached && <Badge tone="cyan">cached</Badge>}
              {data.instrumental ? <Badge tone="amber">instrumental</Badge> : data.synced ? <Badge tone="lime">synced</Badge> : data.found ? <Badge tone="ink">plain</Badge> : null}
            </>
          }
        >
          {data.found === false && <Empty>{data.track?.title ? 'No words for this one, not every song has lyrics.' : 'Nothing is playing.'}</Empty>}

          {data.instrumental && <Empty>Marked as an instrumental. There is nothing to sing, which is the point.</Empty>}

          {data.synced && lines.length > 0 && (
            <>
              <div
                ref={scroller}
                onWheel={() => setFollow(false)}
                onTouchMove={() => setFollow(false)}
                className="max-h-[55vh] overflow-y-auto rounded-xl border border-ink-700 bg-ink-900/60 px-4 py-8"
              >
                {lines.map((line, i) => (
                  <p
                    key={`${line.at}-${i}`}
                    ref={i === index ? activeRef : null}
                    className={cx(
                      'mx-auto max-w-xl py-1.5 text-center text-base leading-relaxed transition',
                      i === index ? 'font-medium text-ink-100' : i < index ? 'text-ink-500' : 'text-ink-300'
                    )}
                  >
                    {line.text || '♪'}
                  </p>
                ))}
                <p className="mt-6 text-center text-[11px] text-ink-500">
                  {index >= 0 ? clock(lines[index].at) : '–'} / {clock(data.durationMs ?? 0)}
                  {data.offsetMs ? ` · file offset ${data.offsetMs} ms` : ''}
                </p>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="sm" variant={follow ? 'cyan' : 'ghost'} onClick={() => setFollow(!follow)}>
                  {follow ? 'Following' : 'Follow'}
                </Button>
                <span className="text-[11px] text-ink-300">If the words run ahead or behind, nudge them:</span>
                <Button size="sm" onClick={() => setOffset(offset - 250)} title="Show them 250 ms later">−0.25 s</Button>
                <span className="w-16 text-center font-mono text-xs text-ink-200">{(offset / 1000).toFixed(2)} s</span>
                <Button size="sm" onClick={() => setOffset(offset + 250)} title="Show them 250 ms earlier">+0.25 s</Button>
                {offset !== 0 && <Button size="sm" variant="ghost" onClick={() => setOffset(0)}>reset</Button>}
              </div>
            </>
          )}

          {!data.synced && data.found && plainLines.length > 0 && (
            <div className="max-h-[55vh] overflow-y-auto rounded-xl border border-ink-700 bg-ink-900/60 px-4 py-6">
              {plainLines.map((line, i) => (
                <p key={i} className="mx-auto max-w-xl py-1 text-center text-sm leading-relaxed text-ink-200">
                  {line || '♪'}
                </p>
              ))}
              <p className="mt-4 text-center text-[11px] text-ink-500">No timings in this file, so there is nothing to follow. The words are just here.</p>
            </div>
          )}
        </Panel>
      )}

      <p className="text-[11px] text-ink-500">
        Lyrics come from LRCLIB through the node. A miss is cached for six hours and a hit for a week, so a song that
        has no words today may have them tomorrow.
      </p>
    </div>
  )
}
