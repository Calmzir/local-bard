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
  /**
   * Enumerate currently RUNNING applications the user can pick from,
   * regardless of whether they're producing audio right now. See
   * `CapturableApp`'s doc comment for why identity is by binary name, not
   * PID.
   */
  listApps(): Promise<CapturableApp[]>;
  /**
   * Start capturing raw PCM audio (s16le, 48kHz, stereo) for the given app.
   * Returns a readable stream of raw PCM bytes.
   *
   * The app may not be producing audio yet: implementations may need to
   * wait for it to start. The returned stream communicates that phase
   * transition by emitting `'waiting'` (capture requested but no audio is
   * flowing yet) and `'live'` (audio has started/is already flowing) events
   * -- callers should subscribe to both rather than inferring phase from
   * data arrival. An implementation that can start capturing immediately
   * (no wait needed) may emit only `'live'`.
   *
   * Caller is responsible for destroying the returned stream (via
   * stopCapture) when done.
   */
  startCapture(appId: string): Readable;
  /**
   * Stop any capture in progress -- including one still waiting for audio
   * to start, with no underlying process spawned yet -- and release
   * underlying resources.
   */
  stopCapture(): void;
}
