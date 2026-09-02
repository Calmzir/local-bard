import { EventEmitter } from 'node:events';
import { Client, GatewayIntentBits, Events, type Guild, type VoiceBasedChannel } from 'discord.js';
import type { StreamingManager } from '../streaming/StreamingManager';
import { createInteractionHandler } from './commands';
import { wireCommandRegistration } from './registerCommands';
import { buildInviteUrl } from './invite';
import { describeLoginError } from './loginErrors';
import type { VoiceChannelInfo } from '../../shared/types';

/**
 * Thin wrapper around the discord.js Client lifecycle. Only the intents
 * actually needed are requested: Guilds (for guild/channel state and slash
 * commands) and GuildVoiceStates (for joining/leaving voice). No message
 * content intent -- this bot never reads message text, only slash command
 * interactions, so there is no freeform text execution surface.
 *
 * Extends EventEmitter (same pattern as `StreamingManager`) to emit
 * 'guildsChanged' whenever the set of guilds the bot can see might have
 * changed (ready, guildCreate, guildDelete, login, logout) -- consumers like
 * `GuildController` use this to push fresh status to the renderer instead of
 * polling.
 */
export class BotController extends EventEmitter {
  private client: Client | null = null;
  private readonly streamingManager: StreamingManager;
  /** Plain-language reason the most recent `login()` call failed, or null if the last attempt (if any) succeeded. Cleared on a successful login. */
  private lastLoginError: string | null = null;

  constructor(streamingManager: StreamingManager) {
    super();
    this.streamingManager = streamingManager;
  }

  isConnected(): boolean {
    return this.client?.isReady() ?? false;
  }

  getUsername(): string | null {
    return this.client?.user?.username ?? null;
  }

  /**
   * The bot's own OAuth2 application id, i.e. the same value the Developer
   * Portal's OAuth2 "Client ID" field shows -- populated by discord.js on
   * `client.application` after a successful login, never asked of the user.
   */
  getClientId(): string | null {
    return this.client?.application?.id ?? null;
  }

  /** The invite-to-server URL built from this bot's own client id, or null before the first successful login. See `bot/invite.ts`. */
  getInviteUrl(): string | null {
    const clientId = this.getClientId();
    return clientId ? buildInviteUrl(clientId) : null;
  }

  /** Plain-language reason the most recent login attempt failed, for surfacing in the GUI -- see `bot/loginErrors.ts`. */
  getLastLoginError(): string | null {
    return this.lastLoginError;
  }

  /** Guild IDs the bot is currently a member of. */
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
      .map((channel) => ({ id: channel.id, name: channel.name, categoryName: channel.parent?.name ?? null }));
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

    client.once(Events.ClientReady, () => this.emit('guildsChanged'));
    client.on(Events.GuildCreate, () => this.emit('guildsChanged'));
    client.on(Events.GuildDelete, () => this.emit('guildsChanged'));

    this.client = client;
    try {
      await client.login(token);
    } catch (err) {
      // discord.js already destroys the client internally on a failed
      // login (see `Client#login`'s catch/rethrow), but it leaves
      // `this.client` pointing at that dead instance -- drop the
      // reference too so `isConnected()`/`getUsername()`/`getClientId()`
      // all cleanly report "not connected" instead of a half-dead client.
      this.client = null;
      this.lastLoginError = describeLoginError(err);
      throw err;
    }
    this.lastLoginError = null;
    this.emit('guildsChanged');
  }

  async logout(): Promise<void> {
    this.lastLoginError = null;
    if (!this.client) return;
    await this.client.destroy();
    this.client = null;
    this.emit('guildsChanged');
  }
}
