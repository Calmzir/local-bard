import type { DiscordUserGuild } from './discordApi';

/** The MANAGE_GUILD permission bit (Discord permission bitfield). */
const MANAGE_GUILD_BIT = 0x20n;

/**
 * Checks the MANAGE_GUILD bit of a Discord permission bitfield string via
 * BigInt -- the value can exceed Number.MAX_SAFE_INTEGER, so parsing with
 * `Number()` would silently lose precision and could misjudge permissions.
 */
export function hasManageGuild(permissionsBitfield: string): boolean {
  try {
    const bits = BigInt(permissionsBitfield);
    return (bits & MANAGE_GUILD_BIT) === MANAGE_GUILD_BIT;
  } catch {
    return false;
  }
}

/** Guild IDs from the user's OAuth `guilds` response where they hold MANAGE_GUILD. */
export function filterManageGuildIds(userGuilds: DiscordUserGuild[]): Set<string> {
  const ids = new Set<string>();
  for (const guild of userGuilds) {
    if (hasManageGuild(guild.permissions)) {
      ids.add(guild.id);
    }
  }
  return ids;
}
