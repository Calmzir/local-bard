import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipcChannels';
import type {
  BotSetupStatus,
  CapturableApp,
  GuildConfigStatus,
  JoinVoiceChannelResult,
  LocalBardAPI,
  SaveGuildIdResult,
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

  getGuildConfig(): Promise<GuildConfigStatus> {
    return ipcRenderer.invoke(IPC.GET_GUILD_CONFIG);
  },

  onGuildConfigChanged(callback: (status: GuildConfigStatus) => void): () => void {
    const listener = (_event: IpcRendererEvent, status: GuildConfigStatus) => callback(status);
    ipcRenderer.on(IPC.GUILD_CONFIG_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.GUILD_CONFIG_CHANGED, listener);
  },

  saveGuildId(guildId: string): Promise<SaveGuildIdResult> {
    return ipcRenderer.invoke(IPC.SAVE_GUILD_ID, guildId);
  },

  joinGuildVoiceChannel(channelId: string): Promise<JoinVoiceChannelResult> {
    return ipcRenderer.invoke(IPC.JOIN_GUILD_VOICE_CHANNEL, channelId);
  },
};

contextBridge.exposeInMainWorld('bard', api);
