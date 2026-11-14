'use client'

/**
 * One station, in full: what it is playing, what is waiting, what it will do
 * at the next seam, and the switches that change any of that.
 *
 * The id comes from `?id=` rather than a path segment because the console is a
 * static export — there is no server to render `/station/night-shift` at
 * request time, and a query string keeps every station one file.
 */
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'

import { useRadio } from '../../components/RadioProvider.js'
import { IconPlay, IconRadio, IconSeams } from '../../components/icons.js'
import { Badge, Button, Empty, Field, KeyGate, Panel, Slider, Stat, Switch, ago, clock, cx, inputClass } from '../../components/ui.js'
import { api, owner } from '../../lib/api.js'

const EFFECTS = ['crossfade', 'bass-swap', 'filter', 'echo', 'sweep', 'spindown', 'slam', 'wash', 'roll', 'drop']

function useStationData(id, key) {
  const [data, setData] = useState({ loading: true, error: null })
  const load = useCallback(async () => {
    if (!id) return
    try {
      const publicInfo = await api(`/api/v1/stations/${encodeURIComponent(id)}`)
      let seam = null
      let filters = null
      let automix = null
      let queue = null
      let requests = null
      let model = null
      if (key) {
        ;[seam, filters, automix, queue, requests, model] = await Promise.all([
          owner(`/stations/${id}/seams`).catch(() => null),
          owner(`/stations/${id}/filters`).catch(() => null),
          owner(`/stations/${id}/automix`).catch(() => null),
          owner(`/stations/${id}/queue`).catch(() => null),
          owner(`/stations/${id}/requests`).catch(() => null),
          owner(`/stations/${id}/dj-model`).catch(() => null)
        ])
      }
      setData({ loading: false, error: null, station: publicInfo, seam, filters, automix, queue: queue?.queue ?? null, requests: requests?.requests ?? null, model })
    } catch (error) {
      setData((current) => ({ ...current, loading: false, error: error.message }))
    }
  }, [id, key])

  useEffect(() => {
    load()
  }, [load])

  return { ...data, load }
}

function Header({ station, refresh }) {
  const { play, tuned, playing, key, stationActions, refresh: refreshAll } = useRadio()
  const [busy, setBusy] = useState(null)
  const live = station.state === 'playing'
  const act = async (name) => {
    setBusy(name)
    try {
      await stationActions[name](station.id)
      await refresh()
      await refreshAll()
    } catch {
      /* the state line below is the error surface */
    } finally {
      setBusy(null)
    }
  }
  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <div className="h-12 w-12 overflow-hidden rounded-xl border border-ink-700 bg-ink-800">
          {station.nowPlaying?.track?.artwork || station.artwork ? (
            <img src={station.nowPlaying?.track?.artwork ?? station.artwork} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center text-ink-500">
              <IconRadio size={18} />
            </div>
          )}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{station.name}</h1>
            <Badge tone={live ? 'amber' : 'ink'}>{live ? 'on air' : station.state}</Badge>
          </div>
          <p className="text-xs text-ink-300">
            {station.genre ?? 'no genre'} · {station.listeners ?? 0} listening · buffered {clock(station.bufferedMs ?? 0)}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant={tuned === station.id && playing ? 'primary' : 'default'} onClick={() => play(station.id)}>
          <IconPlay size={12} /> {tuned === station.id && playing ? 'Playing' : 'Listen'}
        </Button>
        <Button size="sm" variant="ghost" disabled={!key || busy} onClick={() => act(live ? 'stop' : 'start')}>
          {live ? 'Stop' : 'Start'}
        </Button>
        <Button size="sm" variant="ghost" disabled={!key || busy || !live} onClick={() => act('skip')}>
          Skip
        </Button>
        <Button size="sm" variant="ghost" disabled={!key || busy} onClick={() => act('shuffle')}>
          Shuffle
        </Button>
        <Button size="sm" variant="ghost" disabled={!key || busy} onClick={() => act('reload')}>
          Reload
        </Button>
      </div>
    </header>
  )
}

function NowPlaying({ station }) {
  const track = station.nowPlaying?.track
  const progress = track?.duration ? Math.min(1, (station.nowPlaying?.positionMs ?? 0) / (track.duration * 1000)) : 0
  return (
    <Panel title="On air" padded={false}>
      <div className="flex items-center gap-3 p-4">
        <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-ink-800">
          {track?.artwork ? (
            <img src={track.artwork} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center text-ink-500">
              <IconRadio size={20} />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-ink-100">{track ? track.title : 'Nothing playing'}</div>
          <div className="truncate text-xs text-ink-300">{track?.artist ?? '—'}</div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink-700">
            <div className="h-full rounded-full bg-amber transition-all" style={{ width: `${progress * 100}%` }} />
          </div>
          <div className="mt-1 flex justify-between font-mono text-[11px] text-ink-300">
            <span>{clock(station.nowPlaying?.positionMs ?? 0)}</span>
            <span>{track?.duration ? clock(track.duration * 1000) : '—'}</span>
          </div>
        </div>
      </div>
      {station.upNext?.length > 0 && (
        <div className="border-t border-ink-700/70 px-4 py-2 text-xs text-ink-300">
          next: <span className="text-ink-200">{station.upNext[0]?.title}</span>
        </div>
      )}
    </Panel>
  )
}

function Queue({ station, queue, refresh }) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const rows = queue ?? []

  const add = async (event) => {
    event.preventDefault()
    if (!query.trim()) return
    setBusy(true)
    setError(null)
    try {
      await owner(`/stations/${station.id}/queue`, { method: 'POST', body: { query: query.trim() } })
      setQuery('')
      await refresh()
    } catch (problem) {
      setError(problem.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (index) => {
    await owner(`/stations/${station.id}/queue/${index}`, { method: 'DELETE' }).catch(() => {})
    await refresh()
  }

  const clear = async () => {
    await owner(`/stations/${station.id}/queue`, { method: 'DELETE' }).catch(() => {})
    await refresh()
  }

  return (
    <Panel
      title={`Queue · ${rows.length}`}
      subtitle="A search or a provider prefix; Enter adds the first match."
      actions={rows.length ? <Button size="sm" variant="ghost" onClick={clear}>Clear</Button> : null}
    >
      <form onSubmit={add} className="flex gap-2">
        <input className={inputClass} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="search, or local:/music/song.mp3" />
        <Button type="submit" variant="primary" disabled={busy || !query.trim()}>
          {busy ? '…' : 'Add'}
        </Button>
      </form>
      {error && <p className="mt-2 text-xs text-rose">{error}</p>}
      {rows.length === 0 && <Empty>Nothing queued. The rotation will refill once it has a playlist.</Empty>}
      <ul className="mt-3 space-y-1">
        {rows.slice(0, 20).map((track, index) => (
          <li key={`${track.id ?? track.title}-${index}`} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-ink-800/60">
            <span className="w-5 shrink-0 text-right font-mono text-[11px] text-ink-500">{index + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ink-100">{track.title}</span>
              <span className="block truncate text-[11px] text-ink-300">{track.artist ?? '—'} {track.duration ? `· ${clock(track.duration * 1000)}` : ''}</span>
            </span>
            <button type="button" onClick={() => remove(index)} className="text-[11px] text-ink-500 hover:text-rose">
              remove
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function AutomixPanel({ station, automix, refresh }) {
  const [draft, setDraft] = useState(null)
  const current = draft ?? automix ?? station.automix ?? {}
  const save = async (patch) => {
    const next = { ...current, ...patch }
    setDraft(next)
    await owner(`/stations/${station.id}/automix`, { method: 'POST', body: patch }).catch(() => {})
    await refresh()
  }
  return (
    <Panel title="Automix" subtitle="How one song becomes the next, and who chooses.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Transition">
          <select className={inputClass} value={current.effect ?? 'crossfade'} onChange={(event) => save({ effect: event.target.value })}>
            {EFFECTS.map((effect) => (
              <option key={effect} value={effect}>{effect}</option>
            ))}
          </select>
        </Field>
        <Field label="Blend">
          <div className="pt-2">
            <Slider
              label="crossfade"
              value={current.crossfadeMs ?? 6000}
              min={500}
              max={20_000}
              step={100}
              format={(value) => `${(value / 1000).toFixed(1)}s`}
              onChange={(value) => setDraft({ ...current, crossfadeMs: value })}
            />
            <Button size="sm" variant="ghost" className="mt-1" onClick={() => save({ crossfadeMs: current.crossfadeMs })}>
              Apply blend
            </Button>
          </div>
        </Field>
      </div>
      <div className="mt-2 divide-y divide-ink-700/60">
        <Switch label="Beatmatch" hint="stretch the outgoing track onto the incoming tempo" checked={current.beatmatch !== false} onChange={(value) => save({ beatmatch: value })} />
        <Switch label="Learned policy" hint="the model overrules the heuristic at the seam" checked={current.model !== false} onChange={(value) => save({ model: value })} />
        <Switch label="DJ voice" hint="a short ident over the blend" checked={current.dj?.enabled !== false} onChange={(value) => save({ dj: value })} />
        <Switch label="Automix" hint="off: tracks start and end on their own" checked={current.enabled !== false} onChange={(value) => save({ enabled: value })} />
      </div>
      {automix?.last && (
        <div className="mt-3 rounded-xl border border-ink-700 bg-ink-900/60 p-3 text-xs text-ink-300">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="cyan">{automix.last.effect ?? automix.last.decision?.effect ?? '?'}</Badge>
            <span>{automix.last.decision?.source ?? 'heuristic'}</span>
            <span>·</span>
            <span>{clock(automix.last.blendMs ?? 0)} blend</span>
            {automix.last.peakDb != null && <span>· {automix.last.peakDb} dBFS</span>}
          </div>
        </div>
      )}
    </Panel>
  )
}

function Requests({ station, requests, refresh }) {
  const rows = requests ?? []
  const remove = async (id) => {
    await owner(`/stations/${station.id}/requests/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
    await refresh()
  }
  return (
    <Panel title={`Requests · ${rows.length}`} subtitle={station.allowRequests ? 'Listeners can ask for songs.' : 'Requests are closed on this station.'}>
      {rows.length === 0 && <Empty>No requests waiting.</Empty>}
      <ul className="space-y-1">
        {rows.map((request) => (
          <li key={request.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-ink-800/60">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ink-100">{request.title ?? request.track?.title}</span>
              <span className="block truncate text-[11px] text-ink-300">{request.by ?? 'anonymous'} · {request.votes ?? 0} votes</span>
            </span>
            <button type="button" onClick={() => remove(request.id)} className="text-[11px] text-ink-500 hover:text-rose">
              remove
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function SeamPanel({ station, seam, refresh }) {
  const forever = seam?.forever ?? station.foreverInfo ?? { enabled: false }
  const rl = seam?.rl
  const toggle = async (enabled) => {
    await owner(`/stations/${station.id}/forever`, { method: 'POST', body: { enabled } }).catch(() => {})
    await refresh()
  }
  return (
    <Panel
      title="Scout & Forever"
      subtitle="What the seam detector hears in the song on air."
      actions={<Link href={`/seams/?id=${encodeURIComponent(station.id)}`}><Button size="sm" variant="ghost">Open →</Button></Link>}
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Beats" value={seam?.beats ?? '—'} />
        <Stat label="Candidates" value={seam?.candidates ?? '—'} accent="cyan" />
        <Stat label="Branches" value={seam?.jukebox?.branching ?? '—'} hint={seam?.jukebox ? `threshold ${seam.jukebox.threshold}` : 'no graph yet'} />
        <Stat label="Jumps" value={forever.jumps ?? 0} hint={forever.active ? 'looping' : forever.enabled ? 'armed' : 'off'} accent={forever.active ? 'amber' : 'ink'} />
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-3">
        <label className="flex items-center gap-2 text-sm text-ink-200">
          <input type="checkbox" checked={Boolean(forever.enabled)} onChange={(event) => toggle(event.target.checked)} className="accent-amber" />
          Forever mode
        </label>
        {rl && <span className="text-[11px] text-ink-300">{rl.seams ?? 0} RL observations · {rl.categories?.length ?? 8} kinds</span>}
      </div>
    </Panel>
  )
}

function FiltersSummary({ station, filters }) {
  const active = filters?.active ?? []
  return (
    <Panel
      title="Radio filters"
      subtitle="The DSP chain applied before the stream and before the mix."
      actions={<Link href={`/filters/?id=${encodeURIComponent(station.id)}`}><Button size="sm" variant="cyan">Open rack →</Button></Link>}
    >
      {active.length ? (
        <div className="flex flex-wrap gap-1.5">
          {active.map((name) => (
            <Badge key={name} tone="cyan">{name}</Badge>
          ))}
        </div>
      ) : (
        <p className="text-sm text-ink-300">Nothing is colouring the sound: the signal is going out as it came in.</p>
      )}
    </Panel>
  )
}

function Say({ station }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState(null)
  const send = async (event) => {
    event.preventDefault()
    if (!text.trim()) return
    setBusy(true)
    try {
      await owner(`/stations/${station.id}/say`, { method: 'POST', body: { text: text.trim() } })
      setSaid(`Queued: “${text.trim().slice(0, 40)}”`)
      setText('')
    } catch (error) {
      setSaid(error.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Panel title="Announce" subtitle="Spoken over the bed, then the music carries on.">
      <form onSubmit={send} className="flex gap-2">
        <input className={inputClass} value={text} onChange={(event) => setText(event.target.value)} placeholder="Back in ten minutes." />
        <Button type="submit" disabled={busy || !text.trim()}>Say</Button>
      </form>
      {said && <p className="mt-2 text-xs text-ink-300">{said}</p>}
    </Panel>
  )
}

/**
 * The station's own settings: what it is called, how it is described, and
 * where its music comes from.
 *
 * Editing is a PATCH of the fields the manager accepts; playlists are provider
 * strings (`local:/path`, `scsearch:…`), comma separated, exactly as the
 * stations page sends them on create.
 */
function Settings({ station, refresh }) {
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState(null)
  const form = draft ?? {
    name: station.name ?? '',
    genre: station.genre ?? '',
    description: station.description ?? '',
    playlists: (station.playlists ?? []).join(', '),
    allowRequests: station.allowRequests !== false
  }

  const set = (key, value) => setDraft({ ...form, [key]: value })

  const save = async (event) => {
    event.preventDefault()
    setBusy(true)
    setSaid(null)
    try {
      await owner(`/stations/${station.id}`, {
        method: 'PATCH',
        body: {
          name: form.name.trim() || station.name,
          genre: form.genre.trim(),
          description: form.description.trim(),
          playlists: form.playlists.split(',').map((entry) => entry.trim()).filter(Boolean),
          allowRequests: Boolean(form.allowRequests)
        }
      })
      setDraft(null)
      setSaid('Saved.')
      await refresh()
    } catch (problem) {
      setSaid(problem.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title="Settings" subtitle="What this station is, and where its music comes from.">
      <form onSubmit={save} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input className={inputClass} value={form.name} onChange={(event) => set('name', event.target.value)} />
          </Field>
          <Field label="Genre">
            <input className={inputClass} value={form.genre} onChange={(event) => set('genre', event.target.value)} placeholder="ambient" />
          </Field>
        </div>
        <Field label="Description">
          <input className={inputClass} value={form.description} onChange={(event) => set('description', event.target.value)} placeholder="one line for the station wall" />
        </Field>
        <Field label="Playlists" hint="Provider strings, comma separated: local:/music/ambient, scsearch:tycho awake">
          <textarea className={cx(inputClass, 'min-h-[64px] font-mono text-xs')} value={form.playlists} onChange={(event) => set('playlists', event.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-xs text-ink-300">
          <input type="checkbox" className="accent-amber" checked={Boolean(form.allowRequests)} onChange={(event) => set('allowRequests', event.target.checked)} />
          Listeners may request songs
        </label>
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy || !draft}>{busy ? 'Saving…' : 'Save changes'}</Button>
          {draft && <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>Discard</Button>}
          {said && <span className="text-xs text-ink-300">{said}</span>}
        </div>
      </form>
    </Panel>
  )
}

/**
 * The ban list.
 *
 * A listener is identified by the id their requests and votes carry; banning
 * one stops requests and play-now from that line without touching the stream
 * for everybody else. It is node-wide (the store keeps the table), which is
 * what the owner wants: one troll, one entry.
 */
function Listeners({ station }) {
  const [bans, setBans] = useState(null)
  const [voter, setVoter] = useState('')
  const [reason, setReason] = useState('')
  const [said, setSaid] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const payload = await owner('/bans')
      setBans(payload.bans ?? [])
    } catch (problem) {
      setBans({ error: problem.message })
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const ban = async (event) => {
    event.preventDefault()
    if (!voter.trim()) return
    setBusy(true)
    try {
      await owner('/bans', { method: 'POST', body: { voter: voter.trim(), reason: reason.trim() } })
      setVoter('')
      setReason('')
      setSaid('That line can no longer request or play.')
      await load()
    } catch (problem) {
      setSaid(problem.message)
    } finally {
      setBusy(false)
    }
  }

  const unban = async (id) => {
    await owner(`/bans/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
    await load()
  }

  return (
    <Panel title="Listeners" subtitle="Lines that may not request or play. The stream itself stays open to everyone.">
      <form onSubmit={ban} className="flex flex-wrap items-end gap-2">
        <div className="min-w-[160px] flex-1">
          <Field label="Listener id" hint="from a request row">
            <input className={inputClass} value={voter} onChange={(event) => setVoter(event.target.value)} placeholder="voter id" />
          </Field>
        </div>
        <div className="min-w-[160px] flex-1">
          <Field label="Reason">
            <input className={inputClass} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="spam" />
          </Field>
        </div>
        <Button type="submit" variant="danger" size="sm" disabled={busy || !voter.trim()}>Restrict</Button>
      </form>
      {said && <p className="mt-2 text-xs text-ink-300">{said}</p>}
      {Array.isArray(bans) && bans.length === 0 && <p className="mt-3 text-xs text-ink-300">Nobody is restricted.</p>}
      {Array.isArray(bans) && bans.length > 0 && (
        <ul className="mt-3 space-y-1">
          {bans.map((entry) => (
            <li key={entry.voter ?? entry.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-ink-800/60">
              <span className="min-w-0 flex-1 truncate font-mono text-ink-200">{entry.voter ?? entry.id}</span>
              <span className="truncate text-ink-500">{entry.reason || 'no reason given'}</span>
              <button type="button" onClick={() => unban(entry.voter ?? entry.id)} className="text-[11px] text-ink-500 hover:text-lime">
                allow
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function StationBody() {
  const params = useSearchParams()
  const id = params.get('id')
  const { key } = useRadio()
  const { station, seam, filters, automix, queue, requests, model, loading, error, load } = useStationData(id, key)

  if (!id) return <Empty>No station chosen. Open one from <Link href="/stations/" className="underline">Stations</Link>.</Empty>
  if (loading && !station) return <div className="h-40 animate-pulse rounded-2xl bg-ink-800/60" />
  if (error) return <Panel title="Station unavailable"><p className="text-sm text-rose">{error}</p></Panel>

  return (
    <div className="space-y-4">
      <Header station={station} refresh={load} />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <NowPlaying station={station} />
          <Queue station={station} queue={queue} refresh={load} />
          <Requests station={station} requests={requests} refresh={load} />
        </div>
        <div className="space-y-4">
          <AutomixPanel station={station} automix={automix} refresh={load} />
          <FiltersSummary station={station} filters={filters} />
          <SeamPanel station={station} seam={seam} refresh={load} />
          <Say station={station} />
          <Settings station={station} refresh={load} />
          <Listeners station={station} />
        </div>
      </div>
      {model?.model && (
        <Panel title="Policy in use" subtitle={`${model.model.name} · ${model.model.parameters} parameters · ${Math.round((model.stats?.predictions ?? 0))} predictions`}>
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-300">
            <Badge tone="cyan">{model.model.digest ?? 'no digest'}</Badge>
            <span>trained {ago(model.model.trainedAt)}</span>
            {model.torch && <span>· torch {model.torch.available ? model.torch.torch : 'not available'}</span>}
            <Link href={`/models/?id=${encodeURIComponent(station.id)}`} className="ml-auto underline hover:text-ink-100">Train →</Link>
          </div>
        </Panel>
      )}
    </div>
  )
}

export default function StationPage() {
  return (
    <Suspense fallback={<div className="h-40 animate-pulse rounded-2xl bg-ink-800/60" />}>
      <StationBody />
    </Suspense>
  )
}
