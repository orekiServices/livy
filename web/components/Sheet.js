'use client'

import { useEffect } from 'react'

/**
 * A bottom sheet — the phone's answer to a dialog. Anything the studio does
 * that needs a form happens in one of these: it slides up from the thumb,
 * it can be dismissed by tapping away, and on a wide screen it becomes an
 * ordinary centred panel.
 */
export default function Sheet({ open, title, onClose, children }) {
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => event.key === 'Escape' && onClose?.()
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <section className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="grabber" />
        {title ? (
          <div className="row" style={{ marginBottom: 12 }}>
            <strong style={{ fontSize: 17 }}>{title}</strong>
            <div className="grow" />
            <button className="btn small ghost" onClick={onClose}>
              Done
            </button>
          </div>
        ) : null}
        {children}
      </section>
    </>
  )
}
