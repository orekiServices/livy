'use client'

/**
 * The plugins the node is running, and the switches for them.
 *
 * On a phone this is a list of rows: what it is, whether it is on, and a tap
 * to open its settings — which are rendered from the plugin's own schema, so
 * this panel needs to know nothing about any particular plugin.
 */
import { useCallback, useEffect, useState } from 'react'

import Sheet from './Sheet.js'
import PluginSettings from './PluginSettings.js'
import { owner } from '../lib/api.js'

export default function PluginsPanel({ station = null, say }) {
  const [plugins, setPlugins] = useState([])
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState(null)

  const load = useCallback(async () => {
    try {
      const payload = station ? await owner(`/stations/${station}/plugins`) : await owner('/plugins')
      setPlugins(payload.plugins ?? [])
    } catch (error) {
      say?.(error.message)
    }
  }, [station, say])

  useEffect(() => {
    load()
  }, [load])

  const toggle = async (plugin) => {
    const on = station ? plugin.enabled : plugin.status === 'ready'
    setBusy(plugin.id)
    try {
      const path = station
        ? `/stations/${station}/plugins/${plugin.id}/${on ? 'disable' : 'enable'}`
        : `/plugins/${plugin.id}/${on ? 'disable' : 'enable'}`
      await owner(path, { method: 'POST' })
      say?.(`${plugin.name ?? plugin.id} ${on ? 'off' : 'on'}`)
      await load()
    } catch (error) {
      say?.(error.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <div className="stack">
        {plugins.map((plugin) => {
          const on = station ? plugin.enabled : plugin.status === 'ready'
          return (
            <div key={plugin.id} className="queue-item" style={{ alignItems: 'flex-start', padding: 12 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="row" style={{ gap: 8 }}>
                  <strong className="truncate">{plugin.name ?? plugin.id}</strong>
                  {plugin.status === 'error' ? <span className="chip">error</span> : null}
                  {plugin.scope === 'global' ? <span className="chip">node-wide</span> : null}
                </div>
                <div className="dim" style={{ fontSize: 12.5 }}>
                  {plugin.error ?? plugin.description ?? plugin.id}
                </div>
              </div>

              <button className="btn small" onClick={() => setEditing(plugin.id)}>
                ⚙
              </button>
              <button className={`chip ${on ? 'on' : ''}`} onClick={() => toggle(plugin)} disabled={busy === plugin.id}>
                {busy === plugin.id ? <span className="spin" /> : on ? 'on' : 'off'}
              </button>
            </div>
          )
        })}
        {plugins.length === 0 ? <p className="dim">No plugins in this node&apos;s plugins/ folder.</p> : null}
      </div>

      <Sheet open={Boolean(editing)} title={plugins.find((p) => p.id === editing)?.name ?? 'Settings'} onClose={() => setEditing(null)}>
        {editing ? (
          <PluginSettings
            plugin={editing}
            station={station}
            say={say}
            onSaved={() => {
              setEditing(null)
              load()
            }}
          />
        ) : null}
      </Sheet>
    </div>
  )
}
