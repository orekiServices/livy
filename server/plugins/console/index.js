/**
 * Livy console — the web app, as a plugin.
 *
 * The UI used to be baked into the node. It is not any more: this plugin owns
 * the static export (`public/`, built by `bun run build:web`) and mounts it on
 * the node's own port. Switch the plugin off and the node is a pure broadcast
 * API with no HTML attached; switch it on and the console is back, same
 * origin, same process, no second server and nothing to proxy.
 *
 * Boot is deliberately forgiving. A fresh clone has no `public/` yet — the
 * node still comes up, the mount answers with a page that says exactly what to
 * run, and the moment the build appears it is picked up **without a restart**.
 * A missing UI is a thing to explain, not a reason to fail to start.
 */
import fs from 'node:fs'
import path from 'node:path'

export const manifest = {
  name: 'Web console',
  version: '1.1.0',
  description: 'the Livy web UI — station wall, station pages and owner console, served from this node',
  scope: 'global'
}

/** Recursively measure the build so the plugin can report it honestly. */
function measure(dir) {
  let files = 0
  let bytes = 0
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        files += 1
        bytes += fs.statSync(full).size
      }
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return { files, kb: Math.round(bytes / 102.4) / 10 }
}

const isBuilt = (dir) => fs.existsSync(path.join(dir, 'index.html'))

/**
 * The stand-in page. No external CSS, fonts or scripts: it has to render in a
 * sandboxed preview, an offline container and a browser pointed at a node that
 * has nothing else to serve.
 */
function placeholder({ version, port, stations }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>Livy · console not built</title>
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#07080c;
         color:#eef1f7; font:16px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif }
  .card { width:min(680px,92vw); padding:34px 34px 28px; border:1px solid rgba(255,255,255,.12);
          border-radius:18px; background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.02));
          box-shadow:0 30px 80px rgba(0,0,0,.5) }
  h1 { margin:0 0 6px; font-size:24px; letter-spacing:-.4px }
  p { margin:0 0 14px; color:#98a0b4 }
  code, pre { font-family:ui-monospace,Menlo,monospace }
  pre { margin:0 0 16px; padding:14px 16px; border-radius:12px; background:rgba(0,0,0,.45);
        border:1px solid rgba(255,255,255,.1); overflow:auto; color:#3ddc97 }
  .tag { display:inline-flex; align-items:center; gap:8px; padding:5px 11px; border-radius:999px;
         border:1px solid rgba(255,122,61,.5); background:rgba(255,122,61,.12); color:#ff7a3d;
         font-size:12px; letter-spacing:2px; text-transform:uppercase; font-weight:700 }
  ul { margin:0; padding-left:18px; color:#98a0b4 } li { margin:4px 0 }
  a { color:#ff7a3d }
  .row { display:flex; gap:10px; flex-wrap:wrap; margin-top:18px; font-size:13px; color:#6f7789 }
</style></head>
<body><main class="card">
  <span class="tag">● on air · no ui</span>
  <h1>The radio is running. The console is not built yet.</h1>
  <p>Livy ${version} is broadcasting on port ${port} with ${stations} station${stations === 1 ? '' : 's'}.
     The web console ships as a plugin and its static build is missing, so there is nothing to show here yet.</p>
  <pre>cd server
bun run build:web</pre>
  <p>This page refreshes every five seconds and the node picks the build up on its own — no restart.</p>
  <ul>
    <li>The API is unaffected: <a href="/api/v1/info">/api/v1/info</a>, <a href="/health">/health</a></li>
    <li>Streams are unaffected: <code>/stream/&lt;station&gt;</code></li>
    <li>Prefer a headless node? Disable the <code>console</code> plugin and this page goes away too.</li>
  </ul>
  <div class="row"><span>Livy ${version}</span><span>·</span><span>console plugin</span></div>
</main></body></html>`
}

export default function setup(ctx) {
  const dir = path.join(ctx.dir, ctx.settings.dir ?? 'public')
  const mount = ctx.settings.mount ?? '/'
  const built = () => isBuilt(dir)

  // spa: true — /owner/ and /station/ are client-side routes and must
  // survive a hard refresh; asset paths still 404 properly.
  // optional: true — no build is a state, not a crash.
  const handle = ctx.registerStatic(built() ? dir : null, {
    mount,
    spa: true,
    optional: true,
    fallback: ({ req, res, path: rel }) => {
      // Assets must keep 404ing, or a broken build looks like a working one.
      if (path.extname(rel)) return false
      const body = placeholder({
        version: ctx.config.version,
        port: ctx.config.port,
        stations: ctx.stations.every().length
      })
      res.writeHead(req.method === 'HEAD' ? 200 : 503, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': '5'
      })
      res.end(req.method === 'HEAD' ? undefined : body)
      return true
    }
  })

  let build = built() ? measure(dir) : { files: 0, kb: 0 }

  if (built()) {
    ctx.log.info(`console mounted at ${handle.mount}`, { files: build.files, kb: build.kb })
  } else {
    ctx.log.warn(`no console build yet — serving the "run bun run build:web" page at ${handle.mount}`)
  }

  // Watch for the build appearing (or being deleted) and follow it live.
  ctx.every(3000, () => {
    const nowBuilt = built()
    if (nowBuilt === handle.serving()) return
    handle.setDir(nowBuilt ? dir : null)
    build = nowBuilt ? measure(dir) : { files: 0, kb: 0 }
    if (nowBuilt) ctx.log.info(`console build appeared — now serving it at ${handle.mount}`, { files: build.files, kb: build.kb })
    else ctx.log.warn('the console build vanished — back to the placeholder page')
  })

  ctx.registerRoute('GET', '/', ({ res, send }) =>
    send(res, 200, {
      mount: handle.mount,
      built: handle.serving(),
      build,
      pages: ['/', '/listen/', '/station/', '/owner/'],
      builtWith: 'next export',
      ...(handle.serving() ? {} : { hint: 'run `bun run build:web` in server/ — the node picks it up within a few seconds' }),
      note: 'switch this plugin off to run the node headless (API + MP3 only)'
    })
  )

  return () => ctx.log.info('console unmounted — this node is now API only')
}
