import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import {
  AudioPlayer,
  StreamType,
  VoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
} from '@discordjs/voice';
import prism from 'prism-media';
import { createAudioCaptureSource } from '../audio';
import type { AudioCaptureSource } from '../../shared/audioCapture';
import type { StreamingStatus } from '../../shared/types';

const OPUS_RATE = 48000;
const OPUS_CHANNELS = 2;
const OPUS_FRAME_SIZE = 960; // 20ms at 48kHz, standard Discord/Opus frame size.

/**
 * Owns the single active capture -> encode -> Discord voice pipeline.
 * Voice channel join/leave is driven by Discord slash commands
 * (see bot/commands.ts); this manager only cares about "is there a voice
 * connection to play into" and "which app's audio is currently flowing into
 * it". That split is what lets `/stop` stop streaming while staying
 * connected, per spec.
 */
export class StreamingManager extends EventEmitter {
  private readonly captureSource: AudioCaptureSource;
  private readonly audioPlayer: AudioPlayer;
  private voiceConnection: VoiceConnection | null = null;
  private currentCaptureStream: Readable | null = null;
  private status: StreamingStatus = {
    state: 'idle',
    selectedApp: null,
    guildName: null,
    channelName: null,
    errorMessage: null,
  };

  constructor() {
    super();
    this.captureSource = createAudioCaptureSource();
    this.audioPlayer = createAudioPlayer();
  }

  listApps() {
    return this.captureSource.listApps();
  }

  getStatus(): StreamingStatus {
    return this.status;
  }

  attachVoiceConnection(connection: VoiceConnection, guildName: string, channelName: string): void {
    this.voiceConnection = connection;
    connection.subscribe(this.audioPlayer);
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      this.stopStreaming();
      this.voiceConnection = null;
      this.updateStatus({ guildName: null, channelName: null });
    });
    this.updateStatus({ guildName, channelName });
  }

  detachVoiceConnection(): void {
    this.stopStreaming();
    this.voiceConnection = null;
    this.updateStatus({ guildName: null, channelName: null });
  }

  hasVoiceConnection(): boolean {
    return this.voiceConnection !== null;
  }

  async startStreaming(appId: string): Promise<{ ok: boolean; errorMessage: string | null }> {
    if (!this.voiceConnection) {
      const errorMessage = 'Bot is not connected to a voice channel yet. Use /join in Discord first.';
      this.updateStatus({ state: 'error', errorMessage });
      return { ok: false, errorMessage };
    }

    this.updateStatus({ state: 'connecting', errorMessage: null });

    try {
      const apps = await this.captureSource.listApps();
      const app = apps.find((a) => a.id === appId);
      if (!app) {
        throw new Error('Selected application is no longer running.');
      }

      // Stop any previous capture before starting a new one.
      this.teardownCapture();

      const pcmStream = this.captureSource.startCapture(appId);
      this.currentCaptureStream = pcmStream;
      pcmStream.on('error', (err: Error) => this.handleCaptureError(err));
      // The capture source reports its own waiting -> live phase transition
      // via these events (see AudioCaptureSource.startCapture's doc comment)
      // rather than us inferring it from data arrival -- e.g. on Linux the
      // target app may not be producing sound yet when capture starts.
      pcmStream.on('waiting', () => {
        this.updateStatus({ state: 'waiting_for_audio', selectedApp: app, errorMessage: null });
      });
      pcmStream.on('live', () => {
        this.updateStatus({ state: 'live', selectedApp: app, errorMessage: null });
      });

      const opusEncoder = new prism.opus.Encoder({
        rate: OPUS_RATE,
        channels: OPUS_CHANNELS,
        frameSize: OPUS_FRAME_SIZE,
      });
      opusEncoder.on('error', (err: Error) => this.handleCaptureError(err));

      const resource = createAudioResource(pcmStream.pipe(opusEncoder), {
        inputType: StreamType.Opus,
        inlineVolume: false,
      });

      this.audioPlayer.play(resource);
      // Whether this is actually live yet or still waiting for the app to
      // make sound is reported asynchronously via the events above, not
      // this return value -- it only reflects that the pipeline was wired
      // up successfully.
      return { ok: true, errorMessage: null };
    } catch (err) {
      const errorMessage = (err as Error).message;
      this.teardownCapture();
      this.updateStatus({ state: 'error', selectedApp: null, errorMessage });
      return { ok: false, errorMessage };
    }
  }

  stopStreaming(): void {
    this.teardownCapture();
    this.audioPlayer.stop(true);
    this.updateStatus({ state: 'idle', selectedApp: null, errorMessage: null });
  }

  private teardownCapture(): void {
    this.captureSource.stopCapture();
    if (this.currentCaptureStream) {
      this.currentCaptureStream.destroy();
      this.currentCaptureStream = null;
    }
  }

  private handleCaptureError(err: Error): void {
    this.teardownCapture();
    this.audioPlayer.stop(true);
    this.updateStatus({ state: 'error', errorMessage: err.message });
  }

  private updateStatus(partial: Partial<StreamingStatus>): void {
    this.status = { ...this.status, ...partial };
    this.emit('statusChanged', this.status);
  }
}
