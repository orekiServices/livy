/**
 * LivyClient — discord.js client + FastLink (NodeLink) wiring.
 *
 * FastLink is connected with `queue: false`: Livy owns queueing
 * (see managers/QueueManager.js) and FastLink is only the transport.
 */
import { Client, Collection, GatewayIntentBits, Partials } from 'discord.js';
import { FastLink, getNodeInfo } from './fastlink-compat.js';
import { PlayerManager } from './managers/PlayerManager.js';
import { LyricsManager } from './managers/LyricsManager.js';
import { config } from './config.js';
import { log, warn } from './utils/logger.js';

export class LivyClient extends Client {
  constructor() {
    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [Partials.Channel],
    });

    this.commands = new Collection();
    this.playerManager = new PlayerManager(this);
    this.lyricsManager = new LyricsManager();
    this.nodeInfo = new Map(); // hostname -> /v4/info payload
  }

  connectNodes() {
    const events = FastLink.node.connectNodes(config.nodes, {
      botId: this.user.id,
      shards: this.ws.shards.size || 1,
      queue: false,
    });

    events.on('debug', (msg) => {
      if (process.env.LOG_LEVEL === 'debug') log('[FastLink]', msg);
    });

    events.on('ready', async ({ node }) => {
      log(`NodeLink node ready: ${node.hostname}:${node.port}`);
      try {
        const info = await getNodeInfo(node.hostname);
        if (info) {
          this.nodeInfo.set(node.hostname, info);
          const version = info.version?.semver ?? info.version ?? 'unknown';
          log(
            info.isNodelink
              ? `Detected NodeLink v${version} on ${node.hostname}`
              : `Detected Lavalink v${version} on ${node.hostname} (Livy is tuned for NodeLink)`,
          );
        }
      } catch (err) {
        warn(`Could not fetch /v4/info from ${node.hostname}: ${err.message}`);
      }
    });

    events.on('trackStart', (payload) => this.playerManager.onTrackStart(payload));
    events.on('trackEnd', (payload) => this.playerManager.onTrackEnd({ ...payload, type: 'trackEnd' }));
    events.on('trackException', (payload) => this.playerManager.onTrackEnd({ ...payload, type: 'trackException' }));
    events.on('trackStuck', (payload) => this.playerManager.onTrackEnd({ ...payload, type: 'trackStuck' }));
    events.on('playerUpdate', (payload) => this.playerManager.onPlayerUpdate(payload));
    events.on('websocketClosed', ({ guildId }) => {
      const guildPlayer = this.playerManager.get(guildId);
      if (guildPlayer) guildPlayer.playing = false;
    });

    return events;
  }
}
