'use client'

/**
 * Four tabs, filled when you are on them and outlined when you are not —
 * the YouTube Music convention, and the quickest way to answer "where am
 * I?" on a phone.
 */
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { HomeOn, HomeOff, SearchOn, SearchOff, LibraryOn, LibraryOff, StudioOn, StudioOff } from './icons.js'

const TABS = [
  { href: '/', on: HomeOn, off: HomeOff, label: 'Home' },
  { href: '/search/', on: SearchOn, off: SearchOff, label: 'Search' },
  { href: '/station/', on: LibraryOn, off: LibraryOff, label: 'Playing' },
  { href: '/owner/', on: StudioOn, off: StudioOff, label: 'Studio' }
]

export default function Tabs() {
  const path = usePathname() ?? '/'

  return (
    <nav className="tabs">
      {TABS.map((tab) => {
        const active = tab.href === '/' ? path === '/' : path.startsWith(tab.href)
        const Icon = active ? tab.on : tab.off
        return (
          <Link key={tab.href} href={tab.href} className={active ? 'on' : ''}>
            <Icon size={22} color={active ? '#f1f1f1' : '#717171'} />
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
