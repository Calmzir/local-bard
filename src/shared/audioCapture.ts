/**
 * `AudioCaptureSource` is main-process-only: it needs Node's `node:stream`
 * `Readable` type, so it deliberately lives outside types.ts (see the note
 * there) and must only ever be imported by main-process code
 * (src/main/audio/**), never by the renderer.
 */
import type { Readable } from 'node:stream';
import type { CapturableApp } from './types';

/** Platform-agnostic audio capture contract. Implemented per-OS. */
export interface AudioCaptureSource {
  /** Enumerate currently running audio-producing applications. */
  listApps(): Promise<CapturableApp[]>;
  /**
   * Start capturing raw PCM audio (s16le, 48kHz, stereo) for the given app.
   * Returns a readable stream of raw PCM bytes. Caller is responsible for
   * destroying the returned stream (via stopCapture) when done.
   */
  startCapture(appId: string): Readable;
  /** Stop any capture in progress and release underlying resources. */
  stopCapture(): void;
}
