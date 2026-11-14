'use client'

/**
 * Stations directory and creation desk.
 */
import Link from 'next/link'
import { useState, type FormEvent } from 'react'

import { useRadio } from '../../components/RadioProvider'
import { IconPlay, IconRadio, IconStop } from '../../components/icons'
import { Badge, Button, Field, KeyGate, PageHeading, Panel, inputClass } from '../../components/ui'
import { owner } from '../../lib/api'
import type { StationSummary } from '../../lib/types'

function StationCard({ station }: { station: StationSummary }) {
  const { play, stop, tuned, playing, buffering, stationActions, key, refresh } = useRadio()
  const [busy, setBusy] = useState(false)
  const track = station.nowPlaying?.track
  const live = station.state === 'playing'
  const mine = tuned === station.id && (playing || buffering)
  const art = track?.artwork ?? station.artwork ?? null

  const togglePower = async () => {
    setBusy(true)
    try {
      await (live ? stationActions.stop(station.id) : stationActions.start(station.id))
      await refresh()
    } catch {
      /* handled by refresh state */
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="desk-panel flex flex-col justify-between p-4">
      <div className="flex items-start gap-3">
        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-md border border-ink-700 bg-ink-900">
          {art ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={art} alt="" width={56} height={56} className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center text-ink-500">
              <IconRadio size={20} />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <Link
              href={`/station/?id=${encodeURIComponent(station.id)}`}
              className="truncate text-sm font-semibold text-ink-100 hover:text-amber"
            >
              {station.name}
            </Link>
            <Badge tone={live ? 'amber' : 'ink'} dot={live}>
              {live ? 'on air' : station.state}
            </Badge>
          </div>
          <div className="numeric mt-0.5 truncate font-mono text-2xs text-ink-500">
            {station.genre ?? 'general'} · {station.listeners ?? 0} listening · {station.queueLength ?? 0} queued
          </div>
          <div className="mt-1 truncate text-xs text-ink-200">
            {track ? `${track.artist ? `${track.artist} · ` : ''}${track.title}` : 'Nothing playing'}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-ink-700 pt-3">
        <Button size="sm" variant={mine ? 'primary' : 'ghost'} onClick={() => (mine ? stop() : void play(station.id))}>
          {mine ? <IconStop size={12} /> : <IconPlay size={12} />}
          <span>{mine ? 'Stop' : 'Listen'}</span>
        </Button>
        <Button size="sm" variant="ghost" disabled={!key || busy} onClick={() => void togglePower()}>
          {live ? 'Off air' : 'Start'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!key || !live}
          onClick={() => void stationActions.skip(station.id).then(refresh).catch(() => {})}
        >
          Skip
        </Button>
        <Link
          href={`/station/?id=${encodeURIComponent(station.id)}`}
          className="ml-auto text-xs font-medium text-ink-300 underline-offset-4 hover:text-ink-100 hover:underline"
        >
          Open desk
        </Link>
      </div>
    </article>
  )
}

function CreateStation({ onCreated }: { onCreated?: (station: StationSummary) => void }) {
  const { refresh } = useRadio()
  const [form, setForm] = useState({ id: '', name: '', genre: '', source: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<StationSummary | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const id =
        form.id.trim() ||
        form.name
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
      const body: Record<string, unknown> = {
        id,
        name: form.name.trim() || id,
        genre: form.genre.trim() || undefined,
        autoStart: true
      }
      if (form.source.trim()) body.playlists = form.source.trim().split(/\s*,\s*/).filter(Boolean)
      const station = await owner<StationSummary>('/stations', { method: 'POST', body })
      setResult(station)
      setForm({ id: '', name: '', genre: '', source: '' })
      await refresh()
      onCreated?.(station)
    } catch (problem) {
      setError((problem as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyGate title="Unlock to create stations">
      <Panel
        title="New station"
        subtitle="Provide a source prefix (local:/path, scsearch:query, audius:query) or start empty and queue tracks later."
      >
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input
              className={inputClass}
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Night Shift"
              required
            />
          </Field>
          <Field label="Id" hint="Lowercase slug used in /stream/<id>.mp3">
            <input
              className={inputClass}
              value={form.id}
              onChange={(event) => setForm({ ...form, id: event.target.value })}
              placeholder="night-shift"
            />
          </Field>
          <Field label="Genre">
            <input
              className={inputClass}
              value={form.genre}
              onChange={(event) => setForm({ ...form, genre: event.target.value })}
              placeholder="ambient"
            />
          </Field>
          <Field label="Playlists" hint="Optional, comma separated provider queries">
            <input
              className={inputClass}
              value={form.source}
              onChange={(event) => setForm({ ...form, source: event.target.value })}
              placeholder="local:/music"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" variant="primary" size="md" disabled={busy || !form.name.trim()}>
              {busy ? 'Creating...' : 'Create station'}
            </Button>
            {error && <span className="text-xs font-medium text-rose">{error}</span>}
            {result && (
              <span className="text-xs font-medium text-lime">
                Created {result.name}.{' '}
                <Link href={`/station/?id=${encodeURIComponent(result.id)}`} className="underline">
                  Open station desk
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
    <div className="space-y-5">
      <PageHeading
        eyebrow="Broadcast"
        title="Stations"
        subtitle={`${stations.length} station${stations.length === 1 ? '' : 's'} configured on this node.${
          key ? '' : ' Unlock below to create or control channels.'
        }`}
        actions={
          <Link href="/ops/">
            <Button size="sm" variant="ghost">
              Node &amp; cache
            </Button>
          </Link>
        }
      />

      {!ready ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <div key={index} className="skeleton h-36 rounded-lg border border-ink-700" />
          ))}
        </div>
      ) : stations.length === 0 ? (
        <Panel title="No stations on air" subtitle="Create a channel below to start streaming.">
          <p className="text-sm text-ink-300">
            This node is running in {info?.setup?.protected ? 'protected' : 'open'} mode. Unlock with the owner key to
            create your first station.
          </p>
        </Panel>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {stations.map((station) => (
            <StationCard key={station.id} station={station} />
          ))}
        </div>
      )}

      <CreateStation />
    </div>
  )
}
