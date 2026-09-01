import {
  ChannelType,
  ChatInputCommandInteraction,
  GuildMember,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getVoiceConnection } from '@discordjs/voice';
import type { StreamingManager } from '../streaming/StreamingManager';
import { loadConfig } from '../config';
import { isAuthorized } from './permissions';
import { joinVoiceChannelAndAttach } from './voiceJoin';

/** Slash command definitions. Registered per-guild (see registerCommands.ts). */
export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Bring Local Bard into a voice channel')
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Voice channel to join')
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setRequired(true),
    ),
  new SlashCommandBuilder().setName('leave').setDescription('Disconnect Local Bard from voice'),
  new SlashCommandBuilder().setName('status').setDescription('Show current streaming status'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop streaming audio (stays connected to voice)'),
].map((c) => c.toJSON());

async function replyEphemeral(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.reply({ content, ephemeral: true });
}

export function createInteractionHandler(streamingManager: StreamingManager) {
  return async function handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guild) {
      await replyEphemeral(interaction, 'This command only works inside a server.');
      return;
    }
    const member = interaction.member;
    if (!(member instanceof GuildMember)) {
      await replyEphemeral(interaction, 'Could not resolve your server membership.');
      return;
    }

    const config = loadConfig();
    if (!isAuthorized(member, config)) {
      await replyEphemeral(interaction, 'You do not have permission to control Local Bard.');
      return;
    }

    switch (interaction.commandName) {
      case 'join':
        await handleJoin(interaction, member, streamingManager);
        return;
      case 'leave':
        await handleLeave(interaction, streamingManager);
        return;
      case 'status':
        await handleStatus(interaction, streamingManager);
        return;
      case 'stop':
        streamingManager.stopStreaming();
        await replyEphemeral(interaction, 'Streaming stopped (still connected to voice).');
        return;
      default:
        await replyEphemeral(interaction, 'Unknown command.');
    }
  };
}

async function handleJoin(
  interaction: ChatInputCommandInteraction,
  member: GuildMember,
  streamingManager: StreamingManager,
): Promise<void> {
  const channel = interaction.options.getChannel('channel', true);
  const guild = interaction.guild!;
  const resolvedChannel = guild.channels.cache.get(channel.id);
  if (!resolvedChannel || !resolvedChannel.isVoiceBased()) {
    await replyEphemeral(interaction, 'That channel could not be resolved as a voice channel.');
    return;
  }

  const permissions = resolvedChannel.permissionsFor(member);
  if (!permissions || !permissions.has(PermissionFlagsBits.Connect)) {
    await replyEphemeral(interaction, 'You need the "Connect" permission in that channel.');
    return;
  }

  const result = await joinVoiceChannelAndAttach(guild, resolvedChannel, streamingManager);
  if (result.ok) {
    await replyEphemeral(interaction, `Joined **${resolvedChannel.name}**.`);
  } else {
    await replyEphemeral(interaction, result.errorMessage ?? 'Failed to join voice channel.');
  }
}

async function handleLeave(
  interaction: ChatInputCommandInteraction,
  streamingManager: StreamingManager,
): Promise<void> {
  const guild = interaction.guild!;
  const connection = getVoiceConnection(guild.id);
  if (!connection) {
    await replyEphemeral(interaction, 'Local Bard is not connected to voice.');
    return;
  }
  connection.destroy();
  streamingManager.detachVoiceConnection();
  await replyEphemeral(interaction, 'Left the voice channel.');
}

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  streamingManager: StreamingManager,
): Promise<void> {
  const status = streamingManager.getStatus();
  const lines = [
    `State: **${status.state}**`,
    `Selected app: **${status.selectedApp?.name ?? 'none'}**`,
    `Voice channel: **${status.channelName ?? 'not connected'}**`,
    status.errorMessage ? `Last error: ${status.errorMessage}` : null,
  ].filter((l): l is string => l !== null);
  await replyEphemeral(interaction, lines.join('\n'));
}
