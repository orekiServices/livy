/**
 * Livy configuration — loaded from environment variables (see .env.example).
 *
 * NodeLink defaults differ from Lavalink: NodeLink listens on port 3000
 * (Lavalink uses 2333). Hard-coding 2333 was one of the original NodeCast
 * bugs, so the port is configurable and defaults to NodeLink's 3000.
 */
import 'dotenv/config';

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function int(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Parse the multi-node format:
 *   identifier,host,port,password,secure;identifier,host,port,password,secure
 * e.g. "main,127.0.0.1,3000,youshallnotpass,false;backup,10.0.0.2,3000,pw,true"
 */
export function parseNodes(raw) {
  if (!raw || !String(raw).trim()) return null;

  const nodes = String(raw)
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [identifier, hostname, port, password, secure] = entry.split(',').map((s) => s?.trim());
      if (!hostname || !password) {
        throw new Error(`Invalid NODELINK_NODES entry "${entry}" — expected identifier,host,port,password,secure`);
      }
      return {
        identifier: identifier || hostname,
        hostname,
        port: int(port, 3000),
        password,
        secure: bool(secure, false),
      };
    });

  if (nodes.length === 0) return null;
  return nodes;
}

function loadConfig(env = process.env) {
  const nodes = parseNodes(env.NODELINK_NODES) ?? [
    {
      identifier: 'main',
      hostname: env.NODELINK_HOST || '127.0.0.1',
      port: int(env.NODELINK_PORT, 3000),
      password: env.NODELINK_PASSWORD || 'youshallnotpass',
      secure: bool(env.NODELINK_SECURE, false),
    },
  ];

  return {
    token: env.DISCORD_TOKEN || '',
    prefix: env.PREFIX || '!',
    nodes,
    defaultSearchSource: env.DEFAULT_SEARCH_SOURCE || 'ytsearch:',
    maxPlaylistLength: Math.max(1, int(env.MAX_PLAYLIST_LENGTH, 100)),
    emptyLeaveSeconds: Math.max(0, int(env.EMPTY_LEAVE_SECONDS, 60)),
    registerCommands: bool(env.REGISTER_COMMANDS, true),
    commandsGuildId: env.COMMANDS_GUILD_ID || '',
  };
}

export const config = loadConfig();

export function assertConfig(cfg = config) {
  if (!cfg.token) {
    throw new Error(
      'DISCORD_TOKEN is not set. Copy .env.example to .env and add your bot token.',
    );
  }
  if (!cfg.nodes?.length) {
    throw new Error('No NodeLink nodes configured. Set NODELINK_HOST / NODELINK_NODES.');
  }
}
