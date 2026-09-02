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
