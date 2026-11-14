'use client'

/**
 * Radio filters, the DSP rack, live.
 *
 * Two halves. The equaliser is a fader strip, because that is the shape of an
 * equaliser. Everything else is the station's filter *chain*: eighteen units
 * that run in a fixed priority order before the stream and before the automix,
 * each with the ranges its own code declares. The console builds the controls
 * from the schema the node publishes, so a filter that gains a parameter in
 * the server appears here without a console release, and a value that is out of
 * range is clamped by the node rather than by a copy of the limits.
 *
 * Changes are live, debounced by 350 ms: a fader drag is one request, not one
 * hundred.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'

import { useRadio } from '../../components/RadioProvider.js'
import { Badge, Button, Empty, Field, KeyGate, Panel, Slider, cx, inputClass } from '../../components/ui.js'
import { owner } from '../../lib/api.js'

/** The documented "on" value for each unit, since most defaults are neutral. */
const ENGAGE = {
  timescale: { speed: 1, pitch: 1, rate: 1 },
  karaoke: { level: 1, monoLevel: 0.4, filterBand: 220, filterWidth: 100 },
  channelMix: { leftToLeft: 1, leftToRight: 0, rightToLeft: 0, rightToRight: 1 },
  compressor: { threshold: 0.5, ratio: 4, attack: 0.01, release: 0.25, gain: 1, makeupGain: 1.2 },
  lowpass: { cutoff: 6000, smoothing: 1, resonance: 0 },
  highpass: { cutoff: 80, smoothing: 0, resonance: 0 },
  rotation: { rotationHz: 0.2 },
  tesseract: { rotationHz: 0.15 },
  spatial: { x: 1, y: 0, z: 0, depth: 0.5 },
  tremolo: { frequency: 5, depth: 0.5 },
  vibrato: { frequency: 5, depth: 0.3 },
  chorus: { mix: 0.4 },
  phaser: { mix: 0.4 },
  flanger: { mix: 0.4 },
  echo: { delay: 0.35, feedback: 0.35, mix: 0.25 },
  reverb: { roomSize: 0.6, damping: 0.4, wetLevel: 0.35, dryLevel: 0.9, width: 0.6, mix: 0.35 },
  distortion: { scale: 1.5, offset: 0.1 },
  phonograph: { frequency: 1, depth: 0.5, crackle: 0.2, flutter: 0.1, room: 0.2, micAgc: 0, drive: 0.2 }
}

/** The labels a person recognises, keyed by the unit's name. */
const LABELS = {
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

/** dB from the NodeLink gain multiplier: 1 is flat, 0 is silence. */
const gainDb = (gain) => (gain <= 0.0001 ? -60 : 20 * Math.log10(gain))

function buildPreset(id) {
  const eq = (map) => {
    const bands = []
    for (const [band, db] of Object.entries(map)) bands.push({ band: Number(band), gain: Math.pow(10, db / 20) })
    return { bands }
  }
  switch (id) {
    case 'warm':
      return { equalizer: eq({ 1: 2.5, 2: 2, 3: 1.5, 12: -2, 13: -3 }) }
    case 'bright':
      return { equalizer: eq({ 8: 1, 10: 2, 12: 2.5, 13: 2 }) }
    case 'club':
      return { equalizer: eq({ 0: 3, 1: 3, 2: 2, 11: 1, 13: 1.5 }), compressor: { threshold: 0.6, ratio: 3, attack: 0.02, release: 0.2, gain: 1, makeupGain: 1.15 } }
    case 'lofi':
      return { lowpass: { cutoff: 4200, smoothing: 1 }, highpass: { cutoff: 120 }, phonograph: { crackle: 0.18, flutter: 0.08, room: 0.2, drive: 0.25, depth: 0.4 } }
    case 'night':
      return { lowpass: { cutoff: 9000 }, compressor: { threshold: 0.45, ratio: 5, attack: 0.01, release: 0.3, gain: 1, makeupGain: 1.2 }, equalizer: eq({ 13: -1.5, 14: -2 }) }
    case 'karaoke':
      return { karaoke: { level: 1, monoLevel: 0.6, filterBand: 220, filterWidth: 120 } }
    case 'space':
      return { reverb: { mix: 0.45, roomSize: 0.7, damping: 0.35, wetLevel: 0.4, dryLevel: 0.9, width: 0.7 }, echo: { mix: 0.2, delay: 0.42, feedback: 0.3 } }
    case 'phone':
      return { highpass: { cutoff: 380 }, lowpass: { cutoff: 3400 }, distortion: { scale: 1.3 } }
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

function Fader({ frequency, gain, onChange }) {
  const db = gainDb(gain)
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="font-mono text-[10px] text-ink-300">{db > 0.5 ? '+' : ''}{db.toFixed(0)}</span>
      <input
        type="range"
        className="fader accent-amber"
        min={0}
        max={3}
        step={0.01}
        value={gain}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={`${frequency} Hz`}
      />
      <span className="text-[10px] text-ink-500">{frequency >= 1000 ? `${frequency / 1000}k` : frequency}</span>
    </div>
  )
}

function FilterCard({ filter, settings, onChange }) {
  const name = filter.name
  const label = LABELS[name] ?? name
  const params = filter.params ?? []
  const current = settings[name] ?? {}
  const engaged = Object.keys(current).length > 0 && params.some((param) => {
    const value = current[param.key]
    return value != null && JSON.stringify(value) !== JSON.stringify(param.default)
  })
  const toggle = () => onChange(name, engaged ? null : ENGAGE[name] ?? {})
  return (
    <div className={cx('rounded-xl border p-3 transition', engaged ? 'border-cyan-dim bg-cyan/[0.04]' : 'border-ink-700 bg-ink-900/40')}>
      <div className="flex items-center justify-between gap-2">
        <span className={cx('text-sm', engaged ? 'text-cyan' : 'text-ink-100')}>{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={engaged}
          onClick={toggle}
          className={cx('relative h-4 w-7 rounded-full border transition', engaged ? 'border-cyan-dim bg-cyan/60' : 'border-ink-600 bg-ink-700')}
        >
          <span className={cx('absolute top-0.5 h-2.5 w-2.5 rounded-full transition-all', engaged ? 'left-3.5 bg-ink-950' : 'left-0.5 bg-ink-300')} />
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
  const [stationId, setStationId] = useState(params.get('id') ?? '')
  const [settings, setSettings] = useState({})
  const [active, setActive] = useState([])
  const [state, setState] = useState('idle')
  const [error, setError] = useState(null)
  const timer = useRef(null)
  const dirty = useRef(false)

  useEffect(() => {
    if (!stationId && stations.length) setStationId(params.get('id') ?? stations[0].id)
  }, [stations, stationId, params])

  // Read the station's current chain when it is chosen.
  useEffect(() => {
    if (!stationId || !key) return
    owner(`/stations/${stationId}/filters`)
      .then((answer) => {
        setSettings(answer.settings ?? {})
        setActive(answer.active ?? [])
        setState('synced')
      })
      .catch((problem) => setError(problem.message))
  }, [stationId, key])

  const apply = useCallback(
    (next) => {
      if (!stationId) return
      dirty.current = true
      setState('saving')
      clearTimeout(timer.current)
      timer.current = setTimeout(async () => {
        try {
          const answer = await owner(`/stations/${stationId}/filters`, { method: 'POST', body: { filters: next } })
          setActive(answer.active ?? [])
          setState('live')
          setError(null)
        } catch (problem) {
          setError(problem.message)
          setState('error')
        }
      }, 350)
    },
    [stationId]
  )

  const setBand = (band, gain) => {
    const current = settings.equalizer?.bands ?? []
    const bands = current.filter((entry) => entry.band !== band)
    bands.push({ band, gain })
    const next = { ...settings, equalizer: { bands: bands.sort((a, b) => a.band - b.band) } }
    setSettings(next)
    apply(next)
  }

  const setFilter = (name, value) => {
    const next = { ...settings }
    if (value === null) delete next[name]
    else next[name] = value
    setSettings(next)
    apply(next)
  }

  const preset = (id) => {
    const next = id === 'off' ? {} : buildPreset(id)
    setSettings(next)
    apply(next)
  }

  const filters = (setup?.filters?.filters ?? []).filter((filter) => !HIDDEN.has(filter.name))
  const frequencies = setup?.filters?.bands ?? []
  const gains = useMemo(() => {
    const map = new Map((settings.equalizer?.bands ?? []).map((entry) => [entry.band, entry.gain]))
    return frequencies.map((_, band) => map.get(band) ?? 1)
  }, [settings, frequencies])
  const flat = gains.every((gain) => Math.abs(gain - 1) < 0.005)

  if (!stations.length) {
    return (
      <Panel title="Radio filters">
        <Empty>No stations yet: a filter chain belongs to a station. <Link href="/stations/" className="underline">Create one</Link>.</Empty>
      </Panel>
    )
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Radio filters</h1>
          <p className="mt-1 text-sm text-ink-300">Live DSP chain for one station: before the stream, and before the automix.</p>
        </div>
        <div className="flex items-center gap-2">
          <select className={cx(inputClass, 'w-44')} value={stationId} onChange={(event) => setStationId(event.target.value)}>
            {stations.map((station) => (
              <option key={station.id} value={station.id}>{station.name}</option>
            ))}
          </select>
          <Badge tone={state === 'error' ? 'rose' : state === 'saving' ? 'ink' : active.length ? 'cyan' : 'ink'}>
            {state === 'error' ? 'error' : state === 'saving' ? 'saving…' : active.length ? `${active.length} live` : 'bypassed'}
          </Badge>
        </div>
      </header>

      {!key && <KeyGate />}

      <KeyGate>
        <div className="space-y-4">
          <Panel title="Presets" subtitle="A preset replaces the whole chain. Nothing from the last one lingers.">
            <div className="flex flex-wrap gap-1.5">
              {PRESET_LIST.map((entry) => (
                <Button key={entry.id} size="sm" variant={entry.id === 'off' ? 'ghost' : 'default'} onClick={() => preset(entry.id)}>
                  {entry.label}
                </Button>
              ))}
            </div>
            {active.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] uppercase tracking-wider text-ink-300">chain</span>
                {active.map((name) => (
                  <Badge key={name} tone="cyan">{LABELS[name] ?? name}</Badge>
                ))}
              </div>
            )}
            {error && <p className="mt-2 text-xs text-rose">{error}</p>}
          </Panel>

          <Panel
            title="Equaliser"
            subtitle={flat ? 'Flat, every band at unity.' : 'Fifteen bands, an octave wide, aligned with the NodeLink centres.'}
            actions={<Button size="sm" variant="ghost" onClick={() => setFilter('equalizer', null)}>Flat</Button>}
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
    <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-ink-800/60" />}>
      <RackPage />
    </Suspense>
  )
}
