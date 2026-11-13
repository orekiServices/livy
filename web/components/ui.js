'use client'

/**
 * The console's small kit: panels, labels, buttons, switches, sliders and the
 * key gate. Nothing here knows what a radio is — pages compose these.
 */
import { useEffect, useState } from 'react'

import { useRadio } from './RadioProvider.js'

export const cx = (...parts) => parts.filter(Boolean).join(' ')

export function Panel({ title, subtitle, actions, children, className = '', padded = true }) {
  return (
    <section className={cx('rounded-2xl border border-ink-700 bg-ink-850/80 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-ink-700/70 px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold tracking-wide text-ink-100">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-300">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  )
}

export function Stat({ label, value, hint, accent = 'ink' }) {
  const tone = {
    ink: 'text-ink-100',
    amber: 'text-amber',
    cyan: 'text-cyan',
    lime: 'text-lime',
    rose: 'text-rose'
  }[accent]
  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900/60 px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wider text-ink-300">{label}</div>
      <div className={cx('mt-1 font-mono text-lg leading-none', tone)}>{value}</div>
      {hint && <div className="mt-1 text-[11px] text-ink-300">{hint}</div>}
    </div>
  )
}

export function Badge({ children, tone = 'ink', className = '' }) {
  const tones = {
    ink: 'border-ink-600 bg-ink-800 text-ink-200',
    amber: 'border-amber-dim/60 bg-amber/10 text-amber',
    cyan: 'border-cyan-dim/60 bg-cyan/10 text-cyan',
    lime: 'border-lime/40 bg-lime/10 text-lime',
    rose: 'border-rose/40 bg-rose/10 text-rose'
  }
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium', tones[tone], className)}>
      {children}
    </span>
  )
}

export function Button({ children, onClick, variant = 'default', size = 'md', disabled, type = 'button', className = '', title }) {
  const variants = {
    default: 'border-ink-600 bg-ink-800 text-ink-100 hover:border-ink-500 hover:bg-ink-700',
    primary: 'border-amber/50 bg-amber/15 text-amber hover:bg-amber/25',
    cyan: 'border-cyan-dim bg-cyan/10 text-cyan hover:bg-cyan/20',
    ghost: 'border-transparent bg-transparent text-ink-300 hover:text-ink-100 hover:bg-ink-800',
    danger: 'border-rose/40 bg-rose/10 text-rose hover:bg-rose/20'
  }
  const sizes = { sm: 'px-2.5 py-1 text-xs', md: 'px-3 py-1.5 text-sm', lg: 'px-4 py-2 text-sm' }
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium transition disabled:cursor-not-allowed disabled:opacity-40',
        variants[variant],
        sizes[size],
        className
      )}
    >
      {children}
    </button>
  )
}

export function Switch({ checked, onChange, label, hint, disabled }) {
  return (
    <label className={cx('flex cursor-pointer items-start justify-between gap-4 py-2', disabled && 'cursor-not-allowed opacity-50')}>
      <span>
        <span className="block text-sm text-ink-100">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-ink-300">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={Boolean(checked)}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition',
          checked ? 'border-amber/60 bg-amber/70' : 'border-ink-600 bg-ink-700'
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 h-3.5 w-3.5 rounded-full bg-ink-950 transition-all',
            checked ? 'left-[18px] bg-ink-950' : 'left-0.5 bg-ink-300'
          )}
        />
      </button>
    </label>
  )
}

export function Slider({ label, value, min = 0, max = 1, step = 0.01, onChange, format, accent = 'amber', hint }) {
  return (
    <label className="block py-1.5">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-ink-200">{label}</span>
        <span className="font-mono text-xs text-ink-300">{format ? format(value) : value}</span>
      </span>
      <input
        type="range"
        className={cx('mt-1.5 w-full', accent === 'cyan' ? 'accent-cyan' : 'accent-amber')}
        min={min}
        max={max}
        step={step}
        value={value ?? min}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint && <span className="mt-0.5 block text-[11px] text-ink-300">{hint}</span>}
    </label>
  )
}

export function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-wider text-ink-300">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-[11px] text-ink-300">{hint}</span>}
    </label>
  )
}

export const inputClass =
  'w-full rounded-lg border border-ink-600 bg-ink-900 px-2.5 py-1.5 text-sm text-ink-100 outline-none placeholder:text-ink-500 focus:border-amber/60'

export function Empty({ children, icon = '○' }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-ink-700 px-4 py-8 text-center text-sm text-ink-300">
      <span className="text-xl text-ink-500">{icon}</span>
      <div>{children}</div>
    </div>
  )
}

/** Formatting that every page needs and none should re-implement. */
export const clock = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`
}

export const percent = (value) => `${Math.round((Number(value) || 0) * 100)}%`

export const ago = (timestamp) => {
  if (!timestamp) return 'never'
  const seconds = Math.max(0, Math.round((Date.now() - Number(timestamp)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}

/**
 * Owner key gate: a panel that explains itself until the key is accepted.
 * Everything behind `requiresKey` renders only with a verified key.
 */
export function KeyGate({ children, title = 'Owner key required' }) {
  const { key, ownerName, useKey, info } = useRadio()
  const [value, setValue] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setError(null)
  }, [key])

  if (key && ownerName) return children

  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const ok = await useKey(value.trim())
    setBusy(false)
    if (!ok) setError('That key was not accepted by this node.')
  }

  const open = info?.setup?.protected === false

  return (
    <Panel title={title} subtitle="The key is in the node's log, or in ~/.livy. It never leaves this tab." className="max-w-xl">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Owner key">
          <input className={inputClass} value={value} onChange={(event) => setValue(event.target.value)} placeholder="x-owner-key" autoFocus />
        </Field>
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy || value.trim().length < 4}>
            {busy ? 'Checking…' : 'Unlock'}
          </Button>
          {open && <span className="text-xs text-ink-300">This node is in open mode — press Enter with any key.</span>}
        </div>
        {error && <p className="text-sm text-rose">{error}</p>}
      </form>
    </Panel>
  )
}
