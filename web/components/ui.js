'use client'

/**
 * The console's small kit: panels, labels, buttons, switches, sliders and the
 * key gate. Nothing here knows what a radio is, pages compose these.
 *
 * The rule the kit follows is that a surface, a label and a value look the
 * same everywhere. A console is read in a hurry, and a second border colour or
 * a third corner radius is a second thing to decode.
 */
import { useEffect, useState } from 'react'

import { useRadio } from './RadioProvider.js'

export const cx = (...parts) => parts.filter(Boolean).join(' ')

/** A panel is the only surface: a hairline, a header, and a body. */
export function Panel({ title, subtitle, actions, children, className = '', padded = true, id }) {
  return (
    <section id={id} className={cx('surface overflow-hidden', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 px-4 pb-3 pt-3.5">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold tracking-tight text-ink-100">{title}</h2>}
            {subtitle && <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-300">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      {(title || actions) && padded && <div className="rule mx-4" />}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  )
}

/**
 * The page's own heading. One `<h1>` per page, and the eye lands on it first,
 * so the page does not have to invent a header every time.
 */
export function PageHeading({ title, subtitle, actions, eyebrow }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        {eyebrow && <p className="label mb-1.5">{eyebrow}</p>}
        <h1 className="text-display font-semibold tracking-tight text-ink-100">{title}</h1>
        {subtitle && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-300">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

/** A number with its name above and its explanation below. */
export function Stat({ label, value, hint, accent = 'ink', className = '' }) {
  const tone = {
    ink: 'text-ink-100',
    amber: 'text-amber',
    cyan: 'text-cyan',
    lime: 'text-lime',
    rose: 'text-rose'
  }[accent]
  return (
    <div className={cx('surface px-3 py-2.5', className)}>
      <div className="label">{label}</div>
      <div className={cx('numeric mt-1.5 font-mono text-xl leading-none', tone)}>{value}</div>
      {hint && <div className="mt-1.5 text-2xs leading-snug text-ink-300">{hint}</div>}
    </div>
  )
}

export function Badge({ children, tone = 'ink', className = '', dot = false }) {
  const tones = {
    ink: 'border-ink-600/80 bg-ink-800/80 text-ink-200',
    amber: 'border-amber-dim/70 bg-amber/10 text-amber',
    cyan: 'border-cyan-dim/70 bg-cyan/10 text-cyan',
    lime: 'border-lime/35 bg-lime/10 text-lime',
    rose: 'border-rose/40 bg-rose/10 text-rose'
  }
  const dots = {
    ink: 'bg-ink-300',
    amber: 'bg-amber',
    cyan: 'bg-cyan',
    lime: 'bg-lime',
    rose: 'bg-rose'
  }
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium tracking-wide',
        tones[tone],
        className
      )}
    >
      {dot && <span className={cx('h-1.5 w-1.5 rounded-full', dots[tone])} />}
      {children}
    </span>
  )
}

export function Button({ children, onClick, variant = 'default', size = 'md', disabled, type = 'button', className = '', title, ...rest }) {
  const variants = {
    default: 'border-ink-600 bg-ink-800 text-ink-100 hover:border-ink-500 hover:bg-ink-700',
    primary: 'border-amber bg-amber text-ink-950 hover:brightness-105',
    cyan: 'border-cyan-dim bg-cyan/10 text-cyan hover:bg-cyan/20',
    ghost: 'border-transparent bg-transparent text-ink-300 hover:bg-ink-800 hover:text-ink-100',
    danger: 'border-rose/40 bg-rose/10 text-rose hover:bg-rose/20'
  }
  const sizes = { xs: 'gap-1 px-2 py-0.5 text-2xs', sm: 'gap-1.5 px-2.5 py-1 text-xs', md: 'gap-1.5 px-3 py-1.5 text-sm', lg: 'gap-2 px-4 py-2 text-sm' }
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'inline-flex items-center justify-center rounded-lg border font-medium transition disabled:cursor-not-allowed disabled:opacity-40',
        variants[variant],
        sizes[size],
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

/** A row of controls that belongs together, e.g. a preset strip. */
export function Toolbar({ children, className = '' }) {
  return <div className={cx('flex flex-wrap items-center gap-1.5', className)}>{children}</div>
}

/** A small selectable label. `active` is a state, not a button variant. */
export function Chip({ children, active = false, onClick, title, as = 'button', href }) {
  const className = cx(
    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition',
    active
      ? 'border-amber/60 bg-amber/15 text-amber'
      : 'border-ink-600 bg-ink-850 text-ink-300 hover:border-ink-500 hover:text-ink-100'
  )
  if (as === 'span') return <span className={className}>{children}</span>
  return (
    <button type="button" title={title} onClick={onClick} aria-pressed={active} className={className}>
      {children}
    </button>
  )
}

export function Switch({ checked, onChange, label, hint, disabled }) {
  return (
    <label className={cx('flex cursor-pointer items-start justify-between gap-4 py-2', disabled && 'cursor-not-allowed opacity-50')}>
      <span className="min-w-0">
        <span className="block text-sm text-ink-100">{label}</span>
        {hint && <span className="mt-0.5 block text-xs leading-snug text-ink-300">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={Boolean(checked)}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition',
          checked ? 'border-amber/60 bg-amber/80' : 'border-ink-600 bg-ink-700'
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all',
            checked ? 'left-[18px] bg-ink-950' : 'left-0.5 bg-ink-200'
          )}
        />
      </button>
    </label>
  )
}

/** A labelled 0…1-ish control with the filled part of its track shown. */
export function Slider({ label, value, min = 0, max = 1, step = 0.01, onChange, format, accent = 'amber', hint, disabled }) {
  const span = max - min || 1
  const fill = Math.min(100, Math.max(0, ((Number(value ?? min) - min) / span) * 100))
  return (
    <label className="block py-1.5">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-ink-200">{label}</span>
        <span className="numeric rounded-md border border-ink-700 bg-ink-900 px-1.5 py-0.5 font-mono text-2xs text-ink-200">
          {format ? format(value) : value}
        </span>
      </span>
      <input
        type="range"
        className={cx('mt-2', accent === 'cyan' ? 'accent-cyan' : 'accent-amber')}
        style={{ '--fill': `${fill}%` }}
        min={min}
        max={max}
        step={step}
        value={value ?? min}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint && <span className="mt-1 block text-2xs leading-snug text-ink-300">{hint}</span>}
    </label>
  )
}

/** A 0…1 bar, for anything that has a "how full" answer. */
export function Meter({ value = 0, tone = 'amber', label, className = '' }) {
  const percent = Math.min(100, Math.max(0, Number(value) * 100))
  const tones = { amber: 'bg-amber', cyan: 'bg-cyan', lime: 'bg-lime', rose: 'bg-rose', ink: 'bg-ink-300' }
  return (
    <div className={cx('flex items-center gap-2', className)}>
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-700"
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? 'progress'}
      >
        <div className={cx('h-full rounded-full transition-[width] duration-300', tones[tone])} style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

export function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="label block">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && <span className="mt-1 block text-2xs leading-snug text-ink-300">{hint}</span>}
    </label>
  )
}

export const inputClass =
  'w-full rounded-lg border border-ink-600 bg-ink-900 px-2.5 py-1.5 text-sm text-ink-100 outline-none transition placeholder:text-ink-500 focus:border-amber/60'

export function Empty({ children, icon = '○' }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-ink-700 bg-ink-900/40 px-4 py-10 text-center text-sm text-ink-300">
      <span className="text-xl text-ink-500">{icon}</span>
      <div className="max-w-sm leading-relaxed">{children}</div>
    </div>
  )
}

/** Formatting that every page needs and none should re-implement. */
export const clock = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '–'
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
 * The shape of a page while the node is answering. It carries the page's real
 * heading, so the frame does not jump when the data lands, and so the exported
 * HTML has an `<h1>` even before anything has been fetched.
 */
export function PageSkeleton({ title, subtitle, rows = 3 }) {
  return (
    <div className="space-y-4">
      <PageHeading title={title} subtitle={subtitle} />
      <div className="surface relative overflow-hidden p-4 sweep">
        <div className="space-y-2.5">
          {Array.from({ length: rows }).map((_, index) => (
            <div key={index} className="h-3 rounded bg-ink-800" style={{ width: `${88 - index * 14}%` }} />
          ))}
        </div>
      </div>
      <span className="sr-only" role="status">
        Loading {title.toLowerCase()}…
      </span>
    </div>
  )
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
        <Field label="Owner key" hint={open ? 'This node is in open mode, so any key of four characters or more unlocks it.' : undefined}>
          <input
            className={inputClass}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="x-owner-key"
            aria-label="Owner key"
            autoFocus
          />
        </Field>
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy || value.trim().length < 4}>
            {busy ? 'Checking…' : 'Unlock'}
          </Button>
        </div>
        {error && <p className="text-sm text-rose">{error}</p>}
      </form>
    </Panel>
  )
}
