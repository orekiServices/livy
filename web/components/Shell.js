'use client'

/**
 * The frame: a rail of destinations, the page, and the player that follows you
 * around. The <audio> element lives here so a page change never interrupts the
 * stream — the same reason a radio has a knob and not a page.
 */
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { useRadio } from './RadioProvider.js'
import {
  IconDashboard,
  IconFilters,
  IconKey,
  IconModels,
  IconOps,
  IconPause,
  IconPlay,
  IconRadio,
  IconSeams,
  IconSearch,
  IconSkip,
  IconVolume
} from './icons.js'
import { Badge, Button, cx } from './ui.js'

const NAV = [
  { href: '/', label: 'Overview', icon: IconDashboard, exact: true },
  { href: '/stations/', label: 'Stations', icon: IconRadio },
  { href: '/search/', label: 'Search', icon: IconSearch },
  { href: '/seams/', label: 'Seams & Forever', icon: IconSeams },
  { href: '/filters/', label: 'Radio filters', icon: IconFilters },
  { href: '/models/', label: 'Training', icon: IconModels },
  { href: '/ops/', label: 'Node', icon: IconOps }
]

function NavLink({ item, active }) {
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      className={cx(
        'group flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition',
        active ? 'bg-ink-800 text-ink-100' : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100'
      )}
    >
      <Icon size={17} className={active ? 'text-amber' : 'text-ink-500 group-hover:text-ink-300'} />
      <span className="truncate">{item.label}</span>
      {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-amber" />}
    </Link>
  )
}

function PlayerBar() {
  const { stations, tuned, playing, toggle, volume, changeVolume, stationActions, key } = useRadio()
  const station = stations.find((row) => row.id === tuned) ?? null
  const track = station?.nowPlaying?.track ?? null
  if (!station) return null

  return (
    <div className="sticky bottom-0 z-20 border-t border-ink-700 bg-ink-900/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5">
        <button
          type="button"
          onClick={toggle}
          className="grid h-9 w-9 place-items-center rounded-full bg-amber text-ink-950 transition hover:brightness-110"
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <IconPause size={16} /> : <IconPlay size={16} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-ink-100">
            {track ? `${track.artist ?? ''}${track.artist ? ' — ' : ''}${track.title ?? ''}` : station.name}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-ink-300">
            <span className={cx('h-1.5 w-1.5 rounded-full', station.state === 'playing' ? 'bg-amber pulse-dot' : 'bg-ink-500')} />
            <span className="truncate">{station.name}</span>
            <span>·</span>
            <span>{station.listeners ?? 0} listening</span>
          </div>
        </div>
        <div className="hidden items-center gap-2 sm:flex">
          <IconVolume size={15} className="text-ink-300" />
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={(event) => changeVolume(Number(event.target.value))}
            className="w-24 accent-amber"
            aria-label="Volume"
          />
        </div>
        <Button size="sm" variant="ghost" onClick={() => key && stationActions.skip(station.id).catch(() => {})} disabled={!key} title="Skip (owner key)">
          <IconSkip size={14} />
        </Button>
        <Link href={`/station/?id=${encodeURIComponent(station.id)}`} className="hidden text-xs text-ink-300 hover:text-ink-100 sm:block">
          Station →
        </Link>
      </div>
    </div>
  )
}

export default function Shell({ children }) {
  const pathname = usePathname()
  const { info, problem, key, ownerName } = useRadio()

  const active = (item) =>
    item.exact ? pathname === '/' : pathname === item.href || pathname.startsWith(item.href.replace(/\/$/, ''))

  return (
    <div className="flex min-h-screen flex-col">
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-3 py-4 md:flex-row md:gap-6 md:px-5">
        <aside className="md:w-56 md:shrink-0">
          <Link href="/" className="flex items-center gap-2.5 px-2 py-1">
            <span className="grid h-8 w-8 place-items-center rounded-xl border border-amber/40 bg-amber/10 text-sm font-bold text-amber">L</span>
            <span>
              <span className="block text-sm font-semibold tracking-wide">Livy</span>
              <span className="block text-[11px] text-ink-300">node console</span>
            </span>
          </Link>
          <nav className="mt-3 flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
            {NAV.map((item) => (
              <NavLink key={item.href} item={item} active={active(item)} />
            ))}
          </nav>
          <div className="mt-4 hidden rounded-xl border border-ink-700 bg-ink-850/60 p-3 text-[11px] text-ink-300 md:block">
            <div className="flex items-center justify-between gap-2">
              <span className="uppercase tracking-wider">Node</span>
              <Badge tone={info?.deployment?.serverless ? 'rose' : 'lime'}>{info?.deployment?.serverless ? 'serverless' : 'live'}</Badge>
            </div>
            <div className="mt-2 font-mono text-ink-200">v{info?.version ?? '—'}</div>
            <div className="mt-1 truncate">{info?.sources?.length ?? 0} sources · {info?.stations ?? 0} stations</div>
            <div className="mt-2 flex items-center gap-1.5">
              <IconKey size={12} className={key && ownerName ? 'text-lime' : 'text-ink-500'} />
              <span>{key && ownerName ? `owner: ${ownerName}` : 'no owner key'}</span>
            </div>
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          {problem && (
            <div className="mb-3 rounded-xl border border-rose/40 bg-rose/10 px-3 py-2 text-sm text-rose">
              Lost the node: {problem}. {info ? 'Retrying…' : 'Is this console served by Livy?'}
            </div>
          )}
          {children}
        </main>
      </div>
      <PlayerBar />
    </div>
  )
}
