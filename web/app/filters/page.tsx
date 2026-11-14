'use client'

/**
 * Radio filters, the DSP rack, live.
 */
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

import { useRadio } from '../../components/RadioProvider'
import {
  Badge,
  Button,
  Chip,
  Empty,
  KeyGate,
  PageHeading,
  PageSkeleton,
  Panel,
  Slider,
  Toolbar,
  cx,
  inputClass
} from '../../components/ui'
import { owner } from '../../lib/api'

const ENGAGE: Record<string, Record<string, number>> = {
  timescale: { speed: 1.1, pitch: 1, rate: 1 },
  karaoke: { level: 1, monoLevel: 0.4, filterBand: 220, filterWidth: 100 },
  channelMix: { leftToLeft: 0.8, leftToRight: 0.2, rightToLeft: 0.2, rightToRight: 0.8 },
  compressor: { threshold: -18, ratio: 4, attack: 0.01, release: 0.25, gain: 1, makeupGain: 1.2 },
  lowpass: { cutoff: 6000, smoothing: 1, resonance: 0 },
  highpass: { cutoff: 80, smoothing: 1, resonance: 0 },
  rotation: { rotationHz: 0.2 },
  tesseract: { rotationHz: 0.15 },
  spatial: { x: 1, y: 0, z: 0, depth: 0.5 },
  tremolo: { frequency: 5, depth: 0.5 },
  vibrato: { frequency: 5, depth: 0.3 },
  chorus: { delay: 25, rate: 1.5, depth: 0.3, feedback: 0.15, mix: 0.4 },
  phaser: { rate: 0.6, depth: 0.7, feedback: 0.3, mix: 0.5 },
  flanger: { rate: 0.4, depth: 0.5, feedback: 0.2, mix: 0.4 },
  echo: { delay: 350, feedback: 0.35, mix: 0.25 },
  reverb: { roomSize: 0.6, damping: 0.4, wetLevel: 0.35, dryLevel: 0.9, width: 0.6, mix: 0.35 },
  distortion: { scale: 1.5, offset: 0.1 },
  phonograph: { frequency: 1, depth: 0.5, crackle: 0.2, flutter: 0.1, room: 0.2, micAgc: 0, drive: 0.2 }
}

const LABELS: Record<string, string> = {
  timescale: 'Time & pitch',
  equalizer: 'Equaliser',
  equalizerStandalone: 'Single band',
  karaoke: 'Karaoke (vocal cut)',
  channelMix: 'Channel mix',
  compressor: 'Compressor',
  lowpass: 'Low-pass',
  highpass: 'High-pass',
  rotation: 'Rotation',
  tesseract: 'Tesseract',
  spatial: 'Spatial',
  tremolo: 'Tremolo',
  vibrato: 'Vibrato',
  chorus: 'Chorus',
  phaser: 'Phaser',
  flanger: 'Flanger',
  echo: 'Echo',
  reverb: 'Reverb',
  distortion: 'Distortion',
  phonograph: 'Phonograph'
}

const HIDDEN = new Set(['equalizerStandalone'])

const gainDb = (gain: number): number => (gain <= -0.9999 ? -60 : 20 * Math.log10(1 + gain))
const dbToOffset = (db: number): number => Math.max(-1, Math.min(1, 10 ** (db / 20) - 1))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FilterMap = Record<string, any>

function buildPreset(id: string): FilterMap {
  const eq = (map: Record<number, number>) => {
    const bands: Array<{ band: number; gain: number }> = []
    for (const [band, db] of Object.entries(map)) bands.push({ band: Number(band), gain: dbToOffset(db) })
    return { bands }
  }
  switch (id) {
    case 'warm':
      return { equalizer: eq({ 1: 2.5, 2: 2, 3: 1.5, 12: -2, 13: -3 }) }
    case 'bright':
      return { equalizer: eq({ 8: 1, 10: 2, 12: 2.5, 13: 2 }) }
    case 'club':
      return {
        equalizer: eq({ 0: 3, 1: 3, 2: 2, 11: 1, 13: 1.5 }),
        compressor: { threshold: -12, ratio: 3, attack: 0.02, release: 0.2, gain: 1, makeupGain: 1.2 }
      }
    case 'lofi':
      return {
        lowpass: { cutoff: 4200, smoothing: 1 },
        highpass: { cutoff: 120, smoothing: 1 },
        phonograph: { crackle: 0.18, flutter: 0.08, room: 0.2, drive: 0.25, depth: 0.4 }
      }
    case 'night':
      return {
        lowpass: { cutoff: 9000 },
        compressor: { threshold: -20, ratio: 5, attack: 0.01, release: 0.3, gain: 1, makeupGain: 1.5 },
        equalizer: eq({ 13: -1.5, 14: -2 })
      }
    case 'karaoke':
      return { karaoke: { level: 1, monoLevel: 0.6, filterBand: 220, filterWidth: 120 } }
    case 'space':
      return {
        reverb: { mix: 0.45, roomSize: 0.7, damping: 0.35, wetLevel: 0.4, dryLevel: 0.9, width: 0.7 },
        echo: { mix: 0.2, delay: 420, feedback: 0.3 }
      }
    case 'phone':
      return { highpass: { cutoff: 380, smoothing: 1 }, lowpass: { cutoff: 3400 }, distortion: { scale: 1.3 } }
    default:
      return {}
  }
}

const PRESET_LIST = [
  { id: 'off', label: 'Off' },
  { id: 'warm', label: 'Warm' },
  { id: 'bright', label: 'Bright' },
  { id: 'club', label: 'Club' },
  { id: 'lofi', label: 'Lo-fi' },
  { id: 'night', label: 'Night' },
  { id: 'karaoke', label: 'Karaoke' },
  { id: 'space', label: 'Space' },
  { id: 'phone', label: 'Phone' }
]

interface FilterParam {
  key: string
  min?: number
  max?: number
  default?: unknown
}

interface FilterDescriptor {
  name: string
  params?: FilterParam[]
}

function Fader({ frequency, gain, onChange }: { frequency: number; gain: number; onChange: (value: number) => void }) {
  const db = gainDb(gain)
  const label = frequency >= 1000 ? `${frequency / 1000}k` : String(frequency)
  const style = { '--fill': `${Math.round(((gain + 1) / 2) * 100)}%` } as CSSProperties
  return (
    <div className="flex flex-1 flex-col items-center gap-1.5">
      <span
        className={cx('numeric rounded-md px-1 py-0.5 font-mono text-2xs', Math.abs(db) < 0.5 ? 'text-ink-500' : 'text-amber')}
        aria-hidden="true"
      >
        {db > 0.5 ? '+' : ''}
        {db.toFixed(0)}
      </span>
      <input
        type="range"
        className="fader accent-amber"
        style={style}
        min={-1}
        max={1}
        step={0.01}
        value={gain}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={`${frequency} hertz band, ${db.toFixed(0)} decibels`}
        title={`${frequency} Hz · ${db.toFixed(1)} dB`}
      />
      <span className="font-mono text-2xs text-ink-500">{label}</span>
    </div>
  )
}

function FilterCard({
  filter,
  settings,
  onChange
}: {
  filter: FilterDescriptor
  settings: FilterMap
  onChange: (name: string, value: Record<string, number> | null) => void
}) {
  const name = filter.name
  const label = LABELS[name] ?? name
  const params = filter.params ?? []
  const current = (settings[name] ?? {}) as Record<string, number>
  const engaged =
    Object.keys(current).length > 0 &&
    params.some((param) => {
      const value = current[param.key]
      return value != null && JSON.stringify(value) !== JSON.stringify(param.default)
    })
  const toggle = () => onChange(name, engaged ? null : (ENGAGE[name] ?? {}))
  return (
    <div className={cx('rounded-lg border p-3.5 transition-colors', engaged ? 'border-cyan/55 bg-cyan/8' : 'border-ink-700 bg-ink-900')}>
      <div className="flex items-center justify-between gap-2">
        <span className={cx('text-sm font-medium', engaged ? 'text-cyan' : 'text-ink-200')}>{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={engaged}
          aria-label={`${label} filter`}
          onClick={toggle}
          className={cx(
            'relative inline-flex h-5 w-9 shrink-0 items-center rounded border transition-colors',
            engaged ? 'border-cyan bg-cyan' : 'border-ink-600 bg-ink-800'
          )}
        >
          <span
            className={cx(
              'inline-block h-3.5 w-3.5 rounded-xs transition-transform',
              engaged ? 'translate-x-4.5 bg-ink-950' : 'translate-x-0.5 bg-ink-200'
            )}
          />
        </button>
      </div>
      {engaged && (
        <div className="mt-1.5 space-y-0.5">
          {params.slice(0, 6).map((param) => (
            <Slider
              key={param.key}
              label={param.key}
              accent="cyan"
              value={Number(current[param.key] ?? param.default ?? param.min ?? 0)}
              min={param.min ?? 0}
              max={param.max ?? 1}
              step={(param.max ?? 1) - (param.min ?? 0) > 50 ? 1 : 0.01}
              format={(value) => (Number.isInteger(param.min) && Number.isInteger(param.max) ? String(value) : value.toFixed(2))}
              onChange={(value) => onChange(name, { ...current, [param.key]: value })}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function RackPage() {
  const params = useSearchParams()
  const { stations, setup, key } = useRadio()
  const [selectedId, setSelectedId] = useState(params.get('id') ?? '')
  const stationId = selectedId || params.get('id') || stations[0]?.id || ''
  const [settings, setSettings] = useState<FilterMap>({})
  const [active, setActive] = useState<string[]>([])
  const [state, setState] = useState<'idle' | 'synced' | 'saving' | 'live' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirty = useRef(false)

  useEffect(() => {
    if (!stationId || !key) return
    owner<{ settings?: FilterMap; active?: string[] }>(`/stations/${stationId}/filters`)
      .then((answer) => {
        setSettings(answer.settings ?? {})
        setActive(answer.active ?? [])
        setState('synced')
      })
      .catch((problem: Error) => setError(problem.message))
  }, [stationId, key])

  const apply = useCallback(
    (next: FilterMap) => {
      if (!stationId) return
      dirty.current = true
      setState('saving')
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(async () => {
        try {
          const answer = await owner<{ active?: string[] }>(`/stations/${stationId}/filters`, {
            method: 'POST',
            body: { filters: next }
          })
          setActive(answer.active ?? [])
          setState('live')
          setError(null)
        } catch (problem) {
          setError((problem as Error).message)
          setState('error')
        }
      }, 350)
    },
    [stationId]
  )

  const setBand = (band: number, gain: number) => {
    const current: Array<{ band: number; gain: number }> = settings.equalizer?.bands ?? []
    const bands = current.filter((entry) => entry.band !== band)
    bands.push({ band, gain })
    const next: FilterMap = { ...settings, equalizer: { bands: bands.sort((a, b) => a.band - b.band) } }
    setSettings(next)
    apply(next)
  }

  const setFilter = (name: string, value: Record<string, number> | null) => {
    const next: FilterMap = { ...settings }
    if (value === null) delete next[name]
    else next[name] = value
    setSettings(next)
    apply(next)
  }

  const preset = (id: string) => {
    const next = id === 'off' ? {} : buildPreset(id)
    setSettings(next)
    apply(next)
  }

  const filters: FilterDescriptor[] = (setup?.filters?.filters ?? []).filter(
    (filter: FilterDescriptor) => !HIDDEN.has(filter.name)
  )
  const frequencies: number[] = useMemo(() => setup?.filters?.bands ?? [], [setup])
  const gains = useMemo(() => {
    const eqBands: Array<{ band: number; gain: number }> = settings.equalizer?.bands ?? []
    const map = new Map(eqBands.map((entry) => [entry.band, entry.gain]))
    return frequencies.map((_, band) => map.get(band) ?? 0)
  }, [settings, frequencies])
  const flat = gains.every((gain) => Math.abs(gain) < 0.005)

  if (!stations.length) {
    return (
      <div className="space-y-4">
        <PageHeading
          eyebrow="Live DSP"
          title="Radio filters"
          subtitle="One station's chain, applied before the stream and before the automix."
        />
        <Panel title="Radio filters">
          <Empty>
            No stations yet: a filter chain belongs to a station.{' '}
            <Link href="/stations/" className="underline">
              Create one
            </Link>
            .
          </Empty>
        </Panel>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <PageHeading
        eyebrow="Live DSP"
        title="Radio filters"
        subtitle="One station's chain, applied before the stream and before the automix. Changes land on air in the same breath."
        actions={
          <>
            <select
              aria-label="Station"
              className={cx(inputClass, 'w-44')}
              value={stationId}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {stations.map((station) => (
                <option key={station.id} value={station.id}>
                  {station.name}
                </option>
              ))}
            </select>
            <Badge tone={state === 'error' ? 'rose' : active.length ? 'cyan' : 'ink'} dot={active.length > 0}>
              {state === 'error' ? 'error' : state === 'saving' ? 'saving…' : active.length ? `${active.length} live` : 'bypassed'}
            </Badge>
          </>
        }
      />

      {!key && <KeyGate />}

      <KeyGate>
        <div className="space-y-4">
          <Panel title="Presets" subtitle="A preset replaces the whole chain. Nothing from the last one lingers.">
            <Toolbar>
              {PRESET_LIST.map((entry) => (
                <Chip key={entry.id} onClick={() => preset(entry.id)} title={`Apply the ${entry.label.toLowerCase()} preset`}>
                  {entry.label}
                </Chip>
              ))}
            </Toolbar>
            {active.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="label mr-1">chain</span>
                {active.map((name) => (
                  <Badge key={name} tone="cyan">
                    {LABELS[name] ?? name}
                  </Badge>
                ))}
              </div>
            )}
            {error && (
              <p role="alert" className="mt-2 text-xs text-rose">
                {error}
              </p>
            )}
          </Panel>

          <Panel
            title="Equaliser"
            subtitle={flat ? 'Flat, every band at unity.' : 'Fifteen bands, an octave wide, aligned with the NodeLink centres.'}
            actions={
              <Button size="sm" variant="ghost" onClick={() => setFilter('equalizer', null)}>
                Flat
              </Button>
            }
          >
            <div className="flex items-end justify-between gap-1 overflow-x-auto pb-1">
              {frequencies.map((frequency, band) => (
                <Fader key={frequency} frequency={frequency} gain={gains[band]} onChange={(value) => setBand(band, value)} />
              ))}
            </div>
          </Panel>

          <Panel title="The rack" subtitle="Priority order is fixed by the engine; a unit that is off costs nothing.">
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {filters.map((filter) => (
                <FilterCard key={filter.name} filter={filter} settings={settings} onChange={setFilter} />
              ))}
            </div>
          </Panel>
        </div>
      </KeyGate>
    </div>
  )
}

export default function FiltersPage() {
  return (
    <Suspense
      fallback={
        <PageSkeleton
          title="Radio filters"
          subtitle="One station's chain, applied before the stream and before the automix."
          rows={4}
        />
      }
    >
      <RackPage />
    </Suspense>
  )
}
