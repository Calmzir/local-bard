import { ipcMain, type BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import type {
  BotSetupStatus,
  GuildConfigStatus,
  JoinVoiceChannelResult,
  SaveGuildIdResult,
  SaveTokenResult,
  StreamingStatus,
} from '../../shared/types';
import type { StreamingManager } from '../streaming/StreamingManager';
import type { BotController } from '../bot/client';
import type { GuildController } from '../guild/GuildController';
import { hasStoredToken, loadToken, saveToken } from '../secureStorage';

export interface RegisterIpcOptions {
  window: BrowserWindow;
  streamingManager: StreamingManager;
  botController: BotController;
  guildController: GuildController;
  /** Called after a token is saved for the first time, to trigger login. */
  onTokenSaved: (token: string) => Promise<void>;
}

/**
 * Registers every ipcMain.handle/on used by the renderer. This is the
 * complete, narrow surface the preload script proxies -- nothing here
 * accepts or evaluates arbitrary code, and every handler validates its own
 * input shape.
 */
export function registerIpcHandlers(options: RegisterIpcOptions): void {
  const { window, streamingManager, botController, guildController, onTokenSaved } = options;

  ipcMain.handle(IPC.LIST_APPS, async () => {
    return streamingManager.listApps();
  });

  ipcMain.handle(IPC.START_STREAMING, async (_event, appId: unknown) => {
    if (typeof appId !== 'string' || appId.length === 0) {
      return { ok: false, errorMessage: 'Invalid app id.' };
    }
    return streamingManager.startStreaming(appId);
  });

  ipcMain.handle(IPC.STOP_STREAMING, async () => {
    streamingManager.stopStreaming();
  });

  ipcMain.handle(IPC.GET_STATUS, async (): Promise<StreamingStatus> => {
    return streamingManager.getStatus();
  });

  ipcMain.handle(IPC.GET_BOT_SETUP_STATUS, async (): Promise<BotSetupStatus> => {
    return {
      hasToken: hasStoredToken(),
      connected: botController.isConnected(),
      botUsername: botController.getUsername(),
    };
  });

  ipcMain.handle(IPC.SAVE_BOT_TOKEN, async (_event, token: unknown): Promise<SaveTokenResult> => {
    if (typeof token !== 'string') {
      return { ok: false, errorMessage: 'Invalid token.' };
    }
    const result = saveToken(token);
    if (result.ok) {
      await onTokenSaved(token);
    }
    return result;
  });

  ipcMain.handle(IPC.GET_GUILD_CONFIG, async (): Promise<GuildConfigStatus> => {
    return guildController.getStatus();
  });

  ipcMain.handle(IPC.SAVE_GUILD_ID, async (_event, guildId: unknown): Promise<SaveGuildIdResult> => {
    if (typeof guildId !== 'string') {
      return { ok: false, errorMessage: 'Invalid guild id.' };
    }
    return guildController.saveGuildId(guildId);
  });

  ipcMain.handle(
    IPC.JOIN_GUILD_VOICE_CHANNEL,
    async (_event, channelId: unknown): Promise<JoinVoiceChannelResult> => {
      if (typeof channelId !== 'string' || channelId.length === 0) {
        return { ok: false, errorMessage: 'Invalid channel id.' };
      }
      // The guild id is never taken from the renderer -- it always comes
      // from local config, and the controller re-validates the channel
      // actually belongs to that guild before joining.
      return guildController.joinConfiguredVoiceChannel(channelId);
    },
  );

  streamingManager.on('statusChanged', (status: StreamingStatus) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC.STATUS_CHANGED, status);
    }
  });

  guildController.on('guildStatusChanged', (status: GuildConfigStatus) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC.GUILD_CONFIG_CHANGED, status);
    }
  });
}

/** Loads and returns the persisted token, if any, without exposing it over IPC. */
export function tryLoadStoredToken(): string | null {
  return loadToken();
}
