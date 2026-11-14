'use client'

/**
 * Overview: asymmetric broadcast console desk.
 * Featured live On-Air deck paired with a compact node telemetry ledger,
 * followed by the station directory and seam/node cards.
 */
import Link from 'next/link'
import { useEffect, useState } from 'react'

import { useRadio } from '../components/RadioProvider'
import { IconPlay, IconRadio, IconSliders, IconStop, IconWave } from '../components/icons'
import { Badge, Button, Empty, Meter, PageHeading, Panel, ago, formatBytes } from '../components/ui'
import { owner } from '../lib/api'
import type { StationSummary } from '../lib/types'

const greeting = (): string => {
  const hour = new Date().getHours()
  if (hour < 5) return 'Late shift'
  if (hour < 12) return 'Morning desk'
  if (hour < 18) return 'Afternoon desk'
  return 'Evening desk'
}

function FeaturedDeck({ station }: { station: StationSummary }) {
  const { tuned, playing, buffering, play, stop } = useRadio()
  const track = station.nowPlaying?.track
  const live = station.state === 'playing'
  const mine = tuned === station.id && (playing || buffering)
  const art = track?.artwork ?? station.artwork ?? null

  return (
    <section className="desk-panel flex flex-col justify-between p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-700 pb-4">
        <div className="flex items-center gap-2">
          <Badge tone={live ? 'amber' : 'ink'} dot={live}>
            {live ? 'ON AIR' : station.state}
          </Badge>
          {track?.cached && <Badge tone="lime">cached</Badge>}
          <span className="font-mono text-2xs text-ink-500">{station.genre || 'general'}</span>
        </div>
        <span className="numeric font-mono text-xs text-ink-500">
          {station.listeners ?? 0} listening · {station.queueLength ?? 0} queued
        </span>
      </div>

      <div className="my-5 flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="h-24 w-24 shrink-0 overflow-hidden rounded-lg border border-ink-700 bg-ink-900">
          {art ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={art} alt={`${station.name} artwork`} width={96} height={96} className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center text-ink-500">
              <IconRadio size={28} />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-semibold tracking-tight text-ink-100">{station.name}</h2>
          <p className="mt-1 truncate text-base text-ink-200">{track ? track.title : 'Ready for programme'}</p>
          <p className="mt-0.5 truncate text-sm text-ink-500">
            {track?.artist ?? 'Queue a track or playlist to start broadcasting'}
          </p>
          <div className="mt-3 max-w-md">
            <Meter value={live ? 1 : 0.12} tone={live ? 'amber' : 'ink'} label={`${station.name} signal`} />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-ink-700 pt-4">
        <Button variant={mine ? 'ghost' : 'primary'} size="md" onClick={() => (mine ? stop() : void play(station.id))}>
          {mine ? <IconStop size={14} /> : <IconPlay size={14} />}
          <span>{mine ? 'Stop listening' : 'Listen live'}</span>
        </Button>
        <Link href={`/station/?id=${encodeURIComponent(station.id)}`}>
          <Button variant="ghost" size="md">
            Station console
          </Button>
        </Link>
        <Link href={`/filters/?id=${encodeURIComponent(station.id)}`}>
          <Button variant="subtle" size="md">
            <IconSliders size={14} />
            <span>Filters</span>
          </Button>
        </Link>
        <Link href={`/seams/?id=${encodeURIComponent(station.id)}`}>
          <Button variant="subtle" size="md">
            <IconWave size={14} />
            <span>Seams</span>
          </Button>
        </Link>
      </div>
    </section>
  )
}

function StationTile({ station }: { station: StationSummary }) {
  const { tuned, playing, buffering, play, stop } = useRadio()
  const track = station.nowPlaying?.track
  const live = station.state === 'playing'
  const mine = tuned === station.id && (playing || buffering)
  const art = track?.artwork ?? station.artwork ?? null

  return (
    <article className="desk-panel flex flex-col justify-between p-4">
      <div className="flex items-start gap-3">
        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md border border-ink-700 bg-ink-900">
          {art ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={art} alt="" width={48} height={48} className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center text-ink-500">
              <IconRadio size={18} />
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
              {live ? 'live' : station.state}
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-ink-300">
            {track ? `${track.artist ? `${track.artist} · ` : ''}${track.title}` : (station.genre ?? 'Idle')}
          </p>
          <p className="numeric mt-1 font-mono text-2xs text-ink-500">
            {station.listeners ?? 0} listening · {station.queueLength ?? 0} queued
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-ink-700 pt-3">
        <Button size="sm" variant={mine ? 'primary' : 'ghost'} onClick={() => (mine ? stop() : void play(station.id))}>
          {mine ? <IconStop size={12} /> : <IconPlay size={12} />}
          <span>{mine ? 'Stop' : 'Listen'}</span>
        </Button>
        <Link
          href={`/station/?id=${encodeURIComponent(station.id)}`}
          className="text-xs font-medium text-ink-300 underline-offset-4 hover:text-ink-100 hover:underline"
        >
          Inspect
        </Link>
      </div>
    </article>
  )
}

export default function Overview() {
  const { info, stations, tuned, key, ownerName, ready } = useRadio()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [models, setModels] = useState<Record<string, any> | null>(null)

  useEffect(() => {
    if (!key) return
    owner('/models')
      .then(setModels)
      .catch(() => setModels(null))
  }, [key])

  const model = info?.models?.model ?? null
  const torch = models?.torch ?? null
  const auto = models?.auto ?? info?.automixModel ?? null
  const cache = info?.cache ?? null
  const playingCount = stations.filter((station) => station.state === 'playing').length
  const listeners = stations.reduce((total, station) => total + (station.listeners ?? 0), 0)
  const seams = models?.seams ?? 0

  const featured =
    stations.find((s) => s.id === tuned) ??
    stations.find((s) => s.state === 'playing') ??
    stations[0] ??
    null

  const cacheHitPct = cache ? `${Math.round((cache.hitRate ?? 0) * 100)}%` : 'Off'
  const audioBytes = cache?.audio?.enabled ? formatBytes(cache.audio.bytes ?? 0) : 'Disabled'

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow={
          info
            ? `${info.deployment?.serverless ? 'Serverless' : 'Streaming'} node · ${key && ownerName ? `owner ${ownerName}` : 'read-only'}`
            : 'Connecting'
        }
        title={greeting()}
        subtitle={
          info
            ? `Livy v${info.version} running ${stations.length} station${stations.length === 1 ? '' : 's'} across ${info.sources?.length ?? 0} audio sources.`
            : 'Contacting the Livy broadcast node...'
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/stations/">
              <Button variant="primary" size="sm">
                Manage stations
              </Button>
            </Link>
            <Link href="/search/">
              <Button variant="ghost" size="sm">
                Search music
              </Button>
            </Link>
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-8">
          {!ready ? (
            <div className="skeleton h-64 rounded-lg border border-ink-700" />
          ) : featured ? (
            <FeaturedDeck station={featured} />
          ) : (
            <Panel title="No stations configured" subtitle="Create your first station to start broadcasting.">
              <Empty
                icon={<IconRadio size={24} />}
                title="This node has no stations yet"
                action={
                  <Link href="/stations/">
                    <Button variant="primary" size="md">
                      Create first station
                    </Button>
                  </Link>
                }
              >
                Each station carries its own queue, DSP filter rack, audio cache integration, and automix policy.
              </Empty>
            </Panel>
          )}
        </div>

        <aside className="desk-panel flex flex-col justify-between p-5 lg:col-span-4">
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-ink-100">Node ledger</h2>
            <p className="mt-0.5 text-xs text-ink-500">Live runtime health and cache telemetry.</p>

            <dl className="mt-4 divide-y divide-ink-700 text-sm">
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-ink-500">Stations on air</dt>
                <dd className="numeric font-mono font-semibold text-amber">
                  {playingCount} / {stations.length}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-ink-500">Active listeners</dt>
                <dd className="numeric font-mono font-semibold text-ink-100">{listeners}</dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-ink-500">Cache hit rate</dt>
                <dd className="numeric font-mono font-semibold text-lime">{cacheHitPct}</dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-ink-500">Audio cache</dt>
                <dd className="numeric font-mono text-ink-100">
                  {audioBytes}
                  {cache?.audio?.entries ? ` (${cache.audio.entries})` : ''}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-ink-500">DSP engine</dt>
                <dd className="font-mono text-xs text-cyan">
                  {info?.fx?.engine ?? 'js'} {info?.fx?.version ? `v${info.fx.version}` : ''}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-ink-500">DJ policy</dt>
                <dd className="truncate font-mono text-xs text-ink-200">
                  {model?.name ? String(model.name).slice(0, 18) : 'heuristic'}
                </dd>
              </div>
            </dl>
          </div>

          <div className="mt-4 flex flex-wrap gap-2 border-t border-ink-700 pt-3">
            <Link href="/ops/">
              <Button size="sm" variant="ghost">
                Cache &amp; Node
              </Button>
            </Link>
            <Link href="/models/">
              <Button size="sm" variant="subtle">
                Models ({seams || 0})
              </Button>
            </Link>
          </div>
        </aside>
      </div>

      {stations.length > 1 && (
        <Panel
          title="All channels"
          subtitle="Switch live monitoring or jump directly to any station desk."
          actions={
            <Link href="/stations/">
              <Button size="sm" variant="ghost">
                All stations
              </Button>
            </Link>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {stations.map((station) => (
              <StationTile key={station.id} station={station} />
            ))}
          </div>
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Seam engine & automix"
          subtitle="Beat alignment, transition chooser, and background trainer."
          actions={
            <Link href="/seams/">
              <Button size="sm" variant="ghost">
                Open seams
              </Button>
            </Link>
          }
        >
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
            <dt className="text-ink-500">Auto-train</dt>
            <dd className="font-mono text-ink-100">
              {auto?.enabled ? (auto.running ? 'running' : `every ${auto.everySeams} seams`) : 'off'}
            </dd>
            <dt className="text-ink-500">Last run</dt>
            <dd className="font-mono text-ink-100">{auto?.lastRunAt ? ago(auto.lastRunAt) : 'never'}</dd>
            <dt className="text-ink-500">Trainer backend</dt>
            <dd className="font-mono text-ink-100">
              {torch?.available ? `PyTorch ${torch.torch}` : 'JavaScript'}
            </dd>
            <dt className="text-ink-500">Transitions</dt>
            <dd className="numeric font-mono text-ink-100">{info?.transitions?.length ?? 0} effects</dd>
          </dl>
        </Panel>

        <Panel
          title="Host environment"
          subtitle="Storage durability, device profile, and configured providers."
          actions={
            <Link href="/ops/">
              <Button size="sm" variant="ghost">
                Node ops
              </Button>
            </Link>
          }
        >
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
            <dt className="text-ink-500">Storage</dt>
            <dd className="font-mono text-ink-100">{info?.deployment?.storage ?? 'unknown'}</dd>
            <dt className="text-ink-500">Device</dt>
            <dd className="font-mono text-ink-100">
              {info?.device?.profile ?? 'server'} · {info?.device?.cpus ?? '?'} CPUs
            </dd>
            <dt className="text-ink-500">Language</dt>
            <dd className="font-mono text-ink-100">{info?.language ?? 'en'}</dd>
            <dt className="text-ink-500">Sources</dt>
            <dd className="truncate font-mono text-xs text-ink-200">
              {info?.sources?.slice(0, 6).join(', ') ?? 'none'}
              {(info?.sources?.length ?? 0) > 6 ? ` +${info!.sources!.length - 6}` : ''}
            </dd>
          </dl>
        </Panel>
      </div>
    </div>
  )
}
