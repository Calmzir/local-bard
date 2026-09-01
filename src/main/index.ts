import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { StreamingManager } from './streaming/StreamingManager';
import { BotController } from './bot/client';
import { OAuthController } from './oauth/OAuthController';
import { registerIpcHandlers, tryLoadStoredToken } from './ipc/handlers';
import { hasStoredOAuthClient, hasStoredToken, saveOAuthClient, saveToken } from './secureStorage';

if (!app.isPackaged) {
  // Dev convenience only: load .env (see .env.example) so DISCORD_BOT_TOKEN
  // doesn't need to be re-pasted into the GUI on every dev run. This never
  // runs in packaged builds -- the only persisted secret storage anywhere in
  // this app is safeStorage (see secureStorage.ts), never a plaintext .env.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('dotenv').config();
  } catch {
    // dotenv not installed or no .env present -- nothing to load.
  }
}

let mainWindow: BrowserWindow | null = null;
let streamingManager: StreamingManager | null = null;
let botController: BotController | null = null;
let oauthController: OAuthController | null = null;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 900,
    height: 640,
    title: 'Local Bard',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // No `remote` module (removed in modern Electron, and never re-added
      // here). Devtools/remote debugging disabled outright in packaged
      // production builds -- this is the app's only local surface, and it
      // should not stay open on a shipped build.
      devTools: !app.isPackaged,
    },
  });

  // Belt-and-braces against any accidental navigation/window-open surface:
  // this app never needs to open external links or navigate away from its
  // own bundled renderer.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url).catch(() => undefined);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
    }
  });

  if (!app.isPackaged) {
    // devTools is only enabled in dev builds (see webPreferences above);
    // this just opens it automatically for convenience while developing.
    window.webContents.openDevTools({ mode: 'detach' });
  }

  void window.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  return window;
}

async function bootstrap(): Promise<void> {
  mainWindow = createWindow();
  streamingManager = new StreamingManager();
  botController = new BotController(streamingManager);
  oauthController = new OAuthController(botController, streamingManager);

  registerIpcHandlers({
    window: mainWindow,
    streamingManager,
    botController,
    oauthController,
    onTokenSaved: async (token) => {
      await botController!.login(token);
    },
  });

  if (!app.isPackaged && !hasStoredToken() && process.env['DISCORD_BOT_TOKEN']) {
    // Dev convenience: seed safeStorage from the env var on first run so the
    // GUI prompt can be skipped locally. Still goes through the same
    // encrypted-at-rest storage as the GUI path -- never read directly.
    saveToken(process.env['DISCORD_BOT_TOKEN']);
  }

  if (
    !app.isPackaged &&
    !hasStoredOAuthClient() &&
    process.env['DISCORD_CLIENT_ID'] &&
    process.env['DISCORD_CLIENT_SECRET']
  ) {
    // Same dev-convenience seeding as the bot token above, through the same
    // encrypted-at-rest storage as the GUI path.
    saveOAuthClient(process.env['DISCORD_CLIENT_ID'], process.env['DISCORD_CLIENT_SECRET']);
  }

  const storedToken = tryLoadStoredToken();
  if (storedToken) {
    try {
      await botController.login(storedToken);
    } catch (err) {
      console.error('Failed to log in with stored token:', err);
    }
  }

  // Best-effort session restore -- never blocks startup, and leaves the
  // user cleanly logged out if there is nothing to restore or it fails.
  await oauthController.restoreSession();
}

app.whenReady().then(bootstrap).catch((err) => {
  console.error('Fatal error during startup:', err);
  app.quit();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  streamingManager?.stopStreaming();
  void botController?.logout();
});
