import { app, screen } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Persisted window size/position, mirroring the plain-JSON-on-disk pattern
 * used by `config.ts` for non-secret local state. A window's bounds hold no
 * secrets, so (like the guild id) this never goes through safeStorage.
 */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_WINDOW_SIZE = { width: 900, height: 640 } as const;

function boundsFilePath(): string {
  return join(app.getPath('userData'), 'window-bounds.json');
}

export function loadWindowBounds(): WindowBounds | null {
  const path = boundsFilePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<WindowBounds>;
    if (
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number' &&
      typeof parsed.width === 'number' &&
      typeof parsed.height === 'number'
    ) {
      return { x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveWindowBounds(bounds: WindowBounds): void {
  const path = boundsFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(bounds, null, 2), 'utf8');
}

const MIN_VISIBLE_PX = 50;

/**
 * Clamp previously-saved bounds so the window is guaranteed to land at
 * least partially on a currently-connected display. Without this, restoring
 * a position that was last saved on a display (e.g. an external monitor)
 * that's no longer connected would put the window fully off-screen and
 * unreachable.
 */
export function clampToVisibleDisplay(bounds: WindowBounds): WindowBounds {
  const displays = screen.getAllDisplays();

  const fitsOnSomeDisplay = displays.some((display) => {
    const area = display.workArea;
    const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return overlapX >= MIN_VISIBLE_PX && overlapY >= MIN_VISIBLE_PX;
  });

  if (fitsOnSomeDisplay) return bounds;

  const primary = screen.getPrimaryDisplay().workArea;
  const width = Math.min(bounds.width, primary.width);
  const height = Math.min(bounds.height, primary.height);
  return {
    x: primary.x + Math.round((primary.width - width) / 2),
    y: primary.y + Math.round((primary.height - height) / 2),
    width,
    height,
  };
}
