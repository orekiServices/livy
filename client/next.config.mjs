/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  basePath: '/listen',
  images: { unoptimized: true }
}

export default nextConfig
