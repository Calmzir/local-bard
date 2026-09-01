import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import type { AudioCaptureSource } from '../../shared/audioCapture';
import type { CapturableApp } from '../../shared/types';

/**
 * Linux audio capture, backed by PipeWire (`pw-dump` + `pw-record`) with a
 * PulseAudio (`pactl` + `parec`) fallback for systems that don't run
 * PipeWire's `pw-*` CLI tools (or run PipeWire only through its PulseAudio
 * compatibility layer).
 *
 * Every child process is spawned with a fixed executable name and a fixed
 * argv array -- never `shell: true`, never string-concatenated commands --
 * so nothing from app names or user input can be interpreted as shell
 * syntax.
 *
 * App ids are tagged with which backend produced them (`pw:<node-id>` or
 * `pa:<sink-input-index>`) so startCapture() knows which command to run
 * without re-probing the system.
 */
export class LinuxAudioCapture implements AudioCaptureSource {
  private captureProcess: ChildProcessByStdio<null, Readable, Readable> | null = null;

  async listApps(): Promise<CapturableApp[]> {
    const pipewireApps = await this.tryListViaPipewire();
    if (pipewireApps !== null) {
      return pipewireApps;
    }

    const pulseApps = await this.tryListViaPactl();
    if (pulseApps !== null) {
      return pulseApps;
    }

    throw new Error(
      'No supported audio backend found. Local Bard needs either PipeWire ' +
        '("pw-dump"/"pw-record") or PulseAudio ("pactl"/"parec") command-line ' +
        'tools installed and on PATH to list or capture per-application audio.',
    );
  }

  startCapture(appId: string): Readable {
    this.stopCapture();

    const [backend, rawId] = splitAppId(appId);
    const output = new PassThrough();

    let child: ChildProcessByStdio<null, Readable, Readable>;
    if (backend === 'pw') {
      child = spawn(
        'pw-record',
        ['--target-object', rawId, '--format', 's16', '--rate', '48000', '--channels', '2', '-'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } else {
      child = spawn(
        'parec',
        ['--format=s16le', '--rate=48000', '--channels=2', `--monitor-stream=${rawId}`, '--raw', '-'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    }

    this.captureProcess = child;

    child.stdout.pipe(output);
    child.stderr.on('data', (chunk: Buffer) => {
      // Surface backend diagnostics without crashing the pipeline; the
      // orchestrator decides what (if anything) to do with capture errors.
      output.emit('capture-stderr', chunk.toString('utf8'));
    });
    child.on('error', (err) => output.emit('error', err));
    child.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        output.emit('error', new Error(`Audio capture process exited with code ${code} (signal ${signal ?? 'none'})`));
      }
      output.end();
    });

    return output;
  }

  stopCapture(): void {
    if (this.captureProcess) {
      this.captureProcess.kill('SIGTERM');
      this.captureProcess = null;
    }
  }

  private async tryListViaPipewire(): Promise<CapturableApp[] | null> {
    let raw: string;
    try {
      raw = await runCapturingStdout('pw-dump', []);
    } catch (err) {
      if (isMissingBinary(err)) return null;
      throw new Error(`Failed to run "pw-dump": ${(err as Error).message}`);
    }

    let nodes: unknown;
    try {
      nodes = JSON.parse(raw);
    } catch {
      throw new Error('Failed to parse "pw-dump" JSON output.');
    }

    if (!Array.isArray(nodes)) return [];

    const apps: CapturableApp[] = [];
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue;
      const info = (node as Record<string, unknown>)['info'];
      if (typeof info !== 'object' || info === null) continue;
      const props = (info as Record<string, unknown>)['props'];
      if (typeof props !== 'object' || props === null) continue;
      const p = props as Record<string, unknown>;

      if (p['media.class'] !== 'Stream/Output/Audio') continue;

      const nodeId = (node as Record<string, unknown>)['id'];
      if (typeof nodeId !== 'number') continue;

      const name =
        stringProp(p, 'application.name') ??
        stringProp(p, 'node.description') ??
        stringProp(p, 'node.name') ??
        'Unknown application';
      const processName =
        stringProp(p, 'application.process.binary') ?? stringProp(p, 'node.name') ?? 'unknown';

      apps.push({ id: `pw:${nodeId}`, name, processName });
    }
    return dedupeById(apps);
  }

  private async tryListViaPactl(): Promise<CapturableApp[] | null> {
    let raw: string;
    try {
      raw = await runCapturingStdout('pactl', ['list', 'sink-inputs']);
    } catch (err) {
      if (isMissingBinary(err)) return null;
      throw new Error(`Failed to run "pactl": ${(err as Error).message}`);
    }

    const apps: CapturableApp[] = [];
    const blocks = raw.split(/\n(?=Sink Input #)/g);
    for (const block of blocks) {
      const idMatch = block.match(/^Sink Input #(\d+)/);
      if (!idMatch || !idMatch[1]) continue;
      const id = idMatch[1];

      const nameMatch = block.match(/application\.name = "([^"]*)"/);
      const binMatch = block.match(/application\.process\.binary = "([^"]*)"/);

      apps.push({
        id: `pa:${id}`,
        name: nameMatch?.[1] ?? 'Unknown application',
        processName: binMatch?.[1] ?? 'unknown',
      });
    }
    return dedupeById(apps);
  }
}

function splitAppId(appId: string): ['pw' | 'pa', string] {
  if (appId.startsWith('pw:')) return ['pw', appId.slice(3)];
  if (appId.startsWith('pa:')) return ['pa', appId.slice(3)];
  throw new Error(`Unrecognized app id: ${appId}`);
}

function stringProp(props: Record<string, unknown>, key: string): string | undefined {
  const v = props[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function dedupeById(apps: CapturableApp[]): CapturableApp[] {
  const seen = new Set<string>();
  return apps.filter((app) => {
    if (seen.has(app.id)) return false;
    seen.add(app.id);
    return true;
  });
}

function isMissingBinary(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Runs a fixed executable with a fixed argv array and resolves with its stdout. */
function runCapturingStdout(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => errChunks.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf8'));
      } else {
        reject(new Error(`"${command}" exited with code ${code}: ${Buffer.concat(errChunks).toString('utf8')}`));
      }
    });
  });
}
