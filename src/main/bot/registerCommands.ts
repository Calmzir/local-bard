import type { Client, Guild } from 'discord.js';
import { commandDefinitions } from './commands';

/**
 * Registers slash commands per-guild rather than globally. Guild-scoped
 * registration propagates instantly (global registration can take up to an
 * hour to show up), which matters both for fast iteration during
 * development and for a self-hosted single-operator bot like this one that
 * only ever lives in a handful of guilds.
 */
export function registerCommandsForGuild(guild: Guild): Promise<unknown> {
  return guild.commands.set(commandDefinitions);
}

export function wireCommandRegistration(client: Client): void {
  client.once('ready', async (readyClient) => {
    for (const guild of readyClient.guilds.cache.values()) {
      try {
        await registerCommandsForGuild(guild);
      } catch (err) {
        console.error(`Failed to register commands for guild ${guild.id}:`, err);
      }
    }
  });

  client.on('guildCreate', async (guild) => {
    try {
      await registerCommandsForGuild(guild);
    } catch (err) {
      console.error(`Failed to register commands for guild ${guild.id}:`, err);
    }
  });
}
