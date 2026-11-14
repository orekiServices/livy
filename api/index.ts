/**
 * Vercel Function entry point (TypeScript).
 *
 * One function, the whole REST surface. Vercel routes every unmatched request
 * here (`vercel.json` → `rewrites`), and the Livy request handler decides what
 * it is — the console, `/api/v1/…`, an ICY stream, or a static asset from the
 * bundled console plugin.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
  const { handleRequest } = await import('../server/src/index.ts')
  return handleRequest(request, response)
}

export const config = {
  maxDuration: 300
}
