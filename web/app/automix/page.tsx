'use client'

/**
 * Standalone MP3-to-MP3 transition editor. It never reads a station, source,
 * queue, or the persistent broadcast player.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'

import { Badge, Button, Field, KeyGate, PageHeading, Panel, cx, inputClass } from '../../components/ui'
import { ownerAutomixEditor } from '../../lib/api'

const MAX_MP3_BYTES = 12 * 1024 * 1024

type InputMode = 'file' | 'url'
type TrackDraft = {
  mode: InputMode
  file: File | null
  url: string
  title: string
  artist: string
}
type RenderedTransition = {
  url: string
  size: number
  report: Record<string, unknown>
}

const blankTrack = (): TrackDraft => ({ mode: 'file', file: null, url: '', title: '', artist: '' })

function clock(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function fileSize(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 1024 * 1024 ? 1 : 2)} MiB`
}

function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
    reader.onload = () => {
      const value = String(reader.result ?? '')
      const comma = value.indexOf(',')
      if (comma < 0) return reject(new Error(`Could not read ${file.name} as an MP3.`))
      resolve(value.slice(comma + 1))
    }
    reader.readAsDataURL(file)
  })
}

async function requestTrack(track: TrackDraft, label: string) {
  const common = {
    ...(track.title.trim() ? { title: track.title.trim() } : {}),
    ...(track.artist.trim() ? { artist: track.artist.trim() } : {})
  }
  if (track.mode === 'file') {
    if (!track.file) throw new Error(`Choose an outgoing or incoming MP3 file for ${label}.`)
    if (!/\.mp3$/i.test(track.file.name)) throw new Error(`${label} must be an .mp3 file.`)
    if (track.file.size > MAX_MP3_BYTES) throw new Error(`Each MP3 must be 12 MiB or smaller.`)
    return { ...common, name: track.file.name, base64: await readFileBase64(track.file) }
  }

  const url = track.url.trim()
  if (!url) throw new Error(`Enter a direct MP3 link for ${label}.`)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${label} needs a full HTTP or HTTPS URL.`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${label} links must use HTTP or HTTPS.`)
  return { ...common, url }
}

function TrackInput({
  id,
  label,
  draft,
  onChange,
  onEdit
}: {
  id: string
  label: string
  draft: TrackDraft
  onChange: (next: TrackDraft) => void
  onEdit: () => void
}) {
  const [fileError, setFileError] = useState<string | null>(null)
  const update = (patch: Partial<TrackDraft>) => {
    onEdit()
    onChange({ ...draft, ...patch })
  }
  const chooseMode = (mode: InputMode) => {
    if (mode === draft.mode) return
    setFileError(null)
    update({ mode, file: null, url: '' })
  }
  const selectFile = (file: File | null) => {
    setFileError(null)
    if (!file) {
      update({ file: null })
      return
    }
    if (!/\.mp3$/i.test(file.name)) {
      setFileError('Choose an .mp3 file. Other audio formats are not accepted.')
      update({ file: null })
      return
    }
    if (file.size > MAX_MP3_BYTES) {
      setFileError('That file is over the 12 MiB limit.')
      update({ file: null })
      return
    }
    update({ file })
  }

  return (
    <Panel title={label} subtitle={id === 'outgoing' ? 'Livy reads only the end of this MP3.' : 'Livy reads only the start of this MP3.'}>
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-ink-200">Provide this track as</legend>
        <div className="flex flex-wrap gap-4">
          <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-xs text-ink-200">
            <input
              type="radio"
              name={`${id}-mode`}
              value="file"
              checked={draft.mode === 'file'}
              onChange={() => chooseMode('file')}
              className="accent-amber"
            />
            MP3 file
          </label>
          <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-xs text-ink-200">
            <input
              type="radio"
              name={`${id}-mode`}
              value="url"
              checked={draft.mode === 'url'}
              onChange={() => chooseMode('url')}
              className="accent-amber"
            />
            Direct MP3 link
          </label>
        </div>
      </fieldset>

      {draft.mode === 'file' ? (
        <div className="mt-2">
          <label htmlFor={`${id}-file`} className="mb-1.5 block text-xs font-medium text-ink-200">
            MP3 file <span className="text-ink-500">· up to 12 MiB</span>
          </label>
          <input
            id={`${id}-file`}
            type="file"
            accept=".mp3,audio/mpeg,audio/mp3"
            onChange={(event) => {
              const input = event.currentTarget
              const file = input.files?.[0] ?? null
              selectFile(file)
              if (file && (!/\.mp3$/i.test(file.name) || file.size > MAX_MP3_BYTES)) input.value = ''
            }}
            className={cx(inputClass, 'cursor-pointer file:mr-3 file:cursor-pointer file:border-0 file:bg-transparent file:text-xs file:font-medium file:text-amber')}
          />
          {draft.file && <p className="mt-1.5 truncate text-2xs text-ink-300">{draft.file.name} · {fileSize(draft.file.size)}</p>}
          {fileError && <p role="alert" className="mt-1.5 text-xs text-rose">{fileError}</p>}
        </div>
      ) : (
        <Field label="Direct MP3 link" hint="Public HTTP or HTTPS only; Livy fetches it server-side, up to 12 MiB.">
          <input
            type="url"
            inputMode="url"
            autoComplete="url"
            value={draft.url}
            onChange={(event) => update({ url: event.target.value })}
            placeholder="https://example.com/track.mp3"
            className={inputClass}
          />
        </Field>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Track title" hint="Optional, for the render report.">
          <input
            value={draft.title}
            maxLength={160}
            onChange={(event) => update({ title: event.target.value })}
            placeholder={id === 'outgoing' ? 'Outgoing track' : 'Incoming track'}
            className={inputClass}
          />
        </Field>
        <Field label="Artist" hint="Optional.">
          <input
            value={draft.artist}
            maxLength={160}
            onChange={(event) => update({ artist: event.target.value })}
            placeholder="Artist name"
            className={inputClass}
          />
        </Field>
      </div>
    </Panel>
  )
}

export default function AutomixEditorPage() {
  const [outgoing, setOutgoing] = useState<TrackDraft>(blankTrack)
  const [incoming, setIncoming] = useState<TrackDraft>(blankTrack)
  const [crossfadeMs, setCrossfadeMs] = useState(12_000)
  const [preRollMs, setPreRollMs] = useState(3000)
  const [bitrate, setBitrate] = useState(128)
  const [curve, setCurve] = useState('auto')
  const [smart, setSmart] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RenderedTransition | null>(null)
  const controller = useRef<AbortController | null>(null)
  const resultUrl = useRef<string | null>(null)

  const clearResult = () => {
    controller.current?.abort()
    controller.current = null
    if (resultUrl.current) URL.revokeObjectURL(resultUrl.current)
    resultUrl.current = null
    setResult(null)
    setError(null)
    setBusy(false)
  }

  useEffect(() => () => {
    controller.current?.abort()
    if (resultUrl.current) URL.revokeObjectURL(resultUrl.current)
  }, [])

  const setCrossfade = (value: number) => {
    clearResult()
    setCrossfadeMs(value)
  }
  const setPreRoll = (value: number) => {
    clearResult()
    setPreRollMs(value)
  }

  const ready = (track: TrackDraft) => track.mode === 'file' ? Boolean(track.file) : Boolean(track.url.trim())

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    clearResult()
    setBusy(true)
    setError(null)
    const active = new AbortController()
    controller.current = active
    try {
      const [outgoingInput, incomingInput] = await Promise.all([
        requestTrack(outgoing, 'outgoing'),
        requestTrack(incoming, 'incoming')
      ])
      if (active.signal.aborted) return
      const rendered = await ownerAutomixEditor({
        outgoing: outgoingInput,
        incoming: incomingInput,
        options: { crossfadeMs, preRollMs, bitrate, curve, smart }
      }, active.signal)
      if (active.signal.aborted) return
      const url = URL.createObjectURL(rendered.mp3)
      resultUrl.current = url
      setResult({ url, size: rendered.mp3.size, report: rendered.report })
    } catch (problem) {
      if (!active.signal.aborted && (problem as Error)?.name !== 'AbortError') {
        setError((problem as Error).message || 'Could not render the transition.')
      }
    } finally {
      if (controller.current === active) {
        controller.current = null
        setBusy(false)
      }
    }
  }

  return (
    <div className="space-y-4">
      <PageHeading
        eyebrow="Audio desk · standalone"
        title="Automix Editor"
        subtitle="Build and audition one outgoing-to-incoming transition from your own MP3s. No station, queue, or music-source catalog is involved."
      />

      <KeyGate title="Unlock the Automix Editor">
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <TrackInput id="outgoing" label="Outgoing track" draft={outgoing} onChange={setOutgoing} onEdit={clearResult} />
            <TrackInput id="incoming" label="Incoming track" draft={incoming} onChange={setIncoming} onEdit={clearResult} />
          </div>

          <Panel title="Transition" subtitle="The rendered clip moves only from the outgoing track’s end to the incoming track’s start.">
            <div className="grid gap-5 md:grid-cols-2">
              <div>
                <label htmlFor="crossfade" className="flex items-center justify-between gap-3 text-xs">
                  <span className="font-medium text-ink-200">Crossfade length</span>
                  <span className="font-mono text-ink-100">{(crossfadeMs / 1000).toFixed(crossfadeMs % 1000 ? 1 : 0)} s</span>
                </label>
                <input
                  id="crossfade"
                  aria-label="Crossfade length"
                  type="range"
                  min={500}
                  max={30000}
                  step={500}
                  value={crossfadeMs}
                  onChange={(event) => setCrossfade(Number(event.target.value))}
                  className="mt-2 w-full accent-amber"
                />
                <div className="flex justify-between text-2xs text-ink-500"><span>0.5 s</span><span>30 s</span></div>
              </div>
              <div>
                <label htmlFor="pre-roll" className="flex items-center justify-between gap-3 text-xs">
                  <span className="font-medium text-ink-200">Outgoing pre-roll</span>
                  <span className="font-mono text-ink-100">{(preRollMs / 1000).toFixed(preRollMs % 1000 ? 1 : 0)} s</span>
                </label>
                <input
                  id="pre-roll"
                  aria-label="Outgoing pre-roll"
                  type="range"
                  min={0}
                  max={10000}
                  step={500}
                  value={preRollMs}
                  onChange={(event) => setPreRoll(Number(event.target.value))}
                  className="mt-2 w-full accent-amber"
                />
                <div className="flex justify-between text-2xs text-ink-500"><span>0 s</span><span>10 s</span></div>
              </div>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-3">
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-ink-200">
                <input
                  type="checkbox"
                  checked={smart}
                  onChange={(event) => { clearResult(); setSmart(event.target.checked) }}
                  className="h-4 w-4 accent-amber"
                />
                Smart seam timing
              </label>
              <Field label="Fade curve">
                <select value={curve} onChange={(event) => { clearResult(); setCurve(event.target.value) }} className={inputClass}>
                  <option value="auto">Automatic</option>
                  <option value="equal-power">Equal power</option>
                  <option value="equal-gain">Equal gain</option>
                </select>
              </Field>
              <Field label="Output bitrate">
                <select value={bitrate} onChange={(event) => { clearResult(); setBitrate(Number(event.target.value)) }} className={inputClass}>
                  {[96, 128, 192, 256, 320].map((rate) => <option key={rate} value={rate}>{rate} kbps</option>)}
                </select>
              </Field>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" size="lg" disabled={busy || !ready(outgoing) || !ready(incoming)}>
                {busy ? 'Rendering transition…' : 'Render transition'}
              </Button>
              <span className="text-xs text-ink-500">Each source MP3 is limited to 12 MiB.</span>
            </div>
          </Panel>
        </form>

        {error && (
          <Panel title="Could not render" className="border-rose/40">
            <p role="alert" className="text-sm text-rose">{error}</p>
          </Panel>
        )}

        {busy && (
          <Panel title="Rendering your transition" subtitle="The server is fetching or reading both MP3s and rendering a short seam. This does not change station playback.">
            <div className="h-1.5 overflow-hidden rounded bg-ink-800" aria-hidden="true"><div className="h-full w-1/3 animate-pulse rounded bg-amber" /></div>
          </Panel>
        )}

        {result ? (
          <Panel
            title="Transition ready"
            subtitle={`${clock(Number(result.report.durationMs ?? 0))} output · ${(result.size / 1024).toFixed(0)} KiB`}
            actions={<Badge tone="lime">MP3</Badge>}
          >
            <div className="space-y-3">
              <p className="text-sm text-ink-200">
                <span className="font-medium">{String(result.report.from ?? (outgoing.title || 'Outgoing'))}</span>
                <span className="mx-2 text-amber" aria-label="to">→</span>
                <span className="font-medium">{String(result.report.to ?? (incoming.title || 'Incoming'))}</span>
              </p>
              <p className="text-xs text-ink-500">
                {Number(result.report.blendMs ?? 0) > 0 ? `${(Number(result.report.blendMs) / 1000).toFixed(1)} s crossfade` : 'Crossfade rendered'}
                {Number(result.report.preRollMs ?? 0) > 0 ? ` · ${clock(Number(result.report.preRollMs))} outgoing pre-roll` : ''}
                {result.report.curve ? ` · ${String(result.report.curve)} curve` : ''}
              </p>
              <audio controls preload="metadata" src={result.url} className="w-full" aria-label="Audition Automix transition" />
              <a
                href={result.url}
                download="livy-automix-transition.mp3"
                className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-amber bg-amber px-4 py-2.5 text-sm font-semibold text-amber-ink transition-opacity hover:opacity-90"
              >
                Download transition MP3
              </a>
            </div>
          </Panel>
        ) : !busy && !error ? (
          <Panel title="Your render stays yours" subtitle="The editor never auditions through the broadcast player.">
            <p className="text-sm text-ink-300">
              Choose two MP3s or direct links, adjust the seam, and render. Uploaded files and downloaded link audio are kept in a temporary directory only while rendering, then deleted.
            </p>
          </Panel>
        ) : null}
      </KeyGate>
    </div>
  )
}
