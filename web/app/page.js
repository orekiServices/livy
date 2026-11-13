'use client'

/**
 * Overview — the node at a glance.
 *
 * What is on air, what the node is doing with it, and the three things that
 * are new enough to be worth surfacing: the scout hearing seams, the learned
 * policy deciding, and Forever waiting to be switched on.
 */
import Link from 'next/link'
import { useEffect, useState } from 'react'

import { useRadio } from '../components/RadioProvider.js'
import { IconPlay, IconRadio, IconSeams } from '../components/icons.js'
import { Badge, Button, Empty, Panel, Stat, ago, cx } from '../components/ui.js'
import { owner } from '../lib/api.js'

const greeting = () => {
  const hour = new Date().getHours()
  if (hour < 5) return 'Late night'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function OnAir({ station }) {
  const { tuned, playing, play } = useRadio()
  const track = station?.nowPlaying?.track
  const live = station?.state === 'playing'
  const mine = tuned === station?.id && playing
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-ink-700 bg-ink-850/80">
      <div className="flex items-center gap-3 p-3">
        <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-ink-800">
          {track?.artwork || station.artwork ? (
            <img src={track?.artwork ?? station.artwork} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center text-ink-500">
              <IconRadio size={22} />
            </div>
          )}
          {live && (
            <div className="absolute inset-x-0 bottom-0 flex items-end justify-center gap-0.5 bg-gradient-to-t from-ink-950/80 to-transparent pb-1 pt-3 live-bars">
              <i /> <i /> <i />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-ink-100">{station.name}</span>
            <Badge tone={live ? 'amber' : 'ink'}>{live ? 'on air' : station.state}</Badge>
          </div>
          <div className="mt-0.5 truncate text-xs text-ink-200">
            {track ? `${track.artist ? `${track.artist} — ` : ''}${track.title}` : station.genre ?? 'nothing playing'}
          </div>
          <div className="mt-1 flex items-center gap-3 text-[11px] text-ink-300">
            <span>{station.listeners ?? 0} listening</span>
            <span>{station.queueLength ?? 0} queued</span>
            <span className="truncate">{station.automix?.effect ?? '—'} · {Math.round((station.automix?.crossfadeMs ?? 0) / 100) / 10}s</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <Button size="sm" variant={mine ? 'primary' : 'default'} onClick={() => play(station.id)}>
            <IconPlay size={12} /> {mine ? 'Playing' : 'Listen'}
          </Button>
          <Link href={`/station/?id=${encodeURIComponent(station.id)}`} className="text-[11px] text-ink-300 hover:text-ink-100">
            Open →
          </Link>
        </div>
      </div>
    </div>
  )
}

export default function Overview() {
  const { info, stations, key, ownerName, ready } = useRadio()
  const [models, setModels] = useState(null)

  useEffect(() => {
    if (!key) return
    owner('/models')
      .then(setModels)
      .catch(() => setModels(null))
  }, [key])

  const model = info?.models?.model ?? null
  const torch = models?.torch ?? null
  const auto = models?.auto ?? info?.automixModel ?? null
  const playing = stations.filter((station) => station.state === 'playing').length
  const listeners = stations.reduce((total, station) => total + (station.listeners ?? 0), 0)
  const seams = models?.seams ?? 0
  const registry = models?.models ?? []

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{greeting()}.</h1>
          <p className="mt-1 text-sm text-ink-300">
            {info ? `${info.name} v${info.version} · ${info.deployment?.serverless ? 'serverless' : 'streaming'} · ${key && ownerName ? `owner ${ownerName}` : 'read-only until an owner key is entered'}` : 'Looking for the node…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/stations/">
            <Button variant="primary" size="sm">Stations</Button>
          </Link>
          <Link href="/models/">
            <Button size="sm">Training</Button>
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Stations" value={stations.length} hint={`${playing} on air`} accent="amber" />
        <Stat label="Listeners" value={listeners} hint="across the node" />
        <Stat label="Seams logged" value={seams || '—'} hint={auto?.enabled ? `auto-train every ${auto.everySeams}` : 'training off'} accent="cyan" />
        <Stat label="Trainer" value={torch?.available ? 'PyTorch' : 'JS'} hint={torch?.available ? `${torch.torch} · ${torch.device}` : torch ? 'torch not installed' : 'no key'} accent={torch?.available ? 'lime' : 'ink'} />
      </div>

      <Panel
        title="On air"
        subtitle={stations.length ? 'Every station on this node, right now.' : undefined}
        actions={
          <Link href="/stations/">
            <Button size="sm" variant="ghost">All stations →</Button>
          </Link>
        }
      >
        {!ready ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="h-[88px] animate-pulse rounded-2xl bg-ink-800/60" />
            <div className="h-[88px] animate-pulse rounded-2xl bg-ink-800/60" />
          </div>
        ) : stations.length === 0 ? (
          <Empty icon={<IconRadio size={22} />}>
            <p className="text-ink-200">This node has no stations yet.</p>
            <p className="mt-1 text-xs">A station is a queue, a filter chain and a learned policy — create one and it starts playing.</p>
            <Link href="/stations/" className="mt-3 inline-block">
              <Button variant="primary" size="sm">Create the first station</Button>
            </Link>
          </Empty>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {stations.map((station) => (
              <OnAir key={station.id} station={station} />
            ))}
          </div>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="The seam machine"
          subtitle="What the scout hears, and who decides the track change."
          actions={<Link href="/seams/"><Button size="sm" variant="ghost">Seams →</Button></Link>}
        >
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Policy" value={model ? model.name?.slice(0, 14) ?? 'active' : 'heuristic'} hint={model ? `${Math.round((model.parameters ?? 0) / 1) } params` : 'no model trained yet'} />
            <Stat label="Candidates" value={registry.length || '—'} hint="in the registry" />
            <Stat label="Auto-train" value={auto?.enabled ? 'on' : 'off'} hint={auto?.running ? 'running now' : `${auto?.seams ?? 0} seams`} accent={auto?.enabled ? 'lime' : 'ink'} />
            <Stat label="Last run" value={auto?.lastRunAt ? ago(auto.lastRunAt) : 'never'} hint={auto?.last?.accuracy ? `${Math.round(auto.last.accuracy * 100)}% held-out` : '—'} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/seams/"><Button size="sm"><IconSeams size={13} /> Scout & Forever</Button></Link>
            <Link href="/filters/"><Button size="sm" variant="cyan">Radio filters</Button></Link>
            <Link href="/models/"><Button size="sm">Train a model</Button></Link>
          </div>
        </Panel>

        <Panel title="This node" subtitle="Engine, sources and where it keeps its state.">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-ink-300">DSP</dt>
            <dd className="truncate text-ink-100">{info?.fx?.engine ?? '—'} {info?.fx?.version ? `v${info.fx.version}` : ''}</dd>
            <dt className="text-ink-300">Storage</dt>
            <dd className="truncate text-ink-100">{info?.deployment?.storage ?? '—'}</dd>
            <dt className="text-ink-300">Device</dt>
            <dd className="truncate text-ink-100">{info?.device?.profile ?? '—'} · {info?.device?.cpus ?? '—'} cpus</dd>
            <dt className="text-ink-300">Sources</dt>
            <dd className="truncate text-ink-100">{info?.sources?.join(', ') ?? '—'}</dd>
            <dt className="text-ink-300">Lang</dt>
            <dd className="truncate text-ink-100">{info?.language ?? '—'}</dd>
            <dt className="text-ink-300">Transitions</dt>
            <dd className="truncate text-ink-100">{info?.transitions?.length ?? 0} built in</dd>
          </dl>
          <div className="mt-3 flex items-center gap-2 text-xs text-ink-300">
            <Badge tone={torch?.available ? 'lime' : 'ink'}>
              {torch?.available ? `torch ${torch.torch}` : 'torch optional'}
            </Badge>
            {torch && !torch.available && <span className="truncate">{torch.reason}</span>}
          </div>
        </Panel>
      </div>
    </div>
  )
}
