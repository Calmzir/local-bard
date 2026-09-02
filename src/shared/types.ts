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

/**
 * A single currently-running application the user can pick from -- it does
 * NOT need to be producing audio yet. Identity is based on executable/binary
 * name, not PID: multi-process apps (every modern browser) run many OS
 * processes under one binary, and the process that eventually owns an audio
 * stream is often not the PID shown as the app's main process. `id` is
 * therefore one entry per distinct binary (e.g. Linux's `proc:<binary>`),
 * never per-PID, and platform capture implementations must match a later
 * audio stream back to this app by binary name.
 */
export interface CapturableApp {
  /** Stable id for this binary (see class doc above) -- not a PID. */
  id: string;
  /** Human-readable name to show in the GUI. */
  name: string;
  /** Underlying binary/process name, shown as secondary detail. */
  processName: string;
}

export type StreamingState = 'idle' | 'connecting' | 'waiting_for_audio' | 'live' | 'error';

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
  /** Bot's own OAuth2 application id (Discord's "Client ID"), populated once connected. */
  clientId: string | null;
  /** Ready-to-open invite URL built from `clientId`, or null before the first successful login. */
  inviteUrl: string | null;
  /**
   * Plain-language reason the most recent login attempt failed, or null if
   * there hasn't been a failure since the last successful login (or none
   * has been attempted yet). Lets the GUI explain a stuck "not connected"
   * state -- e.g. a stored token that was revoked while the app was
   * closed -- without the user needing to know to check logs.
   */
  connectError: string | null;
}

export interface SaveTokenResult {
  ok: boolean;
  errorMessage: string | null;
}

export interface CopyInviteLinkResult {
  ok: boolean;
  errorMessage: string | null;
}

/** A voice-based channel in a guild the bot is a member of. */
export interface VoiceChannelInfo {
  id: string;
  name: string;
  /**
   * Name of the parent category channel, or null if this channel isn't
   * inside a category. Two servers (or even two categories in the same
   * server) can easily have voice channels with the identical generic name
   * (e.g. "Canal de Voz") -- this lets the picker show the category as
   * disambiguating context.
   */
  categoryName: string | null;
}

export type GuildConfigState = 'not_configured' | 'not_a_member' | 'resolved';

/**
 * Status of the single configured Discord server (guild) id, resolved
 * directly through the bot's own connection (`client.guilds.cache`) --
 * there is no separate user login here, just "is a guild id saved, and is
 * the bot currently a member of it".
 */
export interface GuildConfigStatus {
  state: GuildConfigState;
  /** The configured guild id, or null if none has been saved yet. */
  guildId: string | null;
  /** The guild's name, once resolved (state === 'resolved'). */
  guildName: string | null;
  /** The guild's voice channels, once resolved (state === 'resolved'). */
  voiceChannels: VoiceChannelInfo[];
}

export interface SaveGuildIdResult {
  ok: boolean;
  errorMessage: string | null;
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
  clearBotToken(): Promise<void>;
  copyInviteLink(): Promise<CopyInviteLinkResult>;

  getGuildConfig(): Promise<GuildConfigStatus>;
  onGuildConfigChanged(callback: (status: GuildConfigStatus) => void): () => void;
  saveGuildId(guildId: string): Promise<SaveGuildIdResult>;
  joinGuildVoiceChannel(channelId: string): Promise<JoinVoiceChannelResult>;
}
