import { EventEmitter } from 'node:events';
import { shell } from 'electron';
import type {
  JoinVoiceChannelResult,
  ManageableGuild,
  OAuthClientSetupStatus,
  OAuthLoginStatus,
  SaveOAuthClientResult,
} from '../../shared/types';
import {
  clearOAuthTokens,
  hasStoredOAuthClient,
  loadOAuthClient,
  loadOAuthTokens,
  saveOAuthClient,
  saveOAuthTokens,
} from '../secureStorage';
import type { BotController } from '../bot/client';
import type { StreamingManager } from '../streaming/StreamingManager';
import { joinVoiceChannelAndAttach } from '../bot/voiceJoin';
import { REDIRECT_URI, runLoopbackCallbackServer } from './loopbackServer';
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  fetchCurrentUser,
  fetchUserGuilds,
  refreshAccessToken,
  type TokenResult,
} from './discordApi';
import { filterManageGuildIds } from './guildAccess';
import { generatePkcePair, generateRandomToken } from './pkce';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Owns the human-user Discord login (OAuth2 Authorization Code + PKCE) and
 * the resulting "which guilds can I join a voice channel in from the GUI"
 * state. Mirrors `StreamingManager`'s EventEmitter-based status-push
 * pattern so the renderer gets live updates through the same kind of
 * `*StatusChanged` IPC event, rather than polling.
 */
export class OAuthController extends EventEmitter {
  private readonly botController: BotController;
  private readonly streamingManager: StreamingManager;
  private status: OAuthLoginStatus = { state: 'idle', username: null, errorMessage: null };
  /** Guild IDs the logged-in user holds MANAGE_GUILD in, as of the last successful login/refresh. Never trust the renderer for this -- it is re-checked here on every join attempt. */
  private manageGuildIds: Set<string> = new Set();
  private loginInFlight = false;

  constructor(botController: BotController, streamingManager: StreamingManager) {
    super();
    this.botController = botController;
    this.streamingManager = streamingManager;
  }

  getClientSetupStatus(): OAuthClientSetupStatus {
    return { hasClientCredentials: hasStoredOAuthClient() };
  }

  saveClientCredentials(clientId: string, clientSecret: string): SaveOAuthClientResult {
    const trimmedId = clientId.trim();
    const trimmedSecret = clientSecret.trim();
    if (trimmedId.length === 0 || trimmedSecret.length === 0) {
      return { ok: false, errorMessage: 'Client ID and Client Secret cannot be empty.' };
    }
    return saveOAuthClient(trimmedId, trimmedSecret);
  }

  getLoginStatus(): OAuthLoginStatus {
    return this.status;
  }

  /**
   * Attempts to restore a previously logged-in session from encrypted
   * storage at app startup, without opening a browser. Silently leaves the
   * user logged out (never throws into the caller) if there is nothing to
   * restore or the stored session is no longer valid.
   */
  async restoreSession(): Promise<void> {
    const client = loadOAuthClient();
    const tokens = loadOAuthTokens();
    if (!client || !tokens) return;

    this.setStatus({ state: 'exchanging', errorMessage: null });
    try {
      let accessToken = tokens.accessToken;
      if (Date.now() >= tokens.expiresAt) {
        const refreshed = await refreshAccessToken({
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          refreshToken: tokens.refreshToken,
        });
        accessToken = refreshed.accessToken;
        this.persistTokens(refreshed);
      }
      await this.completeLogin(accessToken);
    } catch (err) {
      clearOAuthTokens();
      this.manageGuildIds = new Set();
      this.setStatus({ state: 'idle', username: null, errorMessage: null });
      console.error('Failed to restore Discord login session:', err);
    }
  }

  /**
   * Runs the full Authorization Code + PKCE flow: opens the system browser,
   * waits for the one-shot loopback callback, exchanges the code, then
   * fetches the user's identity and guild list. Status updates are pushed
   * via the 'loginStatusChanged' event at every step -- this never throws,
   * failures land in `status.state === 'error'` instead.
   */
  async login(): Promise<void> {
    if (this.loginInFlight) return;

    const client = loadOAuthClient();
    if (!client) {
      this.setStatus({
        state: 'error',
        username: null,
        errorMessage: 'Set your Discord Client ID and Client Secret first.',
      });
      return;
    }

    this.loginInFlight = true;
    this.setStatus({ state: 'waiting_for_browser', username: null, errorMessage: null });

    try {
      const state = generateRandomToken(24);
      const { codeVerifier, codeChallenge } = generatePkcePair();

      const callbackPromise = runLoopbackCallbackServer(state, LOGIN_TIMEOUT_MS);

      const authorizeUrl = buildAuthorizeUrl({
        clientId: client.clientId,
        redirectUri: REDIRECT_URI,
        state,
        codeChallenge,
      });
      await shell.openExternal(authorizeUrl);

      const { code } = await callbackPromise;

      this.setStatus({ state: 'exchanging', errorMessage: null });
      const tokens = await exchangeCodeForTokens({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        code,
        redirectUri: REDIRECT_URI,
        codeVerifier,
      });
      this.persistTokens(tokens);
      await this.completeLogin(tokens.accessToken);
    } catch (err) {
      this.setStatus({ state: 'error', username: null, errorMessage: (err as Error).message });
    } finally {
      this.loginInFlight = false;
    }
  }

  /** Clears just the login session tokens. Client ID/Secret are left in place -- see README. */
  logout(): void {
    clearOAuthTokens();
    this.manageGuildIds = new Set();
    this.setStatus({ state: 'idle', username: null, errorMessage: null });
  }

  /**
   * Guilds present in BOTH the bot's own `client.guilds.cache` AND the
   * logged-in user's MANAGE_GUILD set, each with its voice channels.
   */
  listManageableGuilds(): ManageableGuild[] {
    if (this.status.state !== 'logged_in') return [];
    const result: ManageableGuild[] = [];
    for (const guildId of this.manageGuildIds) {
      const guild = this.botController.getGuild(guildId);
      if (!guild) continue; // Bot isn't (or is no longer) a member -- not in the intersection.
      result.push({
        id: guild.id,
        name: guild.name,
        voiceChannels: this.botController.listVoiceChannels(guildId),
      });
    }
    return result;
  }

  /**
   * Joins a voice channel on the user's behalf from the GUI. Re-checks
   * MANAGE_GUILD against the cached OAuth guild list server-side -- the
   * renderer's guild/channel ids are never trusted as an authorization
   * decision on their own.
   */
  async joinGuildVoiceChannel(guildId: string, channelId: string): Promise<JoinVoiceChannelResult> {
    if (this.status.state !== 'logged_in') {
      return { ok: false, errorMessage: 'Not signed in.' };
    }
    if (!this.manageGuildIds.has(guildId)) {
      return { ok: false, errorMessage: 'You do not have Manage Server permission in that server.' };
    }
    const guild = this.botController.getGuild(guildId);
    if (!guild) {
      return { ok: false, errorMessage: 'The bot is not a member of that server.' };
    }
    const channel = this.botController.getVoiceChannel(guildId, channelId);
    if (!channel) {
      return { ok: false, errorMessage: 'That voice channel could not be resolved.' };
    }
    return joinVoiceChannelAndAttach(guild, channel, this.streamingManager);
  }

  private async completeLogin(accessToken: string): Promise<void> {
    const user = await fetchCurrentUser(accessToken);
    const guilds = await fetchUserGuilds(accessToken);
    this.manageGuildIds = filterManageGuildIds(guilds);
    this.setStatus({ state: 'logged_in', username: user.username, errorMessage: null });
  }

  private persistTokens(tokens: TokenResult): void {
    saveOAuthTokens({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + tokens.expiresIn * 1000,
    });
  }

  private setStatus(partial: Partial<OAuthLoginStatus>): void {
    this.status = { ...this.status, ...partial };
    this.emit('loginStatusChanged', this.status);
  }
}
