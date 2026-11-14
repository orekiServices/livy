'use client'

/**
 * One station, in full: what it is playing, what is waiting, what it will do
 * at the next seam, and the switches that change any of that.
 */
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useState, type FormEvent } from 'react'

import { useRadio, type StationActions } from '../../components/RadioProvider'
import { IconPlay, IconRadio, IconStop } from '../../components/icons'
import {
  Badge,
  Button,
  Empty,
  Field,
  PageHeading,
  PageSkeleton,
  Panel,
  Slider,
  Stat,
  Switch,
  ago,
  clock,
  cx,
  inputClass
} from '../../components/ui'
import { api, owner } from '../../lib/api'
import type { StationSummary, Track } from '../../lib/types'

const EFFECTS = ['crossfade', 'bass-swap', 'filter', 'echo', 'sweep', 'spindown', 'slam', 'wash', 'roll', 'drop']

/* eslint-disable @typescript-eslint/no-explicit-any */
interface StationDataState {
  loading: boolean
  error: string | null
  station?: StationSummary
  seam?: any
  filters?: any
  automix?: any
  queue?: Track[] | null
  requests?: any[] | null
  model?: any
}

function useStationData(id: string | null, key: string | null) {
  const [data, setData] = useState<StationDataState>({ loading: true, error: null })
  const load = useCallback(async () => {
    if (!id) return
    try {
      const publicInfo = await api<StationSummary>(`/api/v1/stations/${encodeURIComponent(id)}`)
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
      setData({
        loading: false,
        error: null,
        station: publicInfo,
        seam,
        filters,
        automix,
        queue: queue?.queue ?? null,
        requests: requests?.requests ?? null,
        model
      })
    } catch (error) {
      setData((current) => ({ ...current, loading: false, error: (error as Error).message }))
    }
  }, [id, key])

  useEffect(() => {
    const initial = setTimeout(() => void load(), 0)
    return () => clearTimeout(initial)
  }, [load])

  return { ...data, load }
}

function Header({ station, refresh }: { station: StationSummary; refresh: () => Promise<void> }) {
  const { play, stop, tuned, playing, buffering, key, stationActions, refresh: refreshAll } = useRadio()
  const [busy, setBusy] = useState<string | null>(null)
  const live = station.state === 'playing'
  const mine = tuned === station.id && (playing || buffering)
  const art = station.nowPlaying?.track?.artwork ?? station.artwork ?? null

  const act = async (name: keyof StationActions) => {
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
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-ink-700 pb-4">
      <div className="flex items-center gap-3.5">
        <div className="h-14 w-14 overflow-hidden rounded-lg border border-ink-700 bg-ink-900">
          {art ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={art} alt="" width={56} height={56} className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center text-ink-500">
              <IconRadio size={18} />
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-ink-100">{station.name}</h1>
            <Badge tone={live ? 'amber' : 'ink'} dot={live}>
              {live ? 'on air' : station.state}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-ink-500">
            {station.genre ?? 'general'} · <span className="numeric">{station.listeners ?? 0}</span> listening · buffered{' '}
            <span className="numeric">{clock(station.bufferedMs ?? 0)}</span>
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={mine ? 'primary' : 'default'} onClick={() => (mine ? stop() : void play(station.id))}>
          {mine ? <IconStop size={12} /> : <IconPlay size={12} />} {mine ? 'Stop' : 'Listen'}
        </Button>
        <Button size="sm" variant="ghost" disabled={!key || Boolean(busy)} onClick={() => void act(live ? 'stop' : 'start')}>
          {live ? 'Off air' : 'Start'}
        </Button>
        <Button size="sm" variant="ghost" disabled={!key || Boolean(busy) || !live} onClick={() => void act('skip')}>
          Skip
        </Button>
        <Button size="sm" variant="ghost" disabled={!key || Boolean(busy)} onClick={() => void act('shuffle')}>
          Shuffle
        </Button>
        <Button size="sm" variant="ghost" disabled={!key || Boolean(busy)} onClick={() => void act('reload')}>
          Reload
        </Button>
      </div>
    </header>
  )
}

function NowPlaying({ station }: { station: StationSummary }) {
  const track = station.nowPlaying?.track
  const durationMs = Number(track?.duration) || 0
  const positionMs = Number((station.nowPlaying as any)?.positionMs) || 0
  const progress = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0
  return (
    <Panel title="On air" padded={false} actions={track?.cached ? <Badge tone="lime">cached</Badge> : null}>
      <div className="flex items-center gap-3.5 p-4">
        <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-ink-700 bg-ink-900">
          {track?.artwork ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={track.artwork} alt="" width={64} height={64} className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center text-ink-500">
              <IconRadio size={20} />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-ink-100">{track ? track.title : 'Nothing playing'}</div>
          <div className="truncate text-xs text-ink-300">{track?.artist ?? 'No artist'}</div>
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-xs bg-ink-800">
            <div className="h-full bg-amber transition-all duration-200" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <div className="numeric mt-1.5 flex justify-between font-mono text-2xs text-ink-500">
            <span>{clock(positionMs)}</span>
            <span>{durationMs > 0 ? clock(durationMs) : 'live'}</span>
          </div>
        </div>
      </div>
      {(station.upNext?.length ?? 0) > 0 && (
        <div className="border-t border-ink-700 px-4 py-2.5 text-xs text-ink-500">
          Up next: <span className="font-medium text-ink-200">{station.upNext?.[0]?.title}</span>
        </div>
      )}
    </Panel>
  )
}

function Queue({ station, queue, refresh }: { station: StationSummary; queue: Track[] | null | undefined; refresh: () => Promise<void> }) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rows = queue ?? []

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!query.trim()) return
    setBusy(true)
    setError(null)
    try {
      await owner(`/stations/${station.id}/queue`, { method: 'POST', body: { query: query.trim() } })
      setQuery('')
      await refresh()
    } catch (problem) {
      setError((problem as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (index: number) => {
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
      actions={rows.length ? <Button size="sm" variant="ghost" onClick={() => void clear()}>Clear</Button> : null}
    >
      <form onSubmit={add} className="flex gap-2">
        <input
          className={inputClass}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="search, or local:/music/song.mp3"
          aria-label="Queue search query"
        />
        <Button type="submit" variant="primary" disabled={busy || !query.trim()}>
          {busy ? '…' : 'Add'}
        </Button>
      </form>
      {error && <p className="mt-2 text-xs text-rose">{error}</p>}
      {rows.length === 0 && <Empty>Nothing queued. The rotation will refill once it has a playlist.</Empty>}
      <ul className="mt-3 space-y-1">
        {rows.slice(0, 20).map((track, index) => (
          <li key={`${track.id ?? track.title}-${index}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-ink-800">
            <span className="numeric w-5 shrink-0 text-right font-mono text-2xs text-ink-500">{index + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ink-100">{track.title}</span>
              <span className="block truncate text-2xs text-ink-500">
                {track.artist ?? 'Unknown artist'} {track.duration ? `· ${clock(track.duration)}` : ''}
              </span>
            </span>
            <button
              type="button"
              onClick={() => void remove(index)}
              className="min-h-[32px] rounded px-2 text-2xs font-medium text-ink-300 hover:bg-ink-900 hover:text-rose"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function AutomixPanel({ station, automix, refresh }: { station: StationSummary; automix: any; refresh: () => Promise<void> }) {
  const [draft, setDraft] = useState<any>(null)
  const current = draft ?? automix ?? station.automix ?? {}
  const save = async (patch: Record<string, unknown>) => {
    const next = { ...current, ...patch }
    setDraft(next)
    await owner(`/stations/${station.id}/automix`, { method: 'POST', body: patch }).catch(() => {})
    await refresh()
  }
  return (
    <Panel title="Automix" subtitle="How one song becomes the next, and who chooses.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Transition">
          <select className={inputClass} value={current.effect ?? 'crossfade'} onChange={(event) => void save({ effect: event.target.value })}>
            {EFFECTS.map((effect) => (
              <option key={effect} value={effect}>
                {effect}
              </option>
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
            <Button size="sm" variant="ghost" className="mt-1" onClick={() => void save({ crossfadeMs: current.crossfadeMs })}>
              Apply blend
            </Button>
          </div>
        </Field>
      </div>
      <div className="mt-2 divide-y divide-ink-700/60">
        <Switch label="Beatmatch" hint="stretch the outgoing track onto the incoming tempo" checked={current.beatmatch !== false} onChange={(value) => void save({ beatmatch: value })} />
        <Switch label="Learned policy" hint="the model overrules the heuristic at the seam" checked={current.model !== false} onChange={(value) => void save({ model: value })} />
        <Switch label="DJ voice" hint="a short ident over the blend" checked={current.dj?.enabled !== false} onChange={(value) => void save({ dj: value })} />
        <Switch label="Automix" hint="off: tracks start and end on their own" checked={current.enabled !== false} onChange={(value) => void save({ enabled: value })} />
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

function Requests({ station, requests, refresh }: { station: StationSummary; requests: any[] | null | undefined; refresh: () => Promise<void> }) {
  const rows = requests ?? []
  const remove = async (id: string) => {
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
              <span className="block truncate text-[11px] text-ink-300">
                {request.by ?? 'anonymous'} · {request.votes ?? 0} votes
              </span>
            </span>
            <button
              type="button"
              onClick={() => void remove(request.id)}
              className="min-h-[32px] rounded px-2 text-2xs font-medium text-ink-300 hover:bg-ink-900 hover:text-rose"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function SeamPanel({ station, seam, refresh }: { station: StationSummary; seam: any; refresh: () => Promise<void> }) {
  const forever = seam?.forever ?? station.foreverInfo ?? { enabled: false }
  const rl = seam?.rl
  const toggle = async (enabled: boolean) => {
    await owner(`/stations/${station.id}/forever`, { method: 'POST', body: { enabled } }).catch(() => {})
    await refresh()
  }
  return (
    <Panel
      title="Scout & Forever"
      subtitle="What the seam detector hears in the song on air."
      actions={
        <Link href={`/seams/?id=${encodeURIComponent(station.id)}`}>
          <Button size="sm" variant="ghost">
            Open seams
          </Button>
        </Link>
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Beats" value={seam?.beats ?? '–'} />
        <Stat label="Candidates" value={seam?.candidates ?? '–'} accent="cyan" />
        <Stat label="Branches" value={seam?.jukebox?.branching ?? '–'} hint={seam?.jukebox ? `threshold ${seam.jukebox.threshold}` : 'no graph yet'} />
        <Stat
          label="Jumps"
          value={forever.jumps ?? 0}
          hint={
            forever.source === 'forever-jukebox'
              ? 'forever jukebox analysis'
              : forever.active
                ? 'looping, local analysis'
                : forever.enabled
                  ? 'armed'
                  : 'off'
          }
          accent={forever.active ? 'amber' : 'ink'}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-3">
        <label className="flex items-center gap-2 text-sm text-ink-200">
          <input type="checkbox" checked={Boolean(forever.enabled)} onChange={(event) => void toggle(event.target.checked)} className="accent-amber" />
          Forever mode
        </label>
        {rl && (
          <span className="text-[11px] text-ink-300">
            {rl.seams ?? 0} RL observations · {rl.categories?.length ?? 8} kinds
          </span>
        )}
      </div>
    </Panel>
  )
}

function FiltersSummary({ station, filters }: { station: StationSummary; filters: any }) {
  const active: string[] = filters?.active ?? []
  return (
    <Panel
      title="Radio filters"
      subtitle="The DSP chain applied before the stream and before the mix."
      actions={
        <Link href={`/filters/?id=${encodeURIComponent(station.id)}`}>
          <Button size="sm" variant="cyan">
            Open rack
          </Button>
        </Link>
      }
    >
      {active.length ? (
        <div className="flex flex-wrap gap-1.5">
          {active.map((name) => (
            <Badge key={name} tone="cyan">
              {name}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-sm text-ink-300">Nothing is colouring the sound: the signal is going out as it came in.</p>
      )}
    </Panel>
  )
}

function Say({ station }: { station: StationSummary }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!text.trim()) return
    setBusy(true)
    try {
      await owner(`/stations/${station.id}/say`, { method: 'POST', body: { text: text.trim() } })
      setSaid(`Queued: “${text.trim().slice(0, 40)}”`)
      setText('')
    } catch (error) {
      setSaid((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Panel title="Announce" subtitle="Spoken over the bed, then the music carries on.">
      <form onSubmit={send} className="flex gap-2">
        <input className={inputClass} value={text} onChange={(event) => setText(event.target.value)} placeholder="Back in ten minutes." aria-label="Announcement text" />
        <Button type="submit" disabled={busy || !text.trim()}>
          Say
        </Button>
      </form>
      {said && <p className="mt-2 text-xs text-ink-300">{said}</p>}
    </Panel>
  )
}

function Settings({ station, refresh }: { station: StationSummary; refresh: () => Promise<void> }) {
  const [draft, setDraft] = useState<{ name: string; genre: string; description: string; playlists: string; allowRequests: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const form = draft ?? {
    name: station.name ?? '',
    genre: station.genre ?? '',
    description: station.description ?? '',
    playlists: (station.playlists ?? []).join(', '),
    allowRequests: station.allowRequests !== false
  }

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setDraft({ ...form, [key]: value })

  const save = async (event: FormEvent<HTMLFormElement>) => {
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
          playlists: form.playlists
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
          allowRequests: Boolean(form.allowRequests)
        }
      })
      setDraft(null)
      setSaid('Saved.')
      await refresh()
    } catch (problem) {
      setSaid((problem as Error).message)
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
          <Button type="submit" variant="primary" disabled={busy || !draft}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
          {draft && (
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
              Discard
            </Button>
          )}
          {said && <span className="text-xs text-ink-300">{said}</span>}
        </div>
      </form>
    </Panel>
  )
}

function Listeners() {
  const [bans, setBans] = useState<any[] | { error: string } | null>(null)
  const [voter, setVoter] = useState('')
  const [reason, setReason] = useState('')
  const [said, setSaid] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const payload = await owner<{ bans?: any[] }>('/bans')
      setBans(payload.bans ?? [])
    } catch (problem) {
      setBans({ error: (problem as Error).message })
    }
  }, [])

  useEffect(() => {
    const initial = setTimeout(() => void load(), 0)
    return () => clearTimeout(initial)
  }, [load])

  const ban = async (event: FormEvent<HTMLFormElement>) => {
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
      setSaid((problem as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const unban = async (id: string) => {
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
        <Button type="submit" variant="danger" size="sm" disabled={busy || !voter.trim()}>
          Restrict
        </Button>
      </form>
      {said && <p className="mt-2 text-xs text-ink-300">{said}</p>}
      {Array.isArray(bans) && bans.length === 0 && <p className="mt-3 text-xs text-ink-300">Nobody is restricted.</p>}
      {Array.isArray(bans) && bans.length > 0 && (
        <ul className="mt-3 space-y-1">
          {bans.map((entry) => (
            <li key={entry.voter ?? entry.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-ink-800/60">
              <span className="min-w-0 flex-1 truncate font-mono text-ink-200">{entry.voter ?? entry.id}</span>
              <span className="truncate text-ink-500">{entry.reason || 'no reason given'}</span>
              <button
                type="button"
                onClick={() => void unban(entry.voter ?? entry.id)}
                className="min-h-[32px] rounded px-2 text-2xs font-medium text-ink-300 hover:bg-ink-900 hover:text-lime"
              >
                Allow
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
  const { key, stations } = useRadio()
  const { station, seam, filters, automix, queue, requests, model, loading, error, load } = useStationData(id, key)

  if (!id) {
    return (
      <div className="space-y-5">
        <PageHeading
          eyebrow="Broadcast"
          title="Station"
          subtitle="Select a station to control its queue, automix, DSP rack, and announcements."
          actions={
            <Link href="/stations/">
              <Button size="sm" variant="primary">
                All stations
              </Button>
            </Link>
          }
        />
        {stations.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {stations.map((entry) => (
              <Link
                key={entry.id}
                href={`/station/?id=${encodeURIComponent(entry.id)}`}
                className="desk-panel block p-4 transition-colors hover:border-amber"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-ink-100">{entry.name}</span>
                  <Badge tone={entry.state === 'playing' ? 'amber' : 'ink'} dot={entry.state === 'playing'}>
                    {entry.state}
                  </Badge>
                </div>
                <p className="mt-1 truncate text-xs text-ink-500">{entry.nowPlaying?.track?.title ?? entry.genre ?? 'Idle'}</p>
              </Link>
            ))}
          </div>
        ) : (
          <Empty title="No station selected">
            Open any station from <Link href="/stations/" className="text-ink-100 underline">Stations</Link> to inspect and drive it.
          </Empty>
        )}
      </div>
    )
  }
  if (loading && !station) return <PageSkeleton title="Station" subtitle="Loading station telemetry..." rows={2} />
  if (error || !station) {
    return (
      <div className="space-y-4">
        <PageHeading eyebrow="Broadcast" title="Station" subtitle="Unable to load station details." />
        <Panel title="Station unavailable">
          <p className="text-sm text-rose">{error ?? 'Station not found.'}</p>
        </Panel>
      </div>
    )
  }

  return (
    <div className="space-y-5">
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
          <Listeners />
        </div>
      </div>
      {model?.model && (
        <Panel
          title="Policy in use"
          subtitle={`${model.model.name} · ${model.model.parameters} parameters · ${Math.round(model.stats?.predictions ?? 0)} predictions`}
        >
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-300">
            <Badge tone="cyan">{model.model.digest ?? 'no digest'}</Badge>
            <span>trained {ago(model.model.trainedAt)}</span>
            {model.torch && <span>· torch {model.torch.available ? model.torch.torch : 'not available'}</span>}
            <Link
              href={`/models/?id=${encodeURIComponent(station.id)}`}
              className="ml-auto font-medium text-ink-100 underline underline-offset-4 hover:text-amber"
            >
              Open trainer
            </Link>
          </div>
        </Panel>
      )}
    </div>
  )
}

export default function StationPage() {
  return (
    <Suspense fallback={<PageSkeleton title="Station" subtitle="What is playing, what is next, and what the engine decided." rows={3} />}>
      <StationBody />
    </Suspense>
  )
}
