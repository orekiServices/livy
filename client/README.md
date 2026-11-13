# Livy — listen

The minimalist listener app. One station, one screen: what is on air, and a
search field that plays any song in the catalogue.

Built with `create-next-app` (`--js --app --empty`) and exported as static
files under `basePath: '/listen'`, so the radio node serves it from its own
port — no second process, no proxy.

```bash
bun run build    # static export into out/
bun run dev      # UI only — the API is same-origin, so build and serve from the node to use it
```

`cd server && bun run build:web` builds this app and copies `out/` to
`server/plugins/console/public/listen`.
