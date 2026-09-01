import type { Guild, VoiceBasedChannel } from 'discord.js';
import { VoiceConnectionStatus, entersState, joinVoiceChannel } from '@discordjs/voice';
import type { StreamingManager } from '../streaming/StreamingManager';

export interface VoiceJoinResult {
  ok: boolean;
  errorMessage: string | null;
}

/**
 * The single implementation of "join this voice channel and hand the
 * connection to the streaming pipeline". Used by both the `/join` slash
 * command (bot/commands.ts) and the local GUI's OAuth-driven "join this
 * channel" action (oauth/OAuthController.ts) -- callers are responsible for
 * their own authorization check before calling this; it does not re-derive
 * permissions itself.
 */
export async function joinVoiceChannelAndAttach(
  guild: Guild,
  channel: VoiceBasedChannel,
  streamingManager: StreamingManager,
): Promise<VoiceJoinResult> {
  try {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
    streamingManager.attachVoiceConnection(connection, guild.name, channel.name);
    return { ok: true, errorMessage: null };
  } catch (err) {
    return { ok: false, errorMessage: `Failed to join voice channel: ${(err as Error).message}` };
  }
}
