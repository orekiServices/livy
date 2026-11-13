/**
 * Vercel Function entry point.
 *
 * One function, the whole REST surface. Vercel routes every unmatched request
 * here (`vercel.json` → `rewrites`), and the Livy request handler decides what
 * it is — the console, `/api/v1/…`, an ICY stream, a static asset from the
 * bundled console plugin.
 *
 * The import is dynamic and the module is CommonJS on purpose: Vercel's Node
 * runtime loads this file as CJS by default, and a static `import` of an ESM
 * package from a CJS file is a build error rather than a runtime one.
 *
 * What works on Vercel, and what does not:
 *
 *   ✓ the web console, every REST endpoint, search and resolution
 *   ✓ station/queue/automix/filter management (state is per-instance)
 *   ✓ one-shot automix and filter rendering (CPU work in a request)
 *   ✗ continuous ICY streaming — a function has no long-lived socket
 *   ✗ WebSocket events — an upgrade cannot outlive the invocation
 *   ✗ persistence — the bundle is read-only and /tmp is per-instance
 *
 * For the real thing — a station that stays on air — run the node on a
 * container or a VM: `npm start` in `server/`.
 */
module.exports = async function handler(request, response) {
  const { handleRequest } = await import('../server/src/index.js')
  return handleRequest(request, response)
}

module.exports.config = {
  // Audio work — decoding, an automix seam, a filter chain over a track — is
  // CPU-bound, and 300 s is the Hobby ceiling. Pro/Enterprise deployments can
  // raise this in vercel.json without touching the code.
  maxDuration: 300
}
