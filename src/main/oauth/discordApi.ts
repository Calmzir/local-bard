/**
 * Thin wrappers around the handful of Discord HTTP endpoints this login
 * feature needs. Scopes requested are `identify guilds` only -- both
 * read-only. This module never calls any endpoint that could act on the
 * user's behalf; the bot's own actions continue to go exclusively through
 * BotController's own bot token.
 */

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const API_BASE = 'https://discord.com/api';
const SCOPES = 'identify guilds';

export interface BuildAuthorizeUrlOptions {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

export function buildAuthorizeUrl(opts: BuildAuthorizeUrlOptions): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface TokenResult {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires, per Discord's response. */
  expiresIn: number;
}

interface DiscordTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

async function postTokenRequest(body: URLSearchParams): Promise<TokenResult> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Discord token request failed (HTTP ${res.status}): ${text || res.statusText}`);
  }

  const json = (await res.json()) as Partial<DiscordTokenResponse>;
  if (typeof json.access_token !== 'string' || typeof json.refresh_token !== 'string' || typeof json.expires_in !== 'number') {
    throw new Error('Discord token response was missing expected fields.');
  }

  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresIn: json.expires_in };
}

export interface ExchangeCodeOptions {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export async function exchangeCodeForTokens(opts: ExchangeCodeOptions): Promise<TokenResult> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
  return postTokenRequest(body);
}

export interface RefreshTokenOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export async function refreshAccessToken(opts: RefreshTokenOptions): Promise<TokenResult> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
  });
  return postTokenRequest(body);
}

export interface DiscordUser {
  id: string;
  username: string;
}

export async function fetchCurrentUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(`${API_BASE}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch Discord user profile (HTTP ${res.status}).`);
  }
  const json = (await res.json()) as Partial<DiscordUser>;
  if (typeof json.id !== 'string' || typeof json.username !== 'string') {
    throw new Error('Discord user profile response was missing expected fields.');
  }
  return { id: json.id, username: json.username };
}

export interface DiscordUserGuild {
  id: string;
  name: string;
  /** Permission bitfield as a decimal string -- parse with BigInt, never Number, to avoid precision loss. */
  permissions: string;
}

export async function fetchUserGuilds(accessToken: string): Promise<DiscordUserGuild[]> {
  const res = await fetch(`${API_BASE}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch Discord guild list (HTTP ${res.status}).`);
  }
  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) {
    throw new Error('Discord guild list response was not an array.');
  }
  const guilds: DiscordUserGuild[] = [];
  for (const entry of json) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as Record<string, unknown>)['id'] === 'string' &&
      typeof (entry as Record<string, unknown>)['name'] === 'string' &&
      typeof (entry as Record<string, unknown>)['permissions'] === 'string'
    ) {
      const rec = entry as { id: string; name: string; permissions: string };
      guilds.push({ id: rec.id, name: rec.name, permissions: rec.permissions });
    }
  }
  return guilds;
}
