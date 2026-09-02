import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { StreamingManager } from './streaming/StreamingManager';
import { BotController } from './bot/client';
import { GuildController } from './guild/GuildController';
import { registerIpcHandlers, tryLoadStoredToken } from './ipc/handlers';
import { hasStoredToken, saveToken } from './secureStorage';
import { DEFAULT_WINDOW_SIZE, clampToVisibleDisplay, loadWindowBounds, saveWindowBounds } from './windowBounds';

if (process.platform === 'linux') {
  // Electron/Chromium picks a safeStorage backend by recognizing the desktop
  // environment name (GNOME, KDE, ...). On window managers/compositors it
  // doesn't recognize (Hyprland, Sway, i3, ...) it skips the check entirely
  // and reports no backend available, even when a real one (GNOME
  // Keyring/libsecret, or KWallet's Secret Service compat layer) is running.
  // `gnome-libsecret` talks to the freedesktop.org Secret Service D-Bus API
  // directly -- it works with any provider that implements that standard
  // interface, not just GNOME Keyring specifically. This must be set before
  // `app.whenReady()`. No effect on Windows (DPAPI is used automatically
  // there); harmless if no Secret Service is running at all -- safeStorage
  // still correctly reports itself unavailable in that case.
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}

/**
 * `app.isPackaged` is NOT a reliable dev/prod signal for this project: on at
 * least one confirmed real setup it reads `true` even for a plain `electron .`
 * source run (Electron only guarantees it's about "is a default app.asar
 * present", not "was this built by electron-builder"). electron-builder
 * always produces an asar archive (see `electron-builder.yml`'s `asar: true`),
 * and a plain source run never does -- so checking the actual app path is a
 * deterministic substitute that doesn't depend on that ambiguous heuristic.
 */
const isDev = !app.getAppPath().includes('.asar');

if (isDev) {
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
let guildController: GuildController | null = null;

function createWindow(): BrowserWindow {
  const storedBounds = loadWindowBounds();
  const initialBounds = storedBounds ? clampToVisibleDisplay(storedBounds) : DEFAULT_WINDOW_SIZE;

  const window = new BrowserWindow({
    ...initialBounds,
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
      devTools: isDev,
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

  if (isDev) {
    // DevTools stay openable (see `devTools: isDev` above) but no longer
    // auto-open by default -- set LOCAL_BARD_DEVTOOLS=1 to bring back the
    // automatic detached window while actively debugging the renderer.
    if (process.env['LOCAL_BARD_DEVTOOLS'] === '1') {
      window.webContents.openDevTools({ mode: 'detach' });
    }
    // Mirror renderer console output into this terminal too -- dev only,
    // so runtime errors in the renderer are visible without switching to
    // the detached devtools window.
    window.webContents.on('console-message', (event) => {
      console.log(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    });
    // If the preload script itself throws, `window.bard` never gets
    // attached and every renderer call silently breaks -- surface that
    // loudly instead of leaving it as a mysterious "undefined" downstream.
    window.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error(`[preload-error] ${preloadPath}:`, error);
    });
  }

  // Persist window bounds across restarts: debounce resize/move (dragging
  // or resizing fires many events per second) and also save once more on
  // close in case the debounce timer hadn't fired yet.
  let saveBoundsTimer: ReturnType<typeof setTimeout> | null = null;
  const persistBounds = (): void => {
    if (window.isDestroyed()) return;
    saveWindowBounds(window.getBounds());
  };
  const scheduleBoundsSave = (): void => {
    if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(persistBounds, 400);
  };
  window.on('resize', scheduleBoundsSave);
  window.on('move', scheduleBoundsSave);
  window.on('close', () => {
    if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
    persistBounds();
  });

  void window.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  return window;
}

async function bootstrap(): Promise<void> {
  console.log(`[main] isDev = ${isDev} (app.isPackaged reports ${app.isPackaged} -- not used for this decision)`);
  mainWindow = createWindow();
  streamingManager = new StreamingManager();
  botController = new BotController(streamingManager);
  guildController = new GuildController(botController, streamingManager);

  // Push a fresh guild-config status to the renderer whenever the bot's own
  // guild list might have changed (connect, disconnect, guildCreate,
  // guildDelete) -- see `BotController`'s 'guildsChanged' event doc.
  botController.on('guildsChanged', () => guildController!.emitStatusChanged());

  registerIpcHandlers({
    window: mainWindow,
    streamingManager,
    botController,
    guildController,
    onTokenSaved: async (token) => {
      await botController!.login(token);
    },
  });

  if (isDev && !hasStoredToken() && process.env['DISCORD_BOT_TOKEN']) {
    // Dev convenience: seed safeStorage from the env var on first run so the
    // GUI prompt can be skipped locally. Still goes through the same
    // encrypted-at-rest storage as the GUI path -- never read directly.
    saveToken(process.env['DISCORD_BOT_TOKEN']);
  }

  const storedToken = tryLoadStoredToken();
  if (storedToken) {
    try {
      await botController.login(storedToken);
    } catch (err) {
      console.error('Failed to log in with stored token:', err);
    }
  }
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
