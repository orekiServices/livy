'use client'

/**
 * The frame: a rail of destinations, the page, and the player that follows you
 * around. The <audio> element lives in RadioProvider so a page change never
 * interrupts the stream, the same reason a radio has a knob and not a page.
 *
 * Layout is a single fixed rail on desktop and a scrolling chip strip on a
 * phone. The rail is grouped by what the page is *for* — what is on air, what
 * the station knows, what the node is doing — because eight flat items is a
 * list, and three groups is a map.
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
  IconLyrics,
  IconRadio,
  IconSeams,
  IconSearch,
  IconSkip,
  IconVolume
} from './icons.js'
import { Badge, Button, cx } from './ui.js'

const GROUPS = [
  {
    label: 'On air',
    items: [
      { href: '/', label: 'Overview', icon: IconDashboard, exact: true },
      { href: '/stations/', label: 'Stations', icon: IconRadio },
      { href: '/search/', label: 'Search', icon: IconSearch },
      { href: '/lyrics/', label: 'Words', icon: IconLyrics }
    ]
  },
  {
    label: 'The engine',
    items: [
      { href: '/seams/', label: 'Seams & Forever', icon: IconSeams },
      { href: '/filters/', label: 'Radio filters', icon: IconFilters },
      { href: '/models/', label: 'Training', icon: IconModels }
    ]
  },
  {
    label: 'The node',
    items: [
      { href: '/ops/', label: 'Ops', short: 'Ops', icon: IconOps },
      { href: '/owner/', label: 'Owner desk', icon: IconKey }
    ]
  }
]

const NAV = GROUPS.flatMap((group) => group.items)

function NavLink({ item, active }) {
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition',
        active ? 'bg-ink-800 text-ink-100' : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100'
      )}
    >
      <Icon size={16} className={active ? 'text-amber' : 'text-ink-500 group-hover:text-ink-300'} />
      <span className="truncate">{item.label}</span>
      {active && <span aria-hidden="true" className="absolute -left-2 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-amber" />}
    </Link>
  )
}

function PlayerDock() {
  const { stations, tuned, playing, buffering, playerError, toggle, reconnect, volume, changeVolume, stationActions, key } = useRadio()
  const station = stations.find((row) => row.id === tuned) ?? null
  const track = station?.nowPlaying?.track ?? null
  if (!station) return null

  const live = station.state === 'playing'

  return (
    <div className="sticky bottom-0 z-30 border-t border-hairline bg-ink-900/95 backdrop-blur-md">
      <div aria-label="Player" role="region" className="mx-auto flex max-w-[1400px] items-center gap-3 px-3 py-2.5 md:px-6">
        <button
          type="button"
          onClick={toggle}
          className={cx(
            'grid h-10 w-10 shrink-0 place-items-center rounded-full transition hover:brightness-110',
            playerError ? 'bg-rose text-ink-950' : 'bg-amber text-ink-950',
            buffering && playing ? 'animate-pulse motion-reduce:animate-none' : ''
          )}
          aria-label={playerError ? 'Retry the stream' : playing ? 'Pause' : 'Play'}
          title={playerError ?? undefined}
        >
          {playing && !playerError ? <IconPause size={17} /> : <IconPlay size={17} />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium text-ink-100">
              {track ? `${track.artist ? `${track.artist} · ` : ''}${track.title}` : station.name}
            </span>
            {live && <span className="live-bars shrink-0" aria-hidden="true"><i /><i /><i /></span>}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-2xs text-ink-300">
            <span className={cx('h-1.5 w-1.5 rounded-full', live ? 'bg-amber pulse-dot' : 'bg-ink-500')} aria-hidden="true" />
            <span className="truncate">{station.name}</span>
            <span aria-hidden="true">/</span>
            <span className="numeric">{station.listeners ?? 0}</span>
            <span className="hidden sm:inline">listening</span>
            {playerError ? (
              <button type="button" onClick={reconnect} className="truncate text-rose underline" title={playerError}>
                stream lost, retry
              </button>
            ) : buffering && playing ? (
              <span className="text-cyan">connecting…</span>
            ) : null}
          </div>
        </div>

        <div className="hidden items-center gap-2 md:flex">
          <IconVolume size={15} className="text-ink-300" />
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            style={{ '--fill': `${Math.round(volume * 100)}%` }}
            onChange={(event) => changeVolume(Number(event.target.value))}
            className="w-24 accent-amber"
            aria-label="Volume"
          />
        </div>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => key && stationActions.skip(station.id).catch(() => {})}
          disabled={!key}
          title={key ? 'Skip to the next track' : 'Skip needs an owner key'}
          aria-label="Skip track"
        >
          <IconSkip size={14} />
        </Button>

        <Link
          href={`/station/?id=${encodeURIComponent(station.id)}`}
          className="hidden shrink-0 rounded-lg border border-ink-600 px-2.5 py-1 text-xs text-ink-200 transition hover:border-ink-500 hover:text-ink-100 sm:block"
        >
          Station
        </Link>
      </div>
    </div>
  )
}

function NodeChip({ info, key, ownerName }) {
  const serverless = info?.deployment?.serverless
  return (
    <div className="surface px-3 py-2.5 text-2xs text-ink-300">
      <div className="flex items-center justify-between gap-2">
        <span className="label">Node</span>
        <Badge tone={serverless ? 'rose' : 'lime'} dot>
          {serverless ? 'serverless' : 'live'}
        </Badge>
      </div>
      <div className="numeric mt-2 font-mono text-xs text-ink-200">v{info?.version ?? '–'}</div>
      <div className="mt-1 leading-relaxed">
        {info?.sources?.length ?? 0} sources · {info?.stations ?? 0} stations
      </div>
      <div className="mt-2 flex items-center gap-1.5 border-t border-rule pt-2">
        <IconKey size={12} className={key && ownerName ? 'text-lime' : 'text-ink-500'} />
        <span className="truncate">{key && ownerName ? `owner ${ownerName}` : 'read-only'}</span>
      </div>
    </div>
  )
}

/** The strip above every page: what node am I looking at, in one line. */
function TopStrip({ info, problem, ready }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3 border-b border-hairline pb-2.5 text-2xs text-ink-300 md:mb-5">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', problem ? 'bg-rose' : ready ? 'bg-lime' : 'bg-ink-500')} aria-hidden="true" />
        <span className="truncate font-mono text-ink-200">{info?.name ?? 'livy'}</span>
        <span className="hidden sm:inline">·</span>
        <span className="hidden truncate sm:inline">{info?.deployment?.storage === 'disk' ? 'disk storage' : 'ephemeral'}</span>
        {problem && <span className="truncate text-rose">· {problem}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="numeric hidden font-mono md:inline">
          {info?.fx?.engine ?? '–'} dsp
        </span>
        <span className="hidden md:inline">·</span>
        <span className="numeric font-mono">{info?.stations ?? 0} st</span>
      </div>
    </div>
  )
}

export default function Shell({ children }) {
  const pathname = usePathname()
  const { info, problem, ready, key, ownerName } = useRadio()

  const active = (item) =>
    item.exact ? pathname === '/' : pathname === item.href || pathname.startsWith(item.href.replace(/\/$/, ''))

  return (
    <div className="min-h-screen">
      {/* The first thing a keyboard reaches is the thing after the rail. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-amber focus:px-3 focus:py-1.5 focus:text-sm focus:font-medium focus:text-ink-950"
      >
        Skip to content
      </a>

      <div className="mx-auto flex w-full max-w-[1400px] gap-6 px-3 md:px-6">
        <aside className="hidden shrink-0 py-5 md:block md:w-56 lg:w-60">
          <div className="md:sticky md:top-5 md:flex md:max-h-[calc(100vh-2.5rem)] md:flex-col">
            <Link href="/" className="flex items-center gap-2.5 px-2">
              <span className="grid h-9 w-9 place-items-center rounded-xl border border-amber/40 bg-amber/10 text-sm font-bold text-amber">
                L
              </span>
              <span>
                <span className="block text-sm font-semibold leading-tight tracking-wide">Livy</span>
                <span className="block text-2xs text-ink-300">node console</span>
              </span>
            </Link>

            <nav aria-label="Console" className="mt-5 space-y-4">
              {GROUPS.map((group) => (
                <div key={group.label}>
                  <p className="label px-2.5 pb-1.5">{group.label}</p>
                  <div className="space-y-0.5">
                    {group.items.map((item) => (
                      <NavLink key={item.href} item={item} active={active(item)} />
                    ))}
                  </div>
                </div>
              ))}
            </nav>

            <div className="mt-5">
              <NodeChip info={info} key={key} ownerName={ownerName} />
            </div>
          </div>
        </aside>

        <div className="min-w-0 flex-1 pb-4">
          {/* On a phone the rail is a horizontal strip; the brand stays. */}
          <div className="flex items-center justify-between gap-3 py-3 md:hidden">
            <Link href="/" className="flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg border border-amber/40 bg-amber/10 text-xs font-bold text-amber">L</span>
              <span className="text-sm font-semibold tracking-wide">Livy</span>
            </Link>
            <Badge tone={info?.deployment?.serverless ? 'rose' : 'lime'} dot>
              {info?.deployment?.serverless ? 'serverless' : 'live'}
            </Badge>
          </div>
          <nav aria-label="Console" className="-mx-3 flex gap-1 overflow-x-auto px-3 pb-2 md:hidden">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active(item) ? 'page' : undefined}
                className={cx(
                  'shrink-0 rounded-full border px-2.5 py-1 text-xs transition',
                  active(item)
                    ? 'border-amber/50 bg-amber/15 text-amber'
                    : 'border-ink-700 bg-ink-850 text-ink-300'
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="hidden md:block">
            <TopStrip info={info} problem={problem} ready={ready} />
          </div>

          <main id="main" className="pb-6">
            {problem && (
              <div role="alert" className="mb-4 rounded-xl border border-rose/40 bg-rose/10 px-3 py-2 text-sm text-rose">
                Lost the node: {problem}. {info ? 'Retrying…' : 'Is this console served by Livy?'}
              </div>
            )}
            {children}
          </main>
        </div>
      </div>

      <footer>
        <PlayerDock />
      </footer>
    </div>
  )
}
