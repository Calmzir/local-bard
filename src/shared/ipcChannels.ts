/**
 * IPC channel name constants. Imported ONLY by main and preload (both
 * compiled as CommonJS under tsconfig.main.json / tsconfig.preload.json).
 * The renderer never imports this file -- it only sees the typed API that
 * preload exposes via contextBridge, never a raw channel string. Keeping
 * that boundary means these names can change freely without touching the
 * renderer at all.
 */
export const IPC = {
  LIST_APPS: 'bard:listApps',
  START_STREAMING: 'bard:startStreaming',
  STOP_STREAMING: 'bard:stopStreaming',
  GET_STATUS: 'bard:getStatus',
  STATUS_CHANGED: 'bard:statusChanged',
  GET_BOT_SETUP_STATUS: 'bard:getBotSetupStatus',
  SAVE_BOT_TOKEN: 'bard:saveBotToken',
  CLEAR_BOT_TOKEN: 'bard:clearBotToken',
  COPY_INVITE_LINK: 'bard:copyInviteLink',

  GET_GUILD_CONFIG: 'bard:getGuildConfig',
  SAVE_GUILD_ID: 'bard:saveGuildId',
  GUILD_CONFIG_CHANGED: 'bard:guildConfigChanged',
  JOIN_GUILD_VOICE_CHANNEL: 'bard:joinGuildVoiceChannel',
} as const;
