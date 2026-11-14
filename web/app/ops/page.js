'use client'

/**
 * Node, the operator's page: the key, the password, the plugins, the log.
 *
 * Not a settings screen for the music. Everything here is about the process:
 * who may change it, what is loaded into it, and what it has been saying.
 */
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useRadio } from '../../components/RadioProvider.js'
import { Badge, Button, Empty, Field, KeyGate, Panel, Stat, ago, cx, inputClass } from '../../components/ui.js'
import { api, owner } from '../../lib/api.js'

function KeyPanel() {
  const { key, ownerName, forgetKey, info } = useRadio()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [credential, setCredential] = useState(null)

  useEffect(() => {
    if (!key) return
    owner('/password')
      .then(setCredential)
      .catch(() => setCredential(null))
  }, [key])

  const save = async (event) => {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      await owner('/password', { method: 'POST', body: { password } })
      setMessage('Password set. The console keeps using this key until the tab closes.')
      setPassword('')
      const status = await owner('/password').catch(() => null)
      setCredential(status)
    } catch (problem) {
      setMessage(problem.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title="Owner" subtitle={info?.setup?.open ? 'This node is in open mode, anyone who can reach it can change it.' : 'One credential guards every write.'}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="lime">key accepted</Badge>
        <span className="text-ink-200">{ownerName ?? 'owner'}</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={forgetKey}>
          Forget key
        </Button>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Stat label="Password" value={credential?.configured ? 'set' : 'none'} hint={credential?.fromEnv ? 'from the environment' : 'stored as a hash'} accent={credential?.configured ? 'lime' : 'ink'} />
        <Stat label="Protected" value={info?.setup?.protected ? 'yes' : 'open'} hint={info?.setup?.protected ? 'writes need the key' : 'a laptop, not the internet'} />
      </div>
      <form onSubmit={save} className="mt-3 flex flex-wrap items-end gap-2">
        <div className="min-w-[220px] flex-1">
          <Field label={credential?.configured ? 'Change the owner password' : 'Set an owner password'} hint={`at least ${credential?.minLength ?? 8} characters`}>
            <input className={inputClass} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
          </Field>
        </div>
        <Button type="submit" variant="primary" disabled={busy || password.length < (credential?.minLength ?? 8)}>
          {credential?.configured ? 'Change' : 'Set'}
        </Button>
      </form>
      {message && <p className="mt-2 text-xs text-ink-300">{message}</p>}
    </Panel>
  )
}

function Plugins() {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(null)

  const load = useCallback(async () => {
    try {
      setData(await owner('/plugins'))
    } catch {
      setData(null)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const act = async (plugin, action) => {
    setBusy(`${plugin}:${action}`)
    await owner(`/plugins/${encodeURIComponent(plugin)}/${action}`, { method: 'POST' }).catch(() => {})
    await load()
    setBusy(null)
  }

  return (
    <Panel title="Plugins" subtitle="Everything the node loads: the console, transitions that plugins add, sources." actions={<Button size="sm" variant="ghost" onClick={() => act(data?.plugins?.[0]?.id ?? 'console', 'rescan')}>Rescan</Button>}>
      {!data ? (
        <Empty>Plugins are not enabled on this node.</Empty>
      ) : (
        <ul className="divide-y divide-ink-700/60">
          {data.plugins.map((plugin) => (
            <li key={plugin.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm text-ink-100">{plugin.name}</span>
                  <Badge tone={plugin.enabled ? (plugin.status === 'ready' ? 'lime' : 'amber') : 'ink'}>{plugin.enabled ? plugin.status ?? 'on' : 'off'}</Badge>
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-ink-300">{plugin.description ?? plugin.id}</span>
              </span>
              <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => act(plugin.id, plugin.enabled ? 'disable' : 'enable')}>
                {plugin.enabled ? 'Disable' : 'Enable'}
              </Button>
              <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => act(plugin.id, 'reload')}>
                Reload
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

const LEVEL_TONE = { error: 'text-rose', warn: 'text-amber', info: 'text-ink-200', debug: 'text-ink-500' }

/** The log line's clock, in the browser's own timezone. */
const stamp = (t) => {
  if (!t) return ''
  const date = new Date(t)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}

function Logs() {
  const [data, setData] = useState(null)
  const [level, setLevel] = useState('')
  const [paused, setPaused] = useState(false)
  const box = useRef(null)

  const load = useCallback(async () => {
    if (paused) return
    try {
      const answer = await owner(`/logs?limit=200${level ? `&level=${level}` : ''}`)
      setData(answer)
    } catch {
      /* an older node without the route, or no key */
    }
  }, [level, paused])

  useEffect(() => {
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [load])

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  }, [data])

  return (
    <Panel
      title="Log"
      subtitle="The last 200 lines the process wrote."
      actions={
        <div className="flex items-center gap-1.5">
          <select className={cx(inputClass, 'w-24 py-1 text-xs')} value={level} onChange={(event) => setLevel(event.target.value)}>
            <option value="">all</option>
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
          <Button size="sm" variant="ghost" onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</Button>
        </div>
      }
    >
      <div ref={box} className="h-72 overflow-y-auto rounded-lg border border-ink-700 bg-ink-950/70 p-2 font-mono text-[11px] leading-relaxed">
        {(data?.lines ?? []).map((line, index) => (
          <div key={index} className={cx('whitespace-pre-wrap', LEVEL_TONE[line.level] ?? 'text-ink-300')}>
            <span className="text-ink-500">{stamp(line.t)}</span> <span className="uppercase">{line.level}</span> <span className="text-ink-300">{line.scope}</span> {line.msg}
          </div>
        ))}
        {!data && <div className="text-ink-500">No log available (owner key required).</div>}
      </div>
    </Panel>
  )
}

function NodeCard() {
  const { info } = useRadio()
  const [stats, setStats] = useState(null)

  useEffect(() => {
    const load = () => api('/api/v1/stats').then(setStats).catch(() => {})
    load()
    const timer = setInterval(load, 10_000)
    return () => clearInterval(timer)
  }, [])

  return (
    <Panel title="Process" subtitle="What this node is, and what it is costing.">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Uptime" value={info?.uptime ? `${Math.round(info.uptime / 3_600_000)}h` : '–'} />
        <Stat label="RSS" value={stats?.rssMb ? `${stats.rssMb} MB` : '–'} hint={stats?.heapMb ? `heap ${stats.heapMb} MB` : ''} />
        <Stat label="Stations" value={info?.stations ?? 0} hint={`${info?.sources?.length ?? 0} sources`} />
        <Stat label="DSP" value={info?.fx?.engine ?? '–'} hint={info?.fx?.version ? `v${info.fx.version}` : ''} accent="cyan" />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <dt className="text-ink-300">Version</dt>
        <dd className="font-mono text-ink-100">{info?.version ?? '–'}</dd>
        <dt className="text-ink-300">Deployment</dt>
        <dd className="font-mono text-ink-100">{info?.deployment?.serverless ? 'serverless' : 'server'}</dd>
        <dt className="text-ink-300">Storage</dt>
        <dd className="font-mono text-ink-100">{info?.deployment?.storage ?? '–'}</dd>
        <dt className="text-ink-300">Device</dt>
        <dd className="font-mono text-ink-100">{info?.device?.profile ?? '–'} · {info?.device?.cpus ?? '–'} cpus</dd>
        <dt className="text-ink-300">Language</dt>
        <dd className="font-mono text-ink-100">{info?.language ?? '–'}</dd>
      </dl>
    </Panel>
  )
}

export default function OpsPage() {
  const { key, info } = useRadio()
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Node</h1>
          <p className="mt-1 text-sm text-ink-300">The process behind the stations: credential, plugins, log.</p>
        </div>
        <Link href="/stations/"><Button size="sm" variant="ghost">Stations →</Button></Link>
      </header>

      <NodeCard />

      {!key ? (
        <KeyGate title="Unlock the node" />
      ) : (
        <KeyGate title="Unlock the node">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              <KeyPanel />
              <Plugins />
            </div>
            <Logs />
          </div>
        </KeyGate>
      )}

      <p className="text-[11px] text-ink-500">
        Console built with create-next-app · static export, served by the node on {info?.name ?? 'livy'}.
      </p>
    </div>
  )
}
