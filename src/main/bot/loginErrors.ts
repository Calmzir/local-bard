import { DiscordAPIError, DiscordjsError, DiscordjsErrorCodes } from 'discord.js';

/**
 * Turns whatever `Client#login()` rejected with into a specific,
 * plain-language message a non-developer can act on, distinguishing a
 * genuinely rejected/revoked token from a generic connectivity failure.
 *
 * Discord's gateway login flow makes an authenticated REST call
 * (`GET /gateway/bot`) before ever opening a socket, so an invalid or
 * revoked token surfaces as a `DiscordAPIError` with HTTP status 401 --
 * that is the reliable signal discord.js gives for "the token itself was
 * rejected", not just "something about this exchange failed". The library
 * also throws its own `DiscordjsError(TokenInvalid)` synchronously when the
 * token is empty/not a string, which is included for completeness even
 * though `saveToken()` already rejects an empty token before login is ever
 * attempted.
 */
export function describeLoginError(err: unknown): string {
  if (err instanceof DiscordAPIError && err.status === 401) {
    return (
      'Discord rejected this token as invalid or revoked. Go back to the Developer Portal, ' +
      'open your application, and under Bot click Reset Token to get a fresh one.'
    );
  }
  if (err instanceof DiscordjsError && err.code === DiscordjsErrorCodes.TokenInvalid) {
    return "That doesn't look like a valid bot token. Copy it again from the Developer Portal (Bot -> Reset Token).";
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Could not connect to Discord: ${message}`;
}
