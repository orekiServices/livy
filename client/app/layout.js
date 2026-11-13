import './globals.css'

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#08090c'
}

export const metadata = {
  title: 'Livy — listen',
  description: 'The station in your pocket: what is on air, and any song you want next.',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
