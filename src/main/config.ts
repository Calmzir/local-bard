import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Non-secret local configuration (currently: which role, if any, is allowed
 * to use control slash commands in addition to members with ManageGuild).
 * This is plain JSON on disk -- unlike the bot token, it holds no secrets,
 * so it does not go through safeStorage.
 */
export interface LocalConfig {
  /** Discord role ID allowed to use control commands. Null = ManageGuild only. */
  controlRoleId: string | null;
}

const DEFAULT_CONFIG: LocalConfig = {
  controlRoleId: null,
};

function configFilePath(): string {
  return join(app.getPath('userData'), 'config.json');
}

export function loadConfig(): LocalConfig {
  const path = configFilePath();
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LocalConfig>;
    return {
      controlRoleId: typeof parsed.controlRoleId === 'string' ? parsed.controlRoleId : null,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: LocalConfig): void {
  const path = configFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
}
