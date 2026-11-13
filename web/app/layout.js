import './globals.css'

import RadioProvider from '../components/RadioProvider.js'
import PlayerBar from '../components/PlayerBar.js'
import Tabs from '../components/Tabs.js'

export const metadata = {
  title: 'Livy',
  description: 'A lightweight radio node: many stations, one process, beatmatched automix, streamed as plain MP3.',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Livy' }
}

/* Phone first: fill the notch, lock the zoom to something sane, dark UI. */
export const viewport = {
  themeColor: '#07070b',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover'
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <RadioProvider>
          <div className="app">{children}</div>
          <PlayerBar />
          <Tabs />
        </RadioProvider>
      </body>
    </html>
  )
}
