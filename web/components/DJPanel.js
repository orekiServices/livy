'use client'

/**
 * The DJ booth.
 *
 * Everything about how this station mixes, in one place, with the one thing
 * the old settings form could never do: **you can hear it**. Pick a
 * transition, hit play, and the node renders that exact seam — same
 * beatmatcher, same ducker, same encoder — between two records and streams
 * it back. Choosing between ten transitions by name is guesswork;
 * auditioning them is a decision.
 *
 * Two external components earn their place here:
 *
 *   • [wavesurfer.js](https://wavesurfer.xyz) draws the rendered seam, so a
 *     crossfade is something you can *see* — where one record gives way to
 *     the other, where the roll starts, where the drop lands.
 *   • [Solar](https://www.figma.com/community/file/1166831539721848736) for
 *     the transport icons — the same family as the rest of the console,
 *     because a UI that mixes icon sets looks like three people built it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Waveform as AudioLines,
  Mixer as Blend,
  Mixer as Gauge,
  Play,
  Pause,
  RadioIcon as Radio,
  Refresh as RefreshCw,
  Refresh as Repeat,
  SkipNext as SkipForward,
  Note as Sparkles,
  Note as Timer
} from './icons.js'

import { api, nodeBase, owner, ownerKey } from '../lib/api.js'

const DESCRIPTIONS = {
  auto: 'The node picks, per seam',
  crossfade: 'Plain blend, level-matched',
  'bass-swap': 'Basslines change hands on a beat',
  filter: 'One sweeps out, the other opens up',
  echo: 'Cut into a beat-synced delay tail',
  sweep: 'Filtered-noise riser over the blend',
  wash: 'Dissolves into a reverb tail',
  roll: 'Beat-repeat halving into the handover',
  drop: 'Filtered away, a breath, then the downbeat',
  spindown: 'Tape stop, then the new song lands',
  slam: 'No overlap at all — a cut on a beat'
}

export default function DJPanel({ station, say }) {
  const [info, setInfo] = useState(null)
  const [form, setForm] = useState(null)
  const [effects, setEffects] = useState([])
  const [busy, setBusy] = useState(false)
  const [rendering, setRendering] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [previewOf, setPreviewOf] = useState(null)

  const waveRef = useRef(null)
  const waveHost = useRef(null)
  const urlRef = useRef(null)

  /* ------------------------------ state ----------------------------- */

  const load = useCallback(async () => {
    const [stationInfo, automix] = await Promise.all([owner(`/stations/${station}`), owner('/automix')])
    setInfo(stationInfo)
    setEffects(automix.effects ?? [])
    setForm({
      enabled: stationInfo.automix?.enabled !== false,
      effect: stationInfo.automix?.effect ?? 'auto',
      crossfadeMs: stationInfo.automix?.crossfadeMs ?? 6000,
      smart: stationInfo.automix?.smart !== false,
      beatmatch: stationInfo.automix?.beatmatch !== false,
      maxCrossfadeMs: stationInfo.automix?.maxCrossfadeMs ?? 30_000,
      dj: stationInfo.automix?.dj?.enabled !== false
    })
    return automix
  }, [station])

  useEffect(() => {
    load().catch((error) => say?.(error.message))
  }, [load, say])

  /* ---------------------------- waveform ---------------------------- */

  // wavesurfer is a DOM library: it has to be imported in the browser only,
  // and rebuilt whenever the element it draws into appears.
  useEffect(() => {
    let cancelled = false
    if (!waveHost.current) return undefined

    import('wavesurfer.js').then(({ default: WaveSurfer }) => {
      if (cancelled || !waveHost.current || waveRef.current) return
      waveRef.current = WaveSurfer.create({
        container: waveHost.current,
        height: 64,
        waveColor: 'rgba(255,255,255,0.28)',
        progressColor: '#ff4d6d',
        cursorColor: 'rgba(255,255,255,0.6)',
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        normalize: true
      })
      waveRef.current.on('play', () => setPlaying(true))
      waveRef.current.on('pause', () => setPlaying(false))
      waveRef.current.on('finish', () => setPlaying(false))
    })

    return () => {
      cancelled = true
      waveRef.current?.destroy()
      waveRef.current = null
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    }
  }, [])

  /* ----------------------------- actions ---------------------------- */

  const preview = async (effect) => {
    setRendering(effect)
    try {
      const base = await nodeBase()
      const res = await fetch(`${base}/api/v1/owner/automix/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-owner-key': ownerKey() ?? '' },
        body: JSON.stringify({
          effect,
          crossfadeMs: form.crossfadeMs,
          smart: form.smart,
          beatmatch: form.beatmatch,
          station
        })
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? `HTTP ${res.status}`)

      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      urlRef.current = URL.createObjectURL(await res.blob())
      setPreviewOf(res.headers.get('x-nodecast-effect') ?? effect)

      await waveRef.current?.load(urlRef.current)
      await waveRef.current?.play()
    } catch (error) {
      say?.(error.message)
    } finally {
      setRendering(null)
    }
  }

  const save = async () => {
    setBusy(true)
    try {
      await owner(`/stations/${station}/automix`, {
        method: 'POST',
        body: {
          enabled: form.enabled,
          effect: form.effect,
          crossfadeMs: Number(form.crossfadeMs),
          maxCrossfadeMs: Number(form.maxCrossfadeMs),
          smart: form.smart,
          beatmatch: form.beatmatch,
          dj: { enabled: form.dj }
        }
      })
      say?.('Mix updated')
      await load()
    } catch (error) {
      say?.(error.message)
    } finally {
      setBusy(false)
    }
  }

  const command = async (action, label) => {
    try {
      await owner(`/stations/${station}/${action}`, { method: 'POST' })
      say?.(label)
    } catch (error) {
      say?.(error.message)
    }
  }

  if (!form) return <span className="spin" />

  const last = info?.automix?.last

  return (
    <div>
      {/* ---- transport ------------------------------------------------ */}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn small grow" onClick={() => command('skip', 'Skipped')}>
          <SkipForward size={16} /> Skip
        </button>
        <button className="btn small grow" onClick={() => command('reload', 'Playlist reloaded')}>
          <RefreshCw size={16} /> Reload
        </button>
        <button className="btn small grow" onClick={() => setForm({ ...form, enabled: !form.enabled })}>
          <Blend size={16} /> Mix {form.enabled ? 'on' : 'off'}
        </button>
      </div>

      {/* ---- the audition --------------------------------------------- */}
      <div className="section-title">Audition</div>
      <div className="card">
        <div ref={waveHost} style={{ minHeight: 64 }} />
        <div className="row" style={{ marginTop: 10, gap: 8 }}>
          <button
            className="btn small"
            onClick={() => (playing ? waveRef.current?.pause() : waveRef.current?.play())}
            disabled={!previewOf}
          >
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <span className="dim">
            {previewOf ? (
              <>
                <AudioLines size={13} style={{ verticalAlign: '-2px' }} /> {previewOf} · {(form.crossfadeMs / 1000).toFixed(1)}s
              </>
            ) : (
              'Pick a transition below to hear it'
            )}
          </span>
        </div>
      </div>

      {/* ---- transitions ---------------------------------------------- */}
      <div className="section-title">Transitions</div>
      <div className="grid2">
        {effects.map((effect) => (
          <div
            key={effect}
            className="card"
            style={{ padding: '12px 14px', borderColor: form.effect === effect ? 'var(--accent)' : 'var(--line)' }}
          >
            <button onClick={() => setForm({ ...form, effect })} style={{ textAlign: 'left', width: '100%' }}>
              <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>
                {effect === 'auto' ? <Sparkles size={14} style={{ verticalAlign: '-2px' }} /> : null} {effect.replace('-', ' ')}
              </div>
              <div className="dim" style={{ fontSize: 12 }}>
                {DESCRIPTIONS[effect] ?? 'plugin transition'}
              </div>
            </button>
            <button className="btn small ghost" style={{ marginTop: 8 }} onClick={() => preview(effect)} disabled={rendering !== null}>
              {rendering === effect ? <span className="spin" /> : <Play size={14} />} Hear it
            </button>
          </div>
        ))}
      </div>

      {/* ---- blend ----------------------------------------------------- */}
      <div className="section-title">Blend</div>
      <div className="card">
        <label className="field">
          <Timer size={13} style={{ verticalAlign: '-2px' }} /> Crossfade — {(form.crossfadeMs / 1000).toFixed(1)}s
        </label>
        <input
          type="range"
          min="1000"
          max="30000"
          step="250"
          value={form.crossfadeMs}
          onChange={(event) => setForm({ ...form, crossfadeMs: Number(event.target.value) })}
          style={{ width: '100%' }}
        />

        <label className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
          <span>
            <Sparkles size={14} style={{ verticalAlign: '-2px' }} /> Smart length — let the seam decide
          </span>
          <input type="checkbox" checked={form.smart} onChange={(event) => setForm({ ...form, smart: event.target.checked })} />
        </label>

        {form.smart ? (
          <>
            <label className="field" style={{ marginTop: 10 }}>
              Never longer than {(form.maxCrossfadeMs / 1000).toFixed(0)}s
            </label>
            <input
              type="range"
              min="4000"
              max="60000"
              step="1000"
              value={form.maxCrossfadeMs}
              onChange={(event) => setForm({ ...form, maxCrossfadeMs: Number(event.target.value) })}
              style={{ width: '100%' }}
            />
          </>
        ) : null}

        <label className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
          <span>
            <Gauge size={14} style={{ verticalAlign: '-2px' }} /> Beatmatch (time-stretch + phase-lock)
          </span>
          <input type="checkbox" checked={form.beatmatch} onChange={(event) => setForm({ ...form, beatmatch: event.target.checked })} />
        </label>

        <label className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
          <span>
            <Radio size={14} style={{ verticalAlign: '-2px' }} /> DJ voice over the seam
          </span>
          <input type="checkbox" checked={form.dj} onChange={(event) => setForm({ ...form, dj: event.target.checked })} />
        </label>
      </div>

      {/* ---- what happened last time ----------------------------------- */}
      {last ? (
        <>
          <div className="section-title">Last seam</div>
          <div className="card dim" style={{ fontSize: 13, lineHeight: 1.7 }}>
            <div>
              <strong style={{ color: 'var(--text)', textTransform: 'capitalize' }}>{last.effect?.replace('-', ' ')}</strong>
              {last.chosen ? ' · chosen for the seam' : ' · pinned'} · {last.blendMs}ms
              {last.blend?.bars ? ` (${last.blend.bars} bars)` : ''}
            </div>
            {last.blend?.why ? <div>why: {last.blend.why}</div> : null}
            {last.beat?.matched ? (
              <div>
                <Repeat size={12} style={{ verticalAlign: '-2px' }} /> beatmatched {Math.round(last.beat.bpm)} →{' '}
                {Math.round(last.beat.playedAtBpm)} BPM ({last.beat.stretchPercent > 0 ? '+' : ''}
                {last.beat.stretchPercent}%)
              </div>
            ) : null}
            <div>
              “{last.from}” → “{last.to}”
            </div>
          </div>
        </>
      ) : null}

      <button className="btn primary block" style={{ marginTop: 16 }} onClick={save} disabled={busy}>
        {busy ? <span className="spin" /> : 'Save'}
      </button>
    </div>
  )
}
