'use client'

/**
 * Stations, the wall, and the form that makes another one.
 *
 * A station in Livy is a queue, a filter chain and a policy, so the card shows
 * exactly those three things plus who is listening.
 */
import Link from 'next/link'
import { useState } from 'react'

import { useRadio } from '../../components/RadioProvider.js'
import { IconRadio } from '../../components/icons.js'
import { Badge, Button, Field, KeyGate, Panel, inputClass } from '../../components/ui.js'
import { owner } from '../../lib/api.js'

function StationCard({ station }) {
  const { play, tuned, playing, stationActions, key } = useRadio()
  const track = station.nowPlaying?.track
  const live = station.state === 'playing'
  const mine = tuned === station.id && playing
  return (
    <div className="rounded-2xl border border-ink-700 bg-ink-850/80 p-3">
      <div className="flex items-start gap-3">
        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-ink-800">
          {track?.artwork || station.artwork ? (
            <img src={track?.artwork ?? station.artwork} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center text-ink-500">
              <IconRadio size={20} />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link href={`/station/?id=${encodeURIComponent(station.id)}`} className="truncate text-sm font-semibold hover:text-amber">
              {station.name}
            </Link>
            <Badge tone={live ? 'amber' : 'ink'}>{live ? 'on air' : station.state}</Badge>
          </div>
          <div className="mt-0.5 truncate text-xs text-ink-300">{station.genre ?? 'no genre'} · {station.listeners ?? 0} listening · {station.queueLength ?? 0} queued</div>
          <div className="mt-1 truncate text-xs text-ink-200">
            {track ? `${track.artist ? `${track.artist}, ` : ''}${track.title}` : 'nothing playing'}
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant={mine ? 'primary' : 'default'} onClick={() => play(station.id)}>
          {mine ? 'Playing' : 'Listen'}
        </Button>
        <Button size="sm" variant="ghost" disabled={!key} onClick={() => (live ? stationActions.stop(station.id) : stationActions.start(station.id)).catch(() => {})}>
          {live ? 'Stop' : 'Start'}
        </Button>
        <Button size="sm" variant="ghost" disabled={!key || !live} onClick={() => stationActions.skip(station.id).catch(() => {})}>
          Skip
        </Button>
        <Link href={`/station/?id=${encodeURIComponent(station.id)}`} className="ml-auto text-xs text-ink-300 hover:text-ink-100">
          Open →
        </Link>
      </div>
    </div>
  )
}

function CreateStation({ onCreated }) {
  const { refresh } = useRadio()
  const [form, setForm] = useState({ id: '', name: '', genre: '', source: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const id = form.id.trim() || form.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      const body = {
        id,
        name: form.name.trim() || id,
        genre: form.genre.trim() || undefined,
        autoStart: true
      }
      // Playlists are provider strings, not objects: `local:/music`,
      // `scsearch:late night jazz`, `audius:…`.
      if (form.source.trim()) body.playlists = form.source.trim().split(/\s*,\s*/).filter(Boolean)
      const station = await owner('/stations', { method: 'POST', body })
      setResult(station)
      setForm({ id: '', name: '', genre: '', source: '' })
      await refresh()
      onCreated?.(station)
    } catch (problem) {
      setError(problem.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyGate>
      <Panel title="New station" subtitle="The source is a provider prefix: local:/path, scsearch:, audius:…, or another station's mount.">
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Night Shift" required />
          </Field>
          <Field label="Id" hint="lowercase, used in the stream URL">
            <input className={inputClass} value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value })} placeholder="night-shift" />
          </Field>
          <Field label="Genre">
            <input className={inputClass} value={form.genre} onChange={(event) => setForm({ ...form, genre: event.target.value })} placeholder="ambient" />
          </Field>
          <Field label="Sources" hint="optional, comma separated. A station can also start empty and be filled from the queue">
            <input className={inputClass} value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })} placeholder="local:/music" />
          </Field>
          <div className="sm:col-span-2 flex items-center gap-2">
            <Button type="submit" variant="primary" disabled={busy || !form.name.trim()}>
              {busy ? 'Creating…' : 'Create station'}
            </Button>
            {error && <span className="text-xs text-rose">{error}</span>}
            {result && (
              <span className="text-xs text-lime">
                “{result.name}” is up , {' '}
                <Link href={`/station/?id=${encodeURIComponent(result.id)}`} className="underline">
                  open it
                </Link>
              </span>
            )}
          </div>
        </form>
      </Panel>
    </KeyGate>
  )
}

export default function StationsPage() {
  const { stations, ready, key, info } = useRadio()
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Stations</h1>
          <p className="mt-1 text-sm text-ink-300">
            {stations.length} station{stations.length === 1 ? '' : 's'} on this node.
            {!key && ' Enter the owner key below to change anything.'}
          </p>
        </div>
        <Link href="/ops/">
          <Button size="sm">Node & key</Button>
        </Link>
      </header>

      {!ready ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <div key={index} className="h-[128px] animate-pulse rounded-2xl bg-ink-800/60" />
          ))}
        </div>
      ) : stations.length === 0 ? (
        <Panel title="Nothing on air yet" subtitle="Create a station below. It starts playing as soon as it has a queue.">
          <p className="text-sm text-ink-300">
            A fresh node is in {info?.setup?.protected ? 'protected' : 'open'} mode. The owner key from the boot log unlocks creation; the
            new console stores it in this tab only.
          </p>
        </Panel>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {stations.map((station) => (
            <StationCard key={station.id} station={station} />
          ))}
        </div>
      )}

      <CreateStation />
    </div>
  )
}
