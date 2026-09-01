import { GuildMember, PermissionFlagsBits } from 'discord.js';
import type { LocalConfig } from '../config';

/**
 * Control commands are restricted to members with ManageGuild, or a
 * configurable role ID read from local (non-secret) config, defaulting to
 * ManageGuild-only when no role is configured. This never accepts freeform
 * input -- the role id is a fixed value read from local config, not
 * anything supplied by the interaction itself.
 */
export function isAuthorized(member: GuildMember, config: LocalConfig): boolean {
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  if (config.controlRoleId && member.roles.cache.has(config.controlRoleId)) return true;
  return false;
}
