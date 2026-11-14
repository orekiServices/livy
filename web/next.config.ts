import type { NextConfig } from 'next'

/**
 * Livy console, in two shapes.
 *
 * **Static export** (default) — `next build` writes plain HTML/CSS/JS to
 * `web/out`, the radio node serves it from its own port. One process, one
 * origin, no Node runtime for the UI, and the console can be dropped on any
 * static host and pointed at a node with `?node=`.
 *
 * **Next server** — `LIVY_CONSOLE_SERVER=1 next build && next start` runs the
 * console as its own process with a Node runtime behind it, proxying `/api`
 * and `/stream` to a node that lives elsewhere. Kept in a separate `distDir`
 * so the two builds never overwrite each other.
 */
const serverMode = process.env.LIVY_CONSOLE_SERVER === '1'
const node = (process.env.LIVY_NODE ?? 'http://127.0.0.1:2399').replace(/\/$/, '')

const shared: NextConfig = {
  reactStrictMode: true,
  images: { unoptimized: true },
  productionBrowserSourceMaps: false,
  allowedDevOrigins: ['*.e2b.app', '*.app.github.dev', '*.gitpod.io'],
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css'
      }
    }
  }
}

const staticExport: NextConfig = {
  ...shared,
  output: 'export',
  trailingSlash: true
}

const nextServer: NextConfig = {
  ...shared,
  distDir: '.next-server',
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${node}/api/:path*` },
      { source: '/stream/:path*', destination: `${node}/stream/:path*` }
    ]
  }
}

const nextConfig: NextConfig = serverMode ? nextServer : staticExport

export default nextConfig
