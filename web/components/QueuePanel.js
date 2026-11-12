'use client'

/**
 * The queue, in the order it will play, and draggable.
 *
 * Reordering a radio queue on a phone is the thing every web console gets
 * wrong: HTML5 drag-and-drop does not exist on touch, so this implements
 * both — pointer events for a finger, native drag for a mouse — and sends
 * the result as one `PATCH { order: [...] }` that the node applies
 * atomically. Nothing is lost if two people drag at once: ids the server
 * does not recognise are ignored and anything the console did not mention
 * keeps its place.
 */
import { useEffect, useRef, useState } from 'react'

import { owner } from '../lib/api.js'

const keyOf = (track, index) => `${track.id ?? track.url ?? track.title}#${index}`

export default function QueuePanel({ station, say }) {
  const [queue, setQueue] = useState([])
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(null)
  const [over, setOver] = useState(null)
  const listRef = useRef(null)

  const load = async () => {
    try {
      const payload = await owner(`/stations/${station}/queue`)
      setQueue(payload.queue ?? [])
    } catch (error) {
      say?.(error.message)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station])

  /* --------------------------- reordering ---------------------------- */

  const moveLocally = (from, to) => {
    setQueue((list) => {
      const next = [...list]
      const [item] = next.splice(from, 1)
      next.splice(Math.max(0, Math.min(next.length, to)), 0, item)
      return next
    })
  }

  const commit = async (list) => {
    setBusy(true)
    try {
      const payload = await owner(`/stations/${station}/queue`, {
        method: 'PATCH',
        body: { order: list.map((track) => track.id ?? track.url ?? track.title) }
      })
      setQueue(payload.queue ?? list)
    } catch (error) {
      say?.(error.message)
      load()
    } finally {
      setBusy(false)
    }
  }

  // Touch: track the finger, work out which row it is over, drop on release.
  const onPointerDown = (index) => (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDragging(index)
    setOver(index)
  }

  const onPointerMove = (event) => {
    if (dragging == null || !listRef.current) return
    const rows = [...listRef.current.querySelectorAll('[data-row]')]
    const y = event.clientY
    const target = rows.findIndex((row) => {
      const box = row.getBoundingClientRect()
      return y >= box.top && y <= box.bottom
    })
    if (target !== -1 && target !== over) setOver(target)
  }

  const onPointerUp = () => {
    if (dragging == null) return
    const from = dragging
    const to = over ?? dragging
    setDragging(null)
    setOver(null)
    if (from === to) return
    moveLocally(from, to)
    setQueue((list) => {
      commit(list)
      return list
    })
  }

  const act = async (label, request) => {
    setBusy(true)
    try {
      const payload = await request()
      setQueue(payload.queue ?? [])
      say?.(label)
      if (!payload.queue) load()
    } catch (error) {
      say?.(error.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <strong>{queue.length} queued</strong>
        {busy ? <span className="spin" /> : null}
        <div className="grow" />
        <button className="btn small" onClick={() => act('Shuffled', () => owner(`/stations/${station}/shuffle`, { method: 'POST' }))}>
          Shuffle
        </button>
        <button
          className="btn small ghost"
          onClick={() => act('Queue cleared', () => owner(`/stations/${station}/queue`, { method: 'DELETE' }))}
        >
          Clear
        </button>
      </div>

      <div className="stack" ref={listRef} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        {queue.map((track, index) => (
          <div
            key={keyOf(track, index)}
            data-row
            className={`queue-item ${dragging === index ? 'dragging' : ''} ${over === index && dragging != null && dragging !== index ? 'over' : ''}`}
            draggable
            onDragStart={() => setDragging(index)}
            onDragOver={(event) => {
              event.preventDefault()
              setOver(index)
            }}
            onDrop={() => {
              if (dragging != null && dragging !== index) {
                moveLocally(dragging, index)
                setQueue((list) => {
                  commit(list)
                  return list
                })
              }
              setDragging(null)
              setOver(null)
            }}
            onDragEnd={() => {
              setDragging(null)
              setOver(null)
            }}
          >
            <span className="handle" onPointerDown={onPointerDown(index)} aria-label="Drag to reorder">
              ⋮⋮
            </span>
            <span className="queue-index">{index + 1}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="truncate">{track.title}</div>
              <div className="dim truncate">
                {track.artist}
                {track.requestedBy ? ' · request' : ''}
              </div>
            </div>
            <button
              className="btn small ghost"
              title="Play next"
              onClick={() => act('Moved to the front', () => owner(`/stations/${station}/queue`, { method: 'PATCH', body: { next: index } }))}
            >
              ↑
            </button>
            <button
              className="btn small ghost"
              title="Remove"
              onClick={() => act('Removed', () => owner(`/stations/${station}/queue/${index}`, { method: 'DELETE' }).then(() => ({})))}
            >
              ✕
            </button>
          </div>
        ))}

        {queue.length === 0 ? <p className="dim">Nothing queued. The station plays its rotation.</p> : null}
      </div>
    </div>
  )
}
