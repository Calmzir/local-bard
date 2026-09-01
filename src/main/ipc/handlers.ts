import { ipcMain, type BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import type {
  BotSetupStatus,
  JoinVoiceChannelResult,
  ManageableGuild,
  OAuthClientSetupStatus,
  OAuthLoginStatus,
  SaveOAuthClientResult,
  SaveTokenResult,
  StreamingStatus,
} from '../../shared/types';
import type { StreamingManager } from '../streaming/StreamingManager';
import type { BotController } from '../bot/client';
import type { OAuthController } from '../oauth/OAuthController';
import { hasStoredToken, loadToken, saveToken } from '../secureStorage';

export interface RegisterIpcOptions {
  window: BrowserWindow;
  streamingManager: StreamingManager;
  botController: BotController;
  oauthController: OAuthController;
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
  const { window, streamingManager, botController, oauthController, onTokenSaved } = options;

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

  ipcMain.handle(IPC.GET_OAUTH_CLIENT_STATUS, async (): Promise<OAuthClientSetupStatus> => {
    return oauthController.getClientSetupStatus();
  });

  ipcMain.handle(
    IPC.SAVE_OAUTH_CLIENT,
    async (_event, clientId: unknown, clientSecret: unknown): Promise<SaveOAuthClientResult> => {
      if (typeof clientId !== 'string' || typeof clientSecret !== 'string') {
        return { ok: false, errorMessage: 'Invalid client credentials.' };
      }
      return oauthController.saveClientCredentials(clientId, clientSecret);
    },
  );

  ipcMain.handle(IPC.GET_OAUTH_LOGIN_STATUS, async (): Promise<OAuthLoginStatus> => {
    return oauthController.getLoginStatus();
  });

  ipcMain.handle(IPC.START_OAUTH_LOGIN, async (): Promise<void> => {
    // Fire-and-forget: progress/result is pushed via OAUTH_LOGIN_STATUS_CHANGED,
    // not returned from this call, so the renderer isn't blocked on the browser.
    void oauthController.login();
  });

  ipcMain.handle(IPC.OAUTH_LOGOUT, async (): Promise<void> => {
    oauthController.logout();
  });

  ipcMain.handle(IPC.LIST_MANAGEABLE_GUILDS, async (): Promise<ManageableGuild[]> => {
    return oauthController.listManageableGuilds();
  });

  ipcMain.handle(
    IPC.JOIN_GUILD_VOICE_CHANNEL,
    async (_event, guildId: unknown, channelId: unknown): Promise<JoinVoiceChannelResult> => {
      if (typeof guildId !== 'string' || guildId.length === 0 || typeof channelId !== 'string' || channelId.length === 0) {
        return { ok: false, errorMessage: 'Invalid guild or channel id.' };
      }
      // Authorization (MANAGE_GUILD re-check) happens inside the controller,
      // never trusting these renderer-supplied ids on their own.
      return oauthController.joinGuildVoiceChannel(guildId, channelId);
    },
  );

  streamingManager.on('statusChanged', (status: StreamingStatus) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC.STATUS_CHANGED, status);
    }
  });

  oauthController.on('loginStatusChanged', (status: OAuthLoginStatus) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC.OAUTH_LOGIN_STATUS_CHANGED, status);
    }
  });
}

/** Loads and returns the persisted token, if any, without exposing it over IPC. */
export function tryLoadStoredToken(): string | null {
  return loadToken();
}
