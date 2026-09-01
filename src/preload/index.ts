import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipcChannels';
import type {
  BotSetupStatus,
  CapturableApp,
  JoinVoiceChannelResult,
  LocalBardAPI,
  ManageableGuild,
  OAuthClientSetupStatus,
  OAuthLoginStatus,
  SaveOAuthClientResult,
  SaveTokenResult,
  StreamingStatus,
} from '../shared/types';

/**
 * The ONLY bridge between the sandboxed renderer and the rest of the app.
 * `ipcRenderer` and `require` are never exposed directly -- only this
 * narrow, fully-typed object, matching the `LocalBardAPI` contract in
 * src/shared/types.ts. Every method here maps to exactly one fixed IPC
 * channel; nothing here forwards an arbitrary channel name or payload
 * chosen by renderer code.
 */
const api: LocalBardAPI = {
  listApps(): Promise<CapturableApp[]> {
    return ipcRenderer.invoke(IPC.LIST_APPS);
  },

  startStreaming(appId: string): Promise<{ ok: boolean; errorMessage: string | null }> {
    return ipcRenderer.invoke(IPC.START_STREAMING, appId);
  },

  stopStreaming(): Promise<void> {
    return ipcRenderer.invoke(IPC.STOP_STREAMING);
  },

  getStatus(): Promise<StreamingStatus> {
    return ipcRenderer.invoke(IPC.GET_STATUS);
  },

  onStatusChanged(callback: (status: StreamingStatus) => void): () => void {
    const listener = (_event: IpcRendererEvent, status: StreamingStatus) => callback(status);
    ipcRenderer.on(IPC.STATUS_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.STATUS_CHANGED, listener);
  },

  getBotSetupStatus(): Promise<BotSetupStatus> {
    return ipcRenderer.invoke(IPC.GET_BOT_SETUP_STATUS);
  },

  saveBotToken(token: string): Promise<SaveTokenResult> {
    return ipcRenderer.invoke(IPC.SAVE_BOT_TOKEN, token);
  },

  getOAuthClientStatus(): Promise<OAuthClientSetupStatus> {
    return ipcRenderer.invoke(IPC.GET_OAUTH_CLIENT_STATUS);
  },

  saveOAuthClient(clientId: string, clientSecret: string): Promise<SaveOAuthClientResult> {
    return ipcRenderer.invoke(IPC.SAVE_OAUTH_CLIENT, clientId, clientSecret);
  },

  getOAuthLoginStatus(): Promise<OAuthLoginStatus> {
    return ipcRenderer.invoke(IPC.GET_OAUTH_LOGIN_STATUS);
  },

  onOAuthLoginStatusChanged(callback: (status: OAuthLoginStatus) => void): () => void {
    const listener = (_event: IpcRendererEvent, status: OAuthLoginStatus) => callback(status);
    ipcRenderer.on(IPC.OAUTH_LOGIN_STATUS_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.OAUTH_LOGIN_STATUS_CHANGED, listener);
  },

  startOAuthLogin(): Promise<void> {
    return ipcRenderer.invoke(IPC.START_OAUTH_LOGIN);
  },

  oauthLogout(): Promise<void> {
    return ipcRenderer.invoke(IPC.OAUTH_LOGOUT);
  },

  listManageableGuilds(): Promise<ManageableGuild[]> {
    return ipcRenderer.invoke(IPC.LIST_MANAGEABLE_GUILDS);
  },

  joinGuildVoiceChannel(guildId: string, channelId: string): Promise<JoinVoiceChannelResult> {
    return ipcRenderer.invoke(IPC.JOIN_GUILD_VOICE_CHANNEL, guildId, channelId);
  },
};

contextBridge.exposeInMainWorld('bard', api);
