'use client'

/**
 * Reusable broadcast console primitives.
 * Structured hardware geometry, WCAG AA contrast in both Studio & Daylight
 * themes, 44px mobile touch ergonomics, and honest empty/loading/error states.
 */
import { useState, type ButtonHTMLAttributes, type FormEvent, type ReactNode } from 'react'

import { useRadio } from './RadioProvider'

export const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(' ')

export type Tone = 'ink' | 'amber' | 'cyan' | 'lime' | 'rose'

const TONES: Record<Tone, string> = {
  ink: 'border-ink-700 bg-ink-800 text-ink-200',
  amber: 'border-amber/45 bg-amber/12 text-amber',
  cyan: 'border-cyan/45 bg-cyan/12 text-cyan',
  lime: 'border-lime/45 bg-lime/12 text-lime',
  rose: 'border-rose/45 bg-rose/12 text-rose'
}

const DOT_TONES: Record<Tone, string> = {
  ink: 'bg-ink-500',
  amber: 'bg-amber',
  cyan: 'bg-cyan',
  lime: 'bg-lime',
  rose: 'bg-rose'
}

export interface BadgeProps {
  tone?: Tone
  dot?: boolean
  children?: ReactNode
  className?: string
}

export function Badge({ tone = 'ink', dot = false, children, className }: BadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-2xs font-medium tracking-tight',
        TONES[tone] ?? TONES.ink,
        className
      )}
    >
      {dot && <span className={cx('tally-bar', DOT_TONES[tone] ?? DOT_TONES.ink)} aria-hidden="true" />}
      {children}
    </span>
  )
}

export type ButtonVariant = 'primary' | 'cyan' | 'default' | 'ghost' | 'danger' | 'subtle'
export type ButtonSize = 'sm' | 'md' | 'lg'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'border-amber bg-amber text-amber-ink font-semibold hover:opacity-90',
  cyan: 'border-cyan/50 bg-cyan/15 text-cyan hover:bg-cyan/25',
  default: 'border-ink-600 bg-ink-850 text-ink-100 hover:bg-ink-800',
  ghost: 'border-ink-600 bg-ink-850 text-ink-100 hover:bg-ink-800',
  danger: 'border-rose/50 bg-rose/15 text-rose hover:bg-rose/25',
  subtle: 'border-transparent bg-transparent text-ink-300 hover:bg-ink-800 hover:text-ink-100'
}

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'min-h-[36px] px-3 py-1.5 text-xs',
  md: 'min-h-[40px] px-3.5 py-2 text-sm',
  lg: 'min-h-[44px] px-4 py-2.5 text-sm'
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

export function Button({
  variant = 'ghost',
  size = 'md',
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md border font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45',
        BUTTON_VARIANTS[variant] ?? BUTTON_VARIANTS.ghost,
        BUTTON_SIZES[size] ?? BUTTON_SIZES.md,
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export interface PanelProps {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  padded?: boolean
  children?: ReactNode
  className?: string
  bodyClassName?: string
}

export function Panel({ title, subtitle, actions, padded = true, children, className, bodyClassName }: PanelProps) {
  return (
    <section className={cx('desk-panel', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-700 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold tracking-tight text-ink-100">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx(padded ? 'p-4 sm:p-5' : '', bodyClassName)}>{children}</div>
    </section>
  )
}

export interface StatProps {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  accent?: Tone
}

export function Stat({ label, value, hint, accent = 'ink' }: StatProps) {
  const accentColor =
    accent === 'amber'
      ? 'text-amber'
      : accent === 'cyan'
        ? 'text-cyan'
        : accent === 'lime'
          ? 'text-lime'
          : accent === 'rose'
            ? 'text-rose'
            : 'text-ink-100'
  return (
    <div className="rounded-md border border-ink-700 bg-ink-900 px-3.5 py-3">
      <div className="text-2xs font-medium text-ink-500">{label}</div>
      <div className={cx('numeric mt-1 text-lg font-semibold tracking-tight', accentColor)}>{value}</div>
      {hint && <div className="mt-0.5 truncate text-2xs text-ink-500">{hint}</div>}
    </div>
  )
}

export interface SwitchProps {
  checked?: boolean
  onChange?: (checked: boolean) => void
  label: ReactNode
  hint?: ReactNode
  disabled?: boolean
}

export function Switch({ checked, onChange, label, hint, disabled }: SwitchProps) {
  return (
    <label className={cx('flex min-h-[44px] items-center justify-between gap-4 py-2', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink-100">{label}</span>
        {hint && <span className="block text-xs text-ink-500">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={Boolean(checked)}
        disabled={disabled}
        onClick={() => !disabled && onChange?.(!checked)}
        className={cx(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded border transition-colors duration-150',
          checked ? 'border-amber bg-amber' : 'border-ink-600 bg-ink-800'
        )}
      >
        <span
          className={cx(
            'inline-block h-4 w-4 rounded-xs transition-transform duration-150',
            checked ? 'translate-x-5.5 bg-amber-ink' : 'translate-x-1 bg-ink-200'
          )}
        />
      </button>
    </label>
  )
}

export interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  accent?: Tone
  onChange?: (value: number) => void
  format?: (value: number) => string
  disabled?: boolean
}

export function Slider({ label, value, min, max, step = 0.01, accent, onChange, format, disabled }: SliderProps) {
  const shown = format ? format(value) : String(value)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-ink-300">{label}</span>
        <span className="numeric font-mono text-ink-100">{shown}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange?.(Number(event.target.value))}
        className={cx('w-full', accent === 'cyan' && 'accent-cyan')}
      />
    </div>
  )
}

export interface PageHeadingProps {
  eyebrow?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}

export function PageHeading({ eyebrow, title, subtitle, actions }: PageHeadingProps) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-ink-700 pb-4">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-1 flex items-center gap-2 text-xs font-medium text-amber">
            <span className="tally-bar bg-amber" aria-hidden="true" />
            <span>{eyebrow}</span>
          </div>
        )}
        <h1 className="text-2xl font-semibold tracking-tight text-ink-100 sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-ink-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export interface KeyGateProps {
  title?: string
  children?: ReactNode
}

export function KeyGate({ title = 'Owner access required', children }: KeyGateProps) {
  const { key, unlock, info } = useRadio()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (key || info?.setup?.protected === false) return <>{children}</>

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!draft.trim()) return
    setBusy(true)
    setError(null)
    const ok = await unlock(draft)
    setBusy(false)
    if (!ok) setError('Key was rejected by the node.')
    else setDraft('')
  }

  return (
    <Panel title={title} subtitle="Enter your owner key or password. It stays in this browser tab only.">
      <form onSubmit={submit} className="flex flex-col gap-2.5 sm:flex-row">
        <input
          type="password"
          autoComplete="current-password"
          aria-label="Owner key or password"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Owner key or password"
          className={cx(inputClass, 'flex-1')}
        />
        <Button type="submit" variant="primary" size="lg" disabled={busy || !draft.trim()}>
          {busy ? 'Checking...' : 'Unlock'}
        </Button>
      </form>
      {error && <p className="mt-2 text-xs font-medium text-rose">{error}</p>}
    </Panel>
  )
}

export interface FieldProps {
  label: ReactNode
  hint?: ReactNode
  children?: ReactNode
}

export function Field({ label, hint, children }: FieldProps) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-medium text-ink-200">{label}</span>
      {children}
      {hint && <span className="block text-2xs text-ink-500">{hint}</span>}
    </label>
  )
}

export const inputClass =
  'min-h-[40px] w-full rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-sm text-ink-100 outline-none transition-colors placeholder:text-ink-500 focus:border-amber'

export interface EmptyProps {
  icon?: ReactNode
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
}

export function Empty({ icon, title, children, action }: EmptyProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-ink-700 bg-ink-900 px-6 py-10 text-center">
      {icon && <span className="mb-2 text-ink-500">{icon}</span>}
      {title && <h3 className="text-sm font-semibold text-ink-100">{title}</h3>}
      <p className="mt-1 max-w-md text-xs text-ink-500">{children}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export interface ChipProps {
  active?: boolean
  tone?: 'amber' | 'cyan'
  title?: string
  children?: ReactNode
  onClick?: () => void
  className?: string
}

export function Chip({ active, tone = 'amber', title, children, onClick, className }: ChipProps) {
  const activeStyle = tone === 'cyan' ? 'border-cyan bg-cyan/15 text-cyan' : 'border-amber bg-amber/15 text-amber'
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cx(
        'inline-flex min-h-[36px] cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors duration-150',
        active ? activeStyle : 'border-ink-700 bg-ink-850 text-ink-300 hover:border-ink-600 hover:text-ink-100',
        className
      )}
    >
      {children}
    </button>
  )
}

export function Toolbar({ children, className }: { children?: ReactNode; className?: string }) {
  return <div className={cx('mb-5 flex flex-wrap items-center gap-2', className)}>{children}</div>
}

export interface PageSkeletonProps {
  title?: ReactNode
  subtitle?: ReactNode
  blocks?: number
  rows?: number
}

export function PageSkeleton({ title, subtitle, blocks = 3, rows }: PageSkeletonProps) {
  const count = rows ?? blocks
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      {title ? (
        <PageHeading title={title} subtitle={subtitle} />
      ) : (
        <div className="skeleton h-12 w-56 rounded-md" />
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: count }).map((_, index) => (
          <div key={index} className="skeleton h-40 rounded-lg border border-ink-700" />
        ))}
      </div>
    </div>
  )
}

export interface MeterProps {
  value?: number
  tone?: Tone
  label?: string
}

export function Meter({ value = 0, tone = 'amber', label = 'Level' }: MeterProps) {
  const clamped = Math.max(0, Math.min(1, Number(value) || 0))
  const barColor =
    tone === 'cyan'
      ? 'bg-cyan'
      : tone === 'lime'
        ? 'bg-lime'
        : tone === 'rose'
          ? 'bg-rose'
          : tone === 'ink'
            ? 'bg-ink-500'
            : 'bg-amber'
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      className="h-1.5 w-full overflow-hidden rounded-xs bg-ink-800"
    >
      <div className={cx('h-full transition-all duration-200', barColor)} style={{ width: `${Math.round(clamped * 100)}%` }} />
    </div>
  )
}

export function clock(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '0:00'
  const total = Math.floor(ms / 1000)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export function formatBytes(bytes: number | null | undefined): string {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return 'never'
  const diff = Math.max(0, Date.now() - ts)
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
