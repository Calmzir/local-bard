import type { AudioCaptureSource } from '../../shared/audioCapture';
import { LinuxAudioCapture } from './linuxCapture';
import { WindowsAudioCapture } from './windowsCapture';

/**
 * Picks the right platform-specific `AudioCaptureSource` implementation.
 * This is the only place main-process/GUI orchestration code should branch
 * on `process.platform` for audio capture -- everything else talks to the
 * shared `AudioCaptureSource` interface.
 */
export function createAudioCaptureSource(): AudioCaptureSource {
  switch (process.platform) {
    case 'linux':
      return new LinuxAudioCapture();
    case 'win32':
      return new WindowsAudioCapture();
    default:
      throw new Error(
        `Unsupported platform: "${process.platform}". Local Bard only supports Linux and Windows.`,
      );
  }
}

export type { AudioCaptureSource } from '../../shared/audioCapture';
