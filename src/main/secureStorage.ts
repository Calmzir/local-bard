import { safeStorage, app } from 'electron';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Bot token storage. The token is NEVER written to disk in plaintext: it is
 * encrypted with Electron's `safeStorage` (DPAPI on Windows, libsecret/
 * kwallet on Linux) before being written to a file under userData, and only
 * decrypted back into memory at login time. There is no .env or config file
 * path that carries the raw token in this app once the user has pasted it
 * into the first-run prompt.
 */
function tokenFilePath(): string {
  return join(app.getPath('userData'), 'bot-token.enc');
}

export function hasStoredToken(): boolean {
  return existsSync(tokenFilePath());
}

export function saveToken(token: string): { ok: boolean; errorMessage: string | null } {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return { ok: false, errorMessage: 'Token cannot be empty.' };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      ok: false,
      errorMessage:
        'OS-level secret encryption is unavailable on this system (no DPAPI/libsecret/kwallet backend). ' +
        'Local Bard refuses to store the token in plaintext, so it cannot be saved here.',
    };
  }
  try {
    const encrypted = safeStorage.encryptString(trimmed);
    const path = tokenFilePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, encrypted, { mode: 0o600 });
    return { ok: true, errorMessage: null };
  } catch (err) {
    return { ok: false, errorMessage: `Failed to save token: ${(err as Error).message}` };
  }
}

export function loadToken(): string | null {
  const path = tokenFilePath();
  if (!existsSync(path)) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const encrypted = readFileSync(path);
    return safeStorage.decryptString(encrypted);
  } catch {
    return null;
  }
}

export function clearToken(): void {
  const path = tokenFilePath();
  if (existsSync(path)) unlinkSync(path);
}

/**
 * OAuth2 (Authorization Code + PKCE) storage for the human-user login
 * feature. Deliberately split into two files, both separate from the bot
 * token above:
 *
 *  - oauth-client.enc: the Client ID + Client Secret of Joel's own Discord
 *    Application (OAuth2 tab, same app the bot token comes from). Entered
 *    once through the same first-run-style GUI prompt as the bot token.
 *  - oauth-tokens.enc: the resulting access/refresh token pair for the
 *    logged-in human user's session, so login persists across app restarts
 *    without re-opening the browser every time.
 *
 * Both are encrypted at rest with the exact same safeStorage pattern as the
 * bot token. This is a *read-only* login (scopes: `identify guilds` only --
 * see SECURITY.md) so the blast radius of either file ever being extracted
 * is limited to re-running this same read-only login, nothing that can act
 * on the user's behalf.
 */
export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface StoredOAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds after which `accessToken` should be refreshed. */
  expiresAt: number;
}

function oauthClientFilePath(): string {
  return join(app.getPath('userData'), 'oauth-client.enc');
}

function oauthTokensFilePath(): string {
  return join(app.getPath('userData'), 'oauth-tokens.enc');
}

export function hasStoredOAuthClient(): boolean {
  return existsSync(oauthClientFilePath());
}

export function saveOAuthClient(
  clientId: string,
  clientSecret: string,
): { ok: boolean; errorMessage: string | null } {
  if (clientId.length === 0 || clientSecret.length === 0) {
    return { ok: false, errorMessage: 'Client ID and Client Secret cannot be empty.' };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      ok: false,
      errorMessage:
        'OS-level secret encryption is unavailable on this system (no DPAPI/libsecret/kwallet backend). ' +
        'Local Bard refuses to store the client secret in plaintext, so it cannot be saved here.',
    };
  }
  try {
    const payload: OAuthClientCredentials = { clientId, clientSecret };
    const encrypted = safeStorage.encryptString(JSON.stringify(payload));
    const path = oauthClientFilePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, encrypted, { mode: 0o600 });
    return { ok: true, errorMessage: null };
  } catch (err) {
    return { ok: false, errorMessage: `Failed to save client credentials: ${(err as Error).message}` };
  }
}

export function loadOAuthClient(): OAuthClientCredentials | null {
  const path = oauthClientFilePath();
  if (!existsSync(path)) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const encrypted = readFileSync(path);
    const decrypted = safeStorage.decryptString(encrypted);
    const parsed = JSON.parse(decrypted) as Partial<OAuthClientCredentials>;
    if (typeof parsed.clientId !== 'string' || typeof parsed.clientSecret !== 'string') return null;
    return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
  } catch {
    return null;
  }
}

/** Forgets the stored Client ID/Secret. Only invoked when the user explicitly asks to -- see README. */
export function clearOAuthClient(): void {
  const path = oauthClientFilePath();
  if (existsSync(path)) unlinkSync(path);
}

export function hasStoredOAuthTokens(): boolean {
  return existsSync(oauthTokensFilePath());
}

export function saveOAuthTokens(tokens: StoredOAuthTokens): { ok: boolean; errorMessage: string | null } {
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      ok: false,
      errorMessage:
        'OS-level secret encryption is unavailable on this system (no DPAPI/libsecret/kwallet backend). ' +
        'Local Bard refuses to store the login session in plaintext, so it cannot be saved here.',
    };
  }
  try {
    const encrypted = safeStorage.encryptString(JSON.stringify(tokens));
    const path = oauthTokensFilePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, encrypted, { mode: 0o600 });
    return { ok: true, errorMessage: null };
  } catch (err) {
    return { ok: false, errorMessage: `Failed to save login session: ${(err as Error).message}` };
  }
}

export function loadOAuthTokens(): StoredOAuthTokens | null {
  const path = oauthTokensFilePath();
  if (!existsSync(path)) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const encrypted = readFileSync(path);
    const decrypted = safeStorage.decryptString(encrypted);
    const parsed = JSON.parse(decrypted) as Partial<StoredOAuthTokens>;
    if (
      typeof parsed.accessToken !== 'string' ||
      typeof parsed.refreshToken !== 'string' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null;
    }
    return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

/** Clears just the login session (access/refresh tokens) -- this is what "Log out" does. */
export function clearOAuthTokens(): void {
  const path = oauthTokensFilePath();
  if (existsSync(path)) unlinkSync(path);
}
