/**
 * Types shared across main, preload, and renderer.
 *
 * IMPORTANT: this file must stay runtime-free (interfaces/types/type aliases
 * only). The renderer build (tsconfig.renderer.json) only ever imports from
 * here with `import type`, which TypeScript erases completely at compile
 * time. If you add a real value export (a const, a class, a function) here,
 * it WILL be emitted, and because the renderer's rootDir/outDir mapping is
 * separate from main/preload's, that emission risks clashing with -- or
 * silently diverging from -- the copy compiled for main/preload. Put runtime
 * constants in ipcChannels.ts instead, and only import that from main/preload.
 *
 * NOTE: `AudioCaptureSource` deliberately lives in its own file
 * (audioCapture.ts), not here, because it needs Node's `node:stream`
 * `Readable` type. If that import lived in this file, the renderer's
 * type-only `import type { LocalBardAPI } from '../shared/types'` would
 * force TypeScript to fully resolve `node:stream` too (TS type-checks an
 * entire file once any part of it is reached, not just the symbols
 * actually used) -- and the renderer tsconfig intentionally sets
 * `"types": []` so Node's ambient globals never leak into browser code.
 */

/** A single running, audio-capable application the user can pick from. */
export interface CapturableApp {
  /** Stable id for this run of the app (PipeWire node id / pid / helper id). */
  id: string;
  /** Human-readable name to show in the GUI. */
  name: string;
  /** Underlying binary/process name, shown as secondary detail. */
  processName: string;
}

export type StreamingState = 'idle' | 'connecting' | 'live' | 'error';

export interface StreamingStatus {
  state: StreamingState;
  selectedApp: CapturableApp | null;
  guildName: string | null;
  channelName: string | null;
  errorMessage: string | null;
}

export interface BotSetupStatus {
  /** Whether a bot token is already stored in encrypted local storage. */
  hasToken: boolean;
  /** Whether the bot client is currently logged in to Discord. */
  connected: boolean;
  /** Bot's own username once connected, for display purposes. */
  botUsername: string | null;
}

export interface SaveTokenResult {
  ok: boolean;
  errorMessage: string | null;
}

/** Whether the OAuth Client ID/Secret (Joel's own Discord Application) are already stored. */
export interface OAuthClientSetupStatus {
  hasClientCredentials: boolean;
}

export interface SaveOAuthClientResult {
  ok: boolean;
  errorMessage: string | null;
}

export type OAuthLoginState = 'idle' | 'waiting_for_browser' | 'exchanging' | 'logged_in' | 'error';

export interface OAuthLoginStatus {
  state: OAuthLoginState;
  /** The logged-in Discord user's username, once `state` is 'logged_in'. */
  username: string | null;
  errorMessage: string | null;
}

/** A voice-based channel in a guild the bot is a member of. */
export interface VoiceChannelInfo {
  id: string;
  name: string;
}

/**
 * A guild in the intersection of "bot is a member" and "logged-in user has
 * MANAGE_GUILD permission in" -- the only guilds surfaced for the "join
 * from the GUI" feature.
 */
export interface ManageableGuild {
  id: string;
  name: string;
  voiceChannels: VoiceChannelInfo[];
}

export interface JoinVoiceChannelResult {
  ok: boolean;
  errorMessage: string | null;
}

/**
 * The full API surface exposed to the renderer via
 * `contextBridge.exposeInMainWorld('bard', ...)`. This is the ONLY way the
 * renderer talks to the rest of the app -- no direct ipcRenderer, no
 * `require`. Keep every method here narrow and single-purpose.
 */
export interface LocalBardAPI {
  listApps(): Promise<CapturableApp[]>;
  startStreaming(appId: string): Promise<{ ok: boolean; errorMessage: string | null }>;
  stopStreaming(): Promise<void>;
  getStatus(): Promise<StreamingStatus>;
  onStatusChanged(callback: (status: StreamingStatus) => void): () => void;

  getBotSetupStatus(): Promise<BotSetupStatus>;
  saveBotToken(token: string): Promise<SaveTokenResult>;

  getOAuthClientStatus(): Promise<OAuthClientSetupStatus>;
  saveOAuthClient(clientId: string, clientSecret: string): Promise<SaveOAuthClientResult>;
  getOAuthLoginStatus(): Promise<OAuthLoginStatus>;
  onOAuthLoginStatusChanged(callback: (status: OAuthLoginStatus) => void): () => void;
  startOAuthLogin(): Promise<void>;
  oauthLogout(): Promise<void>;
  listManageableGuilds(): Promise<ManageableGuild[]>;
  joinGuildVoiceChannel(guildId: string, channelId: string): Promise<JoinVoiceChannelResult>;
}
