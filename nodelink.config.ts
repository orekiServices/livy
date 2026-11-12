/**
 * Minimal NodeLink config for the Livy docker-compose stack.
 * Keep `server.password` / `server.port` in sync with Livy's .env
 * (NODELINK_PASSWORD / NODELINK_PORT). See NodeLink's full config
 * reference: https://nodelink.js.org/docs/config
 */
export const config = {
  server: {
    host: '0.0.0.0',
    port: 3000,
    password: 'youshallnotpass',
  },
  search: {
    defaultSource: ['youtube', 'soundcloud'],
  },
  playback: {
    maxPlaylistLength: 100,
  },
};
