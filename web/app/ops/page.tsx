'use client'

/**
 * Node operations: process telemetry, two-tier cache inspection & eviction,
 * owner credential management, plugins, and live process log.
 */
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'

import { useRadio } from '../../components/RadioProvider'
import { IconDatabase, IconRefresh } from '../../components/icons'
import {
  Badge,
  Button,
  Empty,
  Field,
  KeyGate,
  Meter,
  PageHeading,
  Panel,
  Stat,
  ago,
  cx,
  formatBytes,
  inputClass
} from '../../components/ui'
import { api, owner, ownerCache, ownerClearCache, ownerEvictCache } from '../../lib/api'
import type { CacheStats, MemoryBucketStats } from '../../lib/types'

interface CredentialStatus {
  configured?: boolean
  fromEnv?: boolean
  minLength?: number
}

function KeyPanel() {
  const { key, ownerName, lock, info } = useRadio()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [credential, setCredential] = useState<CredentialStatus | null>(null)

  useEffect(() => {
    if (!key) return
    owner<CredentialStatus>('/password')
      .then(setCredential)
      .catch(() => setCredential(null))
  }, [key])

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      await owner('/password', { method: 'POST', body: { password } })
      setMessage('Password updated. This tab stays authenticated until closed.')
      setPassword('')
      const status = await owner<CredentialStatus>('/password').catch(() => null)
      setCredential(status)
    } catch (problem) {
      setMessage((problem as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title="Owner access"
      subtitle={
        info?.setup?.protected === false
          ? 'Open mode: any caller on this network can write.'
          : 'One owner credential guards every write route.'
      }
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="lime">key accepted</Badge>
        <span className="font-medium text-ink-100">{ownerName ?? 'owner'}</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={lock}>
          Forget key
        </Button>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Stat
          label="Password"
          value={credential?.configured ? 'Configured' : 'None'}
          hint={credential?.fromEnv ? 'loaded from environment' : 'stored as scrypt hash'}
          accent={credential?.configured ? 'lime' : 'ink'}
        />
        <Stat
          label="Write protection"
          value={info?.setup?.protected ? 'Protected' : 'Open'}
          hint={info?.setup?.protected ? 'owner key required' : 'local open mode'}
        />
      </div>
      <form onSubmit={save} className="mt-4 flex flex-wrap items-end gap-2">
        <div className="min-w-[220px] flex-1">
          <Field
            label={credential?.configured ? 'Change owner password' : 'Set owner password'}
            hint={`Minimum ${credential?.minLength ?? 8} characters`}
          >
            <input
              className={inputClass}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
        </div>
        <Button type="submit" variant="primary" disabled={busy || password.length < (credential?.minLength ?? 8)}>
          {credential?.configured ? 'Update password' : 'Set password'}
        </Button>
      </form>
      {message && <p className="mt-2 text-xs text-ink-300">{message}</p>}
    </Panel>
  )
}

function CachePanel() {
  const [data, setData] = useState<CacheStats | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await ownerCache(40))
    } catch {
      setData(null)
    }
  }, [])

  useEffect(() => {
    const initial = setTimeout(() => void load(), 0)
    const timer = setInterval(() => void load(), 8000)
    return () => {
      clearTimeout(initial)
      clearInterval(timer)
    }
  }, [load])

  const clearScope = async (scope: 'all' | 'memory' | 'audio') => {
    setBusy(true)
    setStatus(null)
    try {
      await ownerClearCache(scope)
      setStatus(`Cleared ${scope} cache.`)
      await load()
    } catch (error) {
      setStatus((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const evict = async (hash: string) => {
    setBusy(true)
    try {
      await ownerEvictCache(hash)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const audio = data?.audio ?? null
  const memTiers: MemoryBucketStats[] = data?.memory
    ? [data.memory.resolve, data.memory.search, data.memory.trackUrl].filter((t): t is MemoryBucketStats => Boolean(t))
    : []
  const usageRatio = audio?.maxBytes ? Math.min(1, (audio.bytes ?? 0) / audio.maxBytes) : 0

  return (
    <Panel
      title="Two-tier cache"
      subtitle="Bounded in-memory metadata LRU and atomic on-disk MP3 audio cache."
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>
            <IconRefresh size={13} />
            <span>Refresh</span>
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void clearScope('memory')}>
            Clear memory
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void clearScope('audio')}>
            Clear audio
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void clearScope('all')}>
            Clear all
          </Button>
        </div>
      }
    >
      {!data ? (
        <Empty icon={<IconDatabase size={20} />}>Cache telemetry unavailable.</Empty>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-2.5 sm:grid-cols-3">
            <Stat
              label="Overall hit rate"
              value={`${Math.round((data.hitRate ?? 0) * 100)}%`}
              hint={`${data.totalHits ?? 0} hits / ${data.totalMisses ?? 0} misses`}
              accent="lime"
            />
            <Stat
              label="Disk MP3 cache"
              value={audio?.enabled ? formatBytes(audio.bytes ?? 0) : 'Off'}
              hint={
                audio?.enabled
                  ? `${audio.entries ?? 0} / ${audio.maxEntries ?? 0} tracks`
                  : 'read-only or disabled'
              }
              accent="amber"
            />
            <Stat
              label="Disk hits & writes"
              value={`${audio?.hits ?? 0} hits`}
              hint={`${audio?.writes ?? 0} saved · ${audio?.evictions ?? 0} evicted`}
              accent="cyan"
            />
          </div>

          {audio?.enabled && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-ink-500">
                <span>Disk audio budget</span>
                <span className="numeric font-mono text-ink-200">
                  {formatBytes(audio.bytes ?? 0)} / {formatBytes(audio.maxBytes ?? 0)}
                </span>
              </div>
              <Meter value={usageRatio} tone={usageRatio > 0.85 ? 'rose' : 'amber'} label="Audio cache disk usage" />
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-ink-700 text-ink-500">
                  <th className="py-2 pr-3 font-medium">Memory tier</th>
                  <th className="py-2 pr-3 font-medium">Entries</th>
                  <th className="py-2 pr-3 font-medium">Hits</th>
                  <th className="py-2 pr-3 font-medium">Misses</th>
                  <th className="py-2 pr-3 font-medium">Coalesced</th>
                  <th className="py-2 text-right font-medium">Hit rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-700 font-mono">
                {memTiers.map((tier) => (
                  <tr key={tier.name}>
                    <td className="py-2 pr-3 font-sans font-medium text-ink-100">{tier.name}</td>
                    <td className="numeric py-2 pr-3 text-ink-200">
                      {tier.entries}/{tier.maxEntries}
                    </td>
                    <td className="numeric py-2 pr-3 text-lime">{tier.hits}</td>
                    <td className="numeric py-2 pr-3 text-ink-300">{tier.misses}</td>
                    <td className="numeric py-2 pr-3 text-cyan">{tier.coalesced}</td>
                    <td className="numeric py-2 text-right text-ink-100">
                      {Math.round((tier.hitRate ?? 0) * 100)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold text-ink-200">
              Cached MP3 tracks ({data.items?.length ?? 0})
            </h3>
            {!data.items?.length ? (
              <p className="text-xs text-ink-500">
                No tracks cached on disk yet. Completed remote tracks are saved automatically on playback.
              </p>
            ) : (
              <div className="max-h-60 overflow-y-auto rounded-md border border-ink-700 bg-ink-900">
                <ul className="divide-y divide-ink-700">
                  {data.items.map((item) => (
                    <li key={item.hash} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-ink-100">
                          {item.title || String(item.trackId ?? '') || item.hash}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-2xs text-ink-500">
                          {item.artist ? `${item.artist} · ` : ''}
                          {item.source || 'remote'} · {String(item.bitrate ?? '')} kbps · {formatBytes(item.bytes)} ·{' '}
                          {item.hits ?? 0} hits · {ago(item.accessedAt)}
                        </div>
                      </div>
                      <Button size="sm" variant="subtle" disabled={busy} onClick={() => void evict(item.hash)}>
                        Evict
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {status && <p className="text-xs font-medium text-lime">{status}</p>}
        </div>
      )}
    </Panel>
  )
}

interface PluginInfo {
  id: string
  name: string
  description?: string
  enabled?: boolean
  status?: string
}

function Plugins() {
  const [data, setData] = useState<{ plugins: PluginInfo[] } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await owner<{ plugins: PluginInfo[] }>('/plugins'))
    } catch {
      setData(null)
    }
  }, [])

  useEffect(() => {
    const initial = setTimeout(() => void load(), 0)
    return () => clearTimeout(initial)
  }, [load])

  const act = async (plugin: string, action: string) => {
    setBusy(`${plugin}:${action}`)
    await owner(`/plugins/${encodeURIComponent(plugin)}/${action}`, { method: 'POST' }).catch(() => {})
    await load()
    setBusy(null)
  }

  return (
    <Panel
      title="Plugins"
      subtitle="Loaded node extensions: console bundle, transitions, and custom sources."
      actions={
        <Button size="sm" variant="ghost" onClick={() => void act(data?.plugins?.[0]?.id ?? 'console', 'rescan')}>
          Rescan
        </Button>
      }
    >
      {!data ? (
        <Empty>Plugins are disabled on this node.</Empty>
      ) : (
        <ul className="divide-y divide-ink-700">
          {data.plugins.map((plugin) => (
            <li key={plugin.id} className="flex flex-wrap items-center gap-2 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-ink-100">{plugin.name}</span>
                  <Badge tone={plugin.enabled ? (plugin.status === 'ready' ? 'lime' : 'amber') : 'ink'}>
                    {plugin.enabled ? (plugin.status ?? 'on') : 'off'}
                  </Badge>
                </span>
                <span className="mt-0.5 block truncate text-xs text-ink-500">{plugin.description ?? plugin.id}</span>
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={Boolean(busy)}
                  onClick={() => void act(plugin.id, plugin.enabled ? 'disable' : 'enable')}
                >
                  {plugin.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => void act(plugin.id, 'reload')}>
                  Reload
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

const LEVEL_TONE: Record<string, string> = {
  error: 'text-rose',
  warn: 'text-amber',
  info: 'text-ink-200',
  debug: 'text-ink-500'
}

const stamp = (t: number | string | undefined): string => {
  if (!t) return ''
  const date = new Date(t)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}

interface LogLine {
  t?: number | string
  level: string
  scope?: string
  msg?: string
}

function Logs() {
  const [data, setData] = useState<{ lines?: LogLine[] } | null>(null)
  const [level, setLevel] = useState('')
  const [paused, setPaused] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    if (paused) return
    try {
      const answer = await owner<{ lines?: LogLine[] }>(`/logs?limit=200${level ? `&level=${level}` : ''}`)
      setData(answer)
    } catch {
      /* no key or older node */
    }
  }, [level, paused])

  useEffect(() => {
    const initial = setTimeout(() => void load(), 0)
    const timer = setInterval(() => void load(), 5000)
    return () => {
      clearTimeout(initial)
      clearInterval(timer)
    }
  }, [load])

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  }, [data])

  return (
    <Panel
      title="Process log"
      subtitle="Last 200 structured events written by the node."
      actions={
        <div className="flex items-center gap-2">
          <select
            aria-label="Filter log level"
            className={cx(inputClass, 'min-h-[36px] w-24 py-1 text-xs')}
            value={level}
            onChange={(event) => setLevel(event.target.value)}
          >
            <option value="">all</option>
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
          <Button size="sm" variant="ghost" onClick={() => setPaused(!paused)}>
            {paused ? 'Resume' : 'Pause'}
          </Button>
        </div>
      }
    >
      <div
        ref={box}
        className="h-80 overflow-y-auto rounded-md border border-ink-700 bg-ink-950 p-3 font-mono text-2xs leading-relaxed"
      >
        {(data?.lines ?? []).map((line, index) => (
          <div key={index} className={cx('whitespace-pre-wrap break-words', LEVEL_TONE[line.level] ?? 'text-ink-300')}>
            <span className="text-ink-500">{stamp(line.t)}</span>{' '}
            <span className="uppercase">{line.level}</span> <span className="text-ink-300">{line.scope}</span>{' '}
            {line.msg}
          </div>
        ))}
        {!data && <div className="text-ink-500">Unlock with owner key to inspect live process logs.</div>}
      </div>
    </Panel>
  )
}

function NodeCard() {
  const { info } = useRadio()
  const [stats, setStats] = useState<{ rssMb?: number; heapMb?: number } | null>(null)

  useEffect(() => {
    const load = () => void api<{ rssMb?: number; heapMb?: number }>('/api/v1/stats').then(setStats).catch(() => {})
    load()
    const timer = setInterval(load, 10_000)
    return () => clearInterval(timer)
  }, [])

  const cache = info?.cache ?? null

  return (
    <Panel title="Process" subtitle="Runtime resources, DSP backend, and cache status.">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label="Uptime" value={info?.uptime ? `${Math.round(info.uptime / 3_600_000)}h` : '0h'} />
        <Stat
          label="Memory RSS"
          value={stats?.rssMb ? `${stats.rssMb} MB` : 'n/a'}
          hint={stats?.heapMb ? `heap ${stats.heapMb} MB` : ''}
        />
        <Stat
          label="Cache"
          value={cache?.enabled ? `${Math.round((cache.hitRate ?? 0) * 100)}%` : 'Off'}
          hint={
            cache?.audio?.enabled
              ? `${cache.audio.entries ?? 0} MP3 · ${formatBytes(cache.audio.bytes ?? 0)}`
              : 'memory only'
          }
          accent="lime"
        />
        <Stat
          label="DSP engine"
          value={info?.fx?.engine ?? 'js'}
          hint={info?.fx?.version ? `v${info.fx.version}` : ''}
          accent="cyan"
        />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-ink-700 pt-3 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-ink-500">Version</dt>
          <dd className="mt-0.5 font-mono text-ink-100">{info?.version ?? 'unknown'}</dd>
        </div>
        <div>
          <dt className="text-ink-500">Deployment</dt>
          <dd className="mt-0.5 font-mono text-ink-100">{info?.deployment?.serverless ? 'serverless' : 'server'}</dd>
        </div>
        <div>
          <dt className="text-ink-500">Storage</dt>
          <dd className="mt-0.5 font-mono text-ink-100">{info?.deployment?.storage ?? 'unknown'}</dd>
        </div>
        <div>
          <dt className="text-ink-500">Host</dt>
          <dd className="mt-0.5 font-mono text-ink-100">
            {info?.device?.profile ?? 'server'} · {info?.device?.cpus ?? '?'} CPUs
          </dd>
        </div>
      </dl>
    </Panel>
  )
}

export default function OpsPage() {
  const { key, info } = useRadio()
  return (
    <div className="space-y-5">
      <PageHeading
        eyebrow="Operations"
        title="Node"
        subtitle="Runtime metrics, two-tier cache controls, owner credentials, plugins, and live log."
        actions={
          <Link href="/stations/">
            <Button size="sm" variant="ghost">
              Stations
            </Button>
          </Link>
        }
      />

      <NodeCard />

      {!key && info?.setup?.protected !== false ? (
        <KeyGate title="Unlock node operations" />
      ) : (
        <KeyGate title="Unlock node operations">
          <div className="space-y-5">
            <CachePanel />
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-5">
                <KeyPanel />
                <Plugins />
              </div>
              <Logs />
            </div>
          </div>
        </KeyGate>
      )}
    </div>
  )
}
