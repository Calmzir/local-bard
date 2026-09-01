import { Client, GatewayIntentBits, Events, type Guild, type VoiceBasedChannel } from 'discord.js';
import type { StreamingManager } from '../streaming/StreamingManager';
import { createInteractionHandler } from './commands';
import { wireCommandRegistration } from './registerCommands';
import type { VoiceChannelInfo } from '../../shared/types';

/**
 * Thin wrapper around the discord.js Client lifecycle. Only the intents
 * actually needed are requested: Guilds (for guild/channel state and slash
 * commands) and GuildVoiceStates (for joining/leaving voice). No message
 * content intent -- this bot never reads message text, only slash command
 * interactions, so there is no freeform text execution surface.
 */
export class BotController {
  private client: Client | null = null;
  private readonly streamingManager: StreamingManager;

  constructor(streamingManager: StreamingManager) {
    this.streamingManager = streamingManager;
  }

  isConnected(): boolean {
    return this.client?.isReady() ?? false;
  }

  getUsername(): string | null {
    return this.client?.user?.username ?? null;
  }

  /** Guild IDs the bot is currently a member of. Used to cross-reference against the OAuth-logged-in user's MANAGE_GUILD list. */
  listGuildIds(): string[] {
    return this.client ? [...this.client.guilds.cache.keys()] : [];
  }

  /** Resolves a guild by id from the bot's own cache, or null if the bot is not a member of it. */
  getGuild(guildId: string): Guild | null {
    return this.client?.guilds.cache.get(guildId) ?? null;
  }

  /** Lists the voice-based channels of a guild the bot is a member of. */
  listVoiceChannels(guildId: string): VoiceChannelInfo[] {
    const guild = this.getGuild(guildId);
    if (!guild) return [];
    return guild.channels.cache
      .filter((channel): channel is VoiceBasedChannel => channel.isVoiceBased())
      .map((channel) => ({ id: channel.id, name: channel.name }));
  }

  /** Resolves a single voice-based channel of a guild the bot is a member of, or null. */
  getVoiceChannel(guildId: string, channelId: string): VoiceBasedChannel | null {
    const guild = this.getGuild(guildId);
    if (!guild) return null;
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) return null;
    return channel;
  }

  async login(token: string): Promise<void> {
    if (this.client) {
      await this.logout();
    }

    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });

    wireCommandRegistration(client);

    const handleInteraction = createInteractionHandler(this.streamingManager);
    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      try {
        await handleInteraction(interaction);
      } catch (err) {
        console.error('Error handling slash command interaction:', err);
      }
    });

    this.client = client;
    await client.login(token);
  }

  async logout(): Promise<void> {
    if (!this.client) return;
    await this.client.destroy();
    this.client = null;
  }
}
