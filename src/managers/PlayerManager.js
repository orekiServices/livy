/**
 * Per-guild playback state + FastLink player lifecycle.
 *
 * Livy runs FastLink with `queue: false` (see QueueManager) so Livy —
 * not FastLink's buggy built-in queue — decides what plays next.
 * FastLink is used purely as the NodeLink transport: loadTrack,
 * update (PATCH player), connect, destroy.
 */
import { FastLink, createPlayer, disconnectVoice, isPlayerCreated, withTimeout } from '../fastlink-compat.js';
import { QueueManager } from './QueueManager.js';
import { buildIdentifier } from '../utils/search.js';
import { config } from '../config.js';
import { debug, warn } from '../utils/logger.js';

export class GuildPlayer {
  constructor(guildId) {
    this.guildId = guildId;
    this.player = new FastLink.player.Player(guildId);
    this.queue = new QueueManager();
    this.volume = 100;
    this.filters = {};
    this.paused = false;
    this.playing = false;
    this.positionMs = 0;
    this.voiceChannelId = null;
    this.textChannelId = null;
    this.emptyTimer = null;
    this.stayConnected = false; // true after /stop, false = auto-leave when idle
  }

  get created() {
    return isPlayerCreated(this.player);
  }

  ensureCreated() {
    if (!this.created) createPlayer(this.player);
  }

  connect(voiceChannelId, client) {
    this.ensureCreated();
    this.voiceChannelId = voiceChannelId;
    this.player.connect(voiceChannelId, { mute: false, deaf: true }, (gid, payload) => {
      const guild = client.guilds.cache.get(gid);
      guild?.shard?.send(payload);
    });
  }

  /** Play a specific encoded track now (assumes queue bookkeeping is done). */
  playEncoded(encoded) {
    this.player.update({
      track: { encoded },
      volume: this.volume,
      filters: this.filters,
    });
  }

  /** Advance to the next track according to loop mode. Returns the new current. */
  advance() {
    if (this.queue.loopMode === 'track') {
      if (this.queue.current) this.playEncoded(this.queue.current.encoded);
      return this.queue.current;
    }
    if (this.queue.loopMode === 'queue') {
      const next = this.queue.rotate();
      if (next) this.playEncoded(next.encoded);
      else this.stopPlayback();
      return next;
    }
    const next = this.queue.next();
    if (next) this.playEncoded(next.encoded);
    else this.stopPlayback();
    return next;
  }

  stopPlayback() {
    this.playing = false;
    this.paused = false;
    this.positionMs = 0;
    try {
      this.player.update({ track: { encoded: null } });
    } catch (err) {
      debug(`stopPlayback (${this.guildId}):`, err.message);
    }
  }

  destroy(client) {
    this.cancelEmptyTimer();
    this.stopPlayback();
    this.queue.clear();
    if (this.created) {
      try {
        this.player.destroy();
      } catch (err) {
        debug(`destroy (${this.guildId}):`, err.message);
      }
    }
    disconnectVoice(client, this.guildId);
    this.voiceChannelId = null;
  }

  scheduleEmptyLeave(client, onLeave) {
    this.cancelEmptyTimer();
    if (config.emptyLeaveSeconds <= 0 || this.stayConnected) return;
    this.emptyTimer = setTimeout(() => {
      debug(`Empty voice channel in ${this.guildId} — leaving.`);
      this.destroy(client);
      onLeave?.(this.guildId);
    }, config.emptyLeaveSeconds * 1000);
    this.emptyTimer.unref?.();
  }

  cancelEmptyTimer() {
    if (this.emptyTimer) {
      clearTimeout(this.emptyTimer);
      this.emptyTimer = null;
    }
  }
}

export class PlayerManager {
  constructor(client) {
    this.client = client;
    /** @type {Map<string, GuildPlayer>} */
    this.players = new Map();
  }

  get(guildId) {
    return this.players.get(guildId) ?? null;
  }

  getOrCreate(guildId) {
    let guildPlayer = this.players.get(guildId);
    if (!guildPlayer) {
      guildPlayer = new GuildPlayer(guildId);
      this.players.set(guildId, guildPlayer);
    }
    return guildPlayer;
  }

  delete(guildId) {
    this.players.delete(guildId);
  }

  /**
   * Resolve a query and enqueue it. Returns a result object describing
   * what happened so commands can render the right reply.
   */
  async enqueue(guildId, query, requester) {
    if (!FastLink.node.anyNodeAvailable()) {
      throw new Error('No NodeLink node is connected. Is NodeLink running?');
    }

    const guildPlayer = this.getOrCreate(guildId);
    guildPlayer.ensureCreated();
    guildPlayer.textChannelId = requester.channelId ?? guildPlayer.textChannelId;

    const identifier = buildIdentifier(query);
    if (!identifier) throw new Error('Please provide a search query or URL.');

    const result = await withTimeout(
      guildPlayer.player.loadTrack(identifier),
      20_000,
      'loadtracks',
    );

    if (!result || typeof result !== 'object') {
      throw new Error('NodeLink returned an empty response.');
    }

    const loadType = result.loadType;
    const data = result.data ?? {};

    if (loadType === 'error') {
      throw new Error(data.message || 'NodeLink failed to load that track.');
    }
    if (loadType === 'empty') {
      throw new Error('No results found for that query.');
    }

    const toTrack = (track) => ({
      encoded: track.encoded,
      title: track.info?.title ?? 'Unknown track',
      author: track.info?.author ?? '',
      uri: track.info?.uri ?? '',
      duration: track.info?.length ?? 0,
      isStream: track.info?.isStream ?? false,
      sourceName: track.info?.sourceName ?? '',
      requesterId: requester.id,
      requesterTag: requester.tag,
    });

    let added = [];
    let playlistName = null;

    if (loadType === 'track') {
      added = [toTrack(data)];
    } else if (loadType === 'search') {
      if (!Array.isArray(data) || data.length === 0) throw new Error('No results found for that query.');
      added = [toTrack(data[0])];
    } else if (['playlist', 'album', 'station', 'show', 'podcast', 'artist'].includes(loadType)) {
      const tracks = Array.isArray(data.tracks) ? data.tracks : [];
      if (tracks.length === 0) throw new Error('That playlist is empty.');
      playlistName = data.info?.title ?? 'Playlist';
      added = tracks.slice(0, config.maxPlaylistLength).map(toTrack);
    } else {
      // Unknown loadType from a newer NodeLink — treat single-track shapes.
      if (data.encoded) added = [toTrack(data)];
      else throw new Error(`Unsupported load type from NodeLink: ${loadType}`);
    }

    const wasIdle = !guildPlayer.queue.current;
    guildPlayer.queue.addMany(added);

    if (wasIdle) {
      const first = guildPlayer.queue.next();
      guildPlayer.playEncoded(first.encoded);
      return { status: 'playing', track: first, added: added.length, playlistName };
    }

    return {
      status: 'queued',
      track: added[0],
      position: guildPlayer.queue.size,
      added: added.length,
      playlistName,
    };
  }

  /** Skip the current track. Returns the skipped track, or null. */
  skip(guildId) {
    const guildPlayer = this.get(guildId);
    if (!guildPlayer || !guildPlayer.queue.current) return null;

    const skipped = guildPlayer.queue.current;
    const next = guildPlayer.queue.next();
    if (next) guildPlayer.playEncoded(next.encoded);
    else guildPlayer.stopPlayback();
    return skipped;
  }

  stop(guildId) {
    const guildPlayer = this.get(guildId);
    if (!guildPlayer) return false;
    guildPlayer.queue.clear();
    guildPlayer.stopPlayback();
    guildPlayer.stayConnected = true;
    return true;
  }

  leave(guildId) {
    const guildPlayer = this.get(guildId);
    if (!guildPlayer) return false;
    guildPlayer.destroy(this.client);
    this.delete(guildId);
    return true;
  }

  /** Handle FastLink trackStart events. */
  onTrackStart({ guildId, track }) {
    const guildPlayer = this.get(guildId);
    if (!guildPlayer) return;
    guildPlayer.playing = true;
    guildPlayer.paused = false;
    guildPlayer.positionMs = 0;
    guildPlayer.cancelEmptyTimer();
    // Keep metadata in sync with what NodeLink actually started.
    if (track?.encoded && guildPlayer.queue.current?.encoded !== track.encoded) {
      debug(`Track start mismatch in ${guildId} — syncing current track.`);
      guildPlayer.queue.current = {
        ...(guildPlayer.queue.current ?? {}),
        encoded: track.encoded,
        title: track.info?.title ?? guildPlayer.queue.current?.title ?? 'Unknown track',
        uri: track.info?.uri ?? guildPlayer.queue.current?.uri ?? '',
        duration: track.info?.length ?? guildPlayer.queue.current?.duration ?? 0,
      };
    }
  }

  /** Handle FastLink trackEnd / trackException / trackStuck events. */
  onTrackEnd({ guildId, reason, type }) {
    const guildPlayer = this.get(guildId);
    if (!guildPlayer) return;

    guildPlayer.playing = false;
    guildPlayer.positionMs = 0;

    // 'replaced' / 'stopped' / 'cleanup' are caused by our own skip/stop
    // calls, which already updated the queue — never advance twice.
    if (['replaced', 'stopped', 'cleanup'].includes(reason)) return;

    if (type === 'trackException' || type === 'trackStuck') {
      warn(`Track ${type} in ${guildId} (${reason ?? 'unknown'}) — skipping.`);
    }

    const next = guildPlayer.advance();
    if (!next) {
      guildPlayer.scheduleEmptyLeave(this.client, (gid) => this.delete(gid));
    }
  }

  /** Handle FastLink playerUpdate events (position tracking). */
  onPlayerUpdate({ payload }) {
    const guildPlayer = this.get(payload?.guildId);
    if (!guildPlayer) return;
    if (typeof payload?.state?.position === 'number') {
      guildPlayer.positionMs = payload.state.position;
    }
    if (typeof payload?.state?.connected === 'boolean') {
      guildPlayer.playing = payload.state.connected && !payload.state.paused;
      guildPlayer.paused = Boolean(payload.state.paused);
    }
  }
}
