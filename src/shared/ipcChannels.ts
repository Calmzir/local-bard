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

  GET_OAUTH_CLIENT_STATUS: 'bard:getOAuthClientStatus',
  SAVE_OAUTH_CLIENT: 'bard:saveOAuthClient',
  GET_OAUTH_LOGIN_STATUS: 'bard:getOAuthLoginStatus',
  OAUTH_LOGIN_STATUS_CHANGED: 'bard:oauthLoginStatusChanged',
  START_OAUTH_LOGIN: 'bard:startOAuthLogin',
  OAUTH_LOGOUT: 'bard:oauthLogout',
  LIST_MANAGEABLE_GUILDS: 'bard:listManageableGuilds',
  JOIN_GUILD_VOICE_CHANNEL: 'bard:joinGuildVoiceChannel',
} as const;
