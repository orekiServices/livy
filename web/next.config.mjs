/** @type {import('next').NextConfig} */

/**
 * Livy console — a *static* Next export, built with create-next-app.
 *
 * `next build` writes plain HTML/CSS/JS to `web/out`, which the radio node
 * serves from its own port. One process, one origin, no Node runtime for the
 * UI, no server-side environment to leak — and the console can equally be
 * dropped on any static host and pointed at a node with `?node=`.
 */
const nextConfig = {
  output: 'export',
  reactStrictMode: true,
  trailingSlash: true,
  // No image optimiser in a static export; artwork comes straight from the
  // provider CDNs through plain <img>.
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

export default nextConfig
