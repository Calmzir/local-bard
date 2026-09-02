import { PermissionFlagsBits } from 'discord.js';

/**
 * Builds the Discord OAuth2 "add bot to server" invite URL entirely from
 * information Discord already gave the app once the bot logged in (its own
 * application id, via `BotController.getClientId()`) -- no manual Client ID
 * entry and no manual OAuth2 URL Generator step in the Developer Portal.
 *
 * Permissions are computed from discord.js's own `PermissionFlagsBits`
 * constants (never a hardcoded numeric bitfield) so this can't silently
 * drift from what the app actually asks a member to grant: `Connect` and
 * `Speak`, the same two permissions `/join` already requires of the human
 * running it (see `bot/permissions.ts` / `bot/commands.ts`).
 *
 * Uses the same `new URL(...)` + `searchParams` pattern this codebase
 * already used for OAuth2 URL construction (see git history's
 * `src/main/oauth/discordApi.ts` before the user-login OAuth flow was
 * replaced by a plain Guild ID) -- safe encoding, no manual string
 * concatenation.
 */
export function buildInviteUrl(clientId: string): string {
  const permissions = PermissionFlagsBits.Connect | PermissionFlagsBits.Speak;
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('permissions', permissions.toString());
  url.searchParams.set('scope', 'bot applications.commands');
  return url.toString();
}
