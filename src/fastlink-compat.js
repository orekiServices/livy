/**
 * FastLink compatibility shim.
 *
 * FastLink's published npm build (2.4.1-rc.1) and its git `main` (v3.0.0)
 * expose slightly different APIs, and the README example code matches
 * neither perfectly:
 *
 *   v2 (npm):  player.playerCreated() · player.createPlayer()
 *              FastLink.other.handleRaw / .getInfo / .getStats
 *   v3 (git):  player.isCreated (getter) · player.createPlayer(node)
 *              FastLink.handleRaw · FastLink.node.getInfo / .getStats
 *
 * Livy pins v2 but routes every version-sensitive call through here so
 * upgrading FastLink later is a one-line change.
 *
 * Two upstream bugs are also worked around here:
 *  1. `player.disconnect()` throws ("No voiceId provided") because it
 *     forwards `null` into `connect()`, which rejects falsy voice ids.
 *     Livy sends the voice-disconnect payload directly instead.
 *  2. `loadTrack()` never rejects on HTTP errors (the promise simply
 *     never settles), so every request is wrapped in a timeout.
 */
import FastLink from '@performanc/fastlink';
import { debug, warn } from './utils/logger.js';

export { FastLink };

/** True when a FastLink player exists for this guild (v2 + v3 safe). */
export function isPlayerCreated(player) {
  if (typeof player.playerCreated === 'function') return player.playerCreated();
  return Boolean(player.isCreated);
}

/** Create a player, passing a node only when the installed version needs one. */
export function createPlayer(player) {
  try {
    player.createPlayer();
  } catch (err) {
    // v3 requires an explicit node object.
    if (/node/i.test(err.message) && typeof FastLink.node.getRecommendedNode === 'function') {
      player.createPlayer(FastLink.node.getRecommendedNode());
      return;
    }
    throw err;
  }
}

/** Feed a raw Discord gateway payload to FastLink (v2 + v3 safe). */
export function handleRaw(data) {
  const handler = FastLink.handleRaw ?? FastLink.other?.handleRaw;
  if (typeof handler !== 'function') {
    warn('FastLink handleRaw not found — voice connections will not work.');
    return;
  }
  try {
    handler(data);
  } catch (err) {
    debug('handleRaw error:', err.message);
  }
}

/** Send a raw voice payload (used for disconnect — see bug #1 above). */
export function sendVoicePayload(client, guildId, payload) {
  const guild = client.guilds.cache.get(guildId);
  const shard = guild?.shard ?? client.ws?.shards?.get(0);
  if (!shard) {
    warn(`No shard available to send voice payload for guild ${guildId}`);
    return false;
  }
  shard.send(payload);
  return true;
}

export function disconnectVoice(client, guildId) {
  return sendVoicePayload(client, guildId, {
    op: 4,
    d: { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: false },
  });
}

/** Node info / stats (v2 + v3 safe). `hostname` is the node key. */
export async function getNodeInfo(hostname) {
  const fn = FastLink.node?.getInfo ?? FastLink.other?.getInfo;
  return fn ? fn(hostname) : null;
}

export async function getNodeStats(hostname) {
  const fn = FastLink.node?.getStats ?? FastLink.other?.getStats;
  return fn ? fn(hostname) : null;
}

/** Wrap a FastLink request with a timeout (see bug #2 above). */
export function withTimeout(promise, ms = 15_000, label = 'NodeLink request') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}
