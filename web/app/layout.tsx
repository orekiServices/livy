import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

import RadioProvider from '../components/RadioProvider'
import Shell from '../components/Shell'

export const metadata: Metadata = {
  title: 'Livy',
  description: 'Broadcast desk for stations, seams, DSP filters, cache, and the learned DJ policy.',
  applicationName: 'Livy'
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0e1012' },
    { media: '(prefers-color-scheme: light)', color: '#f4f1ea' }
  ]
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <body className="min-h-full">
        <RadioProvider>
          <Shell>{children}</Shell>
        </RadioProvider>
      </body>
    </html>
  )
}
