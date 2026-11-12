'use client'

import { useRadio } from './RadioProvider.js'
import { RadioIcon } from './icons.js'

/** Who you are listening to, and whether the node is actually there. */
export default function TopBar({ title, subtitle, action = null }) {
  const { connected, stats } = useRadio()
  return (
    <header className="topbar">
      <div style={{ minWidth: 0 }}>
        <h1 className="truncate">{title ?? 'Nodecast'}</h1>
        <div className="sub truncate">
          {subtitle ?? (stats ? `${stats.playing}/${stats.stations} on air · ${stats.listeners} listening` : 'multi-station mp3 radio')}
        </div>
      </div>
      <div className="grow" />
      {action}
      <span className="icon-btn" title={connected ? 'live control connection' : 'reconnecting'} aria-label="connection">
        <RadioIcon size={20} color={connected ? '#2ba640' : '#717171'} />
      </span>
    </header>
  )
}
