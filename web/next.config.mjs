/** @type {import('next').NextConfig} */

/**
 * Nodecast console — a *static* Next export.
 *
 * `next build` writes plain HTML/CSS/JS to web/out, which the radio node
 * serves from its own port. That means: one process, one origin, no Node
 * runtime for the UI, no server-side environment to leak, and the console can
 * equally be dropped on any static host and pointed at a node with ?node=.
 */
const nextConfig = {
  output: 'export',
  reactStrictMode: false,
  trailingSlash: true,
  // No image optimiser in a static export; artwork comes straight from the
  // provider CDNs via plain <img>.
  images: { unoptimized: true },
  // Client bundles ship without source maps: the console is a product, not a
  // copy of the codebase.
  productionBrowserSourceMaps: false,
  allowedDevOrigins: ['*.e2b.app', '*.app.github.dev', '*.gitpod.io']
}

export default nextConfig
