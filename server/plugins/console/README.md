# Console plugin

The Next.js app in `../../../web` is exported to static files and installed here:

```bash
cd server && npm run build:web     # → server/plugins/console/public
```

The plugin mounts that folder at `/` with a single-page fallback, so `/owner/` and `/station/?id=…`
survive a hard refresh. Nothing else in the node knows the UI exists.

* **Switch it off** (Plugins panel, or `POST /api/v1/owner/plugins/console/disable`) and the node keeps
  broadcasting with no HTML attached — handy for a headless relay.
* **Mount it elsewhere** with `{"settings":{"mount":"/console"}}`.
* **Serve a different build** with `{"settings":{"dir":"/srv/my-console"}}` (absolute paths are fine).
