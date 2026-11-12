/** Command registry — collects every command module into one map. */
import { command as playCommand } from './play.js';
import {
  pauseCommand, resumeCommand, skipCommand, stopCommand, leaveCommand,
  shuffleCommand, volumeCommand, loopCommand, seekCommand,
} from './controls.js';
import {
  queueCommand, nowPlayingCommand, lyricsCommand, filterCommand,
  statsCommand, pingCommand, helpCommand,
} from './info.js';

const ALL = [
  playCommand,
  pauseCommand, resumeCommand, skipCommand, stopCommand, leaveCommand,
  shuffleCommand, volumeCommand, loopCommand, seekCommand,
  queueCommand, nowPlayingCommand, lyricsCommand, filterCommand,
  statsCommand, pingCommand, helpCommand,
];

export function registerCommands(client) {
  for (const cmd of ALL) {
    client.commands.set(cmd.name, cmd);
    for (const alias of cmd.aliases ?? []) client.commands.set(alias, cmd);
  }
  return ALL.filter((cmd, i) => ALL.indexOf(cmd) === i);
}

/** Slash command payloads for REST registration (deduplicated by name). */
export function slashPayloads() {
  const seen = new Set();
  return ALL.filter((cmd) => {
    if (seen.has(cmd.name)) return false;
    seen.add(cmd.name);
    return true;
  }).map((cmd) => cmd.data.toJSON());
}
