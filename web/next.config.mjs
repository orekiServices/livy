/** @type {import('next').NextConfig} */

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
 * and `/stream` to a node that lives elsewhere. Same app, same code; the only
 * difference is that the proxy is the server's job instead of the node's.
 * Kept in a separate `distDir` so the two builds never overwrite each other.
 */
const serverMode = process.env.LIVY_CONSOLE_SERVER === '1'
/** Where the node is when the console runs on its own. Loopback by default. */
const node = (process.env.LIVY_NODE ?? 'http://127.0.0.1:2399').replace(/\/$/, '')

const shared = {
  reactStrictMode: true,
  // Artwork comes straight from the provider CDNs through plain <img>.
  images: { unoptimized: true },
  // The console is a product, not a copy of the codebase.
  productionBrowserSourceMaps: false,
  // Dev server on the sandbox preview host, and the usual tunnels.
  allowedDevOrigins: ['*.e2b.app', '*.app.github.dev', '*.gitpod.io'],
  turbopack: {
    rules: {
      '*.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' }
    }
  }
}

const staticExport = {
  ...shared,
  output: 'export',
  trailingSlash: true
}

const nextServer = {
  ...shared,
  distDir: '.next-server',
  // Long-lived streams and proxied audio must not be cached or buffered by
  // the framework between the listener and the node.
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${node}/api/:path*` },
      { source: '/stream/:path*', destination: `${node}/stream/:path*` },
      // The listener app is a separate static build the node ships; in server
      // mode the console fronts it too, so one URL still has both halves.
      { source: '/listen', destination: `${node}/listen/` },
      { source: '/listen/:path*', destination: `${node}/listen/:path*` }
    ]
  }
}

export default serverMode ? nextServer : staticExport
