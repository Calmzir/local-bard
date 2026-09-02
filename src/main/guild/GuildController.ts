import { EventEmitter } from 'node:events';
import type { GuildConfigStatus, JoinVoiceChannelResult, SaveGuildIdResult } from '../../shared/types';
import { loadConfig, saveConfig } from '../config';
import type { BotController } from '../bot/client';
import type { StreamingManager } from '../streaming/StreamingManager';
import { joinVoiceChannelAndAttach } from '../bot/voiceJoin';

/** Discord snowflake IDs are numeric strings -- reject anything else up front. */
const SNOWFLAKE_PATTERN = /^[0-9]+$/;

/**
 * Owns the single configured Discord server (guild) id and resolves it
 * directly through the bot's own connection (`BotController.getGuild`) --
 * no user login, no OAuth secrets, no loopback server. Mirrors
 * `StreamingManager`'s EventEmitter-based status-push pattern so the
 * renderer gets live updates through a `*Changed` IPC event (wired in
 * `ipc/handlers.ts`) whenever the bot connects or its guild list changes,
 * rather than polling.
 */
export class GuildController extends EventEmitter {
  private readonly botController: BotController;
  private readonly streamingManager: StreamingManager;

  constructor(botController: BotController, streamingManager: StreamingManager) {
    super();
    this.botController = botController;
    this.streamingManager = streamingManager;
  }

  /** Resolves whatever the app can currently tell about the configured guild id, via the bot's own connection. */
  getStatus(): GuildConfigStatus {
    const { guildId } = loadConfig();
    if (!guildId) {
      return { state: 'not_configured', guildId: null, guildName: null, voiceChannels: [] };
    }
    const guild = this.botController.getGuild(guildId);
    if (!guild) {
      return { state: 'not_a_member', guildId, guildName: null, voiceChannels: [] };
    }
    return {
      state: 'resolved',
      guildId,
      guildName: guild.name,
      voiceChannels: this.botController.listVoiceChannels(guildId),
    };
  }

  /**
   * Validates and persists a new guild id in the plain (non-secret) local
   * config -- see `config.ts`. Rejects anything that isn't a non-empty
   * string of digits, since Discord snowflake IDs are always numeric.
   */
  saveGuildId(guildId: string): SaveGuildIdResult {
    const trimmed = guildId.trim();
    if (!SNOWFLAKE_PATTERN.test(trimmed)) {
      return { ok: false, errorMessage: 'Guild ID must be a numeric Discord server ID.' };
    }
    saveConfig({ ...loadConfig(), guildId: trimmed });
    this.emitStatusChanged();
    return { ok: true, errorMessage: null };
  }

  /** Pushes the current status to listeners (see `ipc/handlers.ts`). Call this after saving, and whenever the bot's guild list may have changed. */
  emitStatusChanged(): void {
    this.emit('guildStatusChanged', this.getStatus());
  }

  /**
   * Joins a voice channel scoped to the configured guild. Validates the
   * requested channel actually belongs to that guild before joining --
   * no per-user permission cross-check is needed here (that was the OAuth
   * feature's job): authorization for this local trust boundary is
   * "whoever can open and use this desktop app", same trust model already
   * used for the bot token and the audio-source selection elsewhere.
   */
  async joinConfiguredVoiceChannel(channelId: string): Promise<JoinVoiceChannelResult> {
    const { guildId } = loadConfig();
    if (!guildId) {
      return { ok: false, errorMessage: 'No Discord server is configured yet.' };
    }
    const guild = this.botController.getGuild(guildId);
    if (!guild) {
      return { ok: false, errorMessage: 'The bot is not a member of the configured server.' };
    }
    const channel = this.botController.getVoiceChannel(guildId, channelId);
    if (!channel) {
      return { ok: false, errorMessage: 'That voice channel could not be resolved in the configured server.' };
    }
    return joinVoiceChannelAndAttach(guild, channel, this.streamingManager);
  }
}
