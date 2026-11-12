'use client'

/**
 * A settings form the console did not have to be told about.
 *
 * Plugins describe their settings (`settingsSchema` in the manifest, see
 * `server/src/core/pluginSchema.js`), and the node hands that description
 * over with the values. So this renders a real form — sliders with units,
 * time pickers, language menus, one-per-line lists — for a plugin it has
 * never heard of, including one you wrote this morning.
 *
 * A plugin with no schema still works: it falls back to a JSON box, which is
 * what the console could offer before.
 */
import { useEffect, useState } from 'react'

import { owner } from '../lib/api.js'

function Field({ field, value, onChange }) {
  const id = `f-${field.key}`
  const common = { id, 'aria-describedby': field.help ? `${id}-help` : undefined }

  const control = () => {
    switch (field.type) {
      case 'boolean':
        return (
          <input
            {...common}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(event) => onChange(field.key, event.target.checked)}
            style={{ width: 22, height: 22 }}
          />
        )

      case 'select':
        return (
          <select {...common} value={value ?? ''} onChange={(event) => onChange(field.key, event.target.value)}>
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )

      case 'integer':
      case 'number': {
        // A bounded number is a slider on a phone; an unbounded one is a box.
        const bounded = field.min != null && field.max != null
        return bounded ? (
          <div className="row" style={{ gap: 10 }}>
            <input
              {...common}
              type="range"
              min={field.min}
              max={field.max}
              step={field.step ?? (field.type === 'integer' ? 1 : 0.05)}
              value={Number(value ?? field.default ?? field.min)}
              onChange={(event) => onChange(field.key, Number(event.target.value))}
              style={{ flex: 1 }}
            />
            <span className="dim" style={{ minWidth: 76, textAlign: 'right' }}>
              {value ?? field.default} {field.unit ?? ''}
            </span>
          </div>
        ) : (
          <input
            {...common}
            type="number"
            value={value ?? ''}
            step={field.step ?? 'any'}
            onChange={(event) => onChange(field.key, event.target.value === '' ? null : Number(event.target.value))}
          />
        )
      }

      case 'list':
        return (
          <textarea
            {...common}
            rows={Math.min(8, Math.max(3, (value?.length ?? 0) + 1))}
            value={Array.isArray(value) ? value.join('\n') : (value ?? '')}
            placeholder="One per line"
            onChange={(event) => onChange(field.key, event.target.value.split('\n'))}
          />
        )

      case 'text':
        return <textarea {...common} value={value ?? ''} onChange={(event) => onChange(field.key, event.target.value)} />

      case 'time':
        return <input {...common} type="time" value={value ?? ''} onChange={(event) => onChange(field.key, event.target.value)} />

      default:
        return (
          <input
            {...common}
            type={field.secret ? 'password' : 'text'}
            value={value ?? ''}
            placeholder={field.placeholder ?? ''}
            onChange={(event) => onChange(field.key, event.target.value)}
          />
        )
    }
  }

  const inline = field.type === 'boolean'

  return (
    <div className="card" style={{ padding: '12px 14px' }}>
      <div className={inline ? 'row' : ''} style={inline ? { justifyContent: 'space-between' } : undefined}>
        <label htmlFor={id} className="field" style={{ marginBottom: inline ? 0 : 6 }}>
          {field.label}
          {field.perStation === false ? <span className="dim"> · node-wide</span> : null}
        </label>
        {inline ? control() : null}
      </div>
      {inline ? null : control()}
      {field.help ? (
        <p id={`${id}-help`} className="dim" style={{ margin: '8px 0 0', fontSize: 12.5 }}>
          {field.help}
        </p>
      ) : null}
    </div>
  )
}

export default function PluginSettings({ plugin, station = null, say, onSaved }) {
  const [fields, setFields] = useState(null)
  const [values, setValues] = useState({})
  const [raw, setRaw] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    const path = station ? `/plugins/${plugin}/schema?station=${encodeURIComponent(station)}` : `/plugins/${plugin}/schema`
    owner(path)
      .then((payload) => {
        setFields(payload.fields ?? [])
        setValues(payload.settings ?? {})
        setRaw(JSON.stringify(payload.settings ?? {}, null, 2))
      })
      .catch((problem) => setError(problem.message))
  }, [plugin, station])

  if (error && !fields) return <p className="error">{error}</p>
  if (!fields) return <span className="spin" />

  const change = (key, value) => setValues((current) => ({ ...current, [key]: value }))

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      let settings = values
      if (fields.length === 0) {
        try {
          settings = JSON.parse(raw || '{}')
        } catch {
          throw new Error('That is not valid JSON')
        }
      }
      const path = station ? `/stations/${station}/plugins/${plugin}` : `/plugins/${plugin}`
      await owner(path, { method: 'PATCH', body: { settings } })
      say?.(station ? `Saved for ${station}` : 'Settings saved')
      onSaved?.()
    } catch (problem) {
      // The node validates against the schema and says which field is wrong,
      // so show that rather than a generic failure.
      setError(problem.message)
    } finally {
      setBusy(false)
    }
  }

  // No schema: the plugin predates them, or does not need one.
  if (fields.length === 0) {
    return (
      <div>
        <p className="dim">This plugin does not describe its settings, so here they are as JSON.</p>
        <textarea rows={10} value={raw} onChange={(event) => setRaw(event.target.value)} spellCheck={false} />
        <button className="btn primary block" style={{ marginTop: 12 }} onClick={save} disabled={busy}>
          {busy ? <span className="spin" /> : 'Save'}
        </button>
        {error ? <p className="error">{error}</p> : null}
      </div>
    )
  }

  const shown = fields.filter((field) => !field.advanced || advanced)
  const hiddenCount = fields.length - shown.length

  return (
    <div>
      {station ? <p className="dim">Editing {station} only — anything you leave alone follows the node.</p> : null}

      <div className="stack">
        {shown.map((field) => (
          <Field
            key={field.key}
            field={field}
            value={values[field.key] ?? field.value ?? field.default}
            onChange={change}
          />
        ))}
      </div>

      {hiddenCount > 0 ? (
        <button className="btn ghost block" style={{ marginTop: 10 }} onClick={() => setAdvanced(true)}>
          Show {hiddenCount} advanced setting{hiddenCount === 1 ? '' : 's'}
        </button>
      ) : null}

      <button className="btn primary block" style={{ marginTop: 14 }} onClick={save} disabled={busy}>
        {busy ? <span className="spin" /> : 'Save'}
      </button>
      {error ? <p className="error">{error}</p> : null}
    </div>
  )
}
