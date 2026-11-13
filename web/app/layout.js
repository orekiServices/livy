import './globals.css'

import RadioProvider from '../components/RadioProvider.js'
import Shell from '../components/Shell.js'

export const metadata = {
  title: 'Livy',
  description: 'Stations, seams, filters and the learned DJ policy for this Livy radio node.',
  applicationName: 'Livy'
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0c0e12'
}

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">
        <RadioProvider>
          <Shell>{children}</Shell>
        </RadioProvider>
      </body>
    </html>
  )
}
