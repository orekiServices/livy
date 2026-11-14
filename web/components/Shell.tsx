'use client'

/**
 * Broadcast console shell:
 * - Desktop (lg+): 236px left studio rail grouped by workflow
 * - Phone / Tablet (< lg): sticky top broadcast bar + labeled Menu drawer
 *   (Escape to close, backdrop click, focus restoration, 44px touch targets)
 * - Bottom persistent transport dock with hardware ON AIR tally, live track
 *   metadata, volume fader, and actionable stream error diagnostics.
 */
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'

import type { NodeInfo, ThemeMode } from '../lib/types'
import { useRadio } from './RadioProvider'
import {
  IconBrain,
  IconDial,
  IconKey,
  IconLyrics,
  IconMenu,
  IconMoon,
  IconMute,
  IconPlay,
  IconRadio,
  IconRefresh,
  IconSearch,
  IconServer,
  IconSliders,
  IconStations,
  IconStop,
  IconSun,
  IconVolume,
  IconWave,
  IconX,
  type IconProps
} from './icons'
import { cx } from './ui'

interface NavDestination {
  href: string
  label: string
  icon: ComponentType<IconProps>
}

const GROUPS: Array<{ label: string; items: NavDestination[] }> = [
  {
    label: 'Broadcast',
    items: [
      { href: '/', label: 'Overview', icon: IconRadio },
      { href: '/station/', label: 'Station', icon: IconDial },
      { href: '/stations/', label: 'Stations', icon: IconStations },
      { href: '/search/', label: 'Search', icon: IconSearch }
    ]
  },
  {
    label: 'Audio desk',
    items: [
      { href: '/filters/', label: 'Filters', icon: IconSliders },
      { href: '/seams/', label: 'Seams', icon: IconWave },
      { href: '/lyrics/', label: 'Lyrics', icon: IconLyrics }
    ]
  },
  {
    label: 'System',
    items: [
      { href: '/models/', label: 'Models', icon: IconBrain },
      { href: '/ops/', label: 'Node', icon: IconServer },
      { href: '/owner/', label: 'Owner', icon: IconKey }
    ]
  }
]

const isActive = (pathname: string | null, href: string): boolean => {
  const clean = (pathname || '/').replace(/\/+$/, '') || '/'
  const target = href.replace(/\/+$/, '') || '/'
  return clean === target
}

function NavItem({
  item,
  active,
  onNavigate
}: {
  item: NavDestination
  active: boolean
  onNavigate?: () => void
}) {
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex min-h-[40px] items-center gap-2.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors duration-150',
        active
          ? 'border-amber/40 bg-amber/12 text-ink-100'
          : 'border-transparent text-ink-300 hover:bg-ink-800 hover:text-ink-100'
      )}
    >
      <Icon size={16} className={active ? 'text-amber' : 'text-ink-500'} />
      <span className="truncate">{item.label}</span>
    </Link>
  )
}

function ThemeToggle({
  theme,
  toggleTheme,
  compact = false
}: {
  theme: ThemeMode
  toggleTheme: () => void
  compact?: boolean
}) {
  const isDark = theme === 'dark'
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? 'Switch to Daylight theme' : 'Switch to Studio dark theme'}
      className={cx(
        'inline-flex min-h-[40px] cursor-pointer items-center justify-center gap-2 rounded-md border border-ink-700 bg-ink-900 text-xs font-medium text-ink-200 transition-colors hover:border-ink-600 hover:text-ink-100',
        compact ? 'min-w-[44px] px-2.5' : 'w-full px-3 py-2'
      )}
    >
      {isDark ? <IconSun size={15} className="text-amber" /> : <IconMoon size={15} className="text-amber" />}
      {!compact && <span>{isDark ? 'Daylight theme' : 'Studio dark'}</span>}
    </button>
  )
}

function NodeStatus({
  info,
  hasKey,
  ownerName,
  nodeError
}: {
  info: NodeInfo | null
  hasKey: boolean
  ownerName: string | null
  nodeError: string | null
}) {
  const label = nodeError
    ? 'Offline'
    : hasKey && ownerName
      ? ownerName
      : info?.setup?.protected === false
        ? 'Open node'
        : 'Read-only'
  const tally = nodeError ? 'bg-rose' : hasKey && ownerName ? 'bg-lime' : 'bg-amber'
  return (
    <Link
      href="/ops/"
      className="flex min-h-[44px] items-center justify-between gap-2 rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-xs transition-colors hover:border-ink-600"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className={cx('tally-bar', tally)} aria-hidden="true" />
        <span className="truncate font-medium text-ink-100">{label}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-2xs text-ink-500">
        {info?.version ? `v${info.version}` : ''}
        <IconKey size={13} className={hasKey && ownerName ? 'text-lime' : 'text-ink-500'} />
      </span>
    </Link>
  )
}

function PlayerDock() {
  const {
    stations,
    tunedStation,
    playing,
    buffering,
    volume,
    muted,
    streamError,
    streamErrorCode,
    togglePlay,
    retryStream,
    clearStreamError,
    setVolume,
    toggleMute
  } = useRadio()

  const shown = tunedStation ?? stations[0] ?? null
  const track = shown?.nowPlaying?.track
  const title = track?.title ?? shown?.name ?? 'No station on air'
  const artist = track?.artist ?? (shown ? (shown.genre ?? shown.id) : 'Create a station to begin')
  const live = playing && !buffering
  const isReconnecting = streamErrorCode === 'reconnecting'
  const hasHardError = Boolean(streamError && !isReconnecting)

  return (
    <div
      role="region"
      aria-label="Broadcast transport"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-700 bg-ink-850 pb-[env(safe-area-inset-bottom)]"
    >
      {hasHardError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-rose/40 bg-rose/12 px-4 py-2 text-xs text-ink-100 lg:pl-[252px]"
        >
          <span className="flex items-center gap-2 font-medium text-rose">
            <span className="tally-bar bg-rose" aria-hidden="true" />
            <span>{streamError}</span>
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={retryStream}
              className="inline-flex min-h-[32px] cursor-pointer items-center gap-1.5 rounded border border-ink-600 bg-ink-900 px-2.5 py-1 text-2xs font-medium text-ink-100 hover:bg-ink-800"
            >
              <IconRefresh size={12} />
              <span>Retry</span>
            </button>
            <button
              type="button"
              onClick={clearStreamError}
              aria-label="Dismiss stream error"
              className="inline-flex min-h-[32px] min-w-[32px] cursor-pointer items-center justify-center rounded border border-transparent text-ink-300 hover:bg-ink-800 hover:text-ink-100"
            >
              <IconX size={13} />
            </button>
          </div>
        </div>
      )}

      <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-3 px-3 sm:px-5 lg:pl-[252px]">
        <button
          type="button"
          onClick={togglePlay}
          disabled={!shown}
          aria-label={playing || buffering ? 'Stop broadcast stream' : 'Play broadcast stream'}
          className={cx(
            'grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-full border transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40',
            playing || buffering
              ? 'border-amber bg-amber text-amber-ink'
              : 'border-ink-600 bg-ink-900 text-ink-100 hover:border-amber hover:text-amber'
          )}
        >
          {playing || buffering ? <IconStop size={15} /> : <IconPlay size={16} className="translate-x-[1px]" />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cx('tally-bar', live ? 'bg-amber' : buffering ? 'bg-cyan' : 'bg-ink-600')}
              aria-hidden="true"
            />
            <span className="truncate text-sm font-semibold text-ink-100">{title}</span>
            {shown && (
              <Link
                href={`/station/?id=${encodeURIComponent(shown.id)}`}
                className="hidden shrink-0 rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 font-mono text-2xs text-ink-300 hover:border-ink-600 hover:text-ink-100 sm:inline"
              >
                {shown.name}
              </Link>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2 truncate text-xs text-ink-500">
            <span className="truncate">{artist}</span>
            {buffering && (
              <span className="shrink-0 font-medium text-cyan">
                {isReconnecting ? streamError : 'Connecting...'}
              </span>
            )}
            {live && <span className="shrink-0 font-mono text-2xs font-medium text-amber">ON AIR</span>}
          </div>
        </div>

        <div className="hidden items-center gap-2.5 sm:flex">
          <button
            type="button"
            onClick={toggleMute}
            aria-label={muted || volume === 0 ? 'Unmute audio' : 'Mute audio'}
            className="grid h-10 w-10 cursor-pointer place-items-center rounded-md border border-transparent text-ink-300 hover:border-ink-700 hover:bg-ink-900 hover:text-ink-100"
          >
            {muted || volume === 0 ? <IconMute size={16} /> : <IconVolume size={16} />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={(event) => setVolume(event.target.value)}
            aria-label="Stream volume"
            className="w-24"
          />
        </div>
      </div>
    </div>
  )
}

export default function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { info, key, ownerName, nodeError, theme, toggleTheme } = useRadio()
  const [drawerPath, setDrawerPath] = useState<string | null>(null)
  const drawerOpen = drawerPath !== null && drawerPath === pathname
  const menuBtnRef = useRef<HTMLButtonElement | null>(null)
  const closeBtnRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!drawerOpen) return
    closeBtnRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawerPath(null)
        menuBtnRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  const closeDrawer = () => {
    setDrawerPath(null)
    menuBtnRef.current?.focus()
  }

  return (
    <div className="flex min-h-dvh flex-col bg-ink-950 text-ink-100 lg:flex-row">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <aside className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-40 lg:flex lg:w-[236px] lg:flex-col lg:border-r lg:border-ink-700 lg:bg-ink-850">
        <div className="flex h-14 items-center justify-between border-b border-ink-700 px-4">
          <Link href="/" className="flex items-center gap-2.5 text-sm font-semibold tracking-tight text-ink-100">
            <span className="grid h-7 w-7 place-items-center rounded-md border border-amber/40 bg-amber/12 text-amber">
              <IconRadio size={15} />
            </span>
            <span>Livy</span>
          </Link>
          <span className="font-mono text-2xs text-ink-500">DESK</span>
        </div>

        <nav aria-label="Console" className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
          {GROUPS.map((group) => (
            <div key={group.label}>
              <div className="mb-1.5 px-3 text-2xs font-semibold text-ink-500">{group.label}</div>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavItem key={item.href} item={item} active={isActive(pathname, item.href)} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="space-y-2 border-t border-ink-700 p-3">
          <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
          <NodeStatus info={info} hasKey={Boolean(key)} ownerName={ownerName} nodeError={nodeError} />
        </div>
      </aside>

      <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-2 border-b border-ink-700 bg-ink-850 px-3 sm:px-5 lg:hidden">
        <Link href="/" className="flex min-h-[44px] items-center gap-2 text-sm font-semibold tracking-tight text-ink-100">
          <span className="grid h-7 w-7 place-items-center rounded-md border border-amber/40 bg-amber/12 text-amber">
            <IconRadio size={15} />
          </span>
          <span>Livy</span>
        </Link>

        <div className="flex items-center gap-2">
          <ThemeToggle theme={theme} toggleTheme={toggleTheme} compact />
          <button
            ref={menuBtnRef}
            type="button"
            aria-expanded={drawerOpen}
            aria-controls="mobile-nav-drawer"
            onClick={() => setDrawerPath(pathname ?? '/')}
            className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-md border border-ink-600 bg-ink-900 px-3 text-xs font-semibold text-ink-100 hover:bg-ink-800"
          >
            <IconMenu size={16} />
            <span>Menu</span>
          </button>
        </div>
      </header>

      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Console navigation">
          <button
            type="button"
            aria-label="Close navigation menu"
            onClick={closeDrawer}
            className="fixed inset-0 bg-black/60"
          />
          <div
            id="mobile-nav-drawer"
            className="fixed inset-y-0 right-0 flex w-72 max-w-[85vw] flex-col border-l border-ink-700 bg-ink-850 shadow-2xl"
          >
            <div className="flex h-14 items-center justify-between border-b border-ink-700 px-4">
              <span className="text-sm font-semibold text-ink-100">Navigation</span>
              <button
                ref={closeBtnRef}
                type="button"
                onClick={closeDrawer}
                aria-label="Close menu"
                className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-md border border-ink-700 bg-ink-900 text-ink-100"
              >
                <IconX size={16} />
              </button>
            </div>
            <nav aria-label="Mobile navigation" className="flex-1 space-y-5 overflow-y-auto p-3">
              {GROUPS.map((group) => (
                <div key={group.label}>
                  <div className="mb-1.5 px-3 text-2xs font-semibold text-ink-500">{group.label}</div>
                  <div className="space-y-1">
                    {group.items.map((item) => (
                      <NavItem
                        key={item.href}
                        item={item}
                        active={isActive(pathname, item.href)}
                        onNavigate={() => setDrawerPath(null)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </nav>
            <div className="space-y-2 border-t border-ink-700 p-3">
              <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
              <NodeStatus info={info} hasKey={Boolean(key)} ownerName={ownerName} nodeError={nodeError} />
            </div>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col lg:pl-[236px]">
        <main id="main" className="mx-auto w-full max-w-[1200px] flex-1 px-4 pt-5 pb-28 sm:px-6 sm:pt-7 lg:px-8">
          {children}
        </main>
        <footer className="border-t border-ink-700 px-4 py-4 pb-24 text-xs text-ink-500 sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-2">
            <span>
              Livy {info?.version ? `v${info.version}` : ''} · {info?.fx?.engine ?? 'DSP ready'}
            </span>
            <span className="font-mono text-2xs">
              {info?.deployment?.serverless ? 'serverless' : 'self-hosted broadcast node'}
            </span>
          </div>
        </footer>
      </div>

      <PlayerDock />
    </div>
  )
}
